// ============================================
// Effects ported from V1: Blob Cursor, Tilt Cards, Fade-in Observer
// ============================================

import { isTouchDevice, prefersReducedMotion } from './utils.js';

// Bioluminescent Blob Cursor
export function initBlobCursor() {
  if (isTouchDevice() || prefersReducedMotion()) return;

  const blob = document.createElement('div');
  blob.classList.add('blob-cursor');
  document.body.appendChild(blob);

  const dot = document.createElement('div');
  dot.classList.add('blob-dot');
  document.body.appendChild(dot);

  let mouseX = 0, mouseY = 0;
  let blobX = 0, blobY = 0;
  let prevMouseX = 0, prevMouseY = 0;
  let velocity = 0;

  function hslColor(v) {
    const hue = Math.max(180, 220 - v * 1.5);
    const lightness = Math.min(70, 45 + v * 0.8);
    const saturation = Math.min(90, 60 + v);
    return `hsla(${hue}, ${saturation}%, ${lightness}%, 0.8)`;
  }

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (!blob.classList.contains('active')) blob.classList.add('active');
  });

  function animate() {
    blobX += (mouseX - blobX) * 0.08;
    blobY += (mouseY - blobY) * 0.08;

    const dx = mouseX - prevMouseX;
    const dy = mouseY - prevMouseY;
    const rawV = Math.sqrt(dx * dx + dy * dy);
    velocity += (rawV - velocity) * 0.1;
    prevMouseX = mouseX;
    prevMouseY = mouseY;

    const scale = 1 + Math.min(velocity * 0.015, 0.4);
    blob.style.transform = `translate(${blobX - 250}px, ${blobY - 250}px) scale(${scale})`;
    blob.style.setProperty('--blob-color', hslColor(velocity));

    dot.style.left = mouseX + 'px';
    dot.style.top = mouseY + 'px';

    requestAnimationFrame(animate);
  }
  animate();
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
