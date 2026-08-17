/* ============================================
   Conservation map — real imagery over real terrain
   ============================================

   The sticky panel in the Conservation path used to hold a hand-traced SVG of
   the California coast. It now holds actual satellite imagery draped over
   actual elevation data, with a camera that can tilt and orbit.

   Three things have to be true at once:

     - scrolling the cards moves the camera between preserves,
     - the reader can grab the map and go wherever they like, and
     - nothing on screen is invented.

   The first two fight each other, so there is an explicit mode: touch the map
   and it stops following the scroll until you hand it back (see TAKEOVER).

   The third is why this is MapLibre over a real DEM rather than a generated
   flyover. A video model can fake a convincing drone orbit from one still,
   but it hallucinates the ridgelines — and this section is called Ground
   Truth. Every hill here is where the elevation data says it is.

   MapLibre is vendored (no CDN) and loaded on demand: Conservation is the
   only path that needs it and it is not small, so the other three don't pay. */

const MAPLIBRE_JS = 'vendor/maplibre/maplibre-gl.js';
const MAPLIBRE_CSS = 'vendor/maplibre/maplibre-gl.css';

// Esri's own service metadata is the authority on this string; it is checked
// against the live service rather than guessed. Maxar became Vantor.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const IMAGERY_CREDIT =
  'Powered by <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> | ' +
  'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
const OSM_CREDIT =
  'Boundaries &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const DEM_CREDIT =
  'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles</a> on AWS';

/* Probed against the live services, not assumed: Esri World Imagery serves
   real tiles through z20 here and returns a 2.5 KB "no data" placeholder at
   z21; the terrarium DEM serves through z15 and 404s at z16. Asking either
   for more than exists just renders grey.

   There used to be a USGS topo alternative behind a corner button. It is gone:
   the section is called Ground Truth and makes its case with photography, so a
   second basemap was a control to press rather than something to see. */
const BASE = {
  tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
  maxzoom: 20,
  attribution: IMAGERY_CREDIT,
};

/* Esri publishes a second, higher-resolution imagery service ("Clarity").
   Compared tile-for-tile against the standard service over Nisene: at z15 the
   standard tile is the better picture — brighter, more contrast between
   canopy and clearing — while Clarity is flat and dark. From about z17 that
   reverses completely, and Clarity resolves individual redwood crowns with
   real separation and shadow where the standard tile is a hazy green mat.

   So neither one wins outright and swapping would be a downgrade at the
   resting shots. Both are loaded instead, with Clarity layered on top from
   z16 up: the composed stops keep the picture that suits them, and zooming
   in — which is the whole point of a map you can grab — is rewarded with
   sharper trees. Clarity 301s at z20, hence the cap. */
const CLARITY_TILES = [
  'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
];
const CLARITY_MINZOOM = 16;
const CLARITY_MAXZOOM = 19;

const DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
/* MapLibre raises its terrain mesh by this factor. The relief here is real
   but gentle enough that a true-to-life profile reads as a smudge at a 20 km
   frame; 1.5 is the smallest exaggeration that makes the Aptos Creek canyon
   look like a canyon, and it is applied to the whole mesh so no feature is
   moved relative to another. */
const TERRAIN_EXAGGERATION = 1.5;
const DEM_MAXZOOM = 15;
const BOUNDARIES_URL = 'assets/park-boundaries.geojson';
/* The same boundaries again, simplified, to be extruded into a curtain.
   A line layer is draped flat on the terrain, so under a 60 degree camera you
   see it edge-on and it thins to nothing exactly when the view gets dramatic.
   A standing wall reads from any angle and at any zoom. Symbol, not structure
   — hence translucent, and deliberately generalised: see tools/build_walls.py
   for why the curtain does not trace the survey line and the flat one does. */
const WALL_LINES_URL = 'assets/park-wall-lines.geojson';
// Half-thickness of the curtain, metres. Thin enough to read as a plane rather
// than a slab, thick enough not to z-fight itself when seen edge-on.
const WALL_HALF_WIDTH_M = 7;

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE = window.matchMedia('(hover: none), (pointer: coarse)').matches;

// ---------------------------------------------------------------- state ----

let map = null;
let libPromise = null;

let host = null;
let ui = null;
let ro = null;
let stepObserver = null;
let sectionObserver = null;

let activeStep = 'overview';
let exploring = false; // TAKEOVER: reader owns the camera
let suppressFocusEnter = false;
let generation = 0; // bumped by destroy() so late async work from a dead init exits
let hintTimer = 0;
let tileErrors = 0;
let styleReady = false;

let orbiting = false;
let orbitRaf = 0;

const prefetched = new Set();
let prefetchBudget = 0;
let idleHandle = 0;

const teardown = [];

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  teardown.push(() => target.removeEventListener(type, fn, opts));
}

// ---------------------------------------------------------------- loader ---

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (libPromise) return libPromise;

  libPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-maplibre]')) {
      const link = el('link');
      link.rel = 'stylesheet';
      link.href = MAPLIBRE_CSS;
      link.dataset.maplibre = '';
      /* prepend, NOT appendChild. Injected at the end of <head> this sheet
         lands after every page stylesheet and wins each equal-specificity
         tie — which is not hypothetical: the vendor sheet sets the canvas
         container background and the attribution pill's white background,
         both of which the page deliberately overrides. Loading it first
         makes the page's own rules win by source order. */
      document.head.prepend(link);
    }
    // Re-entering the path after a failed load must not stack up script tags
    document.querySelector('script[data-maplibre]')?.remove();
    const s = el('script');
    s.src = MAPLIBRE_JS;
    s.async = true;
    s.dataset.maplibre = '';
    s.onload = () =>
      window.maplibregl ? resolve(window.maplibregl) : reject(new Error('maplibregl undefined'));
    s.onerror = () => reject(new Error('MapLibre failed to load'));
    document.head.appendChild(s);
  });

  libPromise.catch(() => {
    libPromise = null; // a failed load must not be cached as permanently failed
  });
  return libPromise;
}

// ----------------------------------------------------------------- sites ---

