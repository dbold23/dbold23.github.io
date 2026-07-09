// ============================================
// Tech Path: macOS Desktop, Matrix Rain
// ============================================

import { randomRange, prefersReducedMotion, sleep } from './utils.js';

// Load model-viewer on demand for the 3D models in this path (fire-and-forget)
import('https://ajax.googleapis.com/ajax/libs/model-viewer/3.4.0/model-viewer.min.js').catch(() => {});

let matrixAnimId = null;
let matrixCanvas = null;
let matrixCtx = null;
let columns = [];

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

// ---- Clear entrance transition delays so hover is instant ----
function clearIconEntrance() {
  const icons = document.querySelectorAll('.desktop-icons .desktop-icon');
  if (!icons.length) return;
  // Wait for longest entrance delay (0.5s) + animation (0.4s) = ~1s
  setTimeout(() => {
    icons.forEach(icon => icon.classList.add('entered'));
  }, 1000);
}

// ---- Desktop Icon Click Navigation ----

let stickerClickCleanup = null;

function initStickerNav() {
  const dock = document.querySelector('.desktop-icons');
  if (!dock) return;
  const stickers = dock.querySelectorAll('.desktop-icon[data-href]');
  const cleanups = [];

  stickers.forEach((sticker) => {
    function onClick(e) {
      e.preventDefault();
      const href = sticker.dataset.href;
      if (sticker.dataset.external === 'true') {
        window.open(href, '_blank', 'noopener');
        return;
      }
      // Scroll to folder and auto-open it (restore the window if minimized)
      const target = document.querySelector(href);
      if (!target) return;
      const win = document.getElementById('tech-file-tree');
      if (win) win.classList.remove('minimized');
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
      // Folders open independently: expand/collapse in place with no
      // accordion auto-close and no compensating scroll, so the view
      // never jumps when you open or close something.
      const isOpen = folder.classList.contains('open');
      folder.classList.toggle('open', !isOpen);
      toggle.setAttribute('aria-expanded', String(!isOpen));
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

// ---- Terminal Window (drag + traffic-light controls) ----

function initTerminalWindow() {
  const win = document.getElementById('tech-file-tree');
  if (!win || win.dataset.windowInit) return;
  win.dataset.windowInit = 'true';

  const titlebar = win.querySelector('.terminal-titlebar');
  const surface = win.closest('.desktop-surface');
  if (!titlebar || !surface) return;

  const desktopMode = window.matchMedia('(min-width: 969px)');
  let winX = 0;
  let winY = 0;

  function applyPosition() {
    win.style.setProperty('--win-x', `${winX}px`);
    win.style.setProperty('--win-y', `${winY}px`);
  }

  function resetWindow() {
    winX = 0;
    winY = 0;
    win.classList.remove('maximized', 'minimized');
    applyPosition();
  }

  // Drag via titlebar (desktop only; dots excluded)
  titlebar.addEventListener('pointerdown', (e) => {
    if (!desktopMode.matches) return;
    if (e.target.closest('.dot')) return;
    if (win.classList.contains('maximized')) return;
    e.preventDefault();

    const startX = e.clientX - winX;
    const startY = e.clientY - winY;
    win.classList.add('dragging');
    titlebar.setPointerCapture(e.pointerId);

    function onMove(ev) {
      winX = ev.clientX - startX;
      winY = ev.clientY - startY;

      // Keep the titlebar reachable inside the desktop surface
      const s = surface.getBoundingClientRect();
      const w = win.offsetWidth;
      const h = win.offsetHeight;
      const minX = 120 - w - (s.width - w) / 2;
      const maxX = s.width - 120 - (s.width - w) / 2;
      const minY = 4 - (s.height - h) / 2;
      const maxY = (s.height + h) / 2 - 48;
      winX = Math.max(minX, Math.min(maxX, winX));
      winY = Math.max(minY, Math.min(maxY, winY));
      applyPosition();
    }

    function onUp() {
      win.classList.remove('dragging');
      titlebar.removeEventListener('pointermove', onMove);
      titlebar.removeEventListener('pointerup', onUp);
      titlebar.removeEventListener('pointercancel', onUp);
    }

    titlebar.addEventListener('pointermove', onMove);
    titlebar.addEventListener('pointerup', onUp);
    titlebar.addEventListener('pointercancel', onUp);
  });

  // Traffic lights: red resets, yellow minimizes, green zooms
  const dotRed = titlebar.querySelector('.dot.red');
  const dotYellow = titlebar.querySelector('.dot.yellow');
  const dotGreen = titlebar.querySelector('.dot.green');
  if (dotRed) {
    dotRed.title = 'Reset window';
    dotRed.addEventListener('click', resetWindow);
  }
  if (dotYellow) {
    dotYellow.title = 'Minimize';
    dotYellow.addEventListener('click', () => win.classList.toggle('minimized'));
  }
  if (dotGreen) {
    dotGreen.title = 'Zoom';
    dotGreen.addEventListener('click', () => {
      win.classList.remove('minimized');
      win.classList.toggle('maximized');
    });
  }

  // Double-click the titlebar to zoom, like macOS
  titlebar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.dot')) return;
    win.classList.toggle('maximized');
  });
}

// ---- Entrance transition: macOS boot screen ----
export async function enter() {
  if (prefersReducedMotion()) return;

  const overlay = document.getElementById('transition-overlay');
  overlay.classList.add('active');
  const content = overlay.querySelector('#transition-content');

  const container = document.createElement('div');
  container.className = 'tech-transition-container';
  container.innerHTML = '<div class="boot-logo">\uF8FF</div><div class="boot-progress"><div class="boot-progress-fill"></div></div>';
  content.appendChild(container);

  // Show boot screen
  await sleep(30);
  container.classList.add('visible');
  await sleep(150);

  // Start progress bar
  container.querySelector('.boot-progress-fill').classList.add('filling');
  await sleep(1800);

  // Pause briefly, then fade out smoothly
  await sleep(200);
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
  clearIconEntrance();
  initTerminalWindow();
  stickerClickCleanup = initStickerNav();
  fileTreeCleanup = initFileTree();
  hwViewerCleanup = initHardwareViewer();
}

export function stop() {
  stopMatrix();
  stopMenubarClock();
  stopFileTree();
  stopHardwareViewer();
}
