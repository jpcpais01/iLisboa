// Street furniture for the station markers, from the OSM extracts (no network):
//   node pipeline/stations.mjs   → public/transit/osm.json
//   e: Metro entrances [x, y, angle, station name, wheelchair]   angle = direction of the street it opens onto
//   s: bus stops       [x, y, angle, shelter 0/1, ref]            angle = kerb direction; GTFS stops borrow shelter + kerb
// Re-run after new OSM extracts (data/raw). Positions on the diorama plane (api/_lib/geo.js).
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fwd } from '../api/_lib/geo.js';

const seen = new Set(), ent = [], stops = [], segs = [];
const CELL = 50, grid = new Map();
const ROAD = /^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|footway|service|trunk|primary_link|secondary_link|tertiary_link)$/;
for (const f of readdirSync('data/raw').filter((f) => f.endsWith('.osm.json.gz'))) {
  const els = JSON.parse(gunzipSync(readFileSync(`data/raw/${f}`))).elements;
  for (const e of els) {
    if (seen.has(e.type + e.id)) continue; seen.add(e.type + e.id);
    const t = e.tags || {};
    if (e.type === 'node' && t.railway === 'subway_entrance') ent.push({ p: fwd(e.lat, e.lon), name: t.name || '', wc: t.wheelchair === 'yes' ? 1 : 0 });
    else if (e.type === 'node' && (t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes'))) stops.push({ p: fwd(e.lat, e.lon), sh: t.shelter === 'yes' ? 1 : 0, ref: t.ref || '' });
    else if (e.type === 'way' && ROAD.test(t.highway || '') && e.geometry) {
      const foot = /footway|pedestrian/.test(t.highway) && t.footway !== 'crossing' ? 1 : 0;
      if (t.footway === 'crossing') continue;
      const g = e.geometry.map((n) => fwd(n.lat, n.lon));
      for (let i = 1; i < g.length; i++) {
        const s = [g[i - 1], g[i], foot]; segs.push(s);
        const k = `${Math.floor((g[i][0] + g[i - 1][0]) / 2 / CELL)},${Math.floor((g[i][1] + g[i - 1][1]) / 2 / CELL)}`;
        (grid.get(k) || grid.set(k, []).get(k)).push(s);
      }
    }
  }
}
// direction of the nearest street (roads for bus stops, any walkway for entrances)
function along([x, y], foot) {
  let best = 30, ang = 0;
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [a, b, f] of grid.get(`${cx + i},${cy + j}`) || []) {
    if (!foot && f) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9, u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
    const d = Math.hypot(x - a[0] - dx * u, y - a[1] - dy * u);
    if (d < best) { best = d; ang = Math.atan2(dy, dx); }
  }
  return Math.round(ang * 100) / 100;
}
const r1 = (v) => Math.round(v * 10) / 10;
const out = {
  e: ent.map((e) => [r1(e.p[0]), r1(e.p[1]), along(e.p, true), e.name, e.wc]),
  s: stops.map((s) => [r1(s.p[0]), r1(s.p[1]), along(s.p, false), s.sh, s.ref]),
};
mkdirSync('public/transit', { recursive: true });
writeFileSync('public/transit/osm.json', JSON.stringify(out));
console.log('entrances', out.e.length, 'bus stops', out.s.length, 'sheltered', out.s.filter((s) => s[3]).length, (JSON.stringify(out).length / 1024).toFixed(0) + ' KB');
