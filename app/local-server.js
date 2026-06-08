/**
 * local-server.js  (DESKTOP)
 *
 * Unified HTTP REST server for Swyft local transfers.
 *
 * FIXES vs old code:
 *  1. PORT changed: 3001/7354 → 53317 everywhere (one port, like LocalSend)
 *  2. socket.io REMOVED for local file transfers — plain HTTP only
 *     (socket.io is kept ONLY for the online/WebRTC signalling path)
 *  3. UDP multicast discovery: MULTICAST_PORT 7354 → 53317
 *  4. Interface filtering: now filters VirtualBox, Tailscale, Docker, WSL,
 *     CGNAT, hotspot, APIPA — and joins multicast on EVERY valid interface
 *  5. setMulticastInterface() called explicitly so Windows uses WiFi NIC,
 *     not the VirtualBox or Hyper-V virtual adapter
 *  6. Announcement payload matches SwyftAnnouncement interface (shared/protocol)
 *  7. /prepare-upload → /upload → /cancel endpoints added (LocalSend protocol)
 *  8. Firewall check endpoints updated: port references corrected to 53317
 *  9. Typo fixed: getlanIP() → getLANIP()
 * 10. socket.io kept on a SEPARATE port (3001) for the online signalling path only
 */

const express    = require('express');
const http       = require('http');
const socketIO   = require('socket.io');
const path       = require('path');
const dgram      = require('dgram');
const os         = require('os');
const fs         = require('fs');
const { Bonjour } = require('bonjour-service');
const { execSync, exec: execCb } = require('child_process');
const multer     = require('multer');   // npm install multer
const upload     = multer({ dest: os.tmpdir() });

// ─── Protocol constants (mirrors shared/protocol.ts) ─────────────────────────
const SWYFT_PORT         = 53317;          // THE single port — never 3001/3002/7354
const SIGNAL_PORT        = 3001;           // socket.io online signalling only
const MULTICAST_ADDR     = '224.0.0.167';
const MULTICAST_PORT     = SWYFT_PORT;
const ANNOUNCE_INTERVAL  = 2000;
const PEER_EXPIRY        = 8000;
const PROTOCOL_VERSION   = '2.0';

// ─── Two Express apps: one for local HTTP (53317), one for online socket.io (3001) ──

const localApp    = express();
const localServer = http.createServer(localApp);

const signalApp    = express();
const signalServer = http.createServer(signalApp);
const io = socketIO(signalServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 100 * 1024 * 1024,
});

// CORS for local app
localApp.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, X-Session-Id, X-File-Id, X-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
// Apply JSON parser to every route EXCEPT /upload — /upload uses its own
// express.text() parser with a 2 GB limit. If the global JSON parser runs
// first on a large upload it will reject it with 413 before the route fires.
localApp.use((req, res, next) => {
  if (req.path === '/upload' || req.path === '/send-to-phone') return next();
  express.json({ limit: '10mb' })(req, res, next);
});
localApp.use(express.static(path.join(__dirname, 'src')));

signalApp.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
signalApp.use(express.static(path.join(__dirname, 'src')));
signalApp.get('/ice-servers', (_, res) => res.json([{ urls: 'stun:stun.l.google.com:19302' }]));

// ─── Stable device identity ───────────────────────────────────────────────────
const TMP = os.tmpdir();

const ID_FILE = path.join(TMP, 'swyft_device_id_v2.txt');
let DEVICE_ID;
try   { DEVICE_ID = fs.readFileSync(ID_FILE, 'utf8').trim(); }
catch { DEVICE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
        fs.writeFileSync(ID_FILE, DEVICE_ID); }

const NAME_FILE = path.join(TMP, 'swyft_device_name_v2.txt');
let DEVICE_NAME;
try { DEVICE_NAME = fs.readFileSync(NAME_FILE, 'utf8').trim(); }
catch {
  const adj  = ['Swift','Bright','Cool','Fast','Sharp','Bold','Clear'];
  const noun = ['Falcon','Tiger','Panda','Eagle','Fox','Wolf','Hawk'];
  DEVICE_NAME = adj[Math.floor(Math.random()*adj.length)] + ' ' +
                noun[Math.floor(Math.random()*noun.length)];
  fs.writeFileSync(NAME_FILE, DEVICE_NAME);
}

