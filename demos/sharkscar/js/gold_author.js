/*
 * Authoring the answer key, from inside the ordinary annotator.
 *
 * A gold standard has to be made the same way the work is made — same canvas, same
 * form, same 16 points — or it is not the same task. So this adds ONE admin-only
 * button beside SAVE: annotate the frame the way it should be done, then keep it as
 * the answer key for that frame.
 *
 * Self-contained, like tracks.js and roi.js: it reads the same three globals the
 * save flow reads and adds nothing to app.js. Entirely inert for non-admins and
 * whenever mlops.datasets.gold is off — the button is not merely hidden, it is
 * never revealed, and the server checks admin again anyway.
 */
const GoldAuthor = {
  enabled: false,

  async init() {
    const btn = document.getElementById('btn-save-gold');
    if (!btn) return;
    try {
      // Cheapest admin+feature probe there is: non-admins get 403, and a config
      // that never opted in answers {enabled:false}.
      const res = await API.get('/api/admin/mlops/gold?status=active');
      if (!res || !res.enabled) return;
    } catch (e) {
      return;                       // 403 / 404 — not an admin, or feature off
    }
    this.enabled = true;
    btn.style.display = '';
    btn.addEventListener('click', () => this._openForm(btn));
  },

  /** A one-line teaching note, inline. Not window.prompt(): it is blocked outright
   *  in some embedded browsers, and this text is the sentence a labeler reads when
   *  they get the frame wrong, so it deserves a real field. */
  _openForm(btn) {
    if (document.getElementById('gold-author-form')) return;
    const box = document.createElement('div');
    box.id = 'gold-author-form';
    box.className = 'ga-form';
    box.innerHTML = `
      <label class="ga-label" for="ga-note">What makes this the right answer?</label>
      <input id="ga-note" class="ga-note" type="text" maxlength="200"
             placeholder="e.g. dorsal base is where the fin meets the body, not the fin edge">
      <div class="ga-actions">
        <button class="btn btn-sm btn-primary" id="ga-save">Save as answer key</button>
        <button class="btn btn-sm btn-ghost" id="ga-cancel">Cancel</button>
      </div>
      <div class="ga-status" id="ga-status"></div>`;
    btn.insertAdjacentElement('afterend', box);
    document.getElementById('ga-note').focus();
    document.getElementById('ga-cancel').onclick = () => box.remove();
    document.getElementById('ga-save').onclick = () => this._save(box);
  },

  /** Which mission this answer key is FOR. The annotator's own task switch is the
   *  honest source: a skeleton authored on the scars tab would be filed against a
   *  mission that never asks for keypoints. */
  _taskType() {
    const ann = window.annotCanvas?.getAnnotationData?.() || {};
    if ((ann.keypoints || []).some((k) => k.v > 0)) return 'pose';
    if ((ann.scars || []).length) return 'bbox';
    return null;
  },

  async _save(box) {
    const status = document.getElementById('ga-status');
    const ann = window.annotCanvas?.getAnnotationData?.() || {};
    const task = this._taskType();
    if (!task) {
      status.textContent = 'Place the keypoints or box a scar first — an empty '
        + 'answer key would mark everybody wrong.';
      return;
    }
    const video = window.appState?.currentVideo;
    if (!video) { status.textContent = 'No video loaded.'; return; }

    status.textContent = 'Saving…';
    try {
      const res = await API.post('/api/admin/mlops/gold', {
        task_type: task,
        video_id: video.id,
        frame_number: window.videoPlayer?.currentFrame?.() ?? null,
        keypoints: ann.keypoints,
        scars: ann.scars,
        body_bbox: ann.body_bbox,
        scars_visible: window.ScarForm?.getEncounterValues?.().scars_visible,
        teach_note: document.getElementById('ga-note').value.trim(),
        // The client already captured this frame for the ordinary save; reusing it
        // means the answer key has a thumbnail even on a box where the clip is not
        // cached, which is exactly the frame that must never show a placeholder.
        frame_image_b64: window.videoPlayer?.captureCurrentFrame?.() || null,
      });
      status.textContent = res?.gold
        ? `Saved as the ${task === 'pose' ? 'pose' : 'scar'} answer key for this frame.`
        : 'Saved.';
      setTimeout(() => box.remove(), 2200);
    } catch (e) {
      status.textContent = `Could not save: ${e.message || e}`;
    }
  },
};

window.GoldAuthor = GoldAuthor;
document.addEventListener('DOMContentLoaded', () => GoldAuthor.init());
