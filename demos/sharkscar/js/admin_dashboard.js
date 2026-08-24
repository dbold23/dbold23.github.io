"use strict";

/* ═══════════════════════════════════════════════════
   Admin Dashboard — Encounter Priority & Assignment
   ═══════════════════════════════════════════════════ */

const API = {
  async _handle(response) {
    if (response.status === 401) {
      window.location.href = "/";
      throw new Error("Session expired");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return response.json();
  },
  async get(url) { return this._handle(await fetch(url)); },
  async post(url, body) {
    return this._handle(await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(body),
    }));
  },
  async postForm(url, fd) {
    return this._handle(await fetch(url, { method: "POST", body: fd, headers: { "X-Requested-With": "XMLHttpRequest" } }));
  },
};


const Dashboard = {
  currentPage: 0,
  pageSize: 50,
  sortBy: "completion_count",
  sortDir: "asc",
  filterSite: "",
  filterSearch: "",
  hideNIF: false,

  async init() {
    // Check auth
    try {
      const user = await API.get("/auth/me");
      document.getElementById("header-user").textContent = user.name || user.email;
      if (!user.is_admin) { window.location.href = "/"; return; }
    } catch {
      document.getElementById("header-user").textContent = "Local Mode";
    }

    this._bindFilters();
    this._bindImport();
    this._bindModals();

    this.loadSummary();
    this.loadEncounters();
    this.loadPoseFrames();
    this.loadConsensusStatus();
  },

  // ── Consensus freshness ────────────────────────────
  //
  // `refresh_all_consensus` had exactly one production caller: the button below.
  // Every student save DELETES the encounter's computed cache row, so an encounter
  // sits with no consensus at all until somebody clicks — and the table renders
  // that identically to "computed, and there was nothing to agree on". This says
  // which. It is also the only way to see from the UI whether the hourly cron is
  // running: `behind` should stay near zero and the timestamp should move.
  async loadConsensusStatus() {
    const el = document.getElementById("consensus-status");
    if (!el) return;
    try {
      const s = await API.get("/api/admin/consensus/status");
      const when = s.newest_computed_at ? String(s.newest_computed_at).slice(0, 16).replace("T", " ") : null;
      const parts = [when ? `last computed ${when}` : "never computed"];
      if (s.behind) parts.push(`${s.behind} encounter${s.behind === 1 ? "" : "s"} behind`);
      el.textContent = parts.join(" · ");
      el.title =`${s.computed_rows} computed row(s) · ${s.encounters_with_annotations} `
        + `encounter(s) with in-app annotations · ${s.archived_imports} archived legacy import(s). `
        + `"Behind" means the newest save is newer than the cached consensus, or none was ever computed.`;
    } catch {
      // A dashboard that fails to load one readout must still load. Silence here
      // is honest: no text at all, rather than a stale or invented timestamp.
      el.textContent = "";
    }
  },

  // ── Summary Cards ──────────────────────────────────

  async loadSummary() {
    try {
      const data = await API.get("/api/admin/encounters/summary");
      const cards = document.getElementById("summary-cards");

      if (data.total_encounters === 0) {
        cards.innerHTML = '<div class="summary-card"><div class="card-label">No priority data imported yet. Click "Import Priority CSV" to get started.</div></div>';
        return;
      }

      const siteStr = Object.entries(data.by_site || {}).map(([s, c]) => `${escapeHtml(s)}: ${c}`).join(" | ");

      const cs = data.consensus || {};
      const csColor = cs.avg_score >= 0.5 ? "var(--success)" : cs.avg_score > 0 ? "var(--warning)" : "var(--text-muted)";
      const csPct = cs.total_computed ? Math.round(cs.avg_score * 100) + "%" : "N/A";

      cards.innerHTML = `
        <div class="summary-card">
          <div class="card-value">${escapeHtml(data.total_encounters)}</div>
          <div class="card-label">Total Encounters</div>
          <div class="card-sub">${siteStr}</div>
        </div>
        <div class="summary-card">
          <div class="card-value">${escapeHtml(data.fully_done)}</div>
          <div class="card-label">Fully Completed</div>
        </div>
        <div class="summary-card">
          <div class="card-value" style="color:var(--danger)">${escapeHtml(data.zero_completions)}</div>
          <div class="card-label">Zero Completions</div>
        </div>
        <div class="summary-card">
          <div class="card-value" style="color:var(--warning)">${escapeHtml(data.not_in_folder)}</div>
          <div class="card-label">Not In Folder</div>
        </div>
        <div class="summary-card">
          <div class="card-value" style="color:var(--accent)">${escapeHtml(data.needs_work || 0)}</div>
          <div class="card-label">Needs More Work</div>
          <div class="card-sub">No/low/moderate consensus | ${escapeHtml(data.actively_assigned || 0)} actively assigned</div>
        </div>
        <div class="summary-card">
          <div class="card-value" style="color:${csColor}">${escapeHtml(csPct)}</div>
          <div class="card-label">Avg Consensus</div>
          <div class="card-sub">${escapeHtml(cs.total_computed || 0)} scored | H:${escapeHtml(cs.high||0)} M:${escapeHtml(cs.moderate||0)} NA:${escapeHtml(cs.needs_analysis||0)}</div>
        </div>
      `;

      this._renderAnnotatorStats(data.annotator_stats || []);
    } catch {
      document.getElementById("summary-cards").innerHTML =
        '<div class="summary-card"><div class="card-label">No priority data. Import the CSV first.</div></div>';
    }
  },

  _workloadTab: "quota",  // "quota" or "proficiency"
  _workloadData: null,

  _renderAnnotatorStats(stats) {
    const el = document.getElementById("annotator-stats");

    // Fetch live workload data for quota progress + proficiency
    API.get("/api/admin/workload").then(data => {
      this._workloadData = data;
      this._renderWorkloadPanel(el, data, stats);
    }).catch(() => {
      // Fallback to CSV-based stats if workload API not available
      if (!stats.length) { el.innerHTML = ""; return; }
      const maxCompleted = Math.max(...stats.map(s => s.completed));
      el.innerHTML = `
        <div class="section-label stats-toggle">
          ANNOTATOR COMPLETION RATES (click to toggle)
        </div>
        <div class="stats-body">
          ${stats.map(s => {
            const pct = s.total ? Math.round(100 * s.completed / s.total) : 0;
            const barW = maxCompleted ? Math.round(100 * s.completed / maxCompleted) : 0;
            return `<div class="stat-bar">
              <span class="stat-name">${escapeHtml(s.annotator_name)}</span>
              <div class="stat-track">
                <div class="stat-fill" style="width:${barW}%"></div>
              </div>
              <span class="stat-pct">${s.completed}/${s.total} (${pct}%)</span>
            </div>`;
          }).join("")}
        </div>
      `;
    });
  },

  _renderWorkloadPanel(el, data, stats) {
    const annotators = data.annotators || [];
    const semester = data.semester;
    if (!annotators.length && !(stats && stats.length)) { el.innerHTML = ""; return; }

    const semLabel = escapeHtml(semester ? semester.semester_name : "Current Semester");
    const tab = this._workloadTab;

    el.innerHTML = `
      <div class="section-label stats-toggle">
        ANNOTATOR WORKLOAD — ${semLabel} (click to toggle)
      </div>
      <div class="stats-body">
        <div class="workload-tabs">
          <button class="workload-tab ${tab === 'quota' ? 'active' : ''}" data-tab="quota">Quota</button>
          <button class="workload-tab ${tab === 'proficiency' ? 'active' : ''}" data-tab="proficiency">Proficiency</button>
        </div>
        <div id="workload-tab-content"></div>
      </div>
    `;

    // Bind tab clicks
    el.querySelectorAll(".workload-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        this._workloadTab = btn.dataset.tab;
        this._renderWorkloadPanel(el, data, stats);
      });
    });

    const content = el.querySelector("#workload-tab-content");
    if (tab === "quota") {
      this._renderQuotaTab(content, annotators);
    } else {
      this._renderProficiencyTab(content, annotators);
    }
  },

  _renderQuotaTab(container, annotators) {
    // Sort by quota completion percentage descending
    const sorted = [...annotators].sort((a, b) => {
      const pctA = (a.semester_quota || 150) > 0 ? (a.semester_completed || 0) / (a.semester_quota || 150) : 0;
      const pctB = (b.semester_quota || 150) > 0 ? (b.semester_completed || 0) / (b.semester_quota || 150) : 0;
      return pctB - pctA;
    });

    container.innerHTML = sorted.map(a => {
      const quota = a.semester_quota || 150;
      const done = a.semester_completed || 0;
      const pct = quota > 0 ? Math.round(100 * done / quota) : 0;
      const barW = Math.min(100, pct);
      const barColor = pct >= 100 ? "var(--success)" : pct >= 60 ? "var(--accent)" : "var(--warning)";
      const pending = a.pending_assignments || 0;
      const active = a.active_assignments || 0;
      return `<div class="stat-bar">
        <span class="stat-name" title="${escapeHtml(a.email)}">${escapeHtml(a.name || a.email)}</span>
        <div class="stat-track">
          <div class="stat-fill" style="width:${barW}%;background:${barColor}"></div>
        </div>
        <span class="stat-pct">
          ${done}/<span class="quota-editable" data-email="${escapeHtml(a.email)}" data-quota="${quota}" title="Click to edit quota">${quota}</span>
          (${pct}%)
          ${pending + active > 0 ? `<span class="badge-assigned">${pending + active} queued</span>` : ""}
        </span>
      </div>`;
    }).join("");

    // Bind inline quota editing
    container.querySelectorAll(".quota-editable").forEach(span => {
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        const current = parseInt(span.dataset.quota);
        const email = span.dataset.email;
        const input = document.createElement("input");
        input.type = "number";
        input.className = "quota-input";
        input.value = current;
        input.min = 1;
        input.max = 500;
        span.replaceWith(input);
        input.focus();
        input.select();

        const save = async () => {
          const val = parseInt(input.value) || current;
          try {
            await API.post("/api/admin/annotator-quota", { email, quota: val });
            this.loadSummary(); // re-render stats
          } catch (err) {
            alert("Failed to save quota: " + err.message);
          }
        };
        input.addEventListener("blur", save);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); save(); }
          if (ev.key === "Escape") { this.loadSummary(); }
        });
      });
    });
  },

  _renderProficiencyTab(container, annotators) {
    // Sort by proficiency_weight descending
    const sorted = [...annotators].sort((a, b) =>
      (b.proficiency_weight || 0) - (a.proficiency_weight || 0)
    );

    const profClass = (v) => v >= 0.8 ? "high" : v >= 0.5 ? "mid" : "low";

    container.innerHTML = `
      <table class="proficiency-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Proficiency</th>
            <th>Consensus</th>
            <th>Experience</th>
            <th class="col-right">Annotations</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map((a, i) => {
            const prof = a.proficiency_weight || 0;
            const profPct = Math.round(prof * 100);
            const cls = profClass(prof);
            const agree = a.consensus_agreement_rate;
            const agreeStr = agree != null ? Math.round(agree * 100) + "%" : "N/A";
            const agreePct = agree != null ? Math.round(agree * 100) : 0;
            const agreeCls = agree != null ? profClass(agree) : "low";
            const exp = a.experience_weight || 0.1;
            const count = a.annotation_count || 0;
            const isExpert = a.is_expert ? true : false;
            return `<tr>
              <td class="rank-num ${i < 3 ? 'top-3' : ''}">${i + 1}</td>
              <td title="${escapeHtml(a.email)}">${escapeHtml(a.name || a.email)}</td>
              <td class="prof-bar-cell">
                <div class="prof-bar-wrap">
                  <div class="prof-bar-track">
                    <div class="prof-bar-fill bar-${cls}" style="width:${profPct}%"></div>
                  </div>
                  <span class="prof-value val-${cls}">${profPct}%</span>
                </div>
              </td>
              <td class="prof-bar-cell">
                <div class="prof-bar-wrap">
                  <div class="prof-bar-track">
                    <div class="prof-bar-fill bar-${agreeCls}" style="width:${agreePct}%"></div>
                  </div>
                  <span class="prof-value val-${agreeCls}">${agreeStr}</span>
                </div>
              </td>
              <td><span class="tier-label">${exp.toFixed(1)}x</span></td>
              <td class="annot-count">${count}</td>
              <td>${isExpert ? '<span class="expert-badge">Expert</span>' : ''}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    `;
  },

  // ── Encounter Table ────────────────────────────────

  async loadEncounters() {
    const params = new URLSearchParams({
      site: this.filterSite,
      sort_by: this.sortBy,
      sort_dir: this.sortDir,
      offset: String(this.currentPage * this.pageSize),
      limit: String(this.pageSize),
      search: this.filterSearch,
      hide_not_in_folder: String(this.hideNIF),
    });
    try {
      const data = await API.get(`/api/admin/encounters?${params}`);
      this._renderTable(data.encounters);
      this._renderPagination(data.total);
    } catch {
      document.getElementById("encounter-tbody").innerHTML =
        '<tr><td colspan="6" class="muted center">No data. Import the priority CSV first.</td></tr>';
    }
  },

  /* ── One reading of "how good is this consensus", used everywhere it is shown ──
   *
   * The badge used to take its COLOUR from `quality_label` and its NUMBER from
   * `consensus_score`, and never compared them. A scar 3 of 20 raters reported and
   * 17 explicitly denied came back as consensus_score 0.15 with quality_label
   * "high", so the table painted a green badge reading "15%" — the strongest
   * colour in the palette on the weakest evidence in the corpus — and the Assign
   * button next to it was DISABLED with the tooltip "Already at full consensus".
   * The engine no longer produces that pair (`high` now also requires mean
   * agreement >= scars.consensus.high_agreement_min), but the display must not
   * depend on that: it renders whatever a cache row says, including rows written
   * by an older build and rows imported from the legacy Forms cohort, and none of
   * those are recomputed. So the class is the WEAKER of what the label claims and
   * what the number supports. A badge can be demoted by its own percentage; it can
   * never be promoted by its label.
   *
   * The two cuts are the repo's own, not new ones: 0.5 is
   * `scars.consensus.high_agreement_min` ("more than half the cohort"), and 0.7 is
   * the agreement bar Stream F and anchor already judge a cohort against.
   */
  consensusView(enc) {
    const RANK = { low: 0, moderate: 1, high: 2 };
    const CLS = ["consensus-low", "consensus-moderate", "consensus-high"];
    const label = enc.quality_label || null;
    const score = enc.consensus_score;
    const raters = enc.consensus_annotators;
    const ratersText = raters == null ? "" : ` · ${raters} annotator${raters === 1 ? "" : "s"}`;

    if (label === "needs_analysis") {
      return {
        kind: "needs_analysis", cls: "consensus-needs-analysis", text: "Needs Analysis",
        title: "Fewer than 2 annotators — there is nobody to agree with yet" + ratersText,
        assignHint: "Assign another annotator — consensus needs at least 2",
      };
    }
    if (score == null) {
      return {
        kind: "none", cls: "", text: "N/A",
        title: label ? `Quality "${label}" with no agreement score recorded${ratersText}`
                     : "No consensus computed for this encounter yet",
        assignHint: "Assign an annotator",
      };
    }
    const pct = Math.round(score * 100);
    const scoreRank = score >= 0.7 ? 2 : score >= 0.5 ? 1 : 0;
    const labelRank = RANK[label] === undefined ? scoreRank : RANK[label];
    const rank = Math.min(scoreRank, labelRank);
    const demoted = labelRank > rank;
    return {
      kind: "scored",
      cls: CLS[rank],
      // The bare "15%" read like a completion percentage next to a progress bar
      // that IS one. It is neither: it is the share of raters who agreed.
      text: `${pct}% agree`,
      title: `Mean per-scar agreement ${pct}%${ratersText}`
        + (label ? ` · quality "${label}"` : "")
        + (demoted ? ` — shown as ${["low", "moderate", "high"][rank]}: the stored label is `
                     + `stronger than the agreement behind it` : "")
        // Consensus is built FROM reported scars, so a scar the whole cohort
        // missed lowers nothing. Never let this read as "we found everything".
        + " · measures agreement among reported scars only",
      assignHint: rank >= 2
        ? "Assign another annotator (agreement is already high — extra eyes optional)"
        : "Assign another annotator — more raters is the only way agreement improves",
    };
  },

  _renderTable(encounters) {
    const tbody = document.getElementById("encounter-tbody");

    if (!encounters.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted center">No encounters match your filters.</td></tr>';
      return;
    }

    tbody.innerHTML = encounters.map(enc => {
      const pct = enc.total_annotators ? Math.round(100 * enc.completion_count / enc.total_annotators) : 0;
      const progressClass = pct < 30 ? "progress-low" : pct < 70 ? "progress-mid" : "progress-high";
      const videoStatus = enc.video_id
        ? `<span class="status-badge status-${escapeHtml(enc.video_status || "unassigned")}">${escapeHtml(enc.video_status || "linked")}</span>`
        : '<span class="muted">--</span>';
      const nifBadge = enc.not_in_folder ? ' <span class="badge-nif" title="Not in folder">!</span>' : "";
      const flagDot = enc.admin_flag
        ? ` <span class="flag-dot flag-${escapeHtml(enc.admin_flag)}" title="${escapeHtml(enc.admin_flag)}"></span>`
        : "";

      const cv = Dashboard.consensusView(enc);
      const consensusCell = cv.kind === "none"
        ? '<span class="muted" title="No consensus has been computed for this encounter">N/A</span>'
        : `<span class="consensus-badge ${cv.cls}" title="${escapeHtml(cv.title)}">${escapeHtml(cv.text)}</span>`;

      const assignedBadge = enc.active_assignments
        ? ` <span class="badge-assigned" title="${enc.active_assignments} pending/active assignments">+${enc.active_assignments}</span>`
        : "";

      // Assign is never disabled. It used to carry
      //   ${enc.quality_label === "high" ? ' disabled title="Already at full consensus"' : ""}
      // which blocked the action exactly where it was most needed: a disabled
      // control is a claim that doing the thing is pointless, and the only way an
      // encounter's agreement improves is by another human looking at it. The
      // claim was also false — "high" was reachable at 15% agreement, and even
      // now it only means the mean cleared 0.5. Advice belongs in a tooltip, not
      // in a locked button.
      return `<tr>
        <td><strong>${escapeHtml(enc.encounter_id)}</strong>${nifBadge}${flagDot}</td>
        <td>${escapeHtml(enc.site)}</td>
        <td>${enc.completion_count}/${enc.total_annotators}${assignedBadge}</td>
        <td><div class="progress-bar"><div class="progress-fill ${progressClass}" style="width:${pct}%"></div></div></td>
        <td>${consensusCell}</td>
        <td>${videoStatus}</td>
        <td>
          <button class="btn btn-sm btn-ghost btn-detail" data-enc="${escapeHtml(enc.encounter_id)}">Detail</button>
          <button class="btn btn-sm btn-primary btn-assign-enc" data-enc="${escapeHtml(enc.encounter_id)}" title="${escapeHtml(cv.assignHint)}">Assign</button>
        </td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll(".btn-detail").forEach(btn => {
      btn.addEventListener("click", () => this.showDetail(btn.dataset.enc));
    });
    tbody.querySelectorAll(".btn-assign-enc").forEach(btn => {
      btn.addEventListener("click", () => this.showAssignModal(btn.dataset.enc));
    });
  },

  _renderPagination(total) {
    const totalPages = Math.ceil(total / this.pageSize);
    const pg = document.getElementById("pagination");
    if (totalPages <= 1) { pg.innerHTML = ""; return; }

    pg.innerHTML = `
      <button class="btn btn-sm btn-ghost" ${this.currentPage === 0 ? "disabled" : ""} id="pg-prev">&lt; Prev</button>
      <span class="muted">Page ${this.currentPage + 1} of ${totalPages} (${total} encounters)</span>
      <button class="btn btn-sm btn-ghost" ${this.currentPage >= totalPages - 1 ? "disabled" : ""} id="pg-next">Next &gt;</button>
    `;
    document.getElementById("pg-prev")?.addEventListener("click", () => {
      if (this.currentPage > 0) { this.currentPage--; this.loadEncounters(); }
    });
    document.getElementById("pg-next")?.addEventListener("click", () => {
      if (this.currentPage < totalPages - 1) { this.currentPage++; this.loadEncounters(); }
    });
  },

  // ── Pose Frames Pool ────────────────────────────────

  async loadPoseFrames() {
    const section = document.getElementById("pose-frames-section");
    try {
      const stats = await API.get("/api/admin/pose-frames/stats");
      if (stats.total === 0) { section.style.display = "none"; return; }
      section.style.display = "";

      document.getElementById("pose-frames-summary").textContent =
        `${stats.total} total | ${stats.unassigned} unassigned | ${stats.assigned} assigned | ${stats.completed} completed`;

      const tbody = document.getElementById("pose-frames-tbody");
      if (stats.annotators.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="muted center">No assignments yet</td></tr>`;
      } else {
        tbody.innerHTML = stats.annotators.map(a =>
          `<tr>
            <td>${escapeHtml(a.annotator_email)}</td>
            <td>${a.pending}</td>
            <td>${a.in_progress}</td>
            <td>${a.completed}</td>
            <td><button class="btn btn-ghost btn-sm pose-assign-more" data-email="${escapeHtml(a.annotator_email)}">+15 more</button></td>
          </tr>`
        ).join("");

        tbody.querySelectorAll(".pose-assign-more").forEach(btn => {
          btn.addEventListener("click", async () => {
            const email = btn.dataset.email;
            btn.disabled = true;
            btn.textContent = "Assigning...";
            try {
              const res = await API.post("/api/admin/pose-frames/assign", { annotator_email: email, batch_size: 15 });
              btn.textContent = `+${res.count} assigned`;
              this.loadPoseFrames();
            } catch (e) {
              btn.textContent = "Error";
            }
          });
        });
      }

      // Populate the annotator dropdown for new assignments
      const select = document.getElementById("pose-assign-annotator");
      try {
        const workload = await API.get("/api/admin/workload");
        select.innerHTML = (workload.annotators || []).map(a =>
          `<option value="${escapeHtml(a.email)}">${escapeHtml(a.name || a.email)}</option>`
        ).join("");
      } catch {
        select.innerHTML = `<option value="">Could not load annotators</option>`;
      }

      // Bind assign button
      const assignBtn = document.getElementById("btn-pose-assign");
      const newBtn = assignBtn.cloneNode(true);
      assignBtn.parentNode.replaceChild(newBtn, assignBtn);
      newBtn.addEventListener("click", async () => {
        const email = document.getElementById("pose-assign-annotator").value;
        const batch = parseInt(document.getElementById("pose-assign-batch").value) || 15;
        const statusEl = document.getElementById("pose-assign-status");
        if (!email) { statusEl.textContent = "Select an annotator"; return; }
        newBtn.disabled = true;
        statusEl.textContent = "Assigning...";
        try {
          const res = await API.post("/api/admin/pose-frames/assign", { annotator_email: email, batch_size: batch });
          statusEl.textContent = `Assigned ${res.count} frames`;
          statusEl.style.color = "var(--success)";
          this.loadPoseFrames();
        } catch (e) {
          statusEl.textContent = "Error: " + e.message;
          statusEl.style.color = "var(--danger)";
        } finally {
          newBtn.disabled = false;
        }
      });
    } catch {
      section.style.display = "none";
    }
  },

  // ── Filters ────────────────────────────────────────

  _bindFilters() {
    document.getElementById("filter-site").addEventListener("change", (e) => {
      this.filterSite = e.target.value;
      this.currentPage = 0;
      this.loadEncounters();
    });

    let searchTimer;
    document.getElementById("filter-search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this.filterSearch = e.target.value.trim();
        this.currentPage = 0;
        this.loadEncounters();
      }, 300);
    });

    document.getElementById("filter-sort").addEventListener("change", (e) => {
      const [col, dir] = e.target.value.split(":");
      this.sortBy = col;
      this.sortDir = dir;
      this.currentPage = 0;
      this.loadEncounters();
    });

    document.getElementById("filter-hide-nif").addEventListener("change", (e) => {
      this.hideNIF = e.target.checked;
      this.currentPage = 0;
      this.loadEncounters();
    });
  },

  // ── Import ─────────────────────────────────────────

  _bindImport() {
    const fileInput = document.getElementById("priority-csv-input");

    document.getElementById("btn-import-priority").addEventListener("click", () => {
      fileInput.click();
    });

    document.getElementById("btn-import-priority-sheet").addEventListener("click", async () => {
      try {
        const config = await API.get("/api/admin/backup-config");
        const savedId = config.priority_sheet_id || "";
        const input = prompt(
          "Enter Google Sheet URL or ID for encounter priority data:" +
          (savedId ? `\n\nPrevious: ${savedId}` : ""),
          savedId
        );
        if (!input) return;
        const sheetName = prompt("Sheet/tab name (default: Sheet1):", "Sheet1");
        if (sheetName === null) return;

        // Ask BEFORE the button says "Importing..." — the server refuses this
        // without confirm:"true" because it rebuilds encounter_priority
        // wholesale, so any encounter missing from the sheet loses its admin
        // flag, admin notes and shark-catalog link (which becomes
        // dwc:organismID on publication) and does not come back.
        if (!confirm(
          "Re-importing replaces ALL encounter priority data.\n\n" +
          "Any encounter not present in this sheet will lose its admin flag, " +
          "admin notes and linked shark-catalog ID permanently.\n\n" +
          "Continue?"
        )) return;

        const btn = document.getElementById("btn-import-priority-sheet");
        btn.disabled = true;
        btn.textContent = "Importing...";

        const res = await API.post("/api/admin/encounters/import-sheet", {
          sheet_id: input,
          sheet_name: sheetName || "Sheet1",
          confirm: "true",
        });
        alert(
          `Imported ${res.imported} encounters from Sheet.\n` +
          `Skipped ${res.duplicates_skipped} duplicates.` +
          (res.errors?.length ? `\n${res.errors.length} errors.` : "")
        );
        this.loadSummary();
        this.loadEncounters();
      } catch (e) {
        alert("Sheet import failed: " + e.message);
      } finally {
        const btn = document.getElementById("btn-import-priority-sheet");
        btn.disabled = false;
        btn.textContent = "Import from Sheet";
      }
    });

    document.getElementById("btn-refresh-consensus").addEventListener("click", async () => {
      const btn = document.getElementById("btn-refresh-consensus");
      btn.disabled = true;
      btn.textContent = "Computing...";
      try {
        const res = await API.post("/api/admin/consensus/refresh", {});
        alert(`Consensus refreshed: ${res.computed} computed, ${res.insufficient} insufficient (< 2 annotators)`);
        this.loadSummary();
        this.loadEncounters();
        this.loadConsensusStatus();
      } catch (e) {
        alert("Refresh failed: " + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Refresh Consensus";
      }
    });

    // Historical import modal
    document.getElementById("btn-import-historical").addEventListener("click", () => {
      document.getElementById("hist-consensus-file").value = "";
      document.getElementById("hist-scar-file").value = "";
      document.getElementById("hist-status").textContent = "";
      document.getElementById("historical-modal").classList.remove("hidden");
    });
    document.getElementById("hist-cancel").addEventListener("click", () => {
      document.getElementById("historical-modal").classList.add("hidden");
    });
    document.getElementById("hist-upload").addEventListener("click", async () => {
      const consensusFile = document.getElementById("hist-consensus-file").files[0];
      const scarFile = document.getElementById("hist-scar-file").files[0];
      if (!consensusFile && !scarFile) {
        document.getElementById("hist-status").textContent = "Select at least one CSV file.";
        return;
      }
      const btn = document.getElementById("hist-upload");
      btn.disabled = true;
      btn.textContent = "Importing...";
      document.getElementById("hist-status").textContent = "Uploading and processing...";
      try {
        const fd = new FormData();
        if (consensusFile) fd.append("consensus_csv", consensusFile);
        if (scarFile) fd.append("scar_csv", scarFile);
        const res = await API.postForm("/api/admin/import-historical", fd);
        let msg = [];
        if (res.consensus) msg.push(`Consensus: ${res.consensus.imported} scored, ${res.consensus.priority_created || 0} new encounters`);
        if (res.scar_data) msg.push(`Scar data: ${res.scar_data.rows_processed} rows, ${res.scar_data.priority_created || 0} new encounters, ${res.scar_data.needs_analysis_flagged || 0} flagged`);
        document.getElementById("hist-status").textContent = msg.join(" | ");
        document.getElementById("hist-status").style.color = "var(--success)";
        this.loadSummary();
        this.loadEncounters();
        setTimeout(() => {
          document.getElementById("historical-modal").classList.add("hidden");
        }, 2500);
      } catch (e) {
        document.getElementById("hist-status").textContent = "Error: " + e.message;
        document.getElementById("hist-status").style.color = "var(--danger)";
      } finally {
        btn.disabled = false;
        btn.textContent = "Upload";
      }
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;

      const btn = document.getElementById("btn-import-priority");
      btn.disabled = true;
      btn.textContent = "Importing...";

      try {
        // Same stakes as the Sheet path: this rebuilds encounter_priority
        // wholesale. The server has always accepted confirm=true here, so the
        // only guard was the admin knowing what it does — make that explicit.
        if (!confirm(
          "Importing replaces ALL encounter priority data.\n\n" +
          "Any encounter not present in this CSV will lose its admin flag, " +
          "admin notes and linked shark-catalog ID permanently.\n\n" +
          "Continue?"
        )) return;

        const fd = new FormData();
        fd.append("file", file);
        fd.append("confirm", "true");
        const res = await API.postForm("/api/admin/encounters/import", fd);
        alert(`Imported ${res.imported} encounters, skipped ${res.duplicates_skipped} duplicates.` +
          (res.errors?.length ? `\n${res.errors.length} errors.` : ""));
        this.loadSummary();
        this.loadEncounters();
      } catch (e) {
        alert("Import failed: " + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Import Priority CSV";
        fileInput.value = "";
      }
    });
  },

  // ── Modals ─────────────────────────────────────────

  _bindModals() {
    // Close encounter detail modal
    document.getElementById("modal-close").addEventListener("click", () => {
      document.getElementById("encounter-modal").classList.add("hidden");
    });

    // Close assign modal
    document.getElementById("assign-cancel").addEventListener("click", () => {
      document.getElementById("assign-modal").classList.add("hidden");
    });

    // Confirm assign
    document.getElementById("assign-confirm").addEventListener("click", () => {
      this._doAssign();
    });

    // Smart assign modal
    document.getElementById("btn-smart-assign").addEventListener("click", () => {
      this.showSmartAssignModal();
    });
    document.getElementById("smart-assign-cancel").addEventListener("click", () => {
      document.getElementById("smart-assign-modal").classList.add("hidden");
    });
    document.getElementById("smart-assign-preview-btn").addEventListener("click", () => {
      this._smartAssignPreview();
    });
    document.getElementById("smart-assign-confirm").addEventListener("click", () => {
      this._smartAssignConfirm();
    });
    document.getElementById("smart-assign-annotator").addEventListener("change", (e) => {
      this._updateWorkloadDisplay(e.target.value);
    });

    // Annotator name map
    document.getElementById("btn-annotator-map").addEventListener("click", () => {
      this.showNameMapModal();
    });
    document.getElementById("map-close").addEventListener("click", () => {
      document.getElementById("map-modal").classList.add("hidden");
    });

    // Backup to Drive
    document.getElementById("btn-backup-drive").addEventListener("click", () => {
      this.backupToDrive();
    });

    // Sync flags to Sheets
    document.getElementById("btn-sync-flags").addEventListener("click", () => {
      this.syncFlagsToSheets();
    });

    // Sync Input Sheet (manual trigger)
    document.getElementById("btn-sync-input-sheet").addEventListener("click", () => {
      this.syncInputSheet(false);
    });

    // Auto-sync input sheet on load
    this._autoSyncInputSheet();

    // Set annotation export folder
    document.getElementById("btn-set-export-folder").addEventListener("click", () => {
      this.pickAnnotationExportFolder();
    });

    // Close modals on backdrop click
    document.querySelectorAll(".modal").forEach(modal => {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.add("hidden");
      });
    });
  },

  // ── Encounter Detail ───────────────────────────────

  _currentDetailEnc: "",

  async showDetail(encId) {
    try {
      const data = await API.get(`/api/admin/encounters/${encId}`);
      this._currentDetailEnc = encId;
      document.getElementById("modal-title").textContent = `Encounter: ${encId}`;

      // admin_flag holds the TRIAGE TIER imported by scripts (ROUTINE / DROP /
      // POSE-GOLD / DOMAIN). It is machine-owned and read by goal-weighted
      // assignment, so the dashboard displays it and never writes it. The old
      // editable dropdown offered an unrelated vocabulary
      // ('review'/'mirrored'/'mislabeled'/'skip') that matched no stored value, so
      // every save silently blanked the tier on 1,362 encounters.
      const TIER_LABEL = {
        "ROUTINE": "Routine", "DROP": "Drop", "POSE-GOLD": "Pose gold", "DOMAIN": "Domain",
      };
      const currentFlag = data.admin_flag || "";
      const currentNotes = data.admin_notes || "";

      let html = "";

      // ── Header info ──
      html += `<div style="margin-bottom:12px;">
        <strong>Site:</strong> ${escapeHtml(data.site)} &nbsp;|&nbsp;
        <strong>Completions:</strong> ${data.completion_count}/${data.total_annotators} &nbsp;|&nbsp;
        <strong>Video:</strong> ${data.video_id ? "Linked" : "Not linked"}
      </div>`;

      // ── Admin Notes + Flag ──
      html += `<div class="detail-section-label">ADMIN NOTES</div>
        <div class="admin-notes-section">
          <div class="admin-notes-row">
            <textarea class="admin-notes-textarea" id="detail-notes" placeholder="Add notes about this encounter...">${escapeHtml(currentNotes)}</textarea>
            <div style="display:flex;flex-direction:column;gap:6px;">
              <div class="admin-flag-badge" title="Triage tier, set by the import. Read-only here.">
                ${currentFlag ? escapeHtml(TIER_LABEL[currentFlag] || currentFlag) : "No tier"}
              </div>
              <button class="btn btn-sm btn-primary admin-notes-save" id="detail-notes-save">Save</button>
              <span class="admin-notes-saved" id="detail-notes-status"></span>
            </div>
          </div>
        </div>`;

      // ── CSV Annotator Comments (status="other") ──
      const comments = (data.completions || []).filter(c => c.status === "other" && c.raw_value);
      if (comments.length) {
        html += `<div class="detail-section-label">ANNOTATOR COMMENTS</div>
          <div class="csv-comments">`;
        for (const c of comments) {
          html += `<div class="csv-comment">
            <span class="csv-comment-name">${escapeHtml(c.annotator_name)}:</span>
            <span class="csv-comment-text">"${escapeHtml(c.raw_value)}"</span>
          </div>`;
        }
        html += `</div>`;
      }

      // ── Consensus + Voter Grid ──
      const cs = data.consensus;
      if (cs) {
        // Same reading as the table — one helper, so a badge cannot be honest in
        // one place and green-at-15% in the other.
        const cv = Dashboard.consensusView({
          quality_label: cs.quality_label,
          consensus_score: cs.consensus_score,
          consensus_annotators: cs.num_annotators,
        });
        // `get_cached_consensus` returns TWO populations when both exist: the
        // legacy Forms cohort (imported, never recomputable) and the in-app one.
        // The headline is whichever has more raters, so without this line a row
        // reading "20 annotators" can be a 2018 import while the students'
        // actual work sits at 1 rater underneath it — and only one of the two is
        // rebuildable by "Refresh Consensus".
        const src = cs.source === "import" ? "imported (legacy Forms cohort)" : "computed from in-app annotations";
        const both = (cs.imported && cs.computed)
          ? ` | also ${cs.source === "import" ? cs.computed.num_annotators + " in-app" : cs.imported.num_annotators + " imported"} rater(s)`
          : "";
        html += `<div class="detail-section-label">CONSENSUS QUALITY</div>
          <div class="consensus-summary">
            <span class="consensus-badge ${cv.cls}" title="${escapeHtml(cv.title)}">${escapeHtml(cv.text)}${cv.kind === "scored" && cs.quality_label ? ` (${escapeHtml(cs.quality_label)})` : ""}</span>
            <span class="muted">${cs.num_annotators} annotators | ${cs.reliable_scars}/${cs.num_scars} reliable scars | Avg confidence: ${cs.mean_confidence}</span>
            <span class="muted">Source: ${escapeHtml(src)}${escapeHtml(both)}</span>
          </div>`;

        // Voter grid
        if (cs.details && cs.details.length && cs.all_annotators && cs.all_annotators.length) {
          html += this._renderVoterGrid(cs);
        } else if (cs.details && cs.details.length) {
          // Fallback: old-style table if no voter data yet (pre-refresh cache)
          html += this._renderLegacyConsensusTable(cs);
        }
      } else {
        html += `<div class="detail-section-label">CONSENSUS QUALITY</div>
          <span class="muted">N/A (fewer than 2 annotators)</span>`;
      }

      // ── Completion Status ──
      const statusLabels = {
        completed: "Done",
        pending: "Not Done",
        not_in_folder: "Not in folder",
        other: "Other",
      };

      html += `<div class="detail-section-label">COMPLETION STATUS</div>
        <div class="detail-grid">`;
      for (const c of data.completions || []) {
        const label = statusLabels[c.status] || c.status;
        html += `<div class="detail-cell status-${c.status}">
            <div class="cell-name">${escapeHtml(c.annotator_name)}</div>
            <div class="cell-status">${escapeHtml(label)}</div>
          </div>`;
      }
      html += `</div>`;

      document.getElementById("modal-body").innerHTML = html;
      document.getElementById("encounter-modal").classList.remove("hidden");

      // Wire up save button
      document.getElementById("detail-notes-save")?.addEventListener("click", () => this._saveDetailNotes());
    } catch (e) {
      alert("Failed to load detail: " + e.message);
    }
  },

  async _saveDetailNotes() {
    const notes = document.getElementById("detail-notes")?.value || "";
    // No "flag" key: the server leaves admin_flag untouched when it is absent.
    const statusEl = document.getElementById("detail-notes-status");
    try {
      await API.post(`/api/admin/encounters/${this._currentDetailEnc}/notes`, { notes });
      if (statusEl) {
        statusEl.textContent = "Saved";
        statusEl.classList.add("show");
        setTimeout(() => statusEl.classList.remove("show"), 2000);
      }
      // Refresh table to update flag dots
      this.loadEncounters();
      // Auto-sync to Google Sheets (fire-and-forget)
      API.post("/api/admin/encounters/sync-flags", {}).catch(() => {});
    } catch (e) {
      if (statusEl) {
        statusEl.textContent = "Error";
        statusEl.style.color = "var(--danger)";
        statusEl.classList.add("show");
      }
    }
  },

  async syncFlagsToSheets() {
    const btn = document.getElementById("btn-sync-flags");
    if (btn) btn.disabled = true;
    try {
      const res = await API.post("/api/admin/encounters/sync-flags", {});
      if (res.url) {
        alert(`Synced ${res.count} flagged encounters to Google Sheets.\n${res.url}`);
      }
    } catch (e) {
      alert("Failed to sync flags: " + (e.message || "Unknown error"));
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  async syncInputSheet(silent = true) {
    const btn = document.getElementById("btn-sync-input-sheet");
    let sheetId = "";
    try {
      const config = await API.get("/api/admin/backup-config");
      sheetId = config.input_sheet_id || "";
    } catch { /* ignore */ }

    if (!sheetId) {
      if (silent) return; // auto-sync: no sheet configured, skip quietly
      const input = prompt("Enter Google Sheet URL or ID for scar data input:");
      if (!input) return;
      sheetId = input;
    }

    if (btn) { btn.disabled = true; btn.textContent = "Syncing..."; }
    try {
      const res = await API.post("/api/admin/encounters/import-input-sheet", {
        sheet_id: sheetId,
        sheet_name: "Form Responses 1",
      });
      const msg = `Synced: ${res.rows_processed || 0} rows, ${res.users_created || 0} new users, ${res.completions_created || 0} completions, ${res.consensus_computed || 0} consensus`;
      if (!silent) {
        alert(msg);
        this.loadSummary();
        this.loadEncounters();
      } else {
        console.log("[InputSheetSync]", msg);
        // Silently refresh data if new completions were created
        if (res.completions_created > 0 || res.users_created > 0) {
          this.loadSummary();
          this.loadEncounters();
        }
      }
    } catch (e) {
      if (!silent) alert("Input sheet sync failed: " + (e.message || "Unknown error"));
      else console.warn("[InputSheetSync] failed:", e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Sync Input Sheet"; }
    }
  },

  _autoSyncInputSheet() {
    // Fire-and-forget on dashboard load
    this.syncInputSheet(true);
  },

  _renderVoterGrid(cs) {
    const annotators = cs.all_annotators || [];
    const details = cs.details || [];
    if (!annotators.length || !details.length) return "";

    // Sort: most disputed first (lowest agreement_ratio)
    const sorted = [...details].sort((a, b) => (a.agreement_ratio || 0) - (b.agreement_ratio || 0));

    let html = "";

    // ── Section A: Agreement Summary Bars ──
    for (const d of sorted) {
      const scarLabel = `${d.scar_type} | ${d.side} | ${d.zone}`;
      const pct = Math.round((d.agreement_ratio || 0) * 100);
      const count = d.num_agreeing || 0;
      const total = cs.num_annotators || annotators.length;
      // `disputed` is NOT a weaker `unconfirmed`. Unconfirmed means too few people
      // spoke; disputed means people looked and said it is not there. Falling both
      // through to "Unconfirmed" renders an actively voted-down scar identically
      // to one nobody voted on — the opposite reading.
      const barClass = d.status === "confirmed" ? "bar-high"
        : d.status === "probable" ? "bar-moderate"
        : d.status === "disputed" ? "bar-disputed" : "bar-low";
      const statusClass = d.status === "confirmed" ? "status-confirmed"
        : d.status === "probable" ? "status-probable"
        : d.status === "disputed" ? "status-disputed" : "status-unconfirmed";
      const statusLabel = d.status === "confirmed" ? "Confirmed"
        : d.status === "probable" ? "Probable"
        : d.status === "disputed" ? "Disputed" : "Unconfirmed";

      html += `<div class="agreement-bar-row">
        <span class="agreement-scar-label" title="${escapeHtml(scarLabel)}">${escapeHtml(scarLabel)}</span>
        <div class="agreement-bar-track"><div class="agreement-bar-fill ${barClass}" style="width:${pct}%"></div></div>
        <span class="agreement-ratio">${count}/${total} (${pct}%)</span>
        <span class="agreement-status ${statusClass}">${statusLabel}</span>
      </div>`;
    }

    // ── Section B: Collapsible Voter Detail Grid ──
    const toggleId = "voter-detail-toggle-" + Date.now();
    const bodyId = "voter-detail-body-" + Date.now();
    html += `<div class="voter-detail-toggle" id="${toggleId}">Show voter details &#9660;</div>`;
    html += `<div class="voter-detail-body" id="${bodyId}">`;

    const shortName = (email) => {
      const local = email.split("@")[0];
      return local.charAt(0).toUpperCase() + local.slice(1).replace(/[._]/g, " ").split(" ")[0];
    };

    html += `<div class="voter-grid-wrap"><table class="voter-grid">`;
    html += `<thead><tr><th>Scar</th><th>Status</th>`;
    for (const a of annotators) {
      html += `<th class="voter-name" title="${escapeHtml(a)}">${escapeHtml(shortName(a))}</th>`;
    }
    html += `</tr></thead><tbody>`;

    for (const d of sorted) {
      const scarLabel = `${d.scar_type} | ${d.side} | ${d.zone}`;
      const rowClass = d.status === "confirmed" ? "row-confirmed"
        : d.status === "probable" ? "row-probable"
        : d.status === "disputed" ? "row-disputed" : "row-unconfirmed";
      const statusClass = d.status === "confirmed" ? "scar-status-confirmed"
        : d.status === "probable" ? "scar-status-probable"
        : d.status === "disputed" ? "scar-status-disputed" : "scar-status-unconfirmed";
      const statusLabel = d.status === "confirmed" ? "Confirmed"
        : d.status === "probable" ? "Probable"
        : d.status === "disputed" ? "Disputed" : "Unconfirmed";

      html += `<tr class="${rowClass}"><td class="scar-label">${escapeHtml(scarLabel)}</td>`;
      html += `<td class="${statusClass}">${statusLabel}</td>`;

      const voters = d.voters || [];
      const voterConf = d.voter_confidences || {};

      for (const a of annotators) {
        if (voters.includes(a)) {
          const conf = voterConf[a] || "?";
          const highConf = conf >= 4;
          html += `<td class="${highConf ? "vote-yes-high" : "vote-yes"}" title="${escapeHtml(a)}: confidence ${conf}">&#10003;(${conf})</td>`;
        } else {
          html += `<td class="vote-no">&#10007;</td>`;
        }
      }
      html += `</tr>`;
    }

    html += `</tbody></table></div>`;
    html += `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">
      &#10003;(n) = reported with confidence n &nbsp;|&nbsp; &#10007; = did not report this scar
    </div>`;
    html += `</div>`; // close voter-detail-body

    // Wire up toggle after DOM insertion (handled via event delegation in showDetail)
    setTimeout(() => {
      const toggle = document.getElementById(toggleId);
      const body = document.getElementById(bodyId);
      if (toggle && body) {
        toggle.addEventListener("click", () => {
          const expanded = body.classList.toggle("expanded");
          toggle.innerHTML = expanded ? "Hide voter details &#9650;" : "Show voter details &#9660;";
        });
      }
    }, 0);

    return html;
  },

  _renderLegacyConsensusTable(cs) {
    let html = `<table class="consensus-table"><thead><tr>
      <th>Side</th><th>Zone</th><th>Type</th><th>Color</th><th>Score</th><th>Conf</th><th>Status</th>
    </tr></thead><tbody>`;
    for (const d of cs.details) {
      const rowClass = d.status === "confirmed" ? "reliable"
        : d.status === "disputed" ? "disputed" : "unreliable";
      html += `<tr class="${rowClass}">
        <td>${escapeHtml(d.side)}</td><td>${escapeHtml(d.zone)}</td><td>${escapeHtml(d.scar_type)}</td><td>${escapeHtml(d.color)}</td>
        <td>${d.consensus_score == null && d.agreement_ratio == null ? "—" : Math.round((d.consensus_score || d.agreement_ratio || 0) * 100) + "%"}</td><td>${escapeHtml(String(d.mean_confidence))}</td>
        <td>${d.status === "confirmed" ? "Reliable"
          : d.status === "disputed" ? "Disputed" : "Weak"}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
    return html;
  },

  // ── Assign ─────────────────────────────────────────

  _currentAssignEnc: "",

  showAssignModal(encId) {
    this._currentAssignEnc = encId;
    document.getElementById("assign-enc-label").textContent = `Encounter: ${encId}`;
    document.getElementById("assign-email-input").value = "";
    document.getElementById("assign-priority-select").value = "medium";
    document.getElementById("assign-due-date").value = "";
    document.getElementById("assign-notes-input").value = "";
    document.getElementById("assign-status").textContent = "";
    document.getElementById("assign-modal").classList.remove("hidden");
    document.getElementById("assign-email-input").focus();
  },

  async _doAssign() {
    const email = document.getElementById("assign-email-input").value.trim();
    if (!email || !email.includes("@")) {
      document.getElementById("assign-status").textContent = "Enter a valid email address.";
      return;
    }

    const btn = document.getElementById("assign-confirm");
    btn.disabled = true;

    try {
      const res = await API.post(`/api/admin/encounters/${this._currentAssignEnc}/assign`, {
        annotator_email: email,
        priority: document.getElementById("assign-priority-select").value,
        due_date: document.getElementById("assign-due-date").value,
        notes: document.getElementById("assign-notes-input").value,
      });
      document.getElementById("assign-status").textContent =
        `Assigned! Video ID: ${res.video_id}`;
      document.getElementById("assign-status").style.color = "var(--success)";
      this.loadEncounters();
      setTimeout(() => {
        document.getElementById("assign-modal").classList.add("hidden");
      }, 1500);
    } catch (e) {
      document.getElementById("assign-status").textContent = "Error: " + e.message;
      document.getElementById("assign-status").style.color = "var(--danger)";
    } finally {
      btn.disabled = false;
    }
  },

  // ── Annotator Name Map ─────────────────────────────

  // ── Smart Assign ───────────────────────────────────

  _workloadData: [],

  async showSmartAssignModal() {
    const status = document.getElementById("smart-assign-status");
    const preview = document.getElementById("smart-assign-preview");
    status.textContent = "";
    preview.style.display = "none";
    preview.innerHTML = "";

    // Load workload data to populate annotator dropdown
    try {
      const data = await API.get("/api/admin/workload");
      this._workloadData = data.annotators || [];
      const semester = data.semester;
      const select = document.getElementById("smart-assign-annotator");
      select.innerHTML = this._workloadData.map(a => {
        const remaining = (a.semester_quota || 150) - a.semester_completed;
        return `<option value="${escapeHtml(a.email)}">${escapeHtml(a.name || a.email)} (${a.semester_completed}/${a.semester_quota || 150} this semester)</option>`;
      }).join("");

      if (this._workloadData.length) {
        this._updateWorkloadDisplay(this._workloadData[0].email);
      }

      document.getElementById("smart-assign-modal").classList.remove("hidden");
    } catch (e) {
      alert("Failed to load workload: " + e.message);
    }
  },

  _updateWorkloadDisplay(email) {
    const a = this._workloadData.find(w => w.email === email);
    const el = document.getElementById("smart-assign-workload");
    if (!a) { el.textContent = ""; return; }
    const quota = a.semester_quota || 150;
    const remaining = Math.max(0, quota - a.semester_completed);
    const pct = a.quota_pct || 0;
    el.innerHTML = `
      Pending: ${a.pending_assignments} | Active: ${a.active_assignments} |
      Quota: ${a.semester_completed}/<span class="quota-editable-sm" data-email="${escapeHtml(a.email)}" title="Click to edit">${quota}</span> (${pct}%) |
      <strong>${remaining} remaining</strong> |
      Weight: ${a.experience_weight}/${a.proficiency_weight}
    `;

    // Bind inline quota edit in workload display
    const span = el.querySelector(".quota-editable-sm");
    if (span) {
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        const input = document.createElement("input");
        input.type = "number";
        input.className = "quota-input-sm";
        input.value = quota;
        input.min = 1;
        input.max = 500;
        span.replaceWith(input);
        input.focus();
        input.select();

        const save = async () => {
          const val = parseInt(input.value) || quota;
          try {
            await API.post("/api/admin/annotator-quota", { email, quota: val });
            // Update local data and re-render
            a.semester_quota = val;
            a.quota_pct = val > 0 ? Math.round(100 * a.semester_completed / val) : 0;
            this._updateWorkloadDisplay(email);
            // Also update dropdown text
            const opt = document.querySelector(`#smart-assign-annotator option[value="${email}"]`);
            if (opt) opt.textContent = `${a.name || a.email} (${a.semester_completed}/${val} this semester)`;
          } catch (err) {
            alert("Failed to save quota: " + err.message);
            this._updateWorkloadDisplay(email);
          }
        };
        input.addEventListener("blur", save);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); save(); }
          if (ev.key === "Escape") { this._updateWorkloadDisplay(email); }
        });
      });
    }
  },

  async _smartAssignPreview() {
    const email = document.getElementById("smart-assign-annotator").value;
    const batch = document.getElementById("smart-assign-batch").value;
    const site = document.getElementById("smart-assign-site").value;
    const preview = document.getElementById("smart-assign-preview");
    const status = document.getElementById("smart-assign-status");

    try {
      status.textContent = "Loading candidates...";
      const data = await API.get(
        `/api/admin/encounters/candidates?limit=${batch}&site=${encodeURIComponent(site)}&exclude_annotator=${encodeURIComponent(email)}`
      );
      const candidates = data.candidates || [];
      if (!candidates.length) {
        preview.style.display = "block";
        preview.innerHTML = '<span class="muted">No candidates found matching criteria.</span>';
        status.textContent = "";
        return;
      }

      // Check quota warning
      const a = this._workloadData.find(w => w.email === email);
      const remaining = a ? Math.max(0, (a.semester_quota || 150) - a.semester_completed) : 999;
      let warning = "";
      if (candidates.length > remaining) {
        warning = `<div style="color:var(--warning);font-size:12px;margin-bottom:4px">Warning: batch (${candidates.length}) exceeds remaining quota (${remaining})</div>`;
      }

      preview.style.display = "block";
      preview.innerHTML = warning + candidates.map(c => {
        const label = c.quality_label || "none";
        const badge = label === "needs_analysis"
          ? '<span class="consensus-badge consensus-needs-analysis" style="font-size:10px">Needs Analysis</span>'
          : label === "none"
          ? '<span class="muted" style="font-size:10px">No data</span>'
          : `<span class="consensus-badge consensus-${label}" style="font-size:10px">${label}</span>`;
        const assigned = c.active_assignments
          ? `<span class="badge-assigned" style="font-size:10px">${c.active_assignments} assigned</span> `
          : "";
        return `<div style="font-size:12px;padding:3px 0;display:flex;justify-content:space-between">
          <span><strong>${escapeHtml(c.encounter_id)}</strong> (${escapeHtml(c.site)})</span>
          <span>${assigned}${badge}</span>
        </div>`;
      }).join("");
      status.textContent = `${candidates.length} encounters ready to assign`;
      status.style.color = "var(--text-label)";
    } catch (e) {
      status.textContent = "Preview failed: " + e.message;
      status.style.color = "var(--danger)";
    }
  },

  async _smartAssignConfirm() {
    const email = document.getElementById("smart-assign-annotator").value;
    const batch = parseInt(document.getElementById("smart-assign-batch").value);
    const site = document.getElementById("smart-assign-site").value;
    const btn = document.getElementById("smart-assign-confirm");
    const status = document.getElementById("smart-assign-status");

    if (!email) { status.textContent = "Select an annotator."; return; }

    btn.disabled = true;
    btn.textContent = "Assigning...";
    status.textContent = "Creating assignments...";

    try {
      const res = await API.post("/api/admin/encounters/smart-assign", {
        annotator_email: email,
        batch_size: batch,
        site: site,
      });
      status.textContent = `Assigned ${res.count} encounters to ${email}`;
      status.style.color = "var(--success)";
      this.loadSummary();
      this.loadEncounters();
      setTimeout(() => {
        document.getElementById("smart-assign-modal").classList.add("hidden");
      }, 2000);
    } catch (e) {
      status.textContent = "Error: " + e.message;
      status.style.color = "var(--danger)";
    } finally {
      btn.disabled = false;
      btn.textContent = "Assign Batch";
    }
  },

  // ── Drive Backup ──────────────────────────────────

  _pickerLoaded: false,

  async backupToDrive() {
    const btn = document.getElementById("btn-backup-drive");

    try {
      // 1. Get backup config (API key, saved folder)
      const config = await API.get("/api/admin/backup-config");

      // If we have a saved folder, offer to reuse or pick new
      if (config.data_backup_folder_id) {
        const reuse = confirm(
          `Use previously selected Drive folder?\n\nClick OK to backup to the same folder, or Cancel to pick a new folder.`
        );
        if (reuse) {
          await this._doBackup(config.data_backup_folder_id, btn);
          return;
        }
      }

      // 2. Need to pick a folder via Picker
      if (!config.picker_api_key) {
        alert(
          "Google Picker API key not configured.\n\n" +
          "To enable Drive folder selection:\n" +
          "1. Go to Google Cloud Console → APIs & Services\n" +
          "2. Enable 'Google Picker API'\n" +
          "3. Create an API Key\n" +
          "4. Add it to config.yaml as picker_api_key"
        );
        return;
      }

      // 3. Get access token for Picker
      const tokenData = await API.get("/api/auth/access-token");
      if (!tokenData.access_token) {
        alert("No access token available. Please re-login.");
        return;
      }

      // 4. Load and show Picker
      await this._showFolderPicker(
        tokenData.access_token,
        config.picker_api_key,
        btn
      );
    } catch (e) {
      alert("Backup failed: " + e.message);
    }
  },

  async _showFolderPicker(accessToken, apiKey, btn) {
    // Load Picker API if not loaded
    if (!this._pickerLoaded) {
      await new Promise((resolve, reject) => {
        if (typeof gapi === "undefined") {
          reject(new Error("Google API script not loaded"));
          return;
        }
        gapi.load("picker", { callback: resolve, onerror: reject });
      });
      this._pickerLoaded = true;
    }

    const view = new google.picker.DocsView()
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes("application/vnd.google-apps.folder");

    const picker = new google.picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .addView(view)
      .setTitle("Select backup folder")
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          const folder = data.docs[0];
          this._doBackup(folder.id, btn);
        }
      })
      .build();

    picker.setVisible(true);
  },

  async _doBackup(folderId, btn) {
    btn.disabled = true;
    btn.textContent = "Backing up...";

    try {
      const res = await API.post("/api/admin/backup-to-drive", {
        folder_id: folderId,
      });
      alert(
        `Backup complete!\n\n` +
        `${res.files_uploaded} files uploaded to ${res.folder_name}\n` +
        `Files: ${res.files.join(", ")}\n\n` +
        `View in Drive: ${res.folder_url}`
      );
    } catch (e) {
      alert("Backup failed: " + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Backup to Drive";
    }
  },

  // ── Annotation Export Folder ─────────────────────────

  async pickAnnotationExportFolder() {
    try {
      const config = await API.get("/api/admin/backup-config");
      if (!config.picker_api_key) {
        alert("Google Picker API key not configured. See config.yaml.");
        return;
      }
      const tokenData = await API.get("/api/auth/access-token");
      if (!tokenData.access_token) {
        alert("No access token. Please re-login.");
        return;
      }

      if (!this._pickerLoaded) {
        await new Promise((resolve, reject) => {
          if (typeof gapi === "undefined") {
            reject(new Error("Google API script not loaded"));
            return;
          }
          gapi.load("picker", { callback: resolve, onerror: reject });
        });
        this._pickerLoaded = true;
      }

      const view = new google.picker.DocsView()
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes("application/vnd.google-apps.folder");

      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(tokenData.access_token)
        .setDeveloperKey(config.picker_api_key)
        .addView(view)
        .setTitle("Select annotation export folder")
        .setCallback(async (data) => {
          if (data.action === google.picker.Action.PICKED) {
            const folder = data.docs[0];
            try {
              await API.post("/api/admin/set-annotation-folder", {
                folder_id: folder.id,
              });
              alert(`Annotation export folder set to: ${folder.name}`);
            } catch (e) {
              alert("Failed to save folder: " + e.message);
            }
          }
        })
        .build();
      picker.setVisible(true);
    } catch (e) {
      alert("Error: " + e.message);
    }
  },

  // ── Annotator Name Map ─────────────────────────────

  async showNameMapModal() {
    try {
      const data = await API.get("/api/admin/annotator-map");
      const mappings = data.mappings || [];

      let html = `<table class="map-table">
        <thead><tr><th>CSV Name</th><th>App Email</th><th></th></tr></thead>
        <tbody>`;

      for (const m of mappings) {
        html += `<tr>
          <td>${escapeHtml(m.csv_name)}</td>
          <td>
            <input type="email" class="map-email" data-name="${escapeHtml(m.csv_name)}"
                   value="${escapeHtml(m.user_email || "")}" placeholder="user@example.com" />
            <span class="map-saved" data-saved="${escapeHtml(m.csv_name)}">Saved</span>
          </td>
        </tr>`;
      }

      html += "</tbody></table>";
      document.getElementById("map-table-wrap").innerHTML = html;

      // Bind save on blur/enter
      document.querySelectorAll(".map-email").forEach(input => {
        const save = async () => {
          try {
            await API.post("/api/admin/annotator-map", {
              csv_name: input.dataset.name,
              user_email: input.value.trim(),
            });
            const saved = document.querySelector(`[data-saved="${input.dataset.name}"]`);
            if (saved) {
              saved.classList.add("show");
              setTimeout(() => saved.classList.remove("show"), 1500);
            }
          } catch (e) {
            alert("Save failed: " + e.message);
          }
        };
        input.addEventListener("blur", save);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
        });
      });

      document.getElementById("map-modal").classList.remove("hidden");
    } catch (e) {
      alert("Failed to load mappings: " + e.message);
    }
  },
};

