#!/usr/bin/env python3
"""
Build the park boundaries for the Conservation map.

WHERE THEY COME FROM
--------------------
Five are OpenStreetMap protected-area relations, fetched as assembled polygons
from polygons.openstreetmap.fr. ODbL 1.0, so the credit rides on the source in
forest-map.js and is a licence condition, not decoration.

The sixth is the Santa Lucia Preserve, which has no OSM boundary and never
will: it is private, gated land. It comes instead from the California
Conservation Easement Database (CCED), published by GreenInfo Network through
the state's own ArcGIS service — the Santa Lucia Conservancy's easement is a
matter of public record even though the land is closed.

LEGIBILITY vs COMPLETENESS
--------------------------
A protected-area relation is a legal object, not a drawing. It carries every
parcel the agency holds, and at these camera distances most of them are
invisible or actively misleading:

  - Elkhorn Slough Ecological Reserve is seven parcels, five of them under 90
    acres, scattered around a 1,187-acre core. At 33 m per pixel they are
    green confetti.
  - The Santa Lucia easement has 4,098 rings. One is the 18,055-acre preserve;
    the other 4,097 are homesites punched out of it, about an acre each. At
    31 m per pixel a one-acre hole is two pixels.

So this drops rings under MIN_RING_SHARE of their park's largest, drops
interior holes, and simplifies what survives. Every drop is printed and the
totals are recorded in the file's own provenance block, because a boundary
that quietly disagrees with the acreage on the card is worse than no boundary.

Dropping is not the only correction. Elkhorn's relation covers the LAND the
reserve holds, so drawing it alone put the boundary around the marsh margins
and left the slough itself — the water, the actual subject — outside the park.
The tidal channel is a separate OSM object and is now drawn alongside it.

SIMPLIFICATION MUST NOT KNOT THE RING
-------------------------------------
Simplifying a ring can tie it in a knot, and a knotted boundary is the one
defect here that is invisible in a build log and glaring on the map. See
SIMPLIFY_M for what went wrong and why GEOS does it instead. The output is
checked for self-intersections before the file is written, so this script
cannot ship one even if that reasoning turns out to be wrong.

The simplified points are inherited by the 3D curtain, which does none of its
own (tools/build_walls.py). Both used to simplify separately, at 13 m and
45 m, which meant the wall was built from different points than the flat line
beside it and visibly did not stand on it.

USAGE
-----
    python3 tools/build_boundaries.py

Writes assets/park-boundaries.geojson. Needs a live connection.
"""

import json
import math
import os
import urllib.parse
import urllib.request

from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

OSM_POLY = "https://polygons.openstreetmap.fr/get_geojson.py?id={rel}&params=0"
CCED = (
    "https://gis.cnra.ca.gov/arcgis/rest/services/Boundaries"
    "/CCED_AccessType/MapServer/0/query"
)
# USGS National Hydrography Dataset, layer 9 = NHDArea (StreamRiver etc).
NHD = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/9/query"
UA = {"User-Agent": "eportfolio-boundary-build/1.0"}

# Simplification tolerance in ground metres.
#
# Applied with GEOS's TOPOLOGY-PRESERVING simplifier, which matters more than
# the number does. Plain Douglas-Peucker moves each vertex independently, so on
# a narrow neck the two opposite banks get pulled past one another and the
# outline ties itself in a knot. That is not theoretical here: a hand-rolled DP
# at this same 45 m shipped 16 self-crossings — 4 in Elkhorn's tidal channel,
# 2 in Nisene, 10 in Santa Lucia — from raw geometry that had none. Elkhorn's
# channel pinches to 1 m wide in places, so 45 m of licence is many times its
# own width.
#
# Backing the tolerance off does not fix that, and the failure is not even
# monotonic: that DP crossed 6 times at 20 m and zero times at 30 m. GEOS
# instead refuses any move that would break the ring, which costs nothing —
# it returns FEWER points than the validated-retry approach it replaced
# (Santa Lucia 585 against 1,099) and guarantees the result.
SIMPLIFY_M = 45.0

