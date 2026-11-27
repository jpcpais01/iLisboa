// Live layers: traffic, public transport, aircraft. Self-contained: main.js hands over the scene and calls
// update() once per frame. Traffic and transit are off (and cost nothing) until switched on; planes always fly, and their
// toggle only shows the helper markers (blue dot + trail).
import * as THREE from 'three';
import { createGround } from './ground.js';
import { ribbonUniforms } from './ribbons.js';
import { beaconUniforms } from './beacons.js';
import { createTraffic } from './traffic.js';
import { createTransit } from './transit.js';
import { createPlanes } from './planes.js';
import { createCars } from './cars.js';
import { claimTap, probe } from '../pick.js';
import { registerLayer } from '../layers/registry.js';

const LAYERS = [
  { key: 'traffic', label: 'Trânsito', icon: '<rect x="7.5" y="2.5" width="9" height="19" rx="3"/><circle cx="12" cy="7" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="17" r="1.6"/>' },
  { key: 'transit', label: 'Transportes', icon: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M8 21l1.5-4M16 21l-1.5-4"/><circle cx="8.5" cy="14" r=".6"/><circle cx="15.5" cy="14" r=".6"/>' },
  { key: 'planes', label: 'Marcar aviões', icon: '<path d="M10.5 3.5c0-1 .7-1.5 1.5-1.5s1.5.5 1.5 1.5V9l7 4v2l-7-2v5l2 1.5V21L12 20l-3.5 1v-1.5l2-1.5v-5l-7 2v-2l7-4V3.5z"/>' },
];

export function initLive({ scene, camera, renderer, canvas, ll, bounds, chase, night = { value: 0 }, mobile = false, lod = () => 1 }) {
  const ground = createGround(scene, bounds);
  const ctx = { scene, ground, ll, status: () => renderStatus() };
  const layers = { traffic: createTraffic(ctx), transit: createTransit(ctx), planes: createPlanes(ctx) };
  layers.planes.start();   // aircraft are always in the sky
  // ambient cars: always on, no toggle; their numbers and speeds follow the live traffic
  const cars = createCars({ scene, ground, ll, camera, canvas, night, mobile, lod });

  // ─── UI: each live layer registers with the layer dock (src/layers/registry.js); the dock draws the toggles ───
  const card = document.createElement('div'); card.className = 'live-card'; card.hidden = true; document.body.appendChild(card);
  const legend = document.createElement('div'); legend.className = 'legend-traffic'; legend.innerHTML = '<span>rápido</span><i></i><span>lento</span>';
  const handles = {};
  function renderStatus() { for (const { key } of LAYERS) handles[key]?.refresh(); }
  for (const l of LAYERS) {
    handles[l.key] = registerLayer({
      id: l.key, label: l.label, group: 'live', icon: l.icon, status: () => layers[l.key].status(),
      legend: l.key === 'traffic' ? legend : undefined,
      set: (v) => { layers[l.key].set(v); if (!v && l.key !== 'planes' && card.dataset.k === l.key) { if (followed) stopFollow(); card.hidden = true; } },
    });
  }

  // ─── tap a vehicle, plane or train: the camera follows it in third person, a chip says what it is ───
  let down = null, followed = null, chipT = 0;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 400) return;
    const r = canvas.getBoundingClientRect(), v = new THREE.Vector3();
    let best = null, bd = e.pointerType === 'touch' ? 34 : 26;   // a fingertip is less precise than a cursor
    for (const { key } of [...LAYERS, { key: 'cars' }]) {
      const src = key === 'cars' ? cars : layers[key];
      if (key !== 'cars' && !src.on) continue;
      for (const c of src.pickables()) {
        v.set(...c.pos).project(camera);
        if (v.z > 1) continue;
        const sx = r.left + ((v.x + 1) / 2) * r.width, sy = r.top + ((1 - v.y) / 2) * r.height, d = Math.hypot(sx - e.clientX, sy - e.clientY);
        const dd = key === 'cars' ? d * 1.8 : d;   // a bus, tram or plane wins over a passing car
        if (dd < bd) { bd = dd; best = { ...c, key }; }
      }
    }
    if (!best) { if (!followed) card.hidden = true; return; }   // while following, a stray tap on the map does not end it
    // a passing ambient car only wins over a landmark behind it when the tap is right on it
    if (best.key === 'cars' && bd > 12 && probe('landmark', e.clientX, e.clientY)) return;
    claimTap('live');   // a vehicle wins the tap over a landmark or the ground layers behind it (src/pick.js)
    if (best.id != null && layers[best.key]?.track) startFollow(best.key, best.id);
    else showCard(best.key, best.info(), false);
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && followed) stopFollow(); });

  const pos = new THREE.Vector3();
  function startFollow(key, id) {
    if (followed && followed.key === key && followed.id === id) return;
    const layer = layers[key], first = layer.track(id);
    if (!first) return;
    followed = { key, id, kind: first.kind, route: null };
    const getter = () => {
      const s = followed && followed.key === key && followed.id === id ? layer.track(id) : null;
      if (!s) return null;
      followed.last = s;
      return { pos: pos.set(s.x, s.z, -s.y), heading: s.heading, speed: s.speed };
    };
    chase.follow(getter, { ...first.chase, onLost: () => { if (followed && followed.id === id) { followed = null; card.hidden = true; card.classList.remove('follow'); } } });
    followed.last = first;
    lookupRoute(followed, first);
    renderChip(true);
  }
  function stopFollow() { followed = null; chase.release(); card.hidden = true; card.classList.remove('follow'); }
  // where it is going: flight routes and regional-bus headsigns come from /api/route, once per vehicle
  function lookupRoute(f, s) {
    const i = s.info();
    let q = null;
    if (f.kind === 'plane' && /^[A-Z]{2,3}\d/.test(i.title)) {
      const lat = 38.71375 + s.y / 111010, lon = -9.13975 + s.x / 86870;   // rough is enough: it only disambiguates callsigns
      q = `call=${encodeURIComponent(i.title)}&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`;
    }
    else if (i.pattern && !i.dest) q = `pattern=${encodeURIComponent(i.pattern)}`;
    if (!q) return;
    fetch(`/api/route?${q}`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d || followed !== f) return;
      if (d.to) f.route = d;
      if (d.headsign) i.setDest?.(d.headsign);
      renderChip(true);
    }).catch(() => {});
  }
  function renderChip(rebuild) {
    if (!followed || !followed.last) return;
    const s = followed.last, i = s.info();
    if (followed.route) {
      const { from, to, plausible } = followed.route;
      i.sub = `${from.iata} → ${to.iata} · ${to.name || to.airport}${plausible ? '' : ' (provável)'}${i.sub ? ' · ' + i.sub : ''}`;
    }
    if (!i.speedKnown && s.kind !== 'plane' && chase.speed > 0.3) i.lines.unshift(`≈ ${Math.round(chase.speed * 3.6)} km/h`);
    if (s.x < bounds.minX - 300 || s.x > bounds.maxX + 300 || s.y < bounds.minY - 300 || s.y > bounds.maxY + 300) i.lines.push('fora do mapa 3D');
    if (rebuild || card.dataset.id !== String(followed.id)) showCard(followed.key, i, true);
    else {
      card.querySelector('.ti').textContent = i.title; card.querySelector('small').textContent = i.sub || '';
      card.querySelector('.ln').innerHTML = i.lines.map((l) => `<span>${esc(l)}</span>`).join('');
    }
  }
  function showCard(key, i, follow) {
    card.dataset.k = key; card.dataset.id = follow ? String(followed.id) : '';
    card.classList.toggle('follow', follow);
    card.innerHTML = `<b class="i">${i.icon}</b><div><b class="ti">${esc(i.title)}</b><small>${esc(i.sub || '')}</small><p class="ln">${i.lines.map((l) => `<span>${esc(l)}</span>`).join('')}</p><em>${esc(i.src)}</em></div>`
      + (follow ? '<button type="button" class="exit" aria-label="Deixar de seguir"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg><span>Sair</span></button>'
        : '<button type="button" class="x" aria-label="Fechar">×</button>');
    card.hidden = false;
    card.querySelector('button').onclick = () => { if (follow) stopFollow(); else card.hidden = true; };
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let lastStatus = 0, last = 0;
  return {
    // called on every rendered frame; the viewer renders at a lower rate when still, so time is measured here
    update(_dt, now) {
      const dt = Math.min(0.5, last ? (now - last) / 1000 : 0); last = now;
      ground.scan(now);
      cars.update(dt, now);
      const any = layers.traffic.on || layers.transit.on || layers.planes.on;
      if (!any) return;
      // on-screen widths: metres per CSS pixel at unit distance
      ribbonUniforms.uPx.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, canvas.clientHeight);
      beaconUniforms.uDpr.value = renderer.getPixelRatio();
      for (const l of Object.values(layers)) l.update(dt, now);
      if (followed && now - chipT > 500) { chipT = now; renderChip(false); }
      if (now - lastStatus > 5000) { lastStatus = now; renderStatus(); }
    },
    layers, ground, cars,
    get following() { return followed && { key: followed.key, id: followed.id }; },
    follow: startFollow, unfollow: stopFollow,
    // moving things on screen: the viewer keeps full frame rate (traffic alone is static and needs none)
    // without markers, planes ride the still-view cadence (a plane kilometres away moves well under a pixel per frame)
    get busy() { return layers.transit.on || layers.planes.markers; },
  };
}
