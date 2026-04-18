/**
 * PANIC BOMB — main.js
 * Entry Point & Module Orchestrator.
 *
 * This is the last script loaded by index.html.
 * By the time this runs, all other modules are defined:
 *   CONFIG, EventBus, State, Network, Game, Animations, Audio, UI
 *
 * Responsibilities:
 *   • Verify all modules loaded correctly
 *   • Initialize modules in dependency order
 *   • Set up global error handling
 *   • Detect device capabilities
 *   • Expose a minimal debug surface on window (dev only)
 *   • Start the app
 *
 * Depends on: everything.
 */

(function () {
  'use strict';

  // ── Module presence check ─────────────────────────────────────
  const REQUIRED = ['CONFIG', 'EventBus', 'State', 'Network', 'Game', 'Animations', 'Audio', 'UI'];

  function _checkModules() {
    const missing = REQUIRED.filter(name => typeof window[name] === 'undefined');
    if (missing.length > 0) {
      console.error('[Main] Missing modules:', missing.join(', '));
      _showFatalError('Failed to load game modules: ' + missing.join(', '));
      return false;
    }
    return true;
  }

  // ── Fatal error display (pre-UI) ──────────────────────────────
  function _showFatalError(message) {
    document.body.innerHTML = `
      <div style="
        position:fixed;inset:0;display:flex;flex-direction:column;
        align-items:center;justify-content:center;
        background:#07070d;color:#ff2d2d;
        font-family:'Exo 2',sans-serif;text-align:center;padding:24px;
      ">
        <div style="font-size:3rem;margin-bottom:16px;">💣</div>
        <div style="font-size:1.2rem;font-weight:700;margin-bottom:8px;">
          Something went wrong
        </div>
        <div style="font-size:0.85rem;color:rgba(255,255,255,0.5);max-width:320px;">
          ${message}
        </div>
        <button onclick="location.reload()" style="
          margin-top:24px;padding:12px 28px;
          background:#ff2d2d;color:#fff;border:none;
          border-radius:8px;font-size:0.95rem;cursor:pointer;
        ">
          Reload
        </button>
      </div>
    `;
  }

  // ── Device capability detection ───────────────────────────────
  function _detectCapabilities() {
    return {
      isMobile:    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
      isTouch:     'ontouchstart' in window || navigator.maxTouchPoints > 0,
      hasAudio:    !!(window.AudioContext || window.webkitAudioContext),
      hasWebGL:    (() => {
        try {
          return !!document.createElement('canvas').getContext('webgl');
        } catch (_) { return false; }
      })(),
      isSafari:    /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
      isFirefox:   navigator.userAgent.toLowerCase().includes('firefox'),
    };
  }

  // ── Prevent accidental UX breaks ─────────────────────────────
  function _lockDefaultBehaviors() {
    // Prevent pull-to-refresh on mobile
    document.body.style.overscrollBehavior = 'none';

    // Prevent accidental zoom on double-tap (mobile)
    let lastTap = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) e.preventDefault();
      lastTap = now;
    }, { passive: false });

    // Prevent context menu (right-click)
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // Prevent text selection during game
    document.addEventListener('selectstart', (e) => {
      if (State.get('screen') === CONFIG.SCREENS.GAME) e.preventDefault();
    });
  }

  // ── Global error handler ──────────────────────────────────────
  function _installErrorHandlers() {
    window.addEventListener('error', (e) => {
      console.error('[Main] Uncaught error:', e.message, e.filename, e.lineno);
      // Only show toast for non-fatal errors (don't wipe the whole screen)
      const screen = State?.get?.('screen');
      if (screen && screen !== CONFIG.SCREENS.LANDING) {
        EventBus?.emit(CONFIG.EVENTS.UI_SHOW_TOAST, {
          message: 'An error occurred. Try refreshing.',
          type: 'error',
        });
      }
    });

    window.addEventListener('unhandledrejection', (e) => {
      console.error('[Main] Unhandled promise rejection:', e.reason);
    });
  }

  // ── Initialization sequence ───────────────────────────────────

  /**
   * Initialize all modules in strict dependency order.
   * Returns false if any step fails.
   */
  function _initModules(caps) {

    // 1. EventBus — no dependencies
    //    Already a self-executing module, nothing to call.

    // 2. State — depends on CONFIG + EventBus
    //    Self-initializing module, no init() needed.

    // 3. Audio — depends on CONFIG + EventBus
    try {
      Audio.init();
    } catch (e) {
      console.warn('[Main] Audio init failed (non-fatal):', e);
      // Audio failure is non-fatal — game works without sound
    }

    // 4. Animations — depends on CONFIG + EventBus + State
    try {
      Animations.init();
    } catch (e) {
      console.error('[Main] Animations init failed:', e);
      return false;
    }

    // 5. Network — depends on CONFIG + EventBus + State
    try {
      Network.init();
    } catch (e) {
      console.error('[Main] Network init failed:', e);
      return false;
    }

    // 6. Game logic — depends on CONFIG + EventBus + State + Network
    try {
      Game.init();
    } catch (e) {
      console.error('[Main] Game init failed:', e);
      return false;
    }

    // 7. UI — depends on everything above
    try {
      UI.init();
    } catch (e) {
      console.error('[Main] UI init failed:', e);
      return false;
    }

    return true;
  }

  // ── Post-init tweaks ──────────────────────────────────────────

  function _applyDeviceAdjustments(caps) {
    if (caps.isMobile || caps.isTouch) {
      // Slightly larger touch targets on mobile
      document.documentElement.classList.add('is-touch');
    }
    if (caps.isSafari) {
      // Safari needs explicit 100dvh handling
      const setVh = () => {
        document.documentElement.style.setProperty(
          '--real-vh', `${window.innerHeight * 0.01}px`
        );
      };
      setVh();
      window.addEventListener('resize', setVh);
    }
    if (!caps.hasAudio) {
      console.warn('[Main] Web Audio API not available — no sound.');
    }
  }

  // ── Network status indicator ──────────────────────────────────

  function _setupNetworkIndicator() {
    const EV = CONFIG.EVENTS;

    EventBus.on(EV.NETWORK_CONNECTED, () => {
      document.documentElement.classList.remove('net-offline');
    });

    EventBus.on(EV.NETWORK_DISCONNECTED, () => {
      // Only show offline indicator when in an active game session
      const screen = State.get('screen');
      const activeScreens = [
        CONFIG.SCREENS.LOBBY,
        CONFIG.SCREENS.GAME,
        CONFIG.SCREENS.COUNTDOWN,
        CONFIG.SCREENS.EXPLOSION,
        CONFIG.SCREENS.RESULTS,
      ];
      if (activeScreens.includes(screen)) {
        document.documentElement.classList.add('net-offline');
      }
    });
  }

  // ── Visibility API (pause on tab switch) ─────────────────────

  function _setupVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      const screen = State.get('screen');
      const inGame = screen === CONFIG.SCREENS.GAME;

      if (document.hidden && inGame) {
        // Tab is hidden during game — just log, server handles the rest
        console.log('[Main] Tab hidden during game — server will handle AFK');
      }
    });
  }

  // ── Dev / debug surface ───────────────────────────────────────

  function _installDebugSurface() {
    if (window.location.hostname !== 'localhost' &&
        !window.location.search.includes('debug')) return;

    EventBus.setDebug(true);

    window.__PB = {
      state:      () => State.get(),
      eventLog:   () => EventBus.getHistory(),
      network:    () => Network.getStatus(),
      ping:       () => Network.getPing(),
      emit:       (ev, d) => EventBus.emit(ev, d),
      showScreen: (s) => UI.showScreen(s),
      toast:      (m) => UI.showToast(m, 'info'),
      mute:       () => Audio.toggleMute(),
      volume:     (v) => Audio.setVolume(v),

      // Simulate server events for testing without a real server
      sim: {
        roomCreated: () => EventBus.emit(CONFIG.SERVER_EVENTS.ROOM_CREATED, {
          roomId: 'test-room-1',
          code:   'XK4P2',
          settings: { maxPlayers: 4, bombMode: 'normal', bestOf: 1 },
          localPlayer: { id: 'player-1', name: State.get('localPlayer.name') || 'You' },
        }),

        playerJoined: (name = 'Bot') => EventBus.emit(CONFIG.SERVER_EVENTS.PLAYER_JOINED, {
          player: {
            id:      `bot-${Date.now()}`,
            name,
            avatar:  CONFIG.PLAYER.DEFAULT_EMOJIS[Math.floor(Math.random() * 6)],
            isReady: false,
            isHost:  false,
            status:  CONFIG.PLAYER_STATUS.CONNECTED,
          },
        }),

        gameStarted: () => {
          const players = State.get('players');
          EventBus.emit(CONFIG.SERVER_EVENTS.GAME_STARTED, {
            round:         1,
            bombMode:      'normal',
            activePlayers: players.map(p => p.id),
          });
        },

        bombAssigned: (holderId) => {
          const id = holderId || State.get('localPlayer.id');
          EventBus.emit(CONFIG.SERVER_EVENTS.BOMB_ASSIGNED, {
            holderId: id,
            explodeAt: Date.now() + 45_000,
            bombMode:  'normal',
          });
        },

        bombPassed: (toId) => {
          const from = State.getCurrentHolder();
          EventBus.emit(CONFIG.SERVER_EVENTS.BOMB_PASSED, { from, to: toId });
        },

        explode: () => {
          const holder = State.getCurrentHolder();
          EventBus.emit(CONFIG.SERVER_EVENTS.BOMB_EXPLODED, {
            victimId:    holder,
            survivorIds: State.get('game.activePlayers').filter(id => id !== holder),
          });
        },
      },
    };

    console.info(
      '%c💣 PANIC BOMB DEBUG MODE',
      'color:#ff6b00;font-size:1.1rem;font-weight:bold',
      '\nUse window.__PB.sim.* to simulate server events.',
      '\nwindow.__PB.state() shows current state.',
    );
  }

  // ── Bootstrap ─────────────────────────────────────────────────

  function boot() {
    console.log('[Main] Panic Bomb booting...');

    // 1. Verify all scripts loaded
    if (!_checkModules()) return;

    // 2. Detect environment
    const caps = _detectCapabilities();
    console.log('[Main] Capabilities:', caps);

    // 3. Error handlers (early, before anything can fail)
    _installErrorHandlers();

    // 4. Lock unwanted default browser behaviors
    _lockDefaultBehaviors();

    // 5. Initialize all modules in order
    const ok = _initModules(caps);
    if (!ok) {
      _showFatalError('Failed to initialize game. Please refresh.');
      return;
    }

    // 6. Post-init device adjustments
    _applyDeviceAdjustments(caps);

    // 7. Network status indicator
    _setupNetworkIndicator();

    // 8. Visibility / tab-switch handler
    _setupVisibilityHandler();

    // 9. Debug surface (localhost / ?debug only)
    _installDebugSurface();

    console.log('[Main] ✅ All modules initialized. Game ready.');
  }

  // ── Wait for DOM, then boot ───────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    // DOM already ready (scripts at end of <body>)
    boot();
  }

}());
