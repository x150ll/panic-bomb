/**
 * PANIC BOMB — state.js
 * Central State Manager.
 *
 * Single source of truth for all game state.
 * State is mutated ONLY through State.set() or State.merge().
 * Every mutation emits CONFIG.EVENTS.STATE_CHANGED automatically.
 *
 * Depends on: config.js, events.js
 */

const State = (() => {

  // ── Default / initial shape ────────────────────────────────────
  function _makeInitial() {
    return {
      // Current visible screen
      screen: CONFIG.SCREENS.LANDING,

      // Network status
      network: {
        connected:    false,
        reconnecting: false,
        ping:         0,
        socketId:     null,
      },

      // Room information (set after create / join)
      room: {
        id:         null,   // internal server ID
        code:       null,   // human-readable 5-char code
        hostId:     null,   // socket/player ID of current host
        settings: {
          maxPlayers:  4,
          bombMode:    'normal',   // 'fast' | 'normal' | 'slow'
          bestOf:      1,          // 1 or 3
        },
      },

      // Local player (this client)
      localPlayer: {
        id:       null,
        name:     '',
        avatar:   '',    // emoji char or base64 data-URL
        isReady:  false,
        isHost:   false,
      },

      // All players in the room (including local)
      // Shape per entry: { id, name, avatar, isReady, isHost, status, badge }
      players: [],

      // Active game state (populated once game starts)
      game: {
        status:          CONFIG.GAME_STATUS.IDLE,
        round:           0,
        matchScore: {},  // { playerId: wins }   for best-of-3
        explodeAt:       null,    // absolute timestamp (ms)
        bombMode:        'normal',
        currentHolder:   null,    // player id
        previousHolder:  null,    // for no-backpass rule
        inTransit:       false,   // true while arc animation plays
        transitFrom:     null,
        transitTo:       null,
        panicLevel:      0,       // 0–3
        holdStartedAt:   null,    // timestamp when current HOLD began
        holdDuration:    0,       // seconds held so far (updated by game.js)
        afkTimer:        null,    // JS timeout id (managed by game.js)
        fakeOutCount:    0,
        fakeOutActive:   false,
        activePlayers:   [],      // ids of non-eliminated players
        eliminated:      [],      // ids in elimination order (first out = index 0)
        badgesThisRound: {},      // { playerId: [badge, ...] }
        slowMotionActive: false,
      },

      // Results (populated at game-over)
      results: {
        winnerId:    null,
        ranking:     [],  // [ { id, name, avatar, eliminatedRound } ] first=winner
        matchScores: {},
      },

      // UI transient state (not game logic, just view state)
      ui: {
        passSelectorOpen: false,
        passOnCooldown:   false,
        cooldownEndAt:    null,
        toastQueue:       [],
        countdownValue:   3,
      },
    };
  }

  // ── Internal storage ──────────────────────────────────────────
  let _state = _makeInitial();

  // ── Path resolver (supports dot notation: 'game.status') ──────
  function _resolvePath(obj, pathStr) {
    const parts = pathStr.split('.');
    let cursor = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cursor == null || typeof cursor !== 'object') return { parent: null, key: null };
      cursor = cursor[parts[i]];
    }
    return { parent: cursor, key: parts[parts.length - 1] };
  }

  // ── Deep clone (shallow for performance on leaf values) ────────
  function _clone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(_clone);
    const out = {};
    for (const k of Object.keys(value)) out[k] = _clone(value[k]);
    return out;
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Read a value by dot-notation path.
   * Returns a deep clone to prevent accidental mutation.
   * @param {string} path   e.g. 'game.currentHolder'
   * @returns {*}
   */
  function get(path) {
    if (!path) return _clone(_state);
    const { parent, key } = _resolvePath(_state, path);
    if (parent == null) {
      console.warn(`[State] get("${path}"): path not found`);
      return undefined;
    }
    return _clone(parent[key]);
  }

  /**
   * Set a value by dot-notation path and emit STATE_CHANGED.
   * @param {string} path
   * @param {*}      value
   * @param {boolean} [silent=false]  If true, suppresses STATE_CHANGED.
   */
  function set(path, value, silent = false) {
    const { parent, key } = _resolvePath(_state, path);
    if (parent == null) {
      console.warn(`[State] set("${path}"): path not found — cannot set`);
      return;
    }
    const prev = parent[key];
    parent[key] = value;

    if (!silent) {
      EventBus.emit(CONFIG.EVENTS.STATE_CHANGED, { path, value, prev });
    }
  }

  /**
   * Shallow-merge an object into a sub-object at path.
   * Useful for updating multiple fields at once without replacing the whole object.
   * @param {string} path    Must point to an object.
   * @param {Object} partial
   * @param {boolean} [silent=false]
   */
  function merge(path, partial, silent = false) {
    const { parent, key } = _resolvePath(_state, path);
    if (parent == null || typeof parent[key] !== 'object' || parent[key] === null) {
      console.warn(`[State] merge("${path}"): target is not an object`);
      return;
    }
    Object.assign(parent[key], partial);
    if (!silent) {
      EventBus.emit(CONFIG.EVENTS.STATE_CHANGED, { path, value: parent[key], merged: partial });
    }
  }

  /**
   * Push a value into an array at path.
   * @param {string} path
   * @param {*}      value
   * @param {boolean} [silent=false]
   */
  function push(path, value, silent = false) {
    const { parent, key } = _resolvePath(_state, path);
    if (!Array.isArray(parent?.[key])) {
      console.warn(`[State] push("${path}"): target is not an array`);
      return;
    }
    parent[key].push(value);
    if (!silent) {
      EventBus.emit(CONFIG.EVENTS.STATE_CHANGED, { path, pushed: value });
    }
  }

  /**
   * Remove item(s) from an array at path using a predicate.
   * @param {string}   path
   * @param {Function} predicate  (item) => boolean — items where true are removed.
   * @param {boolean}  [silent=false]
   */
  function remove(path, predicate, silent = false) {
    const { parent, key } = _resolvePath(_state, path);
    if (!Array.isArray(parent?.[key])) {
      console.warn(`[State] remove("${path}"): target is not an array`);
      return;
    }
    parent[key] = parent[key].filter(item => !predicate(item));
    if (!silent) {
      EventBus.emit(CONFIG.EVENTS.STATE_CHANGED, { path, operation: 'remove' });
    }
  }

  /**
   * Reset entire state to initial values.
   * @param {boolean} [silent=false]
   */
  function reset(silent = false) {
    _state = _makeInitial();
    if (!silent) {
      EventBus.emit(CONFIG.EVENTS.STATE_CHANGED, { path: '*', operation: 'reset' });
    }
  }

  /**
   * Reset only game-related state (keep room + player info).
   * Used when starting a new match in the same room.
   */
  function resetGame(silent = false) {
    const initial = _makeInitial();
    _state.game     = initial.game;
    _state.results  = initial.results;
    _state.ui.passSelectorOpen = false;
    _state.ui.passOnCooldown   = false;
    _state.ui.cooldownEndAt    = null;
    if (!silent) {
      EventBus.emit(CONFIG.EVENTS.STATE_CHANGED, { path: 'game', operation: 'reset' });
    }
  }

  // ── Convenience selectors ──────────────────────────────────────
  // These avoid spreading dot-path strings everywhere.

  /** @returns {Object|null} The local player object from players array. */
  function getLocalPlayerFull() {
    const { id } = _state.localPlayer;
    return _state.players.find(p => p.id === id) ?? null;
  }

  /** @returns {Object|null} Player object by id. */
  function getPlayerById(id) {
    return _state.players.find(p => p.id === id) ?? null;
  }

  /** @returns {boolean} Whether local player is the room host. */
  function isHost() {
    return _state.localPlayer.isHost === true;
  }

  /** @returns {boolean} Whether local player currently holds the bomb. */
  function isHolder() {
    return _state.game.currentHolder === _state.localPlayer.id;
  }

  /** @returns {boolean} Whether local player is still active (not eliminated). */
  function isActivePlayer() {
    return _state.game.activePlayers.includes(_state.localPlayer.id);
  }

  /** @returns {string|null} The player id of the current bomb holder. */
  function getCurrentHolder() {
    return _state.game.currentHolder;
  }

  /** @returns {number} Active (non-eliminated) player count. */
  function activePlayerCount() {
    return _state.game.activePlayers.length;
  }

  /** @returns {Array} All players that are currently active. */
  function getActivePlayers() {
    return _state.players.filter(p =>
      _state.game.activePlayers.includes(p.id)
    );
  }

  /** @returns {number} ms remaining until explosion (-1 if not set). */
  function getBombTimeRemaining() {
    if (!_state.game.explodeAt) return -1;
    return Math.max(0, _state.game.explodeAt - Date.now());
  }

  /** @returns {number} 0–1 fraction of bomb time remaining. */
  function getBombFraction() {
    if (!_state.game.explodeAt || !_state._bombTotalMs) return 1;
    return Math.max(0, getBombTimeRemaining() / _state._bombTotalMs);
  }

  // _bombTotalMs is set by game.js when a round starts — not in initial shape
  // to keep it easy to clear, we store it on _state directly (private by convention)

  /**
   * Store the total bomb duration for the current round.
   * Called by game.js.
   * @param {number} ms
   */
  function setBombTotal(ms) {
    _state._bombTotalMs = ms;
  }

  // ── Public surface ─────────────────────────────────────────────
  return Object.freeze({
    get,
    set,
    merge,
    push,
    remove,
    reset,
    resetGame,
    // Selectors
    getLocalPlayerFull,
    getPlayerById,
    isHost,
    isHolder,
    isActivePlayer,
    getCurrentHolder,
    activePlayerCount,
    getActivePlayers,
    getBombTimeRemaining,
    getBombFraction,
    setBombTotal,
  });

})();
