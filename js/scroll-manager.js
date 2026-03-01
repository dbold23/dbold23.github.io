// ============================================
// Scroll Manager: Single rAF scroll dispatcher
// ============================================

import { rafThrottle } from './utils.js';

let scrollHandler = null;
let currentPath = null;
let currentModule = null;

function onScroll() {
  const scrollY = window.scrollY;

  // Dispatch to active path module
  if (currentModule) {
    if (currentModule.updateParallax) {
      currentModule.updateParallax(scrollY);
    }
    if (currentModule.onScroll) {
      currentModule.onScroll(scrollY);
    }
  }
}

export function initScrollManager(path, mod) {
  currentPath = path;
  currentModule = mod;

  scrollHandler = rafThrottle(onScroll);
  window.addEventListener('scroll', scrollHandler, { passive: true });
}

export function destroyScrollManager() {
  if (scrollHandler) {
    window.removeEventListener('scroll', scrollHandler);
    scrollHandler = null;
  }
  currentPath = null;
  currentModule = null;
}
