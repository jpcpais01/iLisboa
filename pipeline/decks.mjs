// Bridge decks citywide: every road, path and railway that OSM maps as a bridge gets a deck profile measured from the
// DGT 2024 LiDAR (terrain + height above it = the deck surface), so viaducts and flyovers stand at their real height
// instead of lying on the valley floor or the road they cross.
//   node pipeline/decks.mjs   → data/decks.json   (read by pipeline/build.mjs for the geometry and by
//                                                    pipeline/network.mjs for the cars' road graph)
// One citywide pass, so a bridge that crosses an area seam gets one profile in both areas.
//
// Per way: densified centreline (≤ 6 m), deck height per vertex, the half-widths to each side (narrowed where a
// parallel deck runs alongside, so two carriageways or two tracks meet instead of overlapping) and whether each
// side carries a parapet.
import fs from 'node:fs';
import path from 'node:path';
import { fromFile } from 'geotiff';
import { loadOverpass, makeProjection, parseMeters } from './lib/osm.mjs';
import { PONTE_LINE, VG_LINE, AQUEDUTO_LINE } from './lib/authored.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const proj = makeProjection(38.71375, -9.13975);
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const areas = fs.readFileSync(path.join(ROOT, 'pipeline/areas.txt'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/)[0]);

// ─── LiDAR: terrain (4 m) and height above it (2 m), every area ───
async function raster(f) {
  if (!fs.existsSync(f)) return null;
  const img = await (await fromFile(f)).getImage(), [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution(), [r] = await img.readRasters();
  return { ox, oy, rx, ry, w: img.getWidth(), h: img.getHeight(), r, S: oy + ry * img.getHeight(), N: oy, W: ox, E: ox + rx * img.getWidth() };
}
const L = [];
for (const a of areas) {
  const dtm = await raster(path.join(ROOT, 'data/lidar', `${a}_dtm.tif`)), nd = await raster(path.join(ROOT, 'data/lidar', `${a}_ndsm.tif`));
  if (dtm && nd) L.push({ a, dtm, nd });
}
log(`LiDAR areas ${L.length}`);
const bil = (R, la, lo, nodata) => {
  const fx = (lo - R.ox) / R.rx - 0.5, fy = (la - R.oy) / R.ry - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  if (x0 < 0 || y0 < 0 || x0 + 1 >= R.w || y0 + 1 >= R.h) return undefined;
  const a = R.r[y0 * R.w + x0], b = R.r[y0 * R.w + x0 + 1], c = R.r[(y0 + 1) * R.w + x0], d = R.r[(y0 + 1) * R.w + x0 + 1];
  if (nodata != null && (a === nodata || b === nodata || c === nodata || d === nodata)) return NaN;
  return (a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty) / 10;
};
let lastL = null;
// { g: terrain, h: height above it } at a point, NaN where there is no ground (water) — the raster that holds it
function lidar(x, y) {
  const [la, lo] = proj.inv(x, y);
  for (const R of lastL ? [lastL, ...L] : L) {
    if (la > R.dtm.N || la < R.dtm.S || lo < R.dtm.W || lo > R.dtm.E) continue;
    const g = bil(R.dtm, la, lo, 65535); if (g === undefined) continue;
    const h = bil(R.nd, la, lo); if (h === undefined) continue;
    lastL = R; return { g, h };
  }
  return { g: NaN, h: NaN };
}

// ─── OSM: bridge ways (the longest copy of each across the area extracts) ───
const ROAD_W = { motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8, unclassified: 6, residential: 6, living_street: 5, service: 4, pedestrian: 6, footway: 2.4, path: 2, steps: 2.4, cycleway: 2.2, track: 3, bridleway: 2.4, busway: 7, road: 6 };
const RAIL = new Set(['rail', 'light_rail', 'subway', 'tram', 'narrow_gauge', 'funicular']);
const lineOf = (LL, tol) => { const p = LL.map(([la, lo]) => proj.fwd(la, lo)); return (x, y) => { for (let i = 0; i + 1 < p.length; i++) { const [ax, ay] = p[i], [bx, by] = p[i + 1], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); if (Math.hypot(ax + dx * t - x, ay + dy * t - y) < tol) return true; } return false; }; };
const onPonte = lineOf(PONTE_LINE, 16), onVG = lineOf(VG_LINE, 26), onAqueduto = lineOf(AQUEDUTO_LINE, 14);
const ways = new Map(), ground = new Map();   // bridge ways; the other roads and tracks (the approaches that ramps follow)
for (const a of areas) {
  const f = path.join(ROOT, 'data/raw', `${a}.osm.json.gz`); if (!fs.existsSync(f)) continue;
  for (const e of loadOverpass(f)) {
    const t = e.tags; if (e.type !== 'way' || !t || !e.geometry || !e.nodes || e.nodes.length !== e.geometry.length || t.area === 'yes') continue;
    if (!(t.highway && ROAD_W[t.highway.replace('_link', '')]) && !RAIL.has(t.railway)) continue;
    if (t.railway === 'abandoned' || t.highway === 'construction' || t.highway === 'proposed') continue;
    const br = t.bridge && t.bridge !== 'no';
    if (br && (t.bridge === 'boardwalk' || t.bridge === 'aqueduct')) continue;
    if (!br && (t.tunnel && t.tunnel !== 'no' || t.location === 'underground')) continue;
    const M = br ? ways : ground, old = M.get(e.id); if (old && old.geo.length >= e.geometry.length) continue;
    M.set(e.id, { id: e.id, t, nodes: e.nodes, geo: e.geometry });
  }
}
const nodeWays = new Map(); for (const w of ground.values()) w.nodes.forEach((nd, i) => (nodeWays.get(nd) || nodeWays.set(nd, []).get(nd)).push([w, i]));
log(`bridge ways ${ways.size}, other ways ${ground.size}`);

