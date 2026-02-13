/* ============================================
   C'EST TROP DUR - Game Logic
   SocketIO + Canvas + Game Phases
   ============================================ */

// --- Globals (roomCode, myPlayerId, isHost injected from template) ---
const socket = io({ transports: ['websocket', 'polling'] });
const canvas = document.getElementById('drawCanvas');
const ctx = canvas.getContext('2d');

let currentColor = '#000000';
let currentSize = 3;
let isEraser = false;
let isDrawing = false;
let lastX = 0, lastY = 0;
let amDrawer = false;
let amPicker = false;
let gameState = null;
let timerInterval = null;
let timerStartTime = null;
let timerDuration = 40;
let selectedWordIndex = null;
let selectedDesignatedId = null;
let drawSyncInterval = null;
let lastDrawCount = 0;

// ==================== SOCKET CONNECTION ====================

socket.on('connect', () => {
  socket.emit('join_game', { room: roomCode });
});

socket.on('game_state_updated', (state) => {
  gameState = state;
  updateUI(state);
});

// ==================== DRAW EVENTS ====================

function clog(msg) {
  socket.emit('client_log', { msg: msg });
}

socket.on('draw_event', (data) => {
  if (amDrawer) return;
  drawLine(data.x1, data.y1, data.x2, data.y2, data.color, data.size);
  lastDrawCount++;
});

socket.on('draw_data_sync', (data) => {
  const drawData = data.draw_data || [];
  if (amDrawer) return;
  if (drawData.length > lastDrawCount) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const d of drawData) {
      drawLine(d.x1, d.y1, d.x2, d.y2, d.color, d.size);
    }
    lastDrawCount = drawData.length;
  }
});

socket.on('clear_canvas', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  lastDrawCount = 0;
});

socket.on('chat_message', (data) => {
  addChatMessage(data.player_name, data.text, data.correct, data.pending, data.guesser_id, data.system);
});

// ==================== UI UPDATE ====================

function updateUI(state) {
  amDrawer = (state.current_drawer_id === myPlayerId);
  amPicker = (state.current_picker_id === myPlayerId);
  const isDrawingPhase = state.phase === 'drawing_player2' || state.phase === 'drawing_player1';

  // Round info
  document.getElementById('roundInfo').textContent = `${state.round}/${state.total_rounds}`;

  // Phase info
  const phaseInfo = document.getElementById('phaseInfo');
  if (isDrawingPhase) {
    phaseInfo.textContent = amDrawer ? 'A vous de dessiner !' :
      `${state.current_drawer_name} dessine`;
  } else if (state.phase === 'choosing') {
    phaseInfo.textContent = amPicker ? 'Choisissez un mot' :
      `${state.current_picker_name} choisit...`;
  } else {
    phaseInfo.textContent = '';
  }

  // Word display
  const wordDisplay = document.getElementById('wordDisplay');
  if ((amDrawer || amPicker) && state.current_word) {
    wordDisplay.textContent = state.current_word;
  } else if (state.word_hint) {
    wordDisplay.textContent = state.word_hint;
  } else if (state.current_word) {
    wordDisplay.textContent = state.current_word;
  } else {
    wordDisplay.textContent = '';
  }

  // Draw sync polling for non-drawers
  if (!amDrawer && isDrawingPhase) {
    if (!drawSyncInterval) {
      lastDrawCount = 0;
      socket.emit('request_draw_data', { room: roomCode });
      drawSyncInterval = setInterval(() => {
        socket.emit('request_draw_data', { room: roomCode });
      }, 3000);
    }
  } else {
    if (drawSyncInterval) {
      clearInterval(drawSyncInterval);
      drawSyncInterval = null;
    }
    if (state.phase === 'choosing') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      lastDrawCount = 0;
    }
  }

  // Timer
  updateTimer(state.remaining_time);

  // Tools visibility
  const toolsEl = document.getElementById('drawTools');
  if (amDrawer && isDrawingPhase) {
    toolsEl.classList.remove('hidden');
  } else {
    toolsEl.classList.add('hidden');
  }

  // Canvas interaction
  if (amDrawer && isDrawingPhase) {
    canvas.classList.add('can-draw');
    canvas.style.pointerEvents = 'auto';
  } else {
    canvas.classList.remove('can-draw');
    canvas.style.pointerEvents = 'none';
  }

  // Chat input
  const chatInput = document.getElementById('chatInput');
  const chatSend = document.getElementById('chatSend');
  if (amDrawer || amPicker || !isDrawingPhase) {
    chatInput.disabled = true;
    chatSend.disabled = true;
    if (amDrawer) chatInput.placeholder = 'Vous dessinez...';
    else if (amPicker) chatInput.placeholder = 'Validez les reponses...';
    else chatInput.placeholder = 'Tapez votre reponse...';
  } else {
    chatInput.disabled = false;
    chatSend.disabled = false;
    chatInput.placeholder = 'Tapez votre reponse...';
  }

  // Scores
  updateScores(state);

  // Update validation buttons
  if (state.pending_guesses && (amPicker || amDrawer)) {
    document.querySelectorAll('.chat-msg[data-guesser-id]').forEach(msg => {
      const gid = msg.dataset.guesserId;
      const pg = state.pending_guesses[gid];
      const btn = msg.querySelector('.validate-btn');
      if (!btn) return;
      if (!pg) {
        btn.remove();
      } else {
        const myApproval = amPicker ? pg.picker_approved : pg.drawer_approved;
        if (myApproval) {
          btn.classList.add('validated');
          btn.textContent = 'Valide';
          btn.onclick = null;
        }
      }
    });
  }

  // Overlays
  hideAllOverlays();

  if (state.phase === 'choosing') {
    if (amPicker && state.card_choices) {
      showChoosingOverlay(state.card_choices, state.designable_players);
    } else {
      showWaitingChooseOverlay(state.current_picker_name);
    }
  } else if (state.phase === 'round_end') {
    showRoundEndOverlay(state.current_word, state);
  } else if (state.phase === 'game_over') {
    showGameOverOverlay(state);
  }
}

