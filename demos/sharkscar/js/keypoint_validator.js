/**
 * keypoint_validator.js — Biomechanical validation for 16-keypoint annotations.
 * Runs client-side before save to catch placement errors.
 *
 * NOTE: All coordinates are in PIXEL space (x: 0–640, y: 0–360), NOT normalized.
 *
 * Exposes: window.validateKeypoints(keypoints, bbox)
 *   Returns { errors: [string], warnings: [string] }
 */
"use strict";

(function () {
  // Body-axis keypoints in anterior → posterior anatomical order
  const BODY_AXIS_ORDER = [
    "snout_tip", "eye_center", "gill_slit_front", "gill_slit_back",
    "dorsal_base_front", "dorsal_base_back",
    "caudal_notch", "caudal_upper_tip"
  ];

  // Paired keypoints where "front" must be anterior to "back"
  const ORDERED_PAIRS = [
    ["gill_slit_front", "gill_slit_back", "Gill slit front/back"],
    ["pectoral_base_front", "pectoral_base_back", "Pectoral base front/back"],
    ["dorsal_base_front", "dorsal_base_back", "Dorsal base front/back"],
  ];

  // Min pixel distance between distinct keypoints
  const MIN_KP_DISTANCE = 3; // pixels

  function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  /**
   * Validate keypoint placements for biomechanical plausibility.
   * @param {Array} keypoints - [{name, x, y, v}, ...] in PIXEL coords
   * @param {Object|null} bbox - {x, y, width, height} in PIXEL coords, or null
   * @returns {{errors: string[], warnings: string[]}}
   */
  function validateKeypoints(keypoints, bbox) {
    const errors = [];
    const warnings = [];

    if (!keypoints || !Array.isArray(keypoints)) return { errors, warnings };

    // Build lookup of placed keypoints (v > 0 and not at origin sentinel)
    const kp = {};
    for (const p of keypoints) {
      if (p && p.v > 0 && !(p.x === 0 && p.y === 0)) {
        kp[p.name] = p;
      }
    }

    const placed = Object.keys(kp);
    if (placed.length < 2) return { errors, warnings };

    // ── Check 1: Points too close (duplicate click) ────────────────
    const names = placed;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const d = dist(kp[names[i]], kp[names[j]]);
        if (d < MIN_KP_DISTANCE) {
          warnings.push(
            `${_label(names[i])} and ${_label(names[j])} are very close together (${d.toFixed(0)}px) — possible duplicate placement`
          );
        }
      }
    }

    // ── Check 3: Spatial ordering along body axis ────────────────
    const axisKps = BODY_AXIS_ORDER.filter(n => kp[n]);
    if (axisKps.length >= 3) {
      // Auto-detect orientation: is snout left or right?
      const first = kp[axisKps[0]];
      const last = kp[axisKps[axisKps.length - 1]];
      const leftToRight = first.x < last.x;

      for (let i = 0; i < axisKps.length - 1; i++) {
        const a = kp[axisKps[i]];
        const b = kp[axisKps[i + 1]];
        const tolerance = 6; // ~1% of 640px
        const wrongOrder = leftToRight ? a.x > b.x + tolerance : a.x < b.x - tolerance;
        if (wrongOrder) {
          warnings.push(
            `${_label(axisKps[i])} should be anterior to ${_label(axisKps[i + 1])} but appears posterior — check placement`
          );
        }
      }
    }

    // ── Check 4: Paired keypoint ordering ────────────────────────
    for (const [front, back, label] of ORDERED_PAIRS) {
      if (kp[front] && kp[back]) {
        const d = dist(kp[front], kp[back]);
        if (d < MIN_KP_DISTANCE) {
          warnings.push(`${label}: front and back are nearly identical — check placement`);
        }
      }
    }

    // ── Check 5: Dorsal fin tip / base swap detection ─────────────
    if (kp["dorsal_base_front"] && kp["dorsal_fin_tip"]) {
      const base = kp["dorsal_base_front"];
      const tip = kp["dorsal_fin_tip"];

      // In image coords, y increases downward. Dorsal tip should be above (smaller y).
      if (tip.y > base.y + 7) {
        warnings.push(
          "dorsal fin tip is BELOW dorsal base front — these may be swapped. " +
          "Tip = apex of the fin (highest point), Base front = where the fin meets the body"
        );
      }

      // Cross-check against body axis: base should be near gill/pectoral y-level,
      // tip should be distinctly above
      const bodyAxisRefs = ["gill_slit_back", "pectoral_base_front", "gill_slit_front"];
      const refYs = bodyAxisRefs.filter(n => kp[n]).map(n => kp[n].y);
      if (refYs.length > 0) {
        const avgBodyY = refYs.reduce((a, b) => a + b, 0) / refYs.length;
        // If "base" is far above body axis and "tip" is near it, they're swapped
        const baseFarAbove = base.y < avgBodyY - 29; // ~8% of 360
        const tipNearBody = Math.abs(tip.y - avgBodyY) < 18; // ~5% of 360
        if (baseFarAbove && tipNearBody) {
          warnings.push(
            "dorsal base front appears to be at the fin apex and dorsal fin tip is on the body axis — " +
            "these are likely swapped"
          );
        }
      }

      if (dist(base, tip) < MIN_KP_DISTANCE) {
        warnings.push("Dorsal fin tip and base are nearly identical");
      }
    }

    // ── Check 6: Bbox containment ────────────────────────────────
    if (bbox && bbox.width > 0 && bbox.height > 0) {
      const margin = 0.05; // 5% margin
      const bx1 = bbox.x - margin * bbox.width;
      const by1 = bbox.y - margin * bbox.height;
      const bx2 = bbox.x + bbox.width + margin * bbox.width;
      const by2 = bbox.y + bbox.height + margin * bbox.height;

      // Both bbox and keypoints are in pixel coords — compare directly
      const outside = [];
      for (const name of placed) {
        const p = kp[name];
        if (p.x < bx1 || p.x > bx2 || p.y < by1 || p.y > by2) {
          outside.push(_label(name));
        }
      }
      if (outside.length > 0) {
        warnings.push(
          `${outside.length} keypoint(s) outside bounding box: ${outside.join(", ")}`
        );
      }
    }

    // ── Check 7: Caudal tips relative to notch ───────────────────
    if (kp["caudal_notch"] && kp["caudal_upper_tip"] && kp["caudal_lower_tip"]) {
      const upper = kp["caudal_upper_tip"];
      const lower = kp["caudal_lower_tip"];
      // Upper should be above (smaller y), lower should be below (larger y)
      if (upper.y > lower.y) {
        warnings.push(
          "Caudal upper tip is below caudal lower tip — check which is which"
        );
      }
    }

    return { errors, warnings };
  }

  function _label(name) {
    return name.replace(/_/g, " ");
  }

  window.validateKeypoints = validateKeypoints;
})();