/* One entry per scroll step in index.html (.forest-step[data-step]).

   `bearing` and `pitch` are composed by hand: every stop rests on an oblique
   shot rather than a plan view, and each looks a different way so the sequence
   never repeats an angle.

   WHERE and HOW CLOSE are not composed by hand any more. They come from
   _frames in park-boundaries.geojson — the centre and radius of each park's
   own boundary — because the camera orbits, and orbiting about a hand-picked
   trailhead meant the park being described sat off to one side and swung in
   and out of frame. Rotating about the boundary's own centre puts the park on
   the axis, so a full turn keeps it there.

   `lon`/`lat`/`zoom` below are the fallback for the window between first
   paint and the boundaries arriving, and for the case where that fetch fails
   entirely. They are the old hand-picked stops and still frame the sites
   sensibly, just not concentrically.

   PITCH IS CAPPED AT 56, and that is a measurement rather than a taste.
   With 3D terrain on, MapLibre picks each tile's zoom by its distance from
   the camera, so a frame holds several resolutions at once and the bands
   sweep across the imagery as the orbit turns — the thing that reads as the
   map "constantly changing resolution". Counting distinct raster zoom levels
   in frame at one stop: 3 at pitch 64, 3 at 60, and 2 from 56 down. Two is
   the floor while terrain is enabled, so 56 buys the whole available
   improvement and nothing below it helps. These were 64 at Nisene and 62 at
   Big Sur, which did make those canyons read more dramatically; that is what
   the steadier picture cost. */
const SITES = [
  {
    step: 'scmts',
    name: 'Santa Cruz Mountains',
    note: 'Wilder Ranch and Henry Cowell',
    // A corridor, not a point: the two parks are 9 km apart. Looking
    // north-east up the grain of the range, so the coastal terrace, the city
    // and the canopy stack into depth instead of sitting side by side.
    lon: -122.07396,
    lat: 37.00103,
    zoom: 11.8,
    bearing: 35,
    pitch: 52,
  },
  {
    step: 'nisene',
    name: 'The Forest of Nisene Marks',
    note: "George's Picnic Area, on the Aptos Creek fire road",
    // The hardest cut in the sequence. Looking south down the Aptos Creek
    // drainage with the bay beyond, which is the view that makes the canyon
    // read as a canyon rather than as dark green texture.
    lon: -121.90569,
    lat: 37.00101,
    zoom: 13.3,
    bearing: 200,
    pitch: 56,
  },
  {
    step: 'elkhorn',
    name: 'Elkhorn Slough',
    note: 'The tidal channel inland from Moss Landing',
    // Low and flat on purpose — the one stop with almost no relief. Looking
    // east from the harbour mouth so the channel snakes away from the camera.
    lon: -121.7893,
    lat: 36.8033,
    zoom: 11.9,
    bearing: 75,
    pitch: 56,
  },
  {
    step: 'bigsur',
    name: 'Big Sur Land Trust',
    note: 'Palo Corona Regional Park, Carmel',
    // Looking south down the coast, ocean on the right, the protected ridge
    // climbing away — the edge between wild and developed is the story.
    lon: -121.9000,
    lat: 36.5386,
    zoom: 11.2,
    bearing: 158,
    pitch: 56,
  },
  {
    step: 'santalucia',
    name: 'Santa Lucia Conservancy',
    note: 'The Santa Lucia Preserve, Carmel Valley',
    // Inland and dry. Looking west over the oak savanna toward the coast
    // ridge, the only gold frame in a set that is otherwise green and blue.
    lon: -121.8200,
    lat: 36.4750,
    zoom: 12.0,
    bearing: 292,
    pitch: 56,
  },
];

// Every pin in one frame — the only stop that shows the whole working area.
const OVERVIEW = { lon: -121.93, lat: 36.75, zoom: 7.8, bearing: 0, pitch: 34 };

const byStep = (step) => SITES.find((s) => s.step === step) || null;

/* step -> { lon, lat, radiusM }, filled in when the boundaries land. The
   radius is to the FURTHEST boundary vertex from that centre, so it describes
   a circle rather than a box — a box fitted at one bearing stops fitting the
   moment the orbit turns away from it. */
let frames = {};

/* How much of the panel's shorter axis the park should span. Not 1.0: the
   boundary is the subject, not the whole picture, and a park pressed to the
   glass loses the ridge line and coast that put it somewhere. */
const FRAME_FILL = 0.74;

/* A pitched camera sees less ground in the near half of the frame than a plan
   view does at the same zoom, so a circle fitted flat overflows the bottom
   edge once tilted. Backing off by this many zoom levels per degree of pitch
   restores it — 0.006 is ~0.36 levels at the 52-64 degree pitches used here,
   measured against the projected boundary rather than derived, because the
   exact relationship also depends on the field of view. */
const PITCH_ZOOM_ALLOWANCE = 0.006;

function zoomForFrame(frame, pitch) {
  const container = map?.getContainer();
  const w = container?.clientWidth || 0;
  const h = container?.clientHeight || 0;
  if (!w || !h) return null;

  const span = Math.min(w, h) * FRAME_FILL;
  const metresPerPixel = (2 * frame.radiusM) / span;
  const groundResolution = 156543.03392 * Math.cos((frame.lat * Math.PI) / 180);
  const zoom = Math.log2(groundResolution / metresPerPixel) - PITCH_ZOOM_ALLOWANCE * pitch;

  // A park smaller than the panel must not push the camera past the imagery
  // (z20) or out past the DEM into a flat blue marble.
  return Math.min(Math.max(zoom, 8), 16);
}

// ----------------------------------------------------------------- style ---

