// ============================================
// Ocean Path: Wave clip-path + the water behind the research bubbles
// ============================================
//
// The background is a WebGL volume (js/ocean-water.js): sharks making runs
// through scattered bubbles. The flat canvas bubbles below are what runs if
// that will not start — no WebGL, or the context is refused.

import { randomRange, prefersReducedMotion } from './utils.js';

let water = null;         // the 3D module, once it has loaded and started

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

  // Null if something already claimed the canvas for WebGL, which is possible
  // if the 3D water got a context and then failed later on
  bubbleCtx = bubbleCanvas.getContext('2d');
  if (!bubbleCtx) return;

  resizeBubbleCanvas();
  window.addEventListener('resize', resizeBubbleCanvas);

  // Create pool
  const count = 40;
  bubblePool = [];
  for (let i = 0; i < count; i++) {
    bubblePool.push(new Bubble(bubbleCanvas.width, bubbleCanvas.height));
  }

  bubbleCanvas.classList.add('is-lit');

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

// Start/Stop (called by app.js when path is active)
export async function start() {
  if (water) {
    water.resume();
    return;
  }

  const canvas = document.getElementById('bubble-canvas');
  // The 2D fallback needs the same canvas, so WebGL has to get first refusal:
  // a canvas that has handed out a 2D context can never hand out a WebGL one.
  if (canvas && window.WebGLRenderingContext) {
    try {
      const mod = await import('./ocean-water.js?v=20260818i');
      if (await mod.initOceanWater(canvas)) {
        water = mod;
        return;
      }
    } catch (err) {
      console.warn('Ocean water: falling back to flat bubbles.', err);
    }
  }

  startBubbles();
}

export function stop() {
  if (water) {
    water.pause();
    return;
  }
  stopBubbles();
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

  const container = document.createElement('div');
  container.className = 'ocean-dive-container';

  // Create 3 wave layers (deep → mid → surface)
  const WAVE_LAYERS = [
    { color: '#041230', amplitude: 15, frequency: 1.2, speed: 0.015, delay: 0 },
    { color: '#0a2463', amplitude: 25, frequency: 1.0, speed: 0.012, delay: 250 },
    { color: 'rgba(30, 95, 140, 0.9)', amplitude: 35, frequency: 0.8, speed: 0.01, delay: 500 },
  ];

  const waveDivs = WAVE_LAYERS.map((layer) => {
    const div = document.createElement('div');
    div.className = 'ocean-wave-layer';
    div.style.background = layer.color;
    container.appendChild(div);
    return div;
  });

  // Bubble canvas
  const bCanvas = document.createElement('canvas');
  bCanvas.className = 'ocean-dive-bubble-canvas';
  container.appendChild(bCanvas);
  content.appendChild(container);

  bCanvas.width = window.innerWidth;
  bCanvas.height = window.innerHeight;
  const bCtx = bCanvas.getContext('2d');

  const diveBubbles = [];
  for (let i = 0; i < 35; i++) {
    diveBubbles.push(createDiveBubble(bCanvas.width, bCanvas.height));
  }

  // Animate wave rise + bubbles together via rAF
  const DURATION = 2000;
  const startTime = performance.now();
  let animating = true;

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function animate(now) {
    if (!animating) return;
    const elapsed = now - startTime;

    // Update each wave layer's clip-path
    WAVE_LAYERS.forEach((layer, i) => {
      const layerElapsed = Math.max(0, elapsed - layer.delay);
      const progress = Math.min(1, layerElapsed / (DURATION - layer.delay));
      const easedProgress = easeOutCubic(progress);

      // Wave rises from bottom: y offset goes from 110% down to -10% up
      const yOffset = 110 - easedProgress * 120;

      // Build wavy polygon top edge using sine
      const points = [];
      const segments = 20;
      for (let s = 0; s <= segments; s++) {
        const x = (s / segments) * 100;
        const wave =
          Math.sin(
            (s / segments) * Math.PI * 2 * layer.frequency +
              now * layer.speed
          ) *
          layer.amplitude *
          Math.min(1, easedProgress * 3);
        const y = yOffset + wave * (1 - easedProgress * 0.5);
        points.push(`${x}% ${y}%`);
      }
      // Close polygon at bottom
      points.push('100% 120%', '0% 120%');
      waveDivs[i].style.clipPath = `polygon(${points.join(', ')})`;
    });

    // Bubbles
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

    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Wait for animation to complete
  await new Promise((r) => setTimeout(r, DURATION + 200));

  // Stop animation and remove wave layers
  animating = false;
  container.remove();

  // Defer overlay fade to next frame — lets app.js hide homescreen
  // and show the path section before we reveal what's underneath
  requestAnimationFrame(() => {
    overlay.classList.remove('active');
  });
}
