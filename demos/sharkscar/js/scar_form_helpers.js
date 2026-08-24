/**
 * Polish 7 — shared scar form field renderers.
 *
 * Both the sidebar track editor (tracks.js:_openEditor) and the triage card
 * need the same widgets: scar type dropdown, confidence stars, zone SVG,
 * side buttons, color picker. This module owns the markup + bindings.
 *
 * Usage:
 *   const fields = new ScarFormFields("triage-fields", {
 *     track,
 *     onChange: (state) => { ... },
 *   });
 *   container.innerHTML = fields.render();
 *   fields.bind();
 *   const v = fields.getValues();   // {scar_type, human_zone, ...}
 *
 * IDs in markup are prefixed by the `prefix` arg so multiple instances on
 * the same page (modal + triage card swap) don't collide.
 */
"use strict";

(function () {

// The words come from scar_vocab.js so the main form and this one cannot drift;
// this module owns only the MARKUP. index.html loads scar_vocab.js first.
const V = (typeof window !== "undefined" ? window : globalThis).ScarVocab;
const SCAR_TYPES = V.SCAR_TYPES;
const TYPES_WITHOUT_COLOR = new Set(V.TYPES_WITHOUT_COLOR);
const ZONE_LABELS = V.ZONE_LABELS;
const COLORS = V.COLORS;
const COLOR_HEX = V.COLOR_HEX;
const CONFIDENCE_RUBRIC = V.CONFIDENCE_RUBRIC;

// 12-zone polygon picker (mirrors templates/index.html zone SVG, with
// IDs/classes prefixed so multiple instances coexist).
function _zoneSvg(prefix, suggestedZone, activeZone, flipped) {
  const segClasses = (z) => {
    const classes = [`${prefix}-zone-seg`];
    if (z === suggestedZone && !activeZone) classes.push("suggested");
    if (z === activeZone) classes.push("active");
    return classes.join(" ");
  };
  const flipCls = flipped ? "flipped" : "";
  return `
    <svg viewBox="0 0 500 155" xmlns="http://www.w3.org/2000/svg" id="${prefix}-zone-svg" class="${flipCls}">
      <circle cx="55" cy="80" r="2.5" fill="var(--text-muted)" opacity="0.5" pointer-events="none"/>
      <g opacity="0.25" pointer-events="none" stroke="var(--text-muted)" stroke-width="0.8">
        <line x1="142" y1="60" x2="142" y2="120"/><line x1="148" y1="58" x2="148" y2="122"/>
        <line x1="154" y1="56" x2="154" y2="124"/><line x1="160" y1="55" x2="160" y2="126"/>
      </g>
      <g class="${segClasses('1')}" data-zone="1"><polygon points="19,87 50,69 81,58 81,118 42,102"/><text x="55" y="87">1</text></g>
      <g class="${segClasses('2')}" data-zone="2"><polygon points="82,58 102,53 139,46 139,128 110,124 81,119"/><text x="110" y="88">2</text></g>
      <g class="${segClasses('3')}" data-zone="3"><polygon points="140,46 160,44 183,42 182,54 139,58 140,54"/><text x="157" y="50">3</text></g>
      <g class="${segClasses('4')}" data-zone="4"><polygon points="139,58 159,56 182,53 179,94 178,106 175,131 140,128 140,120"/><text x="162" y="93">4</text></g>
      <g class="${segClasses('5')}" data-zone="5"><polygon points="183,42 214,39 244,42 274,49 273,53 272,59 182,54"/><text x="228" y="48">5</text></g>
      <g class="${segClasses('6')}" data-zone="6"><polygon points="182,54 274,60 273,99 273,122 232,129 227,118 206,112 179,106"/><text x="228" y="97">6</text></g>
      <g class="${segClasses('7')}" data-zone="7"><polygon points="274,50 309,58 337,65 360,71 359,81 360,85 320,74 273,59"/><text x="317" y="68">7</text></g>
      <g class="${segClasses('8')}" data-zone="8"><polygon points="273,60 359,85 358,107 274,121"/><text x="316" y="93">8</text></g>
      <g class="${segClasses('9')}" data-zone="9"><polygon points="360,71 411,81 411,95 358,107"/><text x="385" y="89">9</text></g>
      <g class="${segClasses('D')}" data-zone="D"><polygon points="215,37 238,5 250,-1 255,1 258,21 265,37 274,49 250,43 214,38"/><text x="247" y="26">D</text></g>
      <g class="${segClasses('P')}" data-zone="P"><polygon points="179,106 228,118 231,130 246,154 233,153 210,145 191,132 176,131"/><text x="212" y="134">P</text></g>
      <g class="${segClasses('T')}" data-zone="T"><polygon points="411,81 430,65 448,52 473,36 492,25 484,47 478,56 470,68 462,83 458,93 457,116 463,146 445,131 429,111 421,97 411,95"/><text x="460" y="85">T</text></g>
    </svg>`;
}

class ScarFormFields {
  /**
   * @param {string} prefix - unique element-id prefix (e.g. "triage")
   * @param {{
   *   track?: object,                 // pre-populates from track.scar_type / human_*
   *   onChange?: (state) => void,     // fires whenever any field changes
   *   compact?: boolean,              // smaller spacing for triage card
   * }} opts
   */
  constructor(prefix, opts = {}) {
    this.prefix = prefix;
    this.opts = opts;
    const t = opts.track || {};
    // Pre-fill ONLY from human_* (the user's previous choice if revisiting).
    // Auto values are surfaced as visual suggestions (dashed outline / chip)
    // but never pre-fill — keeps human-as-ground-truth invariant intact.
    this.state = {
      scar_type: t.scar_type || "",
      human_confidence: t.human_confidence || 3,
      human_zone: t.human_zone || null,
      human_side: t.human_side || null,
      human_color: t.human_color || null,
    };
    this.suggested = {
      zone: t.auto_zone || null,
      side: t.auto_side || null,
      color: t.auto_color || null,
    };
    this._typeMap = TYPES_WITHOUT_COLOR;
  }

  render() {
    const p = this.prefix;
    const s = this.state;
    const sug = this.suggested;
    const compactSpacing = this.opts.compact ? "10px" : "14px";

    const typeOpts = SCAR_TYPES.map(v =>
      `<option value="${v}" ${v === s.scar_type ? "selected" : ""}>${v}</option>`
    ).join("");

    const stars = [1, 2, 3, 4, 5].map(v =>
      `<span class="star ${v <= s.human_confidence ? "active" : ""} ${p}-conf-star" data-val="${v}">★</span>`
    ).join("");

    // A scar is on ONE flank. "Both" answered the encounter-level
    // `sides_visible` question and never belonged here; a record that already
    // holds it keeps it (V.sidesFor), and nobody else is offered it.
    const sideBtns = V.sidesFor(s.human_side || sug.side).map(side => {
      const isActive = (s.human_side || sug.side) === side;
      const isSuggested = (sug.side === side && !s.human_side);
      const styles = [
        "padding:6px 14px;margin:2px;border-radius:4px;cursor:pointer;background:#333;color:#ddd;border:1px solid #555;font-size:13px;font-family:inherit;",
        isSuggested ? "outline:1.5px dashed #9bf;outline-offset:1px;" : "",
        isActive ? "background:rgba(74,144,217,0.55);border-color:#4a90d9;color:#fff;" : "",
      ].join("");
      return `<button type="button" class="${p}-side-btn" data-side="${side}" style="${styles}">${side}</button>`;
    }).join("");

    const colorBtns = COLORS.map(c => {
      const isActive = (s.human_color || sug.color) === c;
      const styles = [
        `padding:6px 12px;margin:2px;border-radius:4px;cursor:pointer;`,
        `background:${COLOR_HEX[c]};color:${c === "WHITE" || c === "PINK" ? "#222" : "#fff"};`,
        `border:2px solid ${isActive ? "#4a90d9" : "transparent"};font-size:12px;font-weight:600;font-family:inherit;`,
      ].join("");
      return `<button type="button" class="${p}-color-btn" data-color="${c}" style="${styles}">${c}</button>`;
    }).join("");

    const flipped = (s.human_side || sug.side) === "Right";
    const zoneLabel = s.human_zone
      ? `Zone <strong style="color:#9bf;">${s.human_zone}</strong> ${ZONE_LABELS[s.human_zone] || ""}`
      : "Zone — not selected —";

    const showColor = !this._typeMap.has(s.scar_type);

    return `
      <div class="${p}-fields" style="display:flex;flex-direction:column;gap:${compactSpacing};">

        <div class="${p}-field-row">
          <label style="font-size:11px;color:#aaa;display:block;margin-bottom:4px;">SCAR TYPE <span style="color:#a33;">*</span></label>
          <select id="${p}-scar-type" style="width:100%;padding:8px;border-radius:4px;background:#222;color:#eee;border:1px solid #555;font-size:14px;">
            <option value="">— pick type —</option>
            ${typeOpts}
          </select>
          <div style="margin-top:6px;display:flex;align-items:center;gap:8px;">
            <span style="font-size:10px;color:#888;">Confidence:</span>
            <div class="star-rating" id="${p}-stars" style="margin:0;font-size:18px;">${stars}</div>
            <span style="color:#a33;font-size:11px;">*</span>
          </div>
          <div id="${p}-rubric" style="margin-top:3px;font-size:10px;color:#789;font-style:italic;line-height:1.35;min-height:14px;"></div>
        </div>

        <div class="${p}-field-row">
          <label style="font-size:11px;color:#aaa;display:block;margin-bottom:4px;">ZONE <span style="color:#a33;">*</span> <span style="color:#666;font-size:10px;">(tap diagram)</span></label>
          <div class="zone-diagram">${_zoneSvg(p, sug.zone, s.human_zone, flipped)}</div>
          <div id="${p}-zone-label" style="font-size:11px;color:#888;margin-top:4px;">${zoneLabel}</div>
        </div>

        <div class="${p}-field-row">
          <label style="font-size:11px;color:#aaa;display:block;margin-bottom:4px;">SIDE VISIBLE <span style="color:#a33;">*</span></label>
          <div id="${p}-side-picker" style="display:flex;flex-wrap:wrap;">${sideBtns}</div>
        </div>

        <div class="${p}-field-row" id="${p}-color-row" style="${showColor ? '' : 'display:none;'}">
          <label style="font-size:11px;color:#aaa;display:block;margin-bottom:4px;">COLOR</label>
          <div id="${p}-color-picker" style="display:flex;flex-wrap:wrap;">${colorBtns}</div>
        </div>

      </div>
    `;
  }

  /** Bind all field handlers. Call after the markup is in the DOM. */
  bind() {
    const p = this.prefix;
    const fire = () => this.opts.onChange?.(this.getValues());

    // Type dropdown — also flips color section visibility for COPEPODS.
    const typeSel = document.getElementById(`${p}-scar-type`);
    typeSel?.addEventListener("change", () => {
      this.state.scar_type = typeSel.value;
      const colorRow = document.getElementById(`${p}-color-row`);
      if (colorRow) colorRow.style.display = this._typeMap.has(this.state.scar_type) ? "none" : "";
      if (this._typeMap.has(this.state.scar_type)) {
        this.state.human_color = null;  // force-clear when type doesn't carry color
      }
      fire();
    });

    // Confidence stars
    const stars = document.querySelectorAll(`.${p}-conf-star`);
    const rubric = document.getElementById(`${p}-rubric`);
    const showRubric = (val) => {
      const r = val && CONFIDENCE_RUBRIC[val];
      if (rubric) rubric.textContent = r ? `${val}★ ${r.name} — ${r.means}` : "";
    };
    const highlight = (val) => {
      stars.forEach(s => s.classList.toggle("active", +s.dataset.val <= val));
    };
    stars.forEach(star => {
      const v = +star.dataset.val;
      star.addEventListener("mouseenter", () => { highlight(v); showRubric(v); });
      star.addEventListener("mouseleave", () => { highlight(this.state.human_confidence || 0); showRubric(this.state.human_confidence || 0); });
      star.addEventListener("click", () => {
        this.state.human_confidence = v;
        highlight(v); showRubric(v);
        fire();
      });
    });
    showRubric(this.state.human_confidence);

    // Zone segments
    document.querySelectorAll(`#${p}-zone-svg .${p}-zone-seg`).forEach(seg => {
      seg.addEventListener("click", () => {
        document.querySelectorAll(`#${p}-zone-svg .${p}-zone-seg`)
          .forEach(s => s.classList.remove("active"));
        seg.classList.add("active");
        const z = seg.dataset.zone;
        this.state.human_zone = z;
        const lbl = document.getElementById(`${p}-zone-label`);
        if (lbl) lbl.innerHTML = `Zone <strong style="color:#9bf;">${z}</strong> ${ZONE_LABELS[z] || ""}`;
        fire();
      });
    });

    // Side buttons — also flip the zone SVG for "Right"
    document.querySelectorAll(`.${p}-side-btn`).forEach(btn => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.side;
        this.state.human_side = v;
        document.querySelectorAll(`.${p}-side-btn`).forEach(b => {
          b.style.background = "#333";
          b.style.borderColor = "#555";
          b.style.color = "#ddd";
        });
        btn.style.background = "rgba(74,144,217,0.55)";
        btn.style.borderColor = "#4a90d9";
        btn.style.color = "#fff";
        const svg = document.getElementById(`${p}-zone-svg`);
        if (svg) svg.classList.toggle("flipped", v === "Right");
        fire();
      });
    });

    // Color buttons
    document.querySelectorAll(`.${p}-color-btn`).forEach(btn => {
      btn.addEventListener("click", () => {
        const c = btn.dataset.color;
        this.state.human_color = c;
        document.querySelectorAll(`.${p}-color-btn`).forEach(b => {
          b.style.borderColor = "transparent";
        });
        btn.style.borderColor = "#4a90d9";
        fire();
      });
    });
  }

  getValues() {
    return { ...this.state };
  }

  /** Are required fields filled in? scar_type + zone + side, plus color
   * unless the type explicitly doesn't carry one. */
  isValid() {
    const s = this.state;
    if (!s.scar_type) return false;
    if (!s.human_zone) return false;
    if (!s.human_side) return false;
    if (!this._typeMap.has(s.scar_type) && !s.human_color) return false;
    return true;
  }

  // Public introspection — let consumers know the labels for status messages
  static get ZONE_LABELS() { return ZONE_LABELS; }
  static get SCAR_TYPES() { return SCAR_TYPES; }
  static get TYPES_WITHOUT_COLOR() { return TYPES_WITHOUT_COLOR; }
}

window.ScarFormFields = ScarFormFields;

})();
