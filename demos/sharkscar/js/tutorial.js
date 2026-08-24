/**
 * tutorial.js — guided tours, one per annotation UI.
 *
 * The model: **the first tour is the site; every other tour is a task.**
 *
 * A new labeler gets `overview` once, and it teaches only the things that are true no
 * matter what they were assigned — where the work list is, where the annotation surface
 * is, how the right rail behaves, how to get help. It deliberately teaches no annotation
 * mechanics, because at first login we do not yet know whether this person will be
 * placing keypoints, boxing scars, or drawing on a spectrogram.
 *
 * Each annotation UI then teaches itself the first time the labeler actually faces it.
 * The trigger is `taskEntered(task)`, called by `panel_ui.js` — which already resolves
 * "which annotation UI is in front of me" from the loaded data. One source of truth for
 * that question, rather than a `_hasTriggeredXTutorial` flag at every load path.
 *
 * Why that matters and is not just tidier: the old triggers fired on *proxy* events
 * ("a video was selected" ⇒ show the scar form tour). Since the panel rework, the scars
 * task is hidden entirely for an image assignment — so the proxy fires a tour whose every
 * target is `display:none`, and an element that exists but is not rendered measures 0×0,
 * putting the spotlight in the top-left corner over nothing. `_isUsable()` below is the
 * guard for that whole class of failure: a step whose target is not on screen is skipped,
 * never spotlighted at the origin.
 */
