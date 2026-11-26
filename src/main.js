import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { initTouch } from './touch.js';
import { createChase } from './chase.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildingMaterial, farBuildingMaterial, waterMaterial, terrainMaterial, waterUniformTime, cityUniforms, balconyGeometry, railingMaterial } from './materials.js';
import { sunDirection } from './sun.js';
import { createSky } from './sky.js';
import { initLive } from './live/index.js';
import { carGeometries, carPaint } from './cars.js';
import { initDrive } from './drive/index.js';

const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
const SHOW_STATS = new URLSearchParams(location.search).has('stats');

// ─── renderer ───────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, isMobile ? 1.5 : 2);   // phones: 1.5 is sharp at arm's length and costs half the pixels of 2
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;   // re-rendered only when needed (see fitShadow)
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 4, 30000);

// Sky, sun, ambient light and haze all come from one physical atmosphere (src/sky.js), re-solved when the clock moves.
const Q = new URLSearchParams(location.search);
const sky = createSky(renderer, scene, { mobile: isMobile });
if (Q.has('clouds')) sky.clouds = +Q.get('clouds');

// The sun casts two shadow cascades: a sharp map around the view (follows it closely) and a wide, coarse one out to the
// horizon (re-drawn only every few hundred metres of travel or when the sun moves), so the far city keeps its form at a
// low sun instead of going flat. The twin light lends its map only; it adds no light (see sky.js).
const sun = new THREE.DirectionalLight(0xffffff, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(+Q.get('shadow') || (isMobile ? 2048 : 4096));
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 1.0;
sun.shadow.radius = 2;
const sunFar = new THREE.DirectionalLight(0x000000, 0);
sunFar.castShadow = true;
sunFar.shadow.mapSize.setScalar(isMobile ? 1024 : 2048);
sunFar.shadow.bias = -0.0004;
sunFar.shadow.normalBias = 2.5;
sunFar.shadow.camera.layers.set(1);   // only buildings and ground cast into it (trees, cars, lamps are below its texel)
for (const l of [sun, sunFar]) l.shadow.autoUpdate = false;
scene.add(sun, sun.target, sunFar, sunFar.target);
const BIG = 1;   // layer for far-cascade casters
const bigCaster = (o) => { o.layers.enable(BIG); return o; };

const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.minDistance = 60;
controls.maxDistance = 7000;
controls.maxPolarAngle = 1.32;
controls.zoomToCursor = true;
// fingers get their own maps-style navigation (pan / pinch / twist / tilt, fling); MapControls keeps the mouse
// third-person chase camera (follow a plane / bus / tram; drive mode): one finger orbits instead of panning while it is on
const chase = createChase({ camera, controls, ground: (x, y) => (live ? live.ground.at(x, y) : 0), roofs: (x, y) => (live ? live.ground.roofAt(x, y) : -Infinity) });
const touch = initTouch({ camera, controls, canvas, onStart: () => { introT = 1; }, orbit: () => chase.active, exclude: (e) => chase.exclude(e) });
window.__chase = chase;


// ─── load: the city is several areas of 500 m tiles; tiles stream in and out around the view ───
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const progressEl = document.getElementById('progress');
const ok = (r) => { if (!r.ok) throw new Error(`${r.status} ${r.url}`); return r; };
const index = await (await fetch('/tiles/index.json', { cache: 'no-cache' })).json();
const AREAS = index.areas;
const manifest = AREAS[0];   // origin, water level and attribution are shared by every area
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const a of AREAS) { minX = Math.min(minX, a.bounds.minX); minY = Math.min(minY, a.bounds.minY); maxX = Math.max(maxX, a.bounds.maxX); maxY = Math.max(maxY, a.bounds.maxY); }
const center = new THREE.Vector3((minX + maxX) / 2, 0, -(minY + maxY) / 2);
const size = Math.hypot(maxX - minX, maxY - minY);
document.getElementById('attrib').textContent = manifest.attribution;

const matBuildings = buildingMaterial();
const matDetail = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
const maxAniso = renderer.capabilities.getMaxAnisotropy();
let done = 0, total = 1;
const tick = () => { progressEl.style.width = `${Math.min(1, ++done / total) * 100}%`; };

// every asset URL carries its area's build stamp, so a new deploy never mixes with cached tiles
const url = (a, f) => `/tiles/${a.area}/${f}?v=${encodeURIComponent(a.built)}`;
const balconyParts = (() => { let g = null; return () => g || (g = (() => { const { slab, rail } = balconyGeometry(); return { slab, rail: mergeGeometries(rail), slabMat: new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.8 }), railMat: railingMaterial() }; })()); })();
const balconyChunks = [];
const solidRailMat = new THREE.MeshStandardMaterial({ color: 0xeeebe4, roughness: 0.85, side: THREE.DoubleSide });
// iron balconies (positive width) and modern concrete ones with a solid parapet (negative width, twice as deep)
function balconies(buf) {
  const d = new Float32Array(buf), n = d.length / 5, B = balconyParts();
  let nm = 0; for (let i = 4; i < d.length; i += 5) if (d[i] < 0) nm++;
  const ni = n - nm;
  const a = new THREE.InstancedMesh(B.slab, B.slabMat, n), b = new THREE.InstancedMesh(B.rail, B.railMat, Math.max(1, ni)), s = new THREE.InstancedMesh(B.rail, solidRailMat, Math.max(1, nm));
  b.count = ni; s.count = nm;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Vector3();
  for (let j = 0, i = 0, jb = 0, js = 0; j < n; j++, i += 5) {
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, d[i + 3]);
    const w = d[i + 4], mod = w < 0;
    m.compose(p.set(d[i], d[i + 1], d[i + 2]), q, sc.set(Math.abs(w), 1, mod ? 2 : 1));
    a.setMatrixAt(j, m); if (mod) s.setMatrixAt(js++, m); else b.setMatrixAt(jb++, m); c.add(p);
  }
  a.computeBoundingSphere(); b.computeBoundingSphere(); s.computeBoundingSphere();
  a.castShadow = true; a.receiveShadow = true; s.castShadow = true; s.receiveShadow = true;
  const g = new THREE.Group(); g.add(a, b, s); g.userData.c = c.divideScalar(Math.max(1, n));
  return g;
}

