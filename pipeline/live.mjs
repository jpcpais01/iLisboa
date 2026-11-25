// Static geometry for the live layers (traffic, transit): the city's main roads and the four Metro lines.
//   node pipeline/live.mjs
// Reads every data/raw/<area>.osm.json.gz, writes public/live/{roads.bin, metro.json}. Independent of the tile build.
//
// roads.bin (little-endian): u32 road count, then per road: u8 class, u16 point count, (i16 x, i16 y) × n,
//   x/y in half-metres around the shared projection origin (east, north). Classes: see CLASSES below.
import fs from 'node:fs';
import path from 'node:path';
import { loadOverpass, makeProjection } from './lib/osm.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'public/live');
fs.mkdirSync(OUT, { recursive: true });
const proj = makeProjection(38.71375, -9.13975);   // same origin as pipeline/build.mjs

const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
const classOf = (h) => CLASSES.indexOf(String(h).replace(/_link$/, ''));

const ways = new Map(), nodes = new Map(), rels = new Map();
for (const f of fs.readdirSync(path.join(ROOT, 'data/raw')).filter((f) => f.endsWith('.osm.json.gz'))) {
  for (const e of loadOverpass(path.join(ROOT, 'data/raw', f))) {
    if (e.type === 'node') { if (e.tags) nodes.set(e.id, e); continue; }
    if (e.type === 'relation') { if (e.tags?.route === 'subway') rels.set(e.id, e); continue; }
    if (e.type !== 'way' || !e.geometry) continue;
    const t = e.tags || {};
    const keep = (t.highway && classOf(t.highway) >= 0) || t.railway === 'subway';
    if (!keep) continue;
    const old = ways.get(e.id);
    if (!old || old.geometry.length < e.geometry.length) ways.set(e.id, e);
  }
}

// ─── roads ────────────────────────────────────────────────────────────────
// Douglas–Peucker to 1.5 m: the overlay is a coloured band, not survey data
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > best) { best = d; bi = i; } }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const roads = [];
for (const w of ways.values()) {
  const t = w.tags || {};
  if (!t.highway) continue;
  if (t.tunnel && t.tunnel !== 'no') continue;                        // underground: nothing to colour on the surface
  if (t.area === 'yes' || t.access === 'no') continue;
  if (/25 de Abril/i.test(t.name || '') && t.bridge) continue;        // the bridge deck is authored geometry, high above the ground
  const pts = simplify(w.geometry.map((p) => proj.fwd(p.lat, p.lon)), 1.5);
  if (pts.length < 2) continue;
  roads.push({ c: classOf(t.highway), oneway: t.oneway === 'yes' || t.junction === 'roundabout', pts });
}
let bytes = 4; for (const r of roads) bytes += 3 + r.pts.length * 4;
const buf = Buffer.alloc(bytes); let o = 0;
buf.writeUInt32LE(roads.length, o); o += 4;
const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 2)));
for (const r of roads) {
  buf.writeUInt8(r.c | (r.oneway ? 0x80 : 0), o); o += 1;
  buf.writeUInt16LE(r.pts.length, o); o += 2;
  for (const [x, y] of r.pts) { buf.writeInt16LE(q(x), o); buf.writeInt16LE(q(y), o + 2); o += 4; }
}
fs.writeFileSync(path.join(OUT, 'roads.bin'), buf);
console.log(`roads: ${roads.length} ways, ${(bytes / 1024).toFixed(0)} KB`, CLASSES.map((c, i) => `${c} ${roads.filter((r) => r.c === i).length}`).join(', '));

// ─── Metro ────────────────────────────────────────────────────────────────
// one route relation per line (the "A → B" direction listed first); its way members in order make the track,
// its stop members in order make the stations. Ways outside the extracts are bridged with a straight segment.
const lines = new Map();
for (const r of [...rels.values()].sort((a, b) => a.id - b.id)) {
  const name = (r.tags.name || '').split(':')[0].trim();
  if (!name || lines.has(name)) continue;
  const track = [];
  for (const m of r.members.filter((m) => m.type === 'way' && !m.role)) {
    const w = ways.get(m.ref); if (!w) continue;
    let pts = w.geometry.map((p) => proj.fwd(p.lat, p.lon));
    if (track.length) {
      const [lx, ly] = track[track.length - 1];
      const d0 = Math.hypot(pts[0][0] - lx, pts[0][1] - ly), d1 = Math.hypot(pts[pts.length - 1][0] - lx, pts[pts.length - 1][1] - ly);
      if (d1 < d0) pts = pts.reverse();
      if (track.length === 1 || Math.min(d0, d1) > 5) {
        // the first way may itself be backwards: flip the track if that joins better
        const [fx, fy] = track[0];
        if (track.length > 1 && Math.hypot(pts[0][0] - fx, pts[0][1] - fy) < Math.min(d0, d1) - 1) track.reverse();
      }
    }
    for (const p of pts) { const l = track[track.length - 1]; if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.5) track.push(p); }
  }
  const stops = [];
  for (const m of r.members.filter((m) => m.type === 'node' && m.role.startsWith('stop'))) {
    const n = nodes.get(m.ref); if (!n) continue;
    stops.push({ name: n.tags.name || '', p: proj.fwd(n.lat, n.lon) });
  }
  if (track.length < 2 || stops.length < 2) { console.log('metro: skipped', name, track.length, stops.length); continue; }
  // stations ordered along the track by their nearest point on it (distance along, in metres)
  const cum = [0]; for (let i = 1; i < track.length; i++) cum.push(cum[i - 1] + Math.hypot(track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1]));
  const along = ([x, y]) => {
    let best = Infinity, s = 0;
    for (let i = 0; i + 1 < track.length; i++) {
      const [ax, ay] = track[i], [bx, by] = track[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
      if (d < best) { best = d; s = cum[i] + t * Math.sqrt(L2); }
    }
    return { s, off: best };
  };
  const st = stops.map((s) => ({ name: s.name, ...along(s.p) })).filter((s) => s.off < 250);
  lines.set(name, {
    name, colour: r.tags.colour || '#888888',
    track: simplify(track, 2).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
    stops: st.map((s) => ({ name: s.name, s: Math.round(s.s) })),
    length: Math.round(cum[cum.length - 1]),
  });
}
fs.writeFileSync(path.join(OUT, 'metro.json'), JSON.stringify({ origin: { lat: 38.71375, lon: -9.13975 }, lines: [...lines.values()] }));
for (const l of lines.values()) console.log(`metro: ${l.name} ${l.colour} ${(l.length / 1000).toFixed(1)} km, ${l.stops.length} stops: ${l.stops[0].name} → ${l.stops[l.stops.length - 1].name}`);
