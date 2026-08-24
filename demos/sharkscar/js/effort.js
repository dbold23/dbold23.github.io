/**
 * effort.js — how long this frame has actually had someone's attention.
 *
 * The server can already infer cadence from save timestamps, but a gap is
 * bounded by two saves: the first item of every sitting is invisible (opening
 * the clip, finding the animal, deciding) and the last has no successor.
 * Measured on this catalog, 375 saves yield 320 usable gaps before any of that
 * bites. This clock covers the frame from the moment it is shown.
 *
 * THREE RULES, ALL OF WHICH CHANGE THE NUMBER
 *
 * 1. **Watching is working.** A labeler scrubbing a clip looking for the animal
 *    is doing the task. Idle is decided by activity on the annotation surfaces —
 *    canvas, video, the form — not by keystrokes, or every careful person who
 *    studies a frame before touching it reads as idle and the metric rewards
 *    fidgeting.
 *
 * 2. **A hidden tab is not work.** `visibilitychange` pauses. Without it the
 *    number measures how long a browser tab existed, which is a fact about
 *    nobody. This is the single biggest source of nonsense in naive dwell
 *    tracking.
 *
 * 3. **It is per FRAME, not per session.** The clock resets when the frame the
 *    labeler is looking at changes, because that is the unit the save writes
 *    and the unit the difficulty analysis compares.
 *
 * The labeler is told. `metrics.effort.record` off means this file measures
 * nothing and sends nothing; on, the panel shows the running time. Measuring
 * colleagues covertly is not a thing this app does — the same reason skill
 * checks are labelled rather than slipped into ordinary work.
 *
 * Nothing here can break a save. Every call from the save path is optional-
 * chained and `value()` returns null rather than throwing: a missing duration
 * costs one row of a metric, a throwing one costs the annotation.
 */
"use strict";

const Effort = {
  enabled: false,
  _idleMs: 60000,
  _capMs: 30 * 60 * 1000,

  _acc: 0,            // banked ms for the current frame
  _since: null,       // when the current running stretch started
  _lastInput: 0,
  _key: null,         // the frame this clock belongs to
  _tick: null,

  /** @param {{record:boolean, idle_s?:number, max_minutes?:number}} conf */
  init(conf) {
    this.enabled = !!(conf && conf.record);
    if (!this.enabled) return;
    if (conf.idle_s) this._idleMs = Math.max(5, +conf.idle_s) * 1000;
    if (conf.max_minutes) this._capMs = Math.max(1, +conf.max_minutes) * 60000;

    // Scrubbing, drawing and typing are all the task. Listening on the document
    // in capture phase so a handler that stops propagation cannot make a working
    // labeler look idle.
    const mark = () => { this._lastInput = Date.now(); };
    for (const ev of ["pointerdown", "pointermove", "wheel", "keydown", "input", "change"]) {
      document.addEventListener(ev, mark, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this._pause();
      else { this._lastInput = Date.now(); this._resume(); }
    });
    window.addEventListener("blur", () => this._pause());
    window.addEventListener("focus", () => { this._lastInput = Date.now(); this._resume(); });

    this._lastInput = Date.now();
    this._resume();
    this._tick = setInterval(() => this._sweep(), 5000);
  },

  /** Point the clock at a frame. Same frame ⇒ keep counting, never restart. */
  frame(videoId, frameNumber) {
    if (!this.enabled) return;
    const key = `${videoId}#${frameNumber}`;
    if (key === this._key) return;
    this._key = key;
    this._acc = 0;
    this._since = document.hidden ? null : Date.now();
    this._lastInput = Date.now();
    this._paint();
  },

  /** Milliseconds banked so far, or null when there is nothing honest to send. */
  value() {
    if (!this.enabled || this._key === null) return null;
    const ms = Math.round(this._acc + (this._since ? Date.now() - this._since : 0));
    return ms > 0 && ms <= this._capMs ? ms : null;
  },

  /**
   * Zero the clock — called ONLY once the server has acknowledged the save.
   *
   * Two failure modes it sits between. Reset before the request and a save that
   * 500s or drops loses the minutes it took. Never reset and the server, which
   * ACCUMULATES active_ms, bills the next save for this one's time all over
   * again — a frame saved three times would report triple.
   */
  reset() {
    this._acc = 0;
    this._since = document.hidden ? null : Date.now();
    this._paint();
  },

  _pause() {
    if (this._since) { this._acc += Date.now() - this._since; this._since = null; }
    this._paint();
  },

  _resume() {
    if (!this.enabled || this._since || document.hidden) return;
    this._since = Date.now();
  },

  /** Idle rolls the clock back to the last input — time already spent staring
   *  counts, time since walking away does not. */
  _sweep() {
    if (!this.enabled) return;
    if (this._since && Date.now() - this._lastInput > this._idleMs) {
      this._acc += Math.max(0, this._lastInput - this._since);
      this._since = null;
    } else if (!this._since && !document.hidden &&
               Date.now() - this._lastInput <= this._idleMs) {
      this._since = Date.now();
    }
    this._paint();
  },

  /** Say what is being recorded, while it is being recorded. */
  _paint() {
    const el = document.getElementById("effort-readout");
    if (!el) return;
    const ms = this.value();
    if (ms === null) { el.textContent = ""; el.title = ""; return; }
    const s = Math.round(ms / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    el.classList.toggle("paused", !this._since);
    el.title = this._since
      ? "Time on this frame. Saved with your annotation, so the lab can size the work."
      : "Paused — no activity on this frame.";
  },
};

window.Effort = Effort;
