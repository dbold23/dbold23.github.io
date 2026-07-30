// ============================================
// Utility functions
// ============================================

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

// Throttle via rAF
export function rafThrottle(fn) {
  let ticking = false;
  return function (...args) {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      fn.apply(this, args);
      ticking = false;
    });
  };
}

// Check reduced motion preference
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Check touch device
export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches;
}
