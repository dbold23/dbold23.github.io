/**
 * panel_ui.js — compact right rail, collapsible sections, context-driven task, hideable left rail.
 *
 * Additive layer over panels Stream D owns. It reads the existing DOM and wraps it; it
 * does not restructure anyone's markup, and every behaviour degrades to "the panel you
 * had before" if an element is missing.
 *
 * Four things:
 *
 * 1. **Every `.section-label` becomes a collapsible header.** Sections are discovered at
 *    runtime by walking each tab's children, so a section added later by any stream is
 *    picked up with no registration.
 * 2. **Only the applicable task is shown.** What is loaded decides: a still frame is a
 *    pose task, a video is a scar task, a signal deployment is a signals task. When
 *    exactly one applies the tab bar is replaced by a task header, because a one-tab tab
 *    bar is chrome that teaches nothing.
 * 3. **The left rail hides**, from a button in the header, so the annotation surface gets
 *    the full width.
 * 4. **Confidence is stars, not a dropdown** — matching the scar form, which has always
 *    used stars. Two different widgets for the same 1–5 judgement is a papercut every
 *    labeler pays on every annotation.
 *
 * Collapsed state and the left-rail state persist in localStorage per user, because a
 * labeler who collapses a section they never use should not have to do it again every
 * morning.
 */
"use strict";

