// ============================================
// Field Sites — satellite sandbox
// ============================================
//
// Real imagery, free pan and zoom, and a guided pan between the places the
// rest of this site talks about. Leaflet is vendored in /vendor rather than
// pulled from a CDN so the page has no third-party runtime dependency; the
// tiles themselves are Esri's and are the only external request made.

import { SITES, GROUPS, HOME_VIEW, siteById } from './sites.js';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_CREDIT =
  'Imagery &copy; <a href="https://www.esri.com/" rel="noopener">Esri</a>, Maxar, Earthstar Geographics';

const BASEMAPS = {
  satellite: {
    label: 'Satellite',
    url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    maxNativeZoom: 19,
    attribution: `${ESRI_CREDIT}, and the GIS User Community`,
  },
  ocean: {
    label: 'Sea floor',
    url: `${ESRI}/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}`,
    maxNativeZoom: 13,
    attribution: 'Bathymetry &copy; Esri, GEBCO, NOAA, and other contributors',
  },
};

const LABELS = {
  satellite: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
  ocean: `${ESRI}/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}`,
};

// Dwell at each stop on the guided pan. Long enough to read the card.
const TOUR_DWELL_MS = 3400;

let map = null;
let baseLayer = null;
let labelLayer = null;
let currentBase = 'satellite';
let labelsOn = true;

const markers = new Map(); // id -> { marker, extent }
let activeId = null;

let tourToken = 0;
let touring = false;

// ---------------------------------------------------------------- helpers ---

const el = (id) => document.getElementById(id);

function fmtLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

// The "area"/"region" circles carry the honesty of the entry, so they need to
// read as an extent rather than as decoration around a precise point.
function extentStyle(color) {
  return {
    color,
    weight: 1.5,
    opacity: 0.55,
    fillColor: color,
    fillOpacity: 0.08,
    dashArray: '4 6',
    interactive: false,
  };
}

