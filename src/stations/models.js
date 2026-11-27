// Low-poly street furniture for the station markers, true scale, one merged vertex-coloured geometry each
// (drawn instanced, one draw call per kind). Local frame: +x along the kerb, +z away from the road, y up,
// origin on the pavement at the foot of the pole.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const paint = (g, hex) => {
  g = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  return g;
};
const box = (x, y, z, w, h, d, hex) => paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
const cyl = (x, y, z, r, h, hex, seg = 6) => paint(new THREE.CylinderGeometry(r, r, h, seg).translate(x, y, z), hex);
const done = (parts) => { const g = mergeGeometries(parts); g.computeBoundingSphere(); return g; };

// Bus-stop pole with its flag: the flag is white (tinted per operator by the instance colour), the pole and
// timetable case are pre-darkened so the tint barely shows on them.
export function stopPoleGeometry() {
  return done([
    cyl(0, 1.45, 0, 0.045, 2.9, 0x3a3d40),
    box(0, 2.62, 0, 0.06, 0.5, 0.62, 0xffffff),            // flag, faces along the kerb
    box(0, 2.62, 0.33, 0.07, 0.5, 0.05, 0x2b2e31),         // flag edge
    box(0, 1.35, 0, 0.1, 0.55, 0.34, 0x50565c),            // timetable case
  ]);
}

// Glass shelter (abrigo), 3.6 m: dark frame, pale back glazing, advert panel at one end, flat roof.
export function shelterGeometry() {
  const L = 3.6, D = 1.35, H = 2.35, f = 0x34393e, g = 0xb9cbd2;
  return done([
    box(0, H, 0.6, L + 0.1, 0.1, D + 0.15, 0x41474d),         // roof
    box(0, H - 0.08, 0.6, L - 0.1, 0.04, D - 0.1, 0xd8e2e6),   // roof glazing underside
    ...[-L / 2, L / 2].map((x) => box(x, H / 2, D + 0.05, 0.08, H, 0.08, f)),
    ...[-L / 2, L / 2].map((x) => box(x, H / 2, 0.15, 0.06, H, 0.06, f)),
    box(0, 1.3, D + 0.05, L, 1.75, 0.03, g),                  // back glazing
    box(L / 2, 1.25, 0.6, 0.05, 1.75, 0.9, 0xe9e3d0),         // advert panel (lit at night by the emissive tint)
    box(0, 0.48, D - 0.18, L * 0.7, 0.05, 0.38, 0x6b6157),    // bench
    box(0, 0.24, D - 0.05, L * 0.7, 0.03, 0.03, f),
  ]);
}

// Metro entrance: stairwell framed by stone parapets with a steel rail, dark stairs going down, and the
// Metro de Lisboa totem (red M on white) at the head of the stairs. Local +x = down the stairs.
export function metroEntranceGeometry() {
  const L = 5.2, W = 2.2, stone = 0xcfc6b6, rail = 0x8c9399;
  const p = [
    box(0, 0.02, 0, L, 0.04, W, 0x1e2124),                  // stairwell (reads as an opening in the pavement)
    box(L / 2 + 0.12, 0.5, 0, 0.24, 1.0, W + 0.48, stone),  // parapet, far end
    box(0, 0.5, W / 2 + 0.12, L + 0.48, 1.0, 0.24, stone),  // side parapets
    box(0, 0.5, -W / 2 - 0.12, L + 0.48, 1.0, 0.24, stone),
    box(0, 1.08, W / 2 + 0.12, L + 0.48, 0.05, 0.08, rail), box(0, 1.08, -W / 2 - 0.12, L + 0.48, 0.05, 0.08, rail),
    box(L / 2 + 0.12, 1.08, 0, 0.08, 0.05, W + 0.48, rail),
  ];
  for (let i = 0; i < 7; i++) p.push(box(-L / 2 + 0.5 + i * 0.68, 0.045, 0, 0.08, 0.02, W - 0.1, 0x3a3e42));   // step nosings
  // totem: post + white panel with the red M on both faces
  const tx = -L / 2 - 0.5, tz = W / 2 + 0.55;
  p.push(cyl(tx, 1.5, tz, 0.07, 3.0, 0x3b3f44));
  p.push(box(tx, 3.15, tz, 0.16, 0.9, 0.9, 0xf4f1ea));
  for (const s of [1, -1]) {
    const x = tx + s * 0.085;
    p.push(box(x, 3.15, tz - 0.22, 0.02, 0.6, 0.12, 0xd22a1f), box(x, 3.15, tz + 0.22, 0.02, 0.6, 0.12, 0xd22a1f));
    p.push(paint(new THREE.BoxGeometry(0.02, 0.36, 0.1).rotateX(0.62).translate(x, 3.25, tz - 0.1), 0xd22a1f));
    p.push(paint(new THREE.BoxGeometry(0.02, 0.36, 0.1).rotateX(-0.62).translate(x, 3.25, tz + 0.1), 0xd22a1f));
  }
  return done(p);
}
