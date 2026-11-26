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
import earcut from 'earcut';
import ClipperLib from 'clipper-lib';
import { loadOverpass, makeProjection, extractPolygons, extractLines, extractNodes, parseMeters, pointInRing, ringArea } from './lib/osm.mjs';
import { Raster, boxBlur } from './lib/raster.mjs';
import { makeSink, markPartyWalls, buildRoofAndWalls, skeletonRoof, roofExtras, obb, KIND, box, wallQuad, triUp } from './lib/buildings.mjs';
import { OVERRIDES, DROP, dropTag, BAIXA_ZONES, notBlock, pombalineBlocks, profileRoof, mansardProfile, arcoRuaAugusta, equestrianJose, pedroIVColumn, rossioFountain, portico, jeronimosWing, arenaShell, jazigo, seCathedral, panteao, carmoRuins, santaJustaLift, caisColunas, parishChurch, CHURCHES, tramCar, trainCar, catenaryMast, cacilheiro, miradouro, restauradoresObelisk, rossioStationFront, saoBentoFront, sailboat, metalDome, estrelaBasilica, marquesColumn, trellisCedar, pelourinho, domedTower, AREAS, ponte25Abril, PONTE_LINE, cristoRei, aqueduto, AQUEDUTO_LINE, torreBelem, padraoDescobrimentos, jeronimosChurch, estadioLuz, oriente, campoPequenoTower, torreVascoGama, amoreirasCrown, maat, oceanario, alvaladeStadium, bleachers, barrelRoof, palaSiza, sailCrown, VG_LINE, ponteVascoGama, slopedCrown, flareTower, dormers, sawtoothRoof, plainDome, minaretTop, vaultAlong, limb, twinSpires, bullringRoof } from './lib/authored.mjs';

const { default: skPkg } = await import('straight-skeleton');
const { SkeletonBuilder } = skPkg;
await SkeletonBuilder.init();

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const AREA = process.argv[2] || 'baixa-alfama';
const areaLines = fs.readFileSync(path.join(ROOT, 'pipeline/areas.txt'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const areaLine = areaLines.find((l) => l.split(/\s+/)[0] === AREA);
const ALL_AREAS = areaLines.map((l) => l.trim().split(/\s+/)).map(([n, ...b]) => [n, ...b.map(Number)]);
if (!areaLine) throw new Error(`unknown area ${AREA}`);
const [S, W, N, E] = areaLine.trim().split(/\s+/).slice(1).map(Number);
const OUT = path.join(ROOT, 'public/tiles', AREA);
fs.mkdirSync(OUT, { recursive: true });

const TILE = 500;             // tile size (m): small enough that the camera and shadow frusta cull most of the city up close
const TEX_PX = 2048;          // ground texture px per km
const GRID = 8;               // terrain mesh spacing (m)
const SS = 0.32;               // ground map supersample (m/px)
const WATER_Y = 0;            // river surface
const BASE_Y = -28;           // diorama base bottom
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ─── projection & extent ────────────────────────────────────────────────
// every area projects around the same point (the centre of the first, historic area) so their tiles join into one city
const lat0 = 38.71375, lon0 = -9.13975;
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
  let g = boxBlur(ero, w, h, 1, 2);
  const lonC = (c) => ox + (c0 + c + 0.5) * rx, latC = (r) => oy + (r0 + r + 0.5) * ry;
  const sample = (grid, lat, lon) => {
    const fx = (lon - lonC(0)) / rx, fy = (lat - latC(0)) / ry;
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(h - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    const a = grid[y0 * w + x0], b = grid[y0 * w + x0 + 1], c = grid[(y0 + 1) * w + x0], d = grid[(y0 + 1) * w + x0 + 1];
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  };
  // Big footprints (stations, convents, hospitals) are wider than the 3×3 erosion window, so their roofs survived as
  // mounds the streets climbed over. With the OSM buildings known: cells mostly under a roof become unknown and are
  // filled in from the surrounding street-level cells, then eroded and smoothed as before.
  const refine = (covered) => {
    const cov = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      let k = 0; for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (covered(latC(r) + (a - 1.5) / 4 * ry, lonC(c) + (b - 1.5) / 4 * rx)) k++;
      cov[r * w + c] = k / 16;
    }
    const fill = Float32Array.from(raw), known = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) known[i] = isW(raw[i]) || cov[i] < 0.6 ? 1 : 0;
    let todo = known.reduce((a, v) => a + (1 - v), 0); const start = todo;
    for (let pass = 0; pass < 40 && todo > 0; pass++) {
      const next = []; 
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (known[i]) continue;
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue; const j = yy * w + xx; if (known[j] && !isW(raw[j])) { s += fill[j]; n++; } }
        if (n >= 2 || (n && pass > 3)) next.push([i, s / n]);
      }
      for (const [i, v] of next) { fill[i] = Math.min(raw[i], v); known[i] = 1; todo--; }
    }
    const ero2 = new Float32Array(raw.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (isW(raw[i])) { ero2[i] = 0; continue; }
      let m = fill[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue; const v = fill[yy * w + xx]; if (!isW(raw[yy * w + xx])) m = Math.min(m, v); }
      ero2[i] = m;
    }
    const g2 = boxBlur(ero2, w, h, 1, 2);
    let d = 0, dm = 0; for (let i = 0; i < g.length; i++) { const e = Math.abs(g2[i] - g[i]); d += e; dm = Math.max(dm, e); }
    g = g2;
    return { roofCells: start, meanShift: d / g.length, maxShift: dm };
  };
  return {
    refine,
    ground: (x, y) => { const [la, lo] = proj.inv(x, y); return sample(g, la, lo); },
    rawWater: (x, y) => { const [la, lo] = proj.inv(x, y); return sample(raw, la, lo) < 0.5; },
  };
}
const dem = await loadDEM();
log('DEM ready');
// LiDAR terrain (DGT 2024 MDT, ~4 m; see pipeline/fetch_lidar.py) wherever it has ground: the true street levels under the
// 30 m Copernicus estimate. Water and gaps keep Copernicus.
await (async () => {
  const f = path.join(ROOT, 'data/lidar', `${AREA}_dtm.tif`); if (!fs.existsSync(f) || process.env.NO_LIDAR_DTM) return;
  const img = await (await fromFile(f)).getImage(), [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
  const [r] = await img.readRasters(), w = img.getWidth(), h = img.getHeight(), cop = dem.ground;
  const at = (la, lo) => {
    const fx = (lo - ox) / rx - 0.5, fy = (la - oy) / ry - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return NaN;
    const a = r[y0 * w + x0], b = r[y0 * w + x0 + 1], c = r[(y0 + 1) * w + x0], d = r[(y0 + 1) * w + x0 + 1];
    if (a === 65535 || b === 65535 || c === 65535 || d === 65535) return NaN;
    return (a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty) / 10;
  };
  dem.ground = (x, y) => { const [la, lo] = proj.inv(x, y), v = at(la, lo); return isFinite(v) ? v : cop(x, y); };
  // The survey's ground filter swallows some wide flat roofs (showrooms, markets, halls): the 'terrain' climbs onto the roof,
  // the height above it reads ~0 and the building stands on a plateau. Re-derive the ground under every footprint from the
  // street around it (filled inward ring by ring); where the survey's ground stood >1.5 m above that, it was a roof.
  const raw0 = Uint16Array.from(r);
  dem.lidarFix = (polys) => {
    const mask = new Uint8Array(w * h);
    for (const p of polys) {
      let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
      for (const [x, y] of p.outer) { const [la, lo] = proj.inv(x, y); la0 = Math.min(la0, la); la1 = Math.max(la1, la); lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); }
      const c0 = Math.max(0, Math.floor((lo0 - ox) / rx)), c1 = Math.min(w - 1, Math.floor((lo1 - ox) / rx)), k0 = Math.max(0, Math.floor((la1 - oy) / ry)), k1 = Math.min(h - 1, Math.floor((la0 - oy) / ry));
      for (let k = k0; k <= k1; k++) for (let c = c0; c <= c1; c++) {
        const [x, y] = proj.fwd(oy + (k + 0.5) * ry, ox + (c + 0.5) * rx);
        if (pointInRing(x, y, p.outer) && !p.holes.some((q) => pointInRing(x, y, q))) mask[k * w + c] = 1;
      }
    }
    let front = [];
    for (let k = 0; k < h; k++) for (let c = 0; c < w; c++) if (mask[k * w + c] || r[k * w + c] === 65535) { const i = k * w + c; if (r[i] === 65535) mask[i] = 2; else front.push(i); }
    const fix = Float32Array.from(r, (v, i) => (mask[i] ? NaN : v));
    let todo = front.filter((i) => mask[i] === 1), guard = 0;
    while (todo.length && guard++ < 400) {
      const vals = [];
      for (const i of todo) { const k = (i / w) | 0, c = i % w; let s = 0, n = 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const kk = k + b, cc = c + a; if (kk < 0 || cc < 0 || kk >= h || cc >= w) continue; const v = fix[kk * w + cc]; if (isFinite(v) && mask[kk * w + cc] !== 2) { s += v; n++; } }
        vals.push(n ? s / n : NaN); }
      const next = [];
      todo.forEach((i, j) => { if (isFinite(vals[j])) fix[i] = vals[j]; else next.push(i); });
      if (next.length === todo.length) break; todo = next;
    }
    let roofs = 0;
    for (let i = 0; i < r.length; i++) if (mask[i] === 1 && isFinite(fix[i]) && raw0[i] - fix[i] > 15) { r[i] = Math.round(fix[i]); roofs++; }   // dm: >1.5 m
    dem.dtmLift = (x, y) => { const [la, lo] = proj.inv(x, y), c = Math.floor((lo - ox) / rx), k = Math.floor((la - oy) / ry); return c < 0 || k < 0 || c >= w || k >= h ? 0 : (raw0[k * w + c] - r[k * w + c]) / 10; };
    log(`LiDAR ground under footprints: ${roofs} cells were roofs (${(roofs * Math.abs(rx * ry) * 111000 * 87000 / 1e4).toFixed(1)} ha)`);
  };
  log(`LiDAR terrain ${w}×${h}`);
})();

// ─── OSM ────────────────────────────────────────────────────────────────
const els = loadOverpass(path.join(ROOT, 'data/raw', `${AREA}.osm.json.gz`));
log(`OSM elements: ${els.length}`);
const isBuilding = (t) => (t.building && t.building !== 'no') || (t['building:part'] && t['building:part'] !== 'no');
const underground = (t) => t.location === 'underground' || (t.layer && +t.layer < 0) || t.tunnel === 'yes' || t.tunnel === 'building_passage';
const polysB = (() => {   // the same footprint mapped twice (a convent relation over its hospital ways) z-fights: keep one
  const all = extractPolygons(els, proj, (t) => isBuilding(t) && !underground(t)).filter((p) => !(p.tags['bridge:support'] && DROP.has(p.id))), seen = new Map(), out = [];   // authored bridges' pylons: not buildings, not land
  const score = (p) => (OVERRIDES[p.id] ? 4 : 0) + (p.tags.height || p.tags['building:levels'] ? 2 : 0) + (p.tags.name ? 1 : 0);
  for (const p of all) {
    if (p.tags['building:part']) { out.push(p); continue; }
    const k = `${Math.round(p.c[0] * 2)},${Math.round(p.c[1] * 2)},${Math.round(Math.abs(p.area) / 5)}`, q = seen.get(k);
    if (!q) { seen.set(k, p); out.push(p); continue; }
    if (score(p) > score(q)) { out[out.indexOf(q)] = p; seen.set(k, p); }
  }
  console.log('duplicate footprints dropped', all.length - out.length);
  return out;
})();
if (dem.lidarFix) dem.lidarFix(polysB.filter((p) => !p.tags['building:part']));
{ // building-aware ground (see dem.refine)
  const cr = new Raster(minX - 400, minY - 400, maxX + 400, maxY + 400, 3);
  for (const p of polysB) if (!p.tags['building:part']) cr.fillRings([p.outer, ...p.holes], (i) => { cr.data[i] = 1; });
  const covered = (la, lo) => { const [x, y] = proj.fwd(la, lo), c = Math.floor((x - cr.minX) / 3), r = Math.floor((cr.maxY - y) / 3); return c >= 0 && r >= 0 && c < cr.w && r < cr.h && cr.data[r * cr.w + c] === 1; };
  const st = dem.refine(covered);
  log(`ground refined under roofs: ${st.roofCells} cells, mean shift ${st.meanShift.toFixed(2)} m, max ${st.maxShift.toFixed(1)} m`);
}
const polysArea = extractPolygons(els, proj, (t) => !isBuilding(t) && (t.golf || t.landuse || t.leisure || t.natural || t.place || t.amenity || t.highway || t['area:highway'] || t.man_made || t.tourism || t.railway === 'platform'));
for (const [id, tags, ring] of AREAS) { const outer = ring.map(([la, lo]) => proj.fwd(la, lo)); polysArea.push({ id, tags, outer, holes: [], area: Math.abs(ringArea(outer)), c: [outer.reduce((a, q) => a + q[0], 0) / outer.length, outer.reduce((a, q) => a + q[1], 0) / outer.length] }); }
const roads0 = extractLines(els, proj, (t) => t.highway && !t.area && t.area !== 'yes' && !underground(t));
// roads and rails up on the Ponte 25 de Abril deck are part of the authored bridge, not of the ground
const ponteXY = PONTE_LINE.map(([la, lo]) => proj.fwd(la, lo));
const nearPonte = (x, y) => { for (let i = 0; i + 1 < ponteXY.length; i++) { const [ax, ay] = ponteXY[i], [bx, by] = ponteXY[i + 1], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); if (Math.hypot(ax + dx * t - x, ay + dy * t - y) < 16) return true; } return false; };
const onPonte = (l) => l.tags.bridge && l.tags.bridge !== 'no' && l.pts.every(([x, y]) => nearPonte(x, y));
const roads = roads0.filter((r) => !onPonte(r));
const rails = (extractLines(els, proj, (t) => (t.railway === 'tram' || t.railway === 'rail' || t.railway === 'funicular' || t.railway === 'light_rail') && !underground(t))).filter((r) => !onPonte(r));
const coast = extractLines(els, proj, (t) => t.natural === 'coastline');
const treeNodes = extractNodes(els, proj, (t) => t.natural === 'tree');
const treeRows = extractLines(els, proj, (t) => t.natural === 'tree_row');
log(`buildings ${polysB.length}, areas ${polysArea.length}, roads ${roads.length}, rails ${rails.length}, coastline ${coast.length}, trees ${treeNodes.length}`);

// ─── water mask: flood-fill from the water side of OSM coastline ────────
const WM = 1; // m/px
const WMG = 40;   // margin: water just across a seam with a neighbouring area must still count, or the river shore rises there
const wr = new Raster(minX - WMG, minY - WMG, maxX + WMG, maxY + WMG, WM);
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
    if (dem.rawWater(wr.minX + ((i % wr.w) + 0.5) * WM, wr.maxY - (((i / wr.w) | 0) + 0.5) * WM)) agree++;
  }
  const frac = nW / water.length;
  log(`coastline flood: ${(frac * 100).toFixed(1)}% water, DEM agreement ${((agree / Math.max(1, nW)) * 100).toFixed(1)}%`);
  if (coast.length === 0 || frac > 0.97 || agree / Math.max(1, nW) < 0.6) {
    waterSource = 'dem';
    log('falling back to DEM water mask');
    for (let i = 0; i < water.length; i++) water[i] = dem.rawWater(wr.minX + ((i % wr.w) + 0.5) * WM, wr.maxY - (((i / wr.w) | 0) + 0.5) * WM) ? 2 : 0;
  }
  for (let i = 0; i < water.length; i++) if (water[i] === 1) water[i] = 2; // barrier is shoreline → water
  // inland water bodies (ponds, fountains, docks)
  for (const p of polysArea) if (p.tags.natural === 'water' || p.tags.waterway === 'riverbank' || p.tags.waterway === 'dock' || (p.tags.leisure === 'swimming_pool' && p.area > 3000) || p.tags.amenity === 'fountain')
  {
    // at river level (docks, basins) it joins the river; uphill (ponds, pools, fountains) it is drawn
    // on the ground instead — cutting the terrain there opened deep holes down to the river plane
    let g = 0; for (const [x, y] of p.outer) g += dem.ground(x, y); g /= p.outer.length;
    const v = g < 3 ? 2 : 3;
    wr.fillRings([p.outer, ...p.holes], (i) => { if (water[i] !== 2) water[i] = v; });
  }
  // a building stands on land: where the coastline or a dock polygon runs under one (Santos quays), the footprint is ground
  for (const p of polysB) if (!p.tags['building:part'] && p.tags.amenity !== 'ferry_terminal' && !p.tags.man_made && p.tags.building !== 'houseboat')
    wr.fillRings([p.outer], (i) => { if (water[i] === 2 || water[i] === 3) water[i] = 0; });
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
// the height of the rendered terrain mesh (8 m grid per 500 m tile, split b–d like the index buffer): small things
// (cars, lamps, trees, posts) sit on this so they neither float nor sink where the slope bends between grid nodes
const meshAt = (x, y) => {
  const ni_ = Math.ceil((maxX - minX) / TILE), nj_ = Math.ceil((maxY - minY) / TILE);
  const i = Math.max(0, Math.min(ni_ - 1, Math.floor((x - minX) / TILE))), j = Math.max(0, Math.min(nj_ - 1, Math.floor((y - minY) / TILE)));
  const x0 = minX + i * TILE, x1 = Math.min(maxX, x0 + TILE), y0 = minY + j * TILE, y1 = Math.min(maxY, y0 + TILE);
  const cols = Math.max(2, Math.round((x1 - x0) / GRID) + 1), rows = Math.max(2, Math.round((y1 - y0) / GRID) + 1);
  const fx = Math.max(0, Math.min(cols - 1.000001, ((x - x0) / (x1 - x0)) * (cols - 1))), fy = Math.max(0, Math.min(rows - 1.000001, ((y1 - y) / (y1 - y0)) * (rows - 1)));
  const c = Math.floor(fx), r = Math.floor(fy), u = fx - c, v = fy - r;
  const N = (rr, cc) => groundAt(x0 + ((x1 - x0) * cc) / (cols - 1), y1 - ((y1 - y0) * rr) / (rows - 1));
  const a = N(r, c), b = N(r, c + 1), d = N(r + 1, c), e = N(r + 1, c + 1);
  return u + v <= 1 ? a + u * (b - a) + v * (d - a) : e + (1 - u) * (d - e) + (1 - v) * (b - e);
};
if (process.env.DBG) { let mx = 0, sum = 0, n = 0, big = 0; for (let k = 0; k < 20000; k++) { const x = minX + Math.random() * (maxX - minX), y = minY + Math.random() * (maxY - minY), d = Math.abs(meshAt(x, y) - groundAt(x, y)); mx = Math.max(mx, d); sum += d; n++; if (d > 0.5) big++; } console.log('mesh vs groundAt: mean', (sum / n).toFixed(2), 'max', mx.toFixed(2), '>0.5m', big); }

