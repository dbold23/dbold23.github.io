// ============================================
// Tech Path: desktop furniture
//
// Turns the cosmetic macOS dressing into working parts — a window you can
// actually drag and resize, menubar menus that do something, a dock, and a
// Mail app that really sends. Everything here is scoped to the Technology
// path and torn down when you leave it.
// ============================================

import { prefersReducedMotion } from './utils.js';

// Where the Mail app posts. Any endpoint that accepts a JSON or form POST and
// emails it on works — Formspree, Web3Forms, a Worker of your own. Left empty,
// the app still composes the message and hands it to the visitor's mail client
// instead, so the form is never a dead end.
// Where the Mail app posts.
//
//   Formspree   MAIL_ENDPOINT = 'https://formspree.io/f/YOUR_ID'
//               MAIL_EXTRA    = {}
//   Web3Forms   MAIL_ENDPOINT = 'https://api.web3forms.com/submit'
//               MAIL_EXTRA    = { access_key: 'YOUR_KEY' }
//
// Anything that takes a JSON POST and emails it on will do; MAIL_EXTRA covers
// services that want a key in the body rather than a secret in the URL.
// Left empty, the app composes the message and hands it to the visitor's own
// mail client instead, so the form is never a dead end.
const MAIL_ENDPOINT = '';
const MAIL_EXTRA = {};
const CONTACT_EMAIL = 'daniel.sambold@gmail.com';

// Rate limit, enforced in the browser. This is politeness, not security — the
// endpoint should have its own limit too, since anything client-side can be
// stepped around by someone who wants to.
const RATE_LIMIT = { perHour: 3, perDay: 8, storageKey: 'ds-mail-sends' };

const DESKTOP_MIN = '(min-width: 969px)';
const desktopQuery = window.matchMedia(DESKTOP_MIN);
const isDesktop = () => desktopQuery.matches;
const cleanups = [];
const on = (el, ev, fn, opts) => {
  if (!el) return;
  el.addEventListener(ev, fn, opts);
  cleanups.push(() => el.removeEventListener(ev, fn, opts));
};

let toastTimer = null;

function toast(message, ms = 2600) {
  let el = document.querySelector('.os-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'os-toast';
    document.querySelector('.desktop-surface')?.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), ms);
}

// ---------------------------------------------------------------- Resizing

// The window is centred with a translate and offset by --win-x/--win-y, so a
// resize has to move the offset by half of whatever the edge gained: grow the
// left edge by 10px and the centre would otherwise drift 5px right.
function initWindowResize(win) {
  if (!win || win.dataset.resizeInit) return;
  win.dataset.resizeInit = 'true';

  const desktop = window.matchMedia(DESKTOP_MIN);
  const MIN_W = 380;
  const MIN_H = 160;
  const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

  const grips = document.createElement('div');
  grips.className = 'win-grips';
  grips.innerHTML = EDGES.map((d) => `<span class="win-grip win-grip-${d}" data-dir="${d}"></span>`).join('');
  win.appendChild(grips);

  grips.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.win-grip');
    if (!grip || !desktop.matches) return;
    if (win.classList.contains('maximized') || win.classList.contains('minimized')) return;
    e.preventDefault();
    e.stopPropagation();

    const dir = grip.dataset.dir;
    const rect = win.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const baseX = parseFloat(win.style.getPropertyValue('--win-x')) || 0;
    const baseY = parseFloat(win.style.getPropertyValue('--win-y')) || 0;

    win.classList.add('resizing');
    grip.setPointerCapture(e.pointerId);

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let w = startW;
      let h = startH;
      let ox = baseX;
      let oy = baseY;

      if (dir.includes('e')) w = Math.max(MIN_W, startW + dx);
      if (dir.includes('w')) {
        w = Math.max(MIN_W, startW - dx);
        ox = baseX + (startW - w) / 2;      // half, or the centre drifts
      }
      if (dir.includes('s')) h = Math.max(MIN_H, startH + dy);
      if (dir.includes('n')) {
        h = Math.max(MIN_H, startH - dy);
        oy = baseY + (startH - h) / 2;
      }

      win.style.setProperty('--win-w', `${Math.round(w)}px`);
      win.style.setProperty('--win-h', `${Math.round(h)}px`);
      win.style.setProperty('--win-x', `${Math.round(ox)}px`);
      win.style.setProperty('--win-y', `${Math.round(oy)}px`);
      win.classList.add('sized');
    }

    function onUp() {
      win.classList.remove('resizing');
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
    }

    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });

  // The red dot resets position; it should drop the size back too.
  const red = win.querySelector('.dot.red');
  on(red, 'click', () => {
    win.classList.remove('sized');
    win.style.removeProperty('--win-w');
    win.style.removeProperty('--win-h');
  });
}

// ------------------------------------------------------------- Menubar

