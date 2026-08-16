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

let openBubble = null;
let closingBubble = null;
let previousOverflow = '';
let morphAnim = null;

const isOpen = () => openBubble !== null;

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

  // Read the resting radius rather than hard-coding it: the mobile breakpoint
  // squares the shell off, and a filled animation would override that
  const restRadius = getComputedStyle(shell).borderRadius;

  const collapsed = {
    transform: `translate(${b.left - s.left}px, ${b.top - s.top}px) scale(${
      b.width / s.width
    }, ${b.height / s.height})`,
    borderRadius: '50%',
    opacity: 0.35,
  };
  const expanded = {
    transform: 'translate(0px, 0px) scale(1, 1)',
    borderRadius: restRadius,
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
  bodyEl.replaceChildren();
  shell.removeAttribute('aria-labelledby');
  bubble.classList.remove('is-open');
  // Safety net: never leave a bubble invisible because a morph was interrupted
  document
    .querySelectorAll('.research-bubble.is-open')
    .forEach((el) => el.classList.remove('is-open'));
  document.body.style.overflow = previousOverflow;
  closingBubble = null;
}

// ---- Open ----
function openPanel(bubble) {
  if (isOpen()) return;

  const key = bubble.dataset.panel;
  const template = document.querySelector(`template[data-panel="${key}"]`);
  if (!template) return;

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
  closeBtn.focus();
}

// ---- Close ----
export function closeResearchStage() {
  if (!isOpen()) return;

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

  if (returnFocus) bubble.focus();
}

// ---- Cross-links into the Technology path ----
function gotoTech(folderId) {
  closeResearchStage();
  document.dispatchEvent(
    new CustomEvent('goto-tech-folder', { detail: { folder: folderId || null } })
  );
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

  // Escape hatches: the close button, the scrim, and Escape
  closeBtn.addEventListener('click', closeResearchStage);
  stage.querySelector('[data-stage-dismiss]')?.addEventListener('click', closeResearchStage);

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

    // Presentation embeds load on request. Four Google frames mounting at once
    // throttles the page to 15fps, so the panel ships a facade instead.
    const facade = event.target.closest('.pres-facade');
    if (!facade) return;
    const frame = document.createElement('iframe');
    frame.src = facade.dataset.embed;
    frame.title = facade.dataset.embedTitle || 'Presentation';
    frame.width = '100%';
    frame.height = '420';
    frame.frameBorder = '0';
    frame.allowFullscreen = true;
    facade.replaceWith(frame);
  });
}
