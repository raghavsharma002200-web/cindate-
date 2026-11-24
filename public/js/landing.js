/* ═══════════════════════════════════════════════
   landing.js — CineDate Marketing Home Page
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

const STAR_COUNT = 150;
const stars = Array.from({ length: STAR_COUNT }, () => ({
  x:    Math.random() * canvas.width,
  y:    Math.random() * canvas.height,
  r:    Math.random() * 1.3 + 0.3,
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
const HEART_EMOJIS = ['💕', '❤️', '💖', '✨', '🌸', '💞'];

function spawnHeart() {
  const container = document.getElementById('heartsContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'heart';
  el.textContent = HEART_EMOJIS[Math.floor(Math.random() * HEART_EMOJIS.length)];
  el.style.left   = `${Math.random() * 96}vw`;
  el.style.fontSize = `${Math.random() * 18 + 10}px`;
  el.style.opacity  = (Math.random() * 0.35 + 0.15).toFixed(2);
  const dur = (Math.random() * 4 + 5).toFixed(1);
  el.style.animationDuration = `${dur}s`;
  container.appendChild(el);
  setTimeout(() => el.remove(), parseFloat(dur) * 1000 + 200);
}

setInterval(spawnHeart, 2000);
spawnHeart();

// ── Google Sign In & In-App Modal ──────────────
const GOOGLE_CLIENT_ID = '640464867255-tolbo4ld0gl6fc8ermjasbnbhnm649uh.apps.googleusercontent.com';
const savedName = localStorage.getItem('cinedate_user_name');
const googleBtnText = document.getElementById('heroGoogleBtnText');
const googleModal = document.getElementById('googleModal');
const googleModalInput = document.getElementById('googleModalInput');

if (savedName && googleBtnText) {
  googleBtnText.textContent = `Hi, ${savedName} 💕`;
}

function initGoogle() {
  if (window.google && google.accounts && google.accounts.id) {
    try {
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: window.handleGoogleCredentialResponse,
        auto_select: false
      });

      // Render official Google button inside the hero section
      const heroWrap = document.getElementById('heroGoogleBtnWrap');
      if (heroWrap && !savedName) {
        google.accounts.id.renderButton(heroWrap, {
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          text: 'signin_with',
          locale: 'en'
        });
      }

      // Render official Google button inside the modal
      const modalContainer = document.getElementById('googleBtnContainer');
      if (modalContainer) {
        google.accounts.id.renderButton(modalContainer, {
          theme: 'filled_blue',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          width: 280
        });
      }

      // Trigger one-tap prompt for mobile devices
      if (!savedName) {
        google.accounts.id.prompt();
      }
    } catch (err) {
      console.warn('Google GIS init error:', err);
    }
  }
}

// Ensure GIS initializes smoothly
if (window.google) {
  initGoogle();
} else {
  window.addEventListener('load', () => setTimeout(initGoogle, 400));
}

function openGoogleModal() {
  if (googleModal) {
    googleModal.classList.remove('hidden');
    googleModalInput?.focus();
  }
}

function closeGoogleModal() {
  if (googleModal) {
    googleModal.classList.add('hidden');
  }
}

document.getElementById('heroGoogleBtn')?.addEventListener('click', () => {
  if (savedName) {
    window.location.href = '/app';
    return;
  }
  openGoogleModal();
});

document.getElementById('closeGoogleModalBtn')?.addEventListener('click', closeGoogleModal);
googleModal?.addEventListener('click', (e) => {
  if (e.target === googleModal) closeGoogleModal();
});

function submitGoogleModal() {
  const val = googleModalInput?.value.trim();
  if (!val) {
    alert('Please enter your name or Gmail address');
    googleModalInput?.focus();
    return;
  }

  let resolvedName = val;
  if (resolvedName.includes('@')) {
    const raw = resolvedName.split('@')[0];
    resolvedName = raw
      .replace(/[._-]/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  localStorage.setItem('cinedate_user_name', resolvedName);
  window.location.href = '/app';
}

document.getElementById('googleModalSubmitBtn')?.addEventListener('click', submitGoogleModal);
googleModalInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitGoogleModal();
});

// Global Google response handler for GIS
window.handleGoogleCredentialResponse = function(response) {
  try {
    const base64Url = response.credential.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    const payload = JSON.parse(jsonPayload);
    const name = payload.name || payload.given_name;
    const pic  = payload.picture;
    if (name) {
      localStorage.setItem('cinedate_user_name', name);
      if (pic) localStorage.setItem('cinedate_user_pic', pic);
      window.location.href = '/app';
    }
  } catch (err) {
    console.error('Google parse error:', err);
  }
};

// ── Hero Quick Join ────────────────────────────
const quickInput = document.getElementById('quickRoomCode');
const quickJoinBtn = document.getElementById('quickJoinBtn');

function handleQuickJoin() {
  const code = quickInput?.value.trim().toUpperCase();
  if (!code || code.length !== 6) {
    alert('Please enter a valid 6-character partner room code.');
    quickInput?.focus();
    return;
  }
  const name = localStorage.getItem('cinedate_user_name') || 'Guest';
  window.location.href = `/room.html?room=${code}&name=${encodeURIComponent(name)}`;
}

quickJoinBtn?.addEventListener('click', handleQuickJoin);
quickInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleQuickJoin();
});
quickInput?.addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});
