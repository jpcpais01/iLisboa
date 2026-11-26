// Temperatura: the whole city tinted like a thermal photo, isotherms every half degree, and the measured IPMA readings
// pinned where the stations stand. Colour stretches over today's spread across the map (a city varies by 2–5 °C,
// a fixed −10…40 °C scale would paint it one flat colour); the legend gives the real numbers.
import { createOverlay } from './overlay.js';
import { ramp, rampCss } from './palette.js';

export const TEMP_STOPS = ['#3b3fb5', '#2f78e0', '#1db2d6', '#2fc79a', '#94d24a', '#efd03a', '#f79a2b', '#e5502a', '#b11f2e'];

// 'Lisboa (Geofísico)' → 'Geofísico', 'Lisboa, Carnide (CML)' → 'Carnide', 'Barreiro, Lavradio' stays
export const stationName = (n) => n.replace(/^Lisboa \((.*)\)$/, '$1').replace(/^Lisboa,\s*/, '').replace(/\s*\((CML|CMO|LFCL)\)/, '');

export function createTemperature({ weather, ground, bounds, labels, box }) {
  const ov = createOverlay(box, 400, 316);   // ~60 m cells: the field is smooth, the terrain term gives it its grain
  const legend = document.createElement('div'); legend.className = 'wx-legend';
  let on = false, painted = -1, lo = 0, hi = 1, tMin = 0, tMax = 0, groundVer = -1, paintT = 0;
  const fmt = (t) => t.toLocaleString('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function paint() {
    if (!weather.ready()) return false;
    const { W, H, data } = ov, T = new Float32Array(W * H);
    let a = Infinity, b = -Infinity;
    for (let j = 0; j < H; j++) {
      const y = ov.y(j);
      for (let i = 0; i < W; i++) {
        const x = ov.x(i), t = weather.temp(x, y, Math.max(0, ground.at(x, y)));
        T[j * W + i] = t;
        if (x > bounds.minX && x < bounds.maxX && y > bounds.minY && y < bounds.maxY) { if (t < a) a = t; if (t > b) b = t; }
      }
    }
    tMin = a; tMax = b;
    const mid = (a + b) / 2, span = Math.max(2, b - a + 0.4);
    lo = mid - span / 2; hi = mid + span / 2;
    const c = [0, 0, 0];
    for (let k = 0; k < W * H; k++) {
      const f = Math.min(1, Math.max(0, (T[k] - lo) / (hi - lo)));
      ramp(TEMP_STOPS, f, c);
      data[k * 4] = c[0]; data[k * 4 + 1] = c[1]; data[k * 4 + 2] = c[2]; data[k * 4 + 3] = Math.round(f * 255);
    }
    ov.upload();
    const d = weather.data, st = weather.stations;
    legend.innerHTML = `<div class="bar" style="background:${rampCss(TEMP_STOPS)}"></div><div class="ends"><span>${fmt(lo)} °C</span><span>${fmt(hi)} °C</span></div>`
      + `<small>isotérmicas de 0,5 °C · ${st.length} estações IPMA medidas, resto interpolado do modelo (Open-Meteo) com o relevo</small>`;
    labels.set(st.map((s) => ({
      x: s.x, y: s.y, z: ground.at(s.x, s.y) + 25, maxD: 12000, cls: 'wx-st',
      html: `<b>${fmt(s.T)}°</b><span>${stationName(s.name)}</span>`,
    })));
    painted = d.t; groundVer = ground.version; paintT = performance.now();
    return true;
  }
  function show() { ov.show(api, { k: 0.78, lev: (hi - lo) / 0.5, mode: 0 }); }

  const api = {
    get on() { return on; },
    legend,
    set(v) {
      on = v; labels.show(v);
      if (v) { if (painted !== weather.data?.t) paint(); show(); } else ov.hide(api);
    },
    status: () => (on && painted > 0 ? `${fmt(tMin)} a ${fmt(tMax)} °C` : ''),
    // repaint when new readings arrive or more terrain has loaded
    tick() {
      if (!on) return false;
      if (painted !== weather.data?.t || (ground.version !== groundVer && performance.now() - paintT > 20000)) {
        if (paint()) { show(); return true; }
      }
      return false;
    },
  };
  return api;
}
