// The river, as data for the viewer: node pipeline/water/build.mjs
//  · public/water/river.png — one RGBA texture over the whole diorama, 20 m a pixel (x east, rows north → south):
//      R water (the tiles' own 1 m masks, averaged), G depth (EMODnet DTM, √-encoded, 0–40 m), B distance to the shore
//      (4 m a step, 0–1 km), A opaque.
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
const fine = [];   // the 1 m masks, kept for placing moored boats
const wetFine = (x, y) => {
  for (const m of fine) {
    if (x < m.b.minX || x >= m.b.maxX || y < m.b.minY || y >= m.b.maxY) continue;
    const i = Math.floor(((x - m.b.minX) / (m.b.maxX - m.b.minX)) * m.w), j = Math.floor(((m.b.maxY - y) / (m.b.maxY - m.b.minY)) * m.h);
    return m.data[j * m.w + i] > 127;
  }
  return false;
};
for (const a of index.areas) {
  const f = path.join(ROOT, 'public/tiles', a.area, 'water.png');
  if (!fs.existsSync(f)) continue;
  const { data, info } = await sharp(f).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  fine.push({ b: a.bounds, data, w: info.width, h: info.height });
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
const shore = chamfer((k) => water[k] >= 0.5);
const px = Buffer.alloc(W * H * 4);
for (let k = 0; k < W * H; k++) {
  px[k * 4] = Math.round(water[k] * 255);
  px[k * 4 + 1] = water[k] >= 0.05 ? Math.round(Math.sqrt(Math.min(40, depth[k]) / 40) * 255) : 0;
  px[k * 4 + 2] = Math.min(255, Math.round(shore[k] / 4));
  px[k * 4 + 3] = 255;   // (opaque: a browser canvas premultiplies, so any alpha would eat the other channels)
}
await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'river.png'));