# A ring smaller than this share of its park's largest ring is dropped. At 10%
# this keeps every unit a reader would recognise as part of the park — Henry
# Cowell's Fall Creek unit, Wilder's two coastal blocks — and loses only the
# outlying parcels that read as noise.
MIN_RING_SHARE = 0.10

# A simplified ring can end up with needles: a channel arm narrower than the
# tolerance gets its two banks pulled together until the outline runs out a
# hundred metres and comes back within a few metres of itself. GEOS's
# topology-preserving mode stops that becoming an actual crossing, but a 7
# degree spike still DRAWS as one — two lines a pixel apart, which reads as the
# boundary overlapping itself.
#
# The unsimplified geometry has no angle under 179 degrees, so this is entirely
# our own artefact and removing it restores the source's own shape. Only the
# tip vertex goes, and only where both arms are long enough that it is a needle
# rather than a genuinely sharp corner (a parcel corner has short arms).
MIN_SPIKE_ANGLE = 25.0
MIN_SPIKE_ARM_M = 30.0

# The same artefact one step larger: instead of a single needle tip, the ring
# leaves the shoreline, loops through two or three vertices and comes back to
# within a few metres of where it left, enclosing a sliver. It draws as a hook
# hanging off the boundary — most visibly where Elkhorn's channel meets the
# reserve, where the return point was 4.9 m from the departure point.
#
# An excursion is only cut when it comes back this close AND wandered much
# further than the gap it closes; that second test is what stops a gentle
# curve, whose ends are also close together, from being flattened.
MIN_SLOT_M = 15.0
MIN_SLOT_DETOUR = 3.0
MAX_SLOT_SPAN = 6

SQM_PER_ACRE = 4046.8564224

# Features that should be drawn as ONE shape rather than as overlapping
# outlines. Elkhorn is the reserve plus the slough it exists to protect, and
# they share a shoreline: drawn separately you get two outlines a metre apart,
# a 400-acre reserve sliver lying over the channel, and the rail causeway
# showing up as a hairline exclusion slotted down the middle of the water.
# None of that is legible at 33 m per pixel and none of it is the point.
#
# `close_m` is a morphological close (dilate then erode) applied after the
# union. It swallows any gap or slot narrower than roughly twice itself, which
# is what removes the causeway exclusion and welds the reserve to the water
# along their shared bank. 30 m is chosen against the measured slots — the
# widest is 44 m across — and is small enough that no real inlet is bridged.
MERGES = {
    "elkhorn": {
        "name": "Elkhorn Slough Reserve and tidal channel",
        "kind": "water",
        "wall": False,
        "close_m": 30.0,
        "note": (
            "The reserve's land holdings and the slough itself, dissolved into "
            "one outline. Interior exclusions narrower than ~60 m are closed, "
            "including the rail causeway that runs down the channel — it is "
            "real, and it is two pixels wide at the zoom this is drawn at."
        ),
    },
}

