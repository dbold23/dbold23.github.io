// ============================================
// Forest Path: Tree silhouettes + Leaf particles
// + "Zoom through branches" entrance transition
// ============================================

import { randomRange, prefersReducedMotion, sleep } from './utils.js';

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
}

export function stop() {
  stopLeaves();
}

// ============================================
// "Zoom through branches" entrance transition
// ============================================
// Creates layers of dark tree/branch silhouettes that rush toward
// the viewer, simulating flying through a forest canopy.

// ---- Branch shape generators ----
// Each returns an SVG path "d" attribute string. w/h = viewport dimensions.
// All shapes originate from an edge and reach into the frame.

function branchThickTrunk(w, h, side) {
  // Heavy vertical trunk from top or bottom with 2-3 gnarly sub-branches
  const tw = randomRange(50, 100);
  const fromTop = Math.random() > 0.5;
  const xBase = side === 'left' ? randomRange(-10, w * 0.15) : randomRange(w * 0.85, w + 10);
  const dir = side === 'left' ? 1 : -1;

  const y1 = fromTop ? 0 : h;
  const y2 = fromTop ? randomRange(h * 0.55, h * 0.85) : randomRange(h * 0.15, h * 0.45);
  const midY = (y1 + y2) / 2;

  // Main trunk curves slightly
  const curve = randomRange(20, 60) * dir;
  const b1y = fromTop ? randomRange(h * 0.15, h * 0.35) : randomRange(h * 0.65, h * 0.85);
  const b1reach = randomRange(w * 0.15, w * 0.4) * dir;
  const b2y = fromTop ? randomRange(h * 0.4, h * 0.6) : randomRange(h * 0.4, h * 0.6);
  const b2reach = randomRange(w * 0.1, w * 0.35) * dir;
  const b2droop = randomRange(10, 50);

  return `M${xBase},${y1}
    L${xBase + tw},${y1}
    Q${xBase + tw + curve * 0.3},${midY} ${xBase + tw + curve},${y2}
    L${xBase + tw + curve},${b1y - 15}
    Q${xBase + tw + curve + 20 * dir},${b1y} ${xBase + b1reach + tw},${b1y - randomRange(15, 40)}
    L${xBase + b1reach + tw - 10 * dir},${b1y + 8}
    Q${xBase + tw + curve + 10 * dir},${b1y + 12} ${xBase + tw + curve},${b1y + 15}
    L${xBase + tw + curve},${b2y - 10}
    Q${xBase + tw + curve + 15 * dir},${b2y} ${xBase + b2reach + tw},${b2y + b2droop}
    L${xBase + b2reach + tw - 8 * dir},${b2y + b2droop + 10}
    Q${xBase + tw + curve + 8 * dir},${b2y + 8} ${xBase + tw + curve},${b2y + 12}
    L${xBase + curve},${y2}
    Q${xBase + curve * 0.3},${midY} ${xBase},${y1} Z`;
}

function branchThinTwig(w, h, side) {
  // Thin wispy twig reaching diagonally across the screen
  const tw = randomRange(6, 18);
  const fromEdge = side === 'left' ? randomRange(-5, 15) : randomRange(w - 15, w + 5);
  const startY = randomRange(0, h * 0.6);
  const endX = side === 'left' ? randomRange(w * 0.3, w * 0.65) : randomRange(w * 0.35, w * 0.7);
  const endY = startY + randomRange(h * 0.15, h * 0.4);
  const cp1x = (fromEdge + endX) * 0.4;
  const cp1y = startY + randomRange(20, 80);
  const cp2x = (fromEdge + endX) * 0.7;
  const cp2y = endY - randomRange(20, 60);

  // Sub-twig branching off
  const subT = randomRange(0.3, 0.6);
  const subX = fromEdge + (endX - fromEdge) * subT;
  const subY = startY + (endY - startY) * subT;
  const subReachX = subX + randomRange(30, 100) * (side === 'left' ? 1 : -1);
  const subReachY = subY - randomRange(20, 80);

  return `M${fromEdge},${startY}
    C${cp1x},${cp1y} ${cp2x},${cp2y} ${endX},${endY}
    L${endX - tw * 0.5},${endY + tw}
    C${cp2x - tw},${cp2y + tw} ${cp1x - tw},${cp1y + tw} ${fromEdge},${startY + tw}
    Z
    M${subX},${subY}
    Q${(subX + subReachX) / 2},${subReachY - 15} ${subReachX},${subReachY}
    L${subReachX + tw * 0.4},${subReachY + tw * 0.7}
    Q${(subX + subReachX) / 2 + tw * 0.3},${subReachY + tw} ${subX + tw * 0.5},${subY + tw * 0.5}
    Z`;
}

