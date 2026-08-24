/*
 * Stream D — scar-form hint pre-fill (plan 10 D4/§5).
 *
 * The annotator hand-enters six fields per scar. Four of them — zone, side,
 * colour, on-fin — the machine already derives and persists as auto_* on the
 * track path. We compute them and then ask a human to type them anyway. This
 * module pre-fills them from POST /api/scars/hint so the common case is:
 * draw the box, pick the type.
 *
 * FLOW INVERSION. Today the form is filled FIRST ("+ ADD SCAR" refuses until
 * zone and colour are set) and the box drawn second. A hint needs the box in
 * order to know the zone, so with hints on the order flips:
 *
 *     pick type -> draw box -> hint pre-fills zone/side/colour -> commit
 *
 * If the hint is unavailable or below its confidence threshold, the fields are
 * left EMPTY and the box is held pending while the human fills them in — never
 * committed with guessed values. That is the whole contract: a hint is a
 * suggestion, the human is ground truth, and "the model doesn't know" must look
 * different from "the model says X".
 *
 * SAFETY: inert unless the server reports pose.frame_hints.enabled. When off,
 * nothing is patched and the existing form-first flow is exactly as it was.
 */
"use strict";

const ScarHints = {
  enabled: false,
  threshold: 0.35,
  _pendingBbox: null,
  _committing: false,
  _lastHint: null,

  async init() {
    // GET is the capability probe — no inference, no frame upload. Anything
    // other than an explicit {enabled:true} leaves the existing flow untouched,
    // so a server error can never strand the annotator in a half-patched form.
    try {
      const res = await API.get('/api/scars/hint');
      if (!res || res.enabled !== true) return;
      this.threshold = res.show_threshold ?? this.threshold;
    } catch (e) {
      console.info('scar hints unavailable — form unchanged', e);
      return;
    }
    this.enabled = true;
    this._patchValidation();
    this._patchBboxHandler();
  },

  /** Pre-draw, only the scar TYPE can be known — zone/colour arrive with the
   *  box. Commit-time validation still demands everything (see _commit). */
  _patchValidation() {
    const orig = ScarForm.validate.bind(ScarForm);
    ScarForm.validate = () => {
      if (this._committing) return orig();
      return ScarForm.state.scarType ? null : 'Please select a scar type.';
    };
  },

  _patchBboxHandler() {
    const orig = AppState.handleScarBbox.bind(AppState);
    AppState.handleScarBbox = async (bbox) => {
      const missing = await this.prefill(bbox);
      if (missing.length) {
        // Hold the box rather than committing a scar with blank fields.
        this._pendingBbox = bbox;
        // "The model wasn't sure" is false on a blind frame — it was sure and we
        // withheld it. Telling the labeler the model failed would send them
        // looking for a hint that is being deliberately kept from them, and would
        // make a control feel like a bug.
        const why = this._lastHint?.blind
          ? 'No hint on this frame (spot check)'
          : `Model wasn't sure about ${missing.join(' + ')}`;
        AppState._setStatus(
          // `why`, not a hardcoded "Model wasn't sure": on a blind frame the model
          // WAS sure and we withheld it, so naming the model would send the labeler
          // hunting for a hint deliberately kept from them. And the box places
          // itself now — "+ ADD SCAR" is gone (see _onScarFormComplete below), so
          // telling anyone to press it points at a button that is not there.
          `${why} — set ${missing.length > 1
            ? 'them' : 'it'} below and the box will be placed.`, true);
        window.annotCanvas.setMode('browse');
        return;
      }
      this._commit(orig, bbox);
    };

    // A box held because the model was unsure commits itself the moment the labeler
    // supplies what was missing. It used to wait for a click on "+ ADD SCAR"; there
    // is no such button now, and asking for one would throw away their drawing if
    // they did not find it. AppState calls this after every form change.
    AppState._onScarFormComplete = () => {
      if (!this._pendingBbox) return false;
      if (this._validateFull()) return false;
      const bbox = this._pendingBbox;
      this._pendingBbox = null;
      this._commit(orig, bbox);
      return true;                 // handled: do not also arm a new draw
    };
  },

  _validateFull() {
    this._committing = true;
    try { return ScarForm.validate(); } finally { this._committing = false; }
  },

  _commit(orig, bbox) {
    this._committing = true;
    try { orig(bbox); } finally { this._committing = false; this._clearAutoMarks(); }
  },

  /** Fetch hints for a drawn box and apply the confident ones.
   *  @returns {Promise<string[]>} field names still missing after pre-fill. */
  async prefill(bbox) {
    const frame = window.videoPlayer?.captureCurrentFrame?.();
    if (!frame) return this._missingFields();
    let hint = null;
    try {
      // video_id + frame_number travel ALONGSIDE the pixels, never instead of
      // them. They are a cache key (skip the ~90ms model call when this frame was
      // walked at prepare time) and the blind-arm key. If either is wrong the
      // worst case is a cache miss — the hint is still computed on the pixels the
      // annotator is actually looking at.
      hint = await API.post('/api/scars/hint', {
        frame_b64: frame,
        bbox,
        video_id: AppState.currentVideo?.id ?? null,
        frame_number: AppState._activeFrameNum ?? window.videoPlayer?.currentFrame?.() ?? null,
      });
    } catch (e) {
      console.info('scar hint unavailable', e);
      return this._missingFields();
    }
    if (!hint || !hint.enabled) return this._missingFields();
    this._lastHint = hint;
    this.threshold = hint.show_threshold ?? this.threshold;
    // A blind frame carries no values by design (see annotation/hint_blinding.py).
    // Fall through: every field is empty, so _missingFields() asks for all of them,
    // which is exactly the unaided decision the arm is collecting.
    if (hint.blind) return this._missingFields();

    // Apply by clicking the real controls: that reuses every existing state
    // sync (ScarForm.state, hidden inputs, zone label, SVG flip) instead of
    // duplicating it here and drifting from it later.
    if (hint.zone && hint.zone_confidence >= this.threshold) {
      this._click(`.zone-seg[data-zone="${CSS.escape(hint.zone)}"]`, 'zone');
    }
    if (hint.side && hint.side_confidence >= this.threshold) {
      this._click(`.radio-btn[data-group="scar-side"][data-val="${CSS.escape(hint.side)}"]`, 'side');
    }
    if (hint.color && hint.color_confidence >= this.threshold) {
      this._click(`.color-btn[data-color="${CSS.escape(hint.color)}"]`, 'color');
    }
    return this._missingFields();
  },

  _missingFields() {
    const out = [];
    if (!ScarForm.state.zone) out.push('zone');
    if (!ScarForm.state.color) out.push('colour');
    return out;
  },

  _click(selector, label) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.click();
    // Mark it visibly as machine-suggested so a human can tell at a glance what
    // they confirmed vs what they chose. Cleared on commit.
    el.classList.add('auto-filled');
    el.dataset.autoFilled = label;
  },

  _clearAutoMarks() {
    document.querySelectorAll('.auto-filled').forEach((el) => {
      el.classList.remove('auto-filled');
      delete el.dataset.autoFilled;
    });
  },
};

window.ScarHints = ScarHints;
