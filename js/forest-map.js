/* ============================================
   Forest Map — Full-Screen Scrollytelling
   ============================================ */

const LOCATIONS = [
  {
    id: 'scmts',
    name: 'Santa Cruz Mountains',
    summary: 'Wilder Ranch & Henry Cowell trail construction',
    cardId: 'card-scmts',
    cx: 154, cy: 158,
    region: 'M 90,151 L 100,146 L 98,133 L 100,121 L 105,112 L 115,103 L 126,94 L 130,89 L 136,84 L 147,78 L 158,79 L 163,87 L 163,96 L 163,105 L 166,114 L 166,125 L 171,139 L 177,149 L 181,160 L 189,170 L 194,184 L 198,196 L 201,205 L 208,212 L 211,220 L 210,226 L 203,229 L 192,231 L 178,229 L 169,228 L 156,223 L 146,216 L 141,209 L 136,197 L 125,185 L 116,174 L 109,163 L 98,153 Z',
  },
  {
    id: 'nisene',
    name: 'Nisene Marks',
    summary: 'Trail committee chair, GIS mapping, volunteer leadership',
    cardId: 'card-nisene',
    cx: 259, cy: 194,
    region: 'M 261,227 L 259,220 L 251,217 L 241,209 L 239,200 L 236,192 L 236,181 L 236,171 L 244,166 L 253,166 L 264,168 L 273,168 L 281,168 L 284,175 L 279,185 L 274,197 L 271,204 L 267,211 L 265,221 L 264,228 Z',
  },
  {
    id: 'elkhorn',
    name: 'Elkhorn Slough',
    summary: 'Wetland habitat restoration & trail stewardship',
    cardId: 'card-elkhorn',
    cx: 350, cy: 291,
    region: 'M 319,310 L 326,307 L 333,302 L 338,296 L 341,288 L 343,275 L 345,267 L 357,263 L 365,272 L 372,270 L 380,272 L 376,282 L 370,287 L 367,295 L 364,301 L 354,305 L 343,308 L 337,310 L 326,312 Z',
  },
  {
    id: 'bigsur',
    name: 'Big Sur Land Trust',
    summary: '20,000+ acres of coastal & mountain stewardship',
    cardId: 'card-bigsur',
    cx: 358, cy: 481,
    region: 'M 309,469 L 317,473 L 323,478 L 330,485 L 333,495 L 339,501 L 343,507 L 358,509 L 365,511 L 385,508 L 389,497 L 394,487 L 399,476 L 400,469 L 395,459 L 384,457 L 375,459 L 368,465 L 350,472 L 337,469 L 327,467 Z',
  },
  {
    id: 'santalucia',
    name: 'Santa Lucia Conservancy',
    summary: '20,000-acre preserve, invasive species & biodiversity',
    cardId: 'card-santalucia',
    cx: 302, cy: 526,
    region: 'M 309,468 L 302,475 L 288,478 L 275,481 L 263,483 L 256,488 L 259,498 L 263,509 L 266,520 L 269,528 L 271,534 L 272,541 L 272,556 L 274,568 L 276,583 L 285,592 L 298,600 L 317,597 L 334,587 L 347,571 L 355,558 L 363,539 L 368,525 L 364,510 L 343,506 L 333,492 L 329,483 L 318,473 Z',
  }
];

// Traced California coastline
const COASTLINE_PATH = `
  M 45,-1 L 51,6 L 56,15 L 58,25 L 57,38 L 57,52 L 55,67 L 50,80 L 51,91 L 55,101 L 57,110 L 64,115 L 72,123 L 75,131 L 76,138 L 85,141 L 88,155 L 95,153 L 104,159 L 115,172 L 121,180 L 131,193 L 140,204 L 150,214 L 162,224 L 174,231 L 186,238 L 200,242 L 209,243 L 219,243 L 222,240 L 221,235 L 228,235 L 236,240 L 246,240 L 249,234 L 253,229 L 259,227 L 267,230 L 276,235 L 283,244 L 288,251 L 294,261 L 301,273 L 307,286 L 311,298 L 319,311 L 323,325 L 317,340 L 316,355 L 313,369 L 309,385 L 301,403 L 294,418 L 281,426 L 276,429 L 273,422 L 271,415 L 262,412 L 257,407 L 252,414 L 249,422 L 246,427 L 244,433 L 239,439 L 245,445 L 253,449 L 261,457 L 263,468 L 257,472 L 252,470 L 251,471 L 254,479 L 256,488 L 260,497 L 263,504 L 265,513 L 267,521 L 268,530 L 272,535 L 275,544 L 272,550 L 272,558 L 274,567 L 277,574 L 276,583 L 281,593 L 290,598 L 298,604 L 301,614 L 310,618 L 324,624 L 335,632 L 343,639 L 354,642 L 358,652 L 371,661 L 381,674 L 396,696 L 398,700 L 499,697 L 499,1 L 44,-2
`;

