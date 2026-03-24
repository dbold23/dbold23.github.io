/* ============================================
   Forest Map — Interactive California Coast SVG
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
    id: 'santalucia',
    name: 'Santa Lucia Conservancy',
    summary: '20,000-acre preserve, invasive species & biodiversity',
    cardId: 'card-santalucia',
    cx: 302, cy: 526,
    region: 'M 309,468 L 302,475 L 288,478 L 275,481 L 263,483 L 256,488 L 259,498 L 263,509 L 266,520 L 269,528 L 271,534 L 272,541 L 272,556 L 274,568 L 276,583 L 285,592 L 298,600 L 317,597 L 334,587 L 347,571 L 355,558 L 363,539 L 368,525 L 364,510 L 343,506 L 333,492 L 329,483 L 318,473 Z',
  },
  {
    id: 'bigsur',
    name: 'Big Sur Land Trust',
    summary: '20,000+ acres of coastal & mountain stewardship',
    cardId: 'card-bigsur',
    cx: 358, cy: 481,
    region: 'M 309,469 L 317,473 L 323,478 L 330,485 L 333,495 L 339,501 L 343,507 L 358,509 L 365,511 L 385,508 L 389,497 L 394,487 L 399,476 L 400,469 L 395,459 L 384,457 L 375,459 L 368,465 L 350,472 L 337,469 L 327,467 Z',
  }
];

// Traced California coastline (Santa Cruz → Big Sur)
const COASTLINE_PATH = `
  M 45,-1 L 51,6 L 56,15 L 58,25 L 57,38 L 57,52 L 55,67 L 50,80 L 51,91 L 55,101 L 57,110 L 64,115 L 72,123 L 75,131 L 76,138 L 85,141 L 88,155 L 95,153 L 104,159 L 115,172 L 121,180 L 131,193 L 140,204 L 150,214 L 162,224 L 174,231 L 186,238 L 200,242 L 209,243 L 219,243 L 222,240 L 221,235 L 228,235 L 236,240 L 246,240 L 249,234 L 253,229 L 259,227 L 267,230 L 276,235 L 283,244 L 288,251 L 294,261 L 301,273 L 307,286 L 311,298 L 319,311 L 323,325 L 317,340 L 316,355 L 313,369 L 309,385 L 301,403 L 294,418 L 281,426 L 276,429 L 273,422 L 271,415 L 262,412 L 257,407 L 252,414 L 249,422 L 246,427 L 244,433 L 239,439 L 245,445 L 253,449 L 261,457 L 263,468 L 257,472 L 252,470 L 251,471 L 254,479 L 256,488 L 260,497 L 263,504 L 265,513 L 267,521 L 268,530 L 272,535 L 275,544 L 272,550 L 272,558 L 274,567 L 277,574 L 276,583 L 281,593 L 290,598 L 298,604 L 301,614 L 310,618 L 324,624 L 335,632 L 343,639 L 354,642 L 358,652 L 371,661 L 381,674 L 396,696 L 398,700 L 499,697 L 499,1 L 44,-2
`;

// Land mass — coastline closed eastward
const LAND_PATH = `
  M 45,-1 L 51,6 L 56,15 L 58,25 L 57,38 L 57,52 L 55,67 L 50,80 L 51,91 L 55,101 L 57,110 L 64,115 L 72,123 L 75,131 L 76,138 L 85,141 L 88,155 L 95,153 L 104,159 L 115,172 L 121,180 L 131,193 L 140,204 L 150,214 L 162,224 L 174,231 L 186,238 L 200,242 L 209,243 L 219,243 L 222,240 L 221,235 L 228,235 L 236,240 L 246,240 L 249,234 L 253,229 L 259,227 L 267,230 L 276,235 L 283,244 L 288,251 L 294,261 L 301,273 L 307,286 L 311,298 L 319,311 L 323,325 L 317,340 L 316,355 L 313,369 L 309,385 L 301,403 L 294,418 L 281,426 L 276,429 L 273,422 L 271,415 L 262,412 L 257,407 L 252,414 L 249,422 L 246,427 L 244,433 L 239,439 L 245,445 L 253,449 L 261,457 L 263,468 L 257,472 L 252,470 L 251,471 L 254,479 L 256,488 L 260,497 L 263,504 L 265,513 L 267,521 L 268,530 L 272,535 L 275,544 L 272,550 L 272,558 L 274,567 L 277,574 L 276,583 L 281,593 L 290,598 L 298,604 L 301,614 L 310,618 L 324,624 L 335,632 L 343,639 L 354,642 L 358,652 L 371,661 L 381,674 L 396,696 L 398,700
  L 500,700 L 500,0 L 45,-1 Z
`;

// No contour lines for now (can add later)
const CONTOUR_PATHS = [];

// Region fill colors per location
const REGION_COLORS = {
  scmts:      'rgba(94, 201, 105, 0.25)',
  nisene:     'rgba(61, 184, 140, 0.25)',
  elkhorn:    'rgba(107, 194, 226, 0.25)',
  santalucia: 'rgba(201, 168, 76, 0.25)',
  bigsur:     'rgba(224, 122, 95, 0.25)',
};

const REGION_STROKES = {
  scmts:      '#5ec969',
  nisene:     '#3db88c',
  elkhorn:    '#6bc2e2',
  santalucia: '#c9a84c',
  bigsur:     '#e07a5f',
};

let activeLocation = null;
let scrollObserver = null;

export function init(container) {
  if (!container) return;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 500 700');
  svg.setAttribute('class', 'forest-map-svg');
  svg.setAttribute('aria-label', 'Map of Central California coast showing conservation work locations');
  svg.setAttribute('role', 'img');

  // Land mass
  const land = createPath(LAND_PATH, 'map-land');
  svg.appendChild(land);

  // Contour lines (if any)
  CONTOUR_PATHS.forEach((d, i) => {
    const contour = createPath(d, `map-contour map-contour-${i + 1}`);
    contour.setAttribute('fill', 'none');
    svg.appendChild(contour);
  });

  // Coastline stroke
  const coast = createPath(COASTLINE_PATH, 'map-coastline');
  coast.setAttribute('fill', 'none');
  svg.appendChild(coast);

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
      region.setAttribute('fill', REGION_COLORS[loc.id] || 'rgba(74,155,106,0.2)');
      region.setAttribute('stroke', REGION_STROKES[loc.id] || '#4a9b6a');
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

    // Events
    g.addEventListener('mouseenter', () => {
      showTooltip(loc, g, container);
      g.classList.add('hovered');
      showCard(loc);
    });
    g.addEventListener('mouseleave', () => {
      hideTooltip(container);
      g.classList.remove('hovered');
      hideCard(loc);
    });
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
}

function hideTooltip(container) {
  const tooltip = container.querySelector('.map-tooltip');
  if (tooltip) {
    tooltip.classList.remove('visible');
  }
}

function showCard(loc) {
  const card = document.getElementById(loc.cardId);
  if (!card) return;
  card.classList.add('map-hover-preview');
}

function hideCard(loc) {
  const card = document.getElementById(loc.cardId);
  if (!card) return;
  card.classList.remove('map-hover-preview');
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
