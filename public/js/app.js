/* ═══════════════════════════════════════════════
   app.js — CineDate Room Lobby & Google Sign-In
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
  const container = document.getElementById('heartsContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'heart';
  el.textContent = HEART_EMOJIS[Math.floor(Math.random() * HEART_EMOJIS.length)];
  el.style.left   = `${Math.random() * 96}vw`;
  el.style.fontSize = `${Math.random() * 18 + 10}px`;
  el.style.opacity  = (Math.random() * 0.4 + 0.15).toFixed(2);
  const dur = (Math.random() * 4 + 5).toFixed(1);
  el.style.animationDuration = `${dur}s`;
  container.appendChild(el);
  setTimeout(() => el.remove(), parseFloat(dur) * 1000 + 200);
}

setInterval(spawnHeart, 1800);
spawnHeart();

// ── Google Profile & Name Prefill ──────────────
function syncPrefilledName(name, avatar) {
  if (!name) return;
  const createInput = document.getElementById('createName');
  const joinInput   = document.getElementById('joinName');
  if (createInput) createInput.value = name;
  if (joinInput)   joinInput.value   = name;

  const pill = document.getElementById('googleUserPill');
  const nameLabel = document.getElementById('googleUserName');
  const avatarImg = document.getElementById('googleUserAvatar');
  const prompt = document.getElementById('googleSignInPrompt');

  if (pill && nameLabel) {
    pill.style.display = 'inline-flex';
    nameLabel.textContent = `👋 ${name}`;
    if (avatar && avatarImg) {
      avatarImg.src = avatar;
      avatarImg.style.display = 'inline-block';
    }
  }
  if (prompt) prompt.style.display = 'none';
}

// Load remembered name from localStorage on boot
const savedName   = localStorage.getItem('cinedate_user_name');
const savedAvatar = localStorage.getItem('cinedate_user_pic');
if (savedName) {
  syncPrefilledName(savedName, savedAvatar);
}

// Sign-out button
document.getElementById('googleSignOutBtn')?.addEventListener('click', () => {
  localStorage.removeItem('cinedate_user_name');
  localStorage.removeItem('cinedate_user_pic');
  const pill = document.getElementById('googleUserPill');
  const prompt = document.getElementById('googleSignInPrompt');
  if (pill) pill.style.display = 'none';
  if (prompt) prompt.style.display = 'inline-flex';
  const createInput = document.getElementById('createName');
  const joinInput   = document.getElementById('joinName');
  if (createInput) createInput.value = '';
  if (joinInput)   joinInput.value   = '';
});

// Quick Google / Gmail sign in handler
document.getElementById('quickGoogleBtn')?.addEventListener('click', () => {
  // Try Google Identity One-Tap first if available
  if (window.google && google.accounts && google.accounts.id) {
    try {
      google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          promptManualNameOrEmail();
        }
      });
      return;
    } catch (e) {
      // Fallback
    }
  }
  promptManualNameOrEmail();
});

function promptManualNameOrEmail() {
  const userInput = prompt('Enter your Name or Gmail (e.g. Raghav or raghav@gmail.com):');
  if (!userInput) return;

  let resolvedName = userInput.trim();
  if (resolvedName.includes('@')) {
    // Extract name before @ and capitalize nicely (e.g. raghav.sharma -> Raghav Sharma)
    const raw = resolvedName.split('@')[0];
    resolvedName = raw
      .replace(/[._-]/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  if (resolvedName) {
    localStorage.setItem('cinedate_user_name', resolvedName);
    syncPrefilledName(resolvedName, null);
  }
}

// Global Google credential response callback (for GIS client)
window.handleGoogleCredentialResponse = function(response) {
  try {
    const payload = JSON.parse(atob(response.credential.split('.')[1]));
    const name = payload.name || payload.given_name;
    const pic  = payload.picture;
    if (name) {
      localStorage.setItem('cinedate_user_name', name);
      if (pic) localStorage.setItem('cinedate_user_pic', pic);
      syncPrefilledName(name, pic);
    }
  } catch (err) {
    console.error('Failed to parse Google credential:', err);
  }
};

// ── Room Navigation Helpers ────────────────────
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
  const val = document.getElementById(inputId).value.trim();
  if (val) {
    localStorage.setItem('cinedate_user_name', val);
    return val;
  }
  return localStorage.getItem('cinedate_user_name') || 'Anonymous';
}

// ── Create room ────────────────────────────────
document.getElementById('createBtn')?.addEventListener('click', () => {
  const name = getName('createName');
  const roomCode = generateRoomCode();
  window.location.href = `/room.html?room=${roomCode}&name=${encodeURIComponent(name)}&host=1`;
});

document.getElementById('createName')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('createBtn')?.click();
});

// ── Join room ──────────────────────────────────
document.getElementById('joinBtn')?.addEventListener('click', () => {
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

document.getElementById('roomCode')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('joinBtn')?.click();
});

document.getElementById('roomCode')?.addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});
