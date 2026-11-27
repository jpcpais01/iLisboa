// Bus stops and Metro stations: true-scale street furniture (pole + flag, glass shelters where OSM maps one,
// Metro stairwells with the red-M totem) plus a small pin so a stop still reads from a few hundred metres up.
// Hover lights a pin; a tap opens the station card with the next arrivals per line:
//  · buses (Carris, Carris Metropolitana): timetable + live GPS, see eta.js — "ao vivo" vs "horário"
//  · Metro: the Metro publishes no train positions, so its times come from the same typical-timetable model that
//    drives the Metro trains on the map — always labelled "estimado".
// Cost: three instanced meshes + two point clouds, rebuilt only when the camera moves 40 m; nothing beyond ~650 m.
import * as THREE from 'three';
import { stopPoleGeometry, shelterGeometry, metroEntranceGeometry } from './models.js';
import { createBeacons } from '../live/beacons.js';
import { loadNetwork } from '../live/network.js';
import { registerLayer } from '../layers/registry.js';
import { claimTap, tapClaimed, setProbe } from '../pick.js';
import { createEta, prepRoute } from '../../api/_lib/eta.js';

const R_MODEL = 650, R_PIN = 1500, R_METRO = 4200;   // m from the camera
const MAXM = 1500;
const OPNAME = { c: 'Carris', m: 'Carris Metropolitana' };
const PIN_BUS = new THREE.Color(0x1f4e9c), PIN_METRO = new THREE.Color(0xd22a1f), HOVER = new THREE.Color(0xffffff);
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function initStations({ scene, camera, canvas, live, mobile = false, invalidate = () => {} }) {
  const ground = live.ground, transit = live.layers.transit;
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 });
  const mk = (g, n) => { const m = new THREE.InstancedMesh(g, mat, n); m.count = 0; m.frustumCulled = false; m.receiveShadow = true; group.add(m); return m; };
  const poles = mk(stopPoleGeometry(), MAXM), shelters = mk(shelterGeometry(), MAXM), entrances = mk(metroEntranceGeometry(), 300);
  const busPins = createBeacons(2600, { size: 10, lift: 3.6 }), metroPins = createBeacons(120, { size: 15, lift: 6 });
  group.add(busPins.obj, metroPins.obj);

  let on = false, data = null, loading = null, stations = null, placedV = -1, lastCam = new THREE.Vector3(1e9, 0, 0);
  const vis = [];   // what's pickable now: { kind: 'bus' | 'metro', g, x, y, z }

  // ─── data ───
  function load() {
    return (loading ||= Promise.all([
      fetch('/transit/stops.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/transit/osm.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      loadNetwork().catch(() => null),
    ]).then(([st, osm, net]) => {
      // one marker per kerbside stop: Carris and Carris Metropolitana often share a pole under the same name
      const groups = [], cell = new Map(), C = 25;
      for (const [key, name, x, y, routes] of st?.stops || []) {
        const op = key[0], id = key.slice(2), nn = norm(name);
        let g = null;
        const cx = Math.floor(x / C), cy = Math.floor(y / C);
        for (let i = -1; i <= 1 && !g; i++) for (let j = -1; j <= 1 && !g; j++) for (const h of cell.get(`${cx + i},${cy + j}`) || []) if (h.nn === nn && Math.hypot(h.x - x, h.y - y) < 14 && !h.m.some((m) => m.op === op)) { g = h; break; }
        if (!g) { g = { x, y, name, nn, m: [] }; groups.push(g); (cell.get(`${cx},${cy}`) || cell.set(`${cx},${cy}`, []).get(`${cx},${cy}`)).push(g); }
        g.m.push({ op, id, routes });
      }
      // kerb direction + shelter from the OSM stop within 20 m, else the nearest street of the network
      const oc = new Map();
      for (const s of osm?.s || []) { const k = `${Math.floor(s[0] / C)},${Math.floor(s[1] / C)}`; (oc.get(k) || oc.set(k, []).get(k)).push(s); }
      for (const g of groups) {
        let best = null, bd = 20;
        const cx = Math.floor(g.x / C), cy = Math.floor(g.y / C);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const s of oc.get(`${cx + i},${cy + j}`) || []) { const d = Math.hypot(s[0] - g.x, s[1] - g.y); if (d < bd) { bd = d; best = s; } }
        g.shelter = best ? best[3] : 0;
        let a = best ? best[2] : 0, side = null;
        const sn = net && net.snap(g.x, g.y, false, 30);
        if (sn) { if (!best) a = Math.atan2(sn.uy, sn.ux); const nx = g.x - sn.x, ny = g.y - sn.y; if (Math.hypot(nx, ny) > 0.8) side = [nx, ny]; }
        // local +z (away from the road) is the right-hand normal of the kerb direction
        if (side && Math.sin(a) * side[0] - Math.cos(a) * side[1] < 0) a += Math.PI;
        g.a = a;
        if (sn && side) { const L = Math.hypot(...side); if (L < 3.5) { g.x = sn.x + (side[0] / L) * 3.5; g.y = sn.y + (side[1] / L) * 3.5; } }   // onto the pavement, not the lane
      }
      data = { groups, ent: osm?.e || [], routes: st?.routes || {}, built: st?.built };
      placedV = -1; lastCam.set(1e9, 0, 0);
      handle?.refresh();
      return data;
    }));
  }

  // ─── place what's near the camera ───
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), WHITE = new THREE.Color(1, 1, 1);
  let hover = null, selected = null;
  function place() {
    if (!data) return;
    if (!stations) { stations = transit.metroStations(); if (stations) for (const s of stations) s.ent = []; if (stations) for (const e of data.ent) { let b = null, bd = 450; for (const s of stations) { const d = Math.hypot(s.x - e[0], s.y - e[1]) - (norm(s.name) === norm(e[3]) ? 300 : 0); if (d < bd) { bd = d; b = s; } } if (b) b.ent.push(e); } }
    const cx = camera.position.x, cy = -camera.position.z, ch = Math.max(0, camera.position.y - ground.at(cx, cy));
    const far = ch > 2600;   // very high up the pins would be noise
    let np = 0, ns = 0, ne = 0;
    vis.length = 0;
    busPins.begin(); metroPins.begin();
    if (!far) for (const g of data.groups) {
      const d = Math.hypot(g.x - cx, g.y - cy, ch);
      if (d > R_PIN) continue;
      const z = ground.at(g.x, g.y);
      vis.push({ kind: 'bus', g, x: g.x, y: g.y, z });
      const lit = g === hover || g === selected;
      busPins.push(g.x, z, -g.y, lit ? HOVER : PIN_BUS, lit ? 1.6 : 1);
      if (d > R_MODEL) continue;
      q.setFromAxisAngle(up, g.a);
      m4.compose(p.set(g.x, z, -g.y), q, one);
      if (np < MAXM) { poles.setMatrixAt(np, m4); poles.setColorAt(np, g.m[0].op === 'c' ? COL_C : COL_M); np++; }
      if (g.shelter && ns < MAXM) {   // the shelter stands a step behind the pole, back to the buildings
        m4.compose(p.set(g.x + Math.sin(g.a) * 0.6 + Math.cos(g.a) * 1.4, z, -(g.y - Math.cos(g.a) * 0.6 + Math.sin(g.a) * 1.4)), q, one);
        shelters.setMatrixAt(ns, m4); shelters.setColorAt(ns, WHITE); ns++;
      }
    }
    for (const s of stations || []) {
      const d = Math.hypot(s.x - cx, s.y - cy, ch);
      if (d > R_METRO) continue;
      const z = ground.at(s.x, s.y);
      vis.push({ kind: 'metro', g: s, x: s.x, y: s.y, z });
      const lit = s === hover || s === selected;
      metroPins.push(s.x, z, -s.y, lit ? HOVER : PIN_METRO, lit ? 1.35 : 1);
      for (const e of s.ent) {
        if (Math.hypot(e[0] - cx, e[1] - cy, ch) > R_MODEL || ne >= 300) continue;
        const ez = ground.at(e[0], e[1]);
        q.setFromAxisAngle(up, e[2]); m4.compose(p.set(e[0], ez, -e[1]), q, one);
        entrances.setMatrixAt(ne, m4); entrances.setColorAt(ne, WHITE); ne++;
        vis.push({ kind: 'metro', g: s, x: e[0], y: e[1], z: ez });
      }
    }
    busPins.end(); metroPins.end();
    poles.count = np; shelters.count = ns; entrances.count = ne;
    for (const x of [poles, shelters, entrances]) { x.instanceMatrix.needsUpdate = true; if (x.instanceColor) x.instanceColor.needsUpdate = true; }
    placedV = ground.version; lastCam.copy(camera.position);
  }
  const COL_C = new THREE.Color(0xf6c21c), COL_M = new THREE.Color(0xffd800);

  // ─── picking ───
  const v3 = new THREE.Vector3();
  function pick(x, y, touch) {
    if (!on || !vis.length) return null;
    const r = canvas.getBoundingClientRect();
    let best = null, bd = touch ? 30 : 20;
    for (const c of vis) {
      v3.set(c.x, c.z + (c.kind === 'metro' ? 6 : 3.6), -c.y).project(camera);
      if (v3.z > 1) continue;
      const sx = r.left + ((v3.x + 1) / 2) * r.width, sy = r.top + ((1 - v3.y) / 2) * r.height;
      const d = Math.hypot(sx - x, sy - y) * (c.kind === 'metro' ? 0.8 : 1);   // the station wins over a bus stop beside it
      if (d < bd) { bd = d; best = c.g; }
    }
    return best;
  }
  setProbe('stop', (x, y) => pick(x, y, false));
  const blocked = () => live.following || document.body.classList.contains('driving');
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !on || e.buttons) return;
    const g = blocked() ? null : pick(e.clientX, e.clientY, false);
    if (g !== hover) { hover = g; canvas.style.cursor = g ? 'pointer' : ''; place(); invalidate(); }
  });
  // after the live layers' pointerup (a vehicle wins), before the landmarks' (a stop pin in front of a palace wins)
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || e.timeStamp - down.t > 450) return;
    if (!on || tapClaimed() || blocked()) return;
    const g = pick(e.clientX, e.clientY, e.pointerType === 'touch');
    if (g) { claimTap('stop'); open(g); }
    else if (selected) close();
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && selected) close(); });

  // ─── card ───
  const card = document.createElement('aside');
  card.className = 'st-card'; card.hidden = true; card.setAttribute('aria-live', 'polite');
  document.body.appendChild(card);
  const eta = createEta();
  const routeCache = new Map();
  let cal = null, feed = null, feedAt = 0, feedP = null, tick = 0, rows = null, metroRows = null, cardErr = '';
  const getRoute = (key) => {
    if (!routeCache.has(key)) routeCache.set(key, fetch(`/transit/r/${key}.json`).then((r) => (r.ok ? r.json() : null)).then((R) => R && prepRoute(R)).catch(() => null));
    return routeCache.get(key);
  };
  function getFeed() {
    if (Date.now() - feedAt < 14000 && feed) return Promise.resolve(feed);
    return (feedP ||= fetch('/api/transit').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).then((d) => {
      feed = d.v.map((a) => ({ kind: a[0], op: a[0] === 'cm' ? 'm' : 'c', id: a[1], line: a[2], x: a[3], y: a[4], bearing: a[5], ts: d.t - a[7], trip: a[10] || '', pattern: (a[9] || '').replace(/^\[[^\]]+\](?=\[)/, ''), stop: a[11] || '', status: a[12], route: a[13] || '', dir: a[14] >= 0 ? a[14] : null }));
      feed.t = d.t; feedAt = Date.now(); return feed;
    }).catch((e) => { cardErr = 'sem ligação aos dados ao vivo'; return feed || []; }).finally(() => { feedP = null; }));
  }

  async function refresh(g) {
    if (g.lines) { metroRows = transit.metroArrivals(g.name, 3); render(); return; }   // Metro
    const keys = [...new Set(g.m.flatMap((m) => m.routes))];
    const [routes, vehicles] = await Promise.all([
      Promise.all(keys.map(getRoute)).then((a) => a.filter(Boolean)),
      getFeed(),
      cal ? null : fetch('/transit/cal.json').then((r) => r.json()).then((c) => { cal = c; }).catch(() => {}),
    ]);
    if (selected !== g) return;
    const now = Date.now() / 1000;
    rows = [];
    if (cal) for (const m of g.m) rows.push(...eta.arrivals(m.id, routes.filter((R) => R.op === m.op), cal, vehicles.filter((v) => v.op === m.op), now));
    rows.sort((a, b) => a.t - b.t);
    render();
  }

  function open(g) {
    selected = g; rows = null; metroRows = null; cardErr = '';
    document.querySelector('.lm-card')?.setAttribute('hidden', '');   // one card at a time
    document.querySelector('.live-card:not(.follow)')?.setAttribute('hidden', '');
    render(); place(); invalidate();
    if (card.hidden) { card.hidden = false; requestAnimationFrame(() => card.classList.add('in')); }
    refresh(g);
    clearInterval(tick);
    let n = 0;
    tick = setInterval(() => { if (!selected) return; if (++n % 5 === 0) refresh(selected); else render(); }, 1000);   // recompute every 5 s, count down every second
  }
  function close() { selected = null; clearInterval(tick); card.hidden = true; card.classList.remove('in'); place(); invalidate(); }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clock = (t) => new Date(t * 1000).toLocaleTimeString('pt-PT', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit' });
  function when(inS, t, live = true) {
    if (inS < 45) return live ? 'a chegar' : 'agora';
    const m = Math.round(inS / 60);
    return m <= 45 ? `${m} min` : clock(t);
  }
  const busIcon = '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M8 21l1.5-4M16 21l-1.5-4"/></svg>';
  const contrast = (hex) => { const c = new THREE.Color(hex || '#888'); return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 0.62 ? '#1d1d1f' : '#fff'; };
  const LINE_SHORT = (n) => n.replace(/^Linha\s+/i, '');

  function render() {
    const g = selected; if (!g) return;
    const now = Date.now() / 1000;
    let head, body, foot;
    if (g.lines) {   // Metro
      head = `<b class="ic m">M</b><div><b class="ti">${esc(g.name)}</b><small>Metro de Lisboa · ${g.lines.map((l) => `<i class="dot" style="background:${l.colour}"></i>${esc(LINE_SHORT(l.name))}`).join(' ')}</small></div>`;
      const by = new Map();
      for (const r of metroRows || []) { const k = r.line + '|' + r.dest; (by.get(k) || by.set(k, []).get(k)).push(r); }
      body = by.size ? [...by.values()].map((a) => `<li><span class="bd" style="background:${a[0].colour};color:${contrast(a[0].colour)}">${esc(LINE_SHORT(a[0].line))}</span><span class="hd">${esc(a[0].dest)}</span><span class="et est">≈ ${when(a[0].inS - (now - mNow), now + a[0].inS)}</span><span class="nx">${a.slice(1, 3).map((x) => '≈ ' + when(x.inS - (now - mNow), now + x.inS)).join(' · ')}</span></li>`).join('')
        : `<li class="none">${metroRows ? 'Sem comboios agora (o Metro circula das 6h30 à 1h).' : 'a calcular…'}</li>`;
      foot = '<span class="est">≈ estimado</span> pelo horário típico: o Metro não publica a posição dos comboios';
    } else {
      const ops = [...new Set(g.m.map((m) => OPNAME[m.op]))].join(' · ');
      const ids = g.m.map((m) => m.id).join(' / ');
      head = `<b class="ic">${busIcon}</b><div><b class="ti">${esc(g.name)}</b><small>${esc(ops)} · paragem ${esc(ids)}${g.shelter ? ' · abrigo' : ''}</small></div>`;
      if (!rows) body = '<li class="none">a carregar horários…</li>';
      else {
        const by = new Map();
        for (const r of rows) { const k = `${r.op}|${r.line}|${r.head}`; (by.get(k) || by.set(k, []).get(k)).push(r); }
        const grp = [...by.values()].filter((a) => a[0].t - now < 90 * 60).slice(0, 10);
        body = grp.length ? grp.map((a) => {
          const r = a[0], inS = r.t - now, col = r.color || (r.op === 'm' ? '#ffd800' : '#f6c21c');
          const late = r.live && Math.abs(r.delay) >= 90 ? `<em class="dl ${r.delay > 0 ? 'late' : 'early'}">${r.delay > 0 ? '+' : '−'}${Math.round(Math.abs(r.delay) / 60)}</em>` : '';
          const tip = r.live ? `ao vivo: autocarro a ${Math.round(r.away)} m, posição de há ${Math.round(r.age + (now - (feed?.t || now)))} s, ${r.delay >= 0 ? Math.round(r.delay / 60) + ' min atrasado' : Math.round(-r.delay / 60) + ' min adiantado'} face ao horário (${clock(r.sched)})` : `horário: ${clock(r.sched)}, sem autocarro localizado`;
          const nx = a.slice(1, 3).map((x) => `<span class="${x.live ? 'lv' : ''}">${when(x.t - now, x.t, x.live)}</span>`).join(' · ');
          return `<li title="${esc(tip)}"><span class="bd" style="background:${col};color:${r.text || contrast(col)}">${esc(r.line)}</span><span class="hd">${esc(r.head)}</span><span class="et ${r.live ? 'live' : 'sch'}">${r.live ? '<i></i>' : ''}${when(inS, r.t, r.live)}${late}</span><span class="nx">${nx}</span></li>`;
        }).join('') : `<li class="none">${data?.routes && Object.keys(data.routes).length ? 'Sem passagens na próxima hora e meia.' : 'Horários ainda não disponíveis.'}</li>`;
      }
      foot = `<span class="live"><i></i>ao vivo</span> GPS do autocarro, corrigido pelo atraso medido e pela idade do dado · <span class="sch">horário</span> GTFS ${esc(data?.built || '')}${cardErr ? ` · ${esc(cardErr)}` : ''}`;
    }
    card.innerHTML = `<header>${head}</header><button type="button" class="x" aria-label="Fechar">×</button><ol class="arr">${body}</ol><p class="src">${foot}</p>`;
    card.querySelector('.x').onclick = close;
  }
  let mNow = Date.now() / 1000;   // metro rows are "in seconds" from when they were computed
  const _ma = transit.metroArrivals;
  transit.metroArrivals = (...a) => { mNow = Date.now() / 1000; return _ma(...a); };

  // ─── layer ───
  const handle = registerLayer({
    id: 'stops', label: 'Paragens', group: 'live', on: true,
    icon: '<path d="M8 21V4"/><rect x="8" y="3.5" width="9" height="7" rx="1.5"/><path d="M5 21h6"/>',
    status: () => (!on ? '' : !data ? 'a carregar…' : `${data.groups.length} paragens · ${stations?.length || 0} estações de Metro`),
    set: (v) => { on = v; group.visible = v; if (v) load().then(() => { place(); invalidate(); }); else { if (selected) close(); hover = null; } },
  });

  return {
    update() {
      if (!on || !data) return;
      if (placedV !== ground.version || (!stations && transit.metroStations()) || camera.position.distanceToSquared(lastCam) > 40 * 40) place();
    },
    get on() { return on; },
    // test hooks
    open: (name) => { const n = norm(name); const g = (stations || []).find((s) => norm(s.name) === n) || data?.groups.filter((s) => s.nn === n).sort((a, b) => b.m.reduce((k, m) => k + m.routes.length, 0) - a.m.reduce((k, m) => k + m.routes.length, 0))[0]; if (g) open(g); return !!g; },
    close, pick, get selected() { return selected; }, get rows() { return rows; }, get visible() { return vis.length; }, get data() { return data; },
  };
}
