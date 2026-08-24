/*
 * Stream B (MLOps) — admin control panel for the retrain orchestrator + eval gate.
 *
 * Self-injecting + self-contained (Stream B owns this file; the only shared edit is
 * the <script> tag in admin_dashboard.html). On load it fetches /api/admin/mlops/status
 * and renders a small panel: champion, latest run, and Trigger / Rollback / Models /
 * Runs controls. Inert + silent if the endpoints aren't reachable (e.g. the blueprint
 * failed to register) — never breaks the rest of the admin dashboard.
 *
 * Safety: "Trigger retrain" only QUEUES a run for the cron orchestrator (training never
 * runs in the request); a challenger is deployed only if it passes the eval gate AND
 * mlops.orchestrator.deploy.enabled is true.
 */
(function () {
  // utils.js loads first on the admin page; resolved lazily so importing this
  // file headless does not require the sibling to have run.
  const esc = (s) => escapeHtml(s);

  async function api(path, method, body) {
    const opts = {
      method: method || 'GET',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch('/api/admin/mlops' + path, opts);
    if (!r.ok) {
      let msg = 'http ' + r.status;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) { /* non-JSON */ }
      throw new Error(msg);
    }
    return r.json();
  }

  function mountPoint() {
    return document.querySelector('#mlops-admin-root') || document.querySelector('main')
      || document.querySelector('.container') || document.body;
  }

  function badge(on) {
    return `<span style="padding:1px 6px;border-radius:4px;font-size:11px;color:#fff;background:${
      on ? '#2e7d32' : '#9e9e9e'}">${on ? 'ON' : 'OFF'}</span>`;
  }

  function render(panel, s) {
    const champ = s.champion;
    const run = s.latest_run;
    panel.querySelector('#mlops-body').innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;margin-bottom:8px">
        <div>orchestrator ${badge(s.orchestrator_enabled)}</div>
        <div>auto-deploy ${badge(s.deploy_enabled)}</div>
        <div>golden set: <b>${esc(s.golden_set)}</b></div>
        <div>model type: <b>${esc(s.model_type)}</b></div>
      </div>
      <div style="font-size:13px;margin-bottom:6px">champion: ${champ
        ? `#${champ.id} v${esc(champ.version)} — metric <b>${esc(champ.primary_metric)}</b> (${esc(champ.golden_set)})`
        : '<i>none yet</i>'}</div>
      <div style="font-size:13px;margin-bottom:10px">latest run: ${run
        ? `#${run.id} <b>${esc(run.status)}</b> phase=${esc(run.phase)} gate=${esc(run.gate_pass)} — ${esc(run.trigger_reason)}`
        : '<i>none</i>'}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="mlops-trigger">Trigger retrain</button>
        <button id="mlops-rollback">Rollback champion</button>
        <button id="mlops-models">Models</button>
        <button id="mlops-runs">Runs</button>
      </div>
      <div id="mlops-detail" style="margin-top:10px;font-size:12px;font-family:monospace;white-space:pre-wrap"></div>
      <div id="mlops-drift" style="margin-top:12px;border-top:1px solid #eee;padding-top:8px">
        <i>loading drift…</i></div>`;

    const detail = panel.querySelector('#mlops-detail');
    panel.querySelector('#mlops-trigger').onclick = async () => {
      try { detail.textContent = JSON.stringify(await api('/trigger', 'POST'), null, 2); refresh(panel); }
      catch (e) { detail.textContent = 'trigger failed: ' + e.message; }
    };
    panel.querySelector('#mlops-rollback').onclick = async () => {
      if (!confirm('Roll back the champion model to the previous one?')) return;
      try { detail.textContent = JSON.stringify(await api('/rollback', 'POST'), null, 2); refresh(panel); }
      catch (e) { detail.textContent = 'rollback failed: ' + e.message; }
    };
    panel.querySelector('#mlops-runs').onclick = async () => {
      try {
        const d = await api('/runs');
        detail.textContent = (d.runs || []).map((r) =>
          `#${r.id} ${r.status} phase=${r.phase} gate=${r.gate_pass} ${r.trigger_reason}`).join('\n') || '(no runs)';
      } catch (e) { detail.textContent = 'runs failed: ' + e.message; }
    };
    panel.querySelector('#mlops-models').onclick = async () => {
      try {
        const d = await api('/models');
        detail.innerHTML = (d.models || []).map((m) =>
          `#${m.id} v${esc(m.version)} metric=${esc(m.primary_metric)} ${m.is_champion ? '★champion' : esc(m.status)} ` +
          (m.is_champion ? '' : `<button data-promote="${m.id}">promote</button>`)).join('<br>') || '(no models)';
        detail.querySelectorAll('button[data-promote]').forEach((b) => {
          b.onclick = async () => {
            if (!confirm('Promote model #' + b.dataset.promote + ' to champion?')) return;
            try { await api('/models/' + b.dataset.promote + '/promote', 'POST'); refresh(panel); b.click(); }
            catch (e) { detail.textContent = 'promote failed: ' + e.message; }
          };
        });
      } catch (e) { detail.textContent = 'models failed: ' + e.message; }
    };

    loadDrift(panel);
  }

  // ── B4 — drift & degradation sub-panel ──
  const SEV_COLOR = {
    alarm: '#c62828', warn: '#ef6c00', none: '#2e7d32',
    no_baseline: '#9e9e9e', insufficient_data: '#9e9e9e',
  };
  const fmtScore = (x) => (x == null ? '—' : (typeof x === 'number' ? x.toFixed(4) : esc(x)));

  function renderDrift(box, d) {
    const st = d.status || {};
    const sigs = (st.signals || {});
    const rows = Object.keys(sigs).map((k) => {
      const s = sigs[k];
      if (!s) return `<tr><td>${esc(k)}</td><td colspan="3"><i>no snapshot</i></td></tr>`;
      const col = SEV_COLOR[s.severity] || '#555';
      return `<tr><td>${esc(k)}</td>`
        + `<td style="color:${col};font-weight:600">${esc(s.severity)}</td>`
        + `<td>${fmtScore(s.score)}</td>`
        + `<td style="color:#888">${esc((s.computed_at || '').slice(0, 16))}</td></tr>`;
    }).join('');
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <b style="font-size:13px">Model health over time</b>
        <span style="font-size:12px">monitor ${badge(d.monitor_enabled)} · trigger ${badge(d.trigger_retrain)}
          ${d.status && d.status.alarm ? '<span style="color:#c62828;font-weight:600">⚠ ALARM</span>' : ''}</span>
      </div>
      <table style="width:100%;font-size:12px;border-collapse:collapse">
        <tr style="color:#888;text-align:left"><th>signal</th><th>severity</th><th>score</th><th>computed</th></tr>
        ${rows}
      </table>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button id="mlops-drift-check">Check now</button>
        <button id="mlops-drift-base">Re-baseline</button>
      </div>
      <div id="mlops-drift-detail" style="margin-top:6px;font-size:12px;font-family:monospace;white-space:pre-wrap"></div>`;
    const dd = box.querySelector('#mlops-drift-detail');
    box.querySelector('#mlops-drift-check').onclick = async () => {
      dd.textContent = 'running drift pass…';
      try { dd.textContent = JSON.stringify(await api('/drift/check', 'POST'), null, 2); loadDrift(box.closest('#mlops-admin-panel')); }
      catch (e) { dd.textContent = 'check failed: ' + e.message; }
    };
    box.querySelector('#mlops-drift-base').onclick = async () => {
      if (!confirm('Re-freeze drift baselines from current data? (do this right after a promote)')) return;
      try { dd.textContent = JSON.stringify(await api('/drift/baseline', 'POST'), null, 2); loadDrift(box.closest('#mlops-admin-panel')); }
      catch (e) { dd.textContent = 'baseline failed: ' + e.message; }
    };
  }

  async function loadDrift(panel) {
    const box = panel && panel.querySelector('#mlops-drift');
    if (!box) return;
    try { renderDrift(box, await api('/drift')); }
    catch (e) { box.innerHTML = '<i>drift status unavailable</i>'; }
  }

  async function refresh(panel) {
    try { render(panel, await api('/status')); }
    catch (e) { panel.querySelector('#mlops-body').innerHTML = '<i>mlops status unavailable</i>'; }
  }

  // ══════════════ plan 10 — dataset specs + gap dashboard ══════════════
  // The gap dashboard answers "is my keypoint representation uneven" directly,
  // by rendering the deficit the fed queue actually ranks on. What you see here
  // is what the annotators get handed next.

  // The admin dashboard is dark-themed (styles.css :root). Hardcoding a light
  // panel here left near-white inherited text on a near-white background —
  // invisible. Use the app's own variables, with light-theme fallbacks so the
  // panel still reads if the vars ever go away.
  const PANEL_CSS = 'margin:16px 0;padding:12px 14px;'
    + 'border:1px solid var(--border,#ddd);border-radius:8px;'
    + 'background:var(--bg-panel,#fafafa);color:var(--text-primary,#222)';
  const MUTED = 'var(--text-muted,#666)';
  const LABEL = 'var(--text-label,#888)';

  function bar(frac, color) {
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    return `<span style="display:inline-block;width:110px;height:9px;background:var(--bg-card,#e6e6e6);
      border-radius:5px;vertical-align:middle;overflow:hidden">
      <span style="display:block;width:${pct}%;height:100%;background:${color}"></span></span>`;
  }

  function renderGap(box, g) {
    const counts = g.counts || {};
    const names = Object.keys(counts);
    if (!names.length) {
      box.innerHTML = '<i>no annotations yet — the corpus is empty</i>';
      return;
    }
    const max = Math.max(1, ...names.map((k) => counts[k]));
    const weakest = new Set(g.weakest || []);
    // Sorted weakest-first: the top of this list is what the queue chases next.
    const rows = names.sort((a, b) => counts[a] - counts[b]).map((k) => {
      const n = counts[k];
      const weak = weakest.has(k);
      return `<tr${weak ? ' style="background:var(--bg-hover,#fff4f4)"' : ''}>
        <td style="padding:1px 6px 1px 0;${weak ? 'font-weight:600' : ''}">${esc(k)}</td>
        <td style="padding:1px 6px">${bar(n / max, weak ? 'var(--danger,#c62828)' : 'var(--success,#2e7d32)')}</td>
        <td style="padding:1px 0;text-align:right;font-variant-numeric:tabular-nums">${n}</td></tr>`;
    }).join('');
    box.innerHTML = `
      <div style="font-size:12px;color:${MUTED};margin-bottom:6px">
        ${esc(g.task_type)} — ${names.length} classes, ${g.distinct_covered} with at least one example.
        Weakest are highlighted; those are what the queue hands out first.
      </div>
      <table style="font-size:12px;border-collapse:collapse">${rows}</table>`;
  }

  function renderSpecs(box, specs) {
    if (!specs.length) {
      box.innerHTML = '<i>no dataset specs yet — create one below</i>';
      return;
    }
    const rows = specs.map((s) => `
      <tr>
        <td style="padding:2px 8px 2px 0"><b>${esc(s.name)}</b></td>
        <td style="padding:2px 8px">${esc(s.task_type)}</td>
        <td style="padding:2px 8px">${esc(s.status)}</td>
        <td style="padding:2px 8px;text-align:right">${s.target_n || '—'}</td>
        <td style="padding:2px 0">
          <button data-spec="${s.id}" data-act="progress">Progress</button>
          ${s.status !== 'active' ? `<button data-spec="${s.id}" data-act="active">Activate</button>` : ''}
          ${s.status === 'active' ? `<button data-spec="${s.id}" data-act="frozen">Freeze</button>` : ''}
        </td></tr>`).join('');
    box.innerHTML = `<table style="width:100%;font-size:12px;border-collapse:collapse">
      <tr style="color:${LABEL};text-align:left"><th>name</th><th>task</th><th>status</th>
        <th style="text-align:right">target</th><th></th></tr>${rows}</table>`;
  }

  async function loadDatasets(panel) {
    const gapBox = panel.querySelector('#ds-gap');
    const specBox = panel.querySelector('#ds-specs');
    const taskSel = panel.querySelector('#ds-gap-task');
    try { renderGap(gapBox, await api('/gap?task_type=' + encodeURIComponent(taskSel.value))); }
    catch (e) { gapBox.innerHTML = '<i>gap unavailable: ' + esc(e.message) + '</i>'; }
    try { renderSpecs(specBox, (await api('/specs')).specs || []); }
    catch (e) { specBox.innerHTML = '<i>specs unavailable: ' + esc(e.message) + '</i>'; }
  }

  function initDatasets() {
    if (document.querySelector('#datasets-admin-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'datasets-admin-panel';
    panel.style.cssText = PANEL_CSS;
    panel.innerHTML = `
      <h3 style="margin:0 0 8px;font-size:15px">Datasets &amp; work queue</h3>
      <div style="font-size:12px;color:${MUTED};margin-bottom:8px">
        Annotators are FED from active specs — they don't choose. Only <b>active</b>
        specs dispatch. Candidates come from <code>scripts/scan_candidates.py</code>
        (inference never runs in a request).
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <b style="font-size:13px">Coverage gap</b>
        <select id="ds-gap-task" style="font-size:12px">
          <option value="pose">pose (keypoints)</option>
          <option value="segment">scars (classes)</option>
        </select>
        <button id="ds-refresh" style="font-size:12px">Refresh</button>
      </div>
      <div id="ds-gap" style="margin-bottom:12px"><i>loading…</i></div>
      <div style="border-top:1px solid #eee;padding-top:8px">
        <b style="font-size:13px">Specs</b>
        <div id="ds-specs" style="margin:6px 0"><i>loading…</i></div>
        <details style="font-size:12px">
          <summary style="cursor:pointer">New spec</summary>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px">
            <input id="ds-name" placeholder="pose_v5" style="font-size:12px;width:120px">
            <select id="ds-task" style="font-size:12px">
              <option value="pose">pose</option><option value="segment">segment</option>
              <option value="bbox">bbox</option><option value="verify">verify</option>
            </select>
            <input id="ds-target" type="number" placeholder="target n" style="font-size:12px;width:90px">
            <input id="ds-perkp" type="number" placeholder="per-keypoint" style="font-size:12px;width:105px"
              title="pose only: how many frames should show each of the 16 points">
            <button id="ds-create">Create</button>
          </div>
        </details>
        <div id="ds-detail" style="margin-top:8px;font-size:12px;font-family:monospace;white-space:pre-wrap"></div>
      </div>`;
    mountPoint().appendChild(panel);

    const detail = panel.querySelector('#ds-detail');
    panel.querySelector('#ds-refresh').onclick = () => loadDatasets(panel);
    panel.querySelector('#ds-gap-task').onchange = () => loadDatasets(panel);

    panel.querySelector('#ds-create').onclick = async () => {
      const name = panel.querySelector('#ds-name').value.trim();
      if (!name) { detail.textContent = 'name is required'; return; }
      const perkp = parseInt(panel.querySelector('#ds-perkp').value, 10);
      const body = {
        name,
        task_type: panel.querySelector('#ds-task').value,
        target_n: parseInt(panel.querySelector('#ds-target').value, 10) || 0,
        requirements: isNaN(perkp) ? {} : { target_per_keypoint: perkp },
      };
      try {
        detail.textContent = JSON.stringify(await api('/specs', 'POST', body), null, 2);
        loadDatasets(panel);
      } catch (e) { detail.textContent = 'create failed: ' + e.message; }
    };

    panel.querySelector('#ds-specs').onclick = async (ev) => {
      const btn = ev.target.closest('button[data-spec]');
      if (!btn) return;
      const id = btn.dataset.spec;
      const act = btn.dataset.act;
      try {
        if (act === 'progress') {
          detail.textContent = JSON.stringify(await api('/specs/' + id + '/progress'), null, 2);
        } else {
          if (act === 'frozen' && !confirm('Freeze this spec? It stops dispatching to annotators.')) return;
          await api('/specs/' + id + '/status', 'POST', { status: act });
          loadDatasets(panel);
        }
      } catch (e) { detail.textContent = act + ' failed: ' + e.message; }
    };

    loadDatasets(panel);
  }

  function init() {
    let panel = document.querySelector('#mlops-admin-panel');
    if (panel) { initDatasets(); return; }
    panel = document.createElement('section');
    panel.id = 'mlops-admin-panel';
    panel.style.cssText = PANEL_CSS;
    panel.innerHTML = '<h3 style="margin:0 0 8px;font-size:15px">Model training</h3><div id="mlops-body"><i>loading…</i></div>';
    mountPoint().appendChild(panel);
    refresh(panel);
    initDatasets();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
