// The river as data, shared by the water shader and the boats: the river texture (water, depth, shore distance),
// the live wind and the sea state it raises.
//  · river(): public/water/river.png → waterUniforms.uRiver (GPU) + a CPU copy for placing and steering boats;
//  · wind: Open-Meteo 10 m wind (window.__weather / 'weather' event, the same feed as the HUD) → waterUniforms.uWind;
//    ?vento=km/h,from° pins it (tests);
//  · sea(): the waves a boat rides on: a fetch-limited wind sea (JONSWAP growth laws, ~8 km fetch inside the estuary)
//    plus, west of Belém, the Atlantic swell entering over the bar (Open-Meteo marine, keyless), dying out upriver.
//    eta(x, y, t) sums the same components everywhere, so neighbouring boats rise and fall on the same wave.
import * as THREE from 'three';
import { waterUniforms, waterMaterial } from './materials.js';

const Q = new URLSearchParams(location.search);
let grid = null, px = null;
let comps = [], seaDirty = true;   // sea state (see sea / eta below), rebuilt when the wind or swell changes
const ready = (async () => {
  try {
    const meta = await (await fetch('/water/ships.json')).json();
    grid = meta.grid;
    const box = waterUniforms.uRiverBox.value;
    box.set(grid.minX, grid.maxY, grid.W * grid.R, grid.H * grid.R);
    const img = await createImageBitmap(await (await fetch('/water/river.png')).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0);
    px = cx.getImageData(0, 0, img.width, img.height).data;
    const t = new THREE.DataTexture(new Uint8Array(px), img.width, img.height, THREE.RGBAFormat);
    t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
    waterUniforms.uRiver.value = t;
    cv.width = cv.height = 1; img.close?.();
    return meta;
  } catch (e) { console.warn('river data', e); return null; }
})();
export const riverReady = ready;

// the open sea out to the horizon, beyond the city's own areas (each draws its own water): one plane 160 km across,
// clipped by public/water/ocean.png (EMODnet: sea where no area covers it, with its depth for the colour). The mask's
// edges clamp, so the Atlantic carries on west and south past the data. Sits 0.3 m low: under an area's water, never over it.
export async function addOcean(scene, waterY = 0) {
  const meta = await ready;
  if (!meta?.ocean) return null;
  try {
    const img = await createImageBitmap(await (await fetch('/water/ocean.png')).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const t = new THREE.DataTexture(new Uint8Array(cx.getImageData(0, 0, img.width, img.height).data), img.width, img.height, THREE.RGBAFormat);
    cv.width = cv.height = 1; img.close?.();
    t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    const o = meta.ocean, S = 160000, cxm = (o.minX + o.maxX) / 2, cym = (o.minY + o.maxY) / 2, bw = o.maxX - o.minX, bh = o.maxY - o.minY;
    t.repeat.set(S / bw, -S / bh); t.offset.set((cxm - S / 2 - o.minX) / bw, (o.maxY - (cym - S / 2)) / bh);
    t.needsUpdate = true;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(S, S, 1, 1).rotateX(-Math.PI / 2), waterMaterial(t));
    mesh.position.set(cxm, waterY - 0.3, -cym); mesh.receiveShadow = true; mesh.name = 'ocean';
    scene.add(mesh);
    return mesh;
  } catch (e) { console.warn('ocean', e); return null; }
}

// bilinear read of the river texture: { w: water 0–1, d: depth m, s: metres to the shore }
const out = { w: 0, d: 0, s: 0 };
export function riverAt(x, y) {
  if (!px) { out.w = 0; out.d = 0; out.s = 0; return out; }
  const fx = (x - grid.minX) / grid.R - 0.5, fy = (grid.maxY - y) / grid.R - 0.5;
  const i = Math.max(0, Math.min(grid.W - 2, Math.floor(fx))), j = Math.max(0, Math.min(grid.H - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j));
  const ch = (c) => {
    const k = (j * grid.W + i) * 4 + c, k2 = k + grid.W * 4;
    return ((px[k] * (1 - tx) + px[k + 4] * tx) * (1 - ty) + (px[k2] * (1 - tx) + px[k2 + 4] * tx) * ty) / 255;
  };
  out.w = ch(0); const g = ch(1); out.d = g * g * 40; out.s = ch(2) * 1020;
  return out;
}

