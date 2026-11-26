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

export function initLayers({ scene, camera, controls, canvas, ground, bounds, mobile, night = { value: 0 }, invalidate = () => {} }) {
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

  let st = 0;
  return {
    weather,
    get busy() { return wind.busy || rain.busy; },
    update(dt, now) {
      overlayUniforms.uOvLift.value = night.value * 0.045;
      if (temp.tick()) h.temperatura.refresh();
      wind.update(dt); rain.update(dt); regions.update();
      for (const l of Object.values(labels)) l.update();
      if (now - st > 3000) { st = now; h.chuva.refresh(); h.vento.refresh(); }
    },
  };
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
