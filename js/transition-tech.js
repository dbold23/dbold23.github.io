// ============================================
// Tech Path: Laptop zoom, Sticker Peel Timeline, Matrix Rain
// ============================================

import { randomRange, prefersReducedMotion, sleep, lerp, clamp, easeOutCubic, easeInOutCubic } from './utils.js';

// ---- Three.js dynamic loader ----
let threeLoaded = false;

function loadThreeJS() {
  if (threeLoaded || typeof THREE !== 'undefined') {
    threeLoaded = true;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    script.onload = () => { threeLoaded = true; resolve(); };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// ---- 3D MacBook Scene Builder ----

function buildMacBookScene(container) {
  const disposables = [];

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.setClearColor(0x0a0e14);

  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  container.appendChild(canvas);

  // Scene & Camera
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 100);

  // Lights
  scene.add(new THREE.AmbientLight(0x404060, 0.7));

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(5, 10, 7);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 30;
  keyLight.shadow.camera.left = -6;
  keyLight.shadow.camera.right = 6;
  keyLight.shadow.camera.top = 6;
  keyLight.shadow.camera.bottom = -6;
  keyLight.shadow.bias = -0.0005;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x8090ff, 0.3);
  fillLight.position.set(-5, 4, -3);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffc080, 0.2);
  rimLight.position.set(0, 2, -8);
  scene.add(rimLight);

  const screenGlow = new THREE.PointLight(0x6090dd, 0.5, 8);
  screenGlow.position.set(0, 2, 0.5);
  scene.add(screenGlow);

  // Dimensions
  const W = 5.0, DEPTH = 3.4, BASE_H = 0.1, LID_T = 0.06, LID_H = 3.2;
  const SCR_W = 4.4, SCR_H = 2.85;

  // Materials
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x48484f, metalness: 0.82, roughness: 0.2 });
  const innerMat = new THREE.MeshStandardMaterial({ color: 0x2c2c32, metalness: 0.6, roughness: 0.3 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x0c0c10, metalness: 0.15, roughness: 0.4 });
  const keyMat = new THREE.MeshStandardMaterial({ color: 0x18181e, metalness: 0.2, roughness: 0.55 });
  const tpMat = new THREE.MeshStandardMaterial({ color: 0x2a2a32, metalness: 0.55, roughness: 0.12 });
  disposables.push(bodyMat, innerMat, blackMat, keyMat, tpMat);

  // MacBook group
  const macbook = new THREE.Group();
  scene.add(macbook);

  // ── BASE ──
  const base = new THREE.Group();
  macbook.add(base);

  const baseGeo = new THREE.BoxGeometry(W, BASE_H, DEPTH);
  const baseSlab = new THREE.Mesh(baseGeo, bodyMat);
  baseSlab.position.y = BASE_H / 2;
  baseSlab.castShadow = true;
  baseSlab.receiveShadow = true;
  base.add(baseSlab);
  disposables.push(baseGeo);

  const deckGeo = new THREE.BoxGeometry(W - 0.12, 0.004, DEPTH - 0.12);
  const deckMesh = new THREE.Mesh(deckGeo, innerMat);
  deckMesh.position.y = BASE_H + 0.001;
  base.add(deckMesh);
  disposables.push(deckGeo);

  // Keyboard keys
  const kw = 0.19, kgap = 0.04, kh = 0.016;
  const kGeo = new THREE.BoxGeometry(kw, kh, kw);
  const spGeo = new THREE.BoxGeometry(kw * 5.2, kh, kw);
  disposables.push(kGeo, spGeo);

  for (let row = 0; row < 5; row++) {
    const count = row === 4 ? 9 : row === 0 ? 14 : 13;
    const rowW = count * (kw + kgap) - kgap;
    const startX = -rowW / 2;
    const z = -0.55 + row * (kw + kgap);
    for (let c = 0; c < count; c++) {
      const key = new THREE.Mesh(kGeo, keyMat);
      key.position.set(startX + c * (kw + kgap) + kw / 2, BASE_H + kh / 2, z);
      base.add(key);
    }
  }
  const spaceBar = new THREE.Mesh(spGeo, keyMat);
  spaceBar.position.set(0, BASE_H + kh / 2, -0.55 + 4 * (kw + kgap));
  base.add(spaceBar);

  // Trackpad
  const tpGeo = new THREE.BoxGeometry(1.65, 0.006, 1.05);
  const trackpad = new THREE.Mesh(tpGeo, tpMat);
  trackpad.position.set(0, BASE_H + 0.003, 0.65);
  base.add(trackpad);
  disposables.push(tpGeo);

  // Rubber feet
  const footGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.012, 12);
  const rubMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
  disposables.push(footGeo, rubMat);
  [[-2.15, 0.006, -1.35], [2.15, 0.006, -1.35], [-2.15, 0.006, 1.35], [2.15, 0.006, 1.35]].forEach(p => {
    const foot = new THREE.Mesh(footGeo, rubMat);
    foot.position.set(p[0], p[1], p[2]);
    base.add(foot);
  });

  // ── LID ──
  const lidPivot = new THREE.Group();
  lidPivot.position.set(0, BASE_H, -DEPTH / 2);
  macbook.add(lidPivot);

  const lidGeo = new THREE.BoxGeometry(W, LID_H, LID_T);
  const lidBack = new THREE.Mesh(lidGeo, bodyMat);
  lidBack.position.set(0, LID_H / 2, 0);
  lidBack.castShadow = true;
  lidPivot.add(lidBack);
  disposables.push(lidGeo);

  const bezelGeo = new THREE.BoxGeometry(W - 0.06, LID_H - 0.06, 0.005);
  const bezelMesh = new THREE.Mesh(bezelGeo, blackMat);
  bezelMesh.position.set(0, LID_H / 2, LID_T / 2 + 0.002);
  lidPivot.add(bezelMesh);
  disposables.push(bezelGeo);

  // Screen texture
  const sCanvas = document.createElement('canvas');
  sCanvas.width = 1280;
  sCanvas.height = 832;
  const sCtx = sCanvas.getContext('2d');

  // Draw macOS wallpaper
  const g = sCtx.createLinearGradient(0, 0, 1280, 832);
  g.addColorStop(0, '#1a0a3e');
  g.addColorStop(0.35, '#0d1b4a');
  g.addColorStop(0.65, '#1a2a5e');
  g.addColorStop(1, '#0a1530');
  sCtx.fillStyle = g;
  sCtx.fillRect(0, 0, 1280, 832);

  for (let i = 4; i >= 0; i--) {
    const r = 50 + i * 30;
    const og = sCtx.createRadialGradient(640, 370, 0, 640, 370, r);
    og.addColorStop(0, `rgba(120,80,255,${0.5 - i * 0.08})`);
    og.addColorStop(0.4, `rgba(80,160,255,${0.3 - i * 0.05})`);
    og.addColorStop(0.7, `rgba(255,100,180,${0.15 - i * 0.02})`);
    og.addColorStop(1, 'transparent');
    sCtx.fillStyle = og;
    sCtx.beginPath();
    sCtx.arc(640, 370, r, 0, Math.PI * 2);
    sCtx.fill();
  }

  // Menu bar
  sCtx.fillStyle = 'rgba(0,0,0,0.4)';
  sCtx.fillRect(0, 0, 1280, 30);
  sCtx.fillStyle = 'rgba(255,255,255,0.5)';
  sCtx.font = '14px sans-serif';
  sCtx.fillText(' Finder   File   Edit   View   Go', 12, 20);
  sCtx.textAlign = 'right';
  sCtx.fillText('Sat 10:20 PM', 1268, 20);
  sCtx.textAlign = 'left';

  // Dock
  const dw = 420, dh = 50, dx = 640 - dw / 2, dy = 770;
  sCtx.fillStyle = 'rgba(255,255,255,0.06)';
  sCtx.beginPath();
  sCtx.roundRect(dx, dy, dw, dh, 14);
  sCtx.fill();
  ['#ff5f57', '#febc2e', '#28c840', '#5ac8fa', '#007aff', '#af52de', '#ff9500'].forEach((c, i) => {
    sCtx.fillStyle = c;
    sCtx.beginPath();
    sCtx.roundRect(dx + 18 + i * 56, dy + 9, 34, 34, 8);
    sCtx.fill();
  });

  const screenTex = new THREE.CanvasTexture(sCanvas);
  screenTex.encoding = THREE.sRGBEncoding;
  disposables.push(screenTex);

  const screenGeo = new THREE.PlaneGeometry(SCR_W, SCR_H);
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex });
  const screenMesh = new THREE.Mesh(screenGeo, screenMat);
  screenMesh.position.set(0, LID_H / 2, LID_T / 2 + 0.006);
  lidPivot.add(screenMesh);
  disposables.push(screenGeo, screenMat);

  // Notch
  const notchGeo = new THREE.BoxGeometry(0.35, 0.07, 0.015);
  const notch = new THREE.Mesh(notchGeo, blackMat);
  notch.position.set(0, LID_H - 0.06, LID_T / 2 + 0.005);
  lidPivot.add(notch);
  disposables.push(notchGeo);

  // Camera dot
  const camGeo = new THREE.SphereGeometry(0.012, 8, 8);
  const camMat = new THREE.MeshBasicMaterial({ color: 0x333344 });
  const camDot = new THREE.Mesh(camGeo, camMat);
  camDot.position.set(0, LID_H - 0.06, LID_T / 2 + 0.015);
  lidPivot.add(camDot);
  disposables.push(camGeo, camMat);

  // Apple logo on back
  const logoCanvas = document.createElement('canvas');
  logoCanvas.width = 256;
  logoCanvas.height = 256;
  const lCtx = logoCanvas.getContext('2d');
  lCtx.clearRect(0, 0, 256, 256);
  lCtx.save();
  lCtx.translate(60, 20);
  lCtx.scale(0.35, 0.35);
  const applePath = new Path2D('M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z');
  lCtx.fillStyle = '#ccccdd';
  lCtx.fill(applePath);
  lCtx.restore();

  const logoTex = new THREE.CanvasTexture(logoCanvas);
  logoTex.encoding = THREE.sRGBEncoding;
  disposables.push(logoTex);

  const logoGeo = new THREE.PlaneGeometry(0.4, 0.4);
  const logoMat = new THREE.MeshBasicMaterial({ map: logoTex, transparent: true });
  const logoPlane = new THREE.Mesh(logoGeo, logoMat);
  logoPlane.rotation.y = Math.PI;
  logoPlane.position.set(0, LID_H / 2, -LID_T / 2 - 0.002);
  lidPivot.add(logoPlane);
  disposables.push(logoGeo, logoMat);

  // Ground plane
  const groundGeo = new THREE.PlaneGeometry(40, 40);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x0e0e14, roughness: 0.92, metalness: 0.05 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);
  disposables.push(groundGeo, groundMat);

  // Start lid closed
  const CLOSED_ANGLE = -Math.PI / 2 + 0.02;
  lidPivot.rotation.x = CLOSED_ANGLE;

  return { scene, camera, renderer, macbook, lidPivot, screenGlow, disposables };
}

