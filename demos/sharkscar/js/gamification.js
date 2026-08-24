"use strict";

/**
 * Stream C — Gamification (Phase C0)
 *
 * Surfaces signals that already exist, accurately:
 *   1. De-hardcodes the top progress strip (real per-user scar quota + pose goal).
 *   2. Renders a private, non-competitive "My Stats" card in the left panel
 *      (quota progress, experience level, and — for the lab — existing quality).
 *
 * No competition, no leaderboard, no new scoring. Reads GET /api/me/stats only.
 * Self-contained: builds its DOM at runtime (no index.html body edits) and never
 * throws into the annotation flow — on any failure the progress bar simply keeps
 * its built-in 150/50 fallback. Invoked from AppState.init() once window.appState
 * exists; gamification.enabled (from the payload) gates the panel.
 */
const Gamification = {
  stats: null,
  teamGoal: null,
  trust: null,

  async init() {
    const stats = await this._fetchStats();
    if (!stats) return; // network/auth failure -> bar keeps its built-in defaults
    this.stats = stats;

    // (1) Make the existing progress strip honest — always, even when the panel
    // is disabled. _updateProgressBar reads these goals at render time, so setting
    // them + one re-render fixes every subsequent render regardless of load order.
    const app = window.appState;
    if (app && stats.progress) {
      app._scarGoal = stats.progress.scar_goal;
      app._poseGoal = stats.progress.pose_goal;
      if (typeof app._updateProgressBar === "function") app._updateProgressBar();
    }

    // (2) The personal-stats panel is gated by gamification.enabled.
    if (stats.enabled) {
      this.teamGoal = await this._fetchTeamGoal(); // C3 cooperative goal (may be null/disabled)
      // Gated on the SERVER saying the feature is on, never on config read in JS —
      // the same contract /api/tracks/health established. Absent route ⇒ no link.
      this.suggest = await this._fetchSuggestHealth();
      // C4 — "your standing" only matters under the public profile; in lab we
      // never fetch it, so the lab panel is byte-identical to before C4.
      if (stats.profile === "public") this.trust = await this._fetchTrust();
      this._renderPanel(stats);
    }
  },

  async _fetchTeamGoal() {
    try {
      const res = await fetch("/api/team/goal", { credentials: "same-origin" });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async _fetchTrust() {
    try {
      const res = await fetch("/api/me/trust", { credentials: "same-origin" });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async _fetchStats() {
    // Plain fetch (not the API wrapper) so a 401/blocked endpoint can't trigger
    // the wrapper's auto-redirect — this enhancement must never disrupt annotating.
    try {
      const res = await fetch("/api/me/stats", { credentials: "same-origin" });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  _renderPanel(stats) {
    const host = document.querySelector(".panel-left");
    if (!host) return;
    document.getElementById("gamification-panel")?.remove(); // idempotent re-render

    const panel = document.createElement("section");
    panel.id = "gamification-panel";
    panel.className = "gami-panel";

    // Opt ONLY this heading into PanelUI's collapsible-section discovery. The
    // sub-headings below (AGREEMENT, CALIBRATION, ACHIEVEMENTS, …) deliberately keep
    // `gami-section-label` alone: PanelUI treats any `.section-label` as a section
    // BOUNDARY, so tagging them too would stop MY STATS absorbing its own contents and
    // split the panel into nine sibling sections with an empty one on top.
    const head = this._sectionLabel("MY STATS");
    head.classList.add("section-label");
    panel.appendChild(head);
    // No progress meters here. The header strip (app.js _updateProgressBar,
    // #progress-strip) already draws "X / 150 scars" and "X / 50 poses" from the
    // same numbers — and step (1) above deliberately feeds it this payload's
    // goals so it is correct. Drawing them again a few hundred pixels away gave
    // the labeler one quantity twice from two independent renderers, and because
    // gamification ships OFF it would first have been seen by whoever turned it
    // on. One number, one place.
    if (stats.experience) panel.appendChild(this._experienceBlock(stats.experience));
    if (stats.quality) panel.appendChild(this._qualityBlock(stats.quality));
    if (stats.calibration && stats.calibration.enabled)
      panel.appendChild(this._calibrationBlock(stats.calibration));
    if (stats.achievements && stats.achievements.enabled)
      panel.appendChild(this._achievementsBlock(stats.achievements));
    if (stats.streak && stats.streak.enabled)
      panel.appendChild(this._streakBlock(stats.streak));
    if (stats.impact && stats.impact.enabled && stats.impact.cataloged_sharks > 0)
      panel.appendChild(this._impactBlock(stats.impact));
    if (stats.skill && stats.skill.enabled)
      panel.appendChild(this._skillBlock(stats.skill));
    if (this.teamGoal && this.teamGoal.enabled && this.teamGoal.goal)
      panel.appendChild(this._teamGoalBlock(this.teamGoal));
    if (this.trust && this.trust.enabled && this.trust.profile === "public")
      panel.appendChild(this._trustBlock(this.trust));

    host.insertBefore(panel, host.firstChild);

    // This panel is built after an async /api/me/stats fetch, so PanelUI.init() has
    // usually already walked the DOM and finished. Ask it to wrap this subtree now.
    // Optional-chained: gamification must degrade to a plain (uncollapsible) panel
    // wherever panel_ui.js is absent rather than throw and lose the stats entirely.
    window.PanelUI?.buildSectionsIn?.("#gamification-panel");
  },

  // ---- block builders (textContent only — no untrusted innerHTML) ----

  /** Explain something on hover, in a box we control.
   *
   *  `title=` was doing this job and it reads as broken: the browser waits about a
   *  second before showing anything, the text lands wherever the cursor is, and on
   *  a touchscreen it never appears at all. An explanation nobody sees is the same
   *  as no explanation, which is exactly what "the i does nothing" means.
   *
   *  Bound on focus as well as hover, so the keyboard reaches it, and the element
   *  keeps an aria-label so a screen reader gets the text regardless.
   */
  _tip(el, text) {
    if (!el || !text) return el;
    el.setAttribute("aria-label", text);
    el.classList.add("gami-has-tip");
    const show = () => {
      this._hideTip();
      const tip = document.createElement("div");
      tip.className = "gami-tip";
      tip.setAttribute("role", "tooltip");
      tip.textContent = text;
      document.body.appendChild(tip);
      const r = el.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      // Prefer above; flip below when there is no room. Clamp horizontally so a
      // chip at the right edge of a 158px rail does not push the box off-screen.
      const top = r.top - t.height - 6 >= 4 ? r.top - t.height - 6 : r.bottom + 6;
      const left = Math.max(6, Math.min(window.innerWidth - t.width - 6,
        r.left + r.width / 2 - t.width / 2));
      tip.style.top = `${Math.round(top)}px`;
      tip.style.left = `${Math.round(left)}px`;
      this._tipEl = tip;
    };
    el.addEventListener("mouseenter", show);
    el.addEventListener("focus", show);
    el.addEventListener("mouseleave", () => this._hideTip());
    el.addEventListener("blur", () => this._hideTip());
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    return el;
  },

  _hideTip() {
    if (this._tipEl) { this._tipEl.remove(); this._tipEl = null; }
  },

  /** Fold ONE block on its heading, without becoming a PanelUI section boundary.
   *
   *  Kept local because PanelUI's model is flat — it wraps each `.section-label` up
   *  to the next one — so a nested master plus children cannot come from it.
   */
  _bindBlockFold(wrap, label) {
    if (!wrap || !label) return;
    label.classList.add("gami-foldable");
    label.addEventListener("click", (e) => {
      if (e.target.closest(".info-icon")) return;   // the "i" explains, never folds
      const folded = wrap.classList.toggle("gami-folded");
      label.classList.toggle("gami-open", !folded);
      try {
        const k = "gami.fold." + (label.textContent || "").trim().slice(0, 24);
        folded ? localStorage.setItem(k, "1") : localStorage.removeItem(k);
      } catch (_) { /* private mode: folding still works, just does not persist */ }
    });
    try {
      const k = "gami.fold." + (label.textContent || "").trim().slice(0, 24);
      if (localStorage.getItem(k) === "1") wrap.classList.add("gami-folded");
    } catch (_) { /* ignore */ }
  },

  /** Section heading, with an optional "i" affordance carrying an explanation.
   *
   *  `gami-section-label` ONLY — deliberately not `section-label`. PanelUI treats
   *  every `.section-label` as a section BOUNDARY and wraps it up to the next one,
   *  so tagging these too split the panel into seven sibling sections: "MY STATS"
   *  folded the experience block and nothing else, and hiding the panel meant
   *  collapsing seven headers one at a time. Only the panel's own MY STATS heading
   *  wears `section-label`, which is what lets it absorb everything below it.
   *
   *  These still fold individually — `_bindBlockFold` gives them a local toggle
   *  that does not create a PanelUI boundary. Both behaviours, one master.
   */
  _sectionLabel(text, help) {
    const el = document.createElement("div");
    el.className = "gami-section-label";
    el.textContent = text;
    if (help) {
      const i = document.createElement("span");
      i.className = "info-icon gami-info";
      i.textContent = "i";
      el.appendChild(document.createTextNode(" "));
      el.appendChild(this._tip(i, help));
    }
    return el;
  },


  /** A labelled progress meter. The one definition.
   *
   * There were three: this, the badge "next up" row and the cooperative-goal
   * row — same elements, same class names, same percentage arithmetic, differing
   * only in an extra class, a trailing unit and whether the label carries a
   * tooltip. Those are arguments, not reasons to write the markup again.
   */
  _meter(label, count, goal, opts) {
    const o = opts || {};
    const g = Math.max(o.minGoal || 0, Number(goal) || 0);
    const c = Math.max(0, Number(count) || 0);
    const pct = g > 0 ? Math.min(100, Math.round((c / g) * 100)) : 0;

    const row = document.createElement("div");
    row.className = o.extraClass ? `gami-meter ${o.extraClass}` : "gami-meter";

    const head = document.createElement("div");
    head.className = "gami-meter-head";
    const name = document.createElement("span");
    name.textContent = label;
    if (o.tip) this._tip(name, o.tip);
    const val = document.createElement("span");
    val.className = "gami-meter-val";
    val.textContent = o.unit ? `${c} / ${g} ${o.unit}` : `${c} / ${g}`;
    head.appendChild(name);
    head.appendChild(val);

    const track = document.createElement("div");
    track.className = "gami-track";
    const fill = document.createElement("div");
    fill.className = "gami-fill";
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    row.appendChild(head);
    row.appendChild(track);
    return row;
  },

  _experienceBlock(x) {
    const wrap = document.createElement("div");
    wrap.className = "gami-block";

    const head = document.createElement("div");
    head.className = "gami-stat-head";
    const k = document.createElement("span");
    k.textContent = "Experience";
    const v = document.createElement("span");
    v.className = "gami-level";
    // The NUMBER stays in the head — the sub-line below renders "7 to Level 3" and
    // a name-only label would orphan it. The panel is ~158px wide, so
    // "Experience | Level 2 · Surf Line" wrapped mid-phrase; the name gets its own
    // line instead of being crammed alongside.
    v.textContent = x.is_expert ? "Expert" : `Level ${x.level}`;
    head.appendChild(k);
    head.appendChild(v);
    wrap.appendChild(head);

    const title = x.is_expert ? x.expert_title : x.level_title;
    if (title) {
      const nameLine = document.createElement("div");
      nameLine.className = "gami-level-name";
      nameLine.textContent = title;
      wrap.appendChild(nameLine);
    }

    const sub = document.createElement("div");
    sub.className = "gami-sub";
    const n = Number(x.annotation_count) || 0;
    if (x.is_expert) {
      sub.textContent = `${n} annotations`;
    } else if (x.next_level_at) {
      const toGo = Math.max(0, x.next_level_at - n);
      sub.textContent = `${n} annotations · ${toGo} to Level ${x.level + 1}`;
    } else {
      sub.textContent = `${n} annotations · max level`;
    }
    wrap.appendChild(sub);
    return wrap;
  },

  // Two renderings. Admins get the raw numbers they need to run the lab;
  // annotators get a qualitative band. The server decides which — the raw values
  // are never sent to a non-admin, so this is presentation, not the access control.
  BANDS: {
    in_step: "Your calls are in step with the group.",
    mostly_in_step: "Your calls mostly match the group.",
    building: "Still building agreement with the group — that's normal early on.",
  },

  _qualityBlock(q) {
    const wrap = document.createElement("div");
    wrap.className = "gami-block";
    const _lbl0 = this._sectionLabel("AGREEMENT", "How often your independent calls "
      + "match the group's consensus. It is never shown to anyone else, and it is not "
      + "a grade — early disagreement is expected while you learn the scar types.");
    wrap.appendChild(_lbl0);
    this._bindBlockFold(wrap, _lbl0);;

    const agree = document.createElement("div");
    agree.className = "gami-sub";

    if (q.raw) {
      // Admin view — the operational numbers.
      agree.textContent = q.consensus_agreement_rate == null
        ? "Agreement with consensus: not enough data yet"
        : `Agreement with consensus: ${Math.round(q.consensus_agreement_rate * 100)}%`;
      wrap.appendChild(agree);
      if (q.proficiency_weight != null) {
        const prof = document.createElement("div");
        prof.className = "gami-sub gami-muted";
        prof.textContent = `Proficiency weight: ${Math.round(q.proficiency_weight * 100)}%`;
        wrap.appendChild(prof);
      }
      return wrap;
    }

    agree.textContent = q.agreement_band
      ? (this.BANDS[q.agreement_band] || "")
      : "Not enough shared encounters yet to compare — keep annotating.";
    wrap.appendChild(agree);
    return wrap;
  },

  // C1 — blind-gold calibration feedback. Private, encouraging, never punitive:
  // we phrase it as agreements earned, never mistakes made, and never compare to
  // other annotators. Empty state invites rather than scolds.
  _calibrationBlock(c) {
    const wrap = document.createElement("div");
    wrap.className = "gami-block";
    const _lbl1 = this._sectionLabel("CALIBRATION");
    wrap.appendChild(_lbl1);
    this._bindBlockFold(wrap, _lbl1);;

    if (!c.has_data) {
      const empty = document.createElement("div");
      empty.className = "gami-sub";
      empty.textContent =
        "Blind calibration checks appear here as you verify tracks — none yet. Keep going!";
      wrap.appendChild(empty);
      return wrap;
    }

    const n = Math.max(0, Number(c.n_agreed) || 0);
    const m = Math.max(0, Number(c.n_checks) || 0);
    const headline = document.createElement("div");
    headline.className = "gami-sub gami-positive";
    headline.textContent = `You matched the expert answer on ${n} of ${m} hidden checks.`;
    wrap.appendChild(headline);

    if (c.qscore != null) {
      const score = document.createElement("div");
      score.className = "gami-sub gami-muted";
      score.textContent = `Calibration score: ${Math.round(c.qscore * 100)}%`;
      wrap.appendChild(score);
    }
    return wrap;
  },

  // C2 — achievement badges. Private, positive, non-competitive. Earned badges as
  // chips; up to 3 "next up" with progress to give a forward pull (not a checklist).
  _achievementsBlock(a) {
    const wrap = document.createElement("div");
    wrap.className = "gami-block";
    // panel_ui keys a section's remembered collapse state on its CONTAINER's id, so
    // an id-less block keys as "root:..." and could share state with any other
    // panel's section of the same name.
    wrap.id = "gami-achievements";
    const _lbl2 = this._sectionLabel("ACHIEVEMENTS",
      "Every badge you can earn, and what each one asks for. Hover any of them to "
      + "read it. They are private to you, nobody else sees them, and there is no "
      + "deadline on any of them.");
    wrap.appendChild(_lbl2);
    this._bindBlockFold(wrap, _lbl2);;

    const earned = Array.isArray(a.earned) ? a.earned : [];
    const locked = Array.isArray(a.locked) ? a.locked : [];
    const total = (a.counts && a.counts.total) || 0;

    // ONE board, earned and unearned together. Showing only what you already have
    // plus the three you are closest to left most of the set invisible, so there
    // was no way to find out what there is to aim for. A badge you cannot see is
    // not a goal.
    const chips = document.createElement("div");
    chips.className = "gami-chips";

    earned.forEach((b) => {
      const chip = document.createElement("span");
      chip.className = "gami-chip";
      chip.textContent = b.title || b.id;
      const when = b.unlocked_at ? ` Earned ${String(b.unlocked_at).slice(0, 10)}.` : "";
      chips.appendChild(this._tip(chip, `${b.desc || ""}${when}`));
    });

    locked.forEach((b) => {
      const chip = document.createElement("span");
      chip.className = "gami-chip gami-chip-locked";
      chip.textContent = b.title || b.id;
      const cur = Math.max(0, Number(b.cur) || 0);
      const target = Math.max(1, Number(b.target) || 1);
      const at = cur >= target ? " You have met this one; it unlocks on your next save."
                               : ` You are at ${cur} of ${target}.`;
      chips.appendChild(this._tip(chip, `${b.desc || ""}${at}`));
    });

    if (!chips.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "gami-sub";
      empty.textContent = "Badges unlock as you annotate and calibrate. None yet, so keep going.";
      wrap.appendChild(empty);
    } else {
      wrap.appendChild(chips);
      const count = document.createElement("div");
      count.className = "gami-sub gami-muted";
      count.textContent = `${earned.length} of ${total} earned`;
      wrap.appendChild(count);
    }

    const next = Array.isArray(a.next_up) ? a.next_up : [];
    if (next.length) {
      const _lbl3 = this._sectionLabel("CLOSEST",
        "The badges you are nearest to earning, with your progress toward each.");
      wrap.appendChild(_lbl3);
      this._bindBlockFold(wrap, _lbl3);;
      next.forEach((b) => wrap.appendChild(this._nextUpRow(b)));
    }
    return wrap;
  },

  _nextUpRow(b) {
    return this._meter(b.title || b.id, b.cur, b.target, {
      extraClass: "gami-nextup", tip: b.desc || "", minGoal: 1,
    });
  },

  // C2 — gentle daily streak (personal best). Never punitive: a broken streak just
  // resets quietly; we never call out a loss.
  _streakBlock(s) {
    const wrap = document.createElement("div");
    wrap.className = "gami-block";

    const current = Math.max(0, Number(s.current) || 0);
    const longest = Math.max(0, Number(s.longest) || 0);

    if (current <= 0 && longest <= 0) {
      const invite = document.createElement("div");
      invite.className = "gami-sub gami-muted";
      invite.textContent = "Open the annotator today to start a watch.";
      wrap.appendChild(invite);
      return wrap;
    }

    const head = document.createElement("div");
    head.className = "gami-sub gami-positive";
    head.textContent = `${current} day${current === 1 ? "" : "s"} in a row`;
    wrap.appendChild(head);

    const best = document.createElement("div");
    best.className = "gami-sub gami-muted";
    best.textContent = `Personal best: ${longest} day${longest === 1 ? "" : "s"}`;
    wrap.appendChild(best);
    return wrap;
  },

  // C2 — scientific impact. Only rendered when > 0 (no sad zero).
  _impactBlock(i) {
    const wrap = document.createElement("div");
    wrap.className = "gami-block";
    const _lbl4 = this._sectionLabel("IMPACT");
    wrap.appendChild(_lbl4);
    this._bindBlockFold(wrap, _lbl4);;
    const n = Math.max(0, Number(i.cataloged_sharks) || 0);
    const line = document.createElement("div");
    line.className = "gami-sub gami-positive";
    line.textContent = `Your work has helped catalog ${n} shark${n === 1 ? "" : "s"}.`;
    wrap.appendChild(line);
    return wrap;
  },

  // C3 — measured skill tier. Informational + positive; never comparative.
  _skillBlock(s) {
    const wrap = document.createElement("div");
    wrap.className = "gami-block";
    const _lbl5 = this._sectionLabel("SKILL");
    wrap.appendChild(_lbl5);
    this._bindBlockFold(wrap, _lbl5);;

    const tier = String(s.tier || "").toLowerCase();
    const label =
      { novice: "Getting started", intermediate: "Steady", trusted: "Trusted" }[tier] || tier;
    const head = document.createElement("div");
    head.className = "gami-stat-head";
    const k = document.createElement("span");
    k.textContent = "Tier";
    const v = document.createElement("span");
    v.className = "gami-level";
    v.textContent = label;
    head.appendChild(k);
    head.appendChild(v);
    wrap.appendChild(head);

    const basis = {
      qscore: "based on your calibration accuracy",
      proficiency: "based on your proficiency",
      experience: "based on your experience so far",
      expert: "expert reviewer",
    }[s.basis];
    if (basis) {
      const sub = document.createElement("div");
      sub.className = "gami-sub gami-muted";
      sub.textContent = basis;
      wrap.appendChild(sub);
    }
    return wrap;
  },

  // C3 — opt-in, non-zero-sum cooperative goal: collective progress + your own
  // contribution (never a ranking). Joining is opt-in by design.
  /** Why the bar cannot be drawn. Each of these is a real state the server can be
   *  in, and each gets a plain sentence instead of a rail at zero percent, because
   *  an empty bar reads as broken software rather than as work not yet started. */
  NO_NUMBER: {
    no_target: "No target set for this mission yet. Ask a lab lead.",
    nothing_queued: "Nothing has been queued for this mission yet.",
    queue_off: "The work queue is off, so nobody is being handed this mission yet.",
    spec_missing: "The mission this goal pointed at is no longer running.",
    unknown_metric: "This goal counts something the app cannot measure. Ask a lab lead.",
    metric_no_data: "No track checks have been recorded yet.",
  },

  MISSION_STATE: {
    active: "Running",
    draft: "Not started yet",
    frozen: "Finished",
    complete: "Finished",
  },

  _teamGoalBlock(t) {
    const wrap = document.createElement("div");
    wrap.className = "gami-block";
    wrap.id = "gami-team-goal";
    const _lbl6 = this._sectionLabel("TEAM GOAL",
      "One mission the whole lab is working on together. The bar is everyone's work "
      + "added up. It is not a race and it is never a ranking.");
    wrap.appendChild(_lbl6);
    this._bindBlockFold(wrap, _lbl6);;

    const g = t.goal || {};
    const p = t.progress || {};
    const my = t.my || {};
    const mission = g.mission || null;

    // The mission's NAME is deliberately not shown. It is scheduling vocabulary
    // ("Walkthrough - scar coverage") that names the batch the work came from, not
    // anything the labeler is deciding; the bar is the whole message. The name, the
    // purpose and the state live one click away, under More.
    if (p.measurable === false) {
      // No meter at all. See NO_NUMBER.
      const why = document.createElement("div");
      why.className = "gami-sub gami-muted";
      why.textContent = this.NO_NUMBER[p.reason]
        || "There is no number for this goal yet.";
      wrap.appendChild(why);
    } else {
      const cur = Math.max(0, Number(p.current) || 0);
      const target = Math.max(1, Number(p.target) || 1);
      const unit = p.unit || "items";
      // "done", never "verified": state='done' means an annotation was handed in,
      // not that anybody accepted it. Nothing reviews an ordinary finished item.
      wrap.appendChild(this._meter("Together", cur, target, { unit, minGoal: 1 }));

      const caption = this._goalCaption(p, unit);
      if (caption) {
        const cap = document.createElement("div");
        cap.className = "gami-sub gami-muted";
        cap.textContent = caption;
        wrap.appendChild(cap);
      }
    }

    // Everything below is one click away rather than in the rail. What the goal is
    // FOR does not change while somebody works, so it does not need to hold space
    // above the work all day.
    // An explicit toggle rather than <details>. panel_ui walks this subtree and
    // re-parents around any nested `.section-label`, which is enough to leave a
    // closed <details> rendering its own children. A hidden div cannot be
    // second-guessed by either engine or stylesheet.
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "gami-more-btn";
    moreBtn.textContent = "More";
    moreBtn.setAttribute("aria-expanded", "false");
    const more = document.createElement("div");
    more.className = "gami-more";
    more.hidden = true;
    moreBtn.addEventListener("click", () => {
      more.hidden = !more.hidden;
      moreBtn.textContent = more.hidden ? "More" : "Less";
      moreBtn.setAttribute("aria-expanded", String(!more.hidden));
    });
    wrap.appendChild(moreBtn);
    wrap.appendChild(more);

    if (mission && this.MISSION_STATE[mission.status]) {
      const chip = document.createElement("span");
      chip.className = "gami-chip gami-state-chip";
      chip.textContent = this.MISSION_STATE[mission.status];
      more.appendChild(chip);
    }
    // What the mission is FOR, when somebody wrote it down. Omitted entirely when
    // empty rather than filled with a placeholder.
    if (mission && mission.purpose) {
      const why = document.createElement("div");
      why.className = "gami-sub gami-muted";
      why.textContent = mission.purpose;
      more.appendChild(why);
    }

    // The personal line is what the toggle actually governs, so it is the only thing
    // the toggle hides.
    if (my.opt_in) {
      const contrib = document.createElement("div");
      contrib.className = "gami-sub gami-muted";
      contrib.textContent =
        `Your share: ${Math.max(0, Number(my.contribution) || 0)} ${p.unit || "items"}`;
      more.appendChild(contrib);
    }

    const joined = !!my.opt_in;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gami-optin";
    btn.textContent = joined ? "Hide my share" : "Show my share";
    // Corrected. The old label said "Join this goal" and its tooltip claimed leaving
    // stopped your work counting toward the bar. team_goal_progress never reads
    // coop_opt_in, so that was false — and making it true would be worse: a lab total
    // that depends on consent under-reports real work.
    this._tip(btn, "The bar is everyone's work added up either way. This only "
      + "controls whether your own number is shown to you. Nothing about you is "
      + "shown to anyone else.");
    btn.addEventListener("click", () => this._setOptIn(!joined));
    more.appendChild(btn);

    if (this.suggest) more.appendChild(this._suggestBlock(this.suggest));
    return wrap;
  },

  /** One line under the bar saying where the rest of it is. */
  _goalCaption(p, unit) {
    const queued = Number(p.queued) || 0;
    const leased = Number(p.leased) || 0;
    if (p.short_of_target && p.ceiling != null) {
      return `Only ${p.ceiling} ${unit} found so far.`;
    }
    if (!Number(p.current)) {
      return queued ? `Nothing finished yet. ${queued} waiting.` : "";
    }
    if (queued || leased) {
      return `${queued} waiting. ${leased} in progress.`;
    }
    return "";
  },

  // C4 — citizen-science "your standing" (public profile only; never rendered for
  // the lab). Coaching, never punitive: shows whether your work currently counts
  // and what to finish next. Reasons are surfaced as a next step, not a scolding.
  _trustBlock(t) {
    const wrap = document.createElement("div");
    wrap.className = "gami-block";
    const _lbl7 = this._sectionLabel("YOUR STANDING");
    wrap.appendChild(_lbl7);
    this._bindBlockFold(wrap, _lbl7);;

    const head = document.createElement("div");
    head.className = "gami-stat-head";
    const k = document.createElement("span");
    k.textContent = "Status";
    const v = document.createElement("span");
    v.className = "gami-level";
    v.textContent = t.trusted ? "Trusted" : "Building trust";
    head.appendChild(k);
    head.appendChild(v);
    wrap.appendChild(head);

    if (t.trusted) {
      const ok = document.createElement("div");
      ok.className = "gami-sub gami-positive";
      ok.textContent = "Your contributions count toward the consensus.";
      wrap.appendChild(ok);
      return wrap;
    }

    const reasons = Array.isArray(t.reasons) ? t.reasons : [];
    const ob = t.onboarding || {};
    const msg = document.createElement("div");
    msg.className = "gami-sub gami-warn";
    if (t.blocked) {
      msg.textContent = "Your account is under review.";
    } else if (reasons.includes("onboarding_incomplete")) {
      const tleft = Math.max(0, (ob.tutorials_required || 0) - (ob.tutorials_done || 0));
      const pleft = Math.max(0, (ob.practice_required || 0) - (ob.practice || 0));
      const parts = [];
      if (tleft > 0) parts.push(`${tleft} tutorial${tleft === 1 ? "" : "s"}`);
      if (pleft > 0)
        parts.push(`${pleft} more practice annotation${pleft === 1 ? "" : "s"}`);
      msg.textContent = parts.length
        ? `Finish onboarding to start contributing: ${parts.join(" and ")}.`
        : "Finish onboarding to start contributing.";
    } else {
      msg.textContent =
        "Keep verifying blind calibration checks to build trust — you're on your way!";
    }
    wrap.appendChild(msg);
    return wrap;
  },

  async _fetchSuggestHealth() {
    try {
      const res = await fetch("/api/missions/health", { credentials: "same-origin" });
      if (!res.ok) return null;                 // 404 = feature off; draw nothing
      const h = await res.json();
      return h && h.suggestions ? h : null;
    } catch (e) { return null; }
  },

  async _fetchMySuggestions() {
    try {
      const res = await fetch("/api/missions/suggestions", { credentials: "same-origin" });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  },

  /** Status wording as the person who wrote it would say it. `state` is derived
   *  server-side from the mission itself, so "running" cannot disagree with what is
   *  actually being handed out. */
  SUGG_STATE: {
    proposed: "Waiting",
    accepted: "Accepted",
    accepted_not_started: "Accepted",
    running: "Accepted and running",
    finished: "Accepted and finished",
    accepted_removed: "Mission removed",
    declined: "Not this time",
    withdrawn: "Withdrawn",
  },

  /** Propose a mission, and see what happened to the ones you proposed.
   *
   *  No votes, no counts of anybody else's, no byline. The gamification layer is
   *  private and non-competitive on purpose, and a suggestion box with a score
   *  attached is a popularity contest that would induce exactly the herding the
   *  multi-rater design exists to measure. This goes to a lab lead, not to a wall.
   */
  _suggestBlock(h) {
    const wrap = document.createElement("div");
    wrap.className = "gami-suggest";

    const link = document.createElement("button");
    link.type = "button";
    link.className = "gami-suggest-link";
    link.textContent = "Suggest a mission";
    wrap.appendChild(link);

    const form = document.createElement("div");
    form.className = "gami-suggest-form";
    form.hidden = true;
    wrap.appendChild(form);

    const mine = document.createElement("div");
    mine.className = "gami-suggest-mine";
    wrap.appendChild(mine);

    const KINDS = { pose: "Skeleton points", bbox: "Scar boxes",
                    segment: "Outlines", verify: "Checking proposals" };

    const renderMine = async () => {
      const data = await this._fetchMySuggestions();
      mine.textContent = "";
      const rows = (data && data.suggestions) || [];
      if (!rows.length) return;                 // empty list shows nothing at all
      const head = document.createElement("div");
      head.className = "gami-section-label gami-sub-head";
      head.textContent = "YOUR SUGGESTIONS";
      mine.appendChild(head);
      rows.forEach((r) => {
        const row = document.createElement("div");
        row.className = "gami-sugg-row";
        const t = document.createElement("span");
        t.className = "gami-sugg-title";
        t.textContent = r.mission_name || r.title;   // textContent: author-written
        row.appendChild(t);
        const chip = document.createElement("span");
        chip.className = "gami-chip gami-sugg-chip";
        chip.textContent = this.SUGG_STATE[r.state] || r.state;
        row.appendChild(chip);
        if (r.review_note) {
          const note = document.createElement("button");
          note.type = "button";
          note.className = "gami-sugg-note";
          note.textContent = "!";
          // Behind a popover, not inline: a lab lead's paragraph that stays there for
          // days would push everything else down a 158px rail.
          this._tip(note, r.review_note);
          row.appendChild(note);
        }
        if (r.status === "proposed" || r.status === "declined") {
          const w = document.createElement("button");
          w.type = "button";
          w.className = "gami-sugg-withdraw";
          w.textContent = "Withdraw";
          w.addEventListener("click", async () => {
            if (!confirm("Withdraw this suggestion?")) return;
            await fetch(`/api/missions/suggestions/${r.id}`, {
              method: "DELETE", credentials: "same-origin",
              headers: { "X-Requested-With": "XMLHttpRequest" },
            });
            renderMine();
          });
          row.appendChild(w);
        }
        mine.appendChild(row);
      });
    };

    const buildForm = () => {
      form.textContent = "";
      const field = (labelText, el) => {
        const l = document.createElement("label");
        l.className = "gami-sugg-label";
        l.textContent = labelText;
        form.appendChild(l);
        form.appendChild(el);
      };
      const title = document.createElement("input");
      title.type = "text";
      title.maxLength = 120;
      title.placeholder = "Short name for the mission";
      field("What should we work on?", title);

      const why = document.createElement("textarea");
      why.rows = 3;
      why.maxLength = 2000;
      why.placeholder = "What would this let the lab answer that we cannot today?";
      field("Why does it matter?", why);

      const kind = document.createElement("select");
      (h.task_types || Object.keys(KINDS)).forEach((k) => {
        const o = document.createElement("option");
        o.value = k;
        o.textContent = KINDS[k] || k;
        kind.appendChild(o);
      });
      field("Kind of work", kind);

      const err = document.createElement("div");
      err.className = "gami-sub gami-sugg-err";
      form.appendChild(err);

      const send = document.createElement("button");
      send.type = "button";
      send.className = "gami-optin";
      send.textContent = "Send to lab leads";
      send.addEventListener("click", async () => {
        err.textContent = "";
        send.disabled = true;
        try {
          const res = await fetch("/api/missions/suggestions", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json",
                       "X-Requested-With": "XMLHttpRequest" },
            body: JSON.stringify({ title: title.value, rationale: why.value,
                                   task_type: kind.value }),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) {
            // The server's message, shown as written: it is the one that knows why.
            err.textContent = j.error || "Could not send that. Try again in a moment.";
            return;
          }
          form.hidden = true;
          link.textContent = "Sent to your lab leads.";
          renderMine();
        } catch (e) {
          err.textContent = "Could not send that. Try again in a moment.";
        } finally {
          send.disabled = false;
        }
      });
      form.appendChild(send);
    };

    link.addEventListener("click", () => {
      if (!form.childElementCount) buildForm();
      form.hidden = !form.hidden;
      link.textContent = form.hidden ? "Suggest a mission" : "Cancel";
    });

    renderMine();
    return wrap;
  },

  async _setOptIn(optIn) {
    try {
      const res = await fetch("/api/me/team-goal/opt-in", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest", // satisfies the app's CSRF guard
        },
        body: JSON.stringify({ opt_in: optIn }),
      });
      if (!res.ok) return;
      const j = await res.json();
      if (this.teamGoal && this.teamGoal.my) this.teamGoal.my.opt_in = !!j.opt_in;
      if (this.stats) this._renderPanel(this.stats); // re-render reflects new opt-in
    } catch (e) {
      /* never disrupt annotating */
    }
  },
};

window.Gamification = Gamification;
