const socket = io(window.location.origin);

const messages = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('message');
const nextBtn = document.getElementById('next');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

// Create scroll-to-bottom button
const scrollBtn = document.createElement('button');
scrollBtn.id = 'scroll-down';
scrollBtn.className = 'scroll-down';
scrollBtn.textContent = '↓';
document.querySelector('.app').appendChild(scrollBtn);

let typingTimeout;

/* ---------- Status Handling ---------- */
function setStatus(state, text) {
  statusDot.classList.remove('online', 'waiting', 'chatting');
  if (state) statusDot.classList.add(state);
  statusText.textContent = text;
}

/* ---------- Auto-Scroll Helpers ---------- */
function shouldAutoScroll() {
  const { scrollTop, scrollHeight, clientHeight } = messages;
  return scrollTop + clientHeight >= scrollHeight - 40; // tolerance
}
function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

/* ---------- Message Helpers ---------- */
function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'system';
  div.textContent = text;
  const auto = shouldAutoScroll();
  messages.appendChild(div);
  if (auto) scrollToBottom();
}

function addMsg(text, me = false) {
  const div = document.createElement('div');
  div.className = 'msg' + (me ? ' me' : '');
  div.textContent = text;
  const auto = shouldAutoScroll();
  messages.appendChild(div);
  if (auto) scrollToBottom();
}

/* ---------- Socket Events ---------- */
socket.on('connect', () =>
  setStatus('online', 'Connected. Finding a stranger…')
);
socket.on('disconnect', () =>
  setStatus('', 'Disconnected. Reconnecting…')
);

socket.on('queue:waiting', () => {
  setStatus('waiting', 'Waiting for a stranger…');
  addSystem('Looking for a stranger…');
});

socket.on('chat:start', () => {
  setStatus('chatting', 'You are now chatting');
  addSystem('You are now chatting with a stranger. Say hi!');
});

socket.on('chat:ended', () => {
  addSystem('Stranger disconnected.');
  setStatus('waiting', 'Stranger left. Finding a new one…');
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
  } else if (t) {
    t.remove();
  }
  if (shouldAutoScroll()) scrollToBottom();
});

/* ---------- Form Handling ---------- */
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addMsg(text, true);
  socket.emit('chat:message', text);
  input.value = '';
  socket.emit('chat:typing', false);
});

/* ---------- Typing Events ---------- */
input.addEventListener('input', () => {
  socket.emit('chat:typing', true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(
    () => socket.emit('chat:typing', false),
    1000
  );
});

/* ---------- Next Button ---------- */
nextBtn.addEventListener('click', () => {
  addSystem('Searching for a new stranger…');
  socket.emit('chat:next');
});

/* ---------- Scroll Button Handling ---------- */
messages.addEventListener('scroll', () => {
  if (shouldAutoScroll()) {
    scrollBtn.classList.remove('show');
  } else {
    scrollBtn.classList.add('show');
  }
});

scrollBtn.addEventListener('click', scrollToBottom);
