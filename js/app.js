// ============================================
// App Orchestrator: State, Routing, Path Switching
// ============================================

import { prefersReducedMotion } from './utils.js';
import { initLazyVideos, initFadeInObserver, observeNewFadeIns } from './effects.js';
import { initHomescreen, destroyHomescreen } from './homescreen.js';
import { initScrollManager, destroyScrollManager } from './scroll-manager.js';
import { initResearchBubbles, closeResearchStage } from './research-bubbles.js';

// Own the scroll position: prevents the browser from restoring a deep
// scroll offset on reload/back-navigation into a path hash.
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

function scrollTopInstant() {
  // Bypasses `html { scroll-behavior: smooth }` so resets don't animate
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
}

function warmPathMedia(path) {
  // Kick the entered path's lazy media so it loads behind the transition
  // overlay instead of popping in after the reveal
  const section = document.getElementById(`path-${path}`);
  if (!section) return;
  section.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach(el => {
    el.loading = 'eager';
  });
}

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
  // Version-stamped like the stylesheets in index.html, so a returning
  // visitor cannot pair new CSS with a cached transition module.
  const mod = await import(`./transition-${path}.js?v=20260816q`);
  transitionModules[path] = mod;
  return mod;
}

// ---- Path switching ----
// `fromHistory` means the URL already says where we are, because the browser put
// it there. Writing another entry in that case is what made Back a no-op.
async function enterPath(path, fromHistory = false) {
  if (state.transitioning || state.activePath === path) return;
  state.transitioning = true;
  scrollTopInstant();
  warmPathMedia(path);

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

    // Hide homescreen as soon as zoom finishes (before enter() resolves)
    // This prevents the zoomed homescreen from flashing when the
    // transition overlay fades out
    zoomPromise.then(() => {
      homescreen.style.display = 'none';
    });

    // Wait for both zoom and transition to finish
    await Promise.all([enterPromise, zoomPromise]);

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
    scrollTopInstant();
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

  if (!fromHistory && window.location.hash !== `#${path}`) {
    history.pushState(null, '', `#${path}`);
  }

  syncToHash();
}

async function exitCurrentPath() {
  const path = state.activePath;
  if (!path) return;

  // An expanded research bubble must not survive a path change
  closeResearchStage();

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

async function goHome(fromHistory = false) {
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
  scrollTopInstant();

  state.transitioning = false;

  if (!fromHistory && window.location.hash) {
    history.pushState(null, '', window.location.pathname);
  }

  syncToHash();
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

// ---- Cross-path deep link: Research bubble -> Technology file tree ----
function openTechFolder(folderId) {
  const target = document.getElementById(folderId);
  if (!target) return;

  document.getElementById('tech-file-tree')?.classList.remove('minimized');

  // Open the target and every folder that contains it, or a nested target
  // stays collapsed inside a closed parent
  for (let node = target; node; node = node.parentElement) {
    if (!node.classList?.contains('tree-folder')) continue;
    node.classList.add('open');
    const toggle =
      node.querySelector(':scope > .folder-toggle') || node.querySelector('.folder-toggle');
    toggle?.setAttribute('aria-expanded', 'true');
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('highlight');
  setTimeout(() => target.classList.remove('highlight'), 1200);
}

// ---- Event listeners ----
function setupEvents() {
  // Corner hotspot clicks
  document.querySelectorAll('.corner-hotspot').forEach((btn) => {
    btn.addEventListener('click', () => enterPath(btn.dataset.path));
  });

  // Nav pill: home button
  // Wrap it: passing goHome directly hands the MouseEvent to `fromHistory`
  document.querySelector('.nav-home')?.addEventListener('click', () => goHome());

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

  // Research bubbles asking to hand off to the Technology path
  document.addEventListener('goto-tech-folder', async (e) => {
    const folder = e.detail?.folder;
    await enterPath('tech');
    if (folder) requestAnimationFrame(() => openTechFolder(folder));
  });

  // Hash routing. popstate covers Back and Forward, which hashchange alone misses
  // when the entry was written by pushState rather than by a link.
  window.addEventListener('hashchange', handleHash);
  window.addEventListener('popstate', handleHash);
}

const VALID_PATHS = ['forest', 'ocean', 'tech', 'mind'];

// Back and Forward arrive whenever the user presses them, including mid-transition
// when enterPath and goHome refuse to act. Rather than drop the navigation, note
// that the URL and the page disagree and settle it once the transition finishes.
function syncToHash() {
  if (state.transitioning) return;
  const hash = window.location.hash.replace('#', '');
  if (VALID_PATHS.includes(hash)) {
    if (state.activePath !== hash) enterPath(hash, true);
  } else if (!hash && state.activePath) {
    goHome(true);
  }
}

// Both hashchange and popstate mean the URL moved first and the page follows,
// so neither should write a new history entry
function handleHash() {
  syncToHash();
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  // Show body
  document.body.classList.add('loaded');

  // Init effects
  initLazyVideos();
  state.fadeObserver = initFadeInObserver();

  // Init homescreen
  initHomescreen();

  // Init research bubbles (ocean path)
  initResearchBubbles();

  // Setup all events
  setupEvents();

  // Check initial hash. The URL is already correct on load, so do not add to it.
  const hash = window.location.hash.replace('#', '');
  if (VALID_PATHS.includes(hash)) {
    enterPath(hash, true);
  }
});