const kindOf = (t) => t.railway ? (t.railway === 'tram' || t.railway === 'funicular' ? 'tram' : t.railway === 'subway' || t.railway === 'light_rail' ? 'metro' : 'rail')
  : ['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'bridleway', 'track'].includes(t.highway) ? 'foot' : 'road';
// carriageway width: mapped width, else lanes, else the class default; decks add a kerb and a parapet each side
const roadW = (t, k) => {
  if (k === 'rail') return 4.6;   // one track with its walkway (OSM maps each track of a pair as its own way)
  if (k === 'metro') return 4.4;
  if (k === 'tram') return 3.2;
  const w = parseMeters(t.width); if (w && w > 1 && w < 40) return w;
  const ln = parseInt(t.lanes, 10); if (ln > 0 && ln < 10) return ln * 3.3 + (k === 'road' ? 1 : 0);
  return ROAD_W[t.highway.replace('_link', '')] ?? 6;
};
const layerOf = (t) => { const v = parseFloat(t.layer); return Number.isFinite(v) ? v : 1; };

const B = [...ways.values()].map((w) => {
  const pts0 = w.geo.map((p) => proj.fwd(p.lat, p.lon)), k = kindOf(w.t);
  // densify to ≤ 6 m and drop duplicate points
  const pts = [], nodeAt = [];
  for (let i = 0; i < pts0.length; i++) {
    if (i) { const [ax, ay] = pts0[i - 1], [bx, by] = pts0[i], d = Math.hypot(bx - ax, by - ay); if (d < 0.05) continue; const n = Math.ceil(d / 6); for (let j = 1; j < n; j++) { pts.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]); nodeAt.push(null); } }
    pts.push(pts0[i]); nodeAt.push(w.nodes[i] ?? null);
  }
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { id: w.id, t: w.t, k, w: roadW(w.t, k), layer: layerOf(w.t), pts, cum, len: cum[cum.length - 1], n0: w.nodes[0], n1: w.nodes[w.nodes.length - 1], authored: pts.filter(([x, y]) => onPonte(x, y) || onVG(x, y) || onAqueduto(x, y)).length >= pts.length * 0.5 };
}).filter((b) => b.pts.length >= 2 && b.len > 1 && !b.authored);
log(`decks to profile ${B.length}`);