const LAND_PATH = `
  M 45,-1 L 51,6 L 56,15 L 58,25 L 57,38 L 57,52 L 55,67 L 50,80 L 51,91 L 55,101 L 57,110 L 64,115 L 72,123 L 75,131 L 76,138 L 85,141 L 88,155 L 95,153 L 104,159 L 115,172 L 121,180 L 131,193 L 140,204 L 150,214 L 162,224 L 174,231 L 186,238 L 200,242 L 209,243 L 219,243 L 222,240 L 221,235 L 228,235 L 236,240 L 246,240 L 249,234 L 253,229 L 259,227 L 267,230 L 276,235 L 283,244 L 288,251 L 294,261 L 301,273 L 307,286 L 311,298 L 319,311 L 323,325 L 317,340 L 316,355 L 313,369 L 309,385 L 301,403 L 294,418 L 281,426 L 276,429 L 273,422 L 271,415 L 262,412 L 257,407 L 252,414 L 249,422 L 246,427 L 244,433 L 239,439 L 245,445 L 253,449 L 261,457 L 263,468 L 257,472 L 252,470 L 251,471 L 254,479 L 256,488 L 260,497 L 263,504 L 265,513 L 267,521 L 268,530 L 272,535 L 275,544 L 272,550 L 272,558 L 274,567 L 277,574 L 276,583 L 281,593 L 290,598 L 298,604 L 301,614 L 310,618 L 324,624 L 335,632 L 343,639 L 354,642 L 358,652 L 371,661 L 381,674 L 396,696 L 398,700
  L 500,700 L 500,0 L 45,-1 Z
`;

// Region colors
const REGION_COLORS = {
  scmts:      'rgba(94, 201, 105, 0.2)',
  nisene:     'rgba(61, 184, 140, 0.2)',
  elkhorn:    'rgba(107, 194, 226, 0.2)',
  bigsur:     'rgba(224, 122, 95, 0.2)',
  santalucia: 'rgba(201, 168, 76, 0.2)',
};
const REGION_COLORS_ACTIVE = {
  scmts:      'rgba(94, 201, 105, 0.45)',
  nisene:     'rgba(61, 184, 140, 0.45)',
  elkhorn:    'rgba(107, 194, 226, 0.45)',
  bigsur:     'rgba(224, 122, 95, 0.45)',
  santalucia: 'rgba(201, 168, 76, 0.45)',
};
const REGION_STROKES = {
  scmts: '#5ec969', nisene: '#3db88c', elkhorn: '#6bc2e2',
  bigsur: '#e07a5f', santalucia: '#c9a84c',
};

// View targets per step: scale and translate to center each region
// Tuned to the 500x700 viewBox — tx/ty are offsets applied before scale
const MAP_VIEWS = {
  overview:   { scale: 1,   cx: 250, cy: 350 },
  scmts:      { scale: 3,   cx: 154, cy: 158 },
  nisene:     { scale: 3.5, cx: 259, cy: 194 },
  elkhorn:    { scale: 3.5, cx: 350, cy: 291 },
  bigsur:     { scale: 3,   cx: 358, cy: 481 },
  santalucia: { scale: 2.5, cx: 302, cy: 526 },
};

let stepObserver = null;
let activeStep = 'overview';
let isManualMode = false;
let manualTimeout = null;
let viewportGroup = null;

// Manual pan/zoom state
let manualScale = 1;
let manualTx = 0;
let manualTy = 0;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let panOrigin = { tx: 0, ty: 0 };

