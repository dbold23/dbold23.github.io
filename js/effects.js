// ============================================
// Effects ported from V1: Blob Cursor, Tilt Cards, Fade-in Observer
// ============================================

export function initBlobCursor() {
  // removed — was creating a distracting dot on the mouse
}

// Fade-in observer for .fade-in elements
export function initFadeInObserver() {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -60px 0px' }
  );

  document.querySelectorAll('.fade-in').forEach((el) => observer.observe(el));

  // Re-observe when new paths become active
  return observer;
}

// Re-observe fade-in elements (call after showing a path)
export function observeNewFadeIns(observer) {
  document.querySelectorAll('.fade-in:not(.visible)').forEach((el) => observer.observe(el));
}
