import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';

const app = express();

// ✅ Add this middleware BEFORE static routes
app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", "'unsafe-inline'"],
      "connect-src": ["'self'", "ws:", "wss:"],
      "style-src": ["'self'", "'unsafe-inline'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());
app.use(compression());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 60000
});

// Simple matchmaking: FIFO queue of waiting sockets
const queue = [];
const partnerOf = new Map(); // socket.id -> partnerId

function pair(a, b) {
  if (!a || !b) return;
  partnerOf.set(a.id, b.id);
  partnerOf.set(b.id, a.id);
  a.emit('chat:start');
  b.emit('chat:start');
}

function unpair(socket) {
  const partnerId = partnerOf.get(socket.id);
  partnerOf.delete(socket.id);
  if (partnerId) {
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) {
      partnerOf.delete(partner.id);
      partner.emit('chat:ended');
      // Put partner back to queue to find a new stranger
      enqueue(partner);
    }
  }
}

function enqueue(socket) {
  // Avoid duplicates in queue
  const idx = queue.indexOf(socket);
  if (idx !== -1) return;
  // If there's someone waiting, pair them
  while (queue.length > 0) {
    const waiting = queue.shift();
    if (waiting.connected && waiting.id !== socket.id && !partnerOf.has(waiting.id)) {
      pair(waiting, socket);
      return;
    }
  }
  // Otherwise, add to queue
  queue.push(socket);
  socket.emit('queue:waiting');
}

io.on('connection', (socket) => {
  // Attempt to match immediately on connect
  enqueue(socket);

  socket.on('chat:next', () => {
    unpair(socket);
    enqueue(socket);
  });

  socket.on('chat:message', (msg) => {
    const partnerId = partnerOf.get(socket.id);
    if (!partnerId) return;
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) partner.emit('chat:message', { text: String(msg || '').slice(0, 2000) });
  });

  socket.on('chat:typing', (isTyping) => {
    const partnerId = partnerOf.get(socket.id);
    if (!partnerId) return;
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) partner.emit('chat:typing', !!isTyping);
  });

  socket.on('disconnect', () => {
    // Remove from queue if present
    const i = queue.indexOf(socket);
    if (i !== -1) queue.splice(i, 1);
    // Unpair and notify partner
    if (partnerOf.has(socket.id)) unpair(socket);
  });
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`✅ Omegle-lite server running at http://${HOST}:${PORT}`);
});
