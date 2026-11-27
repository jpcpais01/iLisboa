// The river, as data for the viewer: node pipeline/water/build.mjs
//  · public/water/river.png — one RGBA texture over the whole diorama, 20 m a pixel (x east, rows north → south):
//      R water (the tiles' own 1 m masks, averaged), G depth (EMODnet DTM, √-encoded, 0–40 m), B distance to the shore
//      (4 m a step, 0–1 km), A distance into the land (same scale; the water shader ignores it, boats keep off).
//  · public/water/ships.json — what the boats need from OpenStreetMap: Transtejo/Soflusa ferry lines and terminals,
//    marinas, port terminals (container, cruise, multipurpose) with their quay edges, and a few lanes.
// Inputs: public/tiles/*/water.png + index.json, pipeline/water/raw/bathy.tif (fetch-water Action), data/raw/*.osm.json.gz.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { fromFile } from 'geotiff';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'public/water');
fs.mkdirSync(OUT, { recursive: true });
const LAT0 = 38.71375, LON0 = -9.13975, P = (LAT0 * Math.PI) / 180;
const M_LAT = 111132.92 - 559.82 * Math.cos(2 * P) + 1.175 * Math.cos(4 * P), M_LON = 111412.84 * Math.cos(P) - 93.5 * Math.cos(3 * P);
const fwd = (lat, lon) => [(lon - LON0) * M_LON, (lat - LAT0) * M_LAT];
const inv = (x, y) => [LAT0 + y / M_LAT, LON0 + x / M_LON];

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/tiles/index.json')));
let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
for (const a of index.areas) { minX = Math.min(minX, a.bounds.minX); minY = Math.min(minY, a.bounds.minY); maxX = Math.max(maxX, a.bounds.maxX); maxY = Math.max(maxY, a.bounds.maxY); }
const R = 20, W = Math.ceil((maxX - minX) / R), H = Math.ceil((maxY - minY) / R);
console.log(`river grid ${W}×${H} at ${R} m, x ${minX.toFixed(0)}…${maxX.toFixed(0)}, y ${minY.toFixed(0)}…${maxY.toFixed(0)}`);

// ─── water fraction from the tiles' masks ───
const wsum = new Float32Array(W * H), wn = new Float32Array(W * H);
for (const a of index.areas) {
  const f = path.join(ROOT, 'public/tiles', a.area, 'water.png');
  if (!fs.existsSync(f)) continue;
  const { data, info } = await sharp(f).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const sx = (a.bounds.maxX - a.bounds.minX) / info.width, sy = (a.bounds.maxY - a.bounds.minY) / info.height;
  for (let y = 0; y < info.height; y += 2) {
    const wy = a.bounds.maxY - (y + 0.5) * sy, j = Math.floor((maxY - wy) / R);
    if (j < 0 || j >= H) continue;
    for (let x = 0; x < info.width; x += 2) {
      const wx = a.bounds.minX + (x + 0.5) * sx, i = Math.floor((wx - minX) / R);
      if (i < 0 || i >= W) continue;
      wsum[j * W + i] += data[y * info.width + x] > 127 ? 1 : 0; wn[j * W + i]++;
    }
  }
}
const water = new Float32Array(W * H);
for (let k = 0; k < W * H; k++) water[k] = wn[k] ? wsum[k] / wn[k] : 0;

// ─── depth: EMODnet DTM (elevation, negative under water, vertical datum ≈ LAT), bilinear ───
const tif = await fromFile(path.join(ROOT, 'pipeline/water/raw/bathy.tif'));
const im = await tif.getImage(), bb = im.getBoundingBox(), BW = im.getWidth(), BH = im.getHeight();
const dem = (await im.readRasters())[0];
function elev(lat, lon) {
  const fx = ((lon - bb[0]) / (bb[2] - bb[0])) * BW - 0.5, fy = ((bb[3] - lat) / (bb[3] - bb[1])) * BH - 0.5;
  const i = Math.max(0, Math.min(BW - 2, Math.floor(fx))), j = Math.max(0, Math.min(BH - 2, Math.floor(fy))), tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j));
  const v = (a, b) => dem[(j + b) * BW + i + a];
  return (v(0, 0) * (1 - tx) + v(1, 0) * tx) * (1 - ty) + (v(0, 1) * (1 - tx) + v(1, 1) * tx) * ty;
}
const depth = new Float32Array(W * H).fill(-1);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const k = j * W + i;
  if (water[k] < 0.05) continue;
  const [lat, lon] = inv(minX + (i + 0.5) * R, maxY - (j + 0.5) * R);
  const e = elev(lat, lon);
  depth[k] = e < 0 ? -e : -1;   // above the datum here: a tidal flat, or a 115 m cell that is mostly quay — fill below
}
// cells the DTM calls land but the map calls water (docks, the quay edge, flats): spread the neighbours' depth in,
// shallowing it a little with each step away; a flat that reaches no surveyed water stays at 0.8 m
for (let pass = 0; pass < 40; pass++) {
  let changed = 0;
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const k = j * W + i;
    if (water[k] < 0.05 || depth[k] >= 0) continue;
    let s = 0, n = 0;
    for (const d of [-1, 1, -W, W]) if (depth[k + d] >= 0 && water[k + d] >= 0.05) { s += depth[k + d]; n++; }
    if (n) { depth[k] = Math.max(0.8, (s / n) * 0.97); changed++; }
  }
  if (!changed) break;
}
for (let k = 0; k < W * H; k++) if (water[k] >= 0.05 && depth[k] < 0) depth[k] = 0.8;