// The water mask (1 m a pixel over a whole area, ~11 Mpx) is one channel: uploaded as R8 it takes 14 MB of video memory instead of
// the 57 MB an RGBA image costs, and every visible area holds one
async function loadMask(u) {
  const bmp = await createImageBitmap(await (await fetch(u).then(ok)).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const W = bmp.width, H = bmp.height, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0); bmp.close?.();
  const px = cx.getImageData(0, 0, W, H).data, r = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { const src = (H - 1 - y) * W * 4, dst = y * W; for (let x = 0; x < W; x++) r[dst + x] = px[src + x * 4]; }   // rows bottom-up, as an image texture with flipY
  cv.width = cv.height = 1;
  const t = new THREE.DataTexture(r, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  t.unpackAlignment = 1; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  t.userData.px = W * H / 4;   // (for the memory check: one byte a pixel)
  return t;
}
// every area starts with its water, its skirt and its far level of detail (a coarse terrain and plain blocks per tile)
const tileAt = new Map();

// The far level of detail is one draw per area and kind, not ~100 small meshes: every tile's far ground goes into one mesh over an
// area-wide atlas of its ground images, its far blocks into another, bridges into a third. A tile that is showing its own version
// is hidden by a per-tile flag the vertex shader reads (its vertices collapse to a point), so nothing is re-uploaded as tiles come
// and go. Three thousand-odd draw calls become about a hundred, and the per-tile ground images are freed once in the atlas.
const deq = (g) => {   // meshopt-quantised attributes → float, so geometries can be baked into world space and merged
  for (const [k, at] of Object.entries(g.attributes)) {
    if (at.array instanceof Float32Array || k === 'color') continue;
    const n = at.count, s = at.itemSize, f = new Float32Array(n * s);
    for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) f[i * s + c] = at.getComponent(i, c);
    g.setAttribute(k, new THREE.BufferAttribute(f, s));
  }
  return g;
};
function hideable(mat, U) {   // collapse the vertices of tiles whose flag is set
  const prev = mat.onBeforeCompile, key = mat.customProgramCacheKey();
  mat.onBeforeCompile = (s, r) => {
    prev.call(mat, s, r); s.uniforms.uHide = U;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aTile; uniform vec4 uHide[16];')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n{ int k = int(aTile + .5); if (uHide[k >> 2][k & 3] > .5) transformed = vec3(0.); }');
  };
  mat.customProgramCacheKey = () => key + '-hide';
  return mat;
}
const flags = () => ({ value: Array.from({ length: 16 }, () => new THREE.Vector4()) });
function mergeFar(a, root) {
  root.updateMatrixWorld(true);
  const parts = { t: [], b: [], x: [] };
  for (const o of root.children) {
    const m = /^f([tbx])_(\d+)_(\d+)$/.exec(o.name);
    if (!m || !o.isMesh || !tileAt.get(`${a.area}:${m[2]}_${m[3]}`)) continue;
    parts[m[1]].push({ o, i: +m[2], j: +m[3] });
  }
  const ni = Math.max(...a.tiles.map((t) => t.i)) + 1, nj = Math.max(...a.tiles.map((t) => t.j)) + 1;
  if (ni * nj > 64) throw new Error(`${a.area}: ${ni}×${nj} tiles, the far flags hold 64`);
  const H = { t: flags(), b: flags(), ni };
  const bake = ({ o, i, j }, keep) => {
    const g = deq(o.geometry.clone()); g.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
    g.setAttribute('aTile', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(i + j * ni), 1));
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    return g;
  };
  const free = (list) => { for (const { o } of list) { o.geometry.dispose(); const map = o.material.map; if (map) { map.image?.close?.(); map.dispose(); } o.material.dispose(); } };
  const add = (geo, mat, name, U) => { const mesh = new THREE.Mesh(geo, mat);
    mesh.customDepthMaterial = hideable(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), U);   // hidden tiles cast no shadow either
    mesh.name = name; mesh.receiveShadow = true; mesh.castShadow = true; bigCaster(mesh); mesh.matrixAutoUpdate = false; mesh.userData.farMerged = true; scene.add(mesh); return mesh; };
  // ground: lay the tile images out edge to edge (each keeps its own size, so the atlas is simply the area's ground image)
  if (parts.t.length) {
    const colW = new Map(), rowH = new Map();
    const S = isMobile ? 0.5 : 1;   // phones: ~4 m a pixel (a quarter of the video memory); this ground is only seen past ~1 km
    for (const { o, i, j } of parts.t) { const im = o.material.map.image; colW.set(i, Math.round(im.width * S)); rowH.set(j, Math.round(im.height * S)); }
    const cols = [...colW.keys()].sort((p, q) => p - q), rows = [...rowH.keys()].sort((p, q) => q - p);   // atlas rows run north → south
    const x0 = new Map(), y0 = new Map(); let W = 0, Hh = 0;
    for (const i of cols) { x0.set(i, W); W += colW.get(i); }
    for (const j of rows) { y0.set(j, Hh); Hh += rowH.get(j); }
    const cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
    const cx = cv.getContext('2d');
    const geos = parts.t.map((p) => {
      cx.drawImage(p.o.material.map.image, x0.get(p.i), y0.get(p.j), colW.get(p.i), rowH.get(p.j));
      const g = bake(p, ['position', 'normal', 'uv']), uv = g.attributes.uv, w = colW.get(p.i), h = rowH.get(p.j);
      for (let k = 0; k < uv.count; k++) uv.setXY(k, (x0.get(p.i) + uv.getX(k) * w) / W, (y0.get(p.j) + uv.getY(k) * h) / Hh);
      return g;
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.userData.px = W * Hh; tex.onUpdate = () => { cv.width = cv.height = 1; };   // uploaded: let the canvas go
    add(mergeGeometries(geos), hideable(terrainMaterial(tex, a.mask, a.bounds), H.t), `ft_${a.area}`, H.t);
    free(parts.t);
  }
  if (parts.b.length) { add(mergeGeometries(parts.b.map((p) => bake(p, ['position', 'color']))), hideable(farBuildingMaterial(), H.b), `fb_${a.area}`, H.b); free(parts.b); }
  if (parts.x.length) { add(mergeGeometries(parts.x.map((p) => bake(p, ['position', 'color']))), hideable(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }), H.b), `fx_${a.area}`, H.b); free(parts.x); }
  a.farHide = H;   // from here on tiles flag themselves
  for (const t of tiles) if (t.a === a) showFar(t);
}
function base(a) {
  if (a.base) return a.base;
  return (a.base = (async () => {
    a.mask = await loadMask(url(a, 'water.png'));
    const { minX, minY, maxX, maxY } = a.bounds;
    if (a.stats.water !== 0) {
      const water = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxY - minY, 1, 1).rotateX(-Math.PI / 2), waterMaterial(a.mask));
      water.position.set((minX + maxX) / 2, a.waterY, -(minY + maxY) / 2);
      water.receiveShadow = true;
      scene.add(water);
    }
    loader.loadAsync(url(a, 'base.glb')).then((g) => { g.scene.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }); }); scene.add(g.scene); }).catch(() => {});
    if (a.far) {
      const g = await loader.loadAsync(url(a, 'far.glb'));
      mergeFar(a, g.scene);
    }
  })());
}
// near the view an area also gets its trees, parked cars and street lamps
function wake(a) {
  if (a.ready) return a.ready;
  return (a.ready = (async () => {
    await base(a);
    const get = (f) => fetch(url(a, f)).then((r) => (r.ok ? r.arrayBuffer() : new ArrayBuffer(0)));
    get('trees.bin').then(addTrees); get('cars.bin').then(addCars); get('lamps.bin').then(addLamps);
  })());
}

const tiles = AREAS.flatMap((a) => a.tiles.map((t) => ({ a, t, b: t.bounds, state: 0, mode: null, obj: null, bal: null })));   // state 0 idle, 1 loading, 2 shown; mode 'full' (own ground) or 'mid' (buildings over the far ground)
for (const t of tiles) tileAt.set(`${t.a.area}:${t.t.i}_${t.t.j}`, t);
const areaDist = (a) => rectDist([a.bounds.minX, a.bounds.minY, a.bounds.maxX, a.bounds.maxY], controls.target.x, -controls.target.z);
let farReady = null;   // started once the camera is placed: nearest area first, the loading screen waits only for the one under the view
const startFar = () => { const order = [...AREAS].sort((p, q) => areaDist(p) - areaDist(q)); farReady = base(order[0]).catch((e) => console.error(e)); (async () => { for (const a of order.slice(1)) await base(a).catch((e) => console.error(e)); })(); };
// a tile's far ground hides under its own full ground; its far blocks hide once its real buildings are in
const showFar = (t) => { const H = t.a.farHide; if (!H) return; const k = t.t.i + t.t.j * H.ni;
  H.t.value[k >> 2].setComponent(k & 3, t.state === 2 && t.mode === 'full' ? 1 : 0); H.b.value[k >> 2].setComponent(k & 3, t.state === 2 ? 1 : 0); };
