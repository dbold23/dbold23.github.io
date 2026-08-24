/**
 * roi.js — Stream D, ROI #1: "mark ROI only" mode.
 *
 * Self-contained singleton (window.ROI). Registers NO global side effects unless
 * /api/roi/health reports the feature enabled — when gated off the ROI tool button
 * + panel stay hidden and no listeners are bound, so the UI is byte-identical to today.
 *
 * Flow:
 *   1. Click "▢ ROI" (or press the shortcut, default 'g') → canvas enters `roi` draw mode.
 *   2. Drag a box → ROI.onBoxDrawn() POSTs /api/roi (NO scar form, NO propagation).
 *   3. Marks overlay on the canvas (frame-scoped) + list in the ROI panel; delete from the list.
 *
 * Owns no other modules' files. Talks to canvas.js only via window.annotCanvas (mode + roiOverlays).
 */
"use strict";

const ROI = {
  available: false,
  cropCapture: false,
  shortcut: "g",
  _marks: [],
  _lastVideoId: null,

  async init() {
    try {
      const h = await fetch("/api/roi/health").then(r => (r.ok ? r.json() : null));
      this.available = !!(h && h.ok);
      this.cropCapture = !!(h && h.crop_capture);
      if (h && h.shortcut) this.shortcut = String(h.shortcut).slice(0, 1).toLowerCase();
    } catch (e) {
      this.available = false;
    }

    const btn = document.getElementById("tool-roi");
    const panel = document.getElementById("roi-panel");
    if (!this.available) {
      if (btn) btn.style.display = "none";
      if (panel) panel.style.display = "none";
      console.info("[ROI] feature gated off");
      return;
    }
    if (btn) btn.style.display = "";
    if (panel) panel.style.display = "";

    this._bind();

    // AppState.currentVideo isn't observable — poll every 400ms (cheap), mirroring tracks.js.
    setInterval(() => {
      const id = window.appState?.currentVideo?.id || null;
      if (id !== this._lastVideoId) {
        this._lastVideoId = id;
        this.loadForVideo(id);
      }
    }, 400);
  },

  _bind() {
    document.getElementById("tool-roi")?.addEventListener("click", () => this.toggle());
    document.getElementById("btn-roi-mark")?.addEventListener("click", () => this.activate());

    document.addEventListener("keydown", (e) => {
      if (!this.available) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key && e.key.toLowerCase() === this.shortcut) {
        e.preventDefault();
        this.toggle();
      }
    });
  },

  _isActive() {
    return window.annotCanvas?.mode === "roi";
  },

  toggle() {
    if (this._isActive()) this.deactivate();
    else this.activate();
  },

  activate() {
    if (!window.annotCanvas) return;
    if (!window.appState?.currentVideo) {
      this._toast("Load a video first");
      return;
    }
    // Clear other tools' active state without reaching into app.js internals.
    document.querySelectorAll(".tool-btn.active").forEach(b => b.classList.remove("active"));
    document.getElementById("tool-roi")?.classList.add("active");
    window.annotCanvas.setMode("roi");
  },

  deactivate() {
    document.getElementById("tool-roi")?.classList.remove("active");
    if (window.annotCanvas && window.annotCanvas.mode === "roi") {
      window.annotCanvas.setMode("browse");
    }
  },

  /** canvas.js calls this when an ROI box is finished. NO scar form, NO propagation. */
  async onBoxDrawn(bbox) {
    const video = window.appState?.currentVideo;
    if (!video) {
      this.deactivate();
      return;
    }
    const vEl = window.videoPlayer?.video;
    const timeSec = (vEl && typeof vEl.currentTime === "number") ? vEl.currentTime : null;
    const frameNum = window.videoPlayer?.currentFrame?.() ?? null;

    const payload = {
      video_id: video.id,
      frame_number: frameNum,
      time_sec: timeSec,
      bbox,
    };
    if (video.encounter_code) payload.encounter_code = video.encounter_code;
    if (this.cropCapture) {
      const crop = this._captureCrop(bbox);
      if (crop) payload.crop_b64 = crop;
    }

    try {
      const res = await fetch("/api/roi", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mark = await res.json();
      this._marks.unshift(mark);
      this._syncOverlays();
      this._renderList();
      this._toast("ROI saved");
    } catch (e) {
      console.warn("[ROI] save failed", e);
      this._toast("ROI save failed");
    }
    // Stay in roi mode so the annotator can mark several regions in a row.
  },

  /** Crop the just-drawn bbox out of the current frame (native-res ImageBitmap on the canvas). */
  _captureCrop(bbox) {
    try {
      const bm = window.annotCanvas?.baseImage;
      if (!bm) return null;
      const w = Math.max(1, Math.round(bbox.width));
      const h = Math.max(1, Math.round(bbox.height));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(bm, bbox.x, bbox.y, bbox.width, bbox.height, 0, 0, w, h);
      return c.toDataURL("image/jpeg", 0.85).split(",")[1];
    } catch (e) {
      return null;
    }
  },

  async loadForVideo(videoId) {
    this._marks = [];
    this._syncOverlays();
    if (!videoId) {
      this._renderEmpty("No video loaded");
      return;
    }
    try {
      const res = await fetch(`/api/roi?video_id=${encodeURIComponent(videoId)}`)
        .then(r => (r.ok ? r.json() : null));
      this._marks = (res && res.marks) || [];
    } catch (e) {
      this._marks = [];
    }
    this._syncOverlays();
    this._renderList();
  },

  async _delete(id) {
    try {
      const res = await fetch(`/api/roi/${id}`, {
        method: "DELETE",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._marks = this._marks.filter(m => m.id !== id);
      this._syncOverlays();
      this._renderList();
    } catch (e) {
      this._toast("Delete failed");
    }
  },

  /** Push the current marks to canvas.js for overlay rendering. */
  _syncOverlays() {
    if (!window.annotCanvas) return;
    window.annotCanvas.roiOverlays = this._marks.map(m => ({
      id: m.id,
      frame_number: m.frame_number,
      bbox: m.bbox,
      note: m.note,
    }));
  },

  _renderEmpty(msg) {
    const list = document.getElementById("roi-list");
    if (list) list.innerHTML = `<p class="muted" style="font-size:11px;">${msg}</p>`;
  },

  _renderList() {
    const list = document.getElementById("roi-list");
    if (!list) return;
    if (!this._marks.length) {
      this._renderEmpty("No ROI marks yet");
      return;
    }
    const esc = escapeHtml;   // utils.js; the old `|| (s => s)` fallback did not escape
    list.innerHTML = this._marks.map(m => {
      const fn = (m.frame_number != null) ? `f${m.frame_number}` : "—";
      const note = m.note ? ` · ${esc(m.note)}` : "";
      return `<div class="roi-row" data-id="${m.id}" data-frame="${m.frame_number ?? ""}"
                style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #2a2a2a;cursor:pointer;">
        <span style="flex:1;">▢ #${m.id} <span style="color:#888;">${fn}${note}</span></span>
        <button class="roi-del" data-id="${m.id}" title="Delete ROI mark"
                style="background:none;border:none;color:#a55;cursor:pointer;font-size:13px;">✕</button>
      </div>`;
    }).join("");

    list.querySelectorAll(".roi-del").forEach(b =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this._delete(parseInt(b.dataset.id, 10));
      }));
    list.querySelectorAll(".roi-row").forEach(row =>
      row.addEventListener("click", () => {
        const fn = row.dataset.frame;
        if (fn !== "" && window.videoPlayer?.seekToFrame) {
          window.videoPlayer.seekToFrame(parseInt(fn, 10));
        }
      }));
  },

  _toast(msg) {
    if (window.Tracks?._toast) {
      window.Tracks._toast(msg);
      return;
    }
    console.info("[ROI]", msg);
  },
};

document.addEventListener("DOMContentLoaded", () => ROI.init());
window.ROI = ROI;