// ---- Scripted 3D animation ----

function runMacbookAnimation(scene, camera, renderer, lidPivot, screenGlow) {
  const TOTAL_DURATION = 2800;
  const OPEN_ANGLE = -0.35;
  const CLOSED_ANGLE = -Math.PI / 2 + 0.02;

  return new Promise(resolve => {
    const startTime = performance.now();

    function animate(now) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / TOTAL_DURATION, 1);

      // Camera: sweep from behind to front
      const cameraT = easeInOutCubic(Math.min(t / 0.65, 1));
      const theta = lerp(Math.PI, 0.05, cameraT);
      const phi = lerp(0.9, 0.78, cameraT);
      const r = lerp(11, 8, cameraT);

      camera.position.set(
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.cos(theta)
      );
      camera.lookAt(0, 1.0, 0);

      // Lid: opens after camera starts moving
      const lidT = easeOutCubic(clamp((t - 0.2) / 0.5, 0, 1));
      lidPivot.rotation.x = lerp(CLOSED_ANGLE, OPEN_ANGLE, lidT);

      // Screen glow tracks lid openness
      const openness = 1 - (lidPivot.rotation.x - OPEN_ANGLE) / (CLOSED_ANGLE - OPEN_ANGLE);
      screenGlow.intensity = 0.5 * Math.max(0, openness);

      renderer.render(scene, camera);

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(animate);
  });
}