function buildStyle() {
  return {
    version: 8,
    // No glyphs/sprite: every label on this map is a DOM marker, so the style
    // never needs a font or icon server and stays entirely self-hosted.
    sources: {
      base: {
        type: 'raster',
        tiles: BASE.tiles,
        tileSize: 256,
        maxzoom: BASE.maxzoom,
        attribution: `${BASE.attribution} | ${DEM_CREDIT}`,
      },
      clarity: {
        type: 'raster',
        tiles: CLARITY_TILES,
        tileSize: 256,
        minzoom: CLARITY_MINZOOM,
        maxzoom: CLARITY_MAXZOOM,
      },
      dem: {
        type: 'raster-dem',
        tiles: DEM_TILES,
        tileSize: 256,
        maxzoom: DEM_MAXZOOM,
        encoding: 'terrarium',
      },
    },
    /* No 'raster-fade-duration' on either raster layer, deliberately. The
       raster painter passes map.terrain into its fade function and returns
       {opacity: 1} unconditionally when terrain is on, so the property is
       inert here — it was set to 200 for a long time and never once did
       anything. Setting it back only looks like a decision.

       There is no hillshade layer either, and that is the same DEM source the
       terrain mesh uses. Sharing it is worse than redundant: MapLibre's
       TerrainSourceCache MUTATES the shared cache's tileSize to 1024 and
       turns roundZoom off, so the hillshade was drawing two zoom levels
       coarser than it asked for — which is what the "same source for a
       hillshade layer and for 3D terrain" warning in the console was about.
       The fix could have been a second DEM source, but the honest read is
       that this layer was never earning its cost: the note it used to carry
       said the imagery already supplies the shading and doubling it up
       smears every north slope. Dropping it also takes one full draped layer
       out of every terrain tile's render-to-texture pass, which is the
       workload that gets WebGL contexts killed (see the context-loss
       handling in wireInteraction). */
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0f2a1e' } },
      { id: 'base', type: 'raster', source: 'base' },
      /* Sharper canopy, but only once the reader has zoomed past the composed
         shots — below z16 this source is the worse picture, so it stays off. */
      { id: 'base-hi', type: 'raster', source: 'clarity', minzoom: CLARITY_MINZOOM },
    ],
    terrain: { source: 'dem', exaggeration: TERRAIN_EXAGGERATION },
  };
}

// ------------------------------------------------------------ boundaries ---


// Paint expressions keyed off the active step, so switching stops is one
// setPaintProperty per property rather than a rebuild of the source.
const activeCase = (activeVal, idleVal) => [
  'case',
  ['==', ['get', 'step'], ['literal', activeStep]],
  activeVal,
  idleVal,
];

/* Water is not a park and must not be painted like one. Elkhorn Slough is
   drawn from the same source as the boundaries beside it, and while it wore
   the same green outline it read as one more parcel of land rather than as
   the estuary the card is about. Blue, and filled harder than any park is —
   a channel 80 to 230 m wide is three pixels at these stops, so the outline
   alone is a thread and the fill is what actually says "water". */
const kindCase = (water, land) => ['case', ['==', ['get', 'kind'], 'water'], water, land];

/* The curtain's height is a SYMBOL SIZE, not a measurement, and it is set in
   metres because that is the only unit fill-extrusion speaks.

   It was a flat 110 m and effectively invisible, which is arithmetic rather
   than opinion: at Big Sur's z11.2 the ground is 53 m per pixel, so 110 m is
   two pixels tall. Four of the five stops sit between z11.2 and z12, where
   anything under about 400 m simply is not there.

   So it scales with the view, exactly as the line widths above do — the park
   got smaller on screen, so the symbol has to get relatively bigger. These
   stops hold it near 15 px of apparent height across the whole range. Past
   z16 it stops growing and settles around canopy height, because by then you
   are among the trees and a plausible height reads better than a constant
   one. Yes, that means a kilometre-tall wall in a 37 km frame; it is drawn at
   0.3 opacity precisely so it never reads as a thing that is there. */
const wallHeight = () => [
  'interpolate',
  ['linear'],
  ['zoom'],
  10, activeCase(1100, 0),
  12, activeCase(420, 0),
  14, activeCase(150, 0),
  16, activeCase(45, 0),
  18, activeCase(35, 0),
];

function addBoundaries(geo) {
  if (!map || map.getSource('bounds')) return;
  /* The credit rides on the source. MapLibre merges every source's
     attribution into the control automatically, which is the only way this
     stays correct — the boundaries are ODbL and the credit is a licence
     condition, so it must appear whenever the data does and disappear if the
     fetch fails. */
  map.addSource('bounds', { type: 'geojson', data: geo, attribution: OSM_CREDIT });

  map.addLayer({
    id: 'bound-fill',
    type: 'fill',
    source: 'bounds',
    paint: {
      'fill-color': kindCase('#57c8f5', '#7bc96f'),
      'fill-opacity': kindCase(activeCase(0.5, 0.22), activeCase(0.13, 0.04)),
      'fill-opacity-transition': { duration: 450 },
      'fill-color-transition': { duration: 450 },
    },
  });

  /* A dark casing under the bright line. Oldest trick in cartography and the
     only thing that keeps a thin coloured outline legible over imagery that
     is bare sand in one frame and near-black canopy in the next. */
  map.addLayer({
    id: 'bound-casing',
    type: 'line',
    source: 'bounds',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#04140c',
      /* Zoom-interpolated, not fixed. A 2.6 px line reads fine hovering over
         one canyon and vanishes when the same park is a thumbnail in a 37 km
         frame — the park got smaller on screen, so the symbol has to get
         relatively bigger. Widths are symbols, not measurements. */
      'line-width': ['interpolate', ['linear'], ['zoom'],
        10, activeCase(8, 4.5),
        13, activeCase(6.5, 3.5),
        16, activeCase(5.5, 3)],
      'line-opacity': 0.6,
      'line-width-transition': { duration: 450 },
    },
  });

  map.addLayer({
    id: 'bound-line',
    type: 'line',
    source: 'bounds',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': kindCase(activeCase('#bfeeff', '#79c9ea'), activeCase('#c8ffb4', '#8fe07f')),
      'line-width': ['interpolate', ['linear'], ['zoom'],
        10, activeCase(4.2, 2.2),
        13, activeCase(3.2, 1.8),
        16, activeCase(2.6, 1.4)],
      'line-opacity': activeCase(1, 0.8),
      'line-blur': activeCase(0.8, 0),
      'line-width-transition': { duration: 450 },
      'line-opacity-transition': { duration: 450 },
    },
  });

}

function repaintBoundaries() {
  if (!map || !map.getLayer('bound-line')) return;
  map.setPaintProperty(
    'bound-fill', 'fill-opacity',
    kindCase(activeCase(0.5, 0.22), activeCase(0.13, 0.04))
  );
  map.setPaintProperty('bound-casing', 'line-width', ['interpolate', ['linear'], ['zoom'],
    10, activeCase(8, 4.5), 13, activeCase(6.5, 3.5), 16, activeCase(5.5, 3)]);
  map.setPaintProperty(
    'bound-line', 'line-color',
    kindCase(activeCase('#bfeeff', '#79c9ea'), activeCase('#c8ffb4', '#8fe07f'))
  );
  map.setPaintProperty('bound-line', 'line-width', ['interpolate', ['linear'], ['zoom'],
    10, activeCase(4.2, 2.2), 13, activeCase(3.2, 1.8), 16, activeCase(2.6, 1.4)]);
  map.setPaintProperty('bound-line', 'line-opacity', activeCase(1, 0.8));
  map.setPaintProperty('bound-line', 'line-blur', activeCase(0.8, 0));

  if (map.getLayer('bound-wall')) {
    map.setPaintProperty('bound-wall', 'fill-extrusion-color', activeCase('#a8f08c', '#5f9c62'));
    map.setPaintProperty('bound-wall', 'fill-extrusion-height', wallHeight());
  }
}

