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
      // A 404 carrying Flask's DEFAULT message means the ROUTE does not exist —
      // not that a record is missing. In practice that has one cause: the page was
      // loaded from disk while the server is still running the Python it started
      // with, so the frontend is newer than the backend. Say that, because the
      // symptom otherwise reads as a broken feature and sends you looking in the
      // wrong place.
      if (response.status === 404 && /requested URL was not found/i.test(body.error || "")) {
        throw new Error(`This page is newer than the running server — it has no `
          + `${new URL(response.url).pathname}. Restart the server.`);
      }
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
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(body),
    });
    return this._handle(r);
  },
  async patch(url, body) {
    const r = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(body),
    });
    return this._handle(r);
  },
  async postForm(url, fd) {
    const r = await fetch(url, { method: "POST", body: fd, headers: { "X-Requested-With": "XMLHttpRequest" } });
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
  selectedVideoId: null,
  _dirty: false,           // unsaved changes flag
  _autoSaveTimer: null,
  _allVideos: [],           // cached for search filtering
  _saving: false,           // prevent double-save
  _initialFrameLoaded: false, // tracks whether first frame of video has been shown
  // Monotonic "which video is loaded" token. EVERY async continuation that writes
  // shared state (the player, #enc-code, _frameAnnotations, _dirty) must capture
  // this before its await and refuse to write if it no longer matches. A boolean
  // "is this still the current video" flag is NOT enough — a second switch back to
  // the same id would clobber it and let a first, still-pending response through.
  // Without this, a slow /prepare or /annotations response lands on whatever video
  // the student moved on to, and their next save is filed under the wrong video.
  _loadEpoch: 0,
  // Monotonic "which item did the student ask for" token, bumped on ENTRY to
  // _switchToItem. _loadEpoch cannot serve here: a switch awaits its pre-switch save
  // BEFORE it loads anything, so during that await no epoch has moved yet and a second
  // click is invisible to the first. Whoever clicked last must win, or the older
  // continuation loads its video over the newer one.
  _switchSeq: 0,

  // ──────────────────────────────────────────────────────────────
  async init() {
    // Check for auth error in URL (e.g. redirect from failed OAuth callback)
    const urlParams = new URLSearchParams(window.location.search);
    const authError = urlParams.get("error");
    if (authError) {
      window.history.replaceState({}, "", "/");  // Clean URL
    }

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

    // Show auth error after UI is ready
    if (authError) {
      this._showLogin();
      this._setStatus("Login failed. Please try again or contact an administrator.", true);
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
    this._bindCompletedSearch();
    this._bindUnsavedWarning();
    this._bindPanelTabs();
    this._bindMobileDrawers();   // Polish 7 Tier 2 — hamburger drawer toggles
    this._loadMyVideos();

    window.appState = this;

    // Stream C (gamification): honest progress goals + personal-stats panel.
    if (window.Gamification) window.Gamification.init();

    // Stream D (plan 10): the FED work queue. Inert unless the server reports
    // mlops.datasets.enabled — when off, the free-choice list above stands.
    // Must run AFTER _loadMyVideos() so it takes over a populated panel.
    if (window.WorkQueue) window.WorkQueue.init();
    // Stream D (plan 10 §5): pre-fill zone/side/colour from the drawn box.
    // Inert unless pose.frame_hints.enabled; patches nothing when off.
    if (window.ScarHints) window.ScarHints.init();

    // Wire video frame change -> capture frame
    window.videoPlayer.onFrameChange = () => {
      // In frame mode the canvas belongs to the server-decoded frame. The player
      // is hidden but still LOADS, and its loadedmetadata fires this handler with
      // frame 0 — which would quietly paint over the frame the labeler was given.
      if (this._pinnedFrame != null) return;
      const b64 = window.videoPlayer.captureCurrentFrame();
      if (b64) this._displayFrame(b64);
      this._syncFrameAnnotations();
    };

    // Check feature flags (SAM2 availability)
    this._checkFeatures();

    // Start auto-save timer (5 minutes default)
    this._startAutoSave();

    // First-time user tutorial — only for authenticated (non-anonymous) users
    if (this.currentUser && this.currentUser.email !== "anonymous"
        && !this.currentUser.tutorial_states?.overview) {
      setTimeout(() => window.Tutorial?.start("overview"), 600);
    }
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
    try {
      const data = await API.get(`/api/videos?email=${encodeURIComponent(email)}`);
      this._allVideos = data.videos || [];
      this._filterVideos();
      this._renderCompletedList();
      this._openDeepLink();
      // Fetch scar count for progress bar
      try {
        const me = await API.get("/auth/me");
        this._updateProgressBar(me.scar_count || 0, me.pose_count || 0);
      } catch (e) { this._updateProgressBar(0, 0); }
    } catch (e) {
      this._setStatus("Failed to load videos: " + e.message, true);
    }
  },

  /** ?video=<id>&frame=<n> — open that exact frame.
   *
   *  Added for the answer-key workflow: the admin dashboard lists candidate frames
   *  and "Open" has to land on the frame itself. A link that merely opens the app
   *  and leaves you to find AN13120907_1.mov frame 412 by hand is not a link.
   *  Silent when the id is not in this user's list — a deep link is a convenience,
   *  never a way to reach work you were not given. */
  async _openDeepLink() {
    if (this._deepLinkDone) return;
    const p = new URLSearchParams(window.location.search);
    const vid = p.get("video");
    if (!vid) return;
    this._deepLinkDone = true;
    const v = this._allVideos.find((x) => x.id === vid);
    if (!v) return;
    // AWAITED: _switchToItem ends in _loadVideoById, which clears the pinned frame.
    // Pinning before it settles would be undone a tick later.
    await this._switchToItem(v.id, v.video_name || v.id, v.media_type || "video",
                             v.encounter_code || "");
    const frame = parseInt(p.get("frame") || "0", 10);
    if (frame > 0) {
      const ok = await this.showFrame(v.id, frame);
      if (!ok) this.seekWhenReady(frame);
    }
  },

  /** Put ONE frame on the canvas and get the video furniture out of the way.
   *
   *  The queue hands out a single frame, not a clip, so the player chrome — scrubber,
   *  speed, play — is furniture for a task nobody is doing. Worse, routing through
   *  the <video> element made the frame contingent on things that have nothing to do
   *  with annotating: the browser being able to decode the container at all, and a
   *  seek that silently no-ops until metadata lands.
   *
   *  So the server decodes it. cv2 opens the file, seeks to that exact index and
   *  returns the JPEG — which also makes the frame number AUTHORITATIVE rather than
   *  re-derived from currentTime x an fps the browser had to be told. `_pinnedFrame`
   *  carries it to save and to the per-frame annotation cache.
   *
   *  Returns false if the frame could not be fetched, so the caller can leave the
   *  normal player in place rather than stranding somebody on a blank canvas. */
  async showFrame(videoId, frameNumber, opts = {}) {
    try {
      const res = await API.get(
        `/api/frames?video_id=${encodeURIComponent(videoId)}`
        + `&position=${encodeURIComponent(frameNumber)}`);
      if (!res || !res.frame_b64) return false;
      // The server just told us the real fps; the player should agree, in case the
      // labeler reveals the video and scrubs from here.
      if (res.fps) window.videoPlayer?.setRealFps?.(res.fps);
      this._pinnedFrame = res.frame_number;
      this._setFrameChrome(true);
      this._displayFrame(res.frame_b64);
      // Let the sync path move _activeFrameNum. It is the SOLE writer by design
      // (tests/test_frame_attribution.py pins that), and it is what restores or
      // clears the canvas for the frame we just painted — which is exactly what a
      // new frame needs. Assigning it here would be a second source of truth for
      // the number a save is filed under.
      this._syncFrameAnnotations();
      const disp = document.getElementById("frame-display");
      if (disp) disp.textContent = `Frame: ${res.frame_number}`;
      // Offer the seconds either side. Not fetched until asked: most pose frames
      // read fine alone, and decoding 4K HEVC is not free.
      // keepStrip: the clip scrubber is ALREADY showing this frame and asked us to
      // fetch it full-resolution. Re-attaching would throw its proxy frames away
      // and make every scrub reload the clip.
      if (!opts.keepStrip) window.FrameContext?.attach(videoId, res.frame_number);
      return true;
    } catch (e) {
      // 409 = the clip is not on this box yet. Leave the player alone; the normal
      // prepare/download path is already running and will fill the canvas.
      console.info("frame fetch failed — falling back to the player", e.message || e);
      return false;
    }
  },

  /** Open a whole clip, canvas-only, for a task whose unit of work is the clip.
   *
   *  Scars are judged on movement — a mark that stays on the skin as the animal
   *  turns is a scar, one that slides across it is glare — so the labeler needs to
   *  range over the clip rather than be pinned to a still. The <video> element
   *  cannot serve that here (the 4K clips are HEVC, which Chrome does not decode),
   *  so the clip arrives as a server-decoded scrub proxy and the frame the labeler
   *  settles on is then fetched full-resolution and pinned. */
  async showClip(videoId, startFrame, taskType) {
    this._setFrameChrome(true);
    if (!window.FrameContext) return this.showFrame(videoId, startFrame);
    await window.FrameContext.clip(videoId, startFrame);
    return true;
  },

  /** Hide or restore the video player. Hidden is not removed: a labeler who needs
   *  a second of context around their frame can bring it back, and the escape hatch
   *  costs one line. */
  _setFrameChrome(frameOnly) {
    const section = document.querySelector(".video-section");
    if (!section) return;
    section.style.display = frameOnly ? "none" : "";
    let toggle = document.getElementById("btn-show-video");
    if (frameOnly && !toggle) {
      toggle = document.createElement("button");
      toggle.id = "btn-show-video";
      toggle.className = "btn btn-sm btn-ghost";
      toggle.style.cssText = "font-size:11px;margin:4px 0 0 4px";
      toggle.textContent = "Show video";
      toggle.addEventListener("click", () => {
        const hidden = section.style.display === "none";
        section.style.display = hidden ? "" : "none";
        toggle.textContent = hidden ? "Hide video" : "Show video";
      });
      section.parentElement.insertBefore(toggle, section.nextSibling);
    }
    if (toggle) toggle.style.display = frameOnly ? "" : "none";
  },

  /** Back to browsing a whole clip: unpin the frame and give the player back. */
  _exitFrameMode() {
    this._pinnedFrame = null;
    this._setFrameChrome(false);
    window.FrameContext?.detach();
  },

  /** Seek to a frame number once the player can honour it — never on a timer.
   *
   *  Two things must be true first, and a fixed setTimeout guaranteed neither:
   *
   *    1. `video.duration` — seekToFrame() returns silently while it is 0, which
   *       is why a deep link on a large local clip left the canvas empty: the
   *       seek was dropped, no `seeked` event fired, and nothing was captured.
   *    2. `fpsIsReal` — the browser CANNOT determine fps, so the server tells us
   *       (app.js:335 setRealFps, from the prepare/download-status probe). That
   *       answer is async. Seeking before it arrives divides the frame number by
   *       the provisional 30, which on 59.94fps footage lands you at roughly half
   *       the intended time — the exact defect that put frame numbers in this
   *       corpus at half their true value.
   *
   *  If fps never becomes real we deliberately do NOT seek. Landing on the wrong
   *  frame is worse than staying put here: an answer key is stored BY frame
   *  number, so authoring one on a silently-wrong frame would mark every labeler
   *  against a frame they were never shown. */
  seekWhenReady(frame, tries = 0) {
    const vp = window.videoPlayer;
    if (!vp || !(frame > 0)) return;
    if (vp.mediaType === "image") return;      // a still IS the frame
    const ready = vp.video && vp.video.duration > 0 && vp.fpsIsReal;
    if (ready) { vp.seekToFrame(frame); return; }
    if (tries >= 120) {                        // ~60s: a cold clip has to download
      console.info("seek skipped — the server never reported a real fps, and "
                 + "guessing one would land on the wrong frame", { frame });
      return;
    }
    setTimeout(() => this.seekWhenReady(frame, tries + 1), 500);
  },

  _renderVideoList(videos, isFiltered = false) {
    // Stream D (plan 10): when the fed queue owns the left panel, the assignment
    // list must never write to it. _loadMyVideos() is async and un-awaited, so
    // without this guard it resolves after WorkQueue.render() and clobbers the
    // queue with "No videos assigned".
    if (window.WorkQueue?.enabled) return;
    const list = document.getElementById("video-list");
    if (!videos.length) {
      const msg = isFiltered ? "Video not assigned to you" : "No videos assigned";
      list.innerHTML = `<p class="muted">${msg}</p>`;
      return;
    }

    const COLLAPSE_LIMIT = 5;
    const shouldCollapse = videos.length > COLLAPSE_LIMIT && !isFiltered;

    list.innerHTML = videos.map((v, i) => `
      <div class="video-item${shouldCollapse && i >= COLLAPSE_LIMIT ? ' collapsed-video' : ''}"
           data-id="${escapeHtml(v.id)}" data-path="${escapeHtml(v.video_path || '')}" data-name="${escapeHtml(v.video_name)}"
           data-media-type="${escapeHtml(v.media_type || 'video')}" data-encounter-code="${escapeHtml(v.encounter_code || '')}"
           ${shouldCollapse && i >= COLLAPSE_LIMIT ? 'style="display:none"' : ''}>
        <div class="video-item-name">${escapeHtml(v.video_name)}</div>
        <div class="video-item-meta">
          <span class="status-badge status-${escapeHtml(v.status || 'unassigned')}">${escapeHtml(v.status || 'unassigned')}</span>
          ${v.encounter_code ? `<span>${escapeHtml(v.encounter_code)}</span>` : ''}
          ${v.site ? `<span>${escapeHtml(v.site)}</span>` : ''}
        </div>
      </div>
    `).join("");

    if (shouldCollapse) {
      const toggle = document.createElement("div");
      toggle.className = "video-list-toggle";
      toggle.textContent = `Show ${videos.length - COLLAPSE_LIMIT} more`;
      toggle.style.cssText = "padding:6px 8px;text-align:center;cursor:pointer;color:var(--accent);font-size:13px;";
      let expanded = false;
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        list.querySelectorAll(".collapsed-video").forEach(el => {
          el.style.display = expanded ? "" : "none";
        });
        toggle.textContent = expanded
          ? "Show less"
          : `Show ${videos.length - COLLAPSE_LIMIT} more`;
      });
      list.appendChild(toggle);
    }

    list.querySelectorAll(".video-item").forEach(item => {
      item.addEventListener("click", () => {
        item.classList.add("selected");
        this._switchToItem(item.dataset.id, item.dataset.name, item.dataset.mediaType || "video", item.dataset.encounterCode || "");
      });
    });
  },

  async _switchToItem(id, name, mediaType, encounterCode = "") {
    const seq = ++this._switchSeq;
    // Auto-save current work if dirty
    if (this._dirty && this.currentVideo && !this._saving) {
      const ok = await this._save(true);  // silent auto-save
      // A click on a THIRD item during that save skips the save (this._saving is set)
      // and loads straight away; resuming here would load this item over the one the
      // student is now looking at, and the epoch guard cannot see it because the load
      // below is what bumps the epoch. Last click wins — leave the newer switch alone.
      if (seq !== this._switchSeq) return;
      if (!ok) {
        // The switch below calls resetAll() and clears _dirty, which would throw
        // the work away with no prompt and silence both the beforeunload guard and
        // the auto-save retry. A failed save (401/500/429/dropped connection) must
        // never be turned into silent data loss — ask, and default to keeping it.
        const proceed = window.confirm(
          "Your unsaved work on this item could NOT be saved (the server rejected " +
          "the request or the connection dropped).\n\n" +
          "Switching now will DISCARD it permanently.\n\n" +
          "OK = discard and switch.  Cancel = stay here and try saving again."
        );
        if (!proceed) {
          // Undo the optimistic highlight the click handler applied, and leave
          // _dirty / the canvas exactly as they are so a retry is still possible.
          document.querySelectorAll(".video-item").forEach(i => i.classList.remove("selected"));
          const cur = document.querySelector(`.video-item[data-id="${this.selectedVideoId}"]`);
          if (cur) cur.classList.add("selected");
          this._setStatus("Switch cancelled — your work is still here. Press S to try saving again.", true);
          return;
        }
      }
    }
    document.querySelectorAll(".video-item").forEach(i => i.classList.remove("selected"));
    const target = document.querySelector(`.video-item[data-id="${id}"]`);
    if (target) target.classList.add("selected");
    this.selectedVideoId = id;
    this._loadVideoById(id, name, mediaType, encounterCode);
    // Task tutorials are triggered by panel_ui.js when the annotation UI they teach is
    // actually in front of the labeler — not here, where "a video was selected" no longer
    // implies which task the panel will resolve to.
  },

  /** Start a new video-load epoch. Anything already in flight for the previous
   * video becomes stale the moment this returns. */
  _newLoadEpoch() {
    this._loadEpoch = (this._loadEpoch || 0) + 1;
    return this._loadEpoch;
  },

  _loadVideoPath(id, path, name) {
    this._newLoadEpoch();
    this.currentVideo = { id, video_path: path, video_name: name };
    this._initialFrameLoaded = false;
    window.videoPlayer.load(path);
    document.getElementById("header-video-name").textContent = name;
    this._setStatus(`Loaded: ${name}`);
    this._dirty = false;
    const ec = document.getElementById("enc-code");
    // Auto-fill encounter code from filename: e.g. APT22062203.mp4 → APT22062203
    const match = name.match(/^([A-Z]{2,4}\d+)/);
    if (match) ec.value = match[1];
  },

  _loadVideoById(id, name, mediaType = "video", encounterCode = "") {
    // Clear previous annotations immediately
    window.annotCanvas.resetAll();
    // A new clip is a new context: drop any pinned frame, or the next save would be
    // filed under a frame number belonging to the video we just left.
    this._exitFrameMode();

    // Invalidate every in-flight continuation belonging to the previous video
    // BEFORE any shared state is touched.
    const epoch = this._newLoadEpoch();

    const streamUrl = `/api/videos/${id}/stream`;
    // encounter_code travels WITH the video. It is the key the scar board keys
    // its sighting on, and without it here the only other copy lives in a DOM
    // input the annotator can retype.
    this.currentVideo = { id, video_path: streamUrl, video_name: name,
                          media_type: mediaType, encounter_code: encounterCode || "" };
    this._initialFrameLoaded = false;
    this._dirty = false;
    document.getElementById("header-video-name").textContent = name;
    const ec = document.getElementById("enc-code");
    if (encounterCode) {
      ec.value = encounterCode;
    } else {
      const match = name.match(/^([A-Z]{2,4}\d+)/);
      ec.value = match ? match[1] : "";
    }
    // Take the RESOLVED code, after the filename fallback above — otherwise a
    // video whose assignment carries no encounter_code would give the scar board
    // a different answer from the one on screen, and the sighting would key on
    // an encounter the annotator never sees.
    this.currentVideo.encounter_code = ec.value || "";

    // Auto-switch panel tab based on media type
    this._switchPanelTab(mediaType === "image" ? "pose" : "scars");
    const finishBtn = document.getElementById("btn-finish-video");
    if (finishBtn) finishBtn.style.display = mediaType === "image" ? "none" : "";

    // Hide irrelevant tab button — prevent using pose tools on scar videos and vice versa
    const poseTabBtn = document.querySelector('.panel-right .tab-btn[data-tab="pose"]');
    const scarsTabBtn = document.querySelector('.panel-right .tab-btn[data-tab="scars"]');
    if (mediaType === "image") {
      if (scarsTabBtn) scarsTabBtn.style.display = "none";
      if (poseTabBtn) poseTabBtn.style.display = "";
    } else {
      if (poseTabBtn) poseTabBtn.style.display = "none";
      if (scarsTabBtn) scarsTabBtn.style.display = "";
    }

    // Prepare (download if needed) then load
    this._prepareAndLoadVideo(id, streamUrl, name, mediaType, epoch);
  },

  async _prepareAndLoadVideo(id, streamUrl, name, mediaType, epoch = this._loadEpoch) {
    this._setStatus(`Preparing: ${name}...`);
    // Cancel any previous download poll
    if (this._downloadPoll) { clearInterval(this._downloadPoll); this._downloadPoll = null; }
    // Reset the per-frame annotation cache for the new video so a stale frame
    // from the previous video can never be restored onto this one.
    this._frameAnnotations = new Map();
    this._activeFrameNum = null;

    try {
      const res = await API.post(`/api/videos/${id}/prepare`);
      // /prepare probes the container with cv2, so its latency varies with file
      // size — a big video requested first can easily resolve after a small one
      // requested second. Loading it now would put video A on screen while
      // currentVideo is B, and the next save would post A's pixels under B's id.
      if (epoch !== this._loadEpoch) return;
      if (res.status === "ready") {
        this._setStatus(`Loading: ${name}...`);
        window.videoPlayer.load(streamUrl, mediaType);
        // Real container fps from cv2 — the browser cannot determine this,
        // and every persisted frame_number depends on it.
        if (res.fps) window.videoPlayer.setRealFps(res.fps);
        this._loadSavedAnnotations(id, epoch);
        this._markInProgress(id);
        this._prefetchNext(id);   // warm the next few assignments
        return;
      }

      // Download in progress — show overlay and poll
      const pct = Math.round((res.progress || 0) * 100);
      window.videoPlayer._showLoading(true, `Downloading... ${pct}%`);

      const pollStart = Date.now();
      const MAX_POLL_MS = 180_000; // 3 minute timeout
      // Hold our OWN handle: this._downloadPoll is overwritten by the next video's
      // poll, so a stale tick calling clearInterval(this._downloadPoll) would kill
      // the live poll and leave itself running.
      let handle = null;
      const stop = () => {
        clearInterval(handle);
        if (this._downloadPoll === handle) this._downloadPoll = null;
      };
      handle = setInterval(async () => {
        // Bail if the user switched away (epoch), or this tick belongs to a video
        // that is no longer current.
        if (epoch !== this._loadEpoch || !this.currentVideo || this.currentVideo.id !== id) {
          stop();
          return;
        }
        // Timeout after 3 minutes
        if (Date.now() - pollStart > MAX_POLL_MS) {
          stop();
          window.videoPlayer._showLoading(false);
          this._setStatus("Download timed out. Click video again to retry.");
          return;
        }
        try {
          const s = await API.get(`/api/videos/${id}/download-status`);
          // Re-check AFTER the await — the guard above is stale by now.
          if (epoch !== this._loadEpoch) { stop(); return; }
          if (s.status === "ready") {
            stop();
            window.videoPlayer._showLoading(false);
            this._setStatus(`Loading: ${name}...`);
            window.videoPlayer.load(streamUrl, mediaType);
            // Real container fps from cv2 (variable here is `s`, the poll response).
            if (s.fps) window.videoPlayer.setRealFps(s.fps);
            this._loadSavedAnnotations(id, epoch);
            this._markInProgress(id);
            this._prefetchNext(id);   // warm the next few assignments
          } else if (s.status === "error") {
            stop();
            window.videoPlayer._showLoading(false);
            this._setStatus(`Download failed: ${s.error || "unknown error"}. Click video to retry.`);
          } else {
            const p = Math.round((s.progress || 0) * 100);
            window.videoPlayer._showLoading(true, `Downloading... ${p}%`);
          }
        } catch (e) {
          stop();
          if (epoch !== this._loadEpoch) return;
          window.videoPlayer._showLoading(false);
          this._setStatus("Download status check failed. Click video to retry.");
        }
      }, 2000);
      this._downloadPoll = handle;
    } catch (e) {
      if (epoch !== this._loadEpoch) return;
      this._setStatus(`Error: ${e.message}`);
    }
  },

  // Phase 2 UX #2 — prefetch the next few assignments so advancing is instant.
  // Walks the same non-completed queue order the sidebar shows, and fires the
  // existing /prepare endpoint (idempotent; serves cached files instantly) as
  // fire-and-forget — no polling, no load. Runs only AFTER the current video is
  // ready so it never competes with the active download. tmp_videos eviction is
  // a follow-up safeguard (see plans/05-phase2-ux.md).
  async _prefetchNext(currentId) {
    const queue = (this._allVideos || []).filter(v => v.status !== "completed");
    const idx = queue.findIndex(v => v.id === currentId);
    if (idx < 0) return;
    if (!this._prefetched) this._prefetched = new Set();
    const depth = (window.appState?.config?.video?.prefetch_count) ?? 2;
    let warmed = 0;
    for (let i = idx + 1; i < queue.length && warmed < depth; i++) {
      const v = queue[i];
      if (!v?.id || this._prefetched.has(v.id)) continue;
      this._prefetched.add(v.id);
      warmed++;
      // Allow a later retry if the warm-up request fails.
      API.post(`/api/videos/${v.id}/prepare`).catch(() => this._prefetched.delete(v.id));
    }
  },

  async _markInProgress(videoId) {
    const v = (this._allVideos || []).find(v => v.id === videoId);
    if (v && v.status !== "completed" && v.status !== "in_progress") {
      try {
        await API.patch(`/api/videos/${videoId}/status`, { status: "in_progress" });
        this._updateSidebarStatus(videoId, "in_progress");
      } catch (e) { /* non-critical */ }
    }
  },

  async _loadSavedAnnotations(videoId, epoch = this._loadEpoch) {
    // A stale caller must not even clear the cache — that Map belongs to whatever
    // video is loaded now.
    if (epoch !== this._loadEpoch) return;
    this._frameAnnotations = new Map();
    this._activeFrameNum = null;
    try {
      const res = await API.get(`/api/annotations/video/${videoId}`);
      // Everything below writes shared state (the frame cache, #enc-code, the
      // canvas). If the student has moved on, this response describes a video
      // they are no longer looking at: filling the cache would restore video A's
      // scars onto video B's frames, and overwriting #enc-code would file B's
      // saves under A's encounter — the wrong-encounter row is unrecoverable
      // once it reaches the Sheet and the consensus tables.
      if (epoch !== this._loadEpoch) return;
      const anns = res.annotations || [];
      // Index every saved frame by frame_number so frame navigation can
      // restore the right one instead of bleeding the previous frame forward.
      for (const a of anns) {
        const fn = a.frame_number ?? (a.data && a.data.frame_number) ?? 0;
        if (a.data) this._frameAnnotations.set(fn, a.data);
      }
      if (anns.length > 0) {
        const latest = anns[anns.length - 1];
        const data = latest.data || {};
        // Restore encounter code if present (sticky per video)
        if (data.encounter_code) {
          document.getElementById("enc-code").value = data.encounter_code;
        }
        // Images are single-frame — restore directly. Videos restore per frame
        // on navigation via _syncFrameAnnotations (so the image always matches).
        if (window.videoPlayer.mediaType === "image") {
          window.annotCanvas.restoreAnnotation(data);
        }
        this._setStatus(`Loaded ${anns.length} saved annotation(s) — navigate frames to review`);
      }
    } catch (e) {
      // No saved annotations — that's fine
    }
  },

  // Restore the current frame's saved/draft annotations, or clear the canvas so
  // the previous frame's work doesn't bleed onto this one. Keyed by frame_number
  // via videoPlayer.currentFrame() — the same derivation _save() uses — so save
  // and restore stay consistent within a session. (Cross-session client-fps
  // differences are a known edge, tracked in tasks/todo.md.)
  /** The frame number this annotation is ABOUT.
   *
   *  In frame mode the server already told us, authoritatively, which frame it
   *  decoded — so we use that rather than re-deriving it from the video element's
   *  currentTime. The derivation is only as good as the fps the browser was told,
   *  and it is the thing that put frame numbers in this corpus at half their true
   *  value. Save and the per-frame annotation cache MUST agree on this, or work
   *  gets stored under one number and restored under another. */
  currentFrameNumber() {
    // Single exit on purpose. The decision below IS the definition of "which
    // frame does this annotation belong to", and it stays in this function
    // rather than behind a delegation: tests/test_frame_attribution.py reads
    // this body, and a metric wanting a hook is not a reason to move the one
    // rule this repo has already had two frame-identity bugs about.
    let n;
    // 1. A pinned frame is what the SERVER decoded, so it is authoritative: frame
    //    mode and the clip scrubber both set it, and it cannot drift with fps.
    if (this._pinnedFrame != null) n = this._pinnedFrame;
    // 2. Otherwise the frame this canvas content BELONGS to. _activeFrameNum only
    //    advances in _syncFrameAnnotations — once the canvas has actually been
    //    reset or restored for that frame — so a save can never attribute one
    //    frame's boxes to another while somebody scrubs.
    else if (this._activeFrameNum != null) n = this._activeFrameNum;
    // 3. Free browsing with nothing loaded yet. Images never run
    //    _syncFrameAnnotations, so they land here and get 0, unchanged.
    else n = window.videoPlayer.currentFrame();

    // Point the effort clock at what this just resolved to, rather than deriving
    // "which frame" a second time — a second derivation is a second definition.
    // Same frame is a no-op, so this is a string compare on a hot path.
    window.Effort?.frame?.(this.currentVideo?.id, n);
    return n;
  },

  _syncFrameAnnotations() {
    const vp = window.videoPlayer;
    if (!vp || vp.mediaType !== "video") return;   // images are single-frame
    if (vp.video && !vp.video.paused) return;       // don't churn during playback
    if (!this._frameAnnotations) this._frameAnnotations = new Map();
    const fn = this.currentFrameNumber();
    if (fn === this._activeFrameNum) return;         // same frame — nothing to do
    // Preserve unsaved edits on the frame we're leaving (in memory only; a
    // server save is still required to persist across sessions).
    if (this._activeFrameNum != null && this._dirty) {
      this._frameAnnotations.set(this._activeFrameNum, window.annotCanvas.getAnnotationData());
    }
    this._activeFrameNum = fn;
    const data = this._frameAnnotations.get(fn);
    if (data) window.annotCanvas.restoreAnnotation(data);
    else window.annotCanvas.resetAll();
  },

  // ──────────── Panel tabs ────────────────────────────────────

  _bindPanelTabs() {
    document.querySelectorAll(".panel-right .tab-btn").forEach(btn => {
      btn.addEventListener("click", () => this._switchPanelTab(btn.dataset.tab));
    });
    // "Mark remaining occluded" button
    const markBtn = document.getElementById("btn-mark-occluded");
    if (markBtn) {
      markBtn.addEventListener("click", () => {
        if (window.annotCanvas && window.annotCanvas.markRemainingOccluded) {
          window.annotCanvas.markRemainingOccluded();
        }
      });
    }
  },

  /** Polish 7 Tier 2 — hamburger drawer toggles for mobile (< 768px).
   * Left button opens the video-list panel; right button opens the
   * form/tracks panel. Backdrop click + Esc + selecting a video close. */
  _bindMobileDrawers() {
    const body = document.body;
    const closeAll = () => body.classList.remove("left-drawer-open", "right-drawer-open");
    const toggleClass = (cls) => {
      const isOpen = body.classList.contains(cls);
      closeAll();
      if (!isOpen) body.classList.add(cls);
    };

    document.getElementById("btn-toggle-left")?.addEventListener("click", () => toggleClass("left-drawer-open"));
    document.getElementById("btn-toggle-right")?.addEventListener("click", () => toggleClass("right-drawer-open"));
    document.getElementById("drawer-backdrop")?.addEventListener("click", closeAll);

    // Auto-close left drawer when the user picks a video (so they see the canvas)
    // #video-list (templates/index.html:81) is the container _renderVideoList fills.
    // This read #my-videos, which exists nowhere, so on mobile the drawer stayed open
    // over the canvas after picking a clip.
    const videoList = document.getElementById("video-list");
    if (videoList) {
      videoList.addEventListener("click", (e) => {
        // Only close if a video row was actually clicked (not the search box)
        if (e.target.closest(".video-item")) {
          closeAll();
        }
      });
    }

    // Esc closes any open drawer
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (body.classList.contains("left-drawer-open") || body.classList.contains("right-drawer-open"))) {
        closeAll();
      }
    });

    // If the viewport widens past mobile breakpoint, close drawers (they're not relevant on desktop)
    window.matchMedia("(min-width: 768px)").addEventListener("change", (ev) => {
      if (ev.matches) closeAll();
    });
  },

  _switchPanelTab(tabName) {
    this._activeTab = tabName;
    document.querySelectorAll(".panel-right .tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    document.querySelectorAll(".panel-right .tab-content").forEach(el => {
      el.classList.toggle("active", el.id === `tab-${tabName}`);
    });
    // Two "swap the sides label for the pose tab" lines lived here and are gone.
    // Neither did what it said: `[data-group="sides"][data-val="Both"]` matched
    // nothing (the side control is a two-button Right/Left group with
    // data-group="scar-side"), and the second used an unanchored
    // `.radio-group > label`, which matches the FIRST such label in the document —
    // "Scars visible:". Since this runs on every video load, opening any clip
    // silently relabelled the scars-visible control, and that field feeds
    // dwc:occurrenceStatus=absent.
    //
    // An id-scoped version was tried instead of deleting them, and
    // tests/test_dom_targets.py rejects it: `#sides-visible-label` exists in no
    // template, and a getElementById that never resolves is a control that does
    // nothing while looking like it works. If a shared sides label is wanted for
    // the pose tab, add it to the template first and target that.
    // Keypoint and Body are POSE tools; off the pose task they are hidden.
    //
    // Body used to stay visible on the scars task relabelled "Box [B]", which put
    // two free-draw box buttons side by side, and the one a labeler reaches for by
    // name drew the BODY box. A scar box is not free-draw at all: the form arms the
    // canvas ("+ ADD SCAR"), which is why #tool-scar has been display:none for
    // years. So on the scars task the only box you draw by hand is an ROI, and B is
    // what draws it. The body box is still one tab away, on Pose, where it is the
    // task rather than a trap.
    const isPose = tabName === "pose";
    document.getElementById("tool-keypoint").style.display = isPose ? "" : "none";
    const bboxBtn = document.getElementById("tool-bbox");
    if (bboxBtn) {
      bboxBtn.style.display = isPose ? "" : "none";
      bboxBtn.innerHTML = "⬛ Body [B]";
    }
    // Say which key actually reaches ROI here. B falls through to it wherever Body
    // is not offered; its own shortcut is server-configured, so read it rather than
    // hardcoding "G" and lying whenever someone changes it.
    const roiBtn = document.getElementById("tool-roi");
    if (roiBtn) {
      const key = isPose ? (window.ROI?.shortcut || "g").toUpperCase() : "B";
      roiBtn.innerHTML = `▢ ROI [${key}]`;
      roiBtn.title = `[${key}] Mark region of interest (no scar form)`;
    }
    // The pose tour fires from panel_ui.js on arrival at the pose task; see _notifyTask.
  },

  // ──────────── Video search ────────────────────────────────────

  _filterVideos() {
    const q = (document.getElementById("video-search").value || "").toLowerCase().trim();
    const mt = (document.getElementById("media-type-filter")?.value) || "all";
    let filtered = (this._allVideos || []).filter(v => v.status !== "completed");
    if (mt !== "all") {
      filtered = filtered.filter(v => (v.media_type || "video") === mt);
    }
    if (q) {
      filtered = filtered.filter(v =>
        (v.video_name || "").toLowerCase().includes(q) ||
        (v.encounter_code || "").toLowerCase().includes(q) ||
        (v.site || "").toLowerCase().includes(q) ||
        (v.status || "").toLowerCase().includes(q)
      );
    }
    this._renderVideoList(filtered, !!(q || mt !== "all"));
  },

  _renderCompletedList() {
    const q = (document.getElementById("completed-search")?.value || "").toLowerCase().trim();
    const sortBy = document.getElementById("completed-sort")?.value || "recent";

    let completed = (this._allVideos || []).filter(v => v.status === "completed");

    // Search filter
    if (q) {
      completed = completed.filter(v =>
        (v.video_name || "").toLowerCase().includes(q) ||
        (v.encounter_code || "").toLowerCase().includes(q) ||
        (v.site || "").toLowerCase().includes(q)
      );
    }

    // Sort
    completed.sort((a, b) => {
      switch (sortBy) {
        case "recent":
          return (b.completed_at || b.add_date || "").localeCompare(a.completed_at || a.add_date || "");
        case "oldest":
          return (a.completed_at || a.add_date || "").localeCompare(b.completed_at || b.add_date || "");
        case "name":
          return (a.video_name || "").localeCompare(b.video_name || "");
        case "encounter":
          return (a.encounter_code || "").localeCompare(b.encounter_code || "");
        case "site":
          return (a.site || "").localeCompare(b.site || "");
        default:
          return 0;
      }
    });

    const list = document.getElementById("completed-list");
    if (!list) return;
    if (!completed.length) {
      list.innerHTML = q
        ? '<p class="muted">No matching completed annotations</p>'
        : '<p class="muted">No completed annotations</p>';
      return;
    }
    const COLLAPSE_LIMIT = 20;
    const shouldCollapse = completed.length > COLLAPSE_LIMIT;

    list.innerHTML = completed.map((v, i) => `
      <div class="video-item${shouldCollapse && i >= COLLAPSE_LIMIT ? ' collapsed-completed' : ''}"
           data-id="${escapeHtml(v.id)}" data-path="${escapeHtml(v.video_path || '')}"
           data-name="${escapeHtml(v.video_name)}" data-media-type="${escapeHtml(v.media_type || 'video')}"
           data-encounter-code="${escapeHtml(v.encounter_code || '')}"
           ${shouldCollapse && i >= COLLAPSE_LIMIT ? 'style="display:none"' : ''}>
        <div class="video-item-name">${escapeHtml(v.video_name)}</div>
        <div class="video-item-meta">
          <span class="status-badge status-completed">completed</span>
          ${v.encounter_code ? `<span>${escapeHtml(v.encounter_code)}</span>` : ''}
          ${v.site ? `<span>${escapeHtml(v.site)}</span>` : ''}
        </div>
        ${sortBy === "recent" || sortBy === "oldest"
          ? `<div class="video-item-meta" style="font-size:10px;color:var(--text-muted)">${v.completed_at ? new Date(v.completed_at).toLocaleDateString() : ''}</div>`
          : ''}
      </div>
    `).join("");

    if (shouldCollapse) {
      const toggle = document.createElement("div");
      toggle.className = "video-list-toggle";
      toggle.textContent = `Show ${completed.length - COLLAPSE_LIMIT} more completed`;
      toggle.style.cssText = "padding:6px 8px;text-align:center;cursor:pointer;color:var(--accent);font-size:13px;";
      let expanded = false;
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        list.querySelectorAll(".collapsed-completed").forEach(el => {
          el.style.display = expanded ? "" : "none";
        });
        toggle.textContent = expanded
          ? "Show less"
          : `Show ${completed.length - COLLAPSE_LIMIT} more completed`;
      });
      list.appendChild(toggle);
    }

    list.querySelectorAll(".video-item").forEach(item => {
      item.addEventListener("click", () => {
        item.classList.add("selected");
        this._switchToItem(item.dataset.id, item.dataset.name, item.dataset.mediaType || "video", item.dataset.encounterCode || "");
      });
    });
  },

  _bindCompletedSearch() {
    const input = document.getElementById("completed-search");
    const sort = document.getElementById("completed-sort");
    if (input) input.addEventListener("input", () => this._renderCompletedList());
    if (sort) sort.addEventListener("change", () => this._renderCompletedList());
  },

  _updateProgressBar(scarCount, poseCount) {
    if (scarCount !== undefined) this._scarCount = scarCount;
    if (poseCount !== undefined) this._poseCount = poseCount;

    const scars = this._scarCount || 0;
    const scarGoal = this._scarGoal || 150;
    const scarPct = Math.min(100, (scars / scarGoal) * 100);
    const scarText = document.getElementById("progress-text-scars");
    const scarFill = document.getElementById("progress-fill-scars");
    if (scarText) scarText.textContent = `${scars} / ${scarGoal} scars`;
    if (scarFill) scarFill.style.width = `${scarPct}%`;

    const poses = this._poseCount || 0;
    const poseGoal = this._poseGoal || 50;
    const posePct = Math.min(100, (poses / poseGoal) * 100);
    const poseText = document.getElementById("progress-text-poses");
    const poseFill = document.getElementById("progress-fill-poses");
    if (poseText) poseText.textContent = `${poses} / ${poseGoal} poses`;
    if (poseFill) poseFill.style.width = `${posePct}%`;

    const stripEl = document.getElementById("progress-strip");
    if (stripEl) stripEl.style.display = "";
  },

  _bindVideoSearch() {
    const input = document.getElementById("video-search");
    const mtFilter = document.getElementById("media-type-filter");
    input.addEventListener("input", () => this._filterVideos());
    if (mtFilter) mtFilter.addEventListener("change", () => this._filterVideos());
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

  _maybeNudgeFollowScar(scarsSaved) {
    // Once a student has drawn a few scars frame-by-frame, suggest following one
    // across the clip instead — the efficient path they otherwise never discover.
    // One-time (localStorage), video-only, and only when tracks are available.
    if (this._followNudgeShown) return;
    if (localStorage.getItem("followScarNudged") === "1") { this._followNudgeShown = true; return; }
    if (!window.videoPlayer || window.videoPlayer.mediaType !== "video") return;
    const panel = document.getElementById("tracks-panel");
    if (!panel || panel.style.display === "none") return;   // tracks not available
    this._manualScarCount = (this._manualScarCount || 0) + (scarsSaved || 0);
    if (this._manualScarCount < 3) return;
    this._followNudgeShown = true;
    try { localStorage.setItem("followScarNudged", "1"); } catch (e) { /* private mode */ }
    this._setStatus("Tip: instead of drawing each scar frame by frame, draw one box and click 'Follow this scar' — the app tracks it across the whole clip so you just verify.");
    if (window.Tutorial && !window.Tutorial.isActive?.() && !this.currentUser?.tutorial_states?.follow_scar) {
      setTimeout(() => window.Tutorial.start("follow_scar"), 500);
    }
  },

  // ──────────── Auto-save ───────────────────────────────────────

  _startAutoSave() {
    // Base 5 minutes + random 0-60s jitter to prevent thundering herd with many users
    const baseSec = 300;
    const jitterSec = Math.floor(Math.random() * 60);
    const intervalMs = (baseSec + jitterSec) * 1000;
    this._autoSaveTimer = setInterval(() => {
      if (this._dirty && this.currentVideo && !this._saving) {
        this._save(true); // silent auto-save
      }
    }, intervalMs);
  },

  // ──────────── Frame display ───────────────────────────────────

  _displayFrame(b64) {
    this.currentFrameB64 = b64;
    const preserve = this._initialFrameLoaded;
    this._initialFrameLoaded = true;
    // Brightness/contrast are applied by the canvas as it draws, so the frame we
    // hand it here is always the one the camera recorded. See _bindEnhancement.
    window.annotCanvas.setFrame(b64, preserve);
  },

  // ──────────── Canvas click -> SAM ─────────────────────────────

  async handleCanvasClick(imgX, imgY, mode) {
    if (!this.currentFrameB64) return;
    this._setStatus("Segmenting (this may take a moment)...");
    // SAM2 on CPU takes seconds. A mask or scar committed after a switch is annotation
    // data written onto the wrong video — and _markDirty() would then make it look like
    // work the student did on the new one.
    const epoch = this._loadEpoch;
    try {
      const res = await API.post("/api/frames/segment", {
        frame_b64: this.currentFrameB64,
        points: [[Math.round(imgX), Math.round(imgY)]],
        neg_points: [],
        is_body: mode === "body",
      });
      if (epoch !== this._loadEpoch) return;

      if (res.error) {
        this._setStatus(res.error, true);
        window.annotCanvas.setMode("bbox");
        document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
        document.getElementById("tool-bbox").classList.add("active");
        return;
      }

      if (mode === "body") {
        window.annotCanvas.setBodyMask(res.mask_b64);
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

  /** Brightness and contrast are a DISPLAY control, applied by the canvas as it
   *  draws (canvas.js `_imageFilter`).
   *
   *  They used to POST the frame to /api/frames/enhance and paint the reply, which
   *  meant they did nothing whatsoever on clip work: the movement strip writes
   *  straight to the canvas, so `currentFrameB64` was a DIFFERENT frame, and the
   *  round-trip painted that one over what the labeler was looking at. It was also
   *  a 300ms debounce onto a route rate-limited at 30/min — a slider you could
   *  exhaust by dragging it. Doing it at draw time is instant, works on whatever is
   *  on the canvas, and leaves the saved frame untouched. */
  _bindEnhancement() {
    const bSlider = document.getElementById("brightness-slider");
    const cSlider = document.getElementById("contrast-slider");
    const bVal    = document.getElementById("brightness-val");
    const cVal    = document.getElementById("contrast-val");

    const apply = () => {
      this.brightnessVal = parseInt(bSlider.value, 10);
      this.contrastVal   = parseInt(cSlider.value, 10) / 100;
      bVal.textContent = this.brightnessVal;
      cVal.textContent = this.contrastVal.toFixed(1) + "x";
      // -100..100 reads as a percentage either side of the frame as recorded.
      window.annotCanvas.setEnhancement(1 + this.brightnessVal / 100, this.contrastVal);
    };

    bSlider.addEventListener("input", apply);
    cSlider.addEventListener("input", apply);

    document.getElementById("btn-reset-enhance").addEventListener("click", () => {
      bSlider.value = 0; cSlider.value = 100;
      apply();
      window.annotCanvas.zoom_reset();
    });
  },

  // ──────────── Toolbar ─────────────────────────────────────────

  _bindToolbar() {
    const toolMap = {
      "tool-scar":     "scar",
      "tool-keypoint": "keypoint",
      "tool-bbox":     "bbox",
    };
    Object.entries(toolMap).forEach(([id, mode]) => {
      document.getElementById(id).addEventListener("click", () => {
        window.annotCanvas.setMode(mode);
        this._activateTool(id);
        // Auto-start skeleton when entering keypoint mode with no keypoints
        if (mode === "keypoint" && Object.keys(window.annotCanvas.keypoints).length === 0 && !window.annotCanvas._skeletonPhase) {
          window.annotCanvas.startSkeleton();
        }
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
    // Left panel tabs (My Videos / Completed) — scoped to .panel-left
    document.querySelectorAll(".panel-left > .panel-tabs .tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll(".panel-left > .panel-tabs .tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".panel-left > .tab-content").forEach(c => c.classList.remove("active"));
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

  /** Filling the form IS the request to draw the box.
   *
   *  There is no button. Describing a scar and then pressing a control that says
   *  "add scar" is asking somebody to confirm the thing they just spent four
   *  fields saying: the form cannot be complete for a scar that is not there. So
   *  the moment the last required field lands, the canvas arms itself and says
   *  where to draw.
   *
   *  Armed once per description, not on every keystroke: re-arming while somebody
   *  edits a field would yank them back to draw mode mid-correction.
   */
  _bindScarActions() {
    const armIfComplete = () => {
      if (window.ScarForm.validate()) {          // still missing something
        this._scarArmed = false;
        return;
      }
      if (this._scarArmed) return;
      this._scarArmed = true;
      // A box already drawn and held back (the model was unsure, scar_hints.js) is
      // committed instead of asking for a second one.
      if (this._onScarFormComplete && this._onScarFormComplete()) return;
      window.annotCanvas.setMode("scar");
      this._activateTool("tool-scar");
      this._setStatus("Now draw a box around that scar");
    };
    // Every control that can complete the form, plus the zone picker and the
    // colour buttons, which write through hidden inputs rather than firing input.
    ["scar-type", "zone-value", "color-value", "color-other-input"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) ["change", "input"].forEach((ev) => el.addEventListener(ev, armIfComplete));
    });
    document.querySelectorAll('.zone-seg, .color-btn, .radio-btn[data-group="scar-side"]')
      .forEach((el) => el.addEventListener("click", () => setTimeout(armIfComplete, 0)));
    this._armScarIfComplete = armIfComplete;
  },

  // ──────────── Save / Export ───────────────────────────────────

  _bindSaveExport() {
    document.getElementById("btn-save-ann").addEventListener("click", () => this._save());
    document.getElementById("btn-save-and-next").addEventListener("click", async () => {
      // Captured BEFORE the await: `this.currentVideo` read afterwards is whatever the
      // student switched to mid-save, and this branch PATCHes it completed and wipes
      // its canvas — marking an item nobody has annotated as done.
      const epoch = this._loadEpoch;
      const completedId = this.currentVideo?.id;
      const isImage = window.videoPlayer.mediaType === "image";
      const ok = await this._save();
      if (ok) {
        if (epoch !== this._loadEpoch) return;
        // For images, mark as completed in backend
        if (isImage) {
          try {
            await API.patch(`/api/videos/${completedId}/status`, { status: "completed" });
          } catch (e) { /* non-critical */ }
        }
        window.annotCanvas.resetAll();
        window.ScarForm.resetScarFields();
        if (isImage) {
          // Advance BEFORE updating sidebar (which re-filters the list)
          this._advanceToNext();
          this._updateSidebarStatus(completedId, "completed");
        } else {
          window.videoPlayer.stepFrame(1);
        }
      }
    });
    document.getElementById("btn-save-no-scars").addEventListener("click", async () => {
      // Clear canvas first so we don't save stale bbox/mask data with a "no scars" annotation
      window.annotCanvas.resetAll();
      const epoch = this._loadEpoch;
      const ok = await this._save();
      if (ok) {
        if (epoch !== this._loadEpoch) return;   // stepping the video they switched to
        window.videoPlayer.stepFrame(1);
        this._setStatus("Saved — no scars. Next frame ready.");
      }
    });
    document.getElementById("btn-finish-video").addEventListener("click", async () => {
      if (!this.currentVideo) return;
      if (!confirm("Mark this video as complete?\nThis counts toward your semester quota.")) return;

      // The video being finished is the one that was on screen when the button was
      // pressed. Reading this.currentVideo after the save would complete whatever the
      // student switched to — a quota credit and a status change on the wrong video.
      const epoch = this._loadEpoch;
      const finishId = this.currentVideo.id;

      // Save current frame first
      await this._save(true);

      try {
        const res = await API.post(`/api/videos/${finishId}/complete`);
        const autoMsg = res.auto_assigned ? ` (${res.auto_assigned} new auto-assigned)` : "";
        this._setStatus(`Video completed! ${res.encounter_code || ""}${autoMsg}`);

        // Refresh the video list to show updated statuses + any auto-assigned items
        await this._loadMyVideos();

        // The completion above is honoured whatever happened meanwhile — the student
        // asked for it explicitly. Everything below REPLACES what is on screen, so it
        // must not run once they have opened something else.
        if (epoch !== this._loadEpoch) return;

        // Load next assigned video if available
        if (res.next_video) {
          window.annotCanvas.resetAll();
          this._loadVideoById(res.next_video.id, res.next_video.video_name, res.next_video.media_type || "video", res.next_video.encounter_code || "");
          // Highlight the next video in the refreshed list
          const nextItem = document.querySelector(`.video-item[data-id="${res.next_video.id}"]`);
          if (nextItem) {
            document.querySelectorAll(".video-item").forEach(i => i.classList.remove("selected"));
            nextItem.classList.add("selected");
          }
          this._setStatus(`Video completed! Loading next: ${res.next_video.video_name}${autoMsg}`);
        } else {
          window.annotCanvas.resetAll();
          this._newLoadEpoch();
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

    // Run keypoint validation before save (non-blocking on error)
    if (!silent && !this._noSharkFlag && window.validateKeypoints) {
      try {
        const preAnn = window.annotCanvas.getAnnotationData();
        const validation = window.validateKeypoints(preAnn.keypoints, preAnn.body_bbox);
        if (validation.errors.length > 0 || validation.warnings.length > 0) {
          const proceed = await this._showValidationDialog(validation);
          if (!proceed) return false;
        }
      } catch (e) {
        console.warn("Keypoint validation error (saving anyway):", e);
      }
    }

    this._saving = true;
    const saveBtn = document.getElementById("btn-save-ann");
    const saveNextBtn = document.getElementById("btn-save-and-next");
    const noScarsBtn = document.getElementById("btn-save-no-scars");
    saveBtn.disabled = true;
    saveNextBtn.disabled = true;
    noScarsBtn.disabled = true;
    if (!silent) this._setStatus("Saving...");

    try {
      // Everything this save is *about* is captured synchronously, epoch included.
      // _switchToItem deliberately skips the pre-switch save while one is in flight,
      // so the video can change underneath the continuation below.
      const savedEpoch = this._loadEpoch;
      const savedVideoId = this.currentVideo.id;
      const enc = window.ScarForm.getEncounterValues();
      const ann = window.annotCanvas.getAnnotationData();
      const frameNum = this.currentFrameNumber();
      const frameImage = window.videoPlayer.captureCurrentFrame();
      const payload = {
        ...enc,
        ...ann,
        video_id: savedVideoId,
        video_name: this.currentVideo.video_name,
        frame_number: frameNum,
        annotator: this.currentUser?.email || "",
        frame_image_b64: frameImage || null,
        // null when recording is off, and the server ignores it either way
        // unless metrics.effort.record says otherwise.
        active_ms: window.Effort?.value?.() ?? null,
        ...(this._noSharkFlag ? { no_shark: true } : {}),
      };
      const res = await API.post("/api/annotations", payload);
      // Only now: a save that threw above must not lose the minutes it took,
      // and a clock left un-reset would bill the next save for them twice.
      window.Effort?.reset?.();

      // Verified save confirmation with sync status
      if (res.verified && res.annotator === this.currentUser?.email) {
        const time = new Date(res.timestamp).toLocaleTimeString();
        let msg = silent
          ? `Auto-saved Frame ${res.frame_number}`
          : `\u2713 Saved Frame ${res.frame_number} by ${res.annotator} at ${time}`;
        // Sheets/Drive sync is asynchronous: /api/annotations writes the job to the
        // outbox in the same transaction as the annotation and returns immediately, so
        // it cannot report whether the Sheet was written. It reports `sync_queued`
        // (and `sync_disabled` for the DISABLE_SYNC_QUEUE dev kill switch) - say that,
        // and nothing stronger. The old branch tested `sheet_synced`/`drive_synced`,
        // fields no response has ever carried: the success line was unreachable and so
        // was the "sync incomplete" warning, which would have been the only warning a
        // student ever saw about a failed export.
        if (res.sync_disabled === true) {
          msg += " \u00b7 Sheet/Drive sync off";
        } else if (res.sync_queued === true) {
          msg += " \u00b7 Queued for Sheet & Drive";
        }
        this._setStatus(msg);
      } else {
        this._setStatus("Save may not have completed - please retry", true);
      }

      // Green flash on save button
      if (!silent) {
        saveBtn.classList.add("save-flash");
        setTimeout(() => saveBtn.classList.remove("save-flash"), 600);
      }

      // Only touch per-video state if we are STILL on the video this save was for.
      // If the student switched mid-flight, `_dirty` now belongs to the new video
      // (clearing it silences the beforeunload guard, the auto-save and the
      // preserve branch in _syncFrameAnnotations, so their new work is dropped on
      // the next frame step) and `_frameAnnotations` is the new video's cache
      // (writing into it files this video's scars under the other video's frame).
      const stillCurrent = (savedEpoch === this._loadEpoch);
      if (stillCurrent) {
        this._dirty = false;
        // Remember this frame's saved state so navigating back to it restores
        // correctly (and Save&Next's canvas reset can't overwrite it).
        if (this._frameAnnotations) {
          this._frameAnnotations.set(frameNum, ann);
          this._activeFrameNum = frameNum;
        }
      }
      // Update scar progress bar
      if (res.scar_count !== undefined) this._updateProgressBar(res.scar_count, res.pose_count);
      // Stream D (plan 10): retire the leased work item and pull the next one.
      // Only on an explicit save — an auto-save is a checkpoint, not "done".
      if (!silent && window.WorkQueue?.enabled) {
        window.WorkQueue.complete(res.annotation_id ?? res.id ?? null);
      }
      // Nudge toward the follow-a-scar workflow after a few manual scars
      this._maybeNudgeFollowScar((ann.scars || []).length);
      // Mark the video this save belongs to in_progress (but don't downgrade from
      // completed). Keyed on savedVideoId, not the live one — a mid-flight switch
      // would otherwise stamp in_progress onto a video nobody has annotated yet.
      const curVid = (this._allVideos || []).find(v => v.id === savedVideoId);
      if (curVid && curVid.status !== "completed") {
        try {
          await API.patch(`/api/videos/${savedVideoId}/status`, { status: "in_progress" });
          this._updateSidebarStatus(savedVideoId, "in_progress");
        } catch (e) { /* non-critical */ }
      }
      return true;
    } catch (e) {
      this._setStatus("Save failed: " + e.message, true);
      return false;
    } finally {
      this._saving = false;
      saveBtn.disabled = false;
      saveNextBtn.disabled = false;
      noScarsBtn.disabled = false;
    }
  },

  _showValidationDialog(validation) {
    return new Promise((resolve) => {
      // Remove existing dialog if any
      const existing = document.getElementById("kp-validation-dialog");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.id = "kp-validation-dialog";
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;";

      const box = document.createElement("div");
      box.style.cssText = "background:#1e1e2e;border:1px solid #444;border-radius:8px;padding:20px;max-width:480px;width:90%;max-height:80vh;overflow-y:auto;color:#e0e0e0;font-family:system-ui,sans-serif;";

      let html = '<h3 style="margin:0 0 12px;color:#f0c040;">⚠ Keypoint Check</h3>';

      if (validation.errors.length > 0) {
        html += '<div style="margin-bottom:10px;">';
        for (const e of validation.errors) {
          html += `<div style="color:#ff6b6b;margin:4px 0;font-size:13px;">✗ ${e}</div>`;
        }
        html += '</div>';
      }

      if (validation.warnings.length > 0) {
        html += '<div style="margin-bottom:10px;">';
        for (const w of validation.warnings) {
          html += `<div style="color:#f0c040;margin:4px 0;font-size:13px;">⚠ ${w}</div>`;
        }
        html += '</div>';
      }

      html += '<div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end;">';
      html += '<button id="kp-val-fix" style="padding:8px 16px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">Fix Keypoints</button>';
      html += '<button id="kp-val-save" style="padding:8px 16px;background:#2d7d46;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">Save Anyway</button>';
      html += '</div>';

      box.innerHTML = html;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      document.getElementById("kp-val-fix").addEventListener("click", () => {
        overlay.remove();
        resolve(false);
      });
      document.getElementById("kp-val-save").addEventListener("click", () => {
        overlay.remove();
        resolve(true);
      });

      // Escape key = fix
      const onKey = (e) => {
        if (e.key === "Escape") {
          overlay.remove();
          document.removeEventListener("keydown", onKey);
          resolve(false);
        }
      };
      document.addEventListener("keydown", onKey);
    });
  },

  async _markNoShark() {
    window.annotCanvas.resetAll();
    this._setStatus("Marking no shark...");
    this._noSharkFlag = true;
    // Same rule as the save/finish paths: the item being marked "no shark" is the one
    // that was on screen when the key was pressed. Read after the await, this is
    // whatever the student opened meanwhile — and it would be marked completed.
    const epoch = this._loadEpoch;
    const completedId = this.currentVideo.id;
    const ok = await this._save(true);
    this._noSharkFlag = false;
    if (ok) {
      // Mark as completed in backend
      try {
        await API.patch(`/api/videos/${completedId}/status`, { status: "completed" });
      } catch (_) {}
      if (epoch !== this._loadEpoch) return;   // do not advance past their new choice
      // Brief delay so user sees the status before advancing
      this._setStatus("\u2713 No shark — saved & completed");
      setTimeout(() => {
        if (epoch !== this._loadEpoch) return;
        // Advance BEFORE updating sidebar (which re-filters the list)
        this._advanceToNext();
        this._updateSidebarStatus(completedId, "completed");
      }, 400);
    }
  },

  _updateSidebarStatus(videoId, status) {
    const item = document.querySelector(`.video-item[data-id="${videoId}"]`);
    if (item) {
      const badge = item.querySelector(".status-badge");
      if (badge) {
        badge.className = `status-badge status-${status}`;
        badge.textContent = status;
      }
    }
    // Update in-memory data and refresh both lists
    const v = (this._allVideos || []).find(v => v.id === videoId);
    if (v) {
      v.status = status;
      if (status === "completed") v.completed_at = new Date().toISOString();
    }
    this._filterVideos();
    this._renderCompletedList();
  },

  _advanceToNext() {
    const list = document.getElementById("video-list");
    const items = Array.from(list.querySelectorAll(".video-item"));
    const curIdx = items.findIndex(i => i.dataset.id === this.selectedVideoId);
    if (curIdx >= 0 && curIdx < items.length - 1) {
      items[curIdx + 1].click();
    } else {
      // No more items — clear canvas and player
      window.annotCanvas.resetAll();
      window.annotCanvas.baseImage = null;
      window.annotCanvas.frameB64 = null;
      this._newLoadEpoch();
      this.currentVideo = null;
      this._setStatus("All done! No more items in list.");
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
    // Admin actions are now handled in the Admin Dashboard (/admin/dashboard)
  },

  // ──────────── Keyboard shortcuts ──────────────────────────────

  /** Can this mission use that tool?
   *
   *  Read back off the toolbar, which `panel_ui._toolsFor` and `_switchTab` already
   *  scope to the task, rather than keeping a second list of which keys belong to
   *  which mission — two lists drift, and the drift shows up as a scar annotator
   *  pressing K, getting a half-placed skeleton on a clip nobody asked them to
   *  pose, and saving it. If the tool is not offered, the key cannot summon it. */
  _toolOffered(id) {
    const b = document.getElementById(id);
    return !!b && b.offsetParent !== null;
  },

  _bindKeyboard() {
    document.addEventListener("keydown", e => {
      const tag = document.activeElement.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (inInput) return;

      // S = save + advance to next frame (or next item for images)
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        this._save().then(ok => {
          if (ok) {
            if (window.videoPlayer.mediaType === "image") {
              this._advanceToNext();
            } else {
              window.videoPlayer.stepFrame(1);
            }
          }
        });
        return;
      }

      switch (e.key) {
        // Transport belongs to whatever the labeler is actually looking at. On
        // queue work that is the server-decoded strip: the <video> element is
        // hidden, and on these HEVC clips it could not decode them anyway, so
        // togglePlay() there was a keypress into a void.
        case " ":
          e.preventDefault();
          if (window.FrameContext?.isActive()) {
            window.FrameContext.togglePlay();
          } else if (window.videoPlayer.mediaType === "image") {
            this._markNoShark();
          } else {
            window.videoPlayer.togglePlay();
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (window.FrameContext?.isActive()) window.FrameContext.step(e.shiftKey ? -10 : -1);
          else window.videoPlayer.stepFrame(e.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (window.FrameContext?.isActive()) window.FrameContext.step(e.shiftKey ? 10 : 1);
          else window.videoPlayer.stepFrame(e.shiftKey ? 10 : 1);
          break;
        // F shortcut removed — Body tool removed, Box [B] relabels to Body on Pose tab
        // S shortcut disabled — use "+ ADD SCAR" button instead
        // case "s": case "S":
        //   e.preventDefault();
        //   window.annotCanvas.setMode("scar");
        //   this._activateTool("tool-scar");
        //   break;
        case "k": case "K":
          if (!this._toolOffered("tool-keypoint")) break;
          e.preventDefault();
          window.annotCanvas.setMode("keypoint");
          this._activateTool("tool-keypoint");
          // Auto-start skeleton if no keypoints placed yet
          if (Object.keys(window.annotCanvas.keypoints).length === 0 && !window.annotCanvas._skeletonPhase) {
            window.annotCanvas.startSkeleton();
          }
          break;
        case "b": case "B":
          // One key, one idea: "draw the box this task lets you draw by hand".
          // On pose that is the body box. On scars the body box is not offered and
          // the scar box comes from the form, so B reaches ROI instead. ROI keeps
          // its own server-configured shortcut as well; this is a fallback, not a
          // second binding competing with it.
          if (this._toolOffered("tool-bbox")) {
            e.preventDefault();
            window.annotCanvas.setMode("bbox");
            this._activateTool("tool-bbox");
          } else if (window.ROI?.available) {
            e.preventDefault();
            window.ROI.toggle();
          }
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
        case "o": case "O":
          if (window.annotCanvas.mode === "keypoint") {
            e.preventDefault();
            window.annotCanvas.markCurrentOccluded();
            this._markDirty();
          }
          break;
        case "x": case "X":
          if (window.annotCanvas.mode === "keypoint") {
            e.preventDefault();
            window.annotCanvas.skipKeypoint();
            this._markDirty();
          }
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
          window.annotCanvas.cancelBbox();
          window.annotCanvas.setMode("browse");
          this._activateTool(null);
          document.getElementById("shortcuts-modal").classList.add("hidden");
          window.ScarForm?.closeConfidenceRubric?.();
          document.getElementById("bbox-label-popup").classList.add("hidden");
          break;
        default:
          if (/^[1-5]$/.test(e.key)) {
            window.ScarForm.setConfidence(+e.key);
          }
      }
    });
  },

  // ──────────── Feature flags ─────────────────────────────────

  /** Fetch server feature flags + client-tunable config once, and KEEP them.
   *
   *  This used to fetch the payload and use it only to disable `#tool-body`, an
   *  element that does not exist in either template — so the request was made and
   *  the answer thrown away on every startup. Meanwhile app.js and tracks.js both
   *  read knobs off `appState.config`, which nothing assigned, so they were stuck
   *  on their fallbacks. Storing the response here is what connects the two.
   *
   *  The SAM2 tool gate is gone rather than repointed: no button enters "body"
   *  mode and nothing calls setMode("body"), so /api/frames/segment is unreachable
   *  from the UI. The server route stays (tested, harmless) as an API-only surface;
   *  re-add a gate here alongside a real tool button if that path is ever wired up. */
  async _checkFeatures() {
    try {
      this.config = await API.get("/api/config/features");
      // OFF unless the server says otherwise, so an unreachable /features means
      // "do not time anybody" rather than "time everybody".
      window.Effort?.init?.({ record: !!this.config?.effort_record });
    } catch (e) { /* non-critical — readers fall back to their defaults */ }
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
