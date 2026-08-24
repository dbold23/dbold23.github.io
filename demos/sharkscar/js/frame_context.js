/*
 * Motion around the frame you are annotating.
 *
 * A scar is a texture judgement and a single still lies: glare, a ripple and a
 * fold of skin all read as a scar until you watch the animal move through the
 * moment. So the labeler needs the seconds either side — but the <video> element
 * cannot supply them here. The 4K clips in this corpus are HEVC, which Chrome does
 * not decode; that is why a canvas fed by captureCurrentFrame() came up blank on
 * exactly the clips that matter. ffmpeg decodes them server-side, so the context
 * arrives as a short strip of JPEGs and plays as a flipbook.
 *
 * THE RULE THIS MODULE EXISTS TO PROTECT: the annotation always belongs to the
 * frame the item named. Context is for looking, never for labelling. While you are
 * off that frame the canvas drops to browse mode and says so, because a scar boxed
 * on frame 305 and filed as frame 300 is silent and unrecoverable — the same class
 * of error as the fps drift that halved every frame number in this corpus.
 *
 * There is ONE button here. A ▶ that steps and a ▶ that plays are the same glyph
 * doing different things, six pixels apart — so stepping is the arrow keys and
 * play is space, which is what the hands are already doing between annotations.
 *
 * THE OTHER RULE, learned the hard way: STRUCTURE IS BUILT ONCE, state is synced.
 * This bar used to re-render its whole innerHTML on every displayed frame — ten
 * times a second while playing — which replaced the pause button between the
 * labeler's mousedown and their mouseup. The click event had no element left to
 * fire on, so PAUSE SIMPLY DID NOT WORK, and the bar re-flowed under the canvas on
 * every tick. `_render()` builds; `_sync()` updates. Never re-render on a tick.
 */
