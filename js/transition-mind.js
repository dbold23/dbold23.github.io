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

// ---- Captain's Log ----
// Full screen chapters. Moving on runs a lit sweep down or up the deck and the
// arriving chapter is uncovered behind it, rather than fading in over the top.

let current = 0;
let moving = false;
let logReady = false;

const SWEEP_MS = 820;
const SWEEP_EASE = 'cubic-bezier(0.65, 0, 0.2, 1)';

function chapters() {
  return Array.from(document.querySelectorAll('.log-chapter'));
}

function syncNav() {
  const all = chapters();
  document.querySelectorAll('.log-dot').forEach((dot) => {
    const idx = parseInt(dot.dataset.chapter, 10);
    if (idx === current) dot.setAttribute('aria-current', 'true');
    else dot.removeAttribute('aria-current');
    if (idx === current) dot.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  const prev = document.getElementById('log-prev');
  const next = document.getElementById('log-next');
  if (prev) prev.disabled = current === 0;
  if (next) next.disabled = current === all.length - 1;

  // The phone layout turns the rail off, so this is the only thing left saying
  // where in the book you are. Roman, to match the numerals the rail uses and
  // the "Chapter IV" above each entry.
  const count = document.getElementById('log-count');
  if (count) count.textContent = `${roman(current + 1)} / ${roman(all.length)}`;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
function roman(n) {
  return ROMAN[n - 1] || String(n);
}

function setCurrent(idx) {
  chapters().forEach((el) => {
    const isIt = parseInt(el.dataset.chapter, 10) === idx;
    el.classList.toggle('is-current', isIt);
    el.classList.remove('is-leaving');
    el.setAttribute('aria-hidden', isIt ? 'false' : 'true');
  });
  current = idx;
  syncNav();
}

function goTo(idx) {
  const all = chapters();
  if (moving || idx === current || idx < 0 || idx >= all.length) return;

  if (prefersReducedMotion()) { setCurrent(idx); return; }

  const from = all.find((el) => parseInt(el.dataset.chapter, 10) === current);
  const to = all.find((el) => parseInt(el.dataset.chapter, 10) === idx);
  const sweep = document.getElementById('log-sweep');
  if (!from || !to) { setCurrent(idx); return; }

  moving = true;
  const forward = idx > current;

  // Outgoing stays put and is covered over; incoming is uncovered behind the line
  from.classList.add('is-leaving');
  to.classList.add('is-current');
  to.setAttribute('aria-hidden', 'false');
  to.style.zIndex = '4';
  from.style.zIndex = '3';

  const hidden = forward ? 'inset(100% 0 0 0)' : 'inset(0 0 100% 0)';
  const shown = 'inset(0 0 0 0)';
  const timing = { duration: SWEEP_MS, easing: SWEEP_EASE, fill: 'both' };

  const reveal = to.animate([{ clipPath: hidden }, { clipPath: shown }], timing);

  // The chapter being left lets its writing go first, so the two sets of words
  // never sit on top of each other as the line passes
  from.querySelector('.log-copy')?.animate(
    [{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }],
    timing
  );

  // The image settles as it arrives, so the chapter reads as coming toward you
  to.querySelector('.log-media')?.animate(
    [{ transform: forward ? 'scale(1.08) translateY(2%)' : 'scale(1.08) translateY(-2%)' },
     { transform: 'scale(1) translateY(0)' }],
    { duration: SWEEP_MS + 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' }
  );

  // Words arrive after the line has passed them
  const copy = to.querySelector('.log-copy');
  if (copy) {
    copy.animate(
      [{ opacity: 0, transform: 'translateY(18px)' },
       { opacity: 0, transform: 'translateY(18px)', offset: 0.45 },
       { opacity: 1, transform: 'translateY(0)' }],
      { duration: SWEEP_MS + 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' }
    );
  }

  if (sweep) {
    sweep.animate(
      [{ top: forward ? '100%' : '0%', opacity: 0 },
       { opacity: 1, offset: 0.12 },
       { opacity: 1, offset: 0.86 },
       { top: forward ? '0%' : '100%', opacity: 0 }],
      timing
    );
  }

  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    from.classList.remove('is-current', 'is-leaving');
    from.setAttribute('aria-hidden', 'true');
    from.style.zIndex = '';
    to.style.zIndex = '';
    current = idx;
    syncNav();
    moving = false;
  };
  // A backgrounded tab freezes the document timeline, so 'finish' may never
  // arrive and the deck would stay locked. Settle it either way.
  const guard = setTimeout(done, SWEEP_MS + 600);
  reveal.addEventListener('finish', done, { once: true });
  reveal.addEventListener('cancel', done, { once: true });
}

function initLog() {
  const flyleaf = document.getElementById('journal-flyleaf');
  const deck = document.getElementById('log-deck');
  const openBtn = document.getElementById('journal-open-btn');
  if (!flyleaf || !deck || !openBtn) return;

  if (logReady) return;
  logReady = true;

  openBtn.addEventListener('click', () => {
    flyleaf.classList.add('hidden');
    document.getElementById('path-mind')?.classList.add('log-open');
    deck.hidden = false;
    setCurrent(0);
    window.scrollTo({ top: 0, behavior: 'instant' });
  });

  document.getElementById('log-prev')?.addEventListener('click', () => goTo(current - 1));
  document.getElementById('log-next')?.addEventListener('click', () => goTo(current + 1));

  deck.querySelectorAll('.log-dot').forEach((dot) => {
    dot.addEventListener('click', () => goTo(parseInt(dot.dataset.chapter, 10)));
  });

  document.addEventListener('keydown', (e) => {
    if (deck.hidden || moving) return;
    if (e.key === 'ArrowRight') goTo(current + 1);
    else if (e.key === 'ArrowLeft') goTo(current - 1);
  });

  // Bound unconditionally rather than behind a touch test. The test was
  // matchMedia('(pointer: coarse)') read once, at the moment the log is first
  // opened; a touchscreen laptop reports fine and got no swipe at all. Touch
  // events do not fire on a device that has no touch, so there is nothing to
  // guard against.
  {
    let startX = 0, startY = 0;
    deck.addEventListener('touchstart', (e) => {
      startX = e.changedTouches[0].clientX;
      startY = e.changedTouches[0].clientY;
    }, { passive: true });
    deck.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        goTo(dx < 0 ? current + 1 : current - 1);
      }
    }, { passive: true });
  }

  syncNav();
}

// ---- Start/Stop ----
export function start() {
  startNeural();
  initLog();
}

export function stop() {
  stopNeural();
}