// spatial hash of deck segments: crossings, parallel neighbours
const CELL = 40, grid = new Map();
const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
B.forEach((b, bi) => { for (let i = 0; i + 1 < b.pts.length; i++) { const [ax, ay] = b.pts[i], [bx, by] = b.pts[i + 1]; for (const k of new Set([cellKey(ax, ay), cellKey(bx, by), cellKey((ax + bx) / 2, (ay + by) / 2)])) (grid.get(k) || grid.set(k, []).get(k)).push([bi, i]); } });
const near = (x, y, r) => { const out = []; for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++) for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++) for (const s of grid.get(`${gx},${gy}`) || []) out.push(s); return out; };
const segDist = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1))); return { d: Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y), t }; };
const dirAt = (b, i) => { const a = b.pts[Math.max(0, i - 1)], c = b.pts[Math.min(b.pts.length - 1, i + 1)], l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; return [(c[0] - a[0]) / l, (c[1] - a[1]) / l]; };
const pq = (arr, q) => { const s = arr.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))] : NaN; };

// ─── pass 1: raw deck surface along each way ───
let nLow = 0, nFallback = 0;
// lateral: 'median' for decks (one lane of lorries should not lift it), 'min' for ramps (a single bare lane of road
// beside the line means the road is down on the ground there, not up on a structure)
function profile(b, lateral = 'median') {
  const n = b.pts.length, raw = new Array(n).fill(NaN), g = new Array(n).fill(NaN), lat = Math.min(4, b.w * 0.3);
  for (let i = 0; i < n; i++) {
    const [x, y] = b.pts[i], [ux, uy] = dirAt(b, i), vals = [];
    // a higher deck crossing over this one hides it from the survey: those samples are unknown
    let hidden = false;
    for (const [bj, sj] of near(x, y, 30)) {
      const o = B[bj]; if (o === b || o.layer <= b.layer) continue;
      if (segDist(x, y, o.pts[sj], o.pts[sj + 1]).d < o.w / 2 + 2.5) { hidden = true; break; }
    }
    if (onPonte(x, y) || onVG(x, y)) hidden = true;
    let gs = [];
    for (const f of [-1, -0.5, 0, 0.5, 1]) { const q = lidar(x - uy * lat * f, y + ux * lat * f); gs.push(q.g); if (!hidden && Number.isFinite(q.g)) vals.push(q.g + q.h); }
    g[i] = pq(gs, 0.5);
    raw[i] = vals.length >= 3 ? pq(vals, lateral === 'min' ? 0 : 0.5) : NaN;
  }
  // cars, lorries, lamp posts on the deck: the low quartile over ±5 m
  const lowq = raw.map((_, i) => { const w = []; for (let j = 0; j < n; j++) if (Math.abs(b.cum[j] - b.cum[i]) <= 5) w.push(raw[j]); return pq(w, 0.25); });
  b.raw = lowq; b.g = g;
}
for (const b of B) profile(b);