// ─── distance to the shore (water side) and into the land (land side), chamfer 3-4 ───
function chamfer(inside) {
  const d = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) d[k] = inside(k) ? 1e6 : 0;
  const a = R, b = R * Math.SQRT2;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i; if (!d[k]) continue;
    if (i > 0) d[k] = Math.min(d[k], d[k - 1] + a);
    if (j > 0) { d[k] = Math.min(d[k], d[k - W] + a); if (i > 0) d[k] = Math.min(d[k], d[k - W - 1] + b); if (i < W - 1) d[k] = Math.min(d[k], d[k - W + 1] + b); }
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i; if (!d[k]) continue;
    if (i < W - 1) d[k] = Math.min(d[k], d[k + 1] + a);
    if (j < H - 1) { d[k] = Math.min(d[k], d[k + W] + a); if (i < W - 1) d[k] = Math.min(d[k], d[k + W + 1] + b); if (i > 0) d[k] = Math.min(d[k], d[k + W - 1] + b); }
  }
  return d;
}
const shore = chamfer((k) => water[k] >= 0.5), land = chamfer((k) => water[k] < 0.5);
const px = Buffer.alloc(W * H * 4);
for (let k = 0; k < W * H; k++) {
  px[k * 4] = Math.round(water[k] * 255);
  px[k * 4 + 1] = water[k] >= 0.05 ? Math.round(Math.sqrt(Math.min(40, depth[k]) / 40) * 255) : 0;
  px[k * 4 + 2] = Math.min(255, Math.round(shore[k] / 4));
  px[k * 4 + 3] = Math.min(255, Math.round(land[k] / 4));
}
await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'river.png'));

// ─── OpenStreetMap: ferries, terminals, marinas, ports ───
const els = new Map();
for (const f of fs.readdirSync(path.join(ROOT, 'data/raw'))) {
  if (!f.endsWith('.osm.json.gz')) continue;
  for (const e of JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/raw', f)))).elements) {
    const t = e.tags || {};
    if (t.route === 'ferry' || t.amenity === 'ferry_terminal' || t.leisure === 'marina' || t.industrial === 'port' || t.landuse === 'port' || t.harbour || t['seamark:type'] === 'anchorage') els.set(`${e.type}${e.id}`, e);
  }
}
const xy = (g) => g.map((p) => fwd(p.lat, p.lon).map((v) => Math.round(v * 10) / 10));
const ringOf = (e) => {
  if (e.geometry) return xy(e.geometry);
  if (e.members) { const outer = e.members.filter((m) => m.role === 'outer' && m.geometry).flatMap((m) => m.geometry); return outer.length ? xy(outer) : null; }
  if (e.lat != null) return [fwd(e.lat, e.lon)];
  return null;
};
const centre = (r) => { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [Math.round(x / r.length), Math.round(y / r.length)]; };
const inGrid = ([x, y]) => x > minX && x < maxX && y > minY && y < maxY;
const waterAt = (x, y) => { const i = Math.floor((x - minX) / R), j = Math.floor((maxY - y) / R); return i < 0 || j < 0 || i >= W || j >= H ? 0 : water[j * W + i]; };