// ─── the open sea beyond the city's areas: public/water/ocean.png over the whole DTM box (≈115 m a pixel): R sea where
// no area covers it (an area draws its own water; the sea runs 60 m under its edge so no seam shows), G √(depth/40) ───
{
  const covered = (x, y) => index.areas.some((a) => x > a.bounds.minX && x < a.bounds.maxX && y > a.bounds.minY && y < a.bounds.maxY);
  const o = Buffer.alloc(BW * BH * 4), sea0 = new Uint8Array(BW * BH);
  for (let j = 0; j < BH; j++) for (let i = 0; i < BW; i++) {
    const [x, y] = fwd(bb[3] - ((j + 0.5) / BH) * (bb[3] - bb[1]), bb[0] + ((i + 0.5) / BW) * (bb[2] - bb[0]));
    // the Atlantic only (west of the Trafaria–Algés line, and off the Caparica coast): past the map's east edge the DTM's upper estuary is a patchwork
    // of survey rectangles that reads as broken geometry, so the map ends there as it does on land
    const lon = bb[0] + ((i + 0.5) / BW) * (bb[2] - bb[0]);
    const lat = bb[3] - ((j + 0.5) / BH) * (bb[3] - bb[1]);
    sea0[j * BW + i] = dem[j * BW + i] < 0 && (lon < -9.235 || (lat < 38.648 && lon < -9.16)) && !covered(x, y) ? 1 : 0;
  }
  for (let j = 0; j < BH; j++) for (let i = 0; i < BW; i++) {
    const k = j * BW + i, e = dem[k];
    // grown by a cell, so the sea runs under the areas' edges (under their own water and ground: it sits lower)
    const sea = e < 0.5 && (sea0[k] || (i > 0 && sea0[k - 1]) || (i < BW - 1 && sea0[k + 1]) || (j > 0 && sea0[k - BW]) || (j < BH - 1 && sea0[k + BW]));
    o[k * 4] = sea ? 255 : 0; o[k * 4 + 1] = sea ? Math.round(Math.sqrt(Math.min(40, Math.max(0, -e)) / 40) * 255) : 0; o[k * 4 + 2] = 0; o[k * 4 + 3] = 255;
  }
  await sharp(o, { raw: { width: BW, height: BH, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'ocean.png'));
  const [x0, y1] = fwd(bb[3], bb[0]), [x1, y0] = fwd(bb[1], bb[2]);
  var oceanBox = { minX: Math.round(x0), minY: Math.round(y0), maxX: Math.round(x1), maxY: Math.round(y1) };
}

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
// published berth counts (Porto de Lisboa / the marinas' own sites): the basin layout alone would fill every dock wall to wall
const CAP = { 'Doca de Alcântara': 440, 'Doca de Santo Amaro': 331, 'Doca de Belém': 161, 'Doca do Bom Sucesso': 163, 'Marina Parque das Nações': 600 };
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
    if (wet >= 6) { let b = berths(r, pts); const cap = CAP[t.name]; if (cap && b.length > cap) b = b.slice(0, cap); marinas.push({ name: t.name || '', c, area: wet * 100, berths: b }); }
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
// moored boats: rows of berths across the basin's long axis, boats lying side by side, bows to the pontoon between rows;
// a berth is used only where a whole hull (and a metre round it) is water on the 1 m mask. [x, y, heading rad, length m]
function berths(r, pts) {
  let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
  let xx = 0, xy2 = 0, yy = 0; for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; xx += dx * dx; xy2 += dx * dy; yy += dy * dy; }
  const th = 0.5 * Math.atan2(2 * xy2, xx - yy), ax = [Math.cos(th), Math.sin(th)], ay = [-ax[1], ax[0]];
  let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
  for (const p of r) { const u = (p[0] - mx) * ax[0] + (p[1] - my) * ax[1], v = (p[0] - mx) * ay[0] + (p[1] - my) * ay[1]; a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
  const out = []; let seed = Math.round(mx * 7 + my * 13);
  const rnd = () => ((seed = (seed * 16807) % 2147483647) & 0xffff) / 65536;
  const ok = (x, y, h, L, B) => { const c = Math.cos(h), s = Math.sin(h); for (let u = -L / 2 - 1; u <= L / 2 + 1; u += 2) for (const v of [-B / 2 - 0.8, 0, B / 2 + 0.8]) if (!wetFine(x + c * u - s * v, y + s * u + c * v) || !inside(r, x + c * u - s * v, y + s * u + c * v)) return false; return true; };
  // rows of boats run along the long axis; each row is a pontoon with boats either side, 26 m apart
  for (let v = b0 + 8; v < b1 - 4; v += 27) for (const side of [-1, 1]) {
    for (let u = a0 + 4; u < a1 - 4;) {
      const L = 8 + rnd() * 9 + (rnd() < 0.12 ? 8 : 0), B = 2.8 + L * 0.22, cv = v + side * (1.2 + L / 2);
      const x = mx + ax[0] * u + ay[0] * cv, y = my + ax[1] * u + ay[1] * cv, h = Math.atan2(ay[1], ay[0]) * 1 + (side > 0 ? Math.PI : 0);
      if (rnd() < 0.9 && ok(x, y, h, L, B)) out.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(h * 1000) / 1000, Math.round(L * 10) / 10]);
      u += B + 1.1;
    }
  }
  return out;
}
function inside(r, x, y) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
const out = { grid: { minX, maxY, R, W, H }, ocean: oceanBox, terminals, ferries, marinas, ports, src: 'OpenStreetMap contributors (ODbL); EMODnet Bathymetry DTM (CC-BY)' };
fs.writeFileSync(path.join(OUT, 'ships.json'), JSON.stringify(out));
console.log(`terminals ${terminals.length}: ${terminals.map((t) => t.name).join(', ')}`);
console.log(`ferries ${ferries.length}: ${ferries.map((f) => f.name).join(' | ')}`);
console.log(`marinas ${marinas.length}: ${marinas.map((m) => `${m.name} ${m.area} m² ${m.berths.length} boats`).join(', ')}`);
console.log(`ports ${ports.length}: ${ports.map((p) => `${p.name} [${p.kind}] ${p.quays.length} quays`).join(' | ')}`);
console.log(`river.png ${fs.statSync(path.join(OUT, 'river.png')).size} B, ships.json ${fs.statSync(path.join(OUT, 'ships.json')).size} B`);
