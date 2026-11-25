import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildingMaterial, waterMaterial, terrainMaterial, waterUniformTime, cityUniforms, balconyGeometry, railingMaterial } from './materials.js';
import { sunDirection } from './sun.js';
import { initLive } from './live/index.js';

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

// Soft sky environment for reflections & ambient (generated once, no HDR download).
{
  const pm = new THREE.PMREMGenerator(renderer);
  const skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 v; void main(){ v = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec3 v; void main(){ float h = normalize(v).y;
      vec3 sky = mix(vec3(.96,.90,.80), vec3(.50,.70,.90), smoothstep(0.,.6,h));
      vec3 c = h > 0. ? sky : mix(vec3(.78,.70,.60), vec3(.45,.40,.35), smoothstep(0.,-.4,h));
      gl_FragColor = vec4(c,1.); }`,
  })));
  scene.environment = pm.fromScene(skyScene, 0.04).texture;
  scene.environmentIntensity = 0.55;
}

const hemi = new THREE.HemisphereLight(0xdfeaff, 0xb59a7c, 0.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dc, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(+new URLSearchParams(location.search).get('shadow') || (isMobile ? 2048 : 4096));
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 1.2;
sun.shadow.radius = 2;
scene.add(sun, sun.target);

const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.minDistance = 60;
controls.maxDistance = 7000;
controls.maxPolarAngle = 1.32;
controls.zoomToCursor = true;


// ─── load: the city is several areas of 500 m tiles; tiles stream in and out around the view ───
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const texLoader = new THREE.TextureLoader();
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
function balconies(buf) {
  const d = new Float32Array(buf), n = d.length / 5, B = balconyParts();
  const a = new THREE.InstancedMesh(B.slab, B.slabMat, n), b = new THREE.InstancedMesh(B.rail, B.railMat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Vector3();
  for (let j = 0, i = 0; j < n; j++, i += 5) {
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, d[i + 3]);
    m.compose(p.set(d[i], d[i + 1], d[i + 2]), q, sc.set(d[i + 4], 1, 1));
    a.setMatrixAt(j, m); b.setMatrixAt(j, m); c.add(p);
  }
  a.computeBoundingSphere(); b.computeBoundingSphere();
  a.castShadow = true; a.receiveShadow = true;
  const g = new THREE.Group(); g.add(a, b); g.userData.c = c.divideScalar(Math.max(1, n));
  return g;
}

// every area starts with its water, its skirt and its far level of detail (a coarse terrain and plain blocks per tile)
const farBuildingMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
const tileAt = new Map();
function base(a) {
  if (a.base) return a.base;
  return (a.base = (async () => {
    a.mask = await texLoader.loadAsync(url(a, 'water.png'));
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
      for (const o of [...g.scene.children]) {
        const m = /^f([tb])_(\d+)_(\d+)$/.exec(o.name), t = m && tileAt.get(`${a.area}:${m[2]}_${m[3]}`);
        if (!t || !o.isMesh) continue;
        if (m[1] === 't') { const map = o.material.map; map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; map.anisotropy = 4; o.material = terrainMaterial(map, a.mask, a.bounds); }
        else { o.material = farBuildingMat; }
        o.receiveShadow = true; o.visible = t.state !== 2;
        t.far.push(o); scene.add(o);
      }
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

const tiles = AREAS.flatMap((a) => a.tiles.map((t) => ({ a, t, b: t.bounds, state: 0, obj: null, bal: null, far: [] })));   // state 0 idle, 1 loading, 2 shown
for (const t of tiles) tileAt.set(`${t.a.area}:${t.t.i}_${t.t.j}`, t);
const areaDist = (a) => rectDist([a.bounds.minX, a.bounds.minY, a.bounds.maxX, a.bounds.maxY], controls.target.x, -controls.target.z);
let farReady = null;   // started once the camera is placed: nearest area first, the loading screen waits only for the one under the view
const startFar = () => { const order = [...AREAS].sort((p, q) => areaDist(p) - areaDist(q)); farReady = base(order[0]).catch((e) => console.error(e)); (async () => { for (const a of order.slice(1)) await base(a).catch((e) => console.error(e)); })(); };
const showFar = (t, v) => { for (const o of t.far) o.visible = v; };
function adopt(tile, gltf) {
  const { a } = tile;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name.startsWith('buildings')) {
      const g = o.geometry;
      if (!g.attributes._info || !g.attributes._style) throw new Error(`stale tile ${o.name}`);
      g.setAttribute('surf', g.attributes.uv); g.deleteAttribute('uv');
      g.setAttribute('aInfo', g.attributes._info); g.deleteAttribute('_info');
      g.setAttribute('aStyle', g.attributes._style); g.deleteAttribute('_style');
      o.material = matBuildings;
      o.castShadow = o.receiveShadow = true;
    } else if (o.name.startsWith('terrain')) {
      const map = o.material.map;
      map.anisotropy = Math.min(8, maxAniso); map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; map.needsUpdate = true;   // glTF defaults to REPEAT: tile edges bled the opposite edge in
      o.material = terrainMaterial(map, a.mask, a.bounds);
      o.receiveShadow = true;
    }
  });
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
  tile.obj = tile.bal = null; tile.state = 0; showFar(tile, true);
}
async function load(tile) {
  tile.state = 1; const gen = (tile.gen = (tile.gen || 0) + 1);
  try {
    await wake(tile.a);
    const [gltf, bal] = await Promise.all([loader.loadAsync(url(tile.a, tile.t.file)), tile.t.balconies ? fetch(url(tile.a, tile.t.balconies)).then(ok).then((r) => r.arrayBuffer()) : null]);
    if (tile.state !== 1 || tile.gen !== gen) { tile.obj = gltf.scene; tile.bal = null; const st = tile.state; dispose(tile); tile.state = st; return; }   // dropped while in flight
    tile.obj = adopt(tile, gltf); scene.add(tile.obj);
    if (bal) { tile.bal = balconies(bal); scene.add(tile.bal); balconyChunks.push(tile.bal); }
    tile.state = 2; showFar(tile, false);
  } catch (e) { console.error(e); if (tile.gen === gen) tile.state = 0; tile.failed = (tile.failed || 0) + 1; }
}
// façade relief (cornices, string courses, cunhais): a separate file per tile, only within ~900 m of the camera
function dropDetail(t) { if (t.detail) { scene.remove(t.detail); t.detail.traverse((m) => m.isMesh && m.geometry.dispose()); } t.detail = null; t.dstate = 0; }
function detail(t, d) {
  const DR = 900 * lodK;
  if (t.state !== 2 || !t.t.detail) return;
  if (d > DR + 400) { if (t.dstate) dropDetail(t); return; }
  if (d > DR || t.dstate) return;
  t.dstate = 1; const gen = t.gen;
  loader.loadAsync(url(t.a, t.t.detail)).then((g) => {
    if (t.dstate !== 1 || t.gen !== gen || t.state !== 2) { g.scene.traverse((m) => m.isMesh && m.geometry.dispose()); return; }
    g.scene.traverse((m) => { if (m.isMesh) { m.material = matDetail; m.receiveShadow = true; } });
    t.detail = g.scene; t.dstate = 2; scene.add(g.scene);
  }).catch(() => { t.dstate = 0; });
}
// keep the tiles near the view loaded, nearest first; let go of those well outside it
const nearR = (dist) => THREE.MathUtils.clamp(dist * 0.4 + 600, 900, 1450);   // beyond this the far level of detail stands in
const rectDist = (b, x, y) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
let inflight = 0, lodK = 1;   // lodK scales detail distances; drops on devices that stay slow at dpr 1
function stream(force) {
  const x = controls.target.x, y = -controls.target.z, dist = camera.position.distanceTo(controls.target);
  const R = nearR(dist) * (0.75 + 0.25 * lodK);
  const want = [];
  for (const t of tiles) {
    const d = rectDist(t.b, x, y);
    detail(t, rectDist(t.b, camera.position.x, -camera.position.z));
    if (d > R + 900 && t.state === 2) dispose(t);
    else if (d > R + 900 && t.state === 1) t.state = 0;
    else if (d <= R && t.state === 0 && (t.failed || 0) < 3) want.push([d, t]);
  }
  want.sort((p, q) => p[0] - q[0]);
  for (const [, t] of want) {
    if (inflight >= (force ? 8 : 4)) break;
    inflight++; load(t).finally(() => { inflight--; tick(); });
  }
  return want.length;
}
// tiles near the view that are not on screen yet (the loading screen waits for these)
const pending = () => { const x = controls.target.x, y = -controls.target.z, R = Math.min(nearR(camera.position.distanceTo(controls.target)), 2000);
  return tiles.filter((t) => t.state !== 2 && (t.failed || 0) < 3 && rectDist(t.b, x, y) <= R).length; };

// trees: instanced, in chunks with three levels of detail (sculpted near 230 m, lobed to 760 m, a single lobe beyond)
const treeChunks = [], treeHi = [];
let KINDS = null;
function addTrees(buf) {
  const d = new Float32Array(buf), n = d.length / 4;
  if (!KINDS) KINDS = treeKinds();
  // chunked (per kind) so each patch of the city swaps detail by camera distance and frustum-culls on its own
  const cellsOf = (CH) => { const cells = new Map(); for (let i = 0; i < n; i++) { const kind = Math.min(2, Math.floor(d[i * 4 + 3] / 10)), k = kind + ':' + Math.floor(d[i * 4] / CH) + ',' + Math.floor(d[i * 4 + 2] / CH); if (!cells.has(k)) cells.set(k, { kind, ids: [] }); cells.get(k).ids.push(i); } return cells.values(); };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  const place = (meshes, K, ids) => ids.forEach((i, j) => {
    const r = Math.sin(i * 12.9898) * 43758.5453 % 1;
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r * 6.28);
    const k = d[i * 4 + 3] - Math.min(2, Math.floor(d[i * 4 + 3] / 10)) * 10;
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
  return [
    { hi, near: geo, far, mat, matHi, greens: [0x6f9a4f, 0x7ea85a, 0x5e8a45, 0x8bb064, 0x6a9a5c] },
    { hi: palmHi, near: palm, far: palmFar, mat: palmMat, matHi: palmHiMat, greens: [0x4f7134, 0x5b7c3b, 0x48682f] },
    { hi: pineHi, near: pine, far: pineFar, mat, matHi, greens: [0x4f6f3c, 0x5a7a44, 0x466536] },
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
function carMaterial(sel) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.15 });
  mat.onBeforeCompile = (s) => {
    s.uniforms.uCamP = carU.uCamP; s.uniforms.uHiR = carU.uHiR;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 uCamP;\nuniform float uHiR;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{ vec3 io = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz; if (${sel.toFixed(1)} * (uHiR - distance(io, uCamP)) < 0.0) transformed = vec3(0.0); }`)
      // lamps, tyres and glass keep their own colour; only the paint takes the instance colour
      .replace('#include <color_vertex>', '#include <color_vertex>\nif (abs(color.r - color.g) > 0.04 || abs(color.b - color.g) > 0.04 || color.g < 0.2) vColor = color.rgb;');
  };
  mat.customProgramCacheKey = () => `car-v1-${sel}`;
  return mat;
}
let CAR = null;
function carGeometries() {
  const tint = (g, r, gg = r, b = r) => { g = g.index ? g.toNonIndexed() : g; g.deleteAttribute('uv'); g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, () => [r, gg, b]).flat(), 3)); return g; };
  const lo = mergeGeometries([
    tint(new THREE.BoxGeometry(4.3, 0.78, 1.78).translate(0, 0.56, 0), 1),
    tint(new THREE.BoxGeometry(2.25, 0.56, 1.6).translate(-0.25, 1.22, 0), 0.13),
    tint(new THREE.BoxGeometry(1.95, 0.07, 1.52).translate(-0.3, 1.52, 0), 1),
  ]);
  const prof = (pts, depth, bevel) => { const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))); const g = new THREE.ExtrudeGeometry(sh, { depth: depth - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 2 }); g.translate(0, 0, -(depth - 2 * bevel) / 2); return g; };
  // lower body to the belt line, with wheel arches suggested by the sill
  const body = prof([[-2.08, 0.32], [2.06, 0.32], [2.12, 0.52], [2.06, 0.78], [1.25, 0.92], [-1.7, 0.98], [-2.06, 0.92], [-2.12, 0.62]], 1.78, 0.07);
  const glass = prof([[-1.62, 0.96], [1.2, 0.94], [0.42, 1.38], [-1.38, 1.42], [-1.62, 1.16]], 1.6, 0.05);
  const roof = prof([[-1.42, 1.38], [0.45, 1.36], [0.36, 1.46], [-1.3, 1.48]], 1.52, 0.03);
  const parts = [tint(body, 1), tint(glass, 0.1, 0.12, 0.15), tint(roof, 1)];
  for (const x of [-1.32, 1.3]) for (const z of [-0.8, 0.8]) {
    parts.push(tint(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 12).rotateX(Math.PI / 2).translate(x, 0.33, z), 0.06, 0.06, 0.065));
    parts.push(tint(new THREE.CylinderGeometry(0.19, 0.19, 0.24, 8).rotateX(Math.PI / 2).translate(x, 0.33, z), 0.55, 0.55, 0.62));
  }
  for (const z of [-0.6, 0.6]) {
    parts.push(tint(new THREE.BoxGeometry(0.06, 0.12, 0.32).translate(2.11, 0.68, z), 0.95, 0.95, 1.0));   // headlamps
    parts.push(tint(new THREE.BoxGeometry(0.06, 0.14, 0.3).translate(-2.13, 0.76, z), 0.75, 0.06, 0.05));  // tail lamps
  }
  parts.push(tint(new THREE.BoxGeometry(0.05, 0.16, 0.5).translate(-2.14, 0.52, 0), 0.92, 0.9, 0.62));     // number plate
  parts.push(tint(new THREE.BoxGeometry(0.05, 0.12, 0.5).translate(2.13, 0.42, 0), 0.92, 0.92, 1.0));
  for (const z of [-0.92, 0.92]) parts.push(tint(new THREE.BoxGeometry(0.12, 0.08, 0.16).translate(0.55, 1.0, z), 0.12, 0.12, 0.13));   // mirrors
  const hi = mergeGeometries(parts.map((g) => { if (!g.attributes.normal) g.computeVertexNormals(); return g; }));
  return { lo, hi, mLo: carMaterial(-1), mHi: carMaterial(1) };
}
function addCars(buf) {
  const d = new Float32Array(buf), n = d.length / 6;
  if (!CAR) CAR = carGeometries();
  const PAL = [[0xf2f2ef, 30], [0xb9bcbf, 18], [0x7d8185, 12], [0x2a2c30, 15], [0x2b3e5c, 8], [0x8e2b2b, 7], [0xd8cdb4, 4], [0x3f5a46, 3], [0x5d6f86, 3]];
  const tot = PAL.reduce((a, p) => a + p[1], 0), pick = (h) => { let x = h * tot; for (const [c, w] of PAL) { if ((x -= w) < 0) return c; } return PAL[0][0]; };
  const CH = 400, cells = new Map();
  for (let i = 0; i < n; i++) { const k = Math.floor(d[i * 6] / CH) + ',' + Math.floor(d[i * 6 + 2] / CH); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); }
  const m = new THREE.Matrix4(), e = new THREE.Euler(0, 0, 0, 'YZX'), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), col = new THREE.Color();
  for (const ids of cells.values()) {
    const mesh = new THREE.InstancedMesh(CAR.lo, CAR.mLo, ids.length), hi = new THREE.InstancedMesh(CAR.hi, CAR.mHi, ids.length);
    ids.forEach((i, j) => {
      const o = i * 6; e.set(0, d[o + 3], d[o + 4]); q.setFromEuler(e);
      m.compose(p.set(d[o], d[o + 1], d[o + 2]), q, one); mesh.setMatrixAt(j, m); hi.setMatrixAt(j, m);
      col.setHex(pick((d[o + 5] * 7.31) % 1)); mesh.setColorAt(j, col); hi.setColorAt(j, col);
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
const haze = new THREE.FogExp2(0xdde3e6, 0.00011); scene.fog = haze;
const timeEl = document.getElementById('time'), clockEl = document.getElementById('clock');
const sunDir = new THREE.Vector3();
const warm = new THREE.Color(0xffb36b), noon = new THREE.Color(0xfff4e4), moonSky = new THREE.Color(0x5a6d9c), moonGround = new THREE.Color(0x24222c);
function setTime(h) {
  sunDirection(h, manifest.origin.lat, manifest.origin.lon, sunDir);
  const elev = Math.asin(sunDir.y);
  cityUniforms.uNight.value = 1 - THREE.MathUtils.smoothstep(elev, -0.04, 0.1);
  const golden = 1 - THREE.MathUtils.smoothstep(elev, 0.05, 0.5);
  sun.color.copy(noon).lerp(warm, golden);
  sun.intensity = 3.1 * THREE.MathUtils.smoothstep(elev, -0.02, 0.12);
  const night = cityUniforms.uNight.value;
  document.body.classList.toggle('night', night > 0.5);
  // night: cool moonlit sky light, no warm ground bounce; the warmth comes from the windows
  hemi.color.set(0xdfeaff).lerp(moonSky, night); hemi.groundColor.set(0xb59a7c).lerp(moonGround, night);
  hemi.intensity = (0.3 + 0.35 * THREE.MathUtils.smoothstep(elev, -0.1, 0.6)) * (1 - 0.5 * night);
  scene.environmentIntensity = (0.22 + 0.22 * THREE.MathUtils.smoothstep(elev, -0.1, 0.5)) * (1 - 0.85 * night);
  renderer.toneMappingExposure = 0.88 + 0.22 * golden;
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  clockEl.textContent = `${hh}:${String(mm).padStart(2, '0')}`;
  const sky = (day, dusk, nite, g) => new THREE.Color(day).lerp(new THREE.Color(dusk), golden * g).lerp(new THREE.Color(nite), night).getStyle();
  document.body.style.background = `radial-gradient(120% 90% at 50% 0%, ${sky(0xf7f1e6, 0xf6c99a, 0x2a3350, 0.8)} 0%, ${sky(0xe9dfcf, 0xc9a58c, 0x1b2238, 0.7)} 60%, ${sky(0xd9cbb6, 0x8f7d8c, 0x10141f, 0.6)} 100%)`;
  // aerial perspective: a light haze in the horizon's colour, so distance reads as distance (≈1 % at 1 km, 10 % at 3 km, 35 % at 6 km)
  haze.color.set(0xdde3e6).lerp(new THREE.Color(0xe8c2a0), golden * 0.7).lerp(new THREE.Color(0x1a2133), night);
}

timeEl.addEventListener('input', () => { setTime(+timeEl.value); invalidate(true); });
{ const t0 = +new URLSearchParams(location.search).get('t'); if (t0) timeEl.value = t0; }   // ?t=hour, for checks
setTime(+timeEl.value);

// Shadow frustum follows the view so close-ups get crisp shadows; snapped to texels to avoid shimmer.
const lightRight = new THREE.Vector3(), lightUp = new THREE.Vector3();
// The shadow map is the costliest pass, so it is cached: its frustum snaps to coarse steps (size in ×1.2 levels, position
// in tenths of its width) and it is only re-rendered when that snapped frustum, the sun, or the scene's contents change.
let shadowKey = '', shadowDirty = true;
function fitShadow() {
  const dist = camera.position.distanceTo(controls.target), lim = size * 0.6;
  const R0 = THREE.MathUtils.clamp(dist * 0.85, 140, lim);
  const R = Math.min(lim, 140 * 1.2 ** Math.ceil(Math.log(R0 / 140) / Math.log(1.2))) * 1.15;
  const sc = sun.shadow.camera;
  lightRight.crossVectors(sunDir, THREE.Object3D.DEFAULT_UP).normalize();
  lightUp.crossVectors(lightRight, sunDir).normalize();
  const texel = (2 * R) / sun.shadow.mapSize.x, step = texel * Math.round(sun.shadow.mapSize.x / 10);
  const t = controls.target, ka = Math.round(t.dot(lightRight) / step), kb = Math.round(t.dot(lightUp) / step);
  const key = `${R.toFixed(2)}|${ka}|${kb}|${sunDir.x.toFixed(4)},${sunDir.y.toFixed(4)},${sunDir.z.toFixed(4)}`;
  if (key === shadowKey && !shadowDirty) return;
  shadowKey = key; shadowDirty = false; renderer.shadowMap.needsUpdate = true;
  const c = lightRight.clone().multiplyScalar(ka * step).addScaledVector(lightUp, kb * step);
  const along = t.dot(sunDir); c.addScaledVector(sunDir, along);
  sun.target.position.copy(c); sun.target.updateMatrixWorld();
  sun.position.copy(c).addScaledVector(sunDir, 3000);
  if (sc.right !== R) { sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 100; sc.far = 6000; sc.updateProjectionMatrix(); }
}

let needRender = 3;
const invalidate = (shadow = false) => { needRender = Math.max(needRender, 2); if (shadow) shadowDirty = true; };
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
const live = initLive({ scene, camera, renderer, canvas, ll, bounds: { minX, minY, maxX, maxY } }); window.__live = live;
window.__scene = scene; if (SHOW_STATS) window.__dbg = { renderer, scene, camera, sun, THREE }; window.__view = (arr) => { camera.position.fromArray(arr, 0); controls.target.fromArray(arr, 3); introT = 1; };

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
  const moved = controls.update(dt);
  // render on demand: full rate while anything moves or loads; when the view is still, a quarter rate keeps the river alive
  const active = moved || introT < 1 || needRender > 0 || !ready || SHOW_STATS || !!live.busy;   // live layers that are on want every frame
  if (needRender > 0) needRender--;
  idleN = active ? 0 : idleN + 1;
  // motion resolution: while the view moves, draw at ~2/3 the pixel ratio (≈2.2× fewer pixels); full sharpness ~0.15 s after it settles
  const moving = moved || introT < 1, want = moving ? Math.max(1, pixelRatio * 0.67) : pixelRatio;
  if (moving) stillN = 0; else stillN++;
  let resized = false;   // a resized canvas is blank until drawn, so it is drawn this frame
  if (want !== curRatio && (moving || stillN > 8)) { curRatio = want; renderer.setPixelRatio(curRatio); renderer.setSize(innerWidth, innerHeight, false); resized = true; }
  if (!active && !resized && curRatio === pixelRatio && idleN % 4) { if (++nf % 12 === 0) stream(false); last = now; return; }
  // keep the target over the diorama
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, minX, maxX);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, -maxY, -minY);
  fitShadow();
  if (++nf % 12 === 0 || !ready) stream(!ready);
  for (const g of balconyChunks) g.visible = camera.position.distanceTo(g.userData.c) < 900 * lodK;
  carU.uHiR.value = 180 * lodK;
  for (const c of carChunks) { const dd = camera.position.distanceTo(c.c) - c.r; c.mesh.visible = dd < 850 * lodK; c.hi.visible = dd < 180 * lodK; }
  treeU.uCamP.value.copy(camera.position); treeU.uHiR.value = 230 * lodK;
  for (const t of treeHi) t.hi.visible = camera.position.distanceTo(t.c) - t.r < 230 * lodK;
  for (const t of treeChunks) { const nearby = camera.position.distanceTo(t.c) - t.r < 760 * lodK; t.near.visible = nearby; t.lo.visible = !nearby; }
  waterUniformTime.value = now / 1000;
  haze.density = 0.00011 * THREE.MathUtils.clamp(2200 / Math.max(1, camera.position.y), 0.3, 1);   // a high view looks down through less of the hazy low air
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
      else if (fps < 45 && lodK > 0.55) { if (++slow >= 2) { lodK = Math.max(0.55, lodK - 0.15); slow = 0; } }   // still slow at dpr 1: pull the detail distances in
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
