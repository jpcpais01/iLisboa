// Street and tram-rail network for the live vehicles: buses snap to streets and trams to rails, and between GPS fixes
// they drive along this graph instead of cutting straight through blocks.
//   node pipeline/network.mjs   → public/live/net.bin
// net.bin (little-endian): u32 V, V × (i16 x, i16 y) junctions in half-metres; u32 E, per edge:
//   u32 a, u32 b, u8 kind (0 street, 1 major street, 2 tram/funicular rail), u16 n, n × (i16 x, i16 y) inner points.
import fs from 'node:fs';
import path from 'node:path';
import { loadOverpass, makeProjection } from './lib/osm.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const proj = makeProjection(38.71375, -9.13975);
const MAJOR = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link']);
const MINOR = new Set(['unclassified', 'residential', 'living_street', 'busway', 'bus_guideway', 'road']);
const kindOf = (t) => {
  if (t.railway === 'tram' || t.railway === 'funicular') return 2;
  if (!t.highway || (t.area === 'yes')) return -1;
  if (MAJOR.has(t.highway)) return 1;
  if (MINOR.has(t.highway)) return 0;
  if (t.highway === 'service' && t.service !== 'parking_aisle' && t.service !== 'driveway' && t.access !== 'private') return 0;
  if (t.highway === 'pedestrian' && (t.bus === 'yes' || t.psv === 'yes')) return 0;
  return -1;
};
const ways = new Map(), coord = new Map();
for (const f of fs.readdirSync(path.join(ROOT, 'data/raw')).filter((f) => f.endsWith('.osm.json.gz'))) {
  for (const e of loadOverpass(path.join(ROOT, 'data/raw', f))) {
    if (e.type !== 'way' || !e.geometry || !e.nodes || e.nodes.length !== e.geometry.length) continue;
    const k = kindOf(e.tags || {});
    if (k < 0) continue;
    const old = ways.get(e.id);
    if (!old || old.nodes.length < e.nodes.length) ways.set(e.id, { k, nodes: e.nodes, geo: e.geometry });
  }
}
// junctions: nodes used by two or more ways, plus every way end
const uses = new Map();
for (const w of ways.values()) w.nodes.forEach((n, i) => { uses.set(n, (uses.get(n) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)); });
const vid = new Map(), V = [];
const vertex = (n, p) => { let i = vid.get(n); if (i == null) { i = V.length; vid.set(n, i); V.push(proj.fwd(p.lat, p.lon)); } return i; };
// Douglas–Peucker (1 m) on the inner points of each edge
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > best) { best = d; bi = i; } }
    if (best > tol) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const E = [];
for (const w of ways.values()) {
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    if (i < w.nodes.length - 1 && (uses.get(w.nodes[i]) || 0) < 2) continue;
    const a = vertex(w.nodes[start], w.geo[start]), b = vertex(w.nodes[i], w.geo[i]);
    const pts = simplify(w.geo.slice(start, i + 1).map((p) => proj.fwd(p.lat, p.lon)), 1);
    if (a !== b || pts.length > 2) E.push({ a, b, k: w.k, inner: pts.slice(1, -1) });
    start = i;
  }
}
let bytes = 4 + V.length * 4 + 4; for (const e of E) bytes += 11 + e.inner.length * 4;
const buf = Buffer.alloc(bytes); let o = 0;
const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 2)));
buf.writeUInt32LE(V.length, o); o += 4;
for (const [x, y] of V) { buf.writeInt16LE(q(x), o); buf.writeInt16LE(q(y), o + 2); o += 4; }
buf.writeUInt32LE(E.length, o); o += 4;
for (const e of E) {
  buf.writeUInt32LE(e.a, o); buf.writeUInt32LE(e.b, o + 4); buf.writeUInt8(e.k, o + 8); buf.writeUInt16LE(e.inner.length, o + 9); o += 11;
  for (const [x, y] of e.inner) { buf.writeInt16LE(q(x), o); buf.writeInt16LE(q(y), o + 2); o += 4; }
}
fs.mkdirSync(path.join(ROOT, 'public/live'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public/live/net.bin'), buf);
console.log(`network: ${ways.size} ways → ${V.length} junctions, ${E.length} edges (${[0, 1, 2].map((k) => E.filter((e) => e.k === k).length).join('/')} street/major/rail), ${(bytes / 1024).toFixed(0)} KB`);
