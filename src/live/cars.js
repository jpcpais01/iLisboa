// Ambient traffic: tiny cars on every street, always on.
//  · Where they drive: the street graph (public/live/net.bin): right-hand lanes, one-way streets one way, lane counts
//    from OSM, hidden in tunnels, up on the deck of the two big bridges.
//  · How many and how fast: TomTom live flow (/api/traffic) gives each street's speed against its free flow. Speed is
//    taken as is; density follows the traffic-flow fundamental diagram: a slow street is a dense street
//    (k = k_jam · (1 − v/v_free)), a flowing street carries the usual volume for this hour (k = q / v).
//    Streets TomTom doesn't cover (small local streets) use the time-of-day model, scaled by how congested the
//    live city is right now compared with that model.
//  · How: each lane is a queue of cars that keep a safe gap (a car brakes for the one ahead, queues spill back
//    through junctions), pick their next street at the end of each one, preferring streets that are short of cars.
//    Only the streets in view are simulated. Every car is true scale at any distance: the nearest streets get their
//    real density, the far ones share what is left of a fixed budget (10k cars on phones, 32k on computers).
//  · Cost: two instanced draws (modelled cars ~40 triangles close up, plain 10-triangle blocks beyond 380 m),
//    32 bytes per car per frame.
import * as THREE from 'three';
import { loadNetwork, loadNames } from './network.js';
import { getFlow } from './flow.js';
import { lisbonNow } from './clock.js';
import { HOT, pressure } from './traffic.js';
import { carPalette } from '../cars.js';

// per road class: 0 motorway, 1 trunk, 2 primary, 3 secondary, 4 tertiary, 5 residential, 6 service/living
const FREE = [92, 70, 50, 45, 40, 30, 20].map((k) => k / 3.6);   // free-flow speed, m/s
const QMAX = [1700, 1500, 900, 750, 600, 220, 70];               // vehicles / hour / lane at the busiest hour
const SENS = [1, 0.95, 0.85, 0.75, 0.62, 0.45, 0.3];             // how much rush hour slows each class (model)
const LANES1 = [3, 2, 2, 2, 1, 1, 1], LANES2 = [2, 2, 2, 1, 1, 1, 1];   // default lanes: one-way / per direction of a two-way road
const KJAM = 125;                                                 // jam density, vehicles / km / lane (8 m per car)
// demand by hour (0 … 1), Lisbon working days and weekends
const DAY = [0.17, 0.1, 0.07, 0.05, 0.05, 0.09, 0.26, 0.62, 0.95, 0.86, 0.68, 0.66, 0.72, 0.72, 0.68, 0.72, 0.8, 0.94, 1, 0.88, 0.66, 0.48, 0.37, 0.26];
const END = [0.26, 0.19, 0.13, 0.08, 0.06, 0.06, 0.1, 0.17, 0.27, 0.4, 0.52, 0.6, 0.64, 0.62, 0.58, 0.58, 0.6, 0.62, 0.6, 0.55, 0.48, 0.42, 0.36, 0.3];
const GAP0 = 2.2, HEADWAY = 1.15, ACC = 2.2, DEC = 7;             // car following: standstill gap (m), time gap (s), m/s²
const CAR_L = 4.4;                                                // every car is drawn at true scale, at any distance
const NEAR = 380;                                                 // closer than this: the modelled car; beyond, a plain box (10 triangles)