function adopt(tile, gltf, mode) {
  const { a } = tile, strip = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (mode === 'mid' && o.name.startsWith('terrain')) { strip.push(o); return; }
    if (o.name.startsWith('buildings')) {
      const g = o.geometry;
      if (!g.attributes._info || !g.attributes._style) throw new Error(`stale tile ${o.name}`);
      g.setAttribute('surf', g.attributes.uv); g.deleteAttribute('uv');
      g.setAttribute('aInfo', g.attributes._info); g.deleteAttribute('_info');
      g.setAttribute('aStyle', g.attributes._style); g.deleteAttribute('_style');
      o.material = matBuildings;
      o.castShadow = o.receiveShadow = true; bigCaster(o);
    } else if (o.name.startsWith('terrain')) {
      const map = o.material.map;
      map.anisotropy = maxAniso; map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; map.needsUpdate = true;   // glTF defaults to REPEAT: tile edges bled the opposite edge in
      o.material = terrainMaterial(map, a.mask, a.bounds);
      o.receiveShadow = true; o.castShadow = true; bigCaster(o);   // hills shade the valleys at a low sun (back faces only: no acne)
    }
  });
  // a mid-distance tile keeps only its buildings: the ground there is the far level's (its 0.5 m texture would cost ~4 MB of
  // video memory per tile for a few hundred pixels on screen)
  for (const o of strip) { o.parent.remove(o); o.geometry.dispose(); o.material.map?.image?.close?.(); o.material.map?.dispose(); o.material.dispose(); }
  return gltf.scene;
}
function dispose(tile) {
  for (const o of [tile.obj, tile.bal]) {
    if (!o) continue;
    scene.remove(o);
    o.traverse((m) => {
      if (m.isInstancedMesh) { m.dispose(); return; }
      if (!m.isMesh) return;
      m.geometry.dispose();
      if (m.material !== matBuildings) { m.material.map?.dispose(); m.material.dispose(); }
    });
  }
  const i = balconyChunks.indexOf(tile.bal); if (i >= 0) balconyChunks.splice(i, 1);
  dropDetail(tile);
  tile.obj = tile.bal = null; tile.state = 0; tile.mode = null; showFar(tile);
}
async function load(tile, mode) {
  const upgrade = tile.state === 2;   // mid → full: the mid copy stays on screen until the full one is in
  tile.state = upgrade ? 2 : 1; tile.loading = mode; const gen = (tile.gen = (tile.gen || 0) + 1);
  const drop = (o) => o.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); if (m.material !== matBuildings) { m.material.map?.dispose(); m.material.dispose(); } } });
  try {
    await wake(tile.a);
    const gltf = await loader.loadAsync(url(tile.a, tile.t.file));
    if (tile.gen !== gen || tile.state === 0) { drop(gltf.scene); return; }   // dropped or superseded while in flight
    const obj = adopt(tile, gltf, mode);
    if (tile.obj) { scene.remove(tile.obj); drop(tile.obj); }
    tile.obj = obj; scene.add(obj);
    tile.state = 2; tile.mode = mode; showFar(tile);
  } catch (e) { console.error(e); if (tile.gen === gen && !upgrade) tile.state = 0; tile.failed = (tile.failed || 0) + 1; }
  finally { if (tile.gen === gen) tile.loading = null; }
}
// full → mid when the view moves away: drop the ground and its texture, keep the buildings
function downgrade(tile) {
  const strip = []; tile.obj.traverse((o) => { if (o.isMesh && o.name.startsWith('terrain')) strip.push(o); });
  for (const o of strip) { o.parent.remove(o); o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); }
  tile.mode = 'mid'; showFar(tile); invalidate(true);
}
// façade relief (cornices, string courses, cunhais) and balconies: separate files per tile, only within ~900 m of the camera
function dropDetail(t) { if (t.detail) { scene.remove(t.detail); t.detail.traverse((m) => m.isMesh && m.geometry.dispose()); } t.detail = null; t.dstate = 0; }
let DR = 900;   // façade relief and balconies: set per frame from the camera height (see stream)
function detail(t, d) {
  if (t.state !== 2 || !(t.t.detail || t.t.balconies)) return;
  if (!ready || inflight > 1) { if (d > DR + 400 && t.dstate) dropDetail(t); return; }   // near-only detail waits until the city is on screen and its tiles are in
  if (d > DR + 400) { if (t.dstate) dropDetail(t); return; }
  if (d > DR || t.dstate) return;
  t.dstate = 1; const gen = t.gen;
  Promise.all([t.t.detail ? loader.loadAsync(url(t.a, t.t.detail)) : null,
    t.t.balconies && !t.bal ? fetch(url(t.a, t.t.balconies)).then(ok).then((r) => r.arrayBuffer()) : null]).then(([g, bal]) => {
    if (t.dstate !== 1 || t.gen !== gen || t.state !== 2) { g?.scene.traverse((m) => m.isMesh && m.geometry.dispose()); return; }
    if (g) { g.scene.traverse((m) => { if (m.isMesh) { m.material = matDetail; m.receiveShadow = true; } }); t.detail = g.scene; scene.add(g.scene); }
    if (bal && !t.bal) { t.bal = balconies(bal); scene.add(t.bal); balconyChunks.push(t.bal); }
    t.dstate = 2;
  }).catch(() => { t.dstate = 0; });
}
// keep the tiles near the view loaded, nearest first; let go of those well outside it
// tiles with their own 0.5 m ground (4 MB of video memory each). Phones keep fewer: past ~1 km a phone pixel covers 2 m or more of
// ground, which the far ground already holds
const nearR = (dist) => isMobile ? THREE.MathUtils.clamp(dist * 0.25 + 500, 700, 1000) : THREE.MathUtils.clamp(dist * 0.4 + 600, 900, 1450);
// beyond that, out to ~3× as far, tiles keep their full buildings (window grids, roofs, colours) over the far ground; only past
// this do the plain far blocks stand in. Phones get 60 % of it.
const midR = (dist) => THREE.MathUtils.clamp(dist * 1.3 + 700, 1450, 5600) * (isMobile ? 0.6 : 1);
const _fwd = new THREE.Vector3();
window.__stream = () => stream(true);   // for checks: stream without waiting for frames
window.__tileStats = () => tiles.reduce((o, t) => { const k = t.state === 2 ? t.mode : t.state ? 'loading' : 'idle'; o[k] = (o[k] || 0) + 1; return o; }, {});
const rectDist = (b, x, y) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
const LOD_PIN = +new URLSearchParams(location.search).get('lod') || 0;   // ?lod=1 pins it, for checks on slow test machines
let inflight = 0, lodK = LOD_PIN || 1;   // lodK scales detail distances; drops on devices that stay slow at dpr 1
function stream(force) {
  // following something: stream around where it will be in a few seconds, at a range that counts its height above the ground
  const f = chase.focus();
  const x = f ? f.x : controls.target.x, y = f ? f.y : -controls.target.z, dist = f ? f.d : camera.position.distanceTo(controls.target);
  const R = nearR(dist) * (0.75 + 0.25 * lodK), M = midR(dist) * (0.5 + 0.5 * lodK);
  DR = THREE.MathUtils.clamp(700 + camera.position.y * 0.9, 900, 2700) * lodK;   // relief and balconies reach further as the view rises
  camera.getWorldDirection(_fwd); const fl = Math.hypot(_fwd.x, _fwd.z) || 1, fx = _fwd.x / fl, fy = -_fwd.z / fl, cx = camera.position.x, cy = -camera.position.z;
  const want = [];
  for (const t of tiles) {
    const d = rectDist(t.b, x, y);
    detail(t, rectDist(t.b, camera.position.x, -camera.position.z));
    if (t.state === 2 && d > M + 900) { dispose(t); continue; }
    if (t.state === 1 && d > M + 900) { t.state = 0; t.gen = (t.gen || 0) + 1; t.loading = null; continue; }
    if (t.state === 2 && t.mode === 'full' && !t.loading && d > R + 900) downgrade(t);
    if ((t.failed || 0) >= 3 || t.loading) continue;
    if (d <= R && (t.state === 0 || (t.state === 2 && t.mode === 'mid'))) want.push([d, t, 'full']);
    else if (d <= M && t.state === 0 && ((t.b[0] + t.b[2]) / 2 - cx) * fx + ((t.b[1] + t.b[3]) / 2 - cy) * fy > -400) want.push([d + 400, t, 'mid']);   // mid tiles only ahead of the camera
  }
  want.sort((p, q) => p[0] - q[0]);
  for (const [, t, mode] of want) {
    if (inflight >= (force ? 8 : 4)) break;
    inflight++; load(t, mode).finally(() => { inflight--; tick(); });
  }
  return want.length;
}
// tiles near the view that are not on screen yet (the loading screen waits for these)
const pending = () => { const x = controls.target.x, y = -controls.target.z, R = Math.min(nearR(camera.position.distanceTo(controls.target)), 2000);
  return tiles.filter((t) => !(t.state === 2 && t.mode === 'full') && (t.failed || 0) < 3 && rectDist(t.b, x, y) <= R).length; };

