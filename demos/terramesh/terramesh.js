// TerraMesh window. No dependencies beyond the kit's mark.js. Every loop
// stops when its section is off screen, and reduced motion gets the settled
// state of each piece instead of its animation.
(() => {
  'use strict';

  const C = {
    forest: '#163F32', paper: '#F3F5EE', lime: '#D5EE9B', night: '#0D2A2E',
    fog: '#C9D5D6', land: '#2C5A4B', gain: '#F0C067', go: '#6FC39A',
  };
  const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const Mark = window.TerraMeshMark;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // Inside the portfolio's desktop window, the page's own back link would
  // be a second way out of the same window.
  try { if (window.self !== window.top) document.documentElement.classList.add('in-window'); }
  catch (_) { document.documentElement.classList.add('in-window'); }

  // One observer per job. `once` reveals stay revealed; loops get told when
  // they are visible so they can sleep the rest of the time.
  function onceInView(els, fn, threshold = 0.3) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); fn(e.target); } });
    }, { threshold });
    els.forEach((el) => io.observe(el));
  }
  function whileInView(el, fn, threshold = 0.05) {
    new IntersectionObserver((entries) => entries.forEach((e) => fn(e.isIntersecting)), { threshold }).observe(el);
  }

  // A canvas sized to its box at device resolution. Returns a resize function.
  function fit(cv) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect();
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    return { w: cv.width, h: cv.height, dpr };
  }

  // Pointy-top hexagon path
  function hexPath(ctx, x, y, r) {
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 180 * (60 * k - 30);
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }
  function hexGrid(w, h, r) {
    const hw = Math.sqrt(3) * r, cells = [];
    for (let row = -1; row * 1.5 * r < h + r * 2; row++) {
      for (let col = -1; col * hw < w + hw; col++) {
        cells.push({ x: hw * (col + 0.5 * (row & 1)), y: 1.5 * r * row });
      }
    }
    return cells;
  }

  // The valley under the fog: a frame of the Gaia reel, Sentinel-2 over DEM.
  const valley = new Image();
  valley.src = '../../assets/terramesh/cover-valley.avif';
  function drawCover(ctx, img, w, h, alpha = 1) {
    if (!img.complete || !img.naturalWidth) return false;
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
    ctx.globalAlpha = 1;
    return true;
  }

  // ------------------------------------------------------------ reveals
  onceInView($$('.rise'), (el) => el.classList.add('in'), 0.2);
  onceInView($$('.phone, .questions, .flow, .bench'), (el) => el.classList.add('in'), 0.35);

  // ------------------------------------------------------------ 1. hero
  const word = $('.wordmark span');
  word.innerHTML = [...word.textContent].map((ch, i) => `<span class="ch" style="--i:${i}">${ch}</span>`).join('');
  const heroLeaf = $('.hero-leaf');
  requestAnimationFrame(() => {
    $('.wordmark').classList.add('in');
    $('.lede').classList.add('in');
    if (Mark) Mark.play(heroLeaf, { fg: C.lime, bg: C.forest });
  });

  // Faint mesh behind the mark, breathing with a slow travelling fog.
  (function heroMesh() {
    const cv = $('.hex-drift'), ctx = cv.getContext('2d');
    let W, H, cells, R, run = false, raf = 0, last = 0;
    const size = () => { ({ w: W, h: H } = fit(cv)); R = Math.max(18, Math.min(W, H) / 16); cells = hexGrid(W, H, R); };
    const frame = (now) => {
      raf = run ? requestAnimationFrame(frame) : 0;
      if (now - last < 33) return; last = now;
      const t = now / 1000;
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 1;
      for (const c of cells) {
        const n = Math.sin(c.x * 0.006 + t * 0.35) + Math.sin(c.y * 0.008 - t * 0.27) + Math.sin((c.x + c.y) * 0.004 + t * 0.2);
        const a = clamp(0.03 + 0.06 * (n + 3) / 6, 0, 0.12);
        hexPath(ctx, c.x, c.y, R * 0.96);
        ctx.strokeStyle = `rgba(213,238,155,${a})`;
        ctx.stroke();
      }
    };
    size();
    addEventListener('resize', size);
    if (REDUCE) { run = false; frame(performance.now()); return; }
    whileInView(cv, (v) => { run = v; if (v && !raf) raf = requestAnimationFrame(frame); });
  })();

  // ------------------------------------------------------------ 2. fog
  (function fogWalk() {
    const stage = $('.fog-stage'), cv = $('.fog-canvas'), ctx = cv.getContext('2d');
    const lines = $$('.fog-line');
    const hud = { min: $('[data-hud="min"]'), tiles: $('[data-hud="tiles"]'), fog: $('[data-hud="fog"]') };
    let W, H, dpr, R, cells = [], trail = [], run = false, raf = 0;
    const walker = { x: 0, y: 0, vx: 0, vy: 0 };
    const pointer = { x: 0, y: 0, at: -1e9 };
    let tiles = 0, effort = 0, lastT = 0, t0 = performance.now(), line = 0, lineAt = 0;

    function size() {
      ({ w: W, h: H, dpr } = fit(cv));
      R = Math.max(14 * dpr, Math.min(W, H) / 24);
      const old = cells;
      cells = hexGrid(W, H, R).map((c) => ({ ...c, fog: 1, seen: -1e9, ever: false, glow: 0 }));
      if (!old.length) { walker.x = W * 0.2; walker.y = H * 0.7; }
      trail = [];
    }

    stage.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      pointer.x = (e.clientX - r.left) * dpr; pointer.y = (e.clientY - r.top) * dpr; pointer.at = performance.now();
      stage.classList.add('touched');
    });
    stage.addEventListener('pointerleave', () => { pointer.at = -1e9; });

    function step(now) {
      const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016); lastT = now;
      const t = (now - t0) / 1000;

      // Autopilot is a slow figure that wanders the whole map; a pointer
      // takes over while it is moving and hands back two seconds after.
      let tx, ty;
      if (now - pointer.at < 2000) { tx = pointer.x; ty = pointer.y; }
      else {
        tx = W * (0.5 + 0.36 * Math.sin(t * 0.21) + 0.06 * Math.sin(t * 0.83));
        ty = H * (0.55 + 0.30 * Math.sin(t * 0.33 + 1.2) + 0.05 * Math.cos(t * 0.71));
      }
      const k = 2.2, damp = 0.86;
      walker.vx = (walker.vx + (tx - walker.x) * k * dt) * damp;
      walker.vy = (walker.vy + (ty - walker.y) * k * dt) * damp;
      const sp = Math.hypot(walker.vx, walker.vy), max = 260 * dpr * dt;
      if (sp > max) { walker.vx *= max / sp; walker.vy *= max / sp; }
      walker.x += walker.vx; walker.y += walker.vy;
      const moved = Math.hypot(walker.vx, walker.vy);
      if (moved > 0.3) effort += dt;
      if (!trail.length || Math.hypot(trail[trail.length - 1].x - walker.x, trail[trail.length - 1].y - walker.y) > 3 * dpr) {
        trail.push({ x: walker.x, y: walker.y, t: now });
        if (trail.length > 420) trail.shift();
      }

      // Seeing clears fog near the walker; time lets it come back.
      const reach = R * 1.9;
      let fogSum = 0;
      for (const c of cells) {
        const d = Math.hypot(c.x - walker.x, c.y - walker.y);
        if (d < reach) {
          const before = c.fog;
          c.fog = Math.max(0, c.fog - dt * 3.2 * (1 - d / reach + 0.25));
          c.seen = now;
          if (!c.ever && c.fog < 0.5) { c.ever = true; tiles++; c.glow = 1; }
          if (before > 0.5 && c.fog <= 0.5) c.glow = 1;
        } else if (now - c.seen > 3500) {
          c.fog = Math.min(1, c.fog + dt / 10);
        }
        c.glow = Math.max(0, c.glow - dt * 1.4);
        fogSum += c.fog;
      }

      // Captions: one at a time, in order, looping
      if (now - lineAt > 3400) {
        lines[line].classList.remove('is-on');
        line = (line + 1) % lines.length;
        lines[line].classList.add('is-on');
        lineAt = now;
      }

      draw(now);
      hud.min.textContent = Math.floor(effort * 1.5);
      hud.tiles.textContent = tiles;
      hud.fog.textContent = Math.round(100 * fogSum / cells.length);
    }

    function draw(now) {
      ctx.fillStyle = C.land;
      ctx.fillRect(0, 0, W, H);
      drawCover(ctx, valley, W, H, 1);

      // Fog over each tile, with the tile edge showing once it has been walked
      for (const c of cells) {
        hexPath(ctx, c.x, c.y, R * 0.985);
        if (c.fog > 0.01) { ctx.fillStyle = `rgba(201,213,214,${0.9 * c.fog})`; ctx.fill(); }
        ctx.lineWidth = 1 * dpr;
        ctx.strokeStyle = c.ever ? `rgba(213,238,155,${0.18 + 0.6 * c.glow})` : 'rgba(13,42,46,0.10)';
        ctx.stroke();
      }

      // Trail: brightest at the walker, fading back along the path
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 1; i < trail.length; i++) {
        const a = i / trail.length;
        ctx.strokeStyle = `rgba(213,238,155,${0.08 + 0.85 * a * a})`;
        ctx.lineWidth = (1.2 + 2.4 * a) * dpr;
        ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke();
      }

      // Walker and its listening ring
      const pulse = (now / 1400) % 1;
      ctx.beginPath(); ctx.arc(walker.x, walker.y, (8 + 30 * pulse) * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(213,238,155,${0.7 * (1 - pulse)})`; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
      ctx.beginPath(); ctx.arc(walker.x, walker.y, 6 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = C.lime; ctx.fill();
      ctx.lineWidth = 2 * dpr; ctx.strokeStyle = C.night; ctx.stroke();
    }

    function loop(now) { raf = run ? requestAnimationFrame(loop) : 0; step(now); }

    size();
    addEventListener('resize', size);
    valley.addEventListener('load', () => { if (!run) draw(performance.now()); });

    if (REDUCE) {
      // Settled state: a walked path with its tiles cleared, nothing moving.
      for (let i = 0; i <= 80; i++) {
        const u = i / 80;
        walker.x = W * (0.12 + 0.76 * u); walker.y = H * (0.7 - 0.35 * Math.sin(u * Math.PI));
        trail.push({ x: walker.x, y: walker.y, t: 0 });
        for (const c of cells) if (Math.hypot(c.x - walker.x, c.y - walker.y) < R * 1.6) { c.fog = 0; if (!c.ever) { c.ever = true; tiles++; } }
      }
      draw(0);
      hud.tiles.textContent = tiles; hud.min.textContent = 20;
      hud.fog.textContent = Math.round(100 * cells.reduce((s, c) => s + c.fog, 0) / cells.length);
      return;
    }
    whileInView(stage, (v) => { run = v; if (v && !raf) { lastT = performance.now(); raf = requestAnimationFrame(loop); } });
  })();

  // ------------------------------------------------------------ 3. missions
  $$('.mission').forEach((m, i) => m.style.setProperty('--i', i));
  onceInView($$('.mission'), (m) => {
    m.classList.add('in');
    const cv = $('.m-leaf', m);
    const cs = getComputedStyle(m);
    const opts = { style: m.dataset.style, fg: cs.getPropertyValue('--accent').trim(), bg: cs.getPropertyValue('--tint').trim() };
    if (Mark) setTimeout(() => Mark.play(cv, opts), 250 + 120 * Number(m.style.getPropertyValue('--i') || 0));
  }, 0.25);

  // A gentle tilt toward the pointer, desktop only
  if (!REDUCE && matchMedia('(hover: hover)').matches) {
    $$('.mission').forEach((m) => {
      m.addEventListener('pointermove', (e) => {
        const r = m.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        m.classList.add('tilting');
        m.style.setProperty('--ry', `${(x * 8).toFixed(2)}deg`);
        m.style.setProperty('--rx', `${(-y * 6).toFixed(2)}deg`);
      });
      m.addEventListener('pointerleave', () => {
        m.classList.remove('tilting');
        m.style.setProperty('--ry', '0deg'); m.style.setProperty('--rx', '0deg');
      });
    });
  }

  // Videos load when first near the screen and only play while visible.
  $$('video[data-src]').forEach((v) => {
    if (REDUCE) return;   // the poster frame is the settled state
    whileInView(v, (vis) => {
      if (vis) {
        // H.264 where the browser has it (smaller here), VP9 where it does not
        if (!v.src) v.src = v.canPlayType('video/mp4; codecs="avc1.42E01E"') ? v.dataset.src : v.dataset.src.replace(/\.mp4$/, '.webm');
        const p = v.play(); if (p && p.catch) p.catch(() => {});
      } else v.pause();
    }, 0.2);
  });

  // ------------------------------------------------------------ 4. absence curve
  (function absence() {
    const fig = $('.absence'), path = $('.curve', fig);
    const lambda = Math.log(5) / 20;            // reaches 0.8 at 20 minutes
    let d = '';
    for (let m = 0; m <= 30; m += 0.25) {
      const p = 1 - Math.exp(-lambda * m);
      d += `${m ? 'L' : 'M'}${(40 + m * 12).toFixed(1)} ${(200 - 180 * p).toFixed(1)}`;
    }
    path.setAttribute('d', d);
    const len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = REDUCE ? 0 : len;
    if (REDUCE) { fig.classList.add('done'); return; }
    onceInView([fig], () => {
      path.style.transition = 'stroke-dashoffset 1.8s cubic-bezier(.16,1,.3,1)';
      requestAnimationFrame(() => { path.style.strokeDashoffset = 0; });
      setTimeout(() => fig.classList.add('done'), 1300);
    }, 0.4);
  })();

  // ------------------------------------------------------------ 5. consensus
  (function consensus() {
    const vote = $('.vote'), leaf = $('.v-leaf');
    const voters = $$('.voters li');
    const settle = () => { vote.classList.add('s1', 's3'); voters.forEach((v) => v.classList.add('on')); };
    if (Mark) Mark.draw(leaf, { style: 'bio', fg: '#2F5A38', bg: '#FFFFFF' });
    if (REDUCE) return settle();
    onceInView([vote], () => {
      setTimeout(() => vote.classList.add('s1'), 500);
      voters.forEach((v, i) => setTimeout(() => v.classList.add('on'), 1100 + i * 450));
      setTimeout(() => vote.classList.add('s3'), 1100 + voters.length * 450 + 300);
    }, 0.4);
  })();

  // ------------------------------------------------------------ 6. tiles not pins
  (function tiles() {
    const cv = $('.tile-canvas'), ctx = cv.getContext('2d');
    let W, H, dpr, run = false, raf = 0, t0 = performance.now();
    const size = () => ({ w: W, h: H, dpr } = fit(cv));
    const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

    // Nearest hex centre for a point, in the same pointy-top layout as hexGrid
    function cellOf(px, py, r) {
      const q = (Math.sqrt(3) / 3 * px - py / 3) / r, rr = (2 / 3 * py) / r;
      let x = q, z = rr, y = -x - z;
      let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
      const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
      if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
      return { x: r * Math.sqrt(3) * (rx + rz / 2), y: r * 1.5 * rz };
    }

    function draw(now) {
      const T = 7, u = ((now - t0) / 1000 % T) / T;          // one loop, 0..1
      const coarsen = ease(clamp((u - 0.18) / 0.32, 0, 1));
      const fill = clamp((u - 0.52) / 0.12, 0, 1);
      const out = clamp((u - 0.9) / 0.1, 0, 1);
      const r = (10 + 62 * coarsen) * dpr;
      const pin = { x: W * 0.57, y: H * 0.46 };

      ctx.fillStyle = C.night; ctx.fillRect(0, 0, W, H);
      drawCover(ctx, valley, W, H, 0.55);
      ctx.fillStyle = 'rgba(13,42,46,0.35)'; ctx.fillRect(0, 0, W, H);

      // Grid, anchored at the centre so it grows out from the middle
      ctx.save(); ctx.translate(W / 2, H / 2);
      const hw = Math.sqrt(3) * r, n = Math.ceil(Math.max(W, H) / (1.5 * r)) + 2;
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = `rgba(243,245,238,${0.12 + 0.18 * coarsen})`;
      for (let row = -n; row <= n; row++) for (let col = -n; col <= n; col++) {
        hexPath(ctx, hw * (col + row / 2), 1.5 * r * row, r); ctx.stroke();
      }
      const cell = cellOf(pin.x - W / 2, pin.y - H / 2, r);
      if (fill > 0) {
        hexPath(ctx, cell.x, cell.y, r);
        ctx.fillStyle = `rgba(213,238,155,${0.42 * fill * (1 - out)})`; ctx.fill();
        ctx.lineWidth = 2.5 * dpr; ctx.strokeStyle = `rgba(213,238,155,${0.95 * fill * (1 - out)})`; ctx.stroke();
      }
      ctx.restore();

      // The exact point: a pin that pulses, then dissolves into its tile
      const pinA = 1 - clamp((u - 0.4) / 0.16, 0, 1);
      if (pinA > 0) {
        const p = (now / 900) % 1;
        ctx.beginPath(); ctx.arc(pin.x, pin.y, (6 + 20 * p) * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(240,192,103,${0.8 * (1 - p) * pinA})`; ctx.lineWidth = 2 * dpr; ctx.stroke();
        ctx.beginPath(); ctx.arc(pin.x, pin.y, 6 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(240,192,103,${pinA})`; ctx.fill();
      }

      // Labels
      ctx.font = `600 ${13 * dpr}px Figtree, sans-serif`;
      ctx.fillStyle = `rgba(240,192,103,${pinA})`;
      ctx.fillText('Exact point: stays private', 18 * dpr, H - 20 * dpr);
      ctx.fillStyle = `rgba(213,238,155,${fill * (1 - out)})`;
      ctx.fillText('Public: the tile it falls in', 18 * dpr, H - 20 * dpr);
    }
    const loop = (now) => { raf = run ? requestAnimationFrame(loop) : 0; draw(now); };
    size(); addEventListener('resize', size);
    if (REDUCE) { t0 = performance.now() - 0.7 * 7000; const still = () => draw(t0 + 0.7 * 7000); still(); valley.addEventListener('load', still); return; }
    whileInView(cv, (v) => { run = v; if (v && !raf) raf = requestAnimationFrame(loop); });
  })();

})();
