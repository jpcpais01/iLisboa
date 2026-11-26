// Public transport.
//  · Carris buses, trams and lifts + Carris Metropolitana buses: LIVE GPS (via /api/transit, polled every 15 s).
//    Each vehicle is snapped onto its street (buses) or rail (trams, funiculars) and, between fixes, drives the
//    shortest way along the network to its newest one (public/live/net.bin), keeping to the right-hand lane.
//  · Metro de Lisboa: the Metro publishes no train positions, so trains run on a timetable model (real track and
//    stations from OSM, typical headways by time of day, dwell at every station). Labelled "estimado".
import * as THREE from 'three';
import { busGeometry, tramGeometry, metroGeometry } from './models.js';
import { createBeacons } from './beacons.js';
import { buildRibbons, drape, ribbonMaterial } from './ribbons.js';
import { lisbonNow } from './clock.js';
import { loadNetwork, measure, along } from './network.js';

const POLL = 15000, MAXV = 1500;
const COL = { bus: 0xf2a900, cm: 0xffd21f, tram: 0xd8402e, lift: 0xd8402e };
const BODY = { bus: 0xf3b81b, cm: 0xffdb1a, tram: 0xf3b51b, lift: 0xf3b51b };
const NAME = { bus: 'Autocarro', cm: 'Autocarro', tram: 'Elétrico', lift: 'Ascensor' };
const OP = { bus: 'Carris', cm: 'Carris Metropolitana', tram: 'Carris', lift: 'Carris' };