# `published` is the operator's own stated acreage, used only as a sanity
# check on the fetch — a relation that has been vandalised or half-assembled
# shows up here as a number that is nowhere near.
PARKS = [
    {"key": "nisene", "step": "nisene", "name": "The Forest of Nisene Marks",
     "osmRelation": 10558949, "published": 10223},
    {"key": "wilder", "step": "scmts", "name": "Wilder Ranch State Park",
     "osmRelation": 7087507, "published": 7000},
    {"key": "henrycowell", "step": "scmts", "name": "Henry Cowell Redwoods",
     "osmRelation": 7091570, "published": 4623},
    {"key": "elkhorn", "step": "elkhorn", "name": "Elkhorn Slough Ecological Reserve",
     "osmRelation": 17185995, "published": 1700, "merge": "elkhorn"},
    # The reserve is the LAND. Elkhorn Slough itself — seven miles of tidal
    # channel, the thing the card is actually about — is a separate feature and
    # was simply missing, so the drawn extent hugged the uplands and left the
    # water outside the park.
    #
    # USGS NHD rather than OSM, because OSM stops dead at the Highway 1 bridge:
    # Moss Landing Harbor is tagged natural=coastline there, not as a water
    # area, so no OSM polygon covers the widest water on this map. NHD's is
    # 696 acres against OSM's 498 and reaches 1.6 km further south, across the
    # bridge. Matched on PERMANENT_IDENTIFIER, never on name — GNIS_NAME is
    # null on this feature and a name query returns nothing.
    #
    # `simplify` overrides the 45 m default. That tolerance is meant for a
    # 10,000-acre park; on a channel measured at 110 m wide at its mouth and
    # 80 m at its inland end it is wider than the water, and it flattened the
    # upper slough until the ring stopped crossing the channel at Kirby Park
    # altogether. `wall` turns off the 3D curtain — see build_walls.py.
    {"key": "elkhornWater", "step": "elkhorn",
     "name": "Elkhorn Slough (tidal channel)",
     "nhdPermanentId": "137232076", "kind": "water",
     "simplify": 8.0, "wall": False, "merge": "elkhorn"},
    {"key": "paloCorona", "step": "bigsur", "name": "Palo Corona Regional Park",
     "osmRelation": 15100521, "published": 4500},
    {"key": "santaLucia", "step": "santalucia", "name": "Santa Lucia Preserve",
     "ccedObjectId": 8029, "published": 15078},
]


SPIKES_REMOVED = []


def fetch_osm(rel):
    """polygons.openstreetmap.fr returns the bare geometry, not a Feature."""
    req = urllib.request.Request(OSM_POLY.format(rel=rel), headers=UA)
    g = json.load(urllib.request.urlopen(req, timeout=120))
    if g["type"] == "Polygon":
        return [g["coordinates"]]
    return g["coordinates"]  # MultiPolygon: list of [outer, hole, ...]


def esri_outers_and_holes(rings):
    """Split a FLAT Esri ring list into outers and holes.

    Esri geometry, unlike GeoJSON, does not nest holes under their outer ring;
    winding is what tells them apart — clockwise is an outer, counter-clockwise
    is a hole. Getting this wrong still renders acceptably here (holes are
    dropped either way) but it misreports them in the audit as outlying
    parcels, which is the opposite of what they are.
    """
    outers, holes = [], []
    for ring in rings:
        (holes if signed_area(ring) > 0 else outers).append(ring)
    return [[ring] for ring in outers], holes


def fetch_nhd(permanent_id):
    q = urllib.parse.urlencode(
        {
            "where": f"PERMANENT_IDENTIFIER='{permanent_id}'",
            "outFields": "PERMANENT_IDENTIFIER,FTYPE,FCODE,AREASQKM,GNIS_NAME",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "json",
        }
    )
    req = urllib.request.Request(f"{NHD}?{q}", headers=UA)
    r = json.load(urllib.request.urlopen(req, timeout=180))
    if not r.get("features"):
        raise SystemExit(f"NHD returned no feature for {permanent_id}")
    f = r["features"][0]
    outers, holes = esri_outers_and_holes(f["geometry"]["rings"])
    return outers, holes, f["attributes"]


def fetch_cced(object_id):
    q = urllib.parse.urlencode(
        {
            "where": f"OBJECTID={object_id}",
            "outFields": "sitename,esmthldr,gis_acres,pubaccess",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "json",
        }
    )
    req = urllib.request.Request(f"{CCED}?{q}", headers=UA)
    r = json.load(urllib.request.urlopen(req, timeout=180))
    f = r["features"][0]
    outers, holes = esri_outers_and_holes(f["geometry"]["rings"])
    return outers, holes, f["attributes"]


def signed_area(ring):
    """Shoelace in local metres. Positive is counter-clockwise."""
    lat = sum(p[1] for p in ring) / len(ring)
    mlon = 111320.0 * math.cos(math.radians(lat))
    mlat = 111320.0
    s = 0.0
    closed = ring if ring[0] == ring[-1] else ring + [ring[0]]
    for (x1, y1), (x2, y2) in zip(closed, closed[1:]):
        s += (x1 * mlon) * (y2 * mlat) - (x2 * mlon) * (y1 * mlat)
    return s / 2.0