// ---- Three.js cleanup ----

function disposeScene(renderer, scene, disposables) {
  disposables.forEach(obj => { if (obj && obj.dispose) obj.dispose(); });
  scene.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(m => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
    }
  });
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
}

let matrixAnimId = null;
let matrixCanvas = null;
let matrixCtx = null;
let columns = [];
let stickerCleanup = null;

// ---- Matrix Rain ----
const CHAR_SET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*(){}[]|/<>';
const FONT_SIZE = 14;

function initMatrix() {
  matrixCanvas = document.getElementById('matrix-canvas');
  if (!matrixCanvas) return;

  matrixCtx = matrixCanvas.getContext('2d');
  resizeMatrix();
  window.addEventListener('resize', resizeMatrix);
}

function resizeMatrix() {
  if (!matrixCanvas) return;
  matrixCanvas.width = window.innerWidth;
  matrixCanvas.height = window.innerHeight;

  const colCount = Math.floor(matrixCanvas.width / FONT_SIZE);
  columns = [];
  for (let i = 0; i < colCount; i++) {
    columns[i] = Math.floor(randomRange(0, matrixCanvas.height / FONT_SIZE));
  }
}

function startMatrix() {
  if (prefersReducedMotion() || !matrixCanvas) return;
  initMatrix();

  function draw() {
    // Dim previous frame
    matrixCtx.fillStyle = 'rgba(10, 14, 20, 0.06)';
    matrixCtx.fillRect(0, 0, matrixCanvas.width, matrixCanvas.height);

    matrixCtx.fillStyle = 'rgba(0, 255, 200, 0.4)';
    matrixCtx.font = `${FONT_SIZE}px monospace`;

    for (let i = 0; i < columns.length; i++) {
      const char = CHAR_SET[Math.floor(Math.random() * CHAR_SET.length)];
      const x = i * FONT_SIZE;
      const y = columns[i] * FONT_SIZE;

      matrixCtx.fillText(char, x, y);

      if (y > matrixCanvas.height && Math.random() > 0.975) {
        columns[i] = 0;
      }
      columns[i]++;
    }
    matrixAnimId = requestAnimationFrame(draw);
  }
  draw();
}

