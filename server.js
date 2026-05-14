const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fetch = require('node-fetch');

console.log('Node version:', process.version);

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Global CORS — allows requests from any origin (Vercel, local, etc.)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// ICE servers endpoint
app.get('/ice-servers', async (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80',                    username: process.env.METERED_USERNAME, credential: process.env.METERED_CREDENTIAL },
    { urls: 'turn:global.relay.metered.ca:80?transport=tcp',      username: process.env.METERED_USERNAME, credential: process.env.METERED_CREDENTIAL },
    { urls: 'turn:global.relay.metered.ca:443',                   username: process.env.METERED_USERNAME, credential: process.env.METERED_CREDENTIAL },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp',    username: process.env.METERED_USERNAME, credential: process.env.METERED_CREDENTIAL },
  ];

  // Add Xirsys as extra TURN servers if configured
  const xirsysIdent   = process.env.XIRSYS_IDENT;
  const xirsysSecret  = process.env.XIRSYS_SECRET;
  const xirsysChannel = process.env.XIRSYS_CHANNEL;

  if (xirsysIdent && xirsysSecret && xirsysChannel) {
    try {
      const auth = Buffer.from(`${xirsysIdent}:${xirsysSecret}`).toString('base64');
      const r = await fetch(`https://global.xirsys.net/_turn/${xirsysChannel}`, {
        method: 'PUT',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'urls' })
      });
      const data = await r.json();
      const xirsysServers = data.v?.iceServers;
      if (Array.isArray(xirsysServers) && xirsysServers.length > 0) {
        iceServers.push(...xirsysServers);
        console.log('✅ Xirsys servers added:', xirsysServers.length);
      }
    } catch (e) {
      console.warn('Xirsys fetch failed:', e.message);
    }
  }

  console.log(`Serving ${iceServers.length} ICE servers`);
  res.json(iceServers);
});


// Store active rooms
const rooms = new Map();

// Generate 6-digit PIN
function generatePIN() {
  let pin;
  do {
    pin = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(pin));
  return pin;
}

// Clean up old rooms (10 minutes)
setInterval(() => {
  const now = Date.now();
  const TEN_MINUTES = 10 * 60 * 1000;
  
  for (const [pin, room] of rooms.entries()) {
    if (now - room.timestamp > TEN_MINUTES) {
      rooms.delete(pin);
      console.log(`Cleaned up room: ${pin}`);
    }
  }
}, 60000);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Create room with offer
  socket.on('create-room', (offer, callback) => {
    const pin = generatePIN();
    
    rooms.set(pin, {
      offer: offer,
      answer: null,
      senderId: socket.id,
      receiverId: null,
      timestamp: Date.now()
    });
    
    console.log(`Room created: ${pin}`);
    
    callback({ success: true, pin: pin });
  });

  // Join room with PIN
  socket.on('join-room', (pin, callback) => {
    const room = rooms.get(pin);
    
    if (!room) {
      callback({ success: false, message: 'Invalid PIN' });
      return;
    }
    
    if (room.receiverId) {
      callback({ success: false, message: 'Room full' });
      return;
    }
    
    room.receiverId = socket.id;
    console.log(`Client joined room: ${pin}`);
    
    callback({ success: true, offer: room.offer });
  });

  // Send answer
  socket.on('send-answer', (data, callback) => {
    const { pin, answer } = data;
    const room = rooms.get(pin);
    
    if (!room) {
      callback({ success: false, message: 'Room not found' });
      return;
    }
    
    room.answer = answer;
    
    // Notify sender
    io.to(room.senderId).emit('answer-ready', { answer, pin });
    
    console.log(`Answer sent for room: ${pin}`);
    callback({ success: true });
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
  console.log('Client disconnected:', socket.id);

  for (const [pin, room] of rooms.entries()) {
    if (room.senderId === socket.id) {
      rooms.delete(pin);
      console.log(`Cleaned up room (sender left): ${pin}`);
    } else if (room.receiverId === socket.id) {
      room.receiverId = null;
      console.log(`Receiver left room: ${pin}`);
    }
  }
});
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Swyft Server running on http://localhost:${PORT}`);
  console.log('ENV CHECK → METERED_USERNAME:', process.env.METERED_USERNAME || 'NOT SET');
  console.log('ENV CHECK → METERED_CREDENTIAL:', process.env.METERED_CREDENTIAL ? '✅ set' : 'NOT SET');
  console.log('ENV CHECK → XIRSYS_IDENT:', process.env.XIRSYS_IDENT || 'NOT SET');
  console.log('ENV CHECK → XIRSYS_SECRET:', process.env.XIRSYS_SECRET ? '✅ set' : 'NOT SET');
  console.log('ENV CHECK → XIRSYS_CHANNEL:', process.env.XIRSYS_CHANNEL || 'NOT SET');
});