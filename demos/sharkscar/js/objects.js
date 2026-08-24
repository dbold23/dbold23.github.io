/**
 * objects.js — the scar board: a scar that belongs to the ANIMAL.
 *
 * Self-contained singleton (window.ScarObjects). Registers NO global side effects
 * unless /api/objects/health reports the feature enabled — gated off, the panel
 * stays hidden, no listeners are bound, and the annotator UI is byte-identical.
 *
 * WHY THIS EXISTS. The lab annotates "encounter → which sides are visible → scar
 * by scar". The app annotated "frame → box", so the same physical mark on frames
 * 100/200/300 was three unrelated dicts and consensus had to guess which boxes
 * were the same scar from a categorical signature. Measured on the recovered
 * multi-rater corpus, that guess produced 3,717 scars where geometric identity
 * produces 2,049 — 44.9% were phantom duplicates of one another.
 *
 * TWO SURFACES, matching the protocol:
 *
 *   1. SIGHTING CARD — one per encounter. Per clip: sides_visible + usable. Per
 *      encounter: scars_visible. `scars_visible = NO` closes the whole encounter
 *      in one click, which today costs one save per frame per clip and has
 *      produced ZERO recorded absences in the entire live corpus.
 *
 *   2. SCAR BOARD — a grid of scar OBJECTS, not boxes and not frames. Each card
 *      shows which clips the scar has been seen in. "+ NEW SCAR" hands off to the
 *      EXISTING track seed flow (window.Tracks) and then parents the resulting
 *      track to a new object. No new CV code; propagation and verification are
 *      reused verbatim.
 *
 * Owns no other module's files. Talks to canvas.js only via window.annotCanvas,
 * and to the track flow only via window.Tracks.
 */
"use strict";

