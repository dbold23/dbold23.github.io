/**
 * canvas.js — Annotation canvas with zoom/pan, SAM overlay, bbox draw, keypoints.
 * Exposes: AnnotationCanvas (class), window.annotCanvas (singleton)
 */
"use strict";

const KEYPOINT_SEQUENCE = [
  "snout_tip","eye_center","gill_slit_front","gill_slit_back",
  "pectoral_base_front","pectoral_fin_tip","pectoral_base_back",
  "dorsal_fin_tip","dorsal_base_front","dorsal_base_back",
  "second_dorsal_tip","pelvic_fin_tip","anal_fin_tip",
  "caudal_notch","caudal_upper_tip","caudal_lower_tip"
];

const SKELETON_EDGES = [
  ["snout_tip", "eye_center"],
  ["eye_center", "gill_slit_front"],
  ["gill_slit_front", "gill_slit_back"],
  ["gill_slit_back", "pectoral_base_front"],
  ["pectoral_base_front", "pectoral_fin_tip"],
  ["pectoral_fin_tip", "pectoral_base_back"],
  ["gill_slit_back", "dorsal_base_front"],
  ["dorsal_base_front", "dorsal_fin_tip"],
  ["dorsal_base_front", "dorsal_base_back"],
  ["dorsal_base_back", "second_dorsal_tip"],
  ["dorsal_base_back", "pelvic_fin_tip"],
  ["pelvic_fin_tip", "anal_fin_tip"],
  ["anal_fin_tip", "caudal_notch"],
  ["caudal_notch", "caudal_upper_tip"],
  ["caudal_notch", "caudal_lower_tip"],
];

// Template skeleton proportions (0-1 range) for left-side view.
// x: snout(0) -> tail(1), y: dorsal(0) -> ventral(1).
const SKELETON_TEMPLATE_LEFT = {
  snout_tip:             { x: 0.00, y: 0.48 },
  eye_center:            { x: 0.08, y: 0.42 },
  gill_slit_front:       { x: 0.15, y: 0.43 },
  gill_slit_back:        { x: 0.20, y: 0.45 },
  pectoral_base_front:   { x: 0.22, y: 0.58 },
  pectoral_fin_tip:      { x: 0.30, y: 0.78 },
  pectoral_base_back:    { x: 0.34, y: 0.60 },
  dorsal_fin_tip:        { x: 0.42, y: 0.15 },
  dorsal_base_front:     { x: 0.38, y: 0.30 },
  dorsal_base_back:      { x: 0.48, y: 0.32 },
  second_dorsal_tip:     { x: 0.70, y: 0.30 },
  pelvic_fin_tip:        { x: 0.55, y: 0.75 },
  anal_fin_tip:          { x: 0.72, y: 0.70 },
  caudal_notch:          { x: 0.85, y: 0.48 },
  caudal_upper_tip:      { x: 1.00, y: 0.20 },
  caudal_lower_tip:      { x: 0.98, y: 0.75 },
};

const COLORS = {
  body:    "rgba(74,144,217,0.35)",
  bodyStroke: "rgba(74,144,217,0.9)",
  scar:    "rgba(255,107,107,0.4)",
  scarStroke: "rgba(255,107,107,1)",
  kp:      "#10b981",
  kpCurrent: "#f59e0b",
  obs:     "rgba(192,132,252,0.35)",
  obsStroke: "#c084fc",
  bbox:    "rgba(74,144,217,0.15)",
  bboxStroke: "#4a90d9",
  roi:     "rgba(245,200,66,0.12)",   // Stream D — ROI mark (mark-only, no scar form)
  roiStroke: "#f5c842",
};

// Polish 6 — ghost overlay colors per track status. Hex strings; alpha is
// appended as "22" (13%) for fills in the render pass.
const TRACK_OVERLAY_COLORS = {
  verified: "#3a8",   // green — already labeled, leave alone
  proposed: "#fc3",   // yellow — needs your attention
  rejected: "#a33",   // red — usually filtered server-side; defensive
  default:  "#888",
};

class AnnotationCanvas {
  constructor() {
    this.wrap   = document.getElementById("canvas-wrap");
    this.canvas = document.getElementById("annotation-canvas");
    this.ctx    = this.canvas.getContext("2d");

    // State
    this.zoom   = 1;
    this.panX   = 0;
    this.panY   = 0;
    this.mode   = "browse";   // browse | body | scar | keypoint | bbox | track_seed | track_point | roi
    this.baseImage = null;    // ImageBitmap of the current frame, as recorded
    this.frameB64  = null;    // raw base64 of displayed frame
    this.brightness = 1;      // display-only, see setEnhancement()
    this.contrast   = 1;
    // The picture on screen is not always the resolution the marks live in: the
    // clip strip serves a 640-wide proxy while the annotated frame is 1920. These
    // two say which frame the marks belong to, and at what size.
    this.annotWidth = null;   // image width the marks are expressed in
    this.looking    = false;  // showing a frame that is NOT the annotated one

    // Annotations
    this.bodyMask   = null;   // ImageData mask
    this.bodyBbox   = null;   // {x,y,w,h}
    this.scars      = [];     // [{mask, bbox, ...scar data}]
    this.keypoints  = {};     // {name: {x,y,visible}}
    this.kpIndex    = 0;
    this.observations = [];   // [{label, bbox}]

    // History for undo
    this._history = [];
    this._MAX_HIST = 50;

    // Bbox drawing state
    this._bboxDraw  = null;   // {startX, startY, endX, endY}
    this._mouseImgPos = null; // {x, y} in image coords for crosshair guide
    this._isPanning = false;
    this._lastMouse = {x:0, y:0};

    // Skeleton state
    this._skeletonPhase = null;   // null | "anchor1" | "anchor2" | "adjust"
    this._skeletonDrag  = null;   // {type:"point",name} | {type:"whole",lastX,lastY}

    // Polish 6 — ghost overlays for already-tracked scars at the current frame.
    // Tracks.js binds the toggle in tracks-panel which writes back here.
    this.showTrackOverlays = true;

    // Stream D — ROI marks overlay. roi.js populates this with {id, frame_number, bbox, note}
    // for the current video; drawn in the render loop (frame-scoped when frame_number is set).
    this.roiOverlays = [];

    this._resize();
    this._bindEvents();
    this._startRenderLoop();
  }

  // ──────────── Public API ────────────────────────────────────────

  setMode(mode) {
    this.mode = mode;
    this.canvas.style.cursor = mode === "browse" ? "grab" : "crosshair";
  }

  cancelBbox() {
    this._bboxDraw = null;
  }

