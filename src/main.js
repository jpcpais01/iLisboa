import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildingMaterial, waterMaterial, terrainMaterial, waterUniformTime } from './materials.js';
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
const manifest = await (await fetch(BASE + 'manifest.json')).json();
const { minX, minY, maxX, maxY } = manifest.bounds;
const center = new THREE.Vector3((minX + maxX) / 2, 0, -(minY + maxY) / 2);
const size = Math.hypot(maxX - minX, maxY - minY);
document.getElementById('attrib').textContent = manifest.attribution;

const matBuildings = buildingMaterial();
const maxAniso = renderer.capabilities.getMaxAnisotropy();
let done = 0;
const total = manifest.tiles.length + 3;
const tick = () => { progressEl.style.width = `${(++done / total) * 100}%`; };

function adopt(gltf) {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name.startsWith('buildings')) {
      const g = o.geometry;
      g.setAttribute('wall', g.attributes.uv); g.setAttribute('wallInfo', g.attributes.uv1);
      g.deleteAttribute('uv'); g.deleteAttribute('uv1');
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

const waterMask = await texLoader.loadAsync(BASE + 'water.png');
const jobs = [...manifest.tiles.map((t) => t.file), 'base.glb'].map((f) => loader.loadAsync(BASE + f).then(adopt));

// water: plane clipped by the coastline mask
jobs.push(Promise.resolve(waterMask).then((mask) => {
  const geo = new THREE.PlaneGeometry(maxX - minX, maxY - minY, 1, 1).rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(geo, waterMaterial(mask));
  water.position.set(center.x, manifest.waterY, center.z);
  water.receiveShadow = true;
  scene.add(water);
  tick();
}));

// trees: one instanced draw call
jobs.push(fetch(BASE + 'trees.bin').then((r) => r.arrayBuffer()).then((buf) => {
  const d = new Float32Array(buf), n = d.length / 4;
  const crown = new THREE.IcosahedronGeometry(2.6, 0).scale(1, 1.15, 1).translate(0, 5.2, 0);
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 3.4, 5).translate(0, 1.7, 0);
  const paint = (g, hex) => { const c = new THREE.Color(hex); g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, () => [c.r, c.g, c.b]).flat(), 3)); return g; };
  const geo = mergeGeometries([paint(crown.toNonIndexed(), 0xffffff), paint(trunk.toNonIndexed(), 0x6b4f3a)]);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  const greens = [0x6f9a4f, 0x7ea85a, 0x5e8a45, 0x8bb064, 0x6a9a5c];
  for (let i = 0; i < n; i++) {
    const r = Math.sin(i * 12.9898) * 43758.5453 % 1;
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r * 6.28);
    const k = d[i * 4 + 3];
    s.set(k, k * (0.9 + Math.abs(r) * 0.3), k);
    m.compose(p.set(d[i * 4], d[i * 4 + 1] - 0.2, d[i * 4 + 2]), q, s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.setHex(greens[Math.floor(Math.abs(r) * greens.length) % greens.length]));
  }
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  tick();
}));

// ─── sun / time of day ──────────────────────────────────────────────────
const timeEl = document.getElementById('time'), clockEl = document.getElementById('clock');
const sunDir = new THREE.Vector3();
const warm = new THREE.Color(0xffb36b), noon = new THREE.Color(0xfff4e4);
function setTime(h) {
  sunDirection(h, manifest.origin.lat, manifest.origin.lon, sunDir);
  const elev = Math.asin(sunDir.y);
  const golden = 1 - THREE.MathUtils.smoothstep(elev, 0.05, 0.5);
  sun.color.copy(noon).lerp(warm, golden);
  sun.intensity = 3.6 * THREE.MathUtils.smoothstep(elev, -0.02, 0.12);
  hemi.intensity = 0.12 + 0.18 * THREE.MathUtils.smoothstep(elev, -0.1, 0.6);
  scene.environmentIntensity = 0.16 + 0.16 * THREE.MathUtils.smoothstep(elev, -0.1, 0.5);
  renderer.toneMappingExposure = 0.82 + 0.25 * golden;
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  clockEl.textContent = `${hh}:${String(mm).padStart(2, '0')}`;
  document.body.style.background = `radial-gradient(120% 90% at 50% 0%, ${new THREE.Color(0xf7f1e6).lerp(new THREE.Color(0xf6c99a), golden * 0.8).getStyle()} 0%, ${new THREE.Color(0xe9dfcf).lerp(new THREE.Color(0xc9a58c), golden * 0.7).getStyle()} 60%, ${new THREE.Color(0xd9cbb6).lerp(new THREE.Color(0x8f7d8c), golden * 0.6).getStyle()} 100%)`;
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
if (fromHash.length === 6 && fromHash.every(isFinite)) {
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
  waterUniformTime.value = now / 1000;
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

await Promise.all(jobs);
document.getElementById('loading').classList.add('done');
document.getElementById('subtitle').textContent = `Baixa · Alfama · ${manifest.stats.buildings.toLocaleString('pt-PT')} edifícios`;
window.__ready = true;
