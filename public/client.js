// === client.js ===
const socket = io(window.location.origin);

const messages   = document.getElementById('messages');
const form       = document.getElementById('composer');
const input      = document.getElementById('message');
const nextBtn    = document.getElementById('next');
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

const myVideo        = document.getElementById('myVideo');
const strangerVideo  = document.getElementById('strangerVideo');

const muteBtn   = document.getElementById('muteBtn');
const camBtn    = document.getElementById('camBtn');
const endBtn    = document.getElementById('endBtn');
const modeToggle= document.getElementById('modeToggle');

/* Consent UI */
const consentModal   = document.getElementById('consentModal');
const consentAccept  = document.getElementById('consentAccept');
const consentDecline = document.getElementById('consentDecline');
const requestToast   = document.getElementById('requestToast');
const toastDismiss   = document.getElementById('toastDismiss');

let pc;
let localStream;
let remoteStream;
let partnerId = null;
let role = null;
let typingTimeout;

let videoMode = false;
let partnerVideoMode = false;

let hasConsentedVideo = false;
let iAmReady = false;
let partnerReady = false;

let isPolite = false;
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;
let offerStarted = false;

const pendingIce = [];
const pendingDescriptions = [];

let audioEnabled = false;
let videoTrackEnabled = false;

/* ---------- Status / messages ---------- */
function setStatus(state, text) {
  statusDot.className = "dot";
  if (state) statusDot.classList.add(state);
  statusText.textContent = text;
}

function addSystem(text, timeout = 5000) {
  const div = document.createElement('div');
  div.className = 'system';
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  if (timeout) {
    setTimeout(() => {
      div.classList.add('fade-out');
      setTimeout(() => div.remove(), 1000);
    }, timeout);
  }
}

function addMsg(text, me = false) {
  const div = document.createElement('div');
  div.className = 'msg' + (me ? ' me' : '');
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

/* ---------- WebRTC helpers ---------- */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // ⚠️ Add TURN in production
];

async function ensureLocalStream() {
  if (!videoMode) return null;
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

    // 🔇 disable both tracks at start
    localStream.getAudioTracks().forEach(t => t.enabled = false);
    localStream.getVideoTracks().forEach(t => t.enabled = false);

    myVideo.srcObject = localStream;
  } catch (err) {
    console.error("❌ getUserMedia error", err);
    addSystem("Could not access camera/mic");
  }
  return localStream;
}

function attachLocalTracksIfNeeded() {
  if (!pc || !localStream) return;
  const senders = pc.getSenders();
  const audioTrack = localStream.getAudioTracks()[0] || null;
  const videoTrack = localStream.getVideoTracks()[0] || null;

  let audioSender = senders.find(s => s.track && s.track.kind === 'audio');
  let videoSender = senders.find(s => s.track && s.track.kind === 'video');

  if (audioTrack) {
    if (audioSender) audioSender.replaceTrack(audioTrack);
    else pc.addTrack(audioTrack, localStream);
  }
  if (videoTrack) {
    if (videoSender) videoSender.replaceTrack(videoTrack);
    else pc.addTrack(videoTrack, localStream);
  }
}

