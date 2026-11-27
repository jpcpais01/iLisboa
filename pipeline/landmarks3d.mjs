// Landmark detail layer: every clickable landmark (public/landmarks.json) gets real architecture on top of the city tiles,
// streamed only near the camera, with no tile rebuild.
//
// It reads what the tiles already draw for each landmark (walls with their window grid, roofs, flat decks: the massing the
// survey and the detail pass measured) and adds what a building of its kind has in stone and tile:
//   · façades of palaces, convents, museums, theatres…: lioz window surrounds and sills exactly round the painted windows (the
//     grid is read back from the same per-vertex attributes the shader draws them from), hoods over the noble floor,
//     socle, string course, moulded cornice and corner quoins;
//   · tiled roofs: half-round ridge and hip tiles, the double row of eave tiles (beirado) and its shadow line;
//   · flat palace roofs: a balustrade along the edge;
//   · towers (from the 2024 LiDAR read in the tiles' own geometry: a small high deck above the main roof): belfry arches,
//     cornice and a cap.
// It also restyles landmarks the generic rules drew as ordinary houses: a palace drawn with vernacular windows gets the
// palatial window grid (and, where we know it, its real wall and roof colours, see LOOKS).
//
// Output: public/lm/index.json { v, restyle: [[key, variant, wallHex|0, roofHex|0, cx, cy, ring...]...], tiles: { 'area:i_j': file } }
//         public/lm/<area>/l_<i>_<j>.glb   (one mesh 'detail': position, normal, colour; plain stonework material)
// Run after any tile rebuild: node pipeline/landmarks3d.mjs   (~1 min, no network)
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const L = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/landmarks.json'), 'utf8'));
const IDX = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/tiles/index.json'), 'utf8'));
const OUT = path.join(ROOT, 'public/lm');
const ONLY = process.env.LM_ONLY ? new Set(process.env.LM_ONLY.split(',')) : null;   // areas, for quick checks
const log = (...a) => console.log(...a);
const srgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lin = (c) => c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
const LIN = (hex) => lin(srgb(hex));

// ─── what each landmark is ─────────────────────────────────────────────────
// Palatial: houses of state, the Church and learning. Drawn by the generic rules they read as ordinary blocks.
const PALATIAL = /^(castle|manor|palace|government|townhall|courthouse|museum|library|theatre|monastery|university|college|ministry|arts_centre|gallery|community_centre|fort|hospital|public|civic|school|train_station|building|)$/;
// Real colours we are sure of (lioz stone, whitewash, the palace pinks and ochres), by Wikidata id. Roof hex for tiled roofs.
const LOOKS = {
  Q1478288: { wall: '#e9e3d6', roof: '#9d5a46' },          // Palácio Nacional da Ajuda: pale lioz neoclassical block
  Q1776168: { wall: '#efebe2' },                            // São Vicente de Fora: white mannerist monastery
  Q11336481: { wall: '#d99a8f' },                           // Necessidades: the pink palace
  Q1144592: { wall: '#e3a596' },                            // Belém palace: pink
  Q1464499: { wall: '#ece7dc' },                            // São Bento: white
  Q1161724: { wall: '#ece4d4' },                            // Fronteira
  Q5519418: { wall: '#ede6d8' },                            // Galveias: white with lioz
  Q7126269: { wall: '#e8dcc0' },                            // Palácio Palmela
  Q17117463: { wall: '#eeeae1' },                           // Convento da Graça: whitewashed
  Q211262: null,                                            // Gulbenkian: modern, leave
};

