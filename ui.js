/**
 * PANIC BOMB — ui.js
 * UI System.
 *
 * Responsibilities:
 *   • Listen to EventBus and update the DOM accordingly
 *   • Manage screen transitions (show/hide)
 *   • Render player cards in Lobby
 *   • Render player circle in Game screen
 *   • Control PASS / HOLD button states
 *   • Render Explosion and Results screens
 *   • Capture and forward user input to EventBus
 *   • NO game logic, NO animation math, NO audio
 *
 * Depends on: config.js, events.js, state.js
 */

const UI = (() => {

  // ── DOM Cache ─────────────────────────────────────────────────
  // Populated once in init() to avoid repeated querySelector calls.
  const $ = {};

  function _cacheDOM() {
    // Screens
    $.screens = {
      landing:    document.getElementById('screen-landing'),
      room:       document.getElementById('screen-room'),
      setup:      document.getElementById('screen-setup'),
      lobby:      document.getElementById('screen-lobby'),
      countdown:  document.getElementById('screen-countdown'),
      game:       document.getElementById('screen-game'),
      explosion:  document.getElementById('screen-explosion'),
      results:    document.getElementById('screen-results'),
    };

    // Landing
    $.btnCreateRoom  = document.getElementById('btn-create-room');
    $.btnJoinRoom    = document.getElementById('btn-join-room');

    // Room
    $.panelCreate        = document.getElementById('panel-create');
    $.panelJoin          = document.getElementById('panel-join');
    $.toggleCreate       = document.getElementById('toggle-create');
    $.toggleJoin         = document.getElementById('toggle-join');
    $.btnBackFromRoom    = document.getElementById('btn-back-from-room');
    $.btnConfirmCreate   = document.getElementById('btn-confirm-create');
    $.btnConfirmJoin     = document.getElementById('btn-confirm-join');
    $.roomCodeInputGroup = document.getElementById('room-code-input-group');
    $.codeChars          = Array.from(document.querySelectorAll('.code-char'));
    $.codeStatus         = document.getElementById('code-status');
    $.chipsMaxPlayers    = document.getElementById('chips-max-players');
    $.chipsBombTimer     = document.getElementById('chips-bomb-timer');
    $.chipsBestOf        = document.getElementById('chips-best-of');

    // Setup
    $.btnBackFromSetup   = document.getElementById('btn-back-from-setup');
    $.avatarPreview      = document.getElementById('avatar-preview');
    $.avatarImg          = document.getElementById('avatar-img');
    $.avatarFileInput    = document.getElementById('avatar-file-input');
    $.avatarEmojiRow     = document.getElementById('avatar-emoji-row');
    $.playerNameInput    = document.getElementById('player-name-input');
    $.nameCounter        = document.getElementById('name-counter');
    $.namePreviewCard    = document.getElementById('name-preview-card');
    $.previewAvatarDisp  = document.getElementById('preview-avatar-display');
    $.previewNameDisp    = document.getElementById('preview-name-display');
    $.btnReadySetup      = document.getElementById('btn-ready-setup');

    // Lobby
    $.lobbyCodeText      = document.getElementById('lobby-code-text');
    $.btnCopyCode        = document.getElementById('btn-copy-code');
    $.lobbyPlayerCount   = document.getElementById('lobby-player-count');
    $.lobbyPlayersGrid   = document.getElementById('lobby-players-grid');
    $.lobbyEmptySlots    = document.getElementById('lobby-empty-slots');
    $.lobbyWaitingMsg    = document.getElementById('lobby-waiting-msg');
    $.btnStartGame       = document.getElementById('btn-start-game');

    // Countdown
    $.countdownNumber    = document.getElementById('countdown-number');

    // Game
    $.gameArena          = document.getElementById('game-arena');
    $.hudRound           = document.getElementById('hud-round');
    $.hudPlayersLeft     = document.getElementById('hud-players-left');
    $.bvtFill            = document.getElementById('bvt-fill');
    $.bvtPhases          = document.querySelectorAll('.bvt-phase');
    $.holderStatusText   = document.getElementById('holder-status-text');
    $.actionButtons      = document.getElementById('action-buttons');
    $.btnPass            = document.getElementById('btn-pass');
    $.btnHold            = document.getElementById('btn-hold');
    $.holdDangerFill     = document.getElementById('hold-danger-fill');
    $.passCooldownBar    = document.getElementById('pass-cooldown-bar');
    $.passTargetSelector = document.getElementById('pass-target-selector');
    $.ptsPlayers         = document.getElementById('pts-players');
    $.ptsCancel          = document.getElementById('pts-cancel');
    $.spectatorPanel     = document.getElementById('spectator-panel');
    $.specReactions      = document.getElementById('spec-reactions');
    $.reactionsLayer     = document.getElementById('reactions-layer');
    $.flyingBomb         = document.getElementById('flying-bomb');
    $.panicTint          = document.getElementById('panic-tint');

    // Explosion
    $.explosionFlash     = document.getElementById('explosion-flash');
    $.victimAvatar       = document.getElementById('victim-avatar');
    $.victimName         = document.getElementById('victim-name');
    $.victimTagline      = document.getElementById('victim-tagline');
    $.survivorsCount     = document.getElementById('survivors-count');

    // Results
    $.winnerAvatar       = document.getElementById('winner-avatar');
    $.winnerName         = document.getElementById('winner-name');
    $.resultsList        = document.getElementById('results-list');
    $.btnExitRoom        = document.getElementById('btn-exit-room');
    $.btnPlayAgain       = document.getElementById('btn-play-again');

    // Toast
    $.toast = document.getElementById('toast');

    // Global controls
    $.btnMute       = document.getElementById('btn-mute');
    $.netIndicator  = document.getElementById('net-indicator');
  }

  // ── Transient UI state ────────────────────────────────────────
  let _toastTimer       = null;
  let _cooldownRafId    = null;
  let _selectedAvatar   = '😈';   // current emoji or base64
  let _roomSettings     = { maxPlayers: 4, bombMode: 'normal', bestOf: 1 };
  let _spectatorReactionCooldown = false;
  let _holdingDown      = false;  // tracks pointer-down on HOLD button

  // ── Screen Management ─────────────────────────────────────────

  /**
   * Transition to a named screen.
   * @param {string} screenName  One of CONFIG.SCREENS.*
   */
  function showScreen(screenName) {
    const target = $.screens[screenName];
    if (!target) {
      console.warn(`[UI] showScreen: unknown screen "${screenName}"`);
      return;
    }

    // Deactivate all screens
    Object.values($.screens).forEach(s => s.classList.remove('active'));

    // Activate target
    target.classList.add('active');
    State.set('screen', screenName, true);
  }

  // ── Toast ─────────────────────────────────────────────────────

  /**
   * Show a brief status message at the bottom of the screen.
   * @param {string}  message
   * @param {string}  [type]   'success' | 'error' | 'info' | 'warn'
   * @param {number}  [ms]     Duration in ms (default 2500)
   */
  function showToast(message, type = 'info', ms = 2500) {
    clearTimeout(_toastTimer);
    $.toast.textContent = message;
    $.toast.className   = `toast show ${type}`;
    _toastTimer = setTimeout(() => {
      $.toast.classList.remove('show');
    }, ms);
  }

  // ── Avatar Helpers ────────────────────────────────────────────

  /**
   * Render an avatar value (emoji or base64) into an element.
   * If base64, creates an <img>. Otherwise sets textContent.
   * @param {HTMLElement} el
   * @param {string}      avatar
   */
  function _renderAvatar(el, avatar) {
    if (!el) return;
    if (avatar && avatar.startsWith('data:')) {
      el.innerHTML = `<img src="${avatar}" alt="avatar" />`;
    } else {
      el.textContent = avatar || '?';
    }
  }

  // ── Room Settings UI ──────────────────────────────────────────

  function _initChipGroups() {
    function bindChipGroup(container, key) {
      if (!container) return;
      container.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
          container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          _roomSettings[key] = chip.dataset.value;
          if (key === 'maxPlayers') _roomSettings[key] = parseInt(chip.dataset.value, 10);
        });
      });
    }
    bindChipGroup($.chipsMaxPlayers, 'maxPlayers');
    bindChipGroup($.chipsBombTimer,  'bombMode');
    bindChipGroup($.chipsBestOf,     'bestOf');
  }

  // ── Code Input UI ─────────────────────────────────────────────

  function _initCodeInput() {
    $.codeChars.forEach((input, idx) => {
      input.addEventListener('input', (e) => {
        const val = e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 1).toUpperCase();
        e.target.value = val;
        if (val && idx < $.codeChars.length - 1) {
          $.codeChars[idx + 1].focus();
        }
        _checkCodeComplete();
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !e.target.value && idx > 0) {
          $.codeChars[idx - 1].focus();
          $.codeChars[idx - 1].value = '';
          _checkCodeComplete();
        }
      });

      // Select all on focus for easy re-entry
      input.addEventListener('focus', () => e => e.target.select());
    });
  }

  function _checkCodeComplete() {
    const code = $.codeChars.map(c => c.value).join('');
    const complete = code.length === CONFIG.ROOM.CODE_LENGTH;
    $.btnConfirmJoin.disabled = !complete;
    if (complete) $.codeStatus.textContent = '';
    return code;
  }

  function _getEnteredCode() {
    return $.codeChars.map(c => c.value.toUpperCase()).join('');
  }

  function _setCodeInputState(state) {
    // state: 'valid' | 'invalid' | 'neutral'
    $.codeChars.forEach(c => {
      c.classList.remove('valid', 'invalid');
      if (state !== 'neutral') c.classList.add(state);
    });
    if (state === 'valid') {
      $.codeStatus.textContent = '✓ Room found';
      $.codeStatus.className   = 'code-status success';
    } else if (state === 'invalid') {
      $.codeStatus.textContent = '✗ Room not found';
      $.codeStatus.className   = 'code-status error';
    } else {
      $.codeStatus.textContent = '';
      $.codeStatus.className   = 'code-status';
    }
  }

  // ── Avatar / Setup UI ─────────────────────────────────────────

  function _initSetupScreen() {
    // Click on avatar preview → open file picker
    $.avatarPreview.addEventListener('click', () => {
      $.avatarFileInput.click();
    });

    // File selected
    $.avatarFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (file.size > CONFIG.PLAYER.AVATAR_MAX_SIZE) {
        showToast('Image too large (max 2MB)', 'error');
        return;
      }

      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        _selectedAvatar = dataUrl;
        $.avatarImg.src  = dataUrl;
        $.avatarImg.classList.remove('hidden');
        $.avatarPreview.querySelector('.avatar-default-icon').classList.add('hidden');
        // Deselect emoji buttons
        $.avatarEmojiRow.querySelectorAll('.avatar-emoji-opt').forEach(b => b.classList.remove('selected'));
        _updatePreviewCard();
        EventBus.emit(CONFIG.EVENTS.AVATAR_CHANGED, { avatar: dataUrl });
      };
      reader.readAsDataURL(file);
    });

    // Emoji options
    $.avatarEmojiRow.querySelectorAll('.avatar-emoji-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const emoji = btn.dataset.emoji;
        _selectedAvatar = emoji;
        // Clear uploaded image
        $.avatarImg.classList.add('hidden');
        $.avatarImg.src = '';
        $.avatarPreview.querySelector('.avatar-default-icon').textContent = emoji;
        $.avatarPreview.querySelector('.avatar-default-icon').classList.remove('hidden');
        // Mark selected
        $.avatarEmojiRow.querySelectorAll('.avatar-emoji-opt').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        _updatePreviewCard();
        EventBus.emit(CONFIG.EVENTS.AVATAR_CHANGED, { avatar: emoji });
      });
    });

    // Select first emoji by default
    const firstEmoji = $.avatarEmojiRow.querySelector('.avatar-emoji-opt');
    if (firstEmoji) firstEmoji.click();

    // Name input
    $.playerNameInput.addEventListener('input', () => {
      const val = $.playerNameInput.value.slice(0, CONFIG.PLAYER.NAME_MAX_LENGTH);
      $.playerNameInput.value = val;
      $.nameCounter.textContent = `${val.length}/${CONFIG.PLAYER.NAME_MAX_LENGTH}`;
      $.btnReadySetup.disabled = val.trim().length < CONFIG.PLAYER.NAME_MIN_LENGTH;
      _updatePreviewCard();
    });
  }

  function _updatePreviewCard() {
    const name   = $.playerNameInput?.value?.trim() || 'Player';
    const avatar = _selectedAvatar;
    $.previewNameDisp.textContent = name;
    _renderAvatar($.previewAvatarDisp, avatar);
  }

  // ── Lobby Rendering ───────────────────────────────────────────

  /**
   * Re-render the lobby player grid from State.
   */
  function renderLobby() {
    const players    = State.get('players');
    const maxPlayers = State.get('room.settings.maxPlayers') || 4;
    const hostId     = State.get('room.hostId');
    const localId    = State.get('localPlayer.id');
    const isHost     = State.isHost();

    // Header
    $.lobbyCodeText.textContent    = State.get('room.code') || '-----';
    $.lobbyPlayerCount.textContent = `${players.length} / ${maxPlayers}`;

    // Player cards
    $.lobbyPlayersGrid.innerHTML = '';
    players.forEach(player => {
      const card = _makeLobbyPlayerCard(player, hostId, localId, isHost);
      $.lobbyPlayersGrid.appendChild(card);
    });

    // Empty slots
    const emptyCount = Math.max(0, maxPlayers - players.length);
    $.lobbyEmptySlots.innerHTML = '';
    for (let i = 0; i < emptyCount; i++) {
      const slot = document.createElement('div');
      slot.className = 'empty-slot';
      slot.innerHTML = `<span style="font-size:1.5rem;opacity:0.3">+</span><span>Waiting...</span>`;
      $.lobbyEmptySlots.appendChild(slot);
    }

    // Start button (host only, all ready)
    const allReady = players.length >= 2 && players.every(p => p.isReady);
    if (isHost) {
      $.btnStartGame.classList.remove('hidden');
      $.btnStartGame.disabled = !allReady;
      $.lobbyWaitingMsg.textContent = allReady ? 'All ready! Start when you want.' : 'Waiting for everyone to ready up...';
    } else {
      $.btnStartGame.classList.add('hidden');
      const readyCount = players.filter(p => p.isReady).length;
      $.lobbyWaitingMsg.textContent = `${readyCount} / ${players.length} ready`;
    }
  }

  function _makeLobbyPlayerCard(player, hostId, localId, viewerIsHost) {
    const card = document.createElement('div');
    card.className = 'player-card' + (player.id === hostId ? ' host' : '');
    card.dataset.playerId = player.id;

    const isReady    = player.isReady;
    const isThisHost = player.id === hostId;
    const isMe       = player.id === localId;

    card.innerHTML = `
      <div class="pc-avatar" id="pc-av-${player.id}">
        ${_avatarHTML(player.avatar)}
      </div>
      ${isThisHost ? '<span class="host-crown" title="Host">👑</span>' : ''}
      <div class="pc-name">${_escHTML(player.name)}${isMe ? ' (you)' : ''}</div>
      <div class="pc-status ${isReady ? 'ready' : 'waiting'}">
        ${isReady ? '● READY' : '○ WAITING'}
      </div>
      ${(viewerIsHost && !isMe)
        ? `<button class="pc-kick-btn" data-kick="${player.id}" aria-label="Kick ${_escHTML(player.name)}">✕</button>`
        : ''}
    `;

    // Bind kick button
    if (viewerIsHost && !isMe) {
      card.querySelector('.pc-kick-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        Network.kickPlayer(player.id);
      });
    }

    return card;
  }

  // ── Game Circle Layout ────────────────────────────────────────

  /**
   * Calculate (x%, y%) positions for N players in a circle.
   * Returns array of { x, y } in percentages of arena size.
   */
  function _circlePositions(count) {
    const positions = [];
    // Start from top (- π/2) so first player is at top
    const startAngle = -Math.PI / 2;
    for (let i = 0; i < count; i++) {
      const angle = startAngle + (2 * Math.PI * i) / count;
      // radius as % of the container (40% gives good padding)
      const r = 38;
      positions.push({
        x: 50 + r * Math.cos(angle),
        y: 50 + r * Math.sin(angle),
      });
    }
    return positions;
  }

  /**
   * Render the player circle in the game arena.
   * Called once when game starts and when a player is eliminated.
   */
  function renderGameArena() {
    const activePlayers = State.getActivePlayers();
    const holderId      = State.getCurrentHolder();
    const localId       = State.get('localPlayer.id');
    const allPlayers    = State.get('players');

    $.gameArena.innerHTML = '';

    const positions = _circlePositions(activePlayers.length);

    activePlayers.forEach((player, idx) => {
      const pos    = positions[idx];
      const isHolder = player.id === holderId;
      const node   = _makePlayerNode(player, isHolder, localId);
      node.style.left = `${pos.x}%`;
      node.style.top  = `${pos.y}%`;
      $.gameArena.appendChild(node);
    });

    // Also add eliminated players faded out (outside circle or hidden)
    allPlayers
      .filter(p => !activePlayers.find(a => a.id === p.id))
      .forEach(player => {
        const node = _makePlayerNode(player, false, localId);
        node.classList.add('eliminated');
        node.style.left  = '-100px'; // off-screen
        node.style.top   = '-100px';
        node.style.display = 'none';
        $.gameArena.appendChild(node);
      });

    _updateGameActions();
  }

  function _makePlayerNode(player, isHolder, localId) {
    const node = document.createElement('div');
    node.className = 'player-node' + (isHolder ? ' holder' : '');
    node.id        = `pnode-${player.id}`;
    node.dataset.playerId = player.id;

    node.innerHTML = `
      ${isHolder ? '<div class="pn-bomb" aria-label="has the bomb">💣</div>' : ''}
      <div class="pn-avatar-wrap" id="pnav-${player.id}">
        ${_avatarHTML(player.avatar)}
      </div>
      <div class="pn-name">${_escHTML(player.name)}${player.id === localId ? ' ★' : ''}</div>
    `;

    return node;
  }

  /**
   * Move the bomb indicator to a new holder.
   * Called after arc animation completes.
   * @param {string} fromId
   * @param {string} toId
   */
  function transferBombVisual(fromId, toId) {
    // Remove bomb from old holder
    const fromNode = document.getElementById(`pnode-${fromId}`);
    if (fromNode) {
      fromNode.classList.remove('holder');
      const oldBomb = fromNode.querySelector('.pn-bomb');
      if (oldBomb) oldBomb.remove();
    }

    // Add bomb to new holder
    const toNode = document.getElementById(`pnode-${toId}`);
    if (toNode) {
      toNode.classList.add('holder');
      if (!toNode.querySelector('.pn-bomb')) {
        const bombEl = document.createElement('div');
        bombEl.className = 'pn-bomb';
        bombEl.setAttribute('aria-label', 'has the bomb');
        bombEl.textContent = '💣';
        toNode.prepend(bombEl);
      }
    }

    _updateGameActions();
  }

  /**
   * Update action buttons based on local player's current role.
   */
  function _updateGameActions() {
    const isHolder   = State.isHolder();
    const isActive   = State.isActivePlayer();
    const onCooldown = State.get('ui.passOnCooldown');
    const inTransit  = State.get('game.inTransit');

    if (!isActive) {
      // Show spectator panel
      $.spectatorPanel.classList.remove('hidden');
      $.actionButtons.classList.add('hidden');
      $.holderStatusText.textContent = 'You\'ve been eliminated — watching 👁️';
      return;
    }

    $.spectatorPanel.classList.add('hidden');
    $.actionButtons.classList.remove('hidden');

    if (isHolder) {
      $.btnPass.disabled = onCooldown || inTransit;
      $.btnHold.disabled = onCooldown || inTransit;

      if (onCooldown) {
        $.holderStatusText.textContent = '💣 Bomb received — cooldown...';
        _animateCooldownBar();
      } else if (inTransit) {
        $.holderStatusText.textContent = '💣 Passing...';
      } else {
        $.holderStatusText.textContent = '💣 YOU HAVE THE BOMB!';
      }
    } else {
      $.btnPass.disabled = true;
      $.btnHold.disabled = true;
      const holder = State.getPlayerById(State.getCurrentHolder());
      if (holder) {
        $.holderStatusText.textContent = `💣 ${_escHTML(holder.name)} has the bomb`;
      } else {
        $.holderStatusText.textContent = 'Waiting for bomb...';
      }
    }
  }

  /**
   * Animate the cooldown progress bar on the PASS button.
   */
  function _animateCooldownBar() {
    cancelAnimationFrame(_cooldownRafId);
    $.passCooldownBar.style.width = '0%';

    const endAt = State.get('ui.cooldownEndAt');
    if (!endAt) return;
    const total = CONFIG.PASS.COOLDOWN_MS;

    function tick() {
      const elapsed  = Date.now() - (endAt - total);
      const fraction = Math.min(1, elapsed / total);
      $.passCooldownBar.style.width = `${fraction * 100}%`;
      if (fraction < 1) {
        _cooldownRafId = requestAnimationFrame(tick);
      }
    }
    _cooldownRafId = requestAnimationFrame(tick);
  }

  /**
   * Update the HOLD danger fill based on hold duration.
   * Called by game.js via EventBus HOLD_ROULETTE_TICK.
   * @param {number} seconds
   * @param {number} probability  0–1
   */
  function updateHoldDanger(seconds, probability) {
    const pct = Math.min(100, probability * 100);
    $.holdDangerFill.style.width = `${pct}%`;
    // Tint the hold button border
    const alpha = Math.min(0.9, probability);
    $.btnHold.style.borderColor = `rgba(255,${Math.round(107 * (1 - probability))},0,${alpha})`;
  }

  /**
   * Build and show the pass target selector.
   */
  function openPassSelector() {
    const localId   = State.get('localPlayer.id');
    const prevId    = State.get('game.previousHolder');
    const active    = State.getActivePlayers().filter(p => p.id !== localId);

    $.ptsPlayers.innerHTML = '';
    active.forEach(player => {
      const btn = document.createElement('button');
      btn.className = 'pts-player-btn';
      btn.dataset.targetId = player.id;
      const isBlocked = player.id === prevId;
      btn.disabled = isBlocked;
      btn.style.opacity = isBlocked ? '0.35' : '1';
      btn.innerHTML = `
        <span class="pts-av">${_avatarHTML(player.avatar)}</span>
        <span class="pts-nm">${_escHTML(player.name)}</span>
        ${isBlocked ? '<span style="font-size:0.6rem;color:#ff2d2d">No backpass</span>' : ''}
      `;
      btn.addEventListener('click', () => {
        closePassSelector();
        EventBus.emit(CONFIG.EVENTS.PASS_REQUESTED, { toPlayerId: player.id });
      });
      $.ptsPlayers.appendChild(btn);
    });

    $.passTargetSelector.classList.remove('hidden');
    State.set('ui.passSelectorOpen', true, true);
  }

  function closePassSelector() {
    $.passTargetSelector.classList.add('hidden');
    State.set('ui.passSelectorOpen', false, true);
  }

  // ── Bomb Visual Timer ─────────────────────────────────────────

  /**
   * Update the BVT progress bar and phase indicators.
   * @param {number} fraction  0–1 (1 = full time, 0 = exploded)
   * @param {number} panicLevel 0–3
   */
  function updateBombTimer(fraction, panicLevel) {
    const colors = CONFIG.PANIC_EFFECTS.BVT_COLORS;
    const color  = colors[panicLevel] || colors[0];

    $.bvtFill.style.setProperty('--bvt-fill-width',  `${fraction * 100}%`);
    $.bvtFill.style.setProperty('--bvt-fill-color', color);
    $.bvtFill.style.width      = `${fraction * 100}%`;
    $.bvtFill.style.background = color;

    // Activate phase dots
    $.bvtPhases.forEach((dot, i) => {
      dot.classList.toggle('active', i === panicLevel);
    });
  }

  // ── HUD Updates ───────────────────────────────────────────────

  function updateHUD() {
    const round  = State.get('game.round');
    const active = State.activePlayerCount();
    $.hudRound.textContent       = `ROUND ${round}`;
    $.hudPlayersLeft.textContent = `${active} LEFT`;
  }

  // ── Panic Tint ────────────────────────────────────────────────

  /**
   * Update the red tint overlay intensity.
   * @param {number} opacity  0–0.45
   */
  function setPanicTint(opacity) {
    $.panicTint.style.setProperty('--panic-tint-opacity', opacity);
    $.panicTint.style.background = `rgba(255,45,45,${opacity})`;
  }

  // ── Explosion Screen ──────────────────────────────────────────

  /**
   * Populate the explosion screen with victim info.
   * @param {string} victimId
   */
  function showExplosionScreen(victimId) {
    const victim = State.getPlayerById(victimId);
    const active = State.activePlayerCount();

    if (victim) {
      _renderAvatar($.victimAvatar, victim.avatar);
      $.victimName.textContent    = victim.name;
    } else {
      $.victimAvatar.textContent  = '💀';
      $.victimName.textContent    = 'Unknown';
    }

    const taglines = [
      "couldn't handle the heat!",
      "should've passed sooner.",
      "held on too long.",
      "got blown away!",
      "was not fast enough.",
      "stood no chance.",
    ];
    $.victimTagline.textContent = taglines[Math.floor(Math.random() * taglines.length)];
    $.survivorsCount.textContent = active;
  }

  // ── Results Screen ────────────────────────────────────────────

  /**
   * Populate the results screen.
   */
  function showResultsScreen() {
    const results = State.get('results');
    const winner  = State.getPlayerById(results.winnerId);

    // Winner showcase
    if (winner) {
      _renderAvatar($.winnerAvatar, winner.avatar);
      $.winnerName.textContent = winner.name;
    }

    // Rankings list
    $.resultsList.innerHTML = '';
    const RANK_LABELS = ['🥇', '💀', '💀', '💀', '💀', '💀', '💀', '💀'];
    const RANK_NUMS   = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH'];

    results.ranking.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      row.style.setProperty('--i', idx);

      const detail = idx === 0
        ? 'Survived — Winner!'
        : `Eliminated — Round ${entry.eliminatedRound || '?'}`;

      // Award badges collected during game
      const badges = State.get(`game.badgesThisRound`)?.[entry.id] ?? [];
      const badgeStr = badges.map(b => b.emoji).join('');

      row.innerHTML = `
        <div class="rr-rank">${RANK_NUMS[idx] || (idx + 1)}</div>
        <div class="rr-avatar">${_avatarHTML(entry.avatar)}</div>
        <div class="rr-info">
          <div class="rr-name">${_escHTML(entry.name)}</div>
          <div class="rr-detail">${detail}</div>
        </div>
        <div class="rr-badge">${RANK_LABELS[idx] || ''}${badgeStr}</div>
      `;
      $.resultsList.appendChild(row);
    });
  }

  // ── Countdown Screen ──────────────────────────────────────────

  function updateCountdown(value) {
    $.countdownNumber.textContent = value === 0 ? 'GO!' : value;
    // Re-trigger animation by removing and re-adding element
    $.countdownNumber.style.animation = 'none';
    // Force reflow
    void $.countdownNumber.offsetWidth;
    $.countdownNumber.style.animation = '';
  }

  // ── Spectator Reactions ───────────────────────────────────────

  /**
   * Spawn a floating emoji reaction on the game screen.
   * @param {string} emoji
   */
  function spawnReaction(emoji) {
    const el = document.createElement('div');
    el.className = 'floating-reaction';
    el.textContent = emoji;
    el.style.left   = `${20 + Math.random() * 60}%`;
    el.style.bottom = `${80 + Math.random() * 20}px`;
    $.reactionsLayer.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ── Utility ───────────────────────────────────────────────────

  /** Escape HTML special chars to prevent XSS. */
  function _escHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Generate inner HTML for an avatar (emoji or img).
   * @param {string} avatar
   * @returns {string}
   */
  function _avatarHTML(avatar) {
    if (avatar && avatar.startsWith('data:')) {
      return `<img src="${avatar}" alt="avatar" />`;
    }
    return _escHTML(avatar || '?');
  }

  // ── Event Binding (User Input → EventBus) ────────────────────

  function _bindInputEvents() {
    // ── Landing ──────────────────────────────────────────────
    $.btnCreateRoom.addEventListener('click', () => {
      _showRoomPanel('create');
      showScreen(CONFIG.SCREENS.ROOM);
    });
    $.btnJoinRoom.addEventListener('click', () => {
      _showRoomPanel('join');
      showScreen(CONFIG.SCREENS.ROOM);
    });

    // ── Room ─────────────────────────────────────────────────
    $.btnBackFromRoom.addEventListener('click', () => showScreen(CONFIG.SCREENS.LANDING));

    $.toggleCreate.addEventListener('click', () => {
      _showRoomPanel('create');
      $.toggleCreate.classList.add('active');
      $.toggleJoin.classList.remove('active');
    });
    $.toggleJoin.addEventListener('click', () => {
      _showRoomPanel('join');
      $.toggleJoin.classList.add('active');
      $.toggleCreate.classList.remove('active');
    });

    $.btnConfirmCreate.addEventListener('click', () => {
      showScreen(CONFIG.SCREENS.SETUP);
      // Store intent: create
      $.btnReadySetup.dataset.intent = 'create';
    });

    $.btnConfirmJoin.addEventListener('click', () => {
      const code = _getEnteredCode();
      if (code.length < CONFIG.ROOM.CODE_LENGTH) return;
      showScreen(CONFIG.SCREENS.SETUP);
      $.btnReadySetup.dataset.intent = 'join';
      $.btnReadySetup.dataset.code   = code;
    });

    // ── Setup ─────────────────────────────────────────────────
    $.btnBackFromSetup.addEventListener('click', () => showScreen(CONFIG.SCREENS.ROOM));

    $.btnReadySetup.addEventListener('click', () => {
      const name   = $.playerNameInput.value.trim();
      const avatar = _selectedAvatar;
      if (!name) return;

      State.merge('localPlayer', { name, avatar });

      const intent = $.btnReadySetup.dataset.intent;
      if (intent === 'create') {
        Network.createRoom(_roomSettings, { name, avatar });
      } else {
        const code = $.btnReadySetup.dataset.code;
        Network.joinRoom(code, { name, avatar });
      }

      // Optimistic UI while waiting for server
      $.btnReadySetup.disabled  = true;
      $.btnReadySetup.textContent = 'Connecting...';
    });

    // ── Lobby ─────────────────────────────────────────────────
    $.btnCopyCode.addEventListener('click', () => {
      const code = State.get('room.code');
      if (!code) return;
      navigator.clipboard?.writeText(code).then(() => {
        showToast('Room code copied!', 'success');
      }).catch(() => {
        showToast(code, 'info', 4000);
      });
    });

    $.btnStartGame.addEventListener('click', () => {
      Network.startGame();
    });

    // Ready toggle — local player clicks their own card
    $.lobbyPlayersGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.player-card');
      if (!card) return;
      if (card.dataset.playerId !== State.get('localPlayer.id')) return;
      const current = State.get('localPlayer.isReady');
      State.set('localPlayer.isReady', !current, true);
      Network.setReady(!current);
    });

    // ── Game ──────────────────────────────────────────────────
    $.btnPass.addEventListener('click', () => {
      if ($.btnPass.disabled) return;
      const active = State.getActivePlayers().filter(p => p.id !== State.get('localPlayer.id'));
      if (active.length === 1) {
        // Only one other player — pass directly, no selector needed
        EventBus.emit(CONFIG.EVENTS.PASS_REQUESTED, { toPlayerId: active[0].id });
      } else {
        openPassSelector();
      }
    });

    // HOLD — pointer events for hold-down behavior
    $.btnHold.addEventListener('pointerdown', (e) => {
      if ($.btnHold.disabled) return;
      e.preventDefault();
      _holdingDown = true;
      $.btnHold.setPointerCapture(e.pointerId);
      EventBus.emit(CONFIG.EVENTS.HOLD_STARTED);
    });

    const _stopHold = () => {
      if (!_holdingDown) return;
      _holdingDown = false;
      $.holdDangerFill.style.width    = '0%';
      $.btnHold.style.borderColor = '';
      EventBus.emit(CONFIG.EVENTS.HOLD_ENDED);
    };
    $.btnHold.addEventListener('pointerup',    _stopHold);
    $.btnHold.addEventListener('pointerleave', _stopHold);
    $.btnHold.addEventListener('pointercancel',_stopHold);

    $.ptsCancel.addEventListener('click', closePassSelector);

    // Spectator reactions
    $.specReactions.querySelectorAll('.spec-react').forEach(btn => {
      btn.addEventListener('click', () => {
        if (_spectatorReactionCooldown) return;
        _spectatorReactionCooldown = true;
        setTimeout(() => { _spectatorReactionCooldown = false; }, CONFIG.SPECTATOR.REACTION_COOLDOWN_MS);
        spawnReaction(btn.dataset.emoji);
        EventBus.emit(CONFIG.EVENTS.AUDIO_TRIGGER, { type: CONFIG.AUDIO.SFX_DING });
      });
    });

    // ── Results ───────────────────────────────────────────────
    $.btnPlayAgain.addEventListener('click', () => {
      EventBus.emit('PLAY_AGAIN_REQUESTED');
    });
    $.btnExitRoom.addEventListener('click', () => {
      Network.disconnect();
      EventBus.emit('EXIT_ROOM_REQUESTED');
    });

    // ── Global controls ───────────────────────────────────────
    if ($.btnMute) {
      $.btnMute.addEventListener('click', () => {
        const muted = Audio.toggleMute();
        $.btnMute.textContent = muted ? '🔇' : '🔊';
        $.btnMute.classList.toggle('muted', muted);
      });
    }
  }

  function _showRoomPanel(which) {
    if (which === 'create') {
      $.panelCreate.classList.remove('hidden');
      $.panelJoin.classList.add('hidden');
    } else {
      $.panelCreate.classList.add('hidden');
      $.panelJoin.classList.remove('hidden');
      // Focus first code char
      setTimeout(() => $.codeChars[0]?.focus(), 50);
    }
  }

  // ── EventBus Listeners (State → UI) ──────────────────────────

  function _bindStateListeners() {
    const EV = CONFIG.EVENTS;

    // Screen changes
    EventBus.on(EV.UI_SCREEN_CHANGE, (screenName) => {
      showScreen(screenName);

      if (screenName === CONFIG.SCREENS.LOBBY)   renderLobby();
      if (screenName === CONFIG.SCREENS.GAME)    { renderGameArena(); updateHUD(); }
      if (screenName === CONFIG.SCREENS.RESULTS) showResultsScreen();
    });

    // Player updates (join, leave, ready, kick, sync)
    EventBus.on(EV.UI_UPDATE_PLAYERS, (data) => {
      const screen = State.get('screen');
      if (screen === CONFIG.SCREENS.LOBBY) {
        renderLobby();
      } else if (screen === CONFIG.SCREENS.GAME) {
        if (data?.eliminated) {
          // Re-render circle without that player
          renderGameArena();
          updateHUD();
        } else {
          _updateGameActions();
        }
      }
    });

    // Bomb updates
    EventBus.on(EV.UI_UPDATE_BOMB, (data) => {
      if (data.fraction !== undefined) {
        updateBombTimer(data.fraction, data.panicLevel ?? 0);
      }
      if (data.holderId !== undefined) {
        const prevHolder = State.get('game.previousHolder');
        if (prevHolder && data.holderId) {
          transferBombVisual(prevHolder, data.holderId);
        }
        _updateGameActions();
        updateHUD();
      }
    });

    // Panic level changed
    EventBus.on(EV.PANIC_LEVEL_CHANGED, (data) => {
      const opacities = CONFIG.PANIC_EFFECTS.TINT_OPACITY;
      setPanicTint(opacities[data.level] ?? 0);
    });

    // HOLD roulette tick → danger bar
    EventBus.on(EV.HOLD_ROULETTE_TICK, (data) => {
      updateHoldDanger(data.seconds, data.probability);
    });

    // Countdown tick
    EventBus.on(CONFIG.SERVER_EVENTS.COUNTDOWN_TICK, (data) => {
      updateCountdown(data.value);
    });

    // Bomb exploded → populate explosion screen
    EventBus.on(CONFIG.SERVER_EVENTS.BOMB_EXPLODED, (data) => {
      showExplosionScreen(data.victimId);
    });

    // Toast notifications
    EventBus.on(EV.UI_SHOW_TOAST, (data) => {
      if (data?.quiet && State.get('network.ping') < CONFIG.NETWORK.HIGH_PING_THRESHOLD_MS) return;
      showToast(data.message, data.type || 'info');
    });

    // Room error → reset setup button
    EventBus.on(CONFIG.SERVER_EVENTS.ROOM_ERROR, (data) => {
      $.btnReadySetup.disabled    = false;
      $.btnReadySetup.innerHTML   = '<span class="btn-icon">✅</span><span>I\'M READY</span>';
      _setCodeInputState('invalid');
      showToast(data.message || 'Room error', 'error');
    });

    // AFK warning
    EventBus.on(EV.AFK_TIMER_WARNING, () => {
      showToast('⚠️ Pass the bomb — auto-pass incoming!', 'warn', 2000);
      $.btnPass.classList.add('urgent');
      setTimeout(() => $.btnPass.classList.remove('urgent'), 2000);
    });

    // Network status
    EventBus.on(EV.NETWORK_DISCONNECTED, () => {
      showToast('Connection lost — reconnecting...', 'error', 5000);
      if ($.netIndicator) $.netIndicator.classList.add('active');
    });
    EventBus.on(EV.NETWORK_CONNECTED, () => {
      const screen = State.get('screen');
      if (screen !== CONFIG.SCREENS.LANDING && screen !== CONFIG.SCREENS.ROOM) {
        showToast('Reconnected!', 'success');
      }
      if ($.netIndicator) $.netIndicator.classList.remove('active');
    });
    EventBus.on(EV.NETWORK_ERROR, (data) => {
      if (data?.fatal) {
        showToast(data.message, 'error', 8000);
      }
      if ($.netIndicator) $.netIndicator.classList.remove('active');
    });
  }

  // ── Init ──────────────────────────────────────────────────────

  function init() {
    _cacheDOM();
    _initChipGroups();
    _initCodeInput();
    _initSetupScreen();
    _bindInputEvents();
    _bindStateListeners();

    // Show landing screen
    showScreen(CONFIG.SCREENS.LANDING);
  }

  // ── Public surface ────────────────────────────────────────────
  return Object.freeze({
    init,
    showScreen,
    showToast,
    renderLobby,
    renderGameArena,
    transferBombVisual,
    updateBombTimer,
    updateHUD,
    setPanicTint,
    updateCountdown,
    updateHoldDanger,
    openPassSelector,
    closePassSelector,
    showExplosionScreen,
    showResultsScreen,
    spawnReaction,
  });

})();