function branchForked(w, h, side) {
  // A branch that forks into a Y-shape
  const tw = randomRange(25, 55);
  const baseX = side === 'left' ? randomRange(-10, 20) : randomRange(w - 20, w + 10);
  const baseY = randomRange(h * 0.3, h * 0.7);
  const dir = side === 'left' ? 1 : -1;

  const forkX = baseX + randomRange(w * 0.1, w * 0.25) * dir;
  const forkY = baseY + randomRange(-40, 40);

  // Two prongs of the fork
  const prong1X = forkX + randomRange(w * 0.1, w * 0.25) * dir;
  const prong1Y = forkY - randomRange(h * 0.1, h * 0.25);
  const prong2X = forkX + randomRange(w * 0.08, w * 0.2) * dir;
  const prong2Y = forkY + randomRange(h * 0.08, h * 0.2);
  const tw2 = tw * 0.6;

  return `M${baseX},${baseY - tw / 2}
    L${forkX},${forkY - tw / 2}
    L${prong1X},${prong1Y}
    L${prong1X - tw2 * 0.3 * dir},${prong1Y + tw2}
    L${forkX + tw * 0.1 * dir},${forkY}
    L${prong2X},${prong2Y}
    L${prong2X - tw2 * 0.3 * dir},${prong2Y + tw2}
    L${forkX},${forkY + tw / 2}
    L${baseX},${baseY + tw / 2}
    Z`;
}

function branchSweepingBough(w, h, side) {
  // Long sweeping curved bough that arcs across a large portion of the screen
  const tw = randomRange(20, 45);
  const startX = side === 'left' ? randomRange(-20, 10) : randomRange(w - 10, w + 20);
  const startY = randomRange(h * 0.05, h * 0.3);
  const dir = side === 'left' ? 1 : -1;

  // Arc across and downward
  const peakX = startX + randomRange(w * 0.3, w * 0.55) * dir;
  const peakY = startY + randomRange(h * 0.05, h * 0.2);
  const endX = startX + randomRange(w * 0.15, w * 0.35) * dir;
  const endY = startY + randomRange(h * 0.3, h * 0.55);

  // Small twig dropping from the arc
  const dropX = (startX + peakX) * 0.6;
  const dropY = peakY + randomRange(40, 120);

  return `M${startX},${startY}
    Q${peakX},${peakY - 30} ${endX},${endY}
    L${endX - tw * 0.3 * dir},${endY + tw * 0.5}
    Q${peakX - tw * 0.2 * dir},${peakY + tw + 10} ${startX},${startY + tw}
    Z
    M${dropX},${(startY + peakY) / 2}
    L${dropX + 4 * dir},${dropY}
    L${dropX - 4 * dir},${dropY - 5}
    Z`;
}

function branchCanopyTop(w, h) {
  // Dense canopy reaching down from the top of the screen
  const segments = Math.floor(randomRange(3, 6));
  const segW = w / segments;
  let d = `M0,0 `;

  // Irregular bottom edge of the canopy hanging down
  for (let i = 0; i <= segments; i++) {
    const x = i * segW;
    const depth = randomRange(h * 0.08, h * 0.3);
    const cpx = x + randomRange(-segW * 0.3, segW * 0.3);
    const cpy = depth + randomRange(-20, 30);
    if (i === 0) {
      d += `L0,${depth} `;
    } else {
      d += `Q${cpx},${cpy} ${Math.min(x, w)},${depth} `;
    }
  }
  d += `L${w},0 Z`;

  // Add hanging vines / dripping tendrils
  const vineCount = Math.floor(randomRange(2, 5));
  for (let i = 0; i < vineCount; i++) {
    const vx = randomRange(w * 0.1, w * 0.9);
    const vy = randomRange(h * 0.05, h * 0.2);
    const vlen = randomRange(h * 0.05, h * 0.2);
    const sway = randomRange(-25, 25);
    d += ` M${vx - 2},${vy} Q${vx + sway},${vy + vlen * 0.6} ${vx},${vy + vlen}
      Q${vx + sway + 3},${vy + vlen * 0.6} ${vx + 3},${vy} Z`;
  }

  return d;
}

