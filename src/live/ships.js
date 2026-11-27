// Boats on the Tagus. Three sources, each labelled on its card:
//  · ao vivo — AIS (aisstream.io via /api/ships, polled every 30 s): real ships, names, types, destinations, speeds.
//    Between reports each one runs on by dead reckoning and blends into the next fix over 4 s.
//  · horário — Transtejo/Soflusa ferries placed on their published timetable (TTSL GTFS) along their sailing lines,
//    with a proper speed profile (accelerate, cruise, slow into the berth) and dwell at the terminals. When AIS is live,
//    a scheduled ferry that a real one is already shown for is dropped.
//  · ilustrativo — what AIS can't show: yachts moored in the marinas (berths laid out on the real basins, capped at
//    each marina's published berth count), sailing and motor boats in the day, and, only while there's no AIS, ships
//    alongside the real port terminals and a cargo ship working up or down the dredged channel.
// Every hull rides the same waves (src/water.js sea state: live wind + Atlantic swell at the bar) through a damped
// heave/pitch/roll response sized to the hull, so a yacht bobs and a container ship barely moves; yachts heel to the
// live wind. Moving boats leave wakes in the water shader (nearest 24).
import * as THREE from 'three';
import { BOAT_KINDS, boatMaterial } from './boats.js';
import { riverAt, riverReady, eta, wind } from '../water.js';
import { waterUniforms, NWAKE, cityUniforms } from '../materials.js';

const POLL = 30000;
const MAXK = { ferry: 40, container: 24, cruise: 12, tanker: 24, bulk: 24, cargo: 40, tug: 30, sail: 160, moored: 1500, motor: 500, launch: 120, fishing: 60 };
const NAME = { ferry: 'Ferry', container: 'Porta-contentores', cruise: 'Navio de cruzeiro', tanker: 'Navio-tanque', bulk: 'Graneleiro', cargo: 'Navio de carga', tug: 'Rebocador', sail: 'Veleiro', moored: 'Veleiro', motor: 'Barco a motor', launch: 'Lancha', fishing: 'Barco de pesca' };
const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l2 3h14l2-3H3zM6 17V11h12v6M9 11V7h6v4M12 7V3"/></svg>';
const SHIPS_SHADOW = new Set(['container', 'cruise', 'tanker', 'bulk', 'cargo']);
const Q = new URLSearchParams(location.search);