// trees: instanced, in chunks with three levels of detail (sculpted near 230 m, lobed to 760 m, a single lobe beyond)
const treeChunks = [], treeHi = [];
let KINDS = null;
function addTrees(buf) {
  const d = new Float32Array(buf), n = d.length / 4;
  if (!KINDS) KINDS = treeKinds();
  // chunked (per kind) so each patch of the city swaps detail by camera distance and frustum-culls on its own
  const cellsOf = (CH) => { const cells = new Map(); for (let i = 0; i < n; i++) { const kind = Math.min(3, Math.floor(d[i * 4 + 3] / 10)), k = kind + ':' + Math.floor(d[i * 4] / CH) + ',' + Math.floor(d[i * 4 + 2] / CH); if (!cells.has(k)) cells.set(k, { kind, ids: [] }); cells.get(k).ids.push(i); } return cells.values(); };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  const place = (meshes, K, ids) => ids.forEach((i, j) => {
    const r = Math.sin(i * 12.9898) * 43758.5453 % 1;
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r * 6.28);
    const k = d[i * 4 + 3] - Math.min(3, Math.floor(d[i * 4 + 3] / 10)) * 10;
    s.set(k, k * (0.9 + Math.abs(r) * 0.3), k);
    m.compose(p.set(d[i * 4], d[i * 4 + 1] - 0.2, d[i * 4 + 2]), q, s);
    for (const mesh of meshes) { mesh.setMatrixAt(j, m); mesh.setColorAt(j, col.setHex(K.greens[Math.floor(Math.abs(r) * K.greens.length) % K.greens.length])); }
  });
  const fin = (mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); scene.add(mesh); return mesh; };
  for (const { kind, ids } of cellsOf(600)) {
    const K = KINDS[kind], near = new THREE.InstancedMesh(K.near, K.mat, ids.length), lo = new THREE.InstancedMesh(K.far, K.mat, ids.length);
    place([near, lo], K, ids); fin(near); fin(lo);
    treeChunks.push({ near, lo, c: near.boundingSphere.center.clone(), r: near.boundingSphere.radius });
  }
  for (const { kind, ids } of cellsOf(160)) {
    const K = KINDS[kind], hi = new THREE.InstancedMesh(K.hi, K.matHi, ids.length);
    place([hi], K, ids); fin(hi).visible = false; hi.castShadow = false;
    treeHi.push({ hi, c: hi.boundingSphere.center.clone(), r: hi.boundingSphere.radius });
  }
}
function treeKinds() {
  const paint = (g, hex) => { const c = new THREE.Color(hex); g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, () => [c.r, c.g, c.b]).flat(), 3)); return g; };
  // foliage normals bend outwards from the crown centre, so a clump of lobes shades like one soft canopy
  const soften = (g, cx, cy, cz, k = 0.6) => {
    const P = g.attributes.position, N = g.attributes.normal, v = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) { v.set(P.getX(i) - cx, (P.getY(i) - cy) * 1.4, P.getZ(i) - cz).normalize(); n.fromBufferAttribute(N, i).lerp(v, k).normalize(); N.setXYZ(i, n.x, n.y, n.z); }
    return g;
  };
  // lumpy lobe: icosphere with each vertex pushed in or out (deterministic), so no two clumps share a silhouette
  const lumpy = (r, det, x, y, z, shade, seed, sy = 1) => {
    const g = new THREE.IcosahedronGeometry(r, det), P = g.attributes.position;
    for (let i = 0; i < P.count; i++) { const h = Math.sin(P.getX(i) * 7.1 + P.getY(i) * 3.7 + P.getZ(i) * 5.3 + seed * 11.3) * 43758.5453 % 1; const f = 1 + 0.17 * h; P.setXYZ(i, P.getX(i) * f, P.getY(i) * f * sy, P.getZ(i) * f); }
    g.rotateY(seed).translate(x, y, z); const ng = g.toNonIndexed(); ng.computeVertexNormals(); return paint(ng, shade);
  };
  const lobe = (r, x, y, z, shade, ry) => paint(new THREE.IcosahedronGeometry(r, 0).rotateY(ry).rotateX(ry * 0.7).translate(x, y, z).toNonIndexed(), shade);
  const limbG = (x0, y0, z0, x1, y1, z1, r0, r1, sides) => { const a = new THREE.Vector3(x0, y0, z0), b = new THREE.Vector3(x1, y1, z1), L = a.distanceTo(b); const g = new THREE.CylinderGeometry(r1, r0, L, sides, 1, true); g.translate(0, L / 2, 0); g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())); g.translate(x0, y0, z0); return paint(g.toNonIndexed(), 0x5e4636); };
  const trunk = new THREE.CylinderGeometry(0.2, 0.34, 4.2, 5, 1, true).translate(0, 2.1, 0).toNonIndexed();
  // near (≈760 m): five lobes, ~110 triangles
  const geo = mergeGeometries([lobe(2.45, 0, 5.4, 0, 0xe6e6e6, 0), lobe(1.8, 1.35, 6.3, 0.55, 0xffffff, 0.7), lobe(1.7, -1.15, 6.1, -0.75, 0xf2f2f2, 1.3), lobe(1.6, -0.3, 5.9, 1.3, 0xeeeeee, 2.1), lobe(1.4, 0.2, 7.3, -0.2, 0xffffff, 2.9), paint(trunk, 0x5e4636)]);
  geo.computeVertexNormals(); soften(geo, 0, 6, 0, 0.45);
  // hi (≈230 m): a forked trunk and nine lumpy clumps, darker underneath, ~900 triangles
  const hi = mergeGeometries([
    limbG(0, 0, 0, 0.1, 3.4, 0, 0.36, 0.26, 7), limbG(0.1, 3.3, 0, 1.3, 5.6, 0.5, 0.2, 0.1, 5), limbG(0.1, 3.3, 0, -1.1, 5.4, -0.7, 0.19, 0.1, 5), limbG(0.1, 3.4, 0, -0.2, 6.6, 0.9, 0.18, 0.08, 5),
    lumpy(1.75, 1, 0, 5.2, 0, 0xc4c4c4, 0.3), lumpy(1.55, 1, 1.5, 5.9, 0.6, 0xe8e8e8, 1.1), lumpy(1.5, 1, -1.35, 5.7, -0.8, 0xdedede, 2.2), lumpy(1.45, 1, -0.4, 5.6, 1.5, 0xe2e2e2, 3.1),
    lumpy(1.35, 1, 0.8, 5.3, -1.4, 0xd6d6d6, 4.4), lumpy(1.4, 1, 0.3, 7.0, -0.2, 0xffffff, 5.2), lumpy(1.15, 1, -1.0, 6.8, 0.7, 0xf6f6f6, 6.0), lumpy(1.1, 1, 1.2, 6.9, 1.0, 0xfafafa, 6.9), lumpy(0.95, 1, -0.2, 8.0, 0.3, 0xffffff, 7.7),
  ]);
  soften(hi, 0, 6.2, 0, 0.55);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), matHi = mat.clone();
  leafy(mat, -1); leafy(matHi, 1);
  // far LOD: one squat lobe on a stub trunk, ~26 triangles
  const far = mergeGeometries([lobe(2.7, 0, 5.9, 0, 0xf0f0f0, 0.4).scale(1, 0.85, 1), paint(new THREE.CylinderGeometry(0.25, 0.32, 4.2, 3, 1, true).translate(0, 2.1, 0).toNonIndexed(), 0x5e4636)]);
  far.computeVertexNormals(); soften(far, 0, 5.9, 0, 0.5);
  // palms: slim ringed trunk under two layers of drooping fronds (open cones, seen from both sides)
  const palmTrunk = (sides, segs) => paint(new THREE.CylinderGeometry(0.17, 0.27, 7.4, sides, segs, true).translate(0, 3.7, 0).toNonIndexed(), 0x8a7558);
  // a star of arched, tapering blades: rises from the crown, then droops to the tip (hi: split along the rib, with a folded midrib)
  const blades = (count, len, y0, rot, fine = false) => {
    const pos = [];
    for (let f = 0; f < count; f++) {
      const a = rot + (f / count) * Math.PI * 2 + (f % 2) * 0.12, c = Math.cos(a), sn = Math.sin(a), w = 0.32 + (f % 3) * 0.06;
      const droop = 1.1 + (f % 2) * 0.5;
      const pt = (t, off) => { const y = y0 + Math.sin(t * Math.PI * 0.8) * 0.7 - t * t * droop * 1.3; const ww = w * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * (1 - t * 0.85) * 1.4; return [c * len * t - sn * ww * off, y - Math.abs(off) * ww * 0.35, sn * len * t + c * ww * off]; };
      const steps = fine ? 5 : 2;
      for (let k = 0; k < steps; k++) { const t0 = k / steps, t1 = (k + 1) / steps; const A0 = pt(t0, 0), A1 = pt(t1, 0), L0 = pt(t0, -1), L1 = pt(t1, -1), R0 = pt(t0, 1), R1 = pt(t1, 1); pos.push(...A0, ...L0, ...L1, ...A0, ...L1, ...A1, ...A0, ...A1, ...R1, ...A0, ...R1, ...R0); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); return g;
  };
  const bare = (g) => { g.deleteAttribute('normal'); g.deleteAttribute('uv'); return g; };   // blades carry position + colour only
  const palm = mergeGeometries([palmTrunk(6, 2), paint(blades(11, 3.2, 7.4, 0), 0xffffff), paint(blades(7, 2.3, 7.7, 0.4), 0xe6e6e6), paint(new THREE.IcosahedronGeometry(0.5, 0).translate(0, 7.45, 0).toNonIndexed(), 0x9a8a70)].map(bare));
  palm.computeVertexNormals();
  const palmHi = mergeGeometries([palmTrunk(8, 8), paint(blades(16, 3.4, 7.4, 0, true), 0xffffff), paint(blades(10, 2.5, 7.75, 0.3, true), 0xe0e0e0), paint(new THREE.IcosahedronGeometry(0.55, 1).translate(0, 7.45, 0).toNonIndexed(), 0x9a8a70)].map(bare));
  palmHi.computeVertexNormals();
  const palmFar = mergeGeometries([palmTrunk(3, 1), paint(blades(6, 3.0, 7.4, 0), 0xffffff)].map(bare)); palmFar.computeVertexNormals();
  const palmMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true, side: THREE.DoubleSide }), palmHiMat = palmMat.clone();
  leafy(palmMat, -1, false); leafy(palmHiMat, 1, false);
  // stone pines (pinheiro-manso): tall bare trunk, flat umbrella crown
  const flat = (r, x, y, z, shade, ry, sy) => paint(new THREE.IcosahedronGeometry(r, 0).rotateY(ry).rotateX(ry * 0.6).scale(1, sy, 1).translate(x, y, z).toNonIndexed(), shade);
  const pineTrunk = (sides) => paint(new THREE.CylinderGeometry(0.22, 0.38, 6.8, sides, 1, true).translate(0, 3.4, 0).toNonIndexed(), 0x6a5240);
  const pine = mergeGeometries([pineTrunk(5), flat(3.4, 0, 7.6, 0, 0xe4e4e4, 0.3, 0.42), flat(2.4, 1.2, 8.2, 0.6, 0xffffff, 1.1, 0.4), flat(2.2, -1.3, 8.0, -0.5, 0xf2f2f2, 2.0, 0.42)]);
  pine.computeVertexNormals(); soften(pine, 0, 7.8, 0, 0.4);
  const pineHi = mergeGeometries([limbG(0, 0, 0, 0.3, 6.0, 0.1, 0.4, 0.26, 7), limbG(0.3, 5.8, 0.1, 1.8, 7.6, 0.6, 0.17, 0.09, 5), limbG(0.3, 5.8, 0.1, -1.6, 7.5, -0.6, 0.17, 0.09, 5), limbG(0.3, 5.9, 0.1, 0.0, 7.7, -1.7, 0.15, 0.08, 5),
    lumpy(2.2, 1, 0, 7.8, 0, 0xd0d0d0, 0.5, 0.45), lumpy(1.9, 1, 1.9, 8.1, 0.6, 0xf0f0f0, 1.5, 0.42), lumpy(1.8, 1, -1.8, 8.0, -0.6, 0xe6e6e6, 2.5, 0.42), lumpy(1.7, 1, 0.2, 8.1, -1.9, 0xeaeaea, 3.5, 0.42), lumpy(1.6, 1, -0.4, 8.4, 1.8, 0xffffff, 4.5, 0.4), lumpy(1.3, 1, 0.5, 8.7, 0.3, 0xffffff, 5.5, 0.4)]);
  soften(pineHi, 0, 8, 0, 0.5);
  const pineFar = mergeGeometries([pineTrunk(3), flat(3.6, 0, 7.8, 0, 0xf0f0f0, 0.3, 0.45)]); pineFar.computeVertexNormals(); soften(pineFar, 0, 7.8, 0, 0.4);
  // Mediterranean cypresses (Prazeres, Alto de São João, the Estrela gardens): a tall dark spindle on a stub of trunk
  const spindle = (r, y, sy, shade, ry) => paint(new THREE.IcosahedronGeometry(r, 0).rotateY(ry).scale(1, sy, 1).translate(0, y, 0).toNonIndexed(), shade);
  const cyTrunk = (sides) => paint(new THREE.CylinderGeometry(0.14, 0.22, 1.8, sides, 1, true).translate(0, 0.9, 0).toNonIndexed(), 0x5a4434);
  const cypress = mergeGeometries([cyTrunk(4), spindle(1.25, 5.2, 3.4, 0xe0e0e0, 0), spindle(0.9, 9.2, 3.2, 0xffffff, 1.2)]);
  cypress.computeVertexNormals(); soften(cypress, 0, 7, 0, 0.35);
  const cypressHi = mergeGeometries([cyTrunk(6), lumpy(1.2, 1, 0, 4.6, 0, 0xcfcfcf, 0.4, 2.6), lumpy(1.05, 1, 0.08, 7.4, 0.05, 0xebebeb, 1.4, 2.6), lumpy(0.75, 1, 0, 10.3, 0, 0xffffff, 2.4, 2.8), lumpy(0.4, 1, 0, 12.4, 0, 0xffffff, 3.3, 2.5)]);
  soften(cypressHi, 0, 7, 0, 0.4);
  const cypressFar = mergeGeometries([cyTrunk(3), spindle(1.2, 6.5, 5, 0xf0f0f0, 0.3)]); cypressFar.computeVertexNormals(); soften(cypressFar, 0, 6.5, 0, 0.35);
  return [
    { hi, near: geo, far, mat, matHi, greens: [0x5f8744, 0x6c9450, 0x527a3d, 0x779e58, 0x5c8750] },
    { hi: palmHi, near: palm, far: palmFar, mat: palmMat, matHi: palmHiMat, greens: [0x4f7134, 0x5b7c3b, 0x48682f] },
    { hi: pineHi, near: pine, far: pineFar, mat, matHi, greens: [0x4f6f3c, 0x5a7a44, 0x466536] },
    { hi: cypressHi, near: cypress, far: cypressFar, mat, matHi, greens: [0x3d5a30, 0x456337, 0x37512b] },
  ];
}
// foliage shading: leaf clumps (3D value noise in world space, faded out with distance so it never shimmers).
// Each tree is drawn by exactly one of the sculpted (sel +1) or lobed (sel -1) meshes, decided per instance by its distance.
const treeU = { uCamP: { value: new THREE.Vector3() }, uHiR: { value: 230 } };
function leafy(mat, sel, noise = true) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uCamP = treeU.uCamP; s.uniforms.uHiR = treeU.uHiR;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLeafW;\nuniform vec3 uCamP;\nuniform float uHiR;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{ vec3 io = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz; if (${sel.toFixed(1)} * (uHiR - distance(io, uCamP)) < 0.0) transformed = vec3(0.0); }`)
      .replace('#include <color_vertex>', '#include <color_vertex>\nif (color.r > color.g + 0.04) vColor = color.rgb * vec3(0.95, 0.92, 0.9);   // bark keeps its own colour, only foliage takes the instance green')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvLeafW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
    if (noise) s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vLeafW;
float lh(vec3 p) { p = fract(p * 0.3183 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float ln3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(lh(i), lh(i + vec3(1,0,0)), f.x), mix(lh(i + vec3(0,1,0)), lh(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(lh(i + vec3(0,0,1)), lh(i + vec3(1,0,1)), f.x), mix(lh(i + vec3(0,1,1)), lh(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{ float fw = length(fwidth(vLeafW)); float k = 1.0 - smoothstep(0.25, 1.1, fw);
  float c = ln3(vLeafW * 1.6) * 0.65 + ln3(vLeafW * 3.7) * 0.35;
  diffuseColor.rgb *= mix(1.0, 0.5 + 0.85 * c, k * 0.9); }`);
  };
  mat.customProgramCacheKey = () => `leafy-v2-${sel}-${noise}`;
}

