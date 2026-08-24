/**
 * signals_review.js — Stream F, F3: the labeler-facing half of the quality layer.
 *
 * The consensus maths lives in `annotation/signal_consensus.py` and the routes in
 * `annotation/routes_signals.py`. This is the surface that makes their answers
 * actionable: where labelers disagreed, how well the group agrees at all, how you score
 * against blind gold, and where to go next.
 *
 * Four rules this file exists to honour:
 *
 * 1. **Disagreement leads.** Clusters are ordered disputed → unconfirmed → single →
 *    probable → confirmed, not by time. A confirmed event needs nobody's attention; a
 *    disputed one is the entire reason to compute consensus.
 *
 * 2. **A null κ is not a zero κ.** `AgreementStats` returns `kappa_code: null` when only
 *    one code is in play, because κ is genuinely undefined there — with a single
 *    category, agreement expected by chance is ~1 and the statistic collapses. On the
 *    real RELAY corpus two raters agreeing on 80% of a 70-pulse train score κ = 0.0.
 *    Rendering that null as "0.00 — below bar" would tell the lab its labelers disagree
 *    completely when they substantially agree. It is shown as undefined, with the reason.
 *
 * 3. **Peer identities stay with admins.** The `/scorecard` route already filters a
 *    non-admin down to their own row, and that is where the rule belongs. This file does
 *    not re-derive the permission — it just never renders a name it was not given, so a
 *    future loosening of the route cannot leak a ranking into the cohort by accident.
 *
 * 4. **Computing is not free.** `GET /consensus` reads the stored run; `?compute=1`
 *    previews without writing; `POST /consensus/refresh` is admin-only because it stamps
 *    `consensus_state` onto every label. So this never auto-computes on load — when
 *    nothing is stored it offers the preview rather than quietly sweeping the deployment
 *    on somebody's page load.
 *
 * Visibility follows the server's answer: `_may_read` returns 403 for a deployment you
 * are not assigned to, and the panel simply stays hidden.
 */
"use strict";

