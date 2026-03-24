// ============================================
// Tech Path: macOS Desktop, Sticker Peel, Matrix Rain
// ============================================

import { randomRange, prefersReducedMotion, sleep } from './utils.js';

let matrixAnimId = null;
let matrixCanvas = null;
let matrixCtx = null;
let columns = [];
let stickerCleanup = null;

// ---- Matrix Rain ----
const CHAR_SET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*(){}[]|/<>';
const FONT_SIZE = 14;

function initMatrix() {
  matrixCanvas = document.getElementById('matrix-canvas');
  if (!matrixCanvas) return;

  matrixCtx = matrixCanvas.getContext('2d');
  resizeMatrix();
  window.addEventListener('resize', resizeMatrix);
}

function resizeMatrix() {
  if (!matrixCanvas) return;
  matrixCanvas.width = window.innerWidth;
  matrixCanvas.height = window.innerHeight;

  const colCount = Math.floor(matrixCanvas.width / FONT_SIZE);
  columns = [];
  for (let i = 0; i < colCount; i++) {
    columns[i] = Math.floor(randomRange(0, matrixCanvas.height / FONT_SIZE));
  }
}

function startMatrix() {
  if (prefersReducedMotion() || !matrixCanvas) return;
  initMatrix();

  function draw() {
    // Dim previous frame
    matrixCtx.fillStyle = 'rgba(10, 14, 20, 0.06)';
    matrixCtx.fillRect(0, 0, matrixCanvas.width, matrixCanvas.height);

    matrixCtx.fillStyle = 'rgba(0, 255, 200, 0.4)';
    matrixCtx.font = `${FONT_SIZE}px monospace`;

    for (let i = 0; i < columns.length; i++) {
      const char = CHAR_SET[Math.floor(Math.random() * CHAR_SET.length)];
      const x = i * FONT_SIZE;
      const y = columns[i] * FONT_SIZE;

      matrixCtx.fillText(char, x, y);

      if (y > matrixCanvas.height && Math.random() > 0.975) {
        columns[i] = 0;
      }
      columns[i]++;
    }
    matrixAnimId = requestAnimationFrame(draw);
  }
  draw();
}

function stopMatrix() {
  if (matrixAnimId) {
    cancelAnimationFrame(matrixAnimId);
    matrixAnimId = null;
  }
  window.removeEventListener('resize', resizeMatrix);
}

// ---- Sticker Peel (hover-triggered, adapted from v1 scroll-linked) ----

function initStickerPeel() {
  const dock = document.querySelector('.desktop-icons');
  if (!dock) return;
  const stickers = dock.querySelectorAll('.sticker-peel:not(.permanent)');
  if (!stickers.length) return;

  const DURATION = 500; // ms for full peel/unpeel
  const controllers = [];

  stickers.forEach((sticker) => {
    let animId = null;
    let current = 0; // current --peel-amount (0 = flat, 1 = peeled)
    let target = 0;
    let startTime = null;
    let startVal = 0;

    function applyPeel(progress) {
      current = progress;
      sticker.style.setProperty('--peel-amount', progress);

      // Update shadow
      const shadow = sticker.querySelector('.sticker-shadow');
      if (shadow) {
        shadow.style.height = (progress * 20) + 'px';
        shadow.style.opacity = progress;
      }

      // Show/hide label
      if (progress > 0.5) {
        sticker.classList.add('peeled');
      } else {
        sticker.classList.remove('peeled');
      }
    }

    function animate(timestamp) {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const duration = DURATION * Math.abs(target - startVal);
      const t = duration > 0 ? Math.min(elapsed / duration, 1) : 1;

      // Ease out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const value = startVal + (target - startVal) * eased;

      applyPeel(value);

      if (t < 1) {
        animId = requestAnimationFrame(animate);
      } else {
        animId = null;
      }
    }

    function startAnimation(newTarget) {
      target = newTarget;
      startVal = current;
      startTime = null;
      if (animId) cancelAnimationFrame(animId);
      animId = requestAnimationFrame(animate);
    }

    function onEnter() { startAnimation(1); }
    function onLeave() { startAnimation(0); }

    sticker.addEventListener('mouseenter', onEnter);
    sticker.addEventListener('mouseleave', onLeave);

    controllers.push(() => {
      sticker.removeEventListener('mouseenter', onEnter);
      sticker.removeEventListener('mouseleave', onLeave);
      if (animId) cancelAnimationFrame(animId);
      applyPeel(0);
    });
  });

  // Return cleanup function
  return () => controllers.forEach(fn => fn());
}