/* Turn each simplified ring into one thin quad per segment.

   Done here rather than in the build script purely for weight: neighbouring
   quads share two corners each, so writing polygons to disk ships every
   position four times over — 96 KB gzipped against 23 KB for the same
   4,000 segments as lines. Rebuilding them costs well under a millisecond.

   Each quad is pushed half a width past both ends so it tucks under its
   neighbour. Without that overlap every convex corner leaves a wedge of
   daylight, which at a distance is exactly what makes a curtain look torn. */
function wallsFromLines(geo) {
  const features = [];
  const W = WALL_HALF_WIDTH_M;

  geo.features.forEach((f) => {
    const pts = f.geometry?.coordinates;
    if (!pts || pts.length < 3) return;
    const step = f.properties.step;

    // One planar frame per ring. Over a few km of park this is exact enough
    // that the error is far below the 5-decimal-place coordinates themselves.
    const mLat = 111320;
    const mLon = 111320 * Math.cos((pts[0][1] * Math.PI) / 180);

    const P = pts.map((p) => [p[0] * mLon, p[1] * mLat]);
    const closed =
      Math.abs(P[0][0] - P[P.length - 1][0]) < 1e-6 &&
      Math.abs(P[0][1] - P[P.length - 1][1]) < 1e-6;

    // Unit direction and length of every segment, computed once — each is
    // needed by its own quad and by both neighbours' joints.
    const n = P.length - 1;
    const dir = [];
    const len = [];
    for (let i = 0; i < n; i += 1) {
      const dx = P[i + 1][0] - P[i][0];
      const dy = P[i + 1][1] - P[i][1];
      const L = Math.hypot(dx, dy);
      len.push(L);
      dir.push(L > 1e-9 ? [dx / L, dy / L] : [1, 0]);
    }

    /* How far to slide a corner along its own segment so it meets its
       neighbour's corner exactly.

       For a stroke of half-width W turning through `turn` radians, that
       distance is W * tan(turn / 2) — outward on the outside of the bend,
       inward on the inside. The old code used a flat W at both corners of
       both ends, which is the right answer at exactly one angle: a 90 degree
       turn, where tan(45) = 1. Everywhere else it was wrong in a way you
       could see. At a shallow 10 degree bend the outer corners needed 0.6 m
       and got 7, poking a tab through the neighbour; at a 170 degree hairpin
       they needed 80 m and still got 7, leaving the corner torn open. And
       because the inner corners were pushed outward too instead of pulled
       back, every joint double-painted its own inside — which at 0.3 opacity
       is a bright seam at every vertex, 436 of them under 90 degrees. */
    const mitre = (into, outOf) => {
      const u = dir[into];
      const v = dir[outOf];
      const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]));
      const turn = Math.acos(dot);
      return {
        // Capped at two wall widths. Uncapped, a hairpin asks for hundreds of
        // metres of spike; the standard mitre limit is the standard fix.
        c: Math.min(W * Math.tan(turn / 2), 2 * W),
        // Sign of the cross product says which way the path bends, and so
        // which side of the stroke is on the outside of the corner.
        leftIsOuter: u[0] * v[1] - u[1] * v[0] < 0,
      };
    };

    for (let i = 0; i < n; i += 1) {
      if (len[i] < 1) continue;

      const prev = closed ? (i - 1 + n) % n : i - 1;
      const next = closed ? (i + 1) % n : i + 1;

      const a = prev >= 0 ? mitre(prev, i) : { c: 0, leftIsOuter: true };
      const b = next < n ? mitre(i, next) : { c: 0, leftIsOuter: true };

      /* A quad may not eat itself. Two sharp bends close together can ask for
         more cutback than the segment is long, which folds it inside out into
         a bowtie — 55 segments in the shipped data do exactly that, one of
         them a 61 m segment asking for a 489 m cutback. Scale both ends down
         together so the shape stays a quad. */
      let ca = a.c;
      let cb = b.c;
      const room = 0.9 * len[i];
      if (ca + cb > room) {
        const k = room / (ca + cb);
        ca *= k;
        cb *= k;
      }

      const [ux, uy] = dir[i];
      const nx = -uy * W; // across the segment
      const ny = ux * W;

      // On the outside of a bend the corner slides away from the vertex; on
      // the inside it slides toward it. Start and end pull opposite ways.
      const sL = a.leftIsOuter ? -ca : ca;
      const sR = a.leftIsOuter ? ca : -ca;
      const eL = b.leftIsOuter ? cb : -cb;
      const eR = b.leftIsOuter ? -cb : cb;

      const ax = P[i][0];
      const ay = P[i][1];
      const bx = P[i + 1][0];
      const by = P[i + 1][1];

      const ring = [
        [(ax + nx + ux * sL) / mLon, (ay + ny + uy * sL) / mLat],
        [(bx + nx + ux * eL) / mLon, (by + ny + uy * eL) / mLat],
        [(bx - nx + ux * eR) / mLon, (by - ny + uy * eR) / mLat],
        [(ax - nx + ux * sR) / mLon, (ay - ny + uy * sR) / mLat],
      ];
      ring.push(ring[0]);

      features.push({
        type: 'Feature',
        properties: { step },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
  });

  return { type: 'FeatureCollection', features };
}

function addWalls(geo) {
  if (!map || map.getSource('walls')) return;
  map.addSource('walls', { type: 'geojson', data: wallsFromLines(geo) });
  map.addLayer({
    id: 'bound-wall',
    type: 'fill-extrusion',
    source: 'walls',
    paint: {
      'fill-extrusion-color': activeCase('#a8f08c', '#5f9c62'),
      // Only the active park's wall stands up; the rest lie flat so the
      // section never looks like a fenced compound.
      'fill-extrusion-height': wallHeight(),
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.3,
      'fill-extrusion-height-transition': { duration: 700 },
    },
  });
}