function createPeerConnection() {
  if (!videoMode || !hasConsentedVideo) return;
  if (pc) pc.close();

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Remote stream
  remoteStream = new MediaStream();
  strangerVideo.srcObject = remoteStream;

  pc.ontrack = (e) => {
    console.log("🎥 ontrack:", e.track.kind, "id=", e.track.id);
    remoteStream.addTrack(e.track);
    strangerVideo.classList.add("ready");
    strangerVideo.play().catch(() => {});
  };

  pc.onnegotiationneeded = async () => {
    if (!hasConsentedVideo || !iAmReady || !partnerReady || role !== "caller") return;
    if (makingOffer || offerStarted) return;
    try {
      makingOffer = true;
      offerStarted = true;
      console.log("⚙️ onnegotiationneeded -> creating offer");
      await pc.setLocalDescription(await pc.createOffer());
      emitSignal({ description: pc.localDescription });
    } catch (e) {
      offerStarted = false;
      console.error("onnegotiationneeded error", e);
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && partnerId) emitSignal({ candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log("🔗 PC state:", pc.connectionState);
    if (['failed','disconnected'].includes(pc.connectionState)) {
      addSystem(`Connection ${pc.connectionState}.`);
    }
  };
  pc.oniceconnectionstatechange = () => {
    console.log("🧊 ICE state:", pc.iceConnectionState);
  };
}

/* ---------- Core Negotiation ---------- */
async function processPendingWhenReady() {
  if (!(iAmReady && partnerReady && pc)) return;

  while (pendingDescriptions.length) {
    const d = pendingDescriptions.shift();
    const readyForOffer = pc.signalingState === 'stable' || isSettingRemoteAnswerPending;
    const offerCollision = d.type === 'offer' && (!readyForOffer || makingOffer);

    ignoreOffer = !isPolite && offerCollision;
    if (ignoreOffer) {
      console.warn("🙈 Ignoring offer (impolite glare)");
      continue;
    }

    if (d.type === 'offer') {
      if (!pc) {
        console.log("⚙️ Creating PC on offer (callee)");
        createPeerConnection();
        await ensureLocalStream();
        attachLocalTracksIfNeeded();
        iAmReady = true;
      }

      if (offerCollision) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(d),
        ]);
      } else {
        await pc.setRemoteDescription(d);
      }

      await ensureLocalStream();
      attachLocalTracksIfNeeded();

      await pc.setLocalDescription(await pc.createAnswer());
      emitSignal({ description: pc.localDescription });
    } else {
      isSettingRemoteAnswerPending = true;
      await pc.setRemoteDescription(d);
      isSettingRemoteAnswerPending = false;
    }
  }

  while (pendingIce.length) {
    const c = pendingIce.shift();
    try { await pc.addIceCandidate(c); } catch (e) { console.warn("ICE add failed", e); }
  }

  if (role === "caller" && pc.signalingState === "stable" && !makingOffer && !offerStarted) {
    try {
      makingOffer = true;
      offerStarted = true;
      console.log("🚀 starting initial offer (caller, both ready)");
      await pc.setLocalDescription(await pc.createOffer());
      emitSignal({ description: pc.localDescription });
    } catch (e) {
      offerStarted = false;
      console.error("initial-offer error", e);
    } finally {
      makingOffer = false;
    }
  }
}

function emitSignal(payload) {
  socket.emit('signal', { ...payload, to: partnerId });
}

/* ---------- Consent UI Helpers ---------- */
function showConsentModal() { consentModal.classList.remove('hidden'); consentAccept.focus(); }
function hideConsentModal() { consentModal.classList.add('hidden'); }
function showRequestToast() { requestToast.classList.remove('hidden'); }
function hideRequestToast() { requestToast.classList.add('hidden'); }

/* ---------- Socket events (core) ---------- */
socket.on('connect', () => setStatus('online', 'Connected. Finding a stranger…'));
socket.on('disconnect', () => setStatus('', 'Disconnected. Reconnecting…'));

socket.on('queue:waiting', () => {
  setStatus('waiting', 'Waiting for a stranger…');
  addSystem('Looking for a stranger…');
});

socket.on('chat:start', (data) => {
  partnerId = data?.partnerId;
  role = data?.role;
  partnerVideoMode = !!data?.partnerVideoMode;
  isPolite = role === 'callee';

  console.log("🤝 Paired with", partnerId, "role:", role, "partnerVideoMode:", partnerVideoMode);

  setStatus('chatting', 'You are now chatting');
  addSystem('You are now chatting with a stranger. Say hi!');

  hasConsentedVideo = false;
  iAmReady = false;
  partnerReady = false;
  offerStarted = false;
  pendingIce.length = 0;
  pendingDescriptions.length = 0;

  videoMode = false;
  applyModeUI();
  resetControlsUI();
});

socket.on('chat:ended', () => {
  teardownToText();
  addSystem('Stranger left or you skipped.');
});

