/**
 * PANIC BOMB — network.js
 * Multiplayer Network Layer.
 *
 * Responsibilities:
 *   • Manage Socket.io connection lifecycle
 *   • Send client actions to the server
 *   • Receive server events and forward them to EventBus
 *   • Handle latency measurement (ping)
 *   • Handle reconnection with exponential backoff
 *   • Rate-limit outgoing actions (anti-spam)
 *   • Keep the rest of the codebase Socket.io-free
 *
 * Depends on: config.js, events.js, state.js
 *
 * Socket.io is loaded via CDN in index.html before this file.
 * If the CDN is unavailable, Network.isAvailable() returns false
 * and the game shows a connection error.
 */

const Network = (() => {

  // ── Internal state ─────────────────────────────────────────────
  let _socket          = null;
  let _connected       = false;
  let _reconnecting    = false;
  let _reconnectTimer  = null;
  let _reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 8;

  // Ping tracking
  let _pingInterval    = null;
  let _pingStartTime   = 0;
  let _lastPing        = 0;

  // Rate limiting: track last emit time per action
  const _rateLimits    = new Map();  // action → lastEmitTime
  const RATE_LIMIT_MS  = {
    [CONFIG.CLIENT_ACTIONS.PASS_BOMB]:   1000,
    [CONFIG.CLIENT_ACTIONS.START_HOLD]:   300,
    [CONFIG.CLIENT_ACTIONS.END_HOLD]:     100,
    [CONFIG.CLIENT_ACTIONS.SET_READY]:    500,
    [CONFIG.CLIENT_ACTIONS.START_GAME]:  1000,
    [CONFIG.CLIENT_ACTIONS.KICK_PLAYER]: 1000,
  };

  // Sequence counter for ordered messages
  let _seq = 0;
  function _nextSeq() { return ++_seq; }

  // ── Helpers ───────────────────────────────────────────────────

  function _log(...args) {
    if (State.get('network') && window.location.hostname === 'localhost') {
      console.log('[Network]', ...args);
    }
  }

  /**
   * Check if an action is within its rate limit.
   * @param {string} action
   * @returns {boolean} true if allowed
   */
  function _checkRateLimit(action) {
    const limitMs = RATE_LIMIT_MS[action];
    if (!limitMs) return true;
    const last = _rateLimits.get(action) ?? 0;
    if (Date.now() - last < limitMs) return false;
    _rateLimits.set(action, Date.now());
    return true;
  }

  /**
   * Emit an action to the server with sequence number + timestamp.
   * Returns false if not connected or rate-limited.
   * @param {string} action
   * @param {Object} [payload]
   * @returns {boolean}
   */
  function _send(action, payload = {}) {
    if (!_connected || !_socket) {
      _log(`Cannot send "${action}" — not connected`);
      return false;
    }
    if (!_checkRateLimit(action)) {
      _log(`Rate limited: "${action}"`);
      return false;
    }
    const envelope = {
      action,
      seq:  _nextSeq(),
      ts:   Date.now(),
      ...payload,
    };
    _socket.emit('action', envelope);
    _log('→ SEND', action, envelope);
    return true;
  }

  // ── Ping System ───────────────────────────────────────────────

  function _startPing() {
    _stopPing();
    _pingInterval = setInterval(() => {
      if (!_connected) return;
      _pingStartTime = Date.now();
      _socket.emit('ping_check');
    }, 3000);
  }

  function _stopPing() {
    clearInterval(_pingInterval);
    _pingInterval = null;
  }

  function _handlePong() {
    _lastPing = Date.now() - _pingStartTime;
    State.set('network.ping', _lastPing, true);

    // Warn user about high latency
    if (_lastPing > CONFIG.NETWORK.HIGH_PING_THRESHOLD_MS) {
      EventBus.emit(CONFIG.EVENTS.UI_SHOW_TOAST, {
        message: `High ping: ${_lastPing}ms`,
        type: 'warn',
        quiet: true,
      });
    }
  }

  // ── Reconnect System ──────────────────────────────────────────

  /**
   * Exponential backoff reconnect.
   * Attempts: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s
   */
  function _scheduleReconnect() {
    if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      _reconnecting = false;
      State.set('network.reconnecting', false);
      EventBus.emit(CONFIG.EVENTS.NETWORK_ERROR, {
        message: 'Unable to reconnect. Please refresh the page.',
        fatal: true,
      });
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts), 30000);
    _reconnectAttempts++;
    _reconnecting = true;
    State.set('network.reconnecting', true);

    _log(`Reconnecting in ${delay}ms (attempt ${_reconnectAttempts})`);

    _reconnectTimer = setTimeout(() => {
      if (!_connected) _connect();
    }, delay);
  }

  function _cancelReconnect() {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
    _reconnecting   = false;
    _reconnectAttempts = 0;
    State.set('network.reconnecting', false);
  }

  // ── Socket Event Binders ──────────────────────────────────────

  /**
   * Bind all incoming socket events.
   * Each event from the server is forwarded to EventBus using
   * the matching SERVER_EVENTS key.
   */
  function _bindSocketEvents(socket) {
    const SE = CONFIG.SERVER_EVENTS;

    // ── Connection lifecycle ──────────────────────────────────

    socket.on('connect', () => {
      _connected         = true;
      _reconnecting      = false;
      _reconnectAttempts = 0;
      State.merge('network', {
        connected:    true,
        reconnecting: false,
        socketId:     socket.id,
      });
      _cancelReconnect();
      _startPing();
      _log('Connected:', socket.id);
      EventBus.emit(CONFIG.EVENTS.NETWORK_CONNECTED, { socketId: socket.id });

      // If we were in a room when we disconnected, attempt to rejoin
      const roomCode = State.get('room.code');
      const playerId = State.get('localPlayer.id');
      if (roomCode && playerId) {
        _log('Attempting to rejoin room after reconnect:', roomCode);
        _send(CONFIG.CLIENT_ACTIONS.JOIN_ROOM, {
          code:      roomCode,
          playerId,  // server checks if this id is valid for reconnect
          name:      State.get('localPlayer.name'),
          avatar:    State.get('localPlayer.avatar'),
          reconnect: true,
        });
      }
    });

    socket.on('disconnect', (reason) => {
      _connected = false;
      _stopPing();
      State.merge('network', { connected: false, socketId: null });
      _log('Disconnected:', reason);
      EventBus.emit(CONFIG.EVENTS.NETWORK_DISCONNECTED, { reason });

      // Don't reconnect if disconnect was intentional
      const intentional = ['io client disconnect', 'io server disconnect'];
      if (!intentional.includes(reason)) {
        _scheduleReconnect();
      }
    });

    socket.on('connect_error', (err) => {
      _log('Connection error:', err.message);
      EventBus.emit(CONFIG.EVENTS.NETWORK_ERROR, { message: err.message });
      if (!_reconnecting) _scheduleReconnect();
    });

    socket.on('pong_check', _handlePong);

    // ── Room events ───────────────────────────────────────────

    socket.on('ROOM_CREATED',  (d) => { _log('←', 'ROOM_CREATED',  d); EventBus.emit(SE.ROOM_CREATED,  d); });
    socket.on('ROOM_JOINED',   (d) => { _log('←', 'ROOM_JOINED',   d); EventBus.emit(SE.ROOM_JOINED,   d); });
    socket.on('ROOM_ERROR',    (d) => { _log('←', 'ROOM_ERROR',    d); EventBus.emit(SE.ROOM_ERROR,    d); });

    // ── Player events ─────────────────────────────────────────

    socket.on('PLAYER_JOINED',      (d) => { _log('←', 'PLAYER_JOINED',      d); EventBus.emit(SE.PLAYER_JOINED,      d); });
    socket.on('PLAYER_LEFT',        (d) => { _log('←', 'PLAYER_LEFT',        d); EventBus.emit(SE.PLAYER_LEFT,        d); });
    socket.on('PLAYER_READY',       (d) => { _log('←', 'PLAYER_READY',       d); EventBus.emit(SE.PLAYER_READY,       d); });
    socket.on('PLAYER_KICKED',      (d) => { _log('←', 'PLAYER_KICKED',      d); EventBus.emit(SE.PLAYER_KICKED,      d); });
    socket.on('HOST_TRANSFERRED',   (d) => { _log('←', 'HOST_TRANSFERRED',   d); EventBus.emit(SE.HOST_TRANSFERRED,   d); });
    socket.on('PLAYER_RECONNECTED', (d) => { _log('←', 'PLAYER_RECONNECTED', d); EventBus.emit(SE.PLAYER_RECONNECTED, d); });

    // ── Game lifecycle events ─────────────────────────────────

    socket.on('GAME_STARTING',  (d) => { _log('←', 'GAME_STARTING',  d); EventBus.emit(SE.GAME_STARTING,  d); });
    socket.on('COUNTDOWN_TICK', (d) => { _log('←', 'COUNTDOWN_TICK', d); EventBus.emit(SE.COUNTDOWN_TICK, d); });
    socket.on('GAME_STARTED',   (d) => { _log('←', 'GAME_STARTED',   d); EventBus.emit(SE.GAME_STARTED,   d); });
    socket.on('ROUND_STARTED',  (d) => { _log('←', 'ROUND_STARTED',  d); EventBus.emit(SE.ROUND_STARTED,  d); });
    socket.on('ROUND_ENDED',    (d) => { _log('←', 'ROUND_ENDED',    d); EventBus.emit(SE.ROUND_ENDED,    d); });
    socket.on('GAME_OVER',      (d) => { _log('←', 'GAME_OVER',      d); EventBus.emit(SE.GAME_OVER,      d); });

    // ── Bomb events ───────────────────────────────────────────

    socket.on('BOMB_ASSIGNED',      (d) => { _log('←', 'BOMB_ASSIGNED',      d); EventBus.emit(SE.BOMB_ASSIGNED,      d); });
    socket.on('BOMB_PASSED',        (d) => { _log('←', 'BOMB_PASSED',        d); EventBus.emit(SE.BOMB_PASSED,        d); });
    socket.on('PASS_REJECTED',      (d) => { _log('←', 'PASS_REJECTED',      d); EventBus.emit(SE.PASS_REJECTED,      d); });
    socket.on('HOLD_ACKNOWLEDGED',  (d) => { _log('←', 'HOLD_ACKNOWLEDGED',  d); EventBus.emit(SE.HOLD_ACKNOWLEDGED,  d); });
    socket.on('BOMB_EXPLODED',      (d) => { _log('←', 'BOMB_EXPLODED',      d); EventBus.emit(SE.BOMB_EXPLODED,      d); });
    socket.on('FAKE_OUT',           (d) => { _log('←', 'FAKE_OUT',           d); EventBus.emit(SE.FAKE_OUT,           d); });
    socket.on('PLAYER_ELIMINATED',  (d) => { _log('←', 'PLAYER_ELIMINATED',  d); EventBus.emit(SE.PLAYER_ELIMINATED,  d); });

    // ── AFK / sync events ─────────────────────────────────────

    socket.on('AFK_WARNING',      (d) => { _log('←', 'AFK_WARNING',      d); EventBus.emit(SE.AFK_WARNING,      d); });
    socket.on('AFK_AUTO_PASSED',  (d) => { _log('←', 'AFK_AUTO_PASSED',  d); EventBus.emit(SE.AFK_AUTO_PASSED,  d); });
    socket.on('FORCE_STATE_SYNC', (d) => { _log('←', 'FORCE_STATE_SYNC', d); EventBus.emit(SE.FORCE_STATE_SYNC, d); });
  }

  // ── Connection ────────────────────────────────────────────────

  /**
   * Internal: create socket and bind events.
   */
  function _connect() {
    if (_socket) {
      _socket.removeAllListeners();
      _socket.disconnect();
      _socket = null;
    }

    const serverUrl = CONFIG.SERVER_URL;
    _log('Connecting to:', serverUrl);

    _socket = io(serverUrl, {
      transports:        ['websocket', 'polling'],
      reconnection:      false,   // we handle reconnect ourselves
      timeout:           10000,
      forceNew:          true,
      withCredentials:   false,
    });

    _bindSocketEvents(_socket);
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Check if Socket.io library is available (loaded from CDN).
   * @returns {boolean}
   */
  function isAvailable() {
    return typeof io === 'function';
  }

  /**
   * Initialise the network layer.
   * Does NOT connect yet — connection happens on createRoom / joinRoom.
   * Registers EventBus listeners for outgoing actions.
   */
  function init() {
    if (!isAvailable()) {
      console.error('[Network] Socket.io not loaded. Check CDN in index.html.');
      return;
    }

    const EV = CONFIG.EVENTS;
    const CA = CONFIG.CLIENT_ACTIONS;

    // Forward local input events to server
    EventBus.on(EV.PASS_REQUESTED, (data) => {
      if (data?.auto) {
        // Auto-pass — server already knows via timeout, just confirm locally
        return;
      }
      _send(CA.PASS_BOMB, {
        toPlayerId: data?.toPlayerId ?? null,
        roomId:     State.get('room.id'),
        holderId:   State.get('localPlayer.id'),
      });
    });

    EventBus.on(EV.HOLD_STARTED, (data) => {
      if (data?.forceExplode) {
        // HOLD roulette hit — tell server
        _send(CA.END_HOLD, {
          roomId:    State.get('room.id'),
          playerId:  State.get('localPlayer.id'),
          seconds:   State.get('game.holdDuration'),
          explode:   true,
        });
      } else {
        _send(CA.START_HOLD, {
          roomId:   State.get('room.id'),
          playerId: State.get('localPlayer.id'),
        });
      }
    });

    EventBus.on(EV.HOLD_ENDED, () => {
      _send(CA.END_HOLD, {
        roomId:   State.get('room.id'),
        playerId: State.get('localPlayer.id'),
        seconds:  State.get('game.holdDuration'),
        explode:  false,
      });
    });

    EventBus.on(EV.READY_TOGGLED, (data) => {
      _send(CA.SET_READY, {
        roomId:   State.get('room.id'),
        isReady:  data.isReady,
      });
    });

    EventBus.on(EV.START_GAME_CLICKED, () => {
      _send(CA.START_GAME, {
        roomId: State.get('room.id'),
      });
    });

    _log('Network initialized (not connected yet)');
  }

  /**
   * Connect to the server and create a new room.
   * @param {Object} settings  { maxPlayers, bombMode, bestOf }
   * @param {Object} player    { name, avatar }
   */
  function createRoom(settings, player) {
    State.merge('localPlayer', { name: player.name, avatar: player.avatar });
    State.merge('room', { settings });

    _doWithConnection(() => {
      _send(CONFIG.CLIENT_ACTIONS.CREATE_ROOM, {
        settings,
        player: {
          name:   player.name,
          avatar: player.avatar,
        },
      });
    });
  }

  /**
   * Connect to the server and join an existing room by code.
   * @param {string} code    5-char room code
   * @param {Object} player  { name, avatar }
   */
  function joinRoom(code, player) {
    State.merge('localPlayer', { name: player.name, avatar: player.avatar });

    _doWithConnection(() => {
      _send(CONFIG.CLIENT_ACTIONS.JOIN_ROOM, {
        code:   code.toUpperCase(),
        player: {
          name:   player.name,
          avatar: player.avatar,
        },
      });
    });
  }

  /**
   * Internal helper: ensure connection exists before calling action.
   * If already connected, calls fn immediately.
   * If not, connects first then calls fn on connect.
   * @param {Function} fn
   */
  function _doWithConnection(fn) {
    if (_connected && _socket) {
      fn();
      return;
    }

    // Connect and call fn on successful connection
    EventBus.once(CONFIG.EVENTS.NETWORK_CONNECTED, fn);
    _connect();
  }

  /**
   * Mark local player as ready / not ready.
   * @param {boolean} isReady
   */
  function setReady(isReady) {
    EventBus.emit(CONFIG.EVENTS.READY_TOGGLED, { isReady });
  }

  /**
   * Host starts the game.
   */
  function startGame() {
    if (!State.isHost()) return;
    EventBus.emit(CONFIG.EVENTS.START_GAME_CLICKED);
  }

  /**
   * Pass the bomb to a specific player.
   * game.js validates first then calls this via EventBus.
   * @param {string} toPlayerId
   */
  function passBomb(toPlayerId) {
    _send(CONFIG.CLIENT_ACTIONS.PASS_BOMB, {
      roomId:     State.get('room.id'),
      holderId:   State.get('localPlayer.id'),
      toPlayerId,
      ts:         Date.now(),
    });
  }

  /**
   * Kick a player from the room (host only).
   * @param {string} playerId
   */
  function kickPlayer(playerId) {
    if (!State.isHost()) return;
    _send(CONFIG.CLIENT_ACTIONS.KICK_PLAYER, {
      roomId:   State.get('room.id'),
      playerId,
    });
  }

  /**
   * Gracefully disconnect from the server.
   */
  function disconnect() {
    _stopPing();
    _cancelReconnect();
    if (_socket) {
      _socket.disconnect();
      _socket = null;
    }
    _connected = false;
    State.merge('network', { connected: false, socketId: null });
  }

  /**
   * @returns {'connected'|'reconnecting'|'disconnected'}
   */
  function getStatus() {
    if (_connected)    return 'connected';
    if (_reconnecting) return 'reconnecting';
    return 'disconnected';
  }

  /**
   * @returns {number} Last measured ping in ms.
   */
  function getPing() {
    return _lastPing;
  }

  // ── Public surface ─────────────────────────────────────────────
  return Object.freeze({
    isAvailable,
    init,
    createRoom,
    joinRoom,
    setReady,
    startGame,
    passBomb,
    kickPlayer,
    disconnect,
    getStatus,
    getPing,
  });

})();
window.Network = Network;