function loadBoundaries(gen) {
  /* Fetched rather than bundled, and after the map is already usable: the
     outlines are an enhancement, so nothing here may delay or break first
     paint. A failure is silent by design. */
  fetch(BOUNDARIES_URL)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((geo) => {
      if (gen !== generation || !map || !styleReady) return;
      addBoundaries(geo);
      repaintBoundaries();

      /* The camera targets arrive with the geometry they are derived from, so
         re-fly the stop the reader is actually on — otherwise the first site
         they see keeps the fallback framing until they scroll past it and
         back. Not while exploring: the reader owns the camera then, and
         yanking it away because a fetch landed is the one thing TAKEOVER
         exists to prevent. */
      if (geo._frames) {
        frames = geo._frames;
        if (!exploring) flyToStep(activeStep);
      }

      fetch(WALL_LINES_URL)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((walls) => {
          if (gen !== generation || !map || !styleReady) return;
          addWalls(walls);
          repaintBoundaries();
        })
        .catch(() => {
          /* flat outline only; still a boundary */
        });
      map._boundaryCredit = true;
    })
    .catch(() => {
      /* no outlines, still a working map */
    });
}

// --------------------------------------------------------------- chrome ----

function buildChrome() {
  const panel = host.closest('.forest-map-sticky') || host;
  panel.dataset.camera = 'following';

  const layer = el('div', 'fmap-ui');

  const hint = el('button', 'fmap-hint', COARSE ? 'Tap to explore' : '<b>Click the map</b> to explore');
  hint.type = 'button';

  const resume = el('button', 'fmap-resume', COARSE ? 'Done' : 'Resume tour');
  resume.type = 'button';
  resume.hidden = true;

  const readout = el('p', 'fmap-readout');
  readout.setAttribute('aria-hidden', 'true');

  const status = el('p', 'fmap-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const fail = el(
    'div',
    'fmap-fail',
    '<p>The map could not load.</p><p class="fmap-fail-sub">The imagery and elevation data need a live connection.</p>'
  );
  fail.hidden = true;

  // fail first so the controls paint above it — an overlay that buries the
  // only recovery controls is worse than the failure it reports.
  layer.append(fail, hint, resume, readout, status);
  panel.appendChild(layer);

  ui = { panel, layer, hint, resume, readout, status, fail };

  on(hint, 'click', () => setExploring(true));
  on(resume, 'click', () => {
    setExploring(false);
    flyToStep(activeStep);
  });
}

function announce(text) {
  if (ui) ui.status.textContent = text;
}

// ------------------------------------------------------------- takeover ----

/* The camera yields. Scroll owns it until the reader touches the map; the
   reader owns it until they hand it back. No timeout — someone who has spent
   a minute inside the Nisene canopy is the reader this exists for, and
   yanking the camera away would punish exactly that. */
function setExploring(next) {
  if (!map || exploring === next) return;
  exploring = next;

  const losingFocus =
    document.activeElement === ui.hint || (document.activeElement === ui.resume && !next);

  ui.panel.dataset.camera = next ? 'exploring' : 'following';
  ui.hint.hidden = true;
  ui.resume.hidden = !next;

  if (next) {
    // The single point where the orbit yields. Every gesture that can move
    // this camera is gated behind this branch, so nothing else has to watch
    // for input — see the note in wireInteraction().
    stopDrift();
    map.scrollZoom.enable();
    if (COARSE) {
      map.dragPan.enable();
      map.touchZoomRotate.enable();
    }
    updateReadout();
    announce('Map unlocked. Drag to pan, right-drag to tilt and turn, scroll to zoom.');
  } else {
    stopDrift();
    map.scrollZoom.disable();
    if (COARSE) {
      map.dragPan.disable();
      map.touchZoomRotate.disable();
    }
    announce('Map following the story again.');
  }

  if (losingFocus) {
    // focus() dispatches focusin synchronously and that listener would flip
    // straight back to exploring, so gate it across the call.
    suppressFocusEnter = true;
    map.getCanvas().focus({ preventScroll: true });
    suppressFocusEnter = false;
  }
}

// --------------------------------------------------------------- camera ----

function cameraFor(step) {
  const s = byStep(step);
  if (!s) {
    return {
      center: [OVERVIEW.lon, OVERVIEW.lat],
      zoom: OVERVIEW.zoom,
      bearing: OVERVIEW.bearing,
      pitch: OVERVIEW.pitch,
    };
  }

  // Prefer the boundary's own centre and reach; fall back to the hand-picked
  // stop while the boundaries are still in flight, or if they never arrive.
  const frame = frames[step];
  const zoom = frame ? zoomForFrame(frame, s.pitch) : null;

  return zoom == null
    ? { center: [s.lon, s.lat], zoom: s.zoom, bearing: s.bearing, pitch: s.pitch }
    : { center: [frame.lon, frame.lat], zoom, bearing: s.bearing, pitch: s.pitch };
}

let flightToken = 0;

function flyToStep(step) {
  if (!map || exploring) return;
  stopDrift();

  const cam = cameraFor(step);
  const site = byStep(step);
  const token = ++flightToken;

  if (REDUCED) {
    map.jumpTo(cam);
  } else {
    map.flyTo({
      ...cam,
      // Continue turning the way the drift was already going rather than
      // unwinding — this is what makes leaving one site and arriving at the
      // next read as a single move instead of two.
      bearing: shortestBearing(map.getBearing(), cam.bearing),
      duration: 3200,
      // A flatter arc than the default. flyTo climbs to clear the distance,
      // and over terrain a high climb reads as being yanked upward.
      curve: 1.1,
      // Ease out much more than in, so the camera settles onto the site
      // instead of stopping dead on it.
      easing: (t) => 1 - Math.pow(1 - t, 3),
      essential: true,
    });

    /* Hand the flight over to the drift the moment it settles. Guarded by a
       token because moveend fires for every move, including the ones this
       very drift causes and any flight that has since superseded it. */
    map.once('moveend', () => {
      if (token !== flightToken || exploring) return;
      startDrift();
    });
  }

  repaintBoundaries();
  schedulePrefetch(step);
  announce(site ? `Now showing ${site.name}. ${site.note}.` : 'Showing the whole working area.');
}

// ---------------------------------------------------------------- orbit ----