// ─── colours ────────────────────────────────────────────────────────────
const srgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lin = (c) => c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
const NAMED = { white: '#f3f0ea', black: '#3a3a3a', grey: '#b8b4ad', gray: '#b8b4ad', silver: '#c8c8c8', beige: '#e8dcc0', yellow: '#e9c873', orange: '#df9a5a', red: '#b8553f', darkred: '#8e3b2e', brown: '#8a5a3c', pink: '#e9b6a6', blue: '#a9c0d2', lightblue: '#bcd0de', green: '#a9bf98', cream: '#efe4c8', tan: '#d6b98f', maroon: '#7c3a2e', ochre: '#d9a650' };
const ROOF_NAMED = { brown: '#a4604a', red: '#b05a43', orange: '#c47a55' };   // tagged tile roofs are terracotta, not paint-chart brown
// mappers pick paint-chart oranges (#f56f42, #ee4b2b…) for tile roofs; real Lisbon tiles are weathered terracotta.
// Keep the hue, cap saturation and pull lightness into the fired-clay band. Greys and greens just lose some punch.
const tameRoof = (v) => {
  if (!v) return null; v = v.toLowerCase().split(';').pop().trim();
  if (ROOF_NAMED[v]) return ROOF_NAMED[v];
  if (NAMED[v]) v = NAMED[v];
  if (!/^#[0-9a-f]{6}$/.test(v)) return v;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, l = (mx + mn) / 2, sat = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
  if (mx !== mn) h = mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
  h *= 60;
  const clay = (h < 40 || h > 340) && sat > 0.35;
  sat = Math.min(sat, clay ? 0.42 : 0.22); if (clay) l = Math.min(0.5, Math.max(0.38, l * 0.82));
  const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [R, G, B] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [R, G, B].map((q) => Math.round((q + m) * 255).toString(16).padStart(2, '0')).join('');
};
// façade colours tagged as paint-chart hex (#ffdd44, #80f090, #f7351b…): keep the hue but bring it to rendered-plaster
// strength: ochres and pinks may stay warm, greens and blues are mostly a mapper's highlighter (checked against Earth, IST)
const tameWall = (v) => {
  if (!v) return null; v = v.toLowerCase().split(';').pop().trim();
  if (!/^#[0-9a-f]{6}$/.test(v)) return v;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, l = (mx + mn) / 2, sat = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
  if (mx !== mn) h = mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
  h *= 60;
  const warm = h < 62 || h > 330;
  if (sat <= (warm ? 0.5 : 0.22) && l <= 0.94) return v;
  sat = Math.min(sat, warm ? 0.5 : h > 75 && h < 170 ? 0.14 : 0.22); l = Math.min(0.92, Math.max(0.3, l));
  const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [R, G, B] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [R, G, B].map((q) => Math.round((q + m) * 255).toString(16).padStart(2, '0')).join('');
};
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
  if (!tiles.has(k)) tiles.set(k, { i, j, b: makeSink(), d: makeSink(), balconies: [] });
  return tiles.get(k);
};
const stats = { authored: 0, buildings: 0, lidar: 0, height: 0, levels: 0, estimated: 0, planar: 0, skeleton: 0, flat: 0, skeletonFail: 0, parts: 0, skippedOutlines: 0, partyEdges: 0, balconies: 0, statues: 0, wallsM: 0, pillars: 0, chimneys: 0 };

const LEVEL_H = 3.2;
const DEFAULT_H = { church: 20, cathedral: 26, chapel: 10, house: 8, detached: 8, garage: 3, garages: 3, shed: 3, kiosk: 3.2, hut: 3, roof: 3.5, school: 13, hospital: 18, train_station: 12, ruins: 5, castle: 14, tower: 25, bunker: 3, carport: 3, pillar: 5, service: 3.5, construction: 6 };
// institutions (hospital, school, university, government, public, civic) in the old centre are mostly convents and palaces
// under tiled roofs; only built-for-purpose types default to flat-roofed modern boxes
const MODERN = new Set(['office', 'commercial', 'hotel', 'industrial', 'warehouse', 'transportation', 'train_station', 'parking']);
const HALLS = new Set(['sports_hall', 'warehouse', 'hangar', 'riding_hall', 'manufacture', 'storage_tank', 'silo', 'greenhouse', 'barn', 'factory']);
const RESI_KINDS = new Set(['residential', 'apartments', 'yes', 'flats', 'dormitory']);
const UTILITY = new Set(['roof', 'garage', 'garages', 'shed', 'hut', 'bunker', 'carport', 'kiosk', 'service', 'construction', 'ruins', 'pillar']);
const pal = (list) => list.map(([c, w]) => [srgb(c), w]);
// Lisbon façade colours as they read in daylight (weathered lime render and paint, not paint-chart chips; a 'white' wall is
// ~0.8 albedo, never 0.95, or the sun burns it to paper). Each palette is one era / type of building; shares are what you
// count walking (and flying over) the place. Few buildings carry building:colour in OSM (< 1 %), so these do the work.
// 2026-11-26: the earlier mixes were ~75 % lime white, and from the air the city read as plain white boxes (João).
const FC = {   // named façade tones, sRGB
  lime: '#ebe7de', limeW: '#e4dfd4', offw: '#efe9dc', cream: '#eadcbf', ivory: '#e6d8b6', paleY: '#ecd69a', ochre: '#dcb466', ochreD: '#c99a4f',
  rose: '#e1b2a2', roseP: '#e6c4b8', salmon: '#d99a7e', almagre: '#a75b47', blue: '#b5c7d4', blueG: '#a9b9c2', sage: '#c4cfa8', lilac: '#cdbfcc',
  lioz: '#dcd2bf', stoneP: '#cfc4ae', granite: '#a6a49e', graniteD: '#86847f', concrete: '#bcb8af', beige: '#ddcfb5', greyL: '#cfccc5', brick: '#a65d46', brownP: '#9c7a62',
};
const tones = (list) => pal(list.map(([k, w]) => [FC[k] || k, w]));
// old town houses (Alfama, Graça, Mouraria, Madragoa, the old village cores): still mostly lime white, but one in two is coloured
const VERNACULAR = tones([['lime', 34], ['limeW', 10], ['offw', 8], ['cream', 9], ['paleY', 9], ['ochre', 6], ['rose', 8], ['roseP', 4], ['salmon', 3], ['blue', 3], ['sage', 2], ['almagre', 2], ['lilac', 1], ['stoneP', 1]]);
// 18th–19th-century 4–5 storey blocks (Bairro Alto, Lapa, Estrela, Campo de Ourique, Santos): Pombaline ochre, rose, cream, sky blue
const POMBALINE = tones([['lime', 24], ['offw', 8], ['cream', 12], ['paleY', 11], ['ochre', 11], ['ochreD', 3], ['rose', 10], ['roseP', 5], ['salmon', 4], ['blue', 5], ['sage', 3], ['almagre', 2], ['lilac', 2]]);
// Avenidas Novas, Av. da Liberdade, Arroios, Estefânia (1880–1940): cream, pale stone and pastel, with lioz-dressed fronts
const AVENIDAS = tones([['lime', 18], ['offw', 6], ['cream', 16], ['ivory', 6], ['lioz', 10], ['stoneP', 5], ['paleY', 11], ['ochre', 5], ['rose', 10], ['roseP', 5], ['salmon', 3], ['blue', 3], ['sage', 2], ['lilac', 2]]);
// apartment blocks by era (see sub8 below): 0 punched windows (50s–60s), 1 balcony bands (60s–70s), 2 Português Suave (40s–50s), 3 80s–90s
const RESI_ERA = [
  tones([['lime', 28], ['offw', 12], ['cream', 14], ['beige', 10], ['paleY', 9], ['roseP', 8], ['greyL', 7], ['salmon', 3], ['sage', 3], ['blue', 2]]),
  tones([['lime', 28], ['offw', 8], ['concrete', 12], ['greyL', 8], ['beige', 14], ['cream', 10], ['paleY', 6], ['roseP', 6], ['ochre', 3], ['blueG', 4], ['brick', 2]]),
  tones([['cream', 24], ['ivory', 8], ['lioz', 12], ['stoneP', 6], ['paleY', 14], ['rose', 10], ['roseP', 6], ['lime', 12], ['ochre', 6], ['salmon', 3]]),
  tones([['lime', 22], ['offw', 6], ['roseP', 10], ['salmon', 8], ['beige', 14], ['cream', 8], ['ochre', 8], ['paleY', 6], ['brick', 6], ['greyL', 6], ['almagre', 3], ['brownP', 3]]),
];
const NEWTOWN_C = tones([['lime', 40], ['offw', 10], ['lioz', 14], ['greyL', 12], ['granite', 6], ['beige', 8], ['ochre', 4], ['roseP', 4], ['blueG', 2]]);   // Parque das Nações: white render, stone, glass
const HALL_C = pal([['#d9dbda', 4], ['#c9ccce', 3], ['#e4e1d9', 3], ['#b9bfc3', 2], ['#d6cfc0', 2]]);
// offices, hotels, shops: limestone and granite cladding, white render, grey panels
const MODERN_C = tones([['lioz', 20], ['stoneP', 8], ['lime', 16], ['greyL', 14], ['granite', 12], ['graniteD', 5], ['beige', 12], ['concrete', 8], ['brownP', 3], ['blueG', 2]]);
const PALACE_C = tones([['cream', 3], ['ochre', 2], ['rose', 2], ['offw', 3], ['paleY', 2], ['almagre', 1]]);
const VILLA_C = tones([['lime', 10], ['offw', 3], ['cream', 2], ['paleY', 1], ['roseP', 1]]);
// building:material → the wall tone it shows (plaster and tiles keep the palette / azulejo cladding)
const MATERIAL_C = { brick: FC.brick, stone: FC.lioz, limestone: FC.lioz, sandstone: FC.stoneP, granite: FC.granite, marble: FC.lioz, concrete: FC.concrete,
  cement_block: FC.concrete, glass: '#8f9ba3', metal: '#b5b9bb', steel: '#b5b9bb', wood: '#9a7656', timber_framing: '#e8e2d4' };
// Avenidas Novas / Av. da Liberdade / Arroios: the 1880–1940 grid north of Restauradores (local metres, origin Baixa)
const inAvenidas = (c) => c[0] > -1800 && c[0] < 1300 && c[1] > 450 && c[1] < 2700;
const STONE = srgb('#ddd2bd'), LIOZ = srgb('#e7dfcd'), CASTLE = srgb('#bfb5a3');
const ROOFS = pal([['#b5725f', 5], ['#bd7e69', 4], ['#a86a59', 3], ['#c28a75', 3], ['#9a6152', 2], ['#b27765', 3]]);   // sun-faded salmon terracotta (Earth over Alfama/Bairro Alto reads lighter and pinker than new tile)   // weathered terracotta, lighter with sun and lichen
const ESTATE_ROOFS = pal([['#c47a5c', 4], ['#bb7055', 3], ['#cf8a6a', 2], ['#b0654c', 2], ['#a9705f', 2], ['#9e6b5c', 1]]);   // newer machine-made tiles, brighter than the old town's
const BIG_ROOF = pal([['#a9adb0', 3], ['#bcbfbf', 3], ['#9ea4a8', 2], ['#c9c6bd', 2]]);   // metal decks and pale membranes on halls
const FLAT_ROOF = pal([['#b3aea5', 4], ['#a7a39b', 3], ['#bdb6aa', 3], ['#c9c2b5', 2], ['#9a968f', 2], ['#b57a5a', 1]]);   // terraces from the air: grey membrane, gravel, weathered screed; a bright white deck is the exception (it read as snow)
const TRIM = srgb('#f3efe6');

// Height for footprints that carry none (≈70 % of them): the storey count of mapped neighbours of similar size (blocks in
// one estate share a height), else a typed guess. (GHSL's 90 m built volume/surface grid was tried: its cells track mapped
// heights with r = 0.23, no better than the city mean, so it is not used.)
const KNOWN_H = (() => {
  const G = 45, cells = new Map();
  for (const q of polysB) {
    if (q.tags['building:part'] || q.area < 40) continue;
    const t = q.tags, lv = parseFloat(t['building:levels']);
    const hh = parseMeters(t.height) ?? parseMeters(t['building:height']) ?? (isFinite(lv) && lv > 0 ? lv * LEVEL_H + 1.2 : null);
    if (!(hh > 2.5 && hh < 120)) continue;
    const k = Math.floor(q.c[0] / G) + ',' + Math.floor(q.c[1] / G);
    (cells.get(k) || cells.set(k, []).get(k)).push([q.c[0], q.c[1], q.area, hh, t.building || 'yes']);
  }
  const HOUSE = ['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'villa'];
  const binKey = (area, house) => (house ? 'h' : 'b') + Math.round(Math.log2(area) * 2), bins = new Map();
  for (const list of cells.values()) for (const r of list) { const k = binKey(r[2], HOUSE.includes(r[4])); (bins.get(k) || bins.set(k, []).get(k)).push(r[3]); }
  for (const b of bins.values()) b.sort((x, y) => x - y);
  const wmed = (out) => { out.sort((a, b) => a[0] - b[0]); const tot = out.reduce((s, o) => s + o[1], 0); let acc = 0;
    for (const o of out) { acc += o[1]; if (acc >= tot / 2) return o[0]; } return out.at(-1)[0]; };
  // leave-one-out on mapped buildings: within 90 m, median error 1.4 m (Olivais) – 3.3 m (Benfica) against 5–8 m for a typed
  // guess; the 90–220 m ring still beats the guess (2.5–6.7 m), so it is the second tier
  return (p) => {
    const near = [], far = [], cx = Math.floor(p.c[0] / G), cy = Math.floor(p.c[1] / G);
    const house = HOUSE.includes(p.tags.building);
    for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) for (const r of cells.get((cx + i) + ',' + (cy + j)) || []) {
      if (house !== HOUSE.includes(r[4])) continue;
      const d = Math.hypot(r[0] - p.c[0], r[1] - p.c[1]);
      if (d <= 90 && r[2] >= p.area * 0.3 && r[2] <= p.area * 3.5) near.push([r[3], 1 / (d + 15)]);
      else if (d <= 220 && r[2] >= p.area * 0.2 && r[2] <= p.area * 5) far.push([r[3], 1 / (d + 15)]);
    }
    if (near.length >= 3) return wmed(near);
    if (far.length >= 4) return wmed(far);
    const b = bins.get(binKey(p.area, house));   // third tier: mapped buildings of this size anywhere in the area (MAE 3.6–6.4 m vs 4–8 m)
    return b && b.length >= 5 ? b[b.length >> 1] : null;
  };
})();
const BELEM_C = proj.fwd(38.6975, -9.2045);
const MODERN_ZONES = [[[38.7480, -9.1000], [38.7480, -9.0880], [38.8000, -9.0880], [38.8000, -9.0985], [38.7700, -9.0975], [38.7600, -9.0990]]].map((r) => r.map(([la, lo]) => proj.fwd(la, lo)));
const inModernZone = (c) => MODERN_ZONES.some((z) => pointInRing(c[0], c[1], z));
let heightSrc = { neighbours: 0, guess: 0, lidar: 0, lidarSkip: 0 };
// Measured heights: the DGT 2024 LiDAR survey (surface − terrain at 2 m, data/lidar, see pipeline/fetch_lidar.py). Each
// footprint is sampled on a 1.5 m grid kept clear of its outline (the resampled cells blur across the eaves); the low quartile
// is the eave, the 95th percentile the ridge, the 60th the deck of a flat roof.
const LIDAR = await (async () => {
  const f = path.join(ROOT, 'data/lidar', `${AREA}_ndsm.tif`); if (!fs.existsSync(f)) return null;
  const img = await (await fromFile(f)).getImage(), [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
  const [r] = await img.readRasters(), w = img.getWidth(), hh = img.getHeight();
  log(`LiDAR heights ${w}×${hh}`);
  return (x, y) => { const [la, lo] = proj.inv(x, y), c = Math.floor((lo - ox) / rx), k = Math.floor((la - oy) / ry); return c < 0 || k < 0 || c >= w || k >= hh ? NaN : r[k * w + c] / 10 + (dem.dtmLift ? dem.dtmLift(x, y) : 0); };
})();
const segDist = (x, y, R) => { let m = Infinity; for (let i = 0, j = R.length - 1; i < R.length; j = i++) { const [ax, ay] = R[j], [bx, by] = R[i], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)); m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy)); } return m; };
const measured = (p) => {
  if (!LIDAR || p.area < 12) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of p.outer) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const st = Math.max(1.5, Math.sqrt(p.area / 1500));
  for (const margin of [1.2, 0.5]) {
    const v = [];
    for (let y = y0 + st / 2; y < y1; y += st) for (let x = x0 + st / 2; x < x1; x += st) {
      if (!pointInRing(x, y, p.outer) || p.holes.some((h) => pointInRing(x, y, h))) continue;
      if (segDist(x, y, p.outer) < margin || p.holes.some((h) => segDist(x, y, h) < margin)) continue;
      const z = LIDAR(x, y); if (isFinite(z)) v.push(z);
    }
    if (v.length >= 4) { v.sort((a, b) => a - b); const q = (f) => v[Math.min(v.length - 1, Math.floor(f * v.length))]; return { lo: q(0.25), mid: q(0.6), top: q(0.95), n: v.length }; }
  }
  return null;
};
// Stepped landmarks (CGD's Campus XXI): one height cannot stand for a building that climbs in terraces. The survey is cut
// into storey bands; each band becomes a slab over the part of the plan that reaches it, stacked on the band below, so
// the massing is the measured one and no two walls share a plane. OVERRIDES set terraces: { step, minArea }.
const terraceSlabs = (p) => {
  const T = OVERRIDES[p.id].terraces, step = T.step || 3.6, G = 2, SC = 100, minArea = T.minArea || 30;
  if (!LIDAR) return [p];
  // the grid runs along the building's own axes, so terrace edges come out square to the façades, not stair-stepped
  const { ux, uy } = obb(p.outer), W = (u, v) => [u * ux - v * uy, u * uy + v * ux];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of p.outer) { const u = x * ux + y * uy, v = -x * uy + y * ux; x0 = Math.min(x0, u); y0 = Math.min(y0, v); x1 = Math.max(x1, u); y1 = Math.max(y1, v); }
  const nx = Math.ceil((x1 - x0) / G), ny = Math.ceil((y1 - y0) / G), raw = new Float32Array(nx * ny).fill(NaN);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const [x, y] = W(x0 + (i + 0.5) * G, y0 + (j + 0.5) * G);
    if (pointInRing(x, y, p.outer) && !p.holes.some((h) => pointInRing(x, y, h))) raw[j * nx + i] = LIDAR(x, y);
  }
  const hz = new Float32Array(nx * ny), MR = T.median ?? 2;   // 5×5 median: roof plant, rooftop trees and edge blur do not make terraces
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = []; for (let b = -MR; b <= MR; b++) for (let a = -MR; a <= MR; a++) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < nx && jj < ny && isFinite(raw[jj * nx + ii])) v.push(raw[jj * nx + ii]); }
    v.sort((a, b) => a - b); hz[j * nx + i] = isFinite(raw[j * nx + i]) && v.length ? v[v.length >> 1] : 0;
  }
  const C = (r) => r.map(([x, y]) => ({ X: Math.round(x * SC), Y: Math.round(y * SC) }));
  const run = (op, subj, clip) => { const c = new ClipperLib.Clipper(); c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true); if (clip) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true); const o = new ClipperLib.Paths(); c.Execute(op, o, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero); return o; };
  const off = (paths, d) => { const co = new ClipperLib.ClipperOffset(2, 25); co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon); const o = new ClipperLib.Paths(); co.Execute(o, d * SC); return o; };
  const plan = run(ClipperLib.ClipType.ctUnion, [C(p.outer), ...p.holes.map((h) => C(h).reverse())]);
  const top = Math.max(...hz), K = Math.round(top / step), out = [];
  let ground = 0, gn = 0; for (const [x, y] of p.outer) { ground += groundAt(x, y); gn++; } ground /= gn;
  let prev = plan;
  for (let k = 1; k <= K; k++) {
    const L = k * step, cells = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (hz[j * nx + i] >= L - step / 2) {
      let i2 = i; while (i2 + 1 < nx && hz[j * nx + i2 + 1] >= L - step / 2) i2++;   // one run of cells per row keeps the union cheap
      const ax = x0 + i * G, bx = x0 + (i2 + 1) * G, ay = y0 + j * G, by = ay + G;
      cells.push(C([W(ax, ay), W(bx, ay), W(bx, by), W(ax, by)])); i = i2;
    }
    if (!cells.length) break;
    let reg = run(ClipperLib.ClipType.ctUnion, cells);
    const R = T.smooth ?? 3; reg = off(off(reg, R), -R); reg = off(off(reg, -R), R);   // close gaps, then open away spurs narrower than a terrace
    reg = run(ClipperLib.ClipType.ctIntersection, k === 1 ? plan : reg, k === 1 ? null : prev);   // nested: a slab never overhangs the one below
    if (k === 1) reg = plan;   // the bottom slab is the mapped outline itself (crisp street walls)
    reg = ClipperLib.Clipper.CleanPolygons(ClipperLib.Clipper.SimplifyPolygons(reg, ClipperLib.PolyFillType.pftNonZero), 1.4 * SC);
    const c = new ClipperLib.Clipper(); c.AddPaths(reg, ClipperLib.PolyType.ptSubject, true);
    const tree = new ClipperLib.PolyTree(); c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    const keep = [];
    for (const ch of tree.Childs()) {
      const outer = ch.Contour().map((q) => [q.X / SC, q.Y / SC]), holes = ch.Childs().map((hh) => hh.Contour().map((q) => [q.X / SC, q.Y / SC])).filter((r) => Math.abs(ringArea(r)) > 20);
      if (ringArea(outer) < 0) outer.reverse(); holes.forEach((r) => { if (ringArea(r) > 0) r.reverse(); });
      const area = ringArea(outer) + holes.reduce((a, r) => a + ringArea(r), 0);
      if (area < minArea || outer.length < 3) continue;
      keep.push(ch.Contour(), ...ch.Childs().map((hh) => hh.Contour()));
      const c0 = [outer.reduce((a, q) => a + q[0], 0) / outer.length, outer.reduce((a, q) => a + q[1], 0) / outer.length];
      out.push({ id: `${p.id}_t${k}_${out.length}`, tags: p.tags, outer, holes, area, c: c0, ground, ovr: { ...OVERRIDES[p.id], terraces: undefined, h: L, minH: (k - 1) * step, floorH: step, groundH: step, shape: 'flat', parapet: k === K ? 1 : 0 } });
    }
    if (!keep.length) break;
    prev = keep;
  }
  return out.length ? out : [p];
};
// complexes clad in one stone: buildings inside these mapped sites take its colour (CCB: pinkish lioz limestone)
// detached houses outside the old core (Restelo, Belém, Lumiar, the suburbs): villas and moradias in their gardens
const VILLA_KINDS = new Set(['house', 'detached', 'villa', 'bungalow', 'semidetached_house']);
const isVilla = (p) => { const k = p.tags.building, a = Math.abs(p.area), lv = parseFloat(p.tags['building:levels']);
  return !p.tags['building:part'] && a > 50 && a < 700 && !(lv > 3) && (VILLA_KINDS.has(k) || ((k === 'yes' || k === 'residential') && a < 400)) && Math.hypot(p.c[0], p.c[1] * 1.15) > 2500; };
const STONE_SITES = polysArea.filter((a) => ['r10093261_0'].includes(a.id)).map((a) => ({ ring: a.outer, wall: '#dad3c6', flat: [206, 200, 188] }));
function buildingSpec(p) {
  const t = p.tags, kind = t.building && t.building !== 'yes' ? t.building : t['building:part'] && t['building:part'] !== 'yes' ? t['building:part'] : t.building || 'yes';
  const u = (k) => hash(p.id + k);
  let h = parseMeters(t.height) ?? parseMeters(t['building:height']);
  let levels = parseFloat(t['building:levels']);
  // a measured height beats a mapped one and any estimate; a footprint the survey sees as open ground (demolished, or
  // built after 2024) keeps the old way. A storey count that cannot fit the measured height is dropped.
  let lid = p.ovr || OVERRIDES[p.id] || p.tags.man_made === 'tower' || t.building === 'carport' ? null : measured(p);
  // canopies (building=roof) sit at their measured height, not a default 3.5 m (FIL's halls, Estufa Fria, market roofs); a reading
  // above 30 m under a canopy is the bridge or a tower over it, not the canopy
  if (lid && kind === 'roof' && lid.mid > 30) lid = null;
  const lidOk = lid && lid.mid >= 2.2 && lid.mid < 200;
  if (lid && !lidOk) heightSrc.lidarSkip++;
  if (lid && !lidOk && lid.top < 2 && lid.n >= 20 && (kind === 'storage_tank' || /reservoir/.test(t.man_made || ''))) h = 2;   // covered reservoirs: a grassed lid, not a 16 m block
  if (lidOk) { h = Math.max(lid.mid, (parseMeters(t.min_height) ?? 0) + 2); if (isFinite(levels) && Math.abs(levels * LEVEL_H + 1.2 - h) > 4.5) levels = NaN; }
  const roofLevels = parseFloat(t['roof:levels']) || 0;
  let minH = parseMeters(t.min_height) ?? (isFinite(parseFloat(t['building:min_level'])) ? parseFloat(t['building:min_level']) * LEVEL_H : 0);
  const pillar = kind === 'pillar' || t.man_made === 'pillar';
  const castleType = t.castle_type || '';
  const palace = kind === 'palace' || ['palace', 'stately', 'manor'].includes(castleType);
  const castle = !palace && (kind === 'castle' || t.historic === 'castle' || castleType === 'defensive' || castleType === 'castle');
  const church = ['church', 'cathedral', 'chapel', 'basilica'].includes(kind) || (t.amenity === 'place_of_worship' && !t['building:part']);
  const monument = t.historic === 'monument' || t.historic === 'memorial' || t.man_made === 'tower';
  const modern = !palace && !church && (MODERN.has(kind) && (p.area > 700 || levels >= 7)) || levels >= 9 || (t['building:material'] || '').match(/glass|concrete/);
  let src = 'height', estLevels = NaN;
  if (lidOk) { src = 'lidar'; heightSrc.lidar++; if (!isFinite(levels)) estLevels = Math.max(1, Math.round((h - minH - 1.2) / LEVEL_H)); }
  if (h == null && isFinite(levels)) { h = levels * LEVEL_H + 1.2 + (roofLevels ? 2.8 : 0); src = 'levels'; }
  if (h == null) {
    src = 'estimated';
    const typed = kind === 'silo' || t.man_made === 'silo' ? (p.area > 2000 ? 48 : p.area > 300 ? 30 : 16) : DEFAULT_H[kind];   // grain and cement silos stand tall (Trafaria's ~50 m, checked against Earth)
    const small = p.area < 30 || UTILITY.has(kind) || ['garage', 'garages', 'shed', 'kiosk', 'hut', 'roof', 'carport', 'bunker', 'service', 'ruins', 'pillar', 'construction'].includes(kind);
    const special = ['church', 'cathedral', 'chapel', 'castle', 'tower', 'palace', 'basilica'].includes(kind) || t.amenity === 'place_of_worship' || kind === 'silo' || t.man_made === 'silo';
    const nb = small || special || t['building:part'] ? null : KNOWN_H(p);
    if (nb != null) { h = nb * (0.94 + u('h') * 0.12); estLevels = Math.max(1, Math.round((h - 1.2) / LEVEL_H)); heightSrc.neighbours++; }   // window rows follow the borrowed storey count
    else { h = typed ?? (p.area < 30 ? 3.5 : p.area < 90 ? 9 + u('h') * 4 : 12.5 + u('h') * 5); heightSrc.guess++; }
  }
  if (palace && src === 'estimated') h = Math.max(h, 13 + u('ph') * 4);   // palaces tagged 'house' are not 8 m cottages
  if (kind === 'roof' && !minH) minH = Math.max(0, h - 0.8);
  const party = (p.party || []).filter(Boolean).length;
  // halls (sports halls, warehouses, hangars, big industrial sheds): blank cladding, no window grid
  const hall = !church && !palace && (HALLS.has(kind) || (kind === 'industrial' && p.area > 600) || (['sports_centre', 'sports_hall'].includes(t.leisure) && p.area > 500));
  // the 1950s–80s apartment blocks of Olivais, Benfica, Telheiras, Lumiar, Amadora: 8+ storeys, flat roofs, punched windows,
  // roller shutters and balconies — not office glass
  // outside the 18th–19th-century core (Baixa, Alfama, Bairro Alto, Lapa, Graça, Campo de Ourique) and old Belém, a 4+ storey
  // residential block is a post-war estate block (Olivais, Benfica, Telheiras, Odivelas): cream render, flat roof, shutters
  const newTown = inModernZone(p.c);   // Parque das Nações (built from 1995): flat roofs, white render and glass throughout
  const core = Math.hypot(p.c[0], p.c[1] * 1.15) < 2500 || Math.hypot(p.c[0] - BELEM_C[0], p.c[1] - BELEM_C[1]) < 650;
  const resiTall = !(t['building:material'] || '').match(/glass/) && !palace && !church && !castle && RESI_KINDS.has(kind) && h < 130 && p.area > 120 &&   // (levels ≥ 9 alone used to make a 26-storey tower 'modern' and drop it into the old-town palette)
   
    ((isFinite(levels) ? levels >= 8 : h >= 25) || (!core && (isFinite(levels) ? levels >= 4 : h >= 13.5)));
  const officeTall = !resiTall && (levels >= 9) && !RESI_KINDS.has(kind);
  // post-war institutions outside the core (schools, hospitals, faculties, ministries): white punched-window blocks, flat roofs;
  // shops and offices outside the core: modern cladding
  const instOut = !core && !church && !palace && !castle && ['school', 'university', 'college', 'hospital', 'public', 'civic', 'government', 'kindergarten'].includes(kind) && h >= 7;
  const bizOut = !core && !church && !palace && ['office', 'commercial', 'retail', 'hotel'].includes(kind) && h >= 9;
  let variant = hall ? 1 : resiTall || instOut || (newTown && RESI_KINDS.has(kind) && h >= 9 && !church) ? 8 : bizOut || (newTown && !church && !palace && h >= 9) ? 3 : (modern && !(levels >= 9 && RESI_KINDS.has(kind) && !MODERN.has(kind))) || officeTall ? 3 : palace ? 4 : church || castle || monument ? 5 : (isFinite(levels) ? levels >= 4 : h >= 14) && party >= 1 ? 0 : 1;
  // 1950s–70s infill in the 19th-century grid (Arroios, Campo de Ourique, Avenidas Novas): about one 6–9 storey block in three is
  // a plain flat-roofed apartment building among the tiled ones (checked against Earth)
  const infill = core && Math.hypot(p.c[0], p.c[1]) > 1100 && (variant === 0 || variant === 1) && !hall && !palace && !church && RESI_KINDS.has(kind) && h >= 17 && h < 30 && !t['roof:shape'] && !t['building:part'] && u('infill') < 0.33;
  if (infill) variant = 8;
  const mat = (t['building:material'] || t['building:facade:material'] || '').toLowerCase().split(/[;,]/)[0].trim();
  if ((variant === 0 || variant === 1) && !hall && /^(tiles?|azulejos?|ceramic)$/.test(mat)) variant = 2;   // mapped azulejo fronts
  if ((variant === 0 || variant === 1) && !hall && u('azu') < (variant === 1 ? 0.11 : 0.08)) variant = 2; // azulejo-clad
  const stone = castle || pillar || (church && !t['building:colour']) || (monument && !UTILITY.has(kind));
  const utility = UTILITY.has(kind) || p.area < 25 || hall;
  // roof shape
  let shape = (t['roof:shape'] || '').toLowerCase().replace('half-hipped', 'hipped').replace('side_hipped', 'hipped');
  if (!shape) {
    if (hall && !t['building:part'] && p.area > 500) {   // halls: sports pavilions often under a shallow metal barrel, sheds under a low metal gable
      const sport = kind === 'sports_hall' || ['sports_centre', 'sports_hall'].includes(t.leisure);
      shape = sport ? (u('hr') < 0.55 ? 'round' : 'flat') : ['warehouse', 'industrial', 'manufacture', 'factory', 'barn', 'hangar'].includes(kind) && p.area < 2500 && u('hr') < 0.6 ? 'gabled' : 'flat';   // bigger factory halls: flat outline under sawtooth teeth (see sawtoothRoof)
    }
    else if (((newTown || instOut || bizOut) && !church) || infill) shape = 'flat';
    else if (variant === 8 && !instOut && (h < 21 ? u('rs8') < 0.72 : h < 32 && u('rs8') < 0.4) && !t['building:part'] && !(p.area > 1500 && obb(p.outer).hw > 14)) shape = 'hipped';   // a 30 m-deep plan is a hall or a mall, not an estate block (Sacavém)   // Avenidas Novas, Alvalade: about two in five 7–9 storey blocks too   // most 4–6 storey estate blocks (Olivais, Alvalade, Benfica) wear a low tile hip
    else if (castle || pillar || kind === 'roof' || t['building:part'] || modern || monument || hall || variant === 8 || variant === 3) shape = 'flat';
    else if (church) shape = 'gabled';
    else if (roofLevels >= 1) shape = 'mansard';
    else if ((p.area > 3000 && (levels >= 6 || h > 22)) || h > 34) shape = 'flat';   // big low blocks in the old city are convents and palaces under hip roofs
    else if (p.area > 2500 && !p.holes.length && !church && !palace && obb(p.outer).hw > 16) shape = 'flat';   // halls, malls, warehouses: a single hip over a 30 m+ span is not how anything here is roofed
    else if (utility && p.area < 40) shape = 'flat';
    else if (variant === 1 && isVilla(p) && p.area > 110 && !hall && u('vf') < 0.33) shape = 'flat';   // modern villa: white box, roof terrace
    else if ((variant === 1 || variant === 2) && p.area < 350) { const r = u('rs'); shape = r < 0.1 ? 'flat' : r < 0.3 ? 'gabled' : 'hipped'; }   // old-town mix: terraces (açoteias), gables, hips
    else shape = 'hipped';
  }
  if (['saltbox', 'double_saltbox', 'quadruple_saltbox', 'crosspitched'].includes(shape)) shape = 'hipped';
  if (['round', 'gambrel_round', 'barrel'].includes(shape)) shape = 'round';   // barrel vault (built only on near-rectangular plans)
  const floorH = utility || stone || castle ? 0
    : isFinite(levels) && levels > 0 ? Math.min(4.6, Math.max(2.7, (h - minH - (roofLevels ? 2.8 : 0)) / (levels + 0.3)))
    : isFinite(estLevels) ? Math.min(4.6, Math.max(2.7, (h - minH) / (estLevels + 0.3)))
    : variant === 0 ? 3.4 : variant === 3 ? 3.3 : variant === 8 ? 2.9 : variant === 4 ? 4.4 : 3.0;
  const groundH = variant === 0 ? Math.max(floorH, 3.9) : variant === 8 ? Math.max(floorH, 3.6) : variant === 3 ? Math.max(floorH, 4.2) : variant === 4 ? floorH * 1.1 : Math.max(floorH, 2.9);
  const bayW = variant === 8 ? 2.6 + u('bw') * 0.8 : variant === 3 ? 1.6 + u('bw') * 0.6 : variant === 4 ? 3.6 + u('bw') * 0.8 : variant === 5 ? 5.5 : variant === 0 ? 2.7 + u('bw') * 0.5 : 2.5 + u('bw') * 1.1;
  const balconyFloors = variant === 0 || (variant === 2 && u('p') < 0.5) ? [1, ...(u('b2') < 0.55 ? [2] : []), ...(u('b3') < 0.3 ? [3] : [])] : variant === 1 || variant === 2 ? [1, 2, 3, 4] : variant === 4 ? [1] : [];
  const balconyChance = variant === 0 ? 1 : variant === 4 ? 0.6 : 0.2;
  const palette = hall ? HALL_C : newTown ? NEWTOWN_C : variant === 3 ? MODERN_C : variant === 4 ? PALACE_C
    : (variant <= 2) && inAvenidas(p.c) ? AVENIDAS : variant === 0 ? POMBALINE : VERNACULAR;
  let wall = parseColour(tameWall(t['building:colour'])) || (MATERIAL_C[mat] && srgb(MATERIAL_C[mat])) || (shape === 'flat' && variant === 1 && isVilla(p) ? pick(VILLA_C, u('w')) : castle ? CASTLE : stone ? LIOZ : church ? STONE : variant === 8 ? null : pick(palette, u('w')));
  const roofCol = parseColour(tameRoof(t['roof:colour'])) || pick(hall && shape !== 'hipped' ? BIG_ROOF : variant === 8 ? ESTATE_ROOFS : ROOFS, u('r'));
  const flatCol = castle ? [170, 162, 148] : shape === 'flat' && parseColour(tameRoof(t['roof:colour'])) || pick(p.area > 2500 || hall ? BIG_ROOF : FLAT_ROOF, u('f'));
  const pitch = hall && shape === 'gabled' ? 7 + u('pt') * 5 : shape === 'pyramidal' ? 40 : church ? 34 : variant === 8 ? 16 + u('pt') * 6 : 24 + u('pt') * 13;
  const spec = { kind, h, minH, src, shape, floorH, groundH, bayW, variant, stone, castle, pillar, wall, roofCol, flatCol, pitch,
    roofH: parseMeters(t['roof:height']), balconyFloors: floorH && variant !== 8 ? balconyFloors : [], balconyChance, parapet: variant === 3 || variant === 8 ? 1.1 : castle ? 0 : hall ? 0.5 : 0.8 };
  if (lidOk && shape !== 'flat') {   // pitched: the walls stop at the eave, the roof rises to the measured ridge
    const eave = Math.max(minH + 2.2, Math.min(lid.lo, h)), f = (eave - minH) / Math.max(1, h - minH);
    spec.h = eave; spec.roofH = spec.roofH ?? Math.max(1, Math.min(6, lid.top - eave));
    if (spec.floorH) { spec.floorH = Math.max(2.6, spec.floorH * f); spec.groundH = Math.max(spec.floorH, spec.groundH * f); }
  }
  if (variant === 3 && ['office', 'commercial', 'bank'].includes(kind) && h >= 15 && u('cw') < 0.45) spec.msBand = [0.02, 0.26];   // offices: nearly half in curtain-wall glass (Avenidas Novas, Marquês, Parque das Nações)
  if (variant === 8) {   // era of the block, by district: 0 punched + shutters, 1 balcony bands (60s–70s), 2 Português Suave (40s–50s), 3 aluminium + marquises (80s–90s)
    const [x, y] = p.c, w = instOut ? [0.6, 0.4, 0, 0]
      : x > -880 && x < 1030 && y > 2690 && y < 4800 ? [0.35, 0.1, 0.55, 0]     // Alvalade, Areeiro, Av. de Roma
      : x > 1280 && x < 3450 && y > 4800 && y < 7900 && !newTown ? [0.45, 0.45, 0, 0.1]   // Olivais Norte / Sul
      : newTown ? [0.3, 0.45, 0, 0.25]
      : core ? [0.45, 0.3, 0.15, 0.1]
      : y > 5500 || x < -4000 ? [0.35, 0.2, 0, 0.45]                         // Telheiras, Lumiar, Carnide, Amadora, Odivelas: 80s onward
      : [0.45, 0.3, 0.05, 0.2];
    let r = u('era'), k = 0; while (k < 3 && r >= w[k]) r -= w[k++];
    spec.sub8 = k;
    if (!spec.wall) spec.wall = pick(newTown ? NEWTOWN_C : RESI_ERA[k], u('w'));
  }
  if (!spec.wall) spec.wall = pick(RESI_ERA[0], u('w'));
  const site = STONE_SITES.find((z) => pointInRing(p.c[0], p.c[1], z.ring));
  if (site && !t['building:colour']) { spec.wall = srgb(site.wall); spec.flatCol = site.flat; spec.roofCol = srgb(site.wall); spec.stone = true; spec.balconyFloors = []; }   // CCB: big blank walls of dressed stone, hardly a window (checked against Earth)
  const o = p.ovr || OVERRIDES[p.id]; // hand-authored
  if (o) { Object.assign(spec, o, { src: 'authored' }); if (o.wall) spec.wall = srgb(o.wall); if (o.roofCol) spec.roofCol = srgb(o.roofCol); }
  if (process.env.DBG_ID === p.id) console.log('SPEC', p.id, JSON.stringify({ ...spec, src: spec.src }));
  return spec;
}

