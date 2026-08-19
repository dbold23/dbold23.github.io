// ============================================
// Ocean path: the water itself
// ============================================
//
// A WebGL volume that sits behind the research bubbles: a depth gradient with
// light shafts, a few hundred real spheres rising through it, and the two shark
// models making runs across the frame.
//
// Everything here is background. It never takes pointer events, it renders only
// while the ocean path is on screen, and if the GPU refuses it the caller falls
// back to the flat canvas bubbles in transition-ocean.js.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.min.js';

import { prefersReducedMotion, isTouchDevice } from './utils.js';

// ---- Palette. Linear-space conversion is automatic, these are the CSS values.
const MURK = 0x08203f;        // fog, and the colour the gradient passes through
const SURFACE = 0x18567f;     // top of the water column
const ABYSS = 0x020a18;       // bottom of it
const FOAM = 0xb8e6f5;

const FOG_DENSITY = 0.026;
const FOV = 55;

const NEAR_Z = -7;            // bubbles never come closer than this
const FAR_Z = -76;

const SHARKS = [
  {
    url: 'assets/models/white-shark.glb',
    length: 17,
    // A white shark cruises: long body, slow deep beat, little of it up front
    swim: { amp: 0.052, waveK: 3.4, rate: 5.2, headBias: 0.05 },
    girth: 3.0,
    speed: [10, 17],
    rest: [1.8, 4.8],
    depth: [-52, -17],
  },
  {
    url: 'assets/models/leopard-shark.glb',
    length: 8.5,
    // A leopard shark is far more anguilliform — the whole body works
    swim: { amp: 0.085, waveK: 5.0, rate: 7.4, headBias: 0.12 },
    girth: 1.6,
    speed: [8, 14],
    rest: [1.4, 3.9],
    depth: [-44, -13],
  },
];

// ---- State ----
let renderer = null;
let scene = null;
let camera = null;
let lastFrameAt = 0;
let frameId = null;
let running = false;
let bubbles = null;
let shafts = null;
const sharks = [];
let disposed = false;

const pointer = {
  ndc: new THREE.Vector2(0, 0),
  active: false,
  ray: new THREE.Ray(),
  raycaster: new THREE.Raycaster(),
  strength: 0,      // rises with pointer speed, decays on its own
  lastX: 0,
  lastY: 0,
};

const view = { halfH: 1, halfW: 1, aspect: 1 };
const camTarget = new THREE.Vector3();

// ============================================================
// Bubbles
// ============================================================
//
// Every bubble is two triangles. The sphere is not modelled at all: each
// instance draws a camera-facing card and the fragment shader intersects the
// view ray with the sphere it stands for, discarding anything that misses.
//
// That matters for more than triangle count. A tessellated ball has a polygon
// silhouette, and the rim term — pow(1 - |N.V|, 2.6) — is at its most sensitive
// exactly there, so the flat chords of the hull show up as straight lines cut
// across the edge of a big bubble. Solved analytically the edge is a true
// circle at any size, and the normal is exact rather than interpolated.

const BUBBLE_VERT = /* glsl */ `
  attribute vec3 aPos;
  attribute float aScale;
  attribute float aSeed;
  attribute float aAlpha;

  uniform float uTime;
  uniform float uPxScale;   // world units per pixel, per unit of depth

  varying vec3 vCentre;     // ellipsoid centre, view space
  varying vec3 vCard;       // this fragment's point on the card, view space
  varying vec3 vAxes;       // semi-axes
  varying vec2 vProj;       // the projection's z row, for the depth write
  varying float vSeed;
  varying float vAlpha;

  void main() {
    // A bubble is a gas pocket, not a ball bearing: let it breathe on its own
    // phase so a field of them never pulses together. With no mesh to deform,
    // the squash lives in the semi-axes the fragment stage solves against.
    // Capped: past about a tenth of its radius it stops reading as a sphere.
    float t = uTime * (0.8 + aSeed * 1.1) + aSeed * 37.0;
    float wob = min(0.11, 0.045 + aScale * 0.05);
    vec3 axes = aScale * vec3(
      1.0 - sin(t) * wob * 0.65,
      1.0 + sin(t) * wob,
      1.0 - cos(t * 1.13) * wob * 0.65
    );

    vec3 centre = (modelViewMatrix * vec4(aPos, 1.0)).xyz;
    float rb = max(max(axes.x, axes.y), axes.z);
    float d = max(length(centre), rb * 1.001);   // the eye is never inside one
    float k = sqrt(d * d - rb * rb);             // eye to tangent point

    // The card is built in the plane of the silhouette CIRCLE — square-on to the
    // eye-to-centre axis, not to the view axis. That distinction is the whole
    // point: a screen-parallel card is only correct on axis, and off to the side
    // the tangent cone tilts away from it, so its straight edge slices a bite
    // out of the rim. Which is the artifact this was meant to remove.
    vec3 w = centre / d;
    vec3 up = abs(w.y) > 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 su = normalize(cross(w, up));
    vec3 sv = cross(su, w);                      // su x sv = -w, so it faces the eye

    float ds = k * k / d;                        // where the silhouette circle sits
    float rs = rb * k / d;                       // and how wide it is
    float pad = ds * uPxScale * 1.5;             // room for the one-pixel edge fade

    vec3 card = w * ds + (su * position.x + sv * position.y) * (rs + pad);

    vCentre = centre;
    vCard = card;
    vAxes = axes;
    vProj = vec2(projectionMatrix[2].z, projectionMatrix[3].z);
    vSeed = aSeed;
    vAlpha = aAlpha;

    gl_Position = projectionMatrix * vec4(card, 1.0);
  }
`;

