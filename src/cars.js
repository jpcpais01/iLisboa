// Shared car models (parked cars, ambient traffic, the drivable car). Long axis +x (nose), y up, origin on the ground
// under the centre. Paint is white in the vertex colours and takes the instance colour; lamps, tyres and glass keep theirs.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Lisbon's car paint mix (white and greys dominate), weights in %
export const carPalette = [[0xf2f2ef, 30], [0xb9bcbf, 18], [0x7d8185, 12], [0x2a2c30, 15], [0x2b3e5c, 8], [0x8e2b2b, 7], [0xd8cdb4, 4], [0x3f5a46, 3], [0x5d6f86, 3]];
const TOT = carPalette.reduce((a, p) => a + p[1], 0);
// h in [0,1) → a paint colour drawn from the mix
export const carPaint = (h) => { let x = h * TOT; for (const [c, w] of carPalette) { if ((x -= w) < 0) return c; } return carPalette[0][0]; };

// sel −1: the box car (far), +1: the modelled car (near); carU = { uCamP, uHiR } picks per instance by distance
export function carMaterial(sel, carU) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.15 });
  mat.onBeforeCompile = (s) => {
    s.uniforms.uCamP = carU.uCamP; s.uniforms.uHiR = carU.uHiR;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 uCamP;\nuniform float uHiR;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{ vec3 io = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz; if (${sel.toFixed(1)} * (uHiR - distance(io, uCamP)) < 0.0) transformed = vec3(0.0); }`)
      // lamps, tyres and glass keep their own colour; only the paint takes the instance colour
      .replace('#include <color_vertex>', '#include <color_vertex>\nif (abs(color.r - color.g) > 0.04 || abs(color.b - color.g) > 0.04 || color.g < 0.2) vColor = color.rgb;');
  };
  mat.customProgramCacheKey = () => `car-v1-${sel}`;
  return mat;
}
export function carGeometries(carU) {
  const tint = (g, r, gg = r, b = r) => { g = g.index ? g.toNonIndexed() : g; g.deleteAttribute('uv'); g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, () => [r, gg, b]).flat(), 3)); return g; };
  const lo = mergeGeometries([
    tint(new THREE.BoxGeometry(4.3, 0.78, 1.78).translate(0, 0.56, 0), 1),
    tint(new THREE.BoxGeometry(2.25, 0.56, 1.6).translate(-0.25, 1.22, 0), 0.13),
    tint(new THREE.BoxGeometry(1.95, 0.07, 1.52).translate(-0.3, 1.52, 0), 1),
  ]);
  const prof = (pts, depth, bevel) => { const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))); const g = new THREE.ExtrudeGeometry(sh, { depth: depth - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 2 }); g.translate(0, 0, -(depth - 2 * bevel) / 2); return g; };
  // lower body to the belt line, with wheel arches suggested by the sill
  const body = prof([[-2.08, 0.32], [2.06, 0.32], [2.12, 0.52], [2.06, 0.78], [1.25, 0.92], [-1.7, 0.98], [-2.06, 0.92], [-2.12, 0.62]], 1.78, 0.07);
  const glass = prof([[-1.62, 0.96], [1.2, 0.94], [0.42, 1.38], [-1.38, 1.42], [-1.62, 1.16]], 1.6, 0.05);
  const roof = prof([[-1.42, 1.38], [0.45, 1.36], [0.36, 1.46], [-1.3, 1.48]], 1.52, 0.03);
  const parts = [tint(body, 1), tint(glass, 0.1, 0.12, 0.15), tint(roof, 1)];
  for (const x of [-1.32, 1.3]) for (const z of [-0.8, 0.8]) {
    parts.push(tint(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 12).rotateX(Math.PI / 2).translate(x, 0.33, z), 0.06, 0.06, 0.065));
    parts.push(tint(new THREE.CylinderGeometry(0.19, 0.19, 0.24, 8).rotateX(Math.PI / 2).translate(x, 0.33, z), 0.55, 0.55, 0.62));
  }
  for (const z of [-0.6, 0.6]) {
    parts.push(tint(new THREE.BoxGeometry(0.06, 0.12, 0.32).translate(2.11, 0.68, z), 0.95, 0.95, 1.0));   // headlamps
    parts.push(tint(new THREE.BoxGeometry(0.06, 0.14, 0.3).translate(-2.13, 0.76, z), 0.75, 0.06, 0.05));  // tail lamps
  }
  parts.push(tint(new THREE.BoxGeometry(0.05, 0.16, 0.5).translate(-2.14, 0.52, 0), 0.92, 0.9, 0.62));     // number plate
  parts.push(tint(new THREE.BoxGeometry(0.05, 0.12, 0.5).translate(2.13, 0.42, 0), 0.92, 0.92, 1.0));
  for (const z of [-0.92, 0.92]) parts.push(tint(new THREE.BoxGeometry(0.12, 0.08, 0.16).translate(0.55, 1.0, z), 0.12, 0.12, 0.13));   // mirrors
  const hi = mergeGeometries(parts.map((g) => { if (!g.attributes.normal) g.computeVertexNormals(); return g; }));
  return { lo, hi, mLo: carMaterial(-1, carU), mHi: carMaterial(1, carU) };
}