// Lisbon calendar date + seconds into the day (for the timetable). ?livehour=… pins the hour, like the other layers.
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric' });
const pinH = parseFloat(Q.get('livehour')), t0 = performance.now();
function lisbon(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const sec = Number.isFinite(pinH) ? pinH * 3600 + (performance.now() - t0) / 1000 : (+p.hour % 24) * 3600 + +p.minute * 60 + +p.second + (Date.now() % 1000) / 1000;
  return { date: +`${p.year}${p.month}${p.day}`, wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), sec };
}
const hhmm = (s) => { s = ((s % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`; };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// a small deterministic generator: the illustrative traffic is the same for everyone on a given day
function rng(seed) { let s = (seed >>> 0) || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296); }

export function createShips(ctx) {
  const { scene, camera, waterY = 0 } = ctx;
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const mat = boatMaterial(cityUniforms.uNight);
  const meshes = {};
  for (const [k, def] of Object.entries(BOAT_KINDS)) {
    const m = new THREE.InstancedMesh(def.build(), mat, MAXK[k]);
    m.count = 0; m.frustumCulled = false; m.receiveShadow = true; m.castShadow = SHIPS_SHADOW.has(k);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXK[k] * 3).fill(1), 3);
    meshes[k] = m; group.add(m);
  }
  const vessels = new Map();   // id → vessel
  let on = false, data = null, ferry = null, ais = { state: 'off', n: 0, t: 0 }, timer = 0, ambientDay = -1;

  // ─── a vessel ───
  function vessel(id, o) {
    const def = BOAT_KINDS[o.kind];
    const v = { id, x: 0, y: 0, hd: 0, sog: 0, L: def.L, B: def.B, name: '', dest: '', src: 'ilustrativo', col: 0xffffff,
      ex: 0, ey: 0, run: 0, runHd: 0, heave: [0, 0], pitch: [0, 0], roll: [0, 0], heel: 0, seen: performance.now() / 1000, ...o };
    v.runHd = v.hd; vessels.set(id, v);
    return v;
  }

  // ─── data ───
  async function load() {
    data = await riverReady;
    try { ferry = await (await fetch('/water/ferry.json')).json(); } catch { ferry = null; }
    if (data) mooring();
  }
  const loading = load();

  // yachts in the marinas: always there (they don't carry AIS); a fifth are motor yachts
  function mooring() {
    for (const m of data.marinas) {
      const r = rng(m.c[0] * 31 + m.c[1]);
      m.berths.forEach(([x, y, h, L], i) => {
        const motor = r() < 0.22;
        vessel(`m:${m.name}:${i}`, { kind: motor ? 'motor' : 'moored', x, y, hd: Math.PI / 2 - h, L: motor ? L * 1.05 : L, B: (motor ? 0.3 : 0.32) * L + 0.6, moored: true, place: m.name,
          col: r() < 0.12 ? [0x1f3b6e, 0x8a1c1c, 0x2d2d2d, 0xe8e2cf][Math.floor(r() * 4)] : 0xffffff, src: 'ilustrativo' });
      });
    }
  }

  // ─── timetable ferries ───
  const ROUTE_SIZE = { CA: [40, 10.5], BR: [48, 12], TF: [32, 9], MT: [36, 10], SX: [36, 10] };
  const shapeCache = new Map();
  function shapeOf(i) {
    if (shapeCache.has(i)) return shapeCache.get(i);
    const pts = ferry.shapes[i] || [], cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const s = { pts, cum, len: cum[cum.length - 1] };
    shapeCache.set(i, s); return s;
  }
  function pointAt(s, d) {   // → [x, y, heading]
    d = Math.max(0, Math.min(s.len, d));
    let k = 1; while (k < s.cum.length - 1 && s.cum[k] < d) k++;
    const a = s.pts[k - 1], b = s.pts[k], f = (d - s.cum[k - 1]) / Math.max(1e-6, s.cum[k] - s.cum[k - 1]);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, Math.atan2(b[0] - a[0], b[1] - a[1])];
  }
  const runs = (svc, day) => {
    const s = ferry.services[svc];
    if (!s) return false;
    if (s.del.includes(day.date)) return false;
    if (s.add.includes(day.date)) return true;
    return s.d[day.wd] === 1 && day.date >= s.from && day.date <= s.to;
  };
  // the speed profile between two stops: accelerate over the first 12 % of the time, cruise, slow down over the last 18 %
  function profile(f) {
    const a = 0.12, b = 0.18, vmax = 1 / (1 - a / 2 - b / 2);
    if (f < a) return (vmax * f * f) / (2 * a);
    if (f > 1 - b) { const g = 1 - f; return 1 - (vmax * g * g) / (2 * b); }
    return vmax * (a / 2) + vmax * (f - a);
  }
  function ferries() {
    if (!ferry) return new Set();
    const live = new Set(), today = lisbon(), yest = lisbon(-1);
    yest.sec = today.sec + 86400;   // trips after midnight belong to yesterday's service day
    for (const day of [today, yest]) {
      ferry.trips.forEach(([ri, si, svc, head, st], ti) => {
        const s = day.sec, t0s = st[0][2], t1s = st[st.length - 1][1];
        if (s < t0s - 300 || s > t1s + 180 || !runs(svc, day)) return;
        const shp = shapeOf(si), last = st[st.length - 1][3] || shp.len, scale = shp.len / Math.max(1, last);
        let d = 0, sog = 0, at = '';
        if (s <= t0s) { d = 0; at = ferry.stops[st[0][0]].name; }
        else if (s >= t1s) { d = shp.len; at = ferry.stops[st[st.length - 1][0]].name; }
        else for (let k = 0; k < st.length - 1; k++) {
          const A = st[k], B = st[k + 1];
          if (s < A[2]) { d = A[3] * scale; at = ferry.stops[A[0]].name; break; }        // dwelling at an intermediate stop
          if (s < B[1]) {
            const f = (s - A[2]) / Math.max(1, B[1] - A[2]), seg = (B[3] - A[3]) * scale;
            d = A[3] * scale + seg * profile(f);
            sog = (seg / Math.max(1, B[1] - A[2])) * (profile(Math.min(1, f + 0.01)) - profile(Math.max(0, f - 0.01))) / 0.02;
            break;
          }
        }
        const [x, y, h] = pointAt(shp, Math.min(shp.len - 0.1, Math.max(0.1, d)));
        const id = `f:${day.date}:${ti}`, route = ferry.routes[ri], size = ROUTE_SIZE[route.code] || [38, 10];
        live.add(id);
        let v = vessels.get(id);
        if (!v) v = vessel(id, { kind: 'ferry', L: size[0], B: size[1], src: 'horário', col: new THREE.Color(route.col).getHex(), hd: h, x, y });
        const from = ferry.stops[st[0][0]].name, to = ferry.stops[st[st.length - 1][0]].name;
        // berthed: keep the heading it arrived with; underway: follow the line
        Object.assign(v, { tx: x, ty: y, sog, route, head, from, to, dep: t0s, arr: t1s, at: sog > 0.2 ? '' : at, seen: performance.now() / 1000 });
        if (sog > 0.2) v.thd = h;
      });
    }
    for (const [id, v] of vessels) if (id.startsWith('f:') && !live.has(id)) vessels.delete(id);
    return live;
  }

  // ─── AIS ───
  async function poll() {
    if (!on) return;
    if (document.visibilityState === 'visible') {
      try {
        const r = await fetch('/api/ships');
        const d = await r.json().catch(() => ({}));
        const was = ais.state === 'live';
        if (d.error === 'nokey') ais = { state: 'nokey', n: 0, t: Date.now() };
        else if (!r.ok) throw new Error(d.error || r.status);
        else ingest(d);
      } catch (e) { ais = { ...ais, state: ais.n ? 'stale' : 'error', err: String(e.message || e) }; }
      ctx.status();
    }
    timer = setTimeout(poll, POLL);
  }
  // AIS ship type → our hull
  function kindOf(type, L, name) {
    if (type >= 60 && type < 70) return L > 140 ? 'cruise' : L > 22 ? 'ferry' : 'launch';
    if (type >= 70 && type < 80) return /container|maersk|msc |cma cgm|hapag|evergreen/i.test(name) || L > 175 ? 'container' : L > 150 ? 'bulk' : 'cargo';
    if (type >= 80 && type < 90) return 'tanker';
    if (type === 31 || type === 32 || type === 52) return 'tug';
    if (type === 30) return 'fishing';
    if (type === 36) return 'sail';
    if (type === 37) return L > 18 ? 'motor' : L > 10 ? 'motor' : 'launch';
    if (type >= 40 && type < 50) return 'ferry';
    if (type >= 50 && type < 60) return 'launch';
    return L > 40 ? 'cargo' : L > 20 ? 'tug' : 'launch';
  }
  // AIS sends names/types only every ~6 min, so a ship first appears as type 0: guess from speed and the ferry lanes
  function nearFerryLane(x, y) {
    for (const pts of ferry?.shapes || []) for (let i = 1; i < pts.length; i++) {   // shapes are sparse (km-long legs): distance to each leg
      const [ax, ay] = pts[i - 1], dx = pts[i][0] - ax, dy = pts[i][1] - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      if (Math.hypot(ax + t * dx - x, ay + t * dy - y) < 700) return true;
    }
    return false;
  }
  function guessKind(type, L, name, sog, x, y) {
    if (type) return kindOf(type, L || 30, name);
    if (L) return kindOf(0, L, name);
    return sog > 3 && nearFerryLane(x, y) ? 'ferry' : 'cargo';
  }
  const v0kind = (id, type, len, name, sog, x, y) => {
    const v = vessels.get(id);   // a ferry guess holds while it stands at a pier, so the hull doesn't flip to cargo
    return !type && !len && v?.guess && v.kind === 'ferry' ? 'ferry' : guessKind(type, len, name, sog, x, y);
  };
  function ingest(d) {
    const now = performance.now() / 1000;
    let n = 0;
    for (const [mmsi, name, type, x, y, sog, cog, hdg, nav, L, B, dest, age, call] of d.s || []) {
      const id = `a:${mmsi}`, len = L > 2 ? L : 0, kind0 = v0kind(id, type, len, name || '', sog, x, y), kind = kind0;
      const cr = ((cog ?? hdg ?? 0) * Math.PI) / 180, hr = hdg != null && hdg < 360 ? (hdg * Math.PI) / 180 : cr;
      const moving = sog > 0.4 && nav !== 1 && nav !== 5;
      const nx = x + (moving ? Math.sin(cr) * sog * age : 0), ny = y + (moving ? Math.cos(cr) * sog * age : 0);
      let v = vessels.get(id);
      const dims = { L: len || (kind === 'cargo' ? 70 : BOAT_KINDS[kind].L), B: B > 1 ? B : (len || BOAT_KINDS[kind].L) * 0.16 };
      if (!v || v.kind !== kind) { if (v) vessels.delete(id); v = vessel(id, { kind, x: nx, y: ny, hd: hr, src: 'ao vivo', col: kind === 'sail' || kind === 'motor' ? 0xffffff : 0xb8c4d6, ...dims }); }
      else { const j = Math.hypot(nx - v.x, ny - v.y); if (j > 1500) { v.x = nx; v.y = ny; v.ex = v.ey = 0; } else { v.ex = nx - v.x; v.ey = ny - v.y; } }
      Object.assign(v, dims, { name: (name || '').trim(), mmsi, type, cog: cr, thd: hr, sog: moving ? sog : 0, nav, dest: (dest || '').replace(/@+/g, '').trim(), call, seen: now, ais: true, guess: !type && !len });
      n++;
    }
    for (const [id, v] of vessels) if (v.ais && now - v.seen > 20 * 60) vessels.delete(id);
    ais = { state: n ? 'live' : 'empty', n, t: Date.now() };
  }

  // ─── illustrative traffic (one plan per day) ───
  function ambient() {
    const day = lisbon(), r = rng(day.date * 7 + 3);
    for (const id of [...vessels.keys()]) if (id.startsWith('i:')) vessels.delete(id);
    for (const p of data.ports) {
      const occ = { container: 0.85, cruise: day.date % 10000 > 400 && day.date % 10000 < 1130 ? 0.8 : 0.4, tanker: 0.55, bulk: 0.5, cargo: 0.45, service: 0.9 }[p.kind] ?? 0.4;
      const quays = p.quays.map((q) => ({ q, len: Math.hypot(q[2] - q[0], q[3] - q[1]) })).sort((a, b) => b.len - a.len);
      let used = 0;
      for (const { q, len } of quays) {
        if (used >= (p.kind === 'container' || p.kind === 'cruise' ? 2 : 1) || r() > occ) continue;
        const kind = p.kind === 'service' ? 'tug' : p.kind === 'cargo' && r() < 0.3 ? 'container' : p.kind;
        const want = { container: [170, 260], cruise: [230, 330], tanker: [90, 180], bulk: [140, 190], cargo: [85, 135], tug: [26, 32] }[kind];
        const L = Math.min(len * 0.92, want[0] + r() * (want[1] - want[0]));
        if (L < want[0] * 0.6) continue;
        const B = kind === 'cruise' ? L * 0.125 : kind === 'tug' ? L * 0.36 : L * 0.155;
        const [x0, y0, x1, y1, s] = q, ux = (x1 - x0) / len, uy = (y1 - y0) / len, nx = uy * s, ny = -ux * s;
        const mid = (len - L) * (0.25 + r() * 0.5) + L / 2, fwd = r() < 0.5 ? 1 : -1;
        const x = x0 + ux * mid + nx * (B / 2 + 2.5), y = y0 + uy * mid + ny * (B / 2 + 2.5);
        if (riverAt(x, y).w < 0.3) continue;
        vessel(`i:${p.name}:${used}`, { kind, x, y, hd: Math.atan2(ux * fwd, uy * fwd), L, B, moored: true, place: p.name.replace(/^Porto de Lisboa - /, ''), col: [0x1b2a44, 0x7a1f1f, 0x203b2a, 0x2a2a2e, 0x1d3f6e][Math.floor(r() * 5)] });
        used++;
      }
    }
    // day boats: sailing yachts out of the marinas, a few motor boats; more at weekends and in a sailing breeze
    const daylight = day.sec > 8.5 * 3600 && day.sec < 19.5 * 3600;
    const breeze = wind.speed > 1.5 && wind.speed < 13 ? 1 : 0.3;
    const nSail = daylight ? Math.round((day.wd >= 5 ? 22 : 9) * breeze) : 0, nMotor = daylight ? (day.wd >= 5 ? 8 : 4) : 1;
    const homes = data.marinas.filter((m) => m.berths.length > 50);
    for (let i = 0; i < nSail + nMotor; i++) {
      const sail = i < nSail, m = homes[Math.floor(r() * homes.length)];
      const p = sample(m.c[0], m.c[1], 2500, r);
      if (!p) continue;
      const L = sail ? 8 + r() * 6 : 7 + r() * 8;
      vessel(`i:b${i}`, { kind: sail ? 'sail' : L < 9 ? 'launch' : 'motor', x: p[0], y: p[1], hd: r() * 6.283, L, B: L * (sail ? 0.33 : 0.32), agent: sail ? 'sail' : 'motor', home: m.name, cruise: sail ? 0 : 6 + r() * 4, rnd: rng(i * 977 + day.date) });
    }
  }
  // a point in open water (≥ 2 m deep, ≥ 120 m off the shore) within R of (cx, cy)
  function sample(cx, cy, R, r) {
    for (let k = 0; k < 40; k++) {
      const a = r() * 6.283, d = Math.sqrt(r()) * R, x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d, q = riverAt(x, y);
      if (q.w > 0.9 && q.d > 2 && q.s > 120) return [x, y];
    }
    return null;
  }
  const clearAhead = (x, y, hd, dist) => { for (let s = 25; s <= dist; s += 25) { const q = riverAt(x + Math.sin(hd) * s, y + Math.cos(hd) * s); if (q.w < 0.8 || q.s < 50 || q.d < 1.5) return false; } return true; };
  // day-boat helmsman: pick a mark in open water, never one dead upwind (a sailing boat tacks), sail at a speed from a
  // simple polar of the live wind, turn at a sensible rate, and pick a new mark when the way ahead runs out of water
  function steer(v, dt) {
    const up = (wind.from * Math.PI) / 180;
    const okMark = (mx, my) => !(v.agent === 'sail' && Math.abs(wrap(Math.atan2(mx - v.x, my - v.y) - up)) < 0.8);
    if (!v.mark || Math.hypot(v.mark[0] - v.x, v.mark[1] - v.y) < 60 || !clearAhead(v.x, v.y, v.hd, 80)) {
      for (let k = 0; k < 12; k++) { const p = sample(v.x, v.y, 1400, v.rnd); if (p && okMark(p[0], p[1]) && clearAhead(v.x, v.y, Math.atan2(p[0] - v.x, p[1] - v.y), Math.min(600, Math.hypot(p[0] - v.x, p[1] - v.y)))) { v.mark = p; break; } }
    }
    if (v.mark) {
      const want = Math.atan2(v.mark[0] - v.x, v.mark[1] - v.y), d = wrap(want - v.hd), rate = v.agent === 'sail' ? 0.12 : 0.25;
      v.hd = wrap(v.hd + Math.max(-rate * dt, Math.min(rate * dt, d)));
    }
    const off = Math.abs(wrap(v.hd - up));   // 0 = head to wind, π = running
    const target = v.agent === 'sail' ? Math.max(0, Math.min(4.2, wind.speed * 0.5 * Math.sin(Math.min(off, 2.2)) * (off < 0.7 ? 0.2 : 1))) : v.cruise;
    v.sog += (target - v.sog) * Math.min(1, dt * 0.3);
    v.x += Math.sin(v.hd) * v.sog * dt; v.y += Math.cos(v.hd) * v.sog * dt;
  }

  // ─── per frame ───
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YZX'), pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
  const idx = {}; let lastFerry = 0, simT = 0;
  // damped second-order response x'' = ω²(target − x) − 2ζω x'
  const resp = (s, target, T, zeta, dt) => {
    const w = (2 * Math.PI) / T;
    for (let t = 0; t < dt; t += 1 / 30) { const h = Math.min(1 / 30, dt - t); s[1] += (w * w * (target - s[0]) - 2 * zeta * w * s[1]) * h; s[0] += s[1] * h; }
    return s[0];
  };
  function update(dt, nowMs) {
    if (!on || !data) return;
    const now = nowMs / 1000; simT += dt;
    const day = lisbon();
    if (day.date !== ambientDay || ais.changed) { ambientDay = day.date; ais.changed = false; ambient(); }
    if (now - lastFerry > 1) { lastFerry = now; ferries(); hideScheduledUnderLive(); }
    const cam = camera.position, k4 = Math.min(1, dt / 4);
    for (const k in idx) idx[k] = 0;
    const wakes = [];
    for (const v of vessels.values()) {
      // ── where it is ──
      if (v.ais) {
        if (v.sog > 0) { v.x += Math.sin(v.cog) * v.sog * dt; v.y += Math.cos(v.cog) * v.sog * dt; }
        v.x += v.ex * k4; v.ex -= v.ex * k4; v.y += v.ey * k4; v.ey -= v.ey * k4;
        v.hd = wrap(v.hd + wrap(v.thd - v.hd) * Math.min(1, dt * 0.6));
      } else if (v.tx != null) {   // timetable: glide onto the scheduled point
        v.x += (v.tx - v.x) * Math.min(1, dt * 2); v.y += (v.ty - v.y) * Math.min(1, dt * 2);
        if (v.thd != null) v.hd = wrap(v.hd + wrap(v.thd - v.hd) * Math.min(1, dt * 0.8));
      } else if (v.agent) steer(v, dt);
      if (v.hidden) continue;
      // ── wake bookkeeping: how far it has run straight ──
      if (Math.abs(wrap(v.hd - v.runHd)) > 0.18) { v.run = Math.min(v.run, v.L * 1.5); v.runHd = v.hd; }
      v.run = Math.min(3000, v.run + v.sog * dt);
      const dx = v.x - cam.x, dy = v.y + cam.z, dc = Math.hypot(dx, dy);
      if (v.sog > 0.6 && dc < 9000) wakes.push([dc, v]);
      // ── how it rides the waves (only where it can be seen moving) ──
      if (dc < 2500 || !v.posed) {
        v.posed = true;
        const sd = riverAt(v.x, v.y).s, ch = Math.cos(v.hd), sh = Math.sin(v.hd), hl = v.L * 0.4, hb = v.B * 0.45;
        const eB = eta(v.x + sh * hl, v.y + ch * hl, simT, sd), eS = eta(v.x - sh * hl, v.y - ch * hl, simT, sd);
        const eP = eta(v.x - ch * hb, v.y + sh * hb, simT, sd), eT = eta(v.x + ch * hb, v.y - sh * hb, simT, sd);
        const size = Math.sqrt(v.L);
        resp(v.heave, (eB + eS + eP + eT) / 4, Math.max(1.4, 0.45 * size), 0.35, dt);
        resp(v.pitch, Math.atan2(eB - eS, v.L * 0.8), Math.max(1.4, 0.5 * size), 0.3, dt);
        resp(v.roll, Math.atan2(eP - eT, v.B * 0.9) * 1.4, 1.2 + 0.75 * Math.sqrt(v.B), 0.12, dt);
        // sailing yachts heel to leeward with the wind on the beam
        if (v.kind === 'sail') {
          const rel = wrap((wind.from * Math.PI) / 180 - v.hd), beam = Math.abs(Math.sin(rel));
          v.heel += (Math.min(0.42, 0.011 * wind.speed * wind.speed) * beam * Math.sign(rel) - v.heel) * Math.min(1, dt * 0.5);
        }
      }
      // ── into its kind's instanced mesh ──
      const mesh = meshes[v.kind], i = idx[v.kind] ?? 0;
      if (i >= MAXK[v.kind]) continue;
      idx[v.kind] = i + 1; v.slot = i;
      const def = BOAT_KINDS[v.kind];
      e.set(v.roll[0] + v.heel, Math.PI / 2 - v.hd, v.pitch[0] - (v.sog > 3 ? 0.012 : 0));
      q.setFromEuler(e);
      pos.set(v.x, waterY + v.heave[0], -v.y);
      scl.set(v.L / def.L, Math.sqrt(v.L / def.L), v.B / def.B);
      mesh.setMatrixAt(i, m4.compose(pos, q, scl));
      mesh.setColorAt(i, col.setHex(v.col));
    }
    for (const [k, m] of Object.entries(meshes)) { m.count = idx[k] || 0; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    // ── wakes: the nearest moving boats ──
    wakes.sort((a, b) => a[0] - b[0]);
    const W = Math.min(NWAKE, wakes.length), A = waterUniforms.uWakeA.value, B = waterUniforms.uWakeB.value;
    for (let i = 0; i < W; i++) { const v = wakes[i][1]; A[i].set(v.x, v.y, Math.sin(v.hd), Math.cos(v.hd)); B[i].set(v.sog, v.L, v.B, v.run); }
    waterUniforms.uWakes.value = W;
  }
  // a scheduled ferry is dropped while a live AIS passenger ship is within 500 m of where the timetable puts it, and an
  // illustrative ship at a quay is dropped while a real AIS ship lies at or near that berth (AIS coverage here is sparse,
  // so the rest of the quays keep their stand-ins)
  function hideScheduledUnderLive() {
    const live = [...vessels.values()].filter((v) => v.ais);
    for (const v of vessels.values()) {
      if (v.src === 'horário') v.hidden = live.some((a) => a.kind === 'ferry' && Math.hypot(a.x - v.x, a.y - v.y) < 500);
      else if (v.id.startsWith('i:') && v.L > 40) v.hidden = live.some((a) => Math.hypot(a.x - v.x, a.y - v.y) < Math.max(200, v.L / 2 + 100));
    }
  }

  function info(v) {
    const kn = v.sog / 0.5144, lines = [];
    const sp = v.sog > 0.3 ? `${(v.sog * 3.6).toFixed(0)} km/h (${kn.toFixed(1)} nós)` : v.moored || v.at ? 'atracado' : 'parado';
    if (v.src === 'horário') {
      lines.push(v.at ? `no cais · ${v.at}` : sp, `partida ${hhmm(v.dep)} · chegada ${hhmm(v.arr)}`);
      return { icon: ICON, title: `${v.route.code} · ${v.from} → ${v.to}`, sub: `Transtejo Soflusa · ${v.route.name}`, lines, src: 'horário TTSL (GTFS) · posição estimada pelo horário', speedKnown: true };
    }
    if (v.ais) {
      lines.push(sp);
      if (v.dest) lines.push(`destino: ${v.dest}`);
      lines.push(v.guess ? 'tipo e dimensões ainda por receber (o AIS envia-os a cada ~6 min)' : `${Math.round(v.L)} × ${Math.round(v.B)} m`);
      return { icon: ICON, title: v.name || `MMSI ${v.mmsi}`, sub: [NAME[v.kind], v.call].filter(Boolean).join(' · '), lines, src: 'ao vivo · AIS (aisstream.io)', speedKnown: true };
    }
    lines.push(v.place ? `${sp} · ${v.place}` : sp, `${Math.round(v.L)} m`);
    return { icon: ICON, title: NAME[v.kind], sub: v.home ? `saiu de ${v.home}` : '', lines, src: 'ilustrativo · não é um barco real (sem dados AIS para ele)', speedKnown: true };
  }

  return {
    get on() { return on; },
    set(v) {
      on = v; group.visible = v; clearTimeout(timer);
      if (!v) { waterUniforms.uWakes.value = 0; return; }
      loading.then(() => { if (on) poll(); });
    },
    update,
    status() {
      if (!on) return '';
      const n = { live: 0, sched: 0, ill: 0 };
      for (const v of vessels.values()) { if (v.hidden) continue; if (v.ais) n.live++; else if (v.src === 'horário') n.sched++; else if (!v.moored || !v.id.startsWith('m:')) n.ill++; }
      const parts = [];
      if (ais.state === 'live') parts.push(`ao vivo · ${n.live} navios AIS`);
      if (n.sched) parts.push(`${n.sched} ferries pelo horário`);
      if (ais.state !== 'live') parts.push(ais.state === 'nokey' ? 'sem AIS (falta chave) · resto ilustrativo' : 'sem AIS · resto ilustrativo');
      return parts.join(' · ');
    },
    pickables() {
      const out = [];
      for (const v of vessels.values()) if (!v.hidden) out.push({ id: v.id, weak: v.id.startsWith('m:'), pos: [v.x, waterY + Math.min(6, v.L * 0.05), -v.y], info: () => info(v) });
      return out;
    },
    track(id) {
      const v = vessels.get(id);
      if (!v || !on || v.hidden) return null;
      const d = Math.max(40, v.L * 2.4);
      return { x: v.x, y: v.y, z: waterY + v.L * 0.04, heading: Math.PI / 2 - v.hd, speed: v.sog, kind: 'ship', info: () => info(v),
        chase: { dist: d, minDist: Math.max(15, v.L * 0.8), maxDist: 4000, pitch: 0.32 } };
    },
    debug: { vessels, get ais() { return ais; }, ambient, get day() { return ambientDay; } },
  };
}
