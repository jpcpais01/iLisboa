// Landmarks you can tap: every building (or compact historic site) that OpenStreetMap links to Wikidata / Wikipedia.
// Reads every area's raw extract, writes public/landmarks.json for the viewer (src/landmarks.js):
//   { v, items: [[id, name, nameEn, wikidata, wikipedia, kind, cx, cy, ring...], ...] }
// ring = outline in scene metres (x east, y north) relative to (cx, cy), 0.5 m units, flattened [x0,y0,x1,y1,...].
// A wiki-tagged point (a church or museum mapped as a node) lends its name and links to the untagged building it sits in.
// Run: node pipeline/landmarks.mjs   (~20 s; no network)
import fs from 'node:fs';
import path from 'node:path';
import { loadOverpass, makeProjection, extractPolygons, pointInRing } from './lib/osm.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/tiles/index.json'), 'utf8'));
const { lat: lat0, lon: lon0 } = index.areas[0].origin;
const proj = makeProjection(lat0, lon0);

const wiki = (t) => t.wikidata || t.wikipedia;
const isBuilding = (t) => t.building && t.building !== 'no' && !t['building:part'] && t.location !== 'underground';
// compact sites drawn as an area with buildings inside: a castle, a monastery's grounds, a fort
const SITE = (t) => !!(t.historic && /^(castle|fort|monastery|palace|city_gate|tower|church|building|manor|ruins|memorial|monument)$/.test(t.historic))
  || (t.amenity === 'place_of_worship') || /^(museum|attraction)$/.test(t.tourism || '') || /^(tower|lighthouse)$/.test(t.man_made || '');
// things whose wikidata is about something other than the structure
const NOT = (t) => t.highway || t.railway === 'rail' || t.waterway || t.natural || t.boundary || t.place || t.landuse || t.route
  || /^(park|garden|nature_reserve|golf_course|pitch|track)$/.test(t.leisure || '') || t.aeroway === 'aerodrome';
// big structures that carry their own geometry (no buildings inside to check for)
const STRUCT = (t) => t.leisure === 'stadium' || t.man_made === 'bridge';
// wiki links that mark a business rather than a landmark (a bulk import tagged most of Lisbon's hotels)
const TRADE = (t) => /^(hotel|hostel|guest_house|apartment|motel)$/.test(t.tourism || '') || t.shop || t.office === 'diplomatic' || t.diplomatic
  || (t.office && t.office !== 'government') || /^(restaurant|cafe|bar|fast_food|pub|bank|pharmacy|fuel)$/.test(t.amenity || '');
const POINT = (t) => SITE(t) || t.building || t.tourism || t.historic || /^(theatre|arts_centre|library|university|college|townhall|courthouse|hospital|marketplace|fountain|cinema|concert_hall)$/.test(t.amenity || '')
  || t.railway === 'station' || t.public_transport === 'station' || t.office === 'government' || t.government;

const files = fs.readdirSync(path.join(ROOT, 'data/raw')).filter((f) => f.endsWith('.osm.json.gz')).sort();
const polys = new Map(), points = new Map();
for (const f of files) {
  const els = loadOverpass(path.join(ROOT, 'data/raw', f));
  for (const p of extractPolygons(els, proj, (t) => (isBuilding(t) || (wiki(t) && (SITE(t) || STRUCT(t)))) && !NOT(t))) if (!polys.has(p.id)) polys.set(p.id, p);
  for (const e of els) if (e.type === 'node' && e.tags && wiki(e.tags) && POINT(e.tags) && !NOT(e.tags) && !points.has(e.id)) points.set(e.id, { p: proj.fwd(e.lat, e.lon), tags: e.tags });
}

// spatial hash of the buildings, for the point → building match and the "site has buildings" check
const G = 50, grid = new Map(), cell = (x, y) => `${Math.floor(x / G)},${Math.floor(y / G)}`;
const bbox = (r) => r.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
for (const p of polys.values()) {
  p.bb = bbox(p.outer);
  if (!isBuilding(p.tags)) continue;
  for (let i = Math.floor(p.bb[0] / G); i <= Math.floor(p.bb[2] / G); i++) for (let j = Math.floor(p.bb[1] / G); j <= Math.floor(p.bb[3] / G); j++) {
    const k = `${i},${j}`; (grid.get(k) || grid.set(k, []).get(k)).push(p);
  }
}
const inside = (p, x, y) => pointInRing(x, y, p.outer) && !p.holes.some((h) => pointInRing(x, y, h));