// cars: instanced and chunked; a modelled car (bevelled body, glasshouse, wheels, lights) within ~180 m, boxes beyond
const carChunks = [];
const carU = { uCamP: treeU.uCamP, uHiR: { value: 180 } };
let CAR = null;
function addCars(buf) {
  const d = new Float32Array(buf), n = d.length / 6;
  if (!CAR) CAR = carGeometries(carU);
  const pick = carPaint;
  const CH = 400, cells = new Map();
  for (let i = 0; i < n; i++) { const k = Math.floor(d[i * 6] / CH) + ',' + Math.floor(d[i * 6 + 2] / CH); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); }
  const m = new THREE.Matrix4(), e = new THREE.Euler(0, 0, 0, 'YZX'), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), col = new THREE.Color();
  for (const ids of cells.values()) {
    const mesh = new THREE.InstancedMesh(CAR.lo, CAR.mLo, ids.length), hi = new THREE.InstancedMesh(CAR.hi, CAR.mHi, ids.length);
    ids.forEach((i, j) => {
      const o = i * 6; e.set(0, d[o + 3], d[o + 4]); q.setFromEuler(e);
      m.compose(p.set(d[o], d[o + 1], d[o + 2]), q, one); mesh.setMatrixAt(j, m); hi.setMatrixAt(j, m);
      col.setHex(pick((d[o + 5] * 7.31) % 1)); mesh.setColorAt(j, col); hi.setColorAt(j, col);
      drive?.addParked(d[o], d[o + 1], d[o + 2], d[o + 3]);
    });
    for (const x of [mesh, hi]) { x.castShadow = x === mesh; x.receiveShadow = true; x.computeBoundingSphere(); x.visible = false; scene.add(x); }
    carChunks.push({ mesh, hi, c: mesh.boundingSphere.center.clone(), r: mesh.boundingSphere.radius });
  }
}

