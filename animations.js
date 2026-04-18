/**
 * PANIC BOMB — animations.js
 * Animation Engine.
 *
 * Responsibilities:
 *   • Execute all visual animations triggered by EventBus
 *   • Bomb arc flight (parabolic path between players)
 *   • Explosion sequence (flash → shake → reveal)
 *   • Panic phase escalation (tint, shake, pulse)
 *   • Screen shake at multiple intensities
 *   • Hold glow escalation on the holder node
 *   • Slow-motion effect (last seconds drama)
 *   • Fake-out relief animation
 *   • Countdown pop
 *   • Winner confetti
 *
 * Rules:
 *   • Reads DOM positions but does NOT call UI.render*() functions
 *   • Uses CSS custom properties + classList where possible
 *   • Falls back to inline style only when CSS cannot do the job
 *   • Emits ANIMATION_DONE when a sequence completes
 *
 * Depends on: config.js, events.js, state.js
 */

const Animations = (() => {

  // ── Active animation handles ──────────────────────────────────
  let _shakeRafId         = null;
  let _continuousShakeId  = null;
  let _holdGlowRafId      = null;
  let _confettiRafId      = null;
  let _confettiParticles  = [];

  // ── Helpers ───────────────────────────────────────────────────

  /**
   * Get the center (x, y) of a DOM element relative to the viewport.
   * @param {HTMLElement} el
   * @returns {{ x: number, y: number }}
   */
  function _center(el) {
    if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /**
   * Cubic easeOut interpolation.
   * @param {number} t  0–1
   */
  function _easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * EaseInOut interpolation.
   */
  function _easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  /**
   * Run a rAF-based animation.
   * @param {number}   duration  ms
   * @param {Function} onTick    (progress 0–1) => void
   * @param {Function} [onDone]
   * @returns {number} rafId of first frame (can be cancelled)
   */
  function _animate(duration, onTick, onDone) {
    const start = performance.now();
    let rafId;
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      onTick(t);
      if (t < 1) {
        rafId = requestAnimationFrame(frame);
      } else {
        onDone?.();
      }
    }
    rafId = requestAnimationFrame(frame);
    return rafId;
  }

  // ── 1. Bomb Arc Animation ─────────────────────────────────────

  /**
   * Animate the flying bomb element along a parabolic arc
   * from one player node to another.
   *
   * @param {string} fromId      Player ID (source)
   * @param {string} toId        Player ID (destination)
   * @param {number} durationMs
   */
  function bombArc(fromId, toId, durationMs) {
    const flyBomb = document.getElementById('flying-bomb');
    if (!flyBomb) return;

    const fromNode = document.getElementById(`pnav-${fromId}`);
    const toNode   = document.getElementById(`pnav-${toId}`);
    if (!fromNode || !toNode) return;

    const from = _center(fromNode);
    const to   = _center(toNode);

    // Arc height: proportional to distance, min 80px, max 220px
    const dist      = Math.hypot(to.x - from.x, to.y - from.y);
    const arcHeight = Math.min(220, Math.max(80, dist * 0.45));

    // Mid-point of the arc (Bézier control point offset upward)
    const midX = (from.x + to.x) / 2;
    const midY = Math.min(from.y, to.y) - arcHeight;

    // Show flying bomb
    flyBomb.classList.remove('hidden');
    flyBomb.style.left    = `${from.x}px`;
    flyBomb.style.top     = `${from.y}px`;
    flyBomb.style.opacity = '1';
    flyBomb.style.transform = 'translate(-50%,-50%) scale(1) rotate(0deg)';

    // Track trail elements
    const trailParticles = [];

    _animate(durationMs, (t) => {
      const eased = _easeInOut(t);

      // Quadratic Bézier: P = (1-t)²·P0 + 2(1-t)t·P1 + t²·P2
      const u  = 1 - eased;
      const x  = u * u * from.x + 2 * u * eased * midX + eased * eased * to.x;
      const y  = u * u * from.y + 2 * u * eased * midY + eased * eased * to.y;

      flyBomb.style.left = `${x}px`;
      flyBomb.style.top  = `${y}px`;

      // Rotation based on travel direction
      const angle = Math.atan2(
        to.y - from.y + (eased - 0.5) * arcHeight * 2,
        to.x - from.x
      ) * (180 / Math.PI);
      flyBomb.style.transform = `translate(-50%,-50%) scale(${1 + Math.sin(t * Math.PI) * 0.3}) rotate(${angle * 0.4}deg)`;

      // Spawn trail particle every ~50ms worth of progress
      if (Math.random() < 0.25) {
        _spawnTrailParticle(x, y);
      }

      // Scale up slightly at peak arc
      const peakScale = 1 + Math.sin(t * Math.PI) * 0.35;
      flyBomb.style.fontSize = `${2.5 * peakScale}rem`;

    }, () => {
      // Landing impact
      flyBomb.style.opacity   = '0';
      flyBomb.style.transform = 'translate(-50%,-50%) scale(1.5)';
      flyBomb.classList.add('hidden');
      flyBomb.style.fontSize  = '2.5rem';

      // Impact flash on destination
      _impactFlash(toNode);

      EventBus.emit(CONFIG.EVENTS.ANIMATION_DONE, { type: CONFIG.ANIM.BOMB_ARC, toId });
    });
  }

  /**
   * Spawn a single trailing ember particle at a position.
   */
  function _spawnTrailParticle(x, y) {
    const p = document.createElement('div');
    p.style.cssText = `
      position:fixed;
      left:${x}px;
      top:${y}px;
      width:${4 + Math.random() * 6}px;
      height:${4 + Math.random() * 6}px;
      border-radius:50%;
      background:${Math.random() > 0.4 ? '#ff6b00' : '#ff2d2d'};
      pointer-events:none;
      z-index:99;
      transform:translate(-50%,-50%);
      opacity:0.85;
      transition:opacity 0.25s ease, transform 0.25s ease;
    `;
    document.body.appendChild(p);

    // Drift outward slightly
    const dx = (Math.random() - 0.5) * 30;
    const dy = (Math.random() - 0.5) * 30 - 10;
    requestAnimationFrame(() => {
      p.style.opacity   = '0';
      p.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.3)`;
    });
    setTimeout(() => p.remove(), 300);
  }

  /**
   * Brief flash + scale pop on the element that just received the bomb.
   */
  function _impactFlash(el) {
    if (!el) return;
    el.style.transition = 'box-shadow 0.08s ease, transform 0.08s ease';
    el.style.boxShadow  = '0 0 30px rgba(255,45,45,0.9), 0 0 60px rgba(255,107,0,0.5)';
    el.style.transform  = 'scale(1.25)';
    setTimeout(() => {
      el.style.boxShadow = '';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; }, 200);
    }, 120);
  }

  // ── 2. Explosion Sequence ─────────────────────────────────────

  /**
   * Full cinematic explosion sequence.
   * Frame timeline (total ≈ 3 s):
   *   0ms     — freeze frame (everything pauses)
   *   50ms    — WHITE FLASH fills screen
   *   200ms   — sound silence moment
   *   300ms   — heavy screen shake
   *   600ms   — flash fades, screen goes dark
   *   800ms   — victim card reveals
   *   1200ms  — ELIMINATED text pops
   *   2800ms  — ANIMATION_DONE emitted
   *
   * @param {string} victimId
   */
  function explosion(victimId) {
    const flash = document.getElementById('explosion-flash');
    if (!flash) return;

    // Step 1: freeze frame illusion (briefly stop panic tint animation)
    document.body.style.animationPlayState = 'paused';

    setTimeout(() => {
      document.body.style.animationPlayState = '';

      // Step 2: white flash
      flash.style.opacity    = '1';
      flash.style.transition = 'opacity 0.05s ease';

    }, 50);

    // Step 3: shake during flash
    setTimeout(() => {
      screenShake('heavy');
    }, 180);

    // Step 4: flash fades to dark
    setTimeout(() => {
      flash.style.transition = 'opacity 0.4s ease';
      flash.style.opacity    = '0';
    }, 350);

    // Step 5: spawn screen-space explosion particles
    setTimeout(() => {
      _spawnExplosionParticles();
    }, 400);

    // Step 6: done signal (ui.js handles showing the screen,
    //         but we fire our visual "done" later)
    setTimeout(() => {
      EventBus.emit(CONFIG.EVENTS.ANIMATION_DONE, {
        type: CONFIG.ANIM.EXPLOSION,
        victimId,
      });
    }, CONFIG.ANIMATION.EXPLOSION_MS);
  }

  /**
   * Spawn radial ember particles from screen center for explosion effect.
   */
  function _spawnExplosionParticles() {
    const cx = window.innerWidth  / 2;
    const cy = window.innerHeight / 2;
    const N  = 24;

    for (let i = 0; i < N; i++) {
      const angle   = (2 * Math.PI * i) / N + (Math.random() - 0.5) * 0.4;
      const speed   = 80 + Math.random() * 160;
      const size    = 5 + Math.random() * 10;
      const color   = Math.random() > 0.5 ? '#ff6b00' : '#ff2d2d';
      const delay   = Math.random() * 150;

      const p = document.createElement('div');
      p.style.cssText = `
        position:fixed;
        left:${cx}px;
        top:${cy}px;
        width:${size}px;
        height:${size}px;
        border-radius:50%;
        background:${color};
        box-shadow:0 0 ${size * 2}px ${color};
        pointer-events:none;
        z-index:150;
        transform:translate(-50%,-50%);
        opacity:1;
      `;
      document.body.appendChild(p);

      setTimeout(() => {
        p.style.transition = `transform 0.7s ease-out, opacity 0.7s ease-out`;
        p.style.transform  = `translate(calc(-50% + ${Math.cos(angle) * speed}px), calc(-50% + ${Math.sin(angle) * speed}px)) scale(0.2)`;
        p.style.opacity    = '0';
      }, delay);

      setTimeout(() => p.remove(), delay + 800);
    }
  }

  // ── 3. Screen Shake ───────────────────────────────────────────

  /**
   * Apply a screen shake to <body> at the given intensity.
   * @param {'light'|'medium'|'heavy'} intensity
   * @param {boolean} [continuous]  If true, shakes until stopShake() is called.
   */
  function screenShake(intensity, continuous = false) {
    // Stop any previous continuous shake
    if (_continuousShakeId) {
      clearInterval(_continuousShakeId);
      _continuousShakeId = null;
    }
    cancelAnimationFrame(_shakeRafId);

    const amplitudes = { light: 3, medium: 6, heavy: 12 };
    const amp = amplitudes[intensity] || 4;
    const dur = continuous ? 9999 : (intensity === 'heavy' ? 600 : intensity === 'medium' ? 450 : 350);

    if (continuous) {
      // Lower amplitude for sustained shake
      const sustainAmp = amp * 0.5;
      _continuousShakeId = setInterval(() => {
        const tx = (Math.random() - 0.5) * sustainAmp * 2;
        const ty = (Math.random() - 0.5) * sustainAmp * 2;
        document.body.style.transform = `translate(${tx}px,${ty}px)`;
      }, 60);
      return;
    }

    const start = performance.now();
    function frame(now) {
      const elapsed  = now - start;
      if (elapsed >= dur) {
        document.body.style.transform = '';
        return;
      }
      // Decay over time
      const decay = 1 - elapsed / dur;
      const tx = (Math.random() - 0.5) * amp * 2 * decay;
      const ty = (Math.random() - 0.5) * amp * 2 * decay;
      document.body.style.transform = `translate(${tx}px,${ty}px)`;
      _shakeRafId = requestAnimationFrame(frame);
    }
    _shakeRafId = requestAnimationFrame(frame);
  }

  /**
   * Stop any continuous screen shake.
   */
  function stopShake() {
    if (_continuousShakeId) {
      clearInterval(_continuousShakeId);
      _continuousShakeId = null;
    }
    cancelAnimationFrame(_shakeRafId);
    document.body.style.transform = '';
  }

  // ── 4. Panic Tint & Bomb Visual ───────────────────────────────

  /**
   * Update the CSS custom properties that drive panic visuals.
   * Called when panic level changes.
   *
   * @param {number} opacity     0–0.45
   * @param {number} bombScale   1.0–1.4
   * @param {string} pulseSpeed  CSS duration e.g. '1.5s'
   */
  function panicTint(opacity, bombScale, pulseSpeed) {
    const root = document.documentElement;
    root.style.setProperty('--panic-tint-opacity', opacity);
    root.style.setProperty('--bomb-scale',         bombScale);
    root.style.setProperty('--bomb-pulse-speed',   pulseSpeed);
  }

  /**
   * Make the bomb emoji on a holder node pulse visually.
   * Triggered when pass becomes ready after cooldown.
   * @param {boolean} ready
   */
  function bombPulse(ready) {
    const holderId = State.getCurrentHolder();
    if (!holderId) return;
    const bomb = document.querySelector(`#pnode-${holderId} .pn-bomb`);
    if (!bomb) return;

    if (ready) {
      bomb.style.animation = 'none';
      void bomb.offsetWidth; // force reflow
      bomb.style.animation = '';
      bomb.style.filter    = 'drop-shadow(0 0 16px rgba(255,45,45,1))';
      setTimeout(() => { bomb.style.filter = ''; }, 500);
    }
  }

  // ── 5. Focus Effect ───────────────────────────────────────────

  /**
   * Visually emphasise the bomb holder and de-emphasise others.
   * @param {string} holderId
   */
  function focusEffect(holderId) {
    document.querySelectorAll('.player-node').forEach(node => {
      const pid = node.dataset.playerId;
      if (pid === holderId) {
        node.style.opacity = '1';
        node.style.filter  = '';
        node.style.transform = 'scale(1.08)';
        node.style.zIndex  = '10';
      } else {
        node.style.opacity = '0.65';
        node.style.filter  = 'saturate(0.4)';
        node.style.transform = 'scale(1)';
        node.style.zIndex  = '1';
      }
    });
  }

  /**
   * Reset focus — all players equal opacity.
   */
  function resetFocus() {
    document.querySelectorAll('.player-node').forEach(node => {
      node.style.opacity   = '';
      node.style.filter    = '';
      node.style.transform = '';
      node.style.zIndex    = '';
    });
  }

  // ── 6. Hold Glow ─────────────────────────────────────────────

  /**
   * Animate a growing red glow on the HOLD button while held.
   * @param {boolean} start  true to start, false to stop
   */
  function holdGlow(start) {
    cancelAnimationFrame(_holdGlowRafId);
    const btn = document.getElementById('btn-hold');
    if (!btn) return;

    if (!start) {
      btn.style.boxShadow = '';
      btn.style.borderColor = '';
      return;
    }

    const startTime = performance.now();
    const MAX_GLOW  = 6; // seconds before max glow

    function frame(now) {
      const sec = Math.min(MAX_GLOW, (now - startTime) / 1000);
      const t   = sec / MAX_GLOW;
      const red = Math.round(255 * t);
      const alpha = 0.3 + t * 0.5;
      btn.style.boxShadow   = `0 0 ${10 + t * 40}px rgba(255,${Math.round(107 * (1 - t))},0,${alpha})`;
      btn.style.borderColor = `rgba(255,${Math.round(107 * (1 - t))},0,${0.4 + t * 0.6})`;
      btn.style.background  = `rgba(${red},${Math.round(20 * t)},0,${t * 0.35})`;
      _holdGlowRafId = requestAnimationFrame(frame);
    }
    _holdGlowRafId = requestAnimationFrame(frame);
  }

  // ── 7. White Flash ────────────────────────────────────────────

  /**
   * Full-screen white flash (used at explosion moment).
   * @param {number} [ms]  Duration of the flash before fading.
   */
  function whiteFlash(ms = CONFIG.ANIMATION.WHITE_FLASH_MS) {
    const flash = document.getElementById('explosion-flash');
    if (!flash) return;
    flash.style.transition = `opacity ${ms * 0.3}ms ease`;
    flash.style.opacity    = '1';
    setTimeout(() => {
      flash.style.transition = `opacity ${ms * 1.5}ms ease`;
      flash.style.opacity    = '0';
    }, ms);
  }

  // ── 8. Slow Motion ────────────────────────────────────────────

  /**
   * Apply a slow-motion visual effect to the game screen.
   * Slows CSS animations and adds desaturation + vignette.
   * @param {boolean} active
   */
  function slowMotion(active) {
    const arena = document.getElementById('screen-game');
    if (!arena) return;

    if (active) {
      arena.style.filter = 'saturate(0.7)';
      // Slow all CSS animation playback rates
      document.getAnimations?.()?.forEach(anim => {
        // Only slow game-screen animations, not UI controls
        const el = anim.effect?.target;
        if (el && arena.contains(el)) {
          anim.playbackRate = CONFIG.ANIMATION.SLOW_MO_FACTOR;
        }
      });
    } else {
      arena.style.filter = '';
      document.getAnimations?.()?.forEach(anim => {
        anim.playbackRate = 1;
      });
    }
  }

  // ── 9. Fake-out Relief ────────────────────────────────────────

  /**
   * Visual sigh-of-relief when a fake-out resolves.
   * Rapidly fades screen back to calm state.
   */
  function fakeOutRelief() {
    // Flash the screen very briefly then calm
    const root = document.documentElement;

    // Briefly intensify then quickly relax
    root.style.setProperty('--panic-tint-opacity', '0.5');
    root.style.setProperty('--bomb-pulse-speed', '0.3s');

    setTimeout(() => {
      root.style.setProperty('--panic-tint-opacity', '0.05');
      root.style.setProperty('--bomb-pulse-speed', '2.5s');
      root.style.setProperty('--bomb-scale', '1.05');
    }, 500);

    // Scatter particles outward
    const cx = window.innerWidth  / 2;
    const cy = window.innerHeight * 0.4;
    for (let i = 0; i < 8; i++) {
      const angle = (2 * Math.PI * i) / 8;
      const p = document.createElement('div');
      p.style.cssText = `
        position:fixed; left:${cx}px; top:${cy}px;
        width:8px; height:8px; border-radius:50%;
        background:#00ff88;
        box-shadow:0 0 12px #00ff88;
        pointer-events:none; z-index:200;
        transform:translate(-50%,-50%); opacity:1;
      `;
      document.body.appendChild(p);
      requestAnimationFrame(() => {
        p.style.transition = 'transform 0.6s ease-out, opacity 0.6s ease-out';
        p.style.transform  = `translate(calc(-50% + ${Math.cos(angle) * 120}px), calc(-50% + ${Math.sin(angle) * 120}px)) scale(0.2)`;
        p.style.opacity    = '0';
      });
      setTimeout(() => p.remove(), 700);
    }

    // Show "Phew!" text briefly
    const label = document.createElement('div');
    label.textContent = '😅 Phew!';
    label.style.cssText = `
      position:fixed; top:30%; left:50%; transform:translate(-50%,-50%) scale(0);
      font-family:'Bebas Neue',sans-serif; font-size:3rem; color:#00ff88;
      text-shadow:0 0 20px rgba(0,255,136,0.8);
      pointer-events:none; z-index:200;
      transition:transform 0.3s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease;
      opacity:0;
    `;
    document.body.appendChild(label);
    requestAnimationFrame(() => {
      label.style.transform = 'translate(-50%,-50%) scale(1)';
      label.style.opacity   = '1';
    });
    setTimeout(() => {
      label.style.opacity   = '0';
      label.style.transform = 'translate(-50%,-50%) scale(0.7)';
      setTimeout(() => label.remove(), 400);
    }, 1200);
  }

  // ── 10. Countdown Pop ─────────────────────────────────────────

  /**
   * Animate a single countdown number popping in.
   * @param {number|string} value
   */
  function countdownPop(value) {
    const el = document.getElementById('countdown-number');
    if (!el) return;

    el.textContent = value === 0 ? 'GO!' : String(value);

    // Re-trigger CSS animation
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';

    // Change color near GO
    if (value === 0) {
      el.style.color     = '#00ff88';
      el.style.textShadow = '0 0 40px rgba(0,255,136,0.5)';
    } else if (value === 1) {
      el.style.color     = '#ff2d2d';
      el.style.textShadow = '0 0 40px rgba(255,45,45,0.5)';
    } else {
      el.style.color     = '';
      el.style.textShadow = '';
    }
  }

  // ── 11. Winner Confetti ───────────────────────────────────────

  const CONFETTI_COLORS = ['#ff2d2d', '#ff6b00', '#ffd700', '#00ff88', '#ffffff'];

  function _makeConfettiParticle() {
    return {
      x:     Math.random() * window.innerWidth,
      y:     -20,
      vx:    (Math.random() - 0.5) * 3,
      vy:    2 + Math.random() * 4,
      rot:   Math.random() * 360,
      rotV:  (Math.random() - 0.5) * 8,
      w:     6 + Math.random() * 8,
      h:     10 + Math.random() * 6,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      alpha: 1,
      el:    null,
    };
  }

  /**
   * Launch a confetti shower on the results screen.
   */
  function winnerConfetti() {
    cancelAnimationFrame(_confettiRafId);

    // Remove old particles
    _confettiParticles.forEach(p => p.el?.remove());
    _confettiParticles = [];

    const container = document.getElementById('screen-results');
    if (!container) return;

    // Create particles
    const N = 60;
    for (let i = 0; i < N; i++) {
      const p = _makeConfettiParticle();
      const el = document.createElement('div');
      el.style.cssText = `
        position:absolute; width:${p.w}px; height:${p.h}px;
        background:${p.color}; border-radius:2px;
        pointer-events:none; z-index:0; opacity:1;
        left:${p.x}px; top:${p.y}px;
        transform:rotate(${p.rot}deg);
      `;
      container.appendChild(el);
      p.el = el;
      _confettiParticles.push(p);
    }

    const H = window.innerHeight + 40;

    function frame() {
      let allDone = true;
      _confettiParticles.forEach(p => {
        if (!p.el) return;
        p.x   += p.vx;
        p.y   += p.vy;
        p.rot += p.rotV;
        p.vy  += 0.06; // gravity

        if (p.y < H) {
          allDone = false;
          p.el.style.left      = `${p.x}px`;
          p.el.style.top       = `${p.y}px`;
          p.el.style.transform = `rotate(${p.rot}deg)`;
        } else {
          p.el.style.opacity = '0';
        }
      });

      if (!allDone) {
        _confettiRafId = requestAnimationFrame(frame);
      } else {
        _confettiParticles.forEach(p => p.el?.remove());
        _confettiParticles = [];
      }
    }

    _confettiRafId = requestAnimationFrame(frame);
  }

  // ── 12. Player Card Enter / Exit ──────────────────────────────

  /**
   * Animate a lobby player card entering.
   * CSS handles the keyframe; we just ensure the element is ready.
   * @param {string} playerId
   */
  function cardEnter(playerId) {
    const card = document.querySelector(`[data-player-id="${playerId}"]`);
    if (!card) return;
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
  }

  /**
   * Animate a player card / node exiting (lobby or game elimination).
   * @param {string}  playerId
   * @param {boolean} elimination  If true, plays a more dramatic exit.
   */
  function cardExit(playerId, elimination = false) {
    // Lobby card
    const lobbyCard = document.querySelector(`.player-card[data-player-id="${playerId}"]`);
    if (lobbyCard) {
      lobbyCard.style.transition  = 'opacity 0.35s ease, transform 0.35s ease';
      lobbyCard.style.opacity     = '0';
      lobbyCard.style.transform   = 'translateY(20px) scale(0.9)';
      setTimeout(() => lobbyCard.remove(), 380);
    }

    // Game node
    const gameNode = document.getElementById(`pnode-${playerId}`);
    if (gameNode) {
      if (elimination) {
        // Dramatic shake then fade
        _animateElimination(gameNode);
      } else {
        gameNode.style.transition = 'opacity 0.4s ease';
        gameNode.style.opacity    = '0';
        setTimeout(() => { gameNode.style.display = 'none'; }, 420);
      }
    }
  }

  function _animateElimination(node) {
    // Brief shake
    let t = 0;
    const shake = setInterval(() => {
      const amp = Math.max(0, 8 - t * 2);
      node.style.transform = `translate(${(Math.random() - 0.5) * amp}px, ${(Math.random() - 0.5) * amp}px)`;
      t++;
      if (t > 6) {
        clearInterval(shake);
        node.style.transition  = 'opacity 0.5s ease, transform 0.5s ease, filter 0.5s ease';
        node.style.opacity     = '0.2';
        node.style.transform   = 'scale(0.8)';
        node.style.filter      = 'grayscale(1)';
        setTimeout(() => { node.style.display = 'none'; }, 550);
      }
    }, 60);
  }

  // ── EventBus Dispatcher ───────────────────────────────────────

  /**
   * Central dispatcher — listens to ANIMATION_TRIGGER and routes
   * to the appropriate function.
   */
  function _dispatch(data) {
    if (!data?.type) return;

    switch (data.type) {

      case CONFIG.ANIM.BOMB_ARC:
        bombArc(data.from, data.to, data.durationMs ?? CONFIG.ANIMATION.PASS_ARC_MS);
        break;

      case CONFIG.ANIM.EXPLOSION:
        explosion(data.victimId);
        break;

      case CONFIG.ANIM.WHITE_FLASH:
        whiteFlash(data.ms);
        break;

      case CONFIG.ANIM.SCREEN_SHAKE:
        if (data.continuous) {
          screenShake(data.intensity, true);
        } else {
          screenShake(data.intensity || 'medium');
        }
        break;

      case CONFIG.ANIM.PANIC_TINT:
        panicTint(
          data.opacity   ?? 0,
          data.bombScale ?? 1,
          data.pulseSpeed ?? '2s'
        );
        // Stop continuous shake when calming
        if ((data.opacity ?? 0) < 0.2) stopShake();
        break;

      case CONFIG.ANIM.BOMB_PULSE:
        bombPulse(data.ready);
        break;

      case CONFIG.ANIM.FOCUS_EFFECT:
        if (data.holderId) {
          focusEffect(data.holderId);
        } else {
          resetFocus();
        }
        break;

      case CONFIG.ANIM.HOLD_GLOW:
        holdGlow(data.start === true);
        if (data.stop === true) holdGlow(false);
        break;

      case CONFIG.ANIM.SLOW_MOTION:
        slowMotion(data.start === true);
        break;

      case CONFIG.ANIM.FAKE_OUT_RELIEF:
        fakeOutRelief();
        break;

      case CONFIG.ANIM.COUNTDOWN_POP:
        countdownPop(data.value ?? 3);
        break;

      case CONFIG.ANIM.WINNER_CONFETTI:
        winnerConfetti();
        break;

      case CONFIG.ANIM.CARD_ENTER:
        cardEnter(data.playerId);
        break;

      case CONFIG.ANIM.CARD_EXIT:
        cardExit(data.playerId, data.elimination);
        break;

      // 'pass_rejected' — shake the PASS button
      case 'pass_rejected': {
        const btn = document.getElementById('btn-pass');
        if (!btn) break;
        btn.style.animation = 'none';
        void btn.offsetWidth;
        btn.style.animation = 'shakeX 0.4s ease';
        setTimeout(() => { btn.style.animation = ''; }, 450);
        break;
      }

      default:
        break;
    }
  }

  // ── Init ──────────────────────────────────────────────────────

  function init() {
    EventBus.on(CONFIG.EVENTS.ANIMATION_TRIGGER, _dispatch);

    // Clean up confetti if we leave results screen
    EventBus.on(CONFIG.EVENTS.UI_SCREEN_CHANGE, (screen) => {
      if (screen !== CONFIG.SCREENS.RESULTS) {
        cancelAnimationFrame(_confettiRafId);
        _confettiParticles.forEach(p => p.el?.remove());
        _confettiParticles = [];
      }
      // Reset slow motion on any screen change
      slowMotion(false);
      stopShake();
      resetFocus();
    });
  }

  // ── Public surface ────────────────────────────────────────────
  return Object.freeze({
    init,
    bombArc,
    explosion,
    screenShake,
    stopShake,
    panicTint,
    bombPulse,
    focusEffect,
    resetFocus,
    holdGlow,
    whiteFlash,
    slowMotion,
    fakeOutRelief,
    countdownPop,
    winnerConfetti,
    cardEnter,
    cardExit,
  });

})();
