// ============================================
// Forest Path: Tree silhouettes + Leaf particles
// + "Zoom through branches" entrance transition
// ============================================

import { randomRange, prefersReducedMotion, sleep } from './utils.js';
import { init as initForestMap, destroy as destroyForestMap } from './forest-map.js';

const LEAF_COUNT = 20;
let leaves = [];

// Create SVG tree silhouettes for the parallax layers
export function initTreeLayers() {
  const layers = document.querySelectorAll('.tree-layer');
  if (!layers.length) return;

  const treeSvgs = [
    generateTreeSilhouette('#1a3d2e', 0.9),
    generateTreeSilhouette('#2d5f3f', 0.65),
    generateTreeSilhouette('#4a9b6a', 0.4),
  ];

  layers.forEach((layer, i) => {
    if (treeSvgs[i]) {
      layer.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(treeSvgs[i])}")`;
      layer.style.backgroundSize = 'auto 70%';
      layer.style.backgroundPosition = 'bottom center';
      layer.style.backgroundRepeat = 'repeat-x';
    }
  });
}

function generateTreeSilhouette(color, opacity) {
  const w = 400;
  const h = 500;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <g fill="${color}" opacity="${opacity}">
      <polygon points="50,${h} 50,180 30,200 55,170 35,190 60,150 40,170 65,120 45,140 70,80 55,100 75,40 95,100 80,80 105,140 85,120 110,170 90,150 115,190 95,170 120,200 100,180 100,${h}"/>
      <polygon points="160,${h} 160,220 145,240 170,210 155,230 175,190 158,210 180,150 163,175 185,110 170,135 190,70 210,135 195,110 215,175 200,150 222,210 205,190 225,230 210,210 235,240 220,220 220,${h}"/>
      <polygon points="290,${h} 290,260 278,275 295,250 283,265 300,230 288,245 305,200 293,220 310,170 300,190 315,140 330,190 320,170 335,220 325,200 340,245 330,230 345,265 335,250 350,275 340,260 340,${h}"/>
      <rect x="68" y="300" width="14" height="${h - 300}" rx="2"/>
      <rect x="183" y="340" width="16" height="${h - 340}" rx="2"/>
      <rect x="308" y="370" width="12" height="${h - 370}" rx="2"/>
    </g>
  </svg>`;
}

// Leaf particle system
export function startLeaves() {
  if (prefersReducedMotion()) return;

  const container = document.getElementById('leaf-container');
  if (!container) return;

  for (let i = 0; i < LEAF_COUNT; i++) {
    const leaf = document.createElement('div');
    leaf.className = 'leaf';
    resetLeaf(leaf);
    container.appendChild(leaf);
    leaves.push(leaf);
  }
}

function resetLeaf(leaf) {
  const x = randomRange(0, 100);
  const w = randomRange(10, 20);
  const h = w * randomRange(1.1, 1.6);
  const duration = randomRange(7, 16);
  const delay = randomRange(0, 12);
  const hue = randomRange(85, 150);
  const sat = randomRange(40, 70);
  const light = randomRange(30, 55);

  leaf.style.left = x + '%';
  leaf.style.width = w + 'px';
  leaf.style.height = h + 'px';
  leaf.style.background = `hsl(${hue}, ${sat}%, ${light}%)`;
  leaf.style.animationDuration = duration + 's';
  leaf.style.animationDelay = delay + 's';
  leaf.style.opacity = randomRange(0.4, 0.8);
  leaf.style.borderRadius = '50% 0 50% 0';
}

export function stopLeaves() {
  const container = document.getElementById('leaf-container');
  if (container) container.innerHTML = '';
  leaves = [];
}

// Parallax scroll handler
export function updateParallax(scrollY) {
  const layers = document.querySelectorAll('.tree-layer');
  const speeds = [0.3, 0.15, 0.05];
  layers.forEach((layer, i) => {
    layer.style.transform = `translateY(${scrollY * speeds[i]}px)`;
  });
}

// Start/Stop
export function start() {
  initTreeLayers();
  startLeaves();
  initForestMap(document.getElementById('forest-map-container'));
}

export function stop() {
  stopLeaves();
  destroyForestMap();
}

// ============================================
// "Zoom through branches" entrance transition
// ============================================
// Continuous rAF-driven rush through organic branch silhouettes
// with SVG leaf particles and speed streaks.

// ---- Helpers ----

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Add small random bumps along a path for bark-like texture
function noisyLine(x1, y1, x2, y2, steps, amplitude) {
  let d = '';
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const mx = lerp(x1, x2, t) + randomRange(-amplitude, amplitude);
    const my = lerp(y1, y2, t) + randomRange(-amplitude, amplitude);
    d += `L${mx},${my} `;
  }
  return d;
}

// ---- Organic branch shape generators ----

function branchGnarledTrunk(w, h, side) {
  const tw = randomRange(40, 90);
  const fromTop = Math.random() > 0.5;
  const xBase = side === 'left' ? randomRange(-20, w * 0.12) : randomRange(w * 0.88, w + 20);
  const dir = side === 'left' ? 1 : -1;
  const y1 = fromTop ? -10 : h + 10;
  const y2 = fromTop ? randomRange(h * 0.5, h * 0.8) : randomRange(h * 0.2, h * 0.5);

  // Organic S-curve trunk using cubic beziers
  const cx1 = xBase + randomRange(15, 50) * dir;
  const cy1 = lerp(y1, y2, 0.25) + randomRange(-30, 30);
  const cx2 = xBase + randomRange(30, 80) * dir;
  const cy2 = lerp(y1, y2, 0.65) + randomRange(-20, 20);

  // Sub-branches with natural curves
  const b1t = randomRange(0.25, 0.4);
  const b1x = lerp(xBase, cx2, b1t) + tw * 0.5 * dir;
  const b1y = lerp(y1, y2, b1t);
  const b1ex = b1x + randomRange(w * 0.12, w * 0.35) * dir;
  const b1ey = b1y + randomRange(-60, 40);
  const b1cpx = lerp(b1x, b1ex, 0.5) + randomRange(-20, 20) * dir;
  const b1cpy = b1ey - randomRange(20, 60);

  const b2t = randomRange(0.55, 0.75);
  const b2x = lerp(xBase, cx2, b2t) + tw * 0.5 * dir;
  const b2y = lerp(y1, y2, b2t);
  const b2ex = b2x + randomRange(w * 0.08, w * 0.28) * dir;
  const b2ey = b2y + randomRange(15, 70);
  const b2cpx = lerp(b2x, b2ex, 0.6);
  const b2cpy = b2ey - randomRange(10, 40);

  const bark = randomRange(3, 8); // bark noise amplitude

  return `M${xBase},${y1}
    ${noisyLine(xBase, y1, xBase + tw, y1, 4, bark)}
    L${xBase + tw},${y1}
    C${cx1 + tw},${cy1} ${cx2 + tw * 0.8},${cy2} ${cx2 + tw * 0.5},${y2}
    C${cx2},${cy2 + 10} ${cx1 + 5},${cy1 + 10} ${xBase},${y1} Z
    M${b1x},${b1y}
    C${b1cpx},${b1cpy} ${b1cpx + 10 * dir},${b1ey - 10} ${b1ex},${b1ey}
    L${b1ex - 5 * dir},${b1ey + 8}
    C${b1cpx + 5 * dir},${b1ey + 5} ${b1cpx - 5 * dir},${b1cpy + 12} ${b1x + 5 * dir},${b1y + 10}
    Z
    M${b2x},${b2y}
    C${b2cpx},${b2cpy} ${b2cpx + 8 * dir},${b2ey - 8} ${b2ex},${b2ey}
    L${b2ex - 4 * dir},${b2ey + 6}
    C${b2cpx + 3 * dir},${b2ey + 3} ${b2cpx - 3 * dir},${b2cpy + 8} ${b2x + 4 * dir},${b2y + 8}
    Z`;
}

function branchSweepingArc(w, h, side) {
  const tw = randomRange(18, 40);
  const startX = side === 'left' ? randomRange(-25, 5) : randomRange(w - 5, w + 25);
  const startY = randomRange(h * 0.02, h * 0.25);
  const dir = side === 'left' ? 1 : -1;

  // Long dramatic arc across the screen
  const peakX = startX + randomRange(w * 0.3, w * 0.6) * dir;
  const peakY = startY + randomRange(h * 0.02, h * 0.15);
  const endX = startX + randomRange(w * 0.1, w * 0.3) * dir;
  const endY = startY + randomRange(h * 0.3, h * 0.6);

  // Drooping sub-twigs along the arc
  const twigs = [];
  const twigCount = Math.floor(randomRange(2, 5));
  for (let i = 0; i < twigCount; i++) {
    const t = randomRange(0.2, 0.8);
    const tx = lerp(startX, endX, t) + (peakX - startX) * t * (1 - t) * 2;
    const ty = lerp(startY, endY, t) + (peakY - startY) * t * (1 - t) * 2 + tw * 0.5;
    const tlen = randomRange(30, 90);
    const tsway = randomRange(-15, 15);
    twigs.push(`M${tx},${ty} C${tx + tsway},${ty + tlen * 0.4} ${tx + tsway * 0.5},${ty + tlen * 0.7} ${tx + tsway * 0.3},${ty + tlen}
      L${tx + tsway * 0.3 + 3},${ty + tlen - 2}
      C${tx + tsway * 0.5 + 3},${ty + tlen * 0.7} ${tx + tsway + 3},${ty + tlen * 0.4} ${tx + 4},${ty} Z`);
  }

  return `M${startX},${startY}
    C${lerp(startX, peakX, 0.5)},${peakY - 20} ${peakX},${peakY} ${endX},${endY}
    L${endX - tw * 0.2 * dir},${endY + tw * 0.4}
    C${peakX - tw * 0.15 * dir},${peakY + tw} ${lerp(startX, peakX, 0.5) - tw * 0.1 * dir},${peakY + tw - 10} ${startX},${startY + tw}
    Z ${twigs.join(' ')}`;
}

function branchCanopyMass(w, h) {
  const segments = Math.floor(randomRange(5, 9));
  const segW = w / segments;
  let d = `M-10,-10 L${w + 10},-10 `;

  // Right side down
  d += `L${w + 10},${randomRange(h * 0.05, h * 0.12)} `;

  // Irregular organic canopy bottom edge using cubic beziers
  for (let i = segments; i >= 0; i--) {
    const x = i * segW;
    const depth = randomRange(h * 0.08, h * 0.35);
    const cpx1 = x + segW * randomRange(0.2, 0.8);
    const cpy1 = depth + randomRange(-30, 40);
    const cpx2 = x + segW * randomRange(-0.2, 0.3);
    const cpy2 = depth + randomRange(-20, 30);
    d += `C${cpx1},${cpy1} ${cpx2},${cpy2} ${Math.max(x, -10)},${depth} `;
  }

  d += `L-10,${randomRange(h * 0.05, h * 0.12)} Z`;

  // Hanging foliage clusters (groups of overlapping leaf-like ellipses)
  const clusterCount = Math.floor(randomRange(3, 7));
  for (let i = 0; i < clusterCount; i++) {
    const cx = randomRange(w * 0.05, w * 0.95);
    const cy = randomRange(h * 0.1, h * 0.3);
    const clusterSize = randomRange(15, 40);
    for (let j = 0; j < 3; j++) {
      const lx = cx + randomRange(-clusterSize * 0.5, clusterSize * 0.5);
      const ly = cy + randomRange(-clusterSize * 0.3, clusterSize * 0.3);
      const lr = randomRange(8, clusterSize * 0.6);
      const lry = lr * randomRange(0.5, 0.9);
      const rot = randomRange(-40, 40);
      // Approximate ellipse with two arcs
      d += ` M${lx - lr},${ly}
        A${lr},${lry} ${rot} 1 1 ${lx + lr},${ly}
        A${lr},${lry} ${rot} 1 1 ${lx - lr},${ly} Z`;
    }
  }

  // Thin hanging vines
  const vineCount = Math.floor(randomRange(3, 6));
  for (let i = 0; i < vineCount; i++) {
    const vx = randomRange(w * 0.08, w * 0.92);
    const vy = randomRange(h * 0.08, h * 0.22);
    const vlen = randomRange(h * 0.06, h * 0.22);
    const sway1 = randomRange(-20, 20);
    const sway2 = randomRange(-15, 15);
    d += ` M${vx - 1.5},${vy}
      C${vx + sway1},${vy + vlen * 0.35} ${vx + sway2},${vy + vlen * 0.7} ${vx},${vy + vlen}
      C${vx + sway2 + 2},${vy + vlen * 0.7} ${vx + sway1 + 2},${vy + vlen * 0.35} ${vx + 2},${vy} Z`;
  }

  return d;
}

function branchDiagonalLimb(w, h) {
  const tw = randomRange(20, 50);
  const fromLeft = Math.random() > 0.5;
  const fromTop = Math.random() > 0.5;

  const sx = fromLeft ? randomRange(-15, w * 0.08) : randomRange(w * 0.92, w + 15);
  const sy = fromTop ? randomRange(-15, h * 0.08) : randomRange(h * 0.92, h + 15);
  const ex = fromLeft ? randomRange(w * 0.4, w * 0.8) : randomRange(w * 0.2, w * 0.6);
  const ey = fromTop ? randomRange(h * 0.4, h * 0.75) : randomRange(h * 0.25, h * 0.6);

  // Organic S-curve instead of straight diagonal
  const cp1x = lerp(sx, ex, 0.3) + randomRange(-60, 60);
  const cp1y = lerp(sy, ey, 0.2) + randomRange(-40, 40);
  const cp2x = lerp(sx, ex, 0.7) + randomRange(-50, 50);
  const cp2y = lerp(sy, ey, 0.8) + randomRange(-30, 30);

  // Perpendicular offset for organic width (varies along length)
  const angle = Math.atan2(ey - sy, ex - sx);
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  const tw1 = tw;
  const tw2 = tw * randomRange(0.4, 0.7); // tapers toward tip

  // Small fork at the end
  const forkAngle = angle + randomRange(-0.6, 0.6);
  const forkLen = randomRange(30, 80);
  const fex = ex + Math.cos(forkAngle) * forkLen;
  const fey = ey + Math.sin(forkAngle) * forkLen;

  return `M${sx},${sy}
    C${cp1x},${cp1y} ${cp2x},${cp2y} ${ex},${ey}
    L${fex},${fey}
    L${fex + nx * 5},${fey + ny * 5}
    L${ex + nx * tw2},${ey + ny * tw2}
    C${cp2x + nx * tw1 * 0.8},${cp2y + ny * tw1 * 0.8} ${cp1x + nx * tw1},${cp1y + ny * tw1} ${sx + nx * tw1},${sy + ny * tw1}
    Z`;
}

function randomBranchPath(w, h, side) {
  const generators = [
    () => branchGnarledTrunk(w, h, side),
    () => branchSweepingArc(w, h, side),
    () => branchCanopyMass(w, h),
    () => branchDiagonalLimb(w, h),
  ];
  return generators[Math.floor(Math.random() * generators.length)]();
}

function createBranchLayer(depth) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';

  const branchCount = Math.floor(randomRange(2, 4));
  const sides = ['left', 'right'];

  for (let i = 0; i < branchCount; i++) {
    const side = sides[i % 2];
    const pathD = randomBranchPath(w, h, side);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);

    const hue = Math.floor(randomRange(115, 155));
    const sat = Math.floor(randomRange(30, 60));
    const light = Math.floor(randomRange(6 + depth * 3, 16 + depth * 5));
    path.setAttribute('fill', `hsl(${hue},${sat}%,${light}%)`);
    svg.appendChild(path);
  }

  // Leaf clusters scattered across layer
  const leafGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const leafCount = Math.floor(randomRange(10, 25));
  for (let i = 0; i < leafCount; i++) {
    const lx = randomRange(w * 0.02, w * 0.98);
    const ly = randomRange(h * 0.02, h * 0.75);
    const lr = randomRange(5, 22);
    const lry = lr * randomRange(0.4, 0.75);
    const leafEl = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    leafEl.setAttribute('cx', lx);
    leafEl.setAttribute('cy', ly);
    leafEl.setAttribute('rx', lr);
    leafEl.setAttribute('ry', lry);
    leafEl.setAttribute('transform', `rotate(${randomRange(-70, 70)} ${lx} ${ly})`);
    const leafHue = Math.floor(randomRange(80, 155));
    const leafLight = Math.floor(randomRange(10 + depth * 3, 28 + depth * 5));
    leafEl.setAttribute('fill', `hsl(${leafHue},${Math.floor(randomRange(35, 70))}%,${leafLight}%)`);
    leafGroup.appendChild(leafEl);
  }
  svg.appendChild(leafGroup);

  return svg;
}

// ---- SVG leaf particle for the rush ----

function spawnLeaf(container, duration) {
  const size = randomRange(14, 32);
  const startX = randomRange(5, 95);
  const startY = randomRange(5, 95);
  const hue = Math.floor(randomRange(80, 160));
  const sat = Math.floor(randomRange(40, 75));
  const light = Math.floor(randomRange(22, 52));
  const color = `hsl(${hue},${sat}%,${light}%)`;
  const initRot = randomRange(0, 360);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 28');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size * 1.4);
  svg.style.cssText = `
    position:absolute;
    left:${startX}%;top:${startY}%;
    opacity:0.85;
    transform:rotate(${initRot}deg) scale(0.2);
    transition:transform ${duration}ms cubic-bezier(0.2,0,0.3,1), opacity ${duration * 0.8}ms ease-out;
    z-index:8;
    will-change:transform,opacity;
    filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3));
  `;

  // Organic leaf shape with midrib
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M10,0 C6,5 0,12 1,20 C3,26 7,28 10,28 C13,28 17,26 19,20 C20,12 14,5 10,0 Z');
  path.setAttribute('fill', color);
  svg.appendChild(path);

  const midrib = document.createElementNS(ns, 'line');
  midrib.setAttribute('x1', '10'); midrib.setAttribute('y1', '3');
  midrib.setAttribute('x2', '10'); midrib.setAttribute('y2', '26');
  midrib.setAttribute('stroke', 'rgba(0,0,0,0.12)');
  midrib.setAttribute('stroke-width', '0.5');
  svg.appendChild(midrib);

  container.appendChild(svg);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const endRot = initRot + randomRange(180, 540);
      const endScale = randomRange(1.2, 2.5);
      const tx = randomRange(-200, 200);
      const ty = randomRange(-200, 200);
      svg.style.transform = `rotate(${endRot}deg) rotateY(${randomRange(-60,60)}deg) scale(${endScale}) translate(${tx}px,${ty}px)`;
      svg.style.opacity = '0';
    });
  });

  setTimeout(() => svg.remove(), duration + 100);
}

// ---- Speed streaks during rush ----

function spawnStreak(container) {
  const streak = document.createElement('div');
  const y = randomRange(5, 95);
  const width = randomRange(30, 60);
  const angle = randomRange(-8, 8);
  const duration = randomRange(300, 500);
  const fromLeft = Math.random() > 0.5;

  streak.style.cssText = `
    position:absolute;
    top:${y}%;
    ${fromLeft ? 'left:-10%' : 'right:-10%'};
    width:${width}vw;
    height:${randomRange(1, 2)}px;
    background:linear-gradient(${fromLeft ? '90deg' : '270deg'}, transparent, rgba(160,210,160,0.2), rgba(200,240,200,0.35), transparent);
    transform:rotate(${angle}deg) ${fromLeft ? 'translateX(-100%)' : 'translateX(100%)'};
    opacity:0;
    z-index:9;
    pointer-events:none;
    border-radius:1px;
  `;
  container.appendChild(streak);

  requestAnimationFrame(() => {
    streak.style.transition = `transform ${duration}ms cubic-bezier(0.1,0,0.2,1), opacity ${duration * 0.5}ms ease`;
    streak.style.transform = `rotate(${angle}deg) ${fromLeft ? 'translateX(120vw)' : 'translateX(-120vw)'}`;
    streak.style.opacity = '1';
  });

  setTimeout(() => {
    streak.style.opacity = '0';
    setTimeout(() => streak.remove(), 200);
  }, duration * 0.6);
}

// ---- Main entrance transition (continuous rAF loop) ----

export async function enter() {
  if (prefersReducedMotion()) return;

  const overlay = document.getElementById('transition-overlay');
  overlay.classList.add('active');
  const content = overlay.querySelector('#transition-content');

  // Create 4 depth layers of branches up front
  const layers = [];
  for (let depth = 0; depth < 4; depth++) {
    const layer = document.createElement('div');
    layer.style.cssText = `
      position:absolute;inset:0;
      opacity:0;
      transform:scale(0.4);
      transform-origin:50% 50%;
      will-change:transform,opacity;
    `;
    layer.appendChild(createBranchLayer(depth));
    content.appendChild(layer);
    layers.push(layer);
  }

  // Container for leaf particles and speed streaks
  const particleContainer = document.createElement('div');
  particleContainer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10;overflow:hidden;';
  content.appendChild(particleContainer);

  // Green vignette
  const vignette = document.createElement('div');
  vignette.style.cssText = `
    position:absolute;inset:0;
    background:radial-gradient(ellipse at 50% 50%, transparent 10%, rgba(13,40,24,0.3) 50%, rgba(13,40,24,0.85) 100%);
    opacity:0;
    z-index:5;
    will-change:opacity;
  `;
  content.appendChild(vignette);

  // Layer timing config: [appearStart, peakStart, fadeStart, fadeEnd] as fraction of total
  const layerTimings = [
    { start: 0.35, peak: 0.45, fadeStart: 0.65, fadeEnd: 0.85 }, // depth 0 (closest, darkest)
    { start: 0.22, peak: 0.32, fadeStart: 0.55, fadeEnd: 0.75 }, // depth 1
    { start: 0.10, peak: 0.18, fadeStart: 0.40, fadeEnd: 0.60 }, // depth 2
    { start: 0.00, peak: 0.08, fadeStart: 0.25, fadeEnd: 0.45 }, // depth 3 (farthest, lightest)
  ];
  const maxOpacities = [1.0, 0.85, 0.65, 0.45];

  const RUSH_DURATION = 1800;
  const start = performance.now();
  let lastLeafTime = 0;
  let lastStreakTime = 0;

  await new Promise(resolve => {
    function tick(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / RUSH_DURATION, 1);
      // Cubic ease-out for overall progression
      const ease = 1 - Math.pow(1 - t, 3);

      // Update each branch layer
      for (let i = 0; i < 4; i++) {
        const lt = layerTimings[i];
        const maxOp = maxOpacities[i];

        // Opacity: fade in then out
        let opacity;
        if (ease < lt.start) {
          opacity = 0;
        } else if (ease < lt.peak) {
          opacity = smoothstep(lt.start, lt.peak, ease) * maxOp;
        } else if (ease < lt.fadeStart) {
          opacity = maxOp;
        } else if (ease < lt.fadeEnd) {
          opacity = (1 - smoothstep(lt.fadeStart, lt.fadeEnd, ease)) * maxOp;
        } else {
          opacity = 0;
        }

        // Scale: starts small, grows past camera
        const scaleProgress = Math.max(0, (ease - lt.start) / (lt.fadeEnd - lt.start));
        const scale = lerp(0.5, 3.5, Math.pow(scaleProgress, 0.7));

        layers[i].style.opacity = opacity;
        layers[i].style.transform = `scale(${scale})`;
      }

      // Vignette: builds gradually from edges
      if (ease < 0.3) {
        vignette.style.opacity = smoothstep(0, 0.15, ease);
      } else if (ease < 0.7) {
        vignette.style.opacity = 1;
        const fill = smoothstep(0.3, 0.7, ease);
        const centerOpacity = fill * 0.95;
        vignette.style.background = `radial-gradient(ellipse at 50% 50%, rgba(13,40,24,${centerOpacity * 0.5}) 0%, rgba(13,40,24,${0.3 + fill * 0.65}) 50%, rgba(13,40,24,${0.85 + fill * 0.15}) 100%)`;
      } else {
        const solidProgress = smoothstep(0.7, 0.9, ease);
        vignette.style.background = `rgba(13,40,24,${0.85 + solidProgress * 0.15})`;
        vignette.style.opacity = 1;
      }

      // Spawn leaves continuously during rush (0.05 → 0.75)
      if (ease > 0.05 && ease < 0.75 && (now - lastLeafTime) > 60) {
        spawnLeaf(particleContainer, randomRange(400, 900));
        lastLeafTime = now;
      }

      // Speed streaks during the intense part (0.15 → 0.65)
      if (ease > 0.15 && ease < 0.65 && (now - lastStreakTime) > 140) {
        spawnStreak(particleContainer);
        lastStreakTime = now;
      }

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });

  // Hold full green briefly, then fade out to reveal forest path
  await sleep(100);
  vignette.style.transition = 'opacity 0.45s ease';
  vignette.style.opacity = '0';
  await sleep(450);

  // Clean up
  content.innerHTML = '';
  overlay.classList.remove('active');
}