function branchDiagonalCross(w, h) {
  // A branch crossing diagonally across the frame (corner to corner-ish)
  const tw = randomRange(15, 40);
  const fromLeft = Math.random() > 0.5;
  const fromTop = Math.random() > 0.5;

  const sx = fromLeft ? randomRange(-10, w * 0.1) : randomRange(w * 0.9, w + 10);
  const sy = fromTop ? randomRange(-10, h * 0.1) : randomRange(h * 0.9, h + 10);
  const ex = fromLeft ? randomRange(w * 0.5, w * 0.85) : randomRange(w * 0.15, w * 0.5);
  const ey = fromTop ? randomRange(h * 0.5, h * 0.85) : randomRange(h * 0.15, h * 0.5);

  const cpx = (sx + ex) / 2 + randomRange(-80, 80);
  const cpy = (sy + ey) / 2 + randomRange(-80, 80);

  // Perpendicular offset for width
  const angle = Math.atan2(ey - sy, ex - sx);
  const nx = -Math.sin(angle) * tw;
  const ny = Math.cos(angle) * tw;

  return `M${sx},${sy}
    Q${cpx},${cpy} ${ex},${ey}
    L${ex + nx},${ey + ny}
    Q${cpx + nx},${cpy + ny} ${sx + nx},${sy + ny}
    Z`;
}

// Pick a random branch shape generator
function randomBranchPath(w, h, side) {
  const generators = [
    () => branchThickTrunk(w, h, side),
    () => branchThinTwig(w, h, side),
    () => branchForked(w, h, side),
    () => branchSweepingBough(w, h, side),
    () => branchCanopyTop(w, h),
    () => branchDiagonalCross(w, h),
  ];
  return generators[Math.floor(Math.random() * generators.length)]();
}

function getDepthColor(depth) {
  const darkness = Math.max(0.6, 1 - depth * 0.25);
  const r = Math.floor(26 * darkness);
  const g = Math.floor(61 * darkness);
  const b = Math.floor(46 * darkness);
  return `rgb(${r},${g},${b})`;
}

function createBranchLayer(depth) {
  // Generate a layer with 2-4 different branch shapes at various positions
  const w = window.innerWidth;
  const h = window.innerHeight;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.style.cssText = `position:absolute;inset:0;width:100%;height:100%;`;

  const branchCount = Math.floor(randomRange(2, 5));
  const sides = ['left', 'right'];

  for (let i = 0; i < branchCount; i++) {
    const side = sides[i % 2];
    const pathD = randomBranchPath(w, h, side);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);

    // Vary color slightly per branch within the depth
    const hue = Math.floor(randomRange(120, 155));
    const sat = Math.floor(randomRange(35, 65));
    const light = Math.floor(randomRange(8 + depth * 4, 18 + depth * 6));
    path.setAttribute('fill', `hsl(${hue},${sat}%,${light}%)`);
    svg.appendChild(path);
  }

  // Scatter leaf clusters across the layer
  const leafGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const leafCount = Math.floor(randomRange(8, 20));
  for (let i = 0; i < leafCount; i++) {
    const lx = randomRange(w * 0.02, w * 0.98);
    const ly = randomRange(h * 0.02, h * 0.7);
    const lr = randomRange(6, 25);
    const leafEl = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    leafEl.setAttribute('cx', lx);
    leafEl.setAttribute('cy', ly);
    leafEl.setAttribute('rx', lr);
    leafEl.setAttribute('ry', lr * randomRange(0.4, 0.8));
    leafEl.setAttribute('transform', `rotate(${randomRange(-60, 60)} ${lx} ${ly})`);
    const leafHue = Math.floor(randomRange(85, 155));
    const leafLight = Math.floor(randomRange(12 + depth * 3, 30 + depth * 5));
    leafEl.setAttribute('fill', `hsl(${leafHue}, ${Math.floor(randomRange(40, 70))}%, ${leafLight}%)`);
    leafGroup.appendChild(leafEl);
  }
  svg.appendChild(leafGroup);

  return svg;
}