def ring_area_acres(ring):
    return abs(signed_area(ring)) / SQM_PER_ACRE


def despike(poly):
    """Drop needle tips left behind by simplification. Returns (poly, n)."""
    coords = list(poly.exterior.coords)[:-1]
    removed = 0

    changed = True
    while changed and len(coords) > 4:
        changed = False
        n = len(coords)
        for i in range(n):
            a = coords[(i - 1) % n]
            b = coords[i]
            c = coords[(i + 1) % n]
            v1 = (a[0] - b[0], a[1] - b[1])
            v2 = (c[0] - b[0], c[1] - b[1])
            n1 = math.hypot(*v1)
            n2 = math.hypot(*v2)
            if n1 < 1e-9 or n2 < 1e-9 or min(n1, n2) < MIN_SPIKE_ARM_M:
                continue
            dot = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
            if math.degrees(math.acos(dot)) >= MIN_SPIKE_ANGLE:
                continue
            # Only if dropping it leaves a polygon that is still sound.
            trial = Polygon(coords[:i] + coords[i + 1:])
            if trial.is_valid and not trial.is_empty:
                coords = coords[:i] + coords[i + 1:]
                removed += 1
                changed = True
                break

    return (Polygon(coords) if removed else poly), removed


def deslot(poly):
    """Cut excursions that return to where they started. Returns (poly, n)."""
    coords = list(poly.exterior.coords)[:-1]
    removed = 0

    changed = True
    while changed and len(coords) > 6:
        changed = False
        n = len(coords)
        for i in range(n):
            for span in range(2, MAX_SLOT_SPAN + 1):
                if n - (span - 1) < 4:
                    continue
                chord = math.dist(coords[i], coords[(i + span) % n])
                if chord >= MIN_SLOT_M:
                    continue
                path = sum(
                    math.dist(coords[(i + t) % n], coords[(i + t + 1) % n])
                    for t in range(span)
                )
                if path < MIN_SLOT_DETOUR * max(chord, 1.0):
                    continue  # a gentle curve, not an excursion
                drop = {(i + t) % n for t in range(1, span)}
                trial_coords = [c for t, c in enumerate(coords) if t not in drop]
                trial = Polygon(trial_coords)
                if trial.is_valid and not trial.is_empty:
                    coords = trial_coords
                    removed += len(drop)
                    changed = True
                    break
            if changed:
                break

    return (Polygon(coords) if removed else poly), removed


def simplify(ring, tol_m):
    """Simplify a closed ring without letting it cross itself.

    Works in local metres — GEOS is planar, and a tolerance in degrees would
    mean something different at every latitude. The ring's own mean latitude
    sets the scale, which over a few km of park is exact to well under the
    1 m the output is rounded to anyway.
    """
    if len(ring) < 4:
        return ring

    lat = sum(p[1] for p in ring) / len(ring)
    mlon = 111320.0 * math.cos(math.radians(lat))
    poly = Polygon([(p[0] * mlon, p[1] * 111320.0) for p in ring])

    # A source ring can arrive already self-touching; buffer(0) is the standard
    # GEOS repair. Without it simplify() would propagate the invalidity.
    if not poly.is_valid:
        poly = poly.buffer(0)
        if poly.is_empty:
            return ring

    out = poly.simplify(tol_m, preserve_topology=True)
    if out.is_empty:
        return ring
    # preserve_topology can split a pinched ring into a MultiPolygon rather
    # than let it self-touch. Keep the largest piece; anything it shed was
    # below the tolerance in the first place.
    if out.geom_type == "MultiPolygon":
        out = max(out.geoms, key=lambda g: g.area)

    out, spikes = despike(out)
    out, slots = deslot(out)
    if spikes or slots:
        SPIKES_REMOVED.append(spikes + slots)

    return [[x / mlon, y / 111320.0] for x, y in out.exterior.coords]


def segments_cross(p, q, r, s):
    """True only for a PROPER crossing — shared endpoints do not count."""

    def side(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    d1, d2 = side(r, s, p), side(r, s, q)
    d3, d4 = side(p, q, r), side(p, q, s)
    return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0)


