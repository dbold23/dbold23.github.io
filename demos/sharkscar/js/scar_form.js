/**
 * scar_form.js — Scar form logic: zone diagram, star rating, color buttons, radio groups.
 * No external dependencies.
 */
"use strict";

const ScarForm = {
  // Current form values
  state: {
    scarsVisible: "",
    scarType: "",
    confidence: 3,
    scarSide: "Left",
    zone: "",
    color: "",
    colorOther: "",
    notes: "",
    multipleScars: "NO",
  },

  init() {
    this._bindRadioGroups();
    this._bindStars();
    this._bindZoneDiagram();
    this._bindColorButtons();
    this._bindScarTypeSelect();
    document.getElementById("scar-repeat")
      ?.addEventListener("click", () => this.keepForNext(!this._repeat));
    this._initStars(this.state.confidence);
    this._bindConfidenceRubric();
  },

  // ─── Confidence rubric ─────────────────────────────────────────
  /** The "i" beside the Confidence label, and the table behind it.
   *
   *  Rendered from ScarVocab.CONFIDENCE_RUBRIC rather than written into the
   *  template, so the words in the modal, the star tooltips and the triage
   *  card's rubric line are one text that cannot drift apart. */
  _bindConfidenceRubric() {
    const V = window.ScarVocab;
    const modal = document.getElementById("confidence-modal");
    const body = document.getElementById("rubric-rows");
    const icon = document.getElementById("confidence-info");
    if (!V || !modal || !body || !icon) return;

    body.innerHTML = V.CONFIDENCE_LEVELS.map(n => {
      const r = V.CONFIDENCE_RUBRIC[n];
      const stars = "\u2605".repeat(n) +
        `<span class="off">${"\u2605".repeat(5 - n)}</span>`;
      return `<tr data-level="${n}">
        <td class="rubric-level"><span class="rubric-stars">${stars}</span>
          <span class="rubric-name">${n} &mdash; ${escapeHtml(r.name)}</span></td>
        <td class="rubric-means">${escapeHtml(r.means)}</td>
        <td class="rubric-example">${escapeHtml(r.example)}</td>
      </tr>`;
    }).join("");

    // Hovering a star should not require opening anything to learn what it means.
    document.querySelectorAll("#confidence-stars .star").forEach(star => {
      const r = V.CONFIDENCE_RUBRIC[+star.dataset.val];
      if (r) star.title = `${star.dataset.val} \u2014 ${r.name}: ${r.means}`;
    });

    const open = () => {
      modal.classList.remove("hidden");
      this._rubricOpen = true;
      this._syncRubricCurrent();   // answer "where am I?" before "what are the options?"
    };
    const close = () => this.closeConfidenceRubric();

    icon.addEventListener("click", open);
    icon.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    document.getElementById("close-confidence-modal")?.addEventListener("click", close);
    // Clicking the backdrop closes; clicking inside the box does not.
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  },

  // ─── Radio groups ──────────────────────────────────────────────
  _bindRadioGroups() {
    document.querySelectorAll(".radio-btn[data-group]").forEach(btn => {
      btn.addEventListener("click", () => {
        const group = btn.dataset.group;
        document.querySelectorAll(`.radio-btn[data-group="${group}"]`).forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        const val = btn.dataset.val;
        switch (group) {
          case "scars-visible":
            this.state.scarsVisible = val;
            document.getElementById("scar-form-section").classList.toggle("hidden", val === "NO");
            document.getElementById("no-scars-msg").classList.toggle("hidden", val !== "NO");
            // Nothing about scars survives a declaration that there are none. The
            // scar board, the sighting's per-clip review and "follow a scar" are all
            // asking about marks the labeler has just said are not there; leaving
            // them up reads as unfinished work. ROI stays — "worth another look" is
            // a live answer on a clean animal.
            //
            // A CLASS, not a style: those panels are shown or hidden by their own
            // feature gate (objects.js, tracks.js), and writing display here would
            // resurrect a panel the server had switched off the next time somebody
            // clicked Yes.
            document.body.classList.toggle("no-scars-declared", val === "NO");
            break;
          case "scar-side":
            this.state.scarSide = val;
            document.getElementById("zone-svg").classList.toggle("flipped", val === "Right");
            break;
          case "multiple-scars": this.state.multipleScars  = val; break;
        }
      });
    });
  },

  // ─── Star rating ───────────────────────────────────────────────
  _bindStars() {
    const stars = document.querySelectorAll("#confidence-stars .star");
    stars.forEach(star => {
      star.addEventListener("mouseenter", () => this._highlightStars(+star.dataset.val));
      star.addEventListener("mouseleave", () => this._highlightStars(this.state.confidence));
      star.addEventListener("click", () => this._initStars(+star.dataset.val));
    });
    // Key shortcut 1-5 handled in app.js
  },

  _initStars(val) {
    this.state.confidence = val;
    document.getElementById("confidence-value").value = val;
    this._highlightStars(val);
    this._syncRubricCurrent();
  },

  /** Keep the rubric's highlighted row on the star actually selected — 1-5 works
   *  while the modal is open, and a stale highlight would answer the one question
   *  that row exists to answer, wrongly.
   *
   *  Gated on `_rubricOpen`, not on reading the modal's class back out of the
   *  DOM. `_initStars` runs on every reset and every keypress, long before
   *  anything opens the rubric — asking the DOM meant this method had to cope
   *  with a page that has the form and no modal, and it did not: it read
   *  `.classList.contains(...)` off whatever getElementById returned. Owning the
   *  flag makes "the rubric is on screen" a fact this object knows rather than
   *  one it infers. */
  /** Public because Escape is handled in app.js, with the other modals. Closing
   *  the rubric by reaching in and adding `hidden` would leave `_rubricOpen`
   *  saying it is still up — one closer, so the flag cannot drift from the DOM. */
  closeConfidenceRubric() {
    document.getElementById("confidence-modal")?.classList.add("hidden");
    this._rubricOpen = false;
  },

  _syncRubricCurrent() {
    if (!this._rubricOpen) return;
    document.getElementById("rubric-rows")?.querySelectorAll("tr").forEach(
      tr => tr.classList.toggle("current",
                                +tr.dataset.level === this.state.confidence));
  },

  _highlightStars(val) {
    // Scoped to the main form: a bare `.star` also selects the triage card's
    // stars, which carry their own state. Repainting those made the card show
    // a confidence nobody had set on it.
    document.querySelectorAll("#confidence-stars .star").forEach(s => {
      s.classList.toggle("active", +s.dataset.val <= val);
    });
  },

  setConfidence(val) {
    val = Math.max(1, Math.min(5, val));
    this._initStars(val);
  },

  // ─── Zone diagram ──────────────────────────────────────────────
  _bindZoneDiagram() {
    document.querySelectorAll(".zone-seg").forEach(seg => {
      seg.addEventListener("click", () => {
        document.querySelectorAll(".zone-seg").forEach(s => s.classList.remove("active"));
        seg.classList.add("active");
        const zone = seg.dataset.zone;
        if (zone !== this.state.zone) this._breakRepeat();
        this.state.zone = zone;
        document.getElementById("zone-value").value = zone;
        // One vocabulary (scar_vocab.js). This map used to be a second, upper-cased
        // copy of the helpers' — same zones, different words on two surfaces.
        const label = (window.ScarVocab?.ZONE_LABELS || {})[zone] || "";
        document.getElementById("selected-zone-label").textContent =
          `Zone ${zone}: ${label.toUpperCase()}`;
      });
    });
  },

  // ─── Color buttons ─────────────────────────────────────────────
  _bindColorButtons() {
    const otherInput = document.getElementById("color-other-input");
    document.querySelectorAll(".color-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".color-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.state.color = btn.dataset.color;
        document.getElementById("color-value").value = this.state.color;
        if (this.state.color === "OTHER") {
          otherInput.classList.remove("hidden");
          otherInput.focus();
        } else {
          otherInput.classList.add("hidden");
          this.state.colorOther = "";
        }
      });
    });
    otherInput.addEventListener("input", () => {
      this.state.colorOther = otherInput.value;
    });
  },

  // ─── Scar type select ──────────────────────────────────────────
  _bindScarTypeSelect() {
    document.getElementById("scar-type").addEventListener("change", e => {
      if (e.target.value !== this.state.scarType) this._breakRepeat();
      this.state.scarType = e.target.value;
      this.applyTypeRules();
    });
  },

  // ─── Read form values ──────────────────────────────────────────
  getFormValues() {
    return {
      scar_type:             this.state.scarType,
      confidence:            this.state.confidence,
      side:                  this.state.scarSide,
      zone:                  this.state.zone,
      color:                 this.state.color,
      color_other:           this.state.colorOther,
      notes:                 document.getElementById("scar-notes").value.trim(),
      multiple_scars:        this.state.multipleScars,
    };
  },

  getEncounterValues() {
    return {
      encounter_code: document.getElementById("enc-code").value.trim(),
      scars_visible:  this.state.scarsVisible,
    };
  },

  /** Scar types whose remaining questions do not apply.
   *
   *  COPEPODS are parasites, not a wound: they have no scar colour. Fields that
   *  cannot be answered sensibly must not be required — a form that demands a
   *  colour for a parasite teaches labelers that the form is noise, and they start
   *  picking any value to get past it. */
  get NO_COLOUR_TYPES() { return window.ScarVocab.TYPES_WITHOUT_COLOR; },

  needsColour(scarType) {
    return window.ScarVocab.needsColour(scarType);
  },

  /** Show only the questions this scar type actually raises. */
  /** A changed type or zone means this is a different mark — stop repeating. */
  _breakRepeat() {
    if (this._repeat) this.keepForNext(false);
  },

  applyTypeRules() {
    const type = String(document.getElementById("scar-type")?.value || "").toUpperCase();
    const isParasite = !this.needsColour(type);
    const colour = document.getElementById("scar-color-block");
    if (colour) colour.style.display = isParasite ? "none" : "";
    if (isParasite) {
      // Clear rather than keep a stale answer: a colour chosen before switching
      // type would be saved for a scar the form no longer asks about.
      const cv = document.getElementById("color-value");
      if (cv) cv.value = "";
      document.querySelectorAll(".color-btn").forEach((b) => b.classList.remove("active"));
      document.getElementById("color-other-input")?.classList.add("hidden");
    }
  },

  validate() {
    const v = this.getFormValues();
    if (!v.scar_type)   return "Please select a scar type.";
    if (!v.zone)        return "Please select a body zone.";
    if (this.needsColour(v.scar_type)) {
      if (!v.color)     return "Please select a scar color.";
      if (v.color === "OTHER" && !v.color_other) return "Please describe the color.";
    }
    return null;  // valid
  },

  /** Re-arm the SAME description for the next box in a group.
   *
   *  Scratch rakes and copepod clusters are many units in one zone, and the owner
   *  asked whether that could be made easier. It cannot be made cheaper by drawing
   *  FEWER boxes without losing something: measured, twelve SCRATCH boxes in one
   *  zone produce exactly ONE scar in consensus (sig = side+zone+type+colour, one
   *  record per signature per annotator) but TWELVE annotations in the COCO export
   *  the scar detector trains on. The boxes are for the model; the signature is for
   *  the catalog. So the answer is not a count field — it is making the twelfth box
   *  one click instead of six.
   *
   *  Deliberately NOT the default: a form that silently keeps its last answer is how
   *  a labeler files a BITE as a SCRATCH without noticing. It arms only when the
   *  person asks for it, and disarms on any type/zone change or a new frame.
   */
  keepForNext(on) {
    this._repeat = !!on;
    const btn = document.getElementById("scar-repeat");
    if (btn) btn.classList.toggle("active", this._repeat);
    if (window.appState) {
      window.appState._setStatus?.(this._repeat
        ? "Repeat ON — the next box reuses this description. Esc or change the type to stop."
        : "Repeat off.");
    }
  },

  resetScarFields() {
    // Repeat mode: the labeler is mid-group (a scratch rake, a copepod cluster), so
    // the description stands and only the geometry changes. Everything below would
    // blank it.
    if (this._repeat) {
      if (window.appState) window.appState._scarArmed = false;
      return;
    }
    // Reset scar-specific fields, keep encounter-level fields
    document.getElementById("scar-type").value = "";
    document.getElementById("scar-notes").value = "";
    document.getElementById("color-other-input").classList.add("hidden");
    document.getElementById("color-value").value = "";
    document.getElementById("zone-value").value = "";
    document.getElementById("selected-zone-label").textContent = "Zone: — not selected —";
    document.querySelectorAll(".zone-seg").forEach(s => s.classList.remove("active"));
    document.querySelectorAll(".color-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll('.radio-btn[data-group="multiple-scars"]').forEach(b => b.classList.remove("active"));
    this.applyTypeRules();   // type is blank again, so every question comes back
    this._initStars(3);
    this.state.scarType = "";
    this.state.zone = "";
    this.state.color = "";
    this.state.colorOther = "";
    this.state.multipleScars = "NO";
    this.state.confidence = 3;
    // Disarm: the form is blank again, so the next keystroke is the start of a new
    // description, not the completion of one.
    if (window.appState) window.appState._scarArmed = false;
  },
};

// Init on DOM ready
document.addEventListener("DOMContentLoaded", () => ScarForm.init());
window.ScarForm = ScarForm;