const BUBBLE_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uMurk;
  uniform vec3 uFoam;
  uniform vec3 uKey;      // key light, view space
  uniform float uFog;

  varying vec3 vCentre;
  varying vec3 vCard;
  varying vec3 vAxes;
  varying vec2 vProj;
  varying float vSeed;
  varying float vAlpha;

  // Thin-film interference: the soap-bubble smear across the rim
  vec3 film(float x) {
    return 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + x));
  }

  // One wall of the shell
  vec4 wall(vec3 N, vec3 V, float depth) {
    float ndv = abs(dot(N, V));
    float fres = pow(1.0 - ndv, 2.6);

    // Key highlight, plus a wide dim one from below standing in for the bounce
    vec3 H = normalize(uKey + V);
    float spec = pow(max(dot(N, H), 0.0), 96.0) * 1.5;
    float under = pow(max(dot(N, normalize(vec3(-0.3, -1.0, 0.35))), 0.0), 18.0) * 0.09;

    vec3 col = mix(uMurk * 0.8, uFoam, fres);
    col += film(fres * 1.7 + vSeed * 0.8) * fres * 0.30;
    col += spec + under;

    // Nearly clear through the middle, where we are looking at the water behind
    float a = vAlpha * (0.035 + fres * 1.05) + spec * 0.8;

    // Dissolve into the murk on exactly the curve the scene fog uses
    float fog = 1.0 - exp(-uFog * uFog * depth * depth);
    return vec4(col, clamp(a * (1.0 - fog), 0.0, 1.0));
  }

  void main() {
    // In view space the eye is the origin, so the ray through this fragment is
    // just the fragment's own position — however the card is tilted
    vec3 rd = normalize(vCard);
    vec3 V = -rd;

    // Ray against the ellipsoid, by squashing the ray into its unit frame.
    // The semi-axes are taken as view-aligned rather than world-aligned: the
    // camera barely rotates and the squash is at most 11%, so the difference
    // does not survive being looked at, and this saves two mat3 products per
    // fragment in the pass that owns the fill cost.
    vec3 o = -vCentre / vAxes;
    vec3 dir = rd / vAxes;
    float qa = dot(dir, dir);
    float qb = dot(o, dir);
    float qc = dot(o, o) - 1.0;
    float h = qb * qb - qa * qc;

    // h = 0 is the silhouette, and h is locally linear in the radial pixel
    // distance, so this is a one-pixel ramp centred on the true edge. The
    // renderer runs without MSAA and the rim is the most opaque part of a
    // bubble: unfaded, an analytic circle aliases as hard as the chords did.
    float cover = clamp(h / max(fwidth(h), 1e-9) + 0.5, 0.0, 1.0);
    if (cover <= 0.0) discard;

    float sq = sqrt(max(h, 0.0));
    float tF = (-qb - sq) / qa;
    float tB = (-qb + sq) / qa;

    vec3 pF = rd * tF;
    vec3 pB = rd * tB;
    // Gradient of the ellipsoid, which is the surface normal
    vec3 NF = normalize((pF - vCentre) / (vAxes * vAxes));
    vec3 NB = normalize((pB - vCentre) / (vAxes * vAxes));

    // Near wall over far wall. Two-sided drawing used to get this by blending
    // the hull twice in whatever order the triangles arrived; here both hits
    // fall out of the same quadratic, so the order is guaranteed and each wall
    // is fogged at the depth it is actually at. Dropping the far wall would
    // cost about a third of the rim opacity and half the centre's — the
    // difference between glass and a decal.
    vec4 near = wall(NF, V, -pF.z);
    vec4 far = wall(NB, V, -pB.z);

    float alpha = near.w + far.w * (1.0 - near.w);
    // Un-premultiply: colorspace_fragment applies the sRGB curve to rgb only
    vec3 col = (near.xyz * near.w + far.xyz * far.w * (1.0 - near.w)) / max(alpha, 1e-4);

    // The card is a flat plane through the sphere; without this the depth test
    // would compare the plane's depth, and a shark grazing a big bubble would
    // pop the whole thing off at once instead of cutting through it
    gl_FragDepth = 0.5 * ((vProj.x * pF.z + vProj.y) / -pF.z) + 0.5;

    gl_FragColor = vec4(col, clamp(alpha * cover, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

function createBubbles(count, wakeCount) {
  // Two triangles per bubble, spanning [-1, 1]: the card the sphere is solved on
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3
  ));

  const pos = new Float32Array(count * 3);
  const scale = new Float32Array(count);
  const seed = new Float32Array(count);
  const alpha = new Float32Array(count);

  geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
  geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale, 1));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
  geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alpha, 1));
  geo.instanceCount = count;

  const material = new THREE.ShaderMaterial({
    vertexShader: BUBBLE_VERT,
    fragmentShader: BUBBLE_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uMurk: { value: new THREE.Color(MURK) },
      uFoam: { value: new THREE.Color(FOAM) },
      uKey: { value: new THREE.Vector3(0.35, 0.9, 0.25).normalize() },
      uFog: { value: FOG_DENSITY },
      uPxScale: { value: 0.002 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, material);
  // The instances move every frame, so the geometry's own bounds mean nothing
  mesh.frustumCulled = false;

  const state = {
    mesh,
    material,
    count,
    // The head of the pool is reserved: sharks pull from it to lay a wake, and
    // it sits parked far below the volume until they do. Keeping it first means
    // the governor can trim ambient bubbles off the tail without taking the
    // wake with them.
    wakeCount,
    wakeCursor: 0,
    active: count,
    pos,
    scale,
    seed,
    alpha,
    vel: new Float32Array(count * 3),
    rise: new Float32Array(count),
    phase: new Float32Array(count),
    wobble: new Float32Array(count),
    parked: new Uint8Array(count),
  };

  for (let i = 0; i < count; i++) spawn(state, i, i < wakeCount);
  return state;
}

// Place bubble `i` somewhere fresh. Parked bubbles are wake stock waiting for a
// shark; the rest enter from below the frustum.
function spawn(state, i, park = false, fromTop = false) {
  const { pos, scale, seed, alpha, vel, rise, phase, wobble, parked } = state;

  // Depth biased towards the camera, so the near half of the volume — the half
  // the fog has not eaten — carries most of the bubbles
  const z = NEAR_Z + (FAR_Z - NEAR_Z) * Math.pow(Math.random(), 1.7);
  const { halfW, halfH } = extentsAt(z);

  // Many small, a few big: r^3 keeps the large ones rare enough to be an event
  const r = (0.055 + Math.pow(Math.random(), 3) * 0.85) * bubbleScale();

  pos[i * 3] = (Math.random() * 2 - 1) * halfW;
  pos[i * 3 + 1] = park
    ? -1e4
    : fromTop
      ? (Math.random() * 2 - 1) * halfH
      : -halfH - Math.random() * 6 - r;
  pos[i * 3 + 2] = z;

  vel[i * 3] = 0;
  vel[i * 3 + 1] = 0;
  vel[i * 3 + 2] = 0;

  scale[i] = r;
  seed[i] = Math.random();
  alpha[i] = 0.34 + Math.random() * 0.42;
  // Terminal velocity in water goes up with radius — big ones outrun the motes
  rise[i] = 1.1 + r * 3.4 + Math.random() * 0.7;
  phase[i] = Math.random() * Math.PI * 2;
  wobble[i] = 0.35 + Math.random() * 0.9;
  parked[i] = park ? 1 : 0;
}

// A bubble's on-screen size is set by the frustum height, so a portrait phone —
// where the frustum is far narrower than it is tall — would otherwise be full of
// boulders. Scale the field to the narrow dimension instead.
function bubbleScale() {
  return Math.min(1, Math.max(0.42, view.aspect / 1.6));
}

// Half-extents of the frustum at a given depth
function frustumAt(z) {
  const halfH = Math.abs(z) * Math.tan((FOV * Math.PI) / 360);
  return { halfH, halfW: halfH * view.aspect };
}

// The same, padded, so bubbles have somewhere to drift in from
function extentsAt(z) {
  const halfH = Math.abs(z) * Math.tan((FOV * Math.PI) / 360) * 1.22 + 2;
  return { halfH, halfW: halfH * view.aspect };
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Vector3();

function updateBubbles(state, dt, time) {
  const { pos, vel, scale, rise, phase, wobble, parked } = state;
  const count = state.active;

  const usePointer = pointer.active && pointer.strength > 0.01;
  const R = 7.5;              // reach of the cursor, in world units
  const R2 = R * R;

  for (let i = 0; i < count; i++) {
    if (parked[i]) continue;

    const ix = i * 3;
    let px = pos[ix];
    let py = pos[ix + 1];
    let pz = pos[ix + 2];

    // ---- Buoyancy, drag, and the spiral every rising bubble traces ----
    phase[i] += dt * wobble[i] * 2.2;
    const swirl = scale[i] * 1.6 + 0.5;

    vel[ix] += Math.sin(phase[i]) * swirl * dt;
    vel[ix + 2] += Math.cos(phase[i] * 0.87) * swirl * 0.55 * dt;
    vel[ix + 1] += (rise[i] - vel[ix + 1]) * dt * 1.6;

    // ---- The cursor, as a rod pushed through the water ----
    if (usePointer) {
      // Distance from the bubble to the pointer ray, not to a point on screen:
      // a bubble ten units behind the cursor should feel nothing
      _v.set(px, py, pz).sub(pointer.ray.origin);
      const along = _v.dot(pointer.ray.direction);
      if (along > 0) {
        _c.copy(pointer.ray.direction).multiplyScalar(along).add(pointer.ray.origin);
        _w.set(px - _c.x, py - _c.y, pz - _c.z);
        const d2 = _w.lengthSq();
        if (d2 < R2) {
          const d = Math.sqrt(d2) || 1e-4;
          const fall = 1 - d / R;
          // Shove out of the way, and stir around the rod so the field curls
          const push = (fall * fall * 46 * pointer.strength) / (0.5 + scale[i] * 3);
          _w.multiplyScalar(1 / d);
          vel[ix] += _w.x * push * dt;
          vel[ix + 1] += _w.y * push * dt;
          vel[ix + 2] += _w.z * push * dt;

          const sw = fall * 12 * pointer.strength;
          vel[ix] += (pointer.ray.direction.y * _w.z - pointer.ray.direction.z * _w.y) * sw * dt;
          vel[ix + 1] += (pointer.ray.direction.z * _w.x - pointer.ray.direction.x * _w.z) * sw * dt;
        }
      }
    }

    // ---- Drag ----
    const drag = 1 - Math.min(1, dt * 1.9);
    vel[ix] *= drag;
    vel[ix + 2] *= drag;

    px += vel[ix] * dt;
    py += vel[ix + 1] * dt;
    pz += vel[ix + 2] * dt;

    // ---- Keep the volume populated ----
    const { halfW, halfH } = extentsAt(pz);
    if (py > halfH + scale[i]) {
      // A bubble off the top goes back to whichever pool it belongs to. Sending
      // wake stock back into the ambient field instead is what made the water
      // thicken every time a shark went past and never thin out again.
      spawn(state, i, i < state.wakeCount);
      continue;
    }
    if (px > halfW) px -= halfW * 2;
    else if (px < -halfW) px += halfW * 2;
    if (pz > NEAR_Z) { pz = NEAR_Z; vel[ix + 2] = 0; }
    else if (pz < FAR_Z) { pz = FAR_Z; vel[ix + 2] = 0; }

    pos[ix] = px;
    pos[ix + 1] = py;
    pos[ix + 2] = pz;
  }

  state.material.uniforms.uTime.value = time;
  state.mesh.geometry.getAttribute('aPos').needsUpdate = true;
}

// A shark drags the water with it. Sample its spine, shove anything close out
// of the way, pull it along, and let it spin off the trailing edge.
function wakeBubbles(state, shark, dt) {
  const { pos, vel, scale, parked } = state;
  const count = state.active;
  const fx = shark.forward.x;
  const fy = shark.forward.y;
  const fz = shark.forward.z;
  const half = shark.length * 0.5;
  const speed = shark.speed;

  const SAMPLES = 6;
  for (let s = 0; s < SAMPLES; s++) {
    const t = s / (SAMPLES - 1);
    // Fatten towards the middle: the reach follows the animal's girth.
    // The water an animal drags is much wider than the animal — a shark that
    // only disturbs what it touches reads as a cardboard cutout sliding past.
    const R = shark.girth * (1.2 + Math.sin(t * Math.PI) * 1.7);
    const R2 = R * R;
    const along = half - t * shark.length;
    const cx = shark.pos.x + fx * along;
    const cy = shark.pos.y + fy * along;
    const cz = shark.pos.z + fz * along;

    for (let i = 0; i < count; i++) {
      if (parked[i]) continue;
      const ix = i * 3;
      const dx = pos[ix] - cx;
      const dy = pos[ix + 1] - cy;
      const dz = pos[ix + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;

      const d = Math.sqrt(d2) || 1e-4;
      const fall = 1 - d / R;
      const mass = 1 / (0.5 + scale[i] * 3);

      // Out of the way
      const push = fall * fall * speed * 3.4 * mass;
      vel[ix] += (dx / d) * push * dt;
      vel[ix + 1] += (dy / d) * push * dt;
      vel[ix + 2] += (dz / d) * push * dt;

      // Dragged along behind, hardest at the tail where the water is worst
      const suck = fall * speed * (0.25 + t * 0.85) * mass;
      vel[ix] += fx * suck * dt;
      vel[ix + 1] += fy * suck * dt;
      vel[ix + 2] += fz * suck * dt;

      // No bubble survives inside the animal. Pinned to the animal's own girth
      // rather than to R: if the hard shell grew with the soft reach it would
      // become a visible force field around an unchanged model, and the same
      // bubble would get teleported twice in a frame by neighbouring samples.
      // These are the radii R * 0.42 gave before the reach was widened.
      const body = shark.girth * (0.378 + Math.sin(t * Math.PI) * 0.546);
      if (d < body) {
        const k = body / d;
        pos[ix] = cx + dx * k;
        pos[ix + 1] = cy + dy * k;
        pos[ix + 2] = cz + dz * k;
      }
    }
  }
}

// Lay a trail off the tail while a shark is running
function emitWake(state, shark, count) {
  const { pos, vel, scale, alpha, parked, seed, rise, phase, wobble } = state;
  if (state.wakeCount <= 0) return;

  for (let n = 0; n < count; n++) {
    const i = state.wakeCursor++ % state.wakeCount;
    const ix = i * 3;
    const back = shark.length * (0.42 + Math.random() * 0.16);
    const r = (0.05 + Math.random() * 0.16) * bubbleScale();

    pos[ix] = shark.pos.x - shark.forward.x * back + (Math.random() - 0.5) * shark.girth * 1.6;
    pos[ix + 1] = shark.pos.y - shark.forward.y * back + (Math.random() - 0.5) * shark.girth * 1.2;
    pos[ix + 2] = shark.pos.z - shark.forward.z * back + (Math.random() - 0.5) * shark.girth * 1.6;

    const kick = shark.speed * 0.35;
    vel[ix] = -shark.forward.x * kick + (Math.random() - 0.5) * 3;
    vel[ix + 1] = -shark.forward.y * kick + Math.random() * 2;
    vel[ix + 2] = -shark.forward.z * kick + (Math.random() - 0.5) * 3;

    scale[i] = r;
    seed[i] = Math.random();
    alpha[i] = 0.5 + Math.random() * 0.4;
    rise[i] = 1.4 + r * 3.4;
    phase[i] = Math.random() * Math.PI * 2;
    wobble[i] = 0.8 + Math.random();
    parked[i] = 0;
  }
  state.mesh.geometry.getAttribute('aScale').needsUpdate = true;
  state.mesh.geometry.getAttribute('aSeed').needsUpdate = true;
  state.mesh.geometry.getAttribute('aAlpha').needsUpdate = true;
}

// ============================================================
// Water: depth gradient, and shafts of light coming down through it
// ============================================================

const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    return noise(p) * 0.55 + noise(p * 2.03) * 0.28 + noise(p * 4.11) * 0.17;
  }
`;

function createBackdrop() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSurface: { value: new THREE.Color(SURFACE) },
      uMurk: { value: new THREE.Color(MURK) },
      uAbyss: { value: new THREE.Color(ABYSS) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // Pinned to the far plane, whatever the camera is doing
        gl_Position = vec4(position.xy, 1.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform vec3 uSurface;
      uniform vec3 uMurk;
      uniform vec3 uAbyss;
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main() {
        float h = vUv.y;
        vec3 col = h > 0.55
          ? mix(uMurk, uSurface, smoothstep(0.55, 1.0, h))
          : mix(uAbyss, uMurk, smoothstep(0.0, 0.55, h));

        // Far shafts: broad, slow, and never quite repeating
        float band = fbm(vec2(vUv.x * 3.4 - uTime * 0.012, uTime * 0.026));
        float shaft = smoothstep(0.52, 0.95, band) * smoothstep(0.0, 0.75, h);
        col += uSurface * shaft * 0.26;

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, material };
}

// Shafts that live in the volume, so they slide against the flat ones behind
// when the camera drifts
function createShafts() {
  const group = new THREE.Group();
  const materials = [];

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: 0 },
      uTint: { value: new THREE.Color(0x9fd8ef) },
      uFog: { value: FOG_DENSITY },
      uStrength: { value: 0.1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform float uSeed;
      uniform float uStrength;
      uniform float uFog;
      uniform vec3 uTint;
      varying vec2 vUv;
      varying float vDepth;
      ${NOISE_GLSL}
      void main() {
        float x = vUv.x * 5.0 + uSeed * 17.0;
        float band = fbm(vec2(x - uTime * 0.02, uTime * 0.05 + uSeed * 9.0));
        float shaft = smoothstep(0.55, 0.98, band);
        // Cut the shaft off at the top and taper it into the dark below
        float fade = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.72, vUv.y);
        float fog = 1.0 - exp(-uFog * uFog * vDepth * vDepth);
        gl_FragColor = vec4(uTint, shaft * fade * uStrength * (1.0 - fog));
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  [-58, -38, -20].forEach((z, i) => {
    const m = material.clone();
    m.uniforms.uSeed.value = i * 0.37 + 0.11;
    m.uniforms.uStrength.value = 0.13 - i * 0.028;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    mesh.position.z = z;
    mesh.frustumCulled = false;
    mesh.renderOrder = -0.5;
    group.add(mesh);
    materials.push(m);
  });

  return { group, materials, resize: () => {
    group.children.forEach((mesh) => {
      const { halfW, halfH } = extentsAt(mesh.position.z);
      mesh.scale.set(halfW * 2.4, halfH * 2.6, 1);
    });
  } };
}

// ============================================================
// Sharks
// ============================================================
//
// Neither model shipped an animation, so the swim is a travelling wave applied
// in the vertex shader: lateral displacement growing towards the tail, and the
// normal rotated to match so the light still sits right on the flank.

function patchSwim(material, geometry, cfg) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const zLen = box.max.z - box.min.z;

  const uniforms = {
    uTime: { value: 0 },
    uAmp: { value: cfg.amp * zLen },
    uWaveK: { value: cfg.waveK },
    uRate: { value: cfg.rate },
    uHead: { value: cfg.headBias },
    uZHead: { value: box.max.z },
    uZLen: { value: zLen },
  };

  material.customProgramCacheKey = () => 'ocean-swim';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime, uAmp, uWaveK, uRate, uHead, uZHead, uZLen;
        float swimBend, swimSlope;
        `
      )
      // Runs before begin_vertex, so this is where both terms get computed
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        {
          // 0 at the snout, 1 at the tip of the caudal fin
          float s = clamp((uZHead - position.z) / uZLen, 0.0, 1.0);
          float env = uHead + (1.0 - uHead) * s * s * (0.4 + 0.6 * s);
          float ph = s * uWaveK - uTime * uRate;
          swimBend = sin(ph) * uAmp * env;
          // d(bend)/dz, for tilting the normal by the same amount the surface tilts
          swimSlope = -cos(ph) * uAmp * env * uWaveK / uZLen;
        }
        #include <beginnormal_vertex>
        {
          float c = inversesqrt(1.0 + swimSlope * swimSlope);
          float sn = swimSlope * c;
          objectNormal = vec3(
            objectNormal.x * c + objectNormal.z * sn,
            objectNormal.y,
            -objectNormal.x * sn + objectNormal.z * c
          );
        }
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        transformed.x += swimBend;
        `
      );
  };
  material.needsUpdate = true;
  return uniforms;
}

function makeShark(gltf, cfg) {
  const model = gltf.scene;

  let mesh = null;
  model.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) return null;

  const material = mesh.material;
  material.side = THREE.DoubleSide;   // the fins are single sheets
  material.roughness = Math.min(1, (material.roughness ?? 1) * 0.9 + 0.25);
  material.metalness = 0.05;
  const swim = patchSwim(material, mesh.geometry, cfg.swim);

  // Normalise: centre on the origin, scale to a known length, +Z is the snout
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);

  const inner = new THREE.Group();
  inner.scale.setScalar(cfg.length / size.z);
  inner.add(model);

  const pivot = new THREE.Group();
  pivot.add(inner);
  pivot.visible = false;

  return {
    pivot,
    swim,
    cfg,
    length: cfg.length,
    girth: cfg.girth,
    // Lateral half-span, read off the model rather than guessed — cfg.girth is
    // the wake's reach and was never applied to the mesh. Running along x puts
    // this span in world Z, so the far corner of the body sits in a slice of
    // the frustum `reach` deeper than the centre does.
    reach: (size.x / size.z) * cfg.length * 0.5 + cfg.swim.amp * cfg.length,
    pos: new THREE.Vector3(0, 0, -1000),
    forward: new THREE.Vector3(0, 0, 1),
    speed: 0,
    // Runs are scheduled: lurk out of frame, then cross it
    state: 'wait',
    wait: 1.2 + Math.random() * 2.5,
    u: 0,
    curve: null,
    duration: 1,
    bank: 0,
    emitAcc: 0,
  };
}

const _tan = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// The widest the frame can be at a given depth. planRun draws its plan against
// a camera at the origin looking straight down -Z, and renderFrame() gives it
// neither: it drifts up to 3 units sideways and lookAt() yaws it back toward
// centre by up to 0.05 rad. A yaw of psi opens the leading edge to
// tan(theta + psi), which is worth 10% at 16:9 and 17% at 5:1 — the margin has
// to grow with the field of view, not with depth, which is the way a flat
// per-depth pad gets it backwards.
const CAM_YAW = 0.05;

function edgeAt(z) {
  return Math.abs(z) * Math.tan(Math.atan(view.halfW) + CAM_YAW) + 1.5;
}

// One pass across the frame. Entry and exit sit outside the frustum, the middle
// is pulled off-axis so the animal arcs rather than sliding on a rail, and a
// share of the runs come in close enough to fill the screen.
function planRun(shark) {
  const cfg = shark.cfg;
  const close = Math.random() < 0.28;
  // Depths are world units, but a portrait phone frames a third of the width a
  // desktop does, so the same run that reads as a pass there reads as a wall of
  // shark here. Hold the animal further off when the frame is narrow.
  const room = Math.min(1, view.aspect / 1.5);
  const push = 1 + (1 - room) * 1.5;
  const near = cfg.depth[1] * push;
  const far = cfg.depth[0] * push;
  const z = close
    ? near + (near - far) * 0.35 * Math.random()
    : far + Math.random() * (near - far);

  const { halfH } = frustumAt(z);
  const dir = Math.random() < 0.5 ? 1 : -1;

  const y0 = (Math.random() * 2 - 1) * halfH * 0.55;
  const y1 = (Math.random() * 2 - 1) * halfH * 0.55;
  // A close run can plan as shallow as -4.75, so an unconditional +/-14 swing
  // throws one end through z = 0 and anchors it BEHIND the camera — frustumAt
  // takes Math.abs(z) and happily returns a half width for it. That was
  // slicing the body open on the near plane on about one run in six.
  const depthSwing = (Math.random() * 2 - 1)
    * Math.max(0, Math.min(14, Math.abs(z) + NEAR_Z));
  const bow = (Math.random() * 2 - 1) * halfH * 0.5;

  // Each end is anchored against the frame at the deepest point the body
  // reaches there: its own depth plus its lateral span. Two errors used to
  // stack here. Padding both ends against the half width at the MIDPOINT left
  // the deeper end short by |depthSwing| * tan(fov/2) * aspect. Padding against
  // the bare frustum left both ends short by whatever the camera drift had
  // opened up. Neither shows on a phone, both scale with aspect, and the second
  // is the larger — which is why fixing only the first made the wide case
  // worse: the midpoint padding had been over-paying the shallow end by exactly
  // what it under-paid the deep one.
  const z0 = z - depthSwing;
  const z3 = z + depthSwing;
  const anchor = (zz) => edgeAt(Math.abs(zz) + shark.reach) + shark.length * 0.5;

  const p0 = new THREE.Vector3(-dir * anchor(z0), y0, z0);
  const p3 = new THREE.Vector3(dir * anchor(z3), y1, z3);
  const p1 = new THREE.Vector3(
    THREE.MathUtils.lerp(p0.x, p3.x, 0.33), (y0 + y1) * 0.5 + bow, z + depthSwing * 0.4
  );
  const p2 = new THREE.Vector3(
    THREE.MathUtils.lerp(p0.x, p3.x, 0.67), (y0 + y1) * 0.5 - bow * 0.6, z - depthSwing * 0.2
  );

  shark.curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
  const speed = cfg.speed[0] + Math.random() * (cfg.speed[1] - cfg.speed[0]);
  shark.duration = shark.curve.getLength() / speed;
  shark.u = 0;
  shark.state = 'run';
  shark.pivot.visible = true;
}

function updateShark(shark, dt, time, bubbleState) {
  shark.swim.uTime.value = time;

  if (shark.state === 'wait') {
    shark.wait -= dt;
    if (shark.wait <= 0) planRun(shark);
    return;
  }

  const prevU = shark.u;
  shark.u += dt / shark.duration;

  if (shark.u >= 1) {
    shark.state = 'wait';
    shark.wait = shark.cfg.rest[0] + Math.random() * (shark.cfg.rest[1] - shark.cfg.rest[0]);
    shark.pivot.visible = false;
    shark.pos.set(0, 0, -1000);
    shark.speed = 0;
    return;
  }

  shark.curve.getPointAt(shark.u, shark.pos);
  shark.curve.getTangentAt(shark.u, _tan);
  shark.forward.copy(_tan);

  const step = shark.curve.getLength() * (shark.u - prevU);
  shark.speed = dt > 0 ? step / dt : 0;
  // A faster beat when it is working, a lazier one on the glide
  shark.swim.uRate.value = shark.cfg.swim.rate * (0.55 + shark.speed / shark.cfg.speed[1] * 0.6);

  shark.pivot.position.copy(shark.pos);
  _look.copy(shark.pos).add(_tan);
  shark.pivot.up.copy(_up);
  shark.pivot.lookAt(_look);

  // Bank into the turn, plus a slow roll so it never reads as being on rails
  const turn = THREE.MathUtils.clamp(_tan.y * 2.2, -1, 1);
  const target = -turn * 0.5 + Math.sin(time * 0.6 + shark.length) * 0.07;
  shark.bank += (target - shark.bank) * Math.min(1, dt * 2.4);
  shark.pivot.rotateZ(shark.bank);

  // Shove the water it is moving through, and leave something behind
  wakeBubbles(bubbleState, shark, dt);
  shark.emitAcc += dt;
  const interval = 0.22;
  while (shark.emitAcc > interval) {
    shark.emitAcc -= interval;
    emitWake(bubbleState, shark, 1);
  }
}

// ============================================================
// Lifecycle
// ============================================================

// innerWidth reads zero in a hidden or collapsed viewport, which would size the
// canvas to a pixel and pick the low-density field for a desktop
function viewportSize() {
  const el = document.documentElement;
  return {
    w: window.innerWidth || el.clientWidth || 1280,
    h: window.innerHeight || el.clientHeight || 800,
  };
}

function measureView() {
  const { w, h } = viewportSize();
  view.aspect = w / h;
  view.halfH = Math.tan((FOV * Math.PI) / 360);
  view.halfW = view.halfH * view.aspect;
  return { w, h };
}

function resize() {
  if (!renderer) return;
  const { w, h } = measureView();
  camera.aspect = view.aspect;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(w, h, false);
  shafts?.resize();
  syncPixelScale();
}

// How much world a pixel covers, per unit of depth. The bubble cards pad
// themselves by a pixel and a half so the edge fade has somewhere to happen,
// and that padding has to be in world units.
function syncPixelScale() {
  if (!bubbles || !renderer) return;
  const px = renderer.getContext().drawingBufferHeight || 1;
  bubbles.material.uniforms.uPxScale.value =
    (2 * Math.tan((FOV * Math.PI) / 360)) / px;
}

function onPointerMove(e) {
  const { w, h } = viewportSize();
  const x = (e.clientX / w) * 2 - 1;
  const y = -(e.clientY / h) * 2 + 1;
  // Speed decides how hard the water gets stirred, so a slow drift barely
  // registers and a fast swipe throws the field
  const moved = Math.hypot(x - pointer.lastX, y - pointer.lastY);
  pointer.strength = Math.min(1.6, pointer.strength + moved * 6 + 0.16);
  pointer.lastX = x;
  pointer.lastY = y;
  pointer.ndc.set(x, y);
  pointer.active = true;
}

function onPointerLeave() {
  pointer.active = false;
}

let backdrop = null;
let scrollY = 0;
let elapsed = 0;

function tick() {
  frameId = requestAnimationFrame(tick);
  if (!running) return;
  const now = performance.now();
  const dt = (now - lastFrameAt) / 1000;
  lastFrameAt = now;
  // Cap it: a backgrounded tab hands back one enormous step, and the bubbles
  // would all be thrown out of the volume in a single frame
  renderFrame(Math.min(dt, 0.05));
}

// Advance the water by one step and draw it. The animation loop feeds this the
// real frame time; anything wanting a deterministic scene — a headless check, a
// screenshot — can drive it at a fixed step instead.
export function renderFrame(dt) {
  if (!renderer) return;

  elapsed += dt;
  const time = elapsed;

  pointer.strength *= 1 - Math.min(1, dt * 2.6);

  // Drift, plus a little parallax off the cursor and the scroll position
  const sway = Math.sin(time * 0.11) * 1.4;
  camTarget.set(
    sway + pointer.ndc.x * 1.6,
    Math.cos(time * 0.08) * 0.9 + pointer.ndc.y * 1.0 - scrollY * 5.5,
    Math.sin(time * 0.05) * 1.2
  );
  camera.position.lerp(camTarget, Math.min(1, dt * 0.9));
  camera.lookAt(camera.position.x * 0.35, camera.position.y * 0.35, -40);

  if (pointer.active) {
    // The ray has to come off this frame's camera, and matrixWorld is not
    // refreshed until render
    camera.updateMatrixWorld();
    pointer.raycaster.setFromCamera(pointer.ndc, camera);
    pointer.ray.copy(pointer.raycaster.ray);
  }

  for (const shark of sharks) updateShark(shark, dt, time, bubbles);
  updateBubbles(bubbles, dt, time);

  backdrop.material.uniforms.uTime.value = time;
  shafts.materials.forEach((m) => { m.uniforms.uTime.value = time; });

  renderer.render(scene, camera);
  govern(dt);
}

// Rather than refuse to run on a weak GPU, watch the first few seconds and give
// back resolution, then bubbles, until the frame budget is met.
const perf = { frames: 0, sum: 0, step: 0 };

function govern(dt) {
  if (perf.step > 1) return;
  perf.frames++;
  perf.sum += dt;
  if (perf.frames < 100) return;

  const avg = perf.sum / perf.frames;
  perf.frames = 0;
  perf.sum = 0;
  if (avg < 1 / 33) { perf.step = 2; return; }   // comfortably above 33fps, leave it

  perf.step++;
  if (perf.step === 1) {
    renderer.setPixelRatio(Math.min(1, window.devicePixelRatio || 1));
    syncPixelScale();
  } else {
    bubbles.active = bubbles.wakeCount +
      Math.floor((bubbles.count - bubbles.wakeCount) * 0.5);
    bubbles.mesh.geometry.instanceCount = bubbles.active;
  }
}

function onScroll() {
  // Normalised against a screenful rather than against the page. The Research
  // path is barely taller than the viewport now, so dividing by that stub of
  // overflow swung the camera a full unit for thirty pixels of scroll.
  scrollY = Math.min(1, window.scrollY / Math.max(1, viewportSize().h));
}

// Two independent reasons to hold the water still — a panel covering it, and
// the visitor having asked for stillness. Tracking them separately is what
// stops closing a panel from restarting water the visitor had paused.
const holds = new Set();

function hold(reason, on) {
  if (on) holds.add(reason);
  else holds.delete(reason);
  if (holds.size) pause();
  else resume();
}

function onStage(e) {
  hold('panel', !!e.detail?.open);
}

function onMotion(e) {
  hold('visitor', e.detail?.run === false);
}

function onVisibility() {
  if (document.hidden) pause();
  else if (!disposed && scene) resume();
}

// ---- Public API ----

let started = false;

export async function initOceanWater(canvas) {
  if (disposed) return false;
  if (started) { resume(); return true; }

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
  } catch {
    return false;
  }
  renderer.setClearColor(new THREE.Color(MURK), 1);

  started = true;
  measureView();

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(MURK, FOG_DENSITY);

  camera = new THREE.PerspectiveCamera(FOV, view.aspect, 0.5, 300);
  camera.position.set(0, 0, 0);

  lastFrameAt = performance.now();

  // Light: one shaft from the surface, one cold bounce from the deep
  const key = new THREE.DirectionalLight(0xdff2ff, 1.5);
  key.position.set(0.35, 1, 0.45);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x7fc0e0, 0x04122c, 0.5));

  backdrop = createBackdrop();
  scene.add(backdrop.mesh);

  shafts = createShafts();
  scene.add(shafts.group);

  const small = viewportSize().w < 900 || isTouchDevice();
  bubbles = createBubbles(small ? 170 : 380, small ? 34 : 70);
  scene.add(bubbles.mesh);

  resize();

  const reduced = prefersReducedMotion();

  window.addEventListener('resize', resize);
  if (!reduced) {
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    // An expanded research panel covers the water entirely, and carries video
    document.addEventListener('research-stage', onStage);
    document.addEventListener('ocean-motion', onMotion);
    // The toggle sets this at load, long before the water is lazily imported,
    // so a visitor who paused earlier in the session would otherwise get the
    // water back the moment they returned to this path
    if (document.getElementById('path-ocean')?.dataset.drift === 'off') {
      holds.add('visitor');
    }
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    pause();
  });

  // Settle the field before it is shown, so the first frame is not a floor of
  // bubbles waiting to rise
  for (let i = 0; i < 90; i++) updateBubbles(bubbles, 1 / 30, i / 30);

  if (reduced) {
    // Honour the preference but still show the volume: one frame, held
    renderFrame(0);
    canvas.classList.add('is-lit');
    return true;
  }

  loadSharks();
  resume();
  canvas.classList.add('is-lit');
  return true;
}

function loadSharks() {
  const loader = new GLTFLoader();
  SHARKS.forEach((cfg, i) => {
    loader.load(
      cfg.url,
      (gltf) => {
        if (disposed || !scene) return;
        const shark = makeShark(gltf, cfg);
        if (!shark) return;
        // Stagger them so the first two runs do not land together
        shark.wait = 0.8 + i * 3.4;
        scene.add(shark.pivot);
        sharks.push(shark);
      },
      undefined,
      () => { /* one shark missing is not worth losing the water over */ }
    );
  });
}

export function resume() {
  if (disposed || !renderer || running) return;
  if (prefersReducedMotion()) return;
  if (holds.size) return;
  running = true;
  lastFrameAt = performance.now();   // drop whatever accumulated while paused
  if (frameId === null) frameId = requestAnimationFrame(tick);
}

export function pause() {
  running = false;
  if (frameId !== null) {
    cancelAnimationFrame(frameId);
    frameId = null;
  }
}


