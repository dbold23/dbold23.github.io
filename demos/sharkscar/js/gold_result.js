/*
 * How you did — shown right after a walkthrough frame or a skill check is saved.
 *
 * The point of marking against a gold standard is not the number. A labeler told
 * "0.62" has learned nothing; a labeler told "your dorsal_fin_tip is 40 px low and
 * you missed the scar on the left flank" has learned the task. So the score is the
 * small part of this panel and the per-part detail is the large part.
 *
 * Tone rules, deliberate:
 *   - Nothing here is styled as an error. Somebody in a walkthrough has done nothing
 *     wrong — they are being calibrated — and red framing at the exact moment a
 *     person is being judged reads as a reprimand.
 *   - A frame that could not be marked says so plainly and blames the answer key,
 *     because that is whose fault it is.
 *   - "Passed" is never claimed on a frame with no verdict.
 *
 * Inert unless the server returns a `check` block from the queue-completion call,
 * which only happens when mlops.datasets.gold is on.
 */
const GoldResult = {
  /** @param check {kind, result, run?} — the payload from /api/mlops/queue/<id>/complete */
  show(check) {
    if (!check || !check.result) return;
    this._close();
    const r = check.result;
    const el = document.createElement('div');
    el.className = 'gr-backdrop';
    el.id = 'gold-result';
    el.innerHTML = `<div class="gr-panel" role="dialog" aria-modal="true"
                         aria-labelledby="gr-title">
        <div class="gr-head">
          <span class="gr-kind">${check.kind === 'skill_check' ? 'Skill check' : 'Walkthrough'}</span>
          <h3 id="gr-title">${escapeHtml(this._headline(r))}</h3>
        </div>
        ${this._scoreHtml(r)}
        ${this._detailHtml(r)}
        ${r.teach_note ? `<p class="gr-note">${escapeHtml(r.teach_note)}</p>` : ''}
        ${this._runHtml(check.run)}
        <div class="gr-actions">
          <button class="btn btn-primary" id="gr-ok">Keep going</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    const done = () => this._close();
    el.querySelector('#gr-ok').addEventListener('click', done);
    el.addEventListener('click', (e) => { if (e.target === el) done(); });
    this._onKey = (e) => { if (e.key === 'Escape') done(); };
    document.addEventListener('keydown', this._onKey);
    el.querySelector('#gr-ok').focus();
  },

  _close() {
    document.getElementById('gold-result')?.remove();
    if (this._onKey) document.removeEventListener('keydown', this._onKey);
    this._onKey = null;
  },

  _headline(r) {
    if (r.score === null || r.score === undefined) return 'This one could not be marked';
    if (r.passed) return 'That matches the lab standard';
    return 'Worth a second look';
  },

  _scoreHtml(r) {
    if (r.score === null || r.score === undefined) {
      return `<p class="gr-unscored">The answer key for this frame is incomplete, so
        nothing you did here counts against you. A lab lead has been told.</p>`;
    }
    const pct = Math.round(r.score * 100);
    return `<div class="gr-score">
        <div class="gr-bar"><span style="width:${pct}%"></span></div>
        <div class="gr-pct">${pct}<span>%</span></div>
      </div>
      <p class="gr-sub">agreement with the lab's answer key${
        r.pass_score != null ? ` · the bar is ${Math.round(r.pass_score * 100)}%` : ''}</p>`;
  },

  _detailHtml(r) {
    if (r.task === 'pose') return this._poseDetail(r);
    if (r.task === 'scars') return this._scarDetail(r);
    return '';
  },

  _poseDetail(r) {
    const rows = (r.keypoints || []).filter((k) => k.status !== 'ok');
    if (!rows.length) {
      return `<p class="gr-allgood">All ${r.n_asked} points landed within
        ${r.tolerance_px} px of the answer key.</p>`;
    }
    return `<p class="gr-sub gr-detail-head">${rows.length} of ${r.n_asked} points to
        look at — the tolerance is ${r.tolerance_px} px:</p>
      <ul class="gr-list">${rows.map((k) => `<li>
        <span class="gr-name">${escapeHtml(k.name)}</span>
        <span class="gr-what">${k.status === 'missing'
          ? 'not placed' : `${k.distance} px away`}</span>
      </li>`).join('')}</ul>`;
  },

  _scarDetail(r) {
    const rows = (r.scars || []).filter((s) => s.status !== 'ok');
    const extra = r.n_extra
      ? `<li><span class="gr-name">${r.n_extra} extra box${r.n_extra > 1 ? 'es' : ''}</span>
           <span class="gr-what">not in the answer key</span></li>`
      : '';
    if (!rows.length && !extra) {
      return `<p class="gr-allgood">All ${r.n_gold} scars found and named the same way.</p>`;
    }
    return `<p class="gr-sub gr-detail-head">Compared with the answer key
        (${r.n_correct} of ${r.n_gold} matched):</p>
      <ul class="gr-list">${rows.map((s) => `<li>
        <span class="gr-name">${escapeHtml(s.scar_type || 'scar')} ·
          zone ${escapeHtml(String(s.zone ?? '?'))} ${escapeHtml(s.side || '')}</span>
        <span class="gr-what">${s.status === 'missed'
          ? 'you did not box this one'
          : `different ${s.disagreed.join(', ')}`}</span>
      </li>`).join('')}${extra}</ul>`;
  },

  /** The run verdict, when this frame finished a walkthrough. */
  _runHtml(run) {
    if (!run || !run.feedback) return '';
    const cls = run.state === 'approved' ? 'gr-run-open' : 'gr-run-again';
    return `<p class="gr-run ${cls}">${escapeHtml(run.feedback)}</p>`;
  },
};

window.GoldResult = GoldResult;
