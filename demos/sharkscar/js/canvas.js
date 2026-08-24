/**
 * canvas.js — Annotation canvas with zoom/pan, SAM overlay, bbox draw, keypoints.
 * Exposes: AnnotationCanvas (class), window.annotCanvas (singleton)
 */
"use strict";

const KEYPOINT_SEQUENCE = [
  "snout_tip","eye_center","gill_slit","pectoral_base","pectoral_tip",
  "first_dorsal_base","first_dorsal_tip","second_dorsal_base","second_dorsal_tip",
  "pelvic_fin_tip","anal_fin_tip","caudal_notch","caudal_upper_tip",
  "caudal_lower_tip","body_midpoint_dorsal","body_midpoint_ventral"
];

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
    this.mode   = "browse";   // browse | body | scar | keypoint | bbox
    this.baseImage = null;    // ImageBitmap of current (possibly enhanced) frame
    this.frameB64  = null;    // raw base64 of displayed frame

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
    this._isPanning = false;
    this._lastMouse = {x:0, y:0};

    this._resize();
    this._bindEvents();
    this._startRenderLoop();
  }

  // ──────────── Public API ────────────────────────────────────────

  setMode(mode) {
    this.mode = mode;
    this.canvas.style.cursor = mode === "browse" ? "grab" : "crosshair";
  }

  setFrame(b64) {
    this.frameB64 = b64;
    const img = new Image();
    img.onload = () => {
      createImageBitmap(img).then(bm => {
        this.baseImage = bm;
        this._fitToCanvas();
      });
    };
    img.src = "data:image/jpeg;base64," + b64;
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

  setBodyBbox(bbox) { this.bodyBbox = bbox; }

  addScar(data) {
    this._pushHistory();
    this.scars.push(data);
    this._updateScarsList();
  }

  removeScar(id) {
    if (!confirm("Remove this scar annotation?")) return;
    this._pushHistory();
    this.scars = this.scars.filter(s => s.id !== id);
    this._updateScarsList();
  }

  placeKeypoint(name, x, y, v = 2) {
    this._pushHistory();
    const canvasXY = this._screenToImage(x, y);
    this.keypoints[name] = { x: canvasXY.x, y: canvasXY.y, v: v };
    this._advanceToNextUnplaced();
    this._updateKpList();
  }

  skipKeypoint() {
    if (this.kpIndex < KEYPOINT_SEQUENCE.length) {
      this._pushHistory();
      const name = KEYPOINT_SEQUENCE[this.kpIndex];
      this.keypoints[name] = { x: 0, y: 0, v: 0 };
      this._advanceToNextUnplaced();
      this._updateKpList();
    }
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
    this._updateKpList();
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

  zoom_in()  { this.zoom = Math.min(this.zoom * 1.2, 10); }
  zoom_out() { this.zoom = Math.max(this.zoom / 1.2, 0.1); }
  zoom_reset() { this._fitToCanvas(); }

  getAnnotationData() {
    const kpArr = Object.entries(this.keypoints).map(([name, pt]) => ({ name, x: pt.x, y: pt.y, v: pt.v }));
    return {
      body_bbox: this.bodyBbox,
      keypoints: kpArr,
      scars: this.scars.map(s => ({
        id: s.id, scar_type: s.scar_type, zone: s.zone, side: s.side,
        confidence: s.confidence, color: s.color, color_other: s.color_other,
        notes: s.notes, copepods_present_body: s.copepods_present_body,
        copepods_present_wound: s.copepods_present_wound,
        multiple_scars: s.multiple_scars, annotator: s.annotator,
        bbox: s.bbox,
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
      ctx.drawImage(this.baseImage, 0, 0);
    } else {
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, W / this.zoom, H / this.zoom);
      ctx.fillStyle = "#444";
      ctx.font = "16px sans-serif";
      ctx.fillText("Load a video to annotate", 20, 40);
    }

    // Body mask
    if (this.bodyMask && this.baseImage) {
      this._drawMask(ctx, this.bodyMask, "rgba(74,144,217,0.25)", "rgba(74,144,217,0.8)");
    }

    // Body bbox
    if (this.bodyBbox) {
      this._drawBbox(ctx, this.bodyBbox, COLORS.bboxStroke, COLORS.bbox, null);
    }

    // Scar masks + bboxes
    for (const s of this.scars) {
      if (s.mask) this._drawMask(ctx, s.mask, COLORS.scar, COLORS.scarStroke);
      if (s.bbox) this._drawBbox(ctx, s.bbox, COLORS.scarStroke, COLORS.scar, `${s.scar_type} Z${s.zone}`);
    }

    // Custom observations
    for (const obs of this.observations) {
      if (obs.bbox) this._drawBbox(ctx, obs.bbox, COLORS.obsStroke, COLORS.obs, obs.label);
    }

    // Keypoints
    for (const [name, pt] of Object.entries(this.keypoints)) {
      if (pt.v === 0) continue;  // not labeled — don't draw
      const isCurrent = KEYPOINT_SEQUENCE[this.kpIndex] === name;
      const isOcc = pt.v === 1;

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5 / this.zoom, 0, Math.PI * 2);

      if (isOcc) {
        ctx.fillStyle = "rgba(245,158,11,0.3)";
        ctx.fill();
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 1.5 / this.zoom;
        ctx.setLineDash([3 / this.zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = isCurrent ? COLORS.kpCurrent : COLORS.kp;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1 / this.zoom;
        ctx.stroke();
      }

      ctx.fillStyle = isOcc ? "#f59e0b" : "#fff";
      ctx.font = `${10 / this.zoom}px sans-serif`;
      const lbl = name.replace(/_/g, " ") + (isOcc ? " (occ)" : "");
      ctx.fillText(lbl, pt.x + 6 / this.zoom, pt.y - 4 / this.zoom);
    }

    // Current keypoint prompt
    if (this.mode === "keypoint" && this.kpIndex < KEYPOINT_SEQUENCE.length) {
      const name = KEYPOINT_SEQUENCE[this.kpIndex];
      ctx.fillStyle = COLORS.kpCurrent;
      ctx.font = `bold ${13 / this.zoom}px sans-serif`;
      ctx.fillText(`Click: ${name.replace(/_/g, " ")}  (Alt = occluded)`, 10 / this.zoom, 22 / this.zoom);
    }

    // Bbox drawing in progress
    if (this._bboxDraw && (this.mode === "bbox" || this.mode === "scar")) {
      const { sx, sy, ex, ey } = this._bboxDraw;
      const w = ex - sx, h = ey - sy;
      ctx.strokeStyle = this.mode === "scar" ? COLORS.scarStroke : COLORS.obsStroke;
      ctx.lineWidth = 2 / this.zoom;
      ctx.setLineDash([4 / this.zoom]);
      ctx.strokeRect(sx, sy, w, h);
      ctx.setLineDash([]);
    }

    ctx.restore();
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

    // Mouse wheel zoom
    cvs.addEventListener("wheel", e => {
      e.preventDefault();
      const rect = cvs.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.panX = mx - (mx - this.panX) * factor;
      this.panY = my - (my - this.panY) * factor;
      this.zoom *= factor;
      this.zoom = Math.max(0.1, Math.min(20, this.zoom));
    }, { passive: false });

    // Mouse down
    cvs.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      const { x, y } = this._canvasXY(e);

      if (this.mode === "browse") {
        this._isPanning = true;
        this._lastMouse = { x: e.clientX, y: e.clientY };
        cvs.style.cursor = "grabbing";
        return;
      }

      if (this.mode === "bbox" || this.mode === "scar") {
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

      if (this._bboxDraw && (this.mode === "bbox" || this.mode === "scar")) {
        const img = this._screenToImage(x, y);
        this._bboxDraw.ex = img.x;
        this._bboxDraw.ey = img.y;
      }
    });

    // Mouse up / click
    cvs.addEventListener("mouseup", e => {
      if (this._isPanning) {
        this._isPanning = false;
        cvs.style.cursor = this.mode === "browse" ? "grab" : "crosshair";
        return;
      }

      const { x, y } = this._canvasXY(e);
      const img = this._screenToImage(x, y);

      if ((this.mode === "bbox" || this.mode === "scar") && this._bboxDraw) {
        const bd = this._bboxDraw;
        this._bboxDraw = null;
        const bw = Math.abs(bd.ex - bd.sx);
        const bh = Math.abs(bd.ey - bd.sy);
        if (bw > 10 && bh > 10) {
          const bbox = {
            x: Math.min(bd.sx, bd.ex), y: Math.min(bd.sy, bd.ey),
            width: bw, height: bh,
          };
          if (this.mode === "scar") {
            if (window.appState) window.appState.handleScarBbox(bbox);
          } else {
            this._showBboxLabelPopup(x, y, bbox);
          }
        }
        return;
      }

      if (this.mode === "keypoint") {
        if (this.kpIndex < KEYPOINT_SEQUENCE.length) {
          const name = KEYPOINT_SEQUENCE[this.kpIndex];
          const v = e.altKey ? 1 : 2;  // Alt+click = occluded
          this.placeKeypoint(name, x, y, v);
        }
        return;
      }

      if (this.mode === "body") {
        // Dispatch to app.js for SAM call
        if (window.appState) window.appState.handleCanvasClick(img.x, img.y, this.mode);
        return;
      }
    });
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
    const rect = this.wrap.getBoundingClientRect();
    this.canvas.width  = rect.width  || 800;
    this.canvas.height = rect.height || 500;
    if (this.baseImage) this._fitToCanvas();
  }

  // ──────────── History ────────────────────────────────────────────

  _pushHistory() {
    const entry = {
      json: JSON.stringify({
        scars: this.scars, keypoints: this.keypoints,
        kpIndex: this.kpIndex, observations: this.observations,
        bodyBbox: this.bodyBbox,
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
    const placed = Object.values(this.keypoints).filter(k => k.v > 0).length;
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
      return `<div class="kp-item ${cls}" onclick="annotCanvas.selectKeypoint(${i})" title="Click to select"><span>${name.replace(/_/g," ")}</span><span>${icon}</span></div>`;
    }).join("");
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
          <div class="scar-item-type">${s.scar_type || "?"}</div>
          <div class="scar-item-meta">Zone ${s.zone || "?"} · ${s.side || "?"} · Conf ${s.confidence || "?"}</div>
        </div>
        <button class="scar-remove" onclick="annotCanvas.removeScar('${s.id}')">✕</button>
      </div>
    `).join("");
  }
}

window.annotCanvas = new AnnotationCanvas();
