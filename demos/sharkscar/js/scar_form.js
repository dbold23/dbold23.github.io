/**
 * scar_form.js — Scar form logic: zone diagram, star rating, color buttons, radio groups.
 * No external dependencies.
 */
"use strict";

const ScarForm = {
  // Current form values
  state: {
    sidesVisible: "Both",
    scarsVisible: "",
    scarType: "",
    confidence: 3,
    scarSide: "Left",
    zone: "",
    color: "",
    colorOther: "",
    notes: "",
    copepodsBody: "",
    copepodsWound: "",
    multipleScars: "NO",
  },

  init() {
    this._bindRadioGroups();
    this._bindStars();
    this._bindZoneDiagram();
    this._bindColorButtons();
    this._bindScarTypeSelect();
    this._initStars(this.state.confidence);
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
          case "sides":
            this.state.sidesVisible = val;
            // Auto-select scar side when only one side visible
            if (val === "Left" || val === "Right") {
              const sideBtn = document.querySelector(`.radio-btn[data-group="scar-side"][data-val="${val}"]`);
              if (sideBtn && !sideBtn.classList.contains("active")) {
                sideBtn.click();
              }
            }
            break;
          case "scars-visible":
            this.state.scarsVisible = val;
            document.getElementById("scar-form-section").classList.toggle("hidden", val === "NO");
            document.getElementById("no-scars-msg").classList.toggle("hidden", val !== "NO");
            break;
          case "scar-side":
            this.state.scarSide = val;
            document.getElementById("zone-svg").classList.toggle("flipped", val === "Right");
            break;
          case "copepods-body":  this.state.copepodsBody  = val; break;
          case "copepods-wound": this.state.copepodsWound = val; break;
          case "multiple-scars": this.state.multipleScars  = val; break;
        }
      });
    });
  },

  // ─── Star rating ───────────────────────────────────────────────
  _bindStars() {
    const stars = document.querySelectorAll(".star");
    stars.forEach(star => {
      star.addEventListener("mouseenter", () => this._highlightStars(+star.dataset.val));
      star.addEventListener("mouseleave", () => this._highlightStars(this.state.confidence));
      star.addEventListener("click", () => {
        this.state.confidence = +star.dataset.val;
        document.getElementById("confidence-value").value = this.state.confidence;
        this._highlightStars(this.state.confidence);
      });
    });
    // Key shortcut 1-5 handled in app.js
  },

  _initStars(val) {
    this.state.confidence = val;
    document.getElementById("confidence-value").value = val;
    this._highlightStars(val);
  },

  _highlightStars(val) {
    document.querySelectorAll(".star").forEach(s => {
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
        this.state.zone = zone;
        document.getElementById("zone-value").value = zone;
        const labels = { "1":"HEAD","2":"NAPE","3":"ABOVE GILLS","4":"GILLS",
                         "5":"SADDLE","6":"FLANK","7":"AFT DORSAL",
                         "8":"PELVIS","9":"PEDUNCLE","D":"DORSAL FIN",
                         "P":"PECTORAL FIN","T":"TAIL" };
        document.getElementById("selected-zone-label").textContent = `Zone ${zone}: ${labels[zone] || ""}`;
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
      this.state.scarType = e.target.value;
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
      copepods_present_body: this.state.copepodsBody,
      copepods_present_wound:this.state.copepodsWound,
      multiple_scars:        this.state.multipleScars,
    };
  },

  getEncounterValues() {
    return {
      encounter_code: document.getElementById("enc-code").value.trim(),
      sides_visible:  this.state.sidesVisible,
      scars_visible:  this.state.scarsVisible,
    };
  },

  validate() {
    const v = this.getFormValues();
    if (!v.scar_type)   return "Please select a scar type.";
    if (!v.zone)        return "Please select a body zone.";
    if (!v.color)       return "Please select a scar color.";
    if (v.color === "OTHER" && !v.color_other) return "Please describe the color.";
    return null;  // valid
  },

  resetScarFields() {
    // Reset scar-specific fields, keep encounter-level fields
    document.getElementById("scar-type").value = "";
    document.getElementById("scar-notes").value = "";
    document.getElementById("color-other-input").classList.add("hidden");
    document.getElementById("color-value").value = "";
    document.getElementById("zone-value").value = "";
    document.getElementById("selected-zone-label").textContent = "Zone: — not selected —";
    document.querySelectorAll(".zone-seg").forEach(s => s.classList.remove("active"));
    document.querySelectorAll(".color-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll('.radio-btn[data-group="copepods-body"]').forEach(b => b.classList.remove("active"));
    document.querySelectorAll('.radio-btn[data-group="copepods-wound"]').forEach(b => b.classList.remove("active"));
    document.querySelectorAll('.radio-btn[data-group="multiple-scars"]').forEach(b => b.classList.remove("active"));
    this._initStars(3);
    this.state.scarType = "";
    this.state.zone = "";
    this.state.color = "";
    this.state.colorOther = "";
    this.state.copepodsBody = "";
    this.state.copepodsWound = "";
    this.state.multipleScars = "NO";
    this.state.confidence = 3;
  },
};

// Init on DOM ready
document.addEventListener("DOMContentLoaded", () => ScarForm.init());
window.ScarForm = ScarForm;
