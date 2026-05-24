const express  = require('express');
const http     = require('http');
const socketIO = require('socket.io');
const path     = require('path');
const dgram    = require('dgram');
const os       = require('os');
const fs       = require('fs');
const { Bonjour } = require('bonjour-service');

const app    = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 100 * 1024 * 1024,
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

// ─── Stable device identity (persisted to tmp) ────────────────────────────────
const TMP = os.tmpdir();

// Device ID
const ID_FILE = path.join(TMP, 'swyft_device_id.txt');
let DEVICE_ID;
try   { DEVICE_ID = fs.readFileSync(ID_FILE, 'utf8').trim(); }
catch { DEVICE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
        fs.writeFileSync(ID_FILE, DEVICE_ID); }

// ── FIX: generate + persist a friendly Swyft name instead of os.hostname() ──
// Mobile uses the same word-list so all devices look consistent.
const NAME_FILE = path.join(TMP, 'swyft_device_name.txt');
let DEVICE_NAME;
try { DEVICE_NAME = fs.readFileSync(NAME_FILE, 'utf8').trim(); }
catch {
  const adj  = ['Swift','Bright','Cool','Fast','Sharp','Bold','Clear'];
  const noun = ['Falcon','Tiger','Panda','Eagle','Fox','Wolf','Hawk'];
  DEVICE_NAME = adj[Math.floor(Math.random()*adj.length)] + ' ' +
                noun[Math.floor(Math.random()*noun.length)];
  fs.writeFileSync(NAME_FILE, DEVICE_NAME);
}

// Expose identity to local.html so UI and UDP announce stay in sync
app.get('/device-info', (_, res) => res.json({ id: DEVICE_ID, name: DEVICE_NAME }));

// ─── Peer registry ─────────────────────────────────────────────────────────────
// peers: socketId → { id (socketId), name, swyftId, ip }
const peers = new Map();
// ── FIX: swyftId → socketId lookup so mobile can target desktop by Swyft UUID ──
const peersBySwyftId = new Map();

const transfers = new Map(); // transferId → { senderId, receiverId, meta }

function broadcastPeerList() {
  const list = Array.from(peers.values());
  io.emit('peer-list', list);
}

// ─── PIN rooms (online-mode relay fallback) ────────────────────────────────────
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
}, 60_000);

// ─── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // ── FIX: record IP + swyftId from announce ──────────────────────────────
  socket.on('announce', ({ name, swyftId } = {}, cb) => {
    // socket.handshake.address may be '::ffff:192.168.x.x' on IPv6 dual-stack
    const ip = (socket.handshake.address || '').replace('::ffff:', '');
    const peer = { id: socket.id, name: name || 'Unknown Device', swyftId: swyftId || null, ip };
    peers.set(socket.id, peer);
    if (swyftId) peersBySwyftId.set(swyftId, socket.id);
    broadcastPeerList();
    cb?.({ success: true, id: socket.id });
  });

  // ── FIX: resolve targetId as either socket.id OR swyftId ────────────────
  socket.on('request-transfer', ({ targetId, meta }, cb) => {
    const sender = peers.get(socket.id);

    // Allow targeting by Swyft UUID (used by mobile) OR socket.id (used by desktop UI)
    const resolvedSocketId = peers.has(targetId)
      ? targetId
      : peersBySwyftId.get(targetId);

    if (!resolvedSocketId || !peers.has(resolvedSocketId)) {
      return cb?.({ success: false, message: 'Peer not found' });
    }

    const transferId = `${socket.id}::${Date.now()}`;
    transfers.set(transferId, { senderId: socket.id, receiverId: resolvedSocketId, meta });
    io.to(resolvedSocketId).emit('incoming-request', {
      transferId, from: sender?.name || 'Unknown', fromId: socket.id, meta,
    });
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

  // ── PIN room events (online-mode relay) ──────────────────────────────────
  socket.on('create-room', (offer, cb) => {
    const pin = generatePIN();
    rooms.set(pin, { senderId: socket.id, receiverId: null, offer, timestamp: Date.now() });
    cb({ success: true, pin });
  });
  socket.on('join-room', (pin, cb) => {
    const room = rooms.get(pin);
    if (!room) return cb({ success: false, message: 'Invalid PIN' });
    if (room.receiverId) return cb({ success: false, message: 'Room is full' });
    room.receiverId = socket.id;
    socket.join(pin);
    io.to(room.senderId).emit('receiver-joined', { pin });
    cb({ success: true, offer: room.offer });
  });
  socket.on('send-answer', ({ pin, answer }, cb) => {
    const room = rooms.get(pin);
    if (!room) return cb?.({ success: false, message: 'Room not found' });
    io.to(room.senderId).emit('answer-ready', { pin, answer });
    cb?.({ success: true });
  });
  socket.on('ice-candidate', ({ pin, candidate }) => {
    const room = rooms.get(pin);
    if (room) {
      const target = socket.id === room.senderId ? room.receiverId : room.senderId;
      if (target) io.to(target).emit('ice-candidate', { candidate });
    }
  });

  socket.on('disconnect', () => {
    const peer = peers.get(socket.id);
    peers.delete(socket.id);

    // ── FIX: clean up swyftId mapping on disconnect ──────────────────────
    if (peer?.swyftId) peersBySwyftId.delete(peer.swyftId);

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
      if (room.senderId === socket.id) {
        if (room.receiverId) io.to(room.receiverId).emit('sender-left');
        rooms.delete(pin);
      } else if (room.receiverId === socket.id) {
        room.receiverId = null;
        io.to(room.senderId).emit('receiver-left');
      }
    }
  });
});