export function createCars(ctx) {
  const { scene, ground, ll, camera, canvas, night, mobile, lod } = ctx;
  // cars in view at once; the closest share is always simulated at full density, the rest of the budget is spread
  // evenly over the far streets (so a far view stays full of tiny cars instead of a few big ones)
  const BUDGET = mobile ? 10000 : 32000, NEAR_MAX = mobile ? 3000 : 8000;
  const mat = carMaterial(night);
  const mk = (n, plain, name) => {
    const g = carGeometry(n, plain), m = new THREE.Mesh(g, mat);
    m.frustumCulled = false; m.receiveShadow = !plain; m.name = name; g.instanceCount = 0; scene.add(m);
    return { g, pose: g.attributes.aPose, ext: g.attributes.aExt, max: n };
  };
  const near = mk(NEAR_MAX, false, 'ambient-cars'), far = mk(BUDGET, true, 'ambient-cars-far');

  let net = null, info = null;   // per edge: { cls, nl (lanes per direction), mid, rad, sens, seed, r: [fwd, back] live relative speed or NaN }
  let liveK = 1, source = '', flowT = 0, matching = false;
  const lanes = new Map();       // key edge*16 + dir*8 + lane → lane
  let names = null, dbg = {}, total = 0, lastActive = -1e9, lastCam = new THREE.Vector3(1e9, 0, 0), demand = 0.5, pModel = 0.3;
  const hot = HOT.map(([lon, lat, r, k]) => { const v = ll(lat, lon); return [v.x, -v.z, r, k]; });

  // the street graph (1.5 MB) downloads once the city around the camera has drawn its ground, not before
  let booted = false;
  const boot = () => loadNetwork().then((n) => {
    net = n;
    info = n.edges.map((E) => {
      if (E.k === 2 || E.cls > 6) return null;
      const m = E.pts[E.pts.length >> 1], a = E.pts[0], b = E.pts[E.pts.length - 1];
      const mid = [(a[0] + b[0] + 2 * m[0]) / 4, (a[1] + b[1] + 2 * m[1]) / 4];
      let rad = 0; for (const p of E.pts) rad = Math.max(rad, Math.hypot(p[0] - mid[0], p[1] - mid[1]));
      let hs = 0; for (const [hx, hy, r, k] of hot) hs = Math.max(hs, k * Math.exp(-((mid[0] - hx) ** 2 + (mid[1] - hy) ** 2) / (r * r)));
      const seed = fract(Math.sin(mid[0] * 0.0123 + mid[1] * 0.0371) * 43758.5453);
      const nl = E.oneway ? Math.min(5, E.lanes || LANES1[E.cls]) : Math.min(4, E.lanes ? Math.max(1, E.lanes >> 1) : LANES2[E.cls]);
      return { cls: E.cls, nl, mid, rad, sens: SENS[E.cls] * (0.55 + 0.6 * seed) + hs * 0.7, seed, r: [NaN, NaN] };
    });
    refreshFlow();
    loadNames().then((n) => { names = n; }).catch(() => {});
  }).catch((e) => console.warn('cars: network', e));

  // ─── live flow → per edge and direction relative speed ───
  async function refreshFlow() {
    setTimeout(refreshFlow, 300000);
    if (!net || matching || document.visibilityState !== 'visible') return;
    const d = await getFlow();
    if (d.source !== 'tomtom' || !d.segs?.length) { source = 'typical'; return; }
    if (d.t === flowT) return;
    matching = true;
    // sample every TomTom polyline every ~16 m, snap each sample onto the street graph, and vote for the edge in the
    // direction the TomTom line runs. Done in slices so the map never stutters.
    const sum = new Float32Array(net.edges.length * 2), wt = new Float32Array(net.edges.length * 2);
    let t0 = performance.now();
    for (const s of d.segs) {
      const lvl = s[0] / 100;
      for (let i = 2; i + 3 < s.length; i += 2) {
        const ax = s[i], ay = s[i + 1], bx = s[i + 2], by = s[i + 3], L = Math.hypot(bx - ax, by - ay);
        if (L < 0.5) continue;
        const ux = (bx - ax) / L, uy = (by - ay) / L;
        for (let t = Math.min(8, L / 2); t < L; t += 16) {
          const sn = net.snap(ax + ux * t, ay + uy * t, false, 14);
          if (!sn || !info[sn.e]) continue;
          const dot = ux * sn.ux + uy * sn.uy;
          if (Math.abs(dot) < 0.75) continue;
          const k = sn.e * 2 + (dot > 0 ? 0 : 1);
          sum[k] += lvl; wt[k] += 1;
        }
      }
      if (performance.now() - t0 > 8) { await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); }
    }
    // how congested is the live city compared with the model, on the streets both know about
    let cl = 0, cm = 0, n = 0;
    const P = pressure();
    info.forEach((I, e) => {
      if (!I) return;
      for (const dir of [0, 1]) {
        const k = e * 2 + dir;
        I.r[dir] = wt[k] >= 1 ? sum[k] / wt[k] : NaN;
        if (Number.isFinite(I.r[dir])) { cl += (1 - I.r[dir]) * net.edges[e].L; cm += Math.min(0.92, P * I.sens * 0.75) * net.edges[e].L; n++; }
      }
      // TomTom often draws one line for both directions: the other direction borrows it
      if (!net.edges[e].oneway) { if (!Number.isFinite(I.r[1])) I.r[1] = I.r[0]; if (!Number.isFinite(I.r[0])) I.r[0] = I.r[1]; }
    });
    liveK = n > 50 && cm > 0 ? Math.max(0.25, Math.min(3, cl / cm)) : 1;
    source = 'tomtom'; flowT = d.t; matching = false; lastActive = -1e9;
    for (const l of lanes.values()) l.v = laneSpeed(l.e, l.dir);
  }
  const fract = (x) => x - Math.floor(x);

  function relSpeed(e, dir) {
    const I = info[e], r = I.r[dir];
    if (Number.isFinite(r)) return Math.max(0.06, r);
    return Math.max(0.08, 1 - Math.min(0.92, pModel * I.sens * 0.75 * liveK));
  }
  const laneSpeed = (e, dir) => FREE[info[e].cls] * relSpeed(e, dir);
  // vehicles per km per lane on edge e in direction dir (fundamental diagram)
  function density(e, dir) {
    const I = info[e], r = relSpeed(e, dir), v = FREE[I.cls] * 3.6 * r;
    const kFree = (QMAX[I.cls] * demand * (0.75 + 0.5 * I.seed)) / Math.max(5, v);
    const kCong = KJAM * Math.max(0, 0.82 - r) / 0.82;
    return Math.min(KJAM, Math.max(kFree, kCong));
  }

  // ─── lanes ───
  function makeLane(e, dir, li) {
    const E = net.edges[e], I = info[e], nl = I.nl;
    const src = dir ? E.pts.slice().reverse() : E.pts;
    const w = I.cls === 0 ? 3.5 : 3.1;
    const off = E.oneway ? (li - (nl - 1) / 2) * w : (li + 0.5) * w;
    // offset polyline to the right of travel, soft miters
    const pts = [], n = src.length;
    for (let i = 0; i < n; i++) {
      const a = src[Math.max(0, i - 1)], b = src[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      pts.push(src[i][0] + dy * off, src[i][1] - dx * off);
    }
    const cum = new Float32Array(n); for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
    const L = cum[n - 1];
    return { key: e * 16 + dir * 8 + li, e, dir, li, pts, cum, L, eL: E.L, cars: [], target: 0, v: laneSpeed(e, dir), end: dir ? E.a : E.b, start: dir ? E.b : E.a, tunnel: E.tunnel, deck: !!E.z, vg: E.vg, d: 0, fresh: true, active: true, frac: fract(I.seed * 7.31 + li * 0.37 + dir * 0.53) };
  }

  // which streets to simulate: in front of the camera, out to where a car is still worth a couple of pixels
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), sph = new THREE.Sphere(), cp = new THREE.Vector3();
  function activate(now) {
    lastActive = now; lastCam.copy(camera.position);
    const { h, weekend } = lisbonNow(), hh = h % 24, i0 = Math.floor(hh), f = hh - i0, T = weekend ? END : DAY;
    demand = T[i0] * (1 - f) + T[(i0 + 1) % 24] * f; pModel = pressure();
    camera.updateMatrixWorld(); pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    cp.copy(camera.position);
    const R = Math.min(mobile ? 6000 : 9000, 1400 + Math.max(0, cp.y) * 4.5);
    for (const l of lanes.values()) l.active = false;
    let want = 0;
    const cand = [];
    for (let e = 0; e < info.length; e++) {
      const I = info[e]; if (!I) continue;
      const dx = I.mid[0] - cp.x, dy = I.mid[1] + cp.z, dd = Math.hypot(dx, dy);
      if (dd - I.rad > R) continue;
      const gz = ground.at(I.mid[0], I.mid[1]);
      const d3 = Math.hypot(dd, cp.y - gz);
      if (d3 - I.rad > 300) { sph.center.set(I.mid[0], gz, -I.mid[1]); sph.radius = I.rad + 40; if (!frustum.intersectsSphere(sph)) continue; }
      const E = net.edges[e];
      for (const dir of E.oneway ? [0] : [0, 1]) {
        const k = (density(e, dir) * E.L) / 1000;
        cand.push({ e, dir, k, d: d3 }); want += k * I.nl;
      }
    }
    // nearest streets first at their real density, up to 70% of the budget; every street beyond shares the rest
    cand.sort((a, b) => a.d - b.d);
    const B = BUDGET * Math.max(0.55, lod());
    let used = 0, iFull = cand.length;
    for (let i = 0; i < cand.length; i++) { const w = cand[i].k * info[cand[i].e].nl; if (used + w > B * 0.7) { iFull = i; break; } used += w; }
    const rest = want - used, scale = rest > 0 ? Math.min(1, (B - used) / rest) : 1;
    dbg = { want: Math.round(want), fullTo: Math.round(cand[iFull]?.d ?? Infinity), scale: +scale.toFixed(3), lanes: lanes.size, R: Math.round(R) };
    for (let i = 0; i < cand.length; i++) {
      const { e, dir } = cand[i], k = cand[i].k * (i < iFull ? 1 : scale), nl = info[e].nl;
      for (let li = 0; li < nl; li++) {
        const key = e * 16 + dir * 8 + li;
        let l = lanes.get(key);
        if (!l) { l = makeLane(e, dir, li); lanes.set(key, l); }
        l.active = true; l.d = cand[i].d; l.v = laneSpeed(e, dir);
        l.target = Math.floor(k + l.frac);
      }
    }
    // lanes that left the view drop their cars at once (they are off screen)
    for (const [key, l] of lanes) if (!l.active) { total -= l.cars.length; lanes.delete(key); }
  }

  // ─── cars ───
  let uid = 0;
  const rnd = Math.random;
  function newCar(s, v, fade) {
    const h = rnd();
    // paint from the Lisbon mix; one in ten is a van or an SUV (taller, longer), lorries only on the big roads
    return { s, v, f: 0.85 + rnd() * 0.27, col: paintIndex(rnd()), kind: h < 0.9 ? 0 : 1, fade, die: false, jx: 0, jy: 0, wait: 0, seg: 1, id: uid++ };
  }
  function spawn(l, n, spread) {
    for (let q = 0; q < n; q++) {
      // a free spot: random position with room either side
      for (let tries = 0; tries < 4; tries++) {
        const s = rnd() * l.L;
        let i = 0; while (i < l.cars.length && l.cars[i].s < s) i++;
        const back = l.cars[i - 1], front = l.cars[i];
        if ((back && s - back.s < 9) || (front && front.s - s < 9)) continue;
        l.cars.splice(i, 0, newCar(s, l.v * (0.7 + 0.3 * rnd()), spread ? 0 : 0.001)); total++;
        break;
      }
    }
  }
  // the next lane at the end of this one: prefer going straight on, and streets short of cars
  function nextLane(l) {
    const v = l.end, E = net.edges[l.e];
    const inX = l.pts[l.pts.length - 2] - l.pts[l.pts.length - 4], inY = l.pts[l.pts.length - 1] - l.pts[l.pts.length - 3], inL = Math.hypot(inX, inY) || 1;
    let tw = 0; const opts = [];
    for (const e of net.adj[v]) {
      const I = info[e]; if (!I) continue;
      const F = net.edges[e], dir = F.a === v ? 0 : 1;
      if (dir === 1 && F.oneway) continue;
      if (F.a === F.b && dir === 1) continue;
      const uturn = e === l.e;
      const p = dir ? F.pts[F.pts.length - 1] : F.pts[0], q = dir ? F.pts[F.pts.length - 2] : F.pts[1];
      const ox = q[0] - p[0], oy = q[1] - p[1], cos = (inX * ox + inY * oy) / (inL * (Math.hypot(ox, oy) || 1));
      for (let li = 0; li < I.nl; li++) {
        const nl = lanes.get(e * 16 + dir * 8 + li); if (!nl) continue;
        const need = (nl.target - nl.cars.length + 0.6) / (nl.target + 1);
        const w = Math.max(0.03, need + 0.25) * (1.2 + cos) * (uturn ? 0.01 : 1) * (1 + Math.min(2, FREE[I.cls] / FREE[info[l.e].cls] - 1) * 0.3) / I.nl;
        if (w > 0) { opts.push(nl, w); tw += w; }
      }
    }
    if (!opts.length) return null;
    let x = rnd() * tw;
    for (let i = 0; i < opts.length; i += 2) if ((x -= opts[i + 1]) <= 0) return opts[i];
    return opts[opts.length - 2];
  }

  // Far streets are stepped less often: a lane advances when its fastest car would have moved ~0.35 px on screen since its
  // last step (at most every 8th frame), so a city-wide view of 30k sub-pixel cars costs a fraction of the CPU with no
  // visible difference; near streets step every frame as before. Their cars keep the pose drawn at their last step.
  let frame = 0;
  function cadence() {
    const f = canvas.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (const l of lanes.values()) { const pxPerFrame = (l.v * 1.3 * f) / Math.max(1, l.d) / 60; l.k = Math.max(1, Math.min(8, Math.floor(0.35 / Math.max(1e-6, pxPerFrame)))); l.tiny = (CAR_L * f) / Math.max(1, l.d) < 2.5; }
  }
  function step(dtF) {
    frame++;
    for (const l of lanes.values()) {
      l.acc = (l.acc || 0) + dtF;
      l.stepped = l.k <= 1 || (frame + (l.key & 7)) % l.k === 0;
      if (!l.stepped) continue;
      const dt = Math.min(0.25, l.acc); l.acc = 0;
      const cars = l.cars;
      // keep the lane near its target: top up gently (all at once when it first comes into view), thin the excess
      const deficit = l.target - cars.length;
      if (l.fresh) { spawn(l, deficit, true); l.fresh = false; }
      else if (deficit > 0 && rnd() < dt * (0.15 + 0.06 * deficit)) spawn(l, 1, false);
      else if (deficit < -1 && rnd() < dt * 0.5 * -deficit) { const c = cars[(rnd() * cars.length) | 0]; c.die = true; }
      const vL = l.v;
      for (let i = cars.length - 1; i >= 0; i--) {
        const c = cars[i];
        if (c.die) { c.fade -= dt * 1.6; if (c.fade <= 0) { cars.splice(i, 1); total--; continue; } }
        else if (c.fade < 1) c.fade = Math.min(1, c.fade + dt * 1.4);
        const lead = cars[i + 1];
        let gap = lead ? lead.s - CAR_L * (lead.kind ? 1.25 : 1) - c.s : 1e9;
        if (!lead && c.wait > 0) gap = l.L - c.s;   // queued at the junction: stop at the line
        const vSafe = Math.max(0, (gap - GAP0) / HEADWAY);
        const vDes = Math.min(vL * c.f, vSafe);
        c.v = vDes > c.v ? Math.min(vDes, c.v + ACC * dt) : Math.max(vDes, c.v - DEC * dt);
        c.s += c.v * dt;
        if (c.s >= l.L && i === cars.length - 1) {
          // into the next street, or out of the simulation when it leads out of view
          const n = c.die ? null : nextLane(l);
          if (!n || n === l) { cars.splice(i, 1); total--; continue; }
          const tail = n.cars[0], room = tail ? tail.s - CAR_L - GAP0 : 1e9;
          if (room < c.s - l.L) {
            c.s = l.L - 0.01; c.v = 0; c.wait += dt;
            if (c.wait > 30) { c.die = true; c.wait = 0; }
            continue;
          }
          // carry the turn smoothly: remember where the car was and ease into the new lane over its first metres
          const px = l.pts[l.pts.length - 2], py = l.pts[l.pts.length - 1];
          c.s -= l.L; c.seg = 1; c.wait = 0;
          c.jx = px - n.pts[0]; c.jy = py - n.pts[1];
          cars.splice(i, 1); n.cars.unshift(c);
        } else if (c.s > l.L) c.s = l.L;
      }
    }
  }

  // ─── draw ───
  const tmp = { x: 0, y: 0, hx: 1, hy: 0 };
  function at(l, c) {
    const p = l.pts, cum = l.cum, n = cum.length;
    let j = Math.min(c.seg, n - 1);
    while (j < n - 1 && cum[j] < c.s) j++;
    while (j > 1 && cum[j - 1] > c.s) j--;
    c.seg = j;
    const ax = p[2 * j - 2], ay = p[2 * j - 1], bx = p[2 * j], by = p[2 * j + 1], sl = cum[j] - cum[j - 1] || 1;
    const f = Math.max(0, Math.min(1, (c.s - cum[j - 1]) / sl));
    tmp.x = ax + (bx - ax) * f; tmp.y = ay + (by - ay) * f; tmp.hx = (bx - ax) / sl; tmp.hy = (by - ay) / sl;
    return tmp;
  }
  function draw() {
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    let nn = 0, nf = 0;
    for (const l of lanes.values()) {
      if (l.tunnel) continue;
      for (const c of l.cars) {
        if (nf >= BUDGET) break;
        if (!l.stepped && c.pose) {   // (a far lane between its steps: the car stands where it was drawn)
          const q = c.pose, T = q[6] && nn < NEAR_MAX ? near : far, n = T === near ? nn++ : nf++, P = T.pose.array, X = T.ext.array;
          P[n * 4] = q[0]; P[n * 4 + 1] = q[1]; P[n * 4 + 2] = q[2]; P[n * 4 + 3] = q[3];
          X[n * 4] = q[4]; X[n * 4 + 1] = c.fade; X[n * 4 + 2] = c.kind; X[n * 4 + 3] = c.col;
          continue;
        }
        const a = at(l, c);
        let x = a.x, y = a.y;
        if (c.jx || c.jy) {
          const k = Math.max(0, 1 - c.s / 10);
          if (k <= 0) { c.jx = c.jy = 0; } else { x += c.jx * k * k; y += c.jy * k * k; }
        }
        let z, pitch = NaN;
        if (l.deck) {   // up on a bridge deck or a walled ramp: its measured level (never below the ground under it)
          const es = l.dir ? l.eL - (c.s / l.L) * l.eL : (c.s / l.L) * l.eL, dz = net.deckAt(l.e, es);
          z = Number.isFinite(dz) ? Math.max(dz, ground.at(x, y) + (l.vg ? 7 : 0)) : ground.at(x, y);
          if (Number.isFinite(dz)) { const f = net.deckAt(l.e, es + 2.5), b = net.deckAt(l.e, es - 2.5); if (Number.isFinite(f) && Number.isFinite(b)) pitch = Math.atan2((f - b) * (l.dir ? -1 : 1), 5); }
        } else z = ground.at(x, y);
        // pitch along the slope (Lisbon's hills), looked up 2.5 m ahead and behind
        if (!Number.isFinite(pitch)) pitch = (l.deck && l.vg) || l.tiny ? 0 : Math.atan2(ground.at(x + a.hx * 2.5, y + a.hy * 2.5) - ground.at(x - a.hx * 2.5, y - a.hy * 2.5), 5);
        const d = Math.hypot(x - cx, z - cy, -y - cz);
        const T = d < NEAR && nn < NEAR_MAX ? near : far, n = T === near ? nn++ : nf++, P = T.pose.array, X = T.ext.array;
        P[n * 4] = x; P[n * 4 + 1] = z + 0.05; P[n * 4 + 2] = -y; P[n * 4 + 3] = Math.atan2(a.hx, a.hy);
        X[n * 4] = pitch; X[n * 4 + 1] = c.fade; X[n * 4 + 2] = c.kind; X[n * 4 + 3] = c.col;
        if (l.k > 1) { const q = c.pose || (c.pose = new Float32Array(7)); q[0] = x; q[1] = z + 0.05; q[2] = -y; q[3] = P[n * 4 + 3]; q[4] = pitch; q[6] = T === near ? 1 : 0; } else c.pose = null;
      }
    }
    for (const [T, n] of [[near, nn], [far, nf]]) {
      T.g.instanceCount = n;
      for (const A of [T.pose, T.ext]) { A.clearUpdateRanges(); A.addUpdateRange(0, n * 4); A.needsUpdate = true; }
    }
    return nn + nf;
  }

  let shown = 0;
  return {
    update(dt, now) {
      if (!booted) { if (ground.version > 0) { booted = true; boot(); } return; }
      if (!net || !info) return;
      // re-pick the streets in view twice a second, or at once after a big camera move
      if (now - lastActive > 500 || camera.position.distanceToSquared(lastCam) > Math.max(400, camera.position.y * camera.position.y * 0.01)) { activate(now); cadence(); }
      step(dt);
      shown = draw();
    },
    get count() { return shown; },
    get total() { return total; },
    get source() { return source; },
    get liveK() { return liveK; },
    get stats() { return { ...dbg, shown, total, source, liveK: +liveK.toFixed(2), matching }; },
    // tap a car: its street, its speed and what the live feed says about that street
    pickables() {
      const out = [];
      for (const l of lanes.values()) {
        if (l.tunnel) continue;
        for (const c of l.cars) {
          const a = at(l, c), x = a.x, y = a.y;
          out.push({ pos: [x, ground.at(x, y) + 1, -y], info: () => {
            const I = info[l.e], r = I.r[l.dir], street = names?.[net.edges[l.e].name] || '';
            return {
              icon: '🚗', title: c.kind ? 'Carrinha' : 'Carro', sub: street,
              lines: [`${Math.round(c.v * 3.6)} km/h`, Number.isFinite(r) ? `trânsito nesta rua: ${Math.round(r * 100)}% da velocidade livre` : `rua sem medição: estimado para esta hora${source === 'tomtom' ? ', ajustado ao trânsito ao vivo' : ''}`],
              src: Number.isFinite(r) ? 'densidade e velocidade ao vivo · TomTom' : 'densidade estimada',
            };
          } });
        }
      }
      return out;
    },
    // ambient cars near (x, y) (plan metres, y north) for anything that needs to avoid them: { x, y, z, head, half: [L, W] }
    near(x, y, r) {
      const out = [];
      for (const l of lanes.values()) {
        if (l.tunnel) continue;
        const p0 = l.pts, mx = (p0[0] + p0[p0.length - 2]) / 2, my = (p0[1] + p0[p0.length - 1]) / 2;
        if (Math.hypot(mx - x, my - y) > r + l.L) continue;
        for (const c of l.cars) {
          const a = at(l, c);
          if (Math.hypot(a.x - x, a.y - y) > r) continue;
          out.push({ x: a.x, y: a.y, z: ground.at(a.x, a.y), head: Math.atan2(a.hx, a.hy), v: c.v, half: c.kind ? [2.75, 1.0] : [2.2, 0.9] });
        }
      }
      return out;
    },
  };
}