// ─── ramps: where a bridge lands on a walled ramp or a fill the survey's ground filter left out, the road it joins
// is still up in the air for a while. Follow that road outwards while the surface stands > 0.8 m over the terrain:
// that stretch is drawn as a solid ramp (walls down to the ground) and its far end is where the deck really lands.
const mkB = (id, t, pts, nodeAt, extra) => {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const k = kindOf(t); return { id, t, k, w: roadW(t, k), layer: 0, pts, cum, len: cum[cum.length - 1], ...extra };
};
const ramps = [], rampedWays = new Set();
for (const b of [...B]) for (const end of [0, 1]) {
  const nd = end ? b.n1 : b.n0; if (nd == null || B.some((o) => o !== b && (o.n0 === nd || o.n1 === nd))) continue;
  const n = b.pts.length, [ex, ey] = b.pts[end ? n - 1 : 0], [px, py] = b.pts[end ? n - 2 : 1], el = Math.hypot(ex - px, ey - py) || 1, ux = (ex - px) / el, uy = (ey - py) / el;
  // the joining way that carries on most straight, of the same kind (road / rail)
  let best = null;
  for (const [w, i] of nodeWays.get(nd) || []) for (const dir of [1, -1]) {
    const j = i + dir; if (j < 0 || j >= w.geo.length) continue;
    if (!!w.t.railway !== !!b.t.railway) continue;
    const [qx, qy] = proj.fwd(w.geo[j].lat, w.geo[j].lon), ql = Math.hypot(qx - ex, qy - ey) || 1, c = ((qx - ex) * ux + (qy - ey) * uy) / ql;
    if (c > 0.6 && (!best || c > best.c)) best = { w, i, dir, c };
  }
  if (!best || rampedWays.has(`${best.w.id}:${best.i}:${best.dir}`)) continue;
  // walk it outwards in 3 m steps, at most 150 m or to its end
  const pts = [[ex, ey]], idx = []; let i = best.i, acc = 0, nEnd = null;
  while (acc < 150) {
    const j = i + best.dir; if (j < 0 || j >= best.w.geo.length) { nEnd = best.w.nodes[i]; break; }
    const [ax, ay] = proj.fwd(best.w.geo[i].lat, best.w.geo[i].lon), [cx, cy] = proj.fwd(best.w.geo[j].lat, best.w.geo[j].lon), d = Math.hypot(cx - ax, cy - ay), m = Math.max(1, Math.ceil(d / 3));
    for (let k = 1; k <= m; k++) pts.push([ax + ((cx - ax) * k) / m, ay + ((cy - ay) * k) / m]);
    acc += d; i = j;
    if (j === 0 || j === best.w.geo.length - 1) { nEnd = best.w.nodes[j]; break; }
  }
  if (pts.length < 3) continue;
  const R = mkB(best.w.id, best.w.t, pts, null, { ramp: true }); R.layer = b.layer;
  profile(R, 'min');
  let stop = -1, low = 0;   // first of two samples in a row that sit on the terrain
  for (let k = 0; k < R.pts.length; k++) { const up = R.raw[k] - R.g[k]; if (!Number.isFinite(up)) continue; if (!(up > 0.8)) { if (++low >= 2) { stop = k - 1; break; } } else low = 0; }
  if (stop < 0) stop = R.pts.length - 1; else nEnd = null;
  if (R.cum[stop] < 6) continue;
  const keep = R.pts.slice(0, stop + 1), Rr = mkB(best.w.id, best.w.t, keep, null, { ramp: true, n0: nd, n1: nEnd });
  Rr.layer = b.layer;
  rampedWays.add(`${best.w.id}:${best.i}:${best.dir}`);
  if (nEnd != null) { const ii = best.w.nodes.indexOf(nEnd); rampedWays.add(`${best.w.id}:${ii}:${-best.dir}`); }
  ramps.push(Rr);
}
B.forEach((b, bi) => b.bi = bi);
for (const R of ramps) { const bi = B.length; B.push(R); for (let i = 0; i + 1 < R.pts.length; i++) { const [ax, ay] = R.pts[i], [bx, by] = R.pts[i + 1]; for (const k of new Set([cellKey(ax, ay), cellKey(bx, by)])) (grid.get(k) || grid.set(k, []).get(k)).push([bi, i]); } profile(R, 'min'); }
log(`ramps ${ramps.length} (${ramps.reduce((a, r) => a + r.len, 0).toFixed(0)} m)`);
// the level where each end lands: on the ground (the road it joins) or on the next deck (a viaduct split in several ways)
const ends = new Map();   // node id → [ { b, end } ]
for (const b of B) for (const [nd, end] of [[b.n0, 0], [b.n1, 1]]) if (nd != null) (ends.get(nd) || ends.set(nd, []).get(nd)).push({ b, end });
const endRaw = (b, end) => { const n = b.pts.length, idx = end ? [...Array(n).keys()].reverse() : [...Array(n).keys()]; for (const i of idx) if (Number.isFinite(b.raw[i]) && Math.abs(b.cum[i] - b.cum[idx[0]]) < 15) return b.raw[i]; return NaN; };
// the road it joins runs on outwards: read the ground 3–10 m beyond the end (at the end itself the 4 m survey grid
// already leans into the valley under the first span)
const endGround = (b, end) => {
  const n = b.pts.length, [x, y] = b.pts[end ? n - 1 : 0], [px, py] = b.pts[end ? Math.max(0, n - 2) : Math.min(n - 1, 1)], l = Math.hypot(x - px, y - py) || 1, ux = (x - px) / l, uy = (y - py) / l, v = [];
  for (const d of [3, 5, 7, 10]) v.push(lidar(x + ux * d, y + uy * d).g);
  const out = pq(v, 0.75), at = lidar(x, y).g; return Number.isFinite(out) ? Math.max(out, Number.isFinite(at) ? at : out) : at;
};
for (const b of B) {
  b.anchor = [0, 1].map((end) => {
    const nd = end ? b.n1 : b.n0, mates = (ends.get(nd) || []).filter((m) => m.b !== b);
    if (mates.length) { const v = [endRaw(b, end), ...mates.map((m) => endRaw(m.b, m.end))].filter(Number.isFinite); return { onDeck: true, z: v.length ? v.reduce((a, q) => a + q, 0) / v.length : NaN }; }
    return { onDeck: false, z: endGround(b, end) };
  });
}

