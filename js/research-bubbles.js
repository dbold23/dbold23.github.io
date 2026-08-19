// ============================================
// Research path: bobbing bubbles that expand into a full-screen panel
// ============================================
//
// Panel bodies live in <template data-panel="..."> so their presentation
// iframes stay unloaded until a bubble is actually opened, and are torn back
// out on close so the embeds do not accumulate.

import { prefersReducedMotion } from './utils.js';
import { attachLazyVideos } from './effects.js';

const MORPH_MS = 460;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

let stage = null;
let shell = null;
let bodyEl = null;
let closeBtn = null;
// True while the open panel owns the top history entry.
let panelEntry = false;

let openBubble = null;
let closingBubble = null;
let previousOverflow = '';
let morphAnim = null;

let scrollEl = null;
let onScroll = null;

const isOpen = () => openBubble !== null;

// ---- Reader chrome: how far through, and what you are reading ----
// The cover carries the title, so once it has scrolled away the bar takes over.
function wireReader() {
  const cover = bodyEl.querySelector('.rp-head');
  const fill = stage.querySelector('.rp-rail span');
  const org = stage.querySelector('.rp-topbar-org');
  const title = stage.querySelector('.rp-topbar-title');

  if (org) org.textContent = bodyEl.querySelector('.rp-org')?.textContent || '';
  if (title) title.textContent = bodyEl.querySelector('.rp-title')?.textContent || '';

  scrollEl = stage.querySelector('.bubble-stage-scroll');
  if (!scrollEl) return;

  let queued = false;
  const update = () => {
    queued = false;
    const travel = scrollEl.scrollHeight - scrollEl.clientHeight;
    const progress = travel > 0 ? Math.min(1, scrollEl.scrollTop / travel) : 0;
    if (fill) fill.style.transform = `scaleX(${progress})`;
    const handover = Math.max(80, (cover?.offsetHeight || 0) - 72);
    stage.classList.toggle('is-stuck', scrollEl.scrollTop > handover);
  };

  onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };

  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  update();
}

function unwireReader() {
  if (scrollEl && onScroll) scrollEl.removeEventListener('scroll', onScroll);
  scrollEl = null;
  onScroll = null;
  stage.classList.remove('is-stuck');
  const fill = stage.querySelector('.rp-rail span');
  if (fill) fill.style.transform = 'scaleX(0)';
}

// ---- Presentation gallery: the strip drives one large stage ----
function facadeFor(data) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pres-facade';
  button.dataset.embed = data.embed;
  button.dataset.embedTitle = data.embedTitle;
  button.setAttribute('aria-label', `Open ${data.embedTitle}`);
  button.innerHTML =
    '<img class="pres-shot" alt="" width="1280" height="720" decoding="async">' +
    '<span class="pres-play" aria-hidden="true"></span>' +
    '<span class="pres-facade-label">Open</span>';
  button.querySelector('.pres-shot').src = data.shot;
  return button;
}

