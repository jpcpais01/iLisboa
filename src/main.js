import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildingMaterial, waterMaterial, terrainMaterial, waterUniformTime, cityUniforms, balconyGeometry, railingMaterial } from './materials.js';
import { sunDirection } from './sun.js';

const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
const SHOW_STATS = new URLSearchParams(location.search).has('stats');

// ─── renderer ───────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, isMobile ? 2 : 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
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
const nearR = (dist) => THREE.MathUtils.clamp(dist * 0.8 + 1100, 1500, 2800);   // beyond this the far level of detail stands in
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

// trees: instanced, in chunks with a near/far level of detail
const treeChunks = [];
let KINDS = null;
function addTrees(buf) {
  const d = new Float32Array(buf), n = d.length / 4;
  if (!KINDS) KINDS = treeKinds();
  // chunked (per kind) so each patch of the city swaps detail by camera distance and frustum-culls on its own
  const CH = 600, cells = new Map();
  for (let i = 0; i < n; i++) { const kind = Math.min(2, Math.floor(d[i * 4 + 3] / 10)), k = kind + ':' + Math.floor(d[i * 4] / CH) + ',' + Math.floor(d[i * 4 + 2] / CH); if (!cells.has(k)) cells.set(k, { kind, ids: [] }); cells.get(k).ids.push(i); }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  for (const { kind, ids } of cells.values()) {
    const K = KINDS[kind], near = new THREE.InstancedMesh(K.near, K.mat, ids.length), lo = new THREE.InstancedMesh(K.far, K.mat, ids.length);
    ids.forEach((i, j) => {
      const r = Math.sin(i * 12.9898) * 43758.5453 % 1;
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r * 6.28);
      const k = d[i * 4 + 3] - kind * 10;
      s.set(k, k * (0.9 + Math.abs(r) * 0.3), k);
      m.compose(p.set(d[i * 4], d[i * 4 + 1] - 0.2, d[i * 4 + 2]), q, s);
      for (const mesh of [near, lo]) { mesh.setMatrixAt(j, m); mesh.setColorAt(j, col.setHex(K.greens[Math.floor(Math.abs(r) * K.greens.length) % K.greens.length])); }
    });
    for (const mesh of [near, lo]) { mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); scene.add(mesh); }
    treeChunks.push({ near, lo, c: near.boundingSphere.center.clone(), r: near.boundingSphere.radius });
  }
}
function treeKinds() {
  const paint = (g, hex) => { const c = new THREE.Color(hex); g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, () => [c.r, c.g, c.b]).flat(), 3)); return g; };
  // clumped crown: three overlapping low-poly lobes, lighter on top
  // ~110 triangles a tree (was ~340): icosahedron lobes at detail 0, rotated so the facets don't line up
  const lobe = (r, x, y, z, shade, ry) => paint(new THREE.IcosahedronGeometry(r, 0).rotateY(ry).rotateX(ry * 0.7).translate(x, y, z).toNonIndexed(), shade);
  const trunk = new THREE.CylinderGeometry(0.2, 0.34, 4.2, 5, 1, true).translate(0, 2.1, 0).toNonIndexed();
  const geo = mergeGeometries([lobe(2.45, 0, 5.4, 0, 0xe6e6e6, 0), lobe(1.8, 1.35, 6.3, 0.55, 0xffffff, 0.7), lobe(1.7, -1.15, 6.1, -0.75, 0xf2f2f2, 1.3), lobe(1.6, -0.3, 5.9, 1.3, 0xeeeeee, 2.1), lobe(1.4, 0.2, 7.3, -0.2, 0xffffff, 2.9), paint(trunk, 0x5e4636)]);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  // far LOD: one squat lobe on a stub trunk, ~26 triangles
  const far = mergeGeometries([lobe(2.7, 0, 5.9, 0, 0xf0f0f0, 0.4).scale(1, 0.85, 1), paint(new THREE.CylinderGeometry(0.25, 0.32, 4.2, 3, 1, true).translate(0, 2.1, 0).toNonIndexed(), 0x5e4636)]);
  far.computeVertexNormals();
  // palms: slim ringed trunk under two layers of drooping fronds (open cones, seen from both sides)
  const palmTrunk = (sides, segs) => paint(new THREE.CylinderGeometry(0.17, 0.27, 7.4, sides, segs, true).translate(0, 3.7, 0).toNonIndexed(), 0x8a7558);
  // a star of arched, tapering blades: rises from the crown, then droops to the tip
  const blades = (count, len, y0, rot) => {
    const pos = [];
    for (let f = 0; f < count; f++) {
      const a = rot + (f / count) * Math.PI * 2 + (f % 2) * 0.12, c = Math.cos(a), sn = Math.sin(a), w = 0.32 + (f % 3) * 0.06;
      const B = [0, y0, 0], M = [c * len * 0.45, y0 + 0.45, sn * len * 0.45], T = [c * len, y0 - 1.1 - (f % 2) * 0.5, sn * len];
      const ML = [M[0] - sn * w, M[1], M[2] + c * w], MR = [M[0] + sn * w, M[1], M[2] - c * w];
      pos.push(...B, ...ML, ...MR, ...ML, ...T, ...MR);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); return g;
  };
  const bare = (g) => { g.deleteAttribute('normal'); g.deleteAttribute('uv'); return g; };   // blades carry position + colour only
  const palm = mergeGeometries([palmTrunk(6, 2), paint(blades(11, 3.2, 7.4, 0), 0xffffff), paint(blades(7, 2.3, 7.7, 0.4), 0xe6e6e6), paint(new THREE.IcosahedronGeometry(0.5, 0).translate(0, 7.45, 0).toNonIndexed(), 0x9a8a70)].map(bare));
  palm.computeVertexNormals();
  const palmFar = mergeGeometries([palmTrunk(3, 1), paint(blades(6, 3.0, 7.4, 0), 0xffffff)].map(bare)); palmFar.computeVertexNormals();
  const palmMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true, side: THREE.DoubleSide });
  // stone pines (pinheiro-manso): tall bare trunk, flat umbrella crown
  const flat = (r, x, y, z, shade, ry, sy) => paint(new THREE.IcosahedronGeometry(r, 0).rotateY(ry).rotateX(ry * 0.6).scale(1, sy, 1).translate(x, y, z).toNonIndexed(), shade);
  const pineTrunk = (sides) => paint(new THREE.CylinderGeometry(0.22, 0.38, 6.8, sides, 1, true).translate(0, 3.4, 0).toNonIndexed(), 0x6a5240);
  const pine = mergeGeometries([pineTrunk(5), flat(3.4, 0, 7.6, 0, 0xe4e4e4, 0.3, 0.42), flat(2.4, 1.2, 8.2, 0.6, 0xffffff, 1.1, 0.4), flat(2.2, -1.3, 8.0, -0.5, 0xf2f2f2, 2.0, 0.42)]);
  pine.computeVertexNormals();
  const pineFar = mergeGeometries([pineTrunk(3), flat(3.6, 0, 7.8, 0, 0xf0f0f0, 0.3, 0.45)]); pineFar.computeVertexNormals();
  return [
    { near: geo, far, mat, greens: [0x6f9a4f, 0x7ea85a, 0x5e8a45, 0x8bb064, 0x6a9a5c] },
    { near: palm, far: palmFar, mat: palmMat, greens: [0x4f7134, 0x5b7c3b, 0x48682f] },
    { near: pine, far: pineFar, mat, greens: [0x4f6f3c, 0x5a7a44, 0x466536] },
  ];
}

