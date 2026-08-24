/**
 * pose3d.js — Stream H: silhouette verification + measured segments.
 *
 * Produces what marine-cv/shark-pose-3d consumes to fit its rigged SharkSMPL template to
 * real footage and read VOLUME off the fit. Three tasks, two storage primitives:
 *
 *   1. Silhouette  — SAM2 proposes, the human accepts / paint-corrects / rejects.
 *   2. Scale       — a two-point segment plus its real-world length.
 *   3. Chords      — the same two-point gesture, measuring transverse width or height at
 *                    a station along the body axis. This is the task that makes volume
 *                    come out: a lateral view shows height and no width, and volume is
 *                    the integral of cross-sectional area.
 *
 * Owns no other stream's files. Stream D owns canvas.js / video_player.js / scar_form*.js,
 * so this module renders into its OWN overlay canvas appended to #canvas-wrap and mirrors
 * the view transform by READING window.annotCanvas.{zoom,panX,panY,baseImage}. Reading a
 * public property is not an edit — the same containment Stream F got by giving the signal
 * dock its own canvas.
 *
 * Gated on GET /api/pose3d/health. When the feature is off that 404s and this file
 * returns before touching the DOM, so the annotator UI is byte-identical to today.
 */

const Pose3D = {
  health: null,
  tool: null,          // null | 'sam' | 'paint' | 'erase' | 'scale' | 'axis' | 'width' | 'height'
  samPoints: { pos: [], neg: [] },
  brush: 24,
  mask: null,          // offscreen canvas at IMAGE resolution — the painted silhouette
  sourceMask: null,    // what SAM2 proposed, kept so agreement is measured not assumed
  segments: [],
  drag: null,
  // No default view class, and no default confidence. A pre-selected "lateral_left" with
  // a confidence of 3 is a machine-authored label wearing a human's provenance — and this
  // field is an admissibility GATE (it decides whether a width chord may exist), so a
  // wrong value here silently legalises a measurement on the wrong axis. The labeler must
  // choose.
  viewClass: null,
  viewConfidence: null,
  finsIncluded: false,
  part: "whole",
  recorded: null,
  overlay: null,
  _raf: null,

  // ── lifecycle ────────────────────────────────────────────────────────────

  async init() {
    try {
      const r = await fetch("/api/pose3d/health");
      if (!r.ok) return;
      this.health = await r.json();
      if (!this.health.ok) return;
    } catch (e) {
      return; // feature off, or server down — either way, stay invisible
    }
    this.finsIncluded = !!this.health.fins_included_default;
    this._revealTab();
    this._bindPanel();
    this._buildOverlay();
    this._bindKeys();
    this._loop();
  },

  /**
   * Reveal the tab the template already declares.
   *
   * Same contract as Stream F's #signal-tab-btn: the markup ships hidden and only the
   * health probe un-hides it, so the tab bar is byte-identical when the feature is off.
   * Because the button exists at page load, app.js's own tab wiring binds it, and
   * panel_ui.js::_notifyTask sees "pose3d" as a task without either file changing.
   */
  _revealTab() {
    const btn = document.getElementById("pose3d-tab-btn");
    if (!btn) return;
    btn.style.display = "";
    btn.addEventListener("click", () => this.loadFrame());
    // panel_ui.js owns which tasks are applicable and re-hides any button that is not,
    // so revealing it here is not enough: its refreshTask() has usually already run
    // while the health fetch was still in flight. Ask it to re-evaluate now that
    // `_pose3dShown()` can answer true.
    if (window.PanelUI && window.PanelUI.refreshTask) window.PanelUI.refreshTask();
  },

  _buildOverlay() {
    const wrap = document.getElementById("canvas-wrap");
    const base = document.getElementById("annotation-canvas");
    if (!wrap || !base) return;
    const c = document.createElement("canvas");
    c.id = "pose3d-overlay";
    Object.assign(c.style, {
      position: "absolute", left: "0", top: "0",
      pointerEvents: "none", zIndex: "5",
    });
    if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
    wrap.appendChild(c);
    this.overlay = c;

    c.addEventListener("mousedown", (e) => this._onDown(e));
    c.addEventListener("mousemove", (e) => this._onMove(e));
    window.addEventListener("mouseup", (e) => this._onUp(e));
    c.addEventListener("contextmenu", (e) => { if (this.tool) e.preventDefault(); });
  },

  // ── the transform, mirrored read-only from canvas.js ──────────────────────

  _cv() { return window.annotCanvas || null; },

  _img() {
    const cv = this._cv();
    return cv && cv.baseImage ? cv.baseImage : null;
  },

  /** Canvas-element pixels -> image pixels. Same math as canvas.js::_screenToImage. */
  _toImage(sx, sy) {
    const cv = this._cv();
    if (!cv) return { x: sx, y: sy };
    return { x: (sx - cv.panX) / cv.zoom, y: (sy - cv.panY) / cv.zoom };
  },

  _evtXY(e) {
    const r = this.overlay.getBoundingClientRect();
    return this._toImage(e.clientX - r.left, e.clientY - r.top);
  },

  // ── mask painting ────────────────────────────────────────────────────────

  _ensureMask() {
    const img = this._img();
    if (!img) return null;
    if (!this.mask || this.mask.width !== img.width || this.mask.height !== img.height) {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      this.mask = c;
    }
    return this.mask;
  },

  /**
   * Ask SAM2 for a silhouette from the accumulated click prompts.
   *
   * `/api/frames/segment` is POINT-prompted (`points` / `neg_points`), not box-prompted,
   * so this is the assisted-manual loop SAM's own data engine describes: click inside the
   * animal, alt-click anything it wrongly swallowed, re-run. The result is a PROPOSAL —
   * it is never saved until a human presses Accept, Corrected or Reject.
   */
  async proposeFromSam() {
    const img = this._img();
    if (!img) return this._say("Load a frame first.");
    if (!this.samPoints.pos.length) return this._say("Click inside the shark first.");

    const frame = window.videoPlayer && window.videoPlayer.captureCurrentFrame();
    if (!frame) return this._say("Could not capture the frame.");

    this._say("Asking SAM2…");
    try {
      const res = await API.post("/api/frames/segment", {
        frame_b64: frame,
        points: this.samPoints.pos,
        neg_points: this.samPoints.neg,
      });
      if (!res || !res.mask_b64) return this._say("SAM2 returned no mask.");
      await this._loadProposal(res.mask_b64);
      const c = res.confidence != null ? ` (conf ${Number(res.confidence).toFixed(2)})` : "";
      this._say(`Proposal loaded${c} — accept, correct, or reject.`);
    } catch (e) {
      this._say("SAM2: " + (e.message || "failed"));
    }
  },

  _loadProposal(maskB64) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        const c = this._ensureMask();
        if (!c) return resolve();
        const g = c.getContext("2d");
        g.clearRect(0, 0, c.width, c.height);
        g.drawImage(im, 0, 0, c.width, c.height);
        // Snapshot the proposal BEFORE any human edit, so iou_vs_source compares the
        // human's silhouette against what the model actually said.
        const s = document.createElement("canvas");
        s.width = c.width; s.height = c.height;
        s.getContext("2d").drawImage(c, 0, 0);
        this.sourceMask = s;
        resolve();
      };
      im.onerror = () => resolve();
      im.src = maskB64.startsWith("data:") ? maskB64 : "data:image/png;base64," + maskB64;
    });
  },

  _paint(x, y, erase) {
    const c = this._ensureMask();
    if (!c) return;
    const g = c.getContext("2d");
    g.save();
    g.globalCompositeOperation = erase ? "destination-out" : "source-over";
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(x, y, this.brush, 0, Math.PI * 2);
    g.fill();
    g.restore();
  },

  // ── pointer handling ─────────────────────────────────────────────────────

  _onDown(e) {
    if (!this.tool || !this._isActive()) return;
    e.preventDefault();
    const p = this._evtXY(e);
    if (this.tool === "sam") {
      const neg = e.altKey || e.button === 2;
      (neg ? this.samPoints.neg : this.samPoints.pos).push([Math.round(p.x), Math.round(p.y)]);
      this.proposeFromSam();
      return;
    }
    if (this.tool === "paint" || this.tool === "erase") {
      const erase = this.tool === "erase" || e.altKey || e.button === 2;
      this.drag = { kind: "paint", erase };
      this._paint(p.x, p.y, erase);
    } else {
      this.drag = { kind: "segment", x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }
  },

  _onMove(e) {
    if (!this.drag) return;
    const p = this._evtXY(e);
    if (this.drag.kind === "paint") {
      this._paint(p.x, p.y, this.drag.erase);
    } else {
      this.drag.x2 = p.x;
      this.drag.y2 = p.y;
    }
  },

  _onUp() {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.kind !== "segment") return;
    if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 3) return;  // a click, not a measurement
    this._commitSegment(d);
  },

  async _commitSegment(d) {
    const ctx = this._frameContext();
    if (!ctx) return this._say("No frame loaded.");

    const kind = this.tool === "scale" ? "scale_ref"
               : this.tool === "axis" ? "axis" : "chord";
    let label = this.tool, real = null, plane = null, source = null, measure = null;

    if (kind === "scale_ref") {
      // If the encounter has a field-recorded body length, offer THAT first: it is the
      // referent most frames in this catalog actually have, and it needs no second
      // gesture — the span just drawn is the animal. Confirming a known number beats
      // retyping it. Never defaulted silently, though: it is an observer's visual
      // estimate, and the labeler is told so before accepting it.
      if (this.recorded && confirm(
            `Use the recorded body length for this encounter?\n\n` +
            `${this.recorded.size_ft} ft = ${this.recorded.real_length_m} m ` +
            `(${this.recorded.measure.replace(/_/g, " ")})\n\n` +
            `${this.recorded.precision_note}\n\n` +
            `Only accept if the span you just drew is the ` +
            `${this.recorded.measure.replace(/_/g, " ")}.`)) {
        label = "known_body_length";
        real = this.recorded.real_length_m;
        measure = this.recorded.measure;
        source = this.recorded.source;
      } else {
        const known = (this.health.scale_ref_labels || []);
        label = (prompt(`What is this referent?\n(${known.join(", ")})`, "laser_pair") || "").trim();
        if (!label) return;
        const v = prompt("Its real-world length in METRES (e.g. 0.20 for a 20 cm laser pair):", "0.20");
        real = parseFloat(v);
        if (!(real > 0)) return this._say("A scale reference needs a positive length.");
        source = "measured";
      }
      plane = null;   // server derives it from the label unless it is ambiguous
    } else if (kind === "axis") {
      label = "axis";
    }

    const body = Object.assign({}, ctx, {
      kind, label,
      x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
      real_length_m: real, referent_plane: plane, real_length_source: source,
      length_measure: measure, mask_id: this._maskIdForPart(),
    });

    try {
      const res = await API.post("/api/pose3d/segments", body);
      this.segments.push(res.segment);
      this._renderList();
      this._say(kind === "scale_ref"
        ? `Scale set from ${label}.`
        : `${label} recorded.`);
    } catch (e) {
      // The server refuses a width on a lateral view, or a chord with no axis. Surfacing
      // the reason verbatim is the point: it is a protocol correction, not a bug.
      this._say(e.message || "Refused.");
    }
  },

  // ── saving ───────────────────────────────────────────────────────────────

  /** The id of the outline a chord should bind to, when we know it. */
  _maskIdForPart() {
    const m = (this._frameMasks || []).find((x) => x.part === "body")
           || (this._frameMasks || []).find((x) => x.part === "whole");
    return m ? m.id : null;
  },

  _frameContext() {
    const app = window.appState;
    const img = this._img();
    const vp = window.videoPlayer;
    if (!app || !app.currentVideo || !img) return null;
    return {
      video_id: app.currentVideo.id,
      encounter_code: app.currentVideo.encounter_code || null,
      // currentFrame() is a method on VideoPlayer, not a property.
      frame_number: (vp && typeof vp.currentFrame === "function") ? (vp.currentFrame() || 0) : 0,
      // Seconds, not frames. A client-side fps guess has already put a whole track set on
      // the wrong frame in this codebase; the time is what the server anchors on. A still
      // image has no timeline at all, so it anchors at 0 rather than at a guessed frame.
      time_sec: (vp && vp.mediaType !== "image" && vp.video) ? (vp.video.currentTime || 0) : 0,
      image_w: img.width,
      image_h: img.height,
    };
  },

  async save(verdict) {
    const ctx = this._frameContext();
    if (!ctx) return this._say("No frame loaded.");

    if (verdict !== "rejected" && !this.viewClass) {
      return this._say("Pick the view first — it decides which measurements are possible.");
    }

    let reason = null;
    if (verdict === "rejected") {
      reason = (prompt("Why is this frame unusable?\n(occluded / too turbid / cropped / wrong animal)") || "").trim();
      if (!reason) return this._say("A rejection needs a reason — it is the signal that improves the segmenter.");
    } else if (!this.mask) {
      return this._say("No silhouette yet. Run SAM2 or paint one.");
    }

    const body = Object.assign({}, ctx, {
      view_class: this.viewClass,
      view_confidence: this.viewConfidence,
      part: this.part,
      verdict,
      reject_reason: reason,
      fins_included: this.finsIncluded,
      mask_png_b64: verdict === "rejected" ? null : this.mask.toDataURL("image/png"),
      source_mask_png_b64: this.sourceMask ? this.sourceMask.toDataURL("image/png") : null,
    });

    try {
      const res = await API.post("/api/pose3d/masks", body);
      const iou = res.mask && res.mask.iou_vs_source;
      this._say(`Saved (${verdict})` + (iou != null ? ` — IoU vs SAM2 ${iou.toFixed(3)}` : ""));
      this._renderList();
    } catch (e) {
      this._say(e.message || "Save failed.");
    }
  },

  /**
   * Record the VIEW and move on — the loop the view_class reliability study runs in.
   *
   * Deliberately does not ask for a silhouette. The question under test is whether
   * people agree on the view, and forcing an outline would cost roughly forty times as
   * long per frame and change what is being measured. Saved as verdict='view_only',
   * which carries a view and asserts nothing about an outline existing.
   */
  async saveViewAndNext() {
    if (!this.viewClass) return this._say("Pick a view first (keys 1-7).");
    const ctx = this._frameContext();
    if (!ctx) return this._say("No frame loaded.");
    try {
      await API.post("/api/pose3d/masks", Object.assign({}, ctx, {
        view_class: this.viewClass,
        view_confidence: this.viewConfidence,
        verdict: "view_only",
        part: "whole",
      }));
    } catch (e) {
      return this._say(e.message || "Save failed.");
    }
    // Reset the answer so the next frame cannot inherit it — a sticky view class would
    // manufacture agreement with the previous frame rather than measure it.
    this.viewClass = null;
    const sel = document.getElementById("pose3d-view");
    if (sel) sel.value = "";
    this._chordHint(this.health.view_chords || {});
    if (window.appState && window.appState._advanceToNext) {
      window.appState._advanceToNext();
    }
  },

  async loadFrame() {
    const ctx = this._frameContext();
    if (!ctx) return;
    try {
      const enc = (window.appState.currentVideo || {}).encounter_code || "";
      const res = await API.get(
        `/api/pose3d/frame?video_id=${encodeURIComponent(ctx.video_id)}` +
        `&frame_number=${ctx.frame_number}&encounter_code=${encodeURIComponent(enc)}`);
      this.segments = res.segments || [];
      this._frameMasks = res.masks || [];
      this.recorded = res.recorded_length || null;
      if (res.mask) {
        this.viewClass = res.mask.view_class;
        this.finsIncluded = !!res.mask.fins_included;
      }
      this._renderRecorded();
      this._renderList(res.scale);
    } catch (e) { /* nothing recorded on this frame yet */ }
  },

  // ── rendering ────────────────────────────────────────────────────────────

  _loop() {
    const draw = () => {
      this._draw();
      this._raf = requestAnimationFrame(draw);
    };
    this._raf = requestAnimationFrame(draw);
  },

  _draw() {
    const c = this.overlay, cv = this._cv(), base = document.getElementById("annotation-canvas");
    if (!c || !cv || !base) return;
    if (c.width !== base.width || c.height !== base.height) {
      c.width = base.width; c.height = base.height;
      c.style.width = base.style.width || base.clientWidth + "px";
      c.style.height = base.style.height || base.clientHeight + "px";
    }
    // Switching to another task must make this overlay inert immediately, or it keeps
    // swallowing clicks meant for the scar or pose canvas underneath it.
    if (!this._isActive() && this.tool) this._setTool(null);
    const armed = this._isActive() && !!this.tool;
    c.style.pointerEvents = armed ? "auto" : "none";
    c.style.cursor = armed ? "crosshair" : "default";

    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    if (!this._isActive()) return;
    if (!this.tool && !this.mask && !this.segments.length) return;

    g.save();
    g.translate(cv.panX, cv.panY);
    g.scale(cv.zoom, cv.zoom);

    if (this.mask) {
      g.globalAlpha = 0.38;
      g.drawImage(this.mask, 0, 0);
      g.globalAlpha = 1;
    }

    const line = 2 / cv.zoom;
    const drawSeg = (s, color, dash) => {
      g.strokeStyle = color;
      g.lineWidth = line;
      g.setLineDash(dash ? [6 / cv.zoom, 4 / cv.zoom] : []);
      g.beginPath();
      g.moveTo(s.x1, s.y1);
      g.lineTo(s.x2, s.y2);
      g.stroke();
      g.setLineDash([]);
      const r = 3 / cv.zoom;
      g.fillStyle = color;
      [[s.x1, s.y1], [s.x2, s.y2]].forEach(([x, y]) => {
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      });
    };

    const COLOR = { scale_ref: "#ffd166", axis: "#4cc9f0", chord: "#06d6a0" };
    this.segments.forEach((s) => drawSeg(s, COLOR[s.kind] || "#fff", s.kind === "axis"));
    if (this.drag && this.drag.kind === "segment") {
      drawSeg(this.drag, "#ffffff", true);
    }
    g.restore();
  },

  // ── panel ────────────────────────────────────────────────────────────────

  /** Fill the template's dynamic bits and bind its controls. Builds no markup. */
  _bindPanel() {
    const sel = document.getElementById("pose3d-view");
    if (!sel) return;
    const views = this.health.view_classes || [];
    const chords = this.health.view_chords || {};
    sel.innerHTML = '<option value="">— pick the view —</option>' + views
      .map((v) => `<option value="${v}">${v.replace(/_/g, " ")}</option>`)
      .join("");
    sel.value = this.viewClass || "";

    const psel = document.getElementById("pose3d-part");
    if (psel) {
      psel.innerHTML = (this.health.parts || [])
        .map((p) => `<option value="${p}">${p.replace(/_/g, " ")}</option>`)
        .join("");
      psel.value = this.part;
    }

    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };
    on("pose3d-view", "change", (e) => { this.viewClass = e.target.value || null; this._chordHint(chords); });
    on("pose3d-fins", "change", (e) => { this.finsIncluded = e.target.checked; });
    on("pose3d-part", "change", (e) => { this.part = e.target.value; this._partHint(); });
    on("pose3d-brush", "input", (e) => { this.brush = parseInt(e.target.value, 10); });
    ["sam", "paint", "erase", "scale", "axis", "width", "height"].forEach((t) =>
      on("pose3d-" + t, "click", () => this._setTool(t)));
    on("pose3d-save-view", "click", () => this.saveViewAndNext());
    on("pose3d-accept", "click", () => this.save("accepted"));
    on("pose3d-correct", "click", () => this.save("corrected"));
    on("pose3d-reject", "click", () => this.save("rejected"));

    const fins = document.getElementById("pose3d-fins");
    if (fins) fins.checked = this.finsIncluded;
    this._chordHint(chords);
    this._partHint();
  },

  /**
   * Grey out the chord a view cannot measure, and say why.
   *
   * A width read off a lateral frame is not a width — it is a foreshortened something.
   * The server refuses it, but a labeler who can click the button and only learn at POST
   * time has already done the work; and worse, the refusal reads as a bug rather than as
   * the geometry it is.
   */
  _chordHint(chords) {
    const allowed = this.viewClass ? (chords[this.viewClass] || []) : [];
    ["width", "height"].forEach((k) => {
      const b = document.getElementById("pose3d-" + k);
      if (!b) return;
      const ok = allowed.indexOf(k) >= 0;
      b.disabled = !ok;
      b.style.opacity = ok ? "1" : "0.35";
      b.title = ok ? `Measure ${k} on a ${this.viewClass} view`
                   : `A ${this.viewClass} view cannot show ${k}`;
    });
    const hint = document.getElementById("pose3d-chordhint");
    if (!hint) return;
    hint.textContent = !this.viewClass
      ? "Pick the view — it decides which measurements are possible."
      : allowed.length
      ? `This view measures: ${allowed.join(" + ")}`
      : "An oblique view foreshortens by an unknown angle — no chords.";
  },

  /**
   * Say what the selected outline is FOR, because the two uses want opposite things.
   *
   * Fins pin the animal's roll — without them a shark is close to a smooth tube and the
   * fit can spin freely about its long axis. But a fin is a thin foil: lots of outline,
   * almost no bulk. Measure across one and the animal reads as far fatter than it is.
   */
  _partHint() {
    const el = document.getElementById("pose3d-parthint");
    if (!el) return;
    const body = (this.health.body_parts || ["whole", "body"]).indexOf(this.part) >= 0;
    el.textContent =
      this.part === "whole"
        ? "Fins IN. Best for the 3D fit — the fins are what fix which way up the shark is."
        : this.part === "body"
        ? "Fins OUT. This is the outline width and height get measured against."
        : `A ${this.part.replace(/_/g, " ")} outline. Helps the fit; chords cannot be measured on it.`;
    ["width", "height"].forEach((k) => {
      const b = document.getElementById("pose3d-" + k);
      if (b && !body) { b.disabled = true; b.style.opacity = "0.35"; b.title = "Pick a body outline to measure chords"; }
    });
  },

  _setTool(t) {
    this.tool = this.tool === t ? null : t;
    // Prompt points belong to one segmentation attempt. Carrying them across a tool
    // switch would silently re-prompt SAM2 with clicks meant for a different frame.
    if (this.tool !== "sam") this.samPoints = { pos: [], neg: [] };
    ["sam", "paint", "erase", "scale", "axis", "width", "height"].forEach((k) => {
      const b = document.getElementById("pose3d-" + k);
      if (b) b.classList.toggle("active", this.tool === k);
    });
  },

  /** True when the 3D task is the one in front of the labeler. */
  _isActive() {
    const p = document.getElementById("tab-pose3d");
    return !!(p && p.classList.contains("active"));
  },

  _renderList(scale) {
    const el = document.getElementById("pose3d-list");
    if (!el) return;
    const esc = escapeHtml;   // utils.js; the old `|| (s => s)` fallback did not escape
    const rows = this.segments.map((s) => {
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1).toFixed(1);
      const st = s.station != null ? ` @${(s.station * 100).toFixed(0)}%` : "";
      const m = s.real_length_m ? ` = ${s.real_length_m} m` : "";
      return `<div>· ${esc(s.kind)} <b>${esc(s.label)}</b>${st} — ${len}px${m}</div>`;
    });
    if (scale && scale.px_per_m) {
      rows.unshift(`<div style="color:#ffd166;">scale: ${scale.px_per_m.toFixed(1)} px/m `
        + `(${esc(scale.referent_plane)})</div>`);
    }
    el.innerHTML = rows.join("") || '<div style="color:#667;">nothing measured yet</div>';
  },

  /** Show the field-recorded length, caveat and all — or say plainly that there is none. */
  _renderRecorded() {
    const el = document.getElementById("pose3d-recorded");
    if (!el) return;
    if (!this.recorded) {
      el.textContent = "No recorded body length for this encounter — mark a scale reference if the frame has one.";
      return;
    }
    const r = this.recorded;
    el.textContent = `Recorded length: ${r.size_ft} ft = ${r.real_length_m} m `
      + `(${r.measure.replace(/_/g, " ")}, ${r.source.replace(/_/g, " ")}). ${r.precision_note}.`;
  },

  _say(msg) {
    const el = document.getElementById("pose3d-status");
    if (el) el.textContent = msg;
  },

  _bindKeys() {
    document.addEventListener("keydown", (e) => {
      if (!this._isActive()) return;
      // `document` has no .matches, and a keydown with nothing focused targets it —
      // an unguarded call throws and silently kills every shortcut below.
      const t = e.target;
      if (t && typeof t.matches === "function" && t.matches("input, textarea, select")) return;
      if (e.key === "Escape" && this.tool) { this._setTool(null); e.preventDefault(); }

      // Study loop: digits pick a view, Enter commits and advances. Only while the 3D
      // task is in front, so it cannot shadow the scar form's 1-5 confidence keys.
      const views = this.health.view_classes || [];
      const n = parseInt(e.key, 10);
      if (!e.metaKey && !e.ctrlKey && !e.altKey && n >= 1 && n <= views.length) {
        this.viewClass = views[n - 1];
        const sel = document.getElementById("pose3d-view");
        if (sel) sel.value = this.viewClass;
        this._chordHint(this.health.view_chords || {});
        this._say(`View: ${this.viewClass.replace(/_/g, " ")} — Enter to save and go on.`);
        e.preventDefault();
      } else if (e.key === "Enter") {
        this.saveViewAndNext();
        e.preventDefault();
      }
    });
  },
};

window.Pose3D = Pose3D;
document.addEventListener("DOMContentLoaded", () => Pose3D.init());
