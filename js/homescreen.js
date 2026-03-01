// ============================================
// Homescreen: Corner interactions, ambient canvas
// ============================================

import { randomRange, prefersReducedMotion, isTouchDevice } from './utils.js';

let ambientAnimId = null;
let particles = [];

// Ambient floating particles on the homescreen canvas
function startAmbient() {
  if (prefersReducedMotion()) return;

  const canvas = document.getElementById('ambient-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  particles = [];
  const count = 25;
  for (let i = 0; i < count; i++) {
    particles.push({
      x: randomRange(0, canvas.width),
      y: randomRange(0, canvas.height),
      vx: randomRange(-0.2, 0.2),
      vy: randomRange(-0.2, 0.2),
      radius: randomRange(1, 3),
      opacity: randomRange(0.1, 0.3),
    });
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${p.opacity})`;
      ctx.fill();
    });

    ambientAnimId = requestAnimationFrame(animate);
  }
  animate();

  // Handle resize
  window._homescreenResize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  window.addEventListener('resize', window._homescreenResize);
}

function stopAmbient() {
  if (ambientAnimId) {
    cancelAnimationFrame(ambientAnimId);
    ambientAnimId = null;
  }
  if (window._homescreenResize) {
    window.removeEventListener('resize', window._homescreenResize);
    delete window._homescreenResize;
  }
}

// Show hint after delay
function showHint() {
  const hint = document.getElementById('hero-hint');
  if (!hint) return;
  setTimeout(() => {
    hint.classList.add('visible');
  }, 3000);
}

// ---- Image-locked hotspot positioning ----
// Coordinates of each hotspot's CENTER in the original image (0-100%)
const HOTSPOT_IMAGE_COORDS = {
  'tech-board': { x: 42, y: 75 },
  mind:   { x: 59, y: 11, w: 18, h: 56 },
};

function imageToContainer(imgEl, imgX, imgY) {
  // Get natural and rendered dimensions
  const natW = imgEl.naturalWidth;
  const natH = imgEl.naturalHeight;
  if (!natW || !natH) return null;

  const contW = imgEl.clientWidth;
  const contH = imgEl.clientHeight;

  // object-fit: cover scale factor
  const scale = Math.max(contW / natW, contH / natH);
  const rendW = natW * scale;
  const rendH = natH * scale;

  // object-position: 55% 30%  → how much of the overflow is on the left/top
  const offsetX = (rendW - contW) * 0.55;
  const offsetY = (rendH - contH) * 0.30;

  // Map image-space % to container-space %
  const cx = ((imgX / 100) * rendW - offsetX) / contW * 100;
  const cy = ((imgY / 100) * rendH - offsetY) / contH * 100;
  return { x: cx, y: cy };
}

function repositionHotspots() {
  const img = document.querySelector('.hero-portrait');
  if (!img || !img.naturalWidth) return;

  for (const [name, coords] of Object.entries(HOTSPOT_IMAGE_COORDS)) {
    const el = document.querySelector(`.corner-${name}`);
    if (!el) continue;

    const center = imageToContainer(img, coords.x, coords.y);
    if (!center) continue;

    if (coords.w && coords.h) {
      // Rectangular hotspot (mind) — position by center with clamping
      const left = Math.max(-10, Math.min(100 - coords.w, center.x - coords.w / 2));
      const top  = Math.max(-30, Math.min(100 - coords.h, center.y - coords.h / 2));
      el.style.left = `${left}%`;
      el.style.top  = `${top}%`;
    } else {
      // Anchor-only hotspot (tech) — CSS handles size/clip-path, JS just positions
      el.style.left = `${center.x - 50}%`;
      el.style.top  = `${center.y - 26}%`;
    }
    el.classList.add('positioned');
  }
}

function initHotspotTracking() {
  const img = document.querySelector('.hero-portrait');
  if (!img) return;

  const update = () => repositionHotspots();

  if (img.complete && img.naturalWidth) {
    update();
  }
  img.addEventListener('load', update);
  window.addEventListener('resize', update);
  window._hotspotResize = update;
}

// ---- Public API ----
export function initHomescreen() {
  startAmbient();
  showHint();
  initHotspotTracking();
}

export function destroyHomescreen() {
  stopAmbient();
  if (window._hotspotResize) {
    window.removeEventListener('resize', window._hotspotResize);
    delete window._hotspotResize;
  }
}
