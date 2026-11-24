/* ═══════════════════════════════════════════════════════════════
   room.js — WebRTC peer-to-peer video chat + YouTube sync
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── URL params ───────────────────────────────────────────────────
const params  = new URLSearchParams(window.location.search);
const ROOM_ID = (params.get('room') || 'UNKNOWN').toUpperCase();
const MY_NAME = decodeURIComponent(params.get('name') || 'You');

// ── State ────────────────────────────────────────────────────────
let localStream         = null;
let peerConnection      = null;
let partnerId           = null;
let ytPlayer            = null;
let ytReady             = false;
let isMuted             = false;
let isCamOff            = false;
let currentPlayingState = false;
let ignoreEventsUntil   = 0;
let lastYtState         = -1;
let pendingMovieSync    = null;

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

// ── ICE servers (Metered Regional Enterprise TURN + STUN) ──────────
const ICE_CONFIG = {
  iceServers: [
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
  ],
  iceCandidatePoolSize: 10
};

let iceCandidateQueue   = [];
let connectionWatchdog  = null;

function scheduleWatchdog() {
  if (connectionWatchdog) clearTimeout(connectionWatchdog);
  connectionWatchdog = setTimeout(() => {
    if (partnerId && peerConnection && (peerConnection.connectionState === 'failed' || peerConnection.iceConnectionState === 'failed')) {
      console.log('[WebRTC] Watchdog retrying connection with ICE restart for partner:', partnerId);
      initiateCall(partnerId, true);
    }
  }, 8000);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MEDIA — get camera + mic
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
async function startMedia() {
  try {
    // Primary constraints (works on iOS, modern Android, Desktop)
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (err) {
    console.warn('[Media] Strict audio constraints failed, trying basic audio/video:', err.message);
    try {
      // Fallback for Android hardware HALs that fail on custom constraints
      localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
    } catch (fallbackErr) {
      console.warn('[Media] Camera/mic access denied or unavailable:', fallbackErr.message);
      myNoCam.classList.remove('hidden');
    }
  }

  if (localStream) {
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Don't echo your own audio back
    myNoCam.classList.add('hidden');

    // Ensure audio tracks are enabled explicitly
    localStream.getAudioTracks().forEach(t => {
      t.enabled = true;
      console.log('[Media] Audio track active:', t.label);
    });

    // If a peerConnection is already open, attach local tracks now
    if (peerConnection) {
      localStream.getTracks().forEach(track => {
        const senders = peerConnection.getSenders();
        if (!senders.some(s => s.track && s.track.kind === track.kind)) {
          peerConnection.addTrack(track, localStream);
          console.log('[WebRTC] Attached track to active connection:', track.kind);
        }
      });
    }

    // Start speaking visualizer (cam circle glows when speaking)
    setupAudioIndicator(localStream);
  }
}

// Android Web Audio speaking indicator
function setupAudioIndicator(stream) {
  try {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks || audioTracks.length === 0) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const audioCtx = new AudioContextClass();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.4;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function checkAudio() {
      if (isMuted) {
        $('myCamCircle')?.classList.remove('speaking');
        requestAnimationFrame(checkAudio);
        return;
      }

      analyser.getByteFrequencyData(dataArray);
      let total = 0;
      for (let i = 0; i < bufferLength; i++) {
        total += dataArray[i];
      }
      const avg = total / bufferLength;

      if (avg > 18) {
        $('myCamCircle')?.classList.add('speaking');
      } else {
        $('myCamCircle')?.classList.remove('speaking');
      }

      requestAnimationFrame(checkAudio);
    }

    checkAudio();
  } catch (err) {
    console.warn('[Audio] Audio indicator init:', err);
  }
}

// Android Chrome Autoplay Audio Unlocker
function unlockAudioPlayback() {
  const remoteAudio = $('remoteAudio');
  if (remoteAudio && remoteAudio.paused) {
    remoteAudio.play().catch(() => {});
  }
  if (remoteVideo && remoteVideo.paused) {
    remoteVideo.play().catch(() => {});
  }
}
document.addEventListener('click', unlockAudioPlayback, { passive: true });
document.addEventListener('touchstart', unlockAudioPlayback, { passive: true });

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   WEBRTC — peer connection & candidate queue
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

async function drainCandidateQueue() {
  if (!peerConnection || !peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
    return;
  }
  console.log(`[WebRTC] Processing ${iceCandidateQueue.length} queued ICE candidates`);
  while (iceCandidateQueue.length > 0) {
    const candidate = iceCandidateQueue.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[WebRTC] Error adding queued ICE candidate:', err);
    }
  }
}

function createPeerConnection() {
  // Clean up old connection
  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
    peerConnection = null;
  }

  iceCandidateQueue = [];
  window.remoteMediaStream = new MediaStream();
  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  // Add local media tracks to the connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
      console.log('[WebRTC] Added local track to PC:', track.kind);
    });
  }

  // Receive remote media tracks (supports both event.streams and event.track)
  peerConnection.ontrack = (event) => {
    console.log('[WebRTC] Remote track received:', event.track.kind);
    let stream = (event.streams && event.streams[0]) ? event.streams[0] : null;
    if (!stream) {
      window.remoteMediaStream.addTrack(event.track);
      stream = window.remoteMediaStream;
    }

    if (remoteVideo.srcObject !== stream) {
      remoteVideo.srcObject = stream;
    }
    remoteVideo.muted = false;
    remoteVideo.volume = 1.0;
    remoteVideo.play().catch(e => console.log('[WebRTC] video play:', e));

    // Dedicated audio element (critical for Android Chrome)
    const remoteAudio = $('remoteAudio');
    if (remoteAudio) {
      if (remoteAudio.srcObject !== stream) {
        remoteAudio.srcObject = stream;
      }
      remoteAudio.muted = false;
      remoteAudio.volume = 1.0;
      remoteAudio.play().catch(e => console.log('[WebRTC] audio play:', e));
    }

    partnerNoCam.classList.add('hidden');
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
      if (connectionWatchdog) clearTimeout(connectionWatchdog);
      setStatus('connected', `${partnerNameLbl.textContent} connected 💕`);
      showToast(`${partnerNameLbl.textContent} connected 💕`);
      unlockAudioPlayback();
    } else if (state === 'connecting') {
      setStatus('waiting', `Connecting to ${partnerNameLbl.textContent}…`);
      scheduleWatchdog();
    } else if (state === 'failed') {
      setStatus('disconnected', 'Connection failed ⚠️ (Tap to retry)');
      scheduleWatchdog();
    } else if (state === 'disconnected') {
      setStatus('disconnected', 'Reconnecting… 🔄 (Tap to retry)');
      scheduleWatchdog();
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log('[WebRTC] ICE state:', peerConnection.iceConnectionState);
    if (peerConnection.iceConnectionState === 'failed') {
      peerConnection.restartIce?.();
      scheduleWatchdog();
    }
  };

  return peerConnection;
}

// Unified call initiator (supports ICE restart)
async function initiateCall(targetUserId, isRestart = false) {
  if (!targetUserId) return;
  console.log('[WebRTC] Initiating call to', targetUserId, 'restart:', isRestart);
  partnerId = targetUserId;
  const pc = createPeerConnection();

  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
      iceRestart: isRestart
    });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { offer, to: targetUserId });
    console.log('[WebRTC] Offer sent to', targetUserId);
    scheduleWatchdog();
  } catch (err) {
    console.error('[WebRTC] Error creating offer:', err);
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SOCKET EVENTS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// Room joined successfully
socket.on('room-info', ({ userCount, movieState, otherUsers }) => {
  console.log(`[Room] Joined. Users: ${userCount}. Others: ${otherUsers.length}`);

  if (otherUsers.length > 0) {
    partnerId = otherUsers[0];
    setStatus('waiting', 'Connecting to partner…');
    // The existing user in room initiates the call on 'user-joined'.
    // We only initiate as a safety fallback if no connection was attempted after 4s.
    setTimeout(() => {
      if (partnerId && !peerConnection) {
        console.log('[WebRTC] Fallback handshake initiator with peer:', partnerId);
        initiateCall(partnerId);
      }
    }, 4000);
  } else {
    setStatus('waiting', 'Waiting for partner…');
  }

  // If a movie was already playing or loaded, sync to it
  if (movieState && movieState.videoId) {
    applyMovieSync({
      action: 'load',
      videoId: movieState.videoId,
      time: movieState.time || 0
    });
    if (movieState.playing === false) {
      setTimeout(() => applyMovieSync({ action: 'pause' }), 1200);
    }
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

  // Initiate WebRTC call to the joining user
  await initiateCall(userId);
  scheduleWatchdog();
});

// We received a WebRTC offer (we are the joiner — send answer)
socket.on('offer', async ({ offer, from }) => {
  console.log('[WebRTC] Received offer from', from);
  partnerId = from;

  const pc = createPeerConnection();
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await drainCandidateQueue();

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
      await drainCandidateQueue();
      console.log('[WebRTC] Remote answer set and queue drained');
    }
  } catch (err) {
    console.error('[WebRTC] Error handling answer:', err);
  }
});

// ICE candidate received (queued if remoteDescription not ready)
socket.on('ice-candidate', async ({ candidate }) => {
  if (!candidate) return;
  if (!peerConnection || !peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
    console.log('[WebRTC] Queuing ICE candidate (remoteDescription not ready)');
    iceCandidateQueue.push(candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
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

function applyMovieSync(data) {
  if (!data) return;
  const { action, time, videoId } = data;

  if (!ytPlayer || !ytReady) {
    console.log('[Sync] Player not initialized yet, queued pending movie sync:', action, videoId);
    pendingMovieSync = data;
    return;
  }

  // Ignore self-triggered player events during remote sync execution
  ignoreEventsUntil = Date.now() + 1500;

  try {
    if (action === 'load' && videoId) {
      ignoreEventsUntil = Date.now() + 2500;
      console.log('[Sync] Executing video load:', videoId, 'time:', time || 0);
      ytPlayer.loadVideoById(videoId, time || 0);
      currentPlayingState = true;
      updatePlayPauseBtn(true);
      $('moviePlaceholder')?.classList.add('hidden');
      showToast('Movie loaded! 🎬');

    } else if (action === 'play') {
      currentPlayingState = true;
      updatePlayPauseBtn(true);

      const myTime = (ytPlayer.getCurrentTime && typeof ytPlayer.getCurrentTime === 'function')
        ? ytPlayer.getCurrentTime()
        : 0;

      // Align time when resuming playback
      if (time !== undefined && Math.abs(myTime - time) > 1.2) {
        ytPlayer.seekTo(time, true);
      }
      ytPlayer.playVideo();
      console.log('[Sync] Video playing in sync at', time);

    } else if (action === 'pause') {
      currentPlayingState = false;
      updatePlayPauseBtn(false);

      // Crucial: ALWAYS pause without seekTo (seeking on mobile causes auto-play!)
      ytPlayer.pauseVideo();
      setTimeout(() => { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); }, 150);
      setTimeout(() => { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); }, 450);
      console.log('[Sync] Video firmly paused');

    } else if (action === 'seek') {
      if (time !== undefined) {
        ytPlayer.seekTo(time, true);
        if (!currentPlayingState) {
          setTimeout(() => {
            if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
          }, 150);
        }
      }
    }
  } catch (err) {
    console.error('[Sync] Error applying sync:', err);
  }
}

socket.on('movie-sync', (data) => {
  console.log('[Sync] Received from partner:', data);
  applyMovieSync(data);
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
  if (pendingMovieSync) {
    console.log('[YT] Executing pending movie sync after player ready:', pendingMovieSync);
    applyMovieSync(pendingMovieSync);
    pendingMovieSync = null;
  }
}

function onYtStateChange(event) {
  const state = event.data;

  // Ignore events while executing a server sync command
  if (Date.now() < ignoreEventsUntil) {
    if (state === YT.PlayerState.PLAYING) currentPlayingState = true;
    if (state === YT.PlayerState.PAUSED)  currentPlayingState = false;
    updatePlayPauseBtn(currentPlayingState);
    return;
  }

  // Ignore buffering (-1, 3, 5) — not user actions
  if (state === YT.PlayerState.BUFFERING || state === -1 || state === 5) {
    return;
  }

  const time = (ytPlayer.getCurrentTime && typeof ytPlayer.getCurrentTime === 'function')
    ? ytPlayer.getCurrentTime()
    : 0;

  if (state === YT.PlayerState.PLAYING) {
    if (currentPlayingState === true) return; // already in playing state
    currentPlayingState = true;
    updatePlayPauseBtn(true);
    console.log('[YT] User clicked PLAY at', time.toFixed(1));
    socket.emit('movie-action', { action: 'play', time });
    $('moviePlaceholder')?.classList.add('hidden');

  } else if (state === YT.PlayerState.PAUSED) {
    if (currentPlayingState === false) return; // already in paused state
    currentPlayingState = false;
    updatePlayPauseBtn(false);
    console.log('[YT] User clicked PAUSE at', time.toFixed(1));
    socket.emit('movie-action', { action: 'pause', time });
  }
}

function onYtError(event) {
  console.error('[YT] Player error:', event.data);
  showToast('Could not load video — try another URL ❌');
}

// ── Synced Button Controls ─────────────────────────────────────────
function updatePlayPauseBtn(isPlaying) {
  const icon = $('playPauseIcon');
  const text = $('playPauseText');
  if (icon) icon.textContent = isPlaying ? '⏸' : '▶';
  if (text) text.textContent = isPlaying ? 'Pause for both' : 'Play for both';
}

function togglePlayPause() {
  if (!ytPlayer || !ytReady) {
    showToast('Load a movie first! 🎬');
    return;
  }

  const myTime = (ytPlayer.getCurrentTime && typeof ytPlayer.getCurrentTime === 'function')
    ? ytPlayer.getCurrentTime()
    : 0;

  if (currentPlayingState) {
    // Currently playing -> pause for both
    currentPlayingState = false;
    ignoreEventsUntil = Date.now() + 1500;
    ytPlayer.pauseVideo();
    setTimeout(() => { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); }, 150);
    setTimeout(() => { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); }, 400);
    updatePlayPauseBtn(false);
    socket.emit('movie-action', { action: 'pause', time: myTime });
    showToast('Paused for both ⏸');
  } else {
    // Currently paused -> play for both
    currentPlayingState = true;
    ignoreEventsUntil = Date.now() + 1500;
    ytPlayer.playVideo();
    updatePlayPauseBtn(true);
    socket.emit('movie-action', { action: 'play', time: myTime });
    showToast('Playing for both ▶');
  }
}

function seekDelta(seconds) {
  if (!ytPlayer || !ytReady) return;
  const myTime = (ytPlayer.getCurrentTime && typeof ytPlayer.getCurrentTime === 'function')
    ? ytPlayer.getCurrentTime()
    : 0;
  const target = Math.max(0, myTime + seconds);
  ignoreEventsUntil = Date.now() + 1200;
  ytPlayer.seekTo(target, true);
  if (!currentPlayingState) {
    setTimeout(() => {
      if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
    }, 150);
  }
  socket.emit('movie-action', { action: 'seek', time: target });
  showToast(`${seconds > 0 ? '+10s ⏩' : '-10s ⏪'}`);
}

function forceSync() {
  if (!ytPlayer || !ytReady) return;
  const myTime = (ytPlayer.getCurrentTime && typeof ytPlayer.getCurrentTime === 'function')
    ? ytPlayer.getCurrentTime()
    : 0;
  socket.emit('movie-action', {
    action: currentPlayingState ? 'play' : 'pause',
    time: myTime
  });
  showToast('Resynced with partner! 🔄');
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
    showToast('Player initializing… loading in 2 seconds 🎬');
    pendingMovieSync = { action: 'load', videoId };
    socket.emit('movie-action', { action: 'load', videoId });
    if (urlInput) urlInput.value = '';
    return;
  }

  ignoreEventsUntil = Date.now() + 2500;
  ytPlayer.loadVideoById(videoId, 0);
  currentPlayingState = true;
  updatePlayPauseBtn(true);
  socket.emit('movie-action', { action: 'load', videoId });
  if (urlInput) urlInput.value = '';
  $('moviePlaceholder')?.classList.add('hidden');
  showToast('Movie loaded! 🎬 Enjoy your date night 💕');
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CHAT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
let isDrawerOpen = false;
let unreadCount  = 0;

function toggleChatDrawer(open) {
  const chatPanel = $('chatPanel');
  const backdrop  = $('chatBackdrop');
  const badge     = $('chatBadge');

  if (open === undefined) open = !isDrawerOpen;
  isDrawerOpen = open;

  if (isDrawerOpen) {
    chatPanel?.classList.add('drawer-open');
    backdrop?.classList.add('active');
    unreadCount = 0;
    if (badge) {
      badge.textContent = '0';
      badge.classList.add('hidden');
    }
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    setTimeout(() => $('chatInput')?.focus(), 250);
  } else {
    chatPanel?.classList.remove('drawer-open');
    backdrop?.classList.remove('active');
  }
}

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

  // On mobile: if partner sent a message, notify and update badge
  if (!isMe && !isDrawerOpen) {
    unreadCount++;
    const badge = $('chatBadge');
    if (badge) {
      badge.textContent = unreadCount;
      badge.classList.remove('hidden');
    }
    showToast(`💬 ${username}: ${message.length > 25 ? message.substring(0, 25) + '…' : message}`);
  }
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
  // Movie controls & Synced Buttons
  loadMovieBtn?.addEventListener('click', loadYouTubeVideo);
  urlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') loadYouTubeVideo(); });
  $('btnPlayPause')?.addEventListener('click', togglePlayPause);
  $('btnRewind')?.addEventListener('click', () => seekDelta(-10));
  $('btnForward')?.addEventListener('click', () => seekDelta(10));
  $('btnSync')?.addEventListener('click', forceSync);

  // Chat
  $('sendChatBtn')?.addEventListener('click', sendChat);
  chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // Mobile Chat Drawer & FAB
  $('mobileChatFab')?.addEventListener('click', () => toggleChatDrawer(true));
  $('closeChatBtn')?.addEventListener('click', () => toggleChatDrawer(false));
  $('chatBackdrop')?.addEventListener('click', () => toggleChatDrawer(false));

  // Mic / cam
  muteBtn?.addEventListener('click', toggleMute);
  camBtn?.addEventListener('click', toggleCam);

  // Copy room code
  $('copyRoomBtn')?.addEventListener('click', copyRoomCode);

  // Spicy Date Alert dismiss button
  $('closeSpicyAlertBtn')?.addEventListener('click', () => {
    $('spicyAlertModal')?.classList.add('hidden');
    unlockAudioPlayback();
    showToast('Enjoy your date night 💕🍿');
  });

  // Reconnect on tapping status badge
  $('connectionStatus')?.addEventListener('click', () => {
    if (partnerId) {
      showToast('Reconnecting call… 🔄');
      initiateCall(partnerId, true);
    } else {
      showToast('Waiting for partner to join room first…');
    }
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   BOOT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// Fetch dynamic regional cloud TURN servers (e.g. Metered / Multi-Cloud)
fetch('/api/ice-servers')
  .then(res => res.json())
  .then(data => {
    if (data && data.iceServers && data.iceServers.length > 0) {
      ICE_CONFIG.iceServers = data.iceServers;
      console.log(`[ICE] Configured ${data.iceServers.length} cloud relay servers`);
    }
  })
  .catch(err => console.warn('[ICE] Using default servers:', err));

// Start camera first, then announce join so tracks are ready for handshake
startMedia().finally(() => {
  socket.emit('join-room', { roomId: ROOM_ID, username: MY_NAME });
});

// Welcome message in chat
setTimeout(() => {
  addSysMsg(`🌹 Welcome to your date night room, ${MY_NAME}!`);
  addSysMsg(`📋 Share room code "${ROOM_ID}" with your partner`);
}, 300);

console.log(`[CineDate] Room: ${ROOM_ID} | Name: ${MY_NAME}`);