// ─── UDP multicast discovery ──────────────────────────────────────────────────
const MULTICAST_ADDR    = '224.0.0.167';
const MULTICAST_PORT    = 7354;
const ANNOUNCE_INTERVAL = 2000;
const PROTOCOL_VERSION  = 1;
const PORT              = 3001;

const nearbyPeers = new Map(); // peerId → { ...peer, lastSeen }
const PEER_EXPIRY = 6000;

function broadcastNearbyPeers() {
  io.emit('nearby-peers', Array.from(nearbyPeers.values()));
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of nearbyPeers.entries()) {
    if (now - p.lastSeen > PEER_EXPIRY) { nearbyPeers.delete(id); changed = true; }
  }
  if (changed) broadcastNearbyPeers();
}, 2000);

function getLANIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return '127.0.0.1';
}
function getPlatform() {
  if (process.platform === 'win32')  return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function startDiscovery(lanIP) {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('error', err => console.warn('[Discovery] UDP error:', err.message));

  udp.bind(MULTICAST_PORT, () => {
    try {
      udp.addMembership(MULTICAST_ADDR);
      udp.setMulticastTTL(8);
      udp.setMulticastLoopback(false);
    } catch (e) { console.warn('[Discovery] multicast setup:', e.message); }

    // ── FIX: announce with DEVICE_NAME (Swyft-style) not os.hostname() ──
    const announce = () => {
      const payload = Buffer.from(JSON.stringify({
        id:       DEVICE_ID,
        name:     DEVICE_NAME,   // was: os.hostname()
        ip:       lanIP,
        port:     PORT,
        platform: getPlatform(),
        version:  PROTOCOL_VERSION,
      }));
      udp.send(payload, 0, payload.length, MULTICAST_PORT, MULTICAST_ADDR, () => {});
    };
    announce();
    setInterval(announce, ANNOUNCE_INTERVAL);
    console.log('[Discovery] broadcasting as', DEVICE_NAME, 'on', MULTICAST_ADDR + ':' + MULTICAST_PORT);
  });

  udp.on('message', (msg) => {
    try {
      const peer = JSON.parse(msg.toString());
      if (peer.id === DEVICE_ID)             return;
      if (peer.version !== PROTOCOL_VERSION) return;
      const isNew = !nearbyPeers.has(peer.id);
      nearbyPeers.set(peer.id, { ...peer, lastSeen: Date.now() });
      if (isNew) broadcastNearbyPeers();
      else nearbyPeers.get(peer.id).lastSeen = Date.now();
    } catch (_) {}
  });
}

app.get('/nearby-peers', (_, res) => res.json(Array.from(nearbyPeers.values())));

server.listen(PORT, '0.0.0.0', () => {
  const lanIP = getLANIP();
  console.log(`Swyft local server on http://${lanIP}:${PORT}  (${DEVICE_NAME})`);
  try { const b = new Bonjour(); b.publish({ name: 'Swyft', type: 'http', port: PORT }); }
  catch (e) { console.warn('mDNS failed:', e.message); }
  startDiscovery(lanIP);
});

module.exports = server;