// ─── pass 2: final profile ───
const sstep = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
for (const b of B) {
  const n = b.pts.length, z = b.raw.slice();
  let [A0, A1] = b.anchor.map((a) => a.z);
  if (!Number.isFinite(A0)) A0 = endRaw(b, 0); if (!Number.isFinite(A1)) A1 = endRaw(b, 1);
  if (!Number.isFinite(A0)) A0 = A1; if (!Number.isFinite(A1)) A1 = A0;
  const lerpA = (i) => A0 + ((A1 - A0) * b.cum[i]) / (b.len || 1);
  // a deck the survey doesn't show (newer than 2024, or the filter kept it as ground) reads as the valley floor while
  // its ends stand well above: that is no deck
  for (let i = 0; i < n; i++) if (Number.isFinite(z[i]) && Number.isFinite(A0) && lerpA(i) - z[i] > 3 && z[i] - b.g[i] < 0.6) { z[i] = NaN; nLow++; }
  const ok = z.filter(Number.isFinite).length;
  if (ok < Math.max(1, n * 0.25)) {   // no survey: straight between the ends, over whatever lies beneath
    nFallback++;
    for (let i = 0; i < n; i++) z[i] = Math.max(Number.isFinite(A0) ? lerpA(i) : 4, (Number.isFinite(b.g[i]) ? b.g[i] : 0) + (b.layer >= 1 && b.len > 25 ? 5.5 : 1));
  } else {   // fill the gaps linearly between surveyed stretches
    for (let i = 0; i < n; i++) if (!Number.isFinite(z[i])) {
      let a = i - 1; while (a >= 0 && !Number.isFinite(z[a])) a--;
      let c = i + 1; while (c < n && !Number.isFinite(z[c])) c++;
      const za = a >= 0 ? z[a] : Number.isFinite(A0) ? A0 : z[c], zc = c < n ? z[c] : Number.isFinite(A1) ? A1 : za;
      const sa = a >= 0 ? b.cum[a] : 0, sc = c < n ? b.cum[c] : b.len;
      z[i] = za + ((zc - za) * (b.cum[i] - sa)) / ((sc - sa) || 1);
    }
  }
  // smooth (±7 m), then bend the ends onto where they land
  let sm = z.map((_, i) => { let s = 0, w = 0; for (let j = 0; j < n; j++) { const d = Math.abs(b.cum[j] - b.cum[i]); if (d <= 7) { const k = 1 - d / 8; s += z[j] * k; w += k; } } return s / w; });
  const blend = Math.min(12, b.len / 2.2);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(A0)) sm[i] += (A0 - sm[0]) * (1 - sstep(0, blend, b.cum[i]));
    if (Number.isFinite(A1)) sm[i] += (A1 - sm[n - 1]) * (1 - sstep(0, blend, b.len - b.cum[i]));
  }
  // never below the ground it stands on
  b.z = sm.map((v, i) => Math.max(v, Number.isFinite(b.g[i]) ? b.g[i] + 0.15 : v));
}

