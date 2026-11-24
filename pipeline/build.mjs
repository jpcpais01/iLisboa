// iLisboa tile builder: OSM + Copernicus DEM → compressed glTF diorama tiles.
//   node pipeline/build.mjs [area]      (areas live in pipeline/areas.txt)
// Output: public/tiles/<area>/{manifest.json, t_<i>_<j>.glb, base.glb, water.png, trees.bin}
globalThis.self ??= globalThis; // straight-skeleton ships a browser-only Wasm build
globalThis.window ??= globalThis;

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fromFile } from 'geotiff';
import { Document, NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { weld, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { loadOverpass, makeProjection, extractPolygons, extractLines, extractNodes, parseMeters, pointInRing, ringArea } from './lib/osm.mjs';
import { Raster, boxBlur } from './lib/raster.mjs';
import { makeSink, markPartyWalls, buildRoofAndWalls, skeletonRoof, roofExtras, obb, KIND, box, wallQuad, triUp } from './lib/buildings.mjs';

const { default: skPkg } = await import('straight-skeleton');
const { SkeletonBuilder } = skPkg;
await SkeletonBuilder.init();

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const AREA = process.argv[2] || 'baixa-alfama';
const areaLine = fs.readFileSync(path.join(ROOT, 'pipeline/areas.txt'), 'utf8').split('\n').find((l) => l.split(/\s+/)[0] === AREA);
if (!areaLine) throw new Error(`unknown area ${AREA}`);
const [S, W, N, E] = areaLine.trim().split(/\s+/).slice(1).map(Number);
const OUT = path.join(ROOT, 'public/tiles', AREA);
fs.mkdirSync(OUT, { recursive: true });

const TILE = 1000;            // tile size (m)
const TEX_PX = 1024;          // ground texture per tile
const GRID = 8;               // terrain mesh spacing (m)
const SS = 0.5;               // ground map supersample (m/px)
const WATER_Y = 0;            // river surface
const BASE_Y = -28;           // diorama base bottom
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ─── projection & extent ────────────────────────────────────────────────
const lat0 = (S + N) / 2, lon0 = (W + E) / 2;
const proj = makeProjection(lat0, lon0);
const [minX] = proj.fwd(lat0, W), [maxX] = proj.fwd(lat0, E);
const [, minY] = proj.fwd(S, lon0), [, maxY] = proj.fwd(N, lon0);
log(`area ${AREA}: ${(maxX - minX).toFixed(0)} × ${(maxY - minY).toFixed(0)} m`);

// ─── terrain (Copernicus GLO-30 DSM → bare-ground estimate) ─────────────
async function loadDEM() {
  const lat = Math.floor(S), lon = Math.floor(W);
  const name = `Copernicus_DSM_COG_10_N${String(lat).padStart(2, '0')}_00_W${String(-lon).padStart(3, '0')}_00_DEM`;
  const file = path.join(ROOT, 'data/cache', `${name}.tif`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    log('downloading DEM', name);
    const r = await fetch(`https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`);
    if (!r.ok) throw new Error(`DEM ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  const img = await (await fromFile(file)).getImage();
  const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
  const pad = 0.004;
  const c0 = Math.floor((W - pad - ox) / rx), c1 = Math.ceil((E + pad - ox) / rx);
  const r0 = Math.floor((N + pad - oy) / ry), r1 = Math.ceil((S - pad - oy) / ry);
  const [ras] = await img.readRasters({ window: [c0, r0, c1, r1] });
  const w = c1 - c0, h = r1 - r0;
  const raw = Float32Array.from(ras);
  // DSM contains buildings & trees: erode (3×3 min over land) then smooth → ground surface.
  const isW = (v) => v < 0.5;
  const ero = new Float32Array(raw.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (isW(raw[i])) { ero[i] = 0; continue; }
    let m = raw[i];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
      const v = raw[yy * w + xx];
      if (!isW(v)) m = Math.min(m, v);
    }
    ero[i] = m;
  }
  const g = boxBlur(ero, w, h, 1, 2);
  const lonC = (c) => ox + (c0 + c + 0.5) * rx, latC = (r) => oy + (r0 + r + 0.5) * ry;
  const sample = (grid, lat, lon) => {
    const fx = (lon - lonC(0)) / rx, fy = (lat - latC(0)) / ry;
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(h - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    const a = grid[y0 * w + x0], b = grid[y0 * w + x0 + 1], c = grid[(y0 + 1) * w + x0], d = grid[(y0 + 1) * w + x0 + 1];
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  };
  return {
    ground: (x, y) => { const [la, lo] = proj.inv(x, y); return sample(g, la, lo); },
    rawWater: (x, y) => { const [la, lo] = proj.inv(x, y); return sample(raw, la, lo) < 0.5; },
  };
}
const dem = await loadDEM();
log('DEM ready');

// ─── OSM ────────────────────────────────────────────────────────────────
const els = loadOverpass(path.join(ROOT, 'data/raw', `${AREA}.osm.json.gz`));
log(`OSM elements: ${els.length}`);
const isBuilding = (t) => (t.building && t.building !== 'no') || (t['building:part'] && t['building:part'] !== 'no');
const underground = (t) => t.location === 'underground' || (t.layer && +t.layer < 0) || t.tunnel === 'yes' || t.tunnel === 'building_passage';
const polysB = extractPolygons(els, proj, (t) => isBuilding(t) && !underground(t));
const polysArea = extractPolygons(els, proj, (t) => !isBuilding(t) && (t.landuse || t.leisure || t.natural || t.place || t.amenity || t.highway || t['area:highway'] || t.man_made || t.tourism));
const roads = extractLines(els, proj, (t) => t.highway && !t.area && t.area !== 'yes' && !underground(t));
const rails = extractLines(els, proj, (t) => (t.railway === 'tram' || t.railway === 'rail' || t.railway === 'funicular' || t.railway === 'light_rail') && !underground(t));
const coast = extractLines(els, proj, (t) => t.natural === 'coastline');
const treeNodes = extractNodes(els, proj, (t) => t.natural === 'tree');
const treeRows = extractLines(els, proj, (t) => t.natural === 'tree_row');
log(`buildings ${polysB.length}, areas ${polysArea.length}, roads ${roads.length}, rails ${rails.length}, coastline ${coast.length}, trees ${treeNodes.length}`);

// ─── water mask: flood-fill from the water side of OSM coastline ────────
const WM = 1; // m/px
const wr = new Raster(minX, minY, maxX, maxY, WM);
const water = wr.data; // 0 land, 1 barrier, 2 water
let waterSource = 'osm-coastline';
{
  for (const c of coast) wr.strokeLine(c.pts, 2.2, (i) => { water[i] = 1; });
  const queue = new Int32Array(wr.w * wr.h);
  let qh = 0, qt = 0;
  const seed = (x, y) => {
    const c = Math.floor(wr.px(x)), r = Math.floor(wr.py(y));
    if (c < 0 || r < 0 || c >= wr.w || r >= wr.h) return;
    const i = r * wr.w + c;
    if (water[i] === 0) { water[i] = 2; queue[qt++] = i; }
  };
  for (const c of coast) for (let i = 0; i + 1 < c.pts.length; i++) {
    const [x1, y1] = c.pts[i], [x2, y2] = c.pts[i + 1];
    const L = Math.hypot(x2 - x1, y2 - y1); if (L < 1e-3) continue;
    const nx = (y2 - y1) / L, ny = -(x2 - x1) / L; // right-hand side = water
    for (let s = 0.5; s < L; s += 2) seed(x1 + ((x2 - x1) * s) / L + nx * 3, y1 + ((y2 - y1) * s) / L + ny * 3);
  }
  while (qh < qt) {
    const i = queue[qh++], x = i % wr.w, y = (i / wr.w) | 0;
    if (x > 0 && water[i - 1] === 0) { water[i - 1] = 2; queue[qt++] = i - 1; }
    if (x < wr.w - 1 && water[i + 1] === 0) { water[i + 1] = 2; queue[qt++] = i + 1; }
    if (y > 0 && water[i - wr.w] === 0) { water[i - wr.w] = 2; queue[qt++] = i - wr.w; }
    if (y < wr.h - 1 && water[i + wr.w] === 0) { water[i + wr.w] = 2; queue[qt++] = i + wr.w; }
  }
  let nW = 0, agree = 0;
  for (let i = 0; i < water.length; i++) if (water[i] === 2) {
    nW++;
    if (dem.rawWater(minX + ((i % wr.w) + 0.5) * WM, maxY - (((i / wr.w) | 0) + 0.5) * WM)) agree++;
  }
  const frac = nW / water.length;
  log(`coastline flood: ${(frac * 100).toFixed(1)}% water, DEM agreement ${((agree / Math.max(1, nW)) * 100).toFixed(1)}%`);
  if (coast.length === 0 || frac > 0.7 || agree / Math.max(1, nW) < 0.6) {
    waterSource = 'dem';
    log('falling back to DEM water mask');
    for (let i = 0; i < water.length; i++) water[i] = dem.rawWater(minX + ((i % wr.w) + 0.5) * WM, maxY - (((i / wr.w) | 0) + 0.5) * WM) ? 2 : 0;
  }
  for (let i = 0; i < water.length; i++) if (water[i] === 1) water[i] = 2; // barrier is shoreline → water
  // inland water bodies (ponds, fountains, docks)
  for (const p of polysArea) if (p.tags.natural === 'water' || p.tags.waterway === 'riverbank' || p.tags.waterway === 'dock' || p.tags.leisure === 'swimming_pool' || p.tags.amenity === 'fountain')
    wr.fillRings([p.outer, ...p.holes], (i) => { water[i] = 2; });
}
const isWaterAt = (x, y) => {
  const c = Math.floor(wr.px(x)), r = Math.floor(wr.py(y));
  if (c < 0 || r < 0 || c >= wr.w || r >= wr.h) return false;
  return water[r * wr.w + c] === 2;
};
// "deep" water: all of a 7 m neighbourhood is water (terrain vertices drop only there)
const isDeepWater = (x, y) => { for (const [dx, dy] of [[0, 0], [7, 0], [-7, 0], [0, 7], [0, -7], [5, 5], [-5, 5], [5, -5], [-5, -5]]) if (!isWaterAt(x + dx, y + dy)) return false; return true; };
const LAND_MIN = 1.6;
const groundAt = (x, y) => (isDeepWater(x, y) ? -5 : Math.max(LAND_MIN, dem.ground(x, y)));

// ─── colours ────────────────────────────────────────────────────────────
const srgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lin = (c) => c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
const NAMED = { white: '#f3f0ea', black: '#3a3a3a', grey: '#b8b4ad', gray: '#b8b4ad', silver: '#c8c8c8', beige: '#e8dcc0', yellow: '#e9c873', orange: '#df9a5a', red: '#b8553f', darkred: '#8e3b2e', brown: '#8a5a3c', pink: '#e9b6a6', blue: '#a9c0d2', lightblue: '#bcd0de', green: '#a9bf98', cream: '#efe4c8', tan: '#d6b98f', maroon: '#7c3a2e', ochre: '#d9a650' };
const parseColour = (v) => { if (!v) return null; v = v.toLowerCase().trim(); if (/^#[0-9a-f]{6}$/.test(v)) return srgb(v); if (/^#[0-9a-f]{3}$/.test(v)) return srgb('#' + [...v.slice(1)].map((c) => c + c).join('')); return NAMED[v] ? srgb(NAMED[v]) : null; };
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const pick = (list, u) => { const tot = list.reduce((s, x) => s + x[1], 0); let a = u * tot; for (const [c, w] of list) { if ((a -= w) <= 0) return c; } return list[0][0]; };
const triNormal = (a, b, c) => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...n) || 1;
  return n.map((v) => v / l);
};
const jitter = (c, u, amt = 10) => c.map((v) => Math.max(0, Math.min(255, v + (u - 0.5) * 2 * amt)));

// ─── building geometry ──────────────────────────────────────────────────
const tiles = new Map();
const tileOf = (x, y) => [Math.floor((x - minX) / TILE), Math.floor((y - minY) / TILE)];
const getTile = (i, j) => {
  const k = `${i}_${j}`;
  if (!tiles.has(k)) tiles.set(k, { i, j, b: makeSink(), balconies: [] });
  return tiles.get(k);
};
const stats = { buildings: 0, height: 0, levels: 0, estimated: 0, planar: 0, skeleton: 0, flat: 0, skeletonFail: 0, parts: 0, skippedOutlines: 0, partyEdges: 0, balconies: 0, statues: 0, wallsM: 0, pillars: 0, chimneys: 0 };

const LEVEL_H = 3.2;
const DEFAULT_H = { church: 20, cathedral: 26, chapel: 10, house: 8, detached: 8, garage: 3, garages: 3, shed: 3, kiosk: 3.2, hut: 3, roof: 3.5, school: 13, hospital: 18, train_station: 12, ruins: 5, castle: 14, tower: 25, bunker: 3, carport: 3, pillar: 5, service: 3.5, construction: 6 };
const MODERN = new Set(['office', 'commercial', 'hotel', 'hospital', 'university', 'school', 'industrial', 'warehouse', 'government', 'transportation', 'train_station', 'public', 'civic', 'parking']);
const UTILITY = new Set(['roof', 'garage', 'garages', 'shed', 'hut', 'bunker', 'carport', 'kiosk', 'service', 'construction', 'ruins', 'pillar']);
const pal = (list) => list.map(([c, w]) => [srgb(c), w]);
// Real Lisbon façade colours: lime whites, Pombaline ochre, rose/salmon, pistachio, sky blue, lilac, oxblood
const POMBALINE = pal([['#f1ece2', 24], ['#ece0c2', 14], ['#e9c97f', 22], ['#e8b9a0', 12], ['#e2c3c4', 6], ['#c9d7e0', 7], ['#d6dcb9', 5], ['#c27a62', 3], ['#f0dcaa', 8]]);
const VERNACULAR = pal([['#f5f2eb', 34], ['#f0e3c4', 11], ['#efcc7e', 12], ['#ecb79e', 10], ['#bcd3e3', 8], ['#d3dfb8', 5], ['#e8ac84', 5], ['#e2bccb', 5], ['#c86a53', 3], ['#b8cbbb', 3], ['#f3d899', 5]]);
const MODERN_C = pal([['#e7e3dc', 30], ['#cfcac2', 20], ['#b7b4ae', 10], ['#ddd2bf', 15], ['#a8b3b8', 6]]);
const STONE = srgb('#ddd2bd'), LIOZ = srgb('#e7dfcd'), CASTLE = srgb('#c9b99b');
const ROOFS = pal([['#ad5d43', 5], ['#b86b4d', 4], ['#9d5643', 3], ['#c07d5c', 3], ['#8f4f3e', 2], ['#a8664f', 3]]);
const FLAT_ROOF = pal([['#cdc6ba', 4], ['#bdb6aa', 3], ['#d8cfbf', 2], ['#b57a5a', 1]]);
const TRIM = srgb('#f3efe6');

function buildingSpec(p) {
  const t = p.tags, kind = t.building && t.building !== 'yes' ? t.building : t['building:part'] && t['building:part'] !== 'yes' ? t['building:part'] : t.building || 'yes';
  const u = (k) => hash(p.id + k);
  let h = parseMeters(t.height) ?? parseMeters(t['building:height']);
  const levels = parseFloat(t['building:levels']);
  const roofLevels = parseFloat(t['roof:levels']) || 0;
  let minH = parseMeters(t.min_height) ?? (isFinite(parseFloat(t['building:min_level'])) ? parseFloat(t['building:min_level']) * LEVEL_H : 0);
  const pillar = kind === 'pillar' || t.man_made === 'pillar';
  const castleType = t.castle_type || '';
  const palace = kind === 'palace' || ['palace', 'stately', 'manor'].includes(castleType);
  const castle = !palace && (kind === 'castle' || t.historic === 'castle' || castleType === 'defensive' || castleType === 'castle');
  const church = ['church', 'cathedral', 'chapel', 'basilica'].includes(kind) || (t.amenity === 'place_of_worship' && !t['building:part']);
  const monument = t.historic === 'monument' || t.historic === 'memorial' || t.man_made === 'tower';
  const modern = !palace && !church && (MODERN.has(kind) && (p.area > 700 || levels >= 7)) || levels >= 9 || (t['building:material'] || '').match(/glass|concrete/);
  let src = 'height';
  if (h == null && isFinite(levels)) { h = levels * LEVEL_H + 1.2 + (roofLevels ? 2.8 : 0); src = 'levels'; }
  if (h == null) {
    src = 'estimated';
    h = DEFAULT_H[kind] ?? (p.area < 30 ? 3.5 : p.area < 90 ? 9 + u('h') * 4 : 12.5 + u('h') * 5);
  }
  if (kind === 'roof' && !minH) minH = Math.max(0, h - 0.8);
  const party = (p.party || []).filter(Boolean).length;
  let variant = modern ? 3 : palace ? 4 : church || castle || monument ? 5 : (isFinite(levels) ? levels >= 4 : h >= 14) && party >= 1 ? 0 : 1;
  if ((variant === 0 || variant === 1) && u('azu') < (variant === 1 ? 0.16 : 0.1)) variant = 2; // azulejo-clad
  const stone = castle || pillar || (church && !t['building:colour']) || (monument && !UTILITY.has(kind));
  const utility = UTILITY.has(kind) || p.area < 25;
  // roof shape
  let shape = (t['roof:shape'] || '').toLowerCase().replace('half-hipped', 'hipped').replace('side_hipped', 'hipped');
  if (!shape) {
    if (castle || pillar || kind === 'roof' || t['building:part'] || modern || monument) shape = 'flat';
    else if (church) shape = 'gabled';
    else if (roofLevels >= 1) shape = 'mansard';
    else if (p.area > 3000 || h > 34) shape = 'flat';
    else if (utility && p.area < 40) shape = 'flat';
    else shape = 'hipped';
  }
  if (['round', 'saltbox', 'double_saltbox', 'quadruple_saltbox', 'crosspitched'].includes(shape)) shape = 'hipped';
  const floorH = utility || stone || castle ? 0
    : isFinite(levels) && levels > 0 ? Math.min(4.6, Math.max(2.7, (h - minH - (roofLevels ? 2.8 : 0)) / (levels + 0.3)))
    : variant === 0 ? 3.4 : variant === 3 ? 3.3 : variant === 4 ? 4.4 : 3.0;
  const groundH = variant === 0 ? Math.max(floorH, 3.9) : variant === 3 ? Math.max(floorH, 4.2) : variant === 4 ? floorH * 1.1 : Math.max(floorH, 2.9);
  const bayW = variant === 3 ? 1.6 + u('bw') * 0.6 : variant === 4 ? 3.6 + u('bw') * 0.8 : variant === 5 ? 5.5 : variant === 0 ? 2.7 + u('bw') * 0.5 : 2.5 + u('bw') * 1.1;
  const balconyFloors = variant === 0 || (variant === 2 && u('p') < 0.5) ? [1, ...(u('b2') < 0.55 ? [2] : []), ...(u('b3') < 0.3 ? [3] : [])] : variant === 1 || variant === 2 ? [1, 2, 3, 4] : variant === 4 ? [1] : [];
  const balconyChance = variant === 0 ? 1 : variant === 4 ? 0.6 : 0.2;
  const palette = variant === 3 ? MODERN_C : variant === 0 ? POMBALINE : VERNACULAR;
  const wall = parseColour(t['building:colour']) || (castle ? CASTLE : stone ? LIOZ : church ? STONE : variant === 4 ? pick(pal([['#f0e6d2', 3], ['#e9c98a', 2], ['#e3b6a2', 2], ['#f4f0ea', 3]]), u('w')) : pick(palette, u('w')));
  const roofCol = parseColour(t['roof:colour']) || pick(ROOFS, u('r'));
  const flatCol = shape === 'flat' && parseColour(t['roof:colour']) || pick(FLAT_ROOF, u('f'));
  const pitch = shape === 'pyramidal' ? 40 : church ? 34 : 24 + u('pt') * 13;
  return { kind, h, minH, src, shape, floorH, groundH, bayW, variant, stone, castle, pillar, wall, roofCol, flatCol, pitch,
    roofH: parseMeters(t['roof:height']), balconyFloors: floorH ? balconyFloors : [], balconyChance, parapet: variant === 3 ? 1.1 : castle ? 0 : 0.8 };
}

function addBuilding(p) {
  const s = buildingSpec(p);
  stats.buildings++; stats[s.src]++;
  const seed = hash(p.id + 'seed');
  const rng = (k) => hash(p.id + k);
  const rings = [p.outer, ...p.holes];
  let tmin = Infinity, tsum = 0, n = 0;
  for (const r of rings) for (const [x, y] of r) { const g = groundAt(x, y); tmin = Math.min(tmin, g); tsum += g; n++; }
  const ground = tsum / n;
  const bottom = s.minH > 0 ? ground + s.minH : tmin - 1.5;
  const top = ground + s.h;
  const [ti, tj] = tileOf(p.c[0], p.c[1]);
  const T = getTile(ti, tj), S = T.b;
  const colWall = lin(jitter(s.wall, rng('j'), 7)), colRoof = lin(jitter(s.roofCol, rng('k'), 10)), colFlat = lin(jitter(s.flatCol, rng('fl'), 6));
  const colTrim = lin(s.stone ? jitter(s.wall, 0.6, 4) : TRIM);
  const party = p.party || p.outer.map(() => false);
  stats.partyEdges += party.filter(Boolean).length;

  if (s.pillar) { // arcade pillars / columns → octagonal stone shafts
    stats.pillars++;
    const r = Math.max(0.25, Math.sqrt(Math.abs(p.area) / Math.PI));
    const ring = Array.from({ length: 8 }, (_, k) => [p.c[0] + r * Math.cos((k * Math.PI) / 4), p.c[1] + r * Math.sin((k * Math.PI) / 4)]);
    for (let k = 0; k < 8; k++) wallQuad(S, ring[k], ring[(k + 1) % 8], bottom, bottom, top, top, colWall, 0, 1, ground, [0, 0, 0, 0], [KIND.STONE / 8, 5 / 8, seed, 0.9]);
    return;
  }

  // roof strategy
  const ob = obb(p.outer);
  const fill = ob ? Math.abs(p.area) / (4 * ob.hl * ob.hw) : 0;
  const pitched = s.shape !== 'flat' && s.shape !== 'skillion' || (s.shape === 'skillion');
  const planarOK = ob && !p.holes.length && fill > 0.72 && p.outer.length <= 40 && !['dome', 'onion', 'cone'].includes(s.shape);
  let wallTop = top, sk = null, mode = 'flat';
  const sl = Math.tan((s.pitch * Math.PI) / 180);
  if (pitched && s.shape !== 'flat') {
    if (planarOK) {
      mode = 'planar';
      const est = s.roofH ?? (s.shape === 'mansard' || s.shape === 'gambrel' ? 4.6 : Math.min(5.5, Math.max(2.2, ob.hw * sl)));
      wallTop = top - Math.min(est, Math.max(0, s.h - s.minH - 2.5));
    } else if (p.outer.length <= 200) {
      try { sk = SkeletonBuilder.buildFromPolygon([[...p.outer, p.outer[0]], ...p.holes.map((h) => [...h, h[0]])]); } catch { sk = null; }
      if (sk && sk.polygons.length) {
        mode = 'skeleton';
        const zmax = Math.max(...sk.vertices.map((v) => v[2]));
        const dome = ['dome', 'onion', 'cone'].includes(s.shape);
        const rh = s.roofH ?? (dome ? Math.min(zmax * 1.6, 30) : Math.min(zmax * sl, 5.5));
        wallTop = top - Math.min(rh, Math.max(0, s.h - s.minH - 2.5));
      } else { stats.skeletonFail++; sk = null; }
    }
  }
  if (wallTop - bottom < 0.5) return;
  stats[mode]++;
  const spec = { ...s, shape: mode === 'planar' ? s.shape : mode === 'skeleton' ? 'skeleton-done' : 'flat' };
  const ctx = { outer: p.outer, holes: p.holes, party, ground, bottom, wallTop, spec, seed, colWall, colRoof, colTrim, colFlat, colCap: colRoof.map((v) => v * 0.8), rng, cx: p.c[0], cy: p.c[1] };
  const res = buildRoofAndWalls(S, ctx);
  if (mode === 'skeleton') skeletonRoof(S, sk, ctx, sl, 5.5, ['dome', 'onion', 'cone'].includes(s.shape));
  if (!s.stone && s.h > 5) { roofExtras(S, ctx, res.f, rng, mode !== 'flat'); stats.chimneys++; }
  for (const b of res.balconies) T.balconies.push(...b);
  stats.balconies += res.balconies.length;
}

{
  // Simple-3D-Buildings rule: if an outline contains building:parts, draw the parts instead.
  const parts = polysB.filter((p) => p.tags['building:part']);
  const outlines = polysB.filter((p) => !p.tags['building:part']);
  for (const o of outlines) {
    o.skip = parts.some((pt) => pt.area > 4 && pointInRing(pt.c[0], pt.c[1], o.outer) && Math.abs(pt.c[0] - o.c[0]) < 400);
    if (o.skip) stats.skippedOutlines++;
  }
  stats.parts = parts.length;
  const todo = [...outlines.filter((o) => !o.skip), ...parts].filter((p) => p.c[0] >= minX && p.c[0] <= maxX && p.c[1] >= minY && p.c[1] <= maxY && Math.abs(p.area) >= 2);
  markPartyWalls(todo.filter((p) => !p.tags['building:part']));
  for (const p of todo) addBuilding(p);
}

// ─── statues, columns & historic walls ──────────────────────────────────
{
  const bronze = lin(srgb('#55614f')), stoneC = lin(LIOZ), wallC = lin(srgb('#d3c6aa')), whiteC = lin(srgb('#ece6da'));
  const SI = [0, 0, 0, 0], ST = (seed) => [KIND.STONE / 8, 5 / 8, seed, 0.9], PL = (seed) => [KIND.PLAIN / 8, 5 / 8, seed, 1];
  const prism = (S, cx, cy, r, z0, z1, col, sides, st) => {
    const ring = Array.from({ length: sides }, (_, k) => [cx + r * Math.cos((k * 2 * Math.PI) / sides), cy + r * Math.sin((k * 2 * Math.PI) / sides)]);
    for (let k = 0; k < sides; k++) wallQuad(S, ring[k], ring[(k + 1) % sides], z0, z0, z1, z1, col, 0, 1, z0, SI, st);
    for (let k = 1; k + 1 < sides; k++) triUp(S, [ring[0][0], z1, -ring[0][1]], [ring[k][0], z1, -ring[k][1]], [ring[k + 1][0], z1, -ring[k + 1][1]], col, [0, 0], [0, 0], [0, 0], SI, st);
  };
  const figure = (S, x, y, z, sc, seed) => { // stylised standing figure in bronze
    prism(S, x, y, 0.28 * sc, z, z + 0.9 * sc, bronze, 6, PL(seed));
    prism(S, x, y, 0.34 * sc, z + 0.9 * sc, z + 1.55 * sc, bronze, 6, PL(seed));
    prism(S, x, y, 0.14 * sc, z + 1.55 * sc, z + 1.92 * sc, bronze, 6, PL(seed));
  };
  const mem = els.filter((e) => e.type === 'node' && e.tags && (e.tags.historic === 'memorial' || e.tags.historic === 'monument' || e.tags.tourism === 'artwork'));
  for (const e of mem) {
    const t = e.tags, typ = (t.memorial || t.artwork_type || '').toLowerCase();
    if (/mural|azulejo|tile|plaque|graffiti|stolperstein|street_art|painting|blue_plaque/.test(typ) || t.material === 'tile') continue;
    const [x, y] = proj.fwd(e.lat, e.lon);
    if (x < minX || x > maxX || y < minY || y > maxY || isWaterAt(x, y)) continue;
    const g = groundAt(x, y), [ti, tj] = tileOf(x, y), S = getTile(ti, tj).b, seed = hash('m' + e.id);
    const name = (t.name || '').toLowerCase();
    if (typ === 'column' || /coluna|column/.test(name)) {
      box(S, x, y, 1, 0, 2.6, 2.6, g - 0.5, g + 5, stoneC, SI, ST(seed));
      prism(S, x, y, 0.85, g + 5, g + 23, stoneC, 12, ST(seed));
      box(S, x, y, 1, 0, 1.1, 1.1, g + 23, g + 24, stoneC, SI, ST(seed));
      figure(S, x, y, g + 24, 2.2, seed);
    } else if (typ === 'bust') {
      box(S, x, y, 1, 0, 0.45, 0.45, g - 0.3, g + 1.8, stoneC, SI, ST(seed));
      prism(S, x, y, 0.3, g + 1.8, g + 2.5, bronze, 6, PL(seed));
    } else if (/cross|cruzeiro/.test(typ + name)) {
      prism(S, x, y, 0.25, g - 0.3, g + 4, stoneC, 6, ST(seed));
      box(S, x, y, 1, 0, 0.7, 0.12, g + 3.1, g + 3.35, stoneC, SI, ST(seed));
    } else {
      const big = t.historic === 'monument' || /equestre|equestrian|d\. josé|marquês/.test(name + typ);
      const ps = big ? 2.4 : 0.85, ph = big ? 5.5 : 2.4;
      box(S, x, y, 1, 0, ps + 0.4, ps + 0.4, g - 0.4, g + 0.5, stoneC, SI, ST(seed));
      box(S, x, y, 1, 0, ps, ps, g + 0.5, g + ph, stoneC, SI, ST(seed));
      figure(S, x, y, g + ph, big ? 2.6 : 1.15, seed);
    }
    stats.statues++;
  }
  // historic city / castle walls with merlons; ordinary walls low and whitewashed
  const wallLines = extractLines(els, proj, (t) => t.barrier === 'city_wall' || t.historic === 'citywalls' || t.historic === 'city_wall' || (t.barrier === 'wall' && !['fountain', 'arch', 'retaining_wall'].includes(t.historic || t.wall || '')));
  for (const w of wallLines) {
    const city = w.tags.barrier === 'city_wall' || /citywall|city_wall/.test(w.tags.historic || '');
    const H = parseMeters(w.tags.height) ?? (city ? 9 : 1.6), th = city ? 2.4 : 0.35, col = city ? wallC : whiteC;
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const a = w.pts[i], b = w.pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.2) continue;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (mx < minX || mx > maxX || my < minY || my > maxY) continue;
      const [ti, tj] = tileOf(mx, my), S = getTile(ti, tj).b, seed = hash(w.id + i);
      const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L, nx = -dy * th / 2, ny = dx * th / 2;
      const ga = groundAt(a[0], a[1]), gb = groundAt(b[0], b[1]);
      const A = [a[0] - dx * th / 2, a[1] - dy * th / 2], B = [b[0] + dx * th / 2, b[1] + dy * th / 2];
      const q = [[A[0] + nx, A[1] + ny], [B[0] + nx, B[1] + ny], [B[0] - nx, B[1] - ny], [A[0] - nx, A[1] - ny]];
      const zb = [ga, gb, gb, ga], zt = zb.map((z) => z + H);
      const st = city ? ST(seed) : PL(seed);
      wallQuad(S, q[3], q[2], zb[3] - 1, zb[2] - 1, zt[3], zt[2], col, 0, L, zb[3], SI, st);
      wallQuad(S, q[1], q[0], zb[1] - 1, zb[0] - 1, zt[1], zt[0], col, 0, L, zb[1], SI, st);
      wallQuad(S, q[0], q[3], zb[0] - 1, zb[3] - 1, zt[0], zt[3], col, 0, th, zb[0], SI, st);
      wallQuad(S, q[2], q[1], zb[2] - 1, zb[1] - 1, zt[2], zt[1], col, 0, th, zb[2], SI, st);
      triUp(S, [q[0][0], zt[0], -q[0][1]], [q[1][0], zt[1], -q[1][1]], [q[2][0], zt[2], -q[2][1]], col, [0, 0], [0, 0], [0, 0], SI, st);
      triUp(S, [q[0][0], zt[0], -q[0][1]], [q[2][0], zt[2], -q[2][1]], [q[3][0], zt[3], -q[3][1]], col, [0, 0], [0, 0], [0, 0], SI, st);
      if (city) for (let s2 = 1.2; s2 < L - 0.6; s2 += 2.6) {
        const x = a[0] + dx * s2, y = a[1] + dy * s2, z = ga + (gb - ga) * (s2 / L) + H;
        box(S, x, y, dx, dy, 0.6, th / 2, z - 0.05, z + 1.1, col, SI, st);
      }
      stats.wallsM += L;
    }
  }
}
log(`buildings built`, JSON.stringify(stats));

// ─── ground map (supersampled) ──────────────────────────────────────────
const gm = new Raster(minX, minY, maxX, maxY, SS, 3);
const C = {
  ground: srgb('#ddd6c8'), calcada: srgb('#efe9dc'), asphalt: srgb('#8f8c88'), road_edge: srgb('#c9c2b5'),
  park: srgb('#9fbf7a'), grass: srgb('#afc98a'), wood: srgb('#7fa465'), pitch: srgb('#93c07c'), sand: srgb('#e3cf9f'),
  parking: srgb('#b7b2aa'), rail: srgb('#5d5650'), water: srgb('#4c8296'), pier: srgb('#b8aa94'), plaza: srgb('#ebe4d4'),
};
const paint = (col) => (i) => { gm.data[i * 3] = col[0]; gm.data[i * 3 + 1] = col[1]; gm.data[i * 3 + 2] = col[2]; };
for (let i = 0; i < gm.w * gm.h; i++) paint(C.ground)(i);
const areaColor = (t) => {
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'recreation_ground' || t.landuse === 'village_green') return C.park;
  if (t.landuse === 'grass' || t.landuse === 'meadow' || t.natural === 'grassland' || t.landuse === 'flowerbed') return C.grass;
  if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub' || t.natural === 'heath') return C.wood;
  if (t.leisure === 'pitch' || t.leisure === 'playground') return C.pitch;
  if (t.natural === 'sand' || t.natural === 'beach') return C.sand;
  if (t.amenity === 'parking' && !t.parking?.includes('underground') && t.parking !== 'multi-storey') return C.parking;
  if (t.place === 'square' || t.highway === 'pedestrian' || t['area:highway'] === 'pedestrian' || t['area:highway'] === 'footway') return C.plaza;
  if (t['area:highway']) return C.asphalt;
  if (t.man_made === 'pier' || t.man_made === 'quay' || t.man_made === 'breakwater') return C.pier;
  return null;
};
// big areas first so small ones draw on top
for (const p of [...polysArea].sort((a, b) => b.area - a.area)) {
  const col = areaColor(p.tags);
  if (col) gm.fillRings([p.outer, ...p.holes], paint(col));
}
const ROAD_W = { motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8, unclassified: 6, residential: 6, living_street: 5, service: 4, pedestrian: 6, footway: 2.4, path: 2, steps: 2.4, cycleway: 2.2, track: 3 };
const ROAD_ORDER = ['footway', 'path', 'steps', 'cycleway', 'track', 'pedestrian', 'service', 'living_street', 'residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
const roadKind = (t) => t.highway.replace('_link', '');
const sorted = roads.filter((r) => ROAD_W[roadKind(r.tags)]).sort((a, b) => ROAD_ORDER.indexOf(roadKind(a.tags)) - ROAD_ORDER.indexOf(roadKind(b.tags)));
const pedestrianish = (k) => ['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'track', 'living_street'].includes(k);
for (const r of sorted) {   // kerbs/pavement halo first
  const k = roadKind(r.tags);
  if (!pedestrianish(k)) gm.strokeLine(r.pts, (parseMeters(r.tags.width) ?? ROAD_W[k]) + 2.2, paint(C.calcada));
}
for (const r of sorted) {
  const k = roadKind(r.tags);
  const w = parseMeters(r.tags.width) ?? ROAD_W[k];
  gm.strokeLine(r.pts, w, paint(pedestrianish(k) ? C.calcada : C.asphalt));
}
for (const r of rails) { // two rails per track
  const g = r.tags.railway === 'tram' || r.tags.railway === 'funicular' ? 0.9 : 1.435;
  for (const side of [-1, 1]) {
    const off = r.pts.map((p, i) => {
      const a = r.pts[Math.max(0, i - 1)], b = r.pts[Math.min(r.pts.length - 1, i + 1)];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [p[0] - ((b[1] - a[1]) / L) * g * side * 0.5, p[1] + ((b[0] - a[0]) / L) * g * side * 0.5];
    });
    gm.strokeLine(off, 0.35, paint(C.rail));
  }
}
// water (from 1 m mask)
for (let r = 0; r < gm.h; r++) for (let c = 0; c < gm.w; c++) {
  const wi = Math.floor((r * SS) / WM) * wr.w + Math.floor((c * SS) / WM);
  if (water[wi] === 2) paint(C.water)(r * gm.w + c);
}
log(`ground map painted ${gm.w}×${gm.h}`);

// downsample to 1 m and bake contact AO around buildings
const GW = Math.round(gm.w / 2), GH = Math.round(gm.h / 2);
let ground1 = await sharp(Buffer.from(gm.data.buffer), { raw: { width: gm.w, height: gm.h, channels: 3 } }).resize(GW, GH, { kernel: 'lanczos3' }).raw().toBuffer();
gm.data = null;
{
  const bm = new Raster(minX, minY, maxX, maxY, (maxX - minX) / GW);
  const mask = new Float32Array(bm.w * bm.h);
  for (const p of polysB) if (!p.tags['building:part'] || true) bm.fillRings([p.outer, ...p.holes], (i) => { if (i < mask.length) mask[i] = 1; });
  const ao = boxBlur(mask, bm.w, bm.h, 3, 3);
  for (let i = 0; i < GW * GH; i++) {
    const k = 1 - Math.min(1, ao[i] * 1.15) * 0.42;
    ground1[i * 3] *= k; ground1[i * 3 + 1] *= k; ground1[i * 3 + 2] *= k;
  }
}
log('AO baked');

// ─── trees ──────────────────────────────────────────────────────────────
const trees = [];
const groundPx = (x, y) => { const c = Math.floor(((x - minX) / (maxX - minX)) * GW), r = Math.floor(((maxY - y) / (maxY - minY)) * GH); return c >= 0 && r >= 0 && c < GW && r < GH ? r * GW + c : -1; };
const addTree = (x, y, sc) => { if (x < minX || x > maxX || y < minY || y > maxY || isWaterAt(x, y)) return; trees.push(x, groundAt(x, y), -y, sc); };
for (const t of treeNodes) addTree(t.p[0], t.p[1], 0.8 + hash(t.id) * 0.6);
for (const r of treeRows) for (let i = 0; i + 1 < r.pts.length; i++) {
  const [x1, y1] = r.pts[i], [x2, y2] = r.pts[i + 1], L = Math.hypot(x2 - x1, y2 - y1);
  for (let s = 0; s < L; s += 8) addTree(x1 + ((x2 - x1) * s) / L, y1 + ((y2 - y1) * s) / L, 0.8 + hash(r.id + s) * 0.5);
}
const nTagged = trees.length / 4;
{ // scatter inside parks / woods (procedural, flagged in manifest)
  const bm = new Raster(minX, minY, maxX, maxY, 1);
  const blocked = new Uint8Array(bm.w * bm.h);
  for (const p of polysB) bm.fillRings([p.outer, ...p.holes], (i) => { blocked[i] = 1; });
  for (const r of roads) if (ROAD_W[roadKind(r.tags)]) bm.strokeLine(r.pts, ROAD_W[roadKind(r.tags)] + 2, (i) => { blocked[i] = 1; });
  for (let i = 0; i < trees.length; i += 4) bm.disc(trees[i], -trees[i + 2], 5, (k) => { blocked[k] = 1; });
  for (const p of polysArea) {
    const t = p.tags;
    const dense = t.natural === 'wood' || t.landuse === 'forest' ? 7 : t.leisure === 'park' || t.leisure === 'garden' ? 11 : 0;
    if (!dense || p.area < 150) continue;
    const xs = p.outer.map((q) => q[0]), ys = p.outer.map((q) => q[1]);
    for (let x = Math.min(...xs); x < Math.max(...xs); x += dense) for (let y = Math.min(...ys); y < Math.max(...ys); y += dense) {
      const jx = x + (hash(`${p.id}${x}${y}a`) - 0.5) * dense * 0.8, jy = y + (hash(`${p.id}${x}${y}b`) - 0.5) * dense * 0.8;
      if (!pointInRing(jx, jy, p.outer) || p.holes.some((h) => pointInRing(jx, jy, h))) continue;
      const c = Math.floor(bm.px(jx)), r = Math.floor(bm.py(jy));
      if (c < 0 || r < 0 || c >= bm.w || r >= bm.h || blocked[r * bm.w + c]) continue;
      addTree(jx, jy, 0.75 + hash(`${jx}`) * 0.6);
    }
  }
}
log(`trees: ${nTagged} mapped + ${trees.length / 4 - nTagged} scattered`);

// ─── terrain + tiles → glTF ─────────────────────────────────────────────
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await MeshoptEncoder.ready;

function newDoc() {
  const doc = new Document().setLogger(new Logger(Logger.Verbosity.ERROR));
  doc.createBuffer();
  const scene = doc.createScene();
  doc.getRoot().setDefaultScene(scene);
  return { doc, scene };
}
function addMesh(doc, scene, name, attrs, material) {
  const buf = doc.getRoot().listBuffers()[0];
  const prim = doc.createPrimitive();
  for (const [sem, [arr, type, normalized]] of Object.entries(attrs)) {
    if (sem === 'indices') { prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(arr).setBuffer(buf)); continue; }
    const acc = doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
    if (normalized) acc.setNormalized(true);
    prim.setAttribute(sem, acc);
  }
  if (material) prim.setMaterial(material);
  scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
}
async function writeDoc(doc, file) {
  await doc.transform(weld(), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeNormal: 10, quantizeTexcoord: 16, quantizeColor: 8 }));
  await io.write(file, doc);
  return fs.statSync(file).size;
}

const ni = Math.ceil((maxX - minX) / TILE), nj = Math.ceil((maxY - minY) / TILE);
const manifest = {
  area: AREA, origin: { lat: lat0, lon: lon0 }, bounds: { minX, minY, maxX, maxY }, waterY: WATER_Y, baseY: BASE_Y,
  tiles: [], stats: { ...stats, waterSource, trees: trees.length / 4, treesMapped: nTagged },
  attribution: '© OpenStreetMap contributors (ODbL) · Copernicus DEM GLO-30 © ESA/DLR/Airbus',
  built: new Date().toISOString(),
};
let totalBytes = 0, totalTris = 0;
for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
  const x0 = minX + i * TILE, x1 = Math.min(maxX, x0 + TILE), y0 = minY + j * TILE, y1 = Math.min(maxY, y0 + TILE);
  const { doc, scene } = newDoc();
  // ground texture crop
  const px0 = Math.round(((x0 - minX) / (maxX - minX)) * GW), px1 = Math.round(((x1 - minX) / (maxX - minX)) * GW);
  const py0 = Math.round(((maxY - y1) / (maxY - minY)) * GH), py1 = Math.round(((maxY - y0) / (maxY - minY)) * GH);
  const tw = Math.max(16, Math.round((TEX_PX * (x1 - x0)) / TILE)), th = Math.max(16, Math.round((TEX_PX * (y1 - y0)) / TILE));
  const webp = await sharp(ground1, { raw: { width: GW, height: GH, channels: 3 } })
    .extract({ left: px0, top: py0, width: px1 - px0, height: py1 - py0 }).resize(tw, th).webp({ quality: 82, effort: 6 }).toBuffer();
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const tex = doc.createTexture('ground').setImage(webp).setMimeType('image/webp');
  const gmat = doc.createMaterial('ground').setBaseColorTexture(tex).setRoughnessFactor(1).setMetallicFactor(0);
  // terrain grid
  const cols = Math.max(2, Math.round((x1 - x0) / GRID) + 1), rows = Math.max(2, Math.round((y1 - y0) / GRID) + 1);
  const pos = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2), H = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + ((x1 - x0) * c) / (cols - 1), y = y1 - ((y1 - y0) * r) / (rows - 1), k = r * cols + c;
    H[k] = groundAt(x, y);
    pos.set([x, H[k], -y], k * 3); uv.set([c / (cols - 1), r / (rows - 1)], k * 2);
  }
  const nrm = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const hx = H[r * cols + Math.min(cols - 1, c + 1)] - H[r * cols + Math.max(0, c - 1)];
    const hz = H[Math.min(rows - 1, r + 1) * cols + c] - H[Math.max(0, r - 1) * cols + c];
    const dx = ((x1 - x0) / (cols - 1)) * 2, dz = ((y1 - y0) / (rows - 1)) * 2;
    const n = [-hx / dx, 1, -hz / dz], l = Math.hypot(...n);
    nrm.set(n.map((v) => v / l), (r * cols + c) * 3);
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let q = 0;
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
    idx.set([a, d, b, b, d, e], q); q += 6;
  }
  addMesh(doc, scene, 'terrain', { POSITION: [pos, 'VEC3'], NORMAL: [nrm, 'VEC3'], TEXCOORD_0: [uv, 'VEC2'], indices: [idx] }, gmat);
  totalTris += idx.length / 3;
  // buildings
  const T = tiles.get(`${i}_${j}`);
  let balFile = null;
  if (T && T.b.pos.length) {
    const B = T.b;
    const bmat = doc.createMaterial('buildings').setRoughnessFactor(0.9).setMetallicFactor(0);
    const col = Uint8Array.from(B.col, (v) => Math.round(Math.min(1, v) * 255));
    addMesh(doc, scene, 'buildings', {
      POSITION: [Float32Array.from(B.pos), 'VEC3'], NORMAL: [Float32Array.from(B.nrm), 'VEC3'], COLOR_0: [col, 'VEC3', true],
      TEXCOORD_0: [Float32Array.from(B.surf, (v) => Math.min(1, Math.max(0, v / 512 + 0.5))), 'VEC2'], _INFO: [Float32Array.from(B.info), 'VEC4'], _STYLE: [Float32Array.from(B.style), 'VEC4'],
    }, bmat);
    totalTris += B.pos.length / 9;
    if (T.balconies.length) { balFile = `bal_${i}_${j}.bin`; fs.writeFileSync(path.join(OUT, balFile), Buffer.from(Float32Array.from(T.balconies).buffer)); totalBytes += T.balconies.length * 4; }
  }
  const file = `t_${i}_${j}.glb`;
  const bytes = await writeDoc(doc, path.join(OUT, file));
  totalBytes += bytes;
  manifest.tiles.push({ file, i, j, bounds: [x0, y0, x1, y1], bytes, balconies: balFile });
  log(`tile ${i},${j}: ${(bytes / 1024).toFixed(0)} KB`);
}

// diorama base: skirt walls around the edge + bottom
{
  const { doc, scene } = newDoc();
  const pos = [], col = [], nrm = [];
  const soilTop = lin(srgb('#9a6a48')), soilBot = lin(srgb('#5b3d2b')), waterCol = lin(srgb('#3f7f97'));
  const edge = (ax, ay, bx, by, n) => {
    const L = Math.hypot(bx - ax, by - ay), steps = Math.ceil(L / GRID);
    for (let s = 0; s < steps; s++) {
      const x1 = ax + ((bx - ax) * s) / steps, y1 = ay + ((by - ay) * s) / steps, x2 = ax + ((bx - ax) * (s + 1)) / steps, y2 = ay + ((by - ay) * (s + 1)) / steps;
      const h1 = groundAt(x1, y1), h2 = groundAt(x2, y2);
      const quad = (ya1, ya2, yb1, yb2, ct, cb) => {
        const A = [x1, ya1, -y1], B = [x2, ya2, -y2], C2 = [x2, yb2, -y2], D = [x1, yb1, -y1];
        pos.push(...A, ...C2, ...B, ...A, ...D, ...C2);
        col.push(...ct, ...cb, ...ct, ...ct, ...cb, ...cb);
        for (let k = 0; k < 6; k++) nrm.push(...n);
      };
      const wet1 = h1 < WATER_Y, wet2 = h2 < WATER_Y;
      if (wet1 || wet2) { quad(WATER_Y, WATER_Y, Math.min(h1, WATER_Y), Math.min(h2, WATER_Y), waterCol, waterCol); }
      quad(Math.min(h1, WATER_Y + 1e3), Math.min(h2, WATER_Y + 1e3), BASE_Y, BASE_Y, soilTop, soilBot);
    }
  };
  edge(minX, minY, maxX, minY, [0, 0, 1]);   // south
  edge(maxX, minY, maxX, maxY, [1, 0, 0]);   // east
  edge(maxX, maxY, minX, maxY, [0, 0, -1]);  // north
  edge(minX, maxY, minX, minY, [-1, 0, 0]);  // west
  // fix winding per side so faces point outward
  const P = Float32Array.from(pos), Nn = Float32Array.from(nrm);
  for (let t = 0; t < P.length; t += 9) {
    const a = [P[t], P[t + 1], P[t + 2]], b = [P[t + 3], P[t + 4], P[t + 5]], c = [P[t + 6], P[t + 7], P[t + 8]];
    const n = triNormal(a, b, c);
    if (n[0] * Nn[t] + n[2] * Nn[t + 2] < 0) { P.set(c, t + 3); P.set(b, t + 6); const ci = col.slice((t / 3 + 1) * 3, (t / 3 + 2) * 3), cj = col.slice((t / 3 + 2) * 3, (t / 3 + 3) * 3); col.splice((t / 3 + 1) * 3, 3, ...cj); col.splice((t / 3 + 2) * 3, 3, ...ci); }
  }
  const bmat = doc.createMaterial('base').setRoughnessFactor(1).setMetallicFactor(0);
  addMesh(doc, scene, 'base', { POSITION: [P, 'VEC3'], NORMAL: [Nn, 'VEC3'], COLOR_0: [Uint8Array.from(col, (v) => Math.round(v * 255)), 'VEC3', true] }, bmat);
  const bytes = await writeDoc(doc, path.join(OUT, 'base.glb'));
  totalBytes += bytes;
}

// water mask (2 m/px, R channel) for the water shader; trees
{
  const m = Buffer.alloc(wr.w * wr.h);
  for (let i = 0; i < m.length; i++) m[i] = water[i] === 2 ? 255 : 0;
  await sharp(m, { raw: { width: wr.w, height: wr.h, channels: 1 } }).blur(0.7).png({ compressionLevel: 9, palette: false }).toFile(path.join(OUT, 'water.png'));
  fs.writeFileSync(path.join(OUT, 'trees.bin'), Buffer.from(Float32Array.from(trees).buffer));
  totalBytes += fs.statSync(path.join(OUT, 'water.png')).size + trees.length * 4;
}
manifest.stats.bytes = totalBytes;
manifest.stats.triangles = totalTris;
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
log(`done: ${(totalBytes / 1048576).toFixed(2)} MB, ${(totalTris / 1e6).toFixed(2)} M tris`);