const FAR = [];   // footprints for the far level of detail (one block per building)
const BAD = []; // guard: any building vertex far outside the diorama fails the build
const tileB0 = (x, y) => { const [ti, tj] = tileOf(x, y); return getTile(ti, tj).b; };
function addBuilding(p) {
  const S0 = (() => { const [ti, tj] = tileOf(p.c[0], p.c[1]); return getTile(ti, tj).b; })(), n0 = S0.pos.length;
  addBuilding_(p);
  for (let i = n0 + 1; i < S0.pos.length; i += 3) if (S0.pos[i] < -40 || S0.pos[i] > 400 || !isFinite(S0.pos[i])) { { BAD.push(`${p.id} y=${S0.pos[i].toFixed(0)}`); break; } }
}
function addBuilding_(p) {
  const s = buildingSpec(p);
  stats.buildings++; stats[s.src]++;
  let seed = hash(p.id + 'seed');
  if (s.sub8 !== undefined || s.msBand) {   // the shader reads the sub-style from fract(seed·23.17) of the 12-bit seed it receives
    const [lo, hi] = s.msBand || [[0, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1]][s.sub8];
    for (let k = 0; k < 200; k++) {
      const q = Math.round(seed * 4095) / 4095, sn = Math.round(q * 4096) / 4096, ms = (sn * 23.17) % 1;
      if (ms > lo + 0.01 && ms < hi - 0.01) { seed = q; break; }
      seed = hash(p.id + 'seed' + k);
    }
  }
  const rng = (k) => hash(p.id + k);
  const rings = [p.outer, ...p.holes];
  let tmin = Infinity, tsum = 0, n = 0;
  for (const r of rings) for (const [x, y] of r) { const g = groundAt(x, y); tmin = Math.min(tmin, g); tsum += g; n++; }
  const ground = p.ground ?? tsum / n;
  const bottom = s.minH > 0 ? ground + s.minH : tmin - 1.5;
  const top = ground + s.h;
  const [ti, tj] = tileOf(p.c[0], p.c[1]);
  const T = getTile(ti, tj), S = T.b;
  const colWall = lin(jitter(s.wall, rng('j'), 7)), colRoof = lin(jitter(s.roofCol, rng('k'), 10)), colFlat = lin(jitter(s.flatCol, rng('fl'), 6));
  const colTrim = lin(s.stone ? jitter(s.wall, 0.6, 4) : TRIM);
  const party = p.party || p.outer.map(() => false);
  stats.partyEdges += party.filter(Boolean).length;
  if (s.kind === 'roof' && s.minH > 1.5) {   // free-standing canopies (station shelters, petrol stations, markets) stand on slim posts
    const post = lin(srgb('#8f9296')), PLp = [KIND.PLAIN / 8, 5 / 8, 0.3, 1];
    let k = 0;
    for (const r of [p.outer]) {
      let since = 99;                                   // metres walked since the last post: corners get one, long edges one every 9 m
      for (let i = 0; i < r.length && k < 80; i++) {
        const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let t = 0; t < L; t += 1, since += 1) {
          if (!(since >= 9 || (t === 0 && since >= 3))) continue;
          const x = a[0] + (b[0] - a[0]) * (t / L), y = a[1] + (b[1] - a[1]) * (t / L);
          const dx = p.c[0] - x, dy = p.c[1] - y, dl = Math.hypot(dx, dy) || 1, px = x + (dx / dl) * 0.45, py = y + (dy / dl) * 0.45;
          box(S, px, py, 1, 0, 0.13, 0.13, groundAt(px, py) - 0.3, bottom, post, [0, 0, 0, 0], PLp); k++; since = 0;
        }
      }
    }
  }

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
  let barrel = null, domeR = null;
  if (s.shape === 'dome' && ob && ob.hw / ob.hl > 0.8 && fill > 0.7 && fill < 0.87 && !p.holes.length) {   // a round plan under roof:shape=dome: a true spherical cap on a drum (the straight-skeleton dome came out as a cone)
    const r = Math.sqrt(Math.abs(p.area) / Math.PI); wallTop = top - Math.min(s.roofH ?? r * 0.85, Math.max(0, s.h - s.minH - 1)); domeR = { r, rise: top - wallTop };
  }
  else if (s.shape === 'round') {   // barrel vault along the long axis of a near-rectangular plan; otherwise flat
    if (planarOK && ob.hw > 6) { barrel = { ob, rise: s.roofH ?? Math.min(9, ob.hw * 0.32) }; wallTop = top - Math.min(barrel.rise, Math.max(0, s.h - s.minH - 2.5)); barrel.rise = top - wallTop; }
  }
  else if (pitched && s.shape !== 'flat') {
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
  const ctx = { outer: p.outer, holes: p.holes, party, ground, bottom, wallTop, spec, seed, colWall, colRoof, colTrim, colFlat, colCap: colRoof.map((v) => v * 0.8), rng, cx: p.c[0], cy: p.c[1], D: T.d };
  const res = buildRoofAndWalls(S, ctx);
  if (barrel) barrelRoof(S, { ob: barrel.ob, z0: wallTop, rise: barrel.rise, col: colRoof, under: colWall });
  if (domeR && domeR.rise > 0.5) { plainDome(S, { cx: p.c[0], cy: p.c[1], r: domeR.r * 0.98, z0: wallTop, rise: domeR.rise, col: colRoof, lin, srgb }); stats.domes = (stats.domes || 0) + 1; }
  if (mode === 'flat' && ['industrial', 'warehouse', 'manufacture', 'factory'].includes(s.kind) && Math.abs(p.area) > 2500 && !OVERRIDES[p.id] && hash(p.id + 'saw') < 0.7) {
    const sym = hash(p.id + 'sym') < 0.5, tile = hash(p.id + 'tile') < 0.45, sw = 9 + hash(p.id + 'sw') * 5;   // half the old halls are rows of plain gabled naves, tiled or sheeted (Marvila, checked against Earth)
    const k = sym ? sawtoothRoof(S, { outer: p.outer, holes: p.holes, z0: wallTop, lin, srgb, sym: true, w: sw, pitch: sw, rise: sw * 0.24, metal: tile ? '#b27460' : '#9fa3a4' })
      : sawtoothRoof(S, { outer: p.outer, holes: p.holes, z0: wallTop, lin, srgb }); if (k) stats.sawtooth = (stats.sawtooth || 0) + 1;
  }
  if (mode === 'skeleton' && s.shape === 'mansard') profileRoof(S, sk, { ...ctx, bayW: s.bayW, variant: s.variant }, mansardProfile(1.3, 2.6, 0.5, top - wallTop));
  else if (mode === 'skeleton') skeletonRoof(S, sk, ctx, sl, 5.5, ['dome', 'onion', 'cone'].includes(s.shape));
  if (!s.stone && s.h > 5) { roofExtras(ctx.D || S, ctx, res.f, rng, mode !== 'flat'); stats.chimneys++; }
  // solar panels on about a third of the flat-roofed villas (Restelo, Belém from above)
  if (mode === 'flat' && isVilla(p) && hash(p.id + 'pv') < 0.35) {
    const o = obb(p.outer), pc = srgb('#2d3a4c').map((v) => v), PVS = [KIND.PLAIN / 8, 5 / 8, 0.2, 1];
    if (o && o.hl > 4 && o.hw > 3) { const nU = Math.min(6, Math.floor((o.hl * 1.2) / 1.1)), nV = Math.min(3, Math.floor((o.hw * 0.9) / 1.8));
      for (let a = 0; a < nU; a++) for (let b = 0; b < nV; b++) { const du = (a - (nU - 1) / 2) * 1.1, dv = (b - (nV - 1) / 2) * 1.8;
        const x = o.cx + o.ux * du + o.vx * dv, y = o.cy + o.uy * du + o.vy * dv; if (!pointInRing(x, y, p.outer)) continue;
        box(ctx.D || S, x, y, o.ux, o.uy, 0.5, 0.85, wallTop + 0.25, wallTop + 0.4, lin(pc), [0, 0, 0, 0], PVS); } }
  }
  // trapeiras: the old town's attic dormers on the street slopes of tiled roofs (about two Pombaline-type buildings in five, one vernacular in four)
  if (mode === 'planar' && (s.shape === 'hipped' || s.shape === 'gabled') && [0, 1, 2].includes(s.variant) && s.floorH && s.h - (s.minH || 0) >= 9 &&
      hash(p.id + 'trap') < (s.variant === 0 ? 0.42 : 0.25)) {
    const o = obb(p.outer), sl = Math.tan((s.pitch * Math.PI) / 180), dR = 2.5 / sl;
    if (o && o.hw * sl >= 3 && o.hw > dR + 0.6) for (const sg of [1, -1]) {
      const nx = -sg * o.vx, ny = -sg * o.vy, mx = o.cx + sg * o.vx * o.hw, my = o.cy + sg * o.vy * o.hw;
      const ins = (s.shape === 'hipped' ? dR : 0) + 1.2, L = 2 * o.hl - 2 * ins; if (L < 1.4) continue;
      const n = Math.min(4, Math.max(1, Math.round(L / (s.bayW * 2)))), a = [mx - o.ux * (o.hl - ins), my - o.uy * (o.hl - ins)];
      const us = Array.from({ length: n }, (_, k) => ((k + 0.5) / n) * L).filter((uu) => {
        const ex = a[0] + o.ux * uu, ey = a[1] + o.uy * uu, d0 = 0.35 / sl + 0.04;
        return Math.abs(res.f(ex + nx * d0, ey + ny * d0) - (wallTop + 0.35)) < 0.25 && Math.abs(res.f(ex + nx * dR, ey + ny * dR) - (wallTop + 2.5)) < 0.3 &&
          [-0.7, 0.7].every((du) => Math.abs(res.f(ex + o.ux * du + nx * dR, ey + o.uy * du + ny * dR) - (wallTop + 2.5)) < 0.3);
      });
      if (us.length) { dormers(ctx.D || S, { a, ex: o.ux, ey: o.uy, nx, ny, us, wallTop, s1: sl, colRoof, seed }); stats.dormers = (stats.dormers || 0) + us.length; }
    }
  }
  if (s.crenel) { // merlons along every edge (castle walls and towers)
    const cs = [KIND.STONE / 8, 5 / 8, seed, 0.9];
    const slit = colWall.map((c) => c * 0.18), D = T.d;
    for (const r of rings) {
      const out = ringArea(r) > 0 ? -1 : 1;   // left normal points inside a counter-clockwise ring
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
        const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L, n = Math.max(1, Math.floor(L / 1.8)), ox = -dy * out, oy = dx * out;
        for (let k = 0; k < n; k++) { const t = (k + 0.5) / n * L; box(S, a[0] + dx * t - dy * 0.3, a[1] + dy * t + dx * 0.3, dx, dy, 0.42, 0.3, wallTop - 0.05, wallTop + 1.15, colWall, [0, 0, 0, 0], cs); }
        // corbelled parapet course under the merlons, and arrow slits down tall towers and curtain walls (near-only detail)
        box(D, (a[0] + b[0]) / 2 + ox * 0.12, (a[1] + b[1]) / 2 + oy * 0.12, dx, dy, L / 2 + 0.1, 0.2, wallTop - 0.75, wallTop - 0.05, colWall, [0, 0, 0, 0], cs);
        for (let k = 0; k < Math.floor(L / 1.2); k++) { const t = (k + 0.5) * L / Math.floor(L / 1.2); box(D, a[0] + dx * t + ox * 0.3, a[1] + dy * t + oy * 0.3, dx, dy, 0.16, 0.12, wallTop - 1.15, wallTop - 0.75, colWall, [0, 0, 0, 0], cs, false); }
        if (s.h - (s.minH || 0) > 7 && L > 3) for (let t = 2.2; t < L - 1.5; t += 4.4) for (const zf of s.h > 14 ? [0.35, 0.65] : [0.55]) {
          const z = ground + (wallTop - ground) * zf;
          box(D, a[0] + dx * t + ox * 0.04, a[1] + dy * t + oy * 0.04, dx, dy, 0.09, 0.05, z - 0.8, z + 0.8, slit, [0, 0, 0, 0], cs);
        }
      }
    }
  }
  for (const b of res.balconies) T.balconies.push(...b);
  stats.balconies += res.balconies.length;
}