socket.on('chat:message', ({ text }) => addMsg(text, false));
socket.on('chat:typing', (isTyping) => {
  let t = document.getElementById('typing');
  if (isTyping) {
    if (!t) {
      t = document.createElement('div');
      t.id = 'typing';
      t.className = 'system';
      t.textContent = 'Stranger is typing…';
      messages.appendChild(t);
    }
  } else if (t) t.remove();
  messages.scrollTop = messages.scrollHeight;
});

socket.on('partner:mode', ({ videoMode: vm }) => {
  partnerVideoMode = !!vm;
  addSystem(`Stranger switched to ${partnerVideoMode ? 'Video' : 'Text'} mode.`);
});


/* ---------- Consent flow (custom UI) ---------- */
function requestVideo() {
  socket.emit("video:request");
  addSystem("You requested to start video. Waiting for stranger’s response…");
  showRequestToast();
}
toastDismiss?.addEventListener('click', hideRequestToast);

socket.on("video:request", () => { showConsentModal(); });

consentAccept?.addEventListener('click', () => {
  hideConsentModal();
  socket.emit("video:accept");
});
consentDecline?.addEventListener('click', () => {
  hideConsentModal();
  socket.emit("video:decline");
  addSystem("You declined the video request.");
});

socket.on("video:accept", async () => {
  hideRequestToast();

  videoMode = true;
  hasConsentedVideo = true;
  applyModeUI();
  socket.emit('mode:changed', { videoMode: true });

  await ensureLocalStream();
  createPeerConnection();
  attachLocalTracksIfNeeded();

  iAmReady = true;
  socket.emit("video:ready");
  addSystem("Preparing video…");
  await processPendingWhenReady();
});

socket.on("video:decline", () => {
  hideRequestToast();
  addSystem("Stranger declined the video request.");
  pendingDescriptions.length = 0;
  pendingIce.length = 0;
  iAmReady = false;
  partnerReady = false;
});

socket.on("video:ready", async () => {
  partnerReady = true;
  console.log("🎬 Partner ready");
  await processPendingWhenReady();
});

/* ---------- Signaling ---------- */
socket.on('signal', async ({ description, candidate, from }) => {
  try {
    if (description) {
      console.log("📨 SDP from", from, "type:", description.type);
      pendingDescriptions.push(description);
    } else if (candidate) {
      const ice = candidate && candidate.candidate ? new RTCIceCandidate(candidate) : candidate;
      pendingIce.push(ice);
    }
    await processPendingWhenReady();
  } catch (err) {
    console.error("❌ signal handling error", err);
  }
});

/* ---------- Form ---------- */
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  // ---- COMMANDS: handle before normal chat ----
// ---- COMMANDS: handle before normal chat ----
if (text.startsWith("/tictactoe")) {
  console.log("📣 Command: /tictactoe -> emit game:init");
  socket.emit("game:init");
  addSystem("🎮 Starting Tic Tac Toe game…");
  input.value = '';
  return;
}

if (text.startsWith("/connect4")) {
  console.log("📣 Command: /connect4 -> emit connect4:init");
  socket.emit("connect4:init");
  addSystem("🟡 Starting Connect Four game…");
  input.value = '';
  return;
}

 // ---- normal chat ----
  addMsg(text, true);
  socket.emit('chat:message', text);
  input.value = '';
  socket.emit('chat:typing', false);
});

/* ---------- Typing ---------- */
input.addEventListener('input', () => {
  socket.emit('chat:typing', true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('chat:typing', false), 1000);
});

/* ---------- Next ---------- */
nextBtn.addEventListener('click', () => {
  addSystem('Searching for a new stranger…');
  socket.emit('chat:next');
  teardownToText();
});

/* ---------- Controls ---------- */
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    if (!localStream) return;
    audioEnabled = !audioEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);

    document.getElementById("micOnIcon").classList.toggle("hidden", !audioEnabled);
    document.getElementById("micOffIcon").classList.toggle("hidden", audioEnabled);
  });
}

if (camBtn) {
  camBtn.addEventListener('click', () => {
    if (!localStream) return;
    videoTrackEnabled = !videoTrackEnabled;
    localStream.getVideoTracks().forEach(t => t.enabled = videoTrackEnabled);

    document.getElementById("camOnIcon").classList.toggle("hidden", !videoTrackEnabled);
    document.getElementById("camOffIcon").classList.toggle("hidden", videoTrackEnabled);
  });
}

