/**
 * PANIC BOMB — server.js
 * Node.js + Socket.io Game Server.
 *
 * Deploy on Render:
 *   1. Create a new Web Service on render.com
 *   2. Connect your GitHub repo (root dir, no subfolders)
 *   3. Build Command : npm install
 *   4. Start Command : node server.js
 *   5. Environment   : Node
 *   6. Name          : panic-bomb-server
 *
 * All game files live in the same directory — no src/, no folders.
 *
 * Depends on: express, socket.io, cors  (see package.json)
 */

'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const crypto    = require('crypto');

// ── Express + HTTP server ─────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── CORS origins ──────────────────────────────────────────────
// GitHub Pages frontend + local dev
const ALLOWED_ORIGINS = [
  'https://x150ll.github.io',
  'http://localhost',
  'http://127.0.0.1',
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
];

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
  transports:          ['websocket', 'polling'],
  pingInterval:        10_000,
  pingTimeout:         8_000,
  upgradeTimeout:      15_000,
  maxHttpBufferSize:   1e5,   // 100 KB max per message
});

// ── Config (mirrors client CONFIG) ───────────────────────────
const CFG = {
  ROOM: {
    CODE_LENGTH:  5,
    CODE_CHARS:   'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    MIN_PLAYERS:  2,
    MAX_PLAYERS:  8,
  },
  BOMB: {
    FAST:   { MIN: 15_000,  MAX: 40_000  },
    NORMAL: { MIN: 30_000,  MAX: 75_000  },
    SLOW:   { MIN: 50_000,  MAX: 120_000 },
  },
  PLAYER_COUNT_SPEED: { 2:.80, 3:.90, 4:1.00, 5:1.05, 6:1.10, 7:1.15, 8:1.20 },
  HOLD: {
    MAX_SECONDS:  6,
    PROB_PER_SEC: [0, 0.05, 0.15, 0.30, 0.50, 0.75, 0.90],
  },
  PASS: { COOLDOWN_MS: 1_500 },
  AFK:  { FAST_MS: 8_000, NORMAL_MS: 12_000, SLOW_MS: 18_000, WARN_MS: 3_000 },
  DISCONNECT: { GRACE_MS: 2_000, RECONNECT_WINDOW_MS: 30_000 },
  NETWORK: { LATENCY_FORGIVENESS_MS: 200 },
  ROUND_BETWEEN_MS: 3_000,
};

// ── In-memory store ───────────────────────────────────────────
// rooms: Map<code, Room>
const rooms = new Map();
// socketToRoom: Map<socketId, roomCode>
const socketToRoom = new Map();

// ── Room shape factory ────────────────────────────────────────
function makeRoom(code, hostSocket, settings) {
  return {
    code,
    hostId:   hostSocket.id,
    settings: {
      maxPlayers: settings.maxPlayers ?? 4,
      bombMode:   settings.bombMode   ?? 'normal',
      bestOf:     settings.bestOf     ?? 1,
    },
    players:  [],       // { id, name, avatar, isReady, isHost, status }
    game: {
      status:        'lobby',
      round:         0,
      activePlayers: [],
      eliminated:    [],
      currentHolder: null,
      explodeAt:     null,
      bombTimer:     null,   // JS timeout handle
      afkTimer:      null,
      afkWarnTimer:  null,
      holdData:      null,   // { playerId, startedAt, interval }
      matchScore:    {},
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────

function genCode() {
  const chars = CFG.ROOM.CODE_CHARS;
  let code = '';
  for (let i = 0; i < CFG.ROOM.CODE_LENGTH; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  // Ensure uniqueness
  return rooms.has(code) ? genCode() : code;
}

function sanitize(str, maxLen = 64) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').slice(0, maxLen);
}

function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId) ?? null;
}

function activePlayers(room) {
  return room.players.filter(p => room.game.activePlayers.includes(p.id));
}

function broadcastRoom(room, event, data) {
  io.to(room.code).emit(event, data);
}

function broadcastExcept(room, excludeId, event, data) {
  room.players
    .filter(p => p.id !== excludeId)
    .forEach(p => io.to(p.id).emit(event, data));
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, avatar: p.avatar, isReady: p.isReady, isHost: p.isHost, status: p.status };
}