localApp.get('/device-info',  (_, res) => res.json({ id: DEVICE_ID, name: DEVICE_NAME }));
signalApp.get('/device-info', (_, res) => res.json({ id: DEVICE_ID, name: DEVICE_NAME }));

// ─── Interface selection ──────────────────────────────────────────────────────

const SKIP_IP_PREDICATES = [
  a => a.startsWith('192.168.56.'),                          // VirtualBox host-only
  a => a.startsWith('100.64.') || a.startsWith('100.65.'), // Tailscale CGNAT
  a => { const b = parseInt(a.split('.')[1]);
         return a.startsWith('172.') && b >= 16 && b <= 31; }, // Docker/WSL/Hyper-V
  a => a.startsWith('169.254.'),                             // APIPA link-local
  a => a.startsWith('10.0.2.'),                              // VirtualBox NAT
];

const SKIP_NAME_FRAGMENTS = [
  'vmware', 'virtualbox', 'vethernet', 'hyper-v', 'docker',
  'wsl', 'loopback', 'pseudo', 'tailscale', 'zerotier', 'tun', 'tap',
];

function getFilteredLANInterfaces() {
  const ifaces     = os.networkInterfaces();
  const candidates = [];

  for (const [name, entries] of Object.entries(ifaces)) {
    const nameLC = name.toLowerCase();
    if (SKIP_NAME_FRAGMENTS.some(v => nameLC.includes(v))) continue;

    for (const iface of entries) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address;
      if (SKIP_IP_PREDICATES.some(fn => fn(ip))) continue;

      // Score: prefer home WiFi (192.168.x) over corporate (10.x) over others
      const score = ip.startsWith('192.168.') ? 3
                  : ip.startsWith('10.')       ? 2
                  : ip.startsWith('172.')      ? 1 : 0;

      candidates.push({ name, ip, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function getLANIP() {
  const candidates = getFilteredLANInterfaces();
  return candidates[0]?.ip || '127.0.0.1';
}

function getPlatform() {
  if (process.platform === 'win32')  return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

// ─── Local HTTP endpoints (port 53317) ───────────────────────────────────────

// GET /info — device info / HTTP-fallback discovery
localApp.get('/info', (_, res) => {
  res.json({
    alias:       DEVICE_NAME,
    version:     PROTOCOL_VERSION,
    deviceModel: `${os.type()} ${os.release()}`,
    deviceType:  'desktop',
    fingerprint: DEVICE_ID,
    port:        SWYFT_PORT,
    protocol:    'http',
    download:    true,
  });
});

// In-memory session store
const sessions = new Map();   // sessionId → { req, accepted, tokens }

// POST /prepare-upload — returns IMMEDIATELY with status:'pending'
// Sender polls GET /transfer-status until accepted or declined.
localApp.post('/prepare-upload', (req, res) => {
  try {
    const body      = req.body;
    const fileList  = Object.values(body.files || {});
    const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const tokens    = {};

    for (const f of fileList) {
      tokens[f.id] = Math.random().toString(36).slice(2);
    }

    const session = { req: { sessionId, from: body.info?.alias, fromId: body.info?.fingerprint, files: fileList }, accepted: null, tokens };
    sessions.set(sessionId, session);

    // ── FIX: store sender identity in nearbyPeers so the peer card on the
    // desktop shows the device's Swyft name (e.g. "Bright Falcon") instead of
    // its raw IP address. This matters on corporate/managed WiFi where UDP
    // multicast is blocked and the phone never appears via auto-discovery.
    // The sender's IP is extracted from the TCP connection (req.socket.remoteAddress
    // strips the IPv4-mapped IPv6 prefix "::ffff:"). ──────────────────────────────
    const senderAlias       = body.info?.alias;
    const senderFingerprint = body.info?.fingerprint;
    const senderPort        = body.info?.port || SWYFT_PORT;
    if (senderAlias && senderFingerprint) {
      const senderIP = (req.socket?.remoteAddress || req.ip || '').replace('::ffff:', '');
      nearbyPeers.set(senderFingerprint, {
        alias:       senderAlias,
        version:     body.info?.version     || PROTOCOL_VERSION,
        deviceModel: body.info?.deviceModel || 'Unknown',
        deviceType:  body.info?.deviceType  || 'mobile',
        fingerprint: senderFingerprint,
        port:        senderPort,
        ip:          senderIP,
        lastSeen:    Date.now(),
        baseUrl:     `http://${senderIP}:${senderPort}`,
      });
      // Push the updated peer list to the desktop UI immediately
      io.emit('nearby-peers', Array.from(nearbyPeers.values()));
    }

    // Tell the desktop UI about the incoming request
    io.emit('incoming-request-local', { sessionId, from: session.req.from, files: fileList });

    // Return immediately — sender polls /transfer-status
    console.log('[prepare-upload] session created:', sessionId, 'from:', session.req.from);
    res.json({ sessionId, status: 'pending', files: tokens });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /transfer-status?sessionId=X — sender polls after getting status:'pending'
localApp.get('/transfer-status', (req, res) => {
  const { sessionId } = req.query;
  console.log('[transfer-status] polled for:', sessionId);
  if (!sessionId) return res.status(400).json({ message: 'Missing sessionId' });
  const session = sessions.get(sessionId);
  if (!session)  return res.status(404).json({ message: 'Session not found' });
  if (session.accepted === null)  return res.json({ status: 'pending' });
  if (session.accepted === false) { sessions.delete(sessionId); return res.json({ status: 'declined' }); }
  return res.json({ status: 'accepted' });
});

// POST /upload — receives base64-encoded file body as text/plain.
// Supports both single-shot uploads (no chunk headers) and chunked uploads
// (X-Chunk-Index / X-Total-Chunks) from mobile clients. Chunked mode prevents
// HTTP 413 on large files by keeping each POST body under ~700 KB base64.
localApp.post('/upload', express.text({ type: '*/*', limit: '2gb' }), async (req, res) => {
  try {
    // Accept params from query string OR headers (desktop sends headers, mobile sends both)
    const sessionId = req.query.sessionId || req.headers['x-session-id'];
    const fileId    = req.query.fileId    || req.headers['x-file-id'];
    const token     = req.query.token     || req.headers['x-token'];

    console.log('[upload] sessionId:', sessionId, 'fileId:', fileId);

    const session = sessions.get(sessionId);
    if (!session || session.accepted !== true) {
      console.warn('[upload] session not found or not accepted:', sessionId);
      return res.status(403).json({ message: 'Session not found or not accepted' });
    }

    if (session.tokens[fileId] !== token) {
      console.warn('[upload] invalid token');
      return res.status(403).json({ message: 'Invalid token' });
    }

    const fileInfo = session.req.files.find(f => f.id === fileId);
    if (!fileInfo) return res.status(400).json({ message: 'Unknown file' });

    // Sanitise filename to prevent path traversal
    const safeName = path.basename(fileInfo.fileName).replace(/[^a-zA-Z0-9._\- ]/g, '_');

    // ── Chunked upload support ───────────────────────────────────────────────
    // Mobile clients (localClient.ts) send files in 512 KB base64 chunks to
    // avoid HTTP 413. Each chunk carries X-Chunk-Index and X-Total-Chunks headers.
    // Single-shot uploads (no headers, or totalChunks=1) are still supported.
    const chunkIndex  = parseInt(req.headers['x-chunk-index']  ?? req.query.chunkIndex  ?? '0', 10);
    const totalChunks = parseInt(req.headers['x-total-chunks'] ?? req.query.totalChunks ?? '1', 10);

    if (totalChunks > 1) {
      // Multi-chunk path: accumulate in memory, write on final chunk.
      // Using a per-session, per-file chunk map keyed by chunk index.
      if (!session.chunks)          session.chunks = {};
      if (!session.chunks[fileId])  session.chunks[fileId] = {};
      session.chunks[fileId][chunkIndex] = req.body;  // store base64 slice

      console.log(`[upload] chunk ${chunkIndex + 1}/${totalChunks} received for ${safeName}`);

      // Emit approximate progress to the UI
      const pct = Math.round(((chunkIndex + 1) / totalChunks) * 100);
      io.emit('upload-progress-local', { sessionId, fileId, pct });

      if (chunkIndex < totalChunks - 1) {
        // Not the final chunk yet — acknowledge and wait for the next one
        return res.json({ message: 'chunk received', chunkIndex });
      }

      // ── Final chunk: reassemble all parts in order ─────────────────────────
      let fullBase64 = '';
      for (let i = 0; i < totalChunks; i++) {
        const part = session.chunks[fileId][i];
        if (part === undefined) {
          return res.status(400).json({ message: `Missing chunk ${i}` });
        }
        fullBase64 += part;
      }
      delete session.chunks[fileId];

      const dest       = path.join(os.homedir(), 'Downloads', safeName);
      const fileBuffer = Buffer.from(fullBase64, 'base64');
      fs.writeFileSync(dest, fileBuffer);

      console.log('[upload] chunked file saved to:', dest, '— size:', fileBuffer.length, 'bytes');
      io.emit('transfer-complete-local', { sessionId, fileId, fileName: safeName, dest });

      delete session.tokens[fileId];
      if (Object.keys(session.tokens).length === 0) sessions.delete(sessionId);

      return res.json({ message: 'received' });
    }

    // ── Single-shot path (original behaviour) ───────────────────────────────
    // Body is a base64 string (sent as text/plain); decode it before writing.
    const dest       = path.join(os.homedir(), 'Downloads', safeName);
    const fileBuffer = Buffer.from(req.body, 'base64');
    fs.writeFileSync(dest, fileBuffer);

    console.log('[upload] file saved to:', dest, '— size:', fileBuffer.length, 'bytes');
    io.emit('transfer-complete-local', { sessionId, fileId, fileName: safeName, dest });

    delete session.tokens[fileId];
    if (Object.keys(session.tokens).length === 0) sessions.delete(sessionId);

    res.json({ message: 'received' });
  } catch (err) {
    console.error('[upload] error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// POST /cancel
localApp.post('/cancel', (req, res) => {
  // sessionId may arrive in JSON body OR as a query param (mobile sends both)
  const sessionId = req.body?.sessionId || req.query?.sessionId;
  if (sessionId) {
    sessions.delete(sessionId);
    // Emit regardless of whether session was pending or active —
    // the desktop UI handler dismisses whichever overlay is showing.
    io.emit('transfer-cancelled-local', { sessionId });
  } else {
    // Sender cancelled without a sessionId (pre-prepare-upload abort):
    // broadcast a generic cancel so the UI can clean up any pending prompt.
    io.emit('transfer-cancelled-local', { sessionId: null });
  }
  res.json({ message: 'cancelled' });
});

// UI calls these to accept/decline a pending session
localApp.post('/accept-session',  (req, res) => {
  const s = sessions.get(req.body?.sessionId);
  if (s) s.accepted = true;
  res.json({ ok: true });
});
localApp.post('/decline-session', (req, res) => {
  const s = sessions.get(req.body?.sessionId);
  if (s) s.accepted = false;
  res.json({ ok: true });
});

// ── Desktop → Phone: send a file to a phone peer ─────────────────────────────
//
// local.html calls POST /send-to-phone with { peerIP, peerPort, filePath } after
// the user selects a file and taps a phone peer card with the "↓ Send to phone"
// action. This endpoint reads the file, encodes it as base64, and drives the
// same /prepare-upload → poll → /upload flow that mobile-to-desktop uses —
// but in reverse: the DESKTOP is now the sender and the PHONE is the receiver.
//
// Progress is streamed back to the UI via socket.io 'send-to-phone-progress'.
//
// Note: the file content is read from disk using a path the Electron main process
// set when serving the file. For drag-and-drop / file-picker flows, local.html
// passes the raw File object contents as base64 in the request body instead.

const activeSendToPhone = new Map();  // sessionId → AbortController

localApp.post('/send-to-phone', express.json({ limit: '2gb' }), async (req, res) => {
  // Validate required fields
  const { peerIP, peerPort = SWYFT_PORT, fileName, fileSize, fileBase64, fileType } = req.body || {};
  if (!peerIP || !fileName || !fileBase64) {
    return res.status(400).json({ message: 'Missing peerIP, fileName, or fileBase64' });
  }
  const resolvedFileType = fileType || 'application/octet-stream';

  const peerBaseUrl = `http://${peerIP}:${peerPort}`;

  // Respond immediately — progress comes via socket.io
  res.json({ ok: true, message: 'Send started' });

  // Run the send asynchronously
  (async () => {
    const fileId    = Math.random().toString(36).slice(2);
    let sessionId   = null;

    try {
      // 1. Prepare-upload to the phone
      io.emit('send-to-phone-progress', { pct: 0, status: 'requesting', peerIP });
      const prepareBody = {
        info: {
          alias:       DEVICE_NAME,
          version:     PROTOCOL_VERSION,
          deviceModel: `${os.type()} ${os.release()}`,
          deviceType:  'desktop',
          fingerprint: DEVICE_ID,
          port:        SWYFT_PORT,
          protocol:    'http',
          download:    true,
        },
        files: {
          [fileId]: { id: fileId, fileName, size: fileSize || 0, fileType: resolvedFileType },
        },
      };

      const prepCtrl  = new AbortController();
      const prepTimer = setTimeout(() => prepCtrl.abort(), 10000);
      let prepData;
      try {
        const prepRes = await fetch(`${peerBaseUrl}/prepare-upload`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(prepareBody),
          signal:  prepCtrl.signal,
        });
        clearTimeout(prepTimer);
        if (!prepRes.ok) throw new Error(`HTTP ${prepRes.status}`);
        prepData = await prepRes.json();
      } catch (err) {
        io.emit('send-to-phone-progress', { pct: 0, status: 'error', error: 'Cannot reach phone: ' + err.message, peerIP });
        return;
      }

      sessionId = prepData.sessionId;
      const token = prepData.files?.[fileId];
      if (!token) {
        io.emit('send-to-phone-progress', { pct: 0, status: 'error', error: 'No upload token from phone', peerIP });
        return;
      }

      // Register abort controller so the transfer can be cancelled
      const abortCtrl = new AbortController();
      activeSendToPhone.set(sessionId, abortCtrl);

      // 2. Poll phone's /transfer-status until accepted (35s max)
      io.emit('send-to-phone-progress', { pct: 0, status: 'waiting', sessionId, peerIP });
      const deadline = Date.now() + 35000;
      let decided    = false;

      while (Date.now() < deadline) {
        if (abortCtrl.signal.aborted) {
          io.emit('send-to-phone-progress', { pct: 0, status: 'cancelled', sessionId, peerIP });
          return;
        }
        await new Promise(r => setTimeout(r, 400));
        try {
          const statusRes  = await fetch(
            `${peerBaseUrl}/transfer-status?sessionId=${encodeURIComponent(sessionId)}`,
            { signal: AbortSignal.timeout(5000) }
          );
          const statusData = await statusRes.json();
          if (statusData.status === 'accepted') { decided = true; break; }
          if (statusData.status === 'declined') {
            io.emit('send-to-phone-progress', { pct: 0, status: 'declined', sessionId, peerIP });
            activeSendToPhone.delete(sessionId);
            return;
          }
        } catch (_) { /* keep polling */ }
      }

      if (!decided) {
        io.emit('send-to-phone-progress', { pct: 0, status: 'timeout', sessionId, peerIP });
        activeSendToPhone.delete(sessionId);
        return;
      }

      // 3. Upload in 64 KB chunks.
      // expo-http-server on Android has a much lower body-size limit than Node/Express.
      // 512 KB chunks (the mobile→desktop size) cause HTTP 413 on the phone.
      // 64 KB raw → ~85 KB base64 per POST stays well within expo-http-server's limit.
      const CHUNK_BYTES   = 64 * 1024;
      const b64ChunkSize  = Math.ceil(CHUNK_BYTES * 4 / 3);
      const totalChunks   = Math.ceil(fileBase64.length / b64ChunkSize) || 1;

      for (let i = 0; i < totalChunks; i++) {
        if (abortCtrl.signal.aborted) {
          io.emit('send-to-phone-progress', { pct: 0, status: 'cancelled', sessionId, peerIP });
          activeSendToPhone.delete(sessionId);
          return;
        }

        const chunk = fileBase64.slice(i * b64ChunkSize, (i + 1) * b64ChunkSize);
        const uploadRes = await fetch(
          `${peerBaseUrl}/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}`,
          {
            method:  'POST',
            headers: {
              'Content-Type':   'text/plain',
              'X-File-Name':    encodeURIComponent(fileName),
              // Redundantly send params as X-* headers so expo-http-server's
              // parseQueryParams() fallback (which reads headers) can find them
              // even when paramsJson is empty (common on Android).
              'X-Session-Id':   sessionId,
              'X-File-Id':      fileId,
              'X-Token':        token,
              'X-Chunk-Index':  String(i),
              'X-Total-Chunks': String(totalChunks),
            },
            body:   chunk,
            signal: abortCtrl.signal,
          }
        );

        if (!uploadRes.ok) {
          const errText = await uploadRes.text().catch(() => '');
          io.emit('send-to-phone-progress', {
            pct: Math.round((i / totalChunks) * 100),
            status: 'error',
            error:  `Chunk ${i + 1}/${totalChunks} failed: HTTP ${uploadRes.status} ${errText}`,
            peerIP,
          });
          activeSendToPhone.delete(sessionId);
          return;
        }

        const pct = Math.round(((i + 1) / totalChunks) * 100);
        io.emit('send-to-phone-progress', { pct, status: 'uploading', sessionId, peerIP });
      }

      io.emit('send-to-phone-progress', { pct: 100, status: 'done', sessionId, fileName, peerIP });
      activeSendToPhone.delete(sessionId);
    } catch (err) {
      io.emit('send-to-phone-progress', {
        pct: 0, status: 'error', error: err.message,
        sessionId: sessionId || null, peerIP,
      });
      if (sessionId) activeSendToPhone.delete(sessionId);
    }
  })();
});

// Cancel a desktop→phone send in progress
localApp.post('/cancel-send-to-phone', express.json({ limit: '1kb' }), (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId && activeSendToPhone.has(sessionId)) {
    activeSendToPhone.get(sessionId).abort();
    activeSendToPhone.delete(sessionId);
  }
  res.json({ ok: true });
});

// Expose nearby UDP peers to the UI
const nearbyPeers = new Map();

localApp.get('/nearby-peers', (_, res) => {
  res.json(Array.from(nearbyPeers.values()));
});

// ─── Online socket.io signalling (port 3001) ──────────────────────────────────

const peers     = new Map();     // socketId → { id, name, swyftId, ip }
const transfers = new Map();     // transferId → { senderId, receiverId, meta }
const rooms     = new Map();     // pin → room

function broadcastPeerList() {
  const list = Array.from(peers.values());
  io.emit('peer-list', list);
}

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

io.on('connection', (socket) => {
  console.log('Signal connected:', socket.id);

  socket.on('announce', ({ name, swyftId } = {}, cb) => {
    const ip   = (socket.handshake.address || '').replace('::ffff:', '');
    const peer = { id: socket.id, name: name || 'Unknown Device', swyftId: swyftId || null, ip };
    peers.set(socket.id, peer);
    broadcastPeerList();
    cb?.({ success: true, id: socket.id });
    socket.emit('server-identity', { socketId: socket.id });
  });

  socket.on('request-transfer', ({ targetId, meta }, cb) => {
    const sender          = peers.get(socket.id);
    const resolvedSocketId = peers.has(targetId) ? targetId : null;
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

  // PIN room events (online WebRTC)
  socket.on('create-room', (offer, cb) => {
    const pin = generatePIN();
    rooms.set(pin, { senderId: socket.id, receiverId: null, offer, timestamp: Date.now() });
    cb({ success: true, pin });
  });

  socket.on('join-room', (pin, cb) => {
    const room = rooms.get(pin);
    if (!room)          return cb({ success: false, message: 'Invalid PIN' });
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

setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const [id, p] of nearbyPeers.entries()) {
    if (now - p.lastSeen > PEER_EXPIRY) { nearbyPeers.delete(id); changed = true; }
  }
  if (changed) io.emit('nearby-peers', Array.from(nearbyPeers.values()));
}, 2000);

function startDiscovery() {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('error', err => console.warn('[Discovery] UDP error:', err.message));

  // Bind to 0.0.0.0 so we receive on all interfaces
  udp.bind(MULTICAST_PORT, '0.0.0.0', () => {
    try {
      const interfaces = getFilteredLANInterfaces();
      if (interfaces.length === 0) {
        console.warn('[Discovery] No valid LAN interfaces found');
      }

      // Join multicast on EVERY valid LAN interface so we receive from any adapter
      for (const iface of interfaces) {
        try {
          udp.addMembership(MULTICAST_ADDR, iface.ip);
          console.log('[Discovery] Joined multicast:', iface.name, iface.ip);
        } catch (err) {
          console.warn('[Discovery] Failed joining', iface.name, iface.ip, err.message);
        }
      }

      // Set outbound interface to the BEST candidate (highest score = real WiFi NIC)
      // This prevents Windows routing multicast out through VirtualBox/Hyper-V adapters
      const primaryIP = interfaces[0]?.ip;
      if (primaryIP) {
        udp.setMulticastInterface(primaryIP);
        console.log('[Discovery] Primary outbound interface:', primaryIP);
      }

      udp.setMulticastTTL(128);
      udp.setMulticastLoopback(true);
    } catch (e) {
      console.warn('[Discovery] multicast setup:', e.message);
    }

    // Announce this device every 2 seconds
    const announce = () => {
      const payload = Buffer.from(JSON.stringify({
        alias:       DEVICE_NAME,
        version:     PROTOCOL_VERSION,
        deviceModel: `${os.type()} ${os.release()}`,
        deviceType:  'desktop',
        fingerprint: DEVICE_ID,
        port:        SWYFT_PORT,     // always 53317
        protocol:    'http',
        download:    true,
      }));
      udp.send(payload, 0, payload.length, MULTICAST_PORT, MULTICAST_ADDR, () => {});
    };

    announce();
    setInterval(announce, ANNOUNCE_INTERVAL);
    console.log('[Discovery] broadcasting as', DEVICE_NAME, 'on', MULTICAST_ADDR + ':' + MULTICAST_PORT);
  });

 udp.on('message', (msg, rinfo) => {
  try {
    const peer = JSON.parse(msg.toString());
    if (peer.fingerprint === DEVICE_ID)  return;
    if (peer.version !== PROTOCOL_VERSION) return;
    nearbyPeers.set(peer.fingerprint, {
      ...peer,
      ip:       rinfo.address,          // ← THIS is the real fix
      lastSeen: Date.now(),
      baseUrl:  `http://${rinfo.address}:${peer.port}`,
    });
    io.emit('nearby-peers', Array.from(nearbyPeers.values()));
  } catch (_) {}
});
}

// ─── Network / firewall diagnostics (Windows) ────────────────────────────────

signalApp.get('/network-check', (_, res) => {
  const result = {
    os: process.platform,
    networkProfile: null,
    udpBlocked:  false,
    tcpBlocked:  false,
    multicastProfileBlocked: false,
    virtualAdapterConflict:  false,
  };

  if (process.platform !== 'win32') return res.json(result);

  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory"',
      { timeout: 5000 }
    ).toString();
    result.networkProfile = /Public/i.test(out) ? 'Public' : /Domain/i.test(out) ? 'Domain' : 'Private';
  } catch (_) {}

  // Check UDP 53317 (discovery)
  try {
    const out = execSync('netsh advfirewall firewall show rule name="Swyft Discovery" dir=in', { timeout: 5000 }).toString();
    result.udpBlocked = !/Ok\./.test(out);
  } catch (_) { result.udpBlocked = true; }

  // Check TCP 53317 (transfer)
  try {
    const out = execSync('netsh advfirewall firewall show rule name="Swyft Server" dir=in', { timeout: 5000 }).toString();
    result.tcpBlocked = !/Ok\./.test(out);
  } catch (_) { result.tcpBlocked = true; }

  // Check profile-level multicast blocking
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-NetFirewallProfile | Select-Object -ExpandProperty AllowUnicastResponseToMulticast"',
      { timeout: 5000 }
    ).toString();
    if (/False/i.test(out)) result.multicastProfileBlocked = true;
  } catch (_) {}

  // Check for virtual adapter conflict
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-NetAdapter | Where-Object { $_.Status -eq \'Up\' } | Select-Object -ExpandProperty InterfaceDescription"',
      { timeout: 5000 }
    ).toString();
    if (/hyper-v|vmware|virtualbox|vethernet/i.test(out)) result.virtualAdapterConflict = true;
  } catch (_) {}

  res.json(result);
});

signalApp.post('/apply-firewall-fixes', (_, res) => {
  if (process.platform !== 'win32')
    return res.json({ success: true, message: 'Not Windows — no action needed' });

  const cmds = [
    // UDP 53317 — discovery
    'netsh advfirewall firewall add rule name="Swyft Discovery"     dir=in  action=allow protocol=UDP localport=53317',
    'netsh advfirewall firewall add rule name="Swyft Discovery Out" dir=out action=allow protocol=UDP localport=53317',
    // TCP 53317 — file transfer server
    'netsh advfirewall firewall add rule name="Swyft Server"        dir=in  action=allow protocol=TCP localport=53317',
    // Re-enable UnicastResponseToMulticast on all profiles
    'powershell -NoProfile -Command "Set-NetFirewallProfile -Profile Domain,Public,Private -AllowUnicastResponseToMulticast True"',
  ];

  let i = 0;
  function next() {
    if (i >= cmds.length) return res.json({ success: true });
    execCb(cmds[i++], { timeout: 8000 }, (err) => {
      if (err) return res.json({ success: false, message: err.message });
      next();
    });
  }
  next();
});

// ─── Start both servers ───────────────────────────────────────────────────────

// Local HTTP server on SWYFT_PORT (53317) — file transfers
localServer.listen(SWYFT_PORT, '0.0.0.0', () => {
  const lanIP = getLANIP();
  console.log(`[Swyft] Local HTTP server on http://${lanIP}:${SWYFT_PORT}  (${DEVICE_NAME})`);
  try { const b = new Bonjour(); b.publish({ name: 'Swyft', type: 'http', port: SWYFT_PORT }); }
  catch (e) { console.warn('mDNS failed:', e.message); }
});

// Signal server on SIGNAL_PORT (3001) — online WebRTC relay
signalServer.listen(SIGNAL_PORT, '0.0.0.0', () => {
  const lanIP = getLANIP();
  console.log(`[Swyft] Signal server on http://${lanIP}:${SIGNAL_PORT}`);
});

// Start UDP multicast discovery immediately — runs in parallel with TCP binding
startDiscovery();

// ── /session-response — called by the PHONE when user taps Accept/Decline ──────
// Replaces the polling pattern. Phone POSTs { sessionId, accepted, senderIP }
// to http://<desktop-ip>:53317/session-response. Desktop resolves the waiting
// promise in sendToPeer() immediately — no polling, no threading issues.

const sessionResponseResolvers = new Map(); // sessionId → { resolve, reject }

localApp.post('/session-response', (req, res) => {
  const { sessionId, accepted } = req.body || {};
  console.log('[session-response] sessionId:', sessionId, 'accepted:', accepted);
  if (!sessionId) return res.status(400).json({ message: 'Missing sessionId' });

  const resolver = sessionResponseResolvers.get(sessionId);
  if (resolver) {
    sessionResponseResolvers.delete(sessionId);
    resolver(!!accepted);
  }
  io.emit(accepted ? 'session-accepted-local' : 'session-declined-local', { sessionId });
  res.json({ ok: true });
});

// Called by sendToPeer()-equivalent in local.html via a helper exposed on the server.
// Returns a Promise<boolean> that resolves when the phone POSTs /session-response.
function waitForPhoneResponse(sessionId, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sessionResponseResolvers.delete(sessionId);
      reject(new Error('timeout'));
    }, timeoutMs);

    sessionResponseResolvers.set(sessionId, (accepted) => {
      clearTimeout(timer);
      resolve(accepted);
    });
  });
}

// Cancel a waiting resolver (e.g. user cancelled on desktop side)
function cancelPhoneResponseWait(sessionId) {
  const r = sessionResponseResolvers.get(sessionId);
  if (r) { sessionResponseResolvers.delete(sessionId); r(false); }
}

// Expose a REST endpoint so local.html can register a wait and receive the result
// via a long-poll. This keeps the browser from having to maintain a WebSocket
// purely for this — it just does a single long-poll fetch.
localApp.get('/wait-for-response', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ message: 'Missing sessionId' });
  try {
    const accepted = await waitForPhoneResponse(sessionId, 35000);
    res.json({ accepted });
  } catch (_) {
    res.json({ accepted: false, timedOut: true });
  }
});

module.exports = { localServer, signalServer, cancelPhoneResponseWait };