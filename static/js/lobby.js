/* ============================================
   C'EST TROP DUR - Lobby Logic
   ============================================ */

const AVATAR_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'
];

const socket = io({ transports: ['polling'] });

socket.on('connect', () => {
  socket.emit('join_lobby', { room: roomCode });
});

socket.on('lobby_updated', (data) => {
  document.getElementById('currentPlayers').textContent = data.players.length;

  const list = document.getElementById('playersList');
  list.innerHTML = data.players.map((p, i) => {
    const initial = p.name.charAt(0).toUpperCase();
    const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
    return `<div class="player-item">
      <div class="player-avatar">
        <div class="player-avatar-initial" style="background:${color}">${initial}</div>
      </div>
      <div class="player-info">
        <div class="player-name">${p.name}</div>
      </div>
      ${p.id === data.host_id ? '<div class="player-badge">Hote</div>' : ''}
    </div>`;
  }).join('');

  if (isHost) {
    const startBtn = document.getElementById('startBtn');
    const waitingMsg = document.getElementById('waitingMsg');
    if (data.players.length >= 3) {
      startBtn.disabled = false;
      if (waitingMsg) waitingMsg.style.display = 'none';
    } else {
      startBtn.disabled = true;
      if (waitingMsg) waitingMsg.style.display = 'block';
    }
  }
  if (data.started) {
    sessionStorage.setItem('voiceMicEnabled', (!isMuted).toString());
    window.location.href = `/game/${roomCode}`;
  }
});

socket.on('game_started', () => {
  sessionStorage.setItem('voiceMicEnabled', (!isMuted).toString());
  window.location.href = `/game/${roomCode}`;
});

function startGame() {
  fetch(`/lobby/${roomCode}/start`, { method: 'POST' })
    .then(res => { if (!res.ok) alert('Impossible de demarrer (il faut au moins 3 joueurs)'); })
    .catch(() => alert('Erreur'));
}

// ==================== Voice Chat ====================
let localStream = null;
let peerConnections = {};
let isMuted = true;
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

async function toggleVoice() {
  if (isMuted) { await startVoice(); } else { stopVoice(); }
}

async function startVoice() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    document.getElementById('voiceBtn').textContent = 'Couper le micro';
    document.getElementById('voiceBtn').className = 'audio-btn active';
    document.getElementById('voiceStatus').textContent = 'Chat vocal active';
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
  document.getElementById('voiceBtn').textContent = 'Activer le micro';
  document.getElementById('voiceBtn').className = 'audio-btn';
  document.getElementById('voiceStatus').textContent = 'Chat vocal desactive';
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