if (endBtn) {
  endBtn.addEventListener('click', () => {
    socket.emit('chat:next');
    addSystem('You left the chat. Searching for a new stranger...');
    teardownToText();
  });
}

/* ---------- Mode Toggle & UI ---------- */
function applyModeUI() {
  const chatArea = document.getElementById("chat-area");
  const videoArea = document.getElementById("video-area");

  if (videoMode) {
    chatArea.classList.remove("active");
    videoArea.classList.add("active");

    document.getElementById("videoIcon").classList.add("hidden");
    document.getElementById("chatIcon").classList.remove("hidden");
    modeToggle.setAttribute("title", "Switch to Chat");

  } else {
    videoArea.classList.remove("active");
    chatArea.classList.add("active");

    document.getElementById("chatIcon").classList.add("hidden");
    document.getElementById("videoIcon").classList.remove("hidden");
    modeToggle.setAttribute("title", "Switch to Video");

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }
    strangerVideo.srcObject = null;

    pendingIce.length = 0;
    pendingDescriptions.length = 0;
    makingOffer = false;
    ignoreOffer = false;
    isSettingRemoteAnswerPending = false;
    hasConsentedVideo = false;
    iAmReady = false;
    partnerReady = false;
    offerStarted = false;

    // 🔄 reset UI state
    resetControlsUI();
  }
}

// default UI = text
applyModeUI();

if (modeToggle) {
  modeToggle.addEventListener("click", async () => {
    if (!videoMode) {
      requestVideo();
    } else {
      videoMode = false;
      applyModeUI();
      socket.emit('mode:changed', { videoMode: false });
    }
  });
}

/* ---------- Helpers ---------- */
function teardownToText() {
  addSystem('Stranger left or you skipped.');
  setStatus('waiting', 'Stranger left. Finding a new one…');
  hideConsentModal();
  hideRequestToast();
  videoMode = false;
  applyModeUI();
}

function resetControlsUI() {
  audioEnabled = false;
  videoTrackEnabled = false;

  document.getElementById("micOnIcon").classList.add("hidden");
  document.getElementById("micOffIcon").classList.remove("hidden");

  document.getElementById("camOnIcon").classList.add("hidden");
  document.getElementById("camOffIcon").classList.remove("hidden");
}


/* ---------- GAME: Tic Tac Toe ---------- */
let tttBoard = Array(9).fill(null);
let mySymbol = 'X';
let isMyTurn = false;
let currentGameWrapper = null;
let gameOver = false;

socket.on("game:error", ({ message }) => {
  console.warn("game:error", message);
  addSystem(`⚠️ Game error: ${message}`);
});

socket.on("game:start", ({ starter }) => {
  addSystem("🎮 Tic Tac Toe started!");
  tttBoard = Array(9).fill(null);
  mySymbol = starter ? 'X' : 'O';
  isMyTurn = !!starter;
  gameOver = false; // ✅ reset gameOver
  renderTicTacToe();
  updateTttStatus();
});


socket.on("game:move", ({ index, symbol }) => {
  console.log("game:move received", index, symbol);
  if (tttBoard[index]) return;
  tttBoard[index] = symbol;
  if (currentGameWrapper) {
    const cell = currentGameWrapper.querySelector(`.cell[data-idx="${index}"]`);
    if (cell) cell.textContent = symbol;
  }
  isMyTurn = symbol !== mySymbol;
  checkWinner();
  updateTttStatus();
});

