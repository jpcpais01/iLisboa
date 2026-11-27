// Low-poly vessels for the boats layer, one merged geometry per kind, drawn instanced (one call per kind).
// +x is the bow, y up, z to port; y = 0 is the waterline and the origin is amidships. Every model is built at a nominal
// length and beam (NOMINAL) and scaled per instance to the ship's real AIS dimensions.
// Vertex colour alpha = 0 marks paint that takes the instance colour (hull livery); aGlow marks what lights up at night
// (windows, deck and navigation lights).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function finish(g, hex, { tint = false, glow = 0 } = {}) {
  g = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex), n = g.attributes.position.count, col = new Float32Array(n * 4), gl = new Float32Array(n);
  for (let i = 0; i < n; i++) { col.set([c.r, c.g, c.b, tint ? 0 : 1], i * 4); gl[i] = glow; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setAttribute('aGlow', new THREE.BufferAttribute(gl, 1));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'aGlow'].includes(k)) g.deleteAttribute(k);
  return g;
}
const box = (x, y, z, w, h, d, hex, o) => finish(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex, o);
const cyl = (x, y, z, r0, r1, h, hex, o, seg = 8) => finish(new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y, z), hex, o);
const done = (parts) => { const g = mergeGeometries(parts); g.computeBoundingSphere(); return g; };