function stageSlide(thumb) {
  const gallery = thumb.closest('.pres-gallery');
  const stageEl = gallery?.querySelector('.pres-stage');
  const current = stageEl?.querySelector('.pres-facade, .pres-frame');
  if (!current) return;

  current.replaceWith(facadeFor(thumb.dataset));

  const title = stageEl.querySelector('.pres-caption-title');
  const date = stageEl.querySelector('.pres-date');
  if (title) title.textContent = thumb.dataset.title || '';
  if (date) date.textContent = thumb.dataset.date || '';

  gallery.querySelectorAll('.pres-thumb').forEach((el) => {
    const on = el === thumb;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function focusable() {
  return Array.from(
    shell.querySelectorAll(
      'a[href], button:not([disabled]), summary, iframe, video[controls], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.getClientRects().length > 0);
}

// ---- FLIP: scale the full-screen shell down onto the bubble it came from ----
function morph(bubble, direction) {
  if (prefersReducedMotion()) return null;

  const b = bubble.getBoundingClientRect();
  const s = shell.getBoundingClientRect();
  if (!s.width || !s.height) return null;

  // Transform and opacity only. This used to animate borderRadius from 50% down
  // to the shell's resting value as well, which reads nicely — the panel
  // collapsing into a circle — and costs more than everything else on the open
  // path put together. Border radius is not a compositor property, so animating
  // it re-rasterises a viewport-sized element holding the whole panel on every
  // frame: measured across nine opens, 883ms of raster over 6780 tasks with it,
  // 62ms over 742 without. Under a 4x CPU throttle it was the difference
  // between a 374ms frame and a 13ms one. The radius it was animating *to* was
  // always 0 in any case — the shell is square at every breakpoint — so the
  // whole effect was 200ms of rounding on something 13% of its final size and
  // a third opaque.
  const collapsed = {
    transform: `translate(${b.left - s.left}px, ${b.top - s.top}px) scale(${
      b.width / s.width
    }, ${b.height / s.height})`,
    opacity: 0.35,
  };
  const expanded = {
    transform: 'translate(0px, 0px) scale(1, 1)',
    opacity: 1,
  };

  const frames = direction === 'in' ? [collapsed, expanded] : [expanded, collapsed];
  return shell.animate(frames, { duration: MORPH_MS, easing: EASE, fill: 'both' });
}

function cancelMorph() {
  if (!morphAnim) return;
  // Drop the handler first: a cancel must not run the close teardown
  morphAnim.onfinish = null;
  morphAnim.cancel();
  morphAnim = null;
}

// Teardown after a close, run either when the morph lands or immediately if a
// new bubble is opened while the old one is still animating out
function finishClose(bubble) {
  stage.hidden = true;
  cancelMorph();
  unwireReader();
  bodyEl.replaceChildren();
  shell.removeAttribute('aria-labelledby');
  bubble.classList.remove('is-open');
  // Safety net: never leave a bubble invisible because a morph was interrupted
  document
    .querySelectorAll('.research-bubble.is-open')
    .forEach((el) => el.classList.remove('is-open'));
  document.body.style.overflow = previousOverflow;
  document.dispatchEvent(new CustomEvent('research-stage', { detail: { open: false } }));
  closingBubble = null;
}

// ---- Open ----
function openPanel(bubble) {
  if (isOpen()) return;

  const key = bubble.dataset.panel;
  const template = document.querySelector(`template[data-panel="${key}"]`);
  if (!template) return;

  // Stop the water FIRST. Everything below — cloning a hundred-node subtree,
  // the forced reflow, measuring the morph, decoding the cover image — is
  // main-thread work competing with a scene that is about to be completely
  // hidden anyway. Announcing the open at the end of this function, as this
  // used to, meant paying for both at once on exactly the frame that shows.
  document.dispatchEvent(new CustomEvent('research-stage', { detail: { open: true } }));

  // Settle any close still in flight before reusing the stage, or its teardown
  // lands on top of the panel being opened here
  if (closingBubble) finishClose(closingBubble);

  bodyEl.replaceChildren(template.content.cloneNode(true));

  // Name the dialog after the panel's own heading
  const heading = bodyEl.querySelector('.rp-title');
  if (heading) {
    heading.id = `rp-title-${key}`;
    shell.setAttribute('aria-labelledby', heading.id);
  } else {
    shell.removeAttribute('aria-labelledby');
  }

  openBubble = bubble;
  bubble.setAttribute('aria-expanded', 'true');
  bubble.classList.add('is-open');

  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  stage.hidden = false;
  // Force layout so the shell has a rect before the morph is measured
  void shell.offsetWidth;
  stage.classList.add('is-open');
  stage.querySelector('.bubble-stage-scroll').scrollTop = 0;

  cancelMorph();
  morphAnim = morph(bubble, 'in');

  attachLazyVideos(bodyEl);
  wireReader();
  closeBtn.focus();

  // A history entry of its own, so Back — the button on Android, the edge
  // swipe on iOS — closes the panel instead of leaving the Research path
  // entirely. The URL is deliberately left alone: routing here is driven by
  // the hash, so an entry that does not touch it is invisible to the router
  // and syncToHash finds nothing to do when this is popped.
  if (!panelEntry) {
    history.pushState({ ...(history.state || {}), bubbleStage: true }, '');
    panelEntry = true;
  }
}

// ---- Close ----
//
// Three ways out on a desktop: the button, the scrim behind the panel, and
// Escape. On a phone the panel is full-bleed, so the scrim is completely
// buried — measured, zero of 2108 tap points across the viewport could reach
// it — and there is no Escape key. That left one 40px button in the far corner
// as the only exit on the one device where reaching a far corner is hardest.
// So the phone gets the two a phone actually has: Back, and a swipe down.

export function closeResearchStage(fromHistory = false) {
  if (!isOpen()) return;

  // Give the entry back unless the pop is what brought us here, in which case
  // the browser has already taken it.
  if (panelEntry) {
    panelEntry = false;
    if (!fromHistory) history.back();
  }

  const bubble = openBubble;
  openBubble = null;
  closingBubble = bubble;

  bubble.setAttribute('aria-expanded', 'false');
  stage.classList.remove('is-open');

  // Return focus to the bubble that opened this, unless focus already moved on
  const returnFocus =
    shell.contains(document.activeElement) || document.activeElement === document.body;

  cancelMorph();
  morphAnim = morph(bubble, 'out');

  if (morphAnim) {
    morphAnim.onfinish = () => {
      if (closingBubble === bubble) finishClose(bubble);
    };
    // A backgrounded tab freezes the timeline and onfinish never fires, which
    // would leave the stage up with no way to dismiss it
    setTimeout(() => {
      if (closingBubble === bubble) finishClose(bubble);
    }, MORPH_MS + 400);
  } else {
    finishClose(bubble);
  }

  // preventScroll: the bubble is drifting, and letting the browser scroll to
  // wherever it has got to jerks the whole field and the water behind it
  if (returnFocus) bubble.focus({ preventScroll: true });
}

// ---- Cross-links into the Technology path ----
function gotoTech(folderId) {
  closeResearchStage();
  document.dispatchEvent(
    new CustomEvent('goto-tech-folder', { detail: { folder: folderId || null } })
  );
}

// ---- Keyboard: bring a focused bubble to where it can be seen ----
//
// The bubbles drift, so tabbing can land focus on one that has risen past the
// top of the stage or into the fade at either end — where the focus ring is
// invisible along with the bubble. That is two AA failures at once (2.4.7
// Focus Visible, 2.4.11 Focus Not Obscured), and pausing alone does not fix
// either, because a paused bubble that is out of sight is still out of sight.
//
// So focus does not just stop a bubble, it fetches it: the rise animation is
// retimed to a readable height. CSS holds it there while it has focus, and
// hands it back to the drift when focus leaves.

const READ_POINT = 0.42;      // where in the lap a bubble sits mid-stage

function riseAnimation(cell) {
  return cell.getAnimations?.().find((a) => a.animationName === 'bubble-rise') || null;
}

function bringIntoView(cell) {
  const anim = riseAnimation(cell);
  if (!anim) return;

  const timing = anim.effect.getComputedTiming();
  const dur = Number(timing.duration);
  const progress = timing.progress;
  if (!dur || progress == null) return;

  // Take whichever way round the loop is shorter, so a bubble near the top
  // rises the last of the way out rather than sinking the length of the stage
  let delta = (READ_POINT - progress) * dur;
  if (delta > dur / 2) delta -= dur;
  if (delta < -dur / 2) delta += dur;
  if (Math.abs(delta) < 8) return;

  if (prefersReducedMotion()) {
    anim.currentTime = Number(anim.currentTime) + delta;
    return;
  }

  const from = Number(anim.currentTime);
  const span = 240 + Math.min(220, (Math.abs(delta) / dur) * 520);
  const t0 = performance.now();

  const step = (now) => {
    const k = Math.min(1, (now - t0) / span);
    const eased = 1 - Math.pow(1 - k, 3);
    anim.currentTime = from + delta * eased;
    if (k < 1 && cell.matches(':has(:focus-visible)')) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function initDriftFocus() {
  const field = document.getElementById('bubble-field');
  if (!field || !CSS.supports('selector(:has(*))')) return;

  field.addEventListener('focusin', (event) => {
    const cell = event.target.closest('.bubble-cell');
    // Only for keyboard arrivals. Returning focus to a bubble after a mouse
    // user closes its panel must not yank it across the stage.
    if (cell && event.target.matches(':focus-visible')) bringIntoView(cell);
  });
}

// ---- A clean slate at the bottom of every lap ----
//
// Hovering a bubble pauses it, and it resumes wherever the rest of the field
// has got to by then — so a bubble held under the pointer keeps that offset for
// the whole visit, and the layout it was placed into is gone. The layout is the
// whole design: lanes are an even ladder and phases are the golden ratio
// precisely so that no two bubbles are ever at the same height in neighbouring
// lanes. Let the phases wander and that stops being true.
//
// Every cell runs the same rise for the same duration and is separated only by
// its delay, so they all share one start time — and a paused cell is simply one
// whose start time has slipped later. Putting it back is one write. The wrap is
// when to do it: `animationiteration` fires with the cell translated a full
// field height down, under the mask, where the correction cannot be seen.
//
// This replaces a version that re-picked the cell's LANE at each wrap, reading
// nine getBoundingClientRect()s and forcing a reflow to do it. That fought the
// layout it was meant to protect, and the forced layout — on a page carrying a
// live WebGL canvas and eighteen animating layers, roughly every five seconds —
// was a visible hitch. Correcting the phase instead restores the designed
// positions exactly and touches nothing that costs a frame.
function initLapReset() {
  const field = document.getElementById('bubble-field');
  if (!field) return;

  // Nothing drifts out of phase without a hover to pause it, and only a fine
  // pointer can hover. On a touch screen this would be a listener that never
  // has anything to correct.
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  const riseOf = (cell) => (cell.getAnimations
    ? cell.getAnimations().find((a) => a.animationName === 'bubble-rise')
    : null);

  field.addEventListener('animationiteration', (event) => {
    if (event.animationName !== 'bubble-rise') return;
    const cell = event.target;
    if (!cell.classList || !cell.classList.contains('bubble-cell')) return;

    const rise = riseOf(cell);
    if (!rise || rise.startTime === null) return;

    // Pausing can only ever push a start time later, so the earliest one in the
    // field is the one nothing has happened to. Taking the minimum fresh each
    // time rather than remembering a reference means it cannot be anchored to a
    // cell that was itself paused, and it re-derives correctly if the whole
    // field is restarted by the section being hidden and shown again.
    let truth = rise.startTime;
    field.querySelectorAll('.bubble-cell').forEach((c) => {
      const a = riseOf(c);
      if (a && a.startTime !== null && a.startTime < truth) truth = a.startTime;
    });

    // Reading and writing start times touches animation state only — no
    // geometry is measured, so nothing here forces a layout.
    if (rise.startTime > truth) rise.startTime = truth;
  });
}

// ---- Stopping the drift ----
//
// The bubbles start moving on their own and carry the page's only text, so
// there has to be a control that stops them (WCAG 2.2.2 Pause, Stop, Hide).
// The state is one attribute on the path; CSS does the rest, which means a
// paused bubble holds exactly where it was rather than snapping anywhere.

const DRIFT_KEY = 'ocean-drift';

function setDrift(running) {
  const path = document.getElementById('path-ocean');
  const toggle = document.getElementById('drift-toggle');
  if (!path || !toggle) return;

  path.dataset.drift = running ? 'on' : 'off';
  toggle.querySelector('.drift-word').textContent = running ? 'Pause' : 'Play';
  toggle.setAttribute('aria-label', running ? 'Pause the drifting bubbles' : 'Resume the drifting bubbles');

  try {
    sessionStorage.setItem(DRIFT_KEY, running ? 'on' : 'off');
  } catch {
    /* private mode: the choice just does not outlive the page */
  }

  // The water behind is motion too, and someone who asked for stillness meant
  // all of it. It is also the expensive half.
  document.dispatchEvent(new CustomEvent('ocean-motion', { detail: { run: running } }));
}

// A footnote for the water: the sharks in it are the user's own models, and
// nothing on screen says so.
function initWaterInfo() {
  const button = document.getElementById('water-info');
  const note = document.getElementById('water-note');
  if (!button || !note) return;

  const setOpen = (open) => {
    note.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(note.hidden);
  });

  // Dismiss the way a popover should: anywhere else, or Escape
  document.addEventListener('click', (event) => {
    if (!note.hidden && !note.contains(event.target)) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !note.hidden) {
      setOpen(false);
      button.focus();
    }
  });
}

function initDriftToggle() {
  const toggle = document.getElementById('drift-toggle');
  if (!toggle) return;

  let running = true;
  try {
    running = sessionStorage.getItem(DRIFT_KEY) !== 'off';
  } catch {
    /* no storage, no memory of the last choice */
  }

  setDrift(running);
  toggle.addEventListener('click', () => {
    running = !running;
    setDrift(running);
  });
}

// ---- Init ----
export function initResearchBubbles() {
  stage = document.getElementById('bubble-stage');
  shell = stage?.querySelector('.bubble-stage-shell');
  bodyEl = document.getElementById('bubble-stage-body');
  closeBtn = document.getElementById('bubble-stage-close');
  if (!stage || !shell || !bodyEl || !closeBtn) return;

  document.querySelectorAll('.research-bubble').forEach((bubble) => {
    bubble.addEventListener('click', () => openPanel(bubble));
  });

  initDriftFocus();
  initLapReset();
  initWaterInfo();
  initDriftToggle();

  // Escape hatches: the close button, the scrim, and Escape
  // Wrapped, not passed directly: these hand their click Event to the first
  // parameter, and that parameter now means "the history entry is already gone".
  closeBtn.addEventListener('click', () => closeResearchStage());
  stage.querySelector('[data-stage-dismiss]')
    ?.addEventListener('click', () => closeResearchStage());

  // Back closes the panel rather than leaving the path.
  window.addEventListener('popstate', () => {
    if (isOpen()) closeResearchStage(true);
  });

  // Swipe down to dismiss, the gesture a full-screen sheet is expected to have.
  // Only from the top of the article, so it cannot be triggered while reading,
  // and only for a clearly vertical drag, so it does not fight the scroll.
  let sx = 0, sy = 0;
  stage.addEventListener('touchstart', (event) => {
    sx = event.changedTouches[0].clientX;
    sy = event.changedTouches[0].clientY;
  }, { passive: true });
  stage.addEventListener('touchend', (event) => {
    if (!isOpen()) return;
    const scroller = stage.querySelector('.bubble-stage-scroll');
    if (scroller && scroller.scrollTop > 4) return;
    const dx = event.changedTouches[0].clientX - sx;
    const dy = event.changedTouches[0].clientY - sy;
    if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) closeResearchStage();
  }, { passive: true });

  document.addEventListener('keydown', (event) => {
    if (!isOpen()) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      // Stop app.js from also acting on this Escape
      event.stopPropagation();
      closeResearchStage();
      return;
    }

    if (event.key !== 'Tab') return;

    // Keep focus inside the dialog while it is open
    const items = focusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (!shell.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, true);

  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-goto-tech]');
    if (link) {
      event.preventDefault();
      gotoTech(link.dataset.gotoTech);
      return;
    }

    // Picking off the strip swaps what is on the stage, back to a facade even
    // if the previous slide had already been loaded
    const thumb = event.target.closest('.pres-thumb');
    if (thumb) {
      stageSlide(thumb);
      return;
    }

    // Presentation embeds load on request. Four Google frames mounting at once
    // throttles the page to 15fps, so the gallery ships a facade instead.
    const facade = event.target.closest('.pres-facade');
    if (!facade) return;
    const frame = document.createElement('iframe');
    frame.className = 'pres-frame';
    frame.src = facade.dataset.embed;
    frame.title = facade.dataset.embedTitle || 'Presentation';
    frame.loading = 'lazy';
    frame.allowFullscreen = true;
    facade.replaceWith(frame);
  });
}
