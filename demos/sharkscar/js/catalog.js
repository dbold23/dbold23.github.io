/* Stream A (re-ID) Phase A2 — admin "Suggested matches" panel (catalog.js).
 *
 * Surfaces the embedding matcher's k-NN suggestions (GET /api/admin/reid/matcher/suggestions) for
 * human review, and routes Accept/Reject to the EXISTING adjudication endpoint
 * (POST /api/admin/reid/individuals/<encounter>/decide). PROPOSE-ONLY: a catalog link is only
 * written when an admin clicks Accept. Self-mounting + defensive: if the matcher is disabled (route
 * 404s) or the user isn't an admin, the panel never appears. Bundled in templates/admin_dashboard.html.
 */
const Catalog = {
  base: '/api/admin/reid',
  el: null,

  async init() {
    try {
      const r = await this._api('/matcher/suggestions');           // probe: enabled + admin?
      if (!r.ok) return;
    } catch (e) { return; }
    this._mount();
    await this.refresh();
  },

  _api(path, opts) {
    opts = opts || {};
    return fetch(this.base + path, Object.assign({}, opts, {
      headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' },
        opts.headers || {}),
    }));
  },

  // escapeHtml (utils.js) is always loaded; the old guard's else-branch returned
  // the string UNESCAPED, so a load-order change would have turned 14 call sites
  // into an XSS with nothing to notice it.
  _esc(s) { return escapeHtml(s); },

  /** Hide preview thumbnails whose track has no best frame yet.
   *  This was an inline onerror="this.style.display='none'" attribute, which the
   *  dashboard's CSP (script-src 'self' https://apis.google.com) refuses to compile —
   *  the broken-image icon was shipping instead. Attached in the same synchronous turn
   *  as the innerHTML that created the <img>, so no error event can be missed. */
  _wireThumbFallback(root) {
    if (!root) return;
    root.querySelectorAll('img[data-hide-on-error]').forEach(img => {
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
  },

  _mount() {
    if (this.el) return;
    const d = document.createElement('section');
    d.id = 'reid-catalog-panel';
    d.style.cssText = 'margin:24px;padding:16px;border:1px solid #ccc;border-radius:8px;background:#fafafa;font-family:sans-serif';
    d.innerHTML = `
      <h2 style="margin:0 0 8px">Re-ID — suggested matches <span style="font-weight:normal;color:#888;font-size:13px">(propose-only)</span></h2>
      <div style="margin-bottom:10px">
        <button id="reid-run">Run matcher</button>
        <button id="reid-eval">Run eval</button>
        <button id="reid-refresh">Refresh</button>
        <span id="reid-status" style="margin-left:10px;color:#555"></span>
      </div>
      <div id="reid-metrics" style="font-size:13px;color:#333;margin-bottom:8px"></div>
      <div id="reid-suggestions"></div>`;
    (document.querySelector('main') || document.body).appendChild(d);
    this.el = d;
    d.querySelector('#reid-run').onclick = () => this.runMatcher();
    d.querySelector('#reid-eval').onclick = () => this.runEval();
    d.querySelector('#reid-refresh').onclick = () => this.refresh();
  },

  _status(msg) { const s = this.el && this.el.querySelector('#reid-status'); if (s) s.textContent = msg || ''; },

  async refresh() {
    let data;
    try { data = await (await this._api('/matcher/suggestions')).json(); }
    catch (e) { this._status('failed to load suggestions'); return; }
    const rows = (data && data.suggestions) || [];
    const box = this.el.querySelector('#reid-suggestions');
    if (!rows.length) { box.innerHTML = '<em>No suggestions. Run the matcher (needs catalogued individuals + track signatures).</em>'; return; }

    // group by query encounter
    const byEnc = {};
    rows.forEach(r => { (byEnc[r.query_encounter] = byEnc[r.query_encounter] || []).push(r); });
    let html = '';
    Object.keys(byEnc).sort().forEach(enc => {
      const list = byEnc[enc].sort((a, b) => a.rank - b.rank);
      const q = list[0];
      // An encounter carries ONE identity claim. Once one candidate is linked, accepting
      // another can only come back 409 conflict, and re-accepting the linked one restamps
      // decided_by/decided_at on the audit rows for a decision somebody already made.
      // So the Accept button is withdrawn for the whole encounter and the live link is
      // stated instead; Reject stays, because dismissing a suggestion touches no link.
      const linked = list.find(x => x.accepted) || null;
      html += `<div style="display:flex;gap:14px;align-items:flex-start;padding:10px 0;border-top:1px solid #eee">
        <div style="flex:0 0 140px">
          <img src="/api/tracks/${encodeURIComponent(q.query_track_id)}/preview" alt="" loading="lazy"
               data-hide-on-error style="width:140px;border-radius:4px;background:#eee">
          <div style="font-size:12px;color:#444">${this._esc(enc)} <span style="color:#999">(${this._esc(q.side)})</span></div>
        </div>
        <div style="flex:1">`;
      list.forEach(c => {
        const label = this._esc(c.candidate_label || ('catalog #' + c.candidate_catalog_id));
        const score = (typeof c.score === 'number') ? c.score.toFixed(3) : c.score;
        const done = c.accepted;
        let action;
        if (done) {
          action = '<span style="color:#2a7">✓ linked</span>';
        } else if (linked) {
          const other = this._esc(linked.candidate_label || ('catalog #' + linked.candidate_catalog_id));
          action = `<span style="color:#a60;font-size:12px" title="Unlink the encounter first — accepting this would overwrite an existing identity claim.">already linked to ${other}</span>
             <button data-rej="${enc}|${c.candidate_catalog_id}">Reject</button>`;
        } else {
          action = `<button data-acc="${enc}|${c.candidate_catalog_id}">Accept</button>
             <button data-rej="${enc}|${c.candidate_catalog_id}">Reject</button>`;
        }
        html += `<div style="display:flex;align-items:center;gap:8px;margin:3px 0">
          <span style="flex:0 0 28px;color:#999">#${c.rank}</span>
          <span style="flex:1"><strong>${label}</strong> <span style="color:#888">cos ${score}</span></span>
          ${action}
        </div>`;
      });
      html += `</div></div>`;
    });
    box.innerHTML = html;
    this._wireThumbFallback(box);
    box.querySelectorAll('button[data-acc]').forEach(b =>
      b.onclick = () => { const [e, c] = b.getAttribute('data-acc').split('|'); this.decide(e, parseInt(c, 10), 'accepted'); });
    box.querySelectorAll('button[data-rej]').forEach(b =>
      b.onclick = () => { const [e, c] = b.getAttribute('data-rej').split('|'); this.decide(e, parseInt(c, 10), 'rejected'); });
  },

  /** Turn a /decide response into what actually happened to the catalog.
   *
   *  `ok` alone is not the outcome: the endpoint reports `no_change` (nothing had an
   *  encounter_priority row), `conflict` (409 — refused, wrote nothing, needs an
   *  explicit relink), and a per-member split between newly linked, relinked and
   *  already-linked encounters. Reporting all of those as "accepted ok" tells an admin
   *  an identity claim was written when none was. */
  _decideSummary(j, httpStatus) {
    if (!j || typeof j !== 'object') return 'unexpected response (HTTP ' + httpStatus + ')';
    if (j.status === 'conflict' || httpStatus === 409) {
      // Goes to _status(), which assigns textContent — do NOT html-escape here.
      const c = (j.conflicts || [])
        .map(x => x.encounter + '→#' + (x.linked_catalog_id == null ? '?' : x.linked_catalog_id))
        .join(', ');
      return 'CONFLICT — nothing written; already linked: ' + (c || 'see server') + '.';
    }
    if (!j.ok) return 'error: ' + (j.error || ('HTTP ' + httpStatus));
    if (j.status === 'rejected') {
      const n = (j.members || []).length;
      return 'rejected — dismissed for ' + n + ' encounter' + (n === 1 ? '' : 's') + '.';
    }
    const bits = [];
    if (j.encounters_linked) bits.push(j.encounters_linked + ' linked');
    if (j.encounters_relinked) bits.push(j.encounters_relinked + ' RELINKED');
    if ((j.already_linked || []).length) bits.push((j.already_linked || []).length + ' already linked (no change)');
    if ((j.missing_encounters || []).length) bits.push((j.missing_encounters || []).length + ' with no encounter row');
    if ((j.conflicts || []).length) bits.push((j.conflicts || []).length + ' conflict');
    return 'accepted → catalog #' + j.catalog_id + ': ' + (bits.length ? bits.join(', ') : 'nothing changed') + '.';
  },

  async decide(encounter, catalogId, status) {
    this._status(status + ' ' + encounter + '…');
    try {
      const r = await this._api('/individuals/' + encodeURIComponent(encounter) + '/decide', {
        method: 'POST', body: JSON.stringify({ status, catalog_id: catalogId }),
      });
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      this._status(this._decideSummary(j, r.status));
    } catch (e) { this._status('request failed'); }
    await this.refresh();
  },

  async runMatcher() {
    this._status('starting matcher…');
    try {
      await this._api('/matcher/run', { method: 'POST', body: '{}' });
      // poll status
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const st = await (await this._api('/matcher/run/status')).json();
        this._status('matcher: ' + (st.status || '') + ' ' + (st.progress || ''));
        if (st.status === 'complete' || st.status === 'error') break;
      }
    } catch (e) { this._status('matcher failed to start'); }
    await this.refresh();
  },

  async runEval() {
    this._status('evaluating…');
    try {
      const m = await (await this._api('/matcher/eval')).json();
      const rec = m.recall_at || {}; const rnd = m.random_recall_at || {};
      const cells = Object.keys(rec).map(k => `recall@${k}=${rec[k]} <span style="color:#aaa">(rand ${rnd[k] ?? '–'})</span>`).join(' · ');
      this.el.querySelector('#reid-metrics').innerHTML =
        `<strong>Eval</strong> [${this._esc(m.model || 'auto')}] — ${cells} · mAP=${m.map} ·
         queries=${m.n_queries}, individuals=${m.n_eligible_individuals}`;
      this._status('eval done');
    } catch (e) { this._status('eval failed'); }
  },

  // ── Phase A3: scar healing / aging timeline (read-only, propose-only) ──
  // Mounts independently of the matcher panel: healing may be enabled while the matcher is off.
  healEl: null,

  async initHealing() {
    try {
      const r = await this._api('/healing/status');   // probe: enabled + admin?
      if (!r.ok) return;
    } catch (e) { return; }
    this._mountHealing();
    await this.refreshHealing();
  },

  _mountHealing() {
    if (this.healEl) return;
    const d = document.createElement('section');
    d.id = 'reid-healing-panel';
    d.style.cssText = 'margin:24px;padding:16px;border:1px solid #ccc;border-radius:8px;background:#fafafa;font-family:sans-serif';
    d.innerHTML = `
      <h2 style="margin:0 0 8px">Re-ID — scar healing / aging <span style="font-weight:normal;color:#888;font-size:13px">(propose-only · pink→white→black = fresh→old)</span></h2>
      <div style="margin-bottom:10px">
        <button id="heal-run">Run analysis</button>
        <button id="heal-refresh">Refresh</button>
        <span id="heal-status" style="margin-left:10px;color:#555"></span>
      </div>
      <div id="heal-summary" style="font-size:13px;color:#333;margin-bottom:8px"></div>
      <div id="heal-proposals"></div>`;
    (document.querySelector('main') || document.body).appendChild(d);
    this.healEl = d;
    d.querySelector('#heal-run').onclick = () => this.runHealing();
    d.querySelector('#heal-refresh').onclick = () => this.refreshHealing();
  },

  _healStatus(msg) { const s = this.healEl && this.healEl.querySelector('#heal-status'); if (s) s.textContent = msg || ''; },

  _trendColor(t) {
    return ({ healing: '#2a7', worsening: '#c33', new: '#e80', stable: '#888', inconclusive: '#aaa' })[t] || '#888';
  },

  async refreshHealing() {
    let st, data;
    try {
      st = await (await this._api('/healing/status')).json();
      data = await (await this._api('/healing/proposals')).json();
    } catch (e) { this._healStatus('failed to load'); return; }
    const sum = this.healEl.querySelector('#heal-summary');
    const byTrend = (st && st.by_trend) || {};
    const trendBits = Object.keys(byTrend).map(k =>
      `<span style="color:${this._trendColor(k)}">${this._esc(k)}: ${byTrend[k]}</span>`).join(' · ');
    sum.innerHTML = `${st.n_proposals || 0} scar trajectories across ${st.n_individuals || 0} individuals` +
      ` · ${st.resightable_individuals || 0} re-sightable in catalog${trendBits ? ' — ' + trendBits : ''}`;

    const rows = (data && data.proposals) || [];
    const box = this.healEl.querySelector('#heal-proposals');
    if (!rows.length) {
      box.innerHTML = '<em>No healing trajectories. Run the analysis (needs individuals with ≥2 dated sightings of the same scar — accept matcher suggestions first).</em>';
      return;
    }
    let html = '';
    rows.forEach(p => {
      const path = (p.color_path || []).filter(Boolean);
      const pathStr = path.length ? path.map(c => this._esc(c)).join(' → ') : '—';
      const area = (typeof p.area_change_frac === 'number')
        ? ` · area ${(p.area_change_frac * 100).toFixed(0)}%` : '';
      const conf = (typeof p.confidence === 'number') ? p.confidence.toFixed(2) : p.confidence;
      html += `<div style="padding:8px 0;border-top:1px solid #eee">
        <span style="display:inline-block;min-width:88px;font-weight:bold;color:${this._trendColor(p.trend)}">${this._esc(p.trend)}</span>
        <strong>${this._esc(p.display_name || ('catalog #' + p.catalog_id))}</strong>
        <span style="color:#666">— ${this._esc(p.scar_type || '?')} / ${this._esc(p.zone || '?')} / ${this._esc(p.side || '?')}</span>
        <div style="margin:2px 0 0 88px;font-size:13px;color:#444">
          colour ${pathStr} · stage→<strong>${this._esc(p.healing_stage_estimate)}</strong>${area}
          · ${p.n_sightings} sightings / ${p.span_days == null ? '?' : p.span_days}d · conf ${conf}
          ${p.notes ? `<span style="color:#999"> · ${this._esc(p.notes)}</span>` : ''}
          <button data-tl="${p.catalog_id}" style="margin-left:6px;font-size:12px">timeline</button>
        </div>
        <div id="heal-tl-${p.catalog_id}" style="margin:4px 0 0 88px"></div>
      </div>`;
    });
    box.innerHTML = html;
    box.querySelectorAll('button[data-tl]').forEach(b =>
      b.onclick = () => this.showTimeline(parseInt(b.getAttribute('data-tl'), 10)));
  },

  async showTimeline(catalogId) {
    const slot = this.healEl.querySelector('#heal-tl-' + catalogId);
    if (!slot) return;
    if (slot.dataset.open === '1') { slot.innerHTML = ''; slot.dataset.open = '0'; return; }
    slot.innerHTML = '<em>loading…</em>';
    let tl;
    try { tl = await (await this._api('/healing/individual/' + catalogId)).json(); }
    catch (e) { slot.innerHTML = '<em>failed to load timeline</em>'; return; }
    let html = '';
    (tl.scars || []).forEach(s => {
      html += `<div style="margin:4px 0;font-size:12px"><strong>${this._esc(s.scar_type || '?')} / ${this._esc(s.zone || '?')} / ${this._esc(s.side || '?')}</strong>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:3px">`;
      (s.sightings || []).forEach(o => {
        html += `<div style="text-align:center;width:96px">
          <img src="/api/tracks/${encodeURIComponent(o.track_id)}/preview" alt="" loading="lazy"
               data-hide-on-error style="width:96px;border-radius:3px;background:#eee">
          <div style="color:#555">${this._esc(o.obs_date || o.obs_year || '?')}</div>
          <div style="color:#888">${this._esc(o.color || '—')} (${this._esc(o.stage_label)})</div>
        </div>`;
      });
      html += `</div></div>`;
    });
    slot.innerHTML = html || '<em>no observations</em>';
    this._wireThumbFallback(slot);
    slot.dataset.open = '1';
  },

  async runHealing() {
    this._healStatus('starting…');
    try {
      await this._api('/healing/run', { method: 'POST', body: '{}' });
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const st = await (await this._api('/healing/run/status')).json();
        this._healStatus('analysis: ' + (st.status || '') + ' ' + (st.progress || ''));
        if (st.status === 'complete' || st.status === 'error') break;
      }
    } catch (e) { this._healStatus('failed to start'); }
    await this.refreshHealing();
  },
};

document.addEventListener('DOMContentLoaded', () => { Catalog.init(); Catalog.initHealing(); });
window.catalog = Catalog;