  /** Swap the displayed image.
   *
   *  preserveView keeps the labeler's zoom and pan - but "the same view" is not
   *  "the same transform" when the new image is a different SIZE. The clip scrub
   *  proxy is 640px wide, a context strip 800-960, the pinned frame the camera's
   *  native 4K. screen = imgPx * zoom + pan, so carrying the transform across that
   *  swap redraws the animal six times larger, which reads as the canvas resizing
   *  itself every time you settle on a frame. Rescaling zoom by the width ratio
   *  holds every normalised point at the same screen position, which is what
   *  preserving a view actually means.
   */
  setFrame(b64, preserveView = false) {
    this.frameB64 = b64;
    const img = new Image();
    img.onload = () => {
      createImageBitmap(img).then(bm => {
        // Read the outgoing width at swap time, not at call time: two frames can
        // be in flight during a scrub, and the stale one would compensate twice.
        const prevW = this.baseImage ? this.baseImage.width : 0;
        this.baseImage = bm;
        if (!preserveView) this._fitToCanvas();
        else if (prevW && bm.width && bm.width !== prevW) this.zoom *= prevW / bm.width;
        // A mark drawn on the 640 proxy is stored in 640 space; when the 1920
        // rendition of the SAME frame arrives it has to come with it, or the box
        // saves at a third of its size against a frame it no longer matches.
        // Compared against annotWidth, not the outgoing image, so a detour through
        // other frames while looking cannot compound.
        if (!this.looking) {
          if (this.annotWidth && bm.width !== this.annotWidth && this.hasMarks()) {
            this._rescaleMarks(bm.width / this.annotWidth);
          }
          this.annotWidth = bm.width;
        }
      });
    };
    img.src = "data:image/jpeg;base64," + b64;
  }

  /** Move every mark into a new pixel space. Geometry only: a mask can only exist
   *  once SAM2 has run on the full-resolution frame, by which point annotWidth is
   *  already that frame's, so this path never has one to carry. */
  _rescaleMarks(k) {
    if (!(k > 0) || k === 1) return;
    const box = (b) => { if (!b) return; b.x *= k; b.y *= k;
      if (b.width  != null) b.width  *= k; if (b.height != null) b.height *= k;
      if (b.w != null) b.w *= k; if (b.h != null) b.h *= k; };
    box(this.bodyBbox);
    (this.scars || []).forEach(sc => box(sc.bbox));
    (this.observations || []).forEach(o => box(o.bbox));
    for (const pt of Object.values(this.keypoints || {})) {
      if (pt.x != null) pt.x *= k;
      if (pt.y != null) pt.y *= k;
    }
  }

  /** Is there anything of the labeler's on this frame?
   *
   *  Asked by the clip strip before it re-pins: an empty frame is a frame you are
   *  still choosing, a marked one is a frame you have chosen. */
  hasMarks() {
    return !!(this.bodyBbox || this.bodyMask
      || (this.scars && this.scars.length)
      || (this.observations && this.observations.length)
      || Object.keys(this.keypoints || {}).length
      || this._bboxDraw);
  }

  /** Brightness and contrast, as multipliers, applied when the frame is drawn.
   *
   *  Deliberately NOT baked into the image: the labeler is changing how they SEE
   *  the frame, and the bytes that get saved, segmented and scored have to stay
   *  the frame the camera recorded. Applying it at draw time also means it works
   *  on whatever is on the canvas - a clip proxy frame as much as a pinned one. */
  setEnhancement(brightness, contrast) {
    this.brightness = brightness;
    this.contrast   = contrast;
  }

  _imageFilter() {
    return (this.brightness === 1 && this.contrast === 1)
      ? "" : `brightness(${this.brightness}) contrast(${this.contrast})`;
  }

  setBodyMask(maskB64) {
    if (!maskB64) { this.bodyMask = null; return; }
    this._pushHistory();
    const img = new Image();
    img.onload = () => {
      const tmp = document.createElement("canvas");
      tmp.width  = img.width;
      tmp.height = img.height;
      const tc = tmp.getContext("2d");
      tc.drawImage(img, 0, 0);
      this.bodyMask = tc.getImageData(0, 0, img.width, img.height);
    };
    img.src = "data:image/png;base64," + maskB64;
  }

  setBodyBbox(bbox) {
    this.bodyBbox = bbox;
    this._updateKpList();  // refresh bbox status badge
  }

  addScar(data) {
    this._pushHistory();
    // Convert maskB64 to ImageData for rendering
    if (data.maskB64 && !data.mask) {
      const img = new Image();
      img.onload = () => {
        const tmp = document.createElement("canvas");
        tmp.width = img.width; tmp.height = img.height;
        const tc = tmp.getContext("2d");
        tc.drawImage(img, 0, 0);
        data.mask = tc.getImageData(0, 0, img.width, img.height);
      };
      img.src = "data:image/png;base64," + data.maskB64;
    }
    this.scars.push(data);
    this._updateScarsList();
  }

  /** Remove one scar. No confirm() — deliberately.
   *
   *  A single mis-drawn box is not worth a modal, and this modal was worse than
   *  useless: the browser's "prevent this page from creating additional dialogs"
   *  checkbox makes confirm() return false FOREVER, so once a labeler ticks it on
   *  any dialog this page shows, every ✕ silently no-ops for the rest of the
   *  session. Nothing throws and nothing logs — verified in a live browser, where a
   *  programmatic click on the same binding removed the scar correctly. The undo
   *  history is already 50 deep (_MAX_HIST) and _pushHistory runs below, so the
   *  removal is reversible; say so instead of asking. The replacement must NOT be
   *  another blocking dialog — that reintroduces the same failure mode.
   */
  removeScar(id) {
    const kept = this.scars.filter(s => s.id !== id);
    // Already gone (double-click, stale list): don't burn an undo slot rewriting
    // the same state, and don't tell the labeler something was removed.
    if (kept.length === this.scars.length) return;
    this._pushHistory();
    this.scars = kept;
    this._updateScarsList();
    // Without this the deletion is invisible to auto-save and to the beforeunload
    // guard, so removing the only thing you changed on a frame is never persisted.
    window.appState?._markDirty?.();
    window.appState?._setStatus?.("Scar removed \u2014 press Z (\u21a9 Undo) to put it back");
  }

  placeKeypoint(name, x, y, v = 2) {
    this._pushHistory();
    const canvasXY = this._screenToImage(x, y);
    this.keypoints[name] = { x: canvasXY.x, y: canvasXY.y, v: v };
    this._advanceToNextUnplaced();
    this._updateKpList();
    if (window.appState) window.appState._markDirty();
  }

  skipKeypoint() {
    if (this.kpIndex < KEYPOINT_SEQUENCE.length) {
      this._pushHistory();
      const name = KEYPOINT_SEQUENCE[this.kpIndex];
      this.keypoints[name] = { x: 0, y: 0, v: 0 };
      this._advanceToNextUnplaced();
      this._updateKpList();
      if (window.appState) window.appState._markDirty();
    }
  }

  markCurrentOccluded() {
    if (this.kpIndex < KEYPOINT_SEQUENCE.length) {
      this._pushHistory();
      const name = KEYPOINT_SEQUENCE[this.kpIndex];
      const existing = this.keypoints[name];
      if (existing && existing.v === 2) {
        // Already placed — toggle to occluded, keep position
        existing.v = 1;
      } else {
        // Not placed — mark as outside frame (v=0); occluded needs a position
        this.keypoints[name] = { x: 0, y: 0, v: 0 };
      }
      this._advanceToNextUnplaced();
      this._updateKpList();
    }
  }