/* The camera keeps circling the site it has landed on, and starts on its own
   once each flight settles — no button, nothing to press.

   Speed is the whole design here. A drone orbit reads as cinematic at a few
   degrees per second and as nausea above about ten, so this sits at 6°/s: a
   reader lingering fifteen seconds at a stop sees roughly a quarter turn,
   which is plainly moving without ever demanding to be watched. It is driven
   by elapsed time rather than frame count so a slow device orbits at the same
   rate as a fast one, just less smoothly. */
const ORBIT_DEG_PER_SEC = 6;

let lastFrameTime = 0;

function startDrift() {
  if (!map || orbiting || REDUCED || exploring) return;
  orbiting = true;
  lastFrameTime = 0;

  const frame = (t) => {
    if (!orbiting || !map) return;
    if (lastFrameTime) {
      // Clamp dt so a backgrounded tab doesn't resume with a violent spin
      const dt = Math.min((t - lastFrameTime) / 1000, 0.1);
      map.setBearing(map.getBearing() + ORBIT_DEG_PER_SEC * dt);
    }
    lastFrameTime = t;
    orbitRaf = requestAnimationFrame(frame);
  };
  orbitRaf = requestAnimationFrame(frame);
}

function stopDrift() {
  if (!orbiting) return;
  orbiting = false;
  cancelAnimationFrame(orbitRaf);
  orbitRaf = 0;
  lastFrameTime = 0;
}

/* Pick the way round that is actually shorter. Left alone, a drift that has
   wandered to 350° flying to a stop that wants 10° would unwind the long way
   — most of a rotation backwards, in the middle of what should read as one
   continuous move. */
function shortestBearing(from, to) {
  return from + (((((to - from) % 360) + 540) % 360) - 180);
}

// --------------------------------------------------------------- tiles -----

function onTileError() {
  tileErrors += 1;
  // One failed tile is a hiccup; a wall of them is a broken connection.
  if (tileErrors >= 10 && ui) ui.fail.hidden = false;
}

function updateReadout() {
  if (!map || !ui) return;
  const c = map.getCenter();
  const ns = c.lat >= 0 ? 'N' : 'S';
  const ew = c.lng >= 0 ? 'E' : 'W';
  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][
    Math.round(((map.getBearing() % 360) + 360) % 360 / 45) % 8
  ];
  ui.readout.textContent =
    `${Math.abs(c.lat).toFixed(4)}° ${ns}, ${Math.abs(c.lng).toFixed(4)}° ${ew} · ` +
    `z${map.getZoom().toFixed(1)} · ${compass} · ${Math.round(map.getPitch())}° tilt`;
}

// ------------------------------------------------------------- prefetch ----

/* Warming the next stop's tiles so a flight lands on imagery instead of grey.
   Deliberately frugal: only the steps either side of the current one, only on
   idle, never on a metered or slow connection, and hard-capped — scrolling
   the section should cost a few hundred KB, not the whole corpus. */
const PREFETCH_TILE_CAP = 240;

function slowConnection() {
  const c = navigator.connection;
  if (!c) return false;
  return !!c.saveData || /(^|-)2g$/.test(c.effectiveType || '');
}

function tilesForView(lat, lon, zoom, width, height) {
  const z = Math.min(Math.round(zoom), BASE.maxzoom);
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;

  /* A tile from level z draws at 256 * 2^(zoom - z) screen pixels, not 256,
     because the camera sits at fractional zooms — and a pitched camera sees
     further still, so the span is padded. Getting this wrong leaves a third
     of every landing loading in front of the reader. */
  const tilePx = 256 * 2 ** (zoom - z);
  const pitchPad = 1.6;
  const halfW = (width / 2 / tilePx) * pitchPad;
  const halfH = (height / 2 / tilePx) * pitchPad;

  const out = [];
  for (let tx = Math.floor(x - halfW); tx <= Math.floor(x + halfW); tx += 1) {
    for (let ty = Math.floor(y - halfH); ty <= Math.floor(y + halfH); ty += 1) {
      if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
      out.push([z, ty, tx]);
    }
  }
  return out;
}

function warmStep(step) {
  const site = byStep(step);
  if (!site || !map) return;

  const { width, height } = map.getCanvas();
  const spec = BASE;

  tilesForView(site.lat, site.lon, site.zoom, width, height).forEach(([z, y, x]) => {
    if (prefetchBudget <= 0) return;
    const key = `${z}/${y}/${x}`;
    if (prefetched.has(key)) return;
    prefetched.add(key);
    prefetchBudget -= 1;

    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.src = spec.tiles[0].replace('{z}', z).replace('{y}', y).replace('{x}', x);
  });
}

function schedulePrefetch(step) {
  if (slowConnection() || !map || idleHandle) return;

  const i = SITES.findIndex((s) => s.step === step);
  const targets = i < 0 ? [SITES[0]?.step] : [SITES[i + 1]?.step, SITES[i - 1]?.step];

  const run = () => {
    idleHandle = 0;
    targets.filter(Boolean).forEach(warmStep);
  };

  idleHandle = window.requestIdleCallback
    ? window.requestIdleCallback(run, { timeout: 2500 })
    : setTimeout(run, 600);
}

// ------------------------------------------------------------ observers ----

function watchSteps() {
  const steps = document.querySelectorAll('.forest-step');
  if (!steps.length) return;

  const onScreen = new Set();

  stepObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => (e.isIntersecting ? onScreen.add(e.target) : onScreen.delete(e.target)));
      if (!onScreen.size) return;

      /* Whichever step is nearest the middle of the viewport wins. Taking the
         last intersecting entry instead looks equivalent and is not: a fast
         scroll or an anchor jump delivers several steps in one batch, and the
         map would follow whichever the browser listed last — leaving the
         imagery on one preserve while the card beside it describes another. */
      const mid = window.innerHeight / 2;
      let best = null;
      let bestDistance = Infinity;
      onScreen.forEach((node) => {
        const r = node.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestDistance) {
          bestDistance = d;
          best = node;
        }
      });

      const step = best?.dataset.step;
      if (!step || step === activeStep) return;
      activeStep = step;

      flyToStep(step);

      document.querySelectorAll('.forest-card').forEach((card) => {
        card.classList.toggle('visible', card.closest('.forest-step')?.dataset.step === step);
      });
    },
    // A band across the middle of the viewport, so a step becomes active when
    // it reaches the reader's eyeline rather than when it first peeks in.
    { threshold: 0, rootMargin: '-45% 0px -45% 0px' }
  );

  steps.forEach((s) => stepObserver.observe(s));

  /* Hand the camera back once the section is off screen. On touch, exploring
     enables dragging, which claims the gesture — without this a reader who
     left by scrolling would find the map still holding it on return. */
  const section = document.querySelector('.forest-steps');
  if (!section) return;

  sectionObserver = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) {
        stopDrift();
        if (exploring) setExploring(false);
        return;
      }
      /* Back on screen: pick the orbit up again. flyToStep restarts it when
         the STEP changes, which misses the common case of leaving and coming
         back to the same one — that reader would return to a still frame.
         Not during a flight: that one starts its own orbit on arrival, and
         two of them would fight over the bearing. */
      if (!exploring && !document.hidden && !map?.isEasing()) startDrift();
    },
    { threshold: 0 }
  );
  sectionObserver.observe(section);
}

