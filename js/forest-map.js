/* ============================================
   Forest Map — Interactive California Coast SVG
   ============================================ */

const LOCATIONS = [
  {
    id: 'scmts',
    name: 'Santa Cruz Mountains',
    summary: 'Wilder Ranch & Henry Cowell trail construction',
    cardId: 'card-scmts',
    // SVG viewBox coords (500x700)
    cx: 168, cy: 108
  },
  {
    id: 'nisene',
    name: 'Nisene Marks',
    summary: 'Trail committee chair, GIS mapping, volunteer leadership',
    cardId: 'card-nisene',
    cx: 195, cy: 145
  },
  {
    id: 'elkhorn',
    name: 'Elkhorn Slough',
    summary: 'Wetland habitat restoration & trail stewardship',
    cardId: 'card-elkhorn',
    cx: 210, cy: 210
  },
  {
    id: 'santalucia',
    name: 'Santa Lucia Conservancy',
    summary: '20,000-acre preserve, invasive species & biodiversity',
    cardId: 'card-santalucia',
    cx: 175, cy: 310
  },
  {
    id: 'bigsur',
    name: 'Big Sur Land Trust',
    summary: '20,000+ acres of coastal & mountain stewardship',
    cardId: 'card-bigsur',
    cx: 135, cy: 430
  }
];

// Simplified, recognizable Central California coastline path
// Runs from ~Santa Cruz (north) to south of Big Sur
// viewBox: 0 0 500 700
const COASTLINE_PATH = `
  M 210 0
  C 205 20, 195 40, 185 60
  C 175 80, 165 90, 155 105
  Q 145 120, 150 140
  C 155 155, 170 165, 180 175
  Q 195 190, 210 200
  C 225 210, 235 220, 240 235
  Q 245 250, 238 268
  C 230 285, 218 295, 210 310
  Q 200 325, 190 340
  C 178 360, 165 380, 155 400
  Q 142 420, 130 440
  C 118 460, 108 480, 100 500
  Q 90 520, 82 545
  C 75 570, 68 595, 60 620
  Q 52 650, 45 680
  L 45 700
`;

// Land mass — extends from coastline eastward to fill
const LAND_PATH = `
  ${COASTLINE_PATH.trim()}
  L 500 700
  L 500 0
  L 210 0
  Z
`;

// Contour lines for topographic feel (inland from coast)
const CONTOUR_PATHS = [
  // First contour — close to coast
  `M 230 0 C 225 30, 215 60, 205 85
   C 195 105, 185 115, 178 130
   Q 172 148, 178 165
   C 185 180, 198 190, 208 200
   Q 228 215, 245 230
   C 255 240, 260 255, 255 275
   C 248 295, 235 310, 225 330
   Q 215 348, 205 365
   C 193 385, 180 405, 170 425
   Q 158 445, 148 465
   C 138 485, 128 510, 120 535
   Q 110 560, 100 585
   L 90 640 L 80 700`,
  // Second contour — further inland
  `M 270 0 C 265 40, 255 80, 245 110
   C 235 135, 225 150, 220 170
   Q 215 190, 222 210
   C 230 225, 245 235, 258 248
   Q 275 265, 280 285
   C 278 305, 268 325, 258 345
   Q 248 365, 238 385
   C 225 410, 215 435, 205 460
   Q 192 485, 182 510
   C 170 540, 160 570, 150 600
   L 140 650 L 130 700`
];

let activeLocation = null;
let scrollObserver = null;

export function init(container) {
  if (!container) return;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 500 700');
  svg.setAttribute('class', 'forest-map-svg');
  svg.setAttribute('aria-label', 'Map of Central California coast showing conservation work locations');
  svg.setAttribute('role', 'img');

  // Ocean background (implied by the container bg)
  // Land mass
  const land = createPath(LAND_PATH, 'map-land');
  svg.appendChild(land);

  // Contour lines
  CONTOUR_PATHS.forEach((d, i) => {
    const contour = createPath(d, `map-contour map-contour-${i + 1}`);
    contour.setAttribute('fill', 'none');
    svg.appendChild(contour);
  });

  // Coastline stroke
  const coast = createPath(COASTLINE_PATH, 'map-coastline');
  coast.setAttribute('fill', 'none');
  svg.appendChild(coast);

  // Location markers
  LOCATIONS.forEach(loc => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'map-marker');
    g.setAttribute('data-location', loc.id);
    g.style.cursor = 'pointer';

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

    // Events
    g.addEventListener('mouseenter', () => showTooltip(loc, g, container));
    g.addEventListener('mouseleave', () => hideTooltip(container));
    g.addEventListener('click', () => scrollToCard(loc));

    svg.appendChild(g);
  });

  container.appendChild(svg);

  // Create tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'map-tooltip';
  tooltip.setAttribute('aria-hidden', 'true');
  container.appendChild(tooltip);

  // Set up scroll-linked active marker tracking
  setupScrollObserver();
}

function createPath(d, className) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', className);
  return path;
}

function showTooltip(loc, markerGroup, container) {
  const tooltip = container.querySelector('.map-tooltip');
  if (!tooltip) return;

  tooltip.innerHTML = `<strong>${loc.name}</strong><span>${loc.summary}</span>`;
  tooltip.classList.add('visible');

  // Position tooltip relative to the container
  const svg = container.querySelector('svg');
  const svgRect = svg.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  // Convert SVG coords to pixel coords
  const scaleX = svgRect.width / 500;
  const scaleY = svgRect.height / 700;
  const px = svgRect.left - containerRect.left + loc.cx * scaleX;
  const py = svgRect.top - containerRect.top + loc.cy * scaleY;

  // Place tooltip to the right of the marker, or left if near right edge
  const tooltipWidth = tooltip.offsetWidth;
  if (px + tooltipWidth + 30 > containerRect.width) {
    tooltip.style.left = `${px - tooltipWidth - 15}px`;
  } else {
    tooltip.style.left = `${px + 20}px`;
  }
  tooltip.style.top = `${py - 15}px`;

  // Highlight marker
  markerGroup.classList.add('hovered');
}

function hideTooltip(container) {
  const tooltip = container.querySelector('.map-tooltip');
  if (tooltip) {
    tooltip.classList.remove('visible');
  }
  const hovered = container.querySelector('.map-marker.hovered');
  if (hovered) hovered.classList.remove('hovered');
}

function scrollToCard(loc) {
  const card = document.getElementById(loc.cardId);
  if (!card) return;

  card.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Flash highlight
  card.classList.add('map-highlight');
  setTimeout(() => card.classList.remove('map-highlight'), 1500);

  setActiveMarker(loc.id);
}

function setActiveMarker(id) {
  activeLocation = id;
  document.querySelectorAll('.map-marker').forEach(m => {
    m.classList.toggle('active', m.dataset.location === id);
  });
}

function setupScrollObserver() {
  // Track which card is in viewport and highlight the corresponding marker
  const options = { threshold: 0.5 };

  scrollObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const cardId = entry.target.id;
        const loc = LOCATIONS.find(l => l.cardId === cardId);
        if (loc) setActiveMarker(loc.id);
      }
    });
  }, options);

  LOCATIONS.forEach(loc => {
    const card = document.getElementById(loc.cardId);
    if (card) scrollObserver.observe(card);
  });
}

export function destroy() {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  activeLocation = null;

  const container = document.getElementById('forest-map-container');
  if (container) container.innerHTML = '';
}