def self_intersections(ring):
    """Count pairs of non-adjacent edges that cross. Zero is the invariant."""
    lat = sum(p[1] for p in ring) / len(ring)
    mlon = 111320.0 * math.cos(math.radians(lat))
    pts = [(p[0] * mlon, p[1] * 111320.0) for p in ring]
    n = len(pts) - 1  # ring is closed, so the last point repeats the first
    count = 0
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue  # these two share the closing vertex
            if segments_cross(pts[i], pts[i + 1], pts[j], pts[j + 1]):
                count += 1
    return count


def merge_group(name, spec, rings, sources):
    """Dissolve a group's rings into one outline and close its gaps.

    Union first, which removes every shared edge and every overlap — the
    reserve sliver lying across the channel stops being its own outline and
    becomes part of the shore. Then a morphological close, which fills the
    slots the union cannot: a causeway excluded from the water is a notch open
    at one end, so no amount of unioning closes it.
    """
    lat0 = sum(p[1] for r in rings for p in r) / sum(len(r) for r in rings)
    mlon = 111320.0 * math.cos(math.radians(lat0))

    parts = []
    for ring in rings:
        poly = Polygon([(p[0] * mlon, p[1] * 111320.0) for p in ring])
        if not poly.is_valid:
            poly = poly.buffer(0)
        if not poly.is_empty:
            parts.append(poly)

    d = spec["close_m"]
    merged = unary_union(parts).buffer(d, join_style=1).buffer(-d, join_style=1)
    merged = merged.simplify(spec.get("simplify", SIMPLIFY_M), preserve_topology=True)

    polys = list(merged.geoms) if merged.geom_type == "MultiPolygon" else [merged]
    polys = [p for p in polys if not p.is_empty]

    spikes = 0
    cleaned = []
    for poly in polys:
        poly, k = despike(poly)
        poly, m = deslot(poly)
        spikes += k + m
        cleaned.append(poly)
    polys = sorted(cleaned, key=lambda p: -p.area)
    if spikes:
        print(f"  {'':34s} {spikes} needle/hook vertices removed where the union met itself")

    coords = [
        [[[round(x / mlon, 5), round(y / 111320.0, 5)] for x, y in p.exterior.coords]]
        for p in polys
    ]
    acres = sum(p.area for p in polys) / SQM_PER_ACRE
    pts = sum(len(c[0]) for c in coords)
    print(
        f"  {spec['name']:34s} {len(rings):4d} ring(s) -> {len(polys)}  "
        f"{pts:6d} pts, closed at {d:.0f} m  {acres:8.0f} ac  [merged, no curtain]"
        if not spec.get("wall", True)
        else f"  {spec['name']:34s} merged -> {len(polys)}, {acres:.0f} ac"
    )
    return {
        "type": "Feature",
        "properties": {
            "key": name,
            "name": spec["name"],
            "step": name,
            "kind": spec.get("kind", "land"),
            "wall": spec.get("wall", True),
            "source": " + ".join(sources),
            "note": spec.get("note"),
        },
        "geometry": {"type": "MultiPolygon", "coordinates": coords},
    }, round(acres)


