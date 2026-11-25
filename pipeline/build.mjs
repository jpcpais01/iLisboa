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
import { loadOverpass, makeProjection, extractPolygons, extractLines, extractNodes, parseMeters, pointInRing, ringArea } from './lib/osm.mjs';
import { Raster, boxBlur } from './lib/raster.mjs';
import { makeSink, markPartyWalls, buildRoofAndWalls, skeletonRoof, roofExtras, obb, KIND, box, wallQuad, triUp } from './lib/buildings.mjs';
import { OVERRIDES, DROP, dropTag, BAIXA_ZONES, notBlock, pombalineBlocks, profileRoof, mansardProfile, arcoRuaAugusta, equestrianJose, pedroIVColumn, rossioFountain, portico, seCathedral, panteao, carmoRuins, santaJustaLift, caisColunas, parishChurch, CHURCHES, tramCar, trainCar, catenaryMast, cacilheiro, miradouro, restauradoresObelisk, rossioStationFront, saoBentoFront, sailboat, metalDome, estrelaBasilica, marquesColumn, trellisCedar, pelourinho, domedTower, AREAS, ponte25Abril, PONTE_LINE, cristoRei } from './lib/authored.mjs';

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

// ─── OSM ────────────────────────────────────────────────────────────────
const els = loadOverpass(path.join(ROOT, 'data/raw', `${AREA}.osm.json.gz`));
log(`OSM elements: ${els.length}`);
const isBuilding = (t) => (t.building && t.building !== 'no') || (t['building:part'] && t['building:part'] !== 'no');
const underground = (t) => t.location === 'underground' || (t.layer && +t.layer < 0) || t.tunnel === 'yes' || t.tunnel === 'building_passage';
const polysB = (() => {   // the same footprint mapped twice (a convent relation over its hospital ways) z-fights: keep one
  const all = extractPolygons(els, proj, (t) => isBuilding(t) && !underground(t)), seen = new Map(), out = [];
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
{ // building-aware ground (see dem.refine)
  const cr = new Raster(minX - 400, minY - 400, maxX + 400, maxY + 400, 3);
  for (const p of polysB) if (!p.tags['building:part']) cr.fillRings([p.outer, ...p.holes], (i) => { cr.data[i] = 1; });
  const covered = (la, lo) => { const [x, y] = proj.fwd(la, lo), c = Math.floor((x - cr.minX) / 3), r = Math.floor((cr.maxY - y) / 3); return c >= 0 && r >= 0 && c < cr.w && r < cr.h && cr.data[r * cr.w + c] === 1; };
  const st = dem.refine(covered);
  log(`ground refined under roofs: ${st.roofCells} cells, mean shift ${st.meanShift.toFixed(2)} m, max ${st.maxShift.toFixed(1)} m`);
}
const polysArea = extractPolygons(els, proj, (t) => !isBuilding(t) && (t.landuse || t.leisure || t.natural || t.place || t.amenity || t.highway || t['area:highway'] || t.man_made || t.tourism || t.railway === 'platform'));
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
  for (const p of polysArea) if (p.tags.natural === 'water' || p.tags.waterway === 'riverbank' || p.tags.waterway === 'dock' || p.tags.leisure === 'swimming_pool' || p.tags.amenity === 'fountain')
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
const stats = { authored: 0, buildings: 0, height: 0, levels: 0, estimated: 0, planar: 0, skeleton: 0, flat: 0, skeletonFail: 0, parts: 0, skippedOutlines: 0, partyEdges: 0, balconies: 0, statues: 0, wallsM: 0, pillars: 0, chimneys: 0 };

const LEVEL_H = 3.2;
const DEFAULT_H = { church: 20, cathedral: 26, chapel: 10, house: 8, detached: 8, garage: 3, garages: 3, shed: 3, kiosk: 3.2, hut: 3, roof: 3.5, school: 13, hospital: 18, train_station: 12, ruins: 5, castle: 14, tower: 25, bunker: 3, carport: 3, pillar: 5, service: 3.5, construction: 6 };
// institutions (hospital, school, university, government, public, civic) in the old centre are mostly convents and palaces
// under tiled roofs; only built-for-purpose types default to flat-roofed modern boxes
const MODERN = new Set(['office', 'commercial', 'hotel', 'industrial', 'warehouse', 'transportation', 'train_station', 'parking']);
const UTILITY = new Set(['roof', 'garage', 'garages', 'shed', 'hut', 'bunker', 'carport', 'kiosk', 'service', 'construction', 'ruins', 'pillar']);
const pal = (list) => list.map(([c, w]) => [srgb(c), w]);
// Real Lisbon façade colours: lime whites, Pombaline ochre, rose/salmon, pistachio, sky blue, lilac, oxblood
const POMBALINE = pal([['#f1ece2', 24], ['#ece0c2', 14], ['#e9c97f', 22], ['#e8b9a0', 12], ['#e2c3c4', 6], ['#c9d7e0', 7], ['#d6dcb9', 5], ['#c27a62', 3], ['#f0dcaa', 8]]);
const VERNACULAR = pal([['#f5f2eb', 34], ['#f0e3c4', 11], ['#efcc7e', 12], ['#ecb79e', 10], ['#bcd3e3', 8], ['#d3dfb8', 5], ['#e8ac84', 5], ['#e2bccb', 5], ['#c86a53', 3], ['#b8cbbb', 3], ['#f3d899', 5]]);
const MODERN_C = pal([['#e7e3dc', 30], ['#cfcac2', 20], ['#b7b4ae', 10], ['#ddd2bf', 15], ['#a8b3b8', 6]]);
const STONE = srgb('#ddd2bd'), LIOZ = srgb('#e7dfcd'), CASTLE = srgb('#c9b99b');
const ROOFS = pal([['#a05c46', 5], ['#a9664f', 4], ['#925444', 3], ['#ad735b', 3], ['#844e41', 2], ['#9b604d', 3]]);   // weathered terracotta
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
    else if ((p.area > 3000 && (levels >= 6 || h > 22)) || h > 34) shape = 'flat';   // big low blocks in the old city are convents and palaces under hip roofs
    else if (utility && p.area < 40) shape = 'flat';
    else if ((variant === 1 || variant === 2) && p.area < 350) { const r = u('rs'); shape = r < 0.1 ? 'flat' : r < 0.3 ? 'gabled' : 'hipped'; }   // old-town mix: terraces (açoteias), gables, hips
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
  const roofCol = parseColour(tameRoof(t['roof:colour'])) || pick(ROOFS, u('r'));
  const flatCol = shape === 'flat' && parseColour(t['roof:colour']) || pick(FLAT_ROOF, u('f'));
  const pitch = shape === 'pyramidal' ? 40 : church ? 34 : 24 + u('pt') * 13;
  const spec = { kind, h, minH, src, shape, floorH, groundH, bayW, variant, stone, castle, pillar, wall, roofCol, flatCol, pitch,
    roofH: parseMeters(t['roof:height']), balconyFloors: floorH ? balconyFloors : [], balconyChance, parapet: variant === 3 ? 1.1 : castle ? 0 : 0.8 };
  const o = OVERRIDES[p.id]; // hand-authored
  if (o) { Object.assign(spec, o, { src: 'authored' }); if (o.wall) spec.wall = srgb(o.wall); if (o.roofCol) spec.roofCol = srgb(o.roofCol); }
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
  if (mode === 'skeleton' && s.shape === 'mansard') profileRoof(S, sk, { ...ctx, bayW: s.bayW, variant: s.variant }, mansardProfile(1.3, 2.6, 0.5, top - wallTop));
  else if (mode === 'skeleton') skeletonRoof(S, sk, ctx, sl, 5.5, ['dome', 'onion', 'cone'].includes(s.shape));
  if (!s.stone && s.h > 5) { roofExtras(S, ctx, res.f, rng, mode !== 'flat'); stats.chimneys++; }
  if (s.crenel) { // merlons along every edge (castle walls and towers)
    const cs = [KIND.STONE / 8, 5 / 8, seed, 0.9];
    for (const r of rings) for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
      const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L, n = Math.max(1, Math.floor(L / 1.8));
      for (let k = 0; k < n; k++) { const t = (k + 0.5) / n * L; box(S, a[0] + dx * t - dy * 0.3, a[1] + dy * t + dx * 0.3, dx, dy, 0.42, 0.3, wallTop - 0.05, wallTop + 1.15, colWall, [0, 0, 0, 0], cs); }
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
  const parts = polysB.filter((p) => p.tags['building:part']);
  const outlines = polysB.filter((p) => !p.tags['building:part']);
  for (const o of outlines) {
    o.skip = parts.some((pt) => pt.area > 4 && pointInRing(pt.c[0], pt.c[1], o.outer) && Math.abs(pt.c[0] - o.c[0]) < 400);
    if (o.skip && churchy(o) && !['r19372558_0', 'w9253917'].includes(o.id)) { o.skip = false; o.ownParts = true; }   // churches: the outline is modelled whole
    if (o.skip) stats.skippedOutlines++;
  }
  const churchParts = new Set(parts.filter((pt) => outlines.some((o) => o.ownParts && Math.abs(pt.c[0] - o.c[0]) < 120 && pointInRing(pt.c[0], pt.c[1], o.outer))));
  stats.parts = parts.length;
  // hand-authored pilot: the Praça's arcade pillars live in the façade shader; the Arco and D. José are modelled below
  const [pxa, pya] = proj.fwd(38.7062, -9.1400), [pxb, pyb] = proj.fwd(38.7092, -9.1330);
  const inPraca = (p) => p.c[0] > pxa && p.c[0] < pxb && p.c[1] > pya && p.c[1] < pyb;
  const dropped = (p) => DROP.has(p.id) || (dropTag(p.tags) && inPraca(p)) || (p.tags['bridge:support'] && nearPonte(p.c[0], p.c[1]));   // the bridge's piers and pylons are authored
  // Sé: the mapped parts carry no heights; the cathedral is modelled by hand below
  const seOutline = polysB.find((p) => p.id === 'r19372558_0');
  const seParts = seOutline ? parts.filter((p) => pointInRing(p.c[0], p.c[1], seOutline.outer)) : [];
  const ptOutline = polysB.find((p) => p.id === 'w9253917');
  const ptParts = ptOutline ? parts.filter((p) => pointInRing(p.c[0], p.c[1], ptOutline.outer)) : [];
  const seSet = new Set([seOutline, ...seParts, ptOutline, ...ptParts].filter(Boolean));
  for (const p of [...outlines.filter((o) => !o.skip), ...parts]) if (p.c[0] >= minX && p.c[0] <= maxX && p.c[1] >= minY && p.c[1] <= maxY && Math.abs(p.area) >= 12 && !dropped(p)) FAR.push(p);
  let todo = [...outlines.filter((o) => !o.skip), ...parts].filter((p) => !seSet.has(p) && !churchParts.has(p)).filter((p) => p.c[0] >= minX && p.c[0] <= maxX && p.c[1] >= minY && p.c[1] <= maxY && Math.abs(p.area) >= 2 && !dropped(p));
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
    if (mp) { const g = mp.geometry, [x, y] = proj.fwd(g.reduce((a, q) => a + q.lat, 0) / g.length, g.reduce((a, q) => a + q.lon, 0) / g.length); marquesColumn(tileB(x, y), { cx: x, cy: y, ground: groundAt(x, y), lin, srgb }); mark(); }
  }
  { const cr = byId.get('w87891338');   // Cristo Rei: pedestal and statue on the OSM footprint, facing Lisbon
    if (cr && cr.c[0] >= minX && cr.c[0] < maxX && cr.c[1] >= minY && cr.c[1] < maxY) { const ob = obb(cr.outer); cristoRei(tileB(...cr.c), { cx: cr.c[0], cy: cr.c[1], ux: ob.ux, uy: ob.uy, hl: ob.hl, hw: ob.hw, ground: cr.outer.reduce((a, q) => Math.min(a, groundAt(q[0], q[1])), Infinity), lin, srgb }); mark(); } }
  { const [x, y] = proj.fwd(38.7162199, -9.1483953); trellisCedar(tileB(x, y), { cx: x, cy: y, ground: groundAt(x, y), lin, srgb }); mark(); }
  const camara = byId.get('w95417254');
  if (camara) { const [a, b] = facing(camara, -1, 0, 15); const sg = ringArea(camara.outer) > 0; portico(tileB(...camara.c), { a: sg ? a : b, b: sg ? b : a, ground: groundAt(...camara.c), depth: 3.2, colH: 12.5, cols: 4, span: 13, statue: false, lin, srgb }); mark(); }
  {
    const pel = els.find((e) => e.type === 'node' && e.id === 1120633222);
    if (pel) { const [x, y] = proj.fwd(pel.lat, pel.lon); pelourinho(tileB(x, y), { cx: x, cy: y, ground: groundAt(x, y), lin, srgb }); mark(); }
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
function distribute(T) {
  let kept = 0;
  for (let t = 0; t < T.pos.length / 9; t++) {
    const o = t * 9, cx = (T.pos[o] + T.pos[o + 3] + T.pos[o + 6]) / 3, cy = -(T.pos[o + 2] + T.pos[o + 5] + T.pos[o + 8]) / 3;
    if (cx < minX || cx >= maxX || cy < minY || cy >= maxY) continue;
    const D = tileB0(cx, cy); kept++;
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
// ─── statues, columns & historic walls ──────────────────────────────────
const authoredSpots = [...polysB.filter((p) => DROP.has(p.id)).map((p) => p.c), proj.fwd(38.71360, -9.13798)];
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
if (BAD.length) { log('BAD geometry', BAD.length, BAD.slice(0, 5).join('\n')); process.exitCode = 1; }

// ─── ground map (supersampled) ──────────────────────────────────────────
const gm = new Raster(minX, minY, maxX, maxY, SS, 3);
const C = {
  ground: srgb('#d0c8b9'), calcada: srgb('#e2dbcd'), asphalt: srgb('#85827e'), road_edge: srgb('#c9c2b5'),
  park: srgb('#9fbf7a'), grass: srgb('#afc98a'), wood: srgb('#7fa465'), pitch: srgb('#93c07c'), sand: srgb('#e3cf9f'),
  parking: srgb('#b7b2aa'), rail: srgb('#4f4b47'), ballast: srgb('#9a9186'), setts: srgb('#76736e'), tramRail: srgb('#c4c1ba'), yard: srgb('#b3aa9d'), platform: srgb('#d9d3c8'), water: srgb('#4c8296'), pond: srgb('#5d93a3'), pier: srgb('#b8aa94'), plaza: srgb('#e4ddce'),
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
  if (t.landuse === 'railway' && !underground(t) && !t.man_made) return C.yard;
  if (t.railway === 'platform' && !underground(t)) return C.platform;
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
// water (from 1 m mask)
for (let r = 0; r < gm.h; r++) for (let c = 0; c < gm.w; c++) {
  const wi = Math.floor((r * SS + WMG) / WM) * wr.w + Math.floor((c * SS + WMG) / WM);
  if (water[wi] === 2) paint(C.water)(r * gm.w + c);
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
  for (const p of polysB) if (!p.tags['building:part'] || true) bm.fillRings([p.outer, ...p.holes], (i) => { if (i < mask.length) mask[i] = 1; });
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
// tree kind rides in the scale's tens digit: 0 broadleaf, 1 palm, 2 stone pine / conifer
const PALMS = /^(phoenix|chamaerops|howea|jubaea|washingtonia|cocos|trachycarpus|syagrus|livistona|butia|archontophoenix)/i, CONIFERS = /^(pinus|cupressus|cedrus|araucaria|taxus|juniperus|abies|picea)/i;
const treeKind = (t) => { const g = t.genus || t.taxon || t.species || ''; return t.leaf_type === 'palm' || PALMS.test(g) ? 1 : t.leaf_type === 'needleleaved' || CONIFERS.test(g) ? 2 : 0; };
const addTree = (x, y, sc, kind = 0) => { if (x < minX || x > maxX || y < minY || y > maxY || isWaterAt(x, y)) return; trees.push(x, meshAt(x, y), -y, sc + 10 * kind); };
// size by species where the city's tree survey tagged it: the Avenida's planes and elms are big, the lódãos medium
const treeScale = (t, h) => {
  const ht = parseMeters(t.height); if (ht && ht > 2 && ht < 40) return Math.max(0.6, Math.min(2.4, ht / 7.5));
  const g = `${t.genus || ''} ${t.species || ''}`;
  if (/Chamaerops/i.test(g)) return 0.45 + h * 0.15;                               // dwarf fan palm
  if (/Phoenix|Washingtonia/i.test(g)) return 1.3 + h * 0.5;                       // the tall Canary date palms of the squares
  if (/Platanus|Ulmus|Tipuana|Ficus|Populus/i.test(g)) return 1.45 + h * 0.45;
  if (/Celtis|Tilia|Jacaranda|Melia/i.test(g)) return 1.05 + h * 0.35;
  return 0.8 + h * 0.6;
};
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
  for (const r of roads) if (ROAD_W[roadKind(r.tags)]) bm.strokeLine(r.pts, ROAD_W[roadKind(r.tags)] + 2, (i) => { blocked[i] = 1; });
  for (let i = 0; i < trees.length; i += 4) bm.disc(trees[i], -trees[i + 2], 5, (k) => { blocked[k] = 1; });
  { const [x, y] = proj.fwd(38.7162199, -9.1483953); bm.disc(x, y, 15, (k) => { blocked[k] = 1; }); }   // under the Príncipe Real cedar's canopy
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
      addTree(jx, jy, 0.75 + hash(`${jx}`) * 0.6, dense === 7 && hash(`${jy}k`) < 0.3 ? 2 : 0);   // woods: some pines among the broadleaves
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
// street lamps: wall brackets every ~28 m along streets, alternating sides; one point each (night glow sprites)
const lamps = [];
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
        const x = ax + ((bx - ax) * t) / L + nx * off * side, y = ay + ((by - ay) * t) / L + ny * off * side; side = -side;
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


// ─── far level of detail: one file per area, a coarse terrain and a plain block per building for every tile ───
// Seen from a kilometre or more a building is its silhouette, wall colour and roof colour: that is all this keeps.
{
  const FG = 25, FTEX = 160;   // 25 m terrain grid, 160 px (≈3 m) per 500 m tile
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
    const list = byTile.get(`${i}_${j}`); if (!list) continue;
    const P = [], C = [];   // no normals: the viewer shades these flat, so welding can share every corner
    const tri = (a, b, c, col) => { P.push(...a, ...b, ...c); for (let k = 0; k < 3; k++) C.push(...col); };
    for (const p of list) {
      const spec = buildingSpec(p);
      if (Math.abs(p.area) < 25) continue;
      const outer = simplify(p.outer, 1.5); if (outer.length < 3) continue;
      const holes = p.holes.filter((h) => Math.abs(ringArea(h)) > 60).map((h) => simplify(h, 1.2)).filter((h) => h.length >= 3);
      let g = Infinity; for (const [x, y] of outer) g = Math.min(g, groundAt(x, y));
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
manifest.stats.triangles = totalTris;
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
// city index: every built area's manifest in one file, first area first (the viewer streams tiles from all of them)
const index = { areas: ALL_AREAS.map(([n]) => path.join(ROOT, 'public/tiles', n, 'manifest.json')).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))) };
fs.writeFileSync(path.join(ROOT, 'public/tiles/index.json'), JSON.stringify(index));
log(`done: ${(totalBytes / 1048576).toFixed(2)} MB, ${(totalTris / 1e6).toFixed(2)} M tris`);