const chosen = new Map();   // polygon id → { p, tags (the wiki-bearing ones) }
for (const p of polys.values()) {
  if (!wiki(p.tags) || (TRADE(p.tags) && !p.tags.wikipedia)) continue;
  if (STRUCT(p.tags) && !isBuilding(p.tags)) { if (p.area > 1.5e6) continue; }
  else if (!isBuilding(p.tags)) {   // a site: compact, and with buildings in it
    if (p.area > 120000) continue;
    let has = false;
    for (let i = Math.floor(p.bb[0] / G); i <= Math.floor(p.bb[2] / G) && !has; i++) for (let j = Math.floor(p.bb[1] / G); j <= Math.floor(p.bb[3] / G) && !has; j++)
      has = (grid.get(`${i},${j}`) || []).some((b) => inside(p, b.c[0], b.c[1]));
    if (!has) continue;
  }
  chosen.set(p.id, { p, tags: p.tags });
}
let lent = 0;
for (const { p: [x, y], tags } of points.values()) {
  if (TRADE(tags) && !tags.wikipedia) continue;
  const hits = (grid.get(cell(x, y)) || []).filter((b) => inside(b, x, y));
  if (!hits.length) continue;
  const b = hits.sort((a, c) => a.area - c.area)[0];
  if (chosen.has(b.id) || b.area < 40) continue;
  chosen.set(b.id, { p: b, tags }); lent++;
}

// aqueduct arches and other wiki-tagged elevated lines (the Águas Livres): a 9 m band along every bridge segment
const seenLine = new Set();
for (const f of files) for (const e of loadOverpass(path.join(ROOT, 'data/raw', f))) {
  const t = e.tags;
  if (e.type !== 'way' || !t || !wiki(t) || seenLine.has(e.id) || !(t.historic === 'aqueduct' && t.bridge) || !e.geometry) continue;
  seenLine.add(e.id);
  const pts = e.geometry.map((g) => proj.fwd(g.lat, g.lon)), w = 4.5;
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1;
    L.push([pts[i][0] - (dy / n) * w, pts[i][1] + (dx / n) * w]); R.push([pts[i][0] + (dy / n) * w, pts[i][1] - (dx / n) * w]);
  }
  const outer = [...L, ...R.reverse()], c = outer.reduce((s, q) => [s[0] + q[0] / outer.length, s[1] + q[1] / outer.length], [0, 0]);
  chosen.set(`w${e.id}`, { p: { outer, holes: [], c, area: 0 }, tags: t });
}

// one entry per Wikidata item and polygon; several outlines of the same item (a palace in wings) stay separate entries,
// the viewer groups them by wikidata so the whole thing lights up
const q = (v) => Math.round(v * 2);
const items = [];
for (const [id, { p, tags }] of chosen) {
  const name = tags.name || tags['name:pt'] || tags['name:en'] || tags.official_name || '';
  if (!name && !tags.wikipedia) continue;
  const kind = (tags.leisure === 'stadium' ? 'stadium' : '') || (tags.man_made === 'bridge' ? 'bridge' : '') || tags.historic || (tags.amenity === 'place_of_worship' ? 'worship' : tags.amenity) || tags.tourism || tags.man_made || (tags.building !== 'yes' ? tags.building : '') || '';
  const cx = Math.round(p.c[0]), cy = Math.round(p.c[1]);
  const ring = []; let px = null, py = null;
  for (const [x, y] of p.outer) { const a = q(x - cx), b = q(y - cy); if (a === px && b === py) continue; ring.push(a, b); px = a; py = b; }
  items.push([id, name, tags['name:en'] && tags['name:en'] !== name ? tags['name:en'] : '', tags.wikidata || '', tags.wikipedia || '', kind, cx, cy, ...ring]);
}
items.sort((a, b) => (a[0] < b[0] ? -1 : 1));
const out = path.join(ROOT, 'public/landmarks.json');
fs.writeFileSync(out, JSON.stringify({ v: 1, origin: { lat: lat0, lon: lon0 }, items }));
console.log(`${items.length} landmarks (${lent} named by a point inside) → ${path.relative(ROOT, out)} ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
