// Street and tram-rail network for the live vehicles: buses snap to streets and trams to rails, and between GPS fixes
// they drive along this graph instead of cutting straight through blocks.
//   node pipeline/network.mjs   → public/live/net.bin
// net.bin v2 (little-endian): 'NET2', u32 V, V × (i16 x, i16 y) junctions in half-metres; u32 E, per edge:
//   u32 a, u32 b, u8 kind (0 street, 1 major street, 2 tram/funicular rail), u8 cls (road class, see CLS),
//   u8 flags (1 oneway a→b, 2 bridge, 4 tunnel/underground, 8 deck heights follow, 16 Vasco da Gama deck), u8 lanes (0 unknown),
//   u16 street name (index into the name table, 0 = unnamed), u16 n, n × (i16 x, i16 y) inner points; if flags & 8: (n + 2) × i16 deck height in dm (-32768 = none) for a, inner…, b.
// Street names live in public/live/names.json (array; entry 0 is the empty name), loaded only by what shows them.
// The ambient cars (src/live/cars.js) drive this graph: class sets free-flow speed and volume, oneway and lanes set
// where they drive, and the two authored bridges carry their deck profile so nothing rides the river.
import fs from 'node:fs';
import path from 'node:path';
import { loadOverpass, makeProjection } from './lib/osm.mjs';
import { PONTE_LINE, VG_LINE } from './lib/authored.mjs';

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
// road class: 0 motorway, 1 trunk, 2 primary, 3 secondary, 4 tertiary, 5 residential/unclassified, 6 service/living, 7 bus-only
const CLS = { motorway: 0, motorway_link: 0, trunk: 1, trunk_link: 1, primary: 2, primary_link: 2, secondary: 3, secondary_link: 3, tertiary: 4, tertiary_link: 4, unclassified: 5, residential: 5, road: 5, living_street: 6, service: 6, busway: 7, bus_guideway: 7, pedestrian: 7 };
const clsOf = (t) => (t.railway ? 0 : t.access === 'no' || t.motor_vehicle === 'no' || t.motorcar === 'no' ? 7 : CLS[t.highway] ?? 6);
const onewayOf = (t) => {
  if (t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true') return 1;
  if (t.oneway === '-1' || t.oneway === 'reverse') return -1;
  if (t.oneway === 'no') return 0;
  return t.highway === 'motorway' || t.junction === 'roundabout' || t.junction === 'circular' ? 1 : 0;
};
const names = [''], nameIx = new Map([['', 0]]);
const nameId = (n) => { n = String(n).slice(0, 120); let i = nameIx.get(n); if (i == null) { i = names.length; names.push(n); nameIx.set(n, i); } return i; };
const ways = new Map(), coord = new Map();
for (const f of fs.readdirSync(path.join(ROOT, 'data/raw')).filter((f) => f.endsWith('.osm.json.gz'))) {
  for (const e of loadOverpass(path.join(ROOT, 'data/raw', f))) {
    if (e.type !== 'way' || !e.geometry || !e.nodes || e.nodes.length !== e.geometry.length) continue;
    const k = kindOf(e.tags || {});
    if (k < 0) continue;
    const old = ways.get(e.id);
    if (old && old.nodes.length >= e.nodes.length) continue;
    const t = e.tags || {}, ow = k === 2 ? 0 : onewayOf(t);
    const nodes = ow < 0 ? e.nodes.slice().reverse() : e.nodes, geo = ow < 0 ? e.geometry.slice().reverse() : e.geometry;
    const lanes = Math.min(15, Math.max(0, parseInt(t.lanes, 10) || 0));
    const bridge = !!t.bridge && t.bridge !== 'no', tunnel = t.tunnel === 'yes' || t.tunnel === 'building_passage' || t.covered === 'yes' || t.location === 'underground' || (t.layer && +t.layer < 0 && !bridge);
    ways.set(e.id, { k, nodes, geo, cls: clsOf(t), oneway: ow !== 0, lanes, bridge, tunnel, name: nameId(t.name || t.ref || '') });
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
    if (a !== b || pts.length > 2) E.push({ a, b, k: w.k, cls: w.cls, lanes: w.lanes, name: w.name, flags: (w.oneway ? 1 : 0) | (w.bridge ? 2 : 0) | (w.tunnel ? 4 : 0), pts, inner: pts.slice(1, -1) });
    start = i;
  }
}
// deck heights on the authored bridges: the same profiles as pipeline/lib/authored.mjs ponte25Abril / ponteVascoGama
function line(LL) {
  const pts = LL.map(([la, lo]) => proj.fwd(la, lo)), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const near = (x, y) => {   // { s, d }: arc length of the closest point and distance to it
    let best = { s: 0, d: Infinity };
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      const d = Math.hypot(ax + dx * t - x, ay + dy * t - y); if (d < best.d) best = { s: cum[i] + t * Math.hypot(dx, dy), d };
    }
    return best;
  };
  return { pts, cum, L: cum[cum.length - 1], near };
}
const P25 = line(PONTE_LINE), VG = line(VG_LINE);
const p25Z = (() => { const sNA = P25.cum[19], sSA = P25.cum[22], DECK = 70, g0 = 46.5, g1 = 71.5, L = P25.L;
  return (s) => (s < sNA ? g0 + (DECK - g0) * Math.min(1, Math.pow(s / sNA, 0.6)) : s > sSA ? DECK + (g1 - DECK) * (s - sSA) / (L - sSA) : DECK); })();
