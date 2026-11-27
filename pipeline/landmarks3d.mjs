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
import { fromFile } from 'geotiff';
import { makeProjection } from './lib/osm.mjs';
import { obb, box as bbox, KIND } from './lib/buildings.mjs';
import { estrelaFront } from './lib/authored.mjs';

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
    if (Math.abs(T.nrm[a * 3 + 1]) < 0.2 && (kind === 6 || kind === 0)) {   // stone / plain walls: big quads = bare massing, small = hand-built detail
      const ax = T.pos[b * 3] - T.pos[a * 3], ay = T.pos[b * 3 + 1] - T.pos[a * 3 + 1], az = T.pos[b * 3 + 2] - T.pos[a * 3 + 2], bx = T.pos[c * 3] - T.pos[a * 3], by = T.pos[c * 3 + 1] - T.pos[a * 3 + 1], bz = T.pos[c * 3 + 2] - T.pos[a * 3 + 2];
      const ar = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
      g.sw = (g.sw || 0) + ar; g.sn = (g.sn || 0) + 1; if (ar > 12) g.sbig = (g.sbig || 0) + ar; if (ar < 1.5) g.ssmall = (g.ssmall || 0) + 1;
    }
    if (Math.abs(T.nrm[a * 3 + 1]) < 0.2) { const kk = 'k' + kind + 'v' + variant; (g.wk || (g.wk = {}))[kk] = (g.wk[kk] || 0) + 1; }
  }
  const key = `${A.area}:${t.i}_${t.j}`; cache.set(key, T); triGroups.set(key, tg);
}
// decide per group: restyle (vernacular → palatial), colours, whether to add façade stonework
let nRestyle = 0;
for (const g of gIndex) {
  if (!g.tris) continue;
  const wv = Object.entries(g.wallV).sort((a, b) => b[1] - a[1]), dom = wv.length ? +wv[0][0] : -1;
  g.blank = /^(worship|church|chapel|monastery|basilica|cathedral|castle|palace|manor|museum|library|government|townhall|courthouse|university|hospital|theatre|building|)$/.test(g.kind || '') && LOOKS[g.key] !== null;   // bare walls get openings (decided per wall)   // stone massing with nothing on it (church-like buildings the rules drew bare)
  g.authored = g.auth / g.tris > 0.4;
  g.churchy = /^(worship|church|chapel|basilica|cathedral)$/.test(g.kind || '');
  g.look = LOOKS[g.key] === null ? null : LOOKS[g.key] || null;
  g.palatial = !g.authored && PALATIAL.test(g.kind || '') && LOOKS[g.key] !== null;
  g.restyle = g.palatial && (dom === 1 || dom === 2) ? 4 : -1;   // vernacular / azulejo houses → palatial window grid
  g.formal = g.restyle === 4 || (!g.authored && (dom === 4 || dom === 0) && LOOKS[g.key] !== null);
  if (g.restyle >= 0 || g.look) nRestyle++;
}
if (process.env.LM_DBG) for (const g of gIndex) if (process.env.LM_DBG.split(',').includes(g.key)) log(g.name, g.kind, JSON.stringify(g.wallV), JSON.stringify(g.wk), 'auth', g.auth, '/', g.tris, 'restyle', g.restyle, 'formal', g.formal);
log(`landmarks in tiles: ${gIndex.filter((g) => g.tris).length}, authored ${gIndex.filter((g) => g.authored).length}, restyled ${nRestyle}, formal façades ${gIndex.filter((g) => g.formal).length}`);

// ─── pass 2: stonework per tile ──────────────────────────────────────────
const LIOZ = LIN('#d9d0bd'), LIOZ_D = LIN('#c4baa5'), IRON = LIN('#2b302e');
const out = { v: Date.now().toString(36), restyle: [], tiles: {} };
fs.mkdirSync(OUT, { recursive: true });
const written = new Set();
const stats = { walls: 0, windows: 0, ridges: 0, eaves: 0, bal: 0, tris: 0, bytes: 0 };
const K5 = (v) => Math.round(v * 20);   // 5 cm vertex key