// ─── side widths: parallel decks at a similar level meet in the middle, without parapets between them ───
for (const b of B) {
  const n = b.pts.length, hw = b.w / 2 + (b.k === 'road' ? 1.1 : b.k === 'foot' ? 0.35 : 0.6);
  b.hwL = new Array(n).fill(hw); b.hwR = new Array(n).fill(hw); b.pL = new Array(n).fill(1); b.pR = new Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const [x, y] = b.pts[i], [ux, uy] = dirAt(b, i);
    for (const [bj, sj] of near(x, y, 30)) {
      const o = B[bj]; if (o === b) continue;
      const a = o.pts[sj], c = o.pts[sj + 1], dl = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1, ox = (c[0] - a[0]) / dl, oy = (c[1] - a[1]) / dl;
      if (Math.abs(ux * ox + uy * oy) < 0.9) continue;   // crossing, not parallel
      const { d, t } = segDist(x, y, a, c); if (d < 0.5) continue;
      const zo = o.z[sj] + (o.z[sj + 1] - o.z[sj]) * t; if (Math.abs(zo - b.z[i]) > 1.6) continue;
      const ohw = o.w / 2 + 1, gap = d - hw - ohw; if (gap > 1.2) continue;
      const side = (a[0] + (c[0] - a[0]) * t - x) * -uy + (a[1] + (c[1] - a[1]) * t - y) * ux;   // + = left
      const half = Math.max(1, d * (hw / (hw + ohw)) + 0.05);
      if (side > 0) { b.hwL[i] = Math.min(b.hwL[i], half); b.pL[i] = 0; } else { b.hwR[i] = Math.min(b.hwR[i], half); b.pR[i] = 0; }
    }
  }
}

// ─── out ───
const r2 = (v) => Math.round(v * 100) / 100;
const out = B.map((b) => ({
  id: `w${b.id}`, k: b.k, ramp: b.ramp ? 1 : 0, hw: b.t.highway || b.t.railway, layer: b.layer, name: b.t.name || '', tracks: b.k === 'rail' || b.k === 'metro' ? 1 : 0,
  pts: b.pts.map(([x, y]) => [r2(x), r2(y)]), z: b.z.map(r2), g: b.g.map((v) => (Number.isFinite(v) ? r2(v) : null)),
  hwL: b.hwL.map(r2), hwR: b.hwR.map(r2), pL: b.pL.join(''), pR: b.pR.join(''), onDeck: b.anchor.map((a) => (a.onDeck ? 1 : 0)),
}));
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/decks.json'), JSON.stringify({ built: new Date().toISOString(), decks: out }));
const clear = out.map((d) => Math.max(...d.z.map((v, i) => (d.g[i] == null ? 0 : v - d.g[i]))));
log(`decks ${out.length}: ${clear.filter((c) => c > 4).length} stand > 4 m clear, ${clear.filter((c) => c < 1).length} at grade; ${nLow} samples read as ground, ${nFallback} without survey; ${(out.reduce((a, d) => a + d.pts.length, 0))} vertices, ${(fs.statSync(path.join(ROOT, 'data/decks.json')).size / 1024).toFixed(0)} KB`);
if (process.env.DBG_ID) for (const b of B.filter((q) => `w${q.id}` === process.env.DBG_ID)) for (const end of [0, 1]) {
  const n = b.pts.length, [x, y] = b.pts[end ? n - 1 : 0], [px, py] = b.pts[end ? n - 2 : 1], l = Math.hypot(x - px, y - py), ux = (x - px) / l, uy = (y - py) / l;
  console.log(`end ${end} z ${b.z[end ? n - 1 : 0].toFixed(1)}:`, [-12, -6, -3, 0, 3, 6, 10, 15, 20, 30, 45, 60].map((dd) => { const q = lidar(x + ux * dd, y + uy * dd); return `${dd}:${q.g.toFixed(1)}/${(q.g + q.h).toFixed(1)}`; }).join('  '));
}
if (process.env.DBG_ID) { const b = B.find((q) => `w${q.id}` === process.env.DBG_ID && !q.ramp); for (const R of B.filter((q) => q.ramp && (q.n0 === b.n0 || q.n0 === b.n1))) console.log('ramp', R.id, R.len.toFixed(0), 'z', R.z.map((v) => v.toFixed(1)).join(' '), '\n g', R.g.map((v) => v.toFixed(1)).join(' '));
  for (const nd of [b.n0, b.n1]) console.log('node', nd, (nodeWays.get(nd) || []).map(([w, i]) => `${w.id}@${i}/${w.geo.length} ${w.t.highway}`)); }
