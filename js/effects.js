// ============================================
// Effects ported from V1: Tilt Cards, Fade-in Observer, Lazy Videos
// ============================================

import { prefersReducedMotion } from './utils.js';

// Lazy-play .lazy-video elements only while on screen
export function initLazyVideos() {
  const videos = document.querySelectorAll('.lazy-video');
  if (!videos.length) return;

  // Respect reduced motion: expose controls, never autoplay
  if (prefersReducedMotion()) {
    videos.forEach((video) => {
      video.controls = true;
    });
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.play().catch(() => {});
        } else {
          entry.target.pause();
        }
      });
    },
    { threshold: 0.25 }
  );

  videos.forEach((video) => observer.observe(video));
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
