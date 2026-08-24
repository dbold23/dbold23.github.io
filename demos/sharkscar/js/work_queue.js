/*
 * Stream D — the FED work queue (plan 10 D3).
 *
 * Replaces the annotator's free-choice assignment list with a rolling queue of
 * leased items the system chose. No search, no media filter, and no forward
 * visibility at all: exactly one card is shown — the next item, what kind of thing
 * it is, and why it was chosen. Everything else in the lease stays a count.
 *
 * Why: free choice lets people cherry-pick, and the pilot shows what that
 * produces — 69% of scars in two classes, 3 of 295 frames with a full skeleton,
 * and the rare whole-animal frames (~5% of footage) essentially never found.
 * A human scrubbing a 15s clip will not reliably land on the one second where
 * the animal is fully in shot. The queue will.
 *
 * SAFETY: entirely inert unless the server says mlops.datasets.enabled. On
 * {enabled:false} this module returns immediately and the existing list, search
 * and filter are untouched — so a deploy without the config change cannot
 * strand a student mid-semester. Same gating style as tracks.js on
 * /api/tracks/health.
 *
 * Admins are NOT put on the queue: they keep search/choose/assign for
 * spot-checks (server-side, /api/mlops/queue is per-user; this is the UI half).
 */
const WorkQueue = {
  enabled: false,
  items: [],
  missions: [],
  awaitingReview: false,
  _activeItemId: null,
  _autoOpenedId: null,

  async init() {
    try {
      const res = await API.get('/api/mlops/queue');
      if (!res || !res.enabled) return;          // inert — leave the UI alone
      const items = res.items || [];
      this.missions = res.missions || [];
      this.awaitingReview = !!res.awaiting_review;

      // Do NOT seize the panel on an empty queue. The flag being on does not mean
      // there is work: that is exactly the state right after enabling it and before
      // the first candidate scan, or once every spec is frozen. Taking over then
      // would hide the annotator's real assignments behind "Nothing queued right
      // now" with no way back — a config flag would have silently removed their
      // whole workload. Stay dormant instead; the assignment list keeps working.
      //
      // awaiting_review is the ONE empty state we must still take over for: the
      // labeler has finished practice and is deliberately locked out. Falling back
      // to the assignment list there would look like the lock had failed and hand
      // them exactly the free-choice work the gate exists to withhold.
      if (!items.length && !this.awaitingReview) {
        console.info('work queue enabled but empty — assignment list left in place');
        return;
      }
      this.enabled = true;
      this.items = items;
      this._takeOverLeftPanel();
      this.render();
      this._maybeAutoOpen('load');
      this._maybeTeach();
    } catch (e) {
      // Never break the annotator because the queue is unavailable.
      console.info('work queue unavailable — free-choice list unchanged', e);
    }
  },

  /** The mission the head of the queue belongs to, or the only one when locked. */
  activeMission() {
    const head = this._activeItemId ? this._find(this._activeItemId) : this.items[0];
    if (head) return this.missions.find((m) => m.spec_id === head.spec_id) || null;
    // Locked out: show the mission that is actually blocking.
    return this.missions.find((m) => m.practice && m.practice.state === 'awaiting_review')
        || this.missions[0] || null;
  },

  /** First arrival at a mission gets the tour that explains what it is FOR. */
  _maybeTeach() {
    const m = this.activeMission();
    if (!m || !window.Tutorial?.surfaceShown) return;
    window.Tutorial.surfaceShown('mission');
  },

  /** One short line: what this mission is for. The per-card gap_reason already says
   *  why each FRAME is here, so this must not restate it. */
  _missionPurpose(m) {
    if (m.notes) return m.notes;
    return m.task_type === 'pose'
      ? 'Place the 16-point skeleton.'
      : 'Box and classify scars.';
  },

  /** Hide the choose-your-own affordances. The Completed tab stays: past work is
   *  history, not a menu, so there is nothing to cherry-pick there. */
  _takeOverLeftPanel() {
    const search = document.getElementById('video-search');
    const filter = document.getElementById('media-type-filter');
    if (search) search.closest('.search-bar').style.display = 'none';
    if (filter) filter.style.display = 'none';
    const tabBtn = document.querySelector('.panel-left .tab-btn[data-tab="videos"]');
    if (tabBtn) tabBtn.textContent = 'Your queue';
  },

  _badge(taskType) {
    const color = { pose: 'var(--kp-color)', segment: 'var(--scar-color)',
      bbox: 'var(--body-color)', verify: 'var(--accent)' }[taskType] || 'var(--accent)';
    return `<span style="background:${color};color:#0f1117;border-radius:3px;
      padding:0 5px;font-size:10px;font-weight:700;text-transform:uppercase">${escapeHtml(taskType)}</span>`;
  },

  /** What the next item IS — as opposed to what you will DO to it, which is the task
   *  badge above. Two different questions, and with one card on screen the labeler
   *  has no list to infer the medium from any more.
   *
   *  The acoustic/RF/tag kinds are listed even though the queue serves frames of video
   *  today: an item carries whatever `kind` its source declares, and the day a signal
   *  source is queued an unmapped kind must degrade to its own name rather than to a
   *  blank chip. */
  KINDS: {
    frame: 'Frame',
    image: 'Frame',
    video: 'Video',
    audio: 'Sonogram',
    acoustic: 'Sonogram',
    rf: 'RF capture',
    sensor: 'Tag (AXY)',
    behavior: 'Ethogram',
  },

  _kind(it) {
    const raw = String(it.kind || it.source_kind || '').toLowerCase();
    if (raw) return this.KINDS[raw] || raw;
    if (it.media_type === 'image') return this.KINDS.image;
    // A work item on a clip is ONE FRAME of it, not the clip. Saying "video" would
    // promise fifteen seconds of work where there is a single still.
    if (it.frame_number != null) return this.KINDS.frame;
    return this.KINDS[it.media_type] || it.media_type || 'Item';
  },

  /** NEXT, or what kind of check this is.
   *
   *  A gold-backed frame is labelled rather than slipped in unmarked. The friendly
   *  name matters: the first few are a "Walkthrough" because that is what they are
   *  for — being shown how the lab does it — and the recurring one is a "Skill
   *  check", which is a thing colleagues do, not an exam. Hiding it would mean
   *  secretly marking somebody's ordinary work, which is a thing you do to subjects.
   */
  _checkTag(it) {
    if (!it.gold_id) return '<span class="wq-next-tag">NEXT</span>';
    return it.is_practice
      ? '<span class="wq-chip wq-chip-practice">Walkthrough</span>'
      : '<span class="wq-chip wq-chip-check">Skill check</span>';
  },

  /** The frame itself, where the gap-reason prose used to be.
   *
   *  A filename and a sentence ("whole animal, large in frame — lets you place
   *  anal_fin_tip, caudal_upper_tip") does not tell anybody what they are about to
   *  open. The picture does, in a fraction of the height. The reason is not thrown
   *  away — it becomes the image's tooltip and alt text, so it stays reachable and
   *  stays available to a screen reader.
   *
   *  The server answers 409 whenever the clip is not already on the box, because a
   *  thumbnail is not worth a Drive download. That is an ordinary state, not an
   *  error: the image hides itself and the placeholder underneath — which names the
   *  kind — shows through, and the card stays perfectly workable.
   *
   *  The failure handler is BOUND IN JS, not written as an `onerror=` attribute: the
   *  app ships `script-src 'self'` with no 'unsafe-inline' (app.py:203), so an inline
   *  handler is silently dropped by the browser and the broken-image icon is what the
   *  labeler would actually see. */
  _thumbHtml(it) {
    const why = it.gap_reason || '';
    const kind = this._kind(it);
    return `<div class="wq-thumb-wrap">
        <span class="wq-thumb-fallback" aria-hidden="true">${escapeHtml(kind)}</span>
        <img class="wq-thumb" src="/api/mlops/queue/${it.id}/thumb"
             alt="${escapeHtml(why || kind)}" title="${escapeHtml(why)}" loading="lazy">
      </div>`;
  },

  /** Hide a thumbnail that could not be fetched so the placeholder shows through.
   *  `src` is left alone — clearing it re-fires `error` in some browsers. */
  _bindThumbs(root) {
    root.querySelectorAll('.wq-thumb').forEach((img) => {
      img.addEventListener('error', () => img.classList.add('wq-thumb-missing'));
      if (img.complete && img.naturalWidth === 0) img.classList.add('wq-thumb-missing');
    });
  },

  /** Mission briefing + practice standing.
   *
   *  Shown ONLY while the labeler is still in the walkthrough. The briefing is
   *  teaching material — what this mission is for, how far through the walkthrough
   *  they are, what the reviewer said. Somebody approved weeks ago has read it, and
   *  leaving it pinned above every card spends the top third of a 220px rail
   *  restating a paragraph that has not changed since their first session. */
  _missionHtml() {
    const m = this.activeMission();
    if (!m) return '';
    const p = m.practice;
    // No walkthrough in progress → no briefing. Covers both the approved labeler and
    // a mission that opted out of practice entirely (practice_n: 0).
    if (!p || p.state === 'approved') return '';
    const practising = p && p.state === 'practicing';
    const locked = p && p.state === 'awaiting_review';

    let badge = '';
    if (practising) {
      badge = `<span class="wq-chip wq-chip-practice">Practice ${p.n_submitted + 1}/${p.n_required}</span>`;
    } else if (locked) {
      badge = '<span class="wq-chip wq-chip-locked">In review</span>';
    }

    // Feedback lives behind an icon rather than an always-open block. It is a few
    // sentences of prose that stays identical for days, so rendering it inline made
    // the panel taller than the queue it sits above and pushed the actual work down.
    // Hover or click reveals it; the dot alone is enough to say "there is something
    // here", which is all it needs to convey at rest.
    const fb = (practising && p.feedback)
      ? `<button type="button" class="wq-fb-btn" id="wq-fb-btn"
                 title="Feedback from your last attempt"
                 aria-label="Feedback from your last attempt">!</button>
         <span class="wq-fb-pop" id="wq-fb-pop">${escapeHtml(p.feedback)}</span>`
      : '';

    return `<div class="wq-mission" id="wq-mission">
        <div class="wq-mission-head">
          <span class="wq-mission-name">${escapeHtml(m.name)}</span>${badge}${fb}
        </div>
        <p class="wq-mission-purpose">${escapeHtml(this._missionPurpose(m))}</p>
      </div>`;
  },

  /** Click-to-pin the feedback popover. Hover alone is not enough: the text is long
   *  enough to want re-reading, and a touch device has no hover at all. */
  _bindFeedback() {
    const btn = document.getElementById('wq-fb-btn');
    const pop = document.getElementById('wq-fb-pop');
    if (!btn || !pop) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.classList.toggle('open');
    });
    document.addEventListener('click', () => pop.classList.remove('open'));
  },

  render() {
    const list = document.getElementById('video-list');
    if (!list) return;
    const mission = this._missionHtml();

    // Locked out after practice: say so plainly, and do not offer a way around it.
    // A "continue anyway" affordance here would make the hard gate a suggestion.
    if (this.awaitingReview && !this.items.length) {
      list.innerHTML = mission + `<p class="wq-note">
          Practice sent for review. New work unlocks once your lab lead has looked.</p>`;
      this._bindFeedback();
      return;
    }

    if (!this.items.length) {
      list.innerHTML = mission + `<p class="muted" style="padding:8px">
        Nothing queued right now. Ask an admin to run a candidate scan.</p>`;
      this._bindFeedback();
      return;
    }
    // ONE card: the next item and nothing past it — not the rest of the lease, not
    // even a count of it.
    //
    // The rest used to render dimmed, to show the queue was real. But a list is a menu
    // even when four of five rows are greyed out: it invites planning ("I'll do the
    // easy pose one third"), which is the cherry-picking this queue was built to
    // remove. A count said the same thing more quietly — how much is left is a
    // progress bar's job, not this card's.
    const it = this.items[0];
    const name = it.video_name || it.video_id || '(unknown)';
    const frame = (it.frame_number != null) ? ` · frame ${it.frame_number}` : '';

    list.innerHTML = mission + `
      <div class="video-item active wq-next" data-item="${it.id}">
        <div class="wq-next-head">
          <span class="wq-kind">${escapeHtml(this._kind(it))}</span>
          ${this._badge(it.task_type)}
          ${this._checkTag(it)}
        </div>
        ${this._thumbHtml(it)}
        <div class="wq-next-name">${escapeHtml(name)}${frame}</div>
        <div class="wq-next-actions">
          <button class="wq-skip" data-item="${it.id}">Can't annotate this</button>
        </div>
      </div>`;

    this._bindFeedback();
    this._bindThumbs(list);
    list.querySelectorAll('.video-item').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('.wq-skip')) return;
        this.open(parseInt(el.dataset.item, 10));
      });
    });
    list.querySelectorAll('.wq-skip').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.skip(parseInt(b.dataset.item, 10));
      });
    });
  },

  _find(itemId) { return this.items.find((i) => i.id === itemId); },

  /** Open a queued item — routes through _switchToItem, the same entry point the
   *  assignment list uses, so an unsaved frame is auto-saved before we navigate
   *  away and per-frame annotation caching behaves identically.
   *  Signature is (id, name, mediaType, encounterCode) — order matters. */
  open(itemId) {
    const it = this._find(itemId);
    if (!it || !it.video_id) return;
    this._activeItemId = itemId;
    this._startedAt = Date.now();
    // Awaited for the same reason the deep link awaits it: _switchToItem ends in
    // _loadVideoById, which unpins the frame, so presenting before it settles gets
    // undone a tick later.
    Promise.resolve(AppState._switchToItem(
      it.video_id,
      it.video_name || it.video_id,
      it.media_type || 'video',
      it.encounter_code || '',
    )).then(() => this._present(it));
    this._equipFor(it);
  },

  /** Open the head card without waiting for a click.
   *
   *  There is one card and no choosing, so making the labeler click it is asking
   *  them to confirm a decision the system already made. But opening is NOT free,
   *  and every guard below is a way it can cost somebody something:
   *
   *    · `_dirty`/`_saving` — `_switchToItem` SILENTLY saves and then `resetAll()`s.
   *      Auto-opening over live work would file a half-finished frame and wipe the
   *      canvas with no prompt (`beforeunload` does not fire on in-page navigation).
   *    · `gold_id` — a Walkthrough or Skill check must be READ before it is entered.
   *      The chip is the only place the labeler is told, and this repo's rule is that
   *      checks are labelled, not hidden. Dropping them straight in makes it covert.
   *    · unapproved practice — `_missionHtml` is the briefing AND the reviewer's
   *      written feedback. It is teaching material, and it is on the card.
   *    · `media_local` — on page load only. Otherwise arriving at the tab starts a
   *      Drive download plus a cold 4K HEVC decode, per labeler, for a clip nobody
   *      asked for yet. On advance the labeler is working and the warmer has been
   *      running since the lease.
   *    · a `?video=` deep link owns the canvas; the gold result panel is modal in
   *      intent even though it does not block.
   *    · once per item, ever — a failed complete returns the SAME id to the pool,
   *      and every refill would otherwise re-open the frame just finished.
   */
  _maybeAutoOpen(trigger) {
    const app = window.appState;
    const it = this.items[0];
    if (!this.enabled || !app || !it || !it.video_id) return;
    if (this._autoOpenedId === it.id) return;
    if (it.gold_id) return;
    const p = this.activeMission()?.practice;
    if (p && p.state !== 'approved') return;
    if (new URLSearchParams(location.search).has('video')) return;
    if (document.getElementById('gold-result')) return;
    if (app._saving || app._dirty) return;
    if (trigger === 'load' && (app.currentVideo || !it.media_local)) return;
    this._autoOpenedId = it.id;
    this.open(it.id);
    // An auto-open is not the moment work began. `complete()` already sends null
    // rather than a number here, which is honest; a tab left open over lunch would
    // otherwise record a 45-minute item in time_on_task_sec.
    this._startedAt = null;
  },

  /** Show the item the way its KIND deserves, rather than always as a video.
   *
   *  A card promises one thing — this frame, this clip, this sonogram — and the
   *  workspace should be that thing. For a frame the server decodes it and the
   *  player chrome goes away; scrubber, speed and play belong to a browsing task
   *  nobody on this queue is doing, and routing through the <video> element made
   *  the frame hostage to container decoding and to a seek that no-ops until
   *  metadata lands. Falling back to the player is deliberate: unavailable media
   *  should degrade to the old behaviour, never to a blank canvas.
   *
   *  Signal kinds (sonogram, RF, tag) are not dispatched here yet — nothing puts
   *  them in this queue, and the signals dock already owns rendering them. When
   *  they do land, this is the one place that has to learn about them. */
  /** Tasks whose unit of work is a CLIP, not a frame.
   *
   *  Scars cannot be judged from a still. A mark is only a scar if it stays on the
   *  skin while the animal moves; on one frame, glare, ripple and a fold of skin
   *  all look the same. So a scar card opens the whole clip at the suggested frame
   *  and the labeler moves through it, annotating whichever frames actually carry
   *  scars. Pose is the opposite — a clear whole-animal frame is exactly the unit,
   *  and scrubbing would only invite people to drift off the frame the queue chose
   *  for its coverage value. */
  CLIP_TASKS: ['bbox', 'segment', 'verify'],

  _present(it) {
    const app = window.appState;
    if (!app) return;
    if ((it.media_type || 'video') === 'image') return;   // a still IS the frame
    if (it.frame_number == null) { app._exitFrameMode?.(); return; }

    if (this.CLIP_TASKS.includes(it.task_type)) {
      app.showClip?.(it.video_id, it.frame_number, it.task_type);
      return;
    }
    app.showFrame?.(it.video_id, it.frame_number).then((ok) => {
      if (!ok) app.seekWhenReady?.(it.frame_number);
    });
  },

  /** Put the right tool in the labeler's hand for the task the system assigned.
   *
   *  The queue already decided this frame is here to close a keypoint gap or a scar
   *  gap; making them find the mode themselves is a step where the answer is already
   *  known. Deferred behind the same delay as the seek because the canvas is not
   *  ready until the media has loaded, and setMode on an empty canvas is dropped. */
  _equipFor(it) {
    const mode = it.task_type === 'pose' ? 'keypoint'
      : (it.task_type === 'bbox' || it.task_type === 'segment') ? 'scar'
      : null;
    if (!mode) return;
    setTimeout(() => {
      try {
        window.PanelUI?.refreshTask?.();     // pin the tab first…
        window.annotCanvas?.setMode?.(mode); // …then the drawing mode
      } catch (e) { /* tooling is a convenience; never block the annotation */ }
    }, 700);
  },

  /** Called by the save flow once an annotation for the active item is stored. */
  async complete(annotationId) {
    if (!this.enabled || this._activeItemId == null) return;
    const id = this._activeItemId;
    const secs = this._startedAt ? (Date.now() - this._startedAt) / 1000 : null;
    this._activeItemId = null;
    try {
      const res = await API.post(`/api/mlops/queue/${id}/complete`,
        { annotation_id: annotationId ?? null, time_on_task_sec: secs });
      // A gold-backed item comes back marked. Showing the result is the whole
      // point of the walkthrough — a gate that never tells you what you got wrong
      // teaches nothing — so it is surfaced immediately, before the refill.
      if (res?.check) window.GoldResult?.show(res.check);
    } catch (e) {
      // A 409 means the lease expired and the item went back to the pool. The
      // annotation is still saved — only the queue bookkeeping is lost.
      console.info('queue complete failed (lease likely expired)', e);
    }
    await this.refill();
  },

  /** Skips are KEPT with a reason — "this frame was unusable" is training signal
   *  for a quality filter, and silently dropping it throws that away.
   *
   *  Rendered inline rather than via window.prompt(): prompt() is blocked outright
   *  in some embedded browsers, and a modal for a one-tap choice is the wrong
   *  weight anyway. Buttons also constrain the answer to the five values the
   *  server records, instead of accepting free text and coercing it to "other". */
  REASONS: [
    ['blurry', 'Too blurry'],
    ['dark', 'Too dark'],
    ['occluded', 'Shark hidden'],
    ['no_animal', 'No shark here'],
    ['other', 'Something else'],
  ],

  skip(itemId) {
    const card = document.querySelector(`.video-item[data-item="${itemId}"]`);
    if (!card || card.querySelector('.wq-reasons')) return;   // already open
    const box = document.createElement('div');
    box.className = 'wq-reasons';
    box.style.cssText = 'margin-top:5px;display:flex;flex-wrap:wrap;gap:3px';
    box.innerHTML = '<div style="width:100%;font-size:11px;color:var(--text-muted)">Why not?</div>'
      + this.REASONS.map(([v, label]) =>
        `<button class="wq-reason" data-reason="${v}" data-item="${itemId}"
           style="font-size:10px;padding:1px 5px">${label}</button>`).join('')
      + '<button class="wq-reason-cancel" style="font-size:10px;padding:1px 5px">Cancel</button>';
    card.appendChild(box);

    box.querySelectorAll('.wq-reason').forEach((b) => {
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await this._sendSkip(itemId, b.dataset.reason);
      });
    });
    box.querySelector('.wq-reason-cancel').addEventListener('click', (ev) => {
      ev.stopPropagation();
      box.remove();
    });
  },

  async _sendSkip(itemId, reason) {
    try {
      await API.post(`/api/mlops/queue/${itemId}/skip`, { reason });
    } catch (e) {
      console.info('queue skip failed', e);
    }
    if (this._activeItemId === itemId) this._activeItemId = null;
    await this.refill();
  },

  async refill() {
    try {
      const res = await API.get('/api/mlops/queue');
      this.items = (res && res.items) || [];
      // Mission state must be re-read, not just the items: submitting the last
      // practice frame is precisely the moment the labeler flips to awaiting_review,
      // and a stale `missions` would leave the counter reading "PRACTICE 3 of 3"
      // over an empty queue with no explanation of why the work stopped.
      this.missions = (res && res.missions) || [];
      this.awaitingReview = !!(res && res.awaiting_review);
      this.render();
      this._maybeAutoOpen('advance');
    } catch (e) {
      console.info('queue refill failed', e);
    }
  },
};

window.WorkQueue = WorkQueue;