// ─────────────────── Active Learning ───────────────────────────────

function initActiveLearning() {
  const modal = document.getElementById("al-modal");
  const statusEl = document.getElementById("al-status");
  const runBtn = document.getElementById("al-run");

  document.getElementById("btn-active-learning").addEventListener("click", () => {
    modal.classList.remove("hidden");
    statusEl.textContent = "";
    runBtn.disabled = false;
    runBtn.textContent = "Run Selection";
  });

  document.getElementById("al-cancel").addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    runBtn.textContent = "Running...";
    statusEl.textContent = "Starting active learning...";

    try {
      await API.post("/api/admin/active-learning/select", {
        model_path: document.getElementById("al-model-path").value.trim(),
        pool_dir: document.getElementById("al-pool-dir").value.trim(),
        labels_dir: document.getElementById("al-labels-dir").value.trim(),
        n_select: parseInt(document.getElementById("al-n-select").value) || 100,
        assign_to: document.getElementById("al-assign-to").value.trim(),
      });

      // Poll status
      const poll = setInterval(async () => {
        try {
          const status = await API.get("/api/admin/active-learning/status");
          statusEl.textContent = status.progress || status.status;
          if (status.status === "complete" || status.status === "error") {
            clearInterval(poll);
            runBtn.disabled = false;
            runBtn.textContent = "Run Selection";
            if (status.status === "complete" && status.result) {
              statusEl.textContent = `Done! Selected ${status.result.selected} frames`;
              if (status.result.selected > 0) {
                statusEl.textContent += ` → assigned to ${status.result.assigned_to}`;
              }
            }
          }
        } catch (e) {
          clearInterval(poll);
          statusEl.textContent = "Failed to get status: " + e.message;
          runBtn.disabled = false;
          runBtn.textContent = "Run Selection";
        }
      }, 2000);
    } catch (e) {
      statusEl.textContent = "Error: " + e.message;
      runBtn.disabled = false;
      runBtn.textContent = "Run Selection";
    }
  });
}