const ScarObjects = {
  available: false,
  requireCount: false,
  attachSuggestions: false,
  sides: ["Left", "Right", "Both", "None"],
  usableOpts: ["ok", "too_dark", "too_turbid", "no_animal", "too_short"],

  _pass: null,          // the open sighting for this encounter
  _objects: [],
  _encounterId: null,
  _clips: [],           // [{video_id, video_name}]
  _pendingAttach: null, // scar_object_id awaiting a seeded track

  async init() {
    try {
      const h = await fetch("/api/objects/health").then(r => (r.ok ? r.json() : null));
      this.available = !!(h && h.ok);
      if (h) {
        this.requireCount = !!h.require_scar_count;
        this.attachSuggestions = !!h.attach_suggestions;
        if (Array.isArray(h.sides)) this.sides = h.sides;
        if (Array.isArray(h.usable)) this.usableOpts = h.usable;
      }
    } catch (e) {
      this.available = false;
    }
    const panel = document.getElementById("objects-panel");
    if (!this.available) {
      if (panel) panel.style.display = "none";
      console.info("[Objects] feature gated off");
      return;
    }
    if (panel) panel.style.display = "";
    this._bind();

    // AppState.currentVideo is not observable; tracks.js polls it the same way.
    // Keyed on ENCOUNTER, not video: switching between two clips of one animal
    // must NOT reopen the sighting, because the sighting spans all of them.
    this._lastEncounter = null;
    setInterval(() => {
      const v = window.appState?.currentVideo || null;
      const enc = v?.encounter_code || null;
      if (enc !== this._lastEncounter) {
        this._lastEncounter = enc;
        if (enc) this.onVideoLoaded(v, window.appState?.encounterClips || null);
        else this._hide();
      }
    }, 400);
  },

  _bind() {
    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };
    on("btn-new-scar", "click", () => this._newScar());
    on("btn-close-pass", "click", () => this._closePass());
    on("obj-scars-visible", "change", () => this._renderPass());
  },

  /**
   * Called by app.js when a video is selected. Opens (or resumes) the sighting
   * for that video's ENCOUNTER, listing every clip of it — not just this one.
   * 35% of encounters have more than one clip, and until now the queue could
   * only ever reach one of them.
   */
  async onVideoLoaded(video, siblingClips) {
    if (!this.available || !video) return;
    const enc = video.encounter_code || "";
    if (!enc) { this._hide(); return; }
    this._encounterId = enc;
    try {
      // Ask the server which clips this ENCOUNTER has, rather than inferring from
      // the annotator's assignment list. Assignment can currently reach only one
      // clip per encounter, so inferring would silently scope the sighting to a
      // fraction of the footage and still let them declare "no scars".
      const cl = await API.get(
        `/api/objects/encounters/${encodeURIComponent(enc)}/clips`);
      this._clips = (cl && cl.clips && cl.clips.length)
        ? cl.clips
        : [{ video_id: video.id, video_name: video.video_name }];
    } catch (e) {
      this._clips = [{ video_id: video.id, video_name: video.video_name }];
    }
    try {
      await API.post("/api/objects/passes", {
        encounter_id: enc,
        video_ids: this._clips.map(c => c.video_id),
      });
      this._pass = await API.get(`/api/objects/passes/${encodeURIComponent(enc)}`);
      const res = await API.get(`/api/objects/scars?encounter_id=${encodeURIComponent(enc)}`);
      this._objects = (res && res.scars) || [];
    } catch (e) {
      console.info("[Objects] could not open pass", e);
      this._hide();
      return;
    }
    this._renderPass();
    this._renderBoard();
  },

  _hide() {
    const p = document.getElementById("objects-panel");
    if (p) p.style.display = "none";
  },

  // ── the sighting card ──────────────────────────────────────────────

  _renderPass() {
    const host = document.getElementById("obj-pass");
    if (!host || !this._pass) return;
    const p = this._pass;
    // Every clip of a sighting shares the encounter code, so the only part that
    // tells them apart is the SUFFIX -- and left-to-right ellipsis cuts exactly
    // that, rendering three different clips as three identical "AN99010…".
    // Strip the shared prefix instead and keep the distinguishing tail.
    const enc = this._encounterId || "";
    const clipName = id => {
      const full = (this._clips.find(c => c.video_id === id) || {}).video_name || id;
      const short = full.replace(/\.[^.]+$/, "");
      return (enc && short.startsWith(enc) && short.length > enc.length)
        ? short.slice(enc.length).replace(/^[_-]/, "")
        : short;
    };

    const rows = (p.clips || []).map(c => `
      <div class="obj-clip" data-vid="${escapeHtml(c.video_id)}">
        <div class="obj-clip-name" title="${escapeHtml(clipName(c.video_id))}">
          ${c.reviewed_at ? "✓" : "○"} ${escapeHtml(clipName(c.video_id))}
        </div>
        <select class="obj-sides" data-vid="${escapeHtml(c.video_id)}">
          <option value="">sides…</option>
          ${this.sides.map(s =>
            `<option value="${s}" ${c.sides_visible === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <select class="obj-usable" data-vid="${escapeHtml(c.video_id)}">
          <option value="">usable…</option>
          ${this.usableOpts.map(u =>
            `<option value="${u}" ${c.usable === u ? "selected" : ""}>${u}</option>`).join("")}
        </select>
      </div>`).join("");

    const done = p.clips_reviewed || 0, total = p.clips_total || 0;
    const sv = document.getElementById("obj-scars-visible");
    const svVal = sv ? sv.value : (p.scars_visible || "");
    // The count is only asked when there ARE scars. Asking "how many?" after
    // somebody said NO is how you teach people to click through the question.
    const needCount = this.requireCount && svVal === "YES";

    // The clip-by-clip table is CLOSING work, not annotating work: it belongs to the
    // moment somebody finishes a sighting, and fourteen rows of dropdowns held that
    // much space above the frame all session. Collapsed to its own summary line,
    // which is the only part that is true at a glance. The question it protects is
    // real -- "no scars" only describes the animal if you looked at every clip, and
    // sides_visible genuinely differs between clips of one encounter -- so it is one
    // click away, not gone.
    host.innerHTML = `
      <button type="button" class="obj-progress obj-toggle" aria-expanded="${
        this._clipsOpen ? "true" : "false"}">${done} / ${total} clips reviewed</button>
      <div class="obj-clips"${this._clipsOpen ? "" : " hidden"}>${rows}</div>
      ${needCount ? `
        <div class="obj-row">
          <label for="obj-scar-count">How many distinct scars?</label>
          <input id="obj-scar-count" type="number" min="0" step="1"
                 value="${p.scar_count_declared ?? ""}" style="width:56px;">
        </div>` : ""}
      ${p.status === "complete"
        ? `<div class="obj-done">✓ sighting complete</div>`
        : done < total
          ? `<div class="obj-hint muted"${this._clipsOpen ? "" : " hidden"}>Review every
             clip before closing — "no scars" only describes the animal if you looked
             at all of it.</div>`
          : ""}
    `;
    host.querySelectorAll(".obj-sides, .obj-usable").forEach(el => {
      el.addEventListener("change", () => this._recordClip(el.dataset.vid));
    });
    const toggle = host.querySelector(".obj-toggle");
    const clips = host.querySelector(".obj-clips");
    if (toggle && clips) {
      toggle.addEventListener("click", () => {
        this._clipsOpen = !this._clipsOpen;
        clips.hidden = !this._clipsOpen;
        toggle.setAttribute("aria-expanded", String(this._clipsOpen));
      });
    }
    const closeBtn = document.getElementById("btn-close-pass");
    if (closeBtn) closeBtn.disabled = (done < total) || p.status === "complete";
  },

  async _recordClip(videoId) {
    const host = document.getElementById("obj-pass");
    if (!host) return;
    const sides = host.querySelector(`.obj-sides[data-vid="${CSS.escape(videoId)}"]`);
    const usable = host.querySelector(`.obj-usable[data-vid="${CSS.escape(videoId)}"]`);
    const body = {};
    if (sides && sides.value) body.sides_visible = sides.value;
    if (usable && usable.value) body.usable = usable.value;
    if (!Object.keys(body).length) return;
    try {
      const res = await API.patch(
        `/api/objects/passes/${this._pass.id}/clips/${encodeURIComponent(videoId)}`, body);
      // Update IN PLACE. Re-rendering the whole card here destroys and rebuilds
      // every <select> in it -- including the one the annotator is reaching for
      // next. Setting "sides" then "usable" on the same row lost the second
      // value entirely, because the element it was set on had already been
      // replaced by the time the change fired.
      const clip = (this._pass.clips || []).find(c => c.video_id === videoId);
      if (clip) {
        if (body.sides_visible) clip.sides_visible = body.sides_visible;
        if (body.usable) clip.usable = body.usable;
        clip.reviewed_at = clip.reviewed_at || new Date().toISOString();
      }
      if (res && typeof res.clips_reviewed === "number") {
        this._pass.clips_reviewed = res.clips_reviewed;
      }
      this._refreshProgress(videoId);
    } catch (e) {
      console.warn("[Objects] clip update failed", e);
    }
  },

  /** Update only what changed: the row's tick, the counter, the close button. */
  _refreshProgress(videoId) {
    const host = document.getElementById("obj-pass");
    if (!host || !this._pass) return;
    const done = this._pass.clips_reviewed || 0;
    const total = this._pass.clips_total || 0;

    const prog = host.querySelector(".obj-progress");
    if (prog) prog.textContent = `${done} / ${total} clips reviewed`;

    if (videoId) {
      const row = host.querySelector(`.obj-clip[data-vid="${CSS.escape(videoId)}"] .obj-clip-name`);
      if (row && row.textContent.trim().startsWith("○")) {
        row.textContent = row.textContent.replace("○", "✓");
      }
    }
    const hint = host.querySelector(".obj-hint");
    if (hint && done >= total) hint.remove();
    const btn = document.getElementById("btn-close-pass");
    if (btn) btn.disabled = (done < total) || this._pass.status === "complete";
  },

  async _closePass() {
    const sv = document.getElementById("obj-scars-visible");
    const countEl = document.getElementById("obj-scar-count");
    const body = {};
    if (sv && sv.value) body.scars_visible = sv.value;
    if (countEl && countEl.value !== "") body.scar_count_declared = parseInt(countEl.value, 10);
    try {
      const res = await API.post(`/api/objects/passes/${this._pass.id}/close`, body);
      if (res && res.error) { alert(res.error); return; }
      this._pass = await API.get(
        `/api/objects/passes/${encodeURIComponent(this._encounterId)}`);
      this._renderPass();
    } catch (e) {
      // 409 means "not finishable yet", not "malformed" — surface it as guidance.
      alert(e && e.message ? e.message : "Could not close this sighting.");
    }
  },

  // ── the scar board ─────────────────────────────────────────────────

  _renderBoard() {
    const host = document.getElementById("obj-board");
    if (!host) return;
    if (!this._objects.length) {
      host.innerHTML = `<p class="muted" style="font-size:11px;">
        No scars logged for this animal yet. Draw each one <em>once</em> —
        it will follow itself across frames.</p>`;
      return;
    }
    host.innerHTML = this._objects.map(o => {
      const clips = o.clip_count || 0;
      const seenHere = (o.tracks || []).some(t => t.video_id === this._currentVideoId());
      return `
      <div class="obj-card" data-oid="${o.id}">
        <div class="obj-card-head">
          <strong>${escapeHtml(o.scar_type || "—")}</strong>
          <span class="muted">zone ${escapeHtml(o.zone || "?")} · ${escapeHtml(o.side || "?")}</span>
        </div>
        <div class="obj-card-meta">
          ${escapeHtml(o.color || "")}${o.confidence ? ` · conf ${o.confidence}` : ""}
          <span class="obj-clip-chip" title="clips this scar has been seen in">
            ${clips} clip${clips === 1 ? "" : "s"}
          </span>
        </div>
        ${seenHere
          ? `<div class="obj-seen">✓ seen in this clip</div>`
          : `<button class="btn btn-sm obj-attach" data-oid="${o.id}"
                title="Seed this same scar in the clip you are watching now">
               + seen in this clip too
             </button>`}
      </div>`;
    }).join("");
    host.querySelectorAll(".obj-attach").forEach(b => {
      b.addEventListener("click", () => this._seenHereToo(parseInt(b.dataset.oid, 10)));
    });
  },

  _currentVideoId() {
    // window.appState, not window.app — app.js exports the singleton as
    // `appState` (tracks.js reaches it the same way).
    return window.appState?.currentVideo?.id || null;
  },

  /**
   * "+ NEW SCAR" — hand off to the EXISTING track seed flow, then parent the
   * resulting track to a fresh scar object. Drawing a scar once produces an
   * object because the track already follows it across frames; all that was
   * missing was a parent that survives the clip boundary.
   */
  _newScar() {
    if (!window.Tracks || !window.Tracks.available) {
      alert("Track propagation is unavailable, so a scar cannot be followed. " +
            "Draw it with the normal scar tool instead.");
      return;
    }
    this._pendingAttach = "new";
    window.Tracks._onTrackClick();
  },

  _seenHereToo(objectId) {
    if (!window.Tracks || !window.Tracks.available) return;
    // Cross-clip identity is a HUMAN claim, never inferred. This button is the
    // claim; nothing auto-attaches, and the attach is reversible.
    this._pendingAttach = objectId;
    window.Tracks._onTrackClick();
  },

  /**
   * Called by tracks.js once a seeded track has been verified. Creates the scar
   * object (or attaches to an existing one) and refreshes the board.
   */
  async onTrackVerified(trackId, fields) {
    if (!this.available || this._pendingAttach == null) return;
    const pending = this._pendingAttach;
    this._pendingAttach = null;
    try {
      if (pending === "new") {
        // tracks.js hands us the VERIFY body, whose keys are human_zone / human_side /
        // human_color / human_confidence; POST /api/objects/scars reads zone / side /
        // color / confidence. Spreading it verbatim created every scar object with
        // scar_type set and every other field NULL — a silent birth defect, since the
        // POST succeeds and the board renders the row.
        const f = fields || {};
        await API.post("/api/objects/scars", {
          encounter_id: this._encounterId, track_id: trackId,
          scar_type:  f.scar_type,
          zone:       f.zone       ?? f.human_zone,
          side:       f.side       ?? f.human_side,
          color:      f.color      ?? f.human_color,
          confidence: f.confidence ?? f.human_confidence,
          notes:      f.notes,
        });
      } else {
        await API.post(`/api/objects/tracks/${trackId}/attach`,
                       { scar_object_id: pending });
      }
      const res = await API.get(
        `/api/objects/scars?encounter_id=${encodeURIComponent(this._encounterId)}`);
      this._objects = (res && res.scars) || [];
      this._renderBoard();
    } catch (e) {
      console.warn("[Objects] could not record scar object", e);
    }
  },
};

window.ScarObjects = ScarObjects;

document.addEventListener("DOMContentLoaded", () => ScarObjects.init());