// a hull: flat sides, a curved bow coming to a point, a transom stern; from `bottom` (below the waterline, hidden by the
// opaque water) up to `top`. bow: length of the curved bow part; flare: how much wider the deck is than the keel line
function hull(L, B, bottom, top, bow, hex, o = {}, sternRound = 0) {
  const s = new THREE.Shape(), h = B / 2, xb = L / 2 - bow, xs = -L / 2;
  s.moveTo(xs + sternRound, -h);
  s.lineTo(xb, -h);
  s.quadraticCurveTo(L / 2 - bow * 0.15, -h * 0.85, L / 2, 0);
  s.quadraticCurveTo(L / 2 - bow * 0.15, h * 0.85, xb, h);
  s.lineTo(xs + sternRound, h);
  if (sternRound) s.quadraticCurveTo(xs, h, xs, 0), s.quadraticCurveTo(xs, -h, xs + sternRound, -h);
  else s.lineTo(xs, -h);
  const g = new THREE.ExtrudeGeometry(s, { depth: top - bottom, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(-Math.PI / 2).translate(0, bottom, 0);   // shape y → −z: port is +z either way (symmetric)
  return finish(g, hex, o);
}
// a deckhouse with a band of glazing round it (lit at night)
function house(x, y, w, h, d, hex, glass = 0x1d2a33, band = 0.45) {
  return [box(x, y + h / 2, 0, w, h, d, hex), box(x, y + h * 0.55, 0, w + 0.06, h * band, d + 0.06, glass, { glow: 1 })];
}
const navLights = (L, y, B) => [
  box(L * 0.1, y, B / 2 + 0.05, 0.3, 0.3, 0.1, 0x2fd35a, { glow: 2 }), box(L * 0.1, y, -B / 2 - 0.05, 0.3, 0.3, 0.1, 0xe0302a, { glow: 2 }),
];

// ─── kinds ───
// TTSL ferry: twin-hull catamaran, white with the operator's teal-blue band, two passenger decks, wheelhouse on top
function ferry() {
  const L = 40, B = 10.5, p = [];
  for (const z of [-3.6, 3.6]) p.push(finish(hullGeom(L, 2.8, -2, 1.4, 7).translate(0, 0, z), 0x1c3c5a));
  p.push(box(-0.5, 1.75, 0, L - 3, 0.7, B, 0xf2f2ee));
  p.push(...house(-1, 2.1, L - 7, 2.6, B - 0.6, 0xf4f4f0));
  p.push(box(-1, 2.35, 0, L - 6.9, 0.35, B - 0.5, 0x0f7f8f, { tint: true }));   // livery band (instance colour = line colour)
  p.push(...house(-3, 4.7, L - 15, 2.3, B - 1.6, 0xf4f4f0));
  p.push(...house(5, 7, 5, 1.8, 4.5, 0xf4f4f0, 0x16222b, 0.6));
  p.push(box(-L / 2 + 6, 7.4, 0, 3, 0.25, B - 2, 0xd8d8d2));
  p.push(cyl(5, 9.8, 0, 0.08, 0.08, 2, 0x333333), box(5, 10.8, 0, 0.3, 0.3, 0.3, 0xfff4dc, { glow: 2 }));
  p.push(...navLights(L, 8, 5));
  return done(p);
}
function hullGeom(L, B, bottom, top, bow) {   // (bare geometry for the catamaran's demihulls)
  const s = new THREE.Shape(), h = B / 2, xb = L / 2 - bow;
  s.moveTo(-L / 2, -h); s.lineTo(xb, -h); s.quadraticCurveTo(L / 2, -h * 0.6, L / 2, 0); s.quadraticCurveTo(L / 2, h * 0.6, xb, h); s.lineTo(-L / 2, h); s.lineTo(-L / 2, -h);
  return new THREE.ExtrudeGeometry(s, { depth: top - bottom, bevelEnabled: false, curveSegments: 5 }).rotateX(-Math.PI / 2).translate(0, bottom, 0);
}
// container ship (Panamax-ish 200 × 30 m): hull in livery colour, stacks of mixed boxes, white accommodation aft, funnel
const BOX_COLS = [0xb03a2e, 0x1f4e8c, 0x2e7d4f, 0xd9a33a, 0x8a8f96, 0xe8e6df, 0x5b3b8c, 0xc65d2e, 0x1e1e1e, 0x2a8fb8];
function container() {
  const L = 200, B = 30, p = [hull(L, B, -10, 6, 34, 0x1b2a44, { tint: true }), box(-L / 2 + 3, 6.2, 0, 6, 0.4, B - 1, 0xc23a2f)];
  let k = 0;
  for (let x = -L / 2 + 34; x < L / 2 - 26; x += 13.4) {
    const tiers = 3 + ((k * 7) % 4), rows = 11;
    for (let r = 0; r < rows; r++) {
      const zz = -B / 2 + 1.6 + r * ((B - 3.2) / (rows - 1)), tz = tiers - ((r * 3 + k) % 3 === 0 ? 1 : 0);
      for (let t = 0; t < tz; t++) p.push(box(x, 6 + 1.3 + t * 2.6, zz, 12.2, 2.5, 2.4, BOX_COLS[(k * 5 + r * 3 + t * 7) % BOX_COLS.length]));
      k++;
    }
  }
  p.push(...house(-L / 2 + 16, 6, 12, 20, B - 4, 0xf0efe8, 0x1d2a33, 0.25));
  for (let i = 0; i < 6; i++) p.push(box(-L / 2 + 22.05, 9 + i * 3, 0, 0.1, 0.9, B - 6, 0x1d2a33, { glow: 1 }));
  p.push(box(-L / 2 + 16, 26.3, 0, 13, 0.6, B + 2, 0xf0efe8));   // bridge wings
  p.push(box(-L / 2 + 8, 22, 0, 6, 8, 5, 0x2b2b2b), box(-L / 2 + 8, 25.5, 0, 6.1, 1.2, 5.1, 0xc23a2f));   // funnel
  p.push(cyl(L / 2 - 8, 14, 0, 0.3, 0.3, 16, 0xdedede), box(L / 2 - 8, 22.2, 0, 0.6, 0.6, 0.6, 0xfff4dc, { glow: 2 }));
  p.push(...navLights(-L * 0.4, 26.6, B + 2));
  return done(p);
}
// cruise ship (~300 × 36 m): white, many decks stepping back, balcony glazing bands, blue-glass top, funnel, lifeboats
function cruise() {
  const L = 300, B = 36, p = [hull(L, B, -9, 14, 60, 0x1b2c4a, { tint: true }, 6)];
  p.push(box(-6, 14.4, 0, L - 70, 0.8, B, 0xf6f6f4));
  const decks = 9;
  for (let d = 0; d < decks; d++) {
    const y = 15 + d * 3, len = L - 80 - d * 6, x = -14 + d * 1.5;
    p.push(box(x, y + 1.5, 0, len, 3, B - 0.6, 0xf7f7f5));
    p.push(box(x, y + 1.55, 0, len - 3, 1.4, B - 0.4, 0x24384a, { glow: 0.8 }));   // balcony glazing
  }
  p.push(box(20, 15 + decks * 3 + 2, 0, 60, 4, B - 6, 0x2d5f86, { glow: 0.6 }));  // pool-deck glass
  p.push(box(L / 2 - 56, 15 + decks * 3 - 1, 0, 6, 6, B + 2, 0xf7f7f5), box(L / 2 - 53, 15 + decks * 3, 0, 0.2, 2, B, 0x16222b, { glow: 1 }));   // bridge
  p.push(box(-80, 15 + decks * 3 + 6, 0, 18, 12, 10, 0xf7f7f5), box(-80, 15 + decks * 3 + 11.5, 0, 18.2, 2, 10.2, 0x1b2c4a, { tint: true }));
  for (let i = 0; i < 9; i++) for (const z of [B / 2 + 0.6, -B / 2 - 0.6]) p.push(box(-90 + i * 14, 20, z, 9, 2.4, 2.4, 0xf07a1a));   // lifeboats
  p.push(...navLights(L * 0.33, 45, B + 2));
  return done(p);
}
// tanker (180 × 32 m): red-brown deck, pipe manifold, catwalk, white house aft
function tanker() {
  const L = 180, B = 32, p = [hull(L, B, -11, 5, 30, 0x2a2a30, { tint: true }), box(0, 5.15, 0, L - 30, 0.3, B - 1, 0x8e3b2c)];
  p.push(box(8, 6, 0, L - 60, 0.4, 1.2, 0xd7d2c4), box(8, 7, 0, L - 60, 0.3, 0.6, 0xe2ddd0));
  for (let x = -40; x <= 50; x += 30) p.push(box(x, 6.5, 0, 3, 1.6, B - 6, 0x9d9a90));
  p.push(...house(-L / 2 + 14, 5, 14, 15, B - 4, 0xf0efe8, 0x1d2a33, 0.3), box(-L / 2 + 14, 20.3, 0, 15, 0.6, B + 1, 0xf0efe8));
  p.push(box(-L / 2 + 6, 19, 0, 5, 9, 5, 0x24364f), box(-L / 2 + 6, 23, 0, 5.1, 1, 5.1, 0xd8a12a));
  p.push(cyl(L / 2 - 6, 11, 0, 0.3, 0.3, 12, 0xdedede), box(L / 2 - 6, 17.2, 0, 0.6, 0.6, 0.6, 0xfff4dc, { glow: 2 }));
  p.push(...navLights(-L * 0.4, 20.6, B + 1));
  return done(p);
}
// bulk carrier (190 × 32 m): hatch covers and four deck cranes
function bulk() {
  const L = 190, B = 32, p = [hull(L, B, -11, 6, 30, 0x16304d, { tint: true })];
  for (let i = 0; i < 6; i++) p.push(box(-40 + i * 24, 7, 0, 16, 2, B - 8, 0x8b5a2b));
  for (let i = 0; i < 4; i++) { const x = -28 + i * 24; p.push(cyl(x, 12, 0, 1.2, 1.4, 12, 0xe2c23a), box(x + 8, 18, 0, 22, 1, 1, 0xe2c23a)); }
  p.push(...house(-L / 2 + 14, 6, 14, 14, B - 4, 0xf0efe8, 0x1d2a33, 0.3), box(-L / 2 + 6, 20, 0, 5, 8, 5, 0x2a2a2a));
  p.push(...navLights(-L * 0.4, 20.5, B));
  return done(p);
}
// general cargo / ro-ro (120 × 20 m)
function cargo() {
  const L = 120, B = 20, p = [hull(L, B, -7, 5, 20, 0x2e5a3a, { tint: true }), box(5, 5.2, 0, L - 30, 0.4, B - 1, 0x6b6b66)];
  for (let i = 0; i < 3; i++) p.push(box(-10 + i * 26, 6.5, 0, 18, 2.5, B - 4, [0x9a8f7a, 0x3c5f8a, 0xa8432f][i]));
  p.push(cyl(-24, 11, 6, 0.6, 0.7, 10, 0xe8c23a), box(-14, 15, 6, 20, 0.6, 0.6, 0xe8c23a));
  p.push(...house(-L / 2 + 10, 5, 10, 11, B - 3, 0xf0efe8, 0x1d2a33, 0.3), box(-L / 2 + 4, 15, 0, 3.5, 5, 3.5, 0x262626));
  p.push(...navLights(-L * 0.4, 16.4, B));
  return done(p);
}
// harbour tug (30 × 11 m): black hull, red-and-white house, tall wheelhouse, fendering
function tug() {
  const L = 30, B = 11, p = [hull(L, B, -4, 2.5, 8, 0x1c1c1c, { tint: true }, 3), box(0, 2.6, 0, L - 1, 0.6, B + 0.6, 0x111111)];
  p.push(...house(2, 2.6, 12, 3, B - 3, 0xf3f1ec), ...house(5, 5.6, 5, 2.6, B - 5, 0xf3f1ec, 0x16222b, 0.6));
  p.push(box(-1, 8, 0, 2, 3, 2, 0xc8302a), cyl(5, 10, 0, 0.1, 0.1, 3, 0x333333), box(5, 11.6, 0, 0.3, 0.3, 0.3, 0xfff4dc, { glow: 2 }));
  p.push(...navLights(L, 7, B - 4));
  return done(p);
}
// sailing yacht (11 × 3.6 m): white hull, deck, cabin top, mast and two sails (sails lie along the boom; a heeling
// instance rolls the whole rig). `furled`: moored boats show bare masts.
function sail(furled) {
  const L = 11, B = 3.6, p = [hull(L, B, -1.2, 1, 3.2, 0xf6f6f2, { tint: true }), box(-0.6, 1.02, 0, L - 3.4, 0.05, B - 0.4, 0xc9b591)];
  p.push(box(0, 1.4, 0, 3.6, 0.6, 2.2, 0xf2f2ee), box(0.2, 1.45, 0, 3.4, 0.25, 2.24, 0x1e2a33, { glow: 0.6 }));
  p.push(cyl(0.9, 8.5, 0, 0.07, 0.09, 15, 0xd8d8d8, {}, 5), box(-1.8, 2.2, 0, 5.2, 0.12, 0.12, 0xc8c8c8));
  p.push(box(0.9, 16.05, 0, 0.2, 0.2, 0.2, 0xfff4dc, { glow: 2 }));
  if (furled) p.push(box(-1.8, 2.45, 0, 5, 0.35, 0.35, 0x1f4e8c, { tint: true }));
  else {
    const tri = (a, b, c, hex) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...b], 3)); g.computeVertexNormals(); return finish(g, hex); };
    p.push(tri([0.85, 2.3, 0], [0.85, 15.2, 0], [-4.3, 2.3, 0], 0xf4f2ea));        // main
    p.push(tri([1.0, 13.5, 0], [L / 2 - 0.3, 1.2, 0], [1.0, 1.6, 0], 0xf0eee4));   // genoa
  }
  return done(p);
}
// motor yacht (13 × 4.3 m): white, dark glazing, flybridge
function motor() {
  const L = 13, B = 4.3, p = [hull(L, B, -1, 1.3, 4, 0xf7f7f4, { tint: true }), box(-0.4, 1.32, 0, L - 4, 0.05, B - 0.5, 0xc9b591)];
  p.push(box(-0.5, 2.0, 0, 6, 1.4, B - 0.7, 0xf7f7f4), box(-0.3, 2.05, 0, 6.06, 0.6, B - 0.64, 0x16222b, { glow: 0.6 }));
  p.push(box(-1.2, 2.9, 0, 3.5, 0.4, B - 1.2, 0xf2f2ee), cyl(-1.5, 3.8, 0, 0.05, 0.05, 1.6, 0xcccccc), box(-1.5, 4.6, 0, 0.18, 0.18, 0.18, 0xfff4dc, { glow: 2 }));
  return done(p);
}
// small open boat / RIB / pilot launch (8 × 2.8 m)
function launch() {
  const L = 8, B = 2.8, p = [hull(L, B, -0.6, 0.7, 2.5, 0xe8e8e2, { tint: true }), box(0, 1.2, 0, 1.2, 0.9, 1.4, 0xe8e8e2), box(0.25, 1.4, 0, 0.6, 0.4, 1.42, 0x16222b, { glow: 0.5 })];
  return done(p);
}
// fishing boat (16 × 5.5 m): blue hull, white house forward, gantry aft
function fishing() {
  const L = 16, B = 5.5, p = [hull(L, B, -2, 1.6, 4.5, 0x2a5ea8, { tint: true }), box(0, 1.65, 0, L - 2, 0.1, B - 0.4, 0x7a6a55)];
  p.push(...house(3, 1.6, 4, 2.2, B - 1.6, 0xf3f1ec, 0x16222b, 0.5), box(-6, 4, 0, 0.4, 4.5, B - 1, 0xdcdcdc), cyl(3, 5.5, 0, 0.06, 0.06, 3, 0x444444));
  return done(p);
}