def orbit_frames(features):
    """The pivot and reach the camera needs to circle each park.

    The map's stops used to be hand-picked lon/lat/zoom, which meant the
    camera turned about a trailhead while the park it was describing sat off
    to one side and swung in and out of frame. Rotating about the boundary's
    own centre fixes that by construction.

    Centre is the bounding box's centre, not the centroid: the centroid of an
    L-shaped park can sit outside the park, and what matters for framing is
    the extent. `radiusM` is the distance from that centre to the furthest
    vertex, so it describes a CIRCLE — which is the right shape here, because
    a box fitted at one bearing stops fitting the moment the orbit turns.
    Steps with two parks (Wilder and Henry Cowell) get one frame covering
    both. The renderer turns radius into a zoom, since only it knows how big
    the panel is.
    """
    by_step = {}
    for f in features:
        step = f["properties"]["step"]
        for poly in f["geometry"]["coordinates"]:
            by_step.setdefault(step, []).extend(poly[0])

    frames = {}
    for step, pts in by_step.items():
        lons = [p[0] for p in pts]
        lats = [p[1] for p in pts]
        lon = (min(lons) + max(lons)) / 2
        lat = (min(lats) + max(lats)) / 2
        mlon = 111320.0 * math.cos(math.radians(lat))
        radius = max(math.hypot((p[0] - lon) * mlon, (p[1] - lat) * 111320.0) for p in pts)
        frames[step] = {"lon": round(lon, 5), "lat": round(lat, 5), "radiusM": round(radius)}
        print(f"  frame {step:12s} {lon:10.5f} {lat:9.5f}  radius {radius/1000:5.2f} km")
    return frames


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dst = os.path.join(here, "assets", "park-boundaries.geojson")

    features = []
    audit = []
    pending = {}  # merge group -> {"rings": [...], "sources": [...]}
    print(
        f"simplify {SIMPLIFY_M:.0f} m, topology-preserving"
        f" | drop rings under {MIN_RING_SHARE:.0%} of largest\n"
    )

    for park in PARKS:
        if "osmRelation" in park:
            polys = fetch_osm(park["osmRelation"])
            hole_rings = [r for poly in polys for r in poly[1:]]
            source = f"OSM relation {park['osmRelation']}"
            note = None
        elif "nhdPermanentId" in park:
            polys, hole_rings, attrs = fetch_nhd(park["nhdPermanentId"])
            source = f"USGS NHD PERMANENT_IDENTIFIER {park['nhdPermanentId']}"
            note = (
                f"NHDArea FCODE {attrs['FCODE']}, "
                f"{attrs['AREASQKM'] * 247.105:.0f} acres. Drawn as open water: "
                "the interior islands are dropped, as is the tidal marsh around "
                "the channel, which is a separate class of feature."
            )
        else:
            polys, hole_rings, attrs = fetch_cced(park["ccedObjectId"])
            source = f"CCED OBJECTID {park['ccedObjectId']} ({attrs['esmthldr']})"
            note = (
                f"public access: {attrs['pubaccess'].lower()}. Drawn as the outer "
                f"extent: CCED records {attrs['gis_acres']:.0f} acres of easement "
                "once the interior homesite exclusions are subtracted, and those "
                "are about an acre each — two pixels at this map's scale."
            )

        # holes are dropped here, hence poly[0] only — see the module docstring
        rings = [poly[0] for poly in polys if len(poly[0]) >= 4]
        holes = len(hole_rings)
        holes_ac = sum(ring_area_acres(r) for r in hole_rings if len(r) >= 4)
        areas = [ring_area_acres(r) for r in rings]
        biggest = max(areas)
        cutoff = biggest * MIN_RING_SHARE

        kept, kept_ac, dropped_ac, dropped_n = [], 0.0, 0.0, 0
        kept_unsimplified = []
        for ring, ac in zip(rings, areas):
            if ac < cutoff:
                dropped_ac += ac
                dropped_n += 1
                continue
            kept_unsimplified.append(ring)
            kept.append([simplify(ring, park.get("simplify", SIMPLIFY_M))])
            kept_ac += ac

        pts_in = sum(len(r) for r in rings)
        pts_out = sum(len(p[0]) for p in kept)
        if park.get("published"):
            delta = (kept_ac - park["published"]) / park["published"] * 100
            check = f"(published {park['published']}, {delta:+.0f}%)"
        else:
            check = "(no published acreage to check against)"

        group = park.get("merge")
        if group:
            # Held back: this park is dissolved into a group below, and
            # simplifying it here first would round its shared shoreline
            # differently from its neighbour's and leave a seam in the union.
            slot = pending.setdefault(group, {"rings": [], "sources": []})
            slot["rings"].extend(kept_unsimplified)
            slot["sources"].append(source)

        tol = park.get("simplify", SIMPLIFY_M)
        marks = "" if park.get("wall", True) else "  [no curtain]"
        print(
            f"  {park['name']:34s} {len(rings):4d} ring(s) -> {len(kept)}  "
            f"{pts_in:6d} -> {pts_out:4d} pts @{tol:.0f}m  {kept_ac:8.0f} ac {check}{marks}"
        )
        props = {
            "key": park["key"],
            "name": park["name"],
            "step": park["step"],
            # Drives both the palette and whether a 3D curtain gets built for
            # this feature. Water gets neither green nor a wall.
            "kind": park.get("kind", "land"),
            "wall": park.get("wall", True),
            "source": source,
        }
        if "osmRelation" in park:
            props["osmRelation"] = park["osmRelation"]
        elif "nhdPermanentId" in park:
            props["nhdPermanentId"] = park["nhdPermanentId"]
        else:
            props["ccedObjectId"] = park["ccedObjectId"]
        if note:
            props["note"] = note

        if group:
            audit.append(
                {
                    "park": park["name"],
                    "outlying_rings_dropped": dropped_n,
                    "outlying_acres_dropped": round(dropped_ac),
                    "interior_exclusions_dropped": holes,
                    "interior_acres_dropped": round(holes_ac),
                    "acres_drawn": round(kept_ac),
                    "acres_published": park.get("published"),
                    "merged_into": group,
                }
            )
            continue

        features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {
                    "type": "MultiPolygon",
                    # 5 dp is ~1 m, an order of magnitude finer than the
                    # simplification that has already been applied
                    "coordinates": [
                        [[[round(x, 5), round(y, 5)] for x, y in poly[0]]] for poly in kept
                    ],
                },
            }
        )
        audit.append(
            {
                "park": park["name"],
                "rings_kept": len(kept),
                "outlying_rings_dropped": dropped_n,
                "outlying_acres_dropped": round(dropped_ac),
                "interior_exclusions_dropped": holes,
                "interior_acres_dropped": round(holes_ac),
                "acres_drawn": round(kept_ac),
                "acres_published": park.get("published"),
            }
        )

    for group, slot in pending.items():
        feature, acres = merge_group(group, MERGES[group], slot["rings"], slot["sources"])
        features.append(feature)
        audit.append({"park": MERGES[group]["name"], "acres_drawn": acres, "merged": True})

    out = {
        "type": "FeatureCollection",
        "_frames": orbit_frames(features),
        "_provenance": {
            "sources": [
                "OpenStreetMap protected-area relations via polygons.openstreetmap.fr "
                "— ODbL 1.0, (c) OpenStreetMap contributors",
                "California Conservation Easement Database (CCED), GreenInfo Network, "
                "served by gis.cnra.ca.gov — Santa Lucia Preserve only",
            ],
            "generalised": (
                f"topology-preserving simplification (GEOS) at {SIMPLIFY_M:.0f} m, "
                "or a per-feature override where that is coarser than the feature "
                "itself (see `simplify` in tools/build_boundaries.py); "
                f"rings under {MIN_RING_SHARE:.0%} of their park's largest dropped; "
                "interior holes dropped; coordinates rounded to 5 dp (~1 m)"
            ),
            "what_this_costs": (
                "These are drawn extents, not legal descriptions. Outlying parcels "
                "and interior exclusions are omitted for legibility; per-park "
                "figures are in `audit` below."
            ),
            "audit": audit,
            "built_by": "tools/build_boundaries.py",
        },
        "features": features,
    }

    # The invariant, checked on what is actually about to be written rather
    # than on what the simplifier believed it returned. A knotted boundary is
    # the one defect here that is invisible in a build log and glaring on the
    # map, so it fails the build instead.
    knots = sum(
        self_intersections(poly[0])
        for f in features
        for poly in f["geometry"]["coordinates"]
    )
    if knots:
        raise SystemExit(f"refusing to write: {knots} self-intersection(s) in output")

    json.dump(out, open(dst, "w"), separators=(",", ":"))
    print(f"\n  {len(features)} parks, 0 self-intersections, {os.path.getsize(dst)/1024:.0f} KB -> {dst}")


if __name__ == "__main__":
    main()