function stopMatrix() {
  if (matrixAnimId) {
    cancelAnimationFrame(matrixAnimId);
    matrixAnimId = null;
  }
  window.removeEventListener('resize', resizeMatrix);
}

// ---- Sticker Peel (hover-triggered, adapted from v1 scroll-linked) ----

function initStickerPeel() {
  const laptop = document.getElementById('tech-sticker-laptop');
  if (!laptop) return;
  const stickers = laptop.querySelectorAll('.sticker-peel:not(.permanent)');
  if (!stickers.length) return;

  const DURATION = 500; // ms for full peel/unpeel
  const controllers = [];

  stickers.forEach((sticker) => {
    let animId = null;
    let current = 0; // current --peel-amount (0 = flat, 1 = peeled)
    let target = 0;
    let startTime = null;
    let startVal = 0;

    function applyPeel(progress) {
      current = progress;
      sticker.style.setProperty('--peel-amount', progress);

      // Update shadow
      const shadow = sticker.querySelector('.sticker-shadow');
      if (shadow) {
        shadow.style.height = (progress * 20) + 'px';
        shadow.style.opacity = progress;
      }

      // Show/hide label
      if (progress > 0.5) {
        sticker.classList.add('peeled');
      } else {
        sticker.classList.remove('peeled');
      }
    }

    function animate(timestamp) {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const duration = DURATION * Math.abs(target - startVal);
      const t = duration > 0 ? Math.min(elapsed / duration, 1) : 1;

      // Ease out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const value = startVal + (target - startVal) * eased;

      applyPeel(value);

      if (t < 1) {
        animId = requestAnimationFrame(animate);
      } else {
        animId = null;
      }
    }

    function startAnimation(newTarget) {
      target = newTarget;
      startVal = current;
      startTime = null;
      if (animId) cancelAnimationFrame(animId);
      animId = requestAnimationFrame(animate);
    }

    function onEnter() { startAnimation(1); }
    function onLeave() { startAnimation(0); }

    sticker.addEventListener('mouseenter', onEnter);
    sticker.addEventListener('mouseleave', onLeave);

    controllers.push(() => {
      sticker.removeEventListener('mouseenter', onEnter);
      sticker.removeEventListener('mouseleave', onLeave);
      if (animId) cancelAnimationFrame(animId);
      applyPeel(0);
    });
  });

  // Return cleanup function
  return () => controllers.forEach(fn => fn());
}