// street lamps: one additive point sprite each, warm core and soft halo; only drawn after dusk
const lampUniforms = { uNight: cityUniforms.uNight, uScale: { value: 1 } };
const lampPoints = [];
function addLamps(buf) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(buf), 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: lampUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `uniform float uScale; varying float vCore;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mv;
        float px = 9. * uScale / -mv.z; gl_PointSize = clamp(px, 3., 64.);
        vCore = mix(.75, .22, smoothstep(3., 16., px)); }`,   // far away the sprite is mostly core, so it still reads as a light
    fragmentShader: `uniform float uNight; varying float vCore;
      void main() { float r = length(gl_PointCoord - .5) * 2.; if (r > 1.) discard;
        float core = smoothstep(vCore, 0., r), halo = pow(1. - r, 2.2) * .35;
        gl_FragColor = vec4(vec3(1., .74, .42) * (core * 1.3 + halo) * uNight, 1.); }`,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = 2;
  scene.add(pts); lampPoints.push(pts);
  // the posts themselves (Lisbon's dark-green cast-iron candelabra with a four-sided lantern), drawn near the camera
  if (!LAMP) LAMP = lampPost();
  const d = new Float32Array(buf), n = d.length / 3, CH = 300, cells = new Map(), m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) { const k = Math.floor(d[i * 3] / CH) + ',' + Math.floor(d[i * 3 + 2] / CH); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); }
  for (const ids of cells.values()) {
    const mesh = new THREE.InstancedMesh(LAMP.geo, LAMP.mat, ids.length);
    ids.forEach((i, j) => mesh.setMatrixAt(j, m.makeRotationY((i * 2.399) % 6.283).setPosition(d[i * 3], d[i * 3 + 1] - 4.6, d[i * 3 + 2])));
    mesh.castShadow = false; mesh.computeBoundingSphere(); mesh.visible = false; scene.add(mesh);
    lampPosts.push({ mesh, c: mesh.boundingSphere.center.clone(), r: mesh.boundingSphere.radius });
  }
}
const lampPosts = [];
let LAMP = null;
function lampPost() {
  const tint = (g, r, gg = r, b = r) => { g = g.index ? g.toNonIndexed() : g; g.deleteAttribute('uv'); g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, () => [r, gg, b]).flat(), 3)); return g; };
  const iron = [0.11, 0.15, 0.12], lat = (r0, r1, h, y, sides = 8) => tint(new THREE.CylinderGeometry(r1, r0, h, sides).translate(0, y + h / 2, 0), ...iron);
  const parts = [lat(0.2, 0.16, 0.5, 0), lat(0.16, 0.12, 0.25, 0.5), lat(0.1, 0.065, 3.2, 0.75), lat(0.09, 0.09, 0.12, 1.5), lat(0.08, 0.08, 0.1, 3.0), lat(0.065, 0.11, 0.25, 3.95),
    tint(new THREE.CylinderGeometry(0.2, 0.13, 0.55, 4, 1).rotateY(Math.PI / 4).translate(0, 4.5, 0), 0.95, 0.86, 0.6),            // lantern glass
    tint(new THREE.CylinderGeometry(0.02, 0.27, 0.22, 4, 1).rotateY(Math.PI / 4).translate(0, 4.89, 0), ...iron),                     // cap
    tint(new THREE.CylinderGeometry(0.14, 0.14, 0.06, 4, 1).rotateY(Math.PI / 4).translate(0, 4.2, 0), ...iron),
    tint(new THREE.SphereGeometry(0.05, 6, 4).translate(0, 5.03, 0), ...iron)];
  for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + Math.PI / 4; parts.push(tint(new THREE.CylinderGeometry(0.012, 0.012, 0.56, 3).translate(Math.cos(a) * 0.17, 4.5, Math.sin(a) * 0.17), ...iron)); }
  const geo = mergeGeometries(parts); geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.3 });
  mat.onBeforeCompile = (s) => {   // the lantern glows after dusk
    s.uniforms.uNight = cityUniforms.uNight;
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (vColor.r > 0.8) totalEmissiveRadiance += vec3(1., .72, .4) * 1.6 * uNight;');
  };
  mat.customProgramCacheKey = () => 'lamppost-v1';
  return { geo, mat };
}


