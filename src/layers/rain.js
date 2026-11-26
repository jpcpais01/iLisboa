// Chuva: the real rain radar (RainViewer composite, IPMA's radars among them; 10-minute frames of the last 2 h)
// tinted over the city like a radar screen, looping the past two hours, and rain actually falling from the cells
// that are over the view right now. The free radar tiles stop at ~600 m pixels, so cells are soft-edged by nature.
import * as THREE from 'three';
import { createOverlay } from './overlay.js';
import { ramp, rampCss } from './palette.js';
import { createStreaks } from './streaks.js';

// RainViewer "Universal Blue" (scheme 2) colours → dBZ, from their published colour table (rain block)
const UB = [[-10, 0x63, 0x61, 0x59], [-5, 0x72, 0x6e, 0x61], [0, 0x82, 0x7b, 0x69], [5, 0x92, 0x88, 0x71], [10, 0xce, 0xc0, 0x87],
  [15, 0x88, 0xdd, 0xee], [20, 0x00, 0xa3, 0xe0], [25, 0x00, 0x77, 0xaa], [30, 0x00, 0x55, 0x88], [35, 0xff, 0xee, 0x00],
  [40, 0xff, 0xaa, 0x00], [45, 0xff, 0x44, 0x00], [50, 0xc1, 0x00, 0x00], [55, 0xff, 0xaa, 0xff], [60, 0xff, 0x77, 0xff], [65, 0xff, 0xff, 0xff]];
const dbzOf = (r, g, b) => { let best = 0, bd = 1e9; for (const [z, R, G, B] of UB) { const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2; if (d < bd) { bd = d; best = z; } } return best; };
// Marshall–Palmer: Z = 200 R^1.6
const rateOf = (dbz) => (dbz < 8 ? 0 : (10 ** (dbz / 10) / 200) ** (1 / 1.6));
export const RAIN_STOPS = ['#bfe6ff', '#6cc3f5', '#2c8fe0', '#2bc46b', '#f2df3a', '#f59a2e', '#e2412e', '#b0208f'];
const rainF = (mm) => Math.min(1, Math.log2(1 + mm) / Math.log2(1 + 40));   // 0…40 mm/h, log-ish

// local metres ↔ lat/lon (same tangent plane as api/_lib/geo.js)
const LAT0 = 38.71375, LON0 = -9.13975, P = (LAT0 * Math.PI) / 180;
const M_LAT = 111132.92 - 559.82 * Math.cos(2 * P) + 1.175 * Math.cos(4 * P), M_LON = 111412.84 * Math.cos(P) - 93.5 * Math.cos(3 * P);

