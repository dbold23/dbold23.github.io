// ============================================
// Ocean Path: Wave clip-path + Canvas Bubble System
// ============================================

import { randomRange, prefersReducedMotion } from './utils.js';

let bubblePool = [];
let bubbleAnimId = null;
let bubbleCanvas = null;
let bubbleCtx = null;

class Bubble {
  constructor(w, h) {
    this.reset(w, h);
  }

  reset(w, h) {
    this.x = randomRange(0, w);
    this.y = h + randomRange(10, 100);
    this.radius = randomRange(2, 12);
    this.speed = randomRange(0.3, 1.5);
    this.wobbleSpeed = randomRange(0.01, 0.04);
    this.wobbleAmp = randomRange(10, 30);
    this.phase = randomRange(0, Math.PI * 2);
    this.opacity = randomRange(0.15, 0.5);
  }

  update(w, h) {
    this.y -= this.speed;
    this.phase += this.wobbleSpeed;
    this.x += Math.sin(this.phase) * 0.5;

    if (this.y < -20) {
      this.reset(w, h);
    }
  }

  draw(ctx) {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(184, 230, 245, ${this.opacity})`;
    ctx.fill();

    // Highlight
    ctx.beginPath();
    ctx.arc(this.x - this.radius * 0.3, this.y - this.radius * 0.3, this.radius * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity * 0.6})`;
    ctx.fill();
  }
}

export function startBubbles() {
  if (prefersReducedMotion()) return;

  bubbleCanvas = document.getElementById('bubble-canvas');
  if (!bubbleCanvas) return;

  bubbleCtx = bubbleCanvas.getContext('2d');
  resizeBubbleCanvas();
  window.addEventListener('resize', resizeBubbleCanvas);

  // Create pool
  const count = 40;
  bubblePool = [];
  for (let i = 0; i < count; i++) {
    bubblePool.push(new Bubble(bubbleCanvas.width, bubbleCanvas.height));
  }

  function animate() {
    bubbleCtx.clearRect(0, 0, bubbleCanvas.width, bubbleCanvas.height);
    bubblePool.forEach((b) => {
      b.update(bubbleCanvas.width, bubbleCanvas.height);
      b.draw(bubbleCtx);
    });
    bubbleAnimId = requestAnimationFrame(animate);
  }
  animate();
}

export function stopBubbles() {
  if (bubbleAnimId) {
    cancelAnimationFrame(bubbleAnimId);
    bubbleAnimId = null;
  }
  window.removeEventListener('resize', resizeBubbleCanvas);
}

// ---- Card Deck: Hover fan + Click detail expand ----
let backdrop = null;
let detailOverlay = null;
let escHandler = null;

let activeCardIndex = null;

function initCardDeck() {
  const deck = document.querySelector('.card-deck');
  if (!deck) return;

  const cards = deck.querySelectorAll('.deck-card');
  const preview = document.querySelector('.deck-preview');
  const previewTitle = preview?.querySelector('.deck-preview-title');
  const previewDesc = preview?.querySelector('.deck-preview-desc');
  const previewBtn = preview?.querySelector('.deck-preview-btn');

  // Create backdrop
  backdrop = document.createElement('div');
  backdrop.className = 'deck-backdrop';
  document.body.appendChild(backdrop);

  // Create detail overlay container (lives on body to avoid transform issues)
  detailOverlay = document.createElement('div');
  detailOverlay.className = 'deck-detail-overlay';
  document.body.appendChild(detailOverlay);

  // Hover cards → update preview panel
  cards.forEach((card) => {
    card.addEventListener('mouseenter', () => {
      const idx = parseInt(card.dataset.card, 10);
      if (idx === activeCardIndex) return;
      activeCardIndex = idx;

      if (previewTitle) previewTitle.textContent = card.dataset.previewTitle;
      if (previewDesc) previewDesc.textContent = card.dataset.previewDesc;
      if (previewBtn) previewBtn.style.display = '';
    });
  });

  // Mouse leaves entire deck → reset preview
  deck.addEventListener('mouseleave', () => {
    activeCardIndex = null;
    if (previewTitle) previewTitle.textContent = 'Hover a card to explore';
    if (previewDesc) previewDesc.textContent = 'Each card represents a research or presentation topic';
    if (previewBtn) previewBtn.style.display = 'none';
  });

  // Click "More details" in preview panel → open detail for active card
  if (previewBtn) {
    previewBtn.addEventListener('click', () => {
      if (activeCardIndex === null) return;
      const card = deck.querySelector(`[data-card="${activeCardIndex}"]`);
      const detailSource = card?.querySelector('.card-detail');
      if (detailSource) openDetail(detailSource);
    });
  }

  // Also allow clicking the card itself to open details
  deck.addEventListener('click', (e) => {
    const card = e.target.closest('.deck-card');
    if (!card) return;
    const detailSource = card.querySelector('.card-detail');
    if (detailSource) openDetail(detailSource);
  });

  // Backdrop click closes
  backdrop.addEventListener('click', closeDetail);

  // Escape key closes
  escHandler = (e) => {
    if (e.key === 'Escape' && detailOverlay.classList.contains('open')) {
      closeDetail();
    }
  };
  document.addEventListener('keydown', escHandler);
}

