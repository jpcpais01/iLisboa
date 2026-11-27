// Landmark detail layer (pipeline/landmarks3d.mjs → public/lm): stone window surrounds, cornices, balconies, ridge and eave
// tiles for every clickable landmark, loaded with a tile's façade relief (near the camera only); and the restyle table that
// turns palaces the generic rules drew as houses into palaces (window grid and, where known, real colours), applied to a
// tile's building mesh as it arrives.
import * as THREE from 'three';

let index = null, cells = null;
const GC = 100;
export const lmReady = fetch('/lm/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d) return null;
  cells = new Map();
  const lin = (hex) => { if (!hex) return null; const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };   // three's Color(hex) is sRGB → linear
  d.restyle = d.restyle.map((it) => {
    const [key, variant, wall, roof, cx, cy] = it, ring = new Float32Array(it.length - 6);
    for (let k = 6; k < it.length; k += 2) { ring[k - 6] = cx + it[k] / 2; ring[k - 5] = cy + it[k + 1] / 2; }
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < ring.length; k += 2) { bb[0] = Math.min(bb[0], ring[k]); bb[1] = Math.min(bb[1], ring[k + 1]); bb[2] = Math.max(bb[2], ring[k]); bb[3] = Math.max(bb[3], ring[k + 1]); }
    const r = { key, variant, wall: lin(wall), roof: lin(roof), ring, bb };
    for (let i = Math.floor(bb[0] / GC); i <= Math.floor(bb[2] / GC); i++) for (let j = Math.floor(bb[1] / GC); j <= Math.floor(bb[3] / GC); j++) { const c = i * 100003 + j; (cells.get(c) || cells.set(c, []).get(c)).push(r); }
    return r;
  });
  index = d;
  return d;
}).catch(() => null);

export const lmFile = (area, i, j) => { const f = index && index.tiles[`${area}:${i}_${j}`]; return f ? `/lm/${area}/${f}?v=${index.v}` : null; };

function inRing(r, x, y) { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }

// restyle a freshly adopted building mesh (attributes renamed: aStyle, color). Vertices are shared only within a triangle's
// own face, so recolouring per triangle is safe.
const _v = new THREE.Vector3();
export function restyle(mesh) {
  if (!index || !index.restyle.length || mesh.userData.lmStyled) return;
  mesh.userData.lmStyled = true;
  const g = mesh.geometry, N = g.attributes.normal, P = g.attributes.position, S = g.attributes.aStyle, C = g.attributes.color, G = g.attributes.aGene, I = g.index;
  if (!S || !C) return;
  if (!g.boundingBox) g.computeBoundingBox();
  mesh.updateWorldMatrix(true, false);
  const bb = g.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  const list = new Set();
  for (let i = Math.floor(bb.min.x / GC); i <= Math.floor(bb.max.x / GC); i++) for (let j = Math.floor(-bb.max.z / GC); j <= Math.floor(-bb.min.z / GC); j++) for (const r of cells.get(i * 100003 + j) || []) list.add(r);
  if (!list.size) return;
  const rs = [...list], M = mesh.matrixWorld, n = I ? I.count : P.count, done = new Uint8Array(P.count);
  let touched = 0;
  for (let t = 0; t < n; t += 3) {
    const a = I ? I.getX(t) : t, b = I ? I.getX(t + 1) : t + 1, c = I ? I.getX(t + 2) : t + 2;
    let x = 0, y = 0;
    for (const q of [a, b, c]) { _v.fromBufferAttribute(P, q).applyMatrix4(M); x += _v.x / 3; y -= _v.z / 3; }
    if (N) { x -= N.getX(a) * 0.5; y += N.getZ(a) * 0.5; }   // walls stand on the outline: test half a metre inside
    let hit = null;
    for (const r of rs) if (x >= r.bb[0] && x <= r.bb[2] && y >= r.bb[1] && y <= r.bb[3] && inRing(r.ring, x, y)) { hit = r; break; }
    if (!hit) continue;
    for (const q of [a, b, c]) {
      if (done[q]) continue; done[q] = 1;
      const kind = Math.round(S.getX(q) * 8), variant = Math.round(S.getY(q) * 8);
      if (kind === 1 || kind === 2 || (kind === 6 && hit.variant === -2)) {
        if (hit.variant >= 0 && (variant === 1 || variant === 2)) { S.setY(q, hit.variant / 8); if (G) G.setX(q, 0); }   // a landmark's own front, not the street's genome
        if (hit.wall) C.setXYZ(q, hit.wall[0], hit.wall[1], hit.wall[2]);
      } else if ((kind === 3 || kind === 5 || (kind === 4 && hit.variant === -2)) && hit.roof) C.setXYZ(q, hit.roof[0], hit.roof[1], hit.roof[2]);
      touched++;
    }
  }
  if (touched) { S.needsUpdate = true; C.needsUpdate = true; if (G) G.needsUpdate = true; }
}