export function createTransit(ctx) {
  const { scene, ground } = ctx;
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 });
  const buses = new THREE.InstancedMesh(busGeometry(), mat, MAXV), trams = new THREE.InstancedMesh(tramGeometry(), mat, 200);
  for (const x of [buses, trams]) { x.count = 0; x.frustumCulled = false; x.receiveShadow = true; /* no shadow casting: the viewer caches its shadow map */ group.add(x); }
  const beacons = createBeacons(MAXV + 400, { size: 11, lift: 4 });
  group.add(beacons.obj);
  const vehicles = new Map();
  let timer = 0, on = false, lastOk = 0, error = '', counts = {};

  async function poll() {
    if (!on) return;
    if (document.visibilityState === 'visible') {
      try {
        const r = await fetch('/api/transit');
        if (!r.ok) throw new Error(`${r.status}`);
        await ingest(await r.json()); lastOk = Date.now(); error = '';
      } catch (e) { error = String(e.message || e); }
      ctx.status();
    }
    timer = setTimeout(poll, POLL);
  }
  let net = null, netReady = null;
  const railOf = (kind) => kind === 'tram' || kind === 'lift';
  async function ingest(d) {
    if (!netReady) netReady = loadNetwork().then((n) => { net = n; }).catch((e) => console.warn('network', e));
    await netReady;
    const now = performance.now() / 1000, seen = new Set();
    counts = {};
    for (const [kind, id, line, x, y, bearing, speed, age, name, pattern] of d.v) {
      seen.add(id); counts[kind] = (counts[kind] || 0) + 1;
      const rail = railOf(kind), elevator = line === '54E';   // Santa Justa goes up, not along anything
      // onto the network: rail for trams (falls back to streets where the rail isn't mapped), streets for buses
      let sn = net && !elevator ? net.snap(x, y, rail, rail ? 30 : 45) || (rail ? net.snap(x, y, false, 45) : null) : null;
      const tx = sn ? sn.x : x, ty = sn ? sn.y : y;
      let v = vehicles.get(id);
      if (!v) {
        v = { id, x: tx, y: ty, path: [[tx, ty], [tx, ty]], cum: [0, 0], t0: now, dur: 1, snap: sn, head: bearing >= 0 ? (bearing * Math.PI) / 180 : NaN };
        vehicles.set(id, v);
      } else if (Math.hypot(tx - v.path[v.path.length - 1][0], ty - v.path[v.path.length - 1][1]) > 2) {
        const straight = Math.hypot(tx - v.x, ty - v.y);
        let path = null;
        if (net && sn && straight < 1500) {
          const onRail = rail && edgesRail(sn), from = net.snap(v.x, v.y, onRail, 12) || v.snap;
          if (from) path = net.route(from, sn, onRail, Math.max(400, straight * 3));
        }
        if (!path) path = straight < 60 ? [[v.x, v.y], [tx, ty]] : [[tx, ty], [tx, ty]];   // no way along the network: short hop or reappear
        const cum = measure(path), L = cum[cum.length - 1];
        // GPS jitter backwards along the street: hold position rather than U-turn on the spot
        const back = L < 25 && isFinite(v.head) && path.length > 1 && Math.sin(v.head) * (path[path.length - 1][0] - path[0][0]) + Math.cos(v.head) * (path[path.length - 1][1] - path[0][1]) < 0;
        if (!back) { v.path = path; v.cum = cum; v.t0 = now; v.dur = POLL / 1000 + 1; v.snap = sn; }
      }
      if (bearing >= 0 && v.cum[v.cum.length - 1] < 1) v.head = (bearing * Math.PI) / 180;
      Object.assign(v, { kind, line, name, speed, age, fixAt: now - age, seen: now, rail });
      if (pattern && v.pattern !== pattern) { v.pattern = pattern; v.dest = null; }
    }
    for (const [k, v] of vehicles) if (!seen.has(k) && now - v.seen > 60) vehicles.delete(k);
  }
  // a snap found on the street fallback means the tram has to drive the streets there too
  const edgesRail = (sn) => !!net && !!net.snap(sn.x, sn.y, true, 1);

  // ─── Metro (timetable model) ───
  let metro = null;
  const metroMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false });
  metroMat.onBeforeCompile = (s) => {   // drawn x-ray: the trains are underground, pulled towards the camera like the line bands
    s.vertexShader = s.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      { vec4 w = modelMatrix * instanceMatrix * vec4(transformed, 1.); float d = distance(cameraPosition, w.xyz);
        vec4 mv2 = viewMatrix * w; mv2.xyz *= 1. - min(.5, (6. + d * .006) / max(d, 1.)); gl_Position = projectionMatrix * mv2; }`);
  };
  const trains = new THREE.InstancedMesh(metroGeometry(), metroMat, 160);
  trains.count = 0; trains.frustumCulled = false; trains.renderOrder = 11; group.add(trains);
  const stationPins = createBeacons(200, { size: 7.5, lift: 1 }), trainPins = createBeacons(160, { size: 13, lift: 3 });
  group.add(stationPins.obj, trainPins.obj);
  fetch('/live/metro.json').then((r) => r.json()).then((d) => {
    metro = d.lines.map((l) => {
      const cum = [0]; for (let i = 1; i < l.track.length; i++) cum.push(cum[i - 1] + Math.hypot(l.track[i][0] - l.track[i - 1][0], l.track[i][1] - l.track[i - 1][1]));
      const stops = l.stops.slice().sort((a, b) => a.s - b.s).map((s) => ({ ...s, s: s.s * (cum[cum.length - 1] / (l.length || cum[cum.length - 1])) }));
      return { ...l, cum, L: cum[cum.length - 1], stops, col: new THREE.Color(l.colour), trip: timetable(stops) };
    });
    const g = buildRibbons(metro.map((l) => ({ pts: l.track, color: new THREE.Color(l.colour).toArray(), w: 0.8 })));
    const lines = new THREE.Mesh(g, ribbonMaterial({ px: 3.2, minW: 3, dash: 3.5, opacity: 0.9, casing: 0.72 }));
    lines.renderOrder = 10; lines.frustumCulled = false; group.add(lines);
    metro.mesh = lines; drape(g, ground, 1);
    metro.v = -1;
  });
  // one trip, terminus to terminus: run between stations at ~50 km/h with acceleration losses, 25 s dwell
  function timetable(stops) {
    const t = []; let time = 0;
    for (let i = 0; i < stops.length; i++) {
      t.push({ arr: time, dep: time + (i ? 25 : 0), s: stops[i].s });
      time += i ? 25 : 0;
      if (i + 1 < stops.length) time += (stops[i + 1].s - stops[i].s) / 14 + 18;
    }
    return { t, total: time };
  }
  // typical headway (s) by Lisbon time; null outside service (06:30–01:00)
  const PEAK = { 'Linha Azul': 330, 'Linha Amarela': 300, 'Linha Verde': 290, 'Linha Vermelha': 390 };
  function headway(line, h, weekend) {
    if (h < 6.5 || h >= 25) return null;
    if (weekend) return h >= 7.5 && h < 21 ? 510 : 660;
    if ((h >= 7 && h < 10) || (h >= 17 && h < 20)) return PEAK[line] || 330;
    if (h >= 10 && h < 17) return 450;
    if (h >= 20 && h < 22) return 540;
    return h < 7 ? 540 : 660;
  }
  function trainPositions() {
    if (!metro) return [];
    const { sec, weekend } = lisbonNow(), out = [];
    metro.forEach((l, li) => {
      for (const dir of [0, 1]) {
        // departures from the terminus, walking the day's headways (phase-shifted per line and direction)
        let dep = 6.5 * 3600 + ((li * 97 + dir * 151) % 240);
        while (dep <= sec) {
          const age = sec - dep;
          if (age <= l.trip.total) out.push({ l, dir, age, n: Math.round(dep) });
          const hw = headway(l.name, dep / 3600, weekend); if (!hw) break;
          dep += hw;
        }
      }
    });
    return out;
  }
  function trainAt(l, dir, age) {
    const T = l.trip.t;
    let s = T[T.length - 1].s, atStop = null;
    for (let i = 0; i < T.length; i++) {
      if (age < T[i].arr) {
        const a = T[i - 1], b = T[i], f = (age - a.dep) / (b.arr - a.dep);
        const e = f < 0 ? 0 : f * f * (3 - 2 * f);   // accelerate out, brake in
        s = a.s + (b.s - a.s) * e; break;
      }
      if (age <= T[i].dep) { s = T[i].s; atStop = i; break; }
    }
    if (dir) s = l.L - s;   // the return trip runs the same track backwards
    const { x, y, head } = pointAt(l, s);
    const stop = atStop == null ? null : l.stops[dir ? l.stops.length - 1 - atStop : atStop];
    return { x, y, head: head + (dir ? Math.PI : 0), stop };
  }
  function pointAt(l, s) {
    const c = l.cum; let i = 1; while (i < c.length - 1 && c[i] < s) i++;
    const f = Math.max(0, Math.min(1, (s - c[i - 1]) / ((c[i] - c[i - 1]) || 1))), A = l.track[i - 1], B = l.track[i];
    return { x: A[0] + (B[0] - A[0]) * f, y: A[1] + (B[1] - A[1]) * f, head: Math.atan2(B[0] - A[0], B[1] - A[1]) };
  }
  let metroNow = [];

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YZX'), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), col = new THREE.Color(), cb = new THREE.Color();
  const lift = new THREE.Vector3(0.72, 0.72, 0.72), WHITE = new THREE.Color(1, 1, 1);
  function update(dt, nowMs) {
    if (!on) return;
    const now = nowMs / 1000;
    let nb = 0, nt = 0;
    beacons.begin();
    for (const v of vehicles.values()) {
      const f = Math.min(1, (now - v.t0) / v.dur), ef = f * f * (3 - 2 * f) * 0.6 + f * 0.4, L = v.cum[v.cum.length - 1];
      along(v.path, v.cum, L * ef, v);
      // the path turns sharply at every street vertex: the body (and a following camera) turns smoothly instead
      const hr = isFinite(v.head) ? v.head : 0;
      v.hs = v.hs == null ? hr : v.hs + Math.atan2(Math.sin(hr - v.hs), Math.cos(hr - v.hs)) * Math.min(1, dt * 5);
      const h = v.hs, sx = Math.sin(h), sy = Math.cos(h);
      // drive on the right: buses keep to their lane, trams sit on the rail
      const off = v.rail ? 0 : 1.7, dx = v.x + sy * off, dy = v.y - sx * off;
      const z = ground.at(dx, dy), zf = ground.at(dx + sx * 4, dy + sy * 4), zb = ground.at(dx - sx * 4, dy - sy * 4);
      e.set(0, Math.PI / 2 - h, Math.atan2(zf - zb, 8)); q.setFromEuler(e);
      const tramLike = v.kind === 'tram' || v.kind === 'lift';
      v.rx = dx; v.ry = dy; v.rz = z;
      m.compose(p.set(dx, z, -dy), q, v.kind === 'lift' ? lift : one);
      col.setHex(BODY[v.kind]);
      if (tramLike) { if (nt < 200) { trams.setMatrixAt(nt, m); trams.setColorAt(nt, col); nt++; } }
      else if (nb < MAXV) { buses.setMatrixAt(nb, m); buses.setColorAt(nb, col); nb++; }
      beacons.push(dx, z, -dy, cb.setHex(COL[v.kind]), tramLike ? 1.05 : 0.9);
    }
    buses.count = nb; trams.count = nt;
    for (const x of [buses, trams]) { x.instanceMatrix.needsUpdate = true; if (x.instanceColor) x.instanceColor.needsUpdate = true; }
    beacons.end();
    // metro
    if (metro) {
      if (metro.v !== ground.version) {
        drape(metro.mesh.geometry, ground, 1); metro.v = ground.version;
        stationPins.begin();
        for (const l of metro) for (const st of l.stops) { const a = pointAt(l, st.s); stationPins.push(a.x, ground.at(a.x, a.y) + 1, -a.y, cb.copy(l.col).lerp(WHITE, 0.6), 0.7); }
        stationPins.end();
      }
      metroNow = trainPositions();
      let i = 0;
      trainPins.begin();
      for (const t of metroNow) {
        const a = trainAt(t.l, t.dir, t.age); t.pos = a; t.key = `${t.l.name}|${t.dir}|${t.n}`;
        const z = ground.at(a.x, a.y) + 1.5;
        e.set(0, Math.PI / 2 - a.head, 0); q.setFromEuler(e);
        m.compose(p.set(a.x, z, -a.y), q, one);
        trains.setMatrixAt(i, m); trains.setColorAt(i, t.l.col); t.z = z; i++;
        trainPins.push(a.x, z, -a.y, t.l.col, 1);
        if (i >= 160) break;
      }
      trainPins.end();
      trains.count = i; trains.instanceMatrix.needsUpdate = true; if (trains.instanceColor) trains.instanceColor.needsUpdate = true;
    }
  }

  function vInfo(v) {
    return {
      icon: v.kind === 'tram' || v.kind === 'lift' ? '🚋' : '🚌', title: `${NAME[v.kind]} ${v.line}`, sub: v.dest ? `→ ${v.dest}` : v.name || OP[v.kind],
      lines: [v.speed >= 0 ? `${Math.round(v.speed * 3.6)} km/h` : null, `posição de há ${Math.max(0, Math.round(performance.now() / 1000 - v.fixAt))} s`].filter(Boolean),
      src: `ao vivo · GPS ${OP[v.kind]}`, speedKnown: v.speed >= 0, pattern: v.pattern, dest: v.dest, setDest: (d) => { v.dest = d; },
    };
  }
  function mInfo(t) {
    const st = t.l.stops, dest = t.dir ? st[0].name : st[st.length - 1].name;
    return { icon: 'Ⓜ', title: `Metro · ${t.l.name}`, sub: `sentido ${dest}`, lines: [t.pos.stop ? `parado em ${t.pos.stop.name}` : 'em circulação'], src: 'estimado · horário típico (o Metro não publica posições)', speedKnown: true };
  }

  return {
    get on() { return on; },
    set(v) { on = v; group.visible = v; clearTimeout(timer); if (v) poll(); else vehicles.clear(); },
    update,
    status() {
      if (!on) return '';
      if (error && !lastOk) return 'sem ligação · metro estimado';
      const b = (counts.bus || 0) + (counts.cm || 0), t = counts.tram || 0;
      return `ao vivo · ${b} autocarros · ${t} elétricos · metro estimado`;
    },
    pickables() {
      const out = [];
      for (const v of vehicles.values()) out.push({ id: v.id, pos: [v.x, ground.at(v.x, v.y) + 3, -v.y], info: () => vInfo(v) });
      for (const t of metroNow) if (t.pos) out.push({ id: t.key, pos: [t.pos.x, t.z, -t.pos.y], info: () => mInfo(t) });
      return out;
    },
    // for the chase camera: the live state of one vehicle or train, null once it has gone
    track(id) {
      if (!on) return null;
      const v = vehicles.get(id);
      if (v) {
        if (v.rx == null) return null;
        const tramLike = v.kind === 'tram' || v.kind === 'lift';
        return { x: v.rx, y: v.ry, z: v.rz + 1.6, heading: Math.PI / 2 - (v.hs ?? 0), speed: v.speed >= 0 ? v.speed : null, kind: v.kind, info: () => vInfo(v),
          chase: tramLike ? { dist: 48, minDist: 14, pitch: 0.42 } : { dist: 62, minDist: 16, pitch: 0.45 } };
      }
      const t = metroNow.find((x) => x.key === id);
      if (!t || !t.pos) return null;
      return { x: t.pos.x, y: t.pos.y, z: t.z, heading: Math.PI / 2 - t.pos.head, speed: null, kind: 'metro', info: () => mInfo(t), chase: { dist: 240, minDist: 60, pitch: 0.75 } };
    },
  };
}