function getBombRange(room) {
  const modeKey = (room.settings.bombMode ?? 'normal').toUpperCase();
  const range   = CFG.BOMB[modeKey] ?? CFG.BOMB.NORMAL;
  const count   = room.game.activePlayers.length;
  const multi   = CFG.PLAYER_COUNT_SPEED[count] ?? 1.0;
  return { min: Math.round(range.MIN * multi), max: Math.round(range.MAX * multi) };
}

function randomHolder(room, excludeId = null) {
  const pool = activePlayers(room)
    .filter(p => p.id !== excludeId)
    .map(p => p.id);
  if (pool.length === 0) return activePlayers(room)[0]?.id ?? null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function clearBombTimer(room) {
  clearTimeout(room.game.bombTimer);
  clearTimeout(room.game.afkTimer);
  clearTimeout(room.game.afkWarnTimer);
  room.game.bombTimer   = null;
  room.game.afkTimer    = null;
  room.game.afkWarnTimer = null;
}

function clearHold(room) {
  if (room.game.holdData?.interval) {
    clearInterval(room.game.holdData.interval);
  }
  room.game.holdData = null;
}

// ── Game flow ─────────────────────────────────────────────────

function startCountdown(room) {
  room.game.status = 'countdown';
  let count = 3;

  broadcastRoom(room, 'GAME_STARTING', { countdownFrom: count });

  const tick = setInterval(() => {
    count--;
    broadcastRoom(room, 'COUNTDOWN_TICK', { value: count });
    if (count <= 0) {
      clearInterval(tick);
      startRound(room);
    }
  }, 1000);
}

function startGame(room) {
  room.game.activePlayers = room.players.map(p => p.id);
  room.game.eliminated    = [];
  room.game.matchScore    = {};
  room.game.round         = 0;
  room.players.forEach(p => { p.status = 'active'; });
  startCountdown(room);
}

function startRound(room) {
  room.game.round++;
  room.game.status = 'in_game';
  room.game.currentHolder = null;
  room.game.explodeAt     = null;
  clearBombTimer(room);
  clearHold(room);

  broadcastRoom(room, 'GAME_STARTED', {
    round:         room.game.round,
    bombMode:      room.settings.bombMode,
    activePlayers: room.game.activePlayers,
  });

  broadcastRoom(room, 'ROUND_STARTED', {
    round:         room.game.round,
    activePlayers: room.game.activePlayers,
  });

  // Short pause then assign bomb
  setTimeout(() => assignBomb(room), CFG.ROUND_BETWEEN_MS);
}

function assignBomb(room) {
  const holderId = randomHolder(room);
  if (!holderId) return;

  const { min, max } = getBombRange(room);
  const duration  = min + Math.floor(Math.random() * (max - min));
  const explodeAt = Date.now() + duration;

  room.game.currentHolder  = holderId;
  room.game.explodeAt      = explodeAt;
  room.game.previousHolder = null;

  broadcastRoom(room, 'BOMB_ASSIGNED', {
    holderId,
    explodeAt,
    bombMode: room.settings.bombMode,
  });

  // Schedule explosion
  clearBombTimer(room);
  room.game.bombTimer = setTimeout(() => triggerExplosion(room), duration);

  // AFK timer for holder
  startAfkTimer(room, holderId);
}

function startAfkTimer(room, holderId) {
  clearTimeout(room.game.afkTimer);
  clearTimeout(room.game.afkWarnTimer);

  const modeMap = { fast: CFG.AFK.FAST_MS, normal: CFG.AFK.NORMAL_MS, slow: CFG.AFK.SLOW_MS };
  const totalMs = modeMap[room.settings.bombMode] ?? CFG.AFK.NORMAL_MS;
  const warnAt  = totalMs - CFG.AFK.WARN_MS;

  room.game.afkWarnTimer = setTimeout(() => {
    if (room.game.currentHolder === holderId) {
      io.to(holderId).emit('AFK_WARNING', { remainingMs: CFG.AFK.WARN_MS });
    }
  }, warnAt);

  room.game.afkTimer = setTimeout(() => {
    if (room.game.currentHolder !== holderId) return;
    // Auto-pass to random other player
    const targets = activePlayers(room).filter(p => p.id !== holderId);
    if (targets.length === 0) return;
    const toId = targets[Math.floor(Math.random() * targets.length)].id;
    doPassBomb(room, holderId, toId, true);
  }, totalMs);
}

function doPassBomb(room, fromId, toId, isAutoPass = false) {
  if (room.game.currentHolder !== fromId) return false;
  if (!room.game.activePlayers.includes(toId)) return false;

  clearTimeout(room.game.afkTimer);
  clearTimeout(room.game.afkWarnTimer);
  clearHold(room);

  room.game.previousHolder = fromId;
  room.game.currentHolder  = toId;

  broadcastRoom(room, 'BOMB_PASSED', { from: fromId, to: toId, at: Date.now() });

  if (isAutoPass) {
    broadcastRoom(room, 'AFK_AUTO_PASSED', { from: fromId, to: toId });
  }

  startAfkTimer(room, toId);
  return true;
}

function triggerExplosion(room) {
  clearBombTimer(room);
  clearHold(room);

  const victimId = room.game.currentHolder;
  if (!victimId) return;

  room.game.status        = 'explosion';
  room.game.currentHolder = null;

  // Remove from active
  room.game.activePlayers = room.game.activePlayers.filter(id => id !== victimId);
  room.game.eliminated.push(victimId);

  const victim = getPlayer(room, victimId);
  if (victim) victim.status = 'eliminated';

  broadcastRoom(room, 'BOMB_EXPLODED', {
    victimId,
    survivorIds: room.game.activePlayers,
  });

  broadcastRoom(room, 'PLAYER_ELIMINATED', {
    playerId:           victimId,
    survivorsRemaining: room.game.activePlayers.length,
    round:              room.game.round,
  });

  // Check win condition
  setTimeout(() => {
    if (room.game.activePlayers.length <= 1) {
      endGame(room);
    } else {
      // Next round
      broadcastRoom(room, 'ROUND_ENDED', {
        survivorId:   room.game.activePlayers[0] ?? null,
        nextRound:    room.game.round + 1,
        activePlayers: room.game.activePlayers,
      });
      setTimeout(() => startRound(room), CFG.ROUND_BETWEEN_MS);
    }
  }, 3_500);
}

function endGame(room) {
  room.game.status = 'game_over';
  const winnerId   = room.game.activePlayers[0] ?? null;

  // Build ranking: winner first, then eliminated in reverse order (last out first)
  const ranking = [];
  if (winnerId) {
    const w = getPlayer(room, winnerId);
    if (w) ranking.push({ id: w.id, name: w.name, avatar: w.avatar, eliminatedRound: null });
  }
  [...room.game.eliminated].reverse().forEach(id => {
    const p = getPlayer(room, id);
    if (p) ranking.push({ id: p.id, name: p.name, avatar: p.avatar, eliminatedRound: room.game.round });
  });

  broadcastRoom(room, 'GAME_OVER', {
    winnerId,
    ranking,
    matchScores: room.game.matchScore,
  });
}

// ── Rate limiting ─────────────────────────────────────────────
// Simple per-socket action rate limiter
const rateLimits = new Map();   // socketId → { action → lastTs }
const RATE_MS = {
  PASS_BOMB:   800,
  START_HOLD:  200,
  END_HOLD:    100,
  SET_READY:   400,
  START_GAME:  800,
  KICK_PLAYER: 1_000,
};

function checkRate(socketId, action) {
  if (!RATE_MS[action]) return true;
  let map = rateLimits.get(socketId);
  if (!map) { map = {}; rateLimits.set(socketId, map); }
  const now  = Date.now();
  const last = map[action] ?? 0;
  if (now - last < RATE_MS[action]) return false;
  map[action] = now;
  return true;
}

// ── Socket.io connection handler ──────────────────────────────
io.on('connection', (socket) => {

  // ── Helpers scoped to this socket ──────────────────────────

  function myRoom() {
    const code = socketToRoom.get(socket.id);
    return code ? rooms.get(code) : null;
  }

  function me() {
    const room = myRoom();
    return room ? getPlayer(room, socket.id) : null;
  }

  function deny(reason) {
    socket.emit('ROOM_ERROR', { message: reason });
  }

  // ── Central action dispatcher ───────────────────────────────
  socket.on('action', (envelope) => {
    if (!envelope?.action) return;

    const { action, seq } = envelope;
    if (!checkRate(socket.id, action)) return; // rate-limited, drop silently

    switch (action) {

      // ── CREATE ROOM ──────────────────────────────────────
      case 'CREATE_ROOM': {
        const { settings = {}, player = {} } = envelope;
        const name   = sanitize(player.name || 'Player', 16);
        const avatar = sanitize(player.avatar || '😈', 512);

        if (!name) { deny('Name is required'); return; }

        const code = genCode();
        const room = makeRoom(code, socket, {
          maxPlayers: Math.min(Math.max(parseInt(settings.maxPlayers) || 4, CFG.ROOM.MIN_PLAYERS), CFG.ROOM.MAX_PLAYERS),
          bombMode:   ['fast','normal','slow'].includes(settings.bombMode) ? settings.bombMode : 'normal',
          bestOf:     [1,3].includes(parseInt(settings.bestOf)) ? parseInt(settings.bestOf) : 1,
        });

        const p = { id: socket.id, name, avatar, isReady: false, isHost: true, status: 'connected' };
        room.players.push(p);
        rooms.set(code, room);
        socketToRoom.set(socket.id, code);
        socket.join(code);

        socket.emit('ROOM_CREATED', {
          roomId:      code,
          code,
          settings:    room.settings,
          localPlayer: publicPlayer(p),
          players:     room.players.map(publicPlayer),
        });
        break;
      }

      // ── JOIN ROOM ─────────────────────────────────────────
      case 'JOIN_ROOM': {
        const { code: rawCode, player = {}, reconnect = false, playerId } = envelope;
        const code   = sanitize(rawCode || '', 5).toUpperCase();
        const name   = sanitize(player.name || 'Player', 16);
        const avatar = sanitize(player.avatar || '😈', 512);

        const room = rooms.get(code);
        if (!room) { deny('Room not found'); return; }

        // Reconnect attempt
        if (reconnect && playerId) {
          const existing = room.players.find(p => p.id === playerId && p.status === 'disconnected');
          if (existing) {
            existing.id     = socket.id;
            existing.status = room.game.activePlayers.includes(playerId) ? 'active' : 'spectator';
            // Update active list
            const idx = room.game.activePlayers.indexOf(playerId);
            if (idx !== -1) room.game.activePlayers[idx] = socket.id;
            if (room.game.currentHolder === playerId) room.game.currentHolder = socket.id;
            socketToRoom.set(socket.id, code);
            socket.join(code);
            socket.emit('ROOM_JOINED', {
              roomId:       code,
              code,
              hostId:       room.hostId,
              settings:     room.settings,
              players:      room.players.map(publicPlayer),
              localPlayerId: socket.id,
            });
            broadcastExcept(room, socket.id, 'PLAYER_RECONNECTED', { playerId: socket.id, oldId: playerId });
            // Sync state
            socket.emit('FORCE_STATE_SYNC', {
              game:    room.game,
              players: room.players.map(publicPlayer),
            });
            return;
          }
        }

        if (room.game.status !== 'lobby') { deny('Game already started'); return; }
        if (room.players.length >= room.settings.maxPlayers) { deny('Room is full'); return; }
        if (!name) { deny('Name is required'); return; }

        const p = { id: socket.id, name, avatar, isReady: false, isHost: false, status: 'connected' };
        room.players.push(p);
        socketToRoom.set(socket.id, code);
        socket.join(code);

        socket.emit('ROOM_JOINED', {
          roomId:       code,
          code,
          hostId:       room.hostId,
          settings:     room.settings,
          players:      room.players.map(publicPlayer),
          localPlayerId: socket.id,
        });

        broadcastExcept(room, socket.id, 'PLAYER_JOINED', { player: publicPlayer(p) });
        break;
      }

      // ── SET READY ─────────────────────────────────────────
      case 'SET_READY': {
        const room = myRoom();
        const p    = me();
        if (!room || !p) return;
        if (room.game.status !== 'lobby') return;

        p.isReady = !!envelope.isReady;
        broadcastRoom(room, 'PLAYER_READY', { playerId: socket.id, isReady: p.isReady });
        break;
      }

      // ── START GAME ────────────────────────────────────────
      case 'START_GAME': {
        const room = myRoom();
        if (!room) return;
        if (room.hostId !== socket.id) { deny('Only the host can start'); return; }
        if (room.game.status !== 'lobby') return;
        if (room.players.length < CFG.ROOM.MIN_PLAYERS) { deny('Need at least 2 players'); return; }
        if (!room.players.every(p => p.isReady)) { deny('Not all players are ready'); return; }

        startGame(room);
        break;
      }

      // ── PASS BOMB ─────────────────────────────────────────
      case 'PASS_BOMB': {
        const room = myRoom();
        if (!room) return;
        if (room.game.status !== 'in_game') return;
        if (room.game.currentHolder !== socket.id) {
          socket.emit('PASS_REJECTED', { reason: 'not_holder' });
          return;
        }

        const { toPlayerId } = envelope;

        // Validate target
        if (!toPlayerId || !room.game.activePlayers.includes(toPlayerId)) {
          socket.emit('PASS_REJECTED', { reason: 'invalid_target' });
          return;
        }

        // No-backpass rule
        if (toPlayerId === room.game.previousHolder) {
          socket.emit('PASS_REJECTED', { reason: 'no_backpass' });
          return;
        }

        // Latency forgiveness: if bomb was just received (<200ms ago), still allow
        doPassBomb(room, socket.id, toPlayerId);
        break;
      }

      // ── START HOLD ────────────────────────────────────────
      case 'START_HOLD': {
        const room = myRoom();
        if (!room) return;
        if (room.game.currentHolder !== socket.id) return;
        if (room.game.holdData) return; // already holding

        const startedAt = Date.now();
        let seconds     = 0;

        const interval = setInterval(() => {
          seconds++;
          const probIdx = Math.min(seconds, CFG.HOLD.PROB_PER_SEC.length - 1);
          const prob    = CFG.HOLD.PROB_PER_SEC[probIdx];

          socket.emit('HOLD_ACKNOWLEDGED', { playerId: socket.id, seconds });

          if (Math.random() < prob || seconds >= CFG.HOLD.MAX_SECONDS) {
            clearInterval(interval);
            room.game.holdData = null;
            // Force explosion via the normal path
            triggerExplosion(room);
          }
        }, 1000);

        room.game.holdData = { playerId: socket.id, startedAt, interval };
        break;
      }

      // ── END HOLD ──────────────────────────────────────────
      case 'END_HOLD': {
        const room = myRoom();
        if (!room) return;

        const hd = room.game.holdData;
        if (!hd || hd.playerId !== socket.id) return;
        clearInterval(hd.interval);
        room.game.holdData = null;

        if (envelope.explode) {
          triggerExplosion(room);
        } else {
          socket.emit('HOLD_ACKNOWLEDGED', { playerId: socket.id, seconds: envelope.seconds ?? 0 });
        }
        break;
      }

      // ── KICK PLAYER ───────────────────────────────────────
      case 'KICK_PLAYER': {
        const room = myRoom();
        if (!room) return;
        if (room.hostId !== socket.id) return;

        const { playerId } = envelope;
        if (!playerId || playerId === socket.id) return;

        const target = getPlayer(room, playerId);
        if (!target) return;

        io.to(playerId).emit('PLAYER_KICKED', { playerId });
        room.players = room.players.filter(p => p.id !== playerId);
        socketToRoom.delete(playerId);
        io.sockets.sockets.get(playerId)?.leave(room.code);

        broadcastRoom(room, 'PLAYER_LEFT', { playerId });
        break;
      }

      default:
        break;
    }
  });

  // ── Ping/pong ─────────────────────────────────────────────
  socket.on('ping_check', () => {
    socket.emit('pong_check');
  });

  // ── Disconnect ────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const code = socketToRoom.get(socket.id);
    if (!code) { rateLimits.delete(socket.id); return; }

    const room = rooms.get(code);
    if (!room) { socketToRoom.delete(socket.id); rateLimits.delete(socket.id); return; }

    const player = getPlayer(room, socket.id);
    if (!player) { socketToRoom.delete(socket.id); rateLimits.delete(socket.id); return; }

    // Mark as disconnected for grace window
    player.status = 'disconnected';

    // Grace period: wait before treating as permanent leave
    const graceTimer = setTimeout(() => {
      // If player didn't reconnect, remove them
      if (player.status !== 'disconnected') return; // reconnected

      room.players = room.players.filter(p => p.id !== socket.id);
      socketToRoom.delete(socket.id);
      rateLimits.delete(socket.id);

      // Handle in-game disconnect
      if (room.game.activePlayers.includes(socket.id)) {
        room.game.activePlayers = room.game.activePlayers.filter(id => id !== socket.id);
        room.game.eliminated.push(socket.id);

        // If they were holding the bomb, pass it
        if (room.game.currentHolder === socket.id) {
          const nextHolder = randomHolder(room);
          if (nextHolder && room.game.activePlayers.length > 0) {
            room.game.currentHolder = nextHolder;
            broadcastRoom(room, 'BOMB_PASSED', { from: socket.id, to: nextHolder, at: Date.now() });
            startAfkTimer(room, nextHolder);
          } else if (room.game.activePlayers.length <= 1) {
            clearBombTimer(room);
            endGame(room);
          }
        }

        if (room.game.activePlayers.length <= 1 && room.game.status === 'in_game') {
          clearBombTimer(room);
          endGame(room);
        }
      }

      // Host transfer
      if (room.hostId === socket.id && room.players.length > 0) {
        room.hostId = room.players[0].id;
        room.players[0].isHost = true;
        broadcastRoom(room, 'HOST_TRANSFERRED', { newHostId: room.hostId });
      }

      broadcastRoom(room, 'PLAYER_LEFT', { playerId: socket.id, newHostId: room.hostId });

      // Clean up empty rooms
      if (room.players.length === 0) {
        clearBombTimer(room);
        clearHold(room);
        rooms.delete(code);
      }
    }, CFG.DISCONNECT.GRACE_MS);

    // Store timer on player so reconnect can cancel it
    player._graceTimer = graceTimer;

    broadcastExcept(room, socket.id, 'PLAYER_LEFT', { playerId: socket.id });
  });

});