const sinks = new Map(), sinkFor = (key) => sinks.get(key) || sinks.set(key, sink()).get(key);
for (const [key, T] of cache) {
  const tg = triGroups.get(key), S = sinkFor(key), nT = T.idx.length / 3;
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
  // ── bare walls: big stone / plain quads with nothing hand-built in front of them (churches and convents the rules drew
  //    as plain massing) get openings: tall round-arched windows between pilaster strips on churches, rows of framed
  //    windows on convents and palaces; a cornice and a socle on both ──
  {
    const bw = new Map(), small = new Map();   // per group: wall quads, and centroids of small (hand-built) triangles
    for (let k = 0; k < nT; k++) {
      const gi = tg[k]; if (gi < 0) continue; const g = gIndex[gi]; if (!g.blank) continue;
      const ids = [T.idx[k * 3], T.idx[k * 3 + 1], T.idx[k * 3 + 2]], a = ids[0], kind = Math.round(T.style[a * 4]);
      const P = ids.map(V), ex = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]], ey = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
      const ar = Math.hypot(ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]) / 2;
      if (ar < 4) { (small.get(gi) || small.set(gi, []).get(gi)).push([(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3, (P[0][2] + P[1][2] + P[2][2]) / 3]); continue; }
      if (kind !== 6 || Math.abs(T.nrm[a * 3 + 1]) > 0.15) continue;   // stone massing only: blank (2) walls are blind on purpose
      const pts = []; for (const p of P) if (!pts.some((q) => Math.hypot(q[0] - p[0], q[2] - p[2]) < 0.05)) pts.push(p);
      if (pts.length !== 2) continue;
      let [p, q] = pts; const nx = T.nrm[a * 3], nz = T.nrm[a * 3 + 2], tx = q[0] - p[0], ty = -(q[2] - p[2]);
      if (ty * nx + tx * nz < 0) [p, q] = [q, p];
      const wk = `${gi}|${K5(p[0])},${K5(p[2])},${K5(q[0])},${K5(q[2])}`;
      let w = bw.get(wk); if (!w) { w = { gi, p: [p[0], -p[2]], q: [q[0], -q[2]], lo: Infinity, hi: -Infinity, col: [T.col[a * 3], T.col[a * 3 + 1], T.col[a * 3 + 2]], ground: Infinity }; bw.set(wk, w); }
      for (const i of ids) { const y = T.pos[i * 3 + 1]; w.lo = Math.min(w.lo, y); w.hi = Math.max(w.hi, y); const sy = T.surf[i * 2 + 1]; if (sy > -2 && sy < 200) w.ground = Math.min(w.ground, y - sy); }
    }
    const DARK = LIN('#2a2c30');
    for (const w of bw.values()) {
      const g = gIndex[w.gi], Lw = Math.hypot(w.q[0] - w.p[0], w.q[1] - w.p[1]); if (Lw < 3) continue;
      const t = [(w.q[0] - w.p[0]) / Lw, (w.q[1] - w.p[1]) / Lw], n = [t[1], -t[0]];
      const g0 = isFinite(w.ground) && w.ground > w.lo - 0.5 ? w.ground : w.lo + 1.5, top = w.hi, H = top - g0;
      if (H < 4) continue;
      // anything hand-built in front of this wall? then it is not bare
      let busy = 0;
      for (const c of small.get(w.gi) || []) {
        const dx = c[0] - w.p[0], dy = -c[2] - w.p[1], u = dx * t[0] + dy * t[1], d = dx * n[0] + dy * n[1];
        if (u > -0.5 && u < Lw + 0.5 && d > -0.3 && d < 1.2 && c[1] > g0 && c[1] < top + 0.5) busy++;
      }
      if (process.env.LM_DBG && process.env.LM_DBG.split(',').includes(g.key)) log('bare?', g.name, Lw.toFixed(1), 'H', H.toFixed(1), 'busy', busy, 'g0', g0.toFixed(1), w.lo.toFixed(1), w.hi.toFixed(1));
      if (busy > 2) continue;
      stats.bare = (stats.bare || 0) + 1;
      const trim = LIOZ, tall = g.churchy;
      wboxF(S, w.p, t, n, -0.06, Lw + 0.06, 0, 0.09, w.lo, g0 + 0.8, LIOZ_D);                                 // socle
      wboxF(S, w.p, t, n, -0.18, Lw + 0.18, 0, 0.26, top - 0.34, top - 0.04, trim, { bottom: true });         // cornice
      wboxF(S, w.p, t, n, -0.1, Lw + 0.1, 0, 0.13, top - 0.64, top - 0.34, trim, { bottom: true });
      if (Lw > 4) { wboxF(S, w.p, t, n, 0, 0.55, 0, 0.1, g0 + 0.8, top - 0.64, trim); wboxF(S, w.p, t, n, Lw - 0.55, Lw, 0, 0.1, g0 + 0.8, top - 0.64, trim); }
      if (tall) {
        // nave: bays of ~5.5 m, a pilaster strip between bays, one tall arched window high in each
        const nb = Math.max(1, Math.round((Lw - 1.1) / 5.5)), bl = (Lw - 1.1) / nb;
        for (let b = 0; b < nb; b++) {
          const u = 0.55 + bl * (b + 0.5);
          if (b > 0) wboxF(S, w.p, t, n, 0.55 + bl * b - 0.3, 0.55 + bl * b + 0.3, 0, 0.1, g0 + 0.8, top - 0.64, trim);
          const ww = Math.min(1.6, bl * 0.34, H * 0.2), z0 = g0 + Math.max(H < 7 ? H * 0.34 : 2.6, H * 0.42 * (H < 7 ? 0.8 : 1)), z1 = Math.min(top - (H < 7 ? 0.9 : 1.3), z0 + Math.max(2.2, H * 0.36));
          if (z1 - z0 < 1.2) continue;
          archWindow(S, w.p, t, n, u, ww, z0, z1, DARK, trim);
          stats.windows++;
        }
      } else {
        // convent / palace ranges: storeys of ~4 m, a framed window every ~3.6 m
        const nb = Math.max(1, Math.round((Lw - 1.1) / 3.6)), bl = (Lw - 1.1) / nb, fl = Math.max(1, Math.round((H - 0.6) / 4.2)), fh = (H - 0.6) / fl;
        for (let f = 0; f < fl; f++) for (let b = 0; b < nb; b++) {
          const u = 0.55 + bl * (b + 0.5), ww = Math.min(1.25, bl * 0.38), z0 = g0 + f * fh + (f === 0 ? 1.1 : fh * 0.22), z1 = g0 + f * fh + fh * 0.8;
          if (z1 > top - 0.8 || z1 - z0 < 1) continue;
          rectWindow(S, w.p, t, n, u, ww, z0, z1, DARK, trim);
          stats.windows++;
        }
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
}
// modelled one by one in authored.mjs: their towers and domes are already there
// domes only where one is known to stand (a residual blob elsewhere is as often a tower, a crane or trees)
var DOMED = /^(Igreja da Memória|Igreja de Santo António de Lisboa|Igreja do Santíssimo Coração de Jesus)$/;
var HANDMADE = /^(Sé de Lisboa|Sé Patriarcal|Catedral|Basílica da Estrela|Basílica de Nossa Senhora|Panteão|Igreja de Santa Engrácia|Convento do Carmo|Igreja do Convento do Carmo|Mosteiro dos Jerónimos|Igreja de Santa Maria de Belém)/;
await crowns();
await extras();

// ─── famous fronts the rule-built massing lacks, modelled one by one in authored.mjs ───
// Frame recovered the way build.mjs makes it (OBB of the footprint); the façade end is the one the towers stand at.
async function extras() {
  const tileKeyOf = (x, y) => { for (const A of IDX.areas) { if (!(x >= A.bounds.minX && x < A.bounds.maxX && y >= A.bounds.minY && y < A.bounds.maxY)) continue; const t = A.tiles.find((q) => x >= q.bounds[0] && x < q.bounds[2] && y >= q.bounds[1] && y < q.bounds[3]); return t && `${A.area}:${t.i}_${t.j}`; } return null; };
  for (const [qid, fn, H] of [['Q2657972', estrelaFront, 24]]) {
    const g = gIndex.find((q) => q.key === qid); if (!g || !g.parts.length) continue;
    const part = g.parts.reduce((a, b) => (b.area > a.area ? b : a));
    const o = obb(part.ring); if (!o) continue;
    let { ux, uy } = o; const hl = o.hl, hw = o.hw, cx = o.cx, cy = o.cy;
    // the group's vertices: ground = lowest, façade = the end with the tall towers
    let zmin = Infinity; const hi = [0, 0];
    for (const [key, T] of cache) { const tg = triGroups.get(key); for (let k = 0; k < tg.length; k++) { if (tg[k] !== gIndex.indexOf(g)) continue; for (let c = 0; c < 3; c++) { const i = T.idx[k * 3 + c], x = T.pos[i * 3], y = -T.pos[i * 3 + 2], z = T.pos[i * 3 + 1]; zmin = Math.min(zmin, z); const u = (x - cx) * ux + (y - cy) * uy; if (Math.abs(u) > hl * 0.6) hi[u > 0 ? 1 : 0] = Math.max(hi[u > 0 ? 1 : 0], z); } } }
    if (hi[1] > hi[0]) { ux = -ux; uy = -uy; }
    const tk = tileKeyOf(cx, cy); if (!tk) continue; const S = sinkFor(tk); S.info ||= []; S.style ||= []; S.surf ||= [];   // the authored kit writes tile attributes too; only pos/nrm/col are kept
    const ground = zmin + 1.5;   // parishChurch sinks its walls 1.5 m below the lowest corner
    fn(S, { cx, cy, ux, uy, hl, hw, ground, H, lin, srgb });
    stats.fronts = (stats.fronts || 0) + 1; log('front', g.name, 'hl', hl.toFixed(1), 'hw', hw.toFixed(1), 'ground', ground.toFixed(1), 'towers', hi.map((v) => v.toFixed(1)).join('/'));
  }
  // a small block in the Castelejo yard drawn as a plain box with a terracotta flat roof: castle stone and merlons, like the walls round it
  for (const { ring, top, wall, roof } of [{ ring: [[545.9, 28.9], [547.0, 33.0], [542.4, 34.3], [541.2, 30.2]], top: 109.3, wall: '#c9bfa9', roof: '#a99f8c' }]) {
    const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length, cy = ring.reduce((a, p) => a + p[1], 0) / ring.length, tk = tileKeyOf(cx, cy); if (!tk) continue;
    out.restyle.push(['castelejo-block', -2, wall, roof, Math.round(cx), Math.round(cy), ...ring.flatMap(([x, y]) => [Math.round((x - Math.round(cx)) * 2), Math.round((y - Math.round(cy)) * 2)])]);
    const S = sinkFor(tk); S.info ||= []; S.style ||= []; S.surf ||= [];
    const ST = [KIND.STONE / 8, 5 / 8, 0.5, 0.9], col = LIN(wall);
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, n = Math.max(2, Math.round(L / 1.25));
      for (let q = 0; q < n; q++) { const t = (q + 0.5) / n; bbox(S, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, ux, uy, 0.32, 0.3, top - 0.05, top + 1.0, col, [0, 0, 0, 0], ST); }
      bbox(S, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ux, uy, L / 2 + 0.2, 0.2, top - 0.6, top - 0.2, LIN('#b5ab95'), [0, 0, 0, 0], ST);   // a string course under the merlons
    }
    stats.fronts = (stats.fronts || 0) + 1;
  }
}
for (const [key, S] of sinks) {
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
log(`domes ${stats.domes || 0}, towers ${stats.towers || 0}; bare walls ${stats.bare || 0}; walls ${stats.walls}, windows ${stats.windows}, ridges ${stats.ridges}, eaves ${stats.eaves}; ${Object.keys(out.tiles).length} tiles, ${(stats.tris / 1e6).toFixed(2)} M tris, ${(stats.bytes / 1e6).toFixed(1)} MB; restyle ${out.restyle.length} outlines`);

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
// a window opening on a bare wall: dark recessed pane (a panel just proud of the wall), lioz jambs, head and sill
function rectWindow(S, o, t, n, u, ww, z0, z1, dark, trim) {
  const hw = ww / 2, f = 0.18;
  plate(S, o, t, n, u - hw, u + hw, 0.02, z0, z1, dark);
  wboxF(S, o, t, n, u - hw - f, u - hw, 0, 0.12, z0, z1 + f, trim);
  wboxF(S, o, t, n, u + hw, u + hw + f, 0, 0.12, z0, z1 + f, trim);
  wboxF(S, o, t, n, u - hw, u + hw, 0, 0.12, z1, z1 + f, trim, { bottom: true });
  wboxF(S, o, t, n, u - hw - f - 0.06, u + hw + f + 0.06, 0, 0.16, z0 - 0.12, z0, trim);
}
// a tall round-headed church window: dark pane with a semicircular head, a lioz surround following it
function archWindow(S, o, t, n, u, ww, z0, z1, dark, trim) {
  const hw = ww / 2, zs = z1 - hw, f = 0.2, N = 7;
  const P = (uu, d, z) => [o[0] + t[0] * uu + n[0] * d, z, -(o[1] + t[1] * uu + n[1] * d)];
  plate(S, o, t, n, u - hw, u + hw, 0.02, z0, zs, dark);
  let s0 = S.pos.length;
  for (let i = 0; i < N; i++) { const a0 = (Math.PI * i) / N, a1 = (Math.PI * (i + 1)) / N; tri(S, P(u, 0.02, zs), P(u + Math.cos(a0) * hw, 0.02, zs + Math.sin(a0) * hw), P(u + Math.cos(a1) * hw, 0.02, zs + Math.sin(a1) * hw), dark); }
  orient(S, s0, P(u, -1, zs));
  wboxF(S, o, t, n, u - hw - f, u - hw, 0, 0.12, z0, zs, trim);
  wboxF(S, o, t, n, u + hw, u + hw + f, 0, 0.12, z0, zs, trim);
  s0 = S.pos.length;
  for (let i = 0; i < N; i++) {   // the arch's surround: a ring of quads, front and outer face
    const a0 = (Math.PI * i) / N, a1 = (Math.PI * (i + 1)) / N, r0 = hw, r1 = hw + f;
    const A = (r, a, d) => P(u + Math.cos(a) * r, d, zs + Math.sin(a) * r);
    quad(S, A(r0, a0, 0.12), A(r1, a0, 0.12), A(r1, a1, 0.12), A(r0, a1, 0.12), trim);
    quad(S, A(r1, a0, 0), A(r1, a1, 0), A(r1, a1, 0.12), A(r1, a0, 0.12), trim.map((v) => v * 0.92));
  }
  orient(S, s0, P(u, -1, zs));
  wboxF(S, o, t, n, u - hw - f - 0.06, u + hw + f + 0.06, 0, 0.16, z0 - 0.14, z0, trim);
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

// ─── domes and towers the tiles miss, from the 2024 LiDAR ────────────────
// Where the survey's surface stands well above everything the tile draws inside a landmark's outline, in a compact blob,
// something is missing: a dome over the crossing, a bell tower. Round and wide → drum and dome with a lantern; small →
// a tower with belfry arches and a cap, its top at the measured height.
async function crowns() {
  const proj = makeProjection(IDX.areas[0].origin.lat, IDX.areas[0].origin.lon);
  const rasters = new Map();
  const lidar = async (area) => {
    if (rasters.has(area)) return rasters.get(area);
    const f = (k) => path.join(ROOT, 'data/lidar', `${area}_${k}.tif`);
    if (!fs.existsSync(f('ndsm')) || !fs.existsSync(f('dtm'))) { rasters.set(area, null); return null; }
    const rd = async (k) => { const img = await (await fromFile(f(k))).getImage(); const [r] = await img.readRasters(); const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution(); return { r, ox, oy, rx, ry, w: img.getWidth(), h: img.getHeight() }; };
    const N = await rd('ndsm'), D = await rd('dtm');
    const at = (R, la, lo, bil) => { const fx = (lo - R.ox) / R.rx - (bil ? 0.5 : 0), fy = (la - R.oy) / R.ry - (bil ? 0.5 : 0), c = Math.floor(fx), k = Math.floor(fy); if (c < 0 || k < 0 || c + 1 >= R.w || k + 1 >= R.h) return NaN;
      if (!bil) return R.r[k * R.w + c]; const tx = fx - c, ty = fy - k, v = [R.r[k * R.w + c], R.r[k * R.w + c + 1], R.r[(k + 1) * R.w + c], R.r[(k + 1) * R.w + c + 1]]; if (v.some((q) => q === 65535)) return NaN; return v[0] * (1 - tx) * (1 - ty) + v[1] * tx * (1 - ty) + v[2] * (1 - tx) * ty + v[3] * tx * ty; };
    const fn = (x, y) => { const [la, lo] = proj.inv(x, y), n = at(N, la, lo, false), d = at(D, la, lo, true); return isFinite(n) && isFinite(d) ? d / 10 + n / 10 : NaN; };
    rasters.set(area, fn); return fn;
  };
  // every landmark's up-facing triangles, across tiles, in world space
  const roofs = new Map();
  for (const [key, T] of cache) {
    const tg = triGroups.get(key), nT = T.idx.length / 3;
    for (let k = 0; k < nT; k++) {
      const gi = tg[k]; if (gi < 0) continue;
      const a = T.idx[k * 3], b = T.idx[k * 3 + 1], c = T.idx[k * 3 + 2];
      if (T.nrm[a * 3 + 1] < 0.1) continue;
      (roofs.get(gi) || roofs.set(gi, []).get(gi)).push([a, b, c].map((i) => [T.pos[i * 3], T.pos[i * 3 + 1], -T.pos[i * 3 + 2]]));
    }
  }
  const area0 = (x, y) => IDX.areas.find((A) => x >= A.bounds.minX && x < A.bounds.maxX && y >= A.bounds.minY && y < A.bounds.maxY);
  const tileKey = (x, y) => { const A = area0(x, y); if (!A) return null; const t = A.tiles.find((q) => x >= q.bounds[0] && x < q.bounds[2] && y >= q.bounds[1] && y < q.bounds[3]); return t && `${A.area}:${t.i}_${t.j}`; };
  const DOME = LIN('#ddd6c8'), DOME_D = LIN('#b9b2a2'), CAP = LIN('#a35e48'), DARK = LIN('#2a2c30');
  for (const [gi, tris] of roofs) {
    const g = gIndex[gi]; if (process.env.LM_CDBG && g.name.includes(process.env.LM_CDBG)) log('grp', g.name, g.authored, g.kind, tris.length); if (!(g.churchy || /monastery|convent/.test(g.kind || '')) || HANDMADE.test(g.name)) continue;   // only churches carry domes and bell towers; elsewhere the residual is trees and plant rooms
    // the rule-built parish churches (kind 6) already have their towers: they only lack the dome over the crossing
    const A = area0((g.bb[0] + g.bb[2]) / 2, (g.bb[1] + g.bb[3]) / 2); if (!A) continue;
    const L = await lidar(A.area); if (!L) continue;
    // tile roof height on a 1 m grid
    const x0 = Math.floor(g.bb[0]), y0 = Math.floor(g.bb[1]), W = Math.ceil(g.bb[2]) - x0 + 1, H = Math.ceil(g.bb[3]) - y0 + 1;
    if (W * H > 250000) continue;
    const top = new Float32Array(W * H).fill(-Infinity);
    for (const [p, q, r] of tris) {
      const mnx = Math.max(0, Math.floor(Math.min(p[0], q[0], r[0]) - x0)), mxx = Math.min(W - 1, Math.ceil(Math.max(p[0], q[0], r[0]) - x0));
      const mny = Math.max(0, Math.floor(Math.min(p[2], q[2], r[2]) - y0)), mxy = Math.min(H - 1, Math.ceil(Math.max(p[2], q[2], r[2]) - y0));
      const d = (q[0] - p[0]) * (r[2] - p[2]) - (r[0] - p[0]) * (q[2] - p[2]); if (Math.abs(d) < 1e-6) continue;
      for (let j = mny; j <= mxy; j++) for (let i = mnx; i <= mxx; i++) {
        const X = x0 + i + 0.5, Y = y0 + j + 0.5;
        const l1 = ((q[0] - X) * (r[2] - Y) - (r[0] - X) * (q[2] - Y)) / d, l2 = ((r[0] - X) * (p[2] - Y) - (p[0] - X) * (r[2] - Y)) / d, l3 = 1 - l1 - l2;
        if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
        const z = l1 * p[1] + l2 * q[1] + l3 * r[1]; if (z > top[j * W + i]) top[j * W + i] = z;
      }
    }
    // residual: survey surface − drawn roof, on a 2 m grid, inside the outline and clear of its edge
    const S2 = 2, GW = Math.ceil(W / S2), GH = Math.ceil(H / S2), res = new Float32Array(GW * GH).fill(NaN), abs = new Float32Array(GW * GH), base = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const X = x0 + i * S2 + 1, Y = y0 + j * S2 + 1;
      if (!g.parts.some((pp) => pip(X, Y, pp.ring))) continue;
      let tz = -Infinity, ok = 0; for (let dj = 0; dj < S2; dj++) for (let di = 0; di < S2; di++) { const ii = i * S2 + di, jj = j * S2 + dj; if (ii < W && jj < H && isFinite(top[jj * W + ii])) { tz = Math.max(tz, top[jj * W + ii]); ok++; } }
      if (ok < 3) continue;
      const z = L(X, Y); if (!isFinite(z)) continue;
      res[j * GW + i] = z - tz; abs[j * GW + i] = z; base[j * GW + i] = tz;
    }
    // blobs of residual > 3.5 m
    const seen = new Uint8Array(GW * GH), cand = [];
    for (let s0 = 0; s0 < GW * GH; s0++) {
      if (seen[s0] || !(res[s0] > 3.5)) continue;
      const blob = [], stack = [s0]; seen[s0] = 1;
      while (stack.length) { const c = stack.pop(); blob.push(c); const ci = c % GW, cj = (c / GW) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= GW || nj >= GH) continue; const nk = nj * GW + ni; if (!seen[nk] && res[nk] > 3.5) { seen[nk] = 1; stack.push(nk); } } }
      if (process.env.LM_CDBG && g.name.includes(process.env.LM_CDBG)) { let m = 0; for (const c of blob) m = Math.max(m, res[c]); log('blob', g.name, blob.length, m.toFixed(1)); }
      if (blob.length < 3 || blob.length > 160) continue;
      let pk = blob[0]; for (const c of blob) if (res[c] > res[pk]) pk = c;
      if (res[pk] < 5.5) continue;
      const cx = blob.reduce((a, c) => a + x0 + (c % GW) * S2 + 1, 0) / blob.length, cy = blob.reduce((a, c) => a + y0 + ((c / GW) | 0) * S2 + 1, 0) / blob.length;
      const area = blob.length * S2 * S2, r = Math.sqrt(area / Math.PI);
      const zBase = Math.min(...blob.map((c) => base[c])), zTop = abs[pk];
      // a tree over the roof is soft and lumpy: towers and domes have a crisp top (the peak's neighbours fall away evenly)
      // compact: fills its bounding box, not a long strip (a row of trees along the nave)
      let bi0 = 1e9, bi1 = -1e9, bj0 = 1e9, bj1 = -1e9; for (const c of blob) { const ci = c % GW, cj = (c / GW) | 0; bi0 = Math.min(bi0, ci); bi1 = Math.max(bi1, ci); bj0 = Math.min(bj0, cj); bj1 = Math.max(bj1, cj); }
      const bw = bi1 - bi0 + 1, bh = bj1 - bj0 + 1; if (blob.length / (bw * bh) < 0.5 || Math.max(bw, bh) / Math.min(bw, bh) > 2.5) continue;
      cand.push({ cx, cy, area, r, zBase, zTop, h: res[pk], dome: r >= 4.2 && res[pk] < r * 3.2 });
    }
    // at most one dome (the widest) and two towers (the tallest)
    const domes = DOMED.test(g.name) ? cand.filter((c) => c.dome && c.h < c.r * 2.6) : [].sort((a, b) => b.r - a.r).slice(0, 1), towers = g.authored ? [] : cand.filter((c) => !c.dome && c.area <= 80).sort((a, b) => b.h - a.h).slice(0, 2);
    for (const { cx, cy, area, r, zBase, zTop, h, dome } of [...domes, ...towers]) {
      void h; const key = tileKey(cx, cy); if (!key) continue;
      const S = sinkFor(key);
      if (dome) {
        const R = Math.max(3, Math.min(r * 0.6, 8)), lan = Math.max(1.6, R * 0.45), rise = Math.min(R * 1.05, Math.max(2, zTop - zBase - lan - 2)), zs = Math.min(zTop - lan - rise, zBase + R * 0.9);   // a squat drum: better a little short of the survey than a silo
        const zd = Math.max(zBase - 0.6, zs - 0.01);
        drumDome(S, cx, cy, R, zBase - 0.6, Math.max(zBase + 0.5, zs), rise, lan, DOME, DOME_D, DARK);
        stats.domes = (stats.domes || 0) + 1;
        if (process.env.LM_CROWNS) log('dome', g.name, cx.toFixed(0), cy.toFixed(0), 'r', R.toFixed(1), 'base', zBase.toFixed(1), 'top', zTop.toFixed(1)); void zd;
      } else {
        // orient with the landmark's longest wall
        let ux = 1, uy = 0, best = 0; for (const pp of g.parts) for (let k = 0; k < pp.ring.length; k++) { const a = pp.ring[k], b = pp.ring[(k + 1) % pp.ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > best) { best = l; ux = (b[0] - a[0]) / l; uy = (b[1] - a[1]) / l; } }
        const side = Math.max(3.6, Math.min(8, Math.sqrt(area) * 0.9));
        bellTower(S, cx, cy, ux, uy, side, zBase - 0.6, zTop, g.blank ? LIN('#efebe3') : LIN('#ece6da'), LIOZ, CAP, DARK);
        stats.towers = (stats.towers || 0) + 1;
        if (process.env.LM_CROWNS) log('tower', g.name, cx.toFixed(0), cy.toFixed(0), 'side', side.toFixed(1), 'base', zBase.toFixed(1), 'top', zTop.toFixed(1), 'area', area);
      }
    }
  }
}
// drum (with arched windows and pilasters) + dome + lantern + cross
function drumDome(S, cx, cy, R, z0, zs, rise, lan, stone, ribC, dark) {
  const N = 20, P = (a, r, z) => [cx + Math.cos(a) * r, z, -(cy + Math.sin(a) * r)];
  let s0 = S.pos.length;
  for (let i = 0; i < N; i++) { const a0 = (2 * Math.PI * i) / N, a1 = (2 * Math.PI * (i + 1)) / N; quad(S, P(a0, R, z0), P(a1, R, z0), P(a1, R, zs), P(a0, R, zs), stone); }
  orient(S, s0, [cx, (z0 + zs) / 2, -cy]);
  // cornice ring at the spring
  s0 = S.pos.length;
  for (let i = 0; i < N; i++) { const a0 = (2 * Math.PI * i) / N, a1 = (2 * Math.PI * (i + 1)) / N; quad(S, P(a0, R + 0.35, zs - 0.4), P(a1, R + 0.35, zs - 0.4), P(a1, R + 0.35, zs), P(a0, R + 0.35, zs), ribC); quad(S, P(a0, R, zs), P(a1, R, zs), P(a1, R + 0.35, zs), P(a0, R + 0.35, zs), stone); }
  orient(S, s0, [cx, zs - 3, -cy]);
  // drum windows: dark arched panels between pilasters
  if (zs - z0 > 2.5) for (let i = 0; i < 8; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / 8, t = [-Math.sin(a), Math.cos(a)], n = [Math.cos(a), Math.sin(a)], o = [cx + n[0] * R, cy + n[1] * R];
    const h = Math.min(3.2, (zs - z0) * 0.55), zb = zs - 0.6 - h;
    archWindow(S, o, t, n, 0, Math.min(1.2, R * 0.25), zb, zs - 0.6, dark, LIOZ);
    const ap = (2 * Math.PI * i) / 8, tp = [-Math.sin(ap), Math.cos(ap)], np = [Math.cos(ap), Math.sin(ap)];
    wboxF(S, [cx + np[0] * R, cy + np[1] * R], tp, np, -0.3, 0.3, -0.1, 0.18, z0 + 0.5, zs - 0.4, LIOZ);
  }
  // dome: ribs every 1/8, cap
  const M = 6; s0 = S.pos.length;
  for (let i = 0; i < N; i++) for (let k = 0; k < M; k++) {
    const a0 = (2 * Math.PI * i) / N, a1 = (2 * Math.PI * (i + 1)) / N, e0 = (Math.PI / 2) * (k / M), e1 = (Math.PI / 2) * ((k + 1) / M);
    const Q = (a, e) => P(a, R * Math.cos(e), zs + rise * Math.sin(e));
    const col = i % (N / 8 | 0) === 0 ? ribC : stone;
    if (k === M - 1) tri(S, Q(a0, e0), Q(a1, e0), Q(a0, e1), col); else quad(S, Q(a0, e0), Q(a1, e0), Q(a1, e1), Q(a0, e1), col);
  }
  orient(S, s0, [cx, zs, -cy]);
  // lantern
  const lr = Math.max(0.7, R * 0.16), lz = zs + rise - 0.2; s0 = S.pos.length;
  for (let i = 0; i < 8; i++) { const a0 = (2 * Math.PI * i) / 8, a1 = (2 * Math.PI * (i + 1)) / 8, Pl = (a, z) => [cx + Math.cos(a) * lr, z, -(cy + Math.sin(a) * lr)]; quad(S, Pl(a0, lz), Pl(a1, lz), Pl(a1, lz + lan * 0.6), Pl(a0, lz + lan * 0.6), i % 2 ? dark : stone); tri(S, Pl(a0, lz + lan * 0.6), Pl(a1, lz + lan * 0.6), [cx, lz + lan * 0.92, -cy], ribC); }
  orient(S, s0, [cx, lz + lan * 0.3, -cy]);
  wboxF(S, [cx, cy], [1, 0], [0, 1], -0.05, 0.05, -0.05, 0.05, lz + lan * 0.9, lz + lan * 0.9 + 1.2, dark);
  wboxF(S, [cx, cy], [1, 0], [0, 1], -0.35, 0.35, -0.05, 0.05, lz + lan * 0.9 + 0.75, lz + lan * 0.9 + 0.85, dark);
}
// bell tower: square shaft with pilasters and cornices, a belfry with an arched opening on each face, a cap to the measured top
function bellTower(S, cx, cy, ux, uy, side, z0, zTop, wall, trim, capC, dark) {
  const h = side / 2, vx = -uy, vy = ux, capH = Math.min(side * 0.9, Math.max(1.8, (zTop - z0) * 0.22)), zc = zTop - capH, bel = Math.min(4.2, side * 0.8);
  if (zc - z0 < bel + 1.5) return;
  const faces = [[ux, uy, vx, vy], [vx, vy, -ux, -uy], [-ux, -uy, -vx, -vy], [-vx, -vy, ux, uy]];   // outward n, along t
  for (const [nx, ny, tx, ty] of faces) {
    const o = [cx + nx * h - tx * h, cy + ny * h - ty * h], t = [tx, ty], n = [nx, ny];
    wboxF(S, o, t, n, 0, side, -h, 0, z0, zc, wall);                                         // the shaft (one face each; ends overlap)
    wboxF(S, o, t, n, 0, 0.45, 0, 0.1, z0 + 0.6, zc - 0.4, trim); wboxF(S, o, t, n, side - 0.45, side, 0, 0.1, z0 + 0.6, zc - 0.4, trim);   // corner pilasters
    wboxF(S, o, t, n, -0.15, side + 0.15, 0, 0.25, zc - 0.35, zc, trim, { bottom: true });   // crowning cornice
    wboxF(S, o, t, n, -0.08, side + 0.08, 0, 0.15, zc - bel - 0.5, zc - bel - 0.3, trim, { bottom: true });   // belfry string course
    archWindow(S, o, t, n, side / 2, Math.min(1.5, side * 0.34), zc - bel, zc - 0.6, dark, trim);
  }
  // cap: a tiled pyramid when squat, a stone cupola when tall, finial cross
  const P = (a, b, z) => [cx + ux * a + vx * b, z, -(cy + uy * a + vy * b)];
  const s0 = S.pos.length, hh = h + 0.15, corners = [[-hh, -hh], [hh, -hh], [hh, hh], [-hh, hh]];
  if (capH < side * 0.6) for (let k = 0; k < 4; k++) { const [a0, b0] = corners[k], [a1, b1] = corners[(k + 1) % 4]; tri(S, P(a0, b0, zc), P(a1, b1, zc), P(0, 0, zTop - 0.9), capC); }
  else { const N = 12, M = 5; for (let i = 0; i < N; i++) for (let k = 0; k < M; k++) { const a0 = (2 * Math.PI * i) / N, a1 = (2 * Math.PI * (i + 1)) / N, e0 = (Math.PI / 2) * (k / M), e1 = (Math.PI / 2) * ((k + 1) / M), rr = h * 0.92, rise = capH - 0.9; const Q = (a, e) => [cx + Math.cos(a) * rr * Math.cos(e), zc + rise * Math.sin(e), -(cy + Math.sin(a) * rr * Math.cos(e))]; if (k === M - 1) tri(S, Q(a0, e0), Q(a1, e0), Q(a0, e1), wall); else quad(S, Q(a0, e0), Q(a1, e0), Q(a1, e1), Q(a0, e1), wall); } }
  orient(S, s0, [cx, zc, -cy]);
  wboxF(S, [cx, cy], [1, 0], [0, 1], -0.05, 0.05, -0.05, 0.05, zTop - 1.0, zTop, dark);
  wboxF(S, [cx, cy], [ux, uy], [vx, vy], -0.3, 0.3, -0.04, 0.04, zTop - 0.4, zTop - 0.3, dark);
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