// ─── wind ───
export const wind = { speed: 4, from: 315, live: false };   // m/s, degrees the wind comes FROM (Lisbon's usual nortada)
function setWind(kmh, from, live) {
  if (kmh == null || from == null) return;
  wind.speed = kmh / 3.6; wind.from = from; wind.live = live;
  const r = (from * Math.PI) / 180;
  waterUniforms.uWind.value.set(-Math.sin(r), -Math.cos(r), wind.speed, 0);   // downwind (x east, y north)
  seaDirty = true;
}
const pin = Q.get('vento')?.split(',').map(Number);
if (pin && pin.length === 2 && pin.every(Number.isFinite)) setWind(pin[0], pin[1], false);
else {
  const take = (d) => { const c = d?.current; if (c) setWind(c.wind_speed_10m, c.wind_direction_10m, true); };
  addEventListener('weather', (e) => take(e.detail || window.__weather));
  if (window.__weather) take(window.__weather);
  setWind(wind.speed * 3.6, wind.from, false);
}

// ─── Atlantic swell at the bar (Open-Meteo marine, one call per 30 min) ───
export const swell = { h: 0.8, T: 10, from: 270, live: false };
async function loadSwell() {
  try {
    const u = 'https://marine-api.open-meteo.com/v1/marine?latitude=38.62&longitude=-9.35&current=swell_wave_height,swell_wave_period,swell_wave_direction&timezone=UTC';
    const c = (await (await fetch(u)).json()).current;
    if (c?.swell_wave_height != null) Object.assign(swell, { h: c.swell_wave_height, T: c.swell_wave_period || 10, from: c.swell_wave_direction ?? 270, live: true });
    seaDirty = true;
  } catch { /* offline: a typical 0.8 m, 10 s westerly swell */ }
}
if (!Q.has('nosea')) { setTimeout(loadSwell, 3000); setInterval(loadSwell, 30 * 60 * 1000); }

// ─── sea state: wave components (amplitude m, wavenumber, direction, phase) ───
function buildSea() {
  seaDirty = false;
  const U = Math.max(0.5, wind.speed), F = 8000, g = 9.81;
  const Hs = Math.min(1.6, 0.0016 * U * Math.sqrt(F / g)) + 0.03;                    // JONSWAP fetch-limited growth
  const Tp = Math.max(1.2, 0.286 * (U / g) * Math.cbrt((g * F) / (U * U)));
  const down = ((wind.from + 180) * Math.PI) / 180;
  comps = [];
  const N = 7;
  for (let i = 0; i < N; i++) {
    const T = Tp * (0.75 + 0.55 * (i / (N - 1))), k = (4 * Math.PI * Math.PI) / (g * T * T);
    const th = down + (((i * 0.618) % 1) - 0.5) * 1.6;
    comps.push({ a: Math.sqrt((2 * Hs * Hs) / 16 / N), k, dx: Math.sin(th), dy: Math.cos(th), w: Math.sqrt(g * k), ph: i * 2.39, swell: 0 });
  }
  // swell: two long crests from the swell direction, refracted and damped as it runs up the estuary (see eta)
  const sd = ((swell.from + 180) * Math.PI) / 180;
  for (let i = 0; i < 2; i++) {
    const T = swell.T * (1 - i * 0.12), k = (4 * Math.PI * Math.PI) / (g * T * T);
    comps.push({ a: (swell.h / 4) * Math.SQRT1_2, k, dx: Math.sin(sd + i * 0.25), dy: Math.cos(sd + i * 0.25), w: Math.sqrt(g * k), ph: 1.3 + i * 2.1, swell: 1 });
  }
}
// swell reaching here: full at the bar (x ≈ −9 km), half by Belém, gone by the Cais do Sodré
const swellAt = (x) => Math.max(0, Math.min(1, (-x - 1500) / 6500)) ** 1.5;
export function eta(x, y, t, shoreD = 500) {
  if (seaDirty) buildSea();
  let h = 0;
  const sh = 0.35 + 0.65 * Math.min(1, shoreD / 250), sw = swellAt(x);
  for (const c of comps) h += c.a * (c.swell ? sw : sh) * Math.cos(c.k * (c.dx * x + c.dy * y) - c.w * t + c.ph);
  return h;
}
export function seaState() { if (seaDirty) buildSea(); return { comps, wind, swell }; }