export function init(container) {
  if (!container) return;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 500 700');
  svg.setAttribute('class', 'forest-map-svg');
  svg.setAttribute('aria-label', 'Interactive map of Central California coast showing conservation work locations');
  svg.setAttribute('role', 'img');

  // Viewport group — everything goes inside, we transform this for pan/zoom
  viewportGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  viewportGroup.setAttribute('id', 'map-viewport');

  // Land mass
  const land = createPath(LAND_PATH, 'map-land');
  viewportGroup.appendChild(land);

  // Coastline stroke
  const coast = createPath(COASTLINE_PATH, 'map-coastline');
  coast.setAttribute('fill', 'none');
  viewportGroup.appendChild(coast);

  // Location regions + markers
  LOCATIONS.forEach(loc => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'map-marker');
    g.setAttribute('data-location', loc.id);
    g.style.cursor = 'pointer';

    // Region polygon
    if (loc.region) {
      const region = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      region.setAttribute('d', loc.region);
      region.setAttribute('class', 'map-region');
      region.setAttribute('data-region', loc.id);
      region.setAttribute('fill', REGION_COLORS[loc.id]);
      region.setAttribute('stroke', REGION_STROKES[loc.id]);
      region.setAttribute('stroke-width', '1.2');
      region.setAttribute('stroke-opacity', '0.5');
      region.setAttribute('stroke-linejoin', 'round');
      g.appendChild(region);
    }

    // Pulse ring
    const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    pulse.setAttribute('cx', loc.cx);
    pulse.setAttribute('cy', loc.cy);
    pulse.setAttribute('r', '12');
    pulse.setAttribute('class', 'marker-pulse');
    g.appendChild(pulse);

    // Dot
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', loc.cx);
    dot.setAttribute('cy', loc.cy);
    dot.setAttribute('r', '6');
    dot.setAttribute('class', 'marker-dot');
    g.appendChild(dot);

    // Label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', loc.cx + 16);
    text.setAttribute('y', loc.cy + 4);
    text.setAttribute('class', 'marker-label');
    text.textContent = loc.name;
    g.appendChild(text);

    // Click region to jump to step
    g.addEventListener('click', () => {
      const stepEl = document.querySelector(`.forest-step[data-step="${loc.id}"]`);
      if (stepEl) stepEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    viewportGroup.appendChild(g);
  });

  svg.appendChild(viewportGroup);
  container.appendChild(svg);

  // Set initial view
  setMapView('overview', false);

  // Setup scroll observer
  setupStepObserver();

  // Setup manual pan/zoom
  setupManualInteraction(container);
}

function createPath(d, className) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', className);
  return path;
}

// ── Map view transitions ──

function setMapView(stepId, animate = true) {
  if (!viewportGroup) return;
  const view = MAP_VIEWS[stepId];
  if (!view) return;

  activeStep = stepId;

  // Calculate transform: center the target point in the viewport
  // SVG viewBox is 500x700, we want (view.cx, view.cy) at center
  const tx = 250 - view.cx * view.scale;
  const ty = 350 - view.cy * view.scale;

  viewportGroup.style.transition = animate ? 'transform 0.7s cubic-bezier(0.4, 0, 0.2, 1)' : 'none';
  viewportGroup.style.transformOrigin = '0 0';
  viewportGroup.style.transform = `translate(${tx}px, ${ty}px) scale(${view.scale})`;

  // Update active region highlights
  document.querySelectorAll('.map-region').forEach(r => {
    const id = r.dataset.region;
    if (id === stepId) {
      r.setAttribute('fill', REGION_COLORS_ACTIVE[id] || REGION_COLORS[id]);
      r.setAttribute('stroke-opacity', '0.9');
      r.setAttribute('stroke-width', '2');
    } else {
      r.setAttribute('fill', REGION_COLORS[id]);
      r.setAttribute('stroke-opacity', '0.5');
      r.setAttribute('stroke-width', '1.2');
    }
  });

  // Update active marker
  document.querySelectorAll('.map-marker').forEach(m => {
    m.classList.toggle('active', m.dataset.location === stepId);
  });

  // Update card visibility
  document.querySelectorAll('.forest-card').forEach(card => {
    const step = card.closest('.forest-step');
    if (step && step.dataset.step === stepId) {
      card.classList.add('visible');
    } else {
      card.classList.remove('visible');
    }
  });
}