// kind → builder, nominal size (the instance matrix scales to the real length/beam; height follows √(length ratio))
export const BOAT_KINDS = {
  ferry: { build: ferry, L: 40, B: 10.5 },
  container: { build: container, L: 200, B: 30 },
  cruise: { build: cruise, L: 300, B: 36 },
  tanker: { build: tanker, L: 180, B: 32 },
  bulk: { build: bulk, L: 190, B: 32 },
  cargo: { build: cargo, L: 120, B: 20 },
  tug: { build: tug, L: 30, B: 11 },
  sail: { build: () => sail(false), L: 11, B: 3.6 },
  moored: { build: () => sail(true), L: 11, B: 3.6 },
  motor: { build: motor, L: 13, B: 4.3 },
  launch: { build: launch, L: 8, B: 2.8 },
  fishing: { build: fishing, L: 16, B: 5.5 },
};

// Standard material with: instance colour only where the vertex alpha is 0 (the livery), and a warm/white glow at night
// on aGlow (windows 0–1, lamps 2)
export function boatMaterial(uNight) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = uNight;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow; varying float vGlow;')
      .replace('#include <color_vertex>', `vColor = vec4(color.rgb, 1.);
#ifdef USE_INSTANCING_COLOR
  vColor.rgb *= mix(instanceColor, vec3(1.), color.a);
#endif
  vGlow = aGlow;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow; uniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += (vGlow > 1.5 ? diffuseColor.rgb * 6. : vec3(1., .78, .5) * .55 * vGlow) * uNight;`);
  };
  m.customProgramCacheKey = () => 'ilisboa-boat-v1';
  return m;
}
