/**
 * app.js — Main application state manager.
 * Wires together: VideoPlayer, AnnotationCanvas, ScarForm, and Flask API.
 */
"use strict";

// ──────────── API wrapper with error handling ────────────────────────

const API = {
  async _handle(response) {
    if (response.status === 401) {
      // Session expired — redirect to login
      AppState._showLogin();
      throw new Error("Session expired — please sign in again");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return response.json();
  },
  async get(url) {
    const r = await fetch(url);
    return this._handle(r);
  },
  async post(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this._handle(r);
  },
  async patch(url, body) {
    const r = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this._handle(r);
  },
  async postForm(url, fd) {
    const r = await fetch(url, { method: "POST", body: fd });
    return this._handle(r);
  },
};

// ──────────── Application State ──────────────────────────────────────

const AppState = {
  currentUser: null,
  currentVideo: null,
  currentFrameB64: null,
  brightnessVal: 0,
  contrastVal: 1.0,
  frameEnhancePending: false,
  selectedVideoId: null,
  _dirty: false,           // unsaved changes flag
  _autoSaveTimer: null,
  _allVideos: [],           // cached for search filtering
  _saving: false,           // prevent double-save

  // ──────────────────────────────────────────────────────────────
  async init() {
    // Check auth first
    try {
      const user = await API.get("/auth/me");
      this.currentUser = user;
      document.getElementById("header-user").textContent = user.name || user.email;
    } catch (e) {
      // Auth not available or not configured — use anonymous
      this.currentUser = { email: "anonymous", name: "Anonymous", is_admin: true, role: "admin" };
      document.getElementById("header-user").textContent = "Local Mode";
    }

    this._bindNav();
    this._bindToolbar();
    this._bindEnhancement();
    this._bindScarActions();
    this._bindSaveExport();
    this._bindKeyboard();
    this._bindVideoLoad();
    this._bindAdmin();
    this._bindVideoSearch();
    this._bindUnsavedWarning();
    this._loadMyVideos();

    window.appState = this;

    // Wire video frame change -> capture frame
    window.videoPlayer.onFrameChange = () => {
      const b64 = window.videoPlayer.captureCurrentFrame();
      if (b64) this._displayFrame(b64);
    };

    // Start auto-save timer (5 minutes default)
    this._startAutoSave();
  },

  // ──────────── Auth / Login ─────────────────────────────────────

  _showLogin() {
    document.getElementById("header-user").innerHTML =
      '<a href="#" id="btn-login" style="color:var(--accent)">Sign in with Google</a>';
    document.getElementById("btn-login").addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        const res = await API.get("/auth/login");
        if (res.auth_url) window.location.href = res.auth_url;
      } catch (err) {
        this._setStatus("Login unavailable: " + err.message, true);
      }
    });
  },

  // ──────────── Video list ──────────────────────────────────────

  async _loadMyVideos() {
    const email = this.currentUser?.email || "";
    const admin = this.currentUser?.is_admin || this.currentUser?.role === "admin";
    try {
      const data = await API.get(`/api/videos?email=${encodeURIComponent(email)}&admin=${admin}`);
      this._allVideos = data.videos || [];
      this._renderVideoList(this._allVideos);
    } catch (e) {
      this._setStatus("Failed to load videos: " + e.message, true);
    }
  },

  _renderVideoList(videos) {
    const list = document.getElementById("video-list");
    if (!videos.length) { list.innerHTML = '<p class="muted">No videos assigned</p>'; return; }

    list.innerHTML = videos.map(v => `
      <div class="video-item" data-id="${v.id}" data-path="${v.video_path || ''}" data-name="${v.video_name}">
        <div class="video-item-name">${v.video_name}</div>
        <div class="video-item-meta">
          <span class="status-badge status-${v.status || 'unassigned'}">${v.status || 'unassigned'}</span>
          ${v.encounter_code ? `<span>${v.encounter_code}</span>` : ''}
          ${v.site ? `<span>${v.site}</span>` : ''}
        </div>
      </div>
    `).join("");

    list.querySelectorAll(".video-item").forEach(item => {
      item.addEventListener("click", () => {
        list.querySelectorAll(".video-item").forEach(i => i.classList.remove("selected"));
        item.classList.add("selected");
        this.selectedVideoId = item.dataset.id;
        this._loadVideoById(item.dataset.id, item.dataset.name);
      });
    });
  },

  _loadVideoPath(id, path, name) {
    this.currentVideo = { id, video_path: path, video_name: name };
    window.videoPlayer.load(path);
    document.getElementById("header-video-name").textContent = name;
    this._setStatus(`Loaded: ${name}`);
    this._dirty = false;
    const ec = document.getElementById("enc-code");
    // Auto-fill encounter code from filename: e.g. APT22062203.mp4 → APT22062203
    const match = name.match(/^([A-Z]{2,4}\d+)/);
    if (match) ec.value = match[1];
  },

  _loadVideoById(id, name) {
    const streamUrl = `/api/videos/${id}/stream`;
    this.currentVideo = { id, video_path: streamUrl, video_name: name };
    this._setStatus(`Loading: ${name}...`);
    window.videoPlayer.load(streamUrl);
    document.getElementById("header-video-name").textContent = name;
    this._dirty = false;
    const ec = document.getElementById("enc-code");
    const match = name.match(/^([A-Z]{2,4}\d+)/);
    if (match) ec.value = match[1];
  },

  // ──────────── Video search ────────────────────────────────────

  _bindVideoSearch() {
    const input = document.getElementById("video-search");
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase().trim();
      if (!q) {
        this._renderVideoList(this._allVideos);
        return;
      }
      const filtered = this._allVideos.filter(v =>
        (v.video_name || "").toLowerCase().includes(q) ||
        (v.encounter_code || "").toLowerCase().includes(q) ||
        (v.site || "").toLowerCase().includes(q) ||
        (v.status || "").toLowerCase().includes(q)
      );
      this._renderVideoList(filtered);
    });
  },

  // ──────────── Unsaved changes guard ───────────────────────────

  _bindUnsavedWarning() {
    window.addEventListener("beforeunload", (e) => {
      if (this._dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  },

  _markDirty() {
    this._dirty = true;
  },

  // ──────────── Auto-save ───────────────────────────────────────

  _startAutoSave() {
    const intervalSec = 300; // 5 minutes
    this._autoSaveTimer = setInterval(() => {
      if (this._dirty && this.currentVideo && !this._saving) {
        this._save(true); // silent auto-save
      }
    }, intervalSec * 1000);
  },

  // ──────────── Frame display ───────────────────────────────────

  _displayFrame(b64) {
    this.currentFrameB64 = b64;
    if (this.brightnessVal !== 0 || this.contrastVal !== 1.0) {
      this._applyEnhancement(b64);
    } else {
      window.annotCanvas.setFrame(b64);
    }
  },

  async _applyEnhancement(b64) {
    if (this.frameEnhancePending) return;
    this.frameEnhancePending = true;
    try {
      const res = await API.post("/api/frames/enhance", {
        frame_b64: b64,
        brightness: this.brightnessVal,
        contrast: this.contrastVal,
      });
      if (res.frame_b64) window.annotCanvas.setFrame(res.frame_b64);
    } catch (e) {
      window.annotCanvas.setFrame(b64);
    } finally {
      this.frameEnhancePending = false;
    }
  },

  // ──────────── Canvas click -> SAM ─────────────────────────────

  async handleCanvasClick(imgX, imgY, mode) {
    if (!this.currentFrameB64) return;
    this._setStatus("Segmenting (this may take a moment)...");
    try {
      const res = await API.post("/api/frames/segment", {
        frame_b64: this.currentFrameB64,
        points: [[Math.round(imgX), Math.round(imgY)]],
        neg_points: [],
        is_body: mode === "body",
      });

      if (res.error) {
        this._setStatus(res.error, true);
        window.annotCanvas.setMode("bbox");
        document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
        document.getElementById("tool-bbox").classList.add("active");
        return;
      }

      if (mode === "body") {
        window.annotCanvas.setBodyMask(res.mask_b64);
        window.annotCanvas.setBodyBbox(res.bbox);
        window.annotCanvas.setMode("keypoint");
        this._activateTool("tool-keypoint");
        this._setStatus("Body segmented - now place keypoints (K)");
        this._markDirty();
      } else {
        const formVals = window.ScarForm.getFormValues();
        const scar = {
          id: "scar_" + Date.now(),
          mask: null,
          maskB64: res.mask_b64,
          bbox: res.bbox,
          ...formVals,
          annotator: this.currentUser?.email || "",
        };
        window.annotCanvas.addScar(scar);
        window.ScarForm.resetScarFields();
        window.annotCanvas.setMode("browse");
        this._activateTool(null);
        this._setStatus(`Scar added: ${scar.scar_type || "?"} (Zone ${scar.zone || "?"})`);
        this._markDirty();
      }
    } catch (e) {
      this._setStatus("Segmentation failed - try again or draw box manually (B)", true);
    }
  },

  handleScarBbox(bbox) {
    const formVals = window.ScarForm.getFormValues();
    const scar = {
      id: "scar_" + Date.now(),
      mask: null,
      bbox: bbox,
      ...formVals,
      annotator: this.currentUser?.email || "",
    };
    window.annotCanvas.addScar(scar);
    window.ScarForm.resetScarFields();
    window.annotCanvas.setMode("browse");
    this._activateTool(null);
    this._setStatus(`Scar added: ${scar.scar_type || "?"} (Zone ${scar.zone || "?"})`);
    this._markDirty();
  },

  // ──────────── Enhancement ─────────────────────────────────────

  _bindEnhancement() {
    const bSlider = document.getElementById("brightness-slider");
    const cSlider = document.getElementById("contrast-slider");
    const bVal    = document.getElementById("brightness-val");
    const cVal    = document.getElementById("contrast-val");

    const apply = () => {
      this.brightnessVal = parseInt(bSlider.value);
      this.contrastVal   = parseInt(cSlider.value) / 100;
      bVal.textContent = this.brightnessVal;
      cVal.textContent = this.contrastVal.toFixed(1) + "x";
      if (this.currentFrameB64) this._applyEnhancement(this.currentFrameB64);
    };

    bSlider.addEventListener("input", apply);
    cSlider.addEventListener("input", apply);

    document.getElementById("btn-reset-enhance").addEventListener("click", () => {
      bSlider.value = 0; cSlider.value = 100;
      this.brightnessVal = 0; this.contrastVal = 1.0;
      bVal.textContent = "0"; cVal.textContent = "1.0x";
      if (this.currentFrameB64) window.annotCanvas.setFrame(this.currentFrameB64);
    });
  },

  // ──────────── Toolbar ─────────────────────────────────────────

  _bindToolbar() {
    const toolMap = {
      "tool-body":     "body",
      "tool-scar":     "scar",
      "tool-keypoint": "keypoint",
      "tool-bbox":     "bbox",
    };
    Object.entries(toolMap).forEach(([id, mode]) => {
      document.getElementById(id).addEventListener("click", () => {
        window.annotCanvas.setMode(mode);
        this._activateTool(id);
      });
    });

    document.getElementById("tool-undo").addEventListener("click", () => window.annotCanvas.undo());
    document.getElementById("tool-reset").addEventListener("click", () => {
      if (confirm("Reset all annotations for this frame?")) {
        window.annotCanvas.resetAll();
        this._setStatus("Annotations reset");
        this._markDirty();
      }
    });
    document.getElementById("btn-skip-kp").addEventListener("click", () => {
      window.annotCanvas.skipKeypoint();
      this._markDirty();
    });
    document.getElementById("btn-reset-kp").addEventListener("click", () => {
      if (confirm("Reset all keypoints?")) {
        window.annotCanvas.resetKeypoints();
        this._setStatus("Keypoints reset");
        this._markDirty();
      }
    });
  },

  _activateTool(activeId) {
    document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
    if (activeId) document.getElementById(activeId)?.classList.add("active");
  },

  // ──────────── Nav (tab switching) ─────────────────────────────

  _bindNav() {
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(`tab-${tab}`)?.classList.add("active");
      });
    });

    document.getElementById("btn-shortcuts-help").addEventListener("click", () => {
      document.getElementById("shortcuts-modal").classList.remove("hidden");
    });
    document.getElementById("close-shortcuts-modal").addEventListener("click", () => {
      document.getElementById("shortcuts-modal").classList.add("hidden");
    });

    document.getElementById("btn-export-coco").addEventListener("click",  () => this._export("coco"));
    document.getElementById("btn-export-forms").addEventListener("click", () => this._export("forms-csv"));
    document.getElementById("btn-export-json").addEventListener("click",  () => this._export("json"));
  },

  // ──────────── Scar form actions ───────────────────────────────

  _bindScarActions() {
    document.getElementById("btn-add-scar").addEventListener("click", () => {
      const err = window.ScarForm.validate();
      if (err) { this._setStatus(err, true); return; }
      window.annotCanvas.setMode("scar");
      this._activateTool("tool-scar");
      this._setStatus("Draw a box around the scar on the canvas");
    });
  },

  // ──────────── Save / Export ───────────────────────────────────

  _bindSaveExport() {
    document.getElementById("btn-save-ann").addEventListener("click", () => this._save());
    document.getElementById("btn-save-and-next").addEventListener("click", async () => {
      const ok = await this._save();
      if (ok) {
        window.annotCanvas.resetAll();
        window.ScarForm.resetScarFields();
        window.videoPlayer.stepFrame(1);
      }
    });
    document.getElementById("btn-save-no-scars").addEventListener("click", async () => {
      // Clear canvas first so we don't save stale bbox/mask data with a "no scars" annotation
      window.annotCanvas.resetAll();
      const ok = await this._save();
      if (ok) {
        window.videoPlayer.stepFrame(1);
        this._setStatus("Saved — no scars. Next frame ready.");
      }
    });
    document.getElementById("btn-finish-video").addEventListener("click", async () => {
      if (!this.currentVideo) return;
      if (!confirm("Mark this video as complete?\nThis counts toward your semester quota.")) return;

      // Save current frame first
      await this._save(true);

      try {
        const res = await API.post(`/api/videos/${this.currentVideo.id}/complete`);
        this._setStatus(`Video completed! ${res.encounter_code || ""}`);

        // Refresh the video list to show updated statuses and rebind click handlers
        await this._loadMyVideos();

        // Load next assigned video if available
        if (res.next_video) {
          window.annotCanvas.resetAll();
          this._loadVideoById(res.next_video.id, res.next_video.video_name);
          // Highlight the next video in the refreshed list
          const nextItem = document.querySelector(`.video-item[data-id="${res.next_video.id}"]`);
          if (nextItem) {
            document.querySelectorAll(".video-item").forEach(i => i.classList.remove("selected"));
            nextItem.classList.add("selected");
          }
          this._setStatus(`Video completed! Loading next: ${res.next_video.video_name}`);
        } else {
          window.annotCanvas.resetAll();
          this.currentVideo = null;
          this._setStatus("Video completed! No more assigned videos.");
        }
      } catch (e) {
        this._setStatus("Failed to complete: " + e.message, true);
      }
    });
  },

  async _save(silent = false) {
    if (this._saving) return false;
    if (!this.currentVideo) {
      if (!silent) this._setStatus("No video loaded", true);
      return false;
    }
    this._saving = true;
    const saveBtn = document.getElementById("btn-save-ann");
    const saveNextBtn = document.getElementById("btn-save-and-next");
    saveBtn.disabled = true;
    saveNextBtn.disabled = true;
    if (!silent) this._setStatus("Saving...");

    try {
      const enc = window.ScarForm.getEncounterValues();
      const ann = window.annotCanvas.getAnnotationData();
      const frameNum = window.videoPlayer.currentFrame();
      const payload = {
        ...enc,
        ...ann,
        video_id: this.currentVideo.id,
        video_name: this.currentVideo.video_name,
        frame_number: frameNum,
        annotator: this.currentUser?.email || "",
      };
      const res = await API.post("/api/annotations", payload);
      const frameLabel = `Frame ${frameNum}`;
      this._setStatus(silent ? `Auto-saved ${frameLabel}` : `Saved ${frameLabel}`);
      this._dirty = false;
      // Mark video in_progress
      try {
        await API.patch(`/api/videos/${this.currentVideo.id}/status`, { status: "in_progress" });
      } catch (e) { /* non-critical */ }
      return true;
    } catch (e) {
      this._setStatus("Save failed: " + e.message, true);
      return false;
    } finally {
      this._saving = false;
      saveBtn.disabled = false;
      saveNextBtn.disabled = false;
    }
  },

  _export(format) {
    const vid = this.selectedVideoId || "";
    window.location.href = `/api/export/${format}?video_id=${vid}`;
  },

  // ──────────── Video loading ───────────────────────────────────

  _bindVideoLoad() {
    // Handled in video list click -> _loadVideoPath
  },

  // ──────────── Admin actions ───────────────────────────────────

  _bindAdmin() {
    document.getElementById("btn-admin-add").addEventListener("click", async () => {
      const btn = document.getElementById("btn-admin-add");
      btn.disabled = true;
      try {
        const res = await API.post("/api/videos", {
          video_name:     document.getElementById("admin-video-name").value.trim(),
          drive_id:       document.getElementById("admin-drive-id").value.trim(),
          encounter_code: document.getElementById("admin-enc-code").value.trim(),
          site:           document.getElementById("admin-site").value.trim(),
          year:           document.getElementById("admin-year").value,
          notes:          document.getElementById("admin-notes").value.trim(),
        });
        document.getElementById("admin-status").textContent = res.id ? `Added: ${res.id}` : "Error";
        this._loadMyVideos();
      } catch (e) {
        document.getElementById("admin-status").textContent = "Error: " + e.message;
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("btn-import-csv").addEventListener("click", async () => {
      const file = document.getElementById("csv-file-input").files[0];
      if (!file) return;
      const btn = document.getElementById("btn-import-csv");
      btn.disabled = true;
      btn.textContent = "Importing...";
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await API.postForm("/api/videos/import-csv", fd);
        document.getElementById("admin-status").textContent =
          `Imported ${res.added} videos` + (res.errors?.length ? `, ${res.errors.length} errors` : "");
        this._loadMyVideos();
      } catch (e) {
        document.getElementById("admin-status").textContent = "Import failed: " + e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = "Import CSV";
      }
    });

    document.getElementById("btn-assign").addEventListener("click", async () => {
      const vid = document.getElementById("assign-video-id").value.trim();
      const email = document.getElementById("assign-email").value.trim();
      if (!vid || !email) {
        document.getElementById("admin-status").textContent = "Video ID + email required";
        return;
      }
      try {
        await API.post(`/api/videos/${vid}/assign`, {
          annotator_email: email,
          priority: document.getElementById("assign-priority").value,
          due_date: document.getElementById("assign-due").value,
          notes: document.getElementById("assign-notes").value.trim(),
        });
        document.getElementById("admin-status").textContent = `Assigned to ${email}`;
        this._loadMyVideos();
      } catch (e) {
        document.getElementById("admin-status").textContent = "Assign failed: " + e.message;
      }
    });

    document.getElementById("btn-drive-browse").addEventListener("click", () => this._browseDrive("root"));
  },

  async _browseDrive(folderId) {
    const list = document.getElementById("drive-list");
    list.innerHTML = '<p class="muted">Loading...</p>';
    try {
      const data = await API.get(`/api/drive/browse?folder_id=${folderId}`);
      if (data.error) { list.innerHTML = `<p class="muted">${data.error}</p>`; return; }
      const items = data.items || [];
      list.innerHTML = items.map(item => `
        <div class="drive-item ${item.type === 'folder' ? 'folder' : 'video'}"
             data-id="${item.id}" data-name="${item.name}" data-type="${item.type}">
          ${item.type === 'folder' ? '📁' : '🎬'} ${item.name}
          ${item.size ? `<span class="muted">${item.size}</span>` : ''}
        </div>
      `).join("") || '<p class="muted">No items found</p>';

      list.querySelectorAll(".drive-item").forEach(el => {
        el.addEventListener("click", async () => {
          if (el.dataset.type === "folder") {
            this._browseDrive(el.dataset.id);
          } else {
            el.textContent = "Downloading...";
            try {
              const res = await API.post("/api/drive/download", {
                file_id: el.dataset.id,
                file_name: el.dataset.name,
              });
              if (res.local_path) {
                const vid = await API.post("/api/videos", {
                  video_name: el.dataset.name,
                  drive_id: el.dataset.id,
                  video_path: res.local_path,
                });
                this._loadVideoPath(vid.id, res.local_path, el.dataset.name);
                document.getElementById("admin-status").textContent = `Downloaded: ${el.dataset.name}`;
                this._loadMyVideos();
              }
            } catch (err) {
              document.getElementById("admin-status").textContent = "Download failed: " + err.message;
              this._browseDrive(folderId); // re-render list
            }
          }
        });
      });
    } catch (e) {
      list.innerHTML = `<p class="muted">Error: ${e.message}</p>`;
    }
  },

  // ──────────── Keyboard shortcuts ──────────────────────────────

  _bindKeyboard() {
    document.addEventListener("keydown", e => {
      const tag = document.activeElement.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // Ctrl+S always saves
      if (e.key === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this._save(); return; }

      if (inInput) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          window.videoPlayer.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          window.videoPlayer.stepFrame(e.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          window.videoPlayer.stepFrame(e.shiftKey ? 10 : 1);
          break;
        case "f": case "F":
          e.preventDefault();
          window.annotCanvas.setMode("body");
          this._activateTool("tool-body");
          break;
        case "s": case "S":
          e.preventDefault();
          window.annotCanvas.setMode("scar");
          this._activateTool("tool-scar");
          break;
        case "k": case "K":
          e.preventDefault();
          window.annotCanvas.setMode("keypoint");
          this._activateTool("tool-keypoint");
          break;
        case "b": case "B":
          e.preventDefault();
          window.annotCanvas.setMode("bbox");
          this._activateTool("tool-bbox");
          break;
        case "z": case "Z":
          e.preventDefault();
          window.annotCanvas.undo();
          break;
        case "r": case "R":
          e.preventDefault();
          if (confirm("Reset all annotations for this frame?")) window.annotCanvas.resetAll();
          break;
        case "+": case "=":
          e.preventDefault();
          window.annotCanvas.zoom_in();
          break;
        case "-":
          e.preventDefault();
          window.annotCanvas.zoom_out();
          break;
        case "0":
          e.preventDefault();
          window.annotCanvas.zoom_reset();
          break;
        case "Tab":
          if (window.annotCanvas.mode === "keypoint") {
            e.preventDefault();
            window.annotCanvas.skipKeypoint();
            this._markDirty();
          }
          break;
        case "Escape":
          e.preventDefault();
          window.annotCanvas.setMode("browse");
          this._activateTool(null);
          document.getElementById("shortcuts-modal").classList.add("hidden");
          document.getElementById("bbox-label-popup").classList.add("hidden");
          break;
        default:
          if (/^[1-5]$/.test(e.key)) {
            window.ScarForm.setConfidence(+e.key);
          }
      }
    });
  },

  // ──────────── Helpers ─────────────────────────────────────────

  _setStatus(msg, isError = false) {
    const el = document.getElementById("save-status");
    el.textContent = msg;
    el.className = "status-msg" + (isError ? " error" : "");
    if (!isError) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 6000);
  },
};

document.addEventListener("DOMContentLoaded", () => AppState.init());
window.appState = AppState;