const vgZ = (() => { const [s1, s2] = [[38.78583, -9.09057], [38.78529, -9.08578]].map(([la, lo]) => VG.near(...proj.fwd(la, lo)).s).sort((a, b) => a - b), sm = (s1 + s2) / 2, half = (s2 - s1) / 2;
  return (s) => (s >= s1 && s <= s2 ? 50.5 - 2.5 * ((s - sm) / half) ** 2 : s < s1 ? Math.max(12, 48 - 0.036 * (s1 - s)) : Math.max(14, 48 - 0.036 * (s - s2))); })();
let decks = 0;
for (const e of E) {
  if (!(e.flags & 2) || e.k === 2) continue;
  for (const [B, f, tol, vg] of [[P25, p25Z, 16, 0], [VG, vgZ, 24, 16]]) {
    const z = e.pts.map(([x, y]) => { const n = B.near(x, y); return n.d < tol && n.s > 1 && n.s < B.L - 1 ? f(n.s) : NaN; });
    if (z.filter(Number.isFinite).length * 2 >= z.length) { e.z = z; e.flags |= 8 | vg; decks++; break; }
  }
}
let bytes = 4 + 4 + V.length * 4 + 4; for (const e of E) bytes += 16 + e.inner.length * 4 + (e.z ? e.z.length * 2 : 0);
const buf = Buffer.alloc(bytes); let o = 0;
const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 2)));
buf.write('NET2', o, 'latin1'); o += 4;
buf.writeUInt32LE(V.length, o); o += 4;
for (const [x, y] of V) { buf.writeInt16LE(q(x), o); buf.writeInt16LE(q(y), o + 2); o += 4; }
buf.writeUInt32LE(E.length, o); o += 4;
for (const e of E) {
  buf.writeUInt32LE(e.a, o); buf.writeUInt32LE(e.b, o + 4); buf.writeUInt8(e.k, o + 8); buf.writeUInt8(e.cls, o + 9); buf.writeUInt8(e.flags, o + 10); buf.writeUInt8(e.lanes, o + 11); buf.writeUInt16LE(e.name, o + 12); buf.writeUInt16LE(e.inner.length, o + 14); o += 16;
  for (const [x, y] of e.inner) { buf.writeInt16LE(q(x), o); buf.writeInt16LE(q(y), o + 2); o += 4; }
  if (e.z) for (const z of e.z) { buf.writeInt16LE(Number.isFinite(z) ? Math.round(z * 10) : -32768, o); o += 2; }
}
if (o !== bytes) throw new Error(`net.bin size ${o} ≠ ${bytes}`);
fs.mkdirSync(path.join(ROOT, 'public/live'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public/live/net.bin'), buf);
fs.writeFileSync(path.join(ROOT, 'public/live/names.json'), JSON.stringify(names));
console.log(`network: ${ways.size} ways → ${V.length} junctions, ${E.length} edges (${[0, 1, 2].map((k) => E.filter((e) => e.k === k).length).join('/')} street/major/rail, ${E.filter((e) => e.flags & 1).length} one-way, ${E.filter((e) => e.flags & 2).length} bridge (${decks} on authored decks), ${E.filter((e) => e.flags & 4).length} tunnel, ${names.length} names), ${(bytes / 1024).toFixed(0)} KB`);
