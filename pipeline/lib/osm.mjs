// OSM (Overpass "out body geom") → clean local-metre geometry.
import zlib from 'node:zlib';
import fs from 'node:fs';

export function loadOverpass(file) {
  const buf = fs.readFileSync(file);
  const json = JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf);
  return json.elements;
}

// Local tangent-plane projection around (lat0, lon0). x = east (m), y = north (m).
export function makeProjection(lat0, lon0) {
  const p = (lat0 * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
  const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
  return {
    fwd: (lat, lon) => [(lon - lon0) * mLon, (lat - lat0) * mLat],
    inv: (x, y) => [lat0 + y / mLat, lon0 + x / mLon],
  };
}

const key = (pt) => `${pt.lat.toFixed(7)},${pt.lon.toFixed(7)}`;

// Join way fragments (arrays of {lat,lon}) into closed rings.
function joinRings(lines) {
  const rings = [];
  const pool = lines.filter((l) => l && l.length >= 2).map((l) => l.slice());
  while (pool.length) {
    let ring = pool.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const end = key(ring[ring.length - 1]);
      const i = pool.findIndex((l) => key(l[0]) === end || key(l[l.length - 1]) === end);
      if (i < 0) break;
      let next = pool.splice(i, 1)[0];
      if (key(next[0]) !== end) next = next.reverse();
      ring = ring.concat(next.slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

const area2 = (r) => {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
export const ringArea = area2;

const pointInRing = (x, y, r) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
export { pointInRing };

// Remove closing duplicate, near-duplicates and collinear points. Input/Output: open ring [[x,y],...]
export function cleanRing(ring, eps = 0.15) {
  let pts = [];
  for (const p of ring) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) pts.push(p);
  }
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) pts.pop();
  }
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cross) / len < 0.05) { pts.splice(i, 1); changed = true; i--; }
    }
  }
  return pts.length >= 3 ? pts : null;
}

// Returns polygons: [{ outer:[[x,y]..] (CCW), holes:[[..] (CW)], tags, id }]
export function extractPolygons(elements, proj, filter) {
  const out = [];
  const P = (g) => g.map((pt) => proj.fwd(pt.lat, pt.lon));
  for (const el of elements) {
    if (!el.tags || !filter(el.tags, el)) continue;
    if (el.type === 'way' && el.geometry && el.nodes && el.nodes[0] === el.nodes[el.nodes.length - 1]) {
      const r = cleanRing(P(el.geometry));
      if (r) out.push(orient({ outer: r, holes: [], tags: el.tags, id: `w${el.id}` }));
    } else if (el.type === 'relation' && el.tags.type === 'multipolygon' && el.members) {
      const ways = el.members.filter((m) => m.type === 'way' && m.geometry);
      const outers = joinRings(ways.filter((m) => m.role !== 'inner').map((m) => m.geometry)).map((r) => cleanRing(P(r))).filter(Boolean);
      const inners = joinRings(ways.filter((m) => m.role === 'inner').map((m) => m.geometry)).map((r) => cleanRing(P(r))).filter(Boolean);
      outers.forEach((o, i) => {
        const holes = inners.filter((h) => pointInRing(h[0][0], h[0][1], o));
        out.push(orient({ outer: o, holes, tags: el.tags, id: `r${el.id}_${i}` }));
      });
    }
  }
  return out;
}

function orient(poly) {
  if (area2(poly.outer) < 0) poly.outer.reverse();
  poly.holes.forEach((h) => { if (area2(h) > 0) h.reverse(); });
  poly.area = area2(poly.outer) + poly.holes.reduce((s, h) => s + area2(h), 0);
  let cx = 0, cy = 0;
  poly.outer.forEach(([x, y]) => { cx += x; cy += y; });
  poly.c = [cx / poly.outer.length, cy / poly.outer.length];
  return poly;
}

// Polylines: [{pts:[[x,y]..], tags, id}]
export function extractLines(elements, proj, filter) {
  return elements
    .filter((el) => el.type === 'way' && el.tags && el.geometry && filter(el.tags, el))
    .map((el) => ({ pts: el.geometry.map((p) => proj.fwd(p.lat, p.lon)), tags: el.tags, id: `w${el.id}` }));
}

export function extractNodes(elements, proj, filter) {
  return elements
    .filter((el) => el.type === 'node' && el.tags && filter(el.tags, el))
    .map((el) => ({ p: proj.fwd(el.lat, el.lon), tags: el.tags, id: `n${el.id}` }));
}

export function parseMeters(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');
  const m = s.match(/^(-?[\d.]+)\s*(m|ft|')?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  return m[2] === 'ft' || m[2] === "'" ? n * 0.3048 : n;
}