const SignalsReview = {
  // Matches annotation/routes_signals.py.
  ROUTES: {
    consensus: (id) => `/api/signals/deployments/${id}/consensus`,
    preview: (id) => `/api/signals/deployments/${id}/consensus?compute=1`,
    refresh: (id) => `/api/signals/deployments/${id}/consensus/refresh`,
    scorecard: (id) => `/api/signals/deployments/${id}/scorecard`,
    replenish: () => `/api/signals/deployments/replenish`,
    setGold: (labelId) => `/api/signals/labels/${labelId}/gold`,
    exportAgreed: (id, fmt) =>
      `/api/signals/deployments/${id}/export/${fmt}?consensus=confirmed`,
  },

  // Formats `signals_export` serves. Each already has a reader downstream, which is the
  // whole point of the export layer — no format was invented for this app.
  EXPORT_FORMATS: [
    ["raven", "Raven selection table"],
    ["boris", "BORIS events CSV"],
    ["boris-sidecar", "BORIS alignment sidecar"],
    ["rf", "RF training CSV"],
    ["relay", "RELAY eval labels"],
    ["json", "Full JSON"],
  ],

  // Ordered by how much a human needs to look at it.
  STATE_ORDER: ["disputed", "unconfirmed", "single", "probable", "confirmed"],

  STATE_META: {
    disputed: { label: "Disputed", color: "#e0564a", hint: "Labelers named this event differently" },
    unconfirmed: { label: "Unconfirmed", color: "#c98a2e", hint: "Marked, but without enough support" },
    single: { label: "Solo", color: "#7a7f99", hint: "Only one labeler marked this" },
    probable: { label: "Probable", color: "#3f9ad6", hint: "Agreed, but short of the confirmed bar" },
    confirmed: { label: "Confirmed", color: "#3aa76d", hint: "Agreed by enough labelers" },
  },

  RIBBON_H: 4,

  consensus: null,      // ConsensusResult.to_dict(), or null when none is stored
  cached: true,
  scorecard: null,
  isAdmin: false,
  denied: false,        // 403/404 — no review surface for this user on this deployment
  _deploymentId: null,
  _selectedKey: null,
  _busy: false,

  // ══════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Wait for the two things this module depends on, rather than sampling them once.
   *
   * Both arrive asynchronously and neither is fast on a cold worker: `Signals.available`
   * is set after an awaited `/api/signals/health`, and `appState.currentUser` after
   * `/auth/me`. Reading them on a fixed timer meant a slow link silently produced either
   * no F3 surface at all for the whole session, or an admin demoted to a labeler view —
   * failures that look exactly like "the feature is off" and "you are not an admin".
   */
  async init() {
    // Wait for `available` to become TRUE, not merely to be a boolean: signals.js
    // initialises it to `false` and only sets it after an awaited health check, so a
    // type test passes on the first tick and bails before the answer exists. If the
    // feature really is off it never flips and this times out into the same no-op —
    // a few seconds of 200ms polling, invisible either way.
    const ready = await this._waitFor(() => window.Signals && window.Signals.available === true, 15000);
    if (!ready) return;

    await this._waitFor(
      () => window.appState && window.appState.currentUser
        && window.appState.currentUser.email,
      10000
    );
    this.isAdmin = !!(window.appState && window.appState.currentUser
      && window.appState.currentUser.is_admin);

    this._bind();
    this._hookRibbon();
    this._watchDeployment();
  },

  _waitFor(pred, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        let ok = false;
        try { ok = !!pred(); } catch (e) { ok = false; }
        if (ok) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        setTimeout(tick, 200);
      };
      tick();
    });
  },

  /**
   * Follow whatever deployment the dock has open.
   *
   * Polled rather than hooked, for the same reason panel_ui.js polls: `loadDeployment`
   * lives in signals.js, and a callback there would mean editing a file another session
   * is working in. Comparing one integer twice a second is cheaper than the coordination.
   */
  _watchDeployment() {
    setInterval(() => {
      const S = window.Signals;
      const id = (S && S.deployment && S.deployment.id) || null;

      if (id !== this._deploymentId) {
        this._deploymentId = id;
        this.consensus = null;
        this.scorecard = null;
        this.denied = false;
        this._selectedKey = null;
        this.render();
        if (id) this.load(id);
        this._selectedLabelId = (S && S.selectedLabelId) || null;
        return;
      }

      // Also follow the label selection. The gold button's enabled state and its
      // Mark/Un-gold text are computed at render time from `Signals.selectedLabelId`, and
      // nothing in signals.js knows this module exists — so selecting a label on the
      // canvas left the button disabled, and the only affordance for creating the one
      // instrument that catches a shared miss was dead in normal use. It also meant a
      // stale render could act on a label the user had since changed.
      const sel = (S && S.selectedLabelId) || null;
      if (sel !== this._selectedLabelId) {
        this._selectedLabelId = sel;
        if (this.consensus) this.render();
      }
    }, 500);
  },

  /**
   * Accept either consensus shape.
   *
   * `/consensus` now returns the same body cached or computed — but it did not always,
   * and the failure mode is why this stays. The cache row is a flat summary with the run
   * under `details`; read as the computed shape it yields no `agreement`, so κ renders as
   * "not defined" — which is a *real, meaningful* value in this API, returned when only
   * one code is in play. The bug therefore looked like a correct answer, on what would
   * have been every normal page load, and never threw.
   *
   * Six lines to be immune to that, including against a server one deploy behind.
   */
  _normalize(payload) {
    if (!payload) return null;
    if (payload.clusters) return payload;                       // already the full result
    if (payload.details && payload.details.clusters) {
      return Object.assign({}, payload.details, { computed_at: payload.computed_at });
    }
    return null;
  },

  /** Read the stored run. Never computes — see rule 4. */
  async load(deploymentId) {
    try {
      const data = await this._get(this.ROUTES.consensus(deploymentId));
      if (this._deploymentId !== deploymentId) return;   // labeler moved on
      this.consensus = this._normalize(data && data.consensus);
      this.cached = !data || data.cached !== false;
      this.denied = false;
    } catch (e) {
      // 403 = not assigned; 404 = feature/deployment absent. Either way there is no
      // review surface here, and an error banner a labeler cannot act on is just noise.
      this.consensus = null;
      this.denied = true;
    }
    this.render();
    if (window.Signals) window.Signals._dirtyFrame = true;
  },

  /** Preview without writing (any assigned labeler), or refresh + store (admin). */
  async compute(store) {
    const id = this._deploymentId;
    if (!id || this._busy) return;
    this._busy = true;
    this.render();
    try {
      const data = store
        ? await this._post(this.ROUTES.refresh(id))
        : await this._get(this.ROUTES.preview(id));
      if (this._deploymentId !== id) return;
      this.consensus = this._normalize(data && data.consensus);
      this.cached = !!store;
      this.scorecard = null;
    } catch (e) {
      this._toast(`Consensus failed: ${e.message}`);
    } finally {
      this._busy = false;
      this.render();
      if (window.Signals) window.Signals._dirtyFrame = true;
    }
  },

  // ══════════════════════════════════════════════════════════════════════
  // Rail panel
  // ══════════════════════════════════════════════════════════════════════

  render() {
    const panel = document.getElementById("signal-review-panel");
    const head = document.getElementById("signal-review-head");
    if (!panel) return;

    const show = !!this._deploymentId && !this.denied;
    panel.style.display = show ? "" : "none";
    if (head) head.style.display = show ? "" : "none";
    if (!show) return;

    panel.textContent = "";

    if (!this.consensus) {
      panel.appendChild(this._noConsensusBlock());
      return;
    }
    panel.appendChild(this._agreementBlock());
    panel.appendChild(this._stateChips());
    panel.appendChild(this._clusterList());
    panel.appendChild(this._actionBar());
    // Only when a run is actually stored: `?consensus=` reads the stored consensus and
    // 409s otherwise, so offering it against a preview would be offering a dead button.
    if (this.cached) panel.appendChild(this._exportBar());

    // This panel appears on its own schedule — only once somebody has computed consensus
    // and the server lets this labeler read it — so it teaches itself when it first shows
    // up, rather than being explained inside a tour they took days earlier.
    if (window.Tutorial && window.Tutorial.surfaceShown) {
      window.Tutorial.surfaceShown("signals_review");
    }
  },

  _noConsensusBlock() {
    const wrap = document.createElement("div");
    const msg = document.createElement("div");
    msg.className = "sr-empty";
    msg.textContent = this._busy
      ? "Computing…"
      : "No consensus stored for this deployment yet.";
    wrap.appendChild(msg);

    const bar = document.createElement("div");
    bar.className = "sr-admin";
    const preview = document.createElement("button");
    preview.className = "btn btn-sm btn-ghost";
    preview.type = "button";
    preview.textContent = "Preview";
    preview.disabled = this._busy;
    preview.title = "Compute without storing — does not disturb the figure others are reading";
    preview.addEventListener("click", () => this.compute(false));
    bar.appendChild(preview);

    if (this.isAdmin) {
      const refresh = document.createElement("button");
      refresh.className = "btn btn-sm btn-ghost";
      refresh.type = "button";
      refresh.textContent = "Compute & store";
      refresh.disabled = this._busy;
      refresh.title = "Recompute and stamp consensus_state onto every label";
      refresh.addEventListener("click", () => this.compute(true));
      bar.appendChild(refresh);
    }
    wrap.appendChild(bar);
    return wrap;
  },

  _agreementBlock() {
    const a = this.consensus.agreement || {};
    const wrap = document.createElement("div");
    wrap.className = "sr-agree";

    const k = a.kappa_code;
    const bar = typeof a.bar === "number" ? a.bar : 0.7;
    const row = document.createElement("div");
    row.className = "sr-agree-row";

    const name = document.createElement("span");
    name.className = "sr-agree-name";
    name.textContent = "Agreement κ";
    row.appendChild(name);

    const val = document.createElement("span");
    if (k === null || k === undefined) {
      // Undefined is a distinct, honest answer (rule 2) — but it has THREE causes, and
      // saying the wrong one is its own false claim. `compute_agreement` returns null
      // when there are fewer than two raters, when no event was marked by two people,
      // and when only one code is in play. Blaming the vocabulary for the first two tells
      // a lab its codes are degenerate when the truth is "nobody has corroborated this
      // yet" — and both discriminators are already in the payload being read.
      val.className = "sr-kappa sr-kappa-undef";
      val.textContent = "not defined";
      val.title = this._kappaUndefinedReason(a);
    } else {
      // `meets_bar` is the server's own tri-state judgement (true/false/null); prefer it
      // over recomputing the comparison here, so there is one place that decides whether
      // a deployment passes. Fall back only if it is absent from an older payload.
      const ok = typeof a.meets_bar === "boolean" ? a.meets_bar : k >= bar;
      val.className = "sr-kappa " + (ok ? "sr-kappa-ok" : "sr-kappa-low");
      val.textContent = k.toFixed(2);
      val.title =
        `${ok ? "Meets" : "Below"} the ${bar} bar — agreement among the people who ` +
        "marked something. It says nothing about what the whole cohort missed.";
    }
    row.appendChild(val);

    const barTxt = document.createElement("span");
    barTxt.className = "sr-agree-bar";
    barTxt.textContent = `bar ${bar}`;
    row.appendChild(barTxt);
    wrap.appendChild(row);

    const sub = document.createElement("div");
    sub.className = "sr-agree-sub";
    const nRaters = Number(a.n_raters) || 0;
    const parts = [`${nRaters} labeler${nRaters === 1 ? "" : "s"}`];
    // `n_items` is a count of events. `n_items_code` is NOT — it is accumulated once per
    // rater PAIR inside the pairwise loop, so three raters over two events gives 6. It was
    // rendered as "6 co-marked" directly above chips reading "2 confirmed", a figure that
    // grows when a labeler joins even if no new event is marked. Show the event count.
    if (a.n_items) parts.push(`${a.n_items} event${a.n_items === 1 ? "" : "s"}`);
    if (typeof a.raw_agreement === "number") parts.push(`${Math.round(a.raw_agreement * 100)}% raw`);
    if (!this.cached) parts.push("preview");
    sub.textContent = parts.join(" · ");
    wrap.appendChild(sub);

    if (this.consensus.n_machine) {
      const m = document.createElement("div");
      m.className = "sr-agree-sub";
      const n = this.consensus.n_machine;
      m.textContent = `${n} machine proposal${n === 1 ? "" : "s"} · not scored`;
      m.title = "Detector output never counts as a vote — a model must not be scored against its own proposals.";
      wrap.appendChild(m);
    }

    // Visible, not a tooltip. Clusters are built FROM labels, so an event the whole
    // cohort missed produces no cluster and lands in nothing — not κ, not raw agreement,
    // not detection recall, whose denominator is "events other people marked". A cohort
    // that unanimously overlooks half a file therefore scores perfectly.
    //
    // This is the one misreading with methodological consequences, because believing the
    // number means coverage is what stops somebody looking harder. Tooltips go unread, so
    // it costs a line of rail.
    const caveat = document.createElement("div");
    caveat.className = "sr-caveat";
    caveat.textContent = "Agreement, not coverage — an event everyone missed is invisible here.";
    caveat.title =
      "Consensus is computed from labels, so it can only see events somebody marked. " +
      "Blind gold items are the only instrument that catches a miss the whole cohort " +
      "shared, because a gold item asserts an event whether or not anyone found it.";
    wrap.appendChild(caveat);
    return wrap;
  },

  /**
   * Why is κ undefined here? Three causes, distinguished by fields already in the payload.
   *
   * Returned as a sentence rather than a lookup so the scorecard and the rail cannot
   * drift apart — they were separately worded before, and both said "one code in play".
   */
  _kappaUndefinedReason(a) {
    const raters = Number(a.n_raters) || 0;
    const coMarked = Number(a.n_items_code) || 0;
    if (raters < 2) {
      return "Only one labeler has worked on this deployment, so there is no second " +
             "opinion to agree with yet. κ needs at least two raters.";
    }
    if (coMarked === 0) {
      return "No event here has been marked by two people, so there is nothing to " +
             "compare. κ is measured over events both raters marked — this is a lack of " +
             "overlap, not a lack of agreement.";
    }
    return "Only one code is in play, and κ needs at least two. With a single category " +
           "agreement expected by chance is ~1, so κ collapses toward 0 however well " +
           "people actually agree. Judge detection by the per-labeler recall figures.";
  },

  _stateChips() {
    const counts = this.consensus.counts_by_state || {};
    const wrap = document.createElement("div");
    wrap.className = "sr-chips";
    for (const state of this.STATE_ORDER) {
      const n = counts[state] || 0;
      if (!n) continue;
      const meta = this.STATE_META[state];
      const chip = document.createElement("span");
      chip.className = "sr-chip";
      chip.style.borderColor = meta.color;
      chip.title = meta.hint;
      const dot = document.createElement("i");
      dot.style.background = meta.color;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(`${n} ${meta.label.toLowerCase()}`));
      wrap.appendChild(chip);
    }
    return wrap;
  },

  /** Clusters, disagreement first. */
  sortedClusters() {
    const rank = (s) => {
      const i = this.STATE_ORDER.indexOf(s);
      return i === -1 ? this.STATE_ORDER.length : i;
    };
    return [...(this.consensus.clusters || [])].sort((a, b) => {
      const d = rank(a.consensus_state) - rank(b.consensus_state);
      return d !== 0 ? d : a.t_start_s - b.t_start_s;
    });
  },

  _clusterList() {
    const list = document.createElement("div");
    list.className = "sr-list";
    const clusters = this.sortedClusters();
    if (!clusters.length) {
      const empty = document.createElement("div");
      empty.className = "sr-empty";
      empty.textContent = "No events clustered yet.";
      list.appendChild(empty);
      return list;
    }
    for (const c of clusters) list.appendChild(this._clusterRow(c));
    return list;
  },

  _clusterRow(c) {
    const S = window.Signals;
    const meta = this.STATE_META[c.consensus_state] || this.STATE_META.single;
    const row = document.createElement("div");
    row.className = "sr-row" + (c.key === this._selectedKey ? " selected" : "");
    row.style.borderLeftColor = meta.color;

    const top = document.createElement("div");
    top.className = "sr-row-top";

    const code = document.createElement("span");
    code.className = "sr-code";
    code.textContent = c.code || "—";
    if (S && c.code) code.style.color = S._colorFor(c.code);
    top.appendChild(code);

    // Denominator comes from `agreement.n_raters`, NEVER `voter_pool`.
    //
    // This once read `voter_pool.length`, which redaction TRUNCATED to the reader — so a
    // unanimous 3-of-3 event rendered "3/1" for every labeler, and "3/3" for a reader
    // absent from the pool, asserting unanimity that was never measured. Admins, never
    // redacted, saw the right number, which is why it could sit here unnoticed.
    //
    // The backend now withholds that field as `null` rather than shortening it, so the
    // same mistake fails loudly instead of quietly. The rule stands either way: `n_raters`
    // is the count that means the same thing to every reader.
    const pool = Number((this.consensus.agreement || {}).n_raters) || 0;
    const votes = document.createElement("span");
    votes.className = "sr-votes";
    // No fabricated denominator: without a trustworthy pool, show the count alone.
    votes.textContent = pool >= c.n_voters ? `${c.n_voters}/${pool}` : `${c.n_voters}`;
    votes.title = pool >= c.n_voters
      ? "Labelers who marked this, out of those who reviewed the deployment"
      : "Labelers who marked this";
    top.appendChild(votes);

    // Did the detector find this too? Admin-only, and deliberately so.
    //
    // For a labeler it would be an anchor: "the model agrees" next to a disputed event
    // pushes resolution toward the model, which is the same failure the peer-identity
    // redaction exists to prevent — and a detector is a far more confident-looking peer.
    // For an admin it answers a model-evaluation question instead: is the detector
    // finding what people find? That is the flywheel signal, and it only became readable
    // at all once mixed point/box clusters stopped silently reporting zero proposals.
    if (this.isAdmin && Array.isArray(c.proposals) && c.proposals.length) {
      const det = document.createElement("span");
      det.className = "sr-det";
      det.textContent = "◇";
      det.title = `Detector also proposed this event (${c.proposals.length} proposal` +
                  `${c.proposals.length === 1 ? "" : "s"}). Never counted as a vote.`;
      top.appendChild(det);
    }

    if (typeof c.code_agreement === "number" && c.n_voters > 1) {
      const ag = document.createElement("span");
      ag.className = "sr-ag";
      ag.textContent = `${Math.round(c.code_agreement * 100)}%`;
      ag.title = "Share of labelers on the winning code";
      top.appendChild(ag);
    }
    row.appendChild(top);

    const bottom = document.createElement("div");
    bottom.className = "sr-row-bottom";
    const when = document.createElement("span");
    when.textContent = S ? S._fmtTime(c.t_start_s) : `${c.t_start_s.toFixed(2)}s`;
    bottom.appendChild(when);
    if (c.f_lo_hz != null && c.f_hi_hz != null && S) {
      const band = document.createElement("span");
      band.textContent = `${S._fmtHz(c.f_lo_hz)}–${S._fmtHz(c.f_hi_hz)}`;
      bottom.appendChild(band);
    }
    const state = document.createElement("span");
    state.className = "sr-state";
    state.style.color = meta.color;
    state.textContent = meta.label;
    bottom.appendChild(state);
    row.appendChild(bottom);

    // Who called it what. The server redacts `votes` down to the reader's own entry for
    // anyone who is not an admin (`signal_consensus.redact_for`), so this renders whatever
    // it was given and never reconstructs a name from another field. More than one entry
    // therefore only ever appears for a reader entitled to see it — which is also why the
    // `isAdmin` check here is defence-in-depth and not the actual rule.
    // Where the reader personally stands on this event.
    //
    // `mine` / `my_code` are the redaction-safe answer to the one question a labeler can
    // actually act on — and until they existed the panel could not answer it, because
    // every field that carried it named peers. Three cases, and the middle one is the
    // whole point: the group settled on a code you did not choose.
    const stance = this._stanceOn(c);
    if (stance) {
      const s = document.createElement("div");
      s.className = "sr-stance " + stance.cls;
      s.textContent = stance.text;
      s.title = stance.title;
      row.appendChild(s);
    }

    const cast = c.votes ? Object.entries(c.votes) : [];
    if (this.isAdmin && cast.length > 1) {
      const dis = document.createElement("div");
      dis.className = "sr-dissent";
      dis.textContent = cast
        .map(([who, vote]) => `${this._shortName(who)}: ${vote}`)
        .join(" · ");
      row.appendChild(dis);
    }

    row.addEventListener("click", () => this.focusCluster(c));
    return row;
  },

  /**
   * The reader's own position on one event, or null if there is nothing to say.
   *
   * Only rendered when the payload actually carries `mine` — `redact_for` adds it for a
   * labeler, and an admin's unredacted payload has no such notion, since "mine" is not
   * meaningful for someone reviewing everybody.
   */
  _stanceOn(c) {
    if (typeof c.mine !== "boolean") return null;

    if (!c.mine) {
      // Only worth saying when other people agreed it was there: that is a miss you can
      // still go and look at, not noise about every event you happened not to reach.
      if ((c.n_voters || 0) < 2) return null;
      return {
        cls: "sr-stance-missed",
        text: `you didn't mark this`,
        title: "Other labelers marked this event and you did not — worth a second look.",
      };
    }
    if (c.my_code && c.code && c.my_code !== c.code) {
      return {
        cls: "sr-stance-differs",
        text: `you said ${c.my_code}`,
        title: "The group settled on a different code. Neither is automatically right — " +
               "this is the disagreement worth resolving.",
      };
    }
    return { cls: "sr-stance-agrees", text: "you agreed", title: "Your code matched the group's." };
  },

  /** Frame a cluster in the dock and put the playhead on it. */
  focusCluster(c) {
    const S = window.Signals;
    if (!S) return;
    this._selectedKey = c.key;
    const dur = Math.max(0.05, (c.t_end_s || c.t_start_s) - c.t_start_s);
    // Always show context around the event, never edge-to-edge.
    S.view.spanS = Math.max(dur * 6, 1);
    S.view.startS = c.t_start_s + dur / 2 - S.view.spanS / 2;
    S.follow = false;
    S.setCursor(c.t_start_s);
    S._seekTo(c.t_start_s);
    S._dirtyFrame = true;
    this.render();
  },

  _actionBar() {
    const bar = document.createElement("div");
    bar.className = "sr-admin";

    const scores = document.createElement("button");
    scores.className = "btn btn-sm btn-ghost";
    scores.type = "button";
    scores.textContent = this.isAdmin ? "Labelers" : "My score";
    scores.title = this.isAdmin
      ? "Per-labeler agreement and gold performance"
      : "How your labels sit against the group";
    scores.addEventListener("click", () => this.openScorecard());
    bar.appendChild(scores);

    const more = document.createElement("button");
    more.className = "btn btn-sm btn-ghost";
    more.type = "button";
    more.textContent = "More work";
    more.title = "Assign more deployments, those closest to consensus first";
    more.addEventListener("click", () => this.replenish());
    bar.appendChild(more);

    if (this.isAdmin) {
      const refresh = document.createElement("button");
      refresh.className = "btn btn-sm btn-ghost";
      refresh.type = "button";
      refresh.textContent = "Refresh";
      refresh.disabled = this._busy;
      refresh.title = "Recompute and store";
      refresh.addEventListener("click", () => this.compute(true));
      bar.appendChild(refresh);

      const goldBtn = document.createElement("button");
      goldBtn.className = "btn btn-sm btn-ghost";
      goldBtn.type = "button";
      const sel = this._selectedLabel();
      goldBtn.textContent = sel && sel.is_gold ? "Un-gold" : "Mark gold";
      goldBtn.title = "Use the selected label as a blind calibration item";
      goldBtn.disabled = !sel;
      goldBtn.addEventListener("click", () => this.toggleGold());
      bar.appendChild(goldBtn);
    }
    return bar;
  },

  /**
   * Export the cohort's *agreed* events, one representative label each.
   *
   * This is the form a downstream pipeline should consume, and it is the reason the
   * consensus exists at all — so it needs a way to reach it that is not a hand-built URL.
   *
   * Offered only once a run is stored, because `?consensus=` reads the stored consensus
   * and refuses with 409 otherwise. That refusal is deliberate on the server's side
   * (degrading to "export everything" would silently emit the unaggregated dump the
   * filter exists to prevent), so it gets its own message rather than a generic failure.
   */
  _exportBar() {
    const wrap = document.createElement("div");
    wrap.className = "sr-export";

    const label = document.createElement("span");
    label.className = "sr-export-label";
    label.textContent = "Export agreed";
    label.title =
      "The confirmed events only, one representative label each — not every labeler's " +
      "copy, which would weight an event by how many people happened to see it.";
    wrap.appendChild(label);

    const sel = document.createElement("select");
    sel.className = "input";
    for (const [value, text] of this.EXPORT_FORMATS) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    }
    wrap.appendChild(sel);

    const go = document.createElement("button");
    go.className = "btn btn-sm btn-ghost";
    go.type = "button";
    go.textContent = "↓";
    go.title = "Download";
    go.addEventListener("click", () => this.exportAgreed(sel.value));
    wrap.appendChild(go);
    return wrap;
  },

  async exportAgreed(fmt) {
    const id = this._deploymentId;
    if (!id) return;
    try {
      const r = await fetch(this.ROUTES.exportAgreed(id, fmt), { credentials: "same-origin" });
      if (!r.ok) {
        // Render the server's own words for EVERY refusal rather than special-casing
        // statuses here. Each one now names the fix — "an admin must POST to
        // /consensus/refresh first", "attach a WAV source before exporting a Raven
        // selection table" — and a refusal added later is actionable in this UI with no
        // change on this side. A status-by-status ladder here would have to be extended
        // in lockstep, and the default branch is always the useless one.
        let detail = "";
        try { detail = (await r.json()).error || ""; } catch (e) { /* not json */ }
        this._toast(detail || `Export failed (${r.status}).`);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = this._exportFilename(fmt, r);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this._toast(`Exported agreed events (${fmt}).`);
    } catch (e) {
      this._toast(`Export failed: ${e.message}`);
    }
  },

  _exportFilename(fmt, response) {
    const cd = response.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="?([^"';]+)"?/i);
    if (m) return m[1];
    const code = (window.Signals && window.Signals.deployment && window.Signals.deployment.code) || "deployment";
    const ext = fmt === "json" ? "json" : fmt === "raven" ? "txt" : "csv";
    return `${code}_confirmed_${fmt}.${ext}`;
  },

  _selectedLabel() {
    const S = window.Signals;
    if (!S || !S.selectedLabelId) return null;
    return (S.labels || []).find((l) => l.id === S.selectedLabelId) || null;
  },

  async replenish() {
    try {
      const data = await this._post(this.ROUTES.replenish());
      const n = (data && data.n) || 0;
      this._toast(n ? `Assigned ${n} more deployment${n === 1 ? "" : "s"}.`
                    : "Nothing left that needs another labeler.");
      if (n && window.Signals) window.Signals._loadDeployments().catch(() => {});
    } catch (e) {
      this._toast(`Could not get more work: ${e.message}`);
    }
  },

  async toggleGold() {
    const sel = this._selectedLabel();
    if (!sel) return;
    const want = !sel.is_gold;
    try {
      await this._post(this.ROUTES.setGold(sel.id), { is_gold: want });
      sel.is_gold = want;          // keep the local row in step with the server
      this.render();
      this._toast(want ? "Marked as gold." : "No longer gold.");
    } catch (e) {
      this._toast(`Could not change gold: ${e.message}`);
    }
  },

  // ══════════════════════════════════════════════════════════════════════
  // Scorecard modal
  // ══════════════════════════════════════════════════════════════════════

  async openScorecard() {
    const modal = document.getElementById("signal-scorecard-modal");
    const body = document.getElementById("signal-scorecard-body");
    if (!modal || !body) return;
    body.textContent = "";
    const loading = document.createElement("p");
    loading.className = "sr-empty";
    loading.textContent = "Loading…";
    body.appendChild(loading);
    modal.classList.remove("hidden");

    try {
      this.scorecard = await this._get(this.ROUTES.scorecard(this._deploymentId));
    } catch (e) {
      body.textContent = "";
      const err = document.createElement("p");
      err.className = "sr-empty";
      err.textContent = `Could not load the scorecard: ${e.message}`;
      body.appendChild(err);
      return;
    }
    this._renderScorecard(body);
  },

  _renderScorecard(body) {
    const sc = this.scorecard || {};
    const a = sc.agreement || {};
    body.textContent = "";

    const intro = document.createElement("p");
    intro.className = "sr-modal-intro";
    intro.textContent =
      a.kappa_code === null || a.kappa_code === undefined
        ? "κ is undefined here — only one code is in play, so agreement expected by chance is ~1."
        : `Classification κ ${a.kappa_code.toFixed(3)} against a ${a.bar} bar.`;
    body.appendChild(intro);

    // Recall's denominator is "events other people marked", so it measures whether this
    // labeler keeps up with their peers — never whether the peers found everything. Saying
    // "detection is reported by recall" without that qualifier invites exactly the reading
    // that a high column means good coverage.
    const scope = document.createElement("p");
    scope.className = "sr-note";
    scope.textContent =
      "Recall below is against events other labelers marked — it measures keeping up with " +
      "the group, not coverage of the recording. Nothing on this page can see an event the " +
      "whole cohort missed; only blind gold can.";
    body.appendChild(scope);

    body.appendChild(this._scoreTable(sc.annotators || []));

    if (sc.n_gold) {
      const h = document.createElement("h4");
      h.textContent = `Blind gold — ${sc.n_gold} item${sc.n_gold === 1 ? "" : "s"}`;
      body.appendChild(h);
      const why = document.createElement("p");
      why.className = "sr-note";
      why.textContent =
        "The only check independent of what anyone found: a gold item asserts an event " +
        "whether or not it was marked, so Missed here is the one number that catches a " +
        "miss the whole group shared.";
      body.appendChild(why);
      body.appendChild(this._goldTable(sc.gold || []));
    } else {
      const none = document.createElement("p");
      none.className = "sr-note";
      none.textContent =
        "No blind gold on this deployment, so a miss shared by every labeler would go " +
        "unmeasured. Mark a few known events as gold to close that.";
      body.appendChild(none);
    }

    if (!this.isAdmin) {
      const note = document.createElement("p");
      note.className = "sr-note";
      note.textContent =
        "You see your own row. Per-person scores are not published to the cohort — a live " +
        "ranking changes what people label.";
      body.appendChild(note);
    }
  },

  _scoreTable(rows) {
    const table = document.createElement("table");
    table.className = "sr-table";
    const pct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
    const num = (v) => (v === null || v === undefined ? "—" : v.toFixed(2));

    const head = document.createElement("tr");
    for (const h of ["Labeler", "Labels", "Corrob.", "Solo", "Code agree", "Recall", "κ"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    table.appendChild(head);

    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.className = "sr-empty";
      td.textContent = "No scored labelers yet.";
      tr.appendChild(td);
      table.appendChild(tr);
      return table;
    }

    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.appendChild(this._td(this._shortName(r.annotator)));
      tr.appendChild(this._td(String(r.n_labels)));
      tr.appendChild(this._td(String(r.n_corroborated)));

      // Mostly marking things nobody else sees is the signature of drift — worth a look
      // before those labels reach a training set.
      const solo = this._td(String(r.n_solo));
      if (r.n_clusters && r.n_solo / r.n_clusters > 0.5) {
        solo.className = "sr-warn";
        solo.title = "Over half of this labeler's events were marked by nobody else";
      }
      tr.appendChild(solo);

      // Percentages carry their denominator. A rate over one or two events is noise, and
      // rendering it bare states it with the authority of a rate over fifty: "0%" beside
      // n=1 is honest, "0%" alone is an accusation — and this is the column an instructor
      // sets someone's proficiency weight from.
      tr.appendChild(this._rateTd(r.code_agreement, r.n_code_checked,
        "Share of this labeler's events where they matched the group's code"));
      tr.appendChild(this._rateTd(r.detection_recall, r.n_recall_events,
        "Of the events everyone else marked, how many this labeler also marked"));
      tr.appendChild(this._td(num(r.kappa)));
      table.appendChild(tr);
    }
    return table;
  },

  _td(text) {
    const td = document.createElement("td");
    td.textContent = text;
    return td;
  },

  /** A rate rendered with the count it was computed over, never bare. */
  _rateTd(value, n, why) {
    const td = document.createElement("td");
    if (value === null || value === undefined || !n) {
      // No events to measure means no rate — not 0%, which reads as a verdict.
      td.textContent = "—";
      td.title = n ? why : "Nothing to measure yet for this labeler";
      return td;
    }
    td.appendChild(document.createTextNode(`${Math.round(value * 100)}%`));
    const den = document.createElement("span");
    den.className = "sr-den";
    den.textContent = ` n=${n}`;
    td.appendChild(den);
    td.title = `${why} — measured over ${n} event${n === 1 ? "" : "s"}`;
    if (n < 5) td.classList.add("sr-thin");
    return td;
  },

  _goldTable(rows) {
    const table = document.createElement("table");
    table.className = "sr-table";
    const head = document.createElement("tr");
    for (const h of ["Labeler", "Gold", "Hit", "Missed", "False +", "Code acc."]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    table.appendChild(head);

    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "sr-empty";
      td.textContent = "Gold items exist, but nobody has been scored against them yet.";
      tr.appendChild(td);
      table.appendChild(tr);
      return table;
    }
    const pct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
    for (const r of rows) {
      const tr = document.createElement("tr");
      const cells = [this._shortName(r.annotator), String(r.n_gold), String(r.n_hit),
                     String(r.n_missed), String(r.n_false_positive), pct(r.code_accuracy)];
      cells.forEach((v, i) => {
        const td = this._td(v);
        // A labeler is not graded against gold they authored, so their gradable count can
        // be zero — a blank row rather than a bad one. Say which, or it reads as a failure.
        if (i === 1 && !r.n_gold) {
          td.className = "sr-thin";
          td.title = "No gold gradable for this labeler — they drew the items themselves, " +
                     "so scoring them against their own observation would measure nothing.";
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }
    return table;
  },

  // ══════════════════════════════════════════════════════════════════════
  // Disagreement ribbon on the dock's time axis
  // ══════════════════════════════════════════════════════════════════════

  /**
   * A thin band along the ruler showing where in the deployment people disagreed.
   *
   * Wrapping `Signals._render` rather than editing it keeps the feature additive over a
   * file another session is working in — and the wrap is guarded, so a fault in the
   * ribbon can never take the dock's render loop down with it.
   *
   * It rides the top edge of the ruler on purpose: the ruler is chrome, so the ribbon
   * cannot cover a pixel of anyone's data, and "where in time" is what a time axis is for.
   */
  _hookRibbon() {
    const S = window.Signals;
    if (!S || S._reviewRibbonHooked) return;
    const orig = S._render.bind(S);
    S._render = () => {
      orig();
      try {
        this._drawRibbon();
      } catch (e) {
        /* never let the overlay break the dock */
      }
    };
    S._reviewRibbonHooked = true;
  },

  _drawRibbon() {
    if (!this.consensus) return;
    const S = window.Signals;
    const canvas = document.getElementById("signal-canvas");
    const body = document.querySelector(".signal-dock-body");
    if (!canvas || !body) return;
    const w = body.clientWidth;
    const h = body.clientHeight;
    if (w <= 0 || h <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);

    const top = h - S.RULER_H;
    for (const c of this.consensus.clusters || []) {
      const meta = this.STATE_META[c.consensus_state];
      if (!meta) continue;
      const x0 = S._timeToX(c.t_start_s, w);
      const x1 = S._timeToX(Math.max(c.t_end_s, c.t_start_s), w);
      if (x1 < S.GUTTER || x0 > w) continue;
      const left = Math.max(S.GUTTER, x0);
      // A zero-width point event still has to be visible; floor the drawn width.
      const width = Math.max(2, Math.min(w, x1) - left);
      ctx.fillStyle = meta.color;
      ctx.globalAlpha = c.key === this._selectedKey ? 1 : 0.75;
      ctx.fillRect(left, top, width, this.RIBBON_H);
    }
    ctx.restore();
  },

  // ══════════════════════════════════════════════════════════════════════
  // Plumbing
  // ══════════════════════════════════════════════════════════════════════

  _bind() {
    const modal = document.getElementById("signal-scorecard-modal");
    const close = document.getElementById("signal-scorecard-close");
    if (close && modal) close.addEventListener("click", () => modal.classList.add("hidden"));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !modal) return;
      if (!modal.classList.contains("hidden")) {
        e.stopPropagation();
        modal.classList.add("hidden");
      }
    }, true);
  },

  /** Local part of an email — enough to tell labelers apart without publishing addresses. */
  _shortName(email) {
    const s = String(email || "");
    const at = s.indexOf("@");
    return at > 0 ? s.slice(0, at) : s || "—";
  },

  _toast(msg) {
    if (window.Signals && window.Signals._hint) window.Signals._hint(msg);
    else console.warn("[SignalsReview]", msg);
  },

  async _req(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.json()).error || ""; } catch (e) { /* no body */ }
      const err = new Error(detail || `Request failed (${r.status})`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  },
  _get(url) {
    return this._req(url, { credentials: "same-origin" });
  },
  _post(url, body) {
    return this._req(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(body || {}),
    });
  },
};

document.addEventListener("DOMContentLoaded", () => {
  // init() waits for its dependencies itself rather than racing a fixed delay.
  SignalsReview.init();
});
window.SignalsReview = SignalsReview;
