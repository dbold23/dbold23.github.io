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

// ---- Captain's Log Journal ----
let currentChapter = 0;
let turning = false;

function initJournal() {
  const flyleaf = document.getElementById('journal-flyleaf');
  const journal = document.getElementById('journal');
  const openBtn = document.getElementById('journal-open-btn');
  if (!flyleaf || !journal || !openBtn) return;

  openBtn.addEventListener('click', () => {
    // Brief press animation before revealing
    openBtn.style.transform = 'scale(0.95)';
    setTimeout(() => {
      flyleaf.classList.add('hidden');
      journal.classList.add('visible');
      showChapter(0);
    }, 150);
  });

  // Tab clicks
  journal.querySelectorAll('.journal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const idx = parseInt(tab.dataset.chapter, 10);
      if (idx !== currentChapter && !turning) {
        turnToChapter(idx);
      }
    });
  });

  // Click on right page → next chapter, left page → previous chapter
  journal.addEventListener('click', (e) => {
    if (turning) return;
    const rightPage = e.target.closest('.journal-page--right');
    const leftPage = e.target.closest('.journal-page--left');
    if (rightPage && currentChapter < 6) {
      turnToChapter(currentChapter + 1);
    } else if (leftPage && currentChapter > 0) {
      turnToChapter(currentChapter - 1);
    }
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (!journal.classList.contains('visible') || turning) return;
    if (e.key === 'ArrowRight' && currentChapter < 6) {
      turnToChapter(currentChapter + 1);
    } else if (e.key === 'ArrowLeft' && currentChapter > 0) {
      turnToChapter(currentChapter - 1);
    }
  });
}

function showChapter(idx) {
  const journal = document.getElementById('journal');
  if (!journal) return;
  journal.querySelectorAll('.journal-spread').forEach(s => {
    s.classList.remove('active');
  });
  const target = journal.querySelector(`.journal-spread[data-chapter="${idx}"]`);
  if (target) target.classList.add('active');
  currentChapter = idx;
  updateTabs();
}

function turnToChapter(idx) {
  if (prefersReducedMotion()) { showChapter(idx); return; }

  const journal = document.getElementById('journal');
  if (!journal) return;
  turning = true;

  const peelClass = idx > currentChapter ? 'page-turning-forward' : 'page-turning-backward';

  const current = journal.querySelector('.journal-spread.active');
  const target = journal.querySelector(`.journal-spread[data-chapter="${idx}"]`);

  if (current && target) {
    // Show incoming spread underneath the peel
    target.classList.add('peel-entering');

    // Peel the outgoing page away
    current.classList.add(peelClass);

    setTimeout(() => {
      // Clean up outgoing
      current.classList.remove('active', peelClass);
      // Promote incoming to active
      target.classList.remove('peel-entering');
      target.classList.add('active');
      currentChapter = idx;
      updateTabs();
      turning = false;
    }, 850);
  } else {
    showChapter(idx);
    turning = false;
  }
}

function updateTabs() {
  const journal = document.getElementById('journal');
  if (!journal) return;
  journal.querySelectorAll('.journal-tab').forEach(tab => {
    const idx = parseInt(tab.dataset.chapter, 10);
    tab.classList.toggle('active', idx === currentChapter);
  });
}

// ---- Start/Stop ----
export function start() {
  startNeural();
  initJournal();
}

export function stop() {
  stopNeural();
}