// ─── sun / time of day ──────────────────────────────────────────────────
// haze: extinction at sea level per metre (height fog, thinning with a ~1 km scale height; colour from the sky, see sky.js)
const haze = new THREE.FogExp2(0xc8d2dc, 0.00009); scene.fog = haze;
const timeEl = document.getElementById('time'), clockEl = document.getElementById('clock');
const sunDir = new THREE.Vector3(), lightDir = new THREE.Vector3();
const MOON = new THREE.Vector3(-0.42, 0.62, 0.66).normalize();   // a high moon over the south-west at night
let skyT = 0, skyPend = null, sunLit = true;
function setTime(h, now = false) {
  sunDirection(h, manifest.origin.lat, manifest.origin.lon, sunDir);
  const elev = Math.asin(sunDir.y);
  const night = 1 - THREE.MathUtils.smoothstep(elev, -0.1, 0.02);   // civil dusk (−6°) is night for the city lights
  cityUniforms.uNight.value = 1 - THREE.MathUtils.smoothstep(elev, -0.07, 0.04);
  document.body.classList.toggle('night', cityUniforms.uNight.value > 0.5);
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  clockEl.textContent = `${hh}:${String(mm).padStart(2, '0')}`;
  // the sky (and with it the environment) is re-solved at most ~8 times a second while the slider is dragged
  const solve = () => {
    skyPend = null; skyT = performance.now();
    const st = sky.update(sunDir, { night });
    // the sun is the air's transmittance of sunlight; once it has set, a dim cool moon takes over the same light (and its shadows)
    const moon = THREE.MathUtils.smoothstep(elev, -0.06, -0.14) * 0.75;
    if (sunDir.y > -0.035) { lightDir.copy(sunDir); sun.color.copy(st.sunColor); sun.intensity = 1; }
    else { lightDir.copy(MOON); sun.color.setRGB(0.55, 0.68, 1.0); sun.intensity = moon; }
    sunLit = sun.intensity * Math.max(sun.color.r, sun.color.g, sun.color.b) > 1e-3;   // (never toggle .visible: a light count change recompiles every shader)
    // exposure: the eye adapts most (not all) of the way from noon to dusk; night stays night
    const E = Math.max(0, Math.max(sunDir.y, 0) * (st.sunColor.r + st.sunColor.g * 2 + st.sunColor.b) / 4 + 0.9 * THREE.MathUtils.smoothstep(sunDir.y, -0.16, 0.45) + 0.02);
    renderer.toneMappingExposure = EXPOSURE * THREE.MathUtils.clamp(Math.pow(3.6 / E, 0.5), 1, THREE.MathUtils.lerp(2.7, 1.8, night));
    scene.environmentIntensity = 1;
    haze.color.setRGB(0.6, 0.66, 0.75).multiplyScalar(0.02 + 0.9 * THREE.MathUtils.smoothstep(sunDir.y, -0.15, 0.3));
    invalidate(true);
  };
  if (now || performance.now() - skyT > 120) solve(); else if (!skyPend) skyPend = setTimeout(solve, 120);
}
const EXPOSURE = +Q.get('exp') || 1.0;

timeEl.addEventListener('input', () => setTime(+timeEl.value));
timeEl.addEventListener('change', () => setTime(+timeEl.value, true));
{ const t0 = +Q.get('t'); if (t0) timeEl.value = t0; }   // ?t=hour, for checks
// Shadow cascades follow the view, snapped to coarse steps so they neither shimmer nor re-render every frame.
// The near map is centred a little ahead of the view (half its radius at a grazing view, none looking straight down) and is
// re-drawn when its snapped frame, the light, or the scene's contents change. The far map covers ~5 km ahead and is re-drawn
// only when its frame moves a quarter of its width, when the light moves, or (at most every 2 s) when tiles come in.
const lightRight = new THREE.Vector3(), lightUp = new THREE.Vector3(), _sf = new THREE.Vector3(), _fw = new THREE.Vector3(), _lc = new THREE.Vector3();
let shadowKey = '', farKey = '', shadowDirty = true, farDirty = true, farT = 0;
function frame(light, R, t, step, depth) {
  const ka = Math.round(t.dot(lightRight) / step), kb = Math.round(t.dot(lightUp) / step);
  return { ka, kb, apply() {
    const c = _lc.copy(lightRight).multiplyScalar(ka * step).addScaledVector(lightUp, kb * step).addScaledVector(lightDir, t.dot(lightDir));
    light.target.position.copy(c); light.target.updateMatrixWorld();
    light.position.copy(c).addScaledVector(lightDir, depth);
    const sc = light.shadow.camera;
    if (sc.right !== R || sc.far !== depth * 2) { sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 1; sc.far = depth * 2; sc.updateProjectionMatrix(); }
    light.shadow.needsUpdate = true; renderer.shadowMap.needsUpdate = true;
  } };
}
function fitShadow(now) {
  if (!sunLit) return;
  const f = chase.focus(), dist = f ? f.d : camera.position.distanceTo(controls.target), lim = size * 0.6;
  lightRight.crossVectors(lightDir, THREE.Object3D.DEFAULT_UP).normalize();
  lightUp.crossVectors(lightRight, lightDir).normalize();
  camera.getWorldDirection(_fw); const grazing = 1 - Math.abs(_fw.y); _fw.y = 0; _fw.normalize();
  const dirKey = `${lightDir.x.toFixed(4)},${lightDir.y.toFixed(4)},${lightDir.z.toFixed(4)}`;
  // near
  const R0 = THREE.MathUtils.clamp(dist * 0.85, 140, lim);
  const R = Math.min(lim, 140 * 1.2 ** Math.ceil(Math.log(R0 / 140) / Math.log(1.2))) * 1.15;
  const t = (f ? _sf.set(f.x, f.gy, -f.y) : _sf.copy(controls.target)).addScaledVector(_fw, R * 0.5 * grazing);
  const nf = frame(sun, R, t, (2 * R) / 10, R + 2500);
  const key = `${R.toFixed(2)}|${nf.ka}|${nf.kb}|${dirKey}`;
  if (key !== shadowKey || shadowDirty) { shadowKey = key; shadowDirty = false; nf.apply(); return; }   // one cascade per frame at most
  // far: from just behind the camera out towards the horizon
  const RF = Math.min(lim, Math.max(isMobile ? 2600 : 3600, R * 2.5));
  const tf = _sf.copy(camera.position).setY(controls.target.y).addScaledVector(_fw, RF * 0.75 * grazing);
  const ff = frame(sunFar, RF, tf, RF / 2, RF + 2500);
  const fk = `${RF.toFixed(0)}|${ff.ka}|${ff.kb}|${dirKey}`;
  if (fk !== farKey || (farDirty && now - farT > 2000)) { farKey = fk; farDirty = false; farT = now; ff.apply(); }
}
let needRender = 3;
const invalidate = (shadow = false) => { needRender = Math.max(needRender, 2); if (shadow) shadowDirty = farDirty = true; };
setTime(+timeEl.value, true);
{ const add = scene.add.bind(scene), remove = scene.remove.bind(scene); scene.add = (...o) => { invalidate(true); return add(...o); }; scene.remove = (...o) => { invalidate(true); return remove(...o); }; }

