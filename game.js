/**
 * PANIC BOMB — game.js
 * Core Game Logic Engine.
 *
 * Responsibilities:
 *   • Listens to server events (via EventBus, forwarded by network.js)
 *   • Applies game rules and updates State
 *   • Manages bomb timer, panic phases, HOLD roulette, AFK timer
 *   • Emits animation + audio triggers
 *   • Does NOT touch the DOM — that is ui.js's job
 *
 * Depends on: config.js, events.js, state.js
 */

const Game = (() => {

  // ── Internal timers & intervals ───────────────────────────────
  let _panicInterval    = null;   // polls bomb time → updates panic level
  let _holdInterval     = null;   // ticks every 1s during HOLD
  let _afkTimeout       = null;   // fires if holder goes AFK
  let _afkWarnTimeout   = null;   // fires shortly before AFK auto-pass
  let _fakeOutTimeout   = null;   // scheduled fake-out
  let _cooldownTimeout  = null;   // clears pass cooldown flag

  // ── Helpers ───────────────────────────────────────────────────

  /** Emit a named animation trigger. */
  function _anim(type, payload = {}) {
    EventBus.emit(CONFIG.EVENTS.ANIMATION_TRIGGER, { type, ...payload });
  }

  /** Emit a named audio trigger. */
  function _audio(type, options = {}) {
    EventBus.emit(CONFIG.EVENTS.AUDIO_TRIGGER, { type, ...options });
  }

  /** Stop all running internal timers. */
  function _clearAllTimers() {
    clearInterval(_panicInterval);
    clearInterval(_holdInterval);
    clearTimeout(_afkTimeout);
    clearTimeout(_afkWarnTimeout);
    clearTimeout(_fakeOutTimeout);
    clearTimeout(_cooldownTimeout);
    _panicInterval  = null;
    _holdInterval   = null;
    _afkTimeout     = null;
    _afkWarnTimeout = null;
    _fakeOutTimeout = null;
    _cooldownTimeout = null;
  }

  /**
   * Pick a random valid initial bomb holder that is:
   * - currently active
   * - not the same as the last round's starter (fairness)
   * Only used client-side for UI hints; server decides authoritatively.
   */
  function _pickRandomHolder(excludeId = null) {
    const active = State.getActivePlayers();
    const pool   = excludeId ? active.filter(p => p.id !== excludeId) : active;
    if (pool.length === 0) return active[0]?.id ?? null;
    return pool[Math.floor(Math.random() * pool.length)].id;
  }

  /**
   * Compute the bomb timer range for the current settings + player count.
   * Returns { min, max } in ms.
   */
  function _getBombTimeRange() {
    const mode  = State.get('game.bombMode') || 'normal';
    const count = State.activePlayerCount();
    const range = CONFIG.BOMB[mode.toUpperCase()] ?? CONFIG.BOMB.NORMAL;
    const multi = CONFIG.PLAYER_COUNT_SPEED[count] ?? 1.0;
    return {
      min: Math.round(range.MIN * multi),
      max: Math.round(range.MAX * multi),
    };
  }

  /**
   * Determine the AFK timeout in ms for current bomb mode.
   */
  function _getAfkTimeout() {
    const mode = State.get('game.bombMode') || 'normal';
    const map  = { fast: CONFIG.AFK.FAST_MS, normal: CONFIG.AFK.NORMAL_MS, slow: CONFIG.AFK.SLOW_MS };
    return map[mode] ?? CONFIG.AFK.NORMAL_MS;
  }

  // ── Panic System ──────────────────────────────────────────────

  /**
   * Determine panic level (0–3) from fraction of bomb time remaining.
   * 0 = CALM, 1 = TENSION, 2 = PANIC, 3 = ULTRA PANIC
   */
  function _panicLevelFromFraction(fraction) {
    if (fraction > CONFIG.PANIC.LEVEL_1) return 0;
    if (fraction > CONFIG.PANIC.LEVEL_2) return 1;
    if (fraction > CONFIG.PANIC.LEVEL_3) return 2;
    return 3;
  }

  /** Start polling bomb fraction → update panic level & visual vars. */
  function _startPanicMonitor() {
    _stopPanicMonitor();

    _panicInterval = setInterval(() => {
      const fraction    = State.getBombFraction();
      const newLevel    = _panicLevelFromFraction(fraction);
      const currentLevel = State.get('game.panicLevel');

      // Update BVT fill width
      EventBus.emit(CONFIG.EVENTS.UI_UPDATE_BOMB, {
        fraction,
        panicLevel: newLevel,
      });

      if (newLevel !== currentLevel) {
        State.set('game.panicLevel', newLevel, true); // silent — ui listens to PANIC_LEVEL_CHANGED
        EventBus.emit(CONFIG.EVENTS.PANIC_LEVEL_CHANGED, { level: newLevel, fraction });
        _onPanicLevelChange(newLevel);
      }

      // Slow-motion trigger
      const remaining = State.getBombTimeRemaining();
      if (remaining <= CONFIG.ANIMATION.SLOW_MO_TRIGGER_S * 1000 &&
          !State.get('game.slowMotionActive')) {
        State.set('game.slowMotionActive', true, true);
        _anim(CONFIG.ANIM.SLOW_MOTION, { start: true });
        _audio(CONFIG.AUDIO.SFX_TICK, { slowMo: true });
      }

      // Audio drop
      if (remaining <= CONFIG.ANIMATION.AUDIO_DROP_AT_S * 1000 &&
          remaining > 0) {
        _audio(CONFIG.AUDIO.BGM_PANIC, { drop: true });
      }

    }, 200); // 5 fps is enough for visual updates
  }

  function _stopPanicMonitor() {
    clearInterval(_panicInterval);
    _panicInterval = null;
  }

  /** React to a panic level transition with audio + visual triggers. */
  function _onPanicLevelChange(level) {
    const effects = CONFIG.PANIC_EFFECTS;
    _anim(CONFIG.ANIM.PANIC_TINT, {
      opacity:   effects.TINT_OPACITY[level],
      bombScale: effects.BOMB_SCALE[level],
      pulseSpeed: effects.PULSE_SPEED[level],
    });

    if (level === 1) {
      _audio(CONFIG.AUDIO.BGM_TENSION, { fadeIn: true });
    } else if (level === 2) {
      _audio(CONFIG.AUDIO.BGM_PANIC,   { fadeIn: true });
      _audio(CONFIG.AUDIO.SFX_HEARTBEAT, { start: true });
      _anim(CONFIG.ANIM.SCREEN_SHAKE, { intensity: 'light' });
    } else if (level === 3) {
      _audio(CONFIG.AUDIO.SFX_HEARTBEAT, { fast: true });
      _anim(CONFIG.ANIM.SCREEN_SHAKE, { intensity: 'medium', continuous: true });
    }
  }

  // ── AFK Timer ─────────────────────────────────────────────────

  /** Start the AFK auto-pass countdown for the local holder. */
  function _startAfkTimer() {
    _clearAfkTimer();
    if (!State.isHolder()) return;

    const totalMs = _getAfkTimeout();
    const warnAt  = totalMs - CONFIG.AFK.WARN_MS;

    // Warning
    _afkWarnTimeout = setTimeout(() => {
      if (State.isHolder()) {
        EventBus.emit(CONFIG.EVENTS.AFK_TIMER_WARNING, { remainingMs: CONFIG.AFK.WARN_MS });
      }
    }, warnAt);

    // Auto-pass
    _afkTimeout = setTimeout(() => {
      if (State.isHolder()) {
        // Server will handle actual auto-pass, but emit local event for UI
        EventBus.emit(CONFIG.EVENTS.PASS_REQUESTED, { auto: true, toPlayerId: null });
      }
    }, totalMs);
  }

  function _clearAfkTimer() {
    clearTimeout(_afkTimeout);
    clearTimeout(_afkWarnTimeout);
    _afkTimeout     = null;
    _afkWarnTimeout = null;
  }

  // ── Pass Cooldown ─────────────────────────────────────────────

  /** Start the post-receive cooldown (prevents immediate pass spam). */
  function _startPassCooldown() {
    State.set('ui.passOnCooldown', true, true);
    const endAt = Date.now() + CONFIG.PASS.COOLDOWN_MS;
    State.set('ui.cooldownEndAt', endAt, true);

    clearTimeout(_cooldownTimeout);
    _cooldownTimeout = setTimeout(() => {
      State.set('ui.passOnCooldown', false, true);
      State.set('ui.cooldownEndAt', null, true);
      EventBus.emit(CONFIG.EVENTS.ANIMATION_TRIGGER, {
        type: CONFIG.ANIM.BOMB_PULSE,
        ready: true,
      });
      _audio(CONFIG.AUDIO.SFX_PASS_READY);
    }, CONFIG.PASS.COOLDOWN_MS);
  }

  // ── HOLD Roulette ─────────────────────────────────────────────

  /**
   * Start the HOLD danger roulette.
   * Each second, spins a random check; if it hits the threshold, requests explosion.
   */
  function _startHoldRoulette() {
    _stopHoldRoulette();
    State.set('game.holdStartedAt', Date.now(), true);
    State.set('game.holdDuration', 0, true);

    _holdInterval = setInterval(() => {
      const started = State.get('game.holdStartedAt');
      if (!started) { _stopHoldRoulette(); return; }

      const seconds = Math.floor((Date.now() - started) / 1000);
      State.set('game.holdDuration', seconds, true);

      const maxSec  = CONFIG.HOLD.MAX_SECONDS;
      const probIdx = Math.min(seconds, CONFIG.HOLD.PROB_PER_SEC.length - 1);
      const prob    = CONFIG.HOLD.PROB_PER_SEC[probIdx];

      EventBus.emit(CONFIG.EVENTS.HOLD_ROULETTE_TICK, { seconds, probability: prob });

      // Check if hit
      if (Math.random() < prob) {
        _stopHoldRoulette();
        // Notify network — server decides if this truly explodes
        EventBus.emit(CONFIG.EVENTS.HOLD_STARTED, { forceExplode: true, seconds });
      }

      // Hard cap
      if (seconds >= maxSec) {
        _stopHoldRoulette();
        EventBus.emit(CONFIG.EVENTS.HOLD_STARTED, { forceExplode: true, seconds });
      }
    }, 1000);
  }

  function _stopHoldRoulette() {
    clearInterval(_holdInterval);
    _holdInterval = null;
    State.set('game.holdStartedAt', null, true);
    State.set('game.holdDuration',  0,    true);
  }

  // ── Fake-out Logic ────────────────────────────────────────────

  /**
   * Possibly schedule a fake-out explosion for this round.
   * Called once per round after the bomb is assigned.
   */
  function _maybeScheduleFakeOut() {
    const game = State.get('game');
    if (game.fakeOutCount >= CONFIG.FAKE_OUT.MAX_PER_GAME) return;
    if (Math.random() > CONFIG.FAKE_OUT.PROBABILITY) return;

    const remaining = State.getBombTimeRemaining();
    const earliest  = remaining * (1 - CONFIG.FAKE_OUT.EARLIEST_FRACTION);
    const latest    = remaining * (1 - CONFIG.FAKE_OUT.LATEST_FRACTION);
    if (earliest >= latest) return;

    const triggerAt = earliest + Math.random() * (latest - earliest);

    clearTimeout(_fakeOutTimeout);
    _fakeOutTimeout = setTimeout(() => {
      // Confirm conditions still allow a fake-out
      const frac = State.getBombFraction();
      if (frac < CONFIG.FAKE_OUT.LATEST_FRACTION) return;
      if (State.get('game.fakeOutCount') >= CONFIG.FAKE_OUT.MAX_PER_GAME) return;

      State.set('game.fakeOutCount', (State.get('game.fakeOutCount') || 0) + 1, true);
      State.set('game.fakeOutActive', true, true);
      EventBus.emit(CONFIG.EVENTS.FAKE_OUT_TRIGGERED);
      _onFakeOut();
    }, triggerAt);
  }

  function _onFakeOut() {
    // Panic sounds then relief
    _anim(CONFIG.ANIM.SCREEN_SHAKE, { intensity: 'heavy' });
    _audio(CONFIG.AUDIO.SFX_FAKE_OUT);

    setTimeout(() => {
      State.set('game.fakeOutActive', false, true);
      _anim(CONFIG.ANIM.FAKE_OUT_RELIEF);
      State.set('game.panicLevel', 1, true); // reset to TENSION
      EventBus.emit(CONFIG.EVENTS.PANIC_LEVEL_CHANGED, { level: 1, fakeOut: true });
    }, 600);
  }

  // ── Badge Awarding ────────────────────────────────────────────

  function _checkHoldBadge(playerId, secondsHeld) {
    const badges = CONFIG.HOLD.BADGES;
    let awarded = null;
    for (let i = badges.length - 1; i >= 0; i--) {
      if (secondsHeld >= badges[i].minSeconds) {
        awarded = badges[i];
        break;
      }
    }
    if (!awarded) return;

    const current = State.get('game.badgesThisRound') ?? {};
    const playerBadges = current[playerId] ?? [];
    // Avoid duplicates
    if (!playerBadges.find(b => b.label === awarded.label)) {
      playerBadges.push(awarded);
      current[playerId] = playerBadges;
      State.set('game.badgesThisRound', current, true);
      EventBus.emit(CONFIG.EVENTS.UI_UPDATE_PLAYERS, { badge: { playerId, badge: awarded } });
    }
  }

  // ── Server Event Handlers ─────────────────────────────────────

  function _onRoomCreated(data) {
    // { roomId, code, settings, localPlayer }
    State.merge('room', {
      id:       data.roomId,
      code:     data.code,
      hostId:   data.localPlayer.id,
      settings: data.settings ?? State.get('room.settings'),
    });
    State.merge('localPlayer', {
      id:     data.localPlayer.id,
      isHost: true,
    });
    State.set('game.status', CONFIG.GAME_STATUS.LOBBY);
    EventBus.emit(CONFIG.EVENTS.UI_SCREEN_CHANGE, CONFIG.SCREENS.LOBBY);
  }

  function _onRoomJoined(data) {
    // { roomId, code, settings, players, localPlayerId, hostId }
    State.merge('room', {
      id:       data.roomId,
      code:     data.code,
      hostId:   data.hostId,
      settings: data.settings ?? State.get('room.settings'),
    });
    State.merge('localPlayer', {
      id:     data.localPlayerId,
      isHost: data.hostId === data.localPlayerId,
    });
    State.set('players', data.players ?? []);
    State.set('game.status', CONFIG.GAME_STATUS.LOBBY);
    EventBus.emit(CONFIG.EVENTS.UI_SCREEN_CHANGE, CONFIG.SCREENS.LOBBY);
  }

  function _onRoomError(data) {
    // { message }
    EventBus.emit(CONFIG.EVENTS.UI_SHOW_TOAST, { message: data.message, type: 'error' });
  }

  function _onPlayerJoined(data) {
    // { player: { id, name, avatar, isReady, isHost } }
    const existing = State.getPlayerById(data.player.id);
    if (!existing) {
      State.push('players', data.player);
      _audio(CONFIG.AUDIO.SFX_DING);
      _anim(CONFIG.ANIM.CARD_ENTER, { playerId: data.player.id });
    }
    EventBus.emit(CONFIG.EVENTS.UI_UPDATE_PLAYERS, { joined: data.player });
  }

  function _onPlayerLeft(data) {
    // { playerId, newHostId? }
    State.remove('players', p => p.id === data.playerId);
    _anim(CONFIG.ANIM.CARD_EXIT, { playerId: data.playerId });

    if (data.newHostId) {
      State.set('room.hostId', data.newHostId);
      if (data.newHostId === State.get('localPlayer.id')) {
        State.set('localPlayer.isHost', true);
        EventBus.emit(CONFIG.EVENTS.UI_SHOW_TOAST, { message: 'You are now the host', type: 'info' });
      }
    }
    EventBus.emit(CONFIG.EVENTS.UI_UPDATE_PLAYERS, { left: data.playerId });
  }

  function _onPlayerReady(data) {
    // { playerId, isReady }
    const players = State.get('players');
    const idx = players.findIndex(p => p.id === data.playerId);
    if (idx !== -1) {
      players[idx].isReady = data.isReady;
      State.set('players', players, true);
    }
    EventBus.emit(CONFIG.EVENTS.UI_UPDATE_PLAYERS, { ready: data });
  }

  function _onPlayerKicked(data) {
    // { playerId }
    if (data.playerId === State.get('localPlayer.id')) {
      // We got kicked
      State.reset(true);
      EventBus.emit(CONFIG.EVENTS.UI_SCREEN_CHANGE, CONFIG.SCREENS.LANDING);
      EventBus.emit(CONFIG.EVENTS.UI_SHOW_TOAST, { message: 'You were kicked from the room', type: 'error' });
    } else {
      _onPlayerLeft(data);
    }
  }

  function _onGameStarting(data) {
    // { countdownFrom: 3 }
    State.set('game.status', CONFIG.GAME_STATUS.COUNTDOWN);
    State.set('ui.countdownValue', data.countdownFrom ?? 3, true);
    EventBus.emit(CONFIG.EVENTS.UI_SCREEN_CHANGE, CONFIG.SCREENS.COUNTDOWN);
    _audio(CONFIG.AUDIO.SFX_COUNTDOWN);
  }

  function _onCountdownTick(data) {
    // { value: 2 | 1 | 0 }
    State.set('ui.countdownValue', data.value, true);
    _anim(CONFIG.ANIM.COUNTDOWN_POP, { value: data.value });
    _audio(CONFIG.AUDIO.SFX_COUNTDOWN, { tick: data.value });
  }

  function _onGameStarted(data) {
    // { round, bombMode, activePlayers: [id,...] }
    State.merge('game', {
      status:        CONFIG.GAME_STATUS.IN_GAME,
      round:         data.round ?? 1,
      bombMode:      data.bombMode ?? 'normal',
      activePlayers: data.activePlayers ?? State.get('players').map(p => p.id),
      eliminated:    [],
      badgesThisRound: {},
      fakeOutCount:  0,
      panicLevel:    0,
      slowMotionActive: false,
    });
    EventBus.emit(CONFIG.EVENTS.UI_SCREEN_CHANGE, CONFIG.SCREENS.GAME);

    // Start calm music
    _audio(CONFIG.AUDIO.BGM_CALM, { fadeIn: true });

    // Special music if only 2 remain
    if (State.activePlayerCount() === 2) {
      _audio(CONFIG.AUDIO.BGM_FINAL_DUEL, { fadeIn: true });
    }
  }

  function _onRoundStarted(data) {
    // { round, activePlayers }
    State.merge('game', {
      round:           data.round,
      activePlayers:   data.activePlayers,
      panicLevel:      0,
      holdStartedAt:   null,
      holdDuration:    0,
      fakeOutActive:   false,
      slowMotionActive: false,
      badgesThisRound: {},
    });
    _clearAllTimers();
    EventBus.emit(CONFIG.EVENTS.ROUND_STARTED_LOCAL, { round: data.round });
  }

  function _onBombAssigned(data) {
    // { holderId, explodeAt, bombMode }
    const { holderId, explodeAt, bombMode } = data;
    const totalMs = explodeAt - Date.now();

    State.merge('game', {
      currentHolder:  holderId,
      previousHolder: null,
      explodeAt:      explodeAt,
      bombMode:       bombMode ?? State.get('game.bombMode'),
      inTransit:      false,
      panicLevel:     0,
    });
    State.setBombTotal(totalMs);

    // Reset ui pass state
    State.set('ui.passOnCooldown', false, true);
    State.set('ui.cooldownEndAt', null, true);

    // If I'm the holder, start cooldown and AFK timer
    if (State.isHolder()) {
      _startPassCooldown();
      _startAfkTimer();
    }

    // Start panic monitor for everyone
    _startPanicMonitor();

    // Potentially schedule a fake-out
    _maybeScheduleFakeOut();

    // Emit for UI
    EventBus.emit(CONFIG.EVENTS.UI_UPDATE_BOMB, { holderId, explodeAt });

    // Audio
    _audio(CONFIG.AUDIO.BGM_CALM, { reset: true });
    if (State.isHolder()) {
      _audio(CONFIG.AUDIO.SFX_THUD);
    }
  }

  function _onBombPassed(data) {
    // { from, to, at (timestamp) }
    const { from, to } = data;
    const wasMe = from === State.get('localPlayer.id');
    const isMe  = to   === State.get('localPlayer.id');

    // Record previous holder for no-backpass rule
    State.set('game.previousHolder', from, true);

    // Set transit state (animation is in-flight)
    State.merge('game', {
      inTransit:  true,
      transitFrom: from,
      transitTo:   to,
    }, true);

    // Arc animation
    _anim(CONFIG.ANIM.BOMB_ARC, { from, to, durationMs: CONFIG.ANIMATION.PASS_ARC_MS });
    _audio(CONFIG.AUDIO.SFX_WHOOSH);

    // After arc completes, update holder state
    setTimeout(() => {
      State.merge('game', {
        currentHolder: to,
        inTransit:     false,
        transitFrom:   null,
        transitTo:     null,
        panicLevel:    State.get('game.panicLevel'), // keep current panic
      }, true);

      EventBus.emit(CONFIG.EVENTS.UI_UPDATE_BOMB, { holderId: to });
      _audio(CONFIG.AUDIO.SFX_THUD);

      // Focus effect
      _anim(CONFIG.ANIM.FOCUS_EFFECT, { holderId: to });

      // If I just received the bomb
      if (isMe) {
        _startPassCooldown();
        _startAfkTimer();
      }

      // If I just passed successfully, clear my AFK timer
      if (wasMe) {
        _clearAfkTimer();
      }

    }, CONFIG.ANIMATION.PASS_ARC_MS);
  }

  function _onPassRejected(data) {
    // { reason }
    EventBus.emit(CONFIG.EVENTS.ANIMATION_TRIGGER, {
      type: 'pass_rejected',
      reason: data.reason,
    });
    EventBus.emit(CONFIG.EVENTS.UI_SHOW_TOAST, {
      message: 'Pass rejected — try again',
      type: 'error',
    });
  }

  function _onHoldAcknowledged(data) {
    // { playerId, seconds }
    _checkHoldBadge(data.playerId, data.seconds ?? State.get('game.holdDuration'));
  }

  function _onBombExploded(data) {
    // { victimId, survivorIds }
    _stopPanicMonitor();
    _clearAllTimers();
    _stopHoldRoulette();

    State.merge('game', {
      status:       CONFIG.GAME_STATUS.EXPLOSION,
      currentHolder: null,
      explodeAt:    null,
    });

    // Explosion visuals
    _anim(CONFIG.ANIM.WHITE_FLASH);
    _anim(CONFIG.ANIM.SCREEN_SHAKE, { intensity: 'heavy' });
    _anim(CONFIG.ANIM.EXPLOSION,    { victimId: data.victimId });

    // Audio
    _audio(CONFIG.AUDIO.AUDIO_STOP);
    setTimeout(() => _audio(CONFIG.AUDIO.SFX_EXPLOSION), 100);

    // Navigate to explosion screen
    setTimeout(() => {
      EventBus.emit(CONFIG.EVENTS.UI_SCREEN_CHANGE, CONFIG.SCREENS.EXPLOSION);
    }, 50);
  }

  function _onFakeOutReceived(data) {
    // Server-confirmed fake-out (only for server-triggered ones)
    State.set('game.fakeOutCount', (State.get('game.fakeOutCount') || 0) + 1, true);
    State.set('game.fakeOutActive', true, true);
    EventBus.emit(CONFIG.EVENTS.FAKE_OUT_TRIGGERED, data);
    _onFakeOut();
  }

  function _onPlayerEliminated(data) {
    // { playerId, survivorsRemaining, round }
    const { playerId } = data;

    // Move player from active to eliminated
    const active = State.get('game.activePlayers').filter(id => id !== playerId);
    State.set('game.activePlayers', active, true);

    const eliminated = State.get('game.eliminated');
    if (!eliminated.includes(playerId)) {
      State.push('game.eliminated', playerId);
    }

    // Mark player status
    const players = State.get('players');
    const idx = players.findIndex(p => p.id === playerId);
    if (idx !== -1) {
      players[idx].status = CONFIG.PLAYER_STATUS.ELIMINATED;
      State.set('players', players, true);
    }

    // If it was me
    if (playerId === State.get('localPlayer.id')) {
      State.set('ui.passSelectorOpen', false, true);
      _clearAfkTimer();
      _stopHoldRoulette();
    }

    _audio(CONFIG.AUDIO.SFX_ELIMINATION);
    _anim(CONFIG.ANIM.CARD_EXIT, { playerId, elimination: true });

    EventBus.emit(CONFIG.EVENTS.UI_UPDATE_PLAYERS, { eliminated: playerId });
  }

  function _onRoundEnded(data) {
    // { survivorId, nextRound?, activePlayers? }
    _stopPanicMonitor();
    _clearAllTimers();

    State.merge('game', {
      status:     CONFIG.GAME_STATUS.ROUND_END,
      explodeAt:  null,
      panicLevel: 0,
    });

    // Update match score if best-of
    if (data.survivorId) {
      const scores = State.get('game.matchScore');
      scores[data.survivorId] = (scores[data.survivorId] ?? 0) + 1;
      State.set('game.matchScore', scores, true);
    }
  }

  function _onGameOver(data) {
    // { winnerId, ranking: [{id,name,avatar,eliminatedRound},...], matchScores }
    _stopPanicMonitor();
    _clearAllTimers();

    State.merge('game', {
      status: CONFIG.GAME_STATUS.GAME_OVER,
    });

    State.merge('results', {
      winnerId:    data.winnerId,
      ranking:     data.ranking ?? [],
      matchScores: data.matchScores ?? {},
    });

    _audio(CONFIG.AUDIO.AUDIO_STOP);
    setTimeout(() => {
      _audio(CONFIG.AUDIO.SFX_WIN);
      _anim(CONFIG.ANIM.WINNER_CONFETTI);
      EventBus.emit(CONFIG.EVENTS.UI_SCREEN_CHANGE, CONFIG.SCREENS.RESULTS);
    }, 500);
  }

  function _onForceStateSync(data) {
    // Server sends the authoritative state snapshot
    // { game: {...}, players: [...] }
    if (data.game)    State.merge('game',    data.game);
    if (data.players) State.set('players',   data.players);
    EventBus.emit(CONFIG.EVENTS.UI_UPDATE_PLAYERS, { sync: true });
    EventBus.emit(CONFIG.EVENTS.UI_UPDATE_BOMB, data.game ?? {});
  }

  function _onAfkWarning(data) {
    // Server confirms AFK warning for this player
    EventBus.emit(CONFIG.EVENTS.AFK_TIMER_WARNING, data);
  }

  function _onAfkAutoPassed(data) {
    // { from, to } — server auto-passed for an AFK player
    _onBombPassed(data);
    if (data.from === State.get('localPlayer.id')) {
      EventBus.emit(CONFIG.EVENTS.UI_SHOW_TOAST, {
        message: 'Auto-passed — you were too slow!',
        type: 'error',
      });
    }
  }

  function _onHostTransferred(data) {
    // { newHostId }
    State.set('room.hostId', data.newHostId);
    const isMe = data.newHostId === State.get('localPlayer.id');
    if (isMe) {
      State.set('localPlayer.isHost', true);
      EventBus.emit(CONFIG.EVENTS.UI_SHOW_TOAST, { message: 'You are now the host', type: 'info' });
    }
    EventBus.emit(CONFIG.EVENTS.UI_UPDATE_PLAYERS, { hostChange: data.newHostId });
  }

  // ── Local Input Handlers ──────────────────────────────────────

  function _onPassRequested(data) {
    // data: { toPlayerId } or { auto: true }
    // Validate client-side before sending to network

    if (!State.isHolder())               return;
    if (State.get('game.inTransit'))     return;
    if (State.get('ui.passOnCooldown'))  return;

    const toId = data?.toPlayerId;

    // No-backpass rule
    if (toId && toId === State.get('game.previousHolder')) {
      EventBus.emit(CONFIG.EVENTS.UI_SHOW_TOAST, {
        message: 'Cannot pass back immediately!',
        type: 'error',
      });
      return;
    }

    // Close selector
    State.set('ui.passSelectorOpen', false, true);

    // Send to network (network.js picks this up)
    EventBus.emit(CONFIG.EVENTS.UI_UPDATE_BOMB, { passPending: true });
    // network.js listens to PASS_REQUESTED and calls Network.passBomb()
  }

  function _onHoldStarted() {
    if (!State.isHolder())              return;
    if (State.get('game.inTransit'))    return;
    if (State.get('ui.passOnCooldown')) return;
    if (_holdInterval)                  return; // already holding

    _startHoldRoulette();
    _anim(CONFIG.ANIM.HOLD_GLOW, { start: true });
    // network.js sends START_HOLD to server
  }

  function _onHoldEnded() {
    const seconds = State.get('game.holdDuration');
    _stopHoldRoulette();
    _anim(CONFIG.ANIM.HOLD_GLOW, { stop: true });
    _checkHoldBadge(State.get('localPlayer.id'), seconds);
    // network.js sends END_HOLD to server
  }

  // ── Play Again / Exit ─────────────────────────────────────────

  function _onPlayAgainRequested() {
    State.resetGame();
    // Reset all players' ready status
    const players = State.get('players');
    players.forEach(p => { p.isReady = false; p.status = CONFIG.PLAYER_STATUS.CONNECTED; });
    State.set('players', players);
    EventBus.emit(CONFIG.EVENTS.UI_SCREEN_CHANGE, CONFIG.SCREENS.LOBBY);
  }

  function _onExitRoomRequested() {
    _clearAllTimers();
    State.reset();
    EventBus.emit(CONFIG.EVENTS.UI_SCREEN_CHANGE, CONFIG.SCREENS.LANDING);
  }

  // ── Initialization ────────────────────────────────────────────

  function init() {
    const SE = CONFIG.SERVER_EVENTS;
    const EV = CONFIG.EVENTS;

    // ── Server events → handlers ──────────────────────────────
    EventBus.on(SE.ROOM_CREATED,       _onRoomCreated);
    EventBus.on(SE.ROOM_JOINED,        _onRoomJoined);
    EventBus.on(SE.ROOM_ERROR,         _onRoomError);
    EventBus.on(SE.PLAYER_JOINED,      _onPlayerJoined);
    EventBus.on(SE.PLAYER_LEFT,        _onPlayerLeft);
    EventBus.on(SE.PLAYER_READY,       _onPlayerReady);
    EventBus.on(SE.PLAYER_KICKED,      _onPlayerKicked);
    EventBus.on(SE.GAME_STARTING,      _onGameStarting);
    EventBus.on(SE.COUNTDOWN_TICK,     _onCountdownTick);
    EventBus.on(SE.GAME_STARTED,       _onGameStarted);
    EventBus.on(SE.ROUND_STARTED,      _onRoundStarted);
    EventBus.on(SE.BOMB_ASSIGNED,      _onBombAssigned);
    EventBus.on(SE.BOMB_PASSED,        _onBombPassed);
    EventBus.on(SE.PASS_REJECTED,      _onPassRejected);
    EventBus.on(SE.HOLD_ACKNOWLEDGED,  _onHoldAcknowledged);
    EventBus.on(SE.BOMB_EXPLODED,      _onBombExploded);
    EventBus.on(SE.FAKE_OUT,           _onFakeOutReceived);
    EventBus.on(SE.PLAYER_ELIMINATED,  _onPlayerEliminated);
    EventBus.on(SE.ROUND_ENDED,        _onRoundEnded);
    EventBus.on(SE.GAME_OVER,          _onGameOver);
    EventBus.on(SE.FORCE_STATE_SYNC,   _onForceStateSync);
    EventBus.on(SE.AFK_WARNING,        _onAfkWarning);
    EventBus.on(SE.AFK_AUTO_PASSED,    _onAfkAutoPassed);
    EventBus.on(SE.HOST_TRANSFERRED,   _onHostTransferred);

    // ── Local player input → handlers ────────────────────────
    EventBus.on(EV.PASS_REQUESTED, _onPassRequested);
    EventBus.on(EV.HOLD_STARTED,   _onHoldStarted);
    EventBus.on(EV.HOLD_ENDED,     _onHoldEnded);

    // ── App flow ──────────────────────────────────────────────
    EventBus.on('PLAY_AGAIN_REQUESTED', _onPlayAgainRequested);
    EventBus.on('EXIT_ROOM_REQUESTED',  _onExitRoomRequested);
  }

  // ── Public surface ────────────────────────────────────────────
  return Object.freeze({ init });

})();
window.Game = Game;
