/* ═══════════════════════════════════════════════
   index.js — Landing page logic
   ═══════════════════════════════════════════════ */

// ── Starfield canvas ───────────────────────────
const canvas = document.getElementById('starfield');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// Generate stars
const STAR_COUNT = 180;
const stars = Array.from({ length: STAR_COUNT }, () => ({
  x:    Math.random() * canvas.width,
  y:    Math.random() * canvas.height,
  r:    Math.random() * 1.4 + 0.3,
  bri:  Math.random(),
  dBri: (Math.random() * 0.008 + 0.003) * (Math.random() > 0.5 ? 1 : -1)
}));

function drawStars() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of stars) {
    s.bri += s.dBri;
    if (s.bri > 1 || s.bri < 0.05) s.dBri *= -1;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(248, 220, 240, ${s.bri.toFixed(2)})`;
    ctx.fill();
  }
  requestAnimationFrame(drawStars);
}
drawStars();

// ── Floating hearts ────────────────────────────
const HEART_EMOJIS = ['💕', '❤️', '💖', '💗', '✨', '🌸', '💞'];

function spawnHeart() {
  const el = document.createElement('div');
  el.className = 'heart';
  el.textContent = HEART_EMOJIS[Math.floor(Math.random() * HEART_EMOJIS.length)];
  el.style.left   = `${Math.random() * 96}vw`;
  el.style.fontSize = `${Math.random() * 18 + 10}px`;
  el.style.opacity  = (Math.random() * 0.4 + 0.15).toFixed(2);
  const dur = (Math.random() * 4 + 5).toFixed(1);
  el.style.animationDuration = `${dur}s`;
  document.getElementById('heartsContainer').appendChild(el);
  setTimeout(() => el.remove(), parseFloat(dur) * 1000 + 200);
}

setInterval(spawnHeart, 1800);
spawnHeart(); // spawn one immediately

// ── Helpers ────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

function getName(inputId) {
  return document.getElementById(inputId).value.trim() || 'Anonymous';
}

// ── Create room ────────────────────────────────
document.getElementById('createBtn').addEventListener('click', () => {
  const name = getName('createName');
  const roomCode = generateRoomCode();
  window.location.href = `/room.html?room=${roomCode}&name=${encodeURIComponent(name)}&host=1`;
});

document.getElementById('createName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('createBtn').click();
});

// ── Join room ──────────────────────────────────
document.getElementById('joinBtn').addEventListener('click', () => {
  const name = getName('joinName');
  const raw  = document.getElementById('roomCode').value.trim().toUpperCase();

  if (!raw) {
    showError('Please enter a room code.');
    document.getElementById('roomCode').focus();
    return;
  }
  if (raw.length !== 6) {
    showError('Room code must be exactly 6 characters.');
    document.getElementById('roomCode').focus();
    return;
  }

  window.location.href = `/room.html?room=${raw}&name=${encodeURIComponent(name)}`;
});

// Auto-uppercase the room code as user types
document.getElementById('roomCode').addEventListener('input', (e) => {
  const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  e.target.value = val;
});

document.getElementById('roomCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('joinBtn').click();
});

document.getElementById('joinName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('roomCode').focus();
});