function openDetail(sourceEl) {
  if (!detailOverlay || !backdrop) return;

  // Clone the detail content into the overlay
  detailOverlay.innerHTML = '';

  // Add close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'deck-detail-close';
  closeBtn.setAttribute('aria-label', 'Close details');
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', closeDetail);
  detailOverlay.appendChild(closeBtn);

  // Clone and append content (skip the close btn from source)
  Array.from(sourceEl.children).forEach((child) => {
    if (!child.classList.contains('card-close-btn')) {
      detailOverlay.appendChild(child.cloneNode(true));
    }
  });

  backdrop.classList.add('visible');
  detailOverlay.classList.add('open');
}

function closeDetail() {
  if (!detailOverlay || !backdrop) return;
  detailOverlay.classList.remove('open');
  backdrop.classList.remove('visible');
}

function destroyCardDeck() {
  if (backdrop) {
    backdrop.remove();
    backdrop = null;
  }
  if (detailOverlay) {
    detailOverlay.remove();
    detailOverlay = null;
  }
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

// Start/Stop (called by app.js when path is active)
export function start() {
  startBubbles();
  initCardDeck();
}

export function stop() {
  stopBubbles();
  destroyCardDeck();
}

function resizeBubbleCanvas() {
  if (!bubbleCanvas) return;
  bubbleCanvas.width = window.innerWidth;
  bubbleCanvas.height = window.innerHeight;
}

// ---- Diagonal water gush entrance transition ----

function createDiveBubble(w, h) {
  return {
    x: randomRange(0, w),
    y: randomRange(0, h),
    radius: randomRange(2, 10),
    speed: randomRange(1, 3.5),
    wobbleSpeed: randomRange(0.02, 0.05),
    phase: randomRange(0, Math.PI * 2),
    opacity: randomRange(0.2, 0.6),
  };
}

function drawDiveBubble(ctx, b) {
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(184, 230, 245, ${b.opacity})`;
  ctx.fill();

  // Small highlight
  ctx.beginPath();
  ctx.arc(b.x - b.radius * 0.3, b.y - b.radius * 0.3, b.radius * 0.25, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 255, 255, ${b.opacity * 0.5})`;
  ctx.fill();
}

export async function enter() {
  if (prefersReducedMotion()) return;

  const overlay = document.getElementById('transition-overlay');
  overlay.classList.add('active');
  const content = overlay.querySelector('#transition-content');

  // Container
  const container = document.createElement('div');
  container.className = 'ocean-dive-container';

  // Water slab (diagonal clip-path sweep)
  const water = document.createElement('div');
  water.className = 'ocean-dive-water';
  container.appendChild(water);

  // Bubble canvas
  const bCanvas = document.createElement('canvas');
  bCanvas.className = 'ocean-dive-bubble-canvas';
  container.appendChild(bCanvas);

  content.appendChild(container);

  // Size canvas
  bCanvas.width = window.innerWidth;
  bCanvas.height = window.innerHeight;
  const bCtx = bCanvas.getContext('2d');

  // Create bubbles spread across the screen
  const diveBubbles = [];
  for (let i = 0; i < 35; i++) {
    diveBubbles.push(createDiveBubble(bCanvas.width, bCanvas.height));
  }

  // Bubble loop
  let animating = true;
  function animateBubbles() {
    if (!animating) return;
    bCtx.clearRect(0, 0, bCanvas.width, bCanvas.height);
    diveBubbles.forEach((b) => {
      b.y -= b.speed;
      b.phase += b.wobbleSpeed;
      b.x += Math.sin(b.phase) * 0.6;
      if (b.y < -20) {
        b.x = randomRange(0, bCanvas.width);
        b.y = bCanvas.height + randomRange(10, 40);
      }
      drawDiveBubble(bCtx, b);
    });
    requestAnimationFrame(animateBubbles);
  }
  animateBubbles();

  // Trigger diagonal sweep
  await new Promise((r) => setTimeout(r, 30));
  water.classList.add('rising');

  // Let it fill the screen
  await new Promise((r) => setTimeout(r, 1200));

  // Clean up
  animating = false;
  container.remove();
  overlay.classList.remove('active');
}
