/**
 * video_player.js — HTML5 video player with frame-accurate controls.
 * Supports both video and image media types.
 * Exposes: VideoPlayer (class), window.videoPlayer (singleton)
 */
"use strict";

class VideoPlayer {
  constructor() {
    this.video     = document.getElementById("video-element");
    this.imageEl   = document.getElementById("image-element");
    this.seekBar   = document.getElementById("seek-bar");
    this.timeDisp  = document.getElementById("time-display");
    this.frameDisp = document.getElementById("frame-display");
    this.playBtn   = document.getElementById("ctrl-play");
    this.speedSel  = document.getElementById("speed-select");

    this.fps        = 30;
    this.totalFrames = 0;
    this.videoPath  = "";
    this.mediaType  = "video";  // "video" or "image"
    this.onFrameChange = null;   // callback(frameIndex)

    // Prevent video element from stealing arrow key events
    // (browser default: 5s seek jumps when <video> has focus)
    this.video.tabIndex = -1;

    this._bindEvents();
  }

  // ──────────────────────────────────────────
  load(mediaPath, mediaType = "video") {
    this.videoPath = mediaPath;
    this.mediaType = mediaType;
    // Clear per-video: a real fps from the PREVIOUS clip must never be applied to
    // this one. setRealFps() re-arms it once the server answers.
    this.fpsIsReal = false;

    if (mediaType === "image") {
      // Image mode: hide both <video> and <img> — canvas renders the frame
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.style.display = "none";
      this.imageEl.style.display = "none";  // kept off-screen; only used by captureCurrentFrame()
      this.imageEl.src = mediaPath;
      this.fps = 1;
      this.totalFrames = 1;
      this._setControlsEnabled(false);

      this.imageEl.onload = () => {
        this._updateDisplay();
        if (this.onFrameChange) this.onFrameChange(0);
      };
      // Stream URLs are /api/videos/<id>/stream, so the last path segment is the
      // literal word "stream". Keep whatever the caller already set (the real
      // filename) and only fall back to the path for a direct file URL.
      {
        const el = document.getElementById("header-video-name");
        const last = mediaPath.split("/").pop();
        if (last && last !== "stream") el.textContent = last;
      }
    } else {
      // Video mode: show <video>, hide <img>
      this._initialLoaded = false;
      this.imageEl.style.display = "none";
      this.imageEl.removeAttribute("src");
      this.video.style.display = "";
      this.video.src = mediaPath;
      this.video.load();
      this._setControlsEnabled(true);
      // Stream URLs are /api/videos/<id>/stream, so the last path segment is the
      // literal word "stream". Keep whatever the caller already set (the real
      // filename) and only fall back to the path for a direct file URL.
      {
        const el = document.getElementById("header-video-name");
        const last = mediaPath.split("/").pop();
        if (last && last !== "stream") el.textContent = last;
      }
      // Capture first frame once video data is ready
      this.video.addEventListener("loadeddata", () => {
        if (this.onFrameChange) this.onFrameChange(this.currentFrame());
      }, { once: true });
    }
  }

  _setControlsEnabled(enabled) {
    const controls = document.querySelector(".video-controls");
    if (controls) {
      controls.style.display = enabled ? "" : "none";
    }
  }

  // ──────────────────────────────────────────
  _bindEvents() {
    const v = this.video;

    v.addEventListener("loadedmetadata", () => {
      // Provisional only — overwritten by setRealFps() from the server. Never
      // trust this for anything persisted; see fpsIsReal.
      if (!this.fpsIsReal) this.fps = 30;
      this.totalFrames = Math.round(v.duration * this.fps);
      this._updateDisplay();
    });

    v.addEventListener("timeupdate", () => {
      if (!this._seeking) {
        const pct = v.duration ? v.currentTime / v.duration : 0;
        this.seekBar.value = Math.round(pct * 10000);
        this._updateDisplay();
        if (this.onFrameChange) this.onFrameChange(this.currentFrame());
      }
    });

    // Update canvas frame after seeking while paused (timeupdate doesn't fire reliably)
    v.addEventListener("seeked", () => {
      if (v.paused) {
        this._updateDisplay();
        if (this.onFrameChange) this.onFrameChange(this.currentFrame());
      }
    });

    v.addEventListener("play",  () => { this.playBtn.textContent = "\u23F8"; });
    v.addEventListener("pause", () => {
      this.playBtn.textContent = "\u25B6";
      // Announce the frame we actually landed on. Without this the canvas keeps
      // showing (and _save keeps posting) the boxes of whatever frame the user
      // was on BEFORE they pressed play: timeupdate fires during playback but
      // app._syncFrameAnnotations refuses to run while !paused, and the seeked
      // handler below only fires when already paused. Result was one canvas
      // rectangle re-saved under a frame number it was never drawn on -- 36% of
      // the scar corpus, with crops correlating WORSE than the whole frame.
      this._updateDisplay();
      if (this.onFrameChange) this.onFrameChange(this.currentFrame());
    });

    // Loading overlay — distinguish initial download vs normal buffering
    this._initialLoaded = false;

    v.addEventListener("waiting", () => {
      if (!this._seeking) {
        const msg = this._initialLoaded ? "Buffering..." : "Downloading...";
        this._showLoading(true, msg);
      }
    });
    v.addEventListener("canplay", () => {
      this._initialLoaded = true;
      this._showLoading(false);
    });
    v.addEventListener("error", () => {
      this._showLoading(false);
      if (v.currentSrc && v.currentSrc.includes("/api/videos/")) {
        const el = document.getElementById("save-status");
        if (el) { el.textContent = "Failed to load video"; el.className = "status-msg error"; }
      }
    });

    // Seek bar
    this._seeking = false;
    this.seekBar.addEventListener("mousedown",  () => { this._seeking = true; });
    this.seekBar.addEventListener("touchstart", () => { this._seeking = true; });
    this.seekBar.addEventListener("input", () => {
      const frac = this.seekBar.value / 10000;
      v.currentTime = frac * (v.duration || 0);
      this._updateDisplay();
    });
    this.seekBar.addEventListener("change",    () => { this._seeking = false; });
    this.seekBar.addEventListener("mouseup",   () => { this._seeking = false; });
    this.seekBar.addEventListener("touchend",  () => { this._seeking = false; });

    // Play/pause button
    document.getElementById("ctrl-play").addEventListener("click", () => this.togglePlay());
    document.getElementById("ctrl-prev1").addEventListener("click", () => this.stepFrame(-1));
    document.getElementById("ctrl-next1").addEventListener("click", () => this.stepFrame(1));
    document.getElementById("ctrl-prev10").addEventListener("click", () => this.stepFrame(-10));
    document.getElementById("ctrl-next10").addEventListener("click", () => this.stepFrame(10));

    // Speed
    this.speedSel.addEventListener("change", () => {
      v.playbackRate = parseFloat(this.speedSel.value);
    });
  }