const PanelUI = {
  STORE_SECTIONS: "ssa.panel.collapsed",
  STORE_TOUCHED: "ssa.panel.touched",
  STORE_LEFT: "ssa.panel.leftHidden",

  /** Sections that start COLLAPSED for a labeler who has never touched them.
   *  MY STATS is reference material, not part of annotating — it should be there
   *  when you go looking and out of the way when you are not. */
  DEFAULT_COLLAPSED: [
    "gamification-panel:my_stats",
    // A board of goals is something you look at now and then, not on every frame.
    // Folded by default; a labeler who opens it has that remembered. The trailing
    // `_i` is the info icon's own text: _sectionKey takes the header's first three
    // words, and the icon lives in the header.
    "gami-achievements:achievements_i",
    "gami-achievements:closest_i",
  ],

  _collapsed: new Set(),
  /** Keys the labeler has explicitly toggled. Without this, "default collapsed"
   *  cannot be distinguished from "they collapsed it", so expanding MY STATS would
   *  be silently undone on every reload — the preference would never stick. */
  _touched: new Set(),
  _stateLoaded: false,

  init() {
    document.body.classList.add("compact-panels");
    this._loadState();
    this._buildSections();
    // The stats panel is rendered by gamification.js after an async /api/me/stats
    // fetch, so it may land either side of this call. Both paths wrap it and both
    // are idempotent, so whichever happens second is a no-op.
    this._buildSections("#gamification-panel");
    this._bindLeftToggle();
    this._buildSignalStars();
    this._observeContext();
    this._bindTaskTours();
    this.refreshTask();
  },

  // ══════════════════════════════════════════════════════════════════════
  // Task tours
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Tell the tutorial which annotation UI the labeler is now facing.
   *
   * This module already answers that question for its own purposes, so it is the right
   * place to announce it. The alternative — a trigger guard at every path that loads
   * data — is what the tutorial used to do, and it fired on proxies ("a video was
   * selected") that stopped implying the task once the panel became context-driven.
   */
  _notifyTask() {
    const bar = document.querySelector(".panel-right .panel-tabs");
    if (!bar || !window.Tutorial || !window.Tutorial.taskEntered) return;

    // "Facing the UI" means there is something loaded in it. An empty workspace shows the
    // default tab, and teaching the scar form to someone who has not opened an assignment
    // yet is exactly the mistimed tour this rework exists to remove.
    const app = window.appState || window.AppState;
    const loaded = !!((app && app.currentVideo && app.currentVideo.id)
      || (window.Signals && window.Signals.deployment));
    if (!loaded) return;

    const active = bar.querySelector(".tab-btn.active");
    const task = active && active.dataset.tab;
    if (!task) return;
    // Banner and tools are refreshed on EVERY resolution, not only on a change:
    // they describe the current state, whereas a tour fires once per arrival.
    this.showMission(task);
    if (!window.Tutorial || !window.Tutorial.taskEntered) return;
    if (task === this._lastTaskNotified) return;
    this._lastTaskNotified = task;
    window.Tutorial.taskEntered(task);
  },

  /** What this annotation is FOR, said on the image rather than inferred from
   *  which tab happens to be active. A labeler arriving from a queue card has been
   *  handed a job; the workspace should name it. */
  MISSIONS: {
    pose:    ["Pose estimation", "Place the 16-point skeleton on the animal."],
    scars:   ["Scar classification", "Find each scar, then box and classify it."],
    signals: ["Signal annotation", "Mark events on the deployment clock."],
  },

  showMission(task) {
    const el = document.getElementById("mission-banner");
    if (!el) return;
    const m = this.MISSIONS[task];
    if (!m) { el.style.display = "none"; return; }
    // Say what the labeler is being asked to DO. The queue's internal mission name
    // ("Walkthrough — scar coverage") used to win here, which named the batch the
    // work came from rather than the job in front of them — scheduling vocabulary,
    // on the one line that should be instruction.
    document.getElementById("mission-banner-task").textContent = m[0];
    document.getElementById("mission-banner-what").textContent = m[1];
    el.style.display = "";
    el.dataset.task = task;
    this._toolsFor(task);
  },

  /** Only the tools this task uses.
   *
   *  Box and ROI are pose/region tools. On the scar task they are noise at best
   *  and a trap at worst: a labeler who draws with Box gets a BODY box, not a
   *  scar, and nothing tells them so. The scar flow has exactly one entry point —
   *  "+ ADD SCAR" — which fills the form first and then equips the scar box. */
  _toolsFor(task) {
    const show = (id, on) => {
      const b = document.getElementById(id);
      if (b) b.style.display = on ? "" : "none";
    };
    if (task === "scars") {
      show("tool-bbox", false);
      show("tool-roi", false);
    } else if (task === "pose") {
      show("tool-bbox", true);            // "Body [B]" — the body bbox belongs here
      if (window.ROI && window.ROI.available) show("tool-roi", true);   // roi.js names it `available`
    }
  },

  /** A manual tab switch is arriving at that UI too, not just a context change. */
  _bindTaskTours() {
    const bar = document.querySelector(".panel-right .panel-tabs");
    if (!bar) return;
    bar.addEventListener("click", (e) => {
      if (!e.target.closest(".tab-btn")) return;
      setTimeout(() => this._notifyTask(), 60);
    });
  },

  // ══════════════════════════════════════════════════════════════════════
  // Collapsible sections
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Wrap each `.section-label` plus everything up to the next one into a collapsible
   * group. Done by walking siblings rather than by requiring markup changes, so sections
   * owned by other streams keep working untouched.
   *
   * `rootSel` scopes the search. It defaults to the right rail, which is where every
   * section lived when this was written. The stats panel is rendered into the LEFT rail
   * by gamification.js, so it was never reached — MY STATS was the one heading in the
   * app that could not be collapsed. Other streams that render a panel asynchronously
   * should call `buildSectionsIn()` once their markup is in the DOM.
   */
  _buildSections(rootSel = ".panel-right") {
    // Repeatedly wrap the FIRST not-yet-wrapped section-label. Re-querying each time is
    // the only way that survives re-parenting: walking a cached child list loses its
    // place the moment nodes move into the wrapper being built.
    for (let guard = 0; guard < 200; guard++) {
      // `summary.section-label` is excluded: it is already a native <details>
      // disclosure, and re-parenting it out of its <details> would break the built-in
      // toggle to replace it with an identical one.
      const label = document.querySelector(
        `${rootSel} .section-label:not(.panel-section > .section-label):not(summary)`
      );
      if (!label) break;
      const container = label.parentNode;
      if (!container) break;

      const section = document.createElement("div");
      section.className = "panel-section";
      const body = document.createElement("div");
      body.className = "panel-section-body";

      container.insertBefore(section, label);
      section.appendChild(label);
      section.appendChild(body);

      // Absorb following siblings up to the next section boundary.
      let next = section.nextSibling;
      while (next) {
        const after = next.nextSibling;
        if (next.nodeType === 1 && this._isSectionBoundary(next)) break;
        body.appendChild(next);
        next = after;
      }

      const key = this._sectionKey(container, label);
      section.dataset.sectionKey = key;
      const startCollapsed = this._touched.has(key)
        ? this._collapsed.has(key)                  // respect their explicit choice
        : this.DEFAULT_COLLAPSED.includes(key);     // otherwise apply the default
      if (startCollapsed) section.classList.add("collapsed");

      label.setAttribute("role", "button");
      label.setAttribute("tabindex", "0");
      label.addEventListener("click", (e) => {
        // The info "i" and any control inside the header keep their own behaviour.
        if (e.target.closest(".info-icon, button, input, select, a")) return;
        this.toggleSection(section);
      });
      label.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.toggleSection(section);
        }
      });
    }
  },

  /**
   * Where a section stops swallowing its siblings.
   *
   * Getting this wrong is not cosmetic. The right rail is a flat list: the ENCOUNTER
   * heading is followed by its one input, then the tab bar, then every tab's contents,
   * then the tracks/ROI panels, then the save buttons. A naive "absorb until the next
   * heading" rule put ALL of that inside ENCOUNTER — so one click on that heading
   * collapsed the entire panel, and because collapsed state persists, the labeler got an
   * empty rail every session afterwards with only the heading left to click.
   *
   * The general rule that fixes it: a sibling containing headings of its own is a
   * *container of sections*, not content belonging to this one. The explicit list covers
   * the structural elements that hold no heading but are equally not section content.
   */
  BOUNDARY_SELECTOR: ".section-label, .panel-section, .panel-tabs, .panel-task, .tab-content",

  _isSectionBoundary(el) {
    if (el.matches(this.BOUNDARY_SELECTOR)) return true;
    // Holds its own headings ⇒ it is not this section's body.
    return !!el.querySelector(".section-label");
  },

  _sectionKey(container, labelNode) {
    const tab = container.id || "root";
    const text = (labelNode.textContent || "").trim().split(/\s+/).slice(0, 3).join("_");
    return `${tab}:${text}`.toLowerCase();
  },

  /**
   * Make sections inside `rootSel` collapsible. Safe to call before or after `init()`,
   * and safe to call repeatedly — already-wrapped labels are skipped by the selector.
   *
   * Loads persisted state first: a panel that renders before `init()` would otherwise
   * be wrapped against an empty `_collapsed` set and come back expanded for a labeler
   * who had collapsed it, with `init()` then finding nothing left to wrap and no second
   * chance to apply it.
   */
  buildSectionsIn(rootSel) {
    if (!this._stateLoaded) this._loadState();
    this._buildSections(rootSel);
  },

  toggleSection(section) {
    const key = section.dataset.sectionKey;
    const nowCollapsed = section.classList.toggle("collapsed");
    if (nowCollapsed) this._collapsed.add(key);
    else this._collapsed.delete(key);
    this._touched.add(key);   // from here on, their choice beats DEFAULT_COLLAPSED
    this._saveState();
  },

  _loadState() {
    this._stateLoaded = true;
    try {
      const raw = localStorage.getItem(this.STORE_SECTIONS);
      if (raw) this._collapsed = new Set(JSON.parse(raw));
      const touched = localStorage.getItem(this.STORE_TOUCHED);
      if (touched) this._touched = new Set(JSON.parse(touched));
    } catch (e) { /* a corrupt preference must not break the panel */ }
  },

  _saveState() {
    try {
      localStorage.setItem(this.STORE_SECTIONS, JSON.stringify([...this._collapsed]));
      localStorage.setItem(this.STORE_TOUCHED, JSON.stringify([...this._touched]));
    } catch (e) { /* private mode / quota — collapsing still works, it just won't persist */ }
  },

  // ══════════════════════════════════════════════════════════════════════
  // Context-driven task
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Is the signals UI actually in front of this labeler?
   *
   * `Signals.available` means the FEATURE is switched on server-side; `Signals.present`
   * means this particular labeler has an audio/RF/sensor source to look at. Everything
   * user-facing must key off the latter, or every scar and pose annotator in the lab
   * gets a Signals tab and an empty waterfall dock for work they were never assigned.
   * Falls back to `available` so an older signals.js without `present` behaves as before.
   */
  _signalsShown() {
    const sig = window.Signals;
    if (!sig) return false;
    return sig.present !== undefined ? !!sig.present : !!sig.available;
  },

  /** Stream H's 3D task, gated the same way: on the feature answering its health probe. */
  _pose3dShown() {
    return !!(window.Pose3D && window.Pose3D.health);
  },

  /** Map a dataset spec's task_type onto the annotation tab that performs it. */
  TASK_TAB: { pose: "pose", bbox: "scars", segment: "scars", verify: "scars" },

  /**
   * The task the FED queue has assigned, or null when the labeler is free-choosing.
   *
   * When the system chose the item, it also chose the task — a pose item exists
   * because the corpus is short of keypoints, and answering it with a scar box
   * leaves that gap exactly as open while consuming the frame. Letting the labeler
   * switch tabs would quietly defeat the whole point of feeding the queue.
   */
  fedTask() {
    const wq = window.WorkQueue;
    if (!wq || !wq.enabled || !wq.items || !wq.items.length) return null;
    const head = wq._activeItemId ? wq._find(wq._activeItemId) : wq.items[0];
    return head ? (this.TASK_TAB[head.task_type] || null) : null;
  },

  /** Which annotation tasks the currently-loaded data actually supports. */
  applicableTabs() {
    const app = window.appState || window.AppState;
    const media = (app && app.currentVideo && app.currentVideo.media_type) || null;

    // A fed item pins the task, but never to something the media cannot support:
    // a still frame is a pose task, so a bbox item on an image would strand the
    // labeler on a tab with nothing to draw on.
    const fed = this.fedTask();
    if (fed && !(media === "image" && fed === "scars")) return [fed];
    const hasSignals = !!(window.Signals && this._signalsShown() && window.Signals.deployment);

    // Stream H is an ADDITIONAL task on the same media, not an alternative to it: a
    // silhouette can be traced on a still or on a video frame alike. So it is appended
    // rather than returned alone — unlike signals, which pins the task because its media
    // is a different file entirely. Off ⇒ `_pose3dShown()` is false ⇒ refreshTask() hides
    // the button, which is why Stream H needs no `continue` special-case below.
    const p3d = this._pose3dShown() ? ["pose3d"] : [];

    if (hasSignals) return ["signals"];
    if (media === "image") return ["pose", ...p3d];  // a still frame is a pose task
    if (media === "video") return ["pose", "scars", ...p3d]; // a clip carries both
    return ["pose", "scars", ...p3d];                // nothing loaded yet — leave the choice
  },

  /** Show only applicable tabs; collapse the bar to a task header when there is one. */
  refreshTask() {
    const bar = document.querySelector(".panel-right .panel-tabs");
    if (!bar) return;
    const want = this.applicableTabs();
    const btns = [...bar.querySelectorAll(".tab-btn")];

    for (const b of btns) {
      const applicable = want.includes(b.dataset.tab);
      b.classList.toggle("not-applicable", !applicable);
      // Stream F's own button carries an inline display:none until signals.js decides
      // it belongs here; don't fight that. Gated on PRESENCE (this labeler has an
      // audio/RF/sensor source), not on `available` (the feature is switched on) —
      // otherwise every scar and pose annotator in the lab gets a Signals tab for a
      // task they were never assigned.
      if (b.id === "signal-tab-btn" && !this._signalsShown()) continue;
      b.style.display = applicable ? "" : "none";
    }

    const single = want.length === 1;
    bar.classList.toggle("single-task", single);

    // If the active tab is no longer applicable, move to one that is.
    const active = btns.find((b) => b.classList.contains("active"));
    if (!active || !want.includes(active.dataset.tab)) {
      const target = btns.find((b) => b.dataset.tab === want[0]);
      if (target) target.click();
    }
    this._renderTaskHeader(single ? want[0] : null);
    this._applyTaskScoping(want);
    this._notifyTask();
  },

  /**
   * Panels that live OUTSIDE the tab-contents but only mean something for one task.
   *
   * `tracks-panel`, `roi-panel` and the classic scar form all sit at the panel root, so
   * they survive a tab switch and would otherwise show "Follow a scar" next to an
   * acoustic waterfall. The brief asked for only the metadata that belongs to the task in
   * front of you, and a control that cannot apply is worse than clutter — it implies an
   * action that will not work.
   */
  TASK_SCOPED: {
    "tracks-panel": ["scars"],
    "roi-panel": ["scars"],
    "scar-form-section": ["scars"],
    // The sighting/scar-object board is about marks on an ANIMAL, which is a scar
    // question. It was missing here, so it rendered beside the pose task and next to
    // the acoustic waterfall — a control that cannot apply, which is worse than
    // clutter because it implies an action that will not work.
    "objects-panel": ["scars"],
  },

  /** Panels this module has hidden itself, and may therefore un-hide. */
  _hiddenByTask: new Set(),

  _applyTaskScoping(want) {
    for (const [id, tasks] of Object.entries(this.TASK_SCOPED)) {
      const el = document.getElementById(id);
      if (!el) continue;
      // Hide the element ITSELF, never `closest('.panel-section')`. These panels are
      // containers whose own section wrappers live inside them, so hiding the element
      // takes its headers with it — whereas walking UP lands on a wrapper that also
      // swallowed the save buttons (a section absorbs every sibling up to the next
      // header), which blanks the entire rail.
      const applies = tasks.some((t) => want.includes(t));

      if (!applies) {
        // Only record a panel as ours if it was actually visible when we hid it,
        // so a later restore cannot resurrect something a feature gate had hidden.
        if (el.style.display !== "none") this._hiddenByTask.add(id);
        el.style.display = "none";
        continue;
      }

      // Restore ONLY what this module hid. `roi.js` and `tracks.js` set
      // `display:none` on their own panels when their health check says the feature is
      // off; clearing the property unconditionally un-hid them, so on an install with
      // `roi.enabled: false` or no tracker, opening any video made dead controls appear.
      // That is the exact defect this scoping exists to prevent — a control that implies
      // an action it cannot perform — reintroduced by the fix for it.
      if (this._hiddenByTask.has(id)) {
        el.style.display = "";
        this._hiddenByTask.delete(id);
      }
    }
  },

  _renderTaskHeader(tab) {
    let el = document.getElementById("panel-task");
    if (!el) {
      el = document.createElement("div");
      el.id = "panel-task";
      el.className = "panel-task hidden";
      const bar = document.querySelector(".panel-right .panel-tabs");
      if (!bar) return;
      bar.parentNode.insertBefore(el, bar);
    }
    const META = {
      pose: ["Pose & morphometrics", "image"],
      scars: ["Scar annotation", "video"],
      signals: ["Signal labeling", "deployment"],
    };
    if (!tab || !META[tab]) {
      el.classList.add("hidden");
      return;
    }
    const [title, kind] = META[tab];
    el.textContent = "";
    const t = document.createElement("span");
    t.textContent = title;
    const k = document.createElement("span");
    k.className = "panel-task-kind";
    k.textContent = kind;
    el.appendChild(t);
    el.appendChild(k);
    el.classList.remove("hidden");
  },

  /**
   * Re-evaluate the task when the loaded data changes.
   *
   * Polled rather than event-driven on purpose: the load paths live in Stream-D-owned
   * files, and adding a hook there would mean editing them. A 500 ms poll comparing two
   * strings is cheaper than the coordination.
   */
  _observeContext() {
    let last = "";
    setInterval(() => {
      const app = window.appState || window.AppState;
      const sig = window.Signals;
      const key = [
        (app && app.currentVideo && app.currentVideo.id) || "",
        (app && app.currentVideo && app.currentVideo.media_type) || "",
        (sig && sig.deployment && sig.deployment.id) || "",
      ].join("|");
      if (key !== last) {
        last = key;
        this.refreshTask();
      }
    }, 500);
  },

  // ══════════════════════════════════════════════════════════════════════
  // Left rail
  // ══════════════════════════════════════════════════════════════════════

  _bindLeftToggle() {
    const btn = document.getElementById("btn-hide-left");
    if (!btn) return;
    const apply = (hidden) => {
      document.body.classList.toggle("left-hidden", hidden);
      btn.classList.toggle("active", hidden);
      btn.textContent = hidden ? "▸ Panel" : "◂ Panel";
      btn.title = hidden ? "Show the videos panel" : "Hide the videos panel";
      // The canvas sizes itself from its container, so give it a frame to notice.
      setTimeout(() => window.dispatchEvent(new Event("resize")), 180);
    };
    let hidden = false;
    try { hidden = localStorage.getItem(this.STORE_LEFT) === "1"; } catch (e) { /* ignore */ }
    apply(hidden);
    btn.addEventListener("click", () => {
      hidden = !hidden;
      apply(hidden);
      try { localStorage.setItem(this.STORE_LEFT, hidden ? "1" : "0"); } catch (e) { /* ignore */ }
    });
  },

  // ══════════════════════════════════════════════════════════════════════
  // Confidence stars
  // ══════════════════════════════════════════════════════════════════════

  RUBRIC: {
    1: "guess",
    2: "weak",
    3: "moderate",
    4: "strong",
    5: "certain",
  },

  /** Replace the signals confidence <select> with the same star widget the scar form uses. */
  _buildSignalStars() {
    const sel = document.getElementById("signal-confidence");
    if (!sel || sel.dataset.starred) return;

    const wrap = document.createElement("div");
    wrap.className = "signal-stars";
    const hint = document.createElement("span");
    hint.className = "conf-hint";

    const current = () => (window.Signals ? window.Signals.confidence : 3) || 3;
    const stars = [1, 2, 3, 4, 5].map((v) => {
      const s = document.createElement("span");
      s.className = "star";
      s.textContent = "★";
      s.dataset.val = String(v);
      s.setAttribute("role", "button");
      s.setAttribute("aria-label", `${v} — ${this.RUBRIC[v]}`);
      wrap.appendChild(s);
      return s;
    });
    wrap.appendChild(hint);

    const paint = (v) => {
      stars.forEach((s) => s.classList.toggle("active", +s.dataset.val <= v));
      hint.textContent = v ? `${v} — ${this.RUBRIC[v]}` : "";
    };
    stars.forEach((s) => {
      const v = +s.dataset.val;
      s.addEventListener("mouseenter", () => paint(v));
      s.addEventListener("mouseleave", () => paint(current()));
      s.addEventListener("click", () => {
        if (window.Signals) window.Signals.confidence = v;
        // Keep the original <select> in sync: it stays in the DOM (hidden) so anything
        // that reads it by id keeps working.
        sel.value = String(v);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        paint(v);
      });
    });

    sel.dataset.starred = "1";
    sel.style.display = "none";
    sel.parentNode.insertBefore(wrap, sel);
    paint(current());
    this._paintSignalStars = paint;
  },

  /** Let other code (e.g. a 1–5 hotkey) drive the widget. */
  setSignalConfidence(v) {
    v = Math.max(1, Math.min(5, +v || 3));
    if (window.Signals) window.Signals.confidence = v;
    const sel = document.getElementById("signal-confidence");
    if (sel) sel.value = String(v);
    if (this._paintSignalStars) this._paintSignalStars(v);
  },
};

document.addEventListener("DOMContentLoaded", () => {
  // After AppState.init() so the tab buttons other modules add already exist.
  setTimeout(() => PanelUI.init(), 0);
});
window.PanelUI = PanelUI;