// cars: instanced boxes (body, glass cabin, roof), chunked and only drawn near the camera
const carChunks = [];
function addCars(buf) {
  const d = new Float32Array(buf), n = d.length / 6;
  const tint = (g, v) => { g = g.toNonIndexed(); g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count * 3).fill(v), 3)); return g; };
  const geo = mergeGeometries([
    tint(new THREE.BoxGeometry(4.3, 0.78, 1.78).translate(0, 0.56, 0), 1),
    tint(new THREE.BoxGeometry(2.25, 0.56, 1.6).translate(-0.25, 1.22, 0), 0.13),
    tint(new THREE.BoxGeometry(1.95, 0.07, 1.52).translate(-0.3, 1.52, 0), 1),
  ]);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 });
  const PAL = [[0xf2f2ef, 30], [0xb9bcbf, 18], [0x7d8185, 12], [0x1e2023, 15], [0x2b3e5c, 8], [0x8e2b2b, 7], [0xd8cdb4, 4], [0x3f5a46, 3], [0x5d6f86, 3]];
  const tot = PAL.reduce((a, p) => a + p[1], 0), pick = (h) => { let x = h * tot; for (const [c, w] of PAL) { if ((x -= w) < 0) return c; } return PAL[0][0]; };
  const CH = 400, cells = new Map();
  for (let i = 0; i < n; i++) { const k = Math.floor(d[i * 6] / CH) + ',' + Math.floor(d[i * 6 + 2] / CH); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); }
  const m = new THREE.Matrix4(), e = new THREE.Euler(0, 0, 0, 'YZX'), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), col = new THREE.Color();
  for (const ids of cells.values()) {
    const mesh = new THREE.InstancedMesh(geo, mat, ids.length);
    ids.forEach((i, j) => {
      const o = i * 6; e.set(0, d[o + 3], d[o + 4]); q.setFromEuler(e);
      m.compose(p.set(d[o], d[o + 1], d[o + 2]), q, one); mesh.setMatrixAt(j, m);
      mesh.setColorAt(j, col.setHex(pick((d[o + 5] * 7.31) % 1)));
    });
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); mesh.visible = false;
    scene.add(mesh); carChunks.push({ mesh, c: mesh.boundingSphere.center.clone(), r: mesh.boundingSphere.radius });
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
}