const terminals = [], seenT = new Set();
for (const e of els.values()) {
  const t = e.tags;
  if (t.amenity !== 'ferry_terminal' || !t.name) continue;
  const r = ringOf(e); if (!r) continue;
  const c = centre(r), key = t.name.replace(/^(Estação|Terminal) Fluvial (do |de |da )?/i, '');
  if (!inGrid(c) || [...seenT].some((s) => s.name === key && Math.hypot(s.c[0] - c[0], s.c[1] - c[1]) < 400)) continue;
  const o = { name: key, c }; seenT.add(o); terminals.push(o);
}
const ferries = [];
for (const e of els.values()) {
  const t = e.tags;
  if (e.type !== 'way' || t.route !== 'ferry' || !e.geometry) continue;
  const line = xy(e.geometry);
  const [a, b] = (t.name || '').split(/\s+[–-]\s+/);
  const dur = /^(\d+):(\d+)/.exec(t.duration || '');
  ferries.push({ id: e.id, name: t.name || '', a: a || t.from || '', b: b || t.to || '', op: t.operator || t.network || '', min: dur ? +dur[1] * 60 + +dur[2] : null, line });
}
const marinas = [], ports = [];
for (const e of els.values()) {
  const t = e.tags, r = ringOf(e);
  if (!r || r.length < 3) continue;
  const c = centre(r);
  if (!inGrid(c)) continue;
  if (t.leisure === 'marina' || /marina|doca/i.test(t.name || '') && (t.harbour || t['seamark:type'] === 'harbour')) {
    // where boats lie: the marina polygon's water cells (a marina is mapped over its basin)
    let wet = 0; const pts = [];
    const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
    for (let y = Math.min(...ys); y < Math.max(...ys); y += 10) for (let x = Math.min(...xs); x < Math.max(...xs); x += 10) if (inside(r, x, y) && waterAt(x, y) > 0.9) { wet++; if (pts.length < 4000) pts.push([Math.round(x), Math.round(y)]); }
    if (wet >= 6) marinas.push({ name: t.name || '', c, area: wet * 100, ring: r });
  } else if (t.industrial === 'port' || t.landuse === 'port') {
    const nm = (t.name || '') + ' ' + (t.cargo || '');
    const kind = /cruz|cruise/i.test(nm) ? 'cruise' : /assist[êe]ncia|reboc|tug|pilot/i.test(nm) ? 'service' : /contentor|container/i.test(nm) ? 'container' : /l[íi]quido|liquid|oil|gas|petro|fuel/i.test(nm) ? 'tanker'
      : /gran[ée]is|granel|bulk|silo|cereal/i.test(nm) ? 'bulk' : 'cargo';
    // the quay: polygon edges with water right outside them, merged into straight runs ≥ 120 m
    const quays = [];
    for (let k = 0; k < r.length - 1; k++) {
      const [x0, y0] = r[k], [x1, y1] = r[k + 1], L = Math.hypot(x1 - x0, y1 - y0);
      if (L < 60) continue;
      const nx = (y1 - y0) / L, ny = -(x1 - x0) / L, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      for (const s of [1, -1]) {
        let wet = 0; for (let q = 0.15; q < 0.9; q += 0.15) wet += waterAt(x0 + (x1 - x0) * q + s * nx * 40, y0 + (y1 - y0) * q + s * ny * 40) > 0.5 ? 1 : 0;
        if (wet >= 4 && !inside(r, mx + s * nx * 40, my + s * ny * 40)) quays.push([Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), s]);
      }
    }
    if (quays.length) ports.push({ name: t.name || '', kind, op: t.operator || '', c, quays });
  }
}
function inside(r, x, y) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
for (const m of marinas) delete m.ring;
const out = { grid: { minX, maxY, R, W, H }, terminals, ferries, marinas, ports, src: 'OpenStreetMap contributors (ODbL); EMODnet Bathymetry DTM (CC-BY)' };
fs.writeFileSync(path.join(OUT, 'ships.json'), JSON.stringify(out));
console.log(`terminals ${terminals.length}: ${terminals.map((t) => t.name).join(', ')}`);
console.log(`ferries ${ferries.length}: ${ferries.map((f) => f.name).join(' | ')}`);
console.log(`marinas ${marinas.length}: ${marinas.map((m) => `${m.name} ${m.area} m²`).join(', ')}`);
console.log(`ports ${ports.length}: ${ports.map((p) => `${p.name} [${p.kind}] ${p.quays.length} quays`).join(' | ')}`);
console.log(`river.png ${fs.statSync(path.join(OUT, 'river.png')).size} B, ships.json ${fs.statSync(path.join(OUT, 'ships.json')).size} B`);