const MENUS = {
  apple: {
    label: '',
    items: [
      { label: 'About This Mac', action: 'about' },
      { sep: true },
      { label: 'System Settings…', action: 'settings' },
      { label: 'App Store…', action: 'appstore' },
      { sep: true },
      { label: 'Sleep', action: 'sleep' },
      { label: 'Restart…', action: 'restart' },
      { label: 'Log Out Daniel…', action: 'logout' },
    ],
  },
  finder: {
    label: 'Finder',
    items: [
      { label: 'About Finder', action: 'aboutfinder' },
      { sep: true },
      { label: 'Empty Trash…', action: 'trash' },
      { label: 'Hide Others', action: 'hideothers' },
    ],
  },
  file: {
    label: 'File',
    items: [
      { label: 'New Mail Message', action: 'mail', key: '⌘N' },
      { label: 'Open RelayStation', action: 'open-relay' },
      { label: 'Open Scar Annotator', action: 'open-scar' },
      { sep: true },
      { label: 'Close Window', action: 'close', key: '⌘W' },
    ],
  },
  edit: {
    label: 'Edit',
    items: [
      { label: 'Undo', action: 'undo', key: '⌘Z' },
      { label: 'Redo', action: 'redo', key: '⇧⌘Z' },
      { sep: true },
      { label: 'Select All', action: 'selectall', key: '⌘A' },
      { label: 'Find…', action: 'find', key: '⌘F' },
    ],
  },
  view: {
    label: 'View',
    items: [
      { label: 'Toggle Matrix Rain', action: 'matrix' },
      { label: 'Toggle Scanlines', action: 'scanlines' },
      { label: 'Why?', action: 'invert' },
      { sep: true },
      { label: 'Enter Full Screen', action: 'zoom', key: '⌃⌘F' },
    ],
  },
  go: {
    label: 'Go',
    items: [
      { label: 'Conservation', action: 'path-forest' },
      { label: 'Research', action: 'path-ocean' },
      { label: 'About Me', action: 'path-mind' },
      { sep: true },
      { label: 'Home', action: 'path-home', key: '⇧⌘H' },
    ],
  },
  window: {
    label: 'Window',
    items: [
      { label: 'Minimize', action: 'minimize', key: '⌘M' },
      { label: 'Zoom', action: 'zoom' },
      { sep: true },
      { label: 'Bring All to Front', action: 'reset' },
    ],
  },
  help: {
    label: 'Help',
    items: [
      { label: 'Keyboard Shortcuts', action: 'shortcuts' },
      { label: 'Easter Eggs', action: 'eggs' },
      { sep: true },
      { label: 'Contact Support', action: 'mail' },
    ],
  },
};

const EGG_LINES = [
  'Try the Konami code. ↑↑↓↓←→←→ B A',
  'Click the clock. Keep clicking it.',
  'The battery is more honest than most.',
  'Empty the Trash. Go on.',
  'The Wi-Fi menu knows what you did.',
  '⌘M, ⌘N and ⌃⌘F all do what they say.',
];