// ─── sun / time of day ──────────────────────────────────────────────────
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
}
timeEl.addEventListener('input', () => setTime(+timeEl.value));
setTime(+timeEl.value);

// Shadow frustum follows the view so close-ups get crisp shadows; snapped to texels to avoid shimmer.
const lightRight = new THREE.Vector3(), lightUp = new THREE.Vector3();
function fitShadow() {
  const dist = camera.position.distanceTo(controls.target);
  const R = THREE.MathUtils.clamp(dist * 0.85, 140, size * 0.6);
  const sc = sun.shadow.camera;
  lightRight.crossVectors(sunDir, THREE.Object3D.DEFAULT_UP).normalize();
  lightUp.crossVectors(lightRight, sunDir).normalize();
  const texel = (2 * R) / sun.shadow.mapSize.x;
  const t = controls.target.clone();
  const a = Math.round(t.dot(lightRight) / texel) * texel - t.dot(lightRight);
  const b = Math.round(t.dot(lightUp) / texel) * texel - t.dot(lightUp);
  t.addScaledVector(lightRight, a).addScaledVector(lightUp, b);
  sun.target.position.copy(t);
  sun.position.copy(t).addScaledVector(sunDir, 3000);
  if (sc.right !== R) { sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 100; sc.far = 6000; sc.updateProjectionMatrix(); }
}

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
// ?cam=lat,lon,range,heading,tilt — same convention as Google Earth URLs, for side-by-side checks
const cam = (new URLSearchParams(location.search).get('cam') || '').split(',').map(Number);
const camOnGround = cam.length === 5 && cam.every(isFinite);
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
window.__scene = scene; window.__view = (arr) => { camera.position.fromArray(arr, 0); controls.target.fromArray(arr, 3); introT = 1; };

// ─── loop ───────────────────────────────────────────────────────────────
const statsEl = document.getElementById('stats');
if (SHOW_STATS) statsEl.hidden = false;
const _c = new THREE.Vector3();
let frames = 0, acc = 0, last = performance.now(), slow = 0, nf = 0, ready = false;
renderer.setAnimationLoop((now) => {
  const raw = (now - last) / 1000, dt = Math.min(0.1, raw); last = now;
  if (introT < 1 && ready) {
    introT = Math.min(1, introT + dt / 2.8);
    const e = 1 - (1 - introT) ** 3;
    camera.position.lerpVectors(startPos, endPos, e);
  }
  controls.update(dt);
  // keep the target over the diorama
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, minX, maxX);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, -maxY, -minY);
  fitShadow();
  if (++nf % 12 === 0 || !ready) stream(!ready);
  for (const g of balconyChunks) g.visible = camera.position.distanceTo(g.userData.c) < 900 * lodK;
  for (const c of carChunks) c.mesh.visible = camera.position.distanceTo(c.c) - c.r < 850 * lodK;
  for (const t of treeChunks) { const nearby = camera.position.distanceTo(t.c) - t.r < 760 * lodK; t.near.visible = nearby; t.lo.visible = !nearby; }
  waterUniformTime.value = now / 1000;
  for (const l of lampPoints) l.visible = cityUniforms.uNight.value > 0.01;
  { lampUniforms.uScale.value = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360)); }
  renderer.render(scene, camera);

  // adaptive resolution: hold 60 fps on phones
  frames++; acc += raw;
  if (acc > 1) {
    const fps = frames / acc;
    if (ready && introT >= 1) {
      if (fps < 52 && pixelRatio > 1) { if (++slow >= 2) { pixelRatio = Math.max(1, pixelRatio - 0.25); renderer.setPixelRatio(pixelRatio); renderer.setSize(innerWidth, innerHeight, false); slow = 0; } }
      else if (fps < 45 && lodK > 0.55) { if (++slow >= 2) { lodK = Math.max(0.55, lodK - 0.15); slow = 0; } }   // still slow at dpr 1: pull the detail distances in
      else slow = 0;
    }
    if (SHOW_STATS) statsEl.textContent = `${fps.toFixed(0)} fps · dpr ${pixelRatio}\n${renderer.info.render.calls} draws · ${(renderer.info.render.triangles / 1e6).toFixed(2)}M tris`;
    window.__perf = { fps, dpr: pixelRatio, lod: lodK, calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    frames = 0; acc = 0;
  }
});
addEventListener('resize', () => {
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
    if (hit) { const dy = hit.point.y - controls.target.y; controls.target.y += dy; camera.position.y += dy; }
  }
  document.getElementById('loading').classList.add('done');
} catch (err) {
  console.error(err);
  document.querySelector('#loading span').textContent = 'Lisboa não carregou. Recarregue a página.';
}
document.getElementById('subtitle').textContent = `Lisboa · ${AREAS.reduce((n, a) => n + a.stats.buildings, 0).toLocaleString('pt-PT')} edifícios`;
window.__ready = true;