// ── HTTP health check ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'ok',
    game:    'Panic Bomb',
    rooms:   rooms.size,
    players: [...rooms.values()].reduce((n, r) => n + r.players.length, 0),
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`💣 Panic Bomb server running on port ${PORT}`);
  startKeepAlive();
});

// ── Keep-Alive Self-Ping ──────────────────────────────────────
// Render free tier sleeps after 15 min of inactivity.
// We ping ourselves every 14 min (just under Render's 15-min sleep limit).
// cron-job.org pings every 5 min externally — this is the backup layer.
function startKeepAlive() {
  const SELF_URL    = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const INTERVAL_MS = 14 * 60 * 1000; // 14 min — just under Render 15-min sleep limit
  let   failStreak  = 0;

  function ping() {
    const url = `${SELF_URL}/health`;
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, (res) => {
      failStreak = 0;
      console.log(`[KeepAlive] ✅ ${new Date().toISOString()}`);
      res.resume(); // drain body so connection closes
    });
    req.on('error', (err) => {
      failStreak++;
      console.warn(`[KeepAlive] ❌ ${err.message} (streak: ${failStreak})`);
    });
    req.setTimeout(8000, () => { req.destroy(); failStreak++; });
  }

  // Wait 2 minutes after boot, then start pinging
  setTimeout(() => { ping(); setInterval(ping, INTERVAL_MS); }, 2 * 60 * 1000);
  console.log(`[KeepAlive] 🟢 Enabled — will ping ${SELF_URL}/health every 10 min`);
}