function stopStickerPeel() {
  if (stickerCleanup) {
    stickerCleanup();
    stickerCleanup = null;
  }
}

// ---- Sticker Click Navigation ----

let stickerClickCleanup = null;

function initStickerNav() {
  const laptop = document.getElementById('tech-sticker-laptop');
  if (!laptop) return;
  const stickers = laptop.querySelectorAll('.sticker-peel[data-href]');
  const cleanups = [];

  stickers.forEach((sticker) => {
    function onClick(e) {
      e.preventDefault();
      const href = sticker.dataset.href;
      if (sticker.dataset.external === 'true') {
        window.open(href, '_blank', 'noopener');
        return;
      }
      // Scroll to folder and auto-open it
      const target = document.querySelector(href);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Auto-open after scroll settles
      setTimeout(() => {
        if (!target.classList.contains('open')) {
          target.classList.add('open');
          const toggle = target.querySelector('.folder-toggle');
          if (toggle) toggle.setAttribute('aria-expanded', 'true');
        }
        // Flash highlight
        target.classList.add('highlight');
        setTimeout(() => target.classList.remove('highlight'), 1000);
      }, 500);
    }
    sticker.addEventListener('click', onClick);
    cleanups.push(() => sticker.removeEventListener('click', onClick));
  });

  return () => cleanups.forEach(fn => fn());
}

// ---- Hardware 3D Model Part Selector ----

let hwViewerCleanup = null;

function initHardwareViewer() {
  const viewer = document.getElementById('hw-model');
  if (!viewer) return;

  const wrap = viewer.closest('.hw-viewer-wrap');
  if (!wrap) return;

  const buttons = wrap.querySelectorAll('.hw-part-btn');
  const descs = wrap.querySelectorAll('.hw-part-desc');
  const cleanups = [];

  buttons.forEach(btn => {
    function onClick() {
      const part = btn.dataset.part;
      const orbit = btn.dataset.orbit;
      const target = btn.dataset.target;

      // Animate camera to part position
      viewer.cameraOrbit = orbit;
      viewer.cameraTarget = target;

      // Auto-rotate on overview only, pause on specific parts
      viewer.autoRotate = (part === 'overview');

      // Swap active button
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Swap visible description
      descs.forEach(d => {
        d.style.display = d.dataset.for === part ? '' : 'none';
      });
    }

    btn.addEventListener('click', onClick);
    cleanups.push(() => btn.removeEventListener('click', onClick));
  });

  return () => cleanups.forEach(fn => fn());
}

function stopHardwareViewer() {
  if (hwViewerCleanup) {
    hwViewerCleanup();
    hwViewerCleanup = null;
  }
}

// ---- File Tree Expand/Collapse ----

let fileTreeCleanup = null;

