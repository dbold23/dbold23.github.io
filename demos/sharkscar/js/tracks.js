/**
 * tracks.js — Phase 1 SAM2 video propagation UI (minimum viable).
 *
 * Self-contained: registers no global side effects beyond `window.Tracks`.
 * Hidden entirely if /api/tracks/health reports unavailable.
 *
 * Flow:
 *   1. User draws a scar bbox using the existing scar mode.
 *   2. Clicks "🎯 Track this scar" → POST /api/tracks/propagate (returns 202 + track_id).
 *   3. Modal opens, polls /api/tracks/<id>/status with exponential backoff.
 *   4. On done, modal shows best-frame thumbnail + auto-color suggestion + scar-type select.
 *   5. Verify or Reject → POST /api/tracks/<id>/{verify,reject}.
 *
 * Defers full triage UI to Phase 3 per the plan.
 */
"use strict";

/** Every request from this file goes through here.
 *
 * tracks.js hand-wrote 19 `fetch` calls and not one of them looked at 401, so a
 * session that expired mid-triage surfaced as `reject failed: 401` in a toast and
 * left the labeler on a card they could not submit and could not escape. app.js's
 * shared `API` wrapper has always handled this; this file simply never used it.
 *
 * It deliberately returns the RAW Response instead of parsed JSON. The 19 call
 * sites each have their own `.ok` handling and error-body reading that is worth
 * keeping, and converting them all to throw-on-error would be a far larger change
 * than the defect justifies. The one thing they all lacked is the one thing this
 * adds.
 */
async function _tfetch(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) {
    window.appState?._showLogin?.();
    throw new Error("Session expired — please sign in again");
  }
  return r;
}