function initMenubar(ctx) {
  const bar = document.querySelector('.macos-menubar');
  if (!bar || bar.dataset.menubarInit) return;
  bar.dataset.menubarInit = 'true';

  const left = bar.querySelector('.menubar-left');
  const right = bar.querySelector('.menubar-right');
  if (!left) return;

  // Rebuild the left side as real menus, keeping the original labels.
  left.innerHTML = '';
  const keys = ['apple', 'finder', 'file', 'edit', 'view', 'go', 'window', 'help'];
  keys.forEach((k) => {
    const menu = MENUS[k];
    const root = document.createElement('div');
    root.className = 'menubar-menu';
    root.dataset.menu = k;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'menubar-item' + (k === 'apple' ? ' menubar-apple' : '') + (k === 'finder' ? ' menubar-app' : '');
    trigger.textContent = menu.label;
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');

    const drop = document.createElement('div');
    drop.className = 'menubar-dropdown';
    drop.setAttribute('role', 'menu');
    drop.innerHTML = menu.items.map((it) => it.sep
      ? '<div class="menu-sep" role="separator"></div>'
      : `<button type="button" class="menu-item" role="menuitem" data-action="${it.action}">
           <span>${it.label}</span>${it.key ? `<kbd>${it.key}</kbd>` : ''}
         </button>`).join('');

    root.append(trigger, drop);
    left.appendChild(root);
  });

  function closeAll() {
    bar.querySelectorAll('.menubar-menu.open').forEach((m) => {
      m.classList.remove('open');
      m.querySelector('.menubar-item')?.setAttribute('aria-expanded', 'false');
    });
  }

  on(left, 'click', (e) => {
    const trigger = e.target.closest('.menubar-item');
    if (trigger) {
      const root = trigger.closest('.menubar-menu');
      const wasOpen = root.classList.contains('open');
      closeAll();
      if (!wasOpen) {
        root.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    const item = e.target.closest('.menu-item');
    if (item) {
      closeAll();
      runAction(item.dataset.action, ctx);
    }
  });

  // Hover-to-switch once a menu is open, the way a real menubar behaves
  on(left, 'pointerover', (e) => {
    if (!left.querySelector('.menubar-menu.open')) return;
    const trigger = e.target.closest('.menubar-item');
    if (!trigger) return;
    const root = trigger.closest('.menubar-menu');
    if (root.classList.contains('open')) return;
    closeAll();
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
  });

  on(document, 'click', (e) => { if (!e.target.closest('.menubar-left')) closeAll(); });
  on(document, 'keydown', (e) => { if (e.key === 'Escape') closeAll(); });

  // ---- right side: status items with something to say ----
  if (right) {
    const wifi = right.querySelector('.menubar-icon:nth-child(1)');
    const batt = right.querySelector('.menubar-icon:nth-child(2)');
    const clock = right.querySelector('.menubar-time');

    if (wifi) {
      wifi.classList.add('is-interactive');
      wifi.title = 'Wi-Fi';
      let n = 0;
      const nets = ['Connected: eduroam', 'Connected: MBARI-Guest', 'Connected: R/V Rachel Carson',
                    'Connected: Elkhorn-Slough-Relay', 'Searching for networks…'];
      on(wifi, 'click', () => toast(nets[n++ % nets.length]));
    }
    if (batt) {
      batt.classList.add('is-interactive');
      batt.title = 'Battery';
      let n = 0;
      const states = ['Battery: 61% — about 3 hours remaining',
                      'Battery: 61% — about 3 hours, optimistically',
                      'Battery: 61% — fieldwork drains it faster',
                      'Battery: on a boat. No outlets.',
                      'Service Recommended. It is fine. It is fine.'];
      on(batt, 'click', () => toast(states[n++ % states.length]));
    }
    if (clock) {
      clock.classList.add('is-interactive');
      clock.title = 'Date & Time';
      let n = 0;
      const quips = ['Tuesday. Definitely Tuesday.',
                     'Local time. Tide is doing its own thing.',
                     'UTC-8, give or take a research cruise.',
                     'Time is a construct. The tag timestamps are not.',
                     'You have been on this page a while. That is nice.'];
      on(clock, 'click', () => toast(quips[n++ % quips.length]));
    }
  }

  // ---- konami ----
  const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
  let pos = 0;
  on(document, 'keydown', (e) => {
    if (document.body.getAttribute('data-active-path') !== 'tech') return;
    const want = KONAMI[pos];
    const got = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    pos = (got === want) ? pos + 1 : (got === KONAMI[0] ? 1 : 0);
    if (pos === KONAMI.length) {
      pos = 0;
      document.querySelector('.desktop-surface')?.classList.toggle('os-barrel-roll');
      toast('\u{1F41F} Cheat mode: all sharks now identified. You are welcome.');
    }
  });

  // ---- keyboard shortcuts ----
  on(document, 'keydown', (e) => {
    if (document.body.getAttribute('data-active-path') !== 'tech') return;
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'm') { e.preventDefault(); runAction('minimize', ctx); }
    else if (k === 'n') { e.preventDefault(); runAction('mail', ctx); }
    else if (k === 'f' && e.ctrlKey && e.metaKey) { e.preventDefault(); runAction('zoom', ctx); }
  });
}

function runAction(action, ctx) {
  const win = document.getElementById('tech-file-tree');
  const surface = document.querySelector('.desktop-surface');

  switch (action) {
    case 'about':
      openDialog('About This Mac', `
        <div class="about-mac">
          <div class="about-logo"></div>
          <h3>MacBook Pro (Fieldwork, 2026)</h3>
          <dl>
            <div><dt>Chip</dt><dd>Caffeine M3</dd></div>
            <div><dt>Memory</dt><dd>8 GB, 7.9 GB used by browser tabs</dd></div>
            <div><dt>Storage</dt><dd>4,850 archival videos</dd></div>
            <div><dt>Graphics</dt><dd>Enough for one shark at a time</dd></div>
            <div><dt>Serial</dt><dd>DS-UROC-2026</dd></div>
          </dl>
          <p class="about-note">Salt damage not covered under warranty.</p>
        </div>`);
      break;
    case 'aboutfinder':
      openDialog('About Finder', '<p>Finder has found 4,850 videos and exactly one that is properly labelled. Work continues.</p>');
      break;
    case 'settings':
      openDialog('System Settings', '<p>Settings are managed by your organisation.</p><p class="about-note">Your organisation is a shark lab. There is no budget.</p>');
      break;
    case 'appstore':
      openDialog('App Store', '<p>2 updates available.</p><p class="about-note">Both are for apps you did not install and cannot remove.</p>');
      break;
    case 'sleep':
      // No toast here: it renders at z-index 70, under the sleep overlay at
      // 80, so it fired invisibly. The overlay says everything it needs to.
      surface?.classList.add('os-asleep');
      { const wake = () => { surface?.classList.remove('os-asleep'); document.removeEventListener('click', wake); };
        setTimeout(() => document.addEventListener('click', wake), 60); }
      break;
    case 'restart':
      toast('Restarting… just kidding, this is a webpage.');
      break;
    case 'logout':
      toast('Logging out would close the portfolio. Bold strategy.');
      break;
    case 'trash':
      openDialog('Empty the Trash?', `<p>The Trash contains 1 item:</p>
        <ul class="trash-list"><li>\u{1F5C2}️ <em>final_FINAL_v3_actuallyfinal_USE_THIS.csv</em></li></ul>
        <p class="about-note">Some things should be kept as a warning to others.</p>`);
      break;
    case 'hideothers':
      toast('There are no others. It is just you and the shark.');
      break;
    case 'undo':
      toast('Undone. The data is still wrong, but differently.');
      break;
    case 'redo':
      toast('Redone. It was better the first time.');
      break;
    case 'selectall':
      toast('All 4,850 videos selected. Please do not press delete.');
      break;
    case 'find':
      document.getElementById('video-search')?.focus();
      toast('Searching… have you tried the file tree?');
      break;
    case 'matrix': {
      const c = document.getElementById('matrix-canvas');
      if (c) { c.classList.toggle('os-hidden'); toast(c.classList.contains('os-hidden') ? 'Matrix rain off' : 'Matrix rain on'); }
      break;
    }
    case 'scanlines':
      surface?.classList.toggle('os-scanlines');
      toast(surface?.classList.contains('os-scanlines') ? 'CRT mode' : 'CRT mode off');
      break;
    case 'invert':
      surface?.classList.toggle('os-invert');
      toast('Display inverted. This is how the deep sea sees you.');
      break;
    case 'minimize':
      win?.classList.toggle('minimized');
      break;
    case 'zoom':
      win?.classList.remove('minimized');
      win?.classList.toggle('maximized');
      break;
    case 'close':
      win?.classList.add('minimized');
      toast('Window closed. The yellow dot brings it back.');
      break;
    case 'reset':
      win?.classList.remove('minimized', 'maximized', 'sized');
      win?.style.removeProperty('--win-w');
      win?.style.removeProperty('--win-h');
      win?.style.setProperty('--win-x', '0px');
      win?.style.setProperty('--win-y', '0px');
      break;
    case 'shortcuts':
      openDialog('Keyboard Shortcuts', `<dl class="shortcut-list">
        <div><dt>⌘M</dt><dd>Minimize the terminal window</dd></div>
        <div><dt>⌘N</dt><dd>New mail message</dd></div>
        <div><dt>⌃⌘F</dt><dd>Zoom the window</dd></div>
        <div><dt>Esc</dt><dd>Close menus and dialogs</dd></div>
        <div><dt>Drag edges</dt><dd>Resize the window</dd></div>
      </dl>`);
      break;
    case 'eggs':
      openDialog('Easter Eggs', `<ul class="egg-list">${EGG_LINES.map((l) => `<li>${l}</li>`).join('')}</ul>`);
      break;
    case 'mail':
      openMail();
      break;
    case 'open-relay':
      openAppWindow('relay');
      break;
    case 'open-scar':
      openAppWindow('scar');
      break;
    case 'path-forest':
    case 'path-ocean':
    case 'path-mind':
      window.location.hash = `#${action.replace('path-', '')}`;
      break;
    case 'path-home':
      document.querySelector('.nav-home')?.click();
      break;
    default:
      break;
  }
}

// -------------------------------------------------------------- Dialogs

function openDialog(title, bodyHTML) {
  closeDialog();
  const surface = document.querySelector('.desktop-surface');
  if (!surface) return;

  const dlg = document.createElement('div');
  dlg.className = 'os-dialog';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', title);
  dlg.innerHTML = `
    <div class="os-dialog-bar">
      <div class="terminal-dots"><span class="dot red os-dialog-close" role="button" tabindex="0" aria-label="Close"></span><span class="dot yellow"></span><span class="dot green"></span></div>
      <span class="os-dialog-title">${title}</span>
    </div>
    <div class="os-dialog-body">${bodyHTML}</div>`;
  surface.appendChild(dlg);
  makeDraggable(dlg, dlg.querySelector('.os-dialog-bar'));
  dlg.querySelector('.os-dialog-close')?.addEventListener('click', closeDialog);
  dlg.querySelector('.os-dialog-close')?.focus?.();
}

function closeDialog() {
  document.querySelectorAll('.os-dialog').forEach((d) => d.remove());
}

// A plain absolute-positioned drag, for windows that are not the terminal.
function makeDraggable(el, handle) {
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.dot')) return;
    if (!window.matchMedia(DESKTOP_MIN).matches) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const parent = el.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
    const offX = e.clientX - r.left;
    const offY = e.clientY - r.top;
    el.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);

    const move = (ev) => {
      el.style.left = `${Math.round(ev.clientX - parent.left - offX)}px`;
      el.style.top = `${Math.max(0, Math.round(ev.clientY - parent.top - offY))}px`;
      el.style.transform = 'none';
    };
    const up = () => {
      el.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// ---------------------------------------------------------- App windows

// The demos run in a window on this desktop rather than taking over a tab.
// An iframe keeps each app's CSS and its mock API sealed off from the
// portfolio's, which matters — both ship their own global stylesheet.
const APP_WINDOWS = {
  relay: { title: 'RelayStation Central', src: 'demos/relaystation/index.html', w: 1160, h: 720 },
  scar:  { title: 'Shark Scar Annotator', src: 'demos/sharkscar.html',    w: 1180, h: 720 },
};

let appZ = 70;

function openAppWindow(key) {
  const spec = APP_WINDOWS[key];
  const surface = document.querySelector('.desktop-surface');
  if (!spec || !surface) return;

  // On a phone there is no room to put a desktop application inside a window
  // inside a page, so it gets the whole tab. Navigating this one rather than
  // opening a new one is the difference between Back returning to the
  // portfolio and Back having nowhere to go: a _blank tab starts with no
  // history, which left the reader stranded in the demo.
  if (!isDesktop()) { window.location.href = spec.src; return; }

  const existing = surface.querySelector(`.os-app[data-app="${key}"]`);
  if (existing) {                       // already open: raise it, do not reload
    existing.classList.remove('minimized');
    existing.style.zIndex = ++appZ;
    return;
  }

  // Fit the window to the desktop rather than trusting the nominal size, so a
  // 1180px app does not hang off the edge of a 1024px laptop.
  const r = surface.getBoundingClientRect();
  const w = Math.min(spec.w, Math.max(320, r.width - 60));
  const h = Math.min(spec.h, Math.max(260, r.height - 110));

  const win = document.createElement('div');
  win.className = 'os-app';
  win.dataset.app = key;
  win.style.width = `${w}px`;
  win.style.height = `${h}px`;
  win.style.zIndex = ++appZ;
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', spec.title);
  win.innerHTML = `
    <div class="os-app-bar">
      <div class="terminal-dots">
        <span class="dot red"    role="button" tabindex="0" aria-label="Close" data-act="close"></span>
        <span class="dot yellow" role="button" tabindex="0" aria-label="Minimize" data-act="min"></span>
        <span class="dot green"  role="button" tabindex="0" aria-label="Zoom" data-act="zoom"></span>
      </div>
      <span class="os-dialog-title">${spec.title}</span>
      <a class="os-app-pop" href="${spec.src}" target="_blank" rel="noopener" title="Open in a new tab">↗</a>
    </div>
    <div class="os-app-body">
      <iframe src="${spec.src}" title="${spec.title}" loading="lazy"
              referrerpolicy="no-referrer"></iframe>
    </div>
    <div class="win-grips">
      ${['n','s','e','w','ne','nw','se','sw'].map((d) => `<span class="win-grip win-grip-${d}" data-dir="${d}"></span>`).join('')}
    </div>`;
  surface.appendChild(win);

  const bar = win.querySelector('.os-app-bar');
  makeDraggable(win, bar);
  makeResizable(win);
  on(win, 'pointerdown', () => { win.style.zIndex = ++appZ; });

  bar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { win.remove(); syncDock(); }
    else if (act === 'min') win.classList.toggle('minimized');
    else if (act === 'zoom') { win.classList.remove('minimized'); win.classList.toggle('maximized'); }
  });
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.dot') || e.target.closest('.os-app-pop')) return;
    win.classList.toggle('maximized');
  });

  syncDock();
}