function pinIcon(site, active) {
  const color = GROUPS[site.group].color;
  return L.divIcon({
    className: `site-pin${active ? ' is-active' : ''}`,
    html:
      `<span class="site-pin-pulse" style="--pin:${color}"></span>` +
      `<span class="site-pin-dot" style="--pin:${color}"></span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// ------------------------------------------------------------- basemaps -----

function applyBasemap(key) {
  currentBase = key;
  const spec = BASEMAPS[key];

  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(spec.url, {
    maxNativeZoom: spec.maxNativeZoom,
    maxZoom: 20,
    attribution: spec.attribution,
  }).addTo(map);
  baseLayer.bringToBack();

  applyLabels();

  document.querySelectorAll('[data-basemap]').forEach((btn) => {
    const on = btn.dataset.basemap === key;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

function applyLabels() {
  if (labelLayer) {
    map.removeLayer(labelLayer);
    labelLayer = null;
  }
  if (!labelsOn) return;
  labelLayer = L.tileLayer(LABELS[currentBase], {
    maxNativeZoom: currentBase === 'ocean' ? 13 : 19,
    maxZoom: 20,
    opacity: 0.9,
  }).addTo(map);
}

// --------------------------------------------------------------- markers ----

function buildMarkers() {
  SITES.forEach((site) => {
    const color = GROUPS[site.group].color;
    const latlng = [site.lat, site.lon];

    let extent = null;
    if (site.precision !== 'exact' && site.radius) {
      extent = L.circle(latlng, { radius: site.radius, ...extentStyle(color) }).addTo(map);
    }

    const marker = L.marker(latlng, {
      icon: pinIcon(site, false),
      keyboard: true,
      title: `${site.name} — ${site.place}`,
      alt: `${site.name}, ${site.place}`,
    }).addTo(map);

    marker.on('click', () => selectSite(site.id, { source: 'map' }));
    marker.on('keypress', (e) => {
      if (e.originalEvent.key === 'Enter') selectSite(site.id, { source: 'map' });
    });

    markers.set(site.id, { marker, extent, site });
  });
}

function paintActive(id) {
  markers.forEach(({ marker, extent, site }, key) => {
    const on = key === id;
    marker.setIcon(pinIcon(site, on));
    if (extent) {
      extent.setStyle({
        opacity: on ? 0.95 : 0.55,
        fillOpacity: on ? 0.16 : 0.08,
        weight: on ? 2.5 : 1.5,
      });
    }
  });

  document.querySelectorAll('.site-item').forEach((btn) => {
    const on = btn.dataset.site === id;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-current', on ? 'true' : 'false');
  });
}

// ------------------------------------------------------------- site card ----

function renderCard(site) {
  const card = el('site-card');
  if (!site) {
    card.hidden = true;
    card.innerHTML = '';
    return;
  }

  const group = GROUPS[site.group];
  const precisionNote = {
    exact: 'Exact location',
    area: 'Approximate extent — the circle, not the pin, is the claim',
    region: 'Regional view — specific sites are not published here',
  }[site.precision];

  const panelLink = site.panel
    ? `<a class="site-card-link" href="index.html#ocean">Open the research panel &rarr;</a>`
    : '';

  card.innerHTML = `
    <p class="site-card-kicker" style="--pin:${group.color}">${group.name}</p>
    <h2 class="site-card-title">${site.name}</h2>
    <p class="site-card-place">${site.place}</p>
    <p class="site-card-blurb">${site.blurb}</p>
    <p class="site-card-meta">
      <span class="site-card-coords">${fmtLatLon(site.lat, site.lon)}</span>
      <span class="site-card-precision" data-precision="${site.precision}">${precisionNote}</span>
    </p>
    ${panelLink}
  `;
  card.hidden = false;
}

// ---------------------------------------------------------------- select ----

function flyToSite(site) {
  const target = [site.lat, site.lon];
  if (REDUCED) {
    map.setView(target, site.zoom, { animate: false });
  } else {
    map.flyTo(target, site.zoom, { duration: 1.8, easeLinearity: 0.25 });
  }
}

function selectSite(id, { source = 'rail', updateHash = true } = {}) {
  const site = siteById(id);
  if (!site) return;

  activeId = id;
  paintActive(id);
  renderCard(site);
  flyToSite(site);

  if (updateHash) {
    const next = `#${id}`;
    if (window.location.hash !== next) history.replaceState(null, '', next);
  }

  // Keep the rail entry in view when something other than the list drove the change
  if (source !== 'rail') {
    document.querySelector(`.site-item[data-site="${id}"]`)?.scrollIntoView({
      behavior: REDUCED ? 'auto' : 'smooth',
      block: 'nearest',
    });
  }
}

function goHome() {
  stopTour();
  activeId = null;
  paintActive(null);
  renderCard(null);
  if (REDUCED) map.setView([HOME_VIEW.lat, HOME_VIEW.lon], HOME_VIEW.zoom, { animate: false });
  else map.flyTo([HOME_VIEW.lat, HOME_VIEW.lon], HOME_VIEW.zoom, { duration: 1.4 });
  history.replaceState(null, '', window.location.pathname);
}

// ------------------------------------------------------------------ tour ----

// Resolves true only if this tour is still the current one. A cancelled tour
// resolves false on the next tick rather than being aborted mid-flight, which
// keeps the loop in one place.
const wait = (ms, token) =>
  new Promise((resolve) => setTimeout(() => resolve(token === tourToken), ms));

function setTourUI(on) {
  touring = on;
  const btn = el('tour-btn');
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('.tour-label').textContent = on ? 'Stop tour' : 'Guided tour';
  document.body.classList.toggle('is-touring', on);
}

function stopTour() {
  if (!touring) return;
  tourToken += 1;
  setTourUI(false);
}

async function runTour() {
  tourToken += 1;
  const token = tourToken;
  setTourUI(true);

  for (const site of SITES) {
    if (token !== tourToken) return;
    selectSite(site.id, { source: 'tour' });
    const alive = await wait(TOUR_DWELL_MS, token);
    if (!alive) return;
  }

  if (token === tourToken) {
    setTourUI(false);
    goHome();
  }
}

// ------------------------------------------------------------------ rail ----

function buildRail() {
  const rail = el('site-rail');
  const byGroup = new Map();
  SITES.forEach((s) => {
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
  });

  const frag = document.createDocumentFragment();

  byGroup.forEach((sites, key) => {
    const group = GROUPS[key];
    const section = document.createElement('section');
    section.className = 'site-group';

    const head = document.createElement('h2');
    head.className = 'site-group-name';
    head.style.setProperty('--pin', group.color);
    head.textContent = group.name;
    section.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'site-list';

    sites.forEach((site) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'site-item';
      btn.dataset.site = site.id;
      btn.style.setProperty('--pin', group.color);
      btn.setAttribute('aria-current', 'false');
      btn.innerHTML =
        `<span class="site-item-name">${site.name}</span>` +
        `<span class="site-item-place">${site.place}</span>`;
      btn.addEventListener('click', () => {
        stopTour();
        selectSite(site.id);
      });
      li.appendChild(btn);
      list.appendChild(li);
    });

    section.appendChild(list);
    frag.appendChild(section);
  });

  rail.appendChild(frag);
}