// ─────────────────── Export Training Data ──────────────────────────

function initExportTraining() {
  const modal = document.getElementById("export-modal");
  const statusEl = document.getElementById("export-status");
  const runBtn = document.getElementById("export-run");

  document.getElementById("btn-export-training").addEventListener("click", () => {
    modal.classList.remove("hidden");
    statusEl.textContent = "";
    runBtn.disabled = false;
    runBtn.textContent = "Export";
  });

  document.getElementById("export-cancel").addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    runBtn.textContent = "Exporting...";
    statusEl.textContent = "Starting export...";

    try {
      await API.post("/api/admin/export-training-data", {
        dataset_name: document.getElementById("export-name").value.trim(),
        val_split: parseFloat(document.getElementById("export-val-split").value) || 0.2,
        seed: parseInt(document.getElementById("export-seed").value) || 42,
      });

      // Poll status
      const poll = setInterval(async () => {
        try {
          const status = await API.get("/api/admin/export-training-data/status");
          statusEl.textContent = status.progress || status.status;
          if (status.status === "complete" || status.status === "error") {
            clearInterval(poll);
            runBtn.disabled = false;
            runBtn.textContent = "Export";
            if (status.status === "complete" && status.result) {
              const r = status.result;
              statusEl.innerHTML = `Done! ${r.train} train, ${r.val} val, ${r.negatives} negatives<br>`
                + `<a href="${r.download_url}" class="btn btn-primary btn-sm" style="margin-top:6px">Download ZIP</a>`;
            }
          }
        } catch (e) {
          clearInterval(poll);
          statusEl.textContent = "Failed to get status: " + e.message;
          runBtn.disabled = false;
          runBtn.textContent = "Export";
        }
      }, 2000);
    } catch (e) {
      statusEl.textContent = "Error: " + e.message;
      runBtn.disabled = false;
      runBtn.textContent = "Export";
    }
  });
}