// Plain left/top/width/height resizing, for windows that are not centred by a
// transform the way the terminal is — so no half-delta compensation here.
function makeResizable(win) {
  const grips = win.querySelector('.win-grips');
  if (!grips) return;
  const MIN_W = 340, MIN_H = 220;

  grips.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.win-grip');
    if (!grip || !window.matchMedia(DESKTOP_MIN).matches) return;
    if (win.classList.contains('maximized') || win.classList.contains('minimized')) return;
    e.preventDefault();
    e.stopPropagation();

    const dir = grip.dataset.dir;
    const parent = win.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
    const r = win.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const sw = r.width, sh = r.height;
    const sl = r.left - parent.left, st = r.top - parent.top;

    win.classList.add('resizing');
    grip.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (dir.includes('e')) win.style.width = `${Math.max(MIN_W, sw + dx)}px`;
      if (dir.includes('s')) win.style.height = `${Math.max(MIN_H, sh + dy)}px`;
      if (dir.includes('w')) {
        const w = Math.max(MIN_W, sw - dx);
        win.style.width = `${w}px`;
        win.style.left = `${sl + (sw - w)}px`;
      }
      if (dir.includes('n')) {
        const h = Math.max(MIN_H, sh - dy);
        win.style.height = `${h}px`;
        win.style.top = `${st + (sh - h)}px`;
      }
      win.style.transform = 'none';
    };
    const up = () => {
      win.classList.remove('resizing');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grips.addEventListener('pointermove', move);
    grips.addEventListener('pointerup', up);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}