  // ──────────── Skeleton placement ──────────────────────────────

  startSkeleton() {
    this._skeletonPhase = "anchor1";
    this.keypoints = {};
    this.kpIndex = 0;
    this._updateKpList();
  }

  _generateSkeleton(snout, caudal, side) {
    // Compute axis from snout to caudal
    const dx = caudal.x - snout.x;
    const dy = caudal.y - snout.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    // Use left template; mirror for right side
    const tpl = {};
    for (const [name, pt] of Object.entries(SKELETON_TEMPLATE_LEFT)) {
      const tx = side === "Right" ? (1.0 - pt.x) : pt.x;
      tpl[name] = { x: tx, y: pt.y };
    }

    // Template snout and caudal
    const tSnout = tpl["snout_tip"];
    const tCaudal = tpl["caudal_notch"];
    const tDx = tCaudal.x - tSnout.x;
    const tDy = tCaudal.y - tSnout.y;
    const tLen = Math.sqrt(tDx * tDx + tDy * tDy);
    const scale = length / tLen;

    // Center the template on snout, then rotate and scale
    this._pushHistory();
    for (const [name, pt] of Object.entries(tpl)) {
      // Offset relative to template snout
      const rx = pt.x - tSnout.x;
      const ry = pt.y - tSnout.y;
      // Scale
      const sx = rx * scale;
      const sy = ry * scale;
      // Rotate
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const fx = sx * cos - sy * sin + snout.x;
      const fy = sx * sin + sy * cos + snout.y;
      this.keypoints[name] = { x: fx, y: fy, v: 2 };
    }
    this._skeletonPhase = "adjust";
    this.kpIndex = KEYPOINT_SEQUENCE.length; // all placed
    this._updateKpList();
  }

  setKpVisibility(name, v) {
    const kp = this.keypoints[name];
    if (!kp) return;
    this._pushHistory();
    const oldV = kp.v;
    kp.v = v;
    // Moving to "outside frame" — clear coordinates
    if (v === 0) {
      kp.x = 0;
      kp.y = 0;
    }
    // Moving FROM "outside frame" to visible/occluded — let user re-place it
    if (oldV === 0 && (v === 1 || v === 2)) {
      const idx = KEYPOINT_SEQUENCE.indexOf(name);
      if (idx !== -1) {
        delete this.keypoints[name];
        this.kpIndex = idx;
        this.mode = "keypoint";
        this.canvas.style.cursor = "crosshair";
      }
    }
    this._updateKpList();
    if (window.appState) window.appState._markDirty();
  }

  selectKeypoint(index) {
    if (index >= 0 && index < KEYPOINT_SEQUENCE.length) {
      this.kpIndex = index;
      this.mode = "keypoint";
      this.canvas.style.cursor = "crosshair";
      this._updateKpList();
    }
  }

  _advanceToNextUnplaced() {
    // Find next unplaced keypoint after current
    for (let i = this.kpIndex + 1; i < KEYPOINT_SEQUENCE.length; i++) {
      if (!this.keypoints[KEYPOINT_SEQUENCE[i]]) { this.kpIndex = i; return; }
    }
    // Wrap around
    for (let i = 0; i < KEYPOINT_SEQUENCE.length; i++) {
      if (!this.keypoints[KEYPOINT_SEQUENCE[i]]) { this.kpIndex = i; return; }
    }
    // All placed
    this.kpIndex = KEYPOINT_SEQUENCE.length;
  }

  resetKeypoints() {
    this._pushHistory();
    this.keypoints = {};
    this.kpIndex = 0;
    this._skeletonPhase = null;
    this._skeletonDrag = null;
    this._updateKpList();
  }

  /** Declare "the rest of the animal is not in frame": every keypoint the
   *  annotator has not placed becomes v=0 (outside frame, no position).
   *
   *  v=0 and NOT v=1, per the rule markCurrentOccluded states directly: occluded
   *  needs a position, so a point nobody has located cannot be occluded — it is
   *  outside the frame. Writing v=1 at (0,0) instead used to stack every such
   *  point in the image's top-left corner with skeleton edges trailing to it,
   *  and exported a fabricated coordinate as though a human had placed it.
   *
   *  Points already marked v=0 are left alone rather than rewritten, so an
   *  explicit "outside frame" (X / Tab) survives this. */
  markRemainingOccluded() {
    this._pushHistory();
    for (const name of KEYPOINT_SEQUENCE) {
      if (!this.keypoints[name]) {
        this.keypoints[name] = { x: 0, y: 0, v: 0 };
      }
    }
    this.kpIndex = KEYPOINT_SEQUENCE.length;
    this._updateKpList();
    this._draw();
    if (window.appState) window.appState._markDirty();
  }

  addObservation(label, bbox) {
    this._pushHistory();
    const obs = { id: "obs_" + Date.now(), label, bbox };
    this.observations.push(obs);
    return obs;
  }

  resetAll() {
    this._pushHistory();
    this.bodyMask = null; this.bodyBbox = null;
    this.scars = []; this.keypoints = {}; this.kpIndex = 0;
    this.observations = [];
    this._skeletonPhase = null; this._skeletonDrag = null;
    this._updateScarsList();
    this._updateKpList();
  }

  restoreAnnotation(data) {
    this.resetAll();
    if (data.body_bbox) this.bodyBbox = data.body_bbox;
    if (data.keypoints && Array.isArray(data.keypoints)) {
      // Migrate old keypoint names
      const RENAME = { front_dorsal_base: "dorsal_base_front", front_dorsal_tip: "dorsal_fin_tip",
                        first_dorsal_base: "dorsal_base_front", first_dorsal_tip: "dorsal_fin_tip",
                        back_dorsal_base: "dorsal_base_back", back_dorsal_tip: "second_dorsal_tip" };
      for (const kp of data.keypoints) {
        const name = RENAME[kp.name] || kp.name;
        if (name) this.keypoints[name] = { x: kp.x, y: kp.y, v: kp.v };
      }
      // Advance kpIndex past already-placed keypoints
      this.kpIndex = KEYPOINT_SEQUENCE.length;
      for (let i = 0; i < KEYPOINT_SEQUENCE.length; i++) {
        if (!this.keypoints[KEYPOINT_SEQUENCE[i]]) { this.kpIndex = i; break; }
      }
    }
    if (data.scars && Array.isArray(data.scars)) {
      for (const s of data.scars) {
        if (s.maskB64 && !s.mask) {
          const img = new Image();
          img.onload = () => {
            const tmp = document.createElement("canvas");
            tmp.width = img.width; tmp.height = img.height;
            const tc = tmp.getContext("2d");
            tc.drawImage(img, 0, 0);
            s.mask = tc.getImageData(0, 0, img.width, img.height);
          };
          img.src = "data:image/png;base64," + s.maskB64;
        }
        this.scars.push(s);
      }
    }
    if (data.custom_observations) this.observations = data.custom_observations;
    this._updateScarsList();
    this._updateKpList();
  }