function stopStickerPeel() {
  if (stickerCleanup) {
    stickerCleanup();
    stickerCleanup = null;
  }
}

// ---- Sticker Click Navigation ----

let stickerClickCleanup = null;

function initStickerNav() {
  const dock = document.querySelector('.desktop-icons');
  if (!dock) return;
  const stickers = dock.querySelectorAll('.sticker-peel[data-href]');
  const cleanups = [];

  stickers.forEach((sticker) => {
    function onClick(e) {
      e.preventDefault();
      const href = sticker.dataset.href;
      if (sticker.dataset.external === 'true') {
        window.open(href, '_blank', 'noopener');
        return;
      }
      // Scroll to folder and auto-open it
      const target = document.querySelector(href);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Auto-open after scroll settles
      setTimeout(() => {
        if (!target.classList.contains('open')) {
          target.classList.add('open');
          const toggle = target.querySelector('.folder-toggle');
          if (toggle) toggle.setAttribute('aria-expanded', 'true');
        }
        // Flash highlight
        target.classList.add('highlight');
        setTimeout(() => target.classList.remove('highlight'), 1000);
      }, 500);
    }
    sticker.addEventListener('click', onClick);
    cleanups.push(() => sticker.removeEventListener('click', onClick));
  });

  return () => cleanups.forEach(fn => fn());
}

// ---- Hardware 3D Model Part Selector ----

let hwViewerCleanup = null;

function initHardwareViewer() {
  const viewer = document.getElementById('hw-model');
  if (!viewer) return;

  const wrap = viewer.closest('.hw-viewer-wrap');
  if (!wrap) return;

  const buttons = wrap.querySelectorAll('.hw-part-btn');
  const descs = wrap.querySelectorAll('.hw-part-desc');
  const cleanups = [];

  buttons.forEach(btn => {
    function onClick() {
      const part = btn.dataset.part;
      const orbit = btn.dataset.orbit;
      const target = btn.dataset.target;

      // Animate camera to part position
      viewer.cameraOrbit = orbit;
      viewer.cameraTarget = target;

      // Auto-rotate on overview only, pause on specific parts
      viewer.autoRotate = (part === 'overview');

      // Swap active button
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Swap visible description
      descs.forEach(d => {
        d.style.display = d.dataset.for === part ? '' : 'none';
      });
    }

    btn.addEventListener('click', onClick);
    cleanups.push(() => btn.removeEventListener('click', onClick));
  });

  return () => cleanups.forEach(fn => fn());
}

function stopHardwareViewer() {
  if (hwViewerCleanup) {
    hwViewerCleanup();
    hwViewerCleanup = null;
  }
}

// ---- File Tree Expand/Collapse ----

let fileTreeCleanup = null;

