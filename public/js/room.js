/* ═══════════════════════════════════════════════════════════════
   room.js — WebRTC peer-to-peer video chat + YouTube sync
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── URL params ───────────────────────────────────────────────────
const params  = new URLSearchParams(window.location.search);
const ROOM_ID = (params.get('room') || 'UNKNOWN').toUpperCase();
const MY_NAME = decodeURIComponent(params.get('name') || 'You');

// ── State ────────────────────────────────────────────────────────
let localStream    = null;
let peerConnection = null;
let partnerId      = null;
let ytPlayer       = null;
let ytReady        = false;
let isFromServer   = false;   // flag to prevent sync loops
let isMuted        = false;
let isCamOff       = false;
let lastYtState    = -1;

// ── DOM refs ─────────────────────────────────────────────────────
const $  = id => document.getElementById(id);

const localVideo      = $('localVideo');
const remoteVideo     = $('remoteVideo');
const statusDot       = document.querySelector('.status-dot');
const statusText      = $('statusText');
const roomCodeEl      = $('roomCode');
const chatMessages    = $('chatMessages');
const chatInput       = $('chatInput');
const muteBtn         = $('muteBtn');
const muteBtnLabel    = $('muteBtnLabel');
const camBtn          = $('camBtn');
const camBtnLabel     = $('camBtnLabel');
const urlInput        = $('youtubeUrl');
const loadMovieBtn    = $('loadMovieBtn');
const myNoCam         = $('myNoCam');
const partnerNoCam    = $('partnerNoCam');
const partnerNameLbl  = $('partnerNameLabel');
const myNameLbl       = $('myNameLabel');

// ── Init UI ──────────────────────────────────────────────────────
if (roomCodeEl) roomCodeEl.textContent = ROOM_ID;
if (myNameLbl)  myNameLbl.textContent  = MY_NAME;

// ── Socket.IO ────────────────────────────────────────────────────
const socket = io();

// ── ICE servers (free public STUN) ───────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MEDIA — get camera + mic
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
async function startMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
    });
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Don't echo your own audio back
    myNoCam.classList.add('hidden');
  } catch (err) {
    console.warn('Camera/mic access denied or unavailable:', err.message);
    myNoCam.classList.remove('hidden');
    // App still works without camera
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   WEBRTC — peer connection
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function createPeerConnection() {
  // Clean up old connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  // Add local media tracks to the connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // Receive remote media tracks
  peerConnection.ontrack = (event) => {
    console.log('[WebRTC] Remote track received');
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      partnerNoCam.classList.add('hidden');
    }
  };

  // Send ICE candidates to partner via server
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && partnerId) {
      socket.emit('ice-candidate', { candidate: event.candidate, to: partnerId });
    }
  };

  // Monitor connection state
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('[WebRTC] Connection state:', state);
    if (state === 'connected') {
      setStatus('connected', `${partnerNameLbl.textContent} connected 💕`);
      showToast(`${partnerNameLbl.textContent} connected 💕`);
    } else if (state === 'failed') {
      setStatus('disconnected', 'Connection failed');
    }
  };

  return peerConnection;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SOCKET EVENTS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// Room joined successfully
socket.on('room-info', ({ userCount, movieState, otherUsers }) => {
  console.log(`[Room] Joined. Users: ${userCount}. Others: ${otherUsers.length}`);

  if (otherUsers.length > 0) {
    // Partner is already in room — wait for them to send us an offer
    setStatus('waiting', 'Connecting to partner…');
  } else {
    setStatus('waiting', 'Waiting for partner…');
  }

  // If a movie was already playing, sync to it once YouTube is ready
  if (movieState && movieState.videoId) {
    const trySync = () => {
      if (ytReady && ytPlayer) {
        isFromServer = true;
        ytPlayer.loadVideoById(movieState.videoId, movieState.time || 0);
        if (!movieState.playing) setTimeout(() => ytPlayer.pauseVideo(), 800);
        setTimeout(() => { isFromServer = false; }, 1500);
      } else {
        setTimeout(trySync, 500);
      }
    };
    setTimeout(trySync, 1000);
  }
});

// A user joined our room (we are the host — we send the offer)
socket.on('user-joined', async ({ userId, username }) => {
  console.log(`[Room] Partner joined: ${userId} (${username})`);
  partnerId = userId;

  if (username && username !== 'Anonymous') {
    partnerNameLbl.textContent = username;
  }

  setStatus('waiting', `${partnerNameLbl.textContent} connecting…`);
  addSysMsg(`💕 ${partnerNameLbl.textContent} has joined!`);

  // As the existing user, we initiate WebRTC
  const pc = createPeerConnection();
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { offer, to: userId });
    console.log('[WebRTC] Offer sent to', userId);
  } catch (err) {
    console.error('[WebRTC] Error creating offer:', err);
  }
});

// We received a WebRTC offer (we are the joiner — send answer)
socket.on('offer', async ({ offer, from }) => {
  console.log('[WebRTC] Received offer from', from);
  partnerId = from;

  const pc = createPeerConnection();
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { answer, to: from });
    console.log('[WebRTC] Answer sent to', from);
  } catch (err) {
    console.error('[WebRTC] Error handling offer:', err);
  }
});

// We received an answer to our offer
socket.on('answer', async ({ answer }) => {
  console.log('[WebRTC] Received answer');
  try {
    if (peerConnection && peerConnection.signalingState !== 'stable') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
  } catch (err) {
    console.error('[WebRTC] Error handling answer:', err);
  }
});

// ICE candidate received
socket.on('ice-candidate', async ({ candidate }) => {
  try {
    if (peerConnection && candidate) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('[WebRTC] Error adding ICE candidate:', err);
  }
});

// Partner left
socket.on('user-left', ({ userId }) => {
  if (userId === partnerId) {
    partnerId = null;
    setStatus('disconnected', 'Partner left 💔');
    addSysMsg('💔 Your partner has left…');
    showToast('Partner disconnected 💔');

    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    remoteVideo.srcObject = null;
    partnerNoCam.classList.remove('hidden');
  }
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MOVIE SYNC
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
socket.on('movie-sync', ({ action, time, videoId }) => {
  console.log('[Sync] Received:', action, time, videoId);
  if (!ytPlayer || !ytReady) return;

  isFromServer = true;

  try {
    if (action === 'load' && videoId) {
      ytPlayer.loadVideoById(videoId);
      $('moviePlaceholder')?.classList.add('hidden');

    } else if (action === 'play') {
      // Correct drift if more than 1 second off
      if (time !== undefined && Math.abs(ytPlayer.getCurrentTime() - time) > 1) {
        ytPlayer.seekTo(time, true);
      }
      ytPlayer.playVideo();

    } else if (action === 'pause') {
      if (time !== undefined) ytPlayer.seekTo(time, true);
      ytPlayer.pauseVideo();

    } else if (action === 'seek') {
      ytPlayer.seekTo(time, true);
    }
  } catch (err) {
    console.error('[Sync] Error applying sync:', err);
  }

  // Reset flag after a short delay (longer for load)
  setTimeout(() => { isFromServer = false; }, action === 'load' ? 2000 : 600);
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   YOUTUBE IFRAME API
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// Called by YouTube API when it's ready
window.onYouTubeIframeAPIReady = function () {
  console.log('[YT] IFrame API ready, creating player…');
  ytPlayer = new YT.Player('youtube-player', {
    height: '100%',
    width:  '100%',
    videoId: '',
    playerVars: {
      playsinline:     1,   // Critical for iOS inline playback
      rel:             0,
      modestbranding:  1,
      controls:        1,
      iv_load_policy:  3,
      origin: window.location.origin
    },
    events: {
      onReady:       onYtReady,
      onStateChange: onYtStateChange,
      onError:       onYtError
    }
  });
};

function onYtReady() {
  console.log('[YT] Player ready');
  ytReady = true;
}

function onYtStateChange(event) {
  if (isFromServer) return; // Don't echo server-triggered events

  const time  = ytPlayer.getCurrentTime();
  const state = event.data;

  // Avoid re-emitting the same state
  if (state === lastYtState) return;
  lastYtState = state;

  if (state === YT.PlayerState.PLAYING) {
    console.log('[YT] Playing at', time.toFixed(1));
    socket.emit('movie-action', { action: 'play', time });
    $('moviePlaceholder')?.classList.add('hidden');

  } else if (state === YT.PlayerState.PAUSED) {
    console.log('[YT] Paused at', time.toFixed(1));
    socket.emit('movie-action', { action: 'pause', time });
  }
}

function onYtError(event) {
  console.error('[YT] Player error:', event.data);
  showToast('Could not load video — try another URL ❌');
}

// Extract YouTube video ID from various URL formats
function extractYtId(input) {
  if (!input) return null;
  input = input.trim();

  // Raw 11-char video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  // YouTube URL patterns
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
  ];

  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

function loadYouTubeVideo() {
  const url     = urlInput?.value.trim();
  const videoId = extractYtId(url);

  if (!videoId) {
    showToast('Invalid YouTube URL — try again ❌');
    return;
  }

  if (!ytPlayer || !ytReady) {
    showToast('Player not ready yet — please wait…');
    return;
  }

  ytPlayer.loadVideoById(videoId);
  socket.emit('movie-action', { action: 'load', videoId });
  if (urlInput) urlInput.value = '';
  $('moviePlaceholder')?.classList.add('hidden');
  showToast('Movie loaded! 🎬 Enjoy your date night 💕');
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CHAT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
socket.on('chat-message', ({ message, username }) => {
  const isMe = username === MY_NAME;
  addChatBubble(message, username, isMe);
});

function sendChat() {
  const msg = chatInput?.value.trim();
  if (!msg) return;
  socket.emit('chat-message', { message: msg, username: MY_NAME });
  chatInput.value = '';
}

function addChatBubble(message, username, isMe) {
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = `chat-msg ${isMe ? 'mine' : 'theirs'}`;
  div.innerHTML = `
    <div class="chat-bubble">
      <span class="chat-name">${esc(username)}</span>
      ${esc(message)}
    </div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSysMsg(text) {
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = 'sys-msg';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MIC / CAM CONTROLS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  muteBtn.classList.toggle('muted', isMuted);
  muteBtn.setAttribute('aria-pressed', isMuted);
  muteBtnLabel.textContent = isMuted ? 'Unmute' : 'Mute';
  muteBtn.firstChild.textContent = isMuted ? '🔇 ' : '🎤 ';
  showToast(isMuted ? 'Microphone muted 🔇' : 'Microphone on 🎤');
}

function toggleCam() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !isCamOff; });
  camBtn.classList.toggle('cam-off', isCamOff);
  camBtn.setAttribute('aria-pressed', isCamOff);
  camBtnLabel.textContent = isCamOff ? 'Cam on' : 'Cam off';
  showToast(isCamOff ? 'Camera off 📷' : 'Camera on 📸');
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   UI HELPERS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function setStatus(type, text) {
  if (statusDot) {
    statusDot.className = `status-dot ${type}`;
  }
  if (statusText) statusText.textContent = text;
}

let activeToast = null;
function showToast(msg) {
  // Remove existing toast
  if (activeToast) {
    activeToast.remove();
    activeToast = null;
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  activeToast = el;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => { el.classList.add('show'); });
  });

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { if (el.parentNode) el.remove(); if (activeToast === el) activeToast = null; }, 350);
  }, 3200);
}

function copyRoomCode() {
  navigator.clipboard.writeText(ROOM_ID)
    .then(() => showToast('Room code copied! Share it with your partner 📋'))
    .catch(() => {
      // Fallback for browsers that block clipboard
      showToast(`Room code: ${ROOM_ID}`);
    });
}

function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   EVENT LISTENERS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
document.addEventListener('DOMContentLoaded', () => {
  // Movie controls
  loadMovieBtn?.addEventListener('click', loadYouTubeVideo);
  urlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') loadYouTubeVideo(); });

  // Chat
  $('sendChatBtn')?.addEventListener('click', sendChat);
  chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // Mic / cam
  muteBtn?.addEventListener('click', toggleMute);
  camBtn?.addEventListener('click', toggleCam);

  // Copy room code
  $('copyRoomBtn')?.addEventListener('click', copyRoomCode);
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   BOOT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// Join the room on the server
socket.emit('join-room', { roomId: ROOM_ID, username: MY_NAME });

// Start camera
startMedia();

// Welcome message in chat
setTimeout(() => {
  addSysMsg(`🌹 Welcome to your date night room, ${MY_NAME}!`);
  addSysMsg(`📋 Share room code "${ROOM_ID}" with your partner`);
}, 300);

console.log(`[CineDate] Room: ${ROOM_ID} | Name: ${MY_NAME}`);
