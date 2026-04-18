/**
 * PANIC BOMB — config.js
 * Central configuration file.
 * All game constants live here. No magic numbers in other files.
 */

const CONFIG = Object.freeze({

  // ── Server ──────────────────────────────────────────────────────
  SERVER_URL: 'https://panic-bomb-server.onrender.com',

  // ── Room ────────────────────────────────────────────────────────
  ROOM: Object.freeze({
    CODE_LENGTH:       5,         // characters in room code
    CODE_CHARS:        'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // no O/0 or I/1
    MIN_PLAYERS:       2,
    MAX_PLAYERS:       8,
    JOIN_MAX_ATTEMPTS: 10,        // max wrong code attempts per minute
  }),

  // ── Player ──────────────────────────────────────────────────────
  PLAYER: Object.freeze({
    NAME_MIN_LENGTH:  1,
    NAME_MAX_LENGTH:  16,
    AVATAR_MAX_SIZE:  2 * 1024 * 1024,  // 2 MB
    DEFAULT_EMOJIS:   ['😈', '🤖', '👾', '💀', '🎭', '🦊'],
  }),

  // ── Bomb Timing (milliseconds) ──────────────────────────────────
  BOMB: Object.freeze({
    FAST:   Object.freeze({ MIN: 15_000,  MAX: 40_000  }),
    NORMAL: Object.freeze({ MIN: 30_000,  MAX: 75_000  }),
    SLOW:   Object.freeze({ MIN: 50_000,  MAX: 120_000 }),
  }),

  // ── Panic Thresholds (fraction of total bomb time remaining) ────
  PANIC: Object.freeze({
    LEVEL_0: 1.0,    // 100% → 60%  — CALM
    LEVEL_1: 0.60,   // 60%  → 30%  — TENSION
    LEVEL_2: 0.30,   // 30%  → 10%  — PANIC
    LEVEL_3: 0.10,   //        0%   — ULTRA PANIC
  }),

  // ── Panic visual parameters ──────────────────────────────────────
  PANIC_EFFECTS: Object.freeze({
    TINT_OPACITY: [0, 0.05, 0.20, 0.45],        // CSS opacity per level
    SHAKE_AMPLITUDE: [0, 0, 2, 6],               // px
    BOMB_SCALE: [1.0, 1.05, 1.15, 1.40],         // scale factor
    PULSE_SPEED: ['3s', '2.5s', '1.5s', '0.6s'], // CSS animation duration
    BVT_COLORS: ['#00ff88', '#ffd700', '#ff6b00', '#ff2d2d'],
  }),

  // ── HOLD mechanic ────────────────────────────────────────────────
  HOLD: Object.freeze({
    MAX_SECONDS:    6,
    // Explosion probability per second of holding (0–1)
    PROB_PER_SEC:   [0, 0.05, 0.15, 0.30, 0.50, 0.75, 0.90],
    // Minimum hold duration to count as intentional (ms)
    MIN_INTENTIONAL_MS: 500,
    // Badges awarded for hold duration
    BADGES: Object.freeze([
      { minSeconds: 2, label: 'Brave',    emoji: '🦁' },
      { minSeconds: 3, label: 'Reckless', emoji: '🎲' },
      { minSeconds: 4, label: 'Maniac',   emoji: '🔥' },
    ]),
  }),

  // ── Pass mechanic ────────────────────────────────────────────────
  PASS: Object.freeze({
    COOLDOWN_MS:          1_500,   // ms after receiving bomb before you can pass
    NO_BACKPASS_WINDOW_MS: 0,      // no backpass rule (same transfer)
  }),

  // ── AFK / Auto-pass ─────────────────────────────────────────────
  AFK: Object.freeze({
    FAST_MS:   8_000,
    NORMAL_MS: 12_000,
    SLOW_MS:   18_000,
    WARN_MS:   3_000,   // show warning this many ms before auto-pass
  }),

  // ── Disconnect / Reconnect ───────────────────────────────────────
  DISCONNECT: Object.freeze({
    GRACE_MS:          2_000,    // hold state before treating as eliminated
    RECONNECT_WINDOW_MS: 30_000, // allow rejoin as spectator within this window
  }),

  // ── Network fairness ─────────────────────────────────────────────
  NETWORK: Object.freeze({
    LATENCY_FORGIVENESS_MS: 200, // bomb "just arrived" window
    HIGH_PING_THRESHOLD_MS: 500, // show warning above this ping
    VERY_HIGH_PING_MS:     1_000, // treat as disconnect above this
  }),

  // ── Animation durations (milliseconds) ──────────────────────────
  ANIMATION: Object.freeze({
    PASS_ARC_MS:       300,
    EXPLOSION_MS:      3_000,
    ELIMINATION_MS:    3_000,
    COUNTDOWN_STEP_MS: 1_000,
    SCREEN_TRANSITION_MS: 400,
    WHITE_FLASH_MS:    150,
    SLOW_MO_TRIGGER_S: 3.0,     // seconds remaining when slow-mo starts
    SLOW_MO_FACTOR:    0.5,     // playback speed multiplier
    AUDIO_DROP_AT_S:   2.0,     // seconds remaining when audio drops
    FAKE_OUT_MIN_INTERVAL_MS: 20_000, // minimum gap between fake-outs
  }),

  // ── Fake-out settings ────────────────────────────────────────────
  FAKE_OUT: Object.freeze({
    MAX_PER_GAME:       2,
    EARLIEST_FRACTION:  0.35,  // can start at this fraction of bomb time
    LATEST_FRACTION:    0.08,  // won't trigger if less than this fraction left
    PROBABILITY:        0.20,  // base probability of a fake-out per round
  }),

  // ── Round settings ───────────────────────────────────────────────
  ROUND: Object.freeze({
    BETWEEN_ROUND_MS:       3_000,  // pause before next round starts
    REVEAL_BOMB_HOLDER_MS:  2_000,  // suspense before bomb is assigned
  }),

  // ── Spectator reactions ──────────────────────────────────────────
  SPECTATOR: Object.freeze({
    REACTION_COOLDOWN_MS: 800,
    REACTION_EMOJIS: ['😱', '🤣', '👀', '🔥', '💀'],
  }),

  // ── Player count → timer multipliers ────────────────────────────
  PLAYER_COUNT_SPEED: Object.freeze({
    2: 0.80,
    3: 0.90,
    4: 1.00,
    5: 1.05,
    6: 1.10,
    7: 1.15,
    8: 1.20,
  }),

  // ── Screen names (used in State and EventBus) ───────────────────
  SCREENS: Object.freeze({
    LANDING:    'landing',
    ROOM:       'room',
    SETUP:      'setup',
    LOBBY:      'lobby',
    COUNTDOWN:  'countdown',
    GAME:       'game',
    EXPLOSION:  'explosion',
    RESULTS:    'results',
  }),

  // ── Game states (server-authoritative) ──────────────────────────
  GAME_STATUS: Object.freeze({
    IDLE:        'idle',
    LOBBY:       'lobby',
    COUNTDOWN:   'countdown',
    IN_GAME:     'in_game',
    EXPLOSION:   'explosion',
    ROUND_END:   'round_end',
    GAME_OVER:   'game_over',
  }),

  // ── Player states ────────────────────────────────────────────────
  PLAYER_STATUS: Object.freeze({
    CONNECTED:    'connected',
    READY:        'ready',
    ACTIVE:       'active',
    HOLDING:      'holding',    // currently doing HOLD
    ELIMINATED:   'eliminated',
    SPECTATOR:    'spectator',
    DISCONNECTED: 'disconnected',
  }),

  // ── Server-to-client event names ────────────────────────────────
  SERVER_EVENTS: Object.freeze({
    ROOM_CREATED:        'ROOM_CREATED',
    ROOM_JOINED:         'ROOM_JOINED',
    ROOM_ERROR:          'ROOM_ERROR',
    PLAYER_JOINED:       'PLAYER_JOINED',
    PLAYER_LEFT:         'PLAYER_LEFT',
    PLAYER_READY:        'PLAYER_READY',
    PLAYER_KICKED:       'PLAYER_KICKED',
    GAME_STARTING:       'GAME_STARTING',
    COUNTDOWN_TICK:      'COUNTDOWN_TICK',
    GAME_STARTED:        'GAME_STARTED',
    ROUND_STARTED:       'ROUND_STARTED',
    BOMB_ASSIGNED:       'BOMB_ASSIGNED',
    BOMB_PASSED:         'BOMB_PASSED',
    PASS_REJECTED:       'PASS_REJECTED',
    HOLD_ACKNOWLEDGED:   'HOLD_ACKNOWLEDGED',
    BOMB_EXPLODED:       'BOMB_EXPLODED',
    FAKE_OUT:            'FAKE_OUT',
    PLAYER_ELIMINATED:   'PLAYER_ELIMINATED',
    ROUND_ENDED:         'ROUND_ENDED',
    GAME_OVER:           'GAME_OVER',
    FORCE_STATE_SYNC:    'FORCE_STATE_SYNC',
    AFK_WARNING:         'AFK_WARNING',
    AFK_AUTO_PASSED:     'AFK_AUTO_PASSED',
    HOST_TRANSFERRED:    'HOST_TRANSFERRED',
    PLAYER_RECONNECTED:  'PLAYER_RECONNECTED',
  }),

  // ── Client-to-server action names ───────────────────────────────
  CLIENT_ACTIONS: Object.freeze({
    CREATE_ROOM: 'CREATE_ROOM',
    JOIN_ROOM:   'JOIN_ROOM',
    SET_READY:   'SET_READY',
    START_GAME:  'START_GAME',
    PASS_BOMB:   'PASS_BOMB',
    START_HOLD:  'START_HOLD',
    END_HOLD:    'END_HOLD',
    KICK_PLAYER: 'KICK_PLAYER',
  }),

  // ── Internal EventBus event names ────────────────────────────────
  EVENTS: Object.freeze({
    // UI input
    PASS_REQUESTED:       'PASS_REQUESTED',
    HOLD_STARTED:         'HOLD_STARTED',
    HOLD_ENDED:           'HOLD_ENDED',
    READY_TOGGLED:        'READY_TOGGLED',
    NAME_ENTERED:         'NAME_ENTERED',
    AVATAR_CHANGED:       'AVATAR_CHANGED',
    ROOM_CODE_ENTERED:    'ROOM_CODE_ENTERED',
    CREATE_ROOM_CLICKED:  'CREATE_ROOM_CLICKED',
    JOIN_ROOM_CLICKED:    'JOIN_ROOM_CLICKED',
    START_GAME_CLICKED:   'START_GAME_CLICKED',

    // Game logic
    PANIC_LEVEL_CHANGED:  'PANIC_LEVEL_CHANGED',
    ROUND_STARTED_LOCAL:  'ROUND_STARTED_LOCAL',
    FAKE_OUT_TRIGGERED:   'FAKE_OUT_TRIGGERED',
    HOLD_ROULETTE_TICK:   'HOLD_ROULETTE_TICK',
    AFK_TIMER_WARNING:    'AFK_TIMER_WARNING',

    // Network
    NETWORK_CONNECTED:    'NETWORK_CONNECTED',
    NETWORK_DISCONNECTED: 'NETWORK_DISCONNECTED',
    NETWORK_ERROR:        'NETWORK_ERROR',

    // Visual / audio triggers
    ANIMATION_TRIGGER:    'ANIMATION_TRIGGER',
    ANIMATION_DONE:       'ANIMATION_DONE',
    AUDIO_TRIGGER:        'AUDIO_TRIGGER',
    AUDIO_STOP:           'AUDIO_STOP',

    // UI system
    UI_SCREEN_CHANGE:     'UI_SCREEN_CHANGE',
    UI_UPDATE_PLAYERS:    'UI_UPDATE_PLAYERS',
    UI_UPDATE_BOMB:       'UI_UPDATE_BOMB',
    UI_SHOW_TOAST:        'UI_SHOW_TOAST',

    // State
    STATE_CHANGED:        'STATE_CHANGED',
  }),

  // ── Audio clip IDs ───────────────────────────────────────────────
  AUDIO: Object.freeze({
    BGM_CALM:        'bgm_calm',
    BGM_TENSION:     'bgm_tension',
    BGM_PANIC:       'bgm_panic',
    BGM_FINAL_DUEL:  'bgm_final_duel',
    SFX_WHOOSH:      'sfx_whoosh',
    SFX_THUD:        'sfx_thud',
    SFX_HEARTBEAT:   'sfx_heartbeat',
    SFX_EXPLOSION:   'sfx_explosion',
    SFX_ELIMINATION: 'sfx_elimination',
    SFX_WIN:         'sfx_win',
    SFX_COUNTDOWN:   'sfx_countdown',
    SFX_PASS_READY:  'sfx_pass_ready',
    SFX_TICK:        'sfx_tick',
    SFX_FAKE_OUT:    'sfx_fake_out',
    SFX_DING:        'sfx_ding',
  }),

  // ── Animation type IDs ───────────────────────────────────────────
  ANIM: Object.freeze({
    BOMB_ARC:         'bomb_arc',
    EXPLOSION:        'explosion',
    WHITE_FLASH:      'white_flash',
    SCREEN_SHAKE:     'screen_shake',
    BOMB_PULSE:       'bomb_pulse',
    HOLD_GLOW:        'hold_glow',
    FOCUS_EFFECT:     'focus_effect',
    SLOW_MOTION:      'slow_motion',
    CARD_ENTER:       'card_enter',
    CARD_EXIT:        'card_exit',
    PANIC_TINT:       'panic_tint',
    FAKE_OUT_RELIEF:  'fake_out_relief',
    COUNTDOWN_POP:    'countdown_pop',
    WINNER_CONFETTI:  'winner_confetti',
  }),

});
