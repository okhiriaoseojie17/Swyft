const express = require('express');
const http    = require('http');
const socketIO = require('socket.io');
const path    = require('path');
const { Bonjour } = require('bonjour-service');
const dgram   = require('dgram');
const os      = require('os');

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
// ─── UDP multicast discovery (same protocol as mobile app) ───────────────────
const MULTICAST_ADDR     = '224.0.0.167';
const MULTICAST_PORT     = 7354;
const ANNOUNCE_INTERVAL  = 2000;
const PROTOCOL_VERSION   = 1;

function getLANIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function getPlatform() {
  if (process.platform === 'win32')  return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

// Generate a stable device ID
const DEVICE_ID_FILE = require('path').join(require('os').tmpdir(), 'swyft_device_id.txt');
let DEVICE_ID;
try   { DEVICE_ID = require('fs').readFileSync(DEVICE_ID_FILE, 'utf8').trim(); }
catch { DEVICE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
        require('fs').writeFileSync(DEVICE_ID_FILE, DEVICE_ID); }

// Nearby peers discovered via UDP (phones + other desktops)
const nearbyPeers  = new Map();  // peerId → { id, name, ip, port, platform, lastSeen }
const PEER_EXPIRY  = 6000;

function broadcastNearbyPeers() {
  io.emit('nearby-peers', Array.from(nearbyPeers.values()));
}

// Expire stale peers every 2s and re-broadcast
setInterval(() => {
  const now     = Date.now();
  let changed   = false;
  for (const [id, p] of nearbyPeers.entries()) {
    if (now - p.lastSeen > PEER_EXPIRY) { nearbyPeers.delete(id); changed = true; }
  }
  if (changed) broadcastNearbyPeers();
}, 2000);

function startDiscovery(lanIP, deviceName) {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  udp.on('error', err => console.warn('[Discovery] UDP error:', err.message));

  udp.bind(MULTICAST_PORT, () => {
    try {
      udp.addMembership(MULTICAST_ADDR);
      udp.setMulticastTTL(8);
      udp.setMulticastLoopback(false);
    } catch(e) { console.warn('[Discovery] multicast setup:', e.message); }

    // Broadcast our own presence
    const announce = () => {
      const payload = Buffer.from(JSON.stringify({
        id:       DEVICE_ID,
        name:     deviceName || os.hostname(),
        ip:       lanIP,
        port:     PORT,
        platform: getPlatform(),
        version:  PROTOCOL_VERSION,
      }));
      udp.send(payload, 0, payload.length, MULTICAST_PORT, MULTICAST_ADDR, () => {});
    };
    announce();
    setInterval(announce, ANNOUNCE_INTERVAL);
    console.log('[Discovery] broadcasting as', deviceName, 'on', MULTICAST_ADDR + ':' + MULTICAST_PORT);
  });

  // Listen for announcements from other Swyft devices
  udp.on('message', (msg) => {
    try {
      const peer = JSON.parse(msg.toString());
      // Ignore our own packets and wrong protocol versions
      if (peer.id === DEVICE_ID)             return;
      if (peer.version !== PROTOCOL_VERSION) return;

      const isNew = !nearbyPeers.has(peer.id);
      nearbyPeers.set(peer.id, { ...peer, lastSeen: Date.now() });

      // Only re-broadcast the list when something actually changes
      if (isNew) broadcastNearbyPeers();
      else {
        // Update lastSeen but don't spam the browser
        const entry = nearbyPeers.get(peer.id);
        entry.lastSeen = Date.now();
      }
    } catch(_) {}
  });
}

// Endpoint so local.html can fetch the current nearby list on page load
app.get('/nearby-peers', (_, res) => {
  res.json(Array.from(nearbyPeers.values()));
});

server.listen(PORT, '0.0.0.0', () => {
  const lanIP = getLANIP();
  console.log('Swyft local server on http://' + lanIP + ':' + PORT);
  try { const b = new Bonjour(); b.publish({ name: 'Swyft', type: 'http', port: PORT }); }
  catch (e) { console.warn('mDNS failed:', e.message); }
  startDiscovery(lanIP, require('os').hostname());
});

module.exports = server;