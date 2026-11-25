// Live layers: traffic, public transport, aircraft. Self-contained: main.js hands over the scene and calls
// update() once per frame. Every layer is off (and costs nothing) until its toggle is switched on.
import * as THREE from 'three';
import { createGround } from './ground.js';
import { ribbonUniforms } from './ribbons.js';
import { beaconUniforms } from './beacons.js';
import { createTraffic } from './traffic.js';
import { createTransit } from './transit.js';
import { createPlanes } from './planes.js';

const LAYERS = [
  { key: 'traffic', label: 'Trânsito', icon: '<rect x="7.5" y="2.5" width="9" height="19" rx="3"/><circle cx="12" cy="7" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="17" r="1.6"/>' },
  { key: 'transit', label: 'Transportes', icon: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M8 21l1.5-4M16 21l-1.5-4"/><circle cx="8.5" cy="14" r=".6"/><circle cx="15.5" cy="14" r=".6"/>' },
  { key: 'planes', label: 'Aviões', icon: '<path d="M10.5 3.5c0-1 .7-1.5 1.5-1.5s1.5.5 1.5 1.5V9l7 4v2l-7-2v5l2 1.5V21L12 20l-3.5 1v-1.5l2-1.5v-5l-7 2v-2l7-4V3.5z"/>' },
];

export function initLive({ scene, camera, renderer, canvas, ll, bounds }) {
  const ground = createGround(scene, bounds);
  const ctx = { scene, ground, ll, status: () => renderStatus() };
  const layers = { traffic: createTraffic(ctx), transit: createTransit(ctx), planes: createPlanes(ctx) };

  // ─── UI: a stack of toggles, a status line under each, a traffic legend ───
  const panel = document.createElement('nav');
  panel.className = 'live'; panel.setAttribute('aria-label', 'Camadas ao vivo');
  panel.innerHTML = LAYERS.map((l) => `<button type="button" data-k="${l.key}" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true">${l.icon}</svg><span class="t">${l.label}</span><span class="s"></span></button>`).join('')
    + '<div class="legend" hidden><span>rápido</span><i></i><span>lento</span></div>';
  document.body.appendChild(panel);
  const card = document.createElement('div'); card.className = 'live-card'; card.hidden = true; document.body.appendChild(card);
  const btn = (k) => panel.querySelector(`[data-k="${k}"]`);
  function renderStatus() {
    for (const { key } of LAYERS) btn(key).querySelector('.s').textContent = layers[key].status();
    panel.querySelector('.legend').hidden = !layers.traffic.on;
  }
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('ilisboa.live') || '[]'); } catch { /* private mode */ }
  const fromUrl = new URLSearchParams(location.search).get('live');
  const initial = fromUrl != null ? fromUrl.split(',') : saved;
  function toggle(k, v = !layers[k].on) {
    layers[k].set(v); btn(k).setAttribute('aria-pressed', String(v));
    try { localStorage.setItem('ilisboa.live', JSON.stringify(LAYERS.map((l) => l.key).filter((x) => layers[x].on))); } catch { /* ignore */ }
    if (!v && card.dataset.k === k) card.hidden = true;
    renderStatus();
  }
  panel.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) toggle(b.dataset.k); });
  for (const k of initial) if (layers[k]) toggle(k, true);

  // ─── tap a vehicle or plane to see what it is ───
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 400) return;
    const r = canvas.getBoundingClientRect(), v = new THREE.Vector3();
    let best = null, bd = 26;
    for (const { key } of LAYERS) {
      if (!layers[key].on) continue;
      for (const c of layers[key].pickables()) {
        v.set(...c.pos).project(camera);
        if (v.z > 1) continue;
        const sx = r.left + ((v.x + 1) / 2) * r.width, sy = r.top + ((1 - v.y) / 2) * r.height, d = Math.hypot(sx - e.clientX, sy - e.clientY);
        if (d < bd) { bd = d; best = { ...c, key }; }
      }
    }
    if (!best) { card.hidden = true; return; }
    const i = best.info();
    card.dataset.k = best.key;
    card.innerHTML = `<b class="i">${i.icon}</b><div><b>${esc(i.title)}</b><small>${esc(i.sub || '')}</small>${i.lines.map((l) => `<span>${esc(l)}</span>`).join('')}<em>${esc(i.src)}</em></div><button type="button" aria-label="Fechar">×</button>`;
    card.hidden = false;
    card.querySelector('button').onclick = () => { card.hidden = true; };
  });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let lastStatus = 0, last = 0;
  return {
    // called on every rendered frame; the viewer renders at a lower rate when still, so time is measured here
    update(_dt, now) {
      const dt = Math.min(0.5, last ? (now - last) / 1000 : 0); last = now;
      const any = layers.traffic.on || layers.transit.on || layers.planes.on;
      if (!any) return;
      ground.scan(now);
      // on-screen widths: metres per CSS pixel at unit distance
      ribbonUniforms.uPx.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, canvas.clientHeight);
      beaconUniforms.uDpr.value = renderer.getPixelRatio();
      for (const l of Object.values(layers)) l.update(dt, now);
      if (now - lastStatus > 5000) { lastStatus = now; renderStatus(); }
    },
    layers,
  };
}
