// ============================================
// Effects ported from V1: Tilt Cards, Fade-in Observer, Lazy Videos
// ============================================

import { prefersReducedMotion } from './utils.js';

// Lazy-play .lazy-video elements only while on screen
let lazyVideoObserver = null;

export function initLazyVideos() {
  // Respect reduced motion: expose controls, never autoplay
  if (!prefersReducedMotion()) {
    // Only ever decode one clip at a time. Two looping videos playing together
    // drop the whole page to about 15fps, which is what made an opened research
    // bubble feel laggy.
    let playing = null;

    lazyVideoObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            entry.target.pause();
            if (playing === entry.target) playing = null;
            return;
          }
          if (playing && playing !== entry.target && !playing.paused) {
            // Another clip already holds the slot; wait until it scrolls away
            entry.target.pause();
            return;
          }
          playing = entry.target;
          entry.target.play().catch(() => {});
        });
      },
      { threshold: 0.25 }
    );
  }
  attachLazyVideos(document);
}

// Wire up videos that were added after init (e.g. cloned out of a <template>)
export function attachLazyVideos(root = document) {
  const videos = root.querySelectorAll('.lazy-video');
  if (!videos.length) return;

  if (!lazyVideoObserver) {
    videos.forEach((video) => {
      video.controls = true;
    });
    return;
  }

  videos.forEach((video) => lazyVideoObserver.observe(video));
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