{
  // Simple-3D-Buildings rule: if an outline contains building:parts, draw the parts instead.
  // a church is one outline: convents mapped as multi-outer relations tagged place_of_worship (Santo Antão-o-Novo,
  // Mónicas) put a tower on every wing; and a place_of_worship tag on a house is a chapel inside it, not a church
  const multiOuter = new Set(polysB.filter((p) => /^r\d+_[1-9]/.test(p.id)).map((p) => p.id.split('_')[0]));
  const churchy = (p) => !p.tags['building:part'] && !OVERRIDES[p.id] && !multiOuter.has(p.id.split('_')[0]) &&
    (['church', 'chapel', 'basilica'].includes(p.tags.building) || (p.tags.amenity === 'place_of_worship' && [undefined, 'yes', 'religious'].includes(p.tags.building)));
  const WHOLE = new Set(['w42645796', 'r17651166_0', 'w495968848', 'w495968849', 'r5742899_0', 'w96719280']);   // outlines that stay one mass even though parts fill much of them (Colombo, Terminal 1, Colombo's towers); CGD and El Corte Inglés lost their whole mass to one or two small mapped parts
  const parts = polysB.filter((p) => p.tags['building:part']), thinDrop = new Set();
  // an outline handed over to its parts keeps whatever the parts leave uncovered, where the survey sees it standing
  // (Mercado da Ribeira, Altice, InterContinental, Teatro Camões were half-drawn: a tower part mapped, the podium not)
  const fills = [], SCF = 100, CF = (r) => r.map(([x, y]) => ({ X: Math.round(x * SCF), Y: Math.round(y * SCF) }));
  const remainder = (o, inside) => {
    const c = new ClipperLib.Clipper();
    c.AddPaths([CF(o.outer), ...o.holes.map(CF)], ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(inside.flatMap((pt) => [CF(pt.outer), ...pt.holes.map(CF)]), ClipperLib.PolyType.ptClip, true);
    const off = (paths, d) => { const co = new ClipperLib.ClipperOffset(2, 25); co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon); const q = new ClipperLib.Paths(); co.Execute(q, d * SCF); return q; };
    let diff = new ClipperLib.Paths(); c.Execute(ClipperLib.ClipType.ctDifference, diff, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftNonZero);
    diff = off(off(diff, -1.2), 1.2);   // slivers along part edges (mapping slop) are not buildings
    const c2 = new ClipperLib.Clipper(); c2.AddPaths(diff, ClipperLib.PolyType.ptSubject, true);
    const tree = new ClipperLib.PolyTree(); c2.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    const out = [], ov = OVERRIDES[o.id];
    for (const ch of tree.Childs()) {
      const outer = ch.Contour().map((q) => [q.X / SCF, q.Y / SCF]), holes = ch.Childs().map((hh) => hh.Contour().map((q) => [q.X / SCF, q.Y / SCF]));
      if (ringArea(outer) < 0) outer.reverse(); holes.forEach((r) => { if (ringArea(r) > 0) r.reverse(); });
      const area = ringArea(outer) + holes.reduce((a, r) => a + ringArea(r), 0); if (area < 40) continue;
      const q = { id: `${o.id}_rem${out.length}`, tags: o.tags, outer, holes, area, c: [outer.reduce((a, v) => a + v[0], 0) / outer.length, outer.reduce((a, v) => a + v[1], 0) / outer.length] };
      if (ov) q.ovr = ov.h != null && (o.tags.building === 'roof' || ov.minH) ? ov : { ...ov, h: undefined, shape: ov.shape === 'dome' ? undefined : ov.shape };
      const m = measured(q); if (!m || m.mid < 2.2) continue;   // open ground in the survey: a forecourt, a yard, a demolished wing
      if (q.ovr && q.ovr.h === undefined) q.ovr = { ...q.ovr, h: m.mid };
      out.push(q);
    }
    stats.remainders = (stats.remainders || 0) + out.length;
    return out;
  };
  const outlines = polysB.filter((p) => !p.tags['building:part']);
  for (const o of outlines) {
    // …but only when the parts actually fill it: a lone mapped sliver (a lift shaft, a roof stair) must not stand in for a whole tower
    const inside = parts.filter((pt) => pt.area > 4 && Math.abs(pt.c[0] - o.c[0]) < 400 && pointInRing(pt.c[0], pt.c[1], o.outer));
    const special = OVERRIDES[o.id] || DROP.has(o.id) || o.tags.historic || o.tags.amenity === 'place_of_worship' || ['church', 'cathedral', 'chapel', 'basilica', 'castle', 'palace'].includes(o.tags.building);
    // a few mapped parts (a chapel, a tower) do not make a palace: an unauthored landmark stays whole unless its parts fill a fifth
    // of it (Queluz Palace, Palácio Ribeira Grande, Edifício dos Leões, Forte do Conde de Lippe were vanishing)
    // parts held up in the air (a roof canopy, an upper storey bridging) do not stand in for the building under them (Mercado da Ribeira)
    const grounded = inside.filter((pt) => pt.tags['building:part'] !== 'roof' && !(parseMeters(pt.tags.min_height) > 0) && !(parseFloat(pt.tags['building:min_level']) > 0));
    const cover = grounded.reduce((a, pt) => a + Math.abs(pt.area), 0) / Math.abs(o.area);
    o.skip = !WHOLE.has(o.id) && inside.length > 0 && (OVERRIDES[o.id] || DROP.has(o.id) ? true : special ? cover >= 0.2 : cover >= 0.45);
    if (inside.length && !o.skip) {   // the outline stands for the building; parts that do not rise clear of it are redundant (and would z-fight its walls)
      stats.thinParts = (stats.thinParts || 0) + 1;
      const top = (t) => parseMeters(t.height) ?? (isFinite(parseFloat(t['building:levels'])) ? parseFloat(t['building:levels']) * LEVEL_H + 1.2 : null);
      const oTop = OVERRIDES[o.id]?.h ?? top(o.tags) ?? 14;
      for (const pt of inside) if ((OVERRIDES[pt.id]?.h ?? top(pt.tags) ?? 0) <= oTop + 4 && !(OVERRIDES[pt.id]?.shape === "dome")) thinDrop.add(pt);
    }
    if (o.skip && churchy(o) && !['r19372558_0', 'w9253917'].includes(o.id)) { o.skip = false; o.ownParts = true; }   // churches: the outline is modelled whole
    if (o.skip) stats.skippedOutlines++;
    if (o.skip && !o.ownParts && LIDAR && !DROP.has(o.id) && !inside.some((pt) => OVERRIDES[pt.id])) fills.push(...remainder(o, grounded));
  }
  const churchParts = new Set(parts.filter((pt) => outlines.some((o) => o.ownParts && Math.abs(pt.c[0] - o.c[0]) < 120 && pointInRing(pt.c[0], pt.c[1], o.outer))));
  stats.parts = parts.length;
  // hand-authored pilot: the Praça's arcade pillars live in the façade shader; the Arco and D. José are modelled below
  const [pxa, pya] = proj.fwd(38.7062, -9.1400), [pxb, pyb] = proj.fwd(38.7092, -9.1330);
  const inPraca = (p) => p.c[0] > pxa && p.c[0] < pxb && p.c[1] > pya && p.c[1] < pyb;
  // open raked stands: modelled by bleachers() below, not as a box (needs the pitch they face)
  const BLEACH = new Map();
  for (const p of polysB) {
    const t = p.tags;
    if (!(t.leisure === 'bleachers' || t.building === 'grandstand') || OVERRIDES[p.id] || t['roof:shape'] || Math.abs(p.area) < 400) continue;
    let best = null, bd = 140;
    for (const a of polysArea) if (a.tags.leisure === 'pitch' || a.tags.leisure === 'track') { const d = Math.hypot(a.c[0] - p.c[0], a.c[1] - p.c[1]); if (d < bd) { bd = d; best = a; } }
    if (best) BLEACH.set(p.id, best.c);
  }
  const dropped = (p) => DROP.has(p.id) || BLEACH.has(p.id) || (dropTag(p.tags) && inPraca(p)) || (p.tags['bridge:support'] && nearPonte(p.c[0], p.c[1]));   // the bridge's piers and pylons are authored
  // Sé: the mapped parts carry no heights; the cathedral is modelled by hand below
  const seOutline = polysB.find((p) => p.id === 'r19372558_0');
  const seParts = seOutline ? parts.filter((p) => pointInRing(p.c[0], p.c[1], seOutline.outer)) : [];
  const ptOutline = polysB.find((p) => p.id === 'w9253917');
  const ptParts = ptOutline ? parts.filter((p) => pointInRing(p.c[0], p.c[1], ptOutline.outer)) : [];
  const seSet = new Set([seOutline, ...seParts, ptOutline, ...ptParts].filter(Boolean));
  const terr = (p) => (OVERRIDES[p.id]?.terraces ? terraceSlabs(p) : [p]);   // stepped landmarks become their measured terraces
  for (const p of [...outlines.filter((o) => !o.skip), ...parts.filter((pt) => !thinDrop.has(pt)), ...fills].flatMap(terr)) if (p.c[0] >= minX && p.c[0] <= maxX && p.c[1] >= minY && p.c[1] <= maxY && Math.abs(p.area) >= 12 && !dropped(p)) FAR.push(p);
  let todo = [...outlines.filter((o) => !o.skip), ...parts.filter((pt) => !thinDrop.has(pt)), ...fills].flatMap(terr).filter((p) => !seSet.has(p) && !churchParts.has(p)).filter((p) => p.c[0] >= minX && p.c[0] <= maxX && p.c[1] >= minY && p.c[1] <= maxY && Math.abs(p.area) >= 2 && !dropped(p));
  if (process.env.SWEEP) {   // audit: survey mass vs what gets drawn (node pipeline/build.mjs <area> with SWEEP=<out.json>)
    const drawn = [...todo, ...seSet, ...churchParts], G = 2;
    const rr = new Raster(minX, minY, maxX, maxY, G), osmR = new Raster(minX, minY, maxX, maxY, G, 1, Int32Array);
    for (const p of drawn) rr.fillRings([p.outer, ...p.holes], (i) => { rr.data[i] = 1; });
    for (const p of polysB) if (DROP.has(p.id) || BLEACH.has(p.id) || dropped(p)) rr.fillRings([p.outer, ...p.holes], (i) => { rr.data[i] = 1; });   // authored by hand
    polysB.forEach((p, k) => { if (!p.tags['building:part']) osmR.fillRings([p.outer, ...p.holes], (i) => { osmR.data[i] = k + 1; }); });
    // 1) mapped buildings the survey sees standing but nothing draws
    const lost = new Map();
    for (let r = 0; r < rr.h; r++) for (let c = 0; c < rr.w; c++) {
      const i = r * rr.w + c; if (rr.data[i] || !osmR.data[i]) continue;
      const z = LIDAR(rr.minX + (c + 0.5) * G, rr.maxY - (r + 0.5) * G); if (!(z > 3)) continue;
      const k = osmR.data[i] - 1; lost.set(k, (lost.get(k) || 0) + G * G);
    }
    const out = { area: AREA, lost: [], height: [] };
    for (const [k, a] of lost) { const p = polysB[k]; if (a < 60) continue; const [la, lo] = proj.inv(...p.c);
      out.lost.push({ id: p.id, m2: Math.round(a), fp: Math.round(Math.abs(p.area)), ov: !!OVERRIDES[p.id], skip: !!p.skip, name: p.tags.name || '', kind: p.tags.building, ll: [+la.toFixed(5), +lo.toFixed(5)] }); }
    // 2) drawn height vs the survey, for footprints whose height does not come from it
    for (const p of drawn) { if (Math.abs(p.area) < 150) continue; const s = buildingSpec(p); if (s.src === 'lidar') continue; const m = measured(p); if (!m || m.n < 8) continue;
      const top = s.h + (s.shape !== 'flat' ? (s.roofH ?? 2) : 0), d = top - m.top;
      if (Math.abs(d) > 6 && Math.abs(d) > 0.25 * m.top) { const [la, lo] = proj.inv(...p.c); out.height.push({ id: p.id, src: s.src, drawn: +top.toFixed(1), lidarTop: m.top, lidarMid: m.mid, fp: Math.round(Math.abs(p.area)), ov: !!OVERRIDES[p.id], name: p.tags.name || '', ll: [+la.toFixed(5), +lo.toFixed(5)] }); } }
    // 3) standing masses with no footprint at all: flat-topped (not tree crowns), > 150 m²
    { const seen = new Uint8Array(rr.w * rr.h), Z = (c, r) => LIDAR(rr.minX + (c + 0.5) * G, rr.maxY - (r + 0.5) * G);
      out.unmapped = [];
      for (let r0 = 0; r0 < rr.h; r0++) for (let c0 = 0; c0 < rr.w; c0++) {
        const i0 = r0 * rr.w + c0; if (seen[i0] || osmR.data[i0] || rr.data[i0] || !(Z(c0, r0) > 4)) continue;
        const st = [i0], cells = []; seen[i0] = 1;
        while (st.length) { const i = st.pop(); cells.push(i); const c = i % rr.w, r = (i / rr.w) | 0;
          for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const cc = c + a, rq = r + b; if (cc < 0 || rq < 0 || cc >= rr.w || rq >= rr.h) continue; const j = rq * rr.w + cc; if (seen[j] || osmR.data[j] || rr.data[j] || !(Z(cc, rq) > 4)) continue; seen[j] = 1; st.push(j); } }
        if (cells.length * G * G < 150) continue;
        let flat = 0, zs = [];   // roofness: share of cells whose 4 neighbours lie within 0.6 m (tree crowns are rough)
        for (const i of cells) { const c = i % rr.w, r = (i / rr.w) | 0, z = Z(c, r); zs.push(z); let ok = 0; for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (Math.abs(Z(c + a, r + b) - z) < 0.6) ok++; if (ok >= 3) flat++; }
        zs.sort((a, b) => a - b); const fr = flat / cells.length; if (fr < 0.45) continue;
        let sx = 0, sy = 0; for (const i of cells) { sx += rr.minX + (i % rr.w + 0.5) * G; sy += rr.maxY - (((i / rr.w) | 0) + 0.5) * G; }
        const [la, lo] = proj.inv(sx / cells.length, sy / cells.length);
        out.unmapped.push({ m2: cells.length * G * G, flat: +fr.toFixed(2), zMid: zs[zs.length >> 1], ll: [+la.toFixed(5), +lo.toFixed(5)] });
      }
      out.unmapped.sort((a, b) => b.m2 - a.m2); }
    out.lost.sort((a, b) => b.m2 - a.m2); out.height.sort((a, b) => Math.abs(b.drawn - b.lidarTop) - Math.abs(a.drawn - a.lidarTop));
    fs.writeFileSync(process.env.SWEEP, JSON.stringify(out, null, 1)); log(`sweep: ${out.lost.length} lost, ${out.height.length} height, ${out.unmapped.length} unmapped`); process.exit(0);
  }
  if (process.env.DBG_ID) { const q = polysB.find((p) => p.id === process.env.DBG_ID); console.log('TRACE', !!q, q && q.skip, q && dropped(q), q && todo.includes(q), q && q.c); }
  // Pombaline blocks of the pilot zone: built block by block
  const zones = BAIXA_ZONES.map((z) => z.map(([la, lo]) => proj.fwd(la, lo)));
  const inZone = (x, y) => zones.some((z) => pointInRing(x, y, z));
  const baixa = todo.filter((p) => !p.tags['building:part'] && inZone(p.c[0], p.c[1]) && !OVERRIDES[p.id] && !notBlock(p.tags) && Math.abs(p.area) >= 40);
  const baixaSet = new Set(baixa);
  todo = todo.filter((p) => !baixaSet.has(p) && !(p.tags['building:part'] && inZone(p.c[0], p.c[1])));
  markPartyWalls(todo.filter((p) => !p.tags['building:part']));
  // parish churches: whitewashed naves with towers and pedimented fronts, built from the footprint's OBB
  const inBuilding = (x, y, self) => polysB.some((q) => q !== self && !q.tags['building:part'] && Math.abs(q.c[0] - x) < 80 && Math.abs(q.c[1] - y) < 80 && pointInRing(x, y, q.outer));
  for (const p of todo) {
    const ob = churchy(p) && obb(p.outer), info = CHURCHES[p.id] || {};
    if (!ob || info.skip || p.holes.length || (Math.abs(p.area) / (4 * ob.hl * ob.hw) < 0.7 && !info.force) || ob.hw < 2.8 || ob.hl < 4.5 || ob.hl / ob.hw > 4.5) { addBuilding(p); continue; }
    let { ux, uy } = ob;
    const blocked = (s) => [-0.7, -0.35, 0, 0.35, 0.7].filter((f) => inBuilding(ob.cx + ux * s * (ob.hl + 3) - uy * f * ob.hw, ob.cy + uy * s * (ob.hl + 3) + ux * f * ob.hw, p)).length;
    const bm = blocked(-1), bp = blocked(1);
    if (info.front ? info.front > 0 : bp < bm || (bp === bm && ux * 0.8 + uy * 0.6 < 0)) { ux = -ux; uy = -uy; }   // façade at u = -hl; ties face west/south
    let gmin = Infinity; for (const [x, y] of p.outer) gmin = Math.min(gmin, groundAt(x, y));
    const chapel = p.tags.building === 'chapel' || Math.abs(p.area) < 160, th = parseMeters(p.tags.height);
    const H = info.H ?? (th ? Math.min(20, Math.max(6, th * 0.8)) : chapel ? Math.min(10, Math.max(6, ob.hw * 1.3 + 3)) : Math.min(17, Math.max(8, ob.hw * 1.45 + 3)));
    const towers = info.towers ?? (chapel ? 0 : ob.hw >= 7.5 && ob.hl >= 14 ? 2 : ob.hw >= 4.2 ? 1 : 0);
    const u = (k) => hash(p.id + k);
    (p.id === 'w96359439' ? estrelaBasilica : parishChurch)(tileB0(ob.cx, ob.cy), { cx: ob.cx, cy: ob.cy, ux, uy, hl: ob.hl, hw: ob.hw, ground: groundAt(ob.cx, ob.cy), gmin, H, towers, towerSide: u('ts') < 0.5 ? -1 : 1,
      cap: info.cap || (u('cap') < 0.6 ? 'cupola' : 'spire'), wall: info.wall || (u('w') < 0.75 ? '#f1ede4' : '#efe4cc'), roofHex: info.roof, lin, srgb, seed: u('s') });
    stats.buildings++; stats.authored++; stats.churches = (stats.churches || 0) + 1; if (process.env.DBG) log('church', p.id, towers, proj.inv(ob.cx, ob.cy).map((v) => v.toFixed(5)).join(','), p.tags.name || '', p.tags.building, Math.round(Math.abs(p.area)));
  }
  pombalineBlocks(baixa, {
    SkeletonBuilder, groundAt, lin, srgb, jitter, pick, pal, hash, stats,
    getSink: (x, y) => { const [ti, tj] = tileOf(x, y); return getTile(ti, tj).b; },
    getDetail: (x, y) => { const [ti, tj] = tileOf(x, y); return getTile(ti, tj).d; },
    balconies: (x, y) => { const [ti, tj] = tileOf(x, y); return getTile(ti, tj).balconies; },
  });
  stats.buildings += baixa.length; stats.authored += baixa.length;
  // landmarks
  const byId = new Map(polysB.map((p) => [p.id, p]));
  const [sx, sy] = proj.fwd(38.70851, -9.13684), [nx_, ny_] = proj.fwd(38.70959, -9.13726);   // Rua Augusta axis, pointing to the river
  const L = Math.hypot(sx - nx_, sy - ny_), vx = (sx - nx_) / L, vy = (sy - ny_) / L;
  const arco = byId.get('w41683195');
  if (arco) {
    const g = groundAt(arco.c[0], arco.c[1]), [ti, tj] = tileOf(arco.c[0], arco.c[1]);
    arcoRuaAugusta(getTile(ti, tj).b, { cx: arco.c[0], cy: arco.c[1], ux: vy, uy: -vx, ground: g, lin, srgb }); stats.landmarks = (stats.landmarks || 0) + 1;
  }
  const tileB = (x, y) => { const [ti, tj] = tileOf(x, y); return getTile(ti, tj).b; };
  const mark = () => { stats.landmarks = (stats.landmarks || 0) + 1; };
  const col = byId.get('w663311597');
  if (col) { pedroIVColumn(tileB(...col.c), { cx: col.c[0], cy: col.c[1], ground: groundAt(...col.c), lin, srgb }); mark(); }
  for (const id of ['w663311514', 'w663311518']) {
    const f = polysArea.find((p) => p.id === id); if (!f) continue;
    const r = Math.sqrt(Math.abs(f.area) / Math.PI);
    rossioFountain(tileB(...f.c), { cx: f.c[0], cy: f.c[1], r, ground: groundAt(...f.c), lin, srgb }); mark();
  }
  const joaoEl = els.find((e) => e.type === 'way' && e.id === 663318735 && e.geometry);
  const joao = joaoEl && { c: proj.fwd(joaoEl.geometry.reduce((a, q) => a + q.lat, 0) / joaoEl.geometry.length, joaoEl.geometry.reduce((a, q) => a + q.lon, 0) / joaoEl.geometry.length) };
  if (joao) { equestrianJose(tileB(...joao.c), { cx: joao.c[0], cy: joao.c[1], ground: groundAt(...joao.c), heading: Math.atan2(vx, vy), lin, srgb, plain: true }); mark(); }
  const theatre = byId.get('w77473968');
  if (theatre) {   // portico on the façade facing Rossio (outward normal closest to south, longest)
    let best = null, bs = -1;
    theatre.outer.forEach((a, i) => { const b = theatre.outer[(i + 1) % theatre.outer.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); const oy = -(b[0] - a[0]) / L; const sc = -oy * L; if (sc > bs) { bs = sc; best = [a, b]; } });
    portico(tileB(...theatre.c), { a: best[0], b: best[1], ground: groundAt(...theatre.c), lin, srgb }); mark();
  }
  if (seOutline && seParts.length) {
    const ob = obb(seParts.flatMap((p) => p.outer));
    let { ux, uy } = ob; if (ux < 0) { ux = -ux; uy = -uy; }
    let gmin = Infinity; for (const [x, y] of seOutline.outer) gmin = Math.min(gmin, groundAt(x, y));
    seCathedral(tileB(ob.cx, ob.cy), { cx: ob.cx, cy: ob.cy, ux, uy, hl: ob.hl, ground: groundAt(ob.cx, ob.cy), gmin, lin, srgb }); mark();
  }
  if (ptOutline) {
    const ob = obb(ptOutline.outer);
    let gmin = Infinity; for (const [x, y] of ptOutline.outer) gmin = Math.min(gmin, groundAt(x, y));
    panteao(tileB(ob.cx, ob.cy), { cx: ob.cx, cy: ob.cy, ux: ob.ux, uy: ob.uy, ground: groundAt(ob.cx, ob.cy), gmin, lin, srgb }); mark();
  }
  // Convento do Carmo: frame read off the mapped church (west front → apse, 26.2° north of east).
  // The nave floor sits at Largo do Carmo level; the chevet stands on its substructure above Rua do Carmo.
  let carmoFloor = null;
  if (byId.get('w96301719')) {
    const [cx, cy] = proj.fwd(38.7121428, -9.1402322), a = 26.2 * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a);
    const P = (u, v) => [cx + ux * u - uy * v, cy + uy * u + ux * v];
    let gmin = Infinity, gmax = -Infinity;
    for (const [x, y] of byId.get('w96301719').outer) gmin = Math.min(gmin, groundAt(x, y));
    for (let u = -37; u <= 8; u += 3) for (let v = -11; v <= 11; v += 2.75) gmax = Math.max(gmax, groundAt(...P(u, v)));
    carmoFloor = gmax + 0.15;
    carmoRuins(tileB(cx, cy), { cx, cy, ux, uy, ground: carmoFloor, gmin, zf: 0, lin, srgb }); mark();
  }
  // Elevador de Santa Justa: tower on the mapped footprint; walkway (way 446066424 and the terrace beyond) to Carmo
  const lift = byId.get('w115238861');
  if (lift) {
    const ob = obb(lift.outer), bridge = proj.fwd(38.7119825, -9.1398817), g = groundAt(ob.cx, ob.cy);
    const zDeck = (carmoFloor ?? g + 28) - g;
    log(`Santa Justa: ground ${g.toFixed(1)}, deck +${zDeck.toFixed(1)}`);
    santaJustaLift(tileB(ob.cx, ob.cy), { cx: ob.cx, cy: ob.cy, ux: ob.ux, uy: ob.uy, hu: 5, hv: 3.6, ground: g, zWalk: zDeck, bridge, lin, srgb }); mark();
  }
  {  // Cais das Colunas, on the line of the mapped steps (way 243096331, river end first)
    const a = proj.fwd(38.70638, -9.13601), b = proj.fwd(38.70665, -9.13612), d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = [a[0] + (b[0] - a[0]) * 3.5 / d, a[1] + (b[1] - a[1]) * 3.5 / d];
    log(`Cais das Colunas: ground ${groundAt(...b).toFixed(1)} … ${groundAt(...a).toFixed(1)}`);
    caisColunas(tileB(...r), { a: r, b, ground: Math.max(1.6, groundAt(...b)), lin, srgb }); mark();
  }
  const rest = byId.get('w663347630');
  if (rest) { const ob = obb(rest.outer); restauradoresObelisk(tileB(...rest.c), { cx: rest.c[0], cy: rest.c[1], ux: ob.ux, uy: ob.uy, ground: groundAt(...rest.c), lin, srgb }); mark(); }
  // façade pieces on the edge that faces the street: Rossio station (most east-facing long edge), Câmara (west)
  const facing = (p, nx, ny, minL) => { let best = null, bs = -Infinity; const sg = ringArea(p.outer) > 0 ? 1 : -1;
    p.outer.forEach((a, i) => { const b = p.outer[(i + 1) % p.outer.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < minL) return;
      const ox = sg * (b[1] - a[1]) / L, oy = -sg * (b[0] - a[0]) / L, sc = ox * nx + oy * ny; if (sc > bs) { bs = sc; best = sg > 0 ? [a, b] : [a, b]; } }); return best; };
  const rossioSt = byId.get('w96530649');
  if (rossioSt) { const [a, b] = facing(rossioSt, 0.85, 0.5, 30); const sg = ringArea(rossioSt.outer) > 0; rossioStationFront(tileB(...rossioSt.c), { a: sg ? a : b, b: sg ? b : a, ground: groundAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), H: 21, lin, srgb }); mark(); }
  {   // Palácio de São Bento: portico + grand stair on the frontispiece (its OSM part is dropped)
    const a = proj.fwd(38.712327, -9.153664), b = proj.fwd(38.712567, -9.153511), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ox = (b[1] - a[1]) / L, oy = -(b[0] - a[0]) / L;
    const zTop = groundAt(m[0] - ox * 4, m[1] - oy * 4) + 1.5, zSq = groundAt(m[0] + ox * 24, m[1] + oy * 24);
    log(`São Bento: floor ${zTop.toFixed(1)}, Largo ${zSq.toFixed(1)}`);
    saoBentoFront(tileB(...m), { a, b, zTop, zSq: Math.min(zSq, zTop - 0.5), lin, srgb }); mark();
  }
  if (byId.get('w96390844')) {   // Coliseu dos Recreios: the big shallow metal dome over the auditorium drum
    // sized to the drum's own outline (the theatre outline also holds the front block): the rim sits on the drum wall
    const c = byId.get('w1561006352') || byId.get('w96390844'), x = c.c[0], y = c.c[1], r = Math.sqrt(Math.abs(c.area) / Math.PI) + 0.4;
    const g = c.outer.reduce((a, q) => a + groundAt(q[0], q[1]), 0) / c.outer.length;
    metalDome(tileB(x, y), { cx: x, cy: y, r, z0: g + 17, rise: r * 0.34, lin, srgb }); mark();
  }
  {   // Praça Marquês de Pombal: the column (its OSM outline is dropped)
    const mp = els.find((e) => e.type === 'way' && e.id === 822816252);
    if (mp) { const g = mp.geometry, [x, y] = proj.fwd(g.reduce((a, q) => a + q.lat, 0) / g.length, g.reduce((a, q) => a + q.lon, 0) / g.length); marquesColumn(tileB(x, y), { cx: x, cy: y, ground: groundAt(x, y), lin, srgb, heading: 2.53 }); mark(); }
  }
  { const cr = byId.get('w87891338');   // Cristo Rei: pedestal and statue on the OSM footprint, facing Lisbon
    if (cr && cr.c[0] >= minX && cr.c[0] < maxX && cr.c[1] >= minY && cr.c[1] < maxY) { const ob = obb(cr.outer); cristoRei(tileB(...cr.c), { cx: cr.c[0], cy: cr.c[1], ux: ob.ux, uy: ob.uy, hl: ob.hl, hw: ob.hw, ground: cr.outer.reduce((a, q) => Math.min(a, groundAt(q[0], q[1])), Infinity), lin, srgb }); mark(); } }
  const inArea = (c) => c[0] >= minX && c[0] < maxX && c[1] >= minY && c[1] < maxY;
  { const ch = els.find((e) => e.type === 'relation' && e.id === 11318402), r = ch && byId.get('r11318402_0');   // Jerónimos church
    if (r && inArea(r.c)) { jeronimosChurch(tileB(...r.c), { ring: r.outer, fwd: proj.fwd, ground: r.outer.reduce((a, q) => Math.min(a, groundAt(q[0], q[1])), Infinity), lin, srgb }); mark(); } }
  { const r = byId.get('w821784760'), body = byId.get('w821784762');   // Altice Arena: smooth zinc hull on the drum
    if (r && body && inArea(r.c)) { arenaShell(tileB(...r.c), { ring: r.outer, ground: body.outer.reduce((a, q) => Math.min(a, groundAt(q[0], q[1])), Infinity), z0: 20, z1: 38, lin, srgb }); mark(); } }
  { const r = byId.get('r11318401_0');   // Jerónimos monastery range: Manueline cornice, buttresses and pinnacles over the generic walls
    if (r && inArea(r.c)) { jeronimosWing(tileB(...r.c), { ring: r.outer, ground: r.outer.reduce((a, q) => Math.min(a, groundAt(q[0], q[1])), Infinity), H: OVERRIDES['r11318401_0'].h, lin, srgb }); } }
  { const cpq = byId.get('r8872281_0');   // Campo Pequeno: the arena's covered roof on the ring
    if (cpq && cpq.holes.length && inArea(cpq.c)) { const hl = cpq.holes[0], hc = [hl.reduce((a, q) => a + q[0], 0) / hl.length, hl.reduce((a, q) => a + q[1], 0) / hl.length];
      const r = hl.reduce((a, q) => a + Math.hypot(q[0] - hc[0], q[1] - hc[1]), 0) / hl.length, g = cpq.outer.reduce((a, q) => Math.min(a, groundAt(q[0], q[1])), Infinity);
      bullringRoof(tileB(...hc), { cx: hc[0], cy: hc[1], r, z0: g + OVERRIDES['r8872281_0'].h + 0.6, lin, srgb }); mark(); } }
  for (const id of ['w683006891', 'w1268291335', 'w1268291336', 'w1268291337']) {   // Campo Pequeno's four gate towers
    const t = byId.get(id); if (!t || !inArea(t.c)) continue; const ob = obb(t.outer);
    campoPequenoTower(tileB(...t.c), { cx: ob.cx, cy: ob.cy, ux: ob.ux, uy: ob.uy, hw: Math.min(ob.hl, ob.hw), ground: t.outer.reduce((a, q) => Math.min(a, groundAt(q[0], q[1])), Infinity), lin, srgb }); mark();
  }
  { const tv = byId.get('w1387099961');   // Torre Vasco da Gama: core, lattice sail and pod
    if (tv && inArea(tv.c)) {
      const arcs = [['w1387099965', 23.5], ['w1387100762', 40.5], ['w1387100761', 58.5], ['w1387099966', 75.5], ['w1387099964', 91.5], ['w1387099963', 108.5], ['w1387099962', 125.5]].map(([id, z]) => ({ z, ring: byId.get(id)?.outer })).filter((a) => a.ring);
      torreVascoGama(tileB(...tv.c), { core: tv.outer, pod: byId.get('w709779004')?.outer, arcs, ground: Math.max(LAND_MIN, groundAt(...tv.c)), lin, srgb }); mark(); } }
  for (const id of ['w96502765', 'w96502767', 'w96502775']) {   // Amoreiras: pylons, cornice and glass pyramids on the three towers
    const t = byId.get(id); if (!t || !inArea(t.c)) continue;
    amoreirasCrown(tileB(...t.c), { ring: t.outer, ground: t.outer.reduce((a, q) => a + groundAt(q[0], q[1]), 0) / t.outer.length, zTop: 58, lin, srgb }); mark();
  }
  { const m = byId.get('r11381632_0');   // MAAT: the white tiled wave on the river
    if (m && inArea(m.c)) { maat(tileB(...m.c), { ring: m.outer, holes: m.holes, ground: Math.max(LAND_MIN, m.outer.reduce((a, q) => a + groundAt(q[0], q[1]), 0) / m.outer.length), lin, srgb }); mark(); } }
  { const ob = byId.get('w230062385');   // Oceanário: glazed habitat roofs and the central tank
    if (ob && inArea(ob.c)) { const corners = ['w1069604938', 'w1069604939', 'w1069604940', 'w1069604941'].map((id) => byId.get(id)?.outer).filter(Boolean);
      oceanario(tileB(...ob.c), { corners, core: byId.get('w1016189633')?.outer, ground: ob.outer.reduce((a, q) => a + groundAt(q[0], q[1]), 0) / ob.outer.length, lin, srgb }); mark(); } }
  { const st = byId.get('r9159876_0');   // Estádio José Alvalade: bowl, tiled façade, roof ring on yellow trusses
    if (st && st.holes.length && inArea(st.c)) { alvaladeStadium(tileB(...st.c), { ring: st.outer, hole: st.holes[0], ground: groundAt(...st.c), lin, srgb }); mark(); } }
  for (const [id, centre] of BLEACH) { const p = byId.get(id); if (!p || !inArea(p.c)) continue;
    const H = parseMeters(p.tags.height) ?? Math.min(20, Math.max(5, Math.sqrt(Math.abs(p.area)) / 9));
    const seat = p.id === 'w265399341' ? '#cdc8bd' : undefined;   // Estádio Nacional (Jamor): bare limestone terraces, no plastic seats (Earth)
    if (bleachers(tileB(...p.c), { ring: p.outer, centre, ground: p.outer.reduce((a, q) => Math.min(a, groundAt(q[0], q[1])), Infinity), H, seat, lin, srgb })) mark(); }
  { const pl = byId.get('w39735031');   // Pavilhão de Portugal: Siza's concrete pala between its porticoes
    if (pl && inArea(pl.c)) { palaSiza(tileB(...pl.c), { ring: pl.outer, ground: groundAt(...pl.c), lin, srgb }); mark(); } }
  for (const id of ['w240817325', 'w1015870543']) { const tw = byId.get(id);   // São Rafael / São Gabriel crowns
    if (tw && inArea(tw.c)) { const o = obb(tw.outer); sailCrown(tileB(...tw.c), { ring: tw.outer, z0: groundAt(...tw.c) + OVERRIDES[id].h, rise: 18, toward: o.ux > 0 ? 1 : -1, col: '#b9cdd6', lin, srgb }); mark(); } }
  { const tm = byId.get('w193025303');   // Torre de Monsanto: the slanted glass top, rising 20 m to the north
    if (tm && inArea(tm.c)) { slopedCrown(tileB(...tm.c), { ring: tm.outer, z0: groundAt(...tm.c) + OVERRIDES['w193025303'].h, rise: 20, up: [0, 1], col: '#4b6577', lin, srgb }); mark(); } }
  for (const [id, o] of Object.entries(OVERRIDES)) if (o.dome || o.spire) { const d = byId.get(id);   // authored domes and minaret spires on their mapped parts
    if (!d || !inArea(d.c)) continue; const r = Math.sqrt(Math.abs(d.area) / Math.PI), g = groundAt(...d.c);
    if (o.dome) plainDome(tileB(...d.c), { cx: d.c[0], cy: d.c[1], r: r * 0.97, z0: g + o.h, rise: o.dome.rise, col: o.dome.col, lin, srgb });
    else minaretTop(tileB(...d.c), { cx: d.c[0], cy: d.c[1], r: Math.min(r, 2.6) * 0.9, z0: g + o.h, rise: o.spire.rise, col: o.spire.col, lin, srgb });
    mark(); }
  { const pc = byId.get('w1464595790');   // Centro Colombo (checked top-down on Earth): a long glazed vault arcs round the north of Praça Central's dome
    if (pc && inArea(pc.c)) {                // at ~54 m and runs on in straight malls to the south-west and east; small glass pyramids light the plaza roof
      const cx = -4236, cy = 4518, z0 = groundAt(cx, cy) + (OVERRIDES.w42645796?.h ?? 18) + 0.2, R = 54, path = [];
      const A0 = (20 * Math.PI) / 180, A1 = (160 * Math.PI) / 180, e1 = [cx + Math.cos(A1) * R, cy + Math.sin(A1) * R], e0 = [cx + Math.cos(A0) * R, cy + Math.sin(A0) * R];
      for (let k = 11; k >= 1; k--) path.push([e1[0] - 0.61 * 5 * k, e1[1] - 0.79 * 5 * k]);
      for (let k = 0; k <= 28; k++) { const a = A1 - ((A1 - A0) * k) / 28; path.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]); }
      for (let k = 1; k <= 9; k++) path.push([e0[0] + 0.9 * 5 * k, e0[1] - 0.43 * 5 * k]);
      vaultAlong(tileB(cx, cy), { path, hw: 6.5, rise: 4.8, z0, lin, srgb });
      const gl = lin(srgb('#8fa9ad')), PLg = [KIND.PLAIN / 8, 5 / 8, 0.25, 1];
      for (const deg of [10, 50, 90, 130, 170, 210, 330]) { const a = (deg * Math.PI) / 180, x = cx + Math.cos(a) * 37, y = cy + Math.sin(a) * 37;
        limb(tileB(cx, cy), [x, z0, -y], [x, z0 + 2.6, -y], 2.6, 0.06, 4, gl, PLg, true); }
      mark(); } }
  { const gt = byId.get('w151780623');   // Torre da Galp: refinery flare tower
    if (gt && inArea(gt.c)) { flareTower(tileB(...gt.c), { c: gt.c, ground: groundAt(...gt.c), H: parseMeters(gt.tags.height) || 90, lin, srgb }); mark(); } }
  { const vg = byId.get('w240816973');   // Centro Vasco da Gama: the long glass vault (with water running over it) down its spine
    if (vg && inArea(vg.c)) { const o = obb(vg.outer), gl = lin(srgb('#6f9db0')); barrelRoof(tileB(...vg.c), { ob: { ...o, hl: o.hl * 0.82, hw: o.hw * 0.26 }, z0: groundAt(...vg.c) + OVERRIDES['w240816973'].h + 0.6, rise: 4, col: gl, under: gl }); mark(); } }
  { const cn = byId.get('w759763392');   // Gare do Oriente canopy over the platforms
    if (cn && inArea(cn.c)) { oriente(tileB(...cn.c), { canopy: cn.outer, ground: groundAt(...cn.c), deck: 11.6, lin, srgb }); mark(); } }
  { const rf = byId.get('r16349886_0');   // Estádio da Luz: seats and the four arches
    if (rf && rf.holes.length && inArea(rf.c)) { estadioLuz(tileB(...rf.c), { roof: rf.outer, hole: rf.holes[0], outer: byId.get('r9143921_0')?.outer, ground: groundAt(...rf.c), lin, srgb }); mark(); } }
  { const tb = byId.get('w24341353');   // Torre de Belém on its mapped outline
    if (tb && inArea(tb.c)) { torreBelem(tileB(...tb.c), { fwd: proj.fwd, ring: tb.outer, ground: Math.max(LAND_MIN, tb.outer.reduce((a, q) => Math.min(a, groundAt(q[0], q[1])), Infinity)), lin, srgb }); mark(); } }
  { const hull = byId.get('w152327819'), sl = byId.get('w259346570');   // Padrão dos Descobrimentos
    if (hull && sl && inArea(hull.c)) { padraoDescobrimentos(tileB(...hull.c), { slab: sl.outer, hull: hull.outer, ground: Math.max(LAND_MIN, groundAt(...hull.c)), lin, srgb }); mark(); } }
  { const [x, y] = proj.fwd(38.7162199, -9.1483953); trellisCedar(tileB(x, y), { cx: x, cy: y, ground: groundAt(x, y), lin, srgb }); mark(); }
  const camara = byId.get('w95417254');
  if (camara) { const [a, b] = facing(camara, -1, 0, 15); const sg = ringArea(camara.outer) > 0; portico(tileB(...camara.c), { a: sg ? a : b, b: sg ? b : a, ground: groundAt(...camara.c), depth: 3.2, colH: 12.5, cols: 4, span: 13, statue: false, lin, srgb }); mark(); }
  {
    const pel = els.find((e) => e.type === 'node' && e.id === 1120633222);
    if (pel) { const [x, y] = proj.fwd(pel.lat, pel.lon); pelourinho(tileB(x, y), { cx: x, cy: y, ground: groundAt(x, y), lin, srgb }); mark(); }
  }
  const sjd = byId.get('r16201238_0');   // São João de Deus: the twin belfries on the front to Praça de Londres (ENE)
  if (sjd && inArea(sjd.c)) {
    const dx = 0.866, dy = 0.5; let f = sjd.outer[0]; for (const q of sjd.outer) if (q[0] * dx + q[1] * dy > f[0] * dx + f[1] * dy) f = q;
    const k = (f[0] - sjd.c[0]) * dx + (f[1] - sjd.c[1]) * dy - 3.5, x = sjd.c[0] + dx * k, y = sjd.c[1] + dy * k;
    twinSpires(tileB(x, y), { cx: x, cy: y, ux: dx, uy: dy, ground: groundAt(x, y), half: 1.75, gap: 6, h: 29, spire: 6.5, lin, srgb }); mark();
  }
  const mercado = byId.get('w39729235');
  if (mercado) {
    const [a, b] = facing(mercado, 0.2, -1, 20), L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const sg = ringArea(mercado.outer) > 0 ? 1 : -1, x = (a[0] + b[0]) / 2 - sg * uy * 3.4, y = (a[1] + b[1]) / 2 + sg * ux * 3.4;   // inset from the front
    domedTower(tileB(x, y), { cx: x, cy: y, ux, uy, ground: groundAt(x, y), h: 21, half: 3.2, lin, srgb }); mark();
  }
  const jose = byId.get('w663318739');
  if (jose) {
    const g = groundAt(jose.c[0], jose.c[1]), [ti, tj] = tileOf(jose.c[0], jose.c[1]);
    equestrianJose(getTile(ti, tj).b, { cx: jose.c[0], cy: jose.c[1], ground: g, heading: Math.atan2(vx, vy), lin, srgb }); stats.landmarks++;
  }
}