const Tutorial = (() => {
  // ── Tours ───────────────────────────────────────────────────────────────

  // Keys are stable and load-bearing in two places: `users.tutorial_states` in the
  // database, and the `Tutorial.showSingle('…')` info icons in index.html. Rename one
  // and you silently re-show a completed tour, or break an "i" button.
  const TUTORIALS = {
    // ═══ The site tour. First login. No annotation mechanics — see the header. ═══
    overview: [
      {
        key: "welcome",
        target: null,
        title: "Welcome",
        text: "This is where the lab annotates its field data. This quick tour covers the workspace itself, about a minute.\n\nHow to do each kind of annotation is taught separately, the first time you open one, so you learn it with the real thing in front of you.",
        btnText: "Show me around",
      },
      {
        key: "assignments",
        target: "#tab-videos",
        title: "Your queue",
        text: "Your assigned work lands here. Click a card to load it.\n\nIf you cannot annotate a video, press \"Can't annotate this\" and pick a reason. You move on. Completed keeps finished work and has its own search.",
        position: "right",
      },
      {
        key: "progress",
        target: "#progress-strip",
        title: "Your progress",
        text: "These bars track you against the semester goals. They update the moment a save lands, so you always know where you're at.",
        position: "bottom",
      },
      {
        key: "workspace",
        target: "#canvas-wrap",
        title: "The annotation surface",
        text: "This is where you work. Scroll to zoom, drag to pan, and press 0 to fit.\n\nFor a clip, ← and → step one frame and Space plays or pauses.",
        position: "top",
      },
      {
        key: "tools",
        target: "#canvas-tools",
        title: "Always-on tools",
        text: "Undo and Reset sit with the canvas, whatever you are working on. Undo goes back many steps, so it is safe to try something.",
        position: "top",
      },
      {
        key: "task-panel",
        target: ".panel-right",
        title: "The task panel",
        text: "The right side is where you record your metadata, and where each task lives: pose keypoints, bounding boxes, and scar details. It shows only what applies to what you loaded.",
        position: "left",
      },
      {
        key: "hide-left",
        target: "#btn-hide-left",
        title: "More room",
        text: "Hides the work list so the annotation surface gets the full width. Useful on a laptop, or any time you are zoomed in on something small.",
        position: "bottom",
      },
      {
        key: "shortcuts",
        target: "#btn-shortcuts-help",
        title: "Help, any time",
        text: "Every keyboard shortcut lives behind this button, and so does a Replay button for this tour and every task tour, in case you want one again later.\n\nPick something from your list to start; the right tour will meet you there.",
        position: "bottom",
        btnText: "Start working",
      },
    ],

    // ═══ Task: pose / morphometrics. Fires on first entry to the pose task. ═══
    pose: [
      {
        key: "p-welcome",
        target: null,
        title: "Pose measurements",
        text: "Welcome to Pose measurements, your old keypoint annotator with a new interface.\n\nThe 16 points you place become the length and fin measurements, so where you put each one is the whole value.",
        btnText: "Show me",
      },
      {
        key: "p-body",
        target: "#tool-bbox",
        title: "Box the body",
        text: "Press B, then drag a box around the whole animal, snout to tail tip, including fins.",
        position: "top",
      },
      {
        key: "p-keypoint",
        target: "#tool-keypoint",
        title: "Place the skeleton",
        text: "Press K. Click the snout tip, then the caudal notch, and the full 16-point skeleton is fitted for you from those two anchors.\n\nThen drag any point to correct it. Shift+drag moves the whole skeleton at once.",
        position: "right",
      },
      {
        key: "p-states",
        target: "#kp-section-header",
        title: "Say what you cannot see",
        text: "A point you cannot see honestly is still data. Guessing is not.\n\n• Visible: click to place\n• Occluded, position known: Alt+click, or press O\n• Outside the frame: press X or Tab to skip it\n\nRight-click a placed point to cycle its state. The counter here tracks how many of the 16 are done.",
        position: "left",
      },
      {
        key: "p-enhance",
        target: ".enhance-bar",
        title: "When the water is murky",
        text: "Brightness and contrast are display-only. They change what you can see, never the stored frame. Reset Image puts it back.",
        position: "top",
      },
      {
        key: "p-save",
        target: "#btn-save-and-next",
        title: "Save",
        text: "S saves and moves you on. Your work is also auto-saved every few minutes, and you will be warned before leaving with anything unsaved.",
        position: "left",
        btnText: "Start annotating",
      },
    ],

    // ═══ Task: scars. Fires on first entry to the scars task. ═══
    scar_form: [
      {
        key: "sf-welcome",
        target: null,
        title: "Scar classification",
        text: "Welcome to Scar classification, your old scar annotator with a new interface.",
        btnText: "Show me",
      },
      {
        key: "sf-intro",
        target: "#scar-form-section",
        title: "Form first, then the box",
        text: "Fill the form first, then draw the box. The box is what attaches your description to a place on the animal.\n\nOne scar at a time, and add as many as the frame shows.",
        position: "left",
      },
      {
        key: "sf-type",
        target: "#scar-type",
        title: "Type",
        text: "What made the mark: bite, grab, scratch, cookie, gear, prop. Copepods is new: parasites, not a wound, but still its own type. If nothing fits, use Other with a note.",
        position: "left",
      },
      {
        key: "sf-confidence",
        target: "#confidence-stars",
        title: "Confidence",
        text: "How sure are you, 1-5, or just press the number key.\n\nBe honest. Consensus weighs these, so a truthful 2 helps the dataset and an inflated 4 quietly damages it.",
        position: "left",
      },
      {
        key: "sf-side",
        target: "#scar-side-group",
        title: "Side",
        text: "Left or right is from the shark's view, not yours. If it swims away, picture yourself riding it (do not actually ride a shark).",
        position: "left",
      },
      {
        key: "sf-zone",
        target: "#zone-diagram",
        title: "Body zone",
        text: "Click where the scar sits on the diagram. Zones 1-9 run head to peduncle, plus D dorsal, P pectoral, T tail.\n\nZone plus side is what consensus matches on, so a neighboring zone reads as a different scar.",
        position: "left",
      },
      {
        key: "sf-color",
        target: "#color-group",
        title: "Color",
        text: "Pink means fresh or healing, white means healed, plus black, gray, or other. Color is how age is estimated later.",
        position: "left",
      },
      {
        key: "sf-notes",
        target: "#scar-notes",
        title: "Notes",
        text: "Anything the fields cannot hold: overlapping marks, an unusual shape, glare over part of the scar, uncertainty about what you are looking at.",
        position: "left",
      },
      {
        key: "sf-add",
        target: "#scar-arm-hint",
        title: "Draw the box",
        text: "As soon as the fields above are filled in, the canvas switches to drawing mode on its own. Draw a tight box around just that scar. Tight boxes are what make this usable as training data.\n\nEsc cancels if you picked the wrong spot.",
        position: "top",
      },
      {
        key: "sf-save",
        target: "#btn-save-and-next",
        title: "Save",
        text: "S saves this frame and moves you on. Finish Video marks the whole clip done and pulls your next assignment.",
        position: "left",
        btnText: "Start annotating",
      },
    ],

    // ═══ Task: signals (Stream F). Fires on first entry to the signals task. ═══
    signals: [
      {
        key: "sig-intro",
        target: "#signal-dock",
        title: "Signals",
        text: "Every recording from one deployment on one shared time axis. The playhead follows the video. Press \\ to fold it away.",
        position: "top",
        btnText: "Show me",
      },
      {
        key: "sig-deployment",
        target: "#signal-deployment",
        title: "Pick the deployment",
        text: "Everything below is scoped to this deployment. Its start time is the origin for every label you make.",
        position: "bottom",
      },
      {
        key: "sig-lanes",
        target: "#signal-lanes-btn",
        title: "Choose your lanes",
        text: "Show only the lanes you need. Wheel zooms, shift+wheel pans, Fit shows everything.",
        position: "bottom",
      },
      {
        key: "sig-term",
        target: "#signal-terms-head",
        title: "Pick what you are labeling",
        text: "Choose the vocabulary, then the term, before you draw.",
        position: "left",
      },
      {
        key: "sig-box",
        target: "#signal-mode-box",
        title: "Box a sound",
        text: "Press W, then drag on a waterfall lane to box a sound in time and frequency.\n\nThe edges are published coordinates, so box what you can defend.",
        position: "bottom",
      },
      {
        key: "sig-interval",
        target: "#signal-canvas",
        title: "Mark a stretch of time",
        text: "For a stretch with no particular frequency, press [ at the start and ] at the end. Twice in one place marks a point event.",
        position: "top",
      },
      {
        key: "sig-conf",
        target: ".signal-stars",
        title: "Confidence",
        text: "Same 1-5 scale as the scar form, and it matters more here: a spectrogram carries look-alikes, and a marked-uncertain label is what makes the ambiguous cases findable later.",
        position: "left",
      },
      {
        key: "sig-labels",
        target: "#signal-labels-head",
        title: "Your labels",
        text: "Everything you marked here. Click one to jump to it.\n\nYou see yours, not other labelers', so nobody is anchored by someone else's call.",
        position: "left",
      },
      {
        key: "sig-clock",
        target: null,
        title: "One thing worth knowing",
        text: "Labels are stored as seconds on the deployment clock, never frame numbers. That is what makes the video, hydrophone and tag line up.",
        btnText: "Start labeling",
      },
    ],

    // ═══ The fed mission. Fires the first time the queue takes over the left panel,
    //     which is the first moment a labeler is given work instead of choosing it.
    //     Uses surfaceShown, not taskEntered: the queue appears on its own schedule
    //     (only where mlops.datasets is on and a spec is active), so it cannot be
    //     taught inside a tour somebody took on their first login. ═══
    // ═══ Stream H — 3D lift & volumetrics. Fires on first arrival at the 3D task.
    //     Not counted by db_gamification._tutorial_steps: the feature ships off, and
    //     counting it would make onboarding uncompletable wherever it stays off. ═══
    pose3d: [
      {
        key: "p3d-welcome",
        target: null,
        title: "3D body model",
        text: "Welcome to 3D, a new task on the footage you already know.\n\nThe outline you draw is what the 3D body model is fitted against, so the fit is only as good as your tracing.",
        btnText: "Show me",
      },
      {
        key: "p3d-view",
        target: "#pose3d-view-head",
        title: "Which way is the shark facing?",
        text: "Say which side faces the camera before anything else.\n\n\"Lateral left\" means you can see the shark's OWN left flank, not that it is pointing left on your screen. When the shark is upright those happen to be the same thing; when it rolls they are not, which is exactly why the question is worth asking.\n\nThis is not bookkeeping: a side-on view shows the animal's height and tells you nothing about its width. The view you pick decides which measurements the app will let you take.",
        position: "left",
        btnText: "Got it",
      },
      {
        key: "p3d-part",
        target: "#pose3d-part-head",
        title: "Whole animal, or body only?",
        text: "Trace the WHOLE animal, fins and all, for the 3D fit. Fins are what tell the model which way up the shark is; without them a shark is nearly a smooth tube and the fit can roll freely.\n\nThen trace BODY ONLY, fins excluded, if you are measuring width or height. A fin is thin: it adds a lot of outline and almost no bulk, so measuring across one would make the animal look far fatter than it is.",
        position: "left",
      },
      {
        key: "p3d-mask",
        target: "#pose3d-mask-head",
        title: "Outline the animal",
        text: "Click inside the shark and SAM2 proposes an outline. Paint or erase where it is wrong, then Accept or Corrected.\n\nThe 3D model is fitted by matching a rendered shape against this outline, so the outline IS the answer it is aiming at.",
        position: "left",
      },
      {
        key: "p3d-reject",
        target: "#pose3d-reject",
        title: "Reject is an answer too",
        text: "Reject a frame you cannot use: too turbid, half out of shot, the wrong animal. Say why.\n\nThat is data, not a skip. \"The segmenter failed here\" is exactly what makes the next segmenter better.",
        position: "left",
      },
      {
        key: "p3d-scale",
        target: "#pose3d-measure-head",
        title: "Give it a real-world size",
        text: "Pixels have no scale. Mark something of known length: paired lasers, a tag, a cage bar. Type its length in meters.\n\nPrefer something ON the animal. A referent at a different distance is magnified differently by the water, so it measures its own depth, not the shark's.",
        position: "left",
      },
      {
        key: "p3d-chords",
        target: "#pose3d-width",
        title: "Width and height",
        text: "Draw the body axis, then measure across the body wherever its shape changes.\n\nVolume is built from cross-sections, and a cross-section needs both a width and a height. One view only ever gives you one of them, which is why the button for the other is grayed out.",
        position: "left",
      },
    ],

    mission: [
      {
        key: "mis-intro",
        target: "#video-list .video-item",
        title: "The system picks your work",
        text: "You get one card at a time: what it is, what to do to it, and the line saying why it was chosen.\n\nIf it is unusable, say so with \"Can't annotate this\" rather than forcing a label.",
        position: "right",
        btnText: "Next",
      },
      {
        key: "mis-practice",
        target: "#wq-mission",
        title: "First few are practice",
        text: "Your lab lead checks them before the rest unlocks. Feedback shows up here.",
        position: "right",
        btnText: "Start",
      },
    ],

    // ═══ The F3 review surface. Fires the first time it actually appears — which is
    //     only once a consensus run exists and the server lets this labeler read it. ═══
    signals_review: [
      {
        key: "rev-intro",
        target: "#signal-review-head",
        title: "Where you and the others differ",
        text: "Once enough people label this deployment, their marks are matched into events.",
        position: "left",
        btnText: "Show me",
      },
      {
        key: "rev-kappa",
        target: ".sr-agree",
        title: "How well the group agrees",
        text: "κ is agreement corrected for luck. \"Not defined\" is not a bad score; it needs two codes in play.\n\nIt measures agreement, never coverage: an event everyone missed is not in it. Only gold catches that.",
        position: "left",
      },
      {
        key: "rev-states",
        target: ".sr-chips",
        title: "What happened to each event",
        text: "Confirmed and probable are settled. Spend your time on Disputed (same event, different name) and Solo (only one person saw it). Disputed is listed first.",
        position: "left",
      },
      {
        key: "rev-jump",
        target: ".sr-list",
        title: "Go and look",
        text: "Click any event to frame it in the timeline and move the playhead onto it, so you can judge the disagreement against the actual signal rather than against a row in a list.\n\nThe colored band along the time ruler shows the same states across the whole deployment.",
        position: "left",
        btnText: "Got it",
      },
    ],

    // ═══ In-task nudge, not a first-face tour: offered after a few manual scars. ═══
    follow_scar: [
      {
        key: "follow-intro",
        target: "#tracks-panel",
        title: "Stop redrawing the same scar",
        text: "You have now boxed several scars by hand. If a scar stays visible across the clip, you can draw it once and have the app follow it, then you only check the result.",
        position: "left",
        btnText: "Show me",
      },
      {
        key: "follow-button",
        target: "#btn-track-scar",
        title: "Follow this scar",
        text: "Draw one tight box on a clear, well-lit frame, then click here. The scar is tracked across the clip and captured on every frame it appears in.",
        position: "left",
      },
      {
        key: "follow-verify",
        target: "#tracks-list",
        title: "Check the result",
        text: "Each followed scar shows how many frames it captured. Open it to confirm type, zone, side, and color once, instead of re-entering them frame after frame.",
        position: "left",
        btnText: "Got it",
      },
    ],
  };

  // Tours that a task can trigger, and the label used on the replay buttons.
  const TASK_TOURS = {
    pose: { name: "pose", label: "Pose" },
    scars: { name: "scar_form", label: "Scars" },
    signals: { name: "signals", label: "Signals" },
    pose3d: { name: "pose3d", label: "3D" },
  };

  // Every tour is replayable. The five that fire on entering a task are only
  // half of them: `mission`, `follow_scar` and `signals_review` fire on their
  // own trigger (arriving at a fed queue, boxing a third scar by hand, a review
  // panel appearing once somebody computed consensus). Those are the LEAST
  // likely to be caught first time, because they arrive unannounced in the
  // middle of doing something else, and until now they were the three you could
  // never see again.
  //
  // `visible` replaces a hardcoded `if (t.name === "signals")`: the rule is "do
  // not offer a tour of a UI that is not there", and that rule applies to five
  // tours, not one. 3D had no gate at all and offered its tour on installs where
  // pose3d is off, which is the same defect the signals check was written to
  // prevent. Absent predicate means always offered.
  const REPLAY_TOURS = [
    { name: "overview",       label: "Site" },
    { name: "mission",        label: "Queue",       visible: () => !!(window.WorkQueue && window.WorkQueue.enabled) },
    { name: "pose",           label: "Pose" },
    { name: "scar_form",      label: "Scars" },
    { name: "follow_scar",    label: "Follow scar", visible: () => !!(window.Tracks && window.Tracks.available) },
    { name: "signals",        label: "Signals",     visible: () => !!(window.Signals && window.Signals.available) },
    { name: "signals_review", label: "Review",      visible: () => !!(window.Signals && window.Signals.available) },
    { name: "pose3d",         label: "3D",          visible: () => !!(window.Pose3D && window.Pose3D.health && window.Pose3D.health.ok) },
  ];

  /**
   * Put the UI into the state the tour describes, before it starts.
   *
   * The signals tour teaches gestures you make *on* the timeline, and the dock ships
   * collapsed. Explaining "press [ where it starts" over a folded-away strip teaches
   * nothing, and the visibility guard would skip those steps entirely rather than fail
   * loudly — so open it first.
   */
  const SETUP = {
    signals() {
      const dock = document.getElementById("signal-dock");
      const toggle = document.getElementById("signal-dock-toggle");
      if (dock && toggle && !dock.classList.contains("expanded")) toggle.click();
    },
  };

  let _currentStep = 0;
  let _currentTutorialName = null;
  let _currentSteps = [];
  let _overlay = null;
  let _spotlight = null;
  let _tooltip = null;
  let _singleMode = false;
  let _replaying = false;      // a replay must not re-write completion state
  let _pendingTask = null;     // a task entered while another tour was on screen
  let _pendingSurface = null;  // a conditional surface that appeared while one was on screen
  let _shownAnyStep = false;   // did the labeler actually SEE anything this run?
  const _firedThisSession = new Set();

  // ── Tour lifecycle ──────────────────────────────────────────────────────

  /** Start a named tour. No-op if unknown, or if a tour is already on screen. */
  function start(name, opts) {
    if (!TUTORIALS[name]) return false;
    if (_overlay) return false;
    _singleMode = false;
    _replaying = !!(opts && opts.replay);
    _currentTutorialName = name;
    _currentSteps = TUTORIALS[name];
    _currentStep = 0;
    _shownAnyStep = false;
    if (SETUP[name]) {
      try { SETUP[name](); } catch (e) { /* a tour must still run if setup fails */ }
    }
    _createElements();
    // Rendered synchronously, never inside requestAnimationFrame: rAF is throttled to
    // nothing in a background tab, and a tour whose text never paints leaves a black
    // overlay with no visible way out. Position may refine a frame later; content may not.
    _showStep(0);
    return true;
  }

  /**
   * The labeler has just arrived at an annotation UI. Show its tour once.
   *
   * Called by panel_ui.js whenever the resolved task changes. Everything about "should
   * this fire" lives here rather than at the call site, so there is one place to reason
   * about it.
   */
  function taskEntered(task) {
    const tour = TASK_TOURS[task];
    if (!tour) return;
    if (_seen(tour.name) || _firedThisSession.has(tour.name)) return;

    // The site tour comes first. Stacking two overlays on a first-time labeler is worse
    // than either tour alone, so hold the task tour until the overview is out of the way.
    if (_overlay || !_seen("overview")) {
      _pendingTask = task;
      return;
    }
    // Let the panel finish switching before measuring anything in it — then re-check that
    // the labeler is still on this task. Without that, switching tabs inside the delay
    // starts a tour for the task they just left: its targets are now hidden, every step
    // skips, and the tour is spent. (Not recording completion for an unshown tour is the
    // other half of that fix; this is the half that stops it happening.)
    setTimeout(() => {
      if (_overlay) { _pendingTask = task; return; }
      if (_currentTaskOf() !== task) return;
      if (_seen(tour.name) || _firedThisSession.has(tour.name)) return;
      _firedThisSession.add(tour.name);
      start(tour.name);
    }, 450);
  }

  /** Which annotation task is on screen right now, per the panel's own tab state. */
  function _currentTaskOf() {
    const active = document.querySelector(".panel-right .panel-tabs .tab-btn.active");
    return (active && active.dataset.tab) || null;
  }

  /**
   * Fire a tour for a surface that appears conditionally, the first time it is really on
   * screen. Same contract as `taskEntered`, but keyed on the UI existing rather than on a
   * task being selected — the F3 review panel shows up only once consensus exists.
   */
  function surfaceShown(name) {
    if (!TUTORIALS[name]) return;
    if (_seen(name) || _firedThisSession.has(name)) return;
    // Never stack two overlays — but do NOT drop the tour on the floor. This used to
    // return, and the caller re-renders on its own schedule, so the one visit where the
    // surface first appeared was routinely the visit whose tour was discarded: the task
    // tour for the same deployment is typically still on screen at that moment.
    if (_overlay || !_seen("overview")) {
      _pendingSurface = name;
      return;
    }
    setTimeout(() => {
      if (_overlay) { _pendingSurface = name; return; }
      if (_seen(name) || _firedThisSession.has(name)) return;
      // The surface must still be there — it appears and disappears with the data.
      const first = TUTORIALS[name][0];
      if (first && first.target && !_isUsable(document.querySelector(first.target))) return;
      _firedThisSession.add(name);
      start(name);
    }, 600);
  }

  /** Replay a tour without touching completion state. */
  function replay(name) {
    if (_overlay) _finish();
    start(name, { replay: true });
  }

  function _seen(name) {
    const st = window.appState && window.appState.currentUser
      && window.appState.currentUser.tutorial_states;
    return !!(st && st[name]);
  }

  /** Show one step by key, for the "i" icons. Searches every tour. */
  function showSingle(key) {
    let found = null;
    for (const steps of Object.values(TUTORIALS)) {
      const idx = steps.findIndex(s => s.key === key);
      if (idx !== -1) { found = { steps, idx }; break; }
    }
    if (!found) return;
    if (_overlay) _finish();
    _singleMode = true;
    _replaying = false;
    _currentTutorialName = null;
    _currentSteps = found.steps;
    _currentStep = found.idx;
    _createElements();
    _showStep(found.idx);
  }

  function _createElements() {
    if (_overlay) _overlay.remove();

    _overlay = document.createElement("div");
    _overlay.className = "tutorial-overlay";

    _spotlight = document.createElement("div");
    _spotlight.className = "tutorial-spotlight";

    _tooltip = document.createElement("div");
    _tooltip.className = "tutorial-tooltip";

    _overlay.appendChild(_spotlight);
    _overlay.appendChild(_tooltip);
    document.body.appendChild(_overlay);

    document.addEventListener("keydown", _onKey, true);
    window.addEventListener("resize", _reposition);
    // A tour survives the page moving under it: the left rail can be toggled, a panel
    // can scroll. Without this the spotlight stays where the element used to be.
    window.addEventListener("scroll", _reposition, true);
  }

  /**
   * Is this element actually on screen?
   *
   * Presence is not enough. The right rail hides whole tasks by `display:none`, and a
   * hidden element still answers querySelector while measuring 0×0 — which would park
   * the spotlight in the corner over nothing and describe something the labeler cannot
   * see. Steps that fail this are skipped.
   */
  function _isUsable(el) {
    if (!el || !el.isConnected) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function _showStep(idx) {
    _currentStep = idx;
    const step = _currentSteps[idx];
    if (!step) { _finish(); return; }
    const isLast = idx === _currentSteps.length - 1;

    // Only switch tabs to something the panel is actually offering. Clicking a tab that
    // the current task has hidden would put us on an invisible panel.
    if (step.activateTab) {
      const tabBtn = document.querySelector(`[data-tab="${step.activateTab}"]`);
      if (_isUsable(tabBtn)) tabBtn.click();
    }

    let el = null;
    if (step.target) {
      el = document.querySelector(step.target);
      if (!_isUsable(el)) {
        if (_singleMode) { _finish(); return; }
        if (!isLast) { _showStep(idx + 1); return; }
        _finish();
        return;
      }
    }

    _shownAnyStep = true;
    _renderTooltip(step, idx, isLast);

    if (!el) {
      _spotlight.style.display = "none";
      _tooltip.style.left = "50%";
      _tooltip.style.top = "50%";
      _tooltip.style.transform = "translate(-50%, -50%)";
      _tooltip.style.removeProperty("right");
      _tooltip.style.removeProperty("bottom");
    } else {
      _spotlight.style.display = "block";
      _tooltip.style.transform = "";
      _scrollAndPosition(el, step.position || "bottom");
    }
  }

  function _renderTooltip(step, idx, isLast) {
    // The fallback branch escaped & < > " but NOT ', so it was also a weaker
    // escape than the shared one it was standing in for.
    const esc = escapeHtml;
    const safeTitle = esc(step.title);
    const textHtml = esc(step.text).replace(/\n/g, "<br>");

    if (_singleMode) {
      _tooltip.innerHTML = `
        <h4>${safeTitle}</h4>
        <p>${textHtml}</p>
        <div class="tutorial-footer">
          <span></span>
          <button class="tutorial-btn-next" id="tutorial-close">Close</button>
        </div>
      `;
      document.getElementById("tutorial-close").addEventListener("click", _finish);
      return;
    }

    const safeBtnText = esc(step.btnText || (isLast ? "Finish" : "Next"));
    const backable = idx > 0;
    _tooltip.innerHTML = `
      <h4>${safeTitle}</h4>
      <p>${textHtml}</p>
      <div class="tutorial-footer">
        <span class="tutorial-steps">Step ${idx + 1} of ${_currentSteps.length}</span>
        <div>
          <button class="tutorial-btn-skip" id="tutorial-skip">Skip</button>
          ${backable ? '<button class="tutorial-btn-back" id="tutorial-back">Back</button>' : ""}
          <button class="tutorial-btn-next" id="tutorial-next">${safeBtnText}</button>
        </div>
      </div>
    `;
    document.getElementById("tutorial-skip").addEventListener("click", _finish);
    const back = document.getElementById("tutorial-back");
    if (back) back.addEventListener("click", () => _stepBack());
    document.getElementById("tutorial-next").addEventListener("click", () => {
      if (isLast) _finish();
      else _showStep(idx + 1);
    });
  }

  /** Walk backwards past any step whose target has since gone off screen. */
  function _stepBack() {
    for (let i = _currentStep - 1; i >= 0; i--) {
      const s = _currentSteps[i];
      if (!s.target || _isUsable(document.querySelector(s.target))) { _showStep(i); return; }
    }
  }

  function _onKey(e) {
    if (!_overlay) return;
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); _finish(); return; }
    if (_singleMode) return;
    if (e.key === "ArrowRight" || e.key === "Enter") {
      e.stopPropagation(); e.preventDefault();
      if (_currentStep >= _currentSteps.length - 1) _finish();
      else _showStep(_currentStep + 1);
    } else if (e.key === "ArrowLeft") {
      e.stopPropagation(); e.preventDefault();
      _stepBack();
    }
  }

  function _reposition() {
    if (!_overlay) return;
    const step = _currentSteps[_currentStep];
    if (!step || !step.target) return;
    const el = document.querySelector(step.target);
    if (_isUsable(el)) _positionSpotlightAndTooltip(el, step.position || "bottom");
  }

  function _positionSpotlightAndTooltip(el, position) {
    const rect = el.getBoundingClientRect();
    const pad = 8;
    _spotlight.style.left = (rect.left - pad) + "px";
    _spotlight.style.top = (rect.top - pad) + "px";
    _spotlight.style.width = (rect.width + pad * 2) + "px";
    _spotlight.style.height = (rect.height + pad * 2) + "px";
    _positionTooltip(rect, position);
  }

  function _scrollAndPosition(el, position) {
    _scrollToElement(el);
    // Place it now from the geometry we can already read, then refine once the scroll has
    // painted. The refinement is the nicety; the synchronous pass is what guarantees the
    // spotlight is never left sitting at the origin if rAF is throttled.
    _positionSpotlightAndTooltip(el, position);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!_overlay) return; // closed during the scroll
        _positionSpotlightAndTooltip(el, position);
      });
    });
  }

  function _scrollToElement(el) {
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const style = getComputedStyle(parent);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) {
        const parentRect = parent.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        if (elRect.bottom > parentRect.bottom) {
          parent.scrollBy({ top: elRect.bottom - parentRect.bottom + 40, behavior: "instant" });
        }
        if (elRect.top < parentRect.top) {
          parent.scrollBy({ top: elRect.top - parentRect.top - 40, behavior: "instant" });
        }
        return;
      }
      parent = parent.parentElement;
    }
    el.scrollIntoView({ behavior: "instant", block: "nearest" });
  }

  function _positionTooltip(rect, position) {
    const gap = 16;
    _tooltip.style.left = "";
    _tooltip.style.top = "";
    _tooltip.style.right = "";
    _tooltip.style.bottom = "";
    _tooltip.style.transform = "";

    switch (position) {
      case "right":
        _tooltip.style.left = (rect.right + gap) + "px";
        _tooltip.style.top = rect.top + "px";
        break;
      case "left":
        _tooltip.style.right = (window.innerWidth - rect.left + gap) + "px";
        _tooltip.style.top = rect.top + "px";
        break;
      case "bottom":
        _tooltip.style.left = rect.left + "px";
        _tooltip.style.top = (rect.bottom + gap) + "px";
        break;
      case "top":
        _tooltip.style.left = rect.left + "px";
        _tooltip.style.bottom = (window.innerHeight - rect.top + gap) + "px";
        break;
    }

    // Clamp now, then again after paint in case the tooltip reflowed. Same reason as
    // above: a tooltip half off-screen is a tour nobody can finish.
    _clampTooltip();
    requestAnimationFrame(_clampTooltip);
  }

  function _clampTooltip() {
    if (!_tooltip) return;
    const tr = _tooltip.getBoundingClientRect();
    if (tr.right > window.innerWidth - 16) {
      _tooltip.style.left = Math.max(16, window.innerWidth - tr.width - 16) + "px";
      _tooltip.style.right = "";
    }
    if (tr.bottom > window.innerHeight - 16) {
      _tooltip.style.top = Math.max(16, window.innerHeight - tr.height - 16) + "px";
      _tooltip.style.bottom = "";
    }
    if (tr.top < 16) {
      _tooltip.style.top = "16px";
      _tooltip.style.bottom = "";
    }
    if (tr.left < 16) {
      _tooltip.style.left = "16px";
      _tooltip.style.right = "";
    }
  }

  function _finish() {
    if (_overlay) {
      _overlay.remove();
      _overlay = null;
      _spotlight = null;
      _tooltip = null;
      document.removeEventListener("keydown", _onKey, true);
      window.removeEventListener("resize", _reposition);
      window.removeEventListener("scroll", _reposition, true);
    }
    // Only a real first run records completion. A replay is the labeler asking to see it
    // again, and an "i" popup is not a tour at all.
    //
    // `_shownAnyStep` is the third condition, and it is the one that bites: every step
    // whose target is off-screen is skipped, so a tour can walk its whole list, display
    // nothing at all, and reach here — where it would be marked permanently complete and
    // never offered again. That is reachable today: the scars tour targets fields inside
    // `#scar-form-section`, which `tracks.js` hides in its triage layout, and the review
    // tour targets a section a labeler may have collapsed. Silently burning somebody's
    // onboarding is worse than showing it late.
    const finished = _currentTutorialName;
    if (!_singleMode && !_replaying && _shownAnyStep && finished) {
      fetch("/api/tutorial/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        credentials: "same-origin",
        body: JSON.stringify({ name: finished }),
      }).catch(() => {});
      if (window.appState && window.appState.currentUser && window.appState.currentUser.tutorial_states) {
        window.appState.currentUser.tutorial_states[finished] = true;
      }
    }
    // A tour that showed nothing is not "seen" this session either — otherwise
    // `_firedThisSession` would suppress the retry that not recording completion enables.
    if (!_shownAnyStep && finished) _firedThisSession.delete(finished);

    _currentTutorialName = null;
    _currentSteps = [];
    _singleMode = false;
    _replaying = false;
    _shownAnyStep = false;

    // A task the labeler reached while the site tour was up still deserves its tour, and
    // so does a surface that appeared behind it. Task first: it is the wider context.
    if (_pendingTask) {
      const task = _pendingTask;
      _pendingTask = null;
      setTimeout(() => taskEntered(task), 300);
    } else if (_pendingSurface) {
      const name = _pendingSurface;
      _pendingSurface = null;
      setTimeout(() => surfaceShown(name), 300);
    }
  }

  function isActive() {
    return _overlay !== null;
  }

  // ── Replay controls, injected into the shortcuts modal ──────────────────

  /**
   * Once a tour is done there is otherwise no way back to it, which makes the whole
   * system a one-shot. The shortcuts modal is where people already look for "how does
   * this work", so the replay buttons live there.
   */
  function _mountReplay() {
    const modal = document.getElementById("shortcuts-modal");
    if (!modal) return;
    const closeBtn = document.getElementById("close-shortcuts-modal");
    if (!closeBtn) return;

    // REBUILT on every call rather than mounted once. Each `visible` predicate
    // reads a flag some other module sets after an awaited health check, and
    // this used to run on a 1200ms timer whose own comment said it was waiting
    // for `Signals.available` to settle. signals_review.js allows that same
    // flag FIFTEEN seconds on a cold worker, so the timer was a guess that
    // silently lost a button whenever it lost the race. Evaluating on open
    // costs one pass over eight entries and cannot be early.
    let wrap = document.getElementById("tutorial-replay");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "tutorial-replay";
      wrap.className = "tutorial-replay";
      closeBtn.parentNode.insertBefore(wrap, closeBtn);
    }
    wrap.textContent = "";

    const label = document.createElement("span");
    label.className = "tutorial-replay-label";
    label.textContent = "Replay a tour:";
    wrap.appendChild(label);

    for (const t of REPLAY_TOURS) {
      if (t.visible && !t.visible()) continue;
      const b = document.createElement("button");
      b.className = "btn btn-sm btn-ghost";
      b.textContent = t.label;
      b.addEventListener("click", () => {
        modal.classList.add("hidden");
        setTimeout(() => replay(t.name), 120);
      });
      wrap.appendChild(b);
    }
  }

  /**
   * The "i" icons, bound in JS rather than inline.
   *
   * They used to be `onclick="Tutorial.showSingle('p-intro')"`, and the app's CSP is
   * `script-src 'self'` with no 'unsafe-inline', which blocks inline event handlers
   * outright. So every one of them was dead in the browser: clicking an "i" logged a
   * CSP violation and did nothing. It was invisible because the icons still rendered
   * and test_tutorial only checked that the step NAMES were valid, never that the
   * handler could fire.
   *
   * Delegated from document, so icons rendered later by signals.js, gamification.js
   * or the work queue are covered without each module wiring its own listener.
   */
  function _bindInfoIcons() {
    document.addEventListener("click", (e) => {
      const icon = e.target.closest("[data-tutorial-step]");
      if (!icon) return;
      e.preventDefault?.();
      e.stopPropagation?.();    // a section heading is also a collapse toggle
      showSingle(icon.getAttribute("data-tutorial-step"));
    });
  }

  // Bound NOW, not on DOMContentLoaded. The listener is delegated from `document`,
  // so it needs no DOM to exist yet — and waiting for the event means the icons are
  // dead whenever this script is loaded after the document is already parsed
  // (defer/async, injection, a test harness). That is precisely the failure the
  // inline-onclick version had: an icon that renders and does nothing.
  _bindInfoIcons();

  // Refresh the row whenever the shortcuts modal is opened, which is the only
  // moment it is looked at. Delegated from `document` for the same reason the
  // info icons are: the button may not exist yet when this file runs.
  document.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest("#btn-shortcuts-help")) {
      setTimeout(_mountReplay, 0);
    }
  });

  // Still build it once up front, so the row is there for anything that opens
  // the modal without going through that button (Esc-and-back, a test harness).
  document.addEventListener("DOMContentLoaded", () => setTimeout(_mountReplay, 1200));

  return { start, replay, taskEntered, surfaceShown, showSingle, isActive, TASK_TOURS, REPLAY_TOURS };
})();

window.Tutorial = Tutorial;
