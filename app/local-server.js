const express = require('express');
const http    = require('http');
const socketIO = require('socket.io');
const path    = require('path');
const { Bonjour } = require('bonjour-service');

const app    = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 100 * 1024 * 1024
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'src')));
app.get('/ice-servers', (_, res) => res.json([{ urls: 'stun:stun.l.google.com:19302' }]));

// ─── Peer registry ─────────────────────────────────────────────────────────────
const peers = new Map();   // socketId → { id, name }
const transfers = new Map(); // transferId → { senderId, receiverId, meta }

function broadcastPeerList() {
  const list = Array.from(peers.values());
  io.emit('peer-list', list);
}

// ─── PIN rooms (kept for online-mode fallback relay) ──────────────────────────
const rooms = new Map();
function generatePIN() {
  let pin;
  do { pin = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms.has(pin));
  return pin;
}
setInterval(() => {
  const now = Date.now();
  for (const [pin, room] of rooms.entries())
    if (now - room.timestamp > 10 * 60 * 1000) rooms.delete(pin);
}, 60000);

// ─── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('announce', ({ name }, cb) => {
    const peer = { id: socket.id, name: name || 'Unknown Device' };
    peers.set(socket.id, peer);
    broadcastPeerList();
    cb?.({ success: true, id: socket.id });
  });

  socket.on('request-transfer', ({ targetId, meta }, cb) => {
    const sender = peers.get(socket.id);
    if (!peers.has(targetId)) return cb?.({ success: false, message: 'Peer not found' });
    const transferId = `${socket.id}::${Date.now()}`;
    transfers.set(transferId, { senderId: socket.id, receiverId: targetId, meta });
    io.to(targetId).emit('incoming-request', { transferId, from: sender?.name || 'Unknown', fromId: socket.id, meta });
    cb?.({ success: true, transferId });
  });

  socket.on('transfer-response', ({ transferId, accepted }) => {
    const t = transfers.get(transferId);
    if (!t) return;
    io.to(t.senderId).emit('transfer-response', { transferId, accepted });
    if (!accepted) transfers.delete(transferId);
  });

  socket.on('file-metadata', ({ transferId, metadata }) => {
    const t = transfers.get(transferId);
    if (t) io.to(t.receiverId).emit('file-metadata', { transferId, metadata });
  });

  socket.on('file-chunk', ({ transferId, chunk }) => {
    const t = transfers.get(transferId);
    if (t) io.to(t.receiverId).emit('file-chunk', { transferId, chunk });
  });

  socket.on('file-end', ({ transferId }) => {
    const t = transfers.get(transferId);
    if (t) { io.to(t.receiverId).emit('file-end', { transferId }); transfers.delete(transferId); }
  });

  socket.on('file-cancel', ({ transferId }) => {
    const t = transfers.get(transferId);
    if (t) { io.to(t.receiverId).emit('file-cancel', { transferId }); transfers.delete(transferId); }
  });

  // PIN room events
  socket.on('create-room', (cb) => {
    const pin = generatePIN();
    rooms.set(pin, { senderId: socket.id, receiverId: null, timestamp: Date.now() });
    cb({ success: true, pin });
  });
  socket.on('join-room', (pin, cb) => {
    const room = rooms.get(pin);
    if (!room) return cb({ success: false, message: 'Invalid PIN' });
    if (room.receiverId) return cb({ success: false, message: 'Room is full' });
    room.receiverId = socket.id;
    socket.join(pin);
    io.to(room.senderId).emit('receiver-joined', { pin });
    cb({ success: true });
  });

  socket.on('disconnect', () => {
    peers.delete(socket.id);
    broadcastPeerList();
    for (const [id, t] of transfers.entries()) {
      if (t.senderId === socket.id) {
        io.to(t.receiverId).emit('file-cancel', { transferId: id, reason: 'sender-left' });
        transfers.delete(id);
      } else if (t.receiverId === socket.id) {
        io.to(t.senderId).emit('transfer-response', { transferId: id, accepted: false, reason: 'receiver-left' });
        transfers.delete(id);
      }
    }
    for (const [pin, room] of rooms.entries()) {
      if (room.senderId === socket.id) { if (room.receiverId) io.to(room.receiverId).emit('sender-left'); rooms.delete(pin); }
      else if (room.receiverId === socket.id) { room.receiverId = null; io.to(room.senderId).emit('receiver-left'); }
    }
  });
});

const PORT = 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Swyft local server on http://localhost:' + PORT);
  try { const b = new Bonjour(); b.publish({ name: 'Swyft', type: 'http', port: PORT }); }
  catch (e) { console.warn('mDNS failed:', e.message); }
});

module.exports = server;