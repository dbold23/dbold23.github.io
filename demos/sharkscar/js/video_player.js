/**
 * video_player.js — HTML5 video player with frame-accurate controls.
 * Exposes: VideoPlayer (class), window.videoPlayer (singleton)
 */
"use strict";

class VideoPlayer {
  constructor() {
    this.video     = document.getElementById("video-element");
    this.seekBar   = document.getElementById("seek-bar");
    this.timeDisp  = document.getElementById("time-display");
    this.frameDisp = document.getElementById("frame-display");
    this.playBtn   = document.getElementById("ctrl-play");
    this.speedSel  = document.getElementById("speed-select");

    this.fps        = 30;
    this.totalFrames = 0;
    this.videoPath  = "";
    this.onFrameChange = null;   // callback(frameIndex)

    this._bindEvents();
  }

  // ──────────────────────────────────────────
  load(videoPath) {
    this.videoPath = videoPath;
    this.video.src = videoPath;
    this.video.load();
    document.getElementById("header-video-name").textContent = videoPath.split("/").pop();
    // Capture first frame once video data is ready
    this.video.addEventListener("loadeddata", () => {
      if (this.onFrameChange) this.onFrameChange(this.currentFrame());
    }, { once: true });
  }

  // ──────────────────────────────────────────
  _bindEvents() {
    const v = this.video;

    v.addEventListener("loadedmetadata", () => {
      this.fps = this._estimateFps() || 30;
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

    v.addEventListener("play",  () => { this.playBtn.textContent = "⏸"; });
    v.addEventListener("pause", () => { this.playBtn.textContent = "▶"; });

    // Loading overlay for Drive downloads
    v.addEventListener("waiting", () => this._showLoading(true));
    v.addEventListener("canplay", () => this._showLoading(false));
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

  _estimateFps() {
    // Read fps from video track if available (Chrome/Edge)
    try {
      const tracks = this.video.videoTracks;
      if (tracks && tracks.length > 0) return tracks[0].frameRate;
    } catch (_) {}
    return 30;
  }

  currentFrame() {
    const v = this.video;
    if (!v.duration) return 0;
    return Math.round(v.currentTime * this.fps);
  }

  seekToFrame(n) {
    const v = this.video;
    if (!v.duration) return;
    n = Math.max(0, Math.min(n, this.totalFrames - 1));
    v.currentTime = n / this.fps;
  }

  stepFrame(delta) {
    this.seekToFrame(this.currentFrame() + delta);
  }

  togglePlay() {
    if (this.video.paused) this.video.play();
    else this.video.pause();
  }

  _formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  _updateDisplay() {
    const v = this.video;
    const cur = this._formatTime(v.currentTime || 0);
    const tot = this._formatTime(v.duration || 0);
    this.timeDisp.textContent = `${cur} / ${tot}`;
    const fn = this.currentFrame();
    this.frameDisp.textContent = `Frame: ${fn} / ${this.totalFrames}`;
  }

  _showLoading(show) {
    let overlay = document.getElementById("video-loading-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "video-loading-overlay";
      overlay.innerHTML = '<span>Downloading video...</span>';
      overlay.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;"
        + "justify-content:center;gap:8px;background:rgba(0,0,0,0.6);color:#fff;z-index:10;font-size:14px";
      this.video.parentElement.style.position = "relative";
      this.video.parentElement.appendChild(overlay);
    }
    overlay.style.display = show ? "flex" : "none";
  }

  // Capture current frame as base64 JPEG via canvas
  captureCurrentFrame() {
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