// ------------------------------------------------------------ CV document

// The CV opens as a document on this desktop rather than in the slide-out
// panel, which is the right shape for the rest of the site but reads as a
// stray drawer over a Mac. The content is cloned from the panel, so
// build_cv.py stays the single source and there is no second copy to drift.
function openWordDoc() {
  const surface = document.querySelector('.desktop-surface');
  if (!surface) return;

  // The document window is desktop furniture. On a phone the slide-out panel
  // is the better reader and is already designed for that width.
  if (!isDesktop()) { document.getElementById('cv-toggle')?.click(); return; }

  const existing = surface.querySelector('.os-word');
  if (existing) { existing.classList.remove('minimized'); existing.style.zIndex = ++appZ; return; }

  const source = document.querySelector('#resume-panel .resume-panel-content');
  if (!source) return;

  const r = surface.getBoundingClientRect();
  const w = Math.min(820, Math.max(320, r.width - 60));
  const h = Math.min(720, Math.max(260, r.height - 110));

  const win = document.createElement('div');
  win.className = 'os-app os-word';
  win.dataset.app = 'cv';
  win.style.width = `${w}px`;
  win.style.height = `${h}px`;
  win.style.zIndex = ++appZ;
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'Sambold_CV.docx');
  win.innerHTML = `
    <div class="os-app-bar">
      <div class="terminal-dots">
        <span class="dot red"    role="button" tabindex="0" aria-label="Close" data-act="close"></span>
        <span class="dot yellow" role="button" tabindex="0" aria-label="Minimize" data-act="min"></span>
        <span class="dot green"  role="button" tabindex="0" aria-label="Zoom" data-act="zoom"></span>
      </div>
      <span class="os-dialog-title">Sambold_CV.docx</span>
    </div>
    <div class="os-word-ribbon">
      <span class="os-word-mark">W</span>
      <span class="os-word-name">Sambold_CV.docx</span>
      <span class="os-word-chip">Read-Only</span>
      <span class="os-word-spacer"></span>
      <a class="os-word-dl" href="assets/Sambold_Daniel_CV.pdf" download>PDF</a>
      <a class="os-word-dl" href="assets/Sambold_Daniel_CV.docx" download>.docx</a>
    </div>
    <div class="os-word-body"><div class="os-word-page"></div></div>
    <div class="win-grips">
      ${['n','s','e','w','ne','nw','se','sw'].map((d) => `<span class="win-grip win-grip-${d}" data-dir="${d}"></span>`).join('')}
    </div>`;

  // The panel's own download buttons would sit right under the ribbon's, so
  // drop them from the copy rather than showing the same two links twice.
  const page = win.querySelector('.os-word-page');
  const copy = source.cloneNode(true);
  copy.querySelectorAll('.cv-downloads').forEach((el) => el.remove());
  while (copy.firstChild) page.appendChild(copy.firstChild);

  surface.appendChild(win);

  const bar = win.querySelector('.os-app-bar');
  makeDraggable(win, bar);
  makeResizable(win);
  on(win, 'pointerdown', () => { win.style.zIndex = ++appZ; });

  bar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { win.remove(); syncDock(); }
    else if (act === 'min') win.classList.toggle('minimized');
    else if (act === 'zoom') { win.classList.remove('minimized'); win.classList.toggle('maximized'); }
  });
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.dot')) return;
    win.classList.toggle('maximized');
  });

  syncDock();
}

