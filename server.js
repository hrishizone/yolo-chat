import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";

const app = express();

// remove ngrok warning
app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

// CSP: allow ws/wss, blob/data for media; keep things simple for WebRTC + socket.io
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'", "http:", "https:", "ws:", "wss:"],
        "media-src": ["'self'", "blob:"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(cors());
app.use(compression());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 60000,
});

// ---------------- STATE ----------------
const queue = [];                // waiting sockets
const partnerOf = new Map();     // socket.id -> partnerId
const userModes = new Map();     // socket.id -> boolean (true=video, false=text)

function getPartner(id) {
  const pid = partnerOf.get(id);
  return pid ? io.sockets.sockets.get(pid) : null;
}

// ---------------- PAIRING ----------------
function pair(a, b) {
  if (!a || !b) return;
  if (!a.connected || !b.connected) return;

  partnerOf.set(a.id, b.id);
  partnerOf.set(b.id, a.id);

  // Deterministic roles: 'a' (dequeued) is caller (impolite), 'b' is callee (polite)
  const caller = a;
  const callee = b;

  caller.emit("chat:start", {
    partnerId: callee.id,
    role: "caller",           // impolite
    partnerVideoMode: !!userModes.get(callee.id),
  });

  callee.emit("chat:start", {
    partnerId: caller.id,
    role: "callee",           // polite
    partnerVideoMode: !!userModes.get(caller.id),
  });

  console.log(`🤝 Paired ${caller.id} (caller) ↔ ${callee.id} (callee)`);
}

function enqueue(socket) {
  if (partnerOf.has(socket.id)) return; // already paired

  // find a waiting partner
  for (let i = 0; i < queue.length; i++) {
    const waiting = queue[i];
    if (waiting.connected && !partnerOf.has(waiting.id)) {
      queue.splice(i, 1);
      pair(waiting, socket);
      return;
    }
  }

  // nobody free → wait
  queue.push(socket);
  socket.emit("queue:waiting");
}

function unpair(socket) {
  const partnerId = partnerOf.get(socket.id);
  partnerOf.delete(socket.id);

  if (partnerId) {
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) {
      partnerOf.delete(partner.id);
      partner.emit("chat:ended");
      enqueue(partner);
    }
  }
}

// ---------------- CONNECTION ----------------
io.on("connection", (socket) => {
  console.log("🔗 New user", socket.id);
  userModes.set(socket.id, false); // default = text
  enqueue(socket);

  // --- NEXT ---
  socket.on("chat:next", () => {
    unpair(socket);
    enqueue(socket);
  });

  // --- TEXT CHAT ---
  socket.on("chat:message", (msg) => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit("chat:message", { text: String(msg || "").slice(0, 2000) });
  });

  socket.on("chat:typing", (isTyping) => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit("chat:typing", !!isTyping);
  });

  // --- MODE SWITCH (UI only, informational) ---
  socket.on("mode:changed", ({ videoMode }) => {
    userModes.set(socket.id, !!videoMode);
    const partner = getPartner(socket.id);
    if (partner) {
      partner.emit("partner:mode", { videoMode: !!videoMode });
    }
  });

  // --- CONSENT FLOW ---
  socket.on("video:request", () => {
    const partner = getPartner(socket.id);
    if (partner) {
      partner.emit("video:request");
      console.log(`📣 ${socket.id} requested video from ${partner.id}`);
    }
  });

  socket.on("video:accept", () => {
    const partner = getPartner(socket.id);
    if (partner) {
      // Notify both sides
      partner.emit("video:accept");
      socket.emit("video:accept");
      console.log(`✅ ${socket.id} accepted video with ${partner.id}`);
    }
  });

  socket.on("video:decline", () => {
    const partner = getPartner(socket.id);
    if (partner) {
      partner.emit("video:decline");
      console.log(`🚫 ${socket.id} declined video from ${partner.id}`);
    }
  });

  // 🔔 VIDEO READY (handshake to avoid race conditions)
  socket.on("video:ready", () => {
    const partner = getPartner(socket.id);
    if (partner) {
      partner.emit("video:ready");
      console.log(`🎬 ${socket.id} is ready for video → told ${partner.id}`);
    }
  });

  // --- UNIFIED SIGNALING (SDP + ICE) ---
  socket.on("signal", ({ description, candidate, to }) => {
    const partner = io.sockets.sockets.get(to) || getPartner(socket.id);
    if (!partner) return;
    if (description) {
      console.log(`📨 SDP ${description.type} ${socket.id} -> ${partner.id}`);
      partner.emit("signal", { description, from: socket.id });
    }
    if (candidate) {
      partner.emit("signal", { candidate, from: socket.id });
    }
  });

  // --- DISCONNECT ---
  socket.on("disconnect", () => {
    console.log("❌ Disconnected", socket.id);
    const i = queue.indexOf(socket);
    if (i !== -1) queue.splice(i, 1);
    if (partnerOf.has(socket.id)) unpair(socket);
    userModes.delete(socket.id);
  });
});

// ---------------- START ----------------
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`✅ YOLO Chat server running at http://${HOST}:${PORT}`);
});