function initFileTree() {
  const tree = document.getElementById('tech-file-tree');
  if (!tree) return;
  const cleanups = [];

  // Folder toggles (accordion — one open at a time per nesting level)
  const allFolders = tree.querySelectorAll('.tree-folder');
  allFolders.forEach((folder) => {
    const toggle = folder.querySelector(':scope > .folder-toggle');
    if (!toggle) return;

    function onClick() {
      const isOpen = folder.classList.contains('open');

      // Record position of clicked toggle before DOM changes
      const toggleTop = toggle.getBoundingClientRect().top;

      // Close sibling folders — collapse INSTANTLY (skip CSS transition)
      const parent = folder.parentElement;
      const siblings = parent.querySelectorAll(':scope > .tree-folder');
      siblings.forEach(f => {
        if (f !== folder && f.classList.contains('open')) {
          // Kill transition so height collapses immediately
          const children = f.querySelector(':scope > .folder-children');
          if (children) children.style.transition = 'none';

          f.classList.remove('open');
          const t = f.querySelector(':scope > .folder-toggle');
          if (t) t.setAttribute('aria-expanded', 'false');

          // Force reflow, then restore transition
          if (children) {
            children.offsetHeight; // force layout
            children.style.transition = '';
          }
        }
      });

      // Toggle this folder
      folder.classList.toggle('open', !isOpen);
      toggle.setAttribute('aria-expanded', String(!isOpen));

      // Correct scroll so clicked toggle stays in the same viewport position
      const drift = toggle.getBoundingClientRect().top - toggleTop;
      if (Math.abs(drift) > 2) {
        window.scrollBy(0, drift);
      }
    }

    toggle.addEventListener('click', onClick);
    cleanups.push(() => toggle.removeEventListener('click', onClick));
  });

  // File toggles (multiple can be open within a folder)
  const files = tree.querySelectorAll('.tree-file');
  files.forEach((file) => {
    const toggle = file.querySelector(':scope > .file-toggle');
    if (!toggle) return;

    function onClick() {
      const wasOpen = file.classList.contains('open');
      file.classList.toggle('open');

      // Pause any videos inside when closing
      if (wasOpen) {
        file.querySelectorAll('video').forEach(v => v.pause());
      }
    }

    toggle.addEventListener('click', onClick);
    cleanups.push(() => toggle.removeEventListener('click', onClick));
  });

  // Pause videos inside folders that get closed (by accordion)
  const observer = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const el = m.target;
        if ((el.classList.contains('tree-folder') || el.classList.contains('tree-file'))
            && !el.classList.contains('open')) {
          el.querySelectorAll('video').forEach(v => v.pause());
        }
      }
    });
  });
  observer.observe(tree, { attributes: true, attributeFilter: ['class'], subtree: true });
  cleanups.push(() => observer.disconnect());

  // Pause videos when scrolled out of view
  const videos = tree.querySelectorAll('video');
  if (videos.length) {
    const scrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) {
          entry.target.pause();
        }
      });
    }, { threshold: 0 });

    videos.forEach(v => scrollObserver.observe(v));
    cleanups.push(() => scrollObserver.disconnect());
  }

  return () => cleanups.forEach(fn => fn());
}

function stopFileTree() {
  if (fileTreeCleanup) {
    fileTreeCleanup();
    fileTreeCleanup = null;
  }
  if (stickerClickCleanup) {
    stickerClickCleanup();
    stickerClickCleanup = null;
  }
}

// ---- Entrance transition: simple dark fade ----
export async function enter() {
  if (prefersReducedMotion()) return;

  const overlay = document.getElementById('transition-overlay');
  overlay.classList.add('active');
  const content = overlay.querySelector('#transition-content');

  // Dark tech background container
  const container = document.createElement('div');
  container.className = 'tech-transition-container';
  content.appendChild(container);

  // Fade in
  await sleep(30);
  container.classList.add('visible');

  // Brief hold
  await sleep(600);

  // Fade out to reveal desktop
  container.classList.remove('visible');
  await sleep(400);

  container.remove();
  overlay.classList.remove('active');
}

// ---- Menubar Clock ----
let clockInterval = null;

function startMenubarClock() {
  const el = document.querySelector('.menubar-time');
  if (!el) return;
  function update() {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true
    });
  }
  update();
  clockInterval = setInterval(update, 60000);
}

function stopMenubarClock() {
  if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
}

// ---- Start/Stop (called when path is active) ----
export function start() {
  startMatrix();
  startMenubarClock();
  stickerCleanup = initStickerPeel();
  stickerClickCleanup = initStickerNav();
  fileTreeCleanup = initFileTree();
  hwViewerCleanup = initHardwareViewer();
}

export function stop() {
  stopMatrix();
  stopMenubarClock();
  stopStickerPeel();
  stopFileTree();
  stopHardwareViewer();
}