// ─── geometry sink (position, normal, linear colour) ─────────────────────
const sink = () => ({ pos: [], nrm: [], col: [] });
function tri(S, a, b, c, col) {   // world coords [x, y(up), z]; normal from winding
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]; const l = Math.hypot(...n); if (l < 1e-9) return; n = n.map((v) => v / l);
  S.pos.push(...a, ...b, ...c); for (let k = 0; k < 3; k++) { S.nrm.push(...n); S.col.push(...col); }
}
const quad = (S, a, b, c, d, col) => { tri(S, a, b, c, col); tri(S, a, c, d, col); };
// box in a wall frame: origin o (2D plan), along t (unit 2D), out n (unit 2D), u0..u1 along, d0..d1 out, z0..z1 up
function wbox(S, o, t, n, u0, u1, d0, d1, z0, z1, col, { bottom = false } = {}) {
  const P = (u, d, z) => [o[0] + t[0] * u + n[0] * d, z, -(o[1] + t[1] * u + n[1] * d)];
  const dark = col.map((v) => v * 0.78);
  quad(S, P(u0, d1, z0), P(u1, d1, z0), P(u1, d1, z1), P(u0, d1, z1), col);       // front
  quad(S, P(u0, d0, z1), P(u0, d1, z1), P(u1, d1, z1), P(u1, d0, z1), col);       // top
  quad(S, P(u0, d0, z0), P(u0, d1, z0), P(u0, d1, z1), P(u0, d0, z1), col);       // ends
  quad(S, P(u1, d1, z0), P(u1, d0, z0), P(u1, d0, z1), P(u1, d1, z1), col);
  if (bottom) quad(S, P(u0, d0, z0), P(u1, d0, z0), P(u1, d1, z0), P(u0, d1, z0), dark);
}
// faces of a box point away from its centre, whatever the handedness of its frame
function wboxF(S, o, t, n, u0, u1, d0, d1, z0, z1, col, opt) {
  const s0 = S.pos.length; wbox(S, o, t, n, u0, u1, d0, d1, z0, z1, col, opt);
  const um = (u0 + u1) / 2, dm = (d0 + d1) / 2, C = [o[0] + t[0] * um + n[0] * dm, (z0 + z1) / 2, -(o[1] + t[1] * um + n[1] * dm)];
  orient(S, s0, C);
}
function orient(S, s0, C) {
  for (let k = s0; k < S.pos.length; k += 9) {
    const q = k / 3, c = [0, 1, 2].map((d) => (S.pos[k + d] + S.pos[k + 3 + d] + S.pos[k + 6 + d]) / 3 - C[d]);
    if (S.nrm[q * 3] * c[0] + S.nrm[q * 3 + 1] * c[1] + S.nrm[q * 3 + 2] * c[2] >= 0) continue;
    for (let d = 0; d < 3; d++) { const t0 = S.pos[k + 3 + d]; S.pos[k + 3 + d] = S.pos[k + 6 + d]; S.pos[k + 6 + d] = t0; }
    for (let v = q; v < q + 3; v++) for (let d = 0; d < 3; d++) S.nrm[v * 3 + d] *= -1;
  }
}

// ─── read a tile's building mesh back ────────────────────────────────────
async function readTile(file) {
  const doc = await io.read(file);
  const node = doc.getRoot().listNodes().find((q) => q.getName() === 'buildings'); if (!node) return null;
  const pr = node.getMesh().listPrimitives()[0], M = node.getMatrix();
  const A = (s) => pr.getAttribute(s), I = pr.getIndices();
  const P = A('POSITION'), NN = A('NORMAL'), C = A('COLOR_0'), U = A('TEXCOORD_0'), IN = A('_INFO'), ST = A('_STYLE');
  const n = P.getCount(), nrm = new Float32Array(n * 3), pos = new Float32Array(n * 3), col = new Float32Array(n * 3), surf = new Float32Array(n * 2), info = new Float32Array(n * 4), style = new Float32Array(n * 4);
  const v = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    P.getElement(i, v); pos[i * 3] = M[0] * v[0] + M[12]; pos[i * 3 + 1] = M[5] * v[1] + M[13]; pos[i * 3 + 2] = M[10] * v[2] + M[14];
    NN.getElement(i, v); nrm.set(v.slice(0, 3), i * 3);
    C.getElement(i, v); col.set(v.slice(0, 3), i * 3);
    U.getElement(i, v); surf[i * 2] = (v[0] - 0.5) * 512; surf[i * 2 + 1] = (v[1] - 0.5) * 512;
    IN.getElement(i, v); info.set([v[0] * 128, v[1] * 8, v[2] * 128, v[3] * 8], i * 4);
    ST.getElement(i, v); style.set([v[0] * 8, v[1] * 8, v[2], v[3] * 6], i * 4);
  }
  return { pos, nrm, col, surf, info, style, idx: I.getArray() };
}

