// Map layers: weather (Temperatura, Vento, Chuva) and city (Freguesias, Densidade). Registered in the layer dock;
// each costs nothing until switched on. main.js calls update() on every rendered frame and keeps full frame rate
// while busy (the wind and the rain move).
import './overlay.js';
import { overlayUniforms } from '../materials.js';
import { registerLayer } from './registry.js';
import { createWeather } from './weather.js';
import { createLabels } from './labels.js';
import { createTemperature } from './temperature.js';
import { createWind } from './wind.js';
import { createRain } from './rain.js';
import { createRegions } from './freguesias.js';

const ICON = {
  temp: '<path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 11v6"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
  rain: '<path d="M7 15a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 7.5a4 4 0 0 1-.5 7.5"/><path d="M9 17l-1 3M13 17l-1 3M17 17l-1 3"/>',
  frg: '<path d="M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2z"/><path d="M9 4v14M15 6v14"/>',
  dens: '<circle cx="8" cy="8" r="2.2"/><circle cx="16" cy="8" r="2.2"/><circle cx="12" cy="15" r="2.2"/><path d="M4 20c.6-2 2-3 4-3M20 20c-.6-2-2-3-4-3"/>',
};

export function initLayers({ scene, camera, controls, canvas, ground, bounds, mobile, night = { value: 0 }, sky = null, hud = null, invalidate = () => {} }) {
  const box = [-14500, -8800, 11000, 11600];   // the 36 areas and a margin, local metres
  const weather = createWeather(); weather.setGround(ground);
  const card = createCard();
  const labels = { t: createLabels(camera, canvas, 'wx'), f: createLabels(camera, canvas, 'frg'), d: createLabels(camera, canvas, 'dens') };
  const temp = createTemperature({ weather, ground, bounds, labels: labels.t, box });
  const wind = createWind({ weather, ground, camera, controls, canvas, mobile }); wind.attach(scene);
  const rain = createRain({ ground, camera, controls, canvas, box, mobile }); rain.attach(scene);
  const regions = createRegions({ ground, camera, controls, canvas, labelsF: labels.f, labelsD: labels.d, box, mobile, card }); regions.attach(scene);

  const h = {};
  const reg = (id, label, group, icon, l, extra = {}) => { h[id] = registerLayer({ id, label, group, icon, set: (v) => { l.set(v); invalidate(); }, status: l.status, legend: l.legend, ...extra }); };
  reg('temperatura', 'Temperatura', 'weather', ICON.temp, temp, { exclusive: 'map' });
  reg('vento', 'Vento', 'weather', ICON.wind, wind);
  reg('chuva', 'Chuva', 'weather', ICON.rain, rain, { exclusive: 'map' });
  reg('freguesias', 'Freguesias', 'city', ICON.frg, regions.freguesias);
  reg('densidade', 'Densidade', 'city', ICON.dens, regions.densidade, { exclusive: 'map' });
  weather.on(() => { for (const k in h) h[k].refresh(); });

  // the sky's clouds follow the real cloud cover: now when the clock is live, the forecast hour when the slider is moved
  const pinned = new URLSearchParams(location.search).has('clouds');
  let cover = null, coverT = 0;
  function cloudTarget() {
    const d = weather.data; if (!d) return null;
    if (!hud || hud.live()) return d.current?.cloud_cover ?? null;
    const hr = d.hourly; if (!hr?.cloud_cover) return d.current?.cloud_cover ?? null;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date()), h = hud.hour();
    const i0 = hr.time.indexOf(`${day}T${String(Math.floor(h) % 24).padStart(2, '0')}:00`);
    if (i0 < 0) return d.current?.cloud_cover ?? null;
    const i1 = Math.min(i0 + 1, hr.time.length - 1), f = h - Math.floor(h);
    return hr.cloud_cover[i0] + (hr.cloud_cover[i1] - hr.cloud_cover[i0]) * f;
  }
  let st = 0;
  return {
    weather,
    get busy() { return wind.busy || rain.busy; },
    update(dt, now) {
      overlayUniforms.uOvLift.value = night.value * 0.045;
      if (sky && !pinned && now - coverT > 500) {
        coverT = now;
        const c = cloudTarget();
        if (c != null) {
          const u = coverOf(c / 100);
          cover = cover == null ? u : cover + (u - cover) * 0.25;   // eases over a couple of seconds when the slider jumps
          sky.clouds = cover;
        }
      }
      if (temp.tick()) h.temperatura.refresh();
      wind.update(dt); rain.update(dt); regions.update();
      for (const l of Object.values(labels)) l.update();
      if (now - st > 3000) { st = now; h.chuva.refresh(); h.vento.refresh(); }
    },
  };
}

// sky.js draws its deck where a 4-octave value noise exceeds 1 − uCover, with a soft edge. This table (Monte Carlo over
// that same noise and ramp) gives the uCover whose mean cloud opacity equals each tenth of reported cloud cover.
const COVER = [0, 0.498, 0.567, 0.621, 0.668, 0.713, 0.76, 0.81, 0.871, 0.955, 1.15];
function coverOf(f) {
  const x = Math.min(1, Math.max(0, f)) * 10, i = Math.min(9, Math.floor(x));
  return COVER[i] + (COVER[i + 1] - COVER[i]) * (x - i);
}

// a small card for a picked freguesia (or anything else the layers want to say about a place)
function createCard() {
  const el = document.createElement('div'); el.className = 'map-card'; el.hidden = true; document.body.appendChild(el);
  let onClose = null;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return {
    show({ title, sub, rows, src, onClose: oc }) {
      onClose = oc;
      el.innerHTML = `<button type="button" class="x" aria-label="Fechar">×</button><b class="ti">${esc(title)}</b><small>${esc(sub || '')}</small>`
        + `<dl>${rows.map(([k, v]) => `<div${k ? '' : ' class="note"'}><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><em>${esc(src || '')}</em>`;
      el.hidden = false;
      el.querySelector('.x').onclick = () => { el.hidden = true; onClose?.(); };
    },
    hide() { el.hidden = true; },
  };
}
