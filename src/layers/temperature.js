// Temperatura: the whole city tinted like a thermal photo, isotherms every half degree, and the measured IPMA readings
// pinned where the stations stand. Colour stretches over today's spread across the map (a city varies by 2–5 °C,
// a fixed −10…40 °C scale would paint it one flat colour); the legend gives the real numbers.
import { createOverlay } from './overlay.js';
import { ramp, rampCss } from './palette.js';

export const TEMP_STOPS = ['#3b3fb5', '#2f78e0', '#1db2d6', '#2fc79a', '#94d24a', '#efd03a', '#f79a2b', '#e5502a', '#b11f2e'];

// 'Lisboa (Geofísico)' → 'Geofísico', 'Lisboa, Carnide (CML)' → 'Carnide', 'Barreiro, Lavradio' stays
export const stationName = (n) => n.replace(/^Lisboa \((.*)\)$/, '$1').replace(/^Lisboa,\s*/, '').replace(/\s*\((CML|CMO|LFCL)\)/, '');

// one scalar weather field painted over the city: colour stretched over the map's own spread, contour lines every `step`,
// measured station values pinned. Temperature and humidity share it.
function createScalar({ weather, ground, bounds, labels, box, field, ok = () => true, stops, step, minSpan, max = Infinity, fmt, unit, stationValue, note }) {
  const ov = createOverlay(box, 400, 316);   // ~60 m cells: the fields are smooth, the terrain term gives them their grain
  const legend = document.createElement('div'); legend.className = 'wx-legend';
  let on = false, painted = -1, lo = 0, hi = 1, tMin = 0, tMax = 0, groundVer = -1, paintT = 0;

  function paint() {
    if (!weather.ready() || !ok()) return false;
    const { W, H, data } = ov, T = new Float32Array(W * H);
    let a = Infinity, b = -Infinity;
    for (let j = 0; j < H; j++) {
      const y = ov.y(j);
      for (let i = 0; i < W; i++) {
        const x = ov.x(i), t = field(x, y, Math.max(0, ground.at(x, y)));
        T[j * W + i] = t;
        if (x > bounds.minX && x < bounds.maxX && y > bounds.minY && y < bounds.maxY) { if (t < a) a = t; if (t > b) b = t; }
      }
    }
    tMin = a; tMax = b;
    const mid = (a + b) / 2, span = Math.max(minSpan, b - a + step * 0.8);
    lo = mid - span / 2; hi = mid + span / 2;
    if (hi > max) { lo -= hi - max; hi = max; }   // humidity tops out at 100 %: slide the window down instead
    const c = [0, 0, 0];
    for (let k = 0; k < W * H; k++) {
      const f = Math.min(1, Math.max(0, (T[k] - lo) / (hi - lo)));
      ramp(stops, f, c);
      data[k * 4] = c[0]; data[k * 4 + 1] = c[1]; data[k * 4 + 2] = c[2]; data[k * 4 + 3] = Math.round(f * 255);
    }
    ov.upload();
    const st = weather.stations.filter((q) => stationValue(q) != null);
    legend.innerHTML = `<div class="bar" style="background:${rampCss(stops)}"></div><div class="ends"><span>${fmt(lo)} ${unit}</span><span>${fmt(hi)} ${unit}</span></div>`
      + `<small>${note(st.length)}</small>`;
    labels.set(st.map((q) => ({
      x: q.x, y: q.y, z: ground.at(q.x, q.y) + 25, maxD: 12000, cls: 'wx-st',
      html: `<b>${fmt(stationValue(q))}${unit === '°C' ? '°' : ' ' + unit}</b><span>${stationName(q.name)}</span>`,
    })));
    painted = weather.data.t; groundVer = ground.version; paintT = performance.now();
    return true;
  }
  function show() { ov.show(api, { k: 0.78, lev: (hi - lo) / step, mode: 0 }); }

  const api = {
    get on() { return on; },
    legend,
    set(v) {
      on = v; labels.show(v);
      if (v) { if (painted !== weather.data?.t) paint(); show(); } else ov.hide(api);
    },
    status: () => (on && painted > 0 ? `${fmt(tMin)} a ${fmt(tMax)} ${unit}` : ''),
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

const fmt1 = (t) => t.toLocaleString('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function createTemperature(o) {
  return createScalar({ ...o, field: o.weather.temp, stops: TEMP_STOPS, step: 0.5, minSpan: 2, fmt: fmt1, unit: '°C', stationValue: (q) => q.T,
    note: (n) => `isotérmicas de 0,5 °C · ${n} estações IPMA medidas, resto interpolado do modelo (Open-Meteo) com o relevo` });
}

// dry sand → fresh green → sea blue
export const HUM_STOPS = ['#b5763a', '#d9a75c', '#ecd58f', '#cfe6b0', '#8fd0c0', '#4aaecb', '#2f7fbf', '#27509a', '#1f2f6e'];
export function createHumidity(o) {
  return createScalar({ ...o, field: o.weather.humidity, ok: () => o.weather.hasHumidity, stops: HUM_STOPS, step: 2, minSpan: 12, max: 100,
    fmt: (v) => String(Math.round(v)), unit: '%', stationValue: (q) => q.hum,
    note: (n) => `humidade relativa, linhas de 2 % · ${n} estações IPMA medidas; entre elas, o ponto de orvalho do modelo (Open-Meteo) sobre a temperatura local`,
  });
}