function renderTicTacToe() {
  if (currentGameWrapper) currentGameWrapper.remove();

  const wrapper = document.createElement('div');
  wrapper.className = 'game-console';
  wrapper.innerHTML = `
    <div class="tictactoe">
      <h4>🎮 Tic Tac Toe</h4>
      <div class="board">
        ${Array(9).fill().map((_, i) => `<div class="cell" data-idx="${i}"></div>`).join('')}
      </div>
      <p id="tttStatus"></p>
      <button id="tttResetBtn" class="util-btn">Play again</button>
    </div>
  `;
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
  currentGameWrapper = wrapper;

  const cells = wrapper.querySelectorAll('.cell');
  cells.forEach((cell) => {
    cell.textContent = '';
    cell.style.pointerEvents = '';
    cell.addEventListener('click', () => {
      const idx = parseInt(cell.dataset.idx, 10);
      if (!isMyTurn || tttBoard[idx]) return;
      tttBoard[idx] = mySymbol;
      cell.textContent = mySymbol;
      socket.emit("game:move", { index: idx, symbol: mySymbol });
      isMyTurn = false;
      checkWinner();
      updateTttStatus();
    });
  });

  const resetBtn = wrapper.querySelector('#tttResetBtn');
  resetBtn.addEventListener('click', () => {
    socket.emit("game:init");
    addSystem("🎮 Restarting Tic Tac Toe…");
  });
}

function updateTttStatus(textOverride = null) {
  if (!currentGameWrapper) return;
  const status = currentGameWrapper.querySelector('#tttStatus');
  if (!status) return;

  if (textOverride !== null) {
    status.textContent = textOverride;
    return;
  }

  if (gameOver) return; // prevent updates after game ends

  status.textContent = isMyTurn
    ? `Your turn (${mySymbol})`
    : `Waiting for opponent…`;
}

function checkWinner() {
  const wins = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];

  for (let w of wins) {
    const [a,b,c] = w;
    if (tttBoard[a] && tttBoard[a] === tttBoard[b] && tttBoard[a] === tttBoard[c]) {
      const winner = tttBoard[a];
      gameOver = true;

      // Highlight winning cells
      if (currentGameWrapper) {
        const cells = currentGameWrapper.querySelectorAll('.cell');
        [a, b, c].forEach(idx => cells[idx].classList.add('win'));
      }

      // Disable clicks
      if (currentGameWrapper)
        currentGameWrapper.querySelectorAll('.cell').forEach(c => (c.style.pointerEvents = 'none'));

      // ✅ Only show below the board — no system message
      updateTttStatus(`${winner} wins!🏆`);
      return;
    }
  }

  // Draw condition
  if (tttBoard.every(x => x !== null)) {
    gameOver = true;
    updateTttStatus("🤝 It's a draw!");
  }
}

/* ---------- GAME: Connect Four ---------- */
let c4Board = Array.from({ length: 6 }, () => Array(7).fill(null));
let c4MySymbol = '🔴';
let c4IsMyTurn = false;
let c4CurrentWrapper = null;
let c4GameOver = false;

socket.on("connect4:error", ({ message }) => {
  console.warn("connect4:error", message);
  addSystem(`⚠️ Connect Four error: ${message}`);
});

socket.on("connect4:start", ({ starter }) => {
  addSystem("🟡 Connect Four started!");
  c4Board = Array.from({ length: 6 }, () => Array(7).fill(null));
  c4MySymbol = starter ? '🔴' : '🟡';
  c4IsMyTurn = !!starter;
  c4GameOver = false;
  renderConnectFour();
  updateC4Status();
});

socket.on("connect4:move", ({ col, symbol }) => {
  if (c4GameOver) return;
  placeDisc(col, symbol);
  c4IsMyTurn = symbol !== c4MySymbol;
  checkC4Winner();
  updateC4Status();
});

function renderConnectFour() {
  if (c4CurrentWrapper) c4CurrentWrapper.remove();

  const wrapper = document.createElement('div');
  wrapper.className = 'game-console';
  wrapper.innerHTML = `
    <div class="connect4">
      <h4>🟡 Connect Four</h4>
      <div class="c4-grid">
        ${Array.from({ length: 6 }, (_, r) =>
          Array.from({ length: 7 }, (_, c) =>
            `<div class="c4-cell" data-col="${c}" data-row="${r}"></div>`
          ).join('')
        ).join('')}
      </div>
      <p id="c4Status"></p>
      <button id="c4ResetBtn" class="util-btn">Play again</button>
    </div>
  `;
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
  c4CurrentWrapper = wrapper;

  const cells = wrapper.querySelectorAll('.c4-cell');
  cells.forEach(cell => {
    cell.addEventListener('click', () => {
      const col = parseInt(cell.dataset.col, 10);
      if (!c4IsMyTurn || c4GameOver) return;
      const row = findLowestEmptyRow(col);
      if (row === -1) return; // full column
      placeDisc(col, c4MySymbol);
      socket.emit("connect4:move", { col, symbol: c4MySymbol });
      c4IsMyTurn = false;
      checkC4Winner();
      updateC4Status();
    });
  });

  const resetBtn = wrapper.querySelector('#c4ResetBtn');
  resetBtn.addEventListener('click', () => {
    socket.emit("connect4:init");
    addSystem("🔄 Restarting Connect Four…");
  });
}


