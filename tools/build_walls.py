#!/usr/bin/env python3
"""
Turn the flat park boundaries into 3D wall segments.

WHY
---
A boundary drawn as a line layer is draped flat on the terrain. Under a 60
degree camera you see it edge-on, so it thins to nothing exactly when the view
gets dramatic, and at a 20 km frame it disappears entirely. A vertical curtain
standing along the same edge reads from any angle and any distance.

It is a symbol, not a claim: there is no wall at Nisene. It is the 3D
equivalent of a dashed line on a paper map, and it is drawn translucent so it
never pretends to be a structure.

GENERALISED, BUT NOT HERE
-------------------------
The curtain does not trace the survey line exactly. OSM boundary rings carry
metre-scale survey noise — parcel corners, road-easement jogs, digitising
wobble — which at these segment lengths turns into a visibly ragged,
self-intersecting fence.

That generalisation now happens once, upstream, in build_boundaries.py, and
this script does none of its own. Both used to simplify independently, at
different tolerances, which meant the wall was drawn from a different set of
points than the flat line beside it and visibly did not stand on it. The flat
line and the curtain are now the same geometry seen two ways.

HOW
---
This script makes one cartographic decision — how finely the ring is chopped —
and stops there. It writes LineStrings, and forest-map.js turns each segment
into a quad at load time (wallsFromLines).

That split is a size decision as much as a tidiness one. Every quad shares two
corners with each neighbour, so writing them out here means shipping each
position four times over: the same 4,000 segments cost 96 KB gzipped as
polygons and 19 KB as lines. The renderer can rebuild them in under a
millisecond.

No elevation is sampled here, deliberately. With terrain enabled MapLibre
lifts each extrusion by the terrain height at its own centroid (see the
TERRAIN3D branch of the fill-extrusion vertex shader), so short segments
follow the hillside for free. An earlier version of this script range-read the
DEM to compute a `base` property that the style never read — 1,100 needless
tile fetches per build for a field nothing consumed.

USAGE
-----
    python3 tools/build_walls.py

Reads assets/park-boundaries.geojson, writes assets/park-wall-lines.geojson.
"""

import json
import math
import os

# Simplification now happens UPSTREAM, in build_boundaries.py, and this file
# deliberately does none of its own. When both simplified independently the
# curtain and the flat line were generalised differently and the wall visibly
# did not stand on the boundary it was drawn from — a 45 m disagreement is a
# pixel and a half at Nisene's z13.3, which is exactly enough to notice.

# Longest quad allowed. MapLibre lifts each extrusion by the terrain height at
# its own centroid, so a quad that spans more ground than this starts to poke
# out of one hillside and sink into the next. Segments SHORTER than this are
# left alone — forcing even spacing would re-insert most of the vertices
# Douglas-Peucker just removed and quadruple the file for no visible gain.
SEGMENT_M = 70.0

# Drop ring fragments shorter than this. A park multipolygon often carries
# slivers — a detached half-acre parcel, a gap left by a road right-of-way —
# and at map scale each one becomes a stray green tick with no legible shape.
MIN_RING_PERIMETER_M = 500.0


def local_frame(ring):
    """Metres-per-degree at this ring's latitude, for planar work."""
    lat = sum(p[1] for p in ring) / len(ring)
    return 111320.0 * math.cos(math.radians(lat)), 111320.0


def to_metres(ring, mlon, mlat):
    lon0, lat0 = ring[0]
    return [((p[0] - lon0) * mlon, (p[1] - lat0) * mlat) for p in ring]


def perimeter(pts):
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))


def split_long(pts, limit):
    """Subdivide only the segments that are too long to sit on the terrain."""
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        d = math.dist(a, b)
        if d <= limit:
            out.append(b)
            continue
        n = math.ceil(d / limit)
        for i in range(1, n + 1):
            t = i / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = os.path.join(here, "assets", "park-boundaries.geojson")
    dst = os.path.join(here, "assets", "park-wall-lines.geojson")

    geo = json.load(open(src))
    out = {
        "type": "FeatureCollection",
        "_provenance": {
            "derived_from": "assets/park-boundaries.geojson (OSM, ODbL)",
            "what": (
                "Simplified boundary rings, extruded into a translucent curtain by "
                "forest-map.js. A cartographic symbol — there is no wall on the ground."
            ),
            "generalised": (
                f"segments capped at {SEGMENT_M} m; rings under "
                f"{MIN_RING_PERIMETER_M} m perimeter dropped. Simplification is "
                "inherited from park-boundaries.geojson, so the curtain and the "
                "flat line trace exactly the same points."
            ),
            "base": "terrain, applied by MapLibre at each quad's centroid",
        },
        "features": [],
    }

    total_pts = 0
    for f in geo["features"]:
        step = f["properties"]["step"]
        name = f["properties"]["name"]

        # Water gets no curtain. Two 14 m walls extruded hundreds of metres
        # tall, standing on either bank of a channel that is 80-230 m wide,
        # close over the water at the tilted camera these stops use — the
        # slough ends up looking like a trench between two ridges instead of
        # like water. It is drawn flat and filled instead. See `wall` in
        # tools/build_boundaries.py.
        if not f["properties"].get("wall", True):
            print(f"  {name:32s} skipped, drawn flat")
            continue

        rings = dropped = 0
        pts_in = pts_out = 0

        for poly in f["geometry"]["coordinates"]:
            ring = poly[0]
            if len(ring) < 4:
                continue
            mlon, mlat = local_frame(ring)
            pts = to_metres(ring, mlon, mlat)
            if perimeter(pts) < MIN_RING_PERIMETER_M:
                dropped += 1
                continue
            pts_in += len(pts)
            clean = split_long(pts, SEGMENT_M)
            pts_out += len(clean)

            lon0, lat0 = ring[0]
            # 5 dp is ~1.1 m, well under the curtain's own width
            coords = [
                [round(lon0 + x / mlon, 5), round(lat0 + y / mlat, 5)] for x, y in clean
            ]
            out["features"].append(
                {
                    "type": "Feature",
                    "properties": {"step": step},
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )
            rings += 1

        total_pts += pts_out
        note = f", {dropped} sliver(s) dropped" if dropped else ""
        print(f"  {name:32s} {rings} ring(s)  {pts_in:5d} -> {pts_out:4d} pts{note}")

    json.dump(out, open(dst, "w"), separators=(",", ":"))
    print(
        f"\n  {len(out['features'])} rings, {total_pts} points "
        f"({total_pts - len(out['features'])} quads at render time), "
        f"{os.path.getsize(dst)/1024:.0f} KB -> {dst}"
    )


if __name__ == "__main__":
    main()