// ── Scroll step observer ──

function setupStepObserver() {
  const steps = document.querySelectorAll('.forest-step');
  if (!steps.length) return;

  stepObserver = new IntersectionObserver(entries => {
    if (isManualMode) return;

    entries.forEach(entry => {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        const stepId = entry.target.dataset.step;
        if (stepId && stepId !== activeStep) {
          setMapView(stepId);
        }
      }
    });
  }, {
    threshold: [0.5],
    rootMargin: '-10% 0px -10% 0px',
  });

  steps.forEach(step => stepObserver.observe(step));
}

// ── Manual pan/zoom ──

function setupManualInteraction(container) {
  // Mouse wheel zoom
  container.addEventListener('wheel', e => {
    e.preventDefault();
    enterManualMode();

    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    manualScale = Math.max(0.8, Math.min(5, manualScale + delta));

    applyManualTransform();
  }, { passive: false });

  // Mouse drag pan
  container.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
    panOrigin = { tx: manualTx, ty: manualTy };
    container.style.cursor = 'grabbing';
    enterManualMode();
  });

  window.addEventListener('mousemove', e => {
    if (!isPanning) return;
    manualTx = panOrigin.tx + (e.clientX - panStart.x);
    manualTy = panOrigin.ty + (e.clientY - panStart.y);
    applyManualTransform();
  });

  window.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      container.style.cursor = '';
    }
  });

  // Touch gestures
  let lastTouchDist = 0;
  let lastTouchCenter = { x: 0, y: 0 };

  container.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      isPanning = true;
      panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      panOrigin = { tx: manualTx, ty: manualTy };
      enterManualMode();
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      lastTouchDist = Math.hypot(dx, dy);
      lastTouchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
      enterManualMode();
    }
  }, { passive: true });

  container.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && isPanning) {
      e.preventDefault();
      manualTx = panOrigin.tx + (e.touches[0].clientX - panStart.x);
      manualTy = panOrigin.ty + (e.touches[0].clientY - panStart.y);
      applyManualTransform();
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.hypot(dx, dy);
      if (lastTouchDist > 0) {
        const pinchScale = dist / lastTouchDist;
        manualScale = Math.max(0.8, Math.min(5, manualScale * pinchScale));
      }
      lastTouchDist = dist;
      applyManualTransform();
    }
  }, { passive: false });

  container.addEventListener('touchend', () => {
    isPanning = false;
    lastTouchDist = 0;
  }, { passive: true });
}

function enterManualMode() {
  if (!isManualMode) {
    isManualMode = true;
    // Capture current computed transform as manual starting point
    const view = MAP_VIEWS[activeStep];
    if (view && manualScale === 1 && manualTx === 0 && manualTy === 0) {
      manualScale = view.scale;
      manualTx = 250 - view.cx * view.scale;
      manualTy = 350 - view.cy * view.scale;
    }
  }

  // Reset timeout — resume scroll-driving after 3s of no interaction
  clearTimeout(manualTimeout);
  manualTimeout = setTimeout(exitManualMode, 3000);
}

function exitManualMode() {
  isManualMode = false;
  manualScale = 1;
  manualTx = 0;
  manualTy = 0;
  // Snap back to current step
  setMapView(activeStep);
}

function applyManualTransform() {
  if (!viewportGroup) return;
  viewportGroup.style.transition = 'none';
  viewportGroup.style.transformOrigin = '0 0';
  viewportGroup.style.transform = `translate(${manualTx}px, ${manualTy}px) scale(${manualScale})`;
}

// ── Cleanup ──

export function destroy() {
  if (stepObserver) {
    stepObserver.disconnect();
    stepObserver = null;
  }
  clearTimeout(manualTimeout);
  isManualMode = false;
  manualScale = 1;
  manualTx = 0;
  manualTy = 0;
  activeStep = 'overview';
  viewportGroup = null;

  const container = document.getElementById('forest-map-container');
  if (container) container.innerHTML = '';
}