// ==================== TIMER ====================

const TOTAL_TIME = 40;
const TIMER_CIRCUMFERENCE = 282.7;

function updateTimer(remaining) {
  const timerText = document.getElementById('timerText');
  const timerProgress = document.getElementById('timerProgress');
  const timerContainer = document.getElementById('timerContainer');

  if (remaining > 0) {
    timerDuration = remaining;
    timerStartTime = Date.now();

    clearInterval(timerInterval);
    renderTimer(remaining);

    timerInterval = setInterval(() => {
      const elapsed = (Date.now() - timerStartTime) / 1000;
      const t = Math.max(0, Math.round(timerDuration - elapsed));

      renderTimer(t);

      if (t <= 0) {
        clearInterval(timerInterval);
        socket.emit('timer_expired', { room: roomCode });
      }
    }, 250);
  } else {
    timerText.textContent = '--';
    timerProgress.style.strokeDashoffset = '0';
    timerContainer.classList.remove('warning', 'caution');
    clearInterval(timerInterval);
  }
}

function renderTimer(t) {
  const timerText = document.getElementById('timerText');
  const timerProgress = document.getElementById('timerProgress');
  const timerContainer = document.getElementById('timerContainer');

  const mins = Math.floor(t / 60);
  const secs = t % 60;
  timerText.textContent = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}`;

  // Progress: 0 = full circle, CIRCUMFERENCE = empty
  const fraction = 1 - (t / TOTAL_TIME);
  timerProgress.style.strokeDashoffset = (fraction * TIMER_CIRCUMFERENCE).toString();

  // Color states
  timerContainer.classList.remove('warning', 'caution');
  if (t <= 10) {
    timerContainer.classList.add('warning');
  } else if (t <= 20) {
    timerContainer.classList.add('caution');
  }
}

// ==================== SCORES ====================

const AVATAR_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'
];

function updateScores(state) {
  const panel = document.getElementById('scoresPanel');
  const isDrawingPhase = state.phase === 'drawing_player2' || state.phase === 'drawing_player1';

  const sorted = Object.entries(state.scores)
    .map(([pid, score]) => ({
      pid, score,
      name: state.player_names[pid] || '???',
      isDrawer: pid === state.current_drawer_id && isDrawingPhase,
      isPicker: pid === state.current_picker_id
    }))
    .sort((a, b) => b.score - a.score);

  panel.innerHTML = sorted.map((p, i) => {
    const initial = p.name.charAt(0).toUpperCase();
    const colorIdx = Object.keys(state.player_names).indexOf(p.pid) % AVATAR_COLORS.length;
    const avatarBg = AVATAR_COLORS[colorIdx];
    let cardClass = 'player-card';
    let badgeHtml = '';

    if (p.isDrawer) {
      cardClass += ' is-drawer';
      badgeHtml = '<span class="player-badge"><span class="badge badge-gold">Dessine</span></span>';
    } else if (p.isPicker && isDrawingPhase) {
      cardClass += ' is-picker';
      badgeHtml = '<span class="player-badge"><span class="badge badge-green">Pioche</span></span>';
    }

    return `<div class="${cardClass}">
      <div class="player-avatar" style="background:${avatarBg}">${initial}</div>
      <div class="player-info">
        <div class="player-name">${p.name}</div>
        <div class="player-score">${p.score} pts</div>
      </div>
      ${badgeHtml}
    </div>`;
  }).join('');
}

// ==================== OVERLAYS ====================

function hideAllOverlays() {
  document.querySelectorAll('.overlay').forEach(o => o.classList.add('hidden'));
}

function showChoosingOverlay(choices, designablePlayers) {
  selectedWordIndex = null;
  selectedDesignatedId = null;
  const overlay = document.getElementById('choosingOverlay');
  overlay.classList.remove('hidden');

  const container = document.getElementById('cardChoices');
  container.innerHTML = choices.map((word, i) =>
    `<div class="card-choice" data-word-index="${i}" onclick="selectWord(this, ${i})">${word}</div>`
  ).join('');

  const designateSection = document.getElementById('designateSection');
  const playerContainer = document.getElementById('playerChoices');
  if (designablePlayers && designablePlayers.length > 0) {
    playerContainer.innerHTML = designablePlayers.map(p =>
      `<div class="card-choice" data-player-id="${p.id}" onclick="selectPlayer(this, '${p.id}')">${p.name}</div>`
    ).join('');
  }
  designateSection.classList.add('hidden');
  document.getElementById('confirmChoiceBtn').classList.add('hidden');
}

function selectWord(el, index) {
  selectedWordIndex = index;
  document.querySelectorAll('#cardChoices .card-choice').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('designateSection').classList.remove('hidden');
  updateConfirmBtn();
}

function selectPlayer(el, playerId) {
  selectedDesignatedId = playerId;
  document.querySelectorAll('#playerChoices .card-choice').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  updateConfirmBtn();
}

function updateConfirmBtn() {
  const btn = document.getElementById('confirmChoiceBtn');
  if (selectedWordIndex !== null && selectedDesignatedId !== null) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

function confirmChoice() {
  if (selectedWordIndex !== null && selectedDesignatedId !== null) {
    socket.emit('choose_word', {
      room: roomCode,
      index: selectedWordIndex,
      designated_id: selectedDesignatedId
    });
  }
}

function showWaitingChooseOverlay(pickerName) {
  const overlay = document.getElementById('waitingChooseOverlay');
  overlay.classList.remove('hidden');
  document.getElementById('waitingChooseText').textContent =
    `${pickerName} choisit un mot et designe un joueur...`;
}

function showRoundEndOverlay(word, state) {
  const overlay = document.getElementById('roundEndOverlay');
  overlay.classList.remove('hidden');
  document.getElementById('revealWord').textContent = word || '???';

  const msg = document.getElementById('roundResultMsg');
  if (state.point_winner_name) {
    if (state.guessed) {
      msg.textContent = `${state.point_winner_name} a fait deviner le mot et gagne 1 point !`;
    } else {
      msg.textContent = `Personne n'a devine ! ${state.point_winner_name} gagne 1 point.`;
    }
    msg.style.color = 'var(--accent-green)';
  } else {
    msg.textContent = '';
  }

  if (isHost) {
    document.getElementById('nextTurnBtn').classList.remove('hidden');
    document.getElementById('waitingNextMsg').classList.add('hidden');
  } else {
    document.getElementById('nextTurnBtn').classList.add('hidden');
    document.getElementById('waitingNextMsg').classList.remove('hidden');
  }
}