// ─── trams and funiculars ───────────────────────────────────────────────
{
  const at = (pts, cum, s) => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; };
  let n = 0, firstTram = [0, 0];
  for (const r of rails) {
    const fun = r.tags.railway === 'funicular'; if (r.tags.railway !== 'tram' && !fun) continue;
    const cum = [0]; for (let i = 1; i < r.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]));
    const len = cum[cum.length - 1], L = fun ? 11 : 8.6;
    if (len < L + 4) continue;
    const spots = fun ? [len * 0.5] : []; if (!fun) for (let s = 40 + hash(r.id + "tr") * 500; s < len - L - 5; s += 560 + hash(r.id + s) * 300) spots.push(s);
    for (const s of spots) {
      const [x0, y0] = at(r.pts, cum, s - L / 2), [x1, y1] = at(r.pts, cum, s + L / 2);
      if (x0 < minX || x0 > maxX || y0 < minY || y0 > maxY) continue;
      tramCar(tileB0(x0, y0), { x0, y0, z0: groundAt(x0, y0) + 0.05, x1, y1, z1: groundAt(x1, y1) + 0.05, lin, srgb, funicular: fun, seed: hash(r.id + s) }); n++;
      if (!fun && n > 5 && !firstTram[0]) firstTram = proj.inv(x0, y0);
    }
  }
  stats.trams = n;
  log(`trams ${n}, e.g. at ${firstTram.map((v) => v.toFixed(5))}`);
}