// ─────────────────────── Practice review (plan 10 / v41) ───────────────────────
//
// A labeler who has finished their practice run is HARD-LOCKED out of new work
// until somebody here decides. That makes this surface the thing standing between
// a student and their afternoon, so it is rendered at the top of the dashboard and
// hidden completely when the queue is empty.
//
// `approve` governs the PERSON, `decision` governs the DATA. Kept as two separate
// controls rather than one "accept/reject" because they genuinely come apart: a
// labeler can be cleared to continue while their practice frames are still thrown
// away, and a run that needs redoing can still contain usable labels.
const PracticeReview = {
  async load() {
    const section = document.getElementById("practice-review-section");
    const list = document.getElementById("practice-review-list");
    const count = document.getElementById("practice-review-count");
    if (!section || !list) return;
    let rows = [];
    try {
      // /api/admin/mlops — these are admin-only routes and live on the admin
      // blueprint, NOT the annotator's /api/mlops prefix.
      const res = await fetch("/api/admin/mlops/practice?state=awaiting_review",
                              { credentials: "same-origin" });
      if (!res.ok) { section.style.display = "none"; return; }   // feature off / not admin
      rows = (await res.json()).practice || [];
    } catch (e) {
      section.style.display = "none";
      return;
    }
    if (!rows.length) { section.style.display = "none"; return; }

    section.style.display = "";
    if (count) count.textContent = `— ${rows.length} waiting`;
    list.innerHTML = rows.map((r) => {
      const items = (r.items || []).length;
      return `<div class="wq-review-row" data-spec="${r.spec_id}" data-who="${escapeHtml(r.annotator)}">
        <div class="wq-review-head">
          <span class="wq-review-who">${escapeHtml(r.annotator)}</span>
          <span class="wq-review-spec">${escapeHtml(r.spec_name)} · ${escapeHtml(r.task_type)}</span>
        </div>
        <div class="wq-review-items">
          ${escapeHtml(r.n_submitted)}/${escapeHtml(r.n_required)} submitted ·
          ${escapeHtml(items)} frame${items === 1 ? "" : "s"}
        </div>
        <div class="wq-review-actions">
          <textarea placeholder="Feedback (shown to them verbatim)"></textarea>
          <label><input type="checkbox" class="wq-include" /> Keep their work</label>
          <button class="btn btn-primary btn-sm wq-approve">Approve</button>
          <button class="btn btn-secondary btn-sm wq-reject">Send back</button>
        </div>
      </div>`;
    }).join("");

    list.querySelectorAll(".wq-approve, .wq-reject").forEach((btn) => {
      btn.addEventListener("click", () => this._submit(btn));
    });
  },

  async _submit(btn) {
    const row = btn.closest(".wq-review-row");
    const approve = btn.classList.contains("wq-approve");
    const feedback = row.querySelector("textarea").value.trim();
    const include = row.querySelector(".wq-include").checked;

    // Sending someone back with no explanation makes the gate feel arbitrary and
    // gives them nothing to act on — it is the one field that must not be empty.
    if (!approve && !feedback) {
      alert("Add feedback before sending it back.");
      row.querySelector("textarea").focus();
      return;
    }
    row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch(
        `/api/admin/mlops/practice/${row.dataset.spec}/${encodeURIComponent(row.dataset.who)}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
          credentials: "same-origin",
          body: JSON.stringify({
            approve,
            feedback,
            decision: include ? "include" : "discard",
          }),
        });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.load();
    } catch (e) {
      alert(`Review failed: ${e.message}`);
      row.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  },
};

// The ten less-used tools, one click away and grouped. Open state persists: an admin
// mid-import should not have to re-open the drawer after every page refresh.
const MoreTools = {
  KEY: "ssa.admin.moreOpen",
  init() {
    const btn = document.getElementById("btn-admin-more");
    const panel = document.getElementById("admin-more");
    if (!btn || !panel) return;
    const apply = (open) => {
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Fewer tools" : "More tools";
    };
    let open = false;
    try { open = localStorage.getItem(this.KEY) === "1"; } catch (e) { /* private mode */ }
    apply(open);
    btn.addEventListener("click", () => {
      open = panel.hidden;
      apply(open);
      try { localStorage.setItem(this.KEY, open ? "1" : "0"); } catch (e) { /* ignore */ }
    });
  },
};

// ───────────────── Drive resolver ─────────────────
//
// The residue the automated matcher refused to guess on. It is a UI rather than a
// script for one reason: you cannot choose between AN13120907_59108_1.mov and _3
// from filenames, but you can choose instantly from "7.1s / 27MB" versus
// "45.1s / 172MB". Candidates are fetched per row on expand, never as a sweep,
// because each one is an external Drive round trip.
const DriveResolver = {
  shown: 0,
  PAGE: 25,

  async load(reset = true) {
    const section = document.getElementById("drive-resolver-section");
    const list = document.getElementById("drive-resolver-list");
    const count = document.getElementById("drive-resolver-count");
    const more = document.getElementById("btn-resolver-more");
    if (!section || !list) return;
    if (reset) this.shown = 0;

    let data;
    try {
      const res = await fetch(`/api/admin/drive/unlinked?limit=${this.shown + this.PAGE}`,
                              { credentials: "same-origin" });
      if (!res.ok) { section.style.display = "none"; return; }
      data = await res.json();
    } catch (e) { section.style.display = "none"; return; }

    const rows = data.unlinked || [];
    if (!rows.length) { section.style.display = "none"; return; }
    section.style.display = "";
    this.shown = rows.length;
    if (count) count.textContent = `— ${data.total} with no Drive file`;
    if (more) more.style.display = rows.length < data.total ? "" : "none";

    list.innerHTML = rows.map((r) => `
      <div class="wq-review-row" data-video="${escapeHtml(r.id)}">
        <div class="wq-review-head">
          <span class="wq-review-who">${escapeHtml(r.video_name)}</span>
          <span class="wq-review-spec">${escapeHtml(r.encounter_code || "no code")}${
            r.site ? " · " + escapeHtml(r.site) : ""}</span>
        </div>
        <div class="dr-slot"><button class="btn btn-secondary btn-sm dr-find">Find in Drive</button></div>
      </div>`).join("");

    list.querySelectorAll(".dr-find").forEach((b) => {
      b.addEventListener("click", () => this.findFor(b.closest(".wq-review-row")));
    });
  },

  async findFor(row) {
    const slot = row.querySelector(".dr-slot");
    slot.innerHTML = '<span class="muted" style="font-size:12px">Searching Drive…</span>';
    let data;
    try {
      const res = await fetch(`/api/admin/drive/candidates/${encodeURIComponent(row.dataset.video)}`,
                              { credentials: "same-origin" });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (e) {
      slot.innerHTML = `<span class="muted" style="font-size:12px">Search failed: ${escapeHtml(e.message)}</span>`;
      return;
    }

    const cands = data.candidates || [];
    if (!cands.length) {
      slot.innerHTML = `<span class="muted" style="font-size:12px">No Drive file matches ${
        escapeHtml(data.encounter_code || "this row")}. It may not be uploaded.</span>`;
      return;
    }

    // "Keep all" is the PRIMARY action, and deliberately so. The encounter code is
    // site+date+sequence, so every candidate here is the same shark in the same
    // sighting. Picking one discards real footage from a corpus that is short of it.
    const multi = cands.length > 1
      ? `<div class="dr-all">
           <button class="btn btn-primary btn-sm dr-keep-all">Keep all ${cands.length} clips</button>
           <span class="dr-all-note">Same encounter, so same shark. Adds the others as their own clips.</span>
         </div>`
      : "";

    slot.innerHTML = multi + `<div class="dr-cands">${cands.map((c) => `
      <div class="dr-cand">
        ${c.thumbnail ? `<img class="dr-thumb" src="${escapeHtml(c.thumbnail)}" alt="" loading="lazy">`
                      : '<div class="dr-thumb dr-thumb-none"></div>'}
        <div class="dr-meta">
          <div class="dr-name">${escapeHtml(c.name)}${
            c.exact_name ? ' <span class="dr-exact">exact name</span>' : ""}</div>
          <div class="dr-facts">${c.duration_s != null ? escapeHtml(c.duration_s) + "s" : "duration ?"}
            · ${escapeHtml(c.size_mb)} MB${c.resolution ? " · " + escapeHtml(c.resolution) : ""}</div>
        </div>
        <div class="dr-actions">
          ${c.open_url ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(c.open_url)}"
             target="_blank" rel="noopener noreferrer">Preview</a>` : ""}
          <button class="btn btn-primary btn-sm dr-pick" data-drive="${escapeHtml(c.id)}">Link</button>
        </div>
      </div>`).join("")}</div>`;

    slot.querySelectorAll(".dr-pick").forEach((b) => {
      b.addEventListener("click", () => this.link(row, b.dataset.drive));
    });
    const all = slot.querySelector(".dr-keep-all");
    if (all) all.addEventListener("click", () => this.linkAll(row, cands));
  },

  async linkAll(row, cands) {
    row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    const names = {};
    cands.forEach((c) => { names[c.id] = c.name; });
    try {
      const res = await fetch(`/api/admin/drive/link-all/${encodeURIComponent(row.dataset.video)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        credentials: "same-origin",
        body: JSON.stringify({ drive_ids: cands.map((c) => c.id), names }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      row.remove();
      const left = document.querySelectorAll("#drive-resolver-list .wq-review-row").length;
      if (!left) this.load(true);
    } catch (e) {
      alert(`Keep all failed: ${e.message}`);
      row.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  },

  async link(row, driveId) {
    row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch(`/api/admin/drive/link/${encodeURIComponent(row.dataset.video)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        credentials: "same-origin",
        body: JSON.stringify({ drive_id: driveId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      row.remove();
      const left = document.querySelectorAll("#drive-resolver-list .wq-review-row").length;
      if (!left) this.load(true);
    } catch (e) {
      alert(`Link failed: ${e.message}`);
      row.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  },
};

// ── Answer keys: candidates → you annotate → the pool that gates everyone ──
//
// Hidden entirely unless mlops.datasets.gold is on, the same way PracticeReview
// hides itself: an unconfigured deploy must show no trace of a feature nobody
// opted into.
const GoldAdmin = {
  async load() {
    const section = document.getElementById("gold-section");
    if (!section) return;
    let body;
    try {
      const res = await fetch("/api/admin/mlops/gold?status=active",
        { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (!res.ok) return;                       // not admin / route absent
      body = await res.json();
      if (!body.enabled) return;                 // feature off
    } catch (e) {
      return;
    }
    section.style.display = "";
    document.getElementById("gold-refresh")
      ?.addEventListener("click", () => this.loadCandidates());
    document.getElementById("gold-task-type")
      ?.addEventListener("change", () => { this.render(); this.loadCandidates(); });
    this.render(body.gold || []);
    this.loadFlagged();
  },

  _taskType() {
    return document.getElementById("gold-task-type")?.value || "pose";
  },

  async render(rows) {
    const list = document.getElementById("gold-list");
    if (!list) return;
    if (!rows) {
      const res = await fetch(`/api/admin/mlops/gold?status=active&task_type=${this._taskType()}`,
        { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      rows = (await res.json()).gold || [];
    }
    const mine = rows.filter((g) => g.task_type === this._taskType());
    document.getElementById("gold-count").textContent =
      `— ${mine.length} for ${this._taskType()}`;
    if (!mine.length) {
      list.innerHTML = `<div class="muted" style="font-size:12px">
        No answer keys for this task yet. Until there are, labelers are cleared
        straight through rather than blocked.</div>`;
      return;
    }
    list.innerHTML = mine.map((g) => `
      <div class="wq-review-row" data-gold="${g.id}">
        <div class="wq-review-head">
          <img src="/api/admin/mlops/gold/${g.id}/thumb" class="dr-thumb gold-thumb" alt="">
          <span class="wq-review-who">${escapeHtml(g.video_id)}${
            g.frame_number != null ? ` · frame ${g.frame_number}` : ""}</span>
          <span class="wq-review-spec">${g.n_attempts} checked · ${g.n_passed} passed</span>
        </div>
        ${g.teach_note ? `<div class="wq-review-items">${escapeHtml(g.teach_note)}</div>` : ""}
        <div class="wq-review-actions">
          <button class="btn btn-sm btn-ghost" data-retire="${g.id}">Retire</button>
        </div>
      </div>`).join("");
    list.querySelectorAll("[data-retire]").forEach((b) => {
      b.addEventListener("click", () => this.retire(b.dataset.retire));
    });
    // Bound here, not as an inline onerror= attribute: this page ships
    // script-src 'self' with no 'unsafe-inline' (app.py), so an inline handler is
    // dropped by the browser and a broken-image icon is what you would actually see.
    list.querySelectorAll(".gold-thumb").forEach((img) => {
      img.addEventListener("error", () => { img.style.visibility = "hidden"; });
    });
  },

  async loadCandidates() {
    const box = document.getElementById("gold-candidates");
    const status = document.getElementById("gold-status");
    if (!box) return;
    status.textContent = "Looking…";
    try {
      const res = await fetch(
        `/api/admin/mlops/gold/candidates?task_type=${this._taskType()}&limit=12`,
        { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      const body = await res.json();
      const cands = body.candidates || [];
      status.textContent = "";
      if (!cands.length) {
        box.innerHTML = `<div class="muted" style="font-size:12px">
          No candidate frames — they come from work already annotated completely,
          so annotate a few frames first (or open any frame and use SAVE AS ANSWER KEY).
        </div>`;
        return;
      }
      box.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">
          Frames somebody already annotated completely. Open one, annotate it the way
          it should be done, then use SAVE AS ANSWER KEY.</div>` +
        cands.map((c) => `
          <div class="dr-cand">
            <div class="dr-meta">
              <div class="dr-name">${escapeHtml(c.video_name || c.video_id)}${
                c.frame_number != null ? ` · frame ${c.frame_number}` : ""}</div>
              <div class="dr-facts">${escapeHtml(c.annotator || "")}${
                c.is_expert ? " · expert" : ""} · ${
                this._taskType() === "pose" ? `${c.n_keypoints} points`
                                            : `${c.n_scars} scars`}</div>
            </div>
            <div class="dr-actions">
              <a class="btn btn-sm" target="_blank"
                 href="/?video=${encodeURIComponent(c.video_id)}&frame=${c.frame_number ?? 0}">
                 Open</a>
            </div>
          </div>`).join("");
    } catch (e) {
      status.textContent = `Could not load candidates: ${e.message}`;
    }
  },

  async loadFlagged() {
    const box = document.getElementById("gold-flagged");
    if (!box) return;
    try {
      const res = await fetch("/api/admin/mlops/gold/scorecards",
        { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      const body = await res.json();
      const rows = body.flagged || [];
      if (!rows.length) { box.innerHTML = ""; return; }
      // Says what it measures, and what it does NOT: gold only covers the frames a
      // person was actually shown, so this is never a coverage figure.
      box.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">
          Below the ${Math.round((body.pass_score || 0.7) * 100)}% bar on their recent
          checks. Agreement on the frames they were shown — not a measure of what the
          cohort missed.</div>` +
        rows.map((r) => `<div class="wq-review-row">
            <div class="wq-review-head">
              <span class="wq-review-who">${escapeHtml(r.annotator)}</span>
              <span class="wq-review-spec">${Math.round((r.mean_score || 0) * 100)}%
                over ${r.n} check${r.n === 1 ? "" : "s"}</span>
            </div>
          </div>`).join("");
    } catch (e) {
      box.innerHTML = "";
    }
  },

  async retire(goldId) {
    if (!confirm("Retire this answer key? Past results stay; it stops being served.")) return;
    try {
      const res = await fetch(`/api/admin/mlops/gold/${goldId}`, {
        method: "DELETE", credentials: "same-origin",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.render();
    } catch (e) {
      alert(`Could not retire: ${e.message}`);
    }
  },
};


/** Shark catalog — name an individual, and see the ones already named.
 *
 *  This is deliberately the smallest possible surface over the existing
 *  GET/POST /api/admin/catalog routes. It exists because there was no UI at all:
 *  naming an individual required curl, so in practice none ever was, which left
 *  every Darwin Core record without an organismID and the re-ID matcher unable to
 *  bootstrap. One name entered here breaks that deadlock.
 *
 *  Unlike the panels around it this does NOT hide itself when empty — an empty
 *  catalog is exactly when the form needs to be visible. */
const Catalog = {
  async load() {
    const list = document.getElementById("catalog-list");
    const count = document.getElementById("catalog-count");
    if (!list) return;
    try {
      const res = await API.get("/api/admin/catalog");
      const rows = res.sharks || res.items || (Array.isArray(res) ? res : []);
      if (count) count.textContent = rows.length ? `(${rows.length})` : "(none yet)";
      list.innerHTML = rows.length
        ? rows.map((s) => `
            <div class="wq-review-row" style="display:flex; gap:10px; align-items:baseline">
              <b>${escapeHtml(s.display_name || "")}</b>
              <span class="muted" style="font-size:11px; font-family:monospace">
                ${escapeHtml(s.organism_id || "no organismID")}</span>
              <span class="muted" style="font-size:12px">${escapeHtml(s.notes || "")}</span>
              <span class="muted" style="font-size:11px; margin-left:auto">
                ${s.encounter_count || 0} encounter${s.encounter_count === 1 ? "" : "s"}</span>
            </div>`).join("")
        : `<div class="muted" style="font-size:12px">No individuals yet. Naming one
             gives it a stable identity across every encounter and export.</div>`;
    } catch (e) {
      list.innerHTML = `<div class="muted" style="font-size:12px">Could not load the
        catalog: ${escapeHtml(e.message)}</div>`;
    }
  },

  async create() {
    const nameEl = document.getElementById("catalog-name");
    const notesEl = document.getElementById("catalog-notes");
    const btn = document.getElementById("btn-catalog-create");
    const name = (nameEl.value || "").trim();
    if (!name) { nameEl.focus(); return; }
    btn.disabled = true;
    try {
      await API.post("/api/admin/catalog", { display_name: name,
                                             notes: (notesEl.value || "").trim() });
      nameEl.value = ""; notesEl.value = "";
      await this.load();
    } catch (e) {
      alert(`Could not add that individual: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  },
};
// The stats headers used to carry onclick="this.parentElement.classList.toggle('collapsed')"
// inline. The dashboard is served with the same CSP as the annotator (script-src 'self'
// https://apis.google.com, no 'unsafe-inline'), so the browser refused to compile them —
// both collapsibles have been inert in production. Delegated because the headers are
// re-rendered by _renderWorkloadPanel on every tab switch and workload refresh.
document.addEventListener("click", (e) => {
  const toggle = e.target && e.target.closest && e.target.closest(".stats-toggle");
  if (toggle && toggle.parentElement) toggle.parentElement.classList.toggle("collapsed");
});

// Init on load
document.addEventListener("DOMContentLoaded", () => {
  const moreBtn = document.getElementById("btn-resolver-more");
  if (moreBtn) moreBtn.addEventListener("click", () => DriveResolver.load(false));
  DriveResolver.load();
  Dashboard.init();
  initActiveLearning();
  initExportTraining();
  PracticeReview.load();
  GoldAdmin.load();
  MoreTools.init();
  const catalogBtn = document.getElementById("btn-catalog-create");
  if (catalogBtn) catalogBtn.addEventListener("click", () => Catalog.create());
  Catalog.load();
});