// ----------------------------------------------------------------- Dock

const DOCK_APPS = [
  { id: 'finder',    label: 'Finder',           icon: 'assets/icon-finder.svg',        action: 'focus-terminal' },
  { id: 'relay',     label: 'RelayStation',     icon: 'assets/icon-relaystation.png',  app: 'relay' },
  { id: 'scar',      label: 'Scar Annotator',   icon: 'assets/icon-sharkscar.png',     app: 'scar' },
  { sep: true },
  { id: 'jorgensen', label: 'Jorgensen Lab',    icon: 'assets/jorgensen-lab-logo.avif', target: '#folder-jorgensen', tile: true },
  { id: 'jue',       label: 'Jue Lab',          icon: 'assets/jue-lab-logo.avif',       target: '#folder-jue', tile: true },
  { id: 'noaa',      label: 'NOAA Sat Hack',    icon: 'assets/JPSS-1_logo-removebg-preview.png', target: '#folder-noaa', tile: true },
  { id: 'github',    label: 'GitHub',           icon: 'assets/github logo no background_sticker.png', href: 'https://github.com/dbold23', external: true, tile: true },
  { sep: true },
  { id: 'mail',      label: 'Mail',             icon: 'assets/icon-mail.svg',           action: 'mail' },
];

// The dock light is derived, never toggled by hand: it asks what is actually
// on the desktop. Setting it at launch and hoping to catch every close is how
// it ended up staying lit after a window went away.
//
// Only things that run *here* can be lit. GitHub opens a browser tab, whose
// lifetime this page cannot observe, so it never gets a light rather than
// getting one that would be a guess.
function syncDock() {
  const dock = document.querySelector('.os-dock');
  if (!dock) return;
  const openApps = new Set([...document.querySelectorAll('.os-app')].map((w) => w.dataset.app));
  const mailOpen = !!document.querySelector('.os-mail');

  dock.querySelectorAll('.os-dock-app').forEach((btn) => {
    const app = dockApps.find((a) => a.id === btn.dataset.id);
    const lit = app?.app ? openApps.has(app.app)
              : app?.action === 'mail' ? mailOpen
              : false;
    btn.classList.toggle('running', lit);
  });
}

