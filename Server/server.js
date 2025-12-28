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
      if (room.senderId === socket.id || room.receiverId === socket.id) {
        rooms.delete(pin);
        console.log(`Cleaned up room: ${pin}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Swyft Server running on http://localhost:${PORT}`);
});