function showGameOverOverlay(state) {
  const overlay = document.getElementById('gameOverOverlay');
  overlay.classList.remove('hidden');
  document.getElementById('revealWordFinal').textContent = state.current_word || '';

  const sorted = Object.entries(state.scores)
    .map(([pid, score]) => ({ name: state.player_names[pid], score }))
    .sort((a, b) => b.score - a.score);

  const medals = ['&#127942;', '&#129352;', '&#129353;'];
  const ranks = ['1er', '2eme', '3eme'];

  document.getElementById('podium').innerHTML = sorted.map((p, i) => {
    const medal = medals[i] || '';
    const rank = ranks[i] || `${i + 1}eme`;
    return `<div class="podium-item">
      <span class="podium-medal">${medal}</span>
      <span>${rank} - ${p.name}</span>
      <strong>${p.score} pts</strong>
    </div>`;
  }).join('');
}

// ==================== ACTIONS ====================

function requestNextTurn() {
  socket.emit('request_next_turn', { room: roomCode });
}

function sendGuess() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('guess', { room: roomCode, text: text });
  input.value = '';
}

document.getElementById('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendGuess();
});

// ==================== CHAT MESSAGES ====================

function addChatMessage(name, text, correct, pending, guesserId, system) {
  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');

  if (system) {
    div.className = 'chat-msg msg-system animate-slide-right';
    div.textContent = text;
  } else if (correct) {
    div.className = 'chat-msg msg-correct animate-slide-right';
    div.innerHTML = `<span class="correct-star">&#11088;</span> ${name} a devine le mot !`;
  } else {
    div.className = 'chat-msg animate-slide-right';
    if (pending) {
      div.classList.add('msg-pending');
    }
    div.innerHTML = `<span class="msg-author">${name}:</span> ${text}`;

    if (pending && guesserId && (amPicker || amDrawer)) {
      div.dataset.guesserId = guesserId;
      const btn = document.createElement('button');
      btn.className = 'validate-btn';
      btn.textContent = 'Valider';
      btn.onclick = () => validateGuess(guesserId, btn);
      div.appendChild(btn);

      const badge = document.createElement('span');
      badge.className = 'pending-badge';
      badge.textContent = 'En attente...';
      div.appendChild(badge);
    }
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function validateGuess(guesserId, btn) {
  socket.emit('validate_guess', { room: roomCode, guesser_id: guesserId });
  btn.classList.add('validated');
  btn.textContent = 'Valide';
  btn.onclick = null;
}

// ==================== CANVAS DRAWING ====================

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  if (e.touches) {
    return {
      x: (e.touches[0].clientX - rect.left) * scaleX,
      y: (e.touches[0].clientY - rect.top) * scaleY
    };
  }
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

function startDrawing(e) {
  if (!amDrawer) return;
  e.preventDefault();
  isDrawing = true;
  const coords = getCanvasCoords(e);
  lastX = coords.x;
  lastY = coords.y;
}

function draw(e) {
  if (!isDrawing || !amDrawer) return;
  e.preventDefault();
  const coords = getCanvasCoords(e);
  const color = isEraser ? '#ffffff' : currentColor;
  const size = isEraser ? currentSize * 3 : currentSize;

  drawLine(lastX, lastY, coords.x, coords.y, color, size);
  socket.emit('draw', {
    room: roomCode,
    draw_event: { x1: lastX, y1: lastY, x2: coords.x, y2: coords.y, color: color, size: size }
  });
  lastX = coords.x;
  lastY = coords.y;
}

function stopDrawing() {
  isDrawing = false;
}

function drawLine(x1, y1, x2, y2, color, size) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

// Mouse events
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);
// Touch events
canvas.addEventListener('touchstart', startDrawing, { passive: false });
canvas.addEventListener('touchmove', draw, { passive: false });
canvas.addEventListener('touchend', stopDrawing);

// ==================== TOOL CONTROLS ====================

// Color buttons
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentColor = btn.dataset.color;
    isEraser = false;
    document.getElementById('eraserBtn').classList.remove('active');
  });
});