// Below the breakpoint the desktop icons are hidden — a row of files on a
// surface you cannot drag anything around is decoration. The apps are already
// in the dock; the CV is not, so it joins them there rather than being lost
// with the icons.
let dockApps = DOCK_APPS;

function currentDockApps() {
  if (isDesktop()) return DOCK_APPS;
  return DOCK_APPS.concat([
    { sep: true },
    { id: 'cv', label: 'CV', icon: 'assets/icon-cv-doc.svg', action: 'cv' },
  ]);
}

function initDock(ctx) {
  const surface = document.querySelector('.desktop-surface');
  if (!surface || surface.querySelector('.os-dock')) return;

  const dock = document.createElement('div');
  dock.className = 'os-dock';
  dockApps = currentDockApps();
  dock.innerHTML = `<div class="os-dock-inner">${dockApps.map((a) => a.sep
    ? '<span class="os-dock-sep" aria-hidden="true"></span>'
    : `<button type="button" class="os-dock-app${a.tile ? ' is-logo' : ''}" data-id="${a.id}" aria-label="${a.label}">
         <span class="os-dock-tip">${a.label}</span>
         <img src="${a.icon}" alt="" decoding="async">
         <span class="os-dock-dot" aria-hidden="true"></span>
       </button>`).join('')}</div>`;
  surface.appendChild(dock);
  syncDock();

  on(dock, 'click', (e) => {
    const btn = e.target.closest('.os-dock-app');
    if (!btn) return;
    const app = dockApps.find((a) => a.id === btn.dataset.id);
    if (!app) return;

    btn.classList.add('bouncing');
    setTimeout(() => btn.classList.remove('bouncing'), 700);

    if (app.app) { openAppWindow(app.app); return; }
    if (app.href) { window.open(app.href, '_blank', 'noopener'); return; }
    if (app.target) { jumpToFolder(app.target); return; }
    if (app.action === 'mail') { openMail(); return; }
    if (app.action === 'cv') { openWordDoc(); return; }
    if (app.action === 'focus-terminal') {
      const win = document.getElementById('tech-file-tree');
      win?.classList.remove('minimized');
      win?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    }
  });

}

function jumpToFolder(selector) {
  const win = document.getElementById('tech-file-tree');
  win?.classList.remove('minimized');
  const target = document.querySelector(selector);
  if (!target) return;
  if (!target.classList.contains('open')) {
    target.querySelector(':scope > .folder-toggle')?.click();
  }
  target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
}

// ----------------------------------------------------------------- Mail

function readSendLog() {
  try { return JSON.parse(localStorage.getItem(RATE_LIMIT.storageKey) || '[]'); }
  catch { return []; }
}

function rateCheck() {
  const now = Date.now();
  const log = readSendLog().filter((t) => now - t < 86400000);
  const hour = log.filter((t) => now - t < 3600000);
  if (hour.length >= RATE_LIMIT.perHour) {
    const wait = Math.ceil((3600000 - (now - hour[0])) / 60000);
    return { ok: false, message: `That is ${RATE_LIMIT.perHour} messages this hour — the limit. Try again in ${wait} min.` };
  }
  if (log.length >= RATE_LIMIT.perDay) {
    return { ok: false, message: `Daily limit of ${RATE_LIMIT.perDay} messages reached. Email ${CONTACT_EMAIL} directly.` };
  }
  return { ok: true, log };
}

function recordSend(log) {
  try { localStorage.setItem(RATE_LIMIT.storageKey, JSON.stringify([...log, Date.now()])); } catch {}
}