// paint index into the shared Lisbon palette (weights from carPalette)
const PAL_TOT = carPalette.reduce((a, p) => a + p[1], 0);
function paintIndex(h) { let x = h * PAL_TOT; for (let i = 0; i < carPalette.length; i++) if ((x -= carPalette[i][1]) < 0) return i; return 0; }

// one tiny car (+x forward, y up, origin on the ground): painted body, dark glass cabin with a painted roof, dark
// sills. Faces pointing straight down are dropped (never seen). glow: headlamps on the nose, tail lamps on the back.
function carGeometry(max, plain) {
  const pos = [], nor = [], col = [], tint = [], glow = [];
  const box = (cx, cy, cz, L, H, W, c, t, lamps) => {
    const g = new THREE.BoxGeometry(L, H, W).translate(cx, cy, cz).toNonIndexed();
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    for (let i = 0; i < P.length; i += 9) {
      if (N[i + 1] < -0.5) continue;   // underside
      for (let k = 0; k < 9; k += 3) {
        pos.push(P[i + k], P[i + k + 1], P[i + k + 2]); nor.push(N[i + k], N[i + k + 1], N[i + k + 2]);
        col.push(...c); tint.push(t);
        const nx = N[i + k];
        glow.push(...(lamps && nx > 0.5 ? [1, 0.86, 0.62] : lamps && nx < -0.5 ? [0.95, 0.06, 0.03] : [0, 0, 0]));
      }
    }
  };
  if (plain) box(0, 0.75, 0, 4.4, 1.3, 1.78, [1, 1, 1], 1, true);   // far: one painted block with its lamps
  else {
    box(0, 0.6, 0, 4.4, 0.72, 1.78, [1, 1, 1], 1, true);              // body
    box(-0.3, 1.2, 0, 2.3, 0.5, 1.6, [0.09, 0.11, 0.13], 0, false);   // glass
    box(-0.35, 1.47, 0, 2.0, 0.06, 1.5, [1, 1, 1], 1, false);          // roof
    box(0, 0.12, 0, 4.0, 0.24, 1.7, [0.06, 0.06, 0.06], 0, false);    // sills and tyres
  }
  const base = new THREE.BufferGeometry();
  base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  base.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  base.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  base.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 1));
  base.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 3));
  const g = new THREE.InstancedBufferGeometry().copy(base);
  g.setAttribute('aPose', new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aExt', new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage));
  return g;
}