// ─── landmark groups ─────────────────────────────────────────────────────
const groups = new Map();
for (const it of L.items) {
  const [id, name, , wd, wp, kind, cx, cy] = it, ring = [];
  for (let k = 8; k < it.length; k += 2) ring.push([cx + it[k] / 2, cy + it[k + 1] / 2]);
  const key = wd || wp || id;
  let g = groups.get(key);
  if (!g) { g = { key, name, kind, parts: [], bb: [Infinity, Infinity, -Infinity, -Infinity], tris: 0, wallV: {}, auth: 0 }; groups.set(key, g); }
  const bb = ring.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  g.parts.push({ ring, bb, area: Math.abs(ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2) });
  for (let k = 0; k < 4; k++) g.bb[k] = k < 2 ? Math.min(g.bb[k], bb[k]) : Math.max(g.bb[k], bb[k]);
}
const pip = (x, y, R) => { let c = false; for (let i = 0, j = R.length - 1; i < R.length; j = i++) { const [xi, yi] = R[i], [xj, yj] = R[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const GC = 100, grid = new Map();
for (const g of groups.values()) for (const p of g.parts) {
  p.g = g;
  for (let i = Math.floor(p.bb[0] / GC); i <= Math.floor(p.bb[2] / GC); i++) for (let j = Math.floor(p.bb[1] / GC); j <= Math.floor(p.bb[3] / GC); j++) { const k = `${i},${j}`; (grid.get(k) || grid.set(k, []).get(k)).push(p); }
}
const groupAt = (x, y) => { let best = null; for (const p of grid.get(`${Math.floor(x / GC)},${Math.floor(y / GC)}`) || []) { if (x < p.bb[0] || x > p.bb[2] || y < p.bb[1] || y > p.bb[3] || !pip(x, y, p.ring)) continue; if (!best || p.area < best.area) best = p; } return best && best.g; };

// ─── pass 1: what the tiles draw for each landmark ──────────────────────
const tileList = [];
for (const A of IDX.areas) { if (ONLY && !ONLY.has(A.area)) continue; for (const t of A.tiles) tileList.push({ A, t }); }
const cache = new Map();
const relevant = (t) => { const [x0, y0, x1, y1] = t.bounds; for (let i = Math.floor(x0 / GC); i <= Math.floor(x1 / GC); i++) for (let j = Math.floor(y0 / GC); j <= Math.floor(y1 / GC); j++) if (grid.has(`${i},${j}`)) return true; return false; };
const triGroups = new Map();   // tile key → Int32Array group index per triangle (−1 none)
const gIndex = [...groups.values()];
gIndex.forEach((g, i) => (g.i = i));
for (const { A, t } of tileList) {
  if (!relevant(t)) continue;
  const T = await readTile(path.join(ROOT, 'public/tiles', A.area, t.file)); if (!T) continue;
  const nT = T.idx.length / 3, tg = new Int32Array(nT).fill(-1);
  for (let k = 0; k < nT; k++) {
    const a = T.idx[k * 3], b = T.idx[k * 3 + 1], c = T.idx[k * 3 + 2];
    // walls stand on the outline itself: test a point half a metre inside (against the wall's normal)
    const x = (T.pos[a * 3] + T.pos[b * 3] + T.pos[c * 3]) / 3 - T.nrm[a * 3] * 0.5, y = -(T.pos[a * 3 + 2] + T.pos[b * 3 + 2] + T.pos[c * 3 + 2]) / 3 + T.nrm[a * 3 + 2] * 0.5;
    const g = groupAt(x, y); if (!g) continue;
    tg[k] = g.i; g.tris++;
    const kind = Math.round(T.style[a * 4]), variant = Math.round(T.style[a * 4 + 1]);
    if (kind === 6 || (kind === 0 && variant === 5)) g.auth++;
    if (kind === 1 || kind === 2) g.wallV[variant] = (g.wallV[variant] || 0) + 1;
  }
  const key = `${A.area}:${t.i}_${t.j}`; cache.set(key, T); triGroups.set(key, tg);
}
// decide per group: restyle (vernacular → palatial), colours, whether to add façade stonework
let nRestyle = 0;
for (const g of gIndex) {
  if (!g.tris) continue;
  const wv = Object.entries(g.wallV).sort((a, b) => b[1] - a[1]), dom = wv.length ? +wv[0][0] : -1;
  g.authored = g.auth / g.tris > 0.4;
  g.look = LOOKS[g.key] === null ? null : LOOKS[g.key] || null;
  g.palatial = !g.authored && PALATIAL.test(g.kind || '') && LOOKS[g.key] !== null;
  g.restyle = g.palatial && (dom === 1 || dom === 2) ? 4 : -1;   // vernacular / azulejo houses → palatial window grid
  g.formal = g.restyle === 4 || (!g.authored && (dom === 4 || dom === 0) && LOOKS[g.key] !== null);
  if (g.restyle >= 0 || g.look) nRestyle++;
}
if (process.env.LM_DBG) for (const g of gIndex) if (process.env.LM_DBG.split(',').includes(g.key)) log(g.name, g.kind, JSON.stringify(g.wallV), 'auth', g.auth, '/', g.tris, 'restyle', g.restyle, 'formal', g.formal);
log(`landmarks in tiles: ${gIndex.filter((g) => g.tris).length}, authored ${gIndex.filter((g) => g.authored).length}, restyled ${nRestyle}, formal façades ${gIndex.filter((g) => g.formal).length}`);

// ─── pass 2: stonework per tile ──────────────────────────────────────────
const LIOZ = LIN('#d9d0bd'), LIOZ_D = LIN('#c4baa5'), IRON = LIN('#2b302e');
const out = { v: Date.now().toString(36), restyle: [], tiles: {} };
fs.mkdirSync(OUT, { recursive: true });
const written = new Set();
const stats = { walls: 0, windows: 0, ridges: 0, eaves: 0, bal: 0, tris: 0, bytes: 0 };
const K5 = (v) => Math.round(v * 20);   // 5 cm vertex key

for (const [key, T] of cache) {
  const tg = triGroups.get(key), S = sink(), nT = T.idx.length / 3;
  const V = (i) => [T.pos[i * 3], T.pos[i * 3 + 1], T.pos[i * 3 + 2]];
  // ── walls: façade triangles grouped into wall quads by their plan segment ──
  const walls = new Map();
  for (let k = 0; k < nT; k++) {
    const gi = tg[k]; if (gi < 0) continue; const g = gIndex[gi]; if (!g.formal) continue;
    const ids = [T.idx[k * 3], T.idx[k * 3 + 1], T.idx[k * 3 + 2]], a = ids[0];
    const kind = Math.round(T.style[a * 4]); if (kind !== 1) continue;
    const variant = g.restyle >= 0 ? g.restyle : Math.round(T.style[a * 4 + 1]); if (variant !== 4 && variant !== 0) continue;
    // plan segment: the two distinct (x, z) of the triangle
    const P = ids.map(V), pts = [];
    for (const p of P) if (!pts.some((q) => Math.hypot(q[0] - p[0], q[2] - p[2]) < 0.05)) pts.push(p);
    if (pts.length !== 2) continue;
    let [p, q] = pts;
    // orient so the wall's outward normal is to the right of p→q in plan (x east, y north = −z)
    const nx = T.nrm[a * 3], nz = T.nrm[a * 3 + 2];   // the wall's own normal: plan (nx, −nz)
    const tx = q[0] - p[0], ty = -(q[2] - p[2]);
    if (ty * nx + tx * nz < 0) [p, q] = [q, p];   // right of (tx, ty) is (ty, −tx)
    const wk = `${K5(p[0])},${K5(p[2])},${K5(q[0])},${K5(q[2])}`;
    let w = walls.get(wk);
    if (!w) { w = { p: [p[0], -p[2]], q: [q[0], -q[2]], g, variant, lo: Infinity, hi: -Infinity, ground: Infinity, sx: [], ids: [] }; walls.set(wk, w); }
    for (const i of ids) {
      const y = T.pos[i * 3 + 1], sy = T.surf[i * 2 + 1];
      w.lo = Math.min(w.lo, y); w.hi = Math.max(w.hi, y); w.ground = Math.min(w.ground, y - sy);
      const atP = Math.hypot(T.pos[i * 3] - p[0], T.pos[i * 3 + 2] - p[2]) < 0.05;
      w.sx.push([atP ? 0 : 1, T.surf[i * 2]]);
      w.ids.push(i);
    }
  }
  for (const w of walls.values()) {
    const i0 = w.ids[0], top = T.info[i0 * 4], fh = Math.max(T.info[i0 * 4 + 1], 2.4), bays = Math.round(T.info[i0 * 4 + 2]), gh = Math.max(T.info[i0 * 4 + 3], 2.6);
    const bw = Math.max(T.style[i0 * 4 + 3], 0.5);
    const sxP = w.sx.find((s) => s[0] === 0)?.[1], sxQ = w.sx.find((s) => s[0] === 1)?.[1];
    const Lw = Math.hypot(w.q[0] - w.p[0], w.q[1] - w.p[1]);
    const DBGW = process.env.LM_DBG && process.env.LM_DBG.split(',').includes(w.g.key);
    if (DBGW) log('wall', w.g.name, Lw.toFixed(1), 'sx', sxP?.toFixed(2), sxQ?.toFixed(2), 'z', w.lo.toFixed(1), w.hi.toFixed(1), 'g', w.ground.toFixed(1), 'info', top.toFixed(1), fh.toFixed(2), bays, gh.toFixed(2), 'bw', bw.toFixed(2), 'n', w.ids.length);
    if (Lw < 2 || sxP == null || sxQ == null || w.hi - w.lo < 3) continue;
    const t = [(w.q[0] - w.p[0]) / Lw, (w.q[1] - w.p[1]) / Lw], n = [t[1], -t[0]];
    const g0 = w.ground, zTop = g0 + top, zLo = w.lo, zHi = Math.min(w.hi, zTop);
    stats.walls++;
    const restyled = w.g.restyle >= 0;
    const trim = LIOZ;
    // wall-scale stonework where the tile has none of its own (restyled walls: the tile's relief was built for a house)
    if (restyled) {
      wboxF(S, w.p, t, n, -0.08, Lw + 0.08, 0, 0.09, zLo - 0.2, Math.max(zLo + 0.3, g0 + 0.9), LIOZ_D);              // socle
      if (zHi - g0 > gh + 1.5) wboxF(S, w.p, t, n, -0.06, Lw + 0.06, 0, 0.11, g0 + gh - 0.22, g0 + gh, trim, { bottom: true });   // string course
      if (zHi >= zTop - 0.3) {   // cornice under the eave
        wboxF(S, w.p, t, n, -0.2, Lw + 0.2, 0, 0.28, zTop - 0.32, zTop - 0.04, trim, { bottom: true });
        wboxF(S, w.p, t, n, -0.12, Lw + 0.12, 0, 0.14, zTop - 0.62, zTop - 0.32, trim, { bottom: true });
      }
      if (Lw > 5) { wboxF(S, w.p, t, n, 0, 0.6, 0, 0.08, g0 + 0.9, Math.min(zHi, zTop) - 0.62, trim); wboxF(S, w.p, t, n, Lw - 0.6, Lw, 0, 0.08, g0 + 0.9, Math.min(zHi, zTop) - 0.62, trim); }
    }
    // window surrounds, exactly round the shader's windows (palatial / Pombaline grids)
    const bayLen = Lw / Math.max(1, Math.abs(sxQ - sxP)), dir = Math.sign(sxQ - sxP) || 1;
    const s0 = Math.min(sxP, sxQ), s1 = Math.max(sxP, sxQ);
    const nFloors = Math.floor((top - gh) / fh + 1e-3);
    for (let bi = Math.ceil(s0 - 0.5 - 1e-3); bi + 0.5 <= s1 + 1e-3; bi++) {
      const bx = bi + 0.5; if (bx < 0 || bx > bays) continue;
      const u = ((bx - sxP) / (sxQ - sxP)) * Lw; if (u < 0.6 || u > Lw - 0.6) continue;
      const sc = bayLen / bw;   // shader metres → wall metres along the façade
      for (let fi = 0; fi <= nFloors; fi++) {
        const isG = fi === 0, flH = isG ? gh : fh, base = isG ? g0 : g0 + gh + (fi - 1) * fh;
        let ww, y0, y1;
        if (w.variant === 4) {
          ww = Math.min(1.45, bw * 0.45); y0 = isG ? 0.45 : fi < 1.5 ? 0.08 : flH * 0.26; y1 = flH * (isG ? 0.72 : 0.84);
          if (isG) { ww = Math.min(1.3, bw * 0.5); y0 = 0; y1 = Math.min(2.5, flH * 0.86); }
        } else {   // Pombaline: upper floors (ground floor are shops), first floor balcony doors
          if (isG) continue;
          ww = Math.min(1.2, bw * 0.44); y0 = fi === 1 ? 0.06 : -1; y1 = flH * 0.86;
          if (y0 < 0) continue;   // upper windows' sills vary per window in the shader (hashed): leave those painted
        }
        const za = base + y0, zb = base + y1; if (zb > zTop - 0.5 || za < zLo - 0.1 || zb > zHi + 0.05) continue;
        const hw = (ww / 2) * sc, f = 0.2, d = 0.13;
        // jambs and head (architrave), sill
        wboxF(S, w.p, t, n, u - hw - f, u - hw, 0, d, za, zb + f, trim);
        wboxF(S, w.p, t, n, u + hw, u + hw + f, 0, d, za, zb + f, trim);
        wboxF(S, w.p, t, n, u - hw, u + hw, 0, d, zb, zb + f, trim, { bottom: true });
        if (y0 > 0.3) wboxF(S, w.p, t, n, u - hw - f - 0.06, u + hw + f + 0.06, 0, 0.14, za - 0.12, za, trim);
        // noble floor: a cornice hood; the centre bay of a long front: a pediment
        if (w.variant === 4 && fi === 1) {
          wboxF(S, w.p, t, n, u - hw - f - 0.12, u + hw + f + 0.12, 0, 0.2, zb + f + 0.05, zb + f + 0.2, trim, { bottom: true });
          if (bays >= 5 && Math.abs(bx - bays / 2) < 0.6) {
            const P = (uu, dd, z) => [w.p[0] + t[0] * uu + n[0] * dd, z, -(w.p[1] + t[1] * uu + n[1] * dd)];
            const zp = zb + f + 0.2, hp = 0.55, ua = u - hw - f - 0.12, ub = u + hw + f + 0.12;
            tri(S, P(ua, 0.2, zp), P(ub, 0.2, zp), P(u, 0.2, zp + hp), trim);
            const ang = trim.map((v) => v * 0.9);
            quad(S, P(ua, 0, zp), P(ua, 0.2, zp), P(u, 0.2, zp + hp), P(u, 0, zp + hp), ang);
            quad(S, P(u, 0, zp + hp), P(u, 0.2, zp + hp), P(ub, 0.2, zp), P(ub, 0, zp), ang);
            fixLast(S, 6, n);
          }
          // a wrought-iron balcony on the noble floor's doors (palatial y0 .08: door-height windows)
          // janela de sacada: a shallow stone ledge and a wrought-iron rail across the door-height window
          wboxF(S, w.p, t, n, u - hw - 0.22, u + hw + 0.22, 0, 0.3, za - 0.14, za, LIOZ_D, { bottom: true });
          railing(S, w.p, t, n, u - hw - 0.16, u + hw + 0.16, 0.26, za, za + 0.95);
        }
        stats.windows++;
        if (DBGW && stats.windows % 7 === 0) { const cx = w.p[0] + t[0] * u + n[0] * 0.3, cy = w.p[1] + t[1] * u + n[1] * 0.3; log('  win', fi, cx.toFixed(1), cy.toFixed(1), za.toFixed(1), zb.toFixed(1), 'inside?', w.g.parts.some((pp) => pip(cx, cy, pp.ring))); }
      }
    }
  }
  // ── roofs: ridge and hip tiles, eave tiles ──
  const edges = new Map();
  for (let k = 0; k < nT; k++) {
    const gi = tg[k]; if (gi < 0) continue;
    const ids = [T.idx[k * 3], T.idx[k * 3 + 1], T.idx[k * 3 + 2]], kind = Math.round(T.style[ids[0] * 4]);
    if (kind !== 3 && kind !== 5) continue;
    const P = ids.map(V);
    const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]], e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
    let nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...nn); if (l < 1e-6) continue; nn = nn.map((v) => v / l); if (nn[1] < 0) nn = nn.map((v) => -v);
    if (nn[1] < 0.2 || nn[1] > 0.985) continue;   // slopes only
    const col = [T.col[ids[0] * 3], T.col[ids[0] * 3 + 1], T.col[ids[0] * 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const A = P[e], B = P[(e + 1) % 3], C = P[(e + 2) % 3];
      const ka = `${K5(A[0])},${K5(A[1])},${K5(A[2])}`, kb = `${K5(B[0])},${K5(B[1])},${K5(B[2])}`, ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      let E = edges.get(ek); if (!E) { E = { A, B, f: [] }; edges.set(ek, E); }
      E.f.push({ n: nn, C, col, gi });
    }
  }
  for (const E of edges.values()) {
    const { A, B } = E, len = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]); if (len < 0.4) continue;
    if (E.f.length === 2) {
      const [f0, f1] = E.f, d = f0.n[0] * f1.n[0] + f0.n[1] * f1.n[1] + f0.n[2] * f1.n[2];
      if (d > 0.985) continue;   // same plane (a diagonal inside a face)
      // convex (ridge / hip) when the far vertex of one face lies below the other face's plane
      const s = (f1.n[0] * (f0.C[0] - A[0]) + f1.n[1] * (f0.C[1] - A[1]) + f1.n[2] * (f0.C[2] - A[2]));
      if (s >= -0.02) continue;   // valley: leave
      const up = [f0.n[0] + f1.n[0], f0.n[1] + f1.n[1], f0.n[2] + f1.n[2]], ul = Math.hypot(...up);
      ridgeTile(S, A, B, up.map((v) => v / ul), f0.col.map((v) => v * 0.82));
      stats.ridges++;
    } else if (E.f.length === 1) {
      // eave: the lower edge of a slope (both ends below the far vertex)
      const f = E.f[0]; if (!(f.C[1] > A[1] + 0.3 && f.C[1] > B[1] + 0.3 && Math.abs(A[1] - B[1]) < 0.25)) continue;
      // outward, horizontal, away from the far vertex
      const mx = (A[0] + B[0]) / 2, mz = (A[2] + B[2]) / 2, ex = B[0] - A[0], ez = B[2] - A[2], el = Math.hypot(ex, ez);
      let ox = -ez / el, oz = ex / el; if (ox * (f.C[0] - mx) + oz * (f.C[2] - mz) > 0) { ox = -ox; oz = -oz; }
      eaveTiles(S, A, B, [ox, oz], f.col);
      stats.eaves++;
    }
  }
  if (!S.pos.length) continue;
  const [area, ij] = key.split(':'), file = `l_${ij}.glb`;
  fs.mkdirSync(path.join(OUT, area), { recursive: true });
  stats.bytes += await writeGlb(S, path.join(OUT, area, file));
  stats.tris += S.pos.length / 9;
  out.tiles[key] = file; written.add(path.join(area, file));
}
if (!ONLY) for (const a of fs.readdirSync(OUT)) if (fs.statSync(path.join(OUT, a)).isDirectory()) for (const f of fs.readdirSync(path.join(OUT, a))) if (!written.has(path.join(a, f))) fs.rmSync(path.join(OUT, a, f));   // stale tiles
for (const g of gIndex) {
  if (!g.tris || (g.restyle < 0 && !g.look)) continue;
  const wall = g.look?.wall || 0, roof = g.look?.roof || 0;
  for (const p of g.parts) {
    const cx = Math.round((p.bb[0] + p.bb[2]) / 2), cy = Math.round((p.bb[1] + p.bb[3]) / 2);
    out.restyle.push([g.key, g.restyle, wall, roof, cx, cy, ...p.ring.flatMap(([x, y]) => [Math.round((x - cx) * 2), Math.round((y - cy) * 2)])]);
  }
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(out));
log(`walls ${stats.walls}, windows ${stats.windows}, ridges ${stats.ridges}, eaves ${stats.eaves}; ${Object.keys(out.tiles).length} tiles, ${(stats.tris / 1e6).toFixed(2)} M tris, ${(stats.bytes / 1e6).toFixed(1)} MB; restyle ${out.restyle.length} outlines`);

