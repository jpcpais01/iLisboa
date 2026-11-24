import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildingMaterial, waterMaterial, terrainMaterial, waterUniformTime, cityUniforms, balconyGeometry, railingMaterial } from './materials.js';
import { sunDirection } from './sun.js';

const AREA = new URLSearchParams(location.search).get('area') || 'baixa-alfama';
const BASE = `/tiles/${AREA}/`;
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

// ─── load ───────────────────────────────────────────────────────────────
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const texLoader = new THREE.TextureLoader();
const progressEl = document.getElementById('progress');
const manifest = await (await fetch(BASE + 'manifest.json', { cache: 'no-cache' })).json();
// every asset URL carries the build stamp, so a new deploy never mixes with cached tiles
const url = (f) => `${BASE}${f}?v=${encodeURIComponent(manifest.built)}`;
const ok = (r) => { if (!r.ok) throw new Error(`${r.status} ${r.url}`); return r; };
const { minX, minY, maxX, maxY } = manifest.bounds;
const center = new THREE.Vector3((minX + maxX) / 2, 0, -(minY + maxY) / 2);
const size = Math.hypot(maxX - minX, maxY - minY);
document.getElementById('attrib').textContent = manifest.attribution;

const matBuildings = buildingMaterial();
const maxAniso = renderer.capabilities.getMaxAnisotropy();
let done = 0;
const total = manifest.tiles.length + 5;
const tick = () => { progressEl.style.width = `${(++done / total) * 100}%`; };

function adopt(gltf) {
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
      map.anisotropy = Math.min(8, maxAniso);
      o.material = terrainMaterial(map, waterMask, manifest.bounds);
      o.receiveShadow = true;
    } else if (o.name.startsWith('base')) {
      o.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    }
  });
  scene.add(gltf.scene);
  tick();
}

const waterMask = await texLoader.loadAsync(url('water.png'));
const jobs = [...manifest.tiles.map((t) => t.file), 'base.glb'].map((f) => loader.loadAsync(url(f)).then(adopt));