function updateC4Status(text = null) {
  if (!c4CurrentWrapper) return;
  const status = c4CurrentWrapper.querySelector('#c4Status');
  if (!status) return;
  if (text) {
    status.textContent = text;
    return;
  }
  if (c4GameOver) return;
  status.textContent = c4IsMyTurn
    ? `Your turn (${c4MySymbol})`
    : `Waiting for opponent…`;
}

function findLowestEmptyRow(col) {
  for (let r = 5; r >= 0; r--) {
    if (!c4Board[r][col]) return r;
  }
  return -1;
}

function placeDisc(col, symbol) {
  const row = findLowestEmptyRow(col);
  if (row === -1) return;
  c4Board[row][col] = symbol;
  const cell = c4CurrentWrapper.querySelector(`.c4-cell[data-col="${col}"][data-row="${row}"]`);
  if (cell) {
    cell.textContent = symbol;
    cell.classList.add(symbol === '🔴' ? 'red' : 'yellow');
  }
}

function checkC4Winner() {
  const directions = [
    [0, 1], [1, 0], [1, 1], [1, -1]
  ];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const symbol = c4Board[r][c];
      if (!symbol) continue;
      for (let [dr, dc] of directions) {
        const line = [];
        for (let i = 0; i < 4; i++) {
          const nr = r + dr * i, nc = c + dc * i;
          if (nr < 0 || nr >= 6 || nc < 0 || nc >= 7) break;
          if (c4Board[nr][nc] !== symbol) break;
          line.push([nr, nc]);
        }
        if (line.length === 4) {
          c4GameOver = true;
          highlightC4Cells(line);
          updateC4Status(`${symbol} wins! 🏆`);
          return;
        }
      }
    }
  }
  if (c4Board.flat().every(Boolean)) {
    c4GameOver = true;
    updateC4Status("🤝 It's a draw!");
  }
}

function highlightC4Cells(cells) {
  if (!c4CurrentWrapper) return;
  for (const [r, c] of cells) {
    const cell = c4CurrentWrapper.querySelector(`.c4-cell[data-col="${c}"][data-row="${r}"]`);
    if (cell) cell.classList.add('win');
  }
}

/* =======================================================
   SLASH COMMAND PANEL + AUTO HINT
   ======================================================= */

// === Command list setup ===
const commandList = document.getElementById('commandList');
const cmdItems = commandList.querySelectorAll('.cmd-item');

input.addEventListener('input', (e) => {
  const val = e.target.value.trim();
  if (val.startsWith('/')) {
    commandList.classList.remove('hidden');
  } else {
    commandList.classList.add('hidden');
  }
});

// Handle click on a command
cmdItems.forEach((item) => {
  item.addEventListener('click', () => {
    const cmd = item.getAttribute('data-cmd');
    input.value = cmd + ' ';
    commandList.classList.add('hidden');
    input.focus();
  });
});

// Hide when pressing Enter or clicking outside
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') commandList.classList.add('hidden');
});
document.addEventListener('click', (e) => {
  if (!commandList.contains(e.target) && e.target !== input) {
    commandList.classList.add('hidden');
  }
});

/* === Auto System Hint on new chat === */
socket.on('chat:start', (data) => {
  // Existing logic will already call addSystem("You are now chatting…")
  // Add this line right after:
  setTimeout(() => {
    addSystem('💡 Try /tictactoe or /connect4 to play a game!', 8000);
  }, 1000);
});