// ─── pieces ──────────────────────────────────────────────────────────────
function fixLast(S, nTri, n) {   // make the last nTri triangles face outward (+n in plan) or up
  for (let k = S.pos.length - nTri * 9; k < S.pos.length; k += 9) {
    const q = k / 3, N = [S.nrm[q * 3], S.nrm[q * 3 + 1], S.nrm[q * 3 + 2]];
    const out = N[0] * n[0] + N[2] * -n[1] + Math.max(0, N[1]) * 0.5;
    if (out >= -1e-3) continue;
    for (let c = 0; c < 3; c++) { const t0 = S.pos[k + 3 + c]; S.pos[k + 3 + c] = S.pos[k + 6 + c]; S.pos[k + 6 + c] = t0; }
    for (let v = q; v < q + 3; v++) for (let c = 0; c < 3; c++) S.nrm[v * 3 + c] *= -1;
  }
}
function railing(S, o, t, n, u0, u1, d, z0, z1) {
  const P = (u, dd, z) => [o[0] + t[0] * u + n[0] * dd, z, -(o[1] + t[1] * u + n[1] * dd)];
  wboxF(S, o, t, n, u0, u1, d - 0.04, d, z1 - 0.05, z1, IRON);                     // handrail
  wboxF(S, o, t, n, u0, u1, d - 0.035, d, z0 + 0.1, z0 + 0.14, IRON);
  const nb = Math.max(2, Math.round((u1 - u0) / 0.2));
  for (let k = 1; k < nb; k++) { const u = u0 + ((u1 - u0) * k) / nb; plate(S, o, t, n, u - 0.016, u + 0.016, d - 0.015, z0, z1 - 0.05, IRON); }
  wboxF(S, o, t, n, u0 - 0.02, u0 + 0.02, 0.02, d, z0, z1, IRON); wboxF(S, o, t, n, u1 - 0.02, u1 + 0.02, 0.02, d, z0, z1, IRON);
  void P;
}
// a flat bar seen from outside only (balusters, iron bars): one quad facing +n
function plate(S, o, t, n, u0, u1, d, z0, z1, col) {
  const P = (u, z) => [o[0] + t[0] * u + n[0] * d, z, -(o[1] + t[1] * u + n[1] * d)];
  const s0 = S.pos.length; quad(S, P(u0, z0), P(u1, z0), P(u1, z1), P(u0, z1), col);
  const um = (u0 + u1) / 2; orient(S, s0, [o[0] + t[0] * um, (z0 + z1) / 2, -(o[1] + t[1] * um)]);
}
// half-round ridge tiles along A→B, sitting on the ridge (up = bisector of the two slopes)
function ridgeTile(S, A, B, up, col) {
  const ax = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L = Math.hypot(...ax), t = ax.map((v) => v / L);
  let s = [t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]]; const sl = Math.hypot(...s); s = s.map((v) => v / sl);
  const u2 = [s[1] * t[2] - s[2] * t[1], s[2] * t[0] - s[0] * t[2], s[0] * t[1] - s[1] * t[0]];
  const r = 0.15, N = 6, ring = [];
  for (let i = 0; i <= N; i++) { const a = (Math.PI * i) / N; ring.push([Math.cos(a) * r, Math.sin(a) * r * 0.9]); }
  const at = (P, c) => [P[0] + s[0] * c[0] + u2[0] * (c[1] - 0.02), P[1] + s[1] * c[0] + u2[1] * (c[1] - 0.02), P[2] + s[2] * c[0] + u2[2] * (c[1] - 0.02)];
  const A2 = A.map((v, k) => v - t[k] * 0.05), B2 = B.map((v, k) => v + t[k] * 0.05);
  for (let i = 0; i < N; i++) quad(S, at(A2, ring[i + 1]), at(B2, ring[i + 1]), at(B2, ring[i]), at(A2, ring[i]), col.map((v) => v * (0.9 + 0.1 * Math.sin((Math.PI * (i + 0.5)) / N))));
  fixOut(S, N * 2, (P) => [P[0] - (A2[0] + B2[0]) / 2, P[1] - (A2[1] + B2[1]) / 2, P[2] - (A2[2] + B2[2]) / 2], A2, B2, t);
}
// faces of a tube must point away from its axis
function fixOut(S, nTri, _f, A, B, t) {
  for (let k = S.pos.length - nTri * 9; k < S.pos.length; k += 9) {
    const q = k / 3, c = [0, 1, 2].map((d) => (S.pos[k + d] + S.pos[k + 3 + d] + S.pos[k + 6 + d]) / 3);
    const w = [c[0] - A[0], c[1] - A[1], c[2] - A[2]], along = w[0] * t[0] + w[1] * t[1] + w[2] * t[2], r = [w[0] - t[0] * along, w[1] - t[1] * along, w[2] - t[2] * along];
    if (S.nrm[q * 3] * r[0] + S.nrm[q * 3 + 1] * r[1] + S.nrm[q * 3 + 2] * r[2] >= 0) continue;
    for (let d = 0; d < 3; d++) { const t0 = S.pos[k + 3 + d]; S.pos[k + 3 + d] = S.pos[k + 6 + d]; S.pos[k + 6 + d] = t0; }
    for (let v = q; v < q + 3; v++) for (let d = 0; d < 3; d++) S.nrm[v * 3 + d] *= -1;
  }
}
// beirado: the eave's double row of tiles, overhanging the wall, its nosing dark with the shadow under it
function eaveTiles(S, A, B, o, col) {
  const P = (Q, out, dz) => [Q[0] + o[0] * out, Q[1] + dz, Q[2] + o[1] * out];
  const nose = col.map((v) => v * 0.62), under = col.map((v) => v * 0.45);
  quad(S, P(A, 0, 0.02), P(B, 0, 0.02), P(B, 0.32, -0.05), P(A, 0.32, -0.05), col.map((v) => v * 0.95));   // top
  quad(S, P(A, 0.32, -0.05), P(B, 0.32, -0.05), P(B, 0.32, -0.2), P(A, 0.32, -0.2), nose);                // nosing
  quad(S, P(A, 0.32, -0.2), P(B, 0.32, -0.2), P(B, 0, -0.32), P(A, 0, -0.32), under);                      // underside
  fixOutPlan(S, 6, A, B, o);
}
function fixOutPlan(S, nTri, A, B, o) {   // up or outward (+o in x/z) faces
  for (let k = S.pos.length - nTri * 9; k < S.pos.length; k += 9) {
    const q = k / 3, N = [S.nrm[q * 3], S.nrm[q * 3 + 1], S.nrm[q * 3 + 2]];
    const c = [0, 1, 2].map((d) => (S.pos[k + d] + S.pos[k + 3 + d] + S.pos[k + 6 + d]) / 3);
    const want = c[1] < Math.min(A[1], B[1]) - 0.22 ? -1 : 1;   // underside faces down/in
    const sc = (N[0] * o[0] + N[2] * o[1]) * 0.6 + N[1] * want;
    if (sc >= 0) continue;
    for (let d = 0; d < 3; d++) { const t0 = S.pos[k + 3 + d]; S.pos[k + 3 + d] = S.pos[k + 6 + d]; S.pos[k + 6 + d] = t0; }
    for (let v = q; v < q + 3; v++) for (let d = 0; d < 3; d++) S.nrm[v * 3 + d] *= -1;
  }
}

async function writeGlb(S, file) {
  const doc = new Document().setLogger(new Logger(Logger.Verbosity.ERROR));
  const buf = doc.createBuffer(), scene = doc.createScene(); doc.getRoot().setDefaultScene(scene);
  const prim = doc.createPrimitive();
  prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(Float32Array.from(S.pos)).setBuffer(buf));
  prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(Float32Array.from(S.nrm)).setBuffer(buf));
  prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(Uint8Array.from(S.col, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255))).setNormalized(true).setBuffer(buf));
  prim.setMaterial(doc.createMaterial('detail').setRoughnessFactor(0.85).setMetallicFactor(0));
  scene.addChild(doc.createNode('detail').setMesh(doc.createMesh('detail').addPrimitive(prim)));
  await doc.transform(weld(), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeNormal: 8, quantizeColor: 8 }));
  await io.write(file, doc);
  return fs.statSync(file).size;
}