// ─── camera: shareable view in the URL hash, else a postcard intro from the river ───
const ll = (lat, lon) => { // same local tangent plane as the pipeline
  const p = (manifest.origin.lat * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p), mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
  return new THREE.Vector3((lon - manifest.origin.lon) * mLon, 0, -(lat - manifest.origin.lat) * mLat);
};
const focus = ll(38.7112, -9.1362).setY(35);           // between Baixa and the castle
const fit = THREE.MathUtils.clamp(1.3 / camera.aspect, 1, 2.4); // portrait phones need to step back
const endPos = focus.clone().add(new THREE.Vector3(-360, 330, 900).multiplyScalar(fit));
const startPos = new THREE.Vector3(center.x, size * 1.5, center.z + 300);
let introT = 0;
const fromHash = location.hash.slice(1).split(',').map(Number);
// ?cam=lat,lon,range,heading,tilt[,lift] — same convention as Google Earth URLs, for side-by-side checks; lift raises the target (monuments)
const cam = (new URLSearchParams(location.search).get('cam') || '').split(',').map(Number);
const camOnGround = (cam.length === 5 || cam.length === 6) && cam.every(isFinite);
if (camOnGround) {
  const [lat, lon, d, h, t] = cam, hr = (h * Math.PI) / 180, tr = (t * Math.PI) / 180;
  const tgt = ll(lat, lon).setY(0);
  camera.fov = 35; camera.updateProjectionMatrix();
  controls.target.copy(tgt);
  camera.position.copy(tgt).add(new THREE.Vector3(-Math.sin(hr) * Math.sin(tr) * d, Math.cos(tr) * d, Math.cos(hr) * Math.sin(tr) * d));
  introT = 1;
} else if (fromHash.length === 6 && fromHash.every(isFinite)) {
  camera.position.fromArray(fromHash, 0); controls.target.fromArray(fromHash, 3); introT = 1;
} else {
  camera.position.copy(startPos); controls.target.copy(focus);
}
controls.addEventListener('end', () => {
  const v = [...camera.position.toArray(), ...controls.target.toArray()].map((n) => Math.round(n));
  history.replaceState(null, '', '#' + v.join(','));
});
// live layers (traffic, transport, planes): separate module, off until toggled
const live = initLive({ scene, camera, renderer, canvas, ll, bounds: { minX, minY, maxX, maxY }, chase, night: cityUniforms.uNight, mobile: isMobile, lod: () => lodK }); window.__live = live;
// drive mode: a car on the real streets (src/drive), filmed by the shared chase camera (or from the bonnet)
const drive = initDrive({ scene, camera, controls, canvas, chase, live, waterY: manifest.waterY, uNight: cityUniforms.uNight, home: ll(38.7086, -9.1366), ll }); window.__drive = drive;
window.__scene = scene; if (SHOW_STATS) window.__dbg = { renderer, scene, camera, controls, sun, sunFar, THREE }; window.__view = (arr) => { camera.position.fromArray(arr, 0); controls.target.fromArray(arr, 3); introT = 1; };

// ─── loop ───────────────────────────────────────────────────────────────
const statsEl = document.getElementById('stats');
if (SHOW_STATS) statsEl.hidden = false;
const _c = new THREE.Vector3();
let frames = 0, acc = 0, last = performance.now(), slow = 0, nf = 0, ready = false, idleN = 0, wasActive = false, stillN = 0, curRatio = pixelRatio;
renderer.setAnimationLoop((now) => {
  const raw = (now - last) / 1000, dt = Math.min(0.1, raw); last = now;
  if (introT < 1 && ready) {
    introT = Math.min(1, introT + dt / 2.8);
    const e = 1 - (1 - introT) ** 3;
    camera.position.lerpVectors(startPos, endPos, e);
  }
  const driving = drive.update(raw, now);   // before the chase camera, so it films where the car is now; real elapsed time (the car runs its own fixed steps)
  const touching = touch.update(dt);
  const moved = controls.update(dt) || touching || driving;
  if (chase.busy) { introT = 1; chase.update(dt); }   // after the controls: the chase keeps their orbit and carries it along
  if (driving) drive.afterCamera(dt);
  // render on demand: full rate while anything moves or loads; when the view is still, a quarter rate keeps the river alive
  const active = moved || introT < 1 || needRender > 0 || !ready || SHOW_STATS || !!live.busy;   // live layers that are on want every frame
  if (needRender > 0) needRender--;
  idleN = active ? 0 : idleN + 1;
  // motion resolution: while the view moves, draw at ~2/3 the pixel ratio (≈2.2× fewer pixels); full sharpness ~0.15 s after it settles
  const moving = moved || introT < 1, want = moving ? Math.max(1, pixelRatio * 0.67) : pixelRatio;
  if (moving) stillN = 0; else stillN++;
  let resized = false;   // a resized canvas is blank until drawn, so it is drawn this frame
  if (want !== curRatio && (moving || stillN > 8)) { curRatio = want; renderer.setPixelRatio(curRatio); renderer.setSize(innerWidth, innerHeight, false); resized = true; }
  // a still view renders at a quarter rate, or half (30 fps) while the ambient cars drive
  if (!active && !resized && curRatio === pixelRatio && idleN % (live.cars.count ? 2 : 4)) { if (++nf % 12 === 0) stream(false); last = now; return; }
  // keep the target over the diorama (a followed plane may fly beyond it)
  if (!chase.busy) controls.target.x = THREE.MathUtils.clamp(controls.target.x, minX, maxX);
  if (!chase.busy) controls.target.z = THREE.MathUtils.clamp(controls.target.z, -maxY, -minY);
  fitShadow(now); sky.tick(now / 1000);
  if (++nf % (chase.active ? 4 : 12) === 0 || !ready) stream(!ready);   // a followed plane crosses a tile in seconds
  for (const g of balconyChunks) g.visible = camera.position.distanceTo(g.userData.c) < DR;
  carU.uHiR.value = 180 * lodK;
  for (const c of carChunks) { const dd = camera.position.distanceTo(c.c) - c.r; c.mesh.visible = dd < 850 * lodK; c.hi.visible = dd < 180 * lodK; }
  treeU.uCamP.value.copy(camera.position); treeU.uHiR.value = 230 * lodK;
  for (const t of treeHi) t.hi.visible = camera.position.distanceTo(t.c) - t.r < 230 * lodK;
  for (const t of treeChunks) { const nearby = camera.position.distanceTo(t.c) - t.r < 760 * lodK; t.near.visible = nearby; t.lo.visible = !nearby; }
  waterUniformTime.value = now / 1000;
  for (const l of lampPoints) l.visible = cityUniforms.uNight.value > 0.01;
  for (const l of lampPosts) l.mesh.visible = camera.position.distanceTo(l.c) - l.r < 260 * lodK;
  { lampUniforms.uScale.value = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360)); }
  live.update(dt, now);
  renderer.render(scene, camera);

  // adaptive resolution: hold 60 fps on phones (timed on consecutive moving frames only)
  if (!active || !wasActive) { wasActive = active; return; }
  frames++; acc += raw;
  if (acc > 1) {
    const fps = frames / acc;
    if (ready && introT >= 1) {
      if (fps < 52 && pixelRatio > 1) { if (++slow >= 2) { pixelRatio = Math.max(1, pixelRatio - 0.25); curRatio = pixelRatio; renderer.setPixelRatio(pixelRatio); renderer.setSize(innerWidth, innerHeight, false); slow = 0; } }
      else if (fps < 45 && lodK > 0.55 && !LOD_PIN) { if (++slow >= 2) { lodK = Math.max(0.55, lodK - 0.15); slow = 0; } }   // still slow at dpr 1: pull the detail distances in
      else slow = 0;
    }
    if (SHOW_STATS) statsEl.textContent = `${fps.toFixed(0)} fps · dpr ${pixelRatio}\n${renderer.info.render.calls} draws · ${(renderer.info.render.triangles / 1e6).toFixed(2)}M tris`;
    window.__perf = { fps, dpr: pixelRatio, lod: lodK, calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    frames = 0; acc = 0;
  }
});
addEventListener('resize', () => {
  invalidate();
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});
camera.aspect = innerWidth / innerHeight;
camera.updateProjectionMatrix();

try {
  total = Math.max(1, pending()) + 1;
  startFar(); await farReady; tick();
  await new Promise((res) => { const w = () => (pending() === 0 ? res() : setTimeout(w, 100)); w(); });
  ready = true;
  if (camOnGround) {   // ?cam ranges are measured from the ground, as in Google Earth: lift the view onto the terrain
    const terrain = []; scene.traverse((o) => { if (o.isMesh && o.name.startsWith('terrain')) terrain.push(o); });
    const hit = new THREE.Raycaster(controls.target.clone().setY(2000), new THREE.Vector3(0, -1, 0)).intersectObjects(terrain)[0];
    if (hit) { const dy = hit.point.y + (cam[5] || 0) - controls.target.y; controls.target.y += dy; camera.position.y += dy; }
  }
  document.getElementById('loading').classList.add('done');
} catch (err) {
  console.error(err);
  document.querySelector('#loading span').textContent = 'Lisboa não carregou. Recarregue a página.';
}
document.getElementById('subtitle').textContent = `Lisboa · ${AREAS.reduce((n, a) => n + a.stats.buildings, 0).toLocaleString('pt-PT')} edifícios`;
window.__ready = true;