  /** Adopt the container's REAL fps, read by cv2 on the server.
   *
   *  This replaces a client-side _estimateFps() that probed `video.videoTracks`
   *  — a non-standard API no current browser implements — and so returned a
   *  hardcoded 30 for every video. On 59.94fps source footage that made every
   *  stored frame_number, and every per-frame annotation cache key, roughly half
   *  its true value. The browser cannot determine fps, so it must be told. */
  setRealFps(fps) {
    const f = Number(fps);
    if (f > 0) {
      this.fps = f;
      this.fpsIsReal = true;
      if (this.video && this.video.duration) {
        this.totalFrames = Math.round(this.video.duration * this.fps);
      }
      this._updateDisplay();
    }
  }

  currentFrame() {
    if (this.mediaType === "image") return 0;
    const v = this.video;
    if (!v.duration) return 0;
    return Math.round(v.currentTime * this.fps);
  }

  seekToFrame(n) {
    if (this.mediaType === "image") return;
    const v = this.video;
    if (!v.duration) return;
    n = Math.max(0, Math.min(n, this.totalFrames - 1));
    v.currentTime = n / this.fps;
  }

  stepFrame(delta) {
    if (this.mediaType === "image") return;
    this.seekToFrame(this.currentFrame() + delta);
  }

  togglePlay() {
    if (this.mediaType === "image") return;
    if (this.video.paused) this.video.play();
    else this.video.pause();
  }

  _formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  _updateDisplay() {
    if (this.mediaType === "image") {
      this.timeDisp.textContent = "Image";
      this.frameDisp.textContent = "Frame: 0 / 1";
      this.seekBar.value = 0;
      return;
    }
    const v = this.video;
    const cur = this._formatTime(v.currentTime || 0);
    const tot = this._formatTime(v.duration || 0);
    this.timeDisp.textContent = `${cur} / ${tot}`;
    const fn = this.currentFrame();
    this.frameDisp.textContent = `Frame: ${fn} / ${this.totalFrames}`;
  }

  _showLoading(show, msg = "Downloading...") {
    let overlay = document.getElementById("video-loading-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "video-loading-overlay";
      overlay.innerHTML = '<span>Downloading...</span>';
      overlay.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;"
        + "justify-content:center;gap:8px;background:rgba(0,0,0,0.6);color:#fff;z-index:10;font-size:14px";
      this.video.parentElement.style.position = "relative";
      this.video.parentElement.appendChild(overlay);
    }
    if (show) overlay.querySelector("span").textContent = msg;
    overlay.style.display = show ? "flex" : "none";
  }

  // Capture current frame as base64 JPEG via canvas
  captureCurrentFrame() {
    if (this.mediaType === "image") {
      const img = this.imageEl;
      if (!img || !img.naturalWidth) return null;
      const cvs = document.createElement("canvas");
      cvs.width  = img.naturalWidth;
      cvs.height = img.naturalHeight;
      cvs.getContext("2d").drawImage(img, 0, 0);
      return cvs.toDataURL("image/jpeg", 0.88).split(",")[1];
    }
    const v = this.video;
    if (!v.videoWidth) return null;
    const cvs = document.createElement("canvas");
    cvs.width  = v.videoWidth;
    cvs.height = v.videoHeight;
    cvs.getContext("2d").drawImage(v, 0, 0);
    return cvs.toDataURL("image/jpeg", 0.88).split(",")[1];  // base64 only
  }
}

window.videoPlayer = new VideoPlayer();
