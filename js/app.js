// ============================================
// App Orchestrator: State, Routing, Path Switching
// ============================================

import { prefersReducedMotion } from './utils.js';
import { initBlobCursor, initFadeInObserver, observeNewFadeIns } from './effects.js';
import { initHomescreen, destroyHomescreen } from './homescreen.js';
import { initScrollManager, destroyScrollManager } from './scroll-manager.js';

// ---- State ----
const state = {
  activePath: null, // 'forest' | 'ocean' | 'tech' | 'mind' | null
  transitioning: false,
  fadeObserver: null,
};

// ---- DOM References ----
const homescreen = document.getElementById('homescreen');
const nav = document.getElementById('path-nav');
const resumePanel = document.getElementById('resume-panel');
const resumeBackdrop = document.getElementById('resume-backdrop');
const resumeClose = document.getElementById('resume-close');
const cvToggle = document.getElementById('cv-toggle');
const footer = document.getElementById('shared-footer');

// ---- Transition modules (lazy-loaded) ----
const transitionModules = {};

async function loadTransition(path) {
  if (transitionModules[path]) return transitionModules[path];
  const mod = await import(`./transition-${path}.js`);
  transitionModules[path] = mod;
  return mod;
}

// ---- Path switching ----
async function enterPath(path) {
  if (state.transitioning || state.activePath === path) return;
  state.transitioning = true;

  // If coming from another path, exit it first
  if (state.activePath) {
    await exitCurrentPath();
  }

  // Set theme on body
  document.body.setAttribute('data-active-path', path);

  // Load transition module
  const mod = await loadTransition(path);

  // Run zoom + transition entrance simultaneously
  if (!state.activePath) {
    homescreen.classList.add('zooming', `zoom-${path}`);

    // Start the path entrance at the same time as the zoom
    // so branches/waves/etc overlay the zooming image seamlessly
    const enterPromise = mod.enter ? mod.enter() : Promise.resolve();
    const zoomPromise = new Promise((r) =>
      setTimeout(r, prefersReducedMotion() ? 50 : 1200)
    );

    // Wait for both zoom and transition to finish
    await Promise.all([enterPromise, zoomPromise]);

    homescreen.style.display = 'none';
    destroyHomescreen();
  } else {
    // Switching between paths — just run the entrance
    if (mod.enter) await mod.enter();
  }

  if (mod.start) mod.start();

  // Show path section
  const section = document.getElementById(`path-${path}`);
  if (section) {
    section.classList.add('active');
    window.scrollTo(0, 0);
  }

  // Show nav and footer
  nav.classList.add('visible');
  if (footer) footer.classList.add('visible');

  // Update nav buttons
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.path === path);
  });

  // Observe fade-in elements in the new path
  if (state.fadeObserver) observeNewFadeIns(state.fadeObserver);

  // Init scroll manager for this path
  initScrollManager(path, mod);

  state.activePath = path;
  state.transitioning = false;

  // Update URL hash
  history.pushState(null, '', `#${path}`);
}

async function exitCurrentPath() {
  const path = state.activePath;
  if (!path) return;

  const mod = transitionModules[path];

  // Stop path-specific effects
  if (mod && mod.stop) mod.stop();

  // Destroy scroll manager
  destroyScrollManager();

  // Hide path section
  const section = document.getElementById(`path-${path}`);
  if (section) section.classList.remove('active');

  state.activePath = null;
}

async function goHome() {
  if (state.transitioning) return;
  state.transitioning = true;

  await exitCurrentPath();

  // Hide nav and footer
  nav.classList.remove('visible');
  if (footer) footer.classList.remove('visible');

  // Remove theme
  document.body.removeAttribute('data-active-path');

  // Show homescreen
  homescreen.style.display = '';
  homescreen.classList.remove('zooming', 'zoom-forest', 'zoom-ocean', 'zoom-tech', 'zoom-mind');

  // Re-init homescreen
  initHomescreen();

  // Scroll to top
  window.scrollTo(0, 0);

  state.transitioning = false;
  history.pushState(null, '', window.location.pathname);
}

// ---- Resume panel ----
function openResume() {
  resumePanel.classList.add('open');
  resumeBackdrop.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeResume() {
  resumePanel.classList.remove('open');
  resumeBackdrop.classList.remove('visible');
  document.body.style.overflow = '';
}

// ---- Event listeners ----
function setupEvents() {
  // Corner hotspot clicks
  document.querySelectorAll('.corner-hotspot').forEach((btn) => {
    btn.addEventListener('click', () => enterPath(btn.dataset.path));
  });

  // Nav pill: home button
  document.querySelector('.nav-home')?.addEventListener('click', goHome);

  // Nav pill: path buttons
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => enterPath(btn.dataset.path));
  });

  // Resume
  cvToggle?.addEventListener('click', openResume);
  resumeClose?.addEventListener('click', closeResume);
  resumeBackdrop?.addEventListener('click', closeResume);

  // Keyboard: Escape closes resume
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (resumePanel.classList.contains('open')) {
        closeResume();
      }
    }
  });

  // Hash routing
  window.addEventListener('hashchange', handleHash);
}

function handleHash() {
  const hash = window.location.hash.replace('#', '');
  const validPaths = ['forest', 'ocean', 'tech', 'mind'];
  if (validPaths.includes(hash)) {
    enterPath(hash);
  } else if (!hash) {
    goHome();
  }
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  // Show body
  document.body.classList.add('loaded');

  // Init effects
  initBlobCursor();
  state.fadeObserver = initFadeInObserver();

  // Init homescreen
  initHomescreen();

  // Setup all events
  setupEvents();

  // Check initial hash
  const hash = window.location.hash.replace('#', '');
  if (['forest', 'ocean', 'tech', 'mind'].includes(hash)) {
    enterPath(hash);
  }
});