  undo() {
    const entry = this._history.pop();
    if (!entry) return;
    Object.assign(this, JSON.parse(entry.json));
    this.bodyMask = entry.bodyMask;
    this._updateScarsList();
    this._updateKpList();
  }

  zoom_in()  { this._zoomToCenter(1.2); }
  zoom_out() { this._zoomToCenter(1 / 1.2); }

  _zoomToCenter(factor) {
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    this.panX = cx - (cx - this.panX) * factor;
    this.panY = cy - (cy - this.panY) * factor;
    this.zoom = Math.max(0.1, Math.min(10, this.zoom * factor));
  }
  zoom_reset() { this._fitToCanvas(); }

  getAnnotationData() {
    const kpArr = Object.entries(this.keypoints).map(([name, pt]) => ({ name, x: pt.x, y: pt.y, v: pt.v }));
    return {
      body_bbox: this.bodyBbox,
      keypoints: kpArr,
      scars: this.scars.map(s => ({
        id: s.id, scar_type: s.scar_type, zone: s.zone, side: s.side,
        confidence: s.confidence, color: s.color, color_other: s.color_other,
        notes: s.notes,
        // No copepods keys: that is an encounter-level observation and is no longer
        // asked per scar. A historical scar that carries them keeps them in the row
        // already written; this allow-list only governs what is sent from now on.
        multiple_scars: s.multiple_scars, annotator: s.annotator,
        bbox: s.bbox, maskB64: s.maskB64,
      })),
      custom_observations: this.observations,
    };
  }

  // ──────────── Rendering ─────────────────────────────────────────

  _startRenderLoop() {
    const render = () => {
      this._draw();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }

  _draw() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // Base image
    if (this.baseImage) {
      const filter = this._imageFilter();
      // The filter is for the photograph only. Boxes, keypoints and masks are the
      // labeler's own marks and must not shift colour with a slider.
      if (filter) ctx.filter = filter;
      ctx.drawImage(this.baseImage, 0, 0);
      if (filter) ctx.filter = "none";
    } else {
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, W / this.zoom, H / this.zoom);
      ctx.fillStyle = "#444";
      ctx.font = "16px sans-serif";
      ctx.fillText("Load a video to annotate", 20, 40);
    }

    // The marks live in the ANNOTATED frame's pixel space, and the picture on screen
    // may be a 640-wide proxy while that frame is 1920 — so the overlay is scaled to
    // whatever rendition is showing. Not hidden: watching the mark hold position
    // under the box while the clip plays is the entire reason to press play, and an
    // unscaled 1920-space box over a 640 proxy is three times too large and off the
    // picture. zoom is folded in as well, because every stroke width below is written
    // as N/zoom and would otherwise thin out the moment the proxy appears.
    const _rend = this._renditionScale();
    const _zoom0 = this.zoom;
    if (_rend !== 1) { ctx.scale(_rend, _rend); this.zoom *= _rend; }

    // Body mask
    if (this.bodyMask && this.baseImage) {
      this._drawMask(ctx, this.bodyMask, "rgba(74,144,217,0.25)", "rgba(74,144,217,0.8)");
    }

    // Body bbox — outline only in keypoint mode for unobstructed placement
    if (this.bodyBbox) {
      const bboxFill = this.mode === "keypoint" ? "rgba(0,0,0,0)" : COLORS.bbox;
      this._drawBbox(ctx, this.bodyBbox, COLORS.bboxStroke, bboxFill, null);
    }

    // Scar masks (bbox hidden after logging — data preserved in this.scars for save)
    for (const s of this.scars) {
      if (s.mask) this._drawMask(ctx, s.mask, COLORS.scar, COLORS.scarStroke);
    }

    // Custom observations
    for (const obs of this.observations) {
      if (obs.bbox) this._drawBbox(ctx, obs.bbox, COLORS.obsStroke, COLORS.obs, obs.label);
    }

    // Polish 6 — ghost overlays for already-tracked scars at this frame.
    // Skips when toggled off, no cache yet, or no current frame number.
    // O(1) lookup per render tick: byFrame Map keyed by integer frame number.
    // Wrapped in globalAlpha=0.45 so the label banner (which _drawBbox renders
    // at full opacity using stroke color) fades to ghost-style.
    if (this.showTrackOverlays !== false && this.baseImage
        && window.appState?.canvasOverlays && window.videoPlayer) {
      const fn = this._realCurrentFrame();
      const here = (fn != null) ? (window.appState.canvasOverlays.byFrame.get(fn) || []) : [];
      if (here.length) {
        ctx.save();
        for (const o of here) {
          // Phase 2 UX #3 — the track currently open in the sidebar editor
          // (activeTrackId, set by tracks.js) renders bright + opaque so it
          // stands out from the ghosted others; everything else stays at 0.45.
          const isActive = (this.activeTrackId != null && o.track_id === this.activeTrackId);
          ctx.globalAlpha = isActive ? 1.0 : 0.45;
          const stroke = isActive ? "#55ccff" : (TRACK_OVERLAY_COLORS[o.status] || TRACK_OVERLAY_COLORS.default);
          const fill = stroke + (isActive ? "33" : "11");  // ~7% alpha; globalAlpha further halves it
          const label = `#${o.track_id}${o.scar_type ? ' · ' + o.scar_type : ''}`;
          this._drawBbox(ctx, o.bbox, stroke, fill, label);
        }
        ctx.restore();
      }
    }

    // Stream D — ROI marks overlay. Frame-scoped when a mark has a frame_number
    // (only shown on its own frame); marks without one show on every frame.
    if (this.roiOverlays && this.roiOverlays.length && this.baseImage) {
      const fn = this._realCurrentFrame();
      ctx.save();
      for (const r of this.roiOverlays) {
        if (!r.bbox) continue;
        if (r.frame_number != null && fn != null && r.frame_number !== fn) continue;
        const label = `ROI #${r.id}${r.note ? ' · ' + r.note : ''}`;
        this._drawBbox(ctx, r.bbox, COLORS.roiStroke, COLORS.roi, label);
      }
      ctx.restore();
    }