// balconies: instanced per 250 m chunk, only drawn near the camera
const balconyChunks = [];
jobs.push(Promise.all(manifest.tiles.filter((t) => t.balconies).map((t) => fetch(url(t.balconies)).then(ok).then((r) => r.arrayBuffer())))
  .then((bufs) => {
    const { slab, rail } = balconyGeometry();
    const railGeo = mergeGeometries(rail);
    const slabMat = new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.8 });
    const railMat = railingMaterial();
    const cells = new Map();
    for (const buf of bufs) {
      const d = new Float32Array(buf);
      for (let i = 0; i < d.length; i += 5) {
        const k = `${Math.floor(d[i] / 250)},${Math.floor(d[i + 2] / 250)}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i, d);
      }
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    for (const list of cells.values()) {
      const n = list.length / 2;
      const a = new THREE.InstancedMesh(slab, slabMat, n), b = new THREE.InstancedMesh(railGeo, railMat, n);
      const c = new THREE.Vector3();
      for (let j = 0; j < n; j++) {
        const i = list[j * 2], d = list[j * 2 + 1];
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, d[i + 3]);
        m.compose(p.set(d[i], d[i + 1], d[i + 2]), q, sc.set(d[i + 4], 1, 1));
        a.setMatrixAt(j, m); b.setMatrixAt(j, m); c.add(p);
      }
      a.computeBoundingSphere(); b.computeBoundingSphere();
      a.castShadow = true; a.receiveShadow = true;
      const g = new THREE.Group(); g.add(a, b); g.userData.c = c.divideScalar(n);
      balconyChunks.push(g); scene.add(g);
    }
    tick();
  }));

// water: plane clipped by the coastline mask
jobs.push(Promise.resolve(waterMask).then((mask) => {
  const geo = new THREE.PlaneGeometry(maxX - minX, maxY - minY, 1, 1).rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(geo, waterMaterial(mask));
  water.position.set(center.x, manifest.waterY, center.z);
  water.receiveShadow = true;
  scene.add(water);
  tick();
}));

// trees: instanced, in chunks with a near/far level of detail
const treeChunks = [];
jobs.push(fetch(url('trees.bin')).then(ok).then((r) => r.arrayBuffer()).then((buf) => {
  const d = new Float32Array(buf), n = d.length / 4;
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
  // chunked so each patch of the city swaps detail by camera distance (and frustum-culls on its own)
  const CH = 600, cells = new Map();
  for (let i = 0; i < n; i++) { const k = Math.floor(d[i * 4] / CH) + ',' + Math.floor(d[i * 4 + 2] / CH); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  const greens = [0x6f9a4f, 0x7ea85a, 0x5e8a45, 0x8bb064, 0x6a9a5c];
  for (const ids of cells.values()) {
    const near = new THREE.InstancedMesh(geo, mat, ids.length), lo = new THREE.InstancedMesh(far, mat, ids.length);
    ids.forEach((i, j) => {
      const r = Math.sin(i * 12.9898) * 43758.5453 % 1;
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r * 6.28);
      const k = d[i * 4 + 3];
      s.set(k, k * (0.9 + Math.abs(r) * 0.3), k);
      m.compose(p.set(d[i * 4], d[i * 4 + 1] - 0.2, d[i * 4 + 2]), q, s);
      for (const mesh of [near, lo]) { mesh.setMatrixAt(j, m); mesh.setColorAt(j, col.setHex(greens[Math.floor(Math.abs(r) * greens.length) % greens.length])); }
    });
    for (const mesh of [near, lo]) { mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); scene.add(mesh); }
    treeChunks.push({ near, lo, c: near.boundingSphere.center.clone(), r: near.boundingSphere.radius });
  }
  tick();
}));

// street lamps: one additive point sprite each, warm core and soft halo; only drawn after dusk
const lampUniforms = { uNight: cityUniforms.uNight, uScale: { value: 1 } };
let lampPoints = null;
jobs.push(fetch(url('lamps.bin')).then((r) => (r.ok ? r.arrayBuffer() : new ArrayBuffer(0))).then((buf) => {
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
  lampPoints = new THREE.Points(geo, mat); lampPoints.frustumCulled = false; lampPoints.renderOrder = 2;
  scene.add(lampPoints);
  tick();
}));

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
window.__view = (arr) => { camera.position.fromArray(arr, 0); controls.target.fromArray(arr, 3); introT = 1; };

// ─── loop ───────────────────────────────────────────────────────────────
const statsEl = document.getElementById('stats');
if (SHOW_STATS) statsEl.hidden = false;
let frames = 0, acc = 0, last = performance.now(), slow = 0;
renderer.setAnimationLoop((now) => {
  const raw = (now - last) / 1000, dt = Math.min(0.1, raw); last = now;
  if (introT < 1 && done >= total) {
    introT = Math.min(1, introT + dt / 2.8);
    const e = 1 - (1 - introT) ** 3;
    camera.position.lerpVectors(startPos, endPos, e);
  }
  controls.update(dt);
  // keep the target over the diorama
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, minX, maxX);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, -maxY, -minY);
  fitShadow();
  for (const g of balconyChunks) g.visible = camera.position.distanceTo(g.userData.c) < 480;
  for (const t of treeChunks) { const nearby = camera.position.distanceTo(t.c) - t.r < 520; t.near.visible = nearby; t.lo.visible = !nearby; }
  waterUniformTime.value = now / 1000;
  if (lampPoints) { lampPoints.visible = cityUniforms.uNight.value > 0.01; lampUniforms.uScale.value = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360)); }
  renderer.render(scene, camera);

  // adaptive resolution: hold 60 fps on phones
  frames++; acc += raw;
  if (acc > 1) {
    const fps = frames / acc;
    if (done >= total && introT >= 1) {
      if (fps < 52 && pixelRatio > 1) { if (++slow >= 2) { pixelRatio = Math.max(1, pixelRatio - 0.25); renderer.setPixelRatio(pixelRatio); renderer.setSize(innerWidth, innerHeight, false); slow = 0; } }
      else slow = 0;
    }
    if (SHOW_STATS) statsEl.textContent = `${fps.toFixed(0)} fps · dpr ${pixelRatio}\n${renderer.info.render.calls} draws · ${(renderer.info.render.triangles / 1e6).toFixed(2)}M tris`;
    window.__perf = { fps, dpr: pixelRatio, calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
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
  await Promise.all(jobs);
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
document.getElementById('subtitle').textContent = `Baixa · Alfama · ${manifest.stats.buildings.toLocaleString('pt-PT')} edifícios`;
window.__ready = true;