export async function enter() {
  if (prefersReducedMotion()) return;

  const overlay = document.getElementById('transition-overlay');
  overlay.classList.add('active');
  const content = overlay.querySelector('#transition-content');

  // Phase 1 (0ms): Branches start appearing immediately, overlaying
  // the zooming homescreen image. Overlay is semi-transparent at first
  // so you see the trees zooming underneath.

  // Create all 4 depth layers of branches up front
  const layers = [];
  for (let depth = 0; depth < 4; depth++) {
    const layer = document.createElement('div');
    const startScale = 0.4 + depth * 0.15;
    layer.style.cssText = `
      position:absolute;inset:0;
      opacity:0;
      transform:scale(${startScale});
      transform-origin:50% 50%;
      will-change:transform,opacity;
    `;
    layer.appendChild(createBranchLayer(depth));
    content.appendChild(layer);
    layers.push(layer);
  }

  // Stagger leaf particles that fly past during the rush
  const leafBurst = document.createElement('div');
  leafBurst.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10;';
  content.appendChild(leafBurst);

  // Green vignette that builds up gradually (transparent center → dark edges)
  const vignette = document.createElement('div');
  vignette.style.cssText = `
    position:absolute;inset:0;
    background:radial-gradient(ellipse at 50% 50%, transparent 10%, rgba(13,40,24,0.3) 50%, rgba(13,40,24,0.85) 100%);
    opacity:0;
    transition:opacity 0.4s ease;
    z-index:5;
  `;
  content.appendChild(vignette);

  // Phase 1: First branches fade in subtly alongside the zoom (0-600ms)
  // Far layers appear first, semi-transparent
  await sleep(50);
  vignette.style.opacity = '1';

  // Far layer (depth 3) — appears immediately, drifts slowly
  layers[3].style.transition = 'opacity 0.5s ease, transform 1.8s cubic-bezier(0.15, 0, 0.25, 1)';
  layers[3].style.opacity = '0.4';
  layers[3].style.transform = 'scale(0.9)';

  await sleep(200);

  // Mid-far layer (depth 2)
  layers[2].style.transition = 'opacity 0.4s ease, transform 1.5s cubic-bezier(0.15, 0, 0.25, 1)';
  layers[2].style.opacity = '0.6';
  layers[2].style.transform = 'scale(1.0)';

  // Start scattering leaves
  for (let i = 0; i < 8; i++) {
    spawnLeaf(leafBurst, randomRange(300, 900));
  }

  await sleep(300);

  // Phase 2: Branches rush forward as zoom intensifies (500-1200ms)
  // Mid layer (depth 1) — rushes toward camera
  layers[1].style.transition = 'opacity 0.3s ease, transform 1.0s cubic-bezier(0.2, 0, 0.3, 1)';
  layers[1].style.opacity = '0.8';
  layers[1].style.transform = 'scale(1.3)';

  // Far layers accelerate past
  layers[3].style.transition = 'opacity 0.6s ease, transform 0.8s cubic-bezier(0.2, 0, 0.3, 1)';
  layers[3].style.transform = 'scale(2.5)';
  layers[3].style.opacity = '0';

  // More leaves burst
  for (let i = 0; i < 10; i++) {
    spawnLeaf(leafBurst, randomRange(200, 600));
  }

  await sleep(350);

  // Closest layer (depth 0) — big dark branches filling view
  layers[0].style.transition = 'opacity 0.25s ease, transform 0.9s cubic-bezier(0.2, 0, 0.3, 1)';
  layers[0].style.opacity = '1';
  layers[0].style.transform = 'scale(1.5)';

  layers[2].style.transition = 'opacity 0.5s ease, transform 0.7s cubic-bezier(0.2, 0, 0.3, 1)';
  layers[2].style.transform = 'scale(2.8)';
  layers[2].style.opacity = '0';

  // Vignette intensifies
  vignette.style.background = 'radial-gradient(ellipse at 50% 50%, rgba(13,40,24,0.4) 0%, rgba(13,40,24,0.95) 70%)';

  await sleep(400);

  // Phase 3: Everything rushes past — full green (1200-1800ms)
  layers[1].style.transition = 'opacity 0.4s ease, transform 0.5s ease';
  layers[1].style.transform = 'scale(3.5)';
  layers[1].style.opacity = '0';

  layers[0].style.transition = 'opacity 0.5s ease, transform 0.6s ease';
  layers[0].style.transform = 'scale(3.0)';
  layers[0].style.opacity = '0';

  // Full green overlay to bridge into the path
  vignette.style.transition = 'opacity 0.3s ease, background 0.3s ease';
  vignette.style.background = 'rgba(13,40,24,1)';

  await sleep(500);

  // Phase 4: Fade out to reveal forest path (1800-2200ms)
  vignette.style.transition = 'opacity 0.5s ease';
  vignette.style.opacity = '0';

  await sleep(500);

  // Clean up
  content.innerHTML = '';
  overlay.classList.remove('active');
}

function spawnLeaf(container, duration) {
  const leaf = document.createElement('div');
  const size = randomRange(6, 20);
  const startX = randomRange(10, 90);
  const startY = randomRange(10, 90);
  const hue = Math.floor(randomRange(85, 155));
  const lightness = Math.floor(randomRange(25, 50));
  leaf.style.cssText = `
    position:absolute;
    left:${startX}%;top:${startY}%;
    width:${size}px;height:${size * 0.65}px;
    background:hsl(${hue},55%,${lightness}%);
    border-radius:50% 0 50% 0;
    opacity:0.8;
    transform:rotate(${randomRange(0, 360)}deg) scale(0.3);
    transition:all ${duration}ms ease-out;
    z-index:8;
  `;
  container.appendChild(leaf);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      leaf.style.transform = `rotate(${randomRange(0, 720)}deg) scale(${randomRange(1.5, 3)}) translate(${randomRange(-150, 150)}px, ${randomRange(-150, 150)}px)`;
      leaf.style.opacity = '0';
    });
  });

  // Remove after animation
  setTimeout(() => leaf.remove(), duration + 100);
}
