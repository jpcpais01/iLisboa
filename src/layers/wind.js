// Vento: thousands of short streaks drifting over the roofs along the model's 10 m wind (Open-Meteo lattice,
// interpolated), coloured by its real speed. Real wind would barely move on a city-wide view, so the streaks run
// time-lapsed: the factor grows with the view distance and the legend says it. One instanced draw; every streak
// is a screen-facing quad from its tail to its head, a few pixels wide at any zoom.
import * as THREE from 'three';
import { ramp, rampCss } from './palette.js';
import { createStreaks } from './streaks.js';

export const WIND_STOPS = ['#e8f6ff', '#9fd8ff', '#5fb7f0', '#57d39a', '#d8e24a', '#f6a23c', '#ef5a3c', '#c2307a'];
const KMH_MAX = 60;

export function createWind({ weather, ground, camera, controls, canvas, mobile }) {
  const N = mobile ? 1400 : 3600;
  const st = createStreaks(N, mobile ? 1.9 : 1.6), { mesh, A, B, C } = st;
  mesh.name = 'wind';

  const px = new Float32Array(N), py = new Float32Array(N), age = new Float32Array(N), life = new Float32Array(N);
  const w = [0, 0], col = [0, 0, 0];
  let on = false, R = 2000, cx = 0, cy = 0, scale = 60;
  const legend = document.createElement('div'); legend.className = 'wx-legend';
  function spawn(k, anywhere) {
    const r = R * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    px[k] = cx + r * Math.cos(a); py[k] = cy + r * Math.sin(a);
    life[k] = 2.5 + Math.random() * 3; age[k] = anywhere ? Math.random() * life[k] : 0;
  }
  function frameView() {
    const dist = camera.position.distanceTo(controls.target);
    R = THREE.MathUtils.clamp(dist * 1.1, 500, 9000);
    cx = controls.target.x; cy = -controls.target.z;
    scale = THREE.MathUtils.clamp(dist * 0.045, 12, 320);   // time-lapse: streaks cross the view in a few seconds
  }
  function writeLegend() {
    const c = weather.data?.current;
    const dir = c ? ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(c.wind_direction_10m / 45) % 8] : '';
    legend.innerHTML = `<div class="bar" style="background:${rampCss(WIND_STOPS)}"></div><div class="ends"><span>0</span><span>${KMH_MAX} km/h</span></div>`
      + `<small>${c ? `${Math.round(c.wind_speed_10m)} km/h de ${dir}, rajadas ${Math.round(c.wind_gusts_10m ?? 0)} · ` : ''}vento a 10 m do modelo (Open-Meteo), acelerado ×${Math.round(scale)}</small>`;
  }
  let legendScale = 0;

  return {
    get on() { return on; },
    legend,
    status: () => { const c = weather.data?.current; return on && c ? `${Math.round(c.wind_speed_10m)} km/h` : ''; },
    attach(scene) { scene.add(mesh); },
    set(v) {
      on = v; mesh.visible = v;
      if (v) { frameView(); for (let k = 0; k < N; k++) spawn(k, true); writeLegend(); }
    },
    get busy() { return on; },
    update(dt) {
      if (!on || !weather.ready()) { mesh.visible = false; return; }
      mesh.visible = true;
      frameView();
      if (Math.abs(scale - legendScale) / scale > 0.25) { legendScale = scale; writeLegend(); }
      const lift = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.02, 35, 160);
      const trail = 0.22, R2 = R * R * 1.1;
      for (let k = 0; k < N; k++) {
        age[k] += dt;
        if (age[k] > life[k] || (px[k] - cx) ** 2 + (py[k] - cy) ** 2 > R2) spawn(k, false);
        weather.wind(px[k], py[k], w);
        const sp = Math.hypot(w[0], w[1]);
        px[k] += w[0] * scale * dt; py[k] += w[1] * scale * dt;
        const z = Math.max(0, ground.at(px[k], py[k])) + lift;
        // head now, tail where it was `trail` seconds ago (at the same lift: the streak lies flat over the hills)
        B[k * 3] = px[k]; B[k * 3 + 1] = z; B[k * 3 + 2] = -py[k];
        A[k * 3] = px[k] - w[0] * scale * trail; A[k * 3 + 1] = z; A[k * 3 + 2] = -(py[k] - w[1] * scale * trail);
        ramp(WIND_STOPS, (sp * 3.6) / KMH_MAX, col);
        const fade = Math.min(1, age[k] / 0.6, (life[k] - age[k]) / 0.8);
        C[k * 4] = col[0] / 255; C[k * 4 + 1] = col[1] / 255; C[k * 4 + 2] = col[2] / 255; C[k * 4 + 3] = 0.8 * fade;
      }
      st.commit(canvas);
    },
  };
}