export function createRain({ ground, camera, controls, canvas, box, mobile }) {
  const ov = createOverlay(box, 240, 190);
  const legend = document.createElement('div'); legend.className = 'wx-legend';
  let on = false, frames = [], tile = null, fields = [], loadedAt = 0, loading = null, shown = -1, maxNow = 0, frameLabel = '';
  const fall = createStreaks(mobile ? 1500 : 4000, mobile ? 1.6 : 1.3);
  fall.mesh.name = 'rain';
  const N = fall.A.length / 3, fx = new Float32Array(N), fy = new Float32Array(N), fz = new Float32Array(N), alive = new Uint8Array(N);

  // radar frame → rain rate (mm/h) on the overlay grid
  async function decode(f) {
    const img = await createImageBitmap(await (await fetch(`/api/radar?p=${encodeURIComponent(f.p)}`)).blob());
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data, S = c.width, n = 2 ** tile.z;
    const out = new Float32Array(ov.W * ov.H);
    for (let j = 0; j < ov.H; j++) {
      const lat = LAT0 + ov.y(j) / M_LAT, m = Math.asinh(Math.tan((lat * Math.PI) / 180));
      const v = ((1 - m / Math.PI) / 2 * n - tile.y) * S;
      for (let i = 0; i < ov.W; i++) {
        const lon = LON0 + ov.x(i) / M_LON, u = ((lon + 180) / 360 * n - tile.x) * S;
        // bilinear on rain rate (not on colour)
        const u0 = Math.floor(u - 0.5), v0 = Math.floor(v - 0.5), tu = u - 0.5 - u0, tv = v - 0.5 - v0;
        let s = 0;
        for (const [du, dv, w] of [[0, 0, (1 - tu) * (1 - tv)], [1, 0, tu * (1 - tv)], [0, 1, (1 - tu) * tv], [1, 1, tu * tv]]) {
          const k = ((v0 + dv) * S + (u0 + du)) * 4;
          if (u0 + du < 0 || v0 + dv < 0 || u0 + du >= S || v0 + dv >= S || px[k + 3] < 8) continue;
          s += w * rateOf(dbzOf(px[k], px[k + 1], px[k + 2]));
        }
        out[j * ov.W + i] = s;
      }
    }
    return out;
  }
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const r = await (await fetch('/api/radar')).json();
        tile = r.tile;
        const fr = r.frames.slice(-12);
        const got = await Promise.all(fr.map((f) => decode(f).catch(() => null)));
        frames = fr.filter((_, k) => got[k]); fields = got.filter(Boolean);
        loadedAt = performance.now();
      } catch { frames = []; fields = []; }
      loading = null; shown = -1;
      const last = fields.at(-1);
      maxNow = last ? last.reduce((a, b) => Math.max(a, b), 0) : 0;
      writeLegend();
    })();
    return loading;
  }
  const hhmm = (t) => new Date(t * 1000).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' });
  function writeLegend() {
    const ok = fields.length > 0;
    legend.innerHTML = `<div class="bar" style="background:${rampCss(RAIN_STOPS)}"></div><div class="ends"><span>0,2</span><span>40 mm/h</span></div>`
      + `<small>${ok ? (maxNow > 0.1 ? `radar das ${hhmm(frames.at(-1).t)}, últimas 2 h em loop` : `sem chuva no radar (${hhmm(frames.at(-1).t)})`) : 'radar indisponível'} · RainViewer</small>`;
  }
  // paint a blend of two frames into the overlay
  function paint(f) {
    const k0 = Math.floor(f), k1 = Math.min(fields.length - 1, k0 + 1), t = f - k0, a = fields[k0], b = fields[k1], d = ov.data, c = [0, 0, 0];
    for (let k = 0; k < a.length; k++) {
      const mm = a[k] * (1 - t) + b[k] * t;
      ramp(RAIN_STOPS, rainF(mm), c);
      d[k * 4] = c[0]; d[k * 4 + 1] = c[1]; d[k * 4 + 2] = c[2];
      d[k * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, (mm - 0.15) / 1.2)) * 0.95);
    }
    ov.upload();
    frameLabel = hhmm(frames[Math.round(f)].t);
  }
  const rateAt = (x, y) => {   // latest frame, nearest cell
    const a = fields.at(-1); if (!a) return 0;
    const i = Math.round((x - box[0]) / (box[2] - box[0]) * ov.W - 0.5), j = Math.round((y - box[1]) / (box[3] - box[1]) * ov.H - 0.5);
    return i < 0 || j < 0 || i >= ov.W || j >= ov.H ? 0 : a[j * ov.W + i];
  };

  let clock = 0;
  const api = {
    get on() { return on; },
    legend,
    status: () => (!on ? '' : !fields.length ? (loading ? 'a carregar…' : 'sem radar') : maxNow > 0.1 ? `radar ${frameLabel}` : 'sem chuva'),
    attach(scene) { scene.add(fall.mesh); },
    set(v) {
      on = v; fall.mesh.visible = v;
      if (v) { ov.show(api, { k: 0.85, mode: 1 }); if (!fields.length || performance.now() - loadedAt > 5 * 60e3) load(); }
      else ov.hide(api);
    },
    get busy() { return on && fields.length > 0 && maxNow > 0.1; },
    update(dt) {
      if (!on || !fields.length) return;
      if (performance.now() - loadedAt > 10 * 60e3) load();
      // loop: 2 h of frames in 8 s, then hold on the latest for 3 s
      clock = (clock + dt) % 11;
      const f = Math.min(fields.length - 1, (clock / 8) * (fields.length - 1));
      if (Math.abs(f - shown) > 0.08 || (f === fields.length - 1 && shown !== f)) { shown = f; paint(f); }
      if (maxNow <= 0.1) { fall.mesh.visible = false; return; }
      // falling rain around the view, from cells in the latest frame
      fall.mesh.visible = true;
      const dist = camera.position.distanceTo(controls.target), R = THREE.MathUtils.clamp(dist * 0.9, 250, 3500);
      const cx = controls.target.x, cy = -controls.target.z, top = Math.min(1400, dist * 0.6 + 200), vz = Math.max(9, dist * 0.12), len = vz * 0.12;
      const { A, B, C } = fall;
      for (let k = 0; k < N; k++) {
        if (!alive[k] || fz[k] < ground.at(fx[k], fy[k])) {
          const r = R * Math.sqrt(Math.random()), a = Math.random() * 6.283;
          fx[k] = cx + r * Math.cos(a); fy[k] = cy + r * Math.sin(a); fz[k] = Math.random() * top + 20;
          alive[k] = Math.random() < Math.min(1, rateAt(fx[k], fy[k]) / 3) ? 1 : 0;
          if (!alive[k]) { C[k * 4 + 3] = 0; fz[k] = -1e4; continue; }
        }
        fz[k] -= vz * dt;
        A[k * 3] = fx[k] + 0.2 * len; A[k * 3 + 1] = fz[k] + len; A[k * 3 + 2] = -fy[k];
        B[k * 3] = fx[k]; B[k * 3 + 1] = fz[k]; B[k * 3 + 2] = -fy[k];
        C[k * 4] = 0.82; C[k * 4 + 1] = 0.9; C[k * 4 + 2] = 1; C[k * 4 + 3] = 0.55;
      }
      fall.commit(canvas);
    },
  };
  return api;
}