function initFileTree() {
  const tree = document.getElementById('tech-file-tree');
  if (!tree) return;
  const cleanups = [];

  // Folder toggles (accordion — one open at a time per nesting level)
  const allFolders = tree.querySelectorAll('.tree-folder');
  allFolders.forEach((folder) => {
    const toggle = folder.querySelector(':scope > .folder-toggle');
    if (!toggle) return;

    function onClick() {
      const isOpen = folder.classList.contains('open');

      // Record position of clicked toggle before DOM changes
      const toggleTop = toggle.getBoundingClientRect().top;

      // Close sibling folders — collapse INSTANTLY (skip CSS transition)
      const parent = folder.parentElement;
      const siblings = parent.querySelectorAll(':scope > .tree-folder');
      siblings.forEach(f => {
        if (f !== folder && f.classList.contains('open')) {
          // Kill transition so height collapses immediately
          const children = f.querySelector(':scope > .folder-children');
          if (children) children.style.transition = 'none';

          f.classList.remove('open');
          const t = f.querySelector(':scope > .folder-toggle');
          if (t) t.setAttribute('aria-expanded', 'false');

          // Force reflow, then restore transition
          if (children) {
            children.offsetHeight; // force layout
            children.style.transition = '';
          }
        }
      });

      // Toggle this folder
      folder.classList.toggle('open', !isOpen);
      toggle.setAttribute('aria-expanded', String(!isOpen));

      // Correct scroll so clicked toggle stays in the same viewport position
      const drift = toggle.getBoundingClientRect().top - toggleTop;
      if (Math.abs(drift) > 2) {
        window.scrollBy(0, drift);
      }
    }

    toggle.addEventListener('click', onClick);
    cleanups.push(() => toggle.removeEventListener('click', onClick));
  });

  // File toggles (multiple can be open within a folder)
  const files = tree.querySelectorAll('.tree-file');
  files.forEach((file) => {
    const toggle = file.querySelector(':scope > .file-toggle');
    if (!toggle) return;

    function onClick() {
      const wasOpen = file.classList.contains('open');
      file.classList.toggle('open');

      // Pause any videos inside when closing
      if (wasOpen) {
        file.querySelectorAll('video').forEach(v => v.pause());
      }
    }

    toggle.addEventListener('click', onClick);
    cleanups.push(() => toggle.removeEventListener('click', onClick));
  });

  // Pause videos inside folders that get closed (by accordion)
  const observer = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const el = m.target;
        if ((el.classList.contains('tree-folder') || el.classList.contains('tree-file'))
            && !el.classList.contains('open')) {
          el.querySelectorAll('video').forEach(v => v.pause());
        }
      }
    });
  });
  observer.observe(tree, { attributes: true, attributeFilter: ['class'], subtree: true });
  cleanups.push(() => observer.disconnect());

  // Pause videos when scrolled out of view
  const videos = tree.querySelectorAll('video');
  if (videos.length) {
    const scrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) {
          entry.target.pause();
        }
      });
    }, { threshold: 0 });

    videos.forEach(v => scrollObserver.observe(v));
    cleanups.push(() => scrollObserver.disconnect());
  }

  return () => cleanups.forEach(fn => fn());
}

function stopFileTree() {
  if (fileTreeCleanup) {
    fileTreeCleanup();
    fileTreeCleanup = null;
  }
  if (stickerClickCleanup) {
    stickerClickCleanup();
    stickerClickCleanup = null;
  }
}

// ---- Entrance transition: 3D MacBook reveal ----
export async function enter() {
  if (prefersReducedMotion()) return;

  const overlay = document.getElementById('transition-overlay');
  overlay.classList.add('active');
  const content = overlay.querySelector('#transition-content');

  // Container with dark tech background
  const container = document.createElement('div');
  container.className = 'tech-transition-container';
  content.appendChild(container);

  // Phase 1: Fade in dark background
  await sleep(30);
  container.classList.add('visible');

  // Phase 2: Load Three.js and build 3D scene
  try {
    await loadThreeJS();

    const { scene, camera, renderer, lidPivot, screenGlow, disposables } =
      buildMacBookScene(container);

    // Phase 3: Run scripted camera orbit + lid open animation
    await runMacbookAnimation(scene, camera, renderer, lidPivot, screenGlow);

    // Phase 4: Fade out the 3D canvas
    renderer.domElement.style.transition = 'opacity 0.5s ease';
    renderer.domElement.style.opacity = '0';
    await sleep(500);

    // Clean up Three.js resources
    disposeScene(renderer, scene, disposables);
  } catch (_err) {
    // Fallback: if Three.js fails to load, just show dark background briefly
    await sleep(800);
  }

  // Phase 5: Fade out overlay to reveal tech path
  container.classList.remove('visible');
  await sleep(400);

  container.remove();
  overlay.classList.remove('active');
}

// ---- Start/Stop (called when path is active) ----
export function start() {
  startMatrix();
  stickerCleanup = initStickerPeel();
  stickerClickCleanup = initStickerNav();
  fileTreeCleanup = initFileTree();
  hwViewerCleanup = initHardwareViewer();
}

export function stop() {
  stopMatrix();
  stopStickerPeel();
  stopFileTree();
  stopHardwareViewer();
}
