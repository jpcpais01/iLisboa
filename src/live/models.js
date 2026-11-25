// Low-poly vehicles for the live layers. Each is one merged, vertex-coloured geometry, drawn instanced
// (one draw call per kind). Long axis is +x (forward), y up, origin at the ground under the centre.
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
const wheel = (x, z, r, hex = 0x1d1d20) => paint(new THREE.CylinderGeometry(r, r, 0.3, 8).rotateX(Math.PI / 2).translate(x, r, z), hex);
const done = (parts) => { const g = mergeGeometries(parts); g.computeBoundingSphere(); return g; };

// city bus, 12 m: body in the instance colour (white vertex colour × instance tint), dark glazing band, roof pod
export function busGeometry() {
  const L = 12, W = 2.55, glass = 0x1f2a33;
  const p = [
    box(0, 0.95, 0, L, 1.3, W, 0xffffff),                      // lower body
    box(0, 2.25, 0, L - 0.2, 1.3, W - 0.06, glass),            // glazing band, inset a hair
    box(0, 2.25, 0, L - 1.4, 1.32, W + 0.02, glass),           // side windows proud of the band
    box(0.4, 2.98, 0, L - 0.9, 0.18, W, 0xffffff),             // roof
    box(-0.8, 3.2, 0, 4.2, 0.32, W - 0.5, 0xe9e9e9),           // air-con pod
    box(L / 2 - 0.02, 2.35, 0, 0.08, 1.05, W - 0.3, 0x0e1418),  // windscreen
    box(L / 2 + 0.01, 0.8, 0.85, 0.05, 0.18, 0.4, 0xfff4d6), box(L / 2 + 0.01, 0.8, -0.85, 0.05, 0.18, 0.4, 0xfff4d6),  // lamps
    box(L / 2 + 0.01, 2.95, 0, 0.05, 0.22, 1.4, 0xffa21a),     // route display
    box(-L / 2 - 0.01, 0.95, 0.9, 0.05, 0.25, 0.3, 0xb3201c), box(-L / 2 - 0.01, 0.95, -0.9, 0.05, 0.25, 0.3, 0xb3201c),
  ];
  for (const x of [3.6, -2.6]) for (const z of [W / 2 - 0.12, -W / 2 + 0.12]) p.push(wheel(x, z, 0.5));
  return done(p);
}

// Lisbon "remodelado" tram, 8.4 m: two-tone (instance yellow lower, cream upper), clerestory roof, trolley pole
export function tramGeometry() {
  const L = 8.4, W = 2.3, glass = 0x26313a;
  const p = [
    box(0, 0.85, 0, L, 1.1, W, 0xffffff),                      // yellow (tinted) lower body
    box(0, 0.32, 0, L - 1.6, 0.3, W - 0.4, 0x2a2622),          // truck
    box(0, 1.95, 0, L - 0.3, 1.1, W - 0.08, glass),            // windows
    box(0, 1.95, 0, 0.12, 1.1, W, 0xffffff), box(2.2, 1.95, 0, 0.12, 1.1, W, 0xffffff), box(-2.2, 1.95, 0, 0.12, 1.1, W, 0xffffff),   // pillars
    box(0, 2.62, 0, L - 0.1, 0.24, W, 0xf3ecd8),               // cream cant rail
    box(0, 2.86, 0, L - 0.8, 0.26, W - 0.7, 0xf3ecd8),         // clerestory
    paint(new THREE.CylinderGeometry(0.025, 0.025, 4.2, 4).rotateZ(1.2).translate(-0.9, 3.85, 0), 0x222222),   // trolley pole
    box(L / 2 + 0.01, 1.0, 0, 0.05, 0.22, 0.32, 0xfff4d6),
    box(L / 2 + 0.01, 2.55, 0, 0.05, 0.2, 1.0, 0x111111),      // route box
  ];
  return done(p);
}

// Metro de Lisboa six-car set, ~105 m, drawn as one glowing capsule chain (it runs underground: the map shows it x-ray)
export function metroGeometry() {
  const p = [];
  for (let c = 0; c < 6; c++) {
    const x = -52.5 + 8.75 + c * 17.5;
    p.push(paint(new THREE.CapsuleGeometry(1.5, 14.2, 2, 8).rotateZ(Math.PI / 2).translate(x, 1.6, 0), 0xffffff));
  }
  return done(p);
}

// airliner (A320-ish proportions, 38 m): fuselage, swept wings, tailplane, fin, engines
export function planeGeometry() {
  const p = [];
  const fus = new THREE.CylinderGeometry(1.95, 1.95, 30, 10, 1).rotateZ(Math.PI / 2);
  p.push(paint(fus, 0xffffff));
  p.push(paint(new THREE.SphereGeometry(1.95, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 2.2, 1).rotateZ(-Math.PI / 2).translate(15, 0, 0), 0xffffff));   // nose
  p.push(paint(new THREE.ConeGeometry(1.95, 7, 10).rotateZ(Math.PI / 2).scale(1, 1, 1).translate(-18.5, 0.6, 0), 0xffffff));   // tail cone
  p.push(paint(new THREE.CylinderGeometry(0.06, 0.06, 26, 3).rotateZ(Math.PI / 2).translate(0, 0.95, 1.9), 0x2b3440));   // window lines
  p.push(paint(new THREE.CylinderGeometry(0.06, 0.06, 26, 3).rotateZ(Math.PI / 2).translate(0, 0.95, -1.9), 0x2b3440));
  // swept wing: a flat prism, root chord 7 m, tip 2 m, span 34 m
  const wing = (sgn, span, root, tip, sweep, y, x0, hex, dihedral = 0.08) => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(-sweep, span); s.lineTo(-sweep - tip, span); s.lineTo(-root, 0); s.lineTo(0, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.35, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -0.17, 0);
    if (sgn < 0) g.scale(1, 1, -1);
    g.rotateX(sgn * -dihedral).translate(x0, y, 0);
    return paint(g, hex);
  };
  p.push(wing(1, 17, 7, 1.8, 6, -0.9, 3.5, 0xd9dde2), wing(-1, 17, 7, 1.8, 6, -0.9, 3.5, 0xd9dde2));
  p.push(wing(1, 6.2, 3.6, 1.4, 3, 0.9, -15.6, 0xd9dde2, 0.02), wing(-1, 6.2, 3.6, 1.4, 3, 0.9, -15.6, 0xd9dde2, 0.02));
  { // fin
    const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(-4.6, 6.4); s.lineTo(-6.6, 6.4); s.lineTo(-6.4, 0); s.lineTo(0, 0);
    p.push(paint(new THREE.ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: false }).translate(-14.2, 1.4, -0.15), 0xffffff));
  }
  for (const z of [5.7, -5.7]) p.push(paint(new THREE.CylinderGeometry(0.95, 0.85, 4.2, 8).rotateZ(Math.PI / 2).translate(3.2, -1.9, z), 0xc9ced4));
  return done(p);
}