// ─── trains: parked at the buffer stops of the termini (Santa Apolónia, Cais do Sodré, Rossio) ──
// Walk back from each buffer stop along the chained track ways and lay a set of carriages on it.
{
  const heavy = rails.filter((r) => r.tags.railway === 'rail');
  const K = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`, ends = new Map();
  for (const r of heavy) for (const p of [r.pts[0], r.pts.at(-1)]) { const k = K(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(r); }
  const stops = extractNodes(els, proj, (t) => t.railway === 'buffer_stop');
  const LIV = {
    ap: ['#e4e6e8', '#242a31', '#b3303a', '#a3a8ad'],      // tilting long-distance set: pale grey, dark glazing, red accent
    ic: ['#b9bec3', '#2a2f35', '#d06a2a', '#8f959b'],      // stainless intercity coaches
    sub: ['#eeeeea', '#27313b', '#2f5f9a', '#a9adb1'],     // white suburban unit, blue stripe
    cas: ['#c4c8cb', '#2b3036', '#e08a2e', '#9aa0a5'],     // Cascais line stainless units
  };
  const at = (pts, cum, s) => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; };
  let nT = 0, nC = 0; const claimed = new Set(), usedStops = [];
  for (const st of stops) {
    let way = heavy.find((r) => [r.pts[0], r.pts.at(-1)].some((p) => Math.hypot(p[0] - st.p[0], p[1] - st.p[1]) < 3));
    if (!way || claimed.has(way.id) || usedStops.some((q) => Math.hypot(q[0] - st.p[0], q[1] - st.p[1]) < 4.2)) continue;   // buffer stops come in pairs: one train per track
    claimed.add(way.id); usedStops.push(st.p);
    const H = hash(st.id); if (H > 0.7) continue;                       // some platforms stand empty
    // chain ways from the buffer stop outward until ~170 m of track
    let pts = Math.hypot(way.pts[0][0] - st.p[0], way.pts[0][1] - st.p[1]) < 3 ? way.pts.slice() : way.pts.slice().reverse();
    const used = new Set([way.id]);
    for (let g = 0; g < 6; g++) {
      let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (len > 170) break;
      const e = pts.at(-1), d0 = [e[0] - pts.at(-2)[0], e[1] - pts.at(-2)[1]], dl = Math.hypot(...d0) || 1;
      let best = null, bd = 0.9;
      for (const r of ends.get(K(e)) || []) {
        if (used.has(r.id)) continue;
        const q = K(r.pts[0]) === K(e) ? r.pts : r.pts.slice().reverse(), d1 = [q[1][0] - q[0][0], q[1][1] - q[0][1]], c = (d0[0] * d1[0] + d0[1] * d1[1]) / (dl * (Math.hypot(...d1) || 1));
        if (c > bd) { bd = c; best = [r, q]; }
      }
      if (!best) break;
      used.add(best[0].id); pts = pts.concat(best[1].slice(1));
    }
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const len = cum.at(-1), [la, lo] = proj.inv(...st.p);
    const cais = lo < -9.143 && la < 38.708, rossio = lo < -9.14 && la > 38.713;
    const kind = cais ? 'cas' : rossio ? 'sub' : ['ap', 'ic', 'sub', 'ic'][Math.floor(hash(st.id + 'k') * 4)];
    const CL = kind === 'ic' ? 26.4 : 24.5, want = kind === 'ap' ? 6 : kind === 'ic' ? 3 + Math.floor(H * 6) : 4 * (1 + (H < 0.35));
    const n = Math.min(want, Math.floor((len - 4) / (CL + 0.8)));
    if (n < 2) continue;
    // trains stand level: one height for the whole set, from the lower quartile of the ground along it (the DEM bulges near buildings)
    const zs = []; for (let s = 0; s <= Math.min(len, n * (CL + 0.8) + 3); s += 5) zs.push(groundAt(...at(pts, cum, s)));
    zs.sort((a, b) => a - b); const zT = zs[Math.floor(zs.length * 0.25)] + 0.2;
    for (let k = 0; k < n; k++) {
      const s0 = 3 + k * (CL + 0.8), [x0, y0] = at(pts, cum, s0), [x1, y1] = at(pts, cum, s0 + CL);
      const cab = kind === 'ic' ? 0 : k === 0 ? -1 : k === n - 1 ? 1 : 0;   // coaches are loco-hauled: no cab ends
      trainCar(tileB0(x0, y0), { x0, y0, z0: zT, x1, y1, z1: zT, lin, srgb, livery: LIV[kind], cab, pantograph: kind !== 'ic' && k % 4 === 1, seed: hash(st.id + k) }); nC++;
    }
    if (kind === 'ic') {                                                    // the electric loco at the head end, away from the buffers
      const s0 = 3 + n * (CL + 0.8), [x0, y0] = at(pts, cum, s0), [x1, y1] = at(pts, cum, Math.min(len, s0 + 19));
      if (s0 + 19 <= len) { trainCar(tileB0(x0, y0), { x0, y0, z0: zT, x1, y1, z1: zT, lin, srgb, livery: ['#b8c0c6', '#2a2f35', '#d06a2a', '#7e858b'], cab: 1, pantograph: true, seed: 0.5 }); nC++; }
    }
    nT++; if (process.env.DBG) log('train', kind, n, la.toFixed(5), lo.toFixed(5), 'z', zT.toFixed(1));
  }
  // overhead-line masts along the electrified main lines (yards get them from their own ways)
  let nM = 0;
  for (const r of heavy) {
    if (!r.tags.electrified || r.tags.electrified === 'no' || underground(r.tags) || r.tags.covered === 'yes' || r.tags.service === 'crossover') continue;
    const cum = [0]; for (let i = 1; i < r.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]));
    const side = hash(r.id + 'm') < 0.5 ? -1 : 1;
    for (let s = 20 + hash(r.id) * 30; s < cum.at(-1) - 5; s += 58) {
      const [x, y] = at(r.pts, cum, s), [x2, y2] = at(r.pts, cum, Math.min(cum.at(-1), s + 2)), l = Math.hypot(x2 - x, y2 - y) || 1, nx = -(y2 - y) / l * side, ny = (x2 - x) / l * side;
      const mx = x - nx * 2.7, my = y - ny * 2.7;
      if (mx < minX + 5 || mx > maxX - 5 || my < minY + 5 || my > maxY - 5 || isWaterAt(mx, my)) continue;
      catenaryMast(tileB0(mx, my), { x: mx, y: my, z: groundAt(mx, my), nx, ny, lin, srgb }); nM++;
    }
  }
  // tram overhead: in wide streets slim poles with a bracket arm over the track; in the narrow lanes the wire hangs
  // from rosettes on the façades, so where the pole spot falls inside a building there is no pole
  const hitB = (x, y) => polysB.some((q) => !q.tags['building:part'] && Math.abs(q.c[0] - x) < 60 && Math.abs(q.c[1] - y) < 60 && pointInRing(x, y, q.outer));
  const tsegs = []; for (const r of rails) if (r.tags.railway === 'tram') for (let i = 1; i < r.pts.length; i++) tsegs.push([r.pts[i - 1], r.pts[i]]);
  const nearTram = (x, y) => { let d = 1e9; for (const [a, b] of tsegs) { if (Math.min(a[0], b[0]) - 5 > x || Math.max(a[0], b[0]) + 5 < x || Math.min(a[1], b[1]) - 5 > y || Math.max(a[1], b[1]) + 5 < y) continue;
    const vx = b[0] - a[0], vy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy || 1))); d = Math.min(d, Math.hypot(x - a[0] - vx * t, y - a[1] - vy * t)); } return d; };
  let nP = 0;
  for (const r of rails) {
    if (r.tags.railway !== 'tram' || r.tags.service) continue;
    const cum = [0]; for (let i = 1; i < r.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]));
    const side = hash(r.id + 'p') < 0.5 ? -1 : 1;
    for (let s = 10 + hash(r.id) * 20; s < cum.at(-1) - 5; s += 34) {
      const [x, y] = at(r.pts, cum, s), [x2, y2] = at(r.pts, cum, Math.min(cum.at(-1), s + 2)), l = Math.hypot(x2 - x, y2 - y) || 1, nx = -(y2 - y) / l * side, ny = (x2 - x) / l * side;
      let ok = false, mx = 0, my = 0, sx = nx, sy = ny;
      for (const f of [1, -1]) {           // the far side of a double track is the other track: try both sides
        sx = nx * f; sy = ny * f; mx = x - sx * 3.4; my = y - sy * 3.4;
        if (nearTram(mx, my) < 2.4 || nearTram(x - sx * 1.8, y - sy * 1.8) < 1.2) continue;
        ok = true; break;
      }
      if (!ok || mx < minX + 5 || mx > maxX - 5 || my < minY + 5 || my > maxY - 5 || isWaterAt(mx, my) || hitB(mx, my) || hitB(x - sx * 1.6, y - sy * 1.6)) continue;
      catenaryMast(tileB0(mx, my), { x: mx, y: my, z: groundAt(mx, my), nx: sx, ny: sy, lin, srgb, H: 6.6, arm: 3.4 }); nP++;
    }
  }
  stats.tramPoles = nP;
  stats.trains = nT; stats.masts = nM; log(`trains ${nT} (${nC} cars), catenary masts ${nM}, tram poles ${nP}`);
}

// ─── cacilheiros: one moored at each terminal pier, one under way on each crossing ──
{
  let n = 0;
  const hullWet = (x, y, dx, dy) => [-15, -8, 0, 8, 15].every((u) => [-4, 0, 4].every((v) => isWaterAt(x + dx * u - dy * v, y + dy * u + dx * v)));
  const put = (x, y, dx, dy, k, moored = false) => { if (x < minX + 20 || x > maxX - 20 || y < minY + 20 || y > maxY - 20 || !(moored ? hullWet(x, y, dx, dy) : isDeepWater(x, y))) return; cacilheiro(tileB0(x, y), { x, y, dx, dy, lin, srgb, seed: k }); n++; };
  for (const [a, b] of [[[38.7048156, -9.1458602], [38.7043741, -9.1458431]], [[38.7065673, -9.1335673], [38.7062885, -9.1334308]]]) {   // pier root → head
    const [ax, ay] = proj.fwd(...a), [bx, by] = proj.fwd(...b), L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
    // gangway along the mapped pier, a floating pontoon at its head, and the ferry berthed bow-on against it
    const S = tileB0(bx, by), grey = lin(srgb('#9a9792')), dark = lin(srgb('#4b4d50')), PLs = [KIND.PLAIN / 8, 5 / 8, 0.3, 1], I0 = [0, 0, 0, 0];
    box(S, (ax + bx) / 2, (ay + by) / 2, ux, uy, L / 2, 1.6, 0.6, 1.5, grey, I0, PLs);
    box(S, bx + ux * 5, by + uy * 5, ux, uy, 5, 9, -0.6, 1.2, dark, I0, PLs);
    box(S, bx + ux * 5, by + uy * 5, ux, uy, 4.6, 8.6, 1.2, 1.35, grey, I0, PLs);
    put(bx + ux * 26.5, by + uy * 26.5, ux, uy, 0.2, true);
  }
  const moored = n;
  const routes = extractLines(els, proj, (t) => t.route === 'ferry');
  for (const r of routes) {
    const [x0, y0] = r.pts[0], far = r.pts[r.pts.length - 1], L = Math.hypot(far[0] - x0, far[1] - y0), ux = (far[0] - x0) / L, uy = (far[1] - y0) / L;
    const s = 95 + hash(r.id) * 90; put(x0 + ux * s, y0 + uy * s, ux, uy, hash(r.id + 'f'));
  }
  // a few yachts out on the river, spread along the reach, sailing roughly up or down stream
  let sb = 0;
  for (let k = 0; k < 40 && sb < 7; k++) {
    const rnd = (j) => { const v = Math.sin((k + 1) * 12.9898 + j * 78.233) * 43758.5453; return v - Math.floor(v); };
    const x = minX + (0.08 + 0.84 * rnd(1)) * (maxX - minX), y = minY + 25 + rnd(2) * 420;
    if (!isDeepWater(x, y) || !isDeepWater(x, y - 25)) continue;
    const a = (rnd(3) < 0.5 ? 0.35 : Math.PI + 0.35) + (rnd(4) - 0.5) * 0.9;
    sailboat(tileB0(x, y), { x, y, dx: Math.cos(a), dy: Math.sin(a), lin, srgb, seed: rnd(5), len: 8 + rnd(6) * 5 }); sb++;
    if (sb === 1) log('first sailboat at', proj.inv(x, y).map((v) => v.toFixed(5)).join(','));
  }
  // marinas (Doca de Belém, Bom Sucesso, Santo Amaro, Alcântara, Parque das Nações): the mapped pontoons as low floating
  // decks, yachts berthed stern-to along both sides, masts bare and sails furled (checked against Earth)
  { const deckC = lin(srgb('#c9c5bb')), I0 = [0, 0, 0, 0], PLs = [KIND.PLAIN / 8, 5 / 8, 0.5, 1];
    const marinas = polysArea.filter((m) => m.tags.leisure === 'marina');
    const inMarina = (x, y) => marinas.some((m) => pointInRing(x, y, m.outer));
    let moorN = 0;
    for (const w of extractLines(els, proj, (t) => t.man_made === 'pier' || t.man_made === 'pontoon')) {
      const mid = w.pts[Math.floor(w.pts.length / 2)]; if (!inMarina(mid[0], mid[1])) continue;
      const hw = Math.min(2, (parseMeters(w.tags.width) ?? 2.4) / 2);
      for (let i = 0; i + 1 < w.pts.length; i++) {
        const a = w.pts[i], b = w.pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
        const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        if (mx < minX || mx > maxX || my < minY || my > maxY || !isWaterAt(mx, my)) continue;
        box(tileB0(mx, my), mx, my, ux, uy, L / 2 + hw, hw, -0.3, 0.55, deckC, I0, PLs);
        for (let s2 = 3; s2 < L - 2; s2 += 4.4) for (const sg of [1, -1]) {
          const k = hash(`${w.id}${i}${s2}${sg}`); if (k > 0.8) continue;
          const len = 8 + k * 7, off = hw + 1.2 + len / 2, x = a[0] + ux * s2 - uy * sg * off, y = a[1] + uy * s2 + ux * sg * off;
          if (![0, 0.45, -0.45].every((f) => isWaterAt(x - uy * sg * len * f, y + ux * sg * len * f)) || !inMarina(x, y)) continue;
          sailboat(tileB0(x, y), { x, y, dx: -uy * sg, dy: ux * sg, lin, srgb, seed: hash(`${w.id}${s2}b`), len, furled: true }); moorN++;
        }
      }
    }
    stats.moored = moorN;
    // every other mapped pier over open water (Trafaria's grain jetty, the Doca de Pedrouços and Barreiro moles, fishing jetties):
    // a concrete deck 2.4 m above the water on paired piles; floating ones sit low. The two cacilheiro piers are authored above.
    const conc = lin(srgb('#bdb8ae')), pile = lin(srgb('#8e8a83')), authoredPiers = [[38.7048156, -9.1458602], [38.7065673, -9.1335673]].map(([la, lo]) => proj.fwd(la, lo));
    let pierM = 0;
    for (const w of extractLines(els, proj, (t) => t.man_made === 'pier' && t.area !== 'yes')) {
      const mid = w.pts[Math.floor(w.pts.length / 2)]; if (inMarina(mid[0], mid[1]) || authoredPiers.some(([x, y]) => Math.hypot(x - mid[0], y - mid[1]) < 120)) continue;
      const fl = w.tags.floating === 'yes', hw = Math.min(8, Math.max(1.2, (parseMeters(w.tags.width) ?? (fl ? 3 : 5)) / 2)), top = fl ? 0.6 : 2.4;
      for (let i = 0; i + 1 < w.pts.length; i++) {
        const a = w.pts[i], b = w.pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
        const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        if (mx < minX || mx > maxX || my < minY || my > maxY || !isWaterAt(mx, my)) continue;
        box(tileB0(mx, my), mx, my, ux, uy, L / 2 + 0.3, hw, top - (fl ? 0.9 : 0.8), top, conc, I0, PLs); pierM += L;
        if (!fl) for (let s2 = 4; s2 < L; s2 += 9) for (const sg of [1, -1]) { const x = a[0] + ux * s2 - uy * sg * (hw - 0.8), y = a[1] + uy * s2 + ux * sg * (hw - 0.8);
          box(tileB0(x, y), x, y, ux, uy, 0.35, 0.35, -2, top - 0.8, pile, I0, PLs); }
      }
    }
    stats.pierM = Math.round(pierM);
  }
  stats.ferries = n; stats.sailboats = sb; log(`ferries ${n} (${moored} moored), sailboats ${sb}`);
}

// ─── miradouros: balustrades where the terrace drops away; Santa Luzia's pergola ──
{
  const ids = ['w169007610', 'w565894105', 'r19112367_0', 'w526129020', 'r9060636_0', 'w573667052', 'w1450837674',
    'w40705509', 'r8065262_0', 'w39221574'];   // + São Pedro de Alcântara, Santa Catarina (Adamastor), Torel
  const views = extractPolygons(els, proj, (t) => t.tourism === 'viewpoint' || t.leisure || t.highway || t.place);
  let n = 0;
  for (const id of ids) {
    const v = views.find((p) => p.id === id); if (!v) continue;
    miradouro(tileB0(...v.c), { ring: v.outer, groundAt, lin, srgb, pergola: id === 'w169007610', seed: hash(id) }); n++;
  }
  stats.miradouros = n; log(`miradouros ${n}`);
}

// ─── structures that cross area seams: built whole, each area keeps the triangles over its own ground ───
const FARX = new Map();   // tile → triangles of authored structures (bridges, aqueduct) that the far level must keep too
function distribute(T) {
  let kept = 0;
  for (let t = 0; t < T.pos.length / 9; t++) {
    const o = t * 9, cx = (T.pos[o] + T.pos[o + 3] + T.pos[o + 6]) / 3, cy = -(T.pos[o + 2] + T.pos[o + 5] + T.pos[o + 8]) / 3;
    if (cx < minX || cx >= maxX || cy < minY || cy >= maxY) continue;
    const D = tileB0(cx, cy); kept++;
    { const [ti, tj] = tileOf(cx, cy), k = `${ti}_${tj}`, F = FARX.get(k) || FARX.set(k, { P: [], C: [] }).get(k);
      for (let q = 0; q < 9; q++) { F.P.push(T.pos[o + q]); F.C.push(T.col[o + q]); } }
    for (let k = 0; k < 9; k++) { D.pos.push(T.pos[o + k]); D.nrm.push(T.nrm[o + k]); D.col.push(T.col[o + k]); }
    for (let k = 0; k < 12; k++) { D.info.push(T.info[t * 12 + k]); D.style.push(T.style[t * 12 + k]); }
    for (let k = 0; k < 6; k++) D.surf.push(T.surf[t * 6 + k]);
  }
  return kept;
}
{
  const T = makeSink();
  ponte25Abril(T, { fwd: proj.fwd, ground: (x, y) => Math.max(LAND_MIN, dem.ground(x, y)), lin, srgb });
  stats.ponte = distribute(T);
}
if (AQUEDUTO_LINE.some(([la, lo]) => { const [x, y] = proj.fwd(la, lo); return x >= minX - 50 && x < maxX + 50 && y >= minY - 50 && y < maxY + 50; })) {
  const T = makeSink();
  aqueduto(T, { fwd: proj.fwd, groundAt: (x, y) => Math.max(LAND_MIN, dem.ground(x, y)), lin, srgb, log });
  stats.aqueduto = distribute(T);
}
if (VG_LINE.some(([la, lo]) => { const [x, y] = proj.fwd(la, lo); return x >= minX - 50 && x < maxX + 50 && y >= minY - 50 && y < maxY + 50; })) {
  const T = makeSink();
  ponteVascoGama(T, { fwd: proj.fwd, ground: (x, y) => dem.ground(x, y), lin, srgb });
  stats.ponteVG = distribute(T);
}
// ─── statues, columns & historic walls ──────────────────────────────────
const authoredSpots = [...polysB.filter((p) => DROP.has(p.id)).map((p) => p.c), proj.fwd(38.71360, -9.13798)];
{
  const bronze = lin(srgb('#55614f')), stoneC = lin(LIOZ), wallC = lin(srgb('#c4baa7')), whiteC = lin(srgb('#ece6da'));
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
    if (authoredSpots.some(([ax, ay]) => Math.hypot(x - ax, y - ay) < 22)) continue; // modelled by hand
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
  // the Moorish and Fernandine walls survive mostly inside later houses: where the mapped line runs through or between
  // buildings it stays hidden, and only the free stretches stand (Alfama, checked against Earth)
  const wb = new Raster(minX, minY, maxX, maxY, 1);
  for (const p of polysB) if (!p.tags['building:part'] && !/city_?wall/.test(p.tags.barrier || p.tags.historic || '')) wb.fillRings([p.outer], (i) => { wb.data[i] = 1; });
  const inB = (x, y) => { const c = Math.floor(wb.px(x)), r = Math.floor(wb.py(y)); return c >= 0 && r >= 0 && c < wb.w && r < wb.h && wb.data[r * wb.w + c] === 1; };
  for (const w of wallLines) {
    const city = w.tags.barrier === 'city_wall' || /citywall|city_wall/.test(w.tags.historic || '');
    const H = parseMeters(w.tags.height) ?? (city ? 9 : 1.6), th = city ? 2.4 : 0.35, col = city ? wallC : whiteC;
    const pts = []; for (let i = 0; i + 1 < w.pts.length; i++) { const a = w.pts[i], b = w.pts[i + 1], n = city ? Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3)) : 1;
      for (let k = 0; k < n; k++) pts.push([[a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], [a[0] + (b[0] - a[0]) * (k + 1) / n, a[1] + (b[1] - a[1]) * (k + 1) / n]]); }
    for (let i = 0; i < pts.length; i++) {
      const [a, b] = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.2) continue;
      if (city) { const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, nx = -(b[1] - a[1]) / L * 3, ny = (b[0] - a[0]) / L * 3;
        if (inB(mx, my) || (inB(mx + nx, my + ny) && inB(mx - nx, my - ny))) { stats.wallHidden = (stats.wallHidden || 0) + L; continue; } }
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
  // round fountain basins (amenity=fountain drawn as a circle): a dark stone kerb ring round the water and a stepped
  // centre drum, as at Belém's Fonte Luminosa (checked against Earth); the water itself is painted on the ground map
  for (const p of polysArea) {
    if (p.tags.amenity !== 'fountain' || p.area < 60 || p.area > 2500 || p.holes.length || p.id === 'w663311514' || p.id === 'w663311518') continue;   // Rossio's two are authored
    const ob = obb(p.outer), fill = ob && p.area / (4 * ob.hl * ob.hw); if (!ob || ob.hw / ob.hl < 0.85 || fill < 0.72 || fill > 0.87) continue;   // round, not a square chafariz
    const [cx, cy] = p.c; if (cx < minX || cx > maxX || cy < minY || cy > maxY) continue;
    const r = Math.sqrt(p.area / Math.PI), z0 = groundAt(cx, cy), S = getTile(...tileOf(cx, cy)).b, st = ST(hash(p.id));
    const kerb = lin(srgb('#8f8a82')), drum = lin(srgb('#b9b2a5')), water = lin(srgb('#5f97a6')), N = 36, P = (k, rr) => [cx + Math.cos((k / N) * 2 * Math.PI) * rr, cy + Math.sin((k / N) * 2 * Math.PI) * rr];
    const kw = Math.min(1.4, Math.max(0.5, r * 0.08));
    const cyl = (rr, za, zb, col) => { for (let k = 0; k < N; k++) { const a = P(k, rr), b = P(k + 1, rr); wallQuad(S, a, b, za, za, zb, zb, col, 0, 1, za, SI, st); }
      for (let k = 0; k < N; k++) { const a = P(k, rr), b = P(k + 1, rr); triUp(S, [cx, zb, -cy], [a[0], zb, -a[1]], [b[0], zb, -b[1]], col, [0, 0], [0, 0], [0, 0], SI, st); } };
    for (let k = 0; k < N; k++) {   // kerb ring: outer wall, inner wall, flat top
      const a = P(k, r), b = P(k + 1, r), c = P(k, r - kw), d = P(k + 1, r - kw);
      wallQuad(S, a, b, z0 - 0.4, z0 - 0.4, z0 + 0.7, z0 + 0.7, kerb, 0, 1, z0, SI, st);
      wallQuad(S, d, c, z0, z0, z0 + 0.7, z0 + 0.7, kerb, 0, 1, z0, SI, st);
      triUp(S, [a[0], z0 + 0.7, -a[1]], [b[0], z0 + 0.7, -b[1]], [d[0], z0 + 0.7, -d[1]], kerb, [0, 0], [0, 0], [0, 0], SI, st);
      triUp(S, [a[0], z0 + 0.7, -a[1]], [d[0], z0 + 0.7, -d[1]], [c[0], z0 + 0.7, -c[1]], kerb, [0, 0], [0, 0], [0, 0], SI, st);
      triUp(S, [cx, z0 + 0.35, -cy], [c[0], z0 + 0.35, -c[1]], [d[0], z0 + 0.35, -d[1]], water, [0, 0], [0, 0], [0, 0], SI, st);
    }
    if (r > 6) { cyl(r * 0.22, z0, z0 + 0.9, drum); cyl(r * 0.12, z0 + 0.9, z0 + 1.9, drum); }   // tiered centre
    stats.fountains = (stats.fountains || 0) + 1;
  }
  // clipped hedges (barrier=hedge): box and laurel along garden edges, the parterres of Parque Eduardo VII and Belém
  const hedges = extractLines(els, proj, (t) => t.barrier === 'hedge' && t.area !== 'yes');
  for (const w of hedges) {
    const H = Math.min(3, parseMeters(w.tags.height) ?? 1.2), th = 0.9, hc = hash(w.id + 'hc'), col = lin(srgb(hc < 0.4 ? '#4b6a3a' : hc < 0.75 ? '#557343' : '#425f35'));
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const a = w.pts[i], b = w.pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.3) continue;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (mx < minX || mx > maxX || my < minY || my > maxY) continue;
      const S = getTile(...tileOf(mx, my)).b, st = PL(hash(w.id + i)), dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L, nx = -dy * th / 2, ny = dx * th / 2;
      const ga = groundAt(a[0], a[1]), gb = groundAt(b[0], b[1]);
      const q = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], zb = [ga, gb, gb, ga], zt = zb.map((z) => z + H);
      wallQuad(S, q[3], q[2], zb[3] - 0.3, zb[2] - 0.3, zt[3], zt[2], col, 0, L, zb[3], SI, st);
      wallQuad(S, q[1], q[0], zb[1] - 0.3, zb[0] - 0.3, zt[1], zt[0], col, 0, L, zb[1], SI, st);
      triUp(S, [q[0][0], zt[0], -q[0][1]], [q[1][0], zt[1], -q[1][1]], [q[2][0], zt[2], -q[2][1]], col.map((v) => v * 1.1), [0, 0], [0, 0], [0, 0], SI, st);
      triUp(S, [q[0][0], zt[0], -q[0][1]], [q[2][0], zt[2], -q[2][1]], [q[3][0], zt[3], -q[3][1]], col.map((v) => v * 1.1), [0, 0], [0, 0], [0, 0], SI, st);
      stats.hedgeM = (stats.hedgeM || 0) + L;
    }
  }
}
log(`buildings built`, JSON.stringify(stats), 'estimated from', JSON.stringify(heightSrc));
if (BAD.length) { log('BAD geometry', BAD.length, BAD.slice(0, 5).join('\n')); process.exitCode = 1; }

// ─── ground map (supersampled) ──────────────────────────────────────────
const gm = new Raster(minX, minY, maxX, maxY, SS, 3);
const VR = new Raster(minX - 40, minY - 40, maxX + 40, maxY + 40, 4), villaF = new Uint8Array(VR.w * VR.h);
{ // only where houses dominate: a small 'yes' among apartment blocks (Amadora, Odivelas) is an annexe, not a villa in its garden
  const BIG = new Map(), key = (x, y) => `${Math.floor(x / 60)},${Math.floor(y / 60)}`;
  for (const p of polysB) if (!isVilla(p) && Math.abs(p.area) >= 150) { const k = key(...p.c); BIG.set(k, (BIG.get(k) || 0) + Math.abs(p.area)); }
  const bigNear = (x, y) => { let a = 0; for (const dx of [-60, 0, 60]) for (const dy of [-60, 0, 60]) a += BIG.get(key(x + dx, y + dy)) || 0; return a; };
  for (const p of polysB) if (isVilla(p) && bigNear(...p.c) < 4000) VR.disc(p.c[0], p.c[1], 16 + Math.sqrt(Math.abs(p.area)) * 0.5, (i) => { villaF[i] = 1; });
}
const villaAt = (x, y) => { const c = Math.floor(VR.px(x)), r = Math.floor(VR.py(y)); return c >= 0 && r >= 0 && c < VR.w && r < VR.h && villaF[r * VR.w + c] === 1; };
const C = {
  ground: srgb('#d0c8b9'), calcada: srgb('#d6d0c4'), asphalt: srgb('#85827e'), road_edge: srgb('#c9c2b5'),
  park: srgb('#98b774'), grass: srgb('#a7c184'), wood: srgb('#7fa465'), pitch: srgb('#87b871'), turf: srgb('#5f9452'), tartan: srgb('#b5644e'), court: srgb('#5b87a0'), hardcourt: srgb('#a9aaa4'), clay: srgb('#c27a52'), sand: srgb('#e3cf9f'),
  parking: srgb('#b7b2aa'), rail: srgb('#4f4b47'), ballast: srgb('#9a9186'), setts: srgb('#76736e'), tramRail: srgb('#c4c1ba'), yard: srgb('#b3aa9d'), platform: srgb('#d9d3c8'), water: srgb('#4c8296'), cemetery: srgb('#cdc6b6'), rough: srgb('#a3b07c'), pond: srgb('#5d93a3'), pier: srgb('#b8aa94'), plaza: srgb('#e4ddce'),
};
const paint = (col) => (i) => { gm.data[i * 3] = col[0]; gm.data[i * 3 + 1] = col[1]; gm.data[i * 3 + 2] = col[2]; };
let openAtG = null;   // set by the ground pass below: how far a point is from anything built (0 near buildings … 1 open land)
// land OSM leaves undescribed is mostly back yards, courtyards and patios behind the façades: muted garden green,
// earth and cement drifting into each other over ~20 m, with plot-sized (≈6 m) shifts in value — not one pale fill, not camouflage
{
  const GREEN = srgb('#99a07c'), EARTH = srgb('#a99c84'), CEMENT = srgb('#aba79e');
  const hh = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  const vn = (x, y) => { const i = Math.floor(x), j = Math.floor(y); let fx = x - i, fy = y - j; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    return (hh(i, j) * (1 - fx) + hh(i + 1, j) * fx) * (1 - fy) + (hh(i, j + 1) * (1 - fx) + hh(i + 1, j + 1) * fx) * fy; };
  // open land: undescribed ground well away from any building or built-up landuse is not a back yard but rough grass and
  // scrub (Monsanto's edges, motorway verges, the empty lots of the outskirts). A 4 m chamfer distance field finds it.
  const DG = 4, dr = new Raster(minX - 80, minY - 80, maxX + 80, maxY + 80, DG), dist = new Float32Array(dr.w * dr.h).fill(1e4);
  for (const p of polysB) dr.fillRings([p.outer, ...p.holes], (i) => { dist[i] = 0; });
  for (const p of polysArea) if (/^(industrial|commercial|retail|construction|garages|railway|military)$/.test(p.tags.landuse) || p.tags.amenity === 'parking') dr.fillRings([p.outer, ...p.holes], (i) => { dist[i] = 0; });
  for (let pass = 0; pass < 2; pass++) for (let k = 0; k < dist.length; k++) {   // forward then backward sweep
    const i = pass ? dist.length - 1 - k : k, r = Math.floor(i / dr.w), c = i % dr.w, s = pass ? 1 : -1;
    let d = dist[i];
    for (const [dc, drow, w] of [[s, 0, DG], [0, s, DG], [s, s, DG * 1.414], [-s, s, DG * 1.414]]) {
      const cc = c + dc, rr = r + drow; if (cc >= 0 && rr >= 0 && cc < dr.w && rr < dr.h) d = Math.min(d, dist[rr * dr.w + cc] + w);
    }
    dist[i] = d;
  }
  const openAt = (x, y) => { const fx = (x - dr.minX) / DG - 0.5, fy = (dr.maxY - y) / DG - 0.5, c = Math.max(0, Math.min(dr.w - 2, Math.floor(fx))), r = Math.max(0, Math.min(dr.h - 2, Math.floor(fy))), u = fx - c, v = fy - r, i = r * dr.w + c;
    const d = (dist[i] * (1 - u) + dist[i + 1] * u) * (1 - v) + (dist[i + dr.w] * (1 - u) + dist[i + dr.w + 1] * u) * v;
    const t = Math.min(1, Math.max(0, (d - 16) / 26)); return t * t * (3 - 2 * t); };
  openAtG = openAt;
  const DRY = srgb('#b4ad84'), MEAD = srgb('#9ea472'), SCRUB = srgb('#8a9463'), LAWN = srgb('#8fa86c');
  for (let r = 0; r < gm.h; r++) {
    const y = maxY - (r + 0.5) * SS;
    for (let c = 0; c < gm.w; c++) {
      const x = minX + (c + 0.5) * SS, xw = x + 2.2 * Math.sin(y / 5.3), yw = y + 2.2 * Math.sin(x / 4.7);
      const va = villaAt(x, y), g = Math.max(va ? 0.55 + 0.4 * vn(x / 9 + 5, y / 9) : 0, Math.min(1, Math.max(0, (vn(x / 21, y / 21) - 0.35) * 2.2))), e = vn(x / 13 + 17, y / 13 + 5);   // villa gardens: lawn and hedges
      const k = (0.95 + 0.08 * hh(Math.floor(xw / 6), Math.floor(yw / 6))) * (0.97 + 0.06 * hh(Math.floor(x / 1.3), Math.floor(y / 1.3)));
      const i = (r * gm.w + c) * 3;
      const o = openAt(x, y), m = vn(x / 31 + 3, y / 31 + 9), sc = Math.min(1, Math.max(0, (vn(xw / 7 + 41, yw / 7) - 0.66) * 3));
      for (let q = 0; q < 3; q++) {
        const yard = (EARTH[q] * e + CEMENT[q] * (1 - e)) * (1 - g) + (va ? LAWN[q] : GREEN[q]) * g, wild = (DRY[q] * m + MEAD[q] * (1 - m)) * (1 - sc) + SCRUB[q] * sc;
        gm.data[i + q] = Math.min(255, (yard * (1 - o) + wild * o) * k);
      }
    }
  }
}
const TRACK_GREY = new Set(['w1266496440']);   // Restelo's mapped track is a grey paved ring, not tartan
const areaColor = (t, id) => {
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'recreation_ground' || t.landuse === 'village_green') return C.park;
  if (t.landuse === 'grass' || t.landuse === 'meadow' || t.natural === 'grassland' || t.landuse === 'flowerbed') return C.grass;
  if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub' || t.natural === 'heath') return C.wood;
  if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return C.cemetery;
  if (t.golf === 'green' || t.golf === 'tee') return C.pitch;
  if (t.golf === 'fairway') return C.grass;
  if (t.leisure === 'golf_course' || t.golf === 'rough') return C.rough;
  if (TRACK_GREY.has(id)) return srgb('#b6bbbf');
  if (t.leisure === 'track' && !/asphalt|dirt|grass|gravel|ground/.test(t.surface || '') && !TRACK_GREY.has(id)) return C.tartan;   // athletics tracks: red tartan
  if (t.leisure === 'pitch') {   // by surface: artificial turf reads darker than grass, hard courts grey-blue, beach courts sand, clay brick
    const sf = t.surface || '';
    if (sf === 'artificial_turf') return C.turf;
    if (/tartan/.test(sf)) return C.tartan;
    if (/acrylic/.test(sf)) return C.court;
    if (/concrete|asphalt|paved|paving|sett/.test(sf)) return C.hardcourt;
    if (/sand/.test(sf)) return C.sand;
    if (/clay/.test(sf)) return C.clay;
  }
  if (t.leisure === 'pitch' || t.leisure === 'playground') return C.pitch;
  if (t.natural === 'sand' || t.natural === 'beach') return C.sand;
  if (t.amenity === 'parking' && !t.parking?.includes('underground') && t.parking !== 'multi-storey') return C.parking;
  if (t.place === 'square' || t.highway === 'pedestrian' || t['area:highway'] === 'pedestrian' || t['area:highway'] === 'footway') return C.plaza;
  if (t['area:highway']) return C.asphalt;
  if (t.man_made === 'pier' || t.man_made === 'quay' || t.man_made === 'breakwater') return C.pier;
  if (t.landuse === 'railway' && !underground(t) && !t.man_made) return C.yard;
  if (t.railway === 'platform' && !underground(t)) return C.platform;
  return null;
};
// big areas first so small ones draw on top
const GRAVE = [srgb('#e2ded5'), srgb('#cfcac0'), srgb('#bdb8ae'), srgb('#d8d2c4')], GRAVEL = srgb('#aaa290');
for (const p of [...polysArea].sort((a, b) => b.area - a.area)) {
  const col = areaColor(p.tags, p.id);
  if (col === C.cemetery) {   // the blocks between the tomb streets: ground graves, rows of stone slabs on gravel
    const ob = obb(p.outer);
    gm.fillRings([p.outer, ...p.holes], (i) => {
      const x = minX + ((i % gm.w) + 0.5) * SS, y = maxY - (Math.floor(i / gm.w) + 0.5) * SS, u = x * ob.ux + y * ob.uy, v = -x * ob.uy + y * ob.ux;
      const cu = Math.floor(u / 1.7), cv = Math.floor(v / 3.1), fu = u / 1.7 - cu, fv = v / 3.1 - cv, h = hash(`${cu},${cv}`);
      paint(fu > 0.18 && fv > 0.12 && h < 0.85 ? GRAVE[Math.floor(h * 17) % 4] : GRAVEL)(i);
    });
  } else if (col === C.tartan && !p.holes.length && obb(p.outer).hw > 25) {   // a whole athletics oval mapped as one area: lanes round a grass infield
    const ob = obb(p.outer), sl = ob.hl - ob.hw, rin = ob.hw - 9.8;
    gm.fillRings([p.outer], (i) => {
      const x = minX + ((i % gm.w) + 0.5) * SS - ob.cx, y = maxY - (Math.floor(i / gm.w) + 0.5) * SS - ob.cy, u = x * ob.ux + y * ob.uy, v = -x * ob.uy + y * ob.ux;
      paint(Math.hypot(Math.max(0, Math.abs(u) - sl), v) < rin ? C.grass : C.tartan)(i);
    });
  } else if (col) gm.fillRings([p.outer, ...p.holes], paint(col));
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
// sports pitches: football lines; tennis, padel and basketball as coloured hard courts with their lines
{
  const LINE = srgb('#f1efe8'), TURF = srgb('#6e9f58'), HARD = srgb('#5b87a0'), BASKET = srgb('#c27352'), RED = srgb('#b9765a');
  const ring = (ob, du, dv) => { const P = (a, b) => [ob.cx + ob.ux * a - ob.uy * b, ob.cy + ob.uy * a + ob.ux * b]; return [P(-du, -dv), P(du, -dv), P(du, dv), P(-du, dv), P(-du, -dv)]; };
  let nP = 0;
  for (const p of polysArea) {
    const t = p.tags; if (t.leisure !== 'pitch' || p.holes.length || p.area < 120) continue;
    const ob = obb(p.outer), sp = t.sport || '', L = ob.hl, W = ob.hw; if (L < 6 || W < 3) continue;
    const P = (a, b) => [ob.cx + ob.ux * a - ob.uy * b, ob.cy + ob.uy * a + ob.ux * b], lw = 0.45;
    if (/tennis|padel/.test(sp)) {
      gm.fillRings([p.outer], paint(/clay/.test(t.surface || '') ? RED : HARD));
      gm.strokeLine(ring(ob, L - 1.2, W - 0.8), lw, paint(LINE)); gm.strokeLine([P(0, -(W - 0.8)), P(0, W - 0.8)], lw, paint(LINE));
      gm.strokeLine([P(-(L - 1.2) * 0.55, 0), P((L - 1.2) * 0.55, 0)], lw * 0.8, paint(LINE));
    } else if (/basketball/.test(sp)) {
      gm.fillRings([p.outer], paint(BASKET)); gm.strokeLine(ring(ob, L - 0.8, W - 0.8), lw, paint(LINE)); gm.strokeLine([P(0, -(W - 0.8)), P(0, W - 0.8)], lw, paint(LINE));
    } else if (/soccer|football|futsal|multi|^$/.test(sp) && L > 12) {
      if (/artificial|turf|synthetic/.test(t.surface || '') || L < 40) gm.fillRings([p.outer], paint(TURF));
      const l = L - 1, w = W - 1, r = Math.min(9.15, w * 0.28), bd = Math.min(16.5, l * 0.17), bw = Math.min(20.2, w * 0.6);
      gm.strokeLine(ring(ob, l, w), lw, paint(LINE)); gm.strokeLine([P(0, -w), P(0, w)], lw, paint(LINE));
      gm.strokeLine(Array.from({ length: 33 }, (_, k) => P(Math.cos((k / 32) * Math.PI * 2) * r, Math.sin((k / 32) * Math.PI * 2) * r)), lw, paint(LINE));
      for (const e of [-1, 1]) gm.strokeLine([P(e * l, -bw), P(e * (l - bd), -bw), P(e * (l - bd), bw), P(e * l, bw)], lw, paint(LINE));
    } else continue;
    nP++;
  }
  log(`pitches marked: ${nP}`);
  // swimming pools: crisp on the 0.3 m ground map (the 1 m water mask drew them as blobs) — pale coping, then the water
  { const COP = srgb('#e9e6de'), POOL = srgb('#5fb0cf'), POOL2 = srgb('#4b9dc2'); let nPool = 0;
    for (const p of polysArea) { if (p.tags.leisure !== 'swimming_pool' || p.area > 3000) continue;
      gm.fillRings([p.outer], paint(COP)); gm.strokeLine([...p.outer, p.outer[0]], 0.7, paint(COP));
      const c = p.c, inner = p.outer.map((q) => { const dx = q[0] - c[0], dy = q[1] - c[1], l = Math.hypot(dx, dy) || 1, k = Math.max(0, l - 0.45) / l; return [c[0] + dx * k, c[1] + dy * k]; });
      gm.fillRings([inner], paint(hash(p.id) < 0.5 ? POOL : POOL2)); nPool++; }
    log(`pools painted: ${nPool}`); }
}
// the airport: dry grass inside the fence, concrete aprons, taxiways with yellow centre lines, runways with white markings
{
  const offset = (pts, d) => pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [p[0] - ((b[1] - a[1]) / L) * d, p[1] + ((b[0] - a[0]) / L) * d]; });
  const dashed = (pts, w, dash, gap, col) => { let acc = 0; for (let i = 0; i + 1 < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[i + 1], L = Math.hypot(x2 - x1, y2 - y1);
    for (let s = 0; s < L; ) { const ph = acc % (dash + gap), on = ph < dash, step = Math.min(L - s, on ? dash - ph : dash + gap - ph); if (on) gm.strokeLine([[x1 + ((x2 - x1) * s) / L, y1 + ((y2 - y1) * s) / L], [x1 + ((x2 - x1) * (s + step)) / L, y1 + ((y2 - y1) * (s + step)) / L]], w, paint(col)); s += step; acc += step; } } };
  const aeroA = extractPolygons(els, proj, (t) => t.aeroway === 'aerodrome' || t.aeroway === 'apron');
  for (const p of aeroA.filter((q) => q.tags.aeroway === 'aerodrome')) gm.fillRings([p.outer, ...p.holes], paint(srgb('#b8bd8f')));
  for (const p of aeroA.filter((q) => q.tags.aeroway === 'apron')) gm.fillRings([p.outer, ...p.holes], paint(srgb('#b4b2ac')));
  const aeroL = extractLines(els, proj, (t) => (t.aeroway === 'taxiway' || t.aeroway === 'runway') && t.area !== 'yes');
  const WHITE = srgb('#ecebe6'), YEL = srgb('#d9b54a');
  for (const r of aeroL.filter((q) => q.tags.aeroway === 'taxiway')) gm.strokeLine(r.pts, parseMeters(r.tags.width) ?? 23, paint(srgb('#7a7975')));
  for (const r of aeroL.filter((q) => q.tags.aeroway === 'taxiway')) gm.strokeLine(r.pts, 0.5, paint(YEL));
  for (const r of aeroL.filter((q) => q.tags.aeroway === 'runway')) {
    const w = parseMeters(r.tags.width) ?? 45;
    gm.strokeLine(r.pts, w + 6, paint(srgb('#a9a79f'))); gm.strokeLine(r.pts, w, paint(srgb('#5f5e5b')));
    for (const d of [-1, 1]) gm.strokeLine(offset(r.pts, d * (w / 2 - 1.2)), 0.9, paint(WHITE));
    dashed(r.pts, 0.9, 30, 20, WHITE);
  }
}
for (const r of rails) if (r.tags.railway === 'rail' && !underground(r.tags)) gm.strokeLine(r.pts, 3.2, paint(C.ballast));   // gravel bed under main-line track
for (const r of rails) if (r.tags.railway === 'tram' && !underground(r.tags)) gm.strokeLine(r.pts, 2.3, paint(C.setts));   // granite setts between and beside the tram rails
for (const r of rails) { // two rails per track
  const tramish = r.tags.railway === 'tram' || r.tags.railway === 'funicular';
  const g = tramish ? 0.9 : (+r.tags.gauge || 1668) / 1000;
  for (const side of [-1, 1]) {
    const off = r.pts.map((p, i) => {
      const a = r.pts[Math.max(0, i - 1)], b = r.pts[Math.min(r.pts.length - 1, i + 1)];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [p[0] - ((b[1] - a[1]) / L) * g * side * 0.5, p[1] + ((b[0] - a[0]) / L) * g * side * 0.5];
    });
    gm.strokeLine(off, tramish ? 0.2 : 0.3, paint(tramish ? C.tramRail : C.rail));
  }
}
// Castelo de São Jorge: gravel of the Paço da Alcáçova grounds and the bare earth of the archaeological site
{
  const cas = extractPolygons(els, proj, (t) => !!(t.historic || t.tourism || t.castle_type));
  for (const [id, hex] of [['w1382432568', '#cbbb98'], ['w244745550', '#bfa985']]) { const p = cas.find((q) => q.id === id); if (p) gm.fillRings([p.outer, ...p.holes], paint(srgb(hex))); }
}
// Ribeira das Naus: the old Doca Seca is a sunken stone dry dock (OSM maps it as a ruined building): paint it as a basin
{
  const dock = polysB.find((p) => p.id === 'w678721536');
  if (dock) {   // the way traces the dock walls as a thin C; fill its convex hull as the basin floor, walls darker, coping pale
    const pts = [...dock.outer].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = []; for (const q of pts) { while (lo.length > 1 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
    for (const q of pts.reverse()) { while (hi.length > 1 && cr(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q); }
    const hull = [...lo.slice(0, -1), ...hi.slice(0, -1)];
    gm.fillRings([hull], paint(srgb('#a49d8e'))); gm.fillRings([dock.outer], paint(srgb('#7f796d'))); gm.strokeLine([...dock.outer, dock.outer[0]], 0.9, paint(srgb('#ddd5c3')));
  }
}
// Praça do Comércio: pale lioz paving crossed by the darker diagonal bands (mapped as footways)
{
  const sq = polysArea.find((p) => p.id === 'w677181958');
  if (sq) {
    // rhombus lattice centred on D. José, long axis along Rua Augusta
    const [ax, ay] = proj.fwd(38.70851, -9.13684), [bx, by] = proj.fwd(38.70959, -9.13726), Lv = Math.hypot(ax - bx, ay - by);
    const vx = (ax - bx) / Lv, vy = (ay - by) / Lv, ang = (29 * Math.PI) / 180;
    const n1 = [vx * Math.cos(ang) - vy * Math.sin(ang), vx * Math.sin(ang) + vy * Math.cos(ang)], n2 = [vx * Math.cos(-ang) - vy * Math.sin(-ang), vx * Math.sin(-ang) + vy * Math.cos(-ang)];
    const jose = polysB.find((p) => p.id === 'w663318739'), o = jose ? jose.c : sq.c, SP = 33, HW = 0.45;
    const base = srgb('#dcd6c8'), band = srgb('#a99f8e');
    gm.fillRings([sq.outer, ...sq.holes], (i) => {
      const x = minX + ((i % gm.w) + 0.5) * SS - o[0], y = maxY - (Math.floor(i / gm.w) + 0.5) * SS - o[1];
      const d1 = x * -n1[1] + y * n1[0], d2 = x * -n2[1] + y * n2[0];
      const m1 = Math.abs(((d1 % SP) + SP * 1.5) % SP - SP / 2), m2 = Math.abs(((d2 % SP) + SP * 1.5) % SP - SP / 2);
      paint(Math.min(m1, m2) < HW ? band : base)(i);
    });
  }
}
// Rossio: the 'mar largo' — black-and-white basalt/limestone calçada in broad waves
{
  const sq = polysArea.find((p) => p.id === 'w1317749306');
  if (sq) {
    const lightC = srgb('#e6e1d5'), darkC = srgb('#5e5c58');
    gm.fillRings([sq.outer, ...sq.holes], (i) => {
      const x = minX + ((i % gm.w) + 0.5) * SS, y = maxY - (Math.floor(i / gm.w) + 0.5) * SS;
      const w = y + 2.6 * Math.sin(x / 3.4);
      paint(((w / 7) % 1 + 1) % 1 < 0.5 ? darkC : lightC)(i);
    });
  }
  const fig = polysArea.find((p) => p.id === 'w1301226315');
  if (fig) gm.fillRings([fig.outer, ...fig.holes], paint(srgb('#e4ded0')));
}
// land cut off in the river with nothing built on it is a breakwater or a mole (off Cacilhas, the Mutela harbour wall):
// rock and concrete, not a grassy sandbar
const islet = new Uint8Array(water.length);
{
  const comp = new Int32Array(water.length).fill(-1), info = [], q = new Int32Array(water.length);
  for (let s = 0; s < water.length; s++) {
    if (water[s] === 2 || comp[s] >= 0) continue;
    const id = info.length; let qh = 0, qt = 0, n = 0, edge = false; q[qt++] = s; comp[s] = id;
    while (qh < qt) {
      const i = q[qh++], x = i % wr.w, y = (i / wr.w) | 0; n++;
      if (x === 0 || y === 0 || x === wr.w - 1 || y === wr.h - 1) edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < wr.w - 1 ? i + 1 : -1, y > 0 ? i - wr.w : -1, y < wr.h - 1 ? i + wr.w : -1])
        if (j >= 0 && comp[j] < 0 && water[j] !== 2) { comp[j] = id; q[qt++] = j; }
    }
    info.push({ n, edge, built: false });
  }
  for (const p of polysB) { const c = Math.floor((p.c[0] - wr.minX) / WM), r = Math.floor((wr.maxY - p.c[1]) / WM); if (c >= 0 && r >= 0 && c < wr.w && r < wr.h && comp[r * wr.w + c] >= 0) info[comp[r * wr.w + c]].built = true; }
  let nI = 0;
  for (let i = 0; i < water.length; i++) { const k = comp[i]; if (k >= 0 && !info[k].edge && !info[k].built && info[k].n * WM * WM < 60000) { islet[i] = 1; nI++; } }
  if (nI) log(`breakwaters/moles: ${nI} m²`);
}
const ROCK1 = srgb('#a7a196'), ROCK2 = srgb('#8c867b');
// water (from 1 m mask)
for (let r = 0; r < gm.h; r++) for (let c = 0; c < gm.w; c++) {
  const wi = Math.floor((r * SS + WMG) / WM) * wr.w + Math.floor((c * SS + WMG) / WM);
  if (islet[wi] && water[wi] !== 3) { const x = c * SS, y = r * SS, h = Math.sin(Math.floor(x / 1.4) * 127.1 + Math.floor(y / 1.4) * 311.7) * 43758.5; paint(h - Math.floor(h) < 0.5 ? ROCK1 : ROCK2)(r * gm.w + c); }
  else if (water[wi] === 2) paint(C.water)(r * gm.w + c);
  else if (water[wi] === 3) paint(C.pond)(r * gm.w + c);
}
log(`ground map painted ${gm.w}×${gm.h}`);

// downsample to 1 m and bake contact AO around buildings
const GW = Math.round((maxX - minX) / 0.5), GH = Math.round((maxY - minY) / 0.5);   // painted at 0.32 m, filtered down to 0.5 m: crisp kerbs without stair-steps
let ground1 = await sharp(Buffer.from(gm.data.buffer), { raw: { width: gm.w, height: gm.h, channels: 3 }, limitInputPixels: false }).resize(GW, GH, { kernel: 'lanczos3' }).raw().toBuffer();
gm.data = null;
{
  const bm = new Raster(minX, minY, maxX, maxY, (maxX - minX) / GW);
  const mask = new Float32Array(bm.w * bm.h);
  for (const p of polysB) if (!p.skip) bm.fillRings([p.outer, ...p.holes], (i) => { if (i < mask.length) mask[i] = 1; });
  const ao = boxBlur(mask, bm.w, bm.h, 6, 3);
  for (let i = 0; i < GW * GH; i++) {
    const k = 1 - Math.min(1, ao[i] * 1.15) * 0.42;
    ground1[i * 3] *= k; ground1[i * 3 + 1] *= k; ground1[i * 3 + 2] *= k;
  }
}
log('AO baked');
{ // wear: two octaves of value noise so pavements and yards are not flat colour
  const vn = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, h = (a, b) => { let n = (a * 374761393 + b * 668265263) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy); return (h(xi, yi) * (1 - sx) + h(xi + 1, yi) * sx) * (1 - sy) + (h(xi, yi + 1) * (1 - sx) + h(xi + 1, yi + 1) * sx) * sy; };
  const mpp = (maxX - minX) / GW;
  for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) {
    const x = minX + c * mpp, y = maxY - r * mpp, k = 0.93 + 0.09 * vn(x / 23, y / 23) + 0.05 * vn(x / 4.1, y / 4.1), i = (r * GW + c) * 3;
    ground1[i] *= k; ground1[i + 1] *= k; ground1[i + 2] *= k;
  }
}

// ─── trees ──────────────────────────────────────────────────────────────
const trees = [];
const groundPx = (x, y) => { const c = Math.floor(((x - minX) / (maxX - minX)) * GW), r = Math.floor(((maxY - y) / (maxY - minY)) * GH); return c >= 0 && r >= 0 && c < GW && r < GH ? r * GW + c : -1; };
// tree kind rides in the scale's tens digit: 0 broadleaf, 1 palm, 2 stone pine / conifer, 3 cypress
const PALMS = /^(phoenix|chamaerops|howea|jubaea|washingtonia|cocos|trachycarpus|syagrus|livistona|butia|archontophoenix)/i, CONIFERS = /^(pinus|cupressus|cedrus|araucaria|taxus|juniperus|abies|picea)/i;
const treeKind = (t) => { const g = t.genus || t.taxon || t.species || ''; return t.leaf_type === 'palm' || PALMS.test(g) ? 1 : /^cupressus/i.test(g) ? 3 : t.leaf_type === 'needleleaved' || CONIFERS.test(g) ? 2 : 0; };
const addTree = (x, y, sc, kind = 0) => { if (x < minX || x > maxX || y < minY || y > maxY || isWaterAt(x, y)) return; trees.push(x, meshAt(x, y), -y, sc + 10 * kind); };
// size by species where the city's tree survey tagged it: the Avenida's planes and elms are big, the lódãos medium
const treeScale = (t, h) => {
  const ht = parseMeters(t.height); if (ht && ht > 2 && ht < 40) return Math.max(0.6, Math.min(2.4, ht / 7.5));
  const g = `${t.genus || ''} ${t.species || ''}`;
  if (/Chamaerops/i.test(g)) return 0.45 + h * 0.15;                               // dwarf fan palm
  if (/Phoenix|Washingtonia/i.test(g)) return 1.3 + h * 0.5;                       // the tall Canary date palms of the squares
  if (/Platanus|Ulmus|Populus/i.test(g)) return 2.2 + h * 0.5;   // the Avenida's planes are 20–25 m with crowns that close over the side lanes (checked against Earth)
  if (/Tipuana|Ficus/i.test(g)) return 1.7 + h * 0.45;
  if (/Celtis|Tilia|Jacaranda|Melia/i.test(g)) return 1.05 + h * 0.35;
  return 0.95 + h * 0.65;   // untagged street trees: Lisbon's are mostly mature (Avenidas Novas, checked against Earth)
};
// cemeteries (Prazeres, Alto de São João, Ajuda, Benfica, Lumiar): streets of jazigos along the mapped paths, lined with cypresses
{
  const { pointInRing } = await import('./lib/osm.mjs');
  const cems = polysArea.filter((p) => (p.tags.landuse === 'cemetery' || p.tags.amenity === 'grave_yard') && p.area > 4000);
  let nT = 0, nC = 0;
  for (const cem of cems) {
    const inside = (x, y) => pointInRing(x, y, cem.outer) && !cem.holes.some((h) => pointInRing(x, y, h));
    const xs = cem.outer.map((q) => q[0]), ys = cem.outer.map((q) => q[1]), bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const inBB = (q) => q[0] > bb[0] - 5 && q[0] < bb[2] + 5 && q[1] > bb[1] - 5 && q[1] < bb[3] + 5;
    const paths = roads.filter((r) => r.pts.some(inBB) && r.pts.some((q) => inside(q[0], q[1])));
    const segs = paths.flatMap((r) => r.pts.slice(1).map((q, i) => [r.pts[i], q, (ROAD_W[roadKind(r.tags)] || 3) / 2]));
    const near = polysB.filter((b) => !b.tags['building:part'] && b.outer.some(inBB));
    const segD = (x, y, [a, b]) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)); return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t); };
    const clear = (x, y, r) => inside(x, y) && segs.every((sg) => segD(x, y, sg) > sg[2] + r) && !near.some((b) => pointInRing(x, y, b.outer));
    const mapped = treeNodes.filter((t) => inBB(t.p) && inside(t.p[0], t.p[1])).length, plant = mapped < cem.area / 400;   // Prazeres has its cypresses mapped tree by tree
    const taken = new Set(), cell = (x, y) => `${Math.floor(x / 2.6)},${Math.floor(y / 2.6)}`;
    const MARBLE = [lin(srgb('#e9e7e1')), lin(srgb('#d2cdc2')), lin(srgb('#bdb8ad')), lin(srgb('#dcd5c6'))], TRIM = lin(srgb('#c4bfb4'));
    for (const [a, b, hw] of segs) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 3) continue;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      for (const side of [-1, 1]) {
        const nx = -uy * side, ny = ux * side;
        for (let s = 1.6; s < L - 1.6; s += 3.0) {   // a jazigo every 3 m, its door to the path
          const off = hw + 0.9 + 1.6, x = a[0] + ux * s + nx * off, y = a[1] + uy * s + ny * off, k = cell(x, y);
          if (x < minX || x >= maxX || y < minY || y >= maxY || taken.has(k) || !clear(x, y, 1.6)) continue;
          taken.add(k);
          const hh = hash(`${cem.id}${Math.round(x)},${Math.round(y)}`), cap = hh < 0.45 ? 0 : hh < 0.7 ? 1 : 2;
          // facing the path: the door side (v) points back at it
          jazigo(getTile(...tileOf(x, y)).d, { x, y, ux: -ux * side, uy: -uy * side, ground: meshAt(x, y), h: 2.4 + hh * 1.6, w: 2.2 + (hh * 7 % 1) * 0.6, d: 2.8, col: MARBLE[Math.floor(hh * 13) % 4], trim: TRIM, cap });
          nT++;
        }
        if (plant) for (let s = 3.5; s < L - 2; s += 7) {   // cypresses between path and tombs
          const x = a[0] + ux * s + nx * (hw + 0.5), y = a[1] + uy * s + ny * (hw + 0.5);
          if (inside(x, y) && hash(`${x.toFixed(1)}c`) < 0.6) { addTree(x, y, 0.75 + hash(`${y.toFixed(1)}c`) * 0.5, 3); nC++; }
        }
      }
    }
  }
  if (cems.length) log(`cemeteries: ${cems.length}, jazigos ${nT}, cypresses ${nC}`);
}
for (const t of treeNodes) if (t.id !== 'n3761456264') addTree(t.p[0], t.p[1], treeScale(t.tags, hash(t.id)), treeKind(t.tags));   // the Príncipe Real cedar is authored
for (const r of treeRows) for (let i = 0; i + 1 < r.pts.length; i++) {
  const [x1, y1] = r.pts[i], [x2, y2] = r.pts[i + 1], L = Math.hypot(x2 - x1, y2 - y1);
  for (let s = 0; s < L; s += 8) addTree(x1 + ((x2 - x1) * s) / L, y1 + ((y2 - y1) * s) / L, 0.8 + hash(r.id + s) * 0.5, treeKind(r.tags));
}
const nTagged = trees.length / 4;
{ // scatter inside parks / woods (procedural, flagged in manifest)
  const bm = new Raster(minX, minY, maxX, maxY, 1);
  const blocked = new Uint8Array(bm.w * bm.h);
  for (const p of polysB) bm.fillRings([p.outer, ...p.holes], (i) => { blocked[i] = 1; });
  for (const p of polysB) if (/^(monastery|convent|church|cathedral|palace|castle)$/.test(p.tags.building) && p.holes.length) bm.fillRings([p.outer], (i) => { blocked[i] = 1; });
  for (const w of extractLines(els, proj, (t) => t.barrier === 'hedge')) bm.strokeLine(w.pts, 10, (i) => { blocked[i] = 1; });   // box parterres (Parque Eduardo VII, Praça do Império) are clipped lawns, no trees among the hedges
  for (const p of polysArea) if (/^(claustro|cloister|pátio|patio)\b/i.test(p.tags.name || '')) bm.fillRings([p.outer, ...p.holes], (i) => { blocked[i] = 1; });   // cloisters and palace courts: clipped box and gravel, not a grove (Jerónimos, checked against Earth)
  for (const r of roads) if (ROAD_W[roadKind(r.tags)]) bm.strokeLine(r.pts, ROAD_W[roadKind(r.tags)] + 2, (i) => { blocked[i] = 1; });
  for (let i = 0; i < trees.length; i += 4) bm.disc(trees[i], -trees[i + 2], 5, (k) => { blocked[k] = 1; });
  { const [x, y] = proj.fwd(38.7162199, -9.1483953); bm.disc(x, y, 15, (k) => { blocked[k] = 1; }); }   // under the Príncipe Real cedar's canopy
  for (const p of polysArea) if (/^(pitch|playground|track|swimming_pool|stadium)$/.test(p.tags.leisure) || p.tags.amenity === 'parking' || p.tags.natural === 'water' || p.tags.place === 'square') bm.fillRings([p.outer, ...p.holes], (i) => { blocked[i] = 1; });   // no trees on pitches, courts, pools or car parks
  // grove field: value noise at ~45 m, sharpened, so trees gather in clumps with lawns between (about half the park planted)
  const vn = (x, y) => { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), h = (a, b) => hash(`${a},${b}gv`);
    return (h(i, j) * (1 - sx) + h(i + 1, j) * sx) * (1 - sy) + (h(i, j + 1) * (1 - sx) + h(i + 1, j + 1) * sx) * sy; };
  const grove = (x, y) => { const n = vn(x / 45, y / 45) * 0.7 + vn(x / 17 + 9.1, y / 17 + 3.7) * 0.3; const t = Math.min(1, Math.max(0, (n - 0.38) / 0.24)); return t * t * (3 - 2 * t) * 0.95; };
  // back-yard annexes (anexos) in the old city's blocks: from the air the logradouros of Arroios, Campo de Ourique, Graça… are
  // half built over with one- and two-storey sheds, workshops and enclosed porches against the rear walls (checked against Earth).
  // Not in OSM: placed where a free yard spot lies within 3 m of a building, about one in two, each kept clear of the others.
  { const AW = [srgb('#ece8df'), srgb('#e4ddcf'), srgb('#f1efe9'), srgb('#ddd5c6')].map(lin), AR = [srgb('#b9b4ab'), srgb('#ad6e59'), srgb('#a9a69f'), srgb('#9e9286'), srgb('#b27b63'), srgb('#c4c0b8')].map(lin);
    const ST = [KIND.PLAIN / 8, 5 / 8, 0.6, 1], I0 = [0, 0, 0, 0], DIRS = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
    const isB = (x, y) => { const c = Math.floor(bm.px(x)), r = Math.floor(bm.py(y)); return c < 0 || r < 0 || c >= bm.w || r >= bm.h || blocked[r * bm.w + c] === 1; };
    let nA = 0;
    const bb = new Uint8Array(bm.w * bm.h);   // real buildings only: an annex leans on a house, never on another annex
    for (const q of polysB) bm.fillRings([q.outer], (i) => { bb[i] = 1; });
    const isBld = (x, y) => { const c = Math.floor(bm.px(x)), r = Math.floor(bm.py(y)); return c >= 0 && r >= 0 && c < bm.w && r < bm.h && bb[r * bm.w + c] === 1; };
    const rr = new Uint8Array(bm.w * bm.h);   // every mapped way (streets, alleys, stairs) with 6 m to spare
    for (const r of roads) bm.strokeLine(r.pts, (ROAD_W[roadKind(r.tags)] || 3) + 12, (i) => { rr[i] = 1; });
    const nearRoad = (x, y) => { const c = Math.floor(bm.px(x)), r = Math.floor(bm.py(y)); return c < 0 || r < 0 || c >= bm.w || r >= bm.h || rr[r * bm.w + c] === 1; };
    for (const p of polysArea) {
      if (p.tags.landuse !== 'residential' || Math.hypot(p.c[0], p.c[1] * 1.15) > 2500 || Math.hypot(p.c[0], p.c[1]) < 1300 || p.area < 400) continue;   // not in Alfama, Mouraria, Graça, Bairro Alto: their gaps are alleys and stairs, not yards
      const xs = p.outer.map((q) => q[0]), ys = p.outer.map((q) => q[1]);
      for (let x = Math.min(...xs); x < Math.max(...xs); x += 4) for (let y = Math.min(...ys); y < Math.max(...ys); y += 4) {
        const jx = x + (hash(`${x},${y}ax`) - 0.5) * 2, jy = y + (hash(`${x},${y}ay`) - 0.5) * 2;
        if (hash(`${jx}an`) > 0.85 || Math.hypot(jx, jy) < 1300 || Math.hypot(jx, jy * 1.15) > 2500 || !pointInRing(jx, jy, p.outer) || isB(jx, jy)) continue;
        let n = null, wd = 0; for (const r of [2.5, 4.5]) { for (const [dx, dy] of DIRS) if (isBld(jx + dx * r, jy + dy * r)) { n = [dx, dy]; wd = r; break; } if (n) break; }   // a rear wall close by
        if (!n || isBld(jx - n[0] * 6, jy - n[1] * 6) || nearRoad(jx, jy)) continue;   // a passage between two walls, or a street edge, is no yard
        const tx = -n[1], ty = n[0], hw = 2 + hash(`${jx}w`) * 2.2, hd = 1.5 + hash(`${jy}d`) * 1.6, cx = jx - n[0] * (hd - wd + 0.3), cy = jy - n[1] * (hd - wd + 0.3);
        let ok = true;   // the yard side and both ends must be open ground (the wall side may touch the building)
        for (const [a, b] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [0, 0]]) if (isB(cx + (tx * hw * a + n[0] * hd * b) * 0.95, cy + (ty * hw * a + n[1] * hd * b) * 0.95)) { ok = false; break; }
        if (!ok) continue;
        const two = hash(`${jx}t`) < 0.2, z0 = groundAt(cx, cy), z1 = z0 + (two ? 5.6 : 2.9) + hash(`${jy}h`) * 0.7;
        const S = getTile(...tileOf(cx, cy)).b, wc = AW[Math.floor(hash(`${jx}c`) * AW.length)], rc = AR[Math.floor(hash(`${jy}r`) * AR.length)];
        box(S, cx, cy, tx, ty, hw, hd, z0 - 0.5, z1 - 0.18, wc, I0, ST);
        box(S, cx, cy, tx, ty, hw + 0.12, hd + 0.12, z1 - 0.18, z1, rc, I0, ST);
        bm.fillRings([[[cx - tx * hw - n[0] * hd, cy - ty * hw - n[1] * hd], [cx + tx * hw - n[0] * hd, cy + ty * hw - n[1] * hd], [cx + tx * hw + n[0] * hd, cy + ty * hw + n[1] * hd], [cx - tx * hw + n[0] * hd, cy - ty * hw + n[1] * hd]]], (i) => { blocked[i] = 1; });
        nA++;
      }
    }
    log(`back-yard annexes: ${nA}`);
  }
  for (const p of polysArea) {
    const t = p.tags;
    // estates: the lawns between post-war blocks (Olivais, Benfica, Telheiras…) are planted with big trees — thinner than a park
    const estate = (t.landuse === 'residential' || t.landuse === 'grass') && Math.hypot(p.c[0], p.c[1] * 1.15) > 2500;
    // courtyards (logradouros) of the inner-city blocks: gardens with a tree or two, citrus, a palm (Avenidas Novas, Campo de Ourique, Estrela)
    const yard = t.landuse === 'residential' && !estate;
    const wood = t.natural === 'wood' || t.landuse === 'forest' || /^(Jardim Gulbenkian|Jardim Botânico|Tapada das Necessidades|Jardim da Estrela|Jardim Guerra Junqueiro)/.test(t.name || ''), dense = wood ? 7 : t.leisure === 'park' || t.leisure === 'garden' ? 7.5 : estate ? 7 : yard ? 9 : 0;   // estates sample at 7 m (villa gardens use it all; the rest thins to the old 12 m density)
    if (!dense || p.area < 150) continue;
    const clearAt = (x, y) => { for (const [dx, dy] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) { const c = Math.floor(bm.px(x + dx)), r = Math.floor(bm.py(y + dy)); if (c < 0 || r < 0 || c >= bm.w || r >= bm.h || blocked[r * bm.w + c]) return false; } return true; };
    const xs = p.outer.map((q) => q[0]), ys = p.outer.map((q) => q[1]);
    for (let x = Math.min(...xs); x < Math.max(...xs); x += dense) for (let y = Math.min(...ys); y < Math.max(...ys); y += dense) {
      const jx = x + (hash(`${p.id}${x}${y}a`) - 0.5) * dense * 0.8, jy = y + (hash(`${p.id}${x}${y}b`) - 0.5) * dense * 0.8;
      if (!pointInRing(jx, jy, p.outer) || p.holes.some((h) => pointInRing(jx, jy, h))) continue;
      const c = Math.floor(bm.px(jx)), r = Math.floor(bm.py(jy));
      if (c < 0 || r < 0 || c >= bm.w || r >= bm.h || blocked[r * bm.w + c]) continue;
      if (LIDAR) { const z = Math.max(LIDAR(jx, jy), LIDAR(jx + 1.5, jy), LIDAR(jx - 1.5, jy), LIDAR(jx, jy + 1.5), LIDAR(jx, jy - 1.5)); if (z < 2) continue; }   // a tree only where the survey sees a canopy (airfields, lawns and vacant lots stay open)
      if (estate && villaAt(jx, jy)) {   // villa gardens: dense trees, hedging pines, palms, cypresses, 3 m off the walls
        let ok = true; for (const [dx, dy] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]]) { const cc = Math.floor(bm.px(jx + dx)), rr = Math.floor(bm.py(jy + dy)); if (cc < 0 || rr < 0 || cc >= bm.w || rr >= bm.h || blocked[rr * bm.w + cc]) { ok = false; break; } }
        if (ok && hash(`${jx}v`) < 0.62) { const kk = hash(`${jy}vk`); addTree(jx, jy, 0.6 + hash(`${jx}`) * 0.5, kk < 0.12 ? 1 : kk < 0.27 ? 2 : kk < 0.37 ? 3 : 0); }
        continue;
      }
      if (estate && openAtG && openAtG(jx, jy) > 0.5 && hash(`${jx}o`) > 0.12) continue;   // vacant lots and verges far from any building: rough grass, a stray tree (Benfica, checked against Earth)
      if (estate && (hash(`${jx}e`) > 0.34 || !clearAt(jx, jy))) continue;   // keep estate trees off walls and kerbs
      if (yard) {   // only where a courtyard opens up: 6 m clear of walls all round, and then about every other spot
        let ok = true; for (const [dx, dy] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [4.2, 4.2], [-4.2, 4.2], [4.2, -4.2], [-4.2, -4.2]]) { const cc = Math.floor(bm.px(jx + dx)), rr = Math.floor(bm.py(jy + dy)); if (cc < 0 || rr < 0 || cc >= bm.w || rr >= bm.h || blocked[rr * bm.w + cc]) { ok = false; break; } }
        if (!ok || hash(`${jx}y`) > 0.65) continue;
        addTree(jx, jy, 0.55 + hash(`${jx}`) * 0.45, hash(`${jy}p`) < 0.15 ? 1 : 0); continue;
      }
      if (!wood && hash(`${jx}g`) > grove(jx, jy) * (estate ? 0.8 : 1)) continue;   // parks: groves and open lawns, not an orchard
      addTree(jx, jy, (wood ? 0.8 : 0.75) + hash(`${jx}`) * 0.65, dense === 7 && hash(`${jy}k`) < 0.3 ? 2 : 0);   // woods: some pines among the broadleaves
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
  await doc.transform(weld(), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeNormal: 8, quantizeTexcoord: 16, quantizeColor: 8 }));
  await io.write(file, doc);
  return fs.statSync(file).size;
}

const ni = Math.ceil((maxX - minX) / TILE), nj = Math.ceil((maxY - minY) / TILE);
// street lamps: wall brackets every ~28 m along streets, alternating sides; one point each (night glow sprites)
const lamps = [];
const asphaltAt = (x, y) => { const i = groundPx(x, y); if (i < 0) return false; const r = ground1[i * 3], g = ground1[i * 3 + 1], b = ground1[i * 3 + 2]; return Math.max(r, g, b) - Math.min(r, g, b) < 18 && r + g + b < 3 * 165; };
{
  // open squares (Praça do Comércio, Rossio…) are lit from their edges, not along the paths that cross them
  const squares = polysArea.filter((p) => p.tags.place === 'square' || p.tags.highway === 'pedestrian' || p.tags['area:highway'] === 'pedestrian')
    .map((p) => { const xs = p.outer.map((q) => q[0]), ys = p.outer.map((q) => q[1]); return { ring: p.outer, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; });
  const inSquare = (x, y) => squares.some((q) => x > q.x0 && x < q.x1 && y > q.y0 && y < q.y1 && pointInRing(x, y, q.ring));
  const seen = new Set(), SP = { primary: 30, secondary: 30, tertiary: 28, trunk: 32, motorway: 40, residential: 26, unclassified: 26, living_street: 24, service: 34, pedestrian: 24, steps: 18 };   // footways (plaza diagonals, park paths) stay dark
  for (const r of sorted) {
    const k = roadKind(r.tags), sp = SP[k]; if (!sp) continue;
    const w = parseMeters(r.tags.width) ?? ROAD_W[k];
    let carry = sp * 0.5, side = 1;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1], L = Math.hypot(bx - ax, by - ay); if (L < 1e-3) continue;
      const nx = -(by - ay) / L, ny = (bx - ax) / L;
      for (let t = carry; t < L; t += sp) {
        const off = pedestrianish(k) && k !== 'pedestrian' ? 0 : w / 2 + 0.6;
        // walk outwards off the carriageway (the mapped width is often narrower than the painted road): posts stand on the pavement or a median, never in traffic
        const sd = side; side = -side;
        let x = 0, y = 0, okP = false;
        for (let e = 0; e <= 7 && !okP; e += 0.75) { x = ax + ((bx - ax) * t) / L + nx * (off + e) * sd; y = ay + ((by - ay) * t) / L + ny * (off + e) * sd; okP = !asphaltAt(x, y); if (off === 0) break; }
        if (!okP) continue;
        if (x < minX || x > maxX || y < minY || y > maxY || isWaterAt(x, y) || (k === 'pedestrian' && inSquare(x, y))) continue;
        const key = Math.round(x / 9) + ',' + Math.round(y / 9); if (seen.has(key)) continue; seen.add(key);
        lamps.push(x, meshAt(x, y) + 4.6, -y);
      }
      carry = carry >= L ? carry - L : sp - ((L - carry) % sp);
    }
  }
  log(`street lamps ${lamps.length / 3}`);
}
// cars: parked along kerbs of ordinary streets, in lanes on the avenues. x, z, -y, heading, pitch, colour seed
const cars = [];
{
  const CAR = { primary: 'lane', secondary: 'lane', tertiary: 'both', trunk: 'lane', residential: 'park', unclassified: 'park', living_street: 'park' };
  const carHash = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  const taken = new Set();
  for (const r of sorted) {
    const k = roadKind(r.tags), mode = CAR[k]; if (!mode) continue;
    if (r.tags.access === 'no' || r.tags.motor_vehicle === 'no' || r.tags.tunnel) continue;
    const w = parseMeters(r.tags.width) ?? ROAD_W[k]; if (w < 6) continue;
    const oneway = r.tags.oneway === 'yes';
    let acc = 0; const total = r.pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - r.pts[i - 1][0], p[1] - r.pts[i - 1][1]) : 0), 0);
    if (total < 24) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1], L = Math.hypot(bx - ax, by - ay); if (L < 1e-3) { continue; }
      const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy, ny = ux;
      for (let t = 2; t < L; t += 5.2) {
        const along = acc + t; if (along < 10 || along > total - 10) continue;   // keep junctions clear
        const h = carHash(r.pts[0][0] + along, r.pts[0][1] + i);
        let off, dir;
        if (mode === 'park' || (mode === 'both' && h < 0.5)) {
          if (h > 0.62) continue;                                            // gaps between parked cars
          const side = carHash(along, r.pts[0][0]) < 0.5 ? 1 : -1; off = side * (w / 2 - 1.1); dir = side > 0 ? 0 : (oneway ? 0 : Math.PI);
        } else {
          if (h > 0.16) continue;                                            // sparse traffic
          const lane = oneway ? (carHash(along, 7) < 0.5 ? 1 : -1) * w / 6 : (carHash(along, 9) < 0.5 ? 1 : -1) * w / 4;
          off = lane; dir = oneway || lane < 0 ? 0 : Math.PI;                 // drive on the right
        }
        const x = ax + ux * t + nx * off, y = ay + uy * t + ny * off;
        if (x < minX || x > maxX || y < minY || y > maxY || isWaterAt(x, y)) continue;
        const key = Math.round(x / 4) + ',' + Math.round(y / 4); if (taken.has(key)) continue; taken.add(key);
        const z0 = meshAt(x - ux * 2, y - uy * 2), z1 = meshAt(x + ux * 2, y + uy * 2);
        const head = Math.atan2(uy, ux) + dir;
        cars.push(x, (z0 + z1) / 2, -y, head, Math.atan2(z1 - z0, 4) * (dir ? -1 : 1), h);
      }
      acc += L;
    }
  }
  log(`cars ${cars.length / 6}`);
}
const manifest = {
  area: AREA, origin: { lat: lat0, lon: lon0 }, bbox: { S, W, N, E }, bounds: { minX, minY, maxX, maxY }, waterY: WATER_Y, baseY: BASE_Y,
  tiles: [], stats: { ...stats, waterSource, trees: trees.length / 4, treesMapped: nTagged, lamps: lamps.length / 3, cars: cars.length / 6 },
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
  const tw = Math.max(16, Math.round((TEX_PX * (x1 - x0)) / 1000)), th = Math.max(16, Math.round((TEX_PX * (y1 - y0)) / 1000));   // TEX_PX per km
  const webp = await sharp(ground1, { raw: { width: GW, height: GH, channels: 3 } })
    .extract({ left: px0, top: py0, width: px1 - px0, height: py1 - py0 }).resize(tw, th, { kernel: 'lanczos3' }).sharpen({ sigma: 0.7, m1: 0.6, m2: 1.4 }).webp({ quality: 80, effort: 6 }).toBuffer();
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
  // skirts: hang a 3 m strip down from every tile edge so hairline cracks between tiles (vertex quantisation is per tile)
  // show more ground instead of the sky
  const edge = [];
  for (let c = 0; c < cols; c++) edge.push([0 * cols + c, 0]);
  for (let r = 0; r < rows; r++) edge.push([r * cols + cols - 1, 1]);
  for (let c = cols - 1; c >= 0; c--) edge.push([(rows - 1) * cols + c, 2]);
  for (let r = rows - 1; r >= 0; r--) edge.push([r * cols, 3]);
  const nV = cols * rows, sPos = new Float32Array(pos.length + edge.length * 3), sUv = new Float32Array(uv.length + edge.length * 2), sN = new Float32Array(nrm.length + edge.length * 3);
  sPos.set(pos); sUv.set(uv); sN.set(nrm);
  edge.forEach(([k], i) => { sPos.set([pos[k * 3], pos[k * 3 + 1] - 3, pos[k * 3 + 2]], (nV + i) * 3); sUv.set([uv[k * 2], uv[k * 2 + 1]], (nV + i) * 2); sN.set([nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]], (nV + i) * 3); });
  const sIdx = new Uint32Array(idx.length + edge.length * 6); sIdx.set(idx); let sq = idx.length;
  for (let i = 0; i + 1 < edge.length; i++) { if (edge[i][1] !== edge[i + 1][1]) continue; const a = edge[i][0], b = edge[i + 1][0], a2 = nV + i, b2 = nV + i + 1; sIdx.set([a, b, a2, b, b2, a2], sq); sq += 6; }
  addMesh(doc, scene, 'terrain', { POSITION: [sPos, 'VEC3'], NORMAL: [sN, 'VEC3'], TEXCOORD_0: [sUv, 'VEC2'], indices: [sIdx.subarray(0, sq)] }, gmat);
  totalTris += idx.length / 3;
  // buildings
  const T = tiles.get(`${i}_${j}`);
  let balFile = null, detFile = null;
  if (T && T.b.pos.length) {
    const B = T.b;
    const bmat = doc.createMaterial('buildings').setRoughnessFactor(0.9).setMetallicFactor(0);
    const col = Uint8Array.from(B.col, (v) => Math.round(Math.min(1, v) * 255));
    addMesh(doc, scene, 'buildings', {
      POSITION: [Float32Array.from(B.pos), 'VEC3'], NORMAL: [Float32Array.from(B.nrm), 'VEC3'], COLOR_0: [col, 'VEC3', true],
      TEXCOORD_0: [Float32Array.from(B.surf, (v) => Math.min(1, Math.max(0, v / 512 + 0.5))), 'VEC2'], _INFO: [Float32Array.from(B.info), 'VEC4'], _STYLE: [Float32Array.from(B.style), 'VEC4'],
    }, bmat);
    totalTris += B.pos.length / 9;
    const Dd = T.d;   // façade relief: its own file, fetched only for tiles near the camera
    if (Dd.pos.length) {
      const dd = newDoc(); detFile = `d_${i}_${j}.glb`;
      addMesh(dd.doc, dd.scene, 'detail', {
        POSITION: [Float32Array.from(Dd.pos), 'VEC3'], NORMAL: [Float32Array.from(Dd.nrm), 'VEC3'], COLOR_0: [Uint8Array.from(Dd.col, (v) => Math.round(Math.min(1, v) * 255)), 'VEC3', true],
      }, dd.doc.createMaterial('detail').setRoughnessFactor(0.85).setMetallicFactor(0));   // plain stonework: no façade attributes to carry
      totalTris += Dd.pos.length / 9; stats.detailTris = (stats.detailTris || 0) + Dd.pos.length / 9;
      totalBytes += await writeDoc(dd.doc, path.join(OUT, detFile));
    }
    if (T.balconies.length) { balFile = `bal_${i}_${j}.bin`; fs.writeFileSync(path.join(OUT, balFile), Buffer.from(Float32Array.from(T.balconies).buffer)); totalBytes += T.balconies.length * 4; }
  }
  const file = `t_${i}_${j}.glb`;
  const bytes = await writeDoc(doc, path.join(OUT, file));
  totalBytes += bytes;
  manifest.tiles.push({ file, i, j, bounds: [x0, y0, x1, y1], bytes, balconies: balFile, detail: detFile });
  log(`tile ${i},${j}: ${(bytes / 1024).toFixed(0)} KB`);
}


// ─── far level of detail: one file per area, a coarse terrain and a plain block per building for every tile ───
// Seen from a kilometre or more a building is its silhouette, wall colour and roof colour: that is all this keeps.
{
  const FG = 25, FTEX = 256;   // 25 m terrain grid, 256 px (≈2 m) per 500 m tile: roads still read at the horizon
  const simplify = (ring, tol) => {   // Douglas–Peucker on a closed ring
    const pts = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
    if (pts.length <= 4) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = 1;
    let far = 0, fd = -1; for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
    keep[far] = 1;
    const dp = (a, b) => {   // indices a < b along the ring
      const [ax, ay] = pts[a], [bx, by] = pts[b % pts.length], L = Math.hypot(bx - ax, by - ay) || 1e-9;
      let m = -1, md = tol;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > md) { md = d; m = i; } }
      if (m >= 0) { keep[m] = 1; dp(a, m); dp(m, b); }
    };
    dp(0, far); dp(far, pts.length);
    return pts.filter((_, i) => keep[i]);
  };
  const byTile = new Map();
  for (const p of FAR) { const [ti, tj] = tileOf(p.c[0], p.c[1]); const k = `${ti}_${tj}`; if (!byTile.has(k)) byTile.set(k, []); byTile.get(k).push(p); }
  const { doc, scene } = newDoc();
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const bmat = doc.createMaterial('farBuildings').setRoughnessFactor(0.9).setMetallicFactor(0);
  let farTris = 0;
  for (const t of manifest.tiles) {
    const [x0, y0, x1, y1] = t.bounds, { i, j } = t;
    // terrain
    const px0 = Math.round(((x0 - minX) / (maxX - minX)) * GW), px1 = Math.round(((x1 - minX) / (maxX - minX)) * GW);
    const py0 = Math.round(((maxY - y1) / (maxY - minY)) * GH), py1 = Math.round(((maxY - y0) / (maxY - minY)) * GH);
    const tw = Math.max(8, Math.round((FTEX * (x1 - x0)) / TILE)), th = Math.max(8, Math.round((FTEX * (y1 - y0)) / TILE));
    const webp = await sharp(ground1, { raw: { width: GW, height: GH, channels: 3 } }).extract({ left: px0, top: py0, width: px1 - px0, height: py1 - py0 }).resize(tw, th, { kernel: 'lanczos3' }).webp({ quality: 72 }).toBuffer();
    const gmat = doc.createMaterial(`fg_${i}_${j}`).setBaseColorTexture(doc.createTexture().setImage(webp).setMimeType('image/webp')).setRoughnessFactor(1).setMetallicFactor(0);
    const cols = Math.max(2, Math.round((x1 - x0) / FG) + 1), rows = Math.max(2, Math.round((y1 - y0) / FG) + 1);
    const pos = [], uv = [], idx = [], nrm = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = x0 + ((x1 - x0) * c) / (cols - 1), y = y1 - ((y1 - y0) * r) / (rows - 1);
      pos.push(x, groundAt(x, y), -y); uv.push(c / (cols - 1), r / (rows - 1));
      const e = 6, hx = groundAt(x + e, y) - groundAt(x - e, y), hy = groundAt(x, y + e) - groundAt(x, y - e), n = [-hx / (2 * e), 1, hy / (2 * e)], l = Math.hypot(...n);
      nrm.push(n[0] / l, n[1] / l, n[2] / l);
    }
    for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) { const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1; idx.push(a, d, b, b, d, e); }
    addMesh(doc, scene, `ft_${i}_${j}`, { POSITION: [Float32Array.from(pos), 'VEC3'], NORMAL: [Float32Array.from(nrm), 'VEC3'], TEXCOORD_0: [Float32Array.from(uv), 'VEC2'], indices: [Uint32Array.from(idx)] }, gmat);
    farTris += idx.length / 3;
    // buildings: extruded simplified footprints, walls in the façade colour, a flat cap in the roof colour at mid-roof
    const list = byTile.get(`${i}_${j}`) || [];   // no buildings is no reason to skip: a tile of open river can still carry a bridge
    const P = [], C = [];   // no normals: the viewer shades these flat, so welding can share every corner
    const tri = (a, b, c, col) => { P.push(...a, ...b, ...c); for (let k = 0; k < 3; k++) C.push(...col); };
    for (const p of list) {
      const spec = buildingSpec(p);
      if (Math.abs(p.area) < 25) continue;
      const outer = simplify(p.outer, 1.5); if (outer.length < 3) continue;
      const holes = p.holes.filter((h) => Math.abs(ringArea(h)) > 60).map((h) => simplify(h, 1.2)).filter((h) => h.length >= 3);
      let g = Infinity; for (const [x, y] of outer) g = Math.min(g, groundAt(x, y)); if (p.ground != null) g = p.ground;
      const pitched = spec.shape !== 'flat', roofH = pitched ? Math.min(spec.roofH ?? 3, spec.h * 0.3) : 0;
      const yb = g + (spec.minH || 0) - (spec.minH ? 0 : 1.5), yt = g + Math.max(spec.h - roofH * 0.55, (spec.minH || 0) + 0.5);
      const wall = lin(spec.wall), roof = lin(pitched ? spec.roofCol : spec.flatCol);
      const ccw = (r, want) => (Math.sign(ringArea(r)) === want ? r : r.slice().reverse());
      const rings = [ccw(outer, 1), ...holes.map((h) => ccw(h, -1))];
      for (const r of rings) for (let k = 0; k < r.length; k++) {   // outward walls (ccw outer: outside is on the right of each edge)
        const [ax, ay] = r[k], [bx, by] = r[(k + 1) % r.length];
        const A = [ax, yb, -ay], B = [bx, yb, -by], Bt = [bx, yt, -by], At = [ax, yt, -ay];
        const n = triNormal(A, B, Bt), out = n[0] * (by - ay) + n[2] * (bx - ax) >= 0;   // outward = right of the edge = (dy, 0, dx) in world axes
        if (out) { tri(A, B, Bt, wall); tri(A, Bt, At, wall); } else { tri(A, Bt, B, wall); tri(A, At, Bt, wall); }
      }
      const flat = [], hi = [];
      for (const r of rings) { if (flat.length) hi.push(flat.length / 2); for (const [x, y] of r) flat.push(x, y); }
      const ix = earcut(flat, hi);
      for (let k = 0; k < ix.length; k += 3) {
        const v = (q) => [flat[q * 2], yt, -flat[q * 2 + 1]];
        const a = v(ix[k]), b = v(ix[k + 1]), c = v(ix[k + 2]);
        if (triNormal(a, b, c)[1] < 0) tri(a, c, b, roof); else tri(a, b, c, roof);
      }
    }
    if (P.length) {
      addMesh(doc, scene, `fb_${i}_${j}`, { POSITION: [Float32Array.from(P), 'VEC3'], COLOR_0: [Uint8Array.from(C, (v) => Math.round(Math.min(1, v) * 255)), 'VEC3', true] }, bmat);
      farTris += P.length / 9;
    }
    // the bridges and the aqueduct stand at every distance: their own mesh, so the viewer draws no windows on them
    const F = FARX.get(`${i}_${j}`);
    if (F && F.P.length) {
      addMesh(doc, scene, `fx_${i}_${j}`, { POSITION: [Float32Array.from(F.P), 'VEC3'], COLOR_0: [Uint8Array.from(F.C, (v) => Math.round(Math.min(1, v) * 255)), 'VEC3', true] }, bmat);
      farTris += F.P.length / 9;
    }
  }
  const bytes = await writeDoc(doc, path.join(OUT, 'far.glb'));
  totalBytes += bytes;
  manifest.far = { bytes, tris: farTris };
  log(`far LOD: ${(bytes / 1048576).toFixed(2)} MB, ${(farTris / 1e6).toFixed(2)} M tris`);
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
  // a side shared with a neighbouring area is inside the city: no wall there
  const near = (a, b) => Math.abs(a - b) < 1e-6, overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 1e-6;
  const others = ALL_AREAS.filter(([n]) => n !== AREA);
  const hasN = (side) => others.some(([, s, w, n, e]) => side === 'S' ? near(n, S) && overlap(w, e, W, E) : side === 'N' ? near(s, N) && overlap(w, e, W, E)
    : side === 'E' ? near(w, E) && overlap(s, n, S, N) : near(e, W) && overlap(s, n, S, N));
  if (!hasN('S')) edge(minX, minY, maxX, minY, [0, 0, 1]);   // south
  if (!hasN('E')) edge(maxX, minY, maxX, maxY, [1, 0, 0]);   // east
  if (!hasN('N')) edge(maxX, maxY, minX, maxY, [0, 0, -1]);  // north
  if (!hasN('W')) edge(minX, maxY, minX, minY, [-1, 0, 0]);  // west
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
  let nw = 0; for (let i = 0; i < water.length; i++) if (water[i] === 2) nw++;
  manifest.stats.water = +(nw / water.length).toFixed(4);
  for (let i = 0; i < m.length; i++) m[i] = water[i] === 2 ? 255 : 0;
  await sharp(m, { raw: { width: wr.w, height: wr.h, channels: 1 } }).blur(0.7)
    .extract({ left: WMG / WM, top: WMG / WM, width: Math.ceil((maxX - minX) / WM), height: Math.ceil((maxY - minY) / WM) }).png({ compressionLevel: 9, palette: false }).toFile(path.join(OUT, 'water.png'));
  fs.writeFileSync(path.join(OUT, 'trees.bin'), Buffer.from(Float32Array.from(trees).buffer));
  fs.writeFileSync(path.join(OUT, 'lamps.bin'), Buffer.from(Float32Array.from(lamps).buffer));
  fs.writeFileSync(path.join(OUT, 'cars.bin'), Buffer.from(Float32Array.from(cars).buffer));
  totalBytes += cars.length * 4;
  totalBytes += fs.statSync(path.join(OUT, 'water.png')).size + trees.length * 4 + lamps.length * 4;
}
manifest.stats.bytes = totalBytes;
manifest.stats.detailTris = stats.detailTris || 0;
manifest.stats.triangles = totalTris;
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
// city index: every built area's manifest in one file, first area first (the viewer streams tiles from all of them)
const index = { areas: ALL_AREAS.map(([n]) => path.join(ROOT, 'public/tiles', n, 'manifest.json')).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))) };
fs.writeFileSync(path.join(ROOT, 'public/tiles/index.json'), JSON.stringify(index));
log(`done: ${(totalBytes / 1048576).toFixed(2)} MB, ${(totalTris / 1e6).toFixed(2)} M tris`);