function carMaterial(night) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12 });
  const pal = carPalette.map(([c]) => new THREE.Color(c));
  mat.onBeforeCompile = (s) => {
    s.uniforms.uPal = { value: pal };
    s.uniforms.uNight = night;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aPose; attribute vec4 aExt; attribute float aTint; attribute vec3 aGlow;
uniform vec3 uPal[${pal.length}]; varying vec3 vGlow; varying vec2 vLamp;
vec3 carXf(vec3 p) {
  float cp = cos(aExt.x), sp = sin(aExt.x), a = 1.5707963 - aPose.w, ca = cos(a), sa = sin(a);
  p = vec3(p.x * cp - p.y * sp, p.x * sp + p.y * cp, p.z);
  return vec3(p.x * ca + p.z * sa, p.y, -p.x * sa + p.z * ca);
}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = carXf(objectNormal);')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{ vec3 k = aExt.z > 0.5 ? vec3(1.22, 1.38, 1.08) : vec3(1.0);
  transformed = carXf(transformed * k * aExt.y) + aPose.xyz; }`)
      .replace('#include <color_vertex>', `#include <color_vertex>
vColor.rgb = mix(color.rgb, color.rgb * uPal[int(aExt.w + 0.5)], aTint);
vGlow = aGlow; vLamp = vec2(abs(position.z), position.y);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight; varying vec3 vGlow; varying vec2 vLamp;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n{ float lamp = step(.5, vLamp.x) * step(vLamp.x, .82) * step(.62, vLamp.y) * step(vLamp.y, .86); lamp = mix(lamp, .3, smoothstep(.04, .2, fwidth(vLamp.x) + fwidth(vLamp.y)));   // far away: the face average, so traffic still reads as streams of light; two lamps a side, not the whole face\ntotalEmissiveRadiance += vGlow * lamp * (0.3 + 4. * uNight); }');
  };
  mat.customProgramCacheKey = () => 'ambient-car-v2';
  return mat;
}
