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

let videoMode = false;        // me (UI state)
let partnerVideoMode = false; // for UI only

// Consent + handshake
let hasConsentedVideo = false;
let iAmReady = false;
let partnerReady = false;

// Perfect Negotiation flags
let isPolite = false; // callee = polite
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;

// Offer bootstrap guard
let offerStarted = false;

// Buffer signaling until both sides are ready
const pendingIce = [];
const pendingDescriptions = [];

/* ---------- Status ---------- */
function setStatus(state, text) {
  statusDot.className = "dot";
  if (state) statusDot.classList.add(state);
  statusText.textContent = text;
}

/* ---------- Messages ---------- */
function addSystem(text, timeout = 5000) {
  const div = document.createElement('div');
  div.className = 'system';
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;

  if (timeout) {
    setTimeout(() => {
      div.classList.add('fade-out');
      setTimeout(() => div.remove(), 1000); // remove after fade
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
    // Only caller creates offers once both are ready
    if (!hasConsentedVideo || !iAmReady || !partnerReady || role !== "caller") return;
    if (makingOffer || offerStarted) return;
    try {
      makingOffer = true;
      offerStarted = true; // guard
      console.log("⚙️ onnegotiationneeded -> creating offer");
      await pc.setLocalDescription(await pc.createOffer());
      emitSignal({ description: pc.localDescription });
    } catch (e) {
      offerStarted = false; // allow retry if failed
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
      // Ensure callee has PC + tracks before answering
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
      // answer
      isSettingRemoteAnswerPending = true;
      await pc.setRemoteDescription(d);
      isSettingRemoteAnswerPending = false;
    }
  }

  while (pendingIce.length) {
    const c = pendingIce.shift();
    try { await pc.addIceCandidate(c); } catch (e) { console.warn("ICE add failed", e); }
  }

  // Starter: if onnegotiationneeded didn’t fire at the right time, kick it here
  if (role === "caller" && pc.signalingState === "stable" && !makingOffer && !offerStarted) {
    try {
      makingOffer = true;
      offerStarted = true;
      console.log("🚀 starting initial offer (caller, both ready)");
      await pc.setLocalDescription(await pc.createOffer());
      emitSignal({ description: pc.localDescription });
    } catch (e) {
      offerStarted = false; // allow retry if failed
      console.error("initial-offer error", e);
    } finally {
      makingOffer = false;
    }
  }
}

function emitSignal(payload) {
  socket.emit('signal', { ...payload, to: partnerId });
}

/* ---------- Nice Consent UI Helpers ---------- */
function showConsentModal() {
  consentModal.classList.remove('hidden');
  // trap a simple focus
  consentAccept.focus();
}
function hideConsentModal() {
  consentModal.classList.add('hidden');
}
function showRequestToast() {
  requestToast.classList.remove('hidden');
}
function hideRequestToast() {
  requestToast.classList.add('hidden');
}

/* ---------- Socket events ---------- */
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

  console.log("🤝 Paired with", partnerId, "role:", role, "polite:", isPolite, "partnerVideoMode:", partnerVideoMode);

  setStatus('chatting', 'You are now chatting');
  addSystem('You are now chatting with a stranger. Say hi!');

  // reset all
  hasConsentedVideo = false;
  iAmReady = false;
  partnerReady = false;
  offerStarted = false;
  pendingIce.length = 0;
  pendingDescriptions.length = 0;

  // make sure UI starts in text
  videoMode = false;
  applyModeUI();
});

socket.on('chat:ended', teardownToText);

// Text chat
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

// Partner UI mode
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

// Incoming request -> show modal instead of confirm()
socket.on("video:request", () => {
  showConsentModal();
});

// Modal buttons
consentAccept?.addEventListener('click', () => {
  hideConsentModal();
  socket.emit("video:accept");
});
consentDecline?.addEventListener('click', () => {
  hideConsentModal();
  socket.emit("video:decline");
  addSystem("You declined the video request.");
});

// Both sides get video:accept
socket.on("video:accept", async () => {
  hideRequestToast();

  videoMode = true;
  hasConsentedVideo = true;
  applyModeUI();
  socket.emit('mode:changed', { videoMode: true });

  // Have PC + tracks ready before any SDP flows
  await ensureLocalStream();
  createPeerConnection();
  attachLocalTracksIfNeeded();

  iAmReady = true;
  socket.emit("video:ready");
  addSystem("Preparing video…");
  await processPendingWhenReady();
});


// If someone declines
socket.on("video:decline", () => {
  hideRequestToast();
  addSystem("Stranger declined the video request.");
  pendingDescriptions.length = 0;
  pendingIce.length = 0;
  iAmReady = false;
  partnerReady = false;
});

// Partner says they are ready
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
  let audioEnabled = false; // start muted
  muteBtn.addEventListener('click', () => {
    if (!localStream) return;
    audioEnabled = !audioEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);

    document.getElementById("micOnIcon").classList.toggle("hidden", !audioEnabled);
    document.getElementById("micOffIcon").classList.toggle("hidden", audioEnabled);
  });
}

if (camBtn) {
  let videoTrackEnabled = false; // start camera OFF
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

    // Show chat icon, hide camera
    document.getElementById("videoIcon").classList.add("hidden");
    document.getElementById("chatIcon").classList.remove("hidden");
    modeToggle.setAttribute("title", "Switch to Chat");

  } else {
    videoArea.classList.remove("active");
    chatArea.classList.add("active");

    // Show camera icon, hide chat
    document.getElementById("chatIcon").classList.add("hidden");
    document.getElementById("videoIcon").classList.remove("hidden");
    modeToggle.setAttribute("title", "Switch to Video");

    // cleanup
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
  }
}

// default UI = text
applyModeUI();

if (modeToggle) {
  modeToggle.addEventListener("click", async () => {
    if (!videoMode) {
      // request consent (custom UI + toast)
      requestVideo();
    } else {
      // back to text immediately
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
