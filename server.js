const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// ICE servers endpoint — tries Metered first, falls back to Xirsys if Metered fails/empty.
// All credentials are read from Render environment variables — never hardcoded.
app.get('/ice-servers', async (req, res) => {
  const meteredApiKey  = process.env.METERED_API_KEY;
  const meteredAppName = process.env.METERED_APP_NAME;
  const xirsysIdent    = process.env.XIRSYS_IDENT;
  const xirsysSecret   = process.env.XIRSYS_SECRET;
  const xirsysChannel  = process.env.XIRSYS_CHANNEL;

  const stun = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  // Helper: fetch from Metered
  async function fetchMetered() {
    if (!meteredApiKey || !meteredAppName) return null;
    try {
      const r = await fetch(
        `https://${meteredAppName}.metered.live/api/v1/turn/credentials?apiKey=${meteredApiKey}`
      );
      const servers = await r.json();
      if (Array.isArray(servers) && servers.length > 0) {
        console.log('✅ Using Metered TURN servers');
        return servers;
      }
      return null;
    } catch (e) {
      console.warn('Metered failed:', e.message);
      return null;
    }
  }

  // Helper: fetch from Xirsys
  async function fetchXirsys() {
    if (!xirsysIdent || !xirsysSecret || !xirsysChannel) return null;
    try {
      const auth = Buffer.from(`${xirsysIdent}:${xirsysSecret}`).toString('base64');
      const r = await fetch(`https://global.xirsys.net/_turn/${xirsysChannel}`, {
        method: 'PUT',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'urls' })
      });
      const data = await r.json();
      const servers = data.v?.iceServers;
      if (Array.isArray(servers) && servers.length > 0) {
        console.log('✅ Using Xirsys TURN servers (Metered fallback)');
        return servers;
      }
      return null;
    } catch (e) {
      console.warn('Xirsys failed:', e.message);
      return null;
    }
  }

  try {
    // Try Metered first, then Xirsys, then STUN-only
    const turnServers = (await fetchMetered()) || (await fetchXirsys()) || [];
    const iceServers = [...stun, ...turnServers];
    console.log(`Serving ${iceServers.length} ICE servers (${turnServers.length} TURN)`);
    res.json(iceServers);
  } catch (err) {
    console.error('ICE endpoint error:', err.message);
    res.json(stun);
  }
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
});