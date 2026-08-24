/**
 * signals.js — Stream F: the synchronized signal dock.
 *
 * Self-contained singleton (window.Signals). Registers NO global side effects unless
 * /api/signals/health reports the feature enabled — gated off, the dock stays
 * display:none, no listeners are bound, and the annotator UI is byte-identical to today.
 *
 * What it is: a timeline docked inside .panel-center showing an acoustic or RF waterfall
 * (and, from F1, accelerometer channels) on ONE shared time axis with the video. Draw a
 * box on the waterfall, or mark an interval against the video, and it saves as a label
 * on the deployment clock.
 *
 * ── The one rule ──
 * Everything is SECONDS on the deployment clock. Never frames. `video_player.js` derives
 * frames from an *estimated* fps (`_estimateFps`), and this repo has already been bitten
 * by that (30 fps assumed against a 59.94 fps video put the scar tracker on the wrong
 * frame). Each source declares one scalar `t0_offset_s` (plus an optional `drift_ppm`);
 * that conversion lives in `_sourceToDeployment`/`_deploymentToSource` and NOWHERE else,
 * and it mirrors `signals.clock.SourceClock` term for term. Anything that reads
 * `t0_offset_s` directly is a bug: the server always applies drift, so a lane painted or
 * a label written without it silently disagrees with every export.
 *
 * ── Ownership ──
 * Stream D owns canvas.js / tracks.js / video_player.js / scar_form*.js. This module does
 * not modify them. It reads `window.videoPlayer.video.currentTime` and writes it back to
 * seek — the same cross-module-via-global pattern roi.js uses with window.annotCanvas.
 */
"use strict";