// Size buttons
document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSize = parseInt(btn.dataset.size);
  });
});

// Eraser
document.getElementById('eraserBtn').addEventListener('click', function () {
  isEraser = !isEraser;
  this.classList.toggle('active');
  if (isEraser) {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
  }
});

// Clear canvas
document.getElementById('clearBtn').addEventListener('click', () => {
  if (confirm('Effacer tout le dessin ?')) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    socket.emit('clear_canvas', { room: roomCode });
  }
});

// ==================== VOICE CHAT ====================

let localStream = null;
let peerConnections = {};
let isMuted = true;
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Restore voice state from lobby
if (sessionStorage.getItem('voiceMicEnabled') === 'true') {
  setTimeout(() => startVoice(), 500);
}

async function toggleVoice() {
  if (isMuted) await startVoice();
  else stopVoice();
}

async function startVoice() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const btn = document.getElementById('voiceMiniBtn');
    const label = document.getElementById('voiceLabel');
    btn.classList.add('active');
    label.textContent = 'Micro ON';
    isMuted = false;
    socket.emit('join_voice', { room: roomCode });
  } catch (err) {
    alert("Impossible d'acceder au microphone.");
  }
}

function stopVoice() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  const btn = document.getElementById('voiceMiniBtn');
  const label = document.getElementById('voiceLabel');
  btn.classList.remove('active');
  label.textContent = 'Micro OFF';
  isMuted = true;
  socket.emit('leave_voice', { room: roomCode });
}

function createPeerConnection(remoteId) {
  const pc = new RTCPeerConnection(iceConfig);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = (e) => { const a = new Audio(); a.srcObject = e.streams[0]; a.play(); };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice_candidate', { room: roomCode, candidate: e.candidate });
  };
  peerConnections[remoteId] = pc;
  return pc;
}

socket.on('user_joined', async (data) => {
  if (!localStream) return;
  const pc = createPeerConnection(data.player_id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { room: roomCode, offer: offer });
});

socket.on('offer', async (data) => {
  if (!localStream) return;
  const pc = createPeerConnection(data.from);
  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { room: roomCode, answer: answer });
});

socket.on('answer', async (data) => {
  const pc = peerConnections[data.from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
});

socket.on('ice_candidate', async (data) => {
  const pc = peerConnections[data.from] || Object.values(peerConnections)[0];
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
});

socket.on('user_left', (data) => {
  if (peerConnections[data.player_id]) {
    peerConnections[data.player_id].close();
    delete peerConnections[data.player_id];
  }
});

window.addEventListener('beforeunload', () => stopVoice());