/* app.js calls start() while #path-forest is still display:none (app.js:105
   runs before .active lands on :110), so the canvas would size to 0x0. */
function watchSize() {
  /* Coalesced to one call per frame. Every distinct viewport height makes
     MapLibre's Terrain destroy and reallocate its coords texture, depth
     texture and framebuffer — and the panel height is a 0.4 s CSS transition
     on mobile (css/responsive.css), so an unthrottled observer fired 32
     resizes and 22 framebuffer reallocations for a single tap to explore.
     That is the heaviest GPU churn in the file and the likeliest way to get
     a context killed for real.

     MapLibre already watches this same element on its own 50 ms throttle, so
     the resize() below is belt-and-braces; this observer is really here for
     the re-frame under it. */
  let pending = 0;

  ro = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (!map || !box || box.width < 2 || box.height < 2) return;

    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      if (!map) return;
      map.resize();

      /* The frame is a fraction of the panel, so a panel that changed size is
         now framing the wrong amount of park. Zoom only — centre, bearing and
         pitch are all still correct — and never on top of a flight in
         progress or a reader who has taken the camera. */
      const site = byStep(activeStep);
      const zoom = site && frames[activeStep] ? zoomForFrame(frames[activeStep], site.pitch) : null;
      if (zoom != null && !exploring && !map.isEasing()) map.setZoom(zoom);
    });
  });

  ro.observe(host);
}

// ----------------------------------------------------------- interaction ---

function wireInteraction() {
  const canvas = map.getCanvasContainer();

  /* DOM events on the container rather than MapLibre's movestart/zoomstart,
     because flyTo fires those itself — a naive listener would have the camera
     cancel its own flight the moment it started one. */
  on(canvas, 'pointerdown', (e) => {
    if (COARSE) return; // a touch drag is the page-scroll gesture, not a grab
    if (e.target.closest('.fmap-ui')) return;
    setExploring(true);
  });

  /* Touch opts in with a discrete tap instead, which is safe because the map
     is inert until it happens: no handler has claimed the gesture yet. */
  if (COARSE) {
    on(canvas, 'click', (e) => {
      if (e.target.closest('.fmap-ui')) return;
      setExploring(true);
    });
  }

  /* Keyboard readers reach the map by tabbing to the canvas, so focus is as
     much "I am using this" as a pointerdown is. Without it the map could only
     ever be unlocked with a mouse. */
  on(canvas, 'focusin', () => {
    if (!suppressFocusEnter) setExploring(true);
  });

  on(document, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!exploring) return;
    setExploring(false);
    flyToStep(activeStep);
  });

  /* The orbit used to be killed here by a listener on pointerdown, wheel and
     touchstart. The wheel was the mistake: cooperativeGestures means a bare
     wheel over this map scrolls the PAGE and moves nothing, so scrolling down
     the section stopped the orbit at every stop while the camera sat still —
     the reader saw one turn on arrival and a frozen frame from then on.

     Nothing needs to watch raw input at all. dragPan, scrollZoom and
     touchZoomRotate are all disabled until setExploring(true), so there is no
     way to move this camera without going through that one function, and that
     is where the orbit now yields.

     With one exception: MapLibre's own zoom and compass buttons sit in a
     sibling container, outside everything above, and drive the camera
     directly. Pressing one is unambiguously taking it — especially the
     compass, which resets north, a thing the orbit would undo within seconds
     if it kept running. */
  on(map.getContainer(), 'pointerdown', (e) => {
    if (e.target.closest('.maplibregl-ctrl-group button')) setExploring(true);
  });

  /* THE BLACK MAP.

     MapLibre 4.7.1 cannot recover a terrain style from a lost WebGL context,
     and fails at it silently. It registers the handlers and calls
     preventDefault(), so the browser does offer a restore — but its
     _contextRestored only builds a new Painter. map.terrain and
     painter.renderToTexture still reference the DEAD painter, and every
     cached tile texture belongs to a context that no longer exists. Forcing
     a loss and restore on this page leaves 0 of 17 imagery textures valid
     and renderToTexture undefined.

     What the reader sees is the panel's own background colour with all the
     chrome still drawn on top, no console error, and the orbit still
     turning the bearing — a map that looks alive and blank. It never heals:
     fresh tiles keep arriving and uploading fine, and none of them are
     drawn.

     So the only recovery is to build the map again. init() handles the
     teardown, but two details matter: it must not run inside the handler,
     because it removes the very canvas that fired the event; and destroy()
     resets activeStep to 'overview', so the step has to be carried across
     or the reader gets a 3.2 s flight back from the coast. */
  let contextDead = false;

  map.on('webglcontextlost', () => {
    contextDead = true;
    stopDrift();
    if (ui) ui.fail.hidden = false;
  });

  map.on('webglcontextrestored', () => {
    const container = host; // destroy() nulls this
    const step = activeStep; // ...and resets this to 'overview'
    requestAnimationFrame(() => {
      if (!container) return;
      init(container);
      activeStep = step;
    });
  });

  /* Nothing to orbit for on a tab nobody is looking at. rAF is already
     throttled when hidden, but the section observer would happily restart the
     drift on a backgrounded tab, and this map's every frame is a full terrain
     render. */
  on(document, 'visibilitychange', () => {
    if (document.hidden) stopDrift();
    else if (!exploring && !map?.isEasing()) startDrift();
  });

  map.on('move', updateReadout);
  map.on('error', (e) => {
    if (String(e?.error?.message || '').includes('tile')) onTileError();
  });
  map.on('dataloading', () => {});
  map.on('data', (e) => {
    if (e.dataType === 'source' && e.tile) {
      tileErrors = 0;
      /* ...but not once the context is gone. Tiles keep loading perfectly
         after a context loss — only drawing is dead — so without this guard
         the very next tile would clear the failure message one frame after
         it appeared. */
      if (ui && !ui.fail.hidden && !contextDead) ui.fail.hidden = true;
    }
  });
}