const FrameContext = {
  frames: [],
  videoId: null,
  pinned: null,
  i: 0,
  playing: false,
  /** Two ways of looking, because they answer different questions. FINE steps
   *  frame by frame — is this mark sharp, or is it motion blur? WIDE covers a few
   *  seconds coarsely — does the mark stay on the skin while the animal turns, or
   *  does it slide across it like glare? The second is the one that actually tells
   *  a scar from a reflection, and it needs more movement than a single second. */
  SPANS: {
    fine: { span: 12, stride: 2, width: 960, label: 'Step frame by frame' },
    wide: { span: 20, stride: 8, width: 800, label: 'Across a few seconds' },
  },
  spanKey: 'fine',
  /** Slow speeds matter more than fast ones here. Deciding whether a mark holds
   *  position on the skin means watching it cross a few frames, and at full speed
   *  the strip is past it before the eye settles. 0.25x is 2.5 frames a second —
   *  slow enough to follow one mark, still moving enough to read as motion. */
  SPEEDS: [0.25, 0.5, 1, 2],
  BASE_FPS: 10,
  speed: 1,
  /** 'context' = a window around an assigned frame; looking never changes what you
   *  annotate. 'clip' = the whole clip, where the labeler CHOOSES the frame, so the
   *  frame they settle on becomes the annotated one. Scars need the second: a mark
   *  is only a scar if it holds position while the animal moves, and the labeler
   *  has to range over the clip to see that. */
  mode: 'context',
  total: 0,
  _settle: null,
  _timer: null,
  _modeBeforeContext: null,

  /** Build (or rebuild) the bar for a newly pinned frame. Nothing is fetched until
   *  the labeler asks — most pose frames are perfectly legible on their own. */
  attach(videoId, pinnedFrame) {
    this.stop();
    this.frames = [];
    this.videoId = videoId;
    this.pinned = pinnedFrame;
    this.i = 0;
    this._render();
  },

  detach() {
    this.stop();
    if (this._settle) { clearTimeout(this._settle); this._settle = null; }
    this.mode = 'context';
    document.getElementById('frame-context')?.remove();
  },

  /** Is the strip the thing the labeler is actually driving? Keyboard transport
   *  routes here when it is — on queue work the <video> element is hidden, and on
   *  these clips it could not decode them anyway, so Space would go nowhere. */
  isActive() {
    return this.frames.length > 1 && !!document.getElementById('frame-context');
  },

  /** Open a whole clip for a task whose unit of work is the clip. */
  async clip(videoId, startFrame) {
    this.stop();
    this.mode = 'clip';
    this.videoId = videoId;
    this.pinned = startFrame;
    this.frames = [];
    this.i = 0;
    this._render();
    const el = this._host();
    const btn = el && el.querySelector('#fc-load');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading clip…'; }
    try {
      const res = await API.get(
        `/api/frames/context?video_id=${encodeURIComponent(videoId)}&whole=1`);
      this.frames = res.frames || [];
      this.total = res.total_frames || 0;
      // Start where the queue suggested — it ranked that moment for a reason —
      // but the labeler is free to go anywhere.
      this.i = Math.max(0, this.frames.findIndex((f) => f.n >= startFrame));
      this._render();
      this.show(this.i);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Load clip'; }
      window.appState?._setStatus?.(`Could not load the clip: ${e.message || e}`, true);
    }
  },

  /** In clip mode the frame you stop on is the frame you annotate, so it has to be
   *  fetched at full resolution and pinned. Debounced: scrubbing past forty frames
   *  should not fire forty full-resolution decodes. */
  _settleOnFrame(n) {
    if (this._settle) clearTimeout(this._settle);
    this._settle = setTimeout(() => {
      this._settle = null;
      if (this.playing) return;           // still moving; not a choice yet
      window.appState?.showFrame?.(this.videoId, n, { keepStrip: true });
    }, 400);
  },

  _host() {
    const wrap = document.getElementById('canvas-wrap');
    if (!wrap) return null;
    let el = document.getElementById('frame-context');
    if (!el) {
      el = document.createElement('div');
      el.id = 'frame-context';
      el.className = 'fc-bar';
      wrap.parentElement.insertBefore(el, wrap.nextSibling);
    }
    return el;
  },

  /** Build the controls. Called when the strip is attached, loaded or re-spanned —
   *  never on playback. Every control that only CHANGES is rendered here and
   *  updated by _sync(), including ones that are sometimes hidden, so the bar's
   *  height never changes and the canvas above it never gets re-laid-out. */
  _render() {
    const el = this._host();
    if (!el || this.pinned == null) return;
    const loaded = this.frames.length > 0;
    el.innerHTML = `
      <button class="btn btn-sm" id="fc-load">${
        loaded ? '↻' : (this.mode === 'clip' ? 'Load clip' : 'Show movement')}</button>
      ${loaded ? `
        <button class="btn btn-sm btn-ghost" id="fc-play" title="Play / pause [Space]">▶</button>
        <span class="fc-keys">← → frame · space play</span>
        <select class="fc-speed" id="fc-speed" title="Playback speed">${
          this.SPEEDS.map((s) => `<option value="${s}"${
            s === this.speed ? ' selected' : ''}>${s}x</option>`).join('')}</select>
        <input type="range" id="fc-scrub" class="fc-scrub" min="0"
               max="${this.frames.length - 1}" value="${this.i}">` : ''}
      ${loaded && this.mode !== 'clip' ? `<button class="btn btn-sm btn-ghost" id="fc-span"
            title="${this.spanKey === 'fine' ? this.SPANS.wide.label : this.SPANS.fine.label}"
          >${this.spanKey === 'fine' ? '↔ wider' : '↕ finer'}</button>` : ''}
      <span class="fc-label" id="fc-label"></span>
      ${loaded
        ? '<button class="btn btn-sm btn-primary" id="fc-back" hidden>Back to my frame</button>'
        : ''}`;

    el.querySelector('#fc-load').onclick = () => (this.mode === 'clip'
      ? this.clip(this.videoId, this.pinned)
      : (loaded ? this.reload() : this.load()));
    if (loaded) {
      el.querySelector('#fc-play').onclick = () => this.togglePlay();
      el.querySelector('#fc-scrub').oninput = (e) => this.show(parseInt(e.target.value, 10));
      const speed = el.querySelector('#fc-speed');
      speed.onchange = (e) => {
        this.setSpeed(parseFloat(e.target.value));
        // Hand focus back, or the next Space opens the dropdown instead of playing.
        e.target.blur();
      };
      const spanBtn = el.querySelector('#fc-span');
      if (spanBtn) spanBtn.onclick =
        () => this.setSpan(this.spanKey === 'fine' ? 'wide' : 'fine');
      const back = el.querySelector('#fc-back');
      if (back) back.onclick = () => this.backToMine();
    }
    this._sync();
  },

  /** Everything that changes as frames go by — and nothing else. No innerHTML, so
   *  the controls under the labeler's cursor survive playback. */
  _sync() {
    const el = document.getElementById('frame-context');
    if (!el || !this.frames.length) return;
    const viewing = this.frames[this.i].n;
    const off = viewing !== this.pinned;

    const play = el.querySelector('#fc-play');
    if (play) play.textContent = this.playing ? '❚❚' : '▶';

    const scrub = el.querySelector('#fc-scrub');
    // Don't fight the labeler's own drag.
    if (scrub && document.activeElement !== scrub) scrub.value = String(this.i);

    const label = el.querySelector('#fc-label');
    if (label) {
      label.classList.toggle('fc-off', off);
      // Say that the strip is a PREVIEW. Its frames are a 640x360 scrub proxy
      // (~8 KB each); settling on one fetches the real 1920x1080 frame. That 3x
      // resolution jump is what makes the picture visibly sharpen when you stop,
      // and without a word for it the labeler reads it as a filter being applied
      // and starts doubting what they are looking at. It is not a filter —
      // ctx.filter is only ever set from the brightness/contrast sliders.
      const preview = (this.mode === 'clip' && !off)
        ? ' <span class="fc-preview" title="Scrubbing shows a small preview frame so it stays'
          + ' fast. Stop, or start drawing, and the full-resolution frame loads — that is why'
          + ' the picture sharpens. Your marks are rescaled with it.">preview</span>'
        : '';
      label.innerHTML = off
        ? `viewing ${viewing} · <b>annotating ${this.pinned}</b>`
        : this.mode === 'clip'
          ? `frame <b>${viewing}</b>${this.total ? ` of ${this.total}` : ''}${preview}`
          : `frame ${this.pinned}`;
    }

    const back = el.querySelector('#fc-back');
    if (back) back.hidden = !off;
    // The way home outranks the shortcut hint. One row that cannot wrap means
    // something has to give when the off-frame label and the button both appear,
    // and it must not be the button — clipped off the end, it is unreachable.
    const keys = el.querySelector('.fc-keys');
    if (keys) keys.hidden = off;
  },

  async load() {
    const el = this._host();
    if (!el || this.videoId == null) return;
    const btn = el.querySelector('#fc-load');
    if (btn) { btn.disabled = true; btn.textContent = 'Decoding…'; }
    try {
      this.frames = await this._fetch(this.spanKey);
      this.i = Math.max(0, this.frames.findIndex((f) => f.n >= this.pinned));
      this._render();
      this.play();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Show movement'; }
      window.appState?._setStatus?.(`No context available: ${e.message || e}`, true);
    }
  },

  reload() { this.frames = []; this.load(); },

  /** One fetch, shared by the button and the background prefetch. */
  async _fetch(key) {
    const s = this.SPANS[key] || this.SPANS.fine;
    const res = await API.get(
      `/api/frames/context?video_id=${encodeURIComponent(this.videoId)}`
      + `&center=${this.pinned}&span=${s.span}&stride=${s.stride}&width=${s.width}`);
    return res.frames || [];
  },

  /** Warm the strip in the background so "Show movement" is instant when it is
   *  actually needed. Only for tasks where a still genuinely is not enough — a
   *  scar is a texture judgement; a keypoint is not. Failure is silent: this is
   *  an optimisation, and the button still works without it. */
  async prefetch(taskType) {
    if (!['bbox', 'segment', 'verify'].includes(taskType)) return;
    if (this.frames.length || this.videoId == null) return;
    try {
      const frames = await this._fetch(this.spanKey);
      if (!this.frames.length) { this.frames = frames; this._render(); }
    } catch (e) { /* the button will fetch it properly and report any error */ }
  },

  /** Switch how wide a window we look at, re-fetching that span. */
  async setSpan(key) {
    if (!this.SPANS[key] || key === this.spanKey) return;
    this.stop();
    this.spanKey = key;
    this.frames = [];
    await this.load();
  },

  show(i) {
    if (!this.frames.length) return;
    this.i = Math.max(0, Math.min(i, this.frames.length - 1));
    const f = this.frames[this.i];
    const app = window.appState;
    if (!app) return;
    // In clip mode choosing the frame IS the task — but only until there is a mark
    // on it. After that the frame is chosen, and moving is looking, exactly as in
    // context mode. Without this, playing away from a box you had just drawn
    // re-pinned the strip onto a later frame, which files your box under the frame
    // you left and clears the canvas: the box "disappears" on play.
    if (this.mode === 'clip' && !window.annotCanvas?.hasMarks?.()) {
      window.annotCanvas?.setFrame?.(f.b64, true);
      this.pinned = f.n;
      this._settleOnFrame(f.n);
      this._sync();
      return;
    }
    if (f.n !== this.pinned) this._enterLooking();
    else this._leaveLooking();
    // Straight to the canvas: this is a look, not the annotation's image, so it
    // must not go through _displayFrame (which would make it the saved frame).
    window.annotCanvas?.setFrame?.(f.b64, true);
    this._sync();
  },

  step(d) { this.stop(); this.show(this.i + d); },

  /** The labeler has started drawing. Stop, and make the frame they are looking at
   *  the frame they are annotating — synchronously, before the mark is created.
   *
   *  The order is the whole point. `_syncFrameAnnotations` files the canvas's marks
   *  under the OUTGOING frame and resets for the incoming one, so if it runs after
   *  the box is drawn (which is what the 400ms settle used to do) the box is filed
   *  against a frame the labeler had already left and vanishes from the screen. */
  claimFrameForDrawing() {
    if (!this.frames.length) return;
    this.stop();
    if (this.mode !== 'clip') return;   // context mode already refuses to draw off-frame
    if (window.annotCanvas?.hasMarks?.()) return;   // frame already chosen; see show()
    const n = this.frames[this.i].n;
    const app = window.appState;
    if (!app || app._pinnedFrame === n) return;
    if (this._settle) { clearTimeout(this._settle); this._settle = null; }
    this.pinned = n;
    app._pinnedFrame = n;
    app._syncFrameAnnotations();
    const disp = document.getElementById('frame-display');
    if (disp) disp.textContent = `Frame: ${n}`;
    // Fetch the full-resolution frame behind the drag. It repaints the picture and
    // nothing else: by then the active frame already matches, so the sync is a
    // no-op and the mark in progress is untouched.
    app.showFrame(this.videoId, n, { keepStrip: true });
    this._sync();
  },

  togglePlay() { if (this.playing) this.stop(); else this.play(); },

  setSpeed(v) {
    if (!this.SPEEDS.includes(v)) return;
    this.speed = v;
    if (this.playing) this._startTimer();
  },

  play() {
    if (this.frames.length < 2) return;
    this.playing = true;
    this._startTimer();
    this._sync();
  },

  _startTimer() {
    if (this._timer) clearInterval(this._timer);
    const fps = this.BASE_FPS * this.speed;
    this._timer = setInterval(() => {
      this.show((this.i + 1) % this.frames.length);
    }, 1000 / fps);
  },

  stop() {
    this.playing = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._sync();
  },

  /** Put the labeler back on the frame their work belongs to, at full resolution.
   *  keepStrip, or showFrame re-attaches and throws away the strip we just decoded,
   *  making every trip back to your own frame cost another decode. */
  async backToMine() {
    this.stop();
    const app = window.appState;
    this._leaveLooking();
    if (app) await app.showFrame(this.videoId, this.pinned, { keepStrip: true });
    this.i = Math.max(0, this.frames.findIndex((f) => f.n >= this.pinned));
    this._sync();
  },

  /** Drawing is disabled while off-frame. Browse mode still pans and zooms, so the
   *  labeler can look closely — they just cannot label the wrong frame. */
  _enterLooking() {
    if (this._modeBeforeContext != null) return;
    const c = window.annotCanvas;
    this._modeBeforeContext = c?.mode || 'browse';
    // Tells the canvas these frames are not the annotated one: it stops drawing the
    // marks over them, and stops treating a change of rendition as a change of scale.
    if (c) c.looking = true;
    c?.setMode?.('browse');
    document.getElementById('frame-context')?.classList.add('fc-looking');
  },

  _leaveLooking() {
    const c = window.annotCanvas;
    if (c) c.looking = false;
    if (this._modeBeforeContext != null) {
      c?.setMode?.(this._modeBeforeContext);
      this._modeBeforeContext = null;
    }
    document.getElementById('frame-context')?.classList.remove('fc-looking');
  },
};

window.FrameContext = FrameContext;