// -------------------------------------------------------------- readout -----

function updateReadout() {
  const c = map.getCenter();
  el('readout-center').textContent = fmtLatLon(c.lat, c.lng);
  el('readout-zoom').textContent = `z${map.getZoom().toFixed(1).replace(/\.0$/, '')}`;
}

// ------------------------------------------------------------------ hash ----

function applyHash() {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return false;

  // #@lat,lon,zoom — shareable arbitrary view
  if (raw.startsWith('@')) {
    const [lat, lon, z] = raw.slice(1).split(',').map(Number);
    if ([lat, lon, z].every(Number.isFinite)) {
      map.setView([lat, lon], z, { animate: false });
      return true;
    }
    return false;
  }

  if (siteById(raw)) {
    selectSite(raw, { updateHash: false });
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ init ----

function init() {
  map = L.map('map', {
    center: [HOME_VIEW.lat, HOME_VIEW.lon],
    zoom: HOME_VIEW.zoom,
    minZoom: 2,
    maxZoom: 20,
    zoomControl: false,
    worldCopyJump: true,
    // Leaflet's own fade looks wrong over imagery that is already loading in
    fadeAnimation: !REDUCED,
    zoomAnimation: !REDUCED,
  });

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: true, metric: true }).addTo(map);

  applyBasemap('satellite');
  buildMarkers();
  buildRail();

  // Any manual interaction cancels the guided pan, otherwise the map fights you.
  // These have to be DOM events on the container, not Leaflet's own movestart /
  // zoomstart: flyTo fires those itself, so the tour would cancel its own first hop.
  const container = map.getContainer();
  ['pointerdown', 'wheel', 'keydown'].forEach((evt) =>
    container.addEventListener(evt, () => {
      if (touring) stopTour();
    }, { passive: true })
  );

  map.on('move zoom', updateReadout);
  updateReadout();

  document.querySelectorAll('[data-basemap]').forEach((btn) =>
    btn.addEventListener('click', () => applyBasemap(btn.dataset.basemap))
  );

  const labelBtn = el('labels-btn');
  labelBtn.addEventListener('click', () => {
    labelsOn = !labelsOn;
    labelBtn.classList.toggle('is-on', labelsOn);
    labelBtn.setAttribute('aria-pressed', String(labelsOn));
    applyLabels();
  });

  el('tour-btn').addEventListener('click', () => (touring ? stopTour() : runTour()));
  el('home-btn').addEventListener('click', goHome);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (touring) {
        stopTour();
      } else if (activeId) {
        goHome();
      }
    }
  });

  window.addEventListener('hashchange', () => applyHash());

  if (!applyHash()) renderCard(null);

  // The rail is a scroll region on desktop; make sure the map claims the space
  window.addEventListener('resize', () => map.invalidateSize());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
