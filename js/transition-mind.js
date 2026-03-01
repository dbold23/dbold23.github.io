// ============================================
// Mind Path: Iris clip-path zoom + Neural Network SVG
// ============================================

import { randomRange, prefersReducedMotion, sleep } from './utils.js';

let neuralAnimId = null;
let nodes = [];
let edges = [];
const NODE_COUNT = 30;
const MAX_EDGE_DIST = 180;

// ---- Neural Network Background ----
function initNeural() {
  const svg = document.getElementById('neural-svg');
  if (!svg) return;

  const w = window.innerWidth;
  const h = window.innerHeight;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  nodes = [];
  edges = [];

  for (let i = 0; i < NODE_COUNT; i++) {
    nodes.push({
      x: randomRange(0, w),
      y: randomRange(0, h),
      vx: randomRange(-0.3, 0.3),
      vy: randomRange(-0.3, 0.3),
      radius: randomRange(2, 5),
    });
  }
}

function startNeural() {
  if (prefersReducedMotion()) return;

  const svg = document.getElementById('neural-svg');
  if (!svg) return;

  initNeural();

  function animate() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Update positions
    nodes.forEach((n) => {
      n.x += n.vx;
      n.y += n.vy;

      // Bounce off edges
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
      n.x = Math.max(0, Math.min(w, n.x));
      n.y = Math.max(0, Math.min(h, n.y));
    });

    // Build SVG content
    let svgContent = '';

    // Draw edges between nearby nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < MAX_EDGE_DIST) {
          const opacity = (1 - dist / MAX_EDGE_DIST) * 0.6;
          svgContent += `<line x1="${nodes[i].x}" y1="${nodes[i].y}" x2="${nodes[j].x}" y2="${nodes[j].y}" stroke="rgba(199,125,255,${opacity})" stroke-width="1"/>`;
        }
      }
    }

    // Draw nodes
    nodes.forEach((n) => {
      svgContent += `<circle cx="${n.x}" cy="${n.y}" r="${n.radius}" fill="rgba(199,125,255,0.5)"/>`;
    });

    svg.innerHTML = svgContent;
    neuralAnimId = requestAnimationFrame(animate);
  }
  animate();
}

function stopNeural() {
  if (neuralAnimId) {
    cancelAnimationFrame(neuralAnimId);
    neuralAnimId = null;
  }
}

// ---- Entrance transition (iris zoom) ----
export async function enter() {
  if (prefersReducedMotion()) return;

  const overlay = document.getElementById('transition-overlay');
  overlay.classList.add('active');

  // Create iris element
  const iris = document.createElement('div');
  iris.className = 'transition-iris';
  overlay.querySelector('#transition-content').appendChild(iris);

  // Trigger expanding animation
  await sleep(50);
  iris.classList.add('expanding');

  await sleep(1500);

  // Clean up
  iris.remove();
  overlay.classList.remove('active');
}

// ---- Start/Stop ----
export function start() {
  startNeural();
}

export function stop() {
  stopNeural();
}