const Tracks = {
  available: false,
  reason: "",
  pollTimer: null,
  currentTrackId: null,
  // Polish 7 — fullscreen triage state lives on this._triage; see _enterTriageMode

  async init() {
    // Health gate — silent if unavailable
    try {
      const h = await _tfetch("/api/tracks/health").then(r => r.json());
      this.available = !!h.available;
      // Explicit opt-in, default false. Never infer "hide the scar form" from
      // mere tracker availability — see _applyLayout for what that cost.
      this.simplifyScarForm = h.simplify_scar_form === true;
      this.reason = h.reason || "";
    } catch (e) {
      this.available = false;
      this.reason = "health check failed";
    }
    const panel = document.getElementById("tracks-panel");
    if (!panel) return;
    if (!this.available) {
      panel.style.display = "none";
      console.info("[Tracks] feature gated off:", this.reason);
      return;
    }
    panel.style.display = "";
    this._bindButton();
    this._bindEscape();
    this._bindOverlayToggle();
    this._applyLayout();  // apply initial visibility (may already have a video loaded)
    // Re-apply layout + track list whenever the current video changes.
    // AppState.currentVideo isn't an observable, so poll every 400ms — cheap.
    this._lastVideoId = null;
    setInterval(() => {
      const v = this._currentVideo();
      const id = v?.id || null;
      if (id !== this._lastVideoId) {
        this._lastVideoId = id;
        this._applyLayout();
        this._refresh();  // also refreshes canvas overlays via _refresh()
      }
    }, 400);
  },

  // ──────────── Polish 6 — canvas overlay cache ────────────────────

  _bindOverlayToggle() {
    const cb = document.getElementById("track-overlay-toggle");
    if (!cb) return;
    // Restore from localStorage (default: on)
    const saved = localStorage.getItem("trackOverlaysEnabled");
    const enabled = saved === null ? true : (saved === "true");
    cb.checked = enabled;
    if (window.annotCanvas) window.annotCanvas.showTrackOverlays = enabled;
    cb.addEventListener("change", () => {
      localStorage.setItem("trackOverlaysEnabled", String(cb.checked));
      if (window.annotCanvas) window.annotCanvas.showTrackOverlays = cb.checked;
    });
  },

  /** Fetch all live tracks' per-frame bbox maps for the current video and
   * stash on window.appState.canvasOverlays for canvas.js to render against.
   * Idempotent + cheap to over-call. */
  async _refreshCanvasOverlays() {
    const video = this._currentVideo();
    if (!window.appState) return;
    if (!video) {
      window.appState.canvasOverlays = null;
      return;
    }
    try {
      const res = await _tfetch(`/api/tracks/video/${encodeURIComponent(video.id)}/detections-by-frame`)
        .then(r => r.json());
      const tracks = res.tracks || [];
      // Build O(1)-lookup Map: frame_number → array of {track_id, bbox, status, scar_type, ...}
      const byFrame = new Map();
      for (const t of tracks) {
        for (const [fnStr, bbox] of Object.entries(t.frames || {})) {
          const fn = parseInt(fnStr, 10);
          if (!byFrame.has(fn)) byFrame.set(fn, []);
          byFrame.get(fn).push({
            track_id: t.track_id,
            bbox,
            status: t.status,
            scar_type: t.scar_type,
            human_color: t.human_color,
            auto_color: t.auto_color,
            human_zone: t.human_zone,
            is_gold: t.is_gold,
          });
        }
      }
      // Real fps from cv2 (server-side). The HTML5 video element falls back to
      // 30fps for any video where videoTracks API isn't supported, so frame
      // numbers from videoPlayer.currentFrame() are wrong on a 59.94fps video.
      // Canvas overlay lookups must use realFps × video.currentTime.
      window.appState.canvasOverlays = { tracks, byFrame, realFps: res.fps || null };
    } catch (e) {
      console.warn("[Tracks] canvas overlay fetch failed:", e);
    }
  },

  /**
   * Optionally simplify the right sidebar for the tracks workflow.
   *
   * Hides the legacy per-frame scar form ONLY when the server explicitly opts in
   * via tracks.simplify_scar_form (default false), a video is loaded, and it is
   * video media.
   *
   * WHY THE EXTRA CONDITION (plan-11 audit): this used to gate on `this.available`
   * alone. `available` comes from /api/tracks/health, which for the default bbox
   * tracker called is_available() — a function that returns (True, "")
   * unconditionally, because the bbox tracker needs nothing but opencv. So
   * `simplify` was true on every video for every student, and the scar form, the
   * "Scars visible" radio and the no-scars save path were hidden in production by
   * default. The corpus shows the cost: 61 scars against 1,815 keypoints (30:1),
   * and scars_visible left blank on 389 of 440 saves — so the absence signal that
   * becomes dwc:occurrenceStatus=absent was never captured once.
   *
   * The "Advanced: classic form" expander below is the escape hatch that kept this
   * from being a total outage. It is retained, but it is no longer load-bearing.
   */
  _applyLayout() {
    const video = this._currentVideo();
    const isVideoMedia = video && video.media_type === "video";
    const simplify = this.available && this.simplifyScarForm && isVideoMedia;

    const toHide = [
      document.getElementById("scar-form-section"),
      document.getElementById("no-scars-msg"),
    ];
    // Find the "Scars visible" radio group inside the scars tab
    const scarsVisibleGroup = document.querySelector('#tab-scars .radio-group');
    if (scarsVisibleGroup) toHide.push(scarsVisibleGroup);

    toHide.forEach(el => {
      if (!el) return;
      if (simplify) {
        if (!el.dataset.origDisplay) el.dataset.origDisplay = el.style.display || "";
        el.style.display = "none";
      } else {
        if (el.dataset.origDisplay !== undefined) el.style.display = el.dataset.origDisplay;
      }
    });

    // Inject (or remove) the "Advanced: classic form" escape hatch
    this._ensureClassicToggle(simplify);
  },

  _ensureClassicToggle(shouldShow) {
    let toggle = document.getElementById("tracks-classic-toggle");
    if (!shouldShow) {
      toggle?.remove();
      return;
    }
    if (toggle) return; // already present
    const panel = document.getElementById("tracks-panel");
    if (!panel) return;
    toggle = document.createElement("details");
    toggle.id = "tracks-classic-toggle";
    toggle.style.cssText = "margin-top:10px;font-size:11px;color:#888;";
    toggle.innerHTML = `
      <summary style="cursor:pointer;color:#888;">Advanced: show classic per-frame form</summary>
      <div style="margin-top:6px;padding:6px;background:#1a1a22;border-radius:4px;">
        Unhides the legacy per-frame scar form + "Scars visible" radio. Use only if you need
        to make edits that don't fit the track workflow.
        <button id="tracks-classic-unhide" class="btn btn-sm btn-ghost" style="margin-top:6px;">Show classic form</button>
      </div>
    `;
    panel.appendChild(toggle);
    document.getElementById("tracks-classic-unhide")?.addEventListener("click", () => {
      document.querySelectorAll('#scar-form-section, #no-scars-msg, #tab-scars .radio-group')
        .forEach(el => { el.style.display = ""; el.dataset.origDisplay = ""; });
      toggle.remove();
    });
  },

  _bindButton() {
    const btn = document.getElementById("btn-track-scar");
    if (!btn) return;
    btn.addEventListener("click", () => this._onTrackClick());
    document.getElementById("btn-tracks-refresh")?.addEventListener("click", () => this._refresh());

    // Polish 7 — open fullscreen triage card mode
    document.getElementById("btn-triage-mode")?.addEventListener("click", () => this._enterTriageMode());

    // Triage-mode keyboard shortcuts (a/r/e/s + arrows + j/k + Esc + n).
    // Only fire when the triage overlay is visible AND focus isn't in an input.
    document.addEventListener("keydown", (e) => {
      const overlay = document.getElementById("triage-mode");
      if (!overlay || overlay.style.display === "none") return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const seedMode = overlay.dataset.mode === "seed";
      // Esc always exits — seed mode falls back to review, review exits overlay.
      if (e.key === "Escape") {
        e.preventDefault();
        return seedMode ? this._exitSeedMode() : this._exitTriageMode();
      }
      // In seed mode only Enter (propagate) and `c` (clear) are meaningful.
      if (seedMode) {
        if (e.key === "Enter") { e.preventDefault(); return this._propagateSeed(); }
        if (e.key === "c")     { e.preventDefault(); return this._clearSeedBbox(); }
        return;
      }
      switch (e.key) {
        case "a": case "ArrowRight": e.preventDefault(); return this._triageAct("accept");
        case "r": case "x": case "ArrowLeft": e.preventDefault(); return this._triageAct("reject");
        case "e": case "ArrowUp":    e.preventDefault(); return this._triageAct("edit");
        case "s": case " ": case "ArrowDown": e.preventDefault(); return this._triageAct("skip");
        case "j":           e.preventDefault(); return this._triageNext();
        case "k":           e.preventDefault(); return this._triagePrev();
        case "n":           e.preventDefault(); return this._enterSeedMode();
      }
    });
  },

  /** Refresh the list + canvas overlays. Triage mode has its own queue
   * lifecycle and is not tied to this refresh. */
  _refresh() {
    this._refreshCanvasOverlays();  // fire-and-forget; canvas reads when ready
    return this._refreshList();
  },

  _bindEscape() {
    // Esc while in the "click a pixel inside the scar" step → skip the click
    // and propagate with bbox-only. Doesn't interfere with other Esc handlers.
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (this._pendingSeed && window.annotCanvas?.mode === "track_point") {
        e.stopPropagation();
        this.onSeedPointSkipped();
      }
    }, true);  // useCapture so we see it before other handlers
  },

  _currentVideo() {
    return window.appState?.currentVideo || null;
  },

  _onTrackClick() {
    const video = this._currentVideo();
    if (!video) return this._toast("Load a video first");
    if (video.media_type === "image") return this._toast("Following a scar only works on videos, not single images");

    // Enter dedicated seed-bbox draw mode — no form required, no "+ ADD SCAR" step.
    // The canvas's mouseup handler will call Tracks.onSeedBboxDrawn() when the user
    // finishes drawing the bbox.
    window.annotCanvas.setMode("track_seed");
    this._toast("Draw one box around the scar — the app will follow it across the clip so you verify instead of redraw.");
  },

  /** Which frame is actually on the canvas, and how do we say so exactly?
   *
   *  This used to read the <video> element and nothing else. On fed-queue work that
   *  element is hidden — and could not help if it were not, because every 4K clip in
   *  this corpus is HEVC and Chrome refuses to decode it. The canvas is painted by
   *  the server-decoded frame strip (FrameContext) instead, so both numbers the old
   *  code read came from a dead element. Measured live with frame 45 on screen:
   *
   *      videoPlayer.currentFrame()    -> 1        (what was sent)
   *      videoPlayer.video.currentTime -> 0.0167   (what was sent)
   *      FrameContext.isActive()       -> true
   *      WorkQueue.items[0].frame_number -> 45     (what was on screen)
   *
   *  The seed landed on frame 0: track id=2 in the catalog has frame_count=2 with
   *  detections only at frames 0 and 1 — the tracker latched onto open water and
   *  lost the template on the next frame. Track id=1, seeded from the ordinary video
   *  path, has 121 detections across frames 90–210 and is fine.
   *
   *  So ask whatever is painting the pixels, in that order, and REFUSE if nothing
   *  can answer. A wrong seed frame does not produce a degraded track; it produces a
   *  track about different pixels that still looks real, exports, and gets verified.
   *
   *  Returns {frame_number} | {time_sec} | {error}. A server-decoded index is EXACT,
   *  so it travels as a frame number with no time beside it (the route lets
   *  seed_time_sec win, which would put it back through an fps conversion it does
   *  not need). Only the <video> element — whose fps the browser genuinely cannot be
   *  trusted about — goes through seconds. That is what the seconds path is for.
   */
  _resolveSeedFrame() {
    const app = window.appState;
    const fc = window.FrameContext;

    // 1. The frame strip is driving the canvas. `pinned` is the frame the work is
    //    filed under; drawing off it is already refused (FrameContext._enterLooking
    //    drops the canvas to browse, which exits track_seed), so the two agree here
    //    in practice. Check anyway — if they ever diverge the box was drawn on one
    //    frame and would be filed against another, which is the whole defect.
    if (fc?.isActive?.() && fc.pinned != null) {
      const shown = fc.frames?.[fc.i]?.n;
      if (shown != null && shown !== fc.pinned) {
        return { error: `The strip is showing frame ${shown} but your work is filed `
                      + `under frame ${fc.pinned}. Go back to your frame first.` };
      }
      return { frame_number: fc.pinned, source: "frame strip" };
    }

    // 2. Frame mode: the SERVER decoded this index and told us what it was, so it
    //    cannot drift with fps. app.js's onFrameChange refuses to repaint while a
    //    frame is pinned, so this really is the picture on screen.
    if (app && app._pinnedFrame != null) {
      return { frame_number: app._pinnedFrame, source: "server-decoded frame" };
    }

    // 3. The ordinary video path, where the element genuinely is the canvas source.
    //    `duration` is the cheapest proof it decoded anything at all: a hidden or
    //    refused element reports 0/NaN, which is the case that used to send 0.0167s.
    const vEl = window.videoPlayer?.video;
    const dur = vEl ? Number(vEl.duration) : NaN;
    if (vEl && Number.isFinite(dur) && dur > 0 && typeof vEl.currentTime === "number") {
      return { time_sec: vEl.currentTime, source: "video element" };
    }

    return { error: "Can't tell which frame is on screen, so following this scar "
                  + "would seed the wrong pixels. Reopen the clip and try again." };
  },

  /** What the labeler has already told us about this scar.
   *
   *  They fill in type / zone / side / colour / confidence, draw the box, hit
   *  propagate — and the track carried none of it (track id=2: scar_type,
   *  human_zone, human_side, human_color all NULL), so verify asked every question
   *  again from scratch. These land as the HUMAN's answer and are never merged with
   *  the model's auto_* guesses: those columns are separate on purpose, and a hint
   *  written into a human_* column is indistinguishable from a person's judgement
   *  the moment it lands.
   *
   *  Returns null when the form is blank. An untouched form still reports side
   *  "Left" and confidence 3 — both are pre-selected in the markup — so shipping
   *  them unconditionally would put a fabricated flank on the track. `scar_type` and
   *  `zone` are the two fields ScarForm.validate() requires, so one of them being
   *  filled is the signal that somebody actually described this scar.
   */
  _currentScarAnswers() {
    const f = window.ScarForm?.getFormValues?.();
    if (!f) return null;
    const type = String(f.scar_type || "").trim();
    const zone = String(f.zone || "").trim();
    if (!type && !zone) return null;
    const out = {};
    if (type) out.scar_type = type;
    if (zone) out.human_zone = zone;
    if (f.side) out.human_side = String(f.side).trim();
    if (f.color) out.human_color = String(f.color).trim();
    const conf = parseInt(f.confidence, 10);
    if (Number.isFinite(conf) && conf >= 1 && conf <= 5) out.human_confidence = conf;
    const notes = String(f.notes || "").trim();
    if (notes) out.notes = notes;
    return out;
  },

  /** Called by canvas.js when the user finishes a track_seed bbox. */
  onSeedBboxDrawn(bbox) {
    const video = this._currentVideo();
    if (!video) return this._toast("Video unloaded — aborted");
    const seed = this._resolveSeedFrame();
    if (seed.error) {
      // Back to browse: leaving the canvas in track_seed invites the labeler to
      // draw the same box again into the same refusal.
      window.annotCanvas?.setMode?.("browse");
      console.warn("[Tracks] seed refused —", seed.error, {
        frameContextActive: window.FrameContext?.isActive?.() ?? null,
        pinnedFrame: window.appState?._pinnedFrame ?? null,
        videoDuration: window.videoPlayer?.video?.duration ?? null,
      });
      return this._toast(seed.error);
    }
    this._pendingSeed = {
      video_id: video.id,
      seed,
      bbox,
      // Snapshot the form NOW, not at propagate time: this is what the labeler
      // typed for the box they just drew, and the form can be reset in between.
      scar: this._currentScarAnswers(),
    };
    // For the bbox tracker (default), we skip the click step entirely — a
    // single click doesn't help template matching and adds friction.
    // The SAM2 path still uses the point; it's sent on propagate.
    this.onSeedPointSkipped();
  },

  /** Called by canvas.js when the user clicks in track_point mode. */
  onSeedPointClicked(point) {
    const pending = this._pendingSeed;
    if (!pending) return;
    this._pendingSeed = null;
    this._propagate(pending, point);
  },

  /** Called by canvas.js or keydown handler when user presses Esc in track_point mode. */
  onSeedPointSkipped() {
    const pending = this._pendingSeed;
    if (!pending) return;
    this._pendingSeed = null;
    this._propagate(pending, null);
  },

  async _propagate(pending, seed_point) {
    const { video_id, seed, bbox: seed_bbox, scar } = pending;
    this._showModal(seed_point ? "Submitting (bbox + click)…" : "Submitting…");
    const payload = { video_id, seed_bbox };
    // Exactly one of the two, never both — see _resolveSeedFrame.
    if (typeof seed.frame_number === "number") payload.seed_frame_number = seed.frame_number;
    else payload.seed_time_sec = seed.time_sec;
    // Where the answers belong: one write, inside create_track, alongside the seed
    // they describe. The shipped route does not read this yet (see the PATCH in
    // _applyScarAnswers, which is what actually lands them today).
    if (scar) payload.seed_scar = scar;
    if (seed_point) payload.seed_point = seed_point;
    try {
      const res = await _tfetch("/api/tracks/propagate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this._showModal(`Failed: ${err.error || res.status}\n${err.reason || err.hint || ""}`);
        return;
      }
      const body = await res.json();
      this.currentTrackId = body.track_id;
      if (scar) await this._applyScarAnswers(body.track_id, scar);
      this._showModal(`Following the scar through ~${(window.appState?.config?.tracks?.frame_window || 60) * 2 + 1} frames…`, body.track_id);
      this._pollStatus(body.track_id, 1000);
    } catch (e) {
      this._showModal("Network error: " + e.message);
    }
  },

  /** Land the labeler's answers on the track that was just created.
   *
   *  They also ride in the propagate payload as `seed_scar`, which is where they
   *  belong. Until app.py's api_tracks_propagate reads it, this PATCH is what
   *  actually writes them — and PATCH accepts human_zone / human_side / human_color
   *  / human_confidence / notes and nothing else, because `scar_type` is owned by
   *  the verify path. So the TYPE is the one answer that still cannot be carried
   *  without a backend change; everything else prefills the verify form
   *  (ScarFormFields reads track.human_*).
   *
   *  Reported on failure, never swallowed: a track that quietly kept none of the
   *  answers is precisely the defect this exists to fix, and it looks identical to
   *  a labeler who never filled the form in.
   */
  async _applyScarAnswers(track_id, scar) {
    const ACCEPTED = ["human_zone", "human_side", "human_color", "human_confidence", "notes"];
    const body = {};
    for (const k of ACCEPTED) if (scar[k] !== undefined) body[k] = scar[k];
    if (!Object.keys(body).length) return;
    try {
      const r = await _tfetch(`/api/tracks/${track_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        this._toast(`Your scar details did not carry over (${err.error || r.status}) — re-enter them on verify`);
      }
    } catch (e) {
      this._toast("Your scar details did not carry over: " + e.message);
    }
  },

  _pollStatus(track_id, delay_ms) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      try {
        const r = await _tfetch(`/api/tracks/${track_id}/status`);
        if (!r.ok) {
          this._showModal(`Status check failed (${r.status})`);
          return;
        }
        const s = await r.json();
        if (s.propagation_status === "done") {
          this._loadAndShowResult(track_id, true);
          return;
        }
        if (s.propagation_status === "error") {
          this._showModal(`Propagation failed: ${s.propagation_error || "unknown error"}`);
          return;
        }
        // still pending — back off (1s → 2s → 3s → 5s cap)
        const next = Math.min(delay_ms + 1000, 5000);
        this._showModal(`Following the scar across the clip…`, track_id);
        this._pollStatus(track_id, next);
      } catch (e) {
        this._showModal("Status poll failed: " + e.message);
      }
    }, delay_ms);
  },

  async _loadAndShowResult(track_id, justFollowed = false) {
    try {
      const t = await _tfetch(`/api/tracks/${track_id}`).then(r => r.json());
      this._openEditor(t);   // Phase 2 UX #3 — sidebar editor (was: _renderResult modal)
      if (justFollowed) {
        const frames = t.frame_count ?? (t.detections || []).filter(d => !d.rejected).length;
        this._toast(`One box → ${frames} frame${frames === 1 ? "" : "s"} captured. Verify below instead of redrawing.`);
      }
    } catch (e) {
      this._showModal("Failed to load track result: " + e.message);
    }
    this._refresh();
  },

  // ─── Phase 2 UX #3 — in-sidebar track editor ──────────────────────
  // Replaces the cramped 480px modal. The scar fields reuse ScarFormFields;
  // scrub + trim drive the REAL video on the big zoomable main canvas (the
  // edited track is highlighted via canvas.activeTrackId). The modal remains
  // only as the lightweight propagation-progress spinner.

  /** Seek the main video player to a given (real-fps) frame number so the big
   * canvas shows it with the track overlay. */
  _seekToFrame(fn) {
    const vp = window.videoPlayer;
    if (!vp || !vp.video) return;
    const realFps = window.appState?.canvasOverlays?.realFps || vp.fps || 30;
    try { vp.video.currentTime = fn / realFps; } catch (e) { /* seek racing load */ }
  },

  _openEditor(track) {
    const panel = document.getElementById("track-edit-panel");
    if (!panel) return this._toast("Editor panel missing");
    this._closeModal();                 // dismiss the progress spinner
    this._editTrack = track;
    this.currentTrackId = track.track_id;

    // Kept detections sorted by frame; scrub index → real frame number.
    const kept = (track.detections || []).filter(d => !d.rejected)
      .sort((a, b) => a.frame_number - b.frame_number);
    const frameNums = kept.length ? kept.map(d => d.frame_number)
                                  : [track.best_frame_number ?? 0];
    const poseByFrame = {};
    for (const d of kept) if (d.pose_json) poseByFrame[d.frame_number] = true;

    document.getElementById("track-edit-title").textContent =
      `Track #${track.track_id} · ${track.status}`;
    const sug = [];
    if (track.auto_zone)  sug.push(`zone ${track.auto_zone}`);
    if (track.auto_side)  sug.push(track.auto_side);
    if (track.auto_color) {
      const cc = track.auto_color_confidence
        ? ` ${Math.round(track.auto_color_confidence * 100)}%` : "";
      sug.push(`${track.auto_color}${cc}`);
    }
    const suggestEl = document.getElementById("track-edit-suggest");
    suggestEl.textContent = sug.length
      ? `Model suggests: ${sug.join(" · ")}`
      : "No model suggestion for this scar";
    suggestEl.style.color = sug.length ? "#9bf" : "#777";

    // Reusable scar form (pre-fills from human_*; auto_* shown as suggestions).
    const fields = new ScarFormFields("track-edit", { track });
    this._editFields = fields;
    const mount = document.getElementById("track-edit-fields");
    mount.innerHTML = fields.render();
    fields.bind();

    // Stream B (#9) — async model scar-TYPE hint (non-binding; inert when OFF).
    this._loadTypeSuggestion(track.track_id);

    // Show panel + light up this track on the canvas.
    panel.style.display = "block";
    if (window.annotCanvas) {
      window.annotCanvas.showTrackOverlays = true;
      window.annotCanvas.activeTrackId = track.track_id;
    }
    const ovToggle = document.getElementById("track-overlay-toggle");
    if (ovToggle) ovToggle.checked = true;

    // ── Scrub the real video on the big canvas ──
    const scrub = document.getElementById("track-edit-scrub");
    const frameLabel = document.getElementById("track-edit-frame-label");
    let currentFrame = track.best_frame_number ?? frameNums[0];
    const bestIdx = Math.max(0, frameNums.indexOf(track.best_frame_number));
    scrub.min = "0";
    scrub.max = String(Math.max(0, frameNums.length - 1));
    scrub.value = String(bestIdx);
    const _showFrame = (idx) => {
      idx = Math.max(0, Math.min(frameNums.length - 1, idx));
      const fn = frameNums[idx];
      currentFrame = fn;
      scrub.value = String(idx);
      const best = fn === track.best_frame_number;
      const pose = poseByFrame[fn] ? "" : " · no pose";
      frameLabel.textContent = `frame ${fn}${best ? " (best)" : ""}${pose}`;
      this._seekToFrame(fn);
    };
    scrub.oninput = (e) => _showFrame(parseInt(e.target.value, 10));
    document.getElementById("track-edit-prev").onclick =
      () => _showFrame(parseInt(scrub.value, 10) - 1);
    document.getElementById("track-edit-next").onclick =
      () => _showFrame(parseInt(scrub.value, 10) + 1);

    // ── Trim (valid sub-range) — PATCH only, no recomputation ──
    let trimStart = (track.trim_start_frame ?? null);
    let trimEnd   = (track.trim_end_frame ?? null);
    const trimStatus = document.getElementById("track-edit-trim-status");
    const marker = document.getElementById("track-edit-trim-marker");
    const _paintTrim = () => {
      if (trimStart === null && trimEnd === null) {
        trimStatus.textContent = "(full range)"; trimStatus.style.color = "#666";
      } else {
        trimStatus.textContent = `valid: ${trimStart ?? "—"} → ${trimEnd ?? "—"}`;
        trimStatus.style.color = "#9bf";
      }
      if (marker && frameNums.length) {
        const minFn = frameNums[0], maxFn = frameNums[frameNums.length - 1];
        const span = Math.max(1, maxFn - minFn);
        const loF = trimStart !== null ? (Math.max(minFn, trimStart) - minFn) / span : 0;
        const hiF = trimEnd   !== null ? (Math.min(maxFn, trimEnd)   - minFn) / span : 1;
        const a = Math.max(0, Math.min(1, Math.min(loF, hiF)));
        const b = Math.max(0, Math.min(1, Math.max(loF, hiF)));
        marker.innerHTML = `<div style="position:absolute;left:${(a*100).toFixed(1)}%;width:${((b-a)*100).toFixed(1)}%;height:100%;background:#4a90d9;"></div>`;
      }
    };
    const _patchTrim = async () => {
      try {
        await _tfetch(`/api/tracks/${track.track_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
          body: JSON.stringify({ trim_start_frame: trimStart, trim_end_frame: trimEnd }),
        });
      } catch (e) { this._toast("Trim save failed: " + e.message); }
    };
    document.getElementById("track-edit-trim-start").onclick = () => {
      trimStart = currentFrame;
      if (trimEnd !== null && trimEnd < trimStart) { const t = trimStart; trimStart = trimEnd; trimEnd = t; }
      _paintTrim(); _patchTrim();
    };
    document.getElementById("track-edit-trim-end").onclick = () => {
      trimEnd = currentFrame;
      if (trimStart !== null && trimStart > trimEnd) { const t = trimStart; trimStart = trimEnd; trimEnd = t; }
      _paintTrim(); _patchTrim();
    };
    document.getElementById("track-edit-trim-clear").onclick = () => {
      trimStart = null; trimEnd = null; _paintTrim(); _patchTrim();
    };

    // ── Actions ──
    const msg = document.getElementById("track-edit-msg");
    document.getElementById("track-edit-close").onclick = () => this._closeEditor();
    // Esc closes the editor (bound once; ignores typing in form fields).
    if (!this._editorEscBound) {
      this._editorEscBound = true;
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const pnl = document.getElementById("track-edit-panel");
        if (!pnl || pnl.style.display === "none") return;
        const tag = (e.target?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea") return;
        this._closeEditor();
      });
    }
    const verifyBtn = document.getElementById("track-edit-verify");
    verifyBtn.disabled = false;
    verifyBtn.onclick = async () => {
      if (!fields.isValid()) {
        msg.textContent = "Set type, zone, side (and color unless COPEPODS).";
        msg.style.color = "#d96"; return;
      }
      verifyBtn.disabled = true;
      const v = fields.getValues();
      const body = {
        scar_type: v.scar_type, human_zone: v.human_zone,
        human_side: v.human_side, human_confidence: v.human_confidence,
      };
      if (v.human_color && !ScarFormFields.TYPES_WITHOUT_COLOR.has(v.scar_type)) {
        body.human_color = v.human_color;
      }
      try {
        const r = await _tfetch(`/api/tracks/${track.track_id}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          msg.textContent = `Verify failed: ${err.error || r.status}`; msg.style.color = "#d66";
          verifyBtn.disabled = false; return;
        }
        this._toast(`✓ Track #${track.track_id} verified as ${v.scar_type}`);
        // Hand off to the scar board, if it is on. A track is one APPEARANCE of a
        // scar in one clip; ScarObjects owns the physical mark that spans clips.
        // Guarded so this file behaves identically when objects.enabled is false.
        window.ScarObjects?.onTrackVerified?.(track.track_id, body);
        this._closeEditor(); this._refresh();
      } catch (e) {
        msg.textContent = "Verify failed: " + e.message; msg.style.color = "#d66";
        verifyBtn.disabled = false;
      }
    };
    document.getElementById("track-edit-reject").onclick = async () => {
      try {
        await _tfetch(`/api/tracks/${track.track_id}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        });
        this._toast(`Track #${track.track_id} rejected`);
        this._closeEditor(); this._refresh();
      } catch (e) { this._toast("Reject failed: " + e.message); }
    };
    document.getElementById("track-edit-merge").onclick = () => this._mergeTrack(track);

    _paintTrim();
    _showFrame(bestIdx);
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  },

  /** Stream B (#9) — show the model's scar-TYPE suggestion as a non-binding hint
   *  in the verify editor. Inert when mlops.recommendations is OFF (server returns
   *  {enabled:false, suggestion:null}) or the helper isn't loaded. Click "apply" to
   *  drop it into the type dropdown — the human stays ground truth. */
  async _loadTypeSuggestion(trackId) {
    const el = document.getElementById("track-edit-type-suggest");
    if (!el) return;
    el.style.display = "none";
    el.innerHTML = "";
    if (!window.MlopsRecs) return;
    let res;
    try { res = await MlopsRecs.fetchTypeSuggestion(trackId); }
    catch (e) { return; }
    // Race guard: the editor may have closed / switched tracks while we awaited.
    if (this.currentTrackId !== trackId) return;
    if (!res || !res.suggestion) return;
    const esc = escapeHtml;   // utils.js; the old `|| (s => s)` fallback did not escape
    const pct = (typeof res.confidence === "number")
      ? ` ${Math.round(res.confidence * 100)}%` : "";
    el.innerHTML =
      `Model suggests type: <strong>${esc(res.suggestion)}</strong>` +
      `<span style="color:#789;">${pct}</span> ` +
      `<button type="button" class="track-type-apply" style="background:none;border:1px solid #4a7;color:#7d9;border-radius:3px;font-size:10px;padding:1px 6px;cursor:pointer;">apply</button>`;
    el.style.color = "#9bf";
    el.style.display = "";
    el.querySelector(".track-type-apply")?.addEventListener("click", () => {
      const sel = document.getElementById("track-edit-scar-type");
      if (!sel) return;
      sel.value = res.suggestion;
      // Fire change so ScarFormFields updates its state + color-row visibility.
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  },

  _closeEditor() {
    const panel = document.getElementById("track-edit-panel");
    if (panel) panel.style.display = "none";
    if (window.annotCanvas) window.annotCanvas.activeTrackId = null;
    const hint = document.getElementById("track-edit-type-suggest");
    if (hint) { hint.style.display = "none"; hint.innerHTML = ""; }
    this._editTrack = null;
    this._editFields = null;
    this.currentTrackId = null;
  },

  /** Merge picker — prompt-based, identical contract to the old modal. */
  async _mergeTrack(track) {
    let candidates = [];
    try {
      const res = await _tfetch(`/api/tracks/video/${encodeURIComponent(track.video_id)}`).then(r => r.json());
      candidates = (res.tracks || []).filter(t =>
        (t.track_id || t.id) !== track.track_id &&
        !t.merged_into_track_id &&
        (t.status === "verified" || t.status === "proposed"));
    } catch (e) { return this._toast("Could not load merge candidates: " + e.message); }
    if (!candidates.length) return this._toast("No other tracks in this video to merge into.");
    const lines = candidates.map(t => {
      const id = t.track_id || t.id;
      const zone = t.human_zone || t.auto_zone || "?";
      return `  #${id} · ${t.status} · zone ${zone}`;
    }).join("\n");
    const ans = window.prompt(
      `Merge track #${track.track_id} INTO which track id?\n\nCandidates from this video:\n${lines}\n\nEnter target track id:`);
    if (!ans) return;
    const into = parseInt(ans, 10);
    if (isNaN(into)) return this._toast("Invalid track id.");
    try {
      const r = await _tfetch(`/api/tracks/${track.track_id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ into_track_id: into }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})); return this._toast(`Merge failed: ${err.error || r.status}`); }
      this._toast(`#${track.track_id} merged into #${into}`);
      this._closeEditor(); this._refresh();
    } catch (e) { this._toast("Merge failed: " + e.message); }
  },

  async _refreshList() {
    const video = this._currentVideo();
    const listEl = document.getElementById("tracks-list");
    if (!listEl) return;
    if (!video) {
      listEl.innerHTML = '<p class="muted" style="font-size:11px;">No video loaded</p>';
      return;
    }
    try {
      const res = await _tfetch(`/api/tracks/video/${video.id}`).then(r => r.json());
      const tracks = res.tracks || [];
      if (!tracks.length) {
        listEl.innerHTML = '<p class="muted" style="font-size:11px;">No tracks yet</p>';
        return;
      }
      listEl.innerHTML = tracks.map(t => {
        const statusColor = { proposed: "#fc3", verified: "#3a8", rejected: "#a33" }[t.status] || "#888";
        // Prefer human_color (the annotator's final choice); fall back to auto_color
        const color = t.human_color || t.auto_color;
        const colorLabel = t.human_color
          ? `· color <span style="color:#fc6;">${color}</span>`
          : (t.auto_color ? `· color ${t.auto_color}` : '');
        return `<div class="track-list-item" data-track-id="${t.track_id || t.id}" style="padding:6px;margin:4px 0;background:#222;border-left:3px solid ${statusColor};border-radius:3px;font-size:11px;cursor:pointer;" title="Click to view / verify">
          <strong>#${t.track_id || t.id}</strong> · <span style="color:#6cf;">${t.frame_count ?? "?"} frames</span> · best ${t.best_frame_number ?? "?"} · ${t.status}
          ${t.scar_type ? `· <span style="color:#6c3;">${t.scar_type}</span>` : ''}
          ${colorLabel}
        </div>`;
      }).join("");
      // Make each row clickable → opens verify modal for that track
      listEl.querySelectorAll(".track-list-item").forEach(el => {
        el.addEventListener("click", () => {
          const tid = parseInt(el.dataset.trackId, 10);
          if (!isNaN(tid)) this._loadAndShowResult(tid);
        });
        el.addEventListener("mouseenter", () => el.style.background = "#2a2a32");
        el.addEventListener("mouseleave", () => el.style.background = "#222");
      });
    } catch (e) {
      listEl.innerHTML = `<p class="muted" style="font-size:11px;color:#a33;">Failed: ${e.message}</p>`;
    }
  },

  // ──────────── Polish 7 — Triage Card mode ────────────────────

  /** Open the fullscreen triage overlay. Loads up to 50 unverified tracks
   * for the current video (or all videos if no video is selected) and
   * starts on the first card. */
  async _enterTriageMode() {
    const overlay = document.getElementById("triage-mode");
    if (!overlay) return;
    this._triage = {
      queue: [],
      idx: 0,
      currentFields: null,  // ScarFormFields instance for the active card
      currentTrack: null,
      lastType: this._triage?.lastType || "",
      lastConfidence: this._triage?.lastConfidence || 3,
    };

    overlay.style.display = "flex";
    document.body.style.overflow = "hidden";
    this._bindTriageOnce();

    const stage = document.getElementById("triage-stage");
    stage.innerHTML = `<p style="margin:auto;color:#888;">Loading queue…</p>`;
    this._setTriageProgress("…");

    const video = this._currentVideo();
    const params = new URLSearchParams({ limit: "50", strategy: "balanced" });
    if (video?.id) params.set("video_id", video.id);
    try {
      const res = await _tfetch(`/api/tracks/unverified?${params}`).then(r => r.json());
      this._triage.queue = res.tracks || [];
    } catch (e) {
      stage.innerHTML = `<p style="margin:auto;color:#a33;">Queue load failed: ${e.message}</p>`;
      return;
    }
    if (!this._triage.queue.length) {
      stage.innerHTML = "";
      const empty = document.getElementById("triage-empty");
      // If a video is loaded, jump straight into seed mode — review queue is empty.
      // If not, show the empty state with a "+ Seed" CTA.
      if (video?.id) {
        empty.style.display = "none";
        return this._enterSeedMode();
      }
      empty.style.display = "";
      this._setTriageProgress("0 of 0");
      return;
    }
    document.getElementById("triage-empty").style.display = "none";
    this._renderTriageCard(this._triage.queue[0], "in");
  },

  _exitTriageMode() {
    const overlay = document.getElementById("triage-mode");
    if (overlay) overlay.style.display = "none";
    document.body.style.overflow = "";
    // Refresh main UI in case verifications happened
    this._refresh();
  },

  _bindTriageOnce() {
    if (this._triageBound) return;
    this._triageBound = true;
    document.getElementById("triage-back")?.addEventListener("click", () => this._exitTriageMode());
    document.getElementById("triage-close")?.addEventListener("click", () => this._exitTriageMode());
    document.getElementById("triage-prev")?.addEventListener("click", () => this._triagePrev());
    document.getElementById("triage-next")?.addEventListener("click", () => this._triageNext());
    document.getElementById("triage-act-accept")?.addEventListener("click", () => this._triageAct("accept"));
    document.getElementById("triage-act-reject")?.addEventListener("click", () => this._triageAct("reject"));
    document.getElementById("triage-act-edit")?.addEventListener("click",   () => this._triageAct("edit"));
    document.getElementById("triage-act-skip")?.addEventListener("click",   () => this._triageAct("skip"));
    // Polish 7 seed-mode buttons
    document.getElementById("triage-seed-btn")?.addEventListener("click", () => this._enterSeedMode());
    document.getElementById("triage-empty-seed")?.addEventListener("click", () => this._enterSeedMode());
    document.getElementById("triage-seed-cancel")?.addEventListener("click", () => this._exitSeedMode());
    document.getElementById("triage-seed-clear")?.addEventListener("click", () => this._clearSeedBbox());
    document.getElementById("triage-seed-go")?.addEventListener("click", () => this._propagateSeed());
    this._bindTriageGestures();
  },

  /** Touch swipe gestures: right=accept, left=reject, up=edit, down=skip.
   * Threshold: ≥80px primary axis movement, plus dominant axis (avoids
   * accidental triggers from diagonal scrolls). */
  _bindTriageGestures() {
    const stage = document.getElementById("triage-stage");
    if (!stage) return;
    let startX = 0, startY = 0, startT = 0, tracking = false;
    stage.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY; startT = performance.now();
      tracking = true;
    }, { passive: true });
    stage.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      const dt = performance.now() - startT;
      if (dt > 500) return;  // too slow → not a swipe
      const ax = Math.abs(dx), ay = Math.abs(dy);
      const T = 80;
      if (ax > T && ax > ay * 1.4) {
        return this._triageAct(dx > 0 ? "accept" : "reject");
      }
      if (ay > T && ay > ax * 1.4) {
        return this._triageAct(dy < 0 ? "edit" : "skip");
      }
    }, { passive: true });
  },

  _setTriageProgress(text) {
    const el = document.getElementById("triage-progress-text");
    if (el) el.textContent = text;
  },

  /** Render the active card. direction: 'in' | 'out-left' | 'out-right' | 'out-up' | 'out-down' */
  _renderTriageCard(track, direction = "in") {
    if (!track) {
      const stage = document.getElementById("triage-stage");
      stage.innerHTML = "";
      document.getElementById("triage-empty").style.display = "";
      this._setTriageProgress("0 of 0");
      return;
    }
    this._triage.currentTrack = track;
    const tid = track.track_id || track.id;
    const best = track.best_frame_number;
    const stage = document.getElementById("triage-stage");
    document.getElementById("triage-empty").style.display = "none";
    this._setTriageProgress(`Track ${this._triage.idx + 1} of ${this._triage.queue.length}`);

    // Hint chip text
    const z = track.auto_zone, zc = track.auto_zone_confidence || 0;
    const s = track.auto_side, sc = track.auto_side_confidence || 0;
    const col = track.auto_color;
    const POSE_FAIL = new Set(["wrong_subject", "no_detection"]);
    let hintBody;
    if (POSE_FAIL.has(track.pose_status)) {
      hintBody = `<span class="hint-pill warn">⚠ model unsure</span>`;
    } else if (track.pose_status === "head_on") {
      hintBody = `<span class="hint-pill warn">head-on view — pick Both</span>`;
    } else {
      const parts = [];
      if (z) parts.push(`<span class="hint-pill">Zone ${z} · ${(zc*100).toFixed(0)}%</span>`);
      if (s) parts.push(`<span class="hint-pill">${s} · ${(sc*100).toFixed(0)}%</span>`);
      if (col) parts.push(`<span class="hint-pill">${col}</span>`);
      hintBody = parts.length ? `Model: ${parts.join(" ")}` : `<span class="hint-pill">no model suggestion</span>`;
    }

    const trackForFields = {
      ...track,
      scar_type: track.scar_type || this._triage.lastType,
      human_confidence: this._triage.lastConfidence,
    };

    const html = `
      <div class="triage-card" id="triage-card-${tid}">
        <div class="triage-image-wrap">
          <img class="triage-image" id="triage-img"
               src="/api/tracks/${tid}/preview?frame=${best}&crop=bbox&pad=0.5"
               alt="scar #${tid}" loading="eager">
          <div class="triage-frame-label" id="triage-frame-label">#${tid} · frame ${best}</div>
        </div>
        ${(track.frame_count || 0) > 1 ? `
        <div class="triage-scrub">
          <span>frame</span>
          <input type="range" id="triage-scrub-bar" min="0" max="${(track.frame_count || 1) - 1}" value="0">
        </div>` : ""}
        <div class="triage-hint">${hintBody}</div>
        <div id="triage-fields-host"></div>
      </div>
    `;
    stage.innerHTML = html;

    // Render shared form fields
    const host = document.getElementById("triage-fields-host");
    host.classList.add("triage-fields");
    this._triage.currentFields = new window.ScarFormFields("triage", {
      track: trackForFields,
      compact: true,
      onChange: (st) => {
        if (st.scar_type) this._triage.lastType = st.scar_type;
        if (st.human_confidence) this._triage.lastConfidence = st.human_confidence;
        this._updateTriageAcceptEnabled();
      },
    });
    host.innerHTML = this._triage.currentFields.render();
    this._triage.currentFields.bind();
    this._updateTriageAcceptEnabled();

    // Frame scrub (preview only — uses the per-frame preview endpoint)
    const scrub = document.getElementById("triage-scrub-bar");
    if (scrub) {
      // Build a sorted list of frame numbers from the cached overlays (if available)
      // Fallback: just step ±1 from best frame.
      scrub.addEventListener("input", () => {
        const idx = parseInt(scrub.value, 10);
        // Compute frame number relative to best — simple: best + idx*1 (no sorted list).
        // For a smarter scrub we'd need detection list per track; the modal already does that.
        // Acceptable v1: just step by 1 from frame_number=0.
        const frameNum = idx;
        const img = document.getElementById("triage-img");
        const label = document.getElementById("triage-frame-label");
        if (img) img.src = `/api/tracks/${tid}/preview?frame=${frameNum}&crop=bbox&pad=0.5`;
        if (label) label.textContent = `#${tid} · frame ${frameNum}`;
      });
    }
  },

  _updateTriageAcceptEnabled() {
    const acc = document.getElementById("triage-act-accept");
    if (!acc || !this._triage?.currentFields) return;
    const valid = this._triage.currentFields.isValid();
    acc.disabled = !valid;
  },

  _triageNext() {
    if (!this._triage) return;
    if (this._triage.idx + 1 >= this._triage.queue.length) {
      this._toast("end of queue");
      return;
    }
    this._triage.idx++;
    this._renderTriageCard(this._triage.queue[this._triage.idx]);
  },

  _triagePrev() {
    if (!this._triage) return;
    if (this._triage.idx <= 0) {
      this._toast("at start of queue");
      return;
    }
    this._triage.idx--;
    this._renderTriageCard(this._triage.queue[this._triage.idx]);
  },

  /** Run the user's chosen action on the current card. */
  async _triageAct(action) {
    const t = this._triage?.currentTrack;
    if (!t) return;
    const tid = t.track_id || t.id;

    if (action === "edit") {
      // Punt to the existing modal for trim/merge/scrub. Don't slide.
      return this._loadAndShowResult(tid);
    }

    if (action === "skip") {
      this._slideAndAdvance("out-down");
      return;
    }

    if (action === "reject") {
      try {
        const r = await _tfetch(`/api/tracks/${tid}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        });
        if (!r.ok) { this._toast(`reject failed: ${r.status}`); return; }
      } catch (e) { this._toast("reject failed: " + e.message); return; }
      this._toast(`#${tid} rejected`);
      this._removeFromQueueAndAdvance("out-left");
      return;
    }

    if (action === "accept") {
      const fields = this._triage.currentFields;
      if (!fields || !fields.isValid()) {
        this._toast("fill required fields first (or tap ✏ to open editor)");
        return;
      }
      const v = fields.getValues();
      try {
        const r = await _tfetch(`/api/tracks/${tid}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
          body: JSON.stringify({
            scar_type: v.scar_type,
            human_zone: v.human_zone,
            human_side: v.human_side,
            human_color: v.human_color,
            human_confidence: v.human_confidence,
          }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          this._toast(`verify failed: ${err.error || r.status}`);
          return;
        }
      } catch (e) {
        this._toast("verify failed: " + e.message);
        return;
      }
      this._toast(`✓ #${tid} verified as ${v.scar_type}`);
      this._removeFromQueueAndAdvance("out-right");
      return;
    }
  },

  /** Animate the current card out, drop it from the queue, and load the next. */
  _removeFromQueueAndAdvance(direction) {
    const card = document.querySelector("#triage-stage .triage-card");
    const advance = () => {
      this._triage.queue.splice(this._triage.idx, 1);
      // After splice, idx points to the next track (or one past the end)
      if (this._triage.idx >= this._triage.queue.length) {
        this._triage.idx = Math.max(0, this._triage.queue.length - 1);
      }
      const next = this._triage.queue[this._triage.idx];
      if (!next) {
        const stage = document.getElementById("triage-stage");
        stage.innerHTML = "";
        document.getElementById("triage-empty").style.display = "";
        this._setTriageProgress("0 of 0");
      } else {
        this._renderTriageCard(next);
      }
    };
    if (!card) return advance();
    card.classList.add(`slide-${direction}`);
    setTimeout(advance, 200);
  },

  /** Animate the current card out and load the next without removing this one. */
  _slideAndAdvance(direction) {
    const card = document.querySelector("#triage-stage .triage-card");
    const advance = () => this._triageNext();
    if (!card) return advance();
    card.classList.add(`slide-${direction}`);
    setTimeout(advance, 200);
  },

  // ──────────── Polish 7 — Triage seed mode ────────────────────
  // Seed a brand-new track from inside the triage overlay. User scrubs to
  // a frame, taps-and-drags to draw a bbox, then propagates. New track
  // lands in the review queue.

  /** Switch the triage overlay into seed mode. Requires a current video. */
  _enterSeedMode() {
    const overlay = document.getElementById("triage-mode");
    if (!overlay) return;
    const video = this._currentVideo();
    if (!video?.id) {
      this._toast("Select a video first (left sidebar)");
      return;
    }
    if (video.media_type === "image") {
      this._toast("Tracks need a video, not a single image");
      return;
    }
    overlay.dataset.mode = "seed";
    document.getElementById("triage-actionbar-review").style.display = "none";
    document.getElementById("triage-actionbar-seed").style.display   = "";
    document.getElementById("triage-empty").style.display = "none";
    this._setTriageProgress(`Seeding · ${video.video_name || video.encounter_code || video.id}`);

    // Per-session seed state. video coords (natural) are recorded once the
    // <video> metadata loads. bbox stays in natural coords throughout.
    this._seed = {
      videoId: video.id,
      bbox: null,            // {x, y, w, h} in natural video coords
      drawing: false,
      startNat: null,        // {x, y} in natural coords
      naturalW: 0,
      naturalH: 0,
      timeSec: 0,
    };

    this._renderSeedStage(video);
  },

  _exitSeedMode() {
    const overlay = document.getElementById("triage-mode");
    if (!overlay) return;
    overlay.dataset.mode = "review";
    document.getElementById("triage-actionbar-seed").style.display   = "none";
    document.getElementById("triage-actionbar-review").style.display = "";
    this._seed = null;
    // Re-render review queue (or empty state)
    if (this._triage?.queue?.length) {
      const t = this._triage.queue[this._triage.idx] || this._triage.queue[0];
      this._renderTriageCard(t);
    } else {
      const stage = document.getElementById("triage-stage");
      if (stage) stage.innerHTML = "";
      document.getElementById("triage-empty").style.display = "";
      this._setTriageProgress("0 of 0");
    }
  },

  _renderSeedStage(video) {
    const stage = document.getElementById("triage-stage");
    if (!stage) return;
    stage.innerHTML = `
      <div class="seed-card" id="seed-card">
        <div class="seed-stage" id="seed-stage">
          <video id="seed-video" preload="auto" playsinline muted></video>
          <canvas id="seed-canvas" class="seed-canvas"></canvas>
          <div class="seed-loading" id="seed-loading">Preparing video…</div>
        </div>
        <div class="seed-controls">
          <button class="triage-icon-btn" id="seed-step-back" title="−1 frame">⏮</button>
          <input type="range" id="seed-scrub" class="seed-scrub" min="0" max="100" step="0.05" value="0" disabled>
          <button class="triage-icon-btn" id="seed-step-fwd" title="+1 frame">⏭</button>
          <span class="seed-time" id="seed-time">0:00 / 0:00</span>
        </div>
        <div class="seed-tip" id="seed-tip">
          Scrub to the frame with the scar, then <strong>tap and drag</strong> a box around it.
        </div>
      </div>
    `;
    this._prepareAndAttachSeedVideo(video);
  },

  /** Mirrors app._prepareAndLoadVideo — POST /prepare, poll /download-status,
   * then assign src to the <video> element. Self-contained so seed mode works
   * even if the user hasn't opened the video on the main canvas first. */
  async _prepareAndAttachSeedVideo(video) {
    const v  = document.getElementById("seed-video");
    const ld = document.getElementById("seed-loading");
    if (!v || !ld) {
      console.error("[seed] missing video or loading element", {v, ld});
      return;
    }
    const streamUrl = `/api/videos/${video.id}/stream`;
    const setLoading = (msg, isError = false) => {
      ld.style.display = "";
      ld.textContent = msg;
      ld.style.color = isError ? "#f59e0b" : "#888";
      console.log("[seed]", msg);
    };

    const attach = () => {
      setLoading("Loading video bytes…");
      this._bindSeed();   // wire listeners FIRST so loadedmetadata is caught
      // Add an explicit error handler on the video tag so MEDIA_ERR_* shows up
      v.addEventListener("error", () => {
        const err = v.error;
        const codes = {1:"ABORTED",2:"NETWORK",3:"DECODE",4:"SRC_NOT_SUPPORTED"};
        setLoading(`Video failed to load: ${codes[err?.code] || "unknown"} (${err?.message || ""})`, true);
      }, { once: true });
      v.src = streamUrl;
      v.load();
    };

    setLoading(`Preparing video… (id=${video.id.slice(0, 8)})`);
    try {
      const r = await _tfetch(`/api/videos/${video.id}/prepare`, {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (!r.ok) {
        setLoading(`Prepare failed: HTTP ${r.status}`, true);
        return;
      }
      const res = await r.json();
      if (res.status === "ready") return attach();
      if (res.status === "error") {
        setLoading(`Download error: ${res.error || "unknown"}. Open it on the main canvas first.`, true);
        return;
      }
      const pct = Math.round((res.progress || 0) * 100);
      setLoading(`Downloading from Drive… ${pct}%`);
      const start = Date.now();
      const poll = setInterval(async () => {
        if (this._seed?.videoId !== video.id) { clearInterval(poll); return; }
        if (Date.now() - start > 180_000) {
          clearInterval(poll);
          setLoading("Download timed out. Try again or open the video on the main canvas first.", true);
          return;
        }
        try {
          const s = await _tfetch(`/api/videos/${video.id}/download-status`).then(r => r.json());
          if (s.status === "ready") { clearInterval(poll); attach(); return; }
          if (s.status === "error") {
            clearInterval(poll);
            setLoading(`Download failed: ${s.error || "unknown"}.`, true);
            return;
          }
          setLoading(`Downloading from Drive… ${Math.round((s.progress || 0) * 100)}%`);
        } catch (e) { /* swallow individual poll errors */ }
      }, 1500);
    } catch (e) {
      setLoading(`Prepare failed: ${e.message}`, true);
    }
  },

  _bindSeed() {
    const v   = document.getElementById("seed-video");
    const cv  = document.getElementById("seed-canvas");
    const sc  = document.getElementById("seed-scrub");
    const ld  = document.getElementById("seed-loading");
    const tEl = document.getElementById("seed-time");
    if (!v || !cv || !sc) return;

    const fmtTime = (t) => {
      if (!isFinite(t) || t < 0) t = 0;
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    const sizeCanvasToVideo = () => {
      // Match canvas pixel size to video display size for crisp drawing.
      const rect = v.getBoundingClientRect();
      cv.width  = Math.round(rect.width);
      cv.height = Math.round(rect.height);
      cv.style.width  = rect.width  + "px";
      cv.style.height = rect.height + "px";
      this._redrawSeedBbox();
    };

    v.addEventListener("loadedmetadata", () => {
      this._seed.naturalW = v.videoWidth;
      this._seed.naturalH = v.videoHeight;
      sc.disabled = false;
      sc.max = String(v.duration || 0);
      ld.style.display = "none";
      tEl.textContent = `${fmtTime(0)} / ${fmtTime(v.duration)}`;
      // Wait one frame for the layout to settle before sizing.
      requestAnimationFrame(sizeCanvasToVideo);
    });
    v.addEventListener("error", () => {
      ld.textContent = "Failed to load video. Make sure it's downloaded (open it from the canvas first).";
    });
    v.addEventListener("seeked", () => {
      this._seed.timeSec = v.currentTime;
      tEl.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
    });
    window.addEventListener("resize", sizeCanvasToVideo, { passive: true });

    sc.addEventListener("input", () => { v.currentTime = parseFloat(sc.value || "0"); });
    document.getElementById("seed-step-back")?.addEventListener("click", () => {
      const dt = 1 / 30;  // approximate one frame; cv2 fps is authoritative server-side anyway
      v.currentTime = Math.max(0, v.currentTime - dt);
      sc.value = String(v.currentTime);
    });
    document.getElementById("seed-step-fwd")?.addEventListener("click", () => {
      const dt = 1 / 30;
      v.currentTime = Math.min(v.duration || 0, v.currentTime + dt);
      sc.value = String(v.currentTime);
    });

    this._bindSeedPointer(cv);
  },

  /** Pointer events (works for mouse + touch + pen via pointer events API). */
  _bindSeedPointer(cv) {
    const screenToNatural = (clientX, clientY) => {
      const rect = cv.getBoundingClientRect();
      const sx = (clientX - rect.left) / rect.width;
      const sy = (clientY - rect.top)  / rect.height;
      return {
        x: Math.max(0, Math.min(1, sx)) * this._seed.naturalW,
        y: Math.max(0, Math.min(1, sy)) * this._seed.naturalH,
      };
    };
    const updateBbox = (start, end) => {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      this._seed.bbox = { x, y, w, h };
      const goBtn = document.getElementById("triage-seed-go");
      if (goBtn) goBtn.disabled = (w < 4 || h < 4);
      this._redrawSeedBbox();
    };

    cv.addEventListener("pointerdown", (e) => {
      if (!this._seed?.naturalW) return;  // video not loaded yet
      e.preventDefault();
      cv.setPointerCapture?.(e.pointerId);
      this._seed.drawing = true;
      this._seed.startNat = screenToNatural(e.clientX, e.clientY);
      updateBbox(this._seed.startNat, this._seed.startNat);
    });
    cv.addEventListener("pointermove", (e) => {
      if (!this._seed?.drawing) return;
      e.preventDefault();
      const cur = screenToNatural(e.clientX, e.clientY);
      updateBbox(this._seed.startNat, cur);
    });
    const finish = (e) => {
      if (!this._seed?.drawing) return;
      this._seed.drawing = false;
      cv.releasePointerCapture?.(e.pointerId);
    };
    cv.addEventListener("pointerup", finish);
    cv.addEventListener("pointercancel", finish);
  },

  _redrawSeedBbox() {
    const cv = document.getElementById("seed-canvas");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    const bb = this._seed?.bbox;
    if (!bb || !this._seed.naturalW) return;
    // Convert natural coords → canvas pixel coords
    const sx = cv.width  / this._seed.naturalW;
    const sy = cv.height / this._seed.naturalH;
    const x = bb.x * sx, y = bb.y * sy, w = bb.w * sx, h = bb.h * sy;
    ctx.save();
    ctx.fillStyle   = "rgba(80,200,120,0.18)";
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth   = 2.5;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    // Corner ticks for visual polish
    ctx.fillStyle = "#4ade80";
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy]) => {
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
  },

  _clearSeedBbox() {
    if (!this._seed) return;
    this._seed.bbox = null;
    const goBtn = document.getElementById("triage-seed-go");
    if (goBtn) goBtn.disabled = true;
    this._redrawSeedBbox();
  },

  /** POST the seed to /api/tracks/propagate, exit seed mode, refresh queue. */
  async _propagateSeed() {
    const s = this._seed;
    if (!s?.bbox || s.bbox.w < 4 || s.bbox.h < 4) {
      this._toast("Draw a box around the scar first");
      return;
    }
    const goBtn = document.getElementById("triage-seed-go");
    if (goBtn) { goBtn.disabled = true; goBtn.querySelector(".triage-act-label").textContent = "Sending…"; }
    const payload = {
      video_id: s.videoId,
      seed_time_sec: s.timeSec,  // bypasses fps mismatch
      seed_bbox: {
        x: Math.round(s.bbox.x),
        y: Math.round(s.bbox.y),
        width:  Math.round(s.bbox.w),
        height: Math.round(s.bbox.h),
      },
    };
    try {
      const r = await _tfetch("/api/tracks/propagate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        this._toast(`Couldn't follow the scar: ${err.error || r.status}`);
        if (goBtn) { goBtn.disabled = false; goBtn.querySelector(".triage-act-label").textContent = "Follow scar"; }
        return;
      }
      const body = await r.json();
      this._toast(`Following scar #${body.track_id} across the clip…`);
      // Reload the queue from server so the new track shows up. The propagate
      // worker is async — the new track may not be 'proposed' yet, so we
      // refetch a few times before giving up.
      this._exitSeedMode();
      await this._reloadQueueAfterSeed(body.track_id);
    } catch (e) {
      this._toast("Network error: " + e.message);
      if (goBtn) { goBtn.disabled = false; goBtn.querySelector(".triage-act-label").textContent = "Follow scar"; }
    }
  },

  /** Poll the unverified queue until the new track appears (or 30s elapses). */
  async _reloadQueueAfterSeed(trackId) {
    const video = this._currentVideo();
    const params = new URLSearchParams({ limit: "50", strategy: "balanced" });
    if (video?.id) params.set("video_id", video.id);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await _tfetch(`/api/tracks/unverified?${params}`).then(r => r.json());
        const queue = res.tracks || [];
        const idx = queue.findIndex(t => Number(t.id) === Number(trackId));
        if (idx >= 0) {
          this._triage.queue = queue;
          this._triage.idx = idx;
          document.getElementById("triage-empty").style.display = "none";
          this._renderTriageCard(queue[idx]);
          return;
        }
      } catch (_) { /* swallow; retry */ }
      await new Promise(r => setTimeout(r, 1500));
    }
    // Fell through — propagation slow. Just reload whatever queue exists.
    try {
      const res = await _tfetch(`/api/tracks/unverified?${params}`).then(r => r.json());
      this._triage.queue = res.tracks || [];
      this._triage.idx = 0;
      if (this._triage.queue.length) {
        document.getElementById("triage-empty").style.display = "none";
        this._renderTriageCard(this._triage.queue[0]);
      }
    } catch (_) {}
  },

  // ──────────── Modal helpers ────────────────────────────────

  _ensureModal() {
    let m = document.getElementById("tracks-modal");
    if (m) return m;
    m = document.createElement("div");
    m.id = "tracks-modal";
    m.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10001;display:none;align-items:center;justify-content:center;";
    m.innerHTML = `
      <div id="tracks-modal-box" style="background:#1e1e2e;border:1px solid #444;border-radius:8px;padding:20px;width:480px;max-width:90vw;max-height:80vh;overflow-y:auto;color:#e0e0e0;font-family:system-ui,sans-serif;">
        <div id="tracks-modal-content"></div>
        <button id="tracks-modal-close" style="position:absolute;top:8px;right:12px;background:transparent;color:#888;border:none;font-size:20px;cursor:pointer;">×</button>
      </div>
    `;
    document.body.appendChild(m);
    document.getElementById("tracks-modal-close").addEventListener("click", () => this._closeModal());
    return m;
  },

  _showModal(text, trackId) {
    const m = this._ensureModal();
    m.style.display = "flex";
    document.getElementById("tracks-modal-content").innerHTML =
      `<div style="text-align:center;padding:20px;">
        <div style="display:inline-block;width:32px;height:32px;border:3px solid #444;border-top-color:#3a8;border-radius:50%;animation:tracks-spin 1s linear infinite;"></div>
        <div style="margin-top:12px;font-size:14px;">${text}</div>
        ${trackId ? `<div style="font-size:11px;color:#888;margin-top:6px;">Track #${trackId}</div>` : ''}
      </div>
      <style>@keyframes tracks-spin { to { transform: rotate(360deg); } }</style>`;
  },

  _setModalHtml(html) {
    this._ensureModal().style.display = "flex";
    document.getElementById("tracks-modal-content").innerHTML = html;
  },

  _closeModal() {
    const m = document.getElementById("tracks-modal");
    if (m) m.style.display = "none";
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    this.currentTrackId = null;
  },

  _toast(msg) {
    const el = document.getElementById("save-status");
    if (el) {
      el.textContent = msg;
      setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4000);
    } else {
      console.log("[Tracks]", msg);
    }
  },
};

document.addEventListener("DOMContentLoaded", () => Tracks.init());
window.Tracks = Tracks;