function openMail() {
  const surface = document.querySelector('.desktop-surface');
  if (!surface) return;
  const existing = surface.querySelector('.os-mail');
  if (existing) { existing.classList.remove('minimized'); return; }

  const win = document.createElement('div');
  win.className = 'os-mail';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'New message');
  win.innerHTML = `
    <div class="os-mail-bar">
      <div class="terminal-dots"><span class="dot red os-mail-close" role="button" tabindex="0" aria-label="Close"></span><span class="dot yellow"></span><span class="dot green"></span></div>
      <span class="os-dialog-title">New Message</span>
    </div>
    <form class="os-mail-body" novalidate>
      <label class="os-field"><span>To</span><input type="text" value="${CONTACT_EMAIL}" readonly tabindex="-1"></label>
      <label class="os-field"><span>From</span><input type="email" name="email" required placeholder="you@example.com" autocomplete="email"></label>
      <label class="os-field"><span>Name</span><input type="text" name="name" required placeholder="Your name" autocomplete="name"></label>
      <label class="os-field"><span>Subject</span><input type="text" name="subject" required placeholder="What is this about?"></label>
      <!-- honeypot: a real person never fills this in -->
      <div class="os-hp" aria-hidden="true"><label>Company<input type="text" name="company" tabindex="-1" autocomplete="off"></label></div>
      <textarea name="message" required rows="7" placeholder="Write your message…"></textarea>
      <div class="os-mail-foot">
        <p class="os-mail-status" role="status"></p>
        <button type="submit" class="os-send">Send</button>
      </div>
    </form>`;
  surface.appendChild(win);
  makeDraggable(win, win.querySelector('.os-mail-bar'));
  win.querySelector('.os-mail-close').addEventListener('click', () => { win.remove(); syncDock(); });
  win.querySelector('input[name="email"]')?.focus();
  syncDock();

  const form = win.querySelector('form');
  const status = win.querySelector('.os-mail-status');
  const button = win.querySelector('.os-send');
  const openedAt = Date.now();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());

    if (data.company) { status.textContent = 'Message sent.'; return; }        // bot; say nothing useful
    if (Date.now() - openedAt < 3000) { status.textContent = 'Take a moment to write something first.'; return; }
    if (!data.email || !data.name || !data.subject || !data.message) {
      status.className = 'os-mail-status is-error';
      status.textContent = 'Fill in every field before sending.';
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) {
      status.className = 'os-mail-status is-error';
      status.textContent = 'That email address does not look right.';
      return;
    }

    const gate = rateCheck();
    if (!gate.ok) {
      status.className = 'os-mail-status is-error';
      status.textContent = gate.message;
      return;
    }

    button.disabled = true;
    status.className = 'os-mail-status';
    status.textContent = 'Sending…';

    if (!MAIL_ENDPOINT) {
      // No endpoint configured: hand a fully composed message to the visitor's
      // own mail client rather than silently dropping it.
      const body = `${data.message}\n\n— ${data.name} <${data.email}>`;
      window.location.href =
        `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(data.subject)}&body=${encodeURIComponent(body)}`;
      recordSend(gate.log);
      status.textContent = 'Opening your mail app…';
      button.disabled = false;
      return;
    }

    try {
      const res = await fetch(MAIL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...MAIL_EXTRA, name: data.name, email: data.email,
                               subject: data.subject, message: data.message }),
      });
      if (!res.ok) throw new Error(`Server said ${res.status}`);
      recordSend(gate.log);
      form.querySelectorAll('input:not([readonly]), textarea').forEach((f) => { f.value = ''; });
      status.className = 'os-mail-status is-ok';
      status.textContent = 'Sent. Thanks — I will get back to you.';
    } catch (err) {
      status.className = 'os-mail-status is-error';
      status.textContent = `Could not send (${err.message}). Email ${CONTACT_EMAIL} directly.`;
    } finally {
      button.disabled = false;
    }
  });
}

// -------------------------------------------------------------- Site nav

// The path nav is a pill fixed near the top of the window, which on this path
// puts a second floating bar directly under the menubar. Rather than build a
// copy in the menubar and wire up duplicate handlers, the real element moves
// in and moves back out — same buttons, same listeners, no second source of
// truth about which path is active.
let navReturn = null;

function adoptNav() {
  if (!isDesktop()) return;      // the menubar is hidden below this width
  const nav = document.getElementById('path-nav');
  const bar = document.querySelector('.macos-menubar');
  const right = bar?.querySelector('.menubar-right');
  if (!nav || !bar || !right || navReturn) return;
  navReturn = { parent: nav.parentNode, next: nav.nextSibling };
  bar.insertBefore(nav, right);
  nav.classList.add('in-menubar');
}

function releaseNav() {
  const nav = document.getElementById('path-nav');
  if (!nav || !navReturn) return;
  navReturn.parent.insertBefore(nav, navReturn.next);
  nav.classList.remove('in-menubar');
  navReturn = null;
}

// ------------------------------------------------------------ lifecycle

export function init() {
  const win = document.getElementById('tech-file-tree');
  initWindowResize(win);
  initMenubar();
  initDock();
  adoptNav();
  // The desktop icons are wired in transition-tech.js, which has no reach into
  // this module's window manager; an event is the seam between the two.
  on(window, 'os-open-app', (e) => openAppWindow(e.detail));
  on(window, 'os-open-cv', () => openWordDoc());

  // Crossing the breakpoint after load would otherwise leave the nav parked in
  // a menubar that has just been hidden, taking the site's navigation with it.
  const onBreakpoint = () => { if (isDesktop()) adoptNav(); else releaseNav(); };
  desktopQuery.addEventListener('change', onBreakpoint);
  cleanups.push(() => desktopQuery.removeEventListener('change', onBreakpoint));
}

export function destroy() {
  releaseNav();
  while (cleanups.length) cleanups.pop()();
  closeDialog();
  document.querySelectorAll('.os-mail, .os-dock, .os-toast, .os-app, .os-word').forEach((el) => el.remove());
  const bar = document.querySelector('.macos-menubar');
  if (bar) delete bar.dataset.menubarInit;
  const surface = document.querySelector('.desktop-surface');
  surface?.classList.remove('os-asleep', 'os-scanlines', 'os-invert', 'os-barrel-roll');
}
