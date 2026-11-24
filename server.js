const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Clean web app & room routes
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// Dynamic ICE servers endpoint (Supports Metered TURN API or fallback multi-port TURN)
let cachedIceServers = null;
let lastIceFetch = 0;

const METERED_ICE_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: '4cd75a09306f8020f3e74bf4',
    credential: '3j3MnH80VvVMLupC'
  },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: '4cd75a09306f8020f3e74bf4',
    credential: '3j3MnH80VvVMLupC'
  },
  {
    urls: 'turn:global.relay.metered.ca:443',
    username: '4cd75a09306f8020f3e74bf4',
    credential: '3j3MnH80VvVMLupC'
  },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: '4cd75a09306f8020f3e74bf4',
    credential: '3j3MnH80VvVMLupC'
  }
];

app.get('/api/ice-servers', async (req, res) => {
  const apiKey = process.env.METERED_API_KEY;
  const appName = process.env.METERED_APP_NAME || 'cindate';

  if (apiKey) {
    if (cachedIceServers && Date.now() - lastIceFetch < 600000) {
      return res.json({ iceServers: cachedIceServers });
    }
    try {
      const response = await fetch(`https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
      if (response.ok) {
        cachedIceServers = await response.json();
        lastIceFetch = Date.now();
        console.log('[Metered] Fresh regional TURN servers fetched successfully');
        return res.json({ iceServers: cachedIceServers });
      }
    } catch (err) {
      console.warn('[Metered] Failed to fetch dynamic credentials:', err.message);
    }
  }

  // Fallback to high-reliability Metered dedicated TURN servers
  res.json({ iceServers: METERED_ICE_SERVERS });
});

// In-memory room state
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[+] User connected: ${socket.id}`);

  // ── JOIN ROOM ──────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, username }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username || 'Anonymous';

    if (!rooms[roomId]) {
      rooms[roomId] = {
        users: [],
        movieState: { videoId: null, time: 0, playing: false }
      };
    }

    rooms[roomId].users.push(socket.id);
    const otherUsers = rooms[roomId].users.filter(id => id !== socket.id);

    // Tell this user about the room
    socket.emit('room-info', {
      userCount: rooms[roomId].users.length,
      movieState: rooms[roomId].movieState,
      otherUsers
    });

    // Tell existing users someone joined
    socket.to(roomId).emit('user-joined', { userId: socket.id, username: socket.username });

    console.log(`[~] ${socket.username} joined room ${roomId} (${rooms[roomId].users.length} users)`);
  });

  // ── WEBRTC SIGNALING ───────────────────────────────────────────
  socket.on('offer', ({ offer, to }) => {
    socket.to(to).emit('offer', { offer, from: socket.id });
  });

  socket.on('answer', ({ answer, to }) => {
    socket.to(to).emit('answer', { answer, from: socket.id });
  });

  socket.on('ice-candidate', ({ candidate, to }) => {
    socket.to(to).emit('ice-candidate', { candidate, from: socket.id });
  });

  // ── MOVIE SYNC ─────────────────────────────────────────────────
  socket.on('movie-action', ({ action, time, videoId }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    // Update room movie state
    if (action === 'load' && videoId) rooms[roomId].movieState.videoId = videoId;
    if (time !== undefined) rooms[roomId].movieState.time = time;
    if (action === 'play') rooms[roomId].movieState.playing = true;
    if (action === 'pause') rooms[roomId].movieState.playing = false;

    // Relay to others in room
    socket.to(roomId).emit('movie-sync', { action, time, videoId });
  });

  // ── CHAT ───────────────────────────────────────────────────────
  socket.on('chat-message', ({ message, username }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    io.to(roomId).emit('chat-message', { message, username, timestamp: Date.now() });
  });

  // ── DISCONNECT ─────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] User disconnected: ${socket.id}`);
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].users = rooms[roomId].users.filter(id => id !== socket.id);
      if (rooms[roomId].users.length === 0) {
        delete rooms[roomId];
        console.log(`[x] Room ${roomId} deleted (empty)`);
      } else {
        socket.to(roomId).emit('user-left', { userId: socket.id });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n💕 CineDate is running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: Open on your phone using your computer's IP\n`);
});