/* No hand-rolled modifier hint here any more: MapLibre's cooperativeGestures
   option implements the same contract natively, overlay and all, so the
   custom wheel handler this map used to carry is gone. */

// ------------------------------------------------------------- lifecycle ---

export function init(container) {
  if (!container) return;
  destroy(); // start() can run again without stop() when re-entering the path

  const gen = ++generation;
  host = container;
  host.classList.add('fmap');

  buildChrome();

  /* Before MapLibre, and deliberately not inside the promise. This observer
     also adds .visible to each .forest-card, which is what reveals the text —
     the cards are opacity:0 until it does. If it only started after the
     library resolved, a failed vendor script would silently hide all five
     Conservation write-ups, turning a missing map into a missing section. */
  watchSteps();

  loadMapLibre()
    .then((maplibregl) => {
      if (gen !== generation) return; // the path was left while it loaded

      const cam = cameraFor(activeStep);
      map = new maplibregl.Map({
        container: host,
        style: buildStyle(),
        center: cam.center,
        zoom: cam.zoom,
        bearing: cam.bearing,
        pitch: cam.pitch,
        maxPitch: 80,
        minZoom: 6,
        maxZoom: 20,
        attributionControl: false,
        // MapLibre's own implementation of the contract this map wants: the
        // wheel scrolls the page until the reader holds the modifier.
        cooperativeGestures: !COARSE,
        // One-finger drag is the page-scroll gesture on touch. Taking it would
        // trap the reader inside the map, so touch starts inert and opts in.
        dragPan: !COARSE,
        touchZoomRotate: !COARSE,
        scrollZoom: false,
        keyboard: true,
        fadeDuration: REDUCED ? 0 : 300,

        /* Hold a whole revolution's worth of tiles.
           MapLibre sizes its tile cache as (tiles across + 1) x (tiles down
           + 1) x maxTileCacheZoomLevels, which defaults to 5 — about 75 tiles
           in this panel. That is tuned for a map that sits still. This one
           orbits, so tiles leave the frame behind the camera and come back a
           revolution later, and at 75 the cache was pinned at exactly its
           maximum and evicting them in between: measured 11 tile loads per
           revolution, every revolution, forever. Each reload draws first from
           an overzoomed parent and then sharpens, which is the imagery
           visibly changing resolution as the view turns.

           At 12 the cache holds 180 and steady-state loads per revolution
           measured ZERO — the orbit closes on itself entirely from cache. 24
           was no better (it only got to 6 before, mid-warm), so this is the
           knee, not the ceiling.

           Note maxTileCacheSize is the WRONG knob and cannot do this: the
           vendored code takes Math.min(maxTileCacheSize, computed), so it can
           only ever shrink the cache. */
        maxTileCacheZoomLevels: 12,
      });

      /* Compact by choice, not by width. Five credits do not fit across a
         696 px panel, and expanded they wrapped to two lines welded to the
         bottom edge, under the hint pill and into the right-edge dissolve.
         See the .maplibregl-ctrl-attrib rules in path-forest.css. */
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

      /* ...and compact still opens itself. MapLibre's _updateCompact adds
         both `maplibregl-compact` and `-compact-show`, so the control starts
         expanded and re-expands on every resize — and this map resizes on
         entering the path, on the ResizeObserver, and twice more on the first
         two frames. Registered after addControl, so this runs after the
         control's own resize handler. The credits are one click away on the
         chip, which is how every compact attribution on the web behaves. */
      const collapseAttribution = () =>
        host
          .querySelector('.maplibregl-ctrl-attrib')
          ?.classList.remove('maplibregl-compact-show');
      map.on('load', collapseAttribution);
      map.on('resize', collapseAttribution);
      map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
      // The compass earns its place now that the map actually rotates —
      // clicking it resets north, which is the way out of a confusing bearing.
      map.addControl(
        new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }),
        'bottom-right'
      );

      map.on('load', () => {
        if (gen !== generation) return;
        styleReady = true;
        loadBoundaries(gen);
        updateReadout();
        map.resize();
      });

      wireInteraction();
      watchSize();

      /* Budget first: flyToStep schedules a prefetch pass itself and warmStep
         reads the budget when the idle callback fires rather than when it is
         queued — but relying on that ordering would trap whoever edits next. */
      prefetchBudget = PREFETCH_TILE_CAP;
      schedulePrefetch(activeStep);

      // app.js adds .active in the same task as start(), so the box exists by
      // the second frame. The ResizeObserver covers the general case.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (gen !== generation || !map) return;
          map.resize();
        })
      );
    })
    .catch(() => {
      if (gen !== generation || !ui) return;
      ui.fail.hidden = false;
    });
}

export function destroy() {
  generation += 1;

  stopDrift();
  clearTimeout(hintTimer);
  hintTimer = 0;

  if (idleHandle) {
    if (window.cancelIdleCallback) window.cancelIdleCallback(idleHandle);
    clearTimeout(idleHandle);
    idleHandle = 0;
  }

  if (stepObserver) {
    stepObserver.disconnect();
    stepObserver = null;
  }
  if (sectionObserver) {
    sectionObserver.disconnect();
    sectionObserver = null;
  }
  if (ro) {
    ro.disconnect();
    ro = null;
  }

  while (teardown.length) teardown.pop()();

  if (map) {
    map.remove(); // frees the WebGL context — leaking these exhausts the browser
    map = null;
  }
  styleReady = false;

  if (ui) {
    ui.layer.remove();
    delete ui.panel.dataset.camera;
    ui = null;
  }

  if (host) {
    host.classList.remove('fmap');
    host.innerHTML = '';
    host = null;
  }

  activeStep = 'overview';
  exploring = false;
  frames = {};
  tileErrors = 0;
  // `prefetched` deliberately survives: those tiles are still in the browser
  // cache after leaving the path, so re-warming them would be pure waste.
}