    // Skeleton edges (drawn before keypoints so dots appear on top)
    if (Object.keys(this.keypoints).length > 1) {
      ctx.save();
      for (const [a, b] of SKELETON_EDGES) {
        const ptA = this.keypoints[a];
        const ptB = this.keypoints[b];
        if (ptA && ptB && ptA.v > 0 && ptB.v > 0) {
          ctx.beginPath();
          ctx.moveTo(ptA.x, ptA.y);
          ctx.lineTo(ptB.x, ptB.y);
          ctx.strokeStyle = "rgba(255,255,255,0.4)";
          ctx.lineWidth = 1.5 / this.zoom;
          if (ptA.v === 1 || ptB.v === 1) {
            ctx.setLineDash([4 / this.zoom]);
          } else {
            ctx.setLineDash([]);
          }
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Keypoints — target-style: center dot + outer ring
    for (const [name, pt] of Object.entries(this.keypoints)) {
      if (pt.v === 0) continue;
      const isCurrent = KEYPOINT_SEQUENCE[this.kpIndex] === name;
      const isOcc = pt.v === 1;
      const baseColor = isOcc ? "#f59e0b" : (isCurrent ? COLORS.kpCurrent : COLORS.kp);
      const outerR = 8 / this.zoom;
      const innerR = 1.5 / this.zoom;
      const lineW = 1.5 / this.zoom;

      // Outer ring
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, outerR, 0, Math.PI * 2);
      ctx.strokeStyle = baseColor;
      ctx.lineWidth = lineW;
      if (isOcc) ctx.setLineDash([3 / this.zoom]);
      ctx.stroke();
      if (isOcc) ctx.setLineDash([]);

      // Center dot
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, innerR, 0, Math.PI * 2);
      ctx.fillStyle = baseColor;
      ctx.fill();

      // Label
      ctx.fillStyle = isOcc ? "#f59e0b" : "#fff";
      ctx.font = `${10 / this.zoom}px sans-serif`;
      const lbl = name.replace(/_/g, " ") + (isOcc ? " (occ)" : "");
      ctx.fillText(lbl, pt.x + outerR + 3 / this.zoom, pt.y - 4 / this.zoom);
    }

    // Current keypoint / skeleton prompt
    if (this.mode === "keypoint") {
      ctx.fillStyle = COLORS.kpCurrent;
      ctx.font = `bold ${13 / this.zoom}px sans-serif`;
      if (this._skeletonPhase === "anchor1") {
        ctx.fillText("Click SNOUT TIP to start skeleton", 10 / this.zoom, 22 / this.zoom);
      } else if (this._skeletonPhase === "anchor2") {
        ctx.fillText("Click CAUDAL NOTCH to place skeleton", 10 / this.zoom, 22 / this.zoom);
      } else if (this._skeletonPhase === "adjust") {
        ctx.fillText("Drag points to adjust. Shift+drag moves all.", 10 / this.zoom, 22 / this.zoom);
      } else if (this.kpIndex < KEYPOINT_SEQUENCE.length) {
        const name = KEYPOINT_SEQUENCE[this.kpIndex];
        ctx.fillText(`Click: ${name.replace(/_/g, " ")}  (Alt = occluded)`, 10 / this.zoom, 22 / this.zoom);
      }
    }

    // Crosshair guide lines in bbox/scar mode
    if (this._mouseImgPos && (this.mode === "bbox" || this.mode === "scar" || this.mode === "track_seed" || this.mode === "roi")) {
      const imgW = this.baseImage ? this.baseImage.width : this.canvas.width;
      const imgH = this.baseImage ? this.baseImage.height : this.canvas.height;
      ctx.strokeStyle = "rgba(231, 76, 60, 0.5)";
      ctx.lineWidth = 1 / this.zoom;
      ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
      ctx.beginPath();
      ctx.moveTo(this._mouseImgPos.x, 0);    ctx.lineTo(this._mouseImgPos.x, imgH);
      ctx.moveTo(0, this._mouseImgPos.y);    ctx.lineTo(imgW, this._mouseImgPos.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Bbox drawing in progress
    if (this._bboxDraw && (this.mode === "bbox" || this.mode === "scar" || this.mode === "track_seed" || this.mode === "roi")) {
      const { sx, sy, ex, ey } = this._bboxDraw;
      const w = ex - sx, h = ey - sy;
      ctx.strokeStyle = this.mode === "roi" ? COLORS.roiStroke
        : (this.mode === "scar" || this.mode === "track_seed") ? COLORS.scarStroke : COLORS.obsStroke;
      ctx.lineWidth = 2 / this.zoom;
      ctx.setLineDash([4 / this.zoom]);
      ctx.strokeRect(sx, sy, w, h);
      ctx.setLineDash([]);
    }

    this.zoom = _zoom0;          // restored exactly, never by dividing back
    ctx.restore();
  }

  /** How much bigger the picture on screen is than the space the marks are in. 1
   *  whenever the annotated frame is the one being shown, which is most of the time. */
  _renditionScale() {
    return (this.baseImage && this.annotWidth)
      ? this.baseImage.width / this.annotWidth : 1;
  }

  _drawMask(ctx, maskData, fillColor, strokeColor) {
    // maskData is ImageData (white = masked)
    const tmp = document.createElement("canvas");
    tmp.width  = maskData.width;
    tmp.height = maskData.height;
    const tc = tmp.getContext("2d");
    tc.putImageData(maskData, 0, 0);

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = fillColor;

    // Draw mask as tinted overlay
    const scaleX = this.baseImage ? this.baseImage.width  / maskData.width  : 1;
    const scaleY = this.baseImage ? this.baseImage.height / maskData.height : 1;
    ctx.drawImage(tmp, 0, 0,
      this.baseImage ? this.baseImage.width  : maskData.width,
      this.baseImage ? this.baseImage.height : maskData.height);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  _drawBbox(ctx, bbox, stroke, fill, label) {
    const { x, y, width: w, height: h } = bbox;
    ctx.fillStyle   = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth   = 2 / this.zoom;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    if (label) {
      const fs = 11 / this.zoom;
      ctx.font = `bold ${fs}px sans-serif`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = stroke;
      ctx.fillRect(x, y - fs * 1.4, tw + 8 / this.zoom, fs * 1.4);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + 4 / this.zoom, y - 3 / this.zoom);
    }
  }

  // ──────────── Coordinate Transforms ─────────────────────────────

  _screenToImage(sx, sy) {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
    };
  }

  /** Polish 6 — true frame number using the video's REAL fps (read by cv2 on
   * the server and shipped down with the overlay payload). HTML5 video falls
   * back to 30fps for fps detection on most browsers, which is wrong for
   * 59.94fps source video — using that estimate here would mismatch the
   * tracker-stored frame indices and paint bboxes at the wrong frame. */
  _realCurrentFrame() {
    const vp = window.videoPlayer;
    if (!vp || vp.mediaType === "image") return 0;

    // Ask whatever is actually PAINTING the canvas, in the same order
    // tracks.js::_resolveSeedFrame does. This used to read the <video> element
    // only — but on queue work the canvas is fed by the cached frame strip and
    // the element never decodes (every 4K clip here is HEVC, which the browser
    // refuses), so currentTime sat at ~0 and this answered ~0 no matter which
    // frame was on screen. Every consumer of it then looked up frame 0:
    // scrubbing the strip left the propagated track's boxes frozen in place,
    // which is exactly how it was reported — "the canvas stays static".
    //
    // Same root cause as the propagation seed bug, in a second place. Worth
    // stating plainly: the <video> element is NOT the source of truth for which
    // frame the labeler is looking at, and anything that assumes it is will be
    // silently wrong on the queue path.
    const fc = window.FrameContext;
    if (fc?.isActive?.()) {
      const shown = fc.frames?.[fc.i]?.n;
      if (shown != null) return shown;      // follow the strip as it scrubs
      if (fc.pinned != null) return fc.pinned;
    }
    const pinned = window.appState?._pinnedFrame;
    if (pinned != null) return pinned;

    const v = vp.video;
    if (!v || !v.duration) return null;
    const realFps = window.appState?.canvasOverlays?.realFps;
    if (realFps && realFps > 0) {
      return Math.round(v.currentTime * realFps);
    }
    // Fallback: trust the player's estimate. Cache may not have populated yet.
    return vp.currentFrame();
  }

  _imageToScreen(ix, iy) {
    return {
      x: ix * this.zoom + this.panX,
      y: iy * this.zoom + this.panY,
    };
  }

  _fitToCanvas() {
    if (!this.baseImage) return;
    const { width: W, height: H } = this.canvas;
    const scaleX = W / this.baseImage.width;
    const scaleY = H / this.baseImage.height;
    this.zoom = Math.min(scaleX, scaleY);
    this.panX = (W - this.baseImage.width  * this.zoom) / 2;
    this.panY = (H - this.baseImage.height * this.zoom) / 2;
  }

  // ──────────── Events ─────────────────────────────────────────────

  _bindEvents() {
    const cvs = this.canvas;

    // Resize
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.wrap);

    // Polish 7 Tier 2 — touch gestures: one-finger pan in browse mode,
    // two-finger pinch to zoom (always). Bbox draw-on-touch is gated to
    // ≥768px viewports because precise pixel placement is impractical
    // on phone-sized screens.
    let _touchPanLast = null;          // {x, y} last single-finger position
    let _touchPinchStart = null;        // {dist, midX, midY, zoom, panX, panY}
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const midpoint = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

    cvs.addEventListener("touchstart", e => {
      if (e.touches.length === 2) {
        const rect = cvs.getBoundingClientRect();
        const m = midpoint(e.touches[0], e.touches[1]);
        _touchPinchStart = {
          dist: dist(e.touches[0], e.touches[1]),
          midX: m.x - rect.left,
          midY: m.y - rect.top,
          zoom: this.zoom,
          panX: this.panX,
          panY: this.panY,
        };
        _touchPanLast = null;
        e.preventDefault();
      } else if (e.touches.length === 1 && this.mode === "browse") {
        _touchPanLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        _touchPinchStart = null;
      }
    }, { passive: false });

    cvs.addEventListener("touchmove", e => {
      if (e.touches.length === 2 && _touchPinchStart) {
        const newDist = dist(e.touches[0], e.touches[1]);
        const factor = newDist / _touchPinchStart.dist;
        // Zoom around the original midpoint (not the moving one — feels more stable)
        const mx = _touchPinchStart.midX, my = _touchPinchStart.midY;
        const newZoom = Math.max(0.1, Math.min(20, _touchPinchStart.zoom * factor));
        const realFactor = newZoom / _touchPinchStart.zoom;
        this.zoom = newZoom;
        this.panX = mx - (mx - _touchPinchStart.panX) * realFactor;
        this.panY = my - (my - _touchPinchStart.panY) * realFactor;
        e.preventDefault();
      } else if (e.touches.length === 1 && _touchPanLast && this.mode === "browse") {
        const t = e.touches[0];
        const dx = t.clientX - _touchPanLast.x;
        const dy = t.clientY - _touchPanLast.y;
        this.panX += dx;
        this.panY += dy;
        _touchPanLast = { x: t.clientX, y: t.clientY };
        e.preventDefault();
      }
    }, { passive: false });

    const endTouch = () => { _touchPanLast = null; _touchPinchStart = null; };
    cvs.addEventListener("touchend", endTouch);
    cvs.addEventListener("touchcancel", endTouch);

    // Mouse wheel zoom
    cvs.addEventListener("wheel", e => {
      e.preventDefault();
      const rect = cvs.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Scale zoom by deltaY magnitude — trackpads send small values (~1-3),
      // mice send large values (~100). Normalize deltaMode (line vs pixel).
      let absDelta = Math.abs(e.deltaY);
      if (e.deltaMode === 1) absDelta *= 30; // line mode → approx pixels
      absDelta = Math.min(absDelta, 150);
      const base = 1 + Math.min(absDelta * 0.001, 0.15);
      const factor = e.deltaY < 0 ? base : 1 / base;
      this.panX = mx - (mx - this.panX) * factor;
      this.panY = my - (my - this.panY) * factor;
      this.zoom *= factor;
      this.zoom = Math.max(0.1, Math.min(20, this.zoom));
    }, { passive: false });

    // Mouse down
    cvs.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      const { x, y } = this._canvasXY(e);

      // A mark belongs to a frame, and a moving picture is not a frame. The instant
      // the labeler starts drawing, the clip strip stops and the frame on screen
      // becomes the annotated one — BEFORE the mark exists, so the annotation set
      // is swapped in first and the box lands in the right place. Without this a
      // box drawn while the strip was playing was filed against the frame the
      // labeler had left and wiped off the canvas when the strip settled.
      if (this.mode !== "browse") window.FrameContext?.claimFrameForDrawing?.();

      if (this.mode === "browse") {
        // Polish 6 — clicking inside a ghost overlay opens that track's modal.
        // Iterate in reverse so the topmost (last drawn) wins ties.
        if (this.showTrackOverlays !== false && window.appState?.canvasOverlays && window.videoPlayer) {
          const img = this._screenToImage(x, y);
          const fn = this._realCurrentFrame();
          const here = (fn != null) ? (window.appState.canvasOverlays.byFrame.get(fn) || []) : [];
          for (let i = here.length - 1; i >= 0; i--) {
            const o = here[i];
            const b = o.bbox;
            if (img.x >= b.x && img.x <= b.x + b.width &&
                img.y >= b.y && img.y <= b.y + b.height) {
              window.Tracks?._loadAndShowResult(o.track_id);
              return;
            }
          }
        }
        this._isPanning = true;
        this._lastMouse = { x: e.clientX, y: e.clientY };
        cvs.style.cursor = "grabbing";
        return;
      }

      // Drag keypoints: works in skeleton adjust mode AND normal keypoint mode
      if (this.mode === "keypoint" && (this._skeletonPhase === "adjust" || this._skeletonPhase === null)) {
        const img = this._screenToImage(x, y);
        const hitR = 12 / this.zoom;
        let hitName = null;
        for (const [name, pt] of Object.entries(this.keypoints)) {
          if (pt.v > 0) {
            const d = Math.sqrt((pt.x - img.x) ** 2 + (pt.y - img.y) ** 2);
            if (d < hitR) { hitName = name; break; }
          }
        }
        if (hitName) {
          this._skeletonDrag = { type: "point", name: hitName };
          cvs.style.cursor = "move";
          return;
        } else if (e.shiftKey) {
          this._skeletonDrag = { type: "whole", lastX: img.x, lastY: img.y };
          cvs.style.cursor = "move";
          return;
        }
      }

      if (this.mode === "bbox" || this.mode === "scar" || this.mode === "track_seed" || this.mode === "roi") {
        const img = this._screenToImage(x, y);
        this._bboxDraw = { sx: img.x, sy: img.y, ex: img.x, ey: img.y };
        return;
      }
    });

    // Mouse move
    cvs.addEventListener("mousemove", e => {
      const { x, y } = this._canvasXY(e);

      if (this._isPanning) {
        this.panX += e.clientX - this._lastMouse.x;
        this.panY += e.clientY - this._lastMouse.y;
        this._lastMouse = { x: e.clientX, y: e.clientY };
        return;
      }

      // Skeleton drag
      if (this._skeletonDrag && this.mode === "keypoint") {
        const img = this._screenToImage(x, y);
        if (this._skeletonDrag.type === "point") {
          const pt = this.keypoints[this._skeletonDrag.name];
          if (pt) { pt.x = img.x; pt.y = img.y; }
        } else if (this._skeletonDrag.type === "whole") {
          const dx = img.x - this._skeletonDrag.lastX;
          const dy = img.y - this._skeletonDrag.lastY;
          for (const pt of Object.values(this.keypoints)) {
            pt.x += dx; pt.y += dy;
          }
          this._skeletonDrag.lastX = img.x;
          this._skeletonDrag.lastY = img.y;
        }
        return;
      }

      if (this.mode === "bbox" || this.mode === "scar" || this.mode === "track_seed" || this.mode === "roi") {
        const img = this._screenToImage(x, y);
        this._mouseImgPos = { x: img.x, y: img.y };
        if (this._bboxDraw) {
          this._bboxDraw.ex = img.x;
          this._bboxDraw.ey = img.y;
        }
      } else {
        this._mouseImgPos = null;
      }
    });

    cvs.addEventListener("mouseleave", () => {
      this._mouseImgPos = null;
    });

    // Right-click: cycle keypoint visibility (visible → occluded → outside → visible)
    cvs.addEventListener("contextmenu", (e) => {
      if (this.mode !== "keypoint") return;
      e.preventDefault();
      const { x, y } = this._canvasXY(e);
      const img = this._screenToImage(x, y);
      const hitR = 12 / this.zoom;
      let closest = null, closestDist = Infinity;
      for (const [name, pt] of Object.entries(this.keypoints)) {
        if (!pt || pt.v === 0) continue;
        const d = Math.hypot(pt.x - img.x, pt.y - img.y);
        if (d < hitR && d < closestDist) { closest = name; closestDist = d; }
      }
      if (closest) {
        this._pushHistory();
        const pt = this.keypoints[closest];
        pt.v = pt.v === 2 ? 1 : pt.v === 1 ? 0 : 2;
        this._updateKpList();
      }
    });

    // Mouse up / click
    cvs.addEventListener("mouseup", e => {
      if (e.button !== 0) return;
      if (this._isPanning) {
        this._isPanning = false;
        cvs.style.cursor = this.mode === "browse" ? "grab" : "crosshair";
        return;
      }

      // End skeleton drag
      if (this._skeletonDrag) {
        this._skeletonDrag = null;
        cvs.style.cursor = "crosshair";
        this._updateKpList();
        if (window.appState) window.appState._markDirty();
        return;
      }

      const { x, y } = this._canvasXY(e);
      const img = this._screenToImage(x, y);

      if ((this.mode === "bbox" || this.mode === "scar" || this.mode === "track_seed" || this.mode === "roi") && this._bboxDraw) {
        const bd = this._bboxDraw;
        this._bboxDraw = null;
        const bw = Math.abs(bd.ex - bd.sx);
        const bh = Math.abs(bd.ey - bd.sy);
        if (bw > 10 && bh > 10) {
          const bbox = {
            x: Math.min(bd.sx, bd.ex), y: Math.min(bd.sy, bd.ey),
            width: bw, height: bh,
          };
          if (this.mode === "roi") {
            // Stream D — ROI-only mark: hand off to roi.js. NO scar form, NO propagation.
            // Stay in roi mode so the annotator can mark several regions in a row.
            if (window.ROI?.onBoxDrawn) {
              window.ROI.onBoxDrawn(bbox);
            } else {
              this.setMode("browse");
            }
          } else if (this.mode === "scar") {
            if (window.appState) window.appState.handleScarBbox(bbox);
          } else if (this.mode === "track_seed") {
            // Don't switch back to browse yet — Tracks will put us in track_point
            // mode to collect the confirming click. If Tracks isn't loaded, fall
            // back to browse.
            if (window.Tracks?.onSeedBboxDrawn) {
              window.Tracks.onSeedBboxDrawn(bbox);
            } else {
              this.setMode("browse");
            }
          } else {
            this._pushHistory();
            this.bodyBbox = bbox;
            this._updateKpList();
            // Auto-switch to keypoint mode — only one body bbox needed
            this.setMode("keypoint");
            if (window.appState) window.appState._activateTool("tool-keypoint");
          }
        }
        return;
      }

      if (this.mode === "keypoint") {
        // Skeleton anchor placement
        if (this._skeletonPhase === "anchor1") {
          this._pushHistory();
          this.keypoints["snout_tip"] = { x: img.x, y: img.y, v: 2 };
          this._skeletonPhase = "anchor2";
          this._updateKpList();
          if (window.appState) window.appState._markDirty();
          return;
        }
        if (this._skeletonPhase === "anchor2") {
          const snout = this.keypoints["snout_tip"];
          this._generateSkeleton(snout, { x: img.x, y: img.y }, "Left");
          if (window.appState) window.appState._markDirty();
          return;
        }
        // Fallback: individual keypoint placement (legacy mode)
        if (this._skeletonPhase !== "adjust" && this.kpIndex < KEYPOINT_SEQUENCE.length) {
          const name = KEYPOINT_SEQUENCE[this.kpIndex];
          const v = e.altKey ? 1 : 2;
          this.placeKeypoint(name, x, y, v);
        }
        return;
      }

      if (this.mode === "body") {
        // Dispatch to app.js for SAM call
        if (window.appState) window.appState.handleCanvasClick(img.x, img.y, this.mode);
        return;
      }

      if (this.mode === "track_point") {
        // One-click positive-point for SAM2 track refinement
        this.setMode("browse");
        if (window.Tracks?.onSeedPointClicked) {
          window.Tracks.onSeedPointClicked({ x: Math.round(img.x), y: Math.round(img.y) });
        }
        return;
      }
    });

    // Delegated click handler for keypoint list (V/O/X buttons + row select)
    const kpList = document.getElementById("kp-list");
    if (kpList) {
      kpList.addEventListener("click", e => {
        // Check for visibility toggle button first
        const visBtn = e.target.closest("[data-kp-vis]");
        if (visBtn) {
          e.stopPropagation();
          const name = visBtn.dataset.kpVis;
          const v = parseInt(visBtn.dataset.v, 10);
          this.setKpVisibility(name, v);
          return;
        }
        // Otherwise, check for row click (select keypoint)
        const row = e.target.closest("[data-kp-idx]");
        if (row) {
          this.selectKeypoint(parseInt(row.dataset.kpIdx, 10));
        }
      });
    }
  }

  _showBboxLabelPopup(screenX, screenY, bbox) {
    const popup = document.getElementById("bbox-label-popup");
    const input = document.getElementById("bbox-label-input");
    popup.style.left = `${screenX + 8}px`;
    popup.style.top  = `${screenY + 8}px`;
    popup.classList.remove("hidden");
    input.value = "";
    input.focus();

    const save = () => {
      const label = input.value.trim() || "observation";
      this.addObservation(label, bbox);
      popup.classList.add("hidden");
      input.removeEventListener("keydown", onKey);
    };

    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Escape") { popup.classList.add("hidden"); input.removeEventListener("keydown", onKey); }
    };

    input.addEventListener("keydown", onKey);
    // Also save on blur
    input.addEventListener("blur", () => setTimeout(() => { if (!popup.classList.contains("hidden")) save(); }, 200), { once: true });
  }

  _canvasXY(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _resize() {
    const oldW = this.canvas.width;
    const oldH = this.canvas.height;
    const rect = this.wrap.getBoundingClientRect();
    this.canvas.width  = rect.width  || 800;
    this.canvas.height = rect.height || 500;
    if (this.baseImage) {
      if (oldW && oldH && (this.panX !== 0 || this.panY !== 0 || this.zoom !== 1)) {
        // Keep whatever was in the middle in the middle, at the same magnification.
        // Scaling pan proportionally instead slid the image sideways every time a
        // bar appeared or disappeared under the canvas.
        const cx = (oldW / 2 - this.panX) / this.zoom;
        const cy = (oldH / 2 - this.panY) / this.zoom;
        this.panX = this.canvas.width  / 2 - cx * this.zoom;
        this.panY = this.canvas.height / 2 - cy * this.zoom;
      } else {
        this._fitToCanvas();
      }
    }
  }

  // ──────────── History ────────────────────────────────────────────

  _pushHistory() {
    const entry = {
      json: JSON.stringify({
        scars: this.scars, keypoints: this.keypoints,
        kpIndex: this.kpIndex, observations: this.observations,
        bodyBbox: this.bodyBbox, _skeletonPhase: this._skeletonPhase,
      }),
      // ImageData can't be JSON-serialized — clone it separately
      bodyMask: this.bodyMask
        ? new ImageData(new Uint8ClampedArray(this.bodyMask.data),
                        this.bodyMask.width, this.bodyMask.height)
        : null,
    };
    this._history.push(entry);
    if (this._history.length > this._MAX_HIST) this._history.shift();
  }

  // ──────────── DOM updates ────────────────────────────────────────

  _updateKpList() {
    const list = document.getElementById("kp-list");
    const prog = document.getElementById("kp-progress");
    const kpValues = Object.values(this.keypoints);
    const visible = kpValues.filter(k => k.v === 2).length;
    const occluded = kpValues.filter(k => k.v === 1).length;
    const skipped = kpValues.filter(k => k.v === 0).length;
    const placed = visible + occluded;
    prog.textContent = `${placed}/16`;

    list.innerHTML = KEYPOINT_SEQUENCE.map((name, i) => {
      const kp = this.keypoints[name];
      let cls, icon;
      if (kp) {
        if (kp.v === 2) { cls = "done"; icon = "✓"; }
        else if (kp.v === 1) { cls = "occluded"; icon = "⚠"; }
        else { cls = "skipped"; icon = "—"; }
      } else {
        cls = (i === this.kpIndex) ? "current" : "pending";
        icon = (i === this.kpIndex) ? "▶" : "○";
      }
      const toggles = kp ? `<span class="kp-vis-toggles">` +
        `<button class="kp-vis-btn${kp.v===2?' active':''}" data-kp-vis="${name}" data-v="2" title="Visible">V</button>` +
        `<button class="kp-vis-btn${kp.v===1?' active':''}" data-kp-vis="${name}" data-v="1" title="Occluded">O</button>` +
        `<button class="kp-vis-btn${kp.v===0?' active':''}" data-kp-vis="${name}" data-v="0" title="Outside frame">X</button>` +
        `</span>` : '';
      return `<div class="kp-item ${cls}" data-kp-idx="${i}" title="Click to select"><span>${name.replace(/_/g," ")}</span>${toggles}<span>${icon}</span></div>`;
    }).join("");

    // Update summary line
    const summary = document.getElementById("kp-summary");
    if (summary && placed > 0) {
      const parts = [];
      if (visible) parts.push(`${visible} visible`);
      if (occluded) parts.push(`${occluded} occluded`);
      if (skipped) parts.push(`${skipped} outside`);
      summary.textContent = parts.join(" · ");
    } else if (summary) {
      summary.textContent = "";
    }

    // Sync keypoint reference diagram dots
    KEYPOINT_SEQUENCE.forEach((name, i) => {
      const dot = document.getElementById(`kpd-${name}`);
      if (!dot) return;
      const kp = this.keypoints[name];
      dot.className.baseVal = "kp-dot " + (
        kp ? (kp.v === 2 ? "done" : kp.v === 1 ? "occluded" : "skipped")
           : (i === this.kpIndex ? "current" : "pending")
      );
      if (!dot._kpBound) {
        dot.onclick = () => annotCanvas.selectKeypoint(i);
        dot._kpBound = true;
      }
    });

    // Update bbox status badge
    const bboxBadge = document.getElementById("bbox-status");
    if (bboxBadge) {
      if (this.bodyBbox) {
        bboxBadge.textContent = "drawn";
        bboxBadge.style.background = "var(--accent)";
        bboxBadge.style.color = "#fff";
      } else {
        bboxBadge.textContent = "not drawn";
        bboxBadge.style.background = "var(--text-muted)";
        bboxBadge.style.color = "#fff";
      }
    }
  }

  _updateScarsList() {
    const list = document.getElementById("scars-list");
    const count = document.getElementById("scars-count");
    count.textContent = this.scars.length;

    if (!this.scars.length) {
      list.innerHTML = '<p class="muted">No scars added</p>';
      return;
    }
    list.innerHTML = this.scars.map((s, i) => `
      <div class="scar-item">
        <div class="scar-item-info">
          <div class="scar-item-type">${escapeHtml(s.scar_type || "?")}</div>
          <div class="scar-item-meta">Zone ${escapeHtml(s.zone || "?")} · ${escapeHtml(s.side || "?")} · Conf ${escapeHtml(String(s.confidence || "?"))}</div>
        </div>
        <button class="scar-remove" data-scar-id="${escapeHtml(s.id)}">✕</button>
      </div>
    `).join("");
    list.querySelectorAll(".scar-remove").forEach(btn => {
      btn.addEventListener("click", () => annotCanvas.removeScar(btn.dataset.scarId));
    });
  }
}

window.annotCanvas = new AnnotationCanvas();