const Signals = {
  // ── feature gate ──
  available: false,
  layout: "below",

  // ── data ──
  deployments: [],
  deployment: null,
  sources: [],
  vocabularies: [],
  labels: [],

  // ── view (the time window the dock is showing, deployment clock) ──
  view: { startS: 0, spanS: 60 },
  duration: { startS: 0, endS: 60 },

  // ── interaction ──
  mode: "browse",            // browse | box | interval
  activeVocabId: null,
  activeCode: null,
  confidence: 3,
  selectedLabelId: null,
  follow: true,              // keep the playhead in view during playback

  // ── internals ──
  _tiles: new Map(),         // "srcId:tileIdx" -> HTMLImageElement
  _tileOrder: [],            // insertion order, for a bounded cache
  _maxTiles: 400,
  _pyr: new Map(),        // "ch:hash:level:tile" -> Float32Array | 'pending'
  _pyrOrder: [],
  _maxPyr: 400,
  _drag: null,
  _pendingInterval: null,
  _pointerInDock: false,
  _rafId: null,
  _dirtyFrame: true,
  _hiddenSources: new Set(),
  _hiddenChannels: new Set(),
  cursorS: null,          // dock playhead for deployments with no video source

  GUTTER: 56,                // left gutter for frequency / lane names
  RULER_H: 16,
  LABEL_LANE_H: 28,
  MIN_LANE_H: 54,
  MIN_SENSOR_H: 26,
  PREF_SENSOR_H: 40,

  // ══════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════════

  async init() {
    let health = null;
    try {
      const r = await fetch("/api/signals/health");
      health = r.ok ? await r.json() : null;
    } catch (e) {
      health = null;
    }
    this.available = !!(health && health.ok);
    const dock = document.getElementById("signal-dock");
    const tabBtn = document.getElementById("signal-tab-btn");

    if (!this.available) {
      if (dock) dock.style.display = "none";
      if (tabBtn) tabBtn.style.display = "none";
      console.info("[Signals] feature gated off");
      return;
    }

    this.layout = health.layout || "below";

    // Bind and lay out, but do NOT reveal yet. `signals.enabled` says the FEATURE
    // exists; it does not say this labeler has any signal to look at. Revealing on
    // the flag alone put an empty waterfall dock under the video for every scar and
    // pose annotator in the lab — a permanent piece of furniture advertising a task
    // they were never assigned. Presence is decided by data, in _applyPresence().
    this._bindDock();
    this._bindCanvas();
    this._bindKeys();
    this._applyLayout();

    try {
      await this._loadDeployments();
    } catch (e) {
      this._hint(`Could not load deployments: ${e.message}`);
    }

    this._applyPresence();
    this._startRenderLoop();
  },

  /** Kinds that actually need a time–frequency dock. A deployment carrying only a
   *  video source has nothing to waterfall — the video player already shows it. */
  SIGNAL_KINDS: ["audio", "rf", "sensor"],

  /**
   * Show the dock only when there is a signal to show.
   *
   * Two gates, because the two facts arrive at different times: the deployment LIST
   * says whether this labeler has signal work at all, and only the deployment DETAIL
   * says whether the one they opened carries a non-video source. A labeler with no
   * assignment, or one whose deployment is video-only, gets no dock and no tab —
   * identical to `signals.enabled: false`, which is what they should see.
   */
  _applyPresence() {
    const dock = document.getElementById("signal-dock");
    const tabBtn = document.getElementById("signal-tab-btn");

    let show;
    if (!this.deployments.length) {
      show = false;                                   // nothing assigned to this person
    } else if (this.deployment) {
      // A deployment is open — judge it on the sources it actually has.
      show = (this.sources || []).some((s) => this.SIGNAL_KINDS.includes(s.kind));
    } else {
      // Assigned work exists but nothing is open yet: keep the picker reachable,
      // otherwise a labeler with two deployments could never select either.
      show = true;
    }

    this.present = show;
    if (dock) {
      dock.classList.toggle("available", show);
      dock.style.display = show ? "" : "none";
    }
    if (tabBtn) tabBtn.style.display = show ? "" : "none";
    document.body.classList.toggle("has-signals", show);
    if (!show) console.info("[Signals] no audio/RF/sensor source for this labeler — dock hidden");
  },

  // ══════════════════════════════════════════════════════════════════════
  // Data loading
  // ══════════════════════════════════════════════════════════════════════

  async _loadDeployments() {
    const data = await this._get("/api/signals/deployments");
    this.deployments = data.deployments || [];
    const sel = document.getElementById("signal-deployment");
    if (!sel) return;

    sel.innerHTML = '<option value="">— select deployment —</option>';
    for (const d of this.deployments) {
      const o = document.createElement("option");
      o.value = d.id;
      o.textContent = d.code + (d.site ? ` (${d.site})` : "");
      sel.appendChild(o);
    }
    if (this.deployments.length === 1) {
      sel.value = this.deployments[0].id;
      await this.loadDeployment(this.deployments[0].id);
    } else {
      this._setEmpty(
        this.deployments.length
          ? "Pick a deployment to start labeling."
          : "No deployments assigned to you yet."
      );
    }
  },

  async loadDeployment(id) {
    if (!id) {
      this.deployment = null;
      this.sources = [];
      this.labels = [];
      this._tiles.clear();
      this._tileOrder = [];
      this._setEmpty("Pick a deployment to start labeling.");
      this._renderTermList();
      this._renderLabelList();
      this._applyPresence();
      this._dirtyFrame = true;
      return;
    }

    const data = await this._get(`/api/signals/deployments/${id}`);
    this.deployment = data.deployment;
    this.sources = data.sources || [];
    this.vocabularies = data.vocabularies || [];
    this._tiles.clear();
    this._tileOrder = [];
    this._hiddenSources.clear();
    this.selectedLabelId = null;

    // Re-judge now that we know what this deployment actually carries: a video-only
    // deployment has no waterfall to draw, so the dock stays hidden.
    this._applyPresence();

    this._computeDuration();
    this.view.startS = this.duration.startS;
    this.view.spanS = Math.min(60, Math.max(1, this.duration.endS - this.duration.startS));

    // Default to a vocabulary whose KIND matches what this deployment is for. Picking
    // "the first one with terms" put an acoustic vocabulary on a biologging deployment,
    // so [ and ] would save `fish_chorus` as a behaviour interval — create_label checks
    // that a code exists in its vocabulary but never that the kinds are compatible.
    const hasSensor = this.sources.some((x) => x.kind === "sensor");
    const hasVideo = !!this._videoSource();
    const want = (hasSensor || hasVideo) ? "behavior" : null;
    const byKind = (k) => this.vocabularies.find((v) => v.kind === k && (v.terms || []).length);
    const usable = (want && byKind(want)) || this.vocabularies.find((v) => (v.terms || []).length);
    this.activeVocabId = usable ? usable.id : null;
    this.activeCode = usable && usable.terms.length ? usable.terms[0].code : null;
    if (want === "behavior" && !byKind("behavior")) {
      this._hint("No behaviour terms configured — fill signals.vocabularies[shark_ethogram] to label bouts.");
    }

    await this._loadLabels();
    this._renderTermList();
    this._renderLabelList();
    this._setEmpty(this.sources.length ? "" : "This deployment has no sources attached yet.");
    this._dirtyFrame = true;
    this._hint(this._modeHint());
  },

  async _loadLabels() {
    if (!this.deployment) return;
    const data = await this._get(`/api/signals/deployments/${this.deployment.id}/labels?mine=1`);
    this.labels = data.labels || [];
    this._dirtyFrame = true;
  },

  /** Union of every source's span on the deployment clock. */
  _computeDuration() {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.sources) {
      const dur = Number(s.duration_s || 0);
      lo = Math.min(lo, this._sourceToDeployment(s, 0));
      hi = Math.max(hi, this._sourceToDeployment(s, dur));
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) {
      lo = 0;
      hi = 60;
    }
    this.duration = { startS: lo, endS: hi };
  },

  // ══════════════════════════════════════════════════════════════════════
  // Lanes
  // ══════════════════════════════════════════════════════════════════════

  _waterfallSources() {
    return this.sources.filter(
      (s) => (s.kind === "audio" || s.kind === "rf") && s.meta && s.meta.grid && !this._hiddenSources.has(s.id)
    );
  },

  _videoSource() {
    return this.sources.find((s) => s.kind === "video") || null;
  },

  /** Stable identity for a lane across _layoutLanes() calls (which return fresh objects). */
  _laneKey(lane) {
    if (!lane) return "";
    if (lane.type === "sensor") return `sensor:${lane.source.id}:${lane.channel.id}`;
    if (lane.type === "waterfall") return `wf:${lane.source.id}`;
    return lane.type;
  },

  /** Every visible sensor channel, flattened to one lane each. */
  _sensorLanes() {
    const out = [];
    for (const s of this.sources) {
      if (s.kind !== "sensor" || !s.meta || !s.meta.lattice) continue;
      if (this._hiddenSources.has(s.id)) continue;
      for (const c of s.channels || []) {
        if (this._hiddenChannels.has(c.id)) continue;
        out.push({ source: s, channel: c });
      }
    }
    return out;
  },

  /** Lane rectangles for the current canvas size. */
  _layoutLanes(w, h) {
    const lanes = [];
    const wf = this._waterfallSources();
    const sens = this._sensorLanes();
    const availH = h - this.RULER_H - this.LABEL_LANE_H;

    // Two classes, because their needs differ by ~2x: a spectrogram needs vertical room
    // to resolve frequency, a min/max trace is legible at 30px. A single availH/count
    // divisor would give a 12-channel CATS deployment 12 unreadable slivers, or push the
    // waterfall out of the dock entirely.
    let sensorH = sens.length ? Math.max(this.MIN_SENSOR_H, Math.min(this.PREF_SENSOR_H,
      Math.floor((availH * (wf.length ? 0.55 : 1.0)) / sens.length))) : 0;
    let wfH = wf.length ? Math.max(this.MIN_LANE_H,
      Math.floor((availH - sensorH * sens.length) / wf.length)) : 0;
    // If the two classes together overflow, the sensor lanes give way first — the
    // waterfall has a hard legibility floor, a trace degrades gracefully.
    const overflow = wfH * wf.length + sensorH * sens.length - availH;
    if (overflow > 0 && sens.length) {
      sensorH = Math.max(this.MIN_SENSOR_H, sensorH - Math.ceil(overflow / sens.length));
    }

    let y = 0;
    for (const s of wf) {
      lanes.push({ type: "waterfall", source: s, top: y, height: wfH });
      y += wfH;
    }
    for (const sl of sens) {
      lanes.push({ type: "sensor", source: sl.source, channel: sl.channel, top: y, height: sensorH });
      y += sensorH;
    }
    lanes.push({ type: "labels", top: h - this.RULER_H - this.LABEL_LANE_H, height: this.LABEL_LANE_H });
    return lanes;
  },

  // ══════════════════════════════════════════════════════════════════════
  // Coordinate transforms — deployment seconds ⇄ canvas pixels
  // ══════════════════════════════════════════════════════════════════════

  _plotWidth(w) {
    return Math.max(1, w - this.GUTTER);
  },

  _timeToX(t, w) {
    return this.GUTTER + ((t - this.view.startS) / this.view.spanS) * this._plotWidth(w);
  },

  _xToTime(x, w) {
    return this.view.startS + ((x - this.GUTTER) / this._plotWidth(w)) * this.view.spanS;
  },

  /**
   * Frequency ⇄ y within a waterfall lane.
   *
   * The lane's top edge is half a bin ABOVE the highest bin centre and its bottom edge
   * half a bin below the lowest, so a tile drawn into the full lane rect puts image row r
   * exactly on bin (n_bins-1-r). Skipping that half-bin makes every stored box drift by
   * half a bin — invisible on screen, wrong in the export.
   */
  _laneFreqEdges(grid) {
    const half = grid.hz_per_bin / 2;
    return { top: grid.freq_hi_hz + half, bottom: grid.freq_lo_hz - half };
  },

  _freqToY(f, grid, lane) {
    const e = this._laneFreqEdges(grid);
    return lane.top + ((e.top - f) / (e.top - e.bottom)) * lane.height;
  },

  _yToFreq(y, grid, lane) {
    const e = this._laneFreqEdges(grid);
    return e.top - ((y - lane.top) / lane.height) * (e.top - e.bottom);
  },

  /**
   * Source-clock seconds → deployment-clock seconds (the one conversion that matters).
   *
   * This MUST stay numerically identical to `signals.clock.SourceClock`, which every
   * server read path uses (`signal_exports.source_clock`, the `time_basis: "source"`
   * branch of the create route, `update_source_offset`). The dock posts
   * `time_basis: "deployment"`, so whatever this function returns is what gets STORED —
   * and the export end applies `to_source()` including drift. Dropping `drift_ppm` here
   * therefore broke the round trip: a box drawn at source time `s` came back
   * `s * ppm/1e6` away from the pixels it was drawn on, in a Raven/BORIS file no reader
   * can tell is wrong. Same detrend as `SourceClock._detrend`: a device-reported elapsed
   * `t` is a true elapsed `t / (1 + ppm/1e6)`.
   */
  _driftPpm(source) {
    const ppm = Number((source && source.drift_ppm) || 0);
    return isFinite(ppm) ? ppm : 0;
  },

  _sourceToDeployment(source, tSource) {
    const ppm = this._driftPpm(source);
    const t = ppm ? Number(tSource) / (1 + ppm / 1e6) : Number(tSource);
    return t + Number((source && source.t0_offset_s) || 0);
  },

  _deploymentToSource(source, tDeployment) {
    const ppm = this._driftPpm(source);
    const t = Number(tDeployment) - Number((source && source.t0_offset_s) || 0);
    return ppm ? t * (1 + ppm / 1e6) : t;
  },

  // ══════════════════════════════════════════════════════════════════════
  // Tiles
  // ══════════════════════════════════════════════════════════════════════

  _tile(sourceId, tileIndex) {
    const key = `${sourceId}:${tileIndex}`;
    let img = this._tiles.get(key);
    if (img) {
      // Real LRU: touch on hit. As FIFO this evicted on-screen tiles once the working
      // set grew (12 CATS channel lanes x several tiles), and _drawSensorLane
      // re-requesting them inside the rAF loop becomes a per-frame request storm.
      const at = this._tileOrder.indexOf(key);
      if (at >= 0) { this._tileOrder.splice(at, 1); this._tileOrder.push(key); }
      return img;
    }

    img = new Image();
    img.decoding = "async";
    img.onload = () => { this._dirtyFrame = true; };
    img.onerror = () => { img._failed = true; };
    img.src = `/api/signals/sources/${sourceId}/tiles/${tileIndex}.png`;

    this._tiles.set(key, img);
    this._tileOrder.push(key);
    // Bounded cache: a multi-hour mooring would otherwise pin hundreds of decoded PNGs.
    while (this._tileOrder.length > this._maxTiles) {
      this._tiles.delete(this._tileOrder.shift());
    }
    return img;
  },

  // ══════════════════════════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════════════════════════

  _startRenderLoop() {
    const tick = () => {
      this._rafId = requestAnimationFrame(tick);
      const dock = document.getElementById("signal-dock");
      if (!dock || !dock.classList.contains("expanded")) return;

      if (this.follow) this._followPlayhead();
      if (this._dirtyFrame || this._playing()) this._render();
    };
    this._rafId = requestAnimationFrame(tick);
  },

  _playing() {
    const v = window.videoPlayer && window.videoPlayer.video;
    return !!(v && !v.paused && !v.ended);
  },

  /** Deployment-clock time of the video playhead, or null when there is no video source. */
  /**
   * The dock's current time on the deployment clock.
   *
   * Falls back to a dock-local cursor when there is no video. Two of the lab's three real
   * biologging deployments (Leopard Shark, Bat Ray) are accelerometer-only, and without
   * this `[` and `]` are dead keys, the playhead never draws, and interval labeling —
   * the entire point of F1 — is unreachable on them.
   */
  playheadS() {
    const src = this._videoSource();
    const v = window.videoPlayer && window.videoPlayer.video;
    if (src && v && isFinite(v.currentTime) && v.duration) {
      return this._sourceToDeployment(src, v.currentTime);
    }
    return this.cursorS;
  },

  /** Move the dock cursor (and the video, when there is one). */
  setCursor(tDeployment) {
    this.cursorS = tDeployment;
    this._seekTo(tDeployment);
    this._dirtyFrame = true;
  },

  _followPlayhead() {
    const t = this.playheadS();
    if (t == null) return;
    const margin = this.view.spanS * 0.1;
    if (t < this.view.startS + margin || t > this.view.startS + this.view.spanS - margin) {
      this.view.startS = t - this.view.spanS / 2;
      this._dirtyFrame = true;
    }
  },

  _render() {
    const canvas = document.getElementById("signal-canvas");
    const body = document.querySelector(".signal-dock-body");
    if (!canvas || !body) return;

    const dpr = window.devicePixelRatio || 1;
    const w = body.clientWidth;
    const h = body.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0b0d13";
    ctx.fillRect(0, 0, w, h);

    const lanes = this._layoutLanes(w, h);
    for (const lane of lanes) {
      if (lane.type === "waterfall") this._drawWaterfallLane(ctx, lane, w);
      else if (lane.type === "sensor") this._drawSensorLane(ctx, lane, w);
      else if (lane.type === "labels") this._drawLabelLane(ctx, lane, w);
    }
    this._drawRuler(ctx, w, h);
    this._drawPlayhead(ctx, w, h);
    this._drawDragPreview(ctx, w, h, lanes);

    ctx.restore();
    this._dirtyFrame = false;
  },

  _drawWaterfallLane(ctx, lane, w) {
    const s = lane.source;
    const grid = s.meta.grid;
    const render = s.meta.render || {};
    const tileFrames = render.tile_frames || 512;
    const nTiles = render.n_tiles || 0;
    const step = grid.seconds_per_frame;

    ctx.save();
    ctx.beginPath();
    ctx.rect(this.GUTTER, lane.top, w - this.GUTTER, lane.height);
    ctx.clip();

    // Visible frame range on this source, widened by half a frame at each edge so a
    // partially-visible column still paints.
    const viewEnd = this.view.startS + this.view.spanS;
    const fFrom = (this._deploymentToSource(s, this.view.startS) - grid.frame_time_offset_s) / step - 0.5;
    const fTo = (this._deploymentToSource(s, viewEnd) - grid.frame_time_offset_s) / step + 0.5;
    const tFrom = Math.max(0, Math.floor(fFrom / tileFrames));
    const tTo = Math.min(nTiles - 1, Math.floor(fTo / tileFrames));

    ctx.imageSmoothingEnabled = false;
    for (let ti = tFrom; ti <= tTo; ti++) {
      const img = this._tile(s.id, ti);
      if (!img.complete || img._failed || !img.naturalWidth) continue;
      const leftFrame = ti * tileFrames;
      // Column j covers [t_j - step/2, t_j + step/2), so the image's left edge sits half a
      // frame before frame `leftFrame`'s centre.
      // Through the clock helper, not `+ t0_offset_s`: these are source-clock times, and
      // painting them without the drift detrend would put the pixels somewhere the
      // labeler's own box coordinates do not agree with.
      const t0 = this._sourceToDeployment(s, grid.frame_time_offset_s + (leftFrame - 0.5) * step);
      const t1 = this._sourceToDeployment(s, grid.frame_time_offset_s + (leftFrame + tileFrames - 0.5) * step);
      const x0 = this._timeToX(t0, w);
      const x1 = this._timeToX(t1, w);
      if (x1 < this.GUTTER || x0 > w) continue;
      ctx.drawImage(img, x0, lane.top, Math.max(1, x1 - x0), lane.height);
    }
    ctx.restore();

    // Boxes belonging to this source
    for (const lab of this.labels) {
      if (lab.kind !== "box" || lab.source_id !== s.id) continue;
      this._drawBox(ctx, lab, grid, lane, w);
    }

    // Gutter: frequency axis + source name
    ctx.save();
    ctx.fillStyle = "#0f1117";
    ctx.fillRect(0, lane.top, this.GUTTER, lane.height);
    ctx.strokeStyle = "#2e3250";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.GUTTER + 0.5, lane.top);
    ctx.lineTo(this.GUTTER + 0.5, lane.top + lane.height);
    ctx.stroke();

    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px -apple-system, sans-serif";
    ctx.textAlign = "right";
    for (const frac of [0, 0.5, 1]) {
      const f = grid.freq_lo_hz + (grid.freq_hi_hz - grid.freq_lo_hz) * (1 - frac);
      const y = lane.top + frac * lane.height;
      const ty = Math.min(lane.top + lane.height - 2, Math.max(lane.top + 8, y + 3));
      ctx.fillText(this._fmtHz(f), this.GUTTER - 4, ty);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = "#6b7280";
    ctx.fillText(s.label || s.kind, 4, lane.top + 10);
    ctx.restore();
  },

  _drawBox(ctx, lab, grid, lane, w) {
    const x0 = this._timeToX(lab.t_start_s, w);
    const x1 = this._timeToX(lab.t_end_s, w);
    if (x1 < this.GUTTER || x0 > w) return;
    const y0 = this._freqToY(lab.f_hi_hz, grid, lane);
    const y1 = this._freqToY(lab.f_lo_hz, grid, lane);
    const selected = lab.id === this.selectedLabelId;
    const color = this._colorFor(lab.code);

    ctx.save();
    ctx.beginPath();
    ctx.rect(this.GUTTER, lane.top, w - this.GUTTER, lane.height);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.setLineDash(selected ? [] : [4, 2]);
    ctx.strokeRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
    ctx.setLineDash([]);
    ctx.fillStyle = color + "22";
    ctx.fillRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
    if (x1 - x0 > 26) {
      ctx.fillStyle = color;
      ctx.font = "9px -apple-system, sans-serif";
      ctx.fillText(lab.code, x0 + 2, Math.max(lane.top + 9, y0 - 2));
    }
    ctx.restore();
  },

  // ══════════════════════════════════════════════════════════════════════
  // Sensor lanes (F1)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Fetch one pyramid tile as a Float32Array of interleaved [min, max] pairs.
   *
   * The lattice hash is in the URL PATH. After a re-import the server publishes a new
   * hash, so a client still holding the old manifest 404s and refetches instead of
   * decoding new bytes against an old lattice — which would draw a trace wrong in both
   * value and time with no error anywhere.
   */
  _pyrTile(source, channel, level, tileIndex) {
    const hash = source.meta.lattice_hash;
    const key = `${channel.id}:${hash}:${level}:${tileIndex}`;
    const hit = this._pyr.get(key);
    if (hit !== undefined) {
      if (hit !== "pending") {
        const at = this._pyrOrder.indexOf(key);
        if (at >= 0) { this._pyrOrder.splice(at, 1); this._pyrOrder.push(key); }
      }
      return hit === "pending" ? null : hit;
    }
    // Mark in flight BEFORE awaiting: the rAF loop re-enters every frame, and without
    // this a single visible lane issues 60 identical requests a second and trips the
    // rate limiter within seconds.
    this._pyr.set(key, "pending");
    fetch(`/api/signals/channels/${channel.id}/pyramid/${hash}/${level}/${tileIndex}.bin`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => {
        this._pyr.set(key, new Float32Array(buf));
        this._pyrOrder.push(key);
        while (this._pyrOrder.length > this._maxPyr) this._pyr.delete(this._pyrOrder.shift());
        this._dirtyFrame = true;
      })
      .catch(() => { this._pyr.set(key, null); });
    return null;
  },

  /** Coarsest level giving at least one bin per pixel — bounds the bytes read at any zoom. */
  _chooseLevel(lat, spanS, px) {
    if (px <= 0 || spanS <= 0) return 0;
    const want = spanS / px;
    const ratio = lat.level_ratio || 4;
    for (let l = 0; l < lat.levels.length; l++) {
      if (lat.dt_s * Math.pow(ratio, l) >= want) return Math.max(0, l - 1);
    }
    return lat.levels.length - 1;
  },

  /** Deployment-clock time of a bin's left edge, honouring segment gaps. */
  _binTime(lat, source, binIndex) {
    for (const seg of lat.segments) {
      if (binIndex >= seg.bin_start && binIndex < seg.bin_start + seg.n_bins) {
        return this._sourceToDeployment(
          source, seg.t_start_s + (binIndex - seg.bin_start) * lat.dt_s);
      }
    }
    const last = lat.segments[lat.segments.length - 1];
    return this._sourceToDeployment(
      source, last.t_start_s + (binIndex - last.bin_start) * lat.dt_s);
  },

  _drawSensorLane(ctx, lane, w) {
    const s = lane.source;
    const ch = lane.channel;
    const lat = s.meta.lattice;
    const vLo = Number(ch.v_min), vHi = Number(ch.v_max);
    const span = (vHi - vLo) || 1;
    const yOf = (v) => lane.top + lane.height - 2 - ((v - vLo) / span) * (lane.height - 4);

    ctx.save();
    ctx.beginPath();
    ctx.rect(this.GUTTER, lane.top, w - this.GUTTER, lane.height);
    ctx.clip();

    // zero/mid reference line
    ctx.strokeStyle = "#1c2030";
    ctx.lineWidth = 1;
    const yRef = yOf(vLo <= 0 && vHi >= 0 ? 0 : (vLo + vHi) / 2);
    ctx.beginPath(); ctx.moveTo(this.GUTTER, yRef); ctx.lineTo(w, yRef); ctx.stroke();

    const px = Math.max(1, w - this.GUTTER);
    const level = this._chooseLevel(lat, this.view.spanS, px);
    const ratio = lat.level_ratio || 4;
    const decim = Math.pow(ratio, level);
    const dtL = lat.dt_s * decim;
    const nBinsL = lat.levels[level];
    const tileBins = lat.tile_bins;
    const viewEnd = this.view.startS + this.view.spanS;

    const color = ch.name === "odba_display" ? "#f59e0b"
      : /^acc/.test(ch.name) ? "#4a90d9"
      : /^mag/.test(ch.name) ? "#c084fc"
      : /^gyro/.test(ch.name) ? "#10b981"
      : ch.name === "Depth" ? "#22d3ee" : "#9ca3af";

    // Walk the visible bin range per segment, so a gap draws as a gap.
    ctx.strokeStyle = color;
    ctx.fillStyle = color + "88";
    for (const seg of lat.segments) {
      // Segment bounds live on the source's own clock; project them with the same helper
      // the labels use, so a drifting sensor's trace and its labels stay on one axis.
      const segT0 = this._sourceToDeployment(s, seg.t_start_s);
      const segT1 = this._sourceToDeployment(s, seg.t_start_s + seg.n_bins * lat.dt_s);
      if (segT1 < this.view.startS || segT0 > viewEnd) continue;

      // Bin indices are counted in source-clock dt_s, so clamp in source time.
      const binOf = (tDeployment) =>
        (this._deploymentToSource(s, tDeployment) - seg.t_start_s) / lat.dt_s + seg.bin_start;
      const b0 = Math.max(Math.floor(seg.bin_start / decim),
        Math.floor(binOf(Math.max(this.view.startS, segT0)) / decim));
      const b1 = Math.min(Math.ceil((seg.bin_start + seg.n_bins) / decim),
        Math.ceil(binOf(Math.min(viewEnd, segT1)) / decim));

      let started = false;
      ctx.beginPath();
      for (let b = b0; b < Math.min(b1, nBinsL); b++) {
        const ti = Math.floor(b / tileBins);
        const buf = this._pyrTile(s, ch, level, ti);
        if (!buf) { started = false; continue; }
        const k = (b - ti * tileBins) * 2;
        const mn = buf[k], mx = buf[k + 1];
        if (!isFinite(mn) || !isFinite(mx)) { started = false; continue; }
        const x = this._timeToX(this._binTime(lat, s, b * decim), w);
        const yA = yOf(mx), yB = yOf(mn);
        if (yB - yA < 1) {
          // Sub-pixel envelope: draw a line so a flat channel is still visible.
          if (!started) { ctx.moveTo(x, yA); started = true; } else ctx.lineTo(x, yA);
        } else {
          ctx.moveTo(x, yA); ctx.lineTo(x, yB); started = false;
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    // gutter: channel name + value range
    ctx.save();
    ctx.fillStyle = "#0f1117";
    ctx.fillRect(0, lane.top, this.GUTTER, lane.height);
    ctx.strokeStyle = "#2e3250";
    ctx.beginPath();
    ctx.moveTo(this.GUTTER + 0.5, lane.top);
    ctx.lineTo(this.GUTTER + 0.5, lane.top + lane.height);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "9px -apple-system, sans-serif";
    ctx.fillText(ch.name, 3, lane.top + 10);
    if (lane.height >= 30) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "8px -apple-system, sans-serif";
      ctx.fillText(`${this._fmtVal(vHi)}`, 3, lane.top + 20);
      ctx.fillText(`${this._fmtVal(vLo)} ${ch.unit || ""}`, 3, lane.top + lane.height - 3);
    }
    ctx.restore();
  },

  _fmtVal(v) {
    if (!isFinite(v)) return "–";
    const a = Math.abs(v);
    if (a >= 1000) return v.toExponential(1);
    if (a >= 10) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1);
    return v.toFixed(2);
  },

  _drawLabelLane(ctx, lane, w) {
    ctx.save();
    ctx.fillStyle = "#12151f";
    ctx.fillRect(0, lane.top, w, lane.height);
    ctx.strokeStyle = "#2e3250";
    ctx.beginPath();
    ctx.moveTo(0, lane.top + 0.5);
    ctx.lineTo(w, lane.top + 0.5);
    ctx.stroke();

    ctx.fillStyle = "#6b7280";
    ctx.font = "9px -apple-system, sans-serif";
    ctx.fillText("events", 4, lane.top + 12);

    ctx.beginPath();
    ctx.rect(this.GUTTER, lane.top, w - this.GUTTER, lane.height);
    ctx.clip();

    for (const lab of this.labels) {
      if (lab.kind === "box") continue;
      const x0 = this._timeToX(lab.t_start_s, w);
      const x1 = this._timeToX(lab.t_end_s, w);
      if (x1 < this.GUTTER - 4 || x0 > w) continue;
      const color = this._colorFor(lab.code);
      const selected = lab.id === this.selectedLabelId;

      if (lab.kind === "point") {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x0, lane.top + 6);
        ctx.lineTo(x0 + 4, lane.top + 13);
        ctx.lineTo(x0, lane.top + 20);
        ctx.lineTo(x0 - 4, lane.top + 13);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = color + (selected ? "cc" : "66");
        ctx.fillRect(x0, lane.top + 5, Math.max(3, x1 - x0), lane.height - 11);
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(x0, lane.top + 5, Math.max(3, x1 - x0), lane.height - 11);
        if (x1 - x0 > 30) {
          ctx.fillStyle = "#e8eaf0";
          ctx.font = "9px -apple-system, sans-serif";
          ctx.fillText(lab.code, x0 + 3, lane.top + 17);
        }
      }
    }

    // In-progress interval (after "[" and before "]")
    if (this._pendingInterval != null) {
      const x = this._timeToX(this._pendingInterval, w);
      const head = this.playheadS();
      const x2 = head == null ? x : this._timeToX(head, w);
      ctx.fillStyle = "#f59e0b44";
      ctx.fillRect(Math.min(x, x2), lane.top + 5, Math.abs(x2 - x), lane.height - 11);
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(x, x2), lane.top + 5, Math.abs(x2 - x), lane.height - 11);
    }
    ctx.restore();
  },

  _drawRuler(ctx, w, h) {
    const top = h - this.RULER_H;
    ctx.save();
    ctx.fillStyle = "#0f1117";
    ctx.fillRect(0, top, w, this.RULER_H);
    ctx.strokeStyle = "#2e3250";
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(w, top + 0.5);
    ctx.stroke();

    const stepS = this._niceStep(this.view.spanS);
    const first = Math.ceil(this.view.startS / stepS) * stepS;
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px -apple-system, sans-serif";
    ctx.textAlign = "left";
    for (let t = first; t < this.view.startS + this.view.spanS; t += stepS) {
      const x = this._timeToX(t, w);
      if (x < this.GUTTER) continue;
      ctx.strokeStyle = "#2e3250";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, top);
      ctx.lineTo(x + 0.5, top + 4);
      ctx.stroke();
      ctx.fillText(this._fmtTime(t), x + 2, top + 12);
    }
    ctx.restore();
  },

  _drawPlayhead(ctx, w, h) {
    const t = this.playheadS();
    if (t == null) return;
    const x = this._timeToX(t, w);
    if (x < this.GUTTER || x > w) return;
    ctx.save();
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h - this.RULER_H);
    ctx.stroke();
    ctx.restore();
  },

  _drawDragPreview(ctx, w, h, lanes) {
    const d = this._drag;
    if (!d || d.kind !== "box") return;
    // Match on identity KEY, not object identity: _layoutLanes() returns fresh objects
    // on every call, and the drag captured one from the mousedown-time array, so an
    // === comparison never matched and the rubber band was never drawn. (Saving always
    // worked, which is why the F0 browser check missed it.)
    const lane = lanes.find((l) => this._laneKey(l) === this._laneKey(d.lane));
    if (!lane) return;
    ctx.save();
    ctx.strokeStyle = "#4a90d9";
    ctx.setLineDash([4, 2]);
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.min(d.x0, d.x1),
      Math.min(d.y0, d.y1),
      Math.abs(d.x1 - d.x0),
      Math.abs(d.y1 - d.y0)
    );
    ctx.restore();
  },

  // ══════════════════════════════════════════════════════════════════════
  // Interaction
  // ══════════════════════════════════════════════════════════════════════

  _bindCanvas() {
    const canvas = document.getElementById("signal-canvas");
    const body = document.querySelector(".signal-dock-body");
    if (!canvas || !body) return;

    body.addEventListener("mouseenter", () => { this._pointerInDock = true; });
    body.addEventListener("mouseleave", () => { this._pointerInDock = false; });

    canvas.addEventListener("mousedown", (e) => this._onMouseDown(e));
    window.addEventListener("mousemove", (e) => this._onMouseMove(e));
    window.addEventListener("mouseup", (e) => this._onMouseUp(e));
    canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  },

  _canvasPos(e) {
    const canvas = document.getElementById("signal-canvas");
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  },

  _onMouseDown(e) {
    if (!this.deployment) return;
    const p = this._canvasPos(e);
    const lanes = this._layoutLanes(p.w, p.h);

    // Ruler → scrub the video.
    if (p.y > p.h - this.RULER_H) {
      this.setCursor(this._xToTime(p.x, p.w));
      return;
    }

    const lane = lanes.find((l) => p.y >= l.top && p.y < l.top + l.height);
    if (!lane) return;

    if (lane.type === "labels") {
      const hit = this._hitTestEvent(p);
      this.selectedLabelId = hit ? hit.id : null;
      this._renderLabelList();
      this._dirtyFrame = true;
      return;
    }

    if (lane.type === "waterfall" && this.mode === "box" && p.x > this.GUTTER) {
      if (!this.activeCode) {
        this._hint("Pick a label type in the Signals tab first.");
        return;
      }
      this._drag = { kind: "box", lane, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      return;
    }

    // Browse: click selects a box, drag pans.
    const hit = this._hitTestBox(p, lane);
    if (hit) {
      this.selectedLabelId = hit.id;
      this._renderLabelList();
      this._dirtyFrame = true;
      return;
    }
    this._drag = { kind: "pan", x0: p.x, startS: this.view.startS };
  },

  _onMouseMove(e) {
    if (!this._drag) return;
    const p = this._canvasPos(e);
    if (this._drag.kind === "box") {
      this._drag.x1 = p.x;
      this._drag.y1 = p.y;
    } else if (this._drag.kind === "pan") {
      const dt = ((p.x - this._drag.x0) / this._plotWidth(p.w)) * this.view.spanS;
      this.view.startS = this._drag.startS - dt;
      this.follow = false;
    }
    this._dirtyFrame = true;
  },

  async _onMouseUp(e) {
    const d = this._drag;
    this._drag = null;
    if (!d || d.kind !== "box") return;

    const p = this._canvasPos(e);
    const lane = d.lane;
    const grid = lane.source && lane.source.meta && lane.source.meta.grid;
    if (!grid) { this._dirtyFrame = true; return; }

    const t0 = this._xToTime(Math.min(d.x0, d.x1), p.w);
    const t1 = this._xToTime(Math.max(d.x0, d.x1), p.w);
    const fHi = this._yToFreq(Math.min(d.y0, d.y1), grid, lane);
    const fLo = this._yToFreq(Math.max(d.y0, d.y1), grid, lane);

    // A 3px twitch is a misclick, not a selection.
    if (Math.abs(d.x1 - d.x0) < 3 || Math.abs(d.y1 - d.y0) < 3) {
      this._dirtyFrame = true;
      return;
    }

    try {
      const res = await this._post(`/api/signals/deployments/${this.deployment.id}/labels`, {
        kind: "box",
        source_id: lane.source.id,
        time_basis: "deployment",
        t_start_s: t0,
        t_end_s: t1,
        f_lo_hz: Math.max(0, fLo),
        f_hi_hz: fHi,
        code: this.activeCode,
        vocab_id: this.activeVocabId,
        confidence: this.confidence,
      });
      this.labels.push(res.label);
      this.selectedLabelId = res.label.id;
      this._renderLabelList();
      this._hint(`Saved ${res.label.code} · ${this._fmtDur(t1 - t0)} · ${this._fmtHz(fLo)}–${this._fmtHz(fHi)}`);
    } catch (err) {
      this._hint(`Save failed: ${err.message}`);
    }
    this._dirtyFrame = true;
  },

  _onWheel(e) {
    if (!this.deployment) return;
    e.preventDefault();
    const p = this._canvasPos(e);

    if (e.shiftKey) {
      this.view.startS += (e.deltaY / this._plotWidth(p.w)) * this.view.spanS;
      this.follow = false;
    } else {
      // Zoom about the cursor so the thing under the pointer stays put.
      const anchor = this._xToTime(p.x, p.w);
      const factor = Math.exp(e.deltaY * 0.0015);
      const total = this.duration.endS - this.duration.startS;
      const newSpan = Math.min(Math.max(this.view.spanS * factor, 0.02), Math.max(total, 1));
      this.view.startS = anchor - ((anchor - this.view.startS) * newSpan) / this.view.spanS;
      this.view.spanS = newSpan;
    }
    this._dirtyFrame = true;
  },

  _hitTestBox(p, lane) {
    if (lane.type !== "waterfall") return null;
    const grid = lane.source.meta.grid;
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const lab = this.labels[i];
      if (lab.kind !== "box" || lab.source_id !== lane.source.id) continue;
      const x0 = this._timeToX(lab.t_start_s, p.w);
      const x1 = this._timeToX(lab.t_end_s, p.w);
      const y0 = this._freqToY(lab.f_hi_hz, grid, lane);
      const y1 = this._freqToY(lab.f_lo_hz, grid, lane);
      if (p.x >= x0 - 2 && p.x <= x1 + 2 && p.y >= y0 - 2 && p.y <= y1 + 2) return lab;
    }
    return null;
  },

  _hitTestEvent(p) {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const lab = this.labels[i];
      if (lab.kind === "box") continue;
      const x0 = this._timeToX(lab.t_start_s, p.w);
      const x1 = this._timeToX(lab.t_end_s, p.w);
      if (p.x >= x0 - 4 && p.x <= x1 + 4) return lab;
    }
    return null;
  },

  _seekTo(tDeployment) {
    const src = this._videoSource();
    const v = window.videoPlayer && window.videoPlayer.video;
    if (!src || !v) return;
    const tSource = this._deploymentToSource(src, tDeployment);
    if (isFinite(tSource) && isFinite(v.duration)) {
      v.currentTime = Math.min(Math.max(tSource, 0), v.duration);
    }
  },

  // ══════════════════════════════════════════════════════════════════════
  // Keyboard
  // ══════════════════════════════════════════════════════════════════════

  _bindKeys() {
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // "\" always toggles the dock; the rest need the dock open.
      if (e.key === "\\") {
        e.preventDefault();
        this.toggleDock();
        return;
      }
      const dock = document.getElementById("signal-dock");
      if (!dock || !dock.classList.contains("expanded")) return;

      switch (e.key) {
        case "w":
        case "W":
          e.preventDefault();
          this.setMode(this.mode === "box" ? "browse" : "box");
          break;
        case "[":
          e.preventDefault();
          this._startInterval();
          break;
        case "]":
          e.preventDefault();
          this._endInterval();
          break;
        case "Delete":
        case "Backspace":
          if (this.selectedLabelId != null) {
            e.preventDefault();
            this.deleteLabel(this.selectedLabelId);
          }
          break;
        case "Escape":
          if (this._pendingInterval != null || this.mode !== "browse") {
            e.preventDefault();
            this._pendingInterval = null;
            this.setMode("browse");
          }
          break;
        default:
          // Term hotkeys only while the pointer is over the dock, so 1–5 keeps meaning
          // "scar confidence" everywhere else in the app.
          if (this._pointerInDock && /^[0-9]$/.test(e.key)) {
            const vocab = this._activeVocab();
            const term = (vocab?.terms || []).find((t) => t.hotkey === e.key);
            if (term) {
              e.preventDefault();
              this.selectTerm(term.code);
            }
          }
      }
    });
  },

  _startInterval() {
    const t = this.playheadS();
    if (t == null) {
      // Only reachable before the cursor has ever been placed.
      this._hint("Click the time ruler to place the cursor, then press [ again.");
      return;
    }
    if (!this.activeCode) {
      this._hint("Pick a label type in the Signals tab first.");
      return;
    }
    this._pendingInterval = t;
    this._hint(`Interval open at ${this._fmtTime(t)} — press ] to close it.`);
    this._dirtyFrame = true;
  },

  async _endInterval() {
    if (this._pendingInterval == null) {
      this._hint("Press [ first to open an interval.");
      return;
    }
    const t0 = this._pendingInterval;
    const t1 = this.playheadS();
    this._pendingInterval = null;
    if (t1 == null || Math.abs(t1 - t0) < 1e-6) {
      this._hint("Interval had no duration — discarded.");
      this._dirtyFrame = true;
      return;
    }

    try {
      const res = await this._post(`/api/signals/deployments/${this.deployment.id}/labels`, {
        kind: "interval",
        source_id: (this._videoSource() || this.sources.find((x) => x.kind === "sensor") || {}).id,
        time_basis: "deployment",
        t_start_s: Math.min(t0, t1),
        t_end_s: Math.max(t0, t1),
        code: this.activeCode,
        vocab_id: this.activeVocabId,
        confidence: this.confidence,
      });
      this.labels.push(res.label);
      this.selectedLabelId = res.label.id;
      this._renderLabelList();
      this._hint(`Saved ${res.label.code} · ${this._fmtDur(Math.abs(t1 - t0))}`);
    } catch (err) {
      this._hint(`Save failed: ${err.message}`);
    }
    this._dirtyFrame = true;
  },

  // ══════════════════════════════════════════════════════════════════════
  // Dock chrome
  // ══════════════════════════════════════════════════════════════════════

  _bindDock() {
    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };

    on("signal-dock-toggle", "click", () => this.toggleDock());
    on("signal-deployment", "change", async (e) => {
      try {
        await this.loadDeployment(e.target.value ? +e.target.value : null);
      } catch (err) {
        this._hint(`Load failed: ${err.message}`);
      }
    });
    on("signal-mode-box", "click", () => this.setMode(this.mode === "box" ? "browse" : "box"));
    on("signal-fit", "click", () => this.fitAll());
    on("signal-follow", "click", () => {
      this.follow = !this.follow;
      document.getElementById("signal-follow")?.classList.toggle("active", this.follow);
      this._dirtyFrame = true;
    });
    on("signal-lanes-btn", "click", (e) => this._toggleLanePopover(e));
    on("signal-layout", "click", () => {
      this.layout = this.layout === "below" ? "beside" : "below";
      this._applyLayout();
    });

    // Drag-to-resize
    const grip = document.querySelector(".signal-dock-grip");
    const dock = document.getElementById("signal-dock");
    if (grip && dock) {
      let start = null;
      grip.addEventListener("mousedown", (e) => {
        start = { y: e.clientY, h: dock.getBoundingClientRect().height };
        e.preventDefault();
      });
      window.addEventListener("mousemove", (e) => {
        if (!start) return;
        const h = Math.min(Math.max(start.h - (e.clientY - start.y), 120), window.innerHeight * 0.7);
        dock.style.height = h + "px";
        this._dirtyFrame = true;
      });
      window.addEventListener("mouseup", () => { start = null; });
    }

    document.addEventListener("click", (e) => {
      const pop = document.getElementById("signal-lanes-pop");
      if (pop && !pop.classList.contains("hidden")) {
        if (!pop.contains(e.target) && e.target.id !== "signal-lanes-btn") pop.classList.add("hidden");
      }
    });

    window.addEventListener("resize", () => { this._dirtyFrame = true; });

    // The right-panel tab button needs no handler here: AppState._bindPanelTabs()
    // already binds every `.panel-right .tab-btn` generically off its data-tab, and
    // _switchPanelTab keeps _activeTab in sync. Adding a second handler would fight it.
    on("signal-confidence", "change", (e) => { this.confidence = +e.target.value; });
  },

  toggleDock() {
    const dock = document.getElementById("signal-dock");
    if (!dock) return;
    const expanded = dock.classList.toggle("expanded");
    const btn = document.getElementById("signal-dock-toggle");
    if (btn) btn.textContent = expanded ? "▼ Signals" : "▲ Signals";
    this._dirtyFrame = true;
  },

  _applyLayout() {
    const center = document.querySelector(".panel-center");
    const dock = document.getElementById("signal-dock");
    const beside = this.layout === "beside";
    if (center) center.classList.toggle("signals-beside", beside);

    // The resize grip writes an inline height. Inline beats the stylesheet, so leaving it
    // set would pin the dock to a fixed height in the beside layout, where it should fill
    // the grid column. Stash it on the way out and restore it on the way back.
    if (dock) {
      if (beside) {
        if (dock.style.height) this._belowHeight = dock.style.height;
        dock.style.height = "";
      } else if (this._belowHeight) {
        dock.style.height = this._belowHeight;
      }
    }

    const btn = document.getElementById("signal-layout");
    if (btn) btn.textContent = beside ? "◧ Beside" : "▤ Below";
    this._dirtyFrame = true;
  },

  setMode(mode) {
    this.mode = mode;
    document.getElementById("signal-mode-box")?.classList.toggle("active", mode === "box");
    const canvas = document.getElementById("signal-canvas");
    if (canvas) canvas.style.cursor = mode === "box" ? "crosshair" : "grab";
    this._hint(this._modeHint());
  },

  fitAll() {
    this.view.startS = this.duration.startS;
    this.view.spanS = Math.max(1, this.duration.endS - this.duration.startS);
    this._dirtyFrame = true;
  },

  _toggleLanePopover(e) {
    const pop = document.getElementById("signal-lanes-pop");
    if (!pop) return;
    if (!pop.classList.contains("hidden")) {
      pop.classList.add("hidden");
      return;
    }
    pop.innerHTML = "";
    const row = (checked, text, onToggle, indent) => {
      const lab = document.createElement("label");
      if (indent) lab.style.paddingLeft = "14px";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = checked;
      cb.addEventListener("change", () => { onToggle(cb.checked); this._dirtyFrame = true; });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(text));
      pop.appendChild(lab);
    };

    const wf = this.sources.filter((s) => s.kind === "audio" || s.kind === "rf");
    const sensors = this.sources.filter((s) => s.kind === "sensor" && (s.channels || []).length);
    if (!wf.length && !sensors.length) {
      pop.textContent = "No waterfall or sensor lanes on this deployment.";
    }
    for (const s of wf) {
      row(!this._hiddenSources.has(s.id), s.label || `${s.kind} #${s.id}`,
        (on) => (on ? this._hiddenSources.delete(s.id) : this._hiddenSources.add(s.id)));
    }
    // Channel-level toggles: a CATS source carries 12+ channels and nobody wants all of
    // them at once, so visibility is keyed per channel, not per source.
    for (const s of sensors) {
      row(!this._hiddenSources.has(s.id), s.label || `sensor #${s.id}`,
        (on) => (on ? this._hiddenSources.delete(s.id) : this._hiddenSources.add(s.id)));
      for (const c of s.channels) {
        row(!this._hiddenChannels.has(c.id), `${c.name}${c.unit ? " (" + c.unit + ")" : ""}`,
          (on) => (on ? this._hiddenChannels.delete(c.id) : this._hiddenChannels.add(c.id)), true);
      }
    }
    const r = e.target.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left) + "px";
    pop.style.top = r.bottom + 4 + "px";
    pop.classList.remove("hidden");
  },

  // ══════════════════════════════════════════════════════════════════════
  // Right-panel Signals tab
  // ══════════════════════════════════════════════════════════════════════

  _activeVocab() {
    return this.vocabularies.find((v) => v.id === this.activeVocabId) || null;
  },

  _renderTermList() {
    const wrap = document.getElementById("signal-terms");
    const sel = document.getElementById("signal-vocab");
    if (!wrap || !sel) return;

    sel.innerHTML = "";
    for (const v of this.vocabularies) {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = `${v.name} (${v.kind})`;
      if (v.id === this.activeVocabId) o.selected = true;
      sel.appendChild(o);
    }
    if (!sel._bound) {
      sel.addEventListener("change", (e) => {
        this.activeVocabId = +e.target.value;
        const v = this._activeVocab();
        this.activeCode = v && v.terms.length ? v.terms[0].code : null;
        this._renderTermList();
      });
      sel._bound = true;
    }

    const vocab = this._activeVocab();
    wrap.innerHTML = "";
    const terms = (vocab && vocab.terms) || [];
    if (!terms.length) {
      const p = document.createElement("div");
      p.className = "muted";
      p.style.fontSize = "11px";
      p.textContent = vocab
        ? "This vocabulary has no terms yet — add them under signals.vocabularies in config.yaml."
        : "No vocabularies configured.";
      wrap.appendChild(p);
      return;
    }
    for (const t of terms) {
      const b = document.createElement("button");
      b.className = "signal-term" + (t.code === this.activeCode ? " active" : "");
      b.type = "button";
      const dot = document.createElement("span");
      dot.className = "dot";
      if (t.color) dot.style.background = t.color;
      b.appendChild(dot);
      b.appendChild(document.createTextNode(t.display || t.code));
      if (t.hotkey) {
        const hk = document.createElement("span");
        hk.className = "hk";
        hk.textContent = t.hotkey;
        b.appendChild(hk);
      }
      b.addEventListener("click", () => this.selectTerm(t.code));
      wrap.appendChild(b);
    }
  },

  selectTerm(code) {
    this.activeCode = code;
    this._renderTermList();
    this._hint(`Label type: ${code}`);
  },

  _renderLabelList() {
    const wrap = document.getElementById("signal-labels");
    const count = document.getElementById("signal-label-count");
    if (!wrap) return;
    if (count) count.textContent = String(this.labels.length);

    wrap.innerHTML = "";
    const sorted = [...this.labels].sort((a, b) => a.t_start_s - b.t_start_s);
    for (const lab of sorted) {
      const row = document.createElement("div");
      row.className = "signal-label-row" + (lab.id === this.selectedLabelId ? " selected" : "");

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${this._colorFor(lab.code)};flex-shrink:0;`;
      row.appendChild(dot);

      const main = document.createElement("span");
      main.className = "grow";
      main.textContent = lab.code;
      row.appendChild(main);

      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent =
        lab.kind === "box"
          ? `${this._fmtTime(lab.t_start_s)} · ${this._fmtHz(lab.f_lo_hz)}–${this._fmtHz(lab.f_hi_hz)}`
          : `${this._fmtTime(lab.t_start_s)} · ${this._fmtDur(lab.t_end_s - lab.t_start_s)}`;
      row.appendChild(meta);

      const del = document.createElement("button");
      del.className = "del";
      del.type = "button";
      del.textContent = "×";
      del.title = "Delete label";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteLabel(lab.id);
      });
      row.appendChild(del);

      row.addEventListener("click", () => {
        this.selectedLabelId = lab.id;
        this.view.startS = lab.t_start_s - this.view.spanS / 2;
        this.follow = false;
        this.setCursor(lab.t_start_s);
        this._renderLabelList();
        this._dirtyFrame = true;
      });
      wrap.appendChild(row);
    }
  },

  async deleteLabel(id) {
    try {
      await this._del(`/api/signals/labels/${id}`);
      this.labels = this.labels.filter((l) => l.id !== id);
      if (this.selectedLabelId === id) this.selectedLabelId = null;
      this._renderLabelList();
      this._dirtyFrame = true;
      this._hint("Label deleted.");
    } catch (err) {
      this._hint(`Delete failed: ${err.message}`);
    }
  },

  // ══════════════════════════════════════════════════════════════════════
  // Small helpers
  // ══════════════════════════════════════════════════════════════════════

  _modeHint() {
    if (this.mode === "box") return "Drag on the waterfall to box a sound. W exits.";
    return "W: box mode · [ ] : interval · \\ : dock · wheel: zoom · shift+wheel: pan";
  },

  _hint(text) {
    const el = document.getElementById("signal-hint");
    if (el) el.textContent = text || "";
  },

  _setEmpty(text) {
    const el = document.getElementById("signal-empty");
    if (!el) return;
    el.textContent = text || "";
    el.style.display = text ? "flex" : "none";
  },

  _colorFor(code) {
    for (const v of this.vocabularies) {
      const t = (v.terms || []).find((x) => x.code === code);
      if (t && t.color) return t.color;
    }
    return "#4a90d9";
  },

  _niceStep(spanS) {
    const target = spanS / 8;
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    return steps.find((s) => s >= target) || 3600;
  },

  _fmtTime(s) {
    const neg = s < 0;
    s = Math.abs(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const body =
      h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(sec < 10 ? 2 : 1).padStart(4, "0")}`
        : `${m}:${sec.toFixed(sec < 10 ? 2 : 1).padStart(4, "0")}`;
    return (neg ? "-" : "") + body;
  },

  _fmtDur(s) {
    if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
    if (s < 60) return `${s.toFixed(2)} s`;
    return this._fmtTime(s);
  },

  _fmtHz(f) {
    if (!isFinite(f)) return "–";
    if (Math.abs(f) >= 1e6) return `${(f / 1e6).toFixed(3)} MHz`;
    if (Math.abs(f) >= 1000) return `${(f / 1000).toFixed(1)} kHz`;
    return `${f.toFixed(0)} Hz`;
  },

  // Minimal fetch helpers. Mirrors app.js's API wrapper (including the X-Requested-With
  // CSRF header the backend requires on mutating /api/* calls) without depending on it.
  async _json(r) {
    if (r.status === 401) {
      window.appState?._showLogin?.();
      throw new Error("Session expired — please sign in again");
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${r.status})`);
    }
    return r.json();
  },
  async _get(url) {
    return this._json(await fetch(url));
  },
  async _post(url, body) {
    return this._json(
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(body),
      })
    );
  },
  async _del(url) {
    return this._json(
      await fetch(url, { method: "DELETE", headers: { "X-Requested-With": "XMLHttpRequest" } })
    );
  },
};

document.addEventListener("DOMContentLoaded", () => Signals.init());
window.Signals = Signals;
