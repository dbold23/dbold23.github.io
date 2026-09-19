// ============================================
// Field sites — the single source for map coordinates
// ============================================
//
// Every entry here has to be defensible from something already stated
// elsewhere on the site. `precision` is the honesty knob:
//
//   exact   a specific building, dock or beach. Pin means what it looks like.
//   area    a named park or preserve. The pin is a centroid, the circle is the
//           rough extent, and the extent is the true claim.
//   region  the site names a coastline or an archipelago, not a town. Drawn
//           wide on purpose so the map does not invent a precision the
//           underlying claim never had.
//
// Coordinates are public locations of public places. Nothing here is a
// home address, a tagging site fine enough to relocate an animal, or a
// position that is not already on a state park map.

export const GROUPS = {
  lab: { name: 'Labs & institutions', color: '#3d9dd9' },
  shark: { name: 'White shark study sites', color: '#e0a03f' },
  coast: { name: 'Dive & coastal work', color: '#5fd0c5' },
  forest: { name: 'Conservation & trails', color: '#6cc46f' },
  far: { name: 'Away from Monterey Bay', color: '#b98ae0' },
};

export const SITES = [
  // ---------------------------------------------------------------- labs ----
  {
    id: 'mbari',
    name: 'MBARI',
    place: 'Moss Landing, California',
    group: 'lab',
    lat: 36.8025,
    lon: -121.7885,
    zoom: 17,
    precision: 'exact',
    panel: 'fathomnet',
    blurb:
      'Bioinspiration Lab. The FathomNet annotation and segmentation work ran from here, ' +
      'on the research campus at the north side of Moss Landing harbour.',
  },
  {
    id: 'mlml',
    name: 'Moss Landing Marine Laboratories',
    place: 'Moss Landing, California',
    group: 'lab',
    lat: 36.8003,
    lon: -121.7864,
    zoom: 17,
    precision: 'exact',
    panel: 'aquaculture',
    blurb:
      'Gardner Lab. Purple urchin aquaculture — the tank rows, the dissections, and the ' +
      'husbandry work that went with them.',
  },
  {
    id: 'csumb',
    name: 'CSU Monterey Bay',
    place: 'Seaside, California',
    group: 'lab',
    lat: 36.6537,
    lon: -121.7995,
    zoom: 15,
    precision: 'area',
    radius: 1200,
    panel: 'jue',
    blurb:
      'Home campus. The Jorgensen Lab (white sharks, biologging, telemetry) and the Jue Lab ' +
      '(microbial bioremediation) both sit here, and so does the B.S. in Marine Science.',
  },

  // -------------------------------------------------------------- sharks ----
  {
    id: 'ano-nuevo',
    name: 'Año Nuevo',
    place: 'San Mateo County, California',
    group: 'shark',
    lat: 37.1083,
    lon: -122.3372,
    zoom: 15,
    precision: 'area',
    radius: 900,
    panel: 'shark',
    blurb:
      'One of four sites in the white shark video corpus. The island and its pinniped ' +
      'haul-outs are why the sharks are here at all.',
  },
  {
    id: 'farallon',
    name: 'Farallon Islands',
    place: 'Gulf of the Farallones, California',
    group: 'shark',
    lat: 37.6989,
    lon: -123.0033,
    zoom: 14,
    precision: 'area',
    radius: 1400,
    panel: 'shark',
    blurb:
      'Southeast Farallon. Twenty-seven miles offshore, and one of the four sites feeding ' +
      'the 2012–2026 video corpus.',
  },
  {
    id: 'point-reyes',
    name: 'Point Reyes',
    place: 'Marin County, California',
    group: 'shark',
    lat: 37.9958,
    lon: -122.9880,
    zoom: 13,
    precision: 'area',
    radius: 4000,
    panel: 'shark',
    blurb:
      'The headland and the water off it. Fourth of the four white shark sites in the corpus.',
  },
  {
    id: 'aptos-coast',
    name: 'Aptos',
    place: 'Northern Monterey Bay, California',
    group: 'shark',
    lat: 36.9640,
    lon: -121.9060,
    zoom: 13,
    precision: 'area',
    radius: 3500,
    panel: 'shark',
    blurb:
      'Nearshore northern Monterey Bay — the closest of the four white shark sites to campus, ' +
      'and the one you can reach on a weekday.',
  },

  // --------------------------------------------------------------- coast ----
  {
    id: 'san-carlos',
    name: 'San Carlos Beach',
    place: 'Monterey, California',
    group: 'coast',
    lat: 36.6086,
    lon: -121.8936,
    zoom: 17,
    precision: 'exact',
    panel: 'fieldops',
    blurb:
      'Breakwater Cove. Site of the independent AAUS study — thermal thresholds and ' +
      'temperature fluctuation in kelp forest health.',
  },
  {
    id: 'elkhorn',
    name: 'Elkhorn Slough',
    place: 'Monterey County, California',
    group: 'coast',
    lat: 36.8210,
    lon: -121.7450,
    zoom: 14,
    precision: 'area',
    radius: 3000,
    blurb:
      'Wetland habitat restoration and trail stewardship. The estuary runs seven miles inland ' +
      'from the harbour mouth — worth zooming out to see the whole channel.',
  },

  // -------------------------------------------------------------- forest ----
  {
    id: 'nisene',
    name: 'The Forest of Nisene Marks',
    place: 'Aptos, California',
    group: 'forest',
    lat: 37.0330,
    lon: -121.8930,
    zoom: 13,
    precision: 'area',
    radius: 3200,
    blurb: 'Trail committee chair. GIS mapping, trail construction and volunteer leadership.',
  },
  {
    id: 'wilder',
    name: 'Wilder Ranch State Park',
    place: 'Santa Cruz, California',
    group: 'forest',
    lat: 36.9614,
    lon: -122.0847,
    zoom: 14,
    precision: 'area',
    radius: 2400,
    blurb: 'Trail construction in the Santa Cruz Mountains.',
  },
  {
    id: 'henry-cowell',
    name: 'Henry Cowell Redwoods',
    place: 'Felton, California',
    group: 'forest',
    lat: 37.0410,
    lon: -122.0640,
    zoom: 14,
    precision: 'area',
    radius: 2200,
    blurb: 'Trail construction in the Santa Cruz Mountains.',
  },
  {
    id: 'big-sur',
    name: 'Big Sur Land Trust',
    place: 'Carmel & the Big Sur coast, California',
    group: 'forest',
    lat: 36.5230,
    lon: -121.9160,
    zoom: 12,
    precision: 'area',
    radius: 7000,
    blurb:
      'Coastal and mountain stewardship across 20,000+ acres. The circle is the Palo Corona ' +
      'end of it, not the whole holding.',
  },
  {
    id: 'santa-lucia',
    name: 'Santa Lucia Conservancy',
    place: 'Carmel Valley, California',
    group: 'forest',
    lat: 36.4780,
    lon: -121.7850,
    zoom: 12,
    precision: 'area',
    radius: 6500,
    blurb: 'A 20,000-acre preserve. Invasive species removal and biodiversity monitoring.',
  },

  // ----------------------------------------------------------------- far ----
  {
    id: 'galapagos',
    name: 'Galápagos',
    place: 'Ecuador',
    group: 'far',
    lat: -0.5500,
    lon: -90.7500,
    zoom: 8,
    precision: 'region',
    radius: 90000,
    panel: 'relay',
    blurb:
      'Where the low-cost VHF relay was deployed and where local teams were taught to build ' +
      'and repair their own. Archipelago view — the individual deployment sites are not published here.',
  },
  {
    id: 'south-africa',
    name: 'South African coastal waters',
    place: 'South Africa',
    group: 'far',
    lat: -34.1000,
    lon: 22.5000,
    zoom: 7,
    precision: 'region',
    radius: 190000,
    panel: 'southafrica',
    blurb:
      'Six weeks of survey diving and vessel work, July–August 2024. Shown as a coastline ' +
      'rather than a pin, because a coastline is what the record says.',
  },
];

// Opening view: the whole Monterey Bay working area, which is where most of it happened
export const HOME_VIEW = { lat: 36.85, lon: -121.95, zoom: 9 };

export const siteById = (id) => SITES.find((s) => s.id === id) || null;
