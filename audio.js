/**
 * PANIC BOMB — audio.js
 * Audio System.
 *
 * All sound is generated programmatically via the Web Audio API.
 * No external files needed — zero network requests for audio.
 *
 * Responsibilities:
 *   • Synthesize all SFX and music procedurally
 *   • Manage BGM layers (calm → tension → panic → final duel)
 *   • Heartbeat that accelerates with panic level
 *   • Mute / unmute with persistent preference
 *   • Master volume control
 *   • Respect browser autoplay policy (unlock on first gesture)
 *
 * Depends on: config.js, events.js
 */

const Audio = (() => {

  // ── Context & state ───────────────────────────────────────────
  let _ctx          = null;   // AudioContext
  let _masterGain   = null;   // master volume node
  let _muted        = false;
  let _masterVolume = 0.7;
  let _unlocked     = false;

  // Active looping sources (so we can stop them)
  const _loops = new Map();   // id → { source, gainNode }

  // Heartbeat state
  let _heartbeatInterval = null;
  let _heartbeatBpm      = 0;

  // BGM state
  let _currentBgm = null;

  // ── AudioContext bootstrap ────────────────────────────────────

  function _getCtx() {
    if (_ctx) return _ctx;
    try {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
      _masterGain = _ctx.createGain();
      _masterGain.gain.value = _muted ? 0 : _masterVolume;
      _masterGain.connect(_ctx.destination);
    } catch (e) {
      console.warn('[Audio] Web Audio API not available:', e);
      _ctx = null;
    }
    return _ctx;
  }

  /**
   * Resume the AudioContext after a user gesture.
   * Must be called from a click/tap handler to satisfy autoplay policy.
   */
  function _unlock() {
    if (_unlocked) return;
    const ctx = _getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => { _unlocked = true; });
    } else {
      _unlocked = true;
    }
  }

  // ── Low-level synthesis helpers ───────────────────────────────

  /**
   * Create a GainNode connected to master output.
   * @param {number} volume  0–1
   * @returns {GainNode}
   */
  function _gain(volume = 1) {
    const g = _ctx.createGain();
    g.gain.value = volume;
    g.connect(_masterGain);
    return g;
  }

  /**
   * Schedule a gain ramp.
   * @param {GainNode} gainNode
   * @param {number}   targetValue
   * @param {number}   durationSec
   */
  function _ramp(gainNode, targetValue, durationSec) {
    const now = _ctx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(targetValue, now + durationSec);
  }

  /**
   * Play a one-shot buffer.
   * @param {AudioBuffer} buffer
   * @param {GainNode}    outputGain
   * @param {number}      [when]  AudioContext time (default: now)
   */
  function _playBuffer(buffer, outputGain, when = 0) {
    if (!_ctx || !buffer) return null;
    const src = _ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(outputGain);
    src.start(when || _ctx.currentTime);
    return src;
  }

  /**
   * Create a simple buffer from a generator function.
   * @param {number}   duration   seconds
   * @param {Function} generator  (sampleIndex, sampleRate, numChannels) => Float32Array[]
   * @returns {AudioBuffer}
   */
  function _buildBuffer(duration, generator) {
    const ctx    = _ctx;
    const sr     = ctx.sampleRate;
    const len    = Math.ceil(sr * duration);
    const buf    = ctx.createBuffer(1, len, sr);
    const data   = buf.getChannelData(0);
    generator(data, sr, len);
    return buf;
  }

  // ── Sound Synthesis Library ───────────────────────────────────

  /**
   * Synthesize a tick/click sound (metronome-style).
   * @param {number} [pitch]  Hz (default 880)
   * @param {number} [vol]    0–1
   */
  function _synthTick(pitch = 880, vol = 0.4) {
    const ctx = _getCtx();
    if (!ctx) return;
    const g = _gain(vol);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitch, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.5, ctx.currentTime + 0.06);
    osc.connect(g);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  }

  /**
   * Single heartbeat "LUB-DUB" pattern.
   * @param {number} vol  0–1
   */
  function _synthHeartbeat(vol = 0.5) {
    const ctx = _getCtx();
    if (!ctx) return;

    function beat(offset, freq, dur, gainVal) {
      const g   = _gain(0);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + offset);

      g.gain.setValueAtTime(0, ctx.currentTime + offset);
      g.gain.linearRampToValueAtTime(gainVal, ctx.currentTime + offset + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + dur);

      osc.connect(g);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + dur + 0.01);
    }

    // Lub
    beat(0,    70, 0.10, vol);
    beat(0,    55, 0.12, vol * 0.7);
    // Dub (slightly quieter, 140ms later)
    beat(0.14, 60, 0.09, vol * 0.85);
    beat(0.14, 45, 0.11, vol * 0.6);
  }

  /**
   * Whoosh sound for bomb pass.
   * @param {number} vol
   */
  function _synthWhoosh(vol = 0.55) {
    const ctx = _getCtx();
    if (!ctx) return;
    const duration = 0.35;
    const buf = _buildBuffer(duration, (data, sr) => {
      for (let i = 0; i < data.length; i++) {
        const t   = i / sr;
        const env = Math.sin(Math.PI * t / duration);
        // White noise shaped into swoosh
        data[i] = (Math.random() * 2 - 1) * env * 0.8;
      }
    });
    // Band-pass filter for whoosh character
    const filter = ctx.createBiquadFilter();
    filter.type            = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value         = 0.6;

    const g = _gain(vol);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(filter);
    filter.connect(g);
    src.start(ctx.currentTime);
  }

  /**
   * Heavy thud for bomb landing.
   * @param {number} vol
   */
  function _synthThud(vol = 0.6) {
    const ctx = _getCtx();
    if (!ctx) return;

    const g   = _gain(0);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.2);

    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);

    osc.connect(g);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  }

  /**
   * Big explosion sound.
   * @param {number} vol
   */
  function _synthExplosion(vol = 0.9) {
    const ctx = _getCtx();
    if (!ctx) return;

    const duration = 2.0;

    // Low rumble
    const rumbleBuf = _buildBuffer(duration, (data, sr) => {
      for (let i = 0; i < data.length; i++) {
        const t   = i / sr;
        const env = Math.pow(1 - t / duration, 1.5);
        data[i] = (Math.random() * 2 - 1) * env;
      }
    });
    const lp = ctx.createBiquadFilter();
    lp.type            = 'lowpass';
    lp.frequency.value = 180;
    const g1 = _gain(vol * 0.9);
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = rumbleBuf;
    rumbleSrc.connect(lp);
    lp.connect(g1);
    rumbleSrc.start(ctx.currentTime);

    // Crack / transient
    const crackBuf = _buildBuffer(0.3, (data, sr) => {
      for (let i = 0; i < data.length; i++) {
        const t   = i / sr;
        const env = Math.pow(1 - t / 0.3, 4);
        data[i] = (Math.random() * 2 - 1) * env;
      }
    });
    const hp = ctx.createBiquadFilter();
    hp.type            = 'highpass';
    hp.frequency.value = 2000;
    const g2 = _gain(vol * 0.7);
    const crackSrc = ctx.createBufferSource();
    crackSrc.buffer = crackBuf;
    crackSrc.connect(hp);
    hp.connect(g2);
    crackSrc.start(ctx.currentTime);

    // Sub boom
    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(60, ctx.currentTime);
    boom.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 0.4);
    const g3 = _gain(0);
    g3.gain.setValueAtTime(vol, ctx.currentTime);
    g3.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    boom.connect(g3);
    boom.start(ctx.currentTime);
    boom.stop(ctx.currentTime + 0.55);
  }

  /**
   * Elimination sound (descending tones).
   * @param {number} vol
   */
  function _synthElimination(vol = 0.5) {
    const ctx = _getCtx();
    if (!ctx) return;
    const freqs = [440, 330, 220, 165];
    freqs.forEach((freq, i) => {
      const g   = _gain(0);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol * 0.5, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + 0.2);
    });
  }

  /**
   * Win fanfare (ascending arpeggio).
   * @param {number} vol
   */
  function _synthWin(vol = 0.6) {
    const ctx = _getCtx();
    if (!ctx) return;
    const freqs = [261, 329, 392, 523, 659, 784];
    freqs.forEach((freq, i) => {
      const g   = _gain(0);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + i * 0.1;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol * 0.7, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
  }

  /**
   * Soft ding (player joined / copy code).
   * @param {number} vol
   */
  function _synthDing(vol = 0.35) {
    const ctx = _getCtx();
    if (!ctx) return;
    const g   = _gain(0);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1047, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1047 * 1.5, ctx.currentTime + 0.03);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(g);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.55);
  }

  /**
   * PASS ready indicator (rising two-tone).
   * @param {number} vol
   */
  function _synthPassReady(vol = 0.3) {
    const ctx = _getCtx();
    if (!ctx) return;
    [[440, 0], [660, 0.09]].forEach(([freq, offset]) => {
      const g   = _gain(0);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + offset;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + 0.18);
    });
  }

  /**
   * Fake-out "scare" sound — rising glissando then cut.
   * @param {number} vol
   */
  function _synthFakeOut(vol = 0.55) {
    const ctx = _getCtx();
    if (!ctx) return;

    // Rising siren
    const g   = _gain(0);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.4);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
    osc.connect(g);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.42);

    // Then relief exhale (white noise burst)
    setTimeout(() => {
      const buf = _buildBuffer(0.3, (data, sr) => {
        for (let i = 0; i < data.length; i++) {
          const t = i / sr;
          data[i] = (Math.random() * 2 - 1) * (1 - t / 0.3) * 0.4;
        }
      });
      const g2 = _gain(vol * 0.4);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(g2);
      src.start(ctx.currentTime);
    }, 420);
  }

  /**
   * Countdown beep.
   * @param {number} tick   3 | 2 | 1 | 0 (0 = GO)
   * @param {number} vol
   */
  function _synthCountdown(tick, vol = 0.5) {
    const ctx = _getCtx();
    if (!ctx) return;
    const freq = tick === 0 ? 880 : 440;
    const dur  = tick === 0 ? 0.4 : 0.12;
    const g    = _gain(0);
    const osc  = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.connect(g);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur + 0.01);
  }

  // ── Background Music Synthesizer ─────────────────────────────
  //
  // BGM is built from looping oscillator patterns.
  // Four layers, crossfaded based on panic level:
  //   calm       — slow pulse, low drones
  //   tension    — mid-tempo hi-hat pattern + bass
  //   panic      — faster pattern + distortion
  //   final_duel — intense sustained tones

  /**
   * Build a looping rhythmic BGM node graph.
   * Returns a gain node (connected to master) that can be faded.
   *
   * @param {'calm'|'tension'|'panic'|'final'} mode
   * @returns {{ gainNode: GainNode, stop: Function }}
   */
  function _buildBgmLayer(mode) {
    const ctx = _ctx;
    const layerGain = ctx.createGain();
    layerGain.gain.value = 0;
    layerGain.connect(_masterGain);

    const sources = [];

    if (mode === 'calm') {
      // Slow LFO pulse drone
      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.value = 55; // low A

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.3;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 8;
      lfo.connect(lfoGain);
      lfoGain.connect(osc1.frequency);

      const filt = ctx.createBiquadFilter();
      filt.type            = 'lowpass';
      filt.frequency.value = 300;

      osc1.connect(filt);
      filt.connect(layerGain);

      osc1.start();
      lfo.start();
      sources.push(osc1, lfo);

      // Second harmonic
      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.value = 110;
      const g2 = ctx.createGain();
      g2.gain.value = 0.2;
      osc2.connect(g2);
      g2.connect(layerGain);
      osc2.start();
      sources.push(osc2);

    } else if (mode === 'tension') {
      // Bass pulse + mid drone
      const bass = ctx.createOscillator();
      bass.type = 'sawtooth';
      bass.frequency.value = 80;

      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 2.5;   // ~150 BPM 16th note feel
      const lfoG = ctx.createGain();
      lfoG.gain.value = 0.6;
      lfo.connect(lfoG);
      lfoG.connect(bass.frequency);

      const lp = ctx.createBiquadFilter();
      lp.type            = 'lowpass';
      lp.frequency.value = 600;
      const bassG = ctx.createGain();
      bassG.gain.value   = 0.5;
      bass.connect(lp);
      lp.connect(bassG);
      bassG.connect(layerGain);
      bass.start();
      lfo.start();
      sources.push(bass, lfo);

      // Tension drone
      const drone = ctx.createOscillator();
      drone.type = 'sawtooth';
      drone.frequency.value = 165;
      const droneG = ctx.createGain();
      droneG.gain.value = 0.15;
      drone.connect(droneG);
      droneG.connect(layerGain);
      drone.start();
      sources.push(drone);

    } else if (mode === 'panic') {
      // Fast aggressive pulse
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 110;

      const tremoloLfo = ctx.createOscillator();
      tremoloLfo.frequency.value = 8;
      const tremoloG = ctx.createGain();
      tremoloG.gain.value = 0.8;
      tremoloLfo.connect(tremoloG);
      tremoloG.connect(osc.frequency);

      const dist = ctx.createWaveShaper();
      dist.curve = _makeDistortionCurve(50);
      dist.oversample = '2x';

      const bp = ctx.createBiquadFilter();
      bp.type            = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value         = 1.5;

      const g = ctx.createGain();
      g.gain.value = 0.35;

      osc.connect(dist);
      dist.connect(bp);
      bp.connect(g);
      g.connect(layerGain);

      osc.start();
      tremoloLfo.start();
      sources.push(osc, tremoloLfo);

    } else if (mode === 'final') {
      // Intense high-frequency sustained tone with vibrato
      const freqs = [220, 277, 330, 440];
      freqs.forEach((f, i) => {
        const osc  = ctx.createOscillator();
        osc.type   = 'sawtooth';
        osc.frequency.value = f;

        const vib  = ctx.createOscillator();
        vib.frequency.value = 5 + i;
        const vibG = ctx.createGain();
        vibG.gain.value = 3;
        vib.connect(vibG);
        vibG.connect(osc.frequency);

        const g = ctx.createGain();
        g.gain.value = 0.12;
        osc.connect(g);
        g.connect(layerGain);

        osc.start();
        vib.start();
        sources.push(osc, vib);
      });
    }

    return {
      gainNode: layerGain,
      stop() {
        sources.forEach(s => { try { s.stop(); } catch (_) {} });
        layerGain.disconnect();
      },
    };
  }

  function _makeDistortionCurve(amount) {
    const n   = 256;
    const curve = new Float32Array(n);
    const deg  = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  // ── BGM Manager ───────────────────────────────────────────────

  const _bgmLayers = {};   // mode → { gainNode, stop }

  function _ensureBgmLayer(mode) {
    if (!_bgmLayers[mode]) {
      _bgmLayers[mode] = _buildBgmLayer(mode);
    }
    return _bgmLayers[mode];
  }

  /**
   * Cross-fade to a BGM layer.
   * @param {string}  mode       'calm'|'tension'|'panic'|'final'
   * @param {number}  [fadeIn]   seconds (default 1.5)
   * @param {boolean} [reset]    If true, fade out all other layers first
   */
  function _crossfadeBgm(mode, fadeIn = 1.5, reset = false) {
    const ctx = _getCtx();
    if (!ctx) return;

    if (reset) {
      Object.entries(_bgmLayers).forEach(([m, layer]) => {
        if (m !== mode) {
          _ramp(layer.gainNode, 0, 0.8);
        }
      });
    }

    const layer = _ensureBgmLayer(mode);
    const targetVol = { calm: 0.18, tension: 0.22, panic: 0.28, final: 0.32 }[mode] ?? 0.2;
    _ramp(layer.gainNode, targetVol, fadeIn);
    _currentBgm = mode;
  }

  /**
   * Fade out all BGM.
   * @param {number} [duration]  seconds
   */
  function _stopAllBgm(duration = 1.0) {
    Object.values(_bgmLayers).forEach(layer => {
      _ramp(layer.gainNode, 0, duration);
    });
    _currentBgm = null;
  }

  // ── Heartbeat Manager ─────────────────────────────────────────

  /**
   * Start heartbeat at a given BPM.
   * @param {number} bpm
   */
  function _startHeartbeat(bpm) {
    _stopHeartbeat();
    _heartbeatBpm = bpm;
    const intervalMs = (60 / bpm) * 1000;
    _heartbeatInterval = setInterval(() => {
      _synthHeartbeat(0.45);
    }, intervalMs);
    // First beat immediately
    _synthHeartbeat(0.45);
  }

  /**
   * Change heartbeat speed smoothly.
   * @param {number} bpm
   */
  function _setHeartbeatBpm(bpm) {
    if (Math.abs(bpm - _heartbeatBpm) < 5) return; // ignore tiny changes
    _startHeartbeat(bpm);
  }

  function _stopHeartbeat() {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
    _heartbeatBpm      = 0;
  }

  // ── Audio Trigger Dispatcher ──────────────────────────────────

  /**
   * Central handler for AUDIO_TRIGGER events from EventBus.
   * @param {Object} data  { type, ...options }
   */
  function _dispatch(data) {
    if (!data?.type) return;
    _unlock(); // ensure context is live
    const ctx = _getCtx();
    if (!ctx) return;

    const A = CONFIG.AUDIO;

    switch (data.type) {

      // ── SFX ──────────────────────────────────────────────────

      case A.SFX_TICK:
        _synthTick(data.slowMo ? 600 : 880, 0.35);
        break;

      case A.SFX_HEARTBEAT:
        if (data.start) {
          _startHeartbeat(60);
        } else if (data.fast) {
          _setHeartbeatBpm(140);
        } else if (data.stop) {
          _stopHeartbeat();
        } else {
          // Single beat
          _synthHeartbeat(0.45);
        }
        break;

      case A.SFX_WHOOSH:
        _synthWhoosh(0.55);
        break;

      case A.SFX_THUD:
        _synthThud(0.6);
        break;

      case A.SFX_EXPLOSION:
        _synthExplosion(0.9);
        _stopHeartbeat();
        break;

      case A.SFX_ELIMINATION:
        _synthElimination(0.5);
        break;

      case A.SFX_WIN:
        _synthWin(0.65);
        break;

      case A.SFX_DING:
        _synthDing(0.35);
        break;

      case A.SFX_PASS_READY:
        _synthPassReady(0.3);
        break;

      case A.SFX_FAKE_OUT:
        _synthFakeOut(0.55);
        break;

      case A.SFX_COUNTDOWN:
        _synthCountdown(data.tick ?? 3, 0.5);
        break;

      // ── BGM ───────────────────────────────────────────────────

      case A.BGM_CALM:
        _crossfadeBgm('calm', 1.5, data.reset);
        // Fade out higher panic layers
        if (_bgmLayers['tension']) _ramp(_bgmLayers['tension'].gainNode, 0, 1.5);
        if (_bgmLayers['panic'])   _ramp(_bgmLayers['panic'].gainNode, 0, 1.5);
        if (_bgmLayers['final'])   _ramp(_bgmLayers['final'].gainNode, 0, 1.5);
        break;

      case A.BGM_TENSION:
        if (data.fadeIn) {
          _crossfadeBgm('tension', 1.2);
          if (_bgmLayers['calm']) _ramp(_bgmLayers['calm'].gainNode, 0.08, 1.2);
        }
        break;

      case A.BGM_PANIC:
        if (data.fadeIn) {
          _crossfadeBgm('panic', 0.8);
          if (_bgmLayers['tension']) _ramp(_bgmLayers['tension'].gainNode, 0.1, 0.8);
          if (_bgmLayers['calm'])    _ramp(_bgmLayers['calm'].gainNode, 0, 0.6);
        }
        if (data.drop) {
          // Audio drop: briefly silence everything except low rumble
          _stopAllBgm(0.15);
          _stopHeartbeat();
          // Single slow heartbeat after silence
          setTimeout(() => _synthHeartbeat(0.6), 300);
        }
        break;

      case A.BGM_FINAL_DUEL:
        if (data.fadeIn) {
          _crossfadeBgm('final', 1.5, true);
          _startHeartbeat(72);
        }
        break;

      case A.AUDIO_STOP:
        _stopAllBgm(0.3);
        _stopHeartbeat();
        break;

      default:
        break;
    }
  }

  // ── Public Controls ───────────────────────────────────────────

  /**
   * Set master volume.
   * @param {number} vol  0–1
   */
  function setVolume(vol) {
    _masterVolume = Math.max(0, Math.min(1, vol));
    if (_masterGain && !_muted) {
      _masterGain.gain.value = _masterVolume;
    }
    try { localStorage.setItem('pb_volume', _masterVolume); } catch (_) {}
  }

  /**
   * Toggle mute on/off.
   * @returns {boolean}  new muted state
   */
  function toggleMute() {
    _muted = !_muted;
    if (_masterGain) {
      _masterGain.gain.value = _muted ? 0 : _masterVolume;
    }
    try { localStorage.setItem('pb_muted', _muted ? '1' : '0'); } catch (_) {}
    return _muted;
  }

  /** @returns {boolean} */
  function isMuted() { return _muted; }

  /** @returns {number} 0–1 */
  function getVolume() { return _masterVolume; }

  // ── Init ──────────────────────────────────────────────────────

  function init() {
    // Restore preferences
    try {
      const savedVol   = localStorage.getItem('pb_volume');
      const savedMuted = localStorage.getItem('pb_muted');
      if (savedVol   !== null) _masterVolume = parseFloat(savedVol);
      if (savedMuted !== null) _muted        = savedMuted === '1';
    } catch (_) {}

    // Unlock on first user gesture
    const unlockEvents = ['click', 'touchstart', 'keydown', 'pointerdown'];
    const _onGesture = () => {
      _unlock();
      unlockEvents.forEach(e => document.removeEventListener(e, _onGesture));
    };
    unlockEvents.forEach(e => document.addEventListener(e, _onGesture, { once: true, passive: true }));

    // Listen to trigger events
    EventBus.on(CONFIG.EVENTS.AUDIO_TRIGGER, _dispatch);

    // Update heartbeat speed on panic level change
    EventBus.on(CONFIG.EVENTS.PANIC_LEVEL_CHANGED, (data) => {
      if (!_unlocked) return;
      const bpmMap = [0, 60, 100, 160];
      const bpm    = bpmMap[data.level] ?? 0;
      if (data.fakeOut) {
        // Fake-out: stop accelerating heartbeat
        _stopHeartbeat();
        return;
      }
      if (bpm === 0) {
        _stopHeartbeat();
      } else if (data.level >= 2) {
        _setHeartbeatBpm(bpm);
      }
    });

    // Stop everything on game end
    EventBus.on(CONFIG.EVENTS.UI_SCREEN_CHANGE, (screen) => {
      if (screen === CONFIG.SCREENS.RESULTS || screen === CONFIG.SCREENS.LOBBY) {
        _stopAllBgm(1.0);
        _stopHeartbeat();
      }
    });
  }

  // ── Public surface ────────────────────────────────────────────
  return Object.freeze({
    init,
    setVolume,
    toggleMute,
    isMuted,
    getVolume,
  });

})();
window.Audio = Audio;
