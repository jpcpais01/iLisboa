// Next arrivals at a bus stop: the timetable (GTFS, public/transit) corrected by where the buses really are.
//
// For every live vehicle on a line that calls at the stop we find the trip it is running and how far along the
// route it was AT THE MOMENT OF ITS GPS FIX (the feed is 15–60 s behind; the fix carries its own timestamp), then
//   delay = fix time − scheduled time at that point of the route        (interpolated between the stops)
//   ETA   = scheduled time at this stop + delay                          (late buses stay late; an early one
//                                                                          usually waits at a timing point, so
//                                                                          only half of an early lead is kept)
// floored by how soon it could physically get here (remaining distance at 13 m/s ≈ 47 km/h from the fix time).
// Because the delay is measured at the fix time, the age of the data drops out instead of skewing the ETA.
// Trips with no vehicle matched keep their timetable time and are shown as such ("horário").
const SAFE_V = 13;          // m/s: no city bus averages more between stops
const SNAP = 45;            // m: GPS fix to route shape
const WINDOW = 95 * 60;     // s: how far ahead the card looks

// ─── Lisbon calendar ───
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function lisbonParts(ms) { const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second }; }
// unix seconds of Lisbon local midnight `off` days from today
export function midnight(nowS, off = 0) {
  const p = lisbonParts(nowS * 1000);
  const utc = Date.UTC(p.y, p.m - 1, p.d + off) / 1000;
  const q = lisbonParts(utc * 1000);   // Lisbon is UTC+0 or UTC+1: the wall clock at UTC midnight gives the offset
  const offS = q.h * 3600 + q.mi * 60 + (q.d !== new Date(utc * 1000).getUTCDate() ? -86400 : 0);
  return utc - offS;
}
function dayIndex(cal, nowS, off) {
  const p = lisbonParts(nowS * 1000), s = cal.start;
  return Math.round((Date.UTC(p.y, p.m - 1, p.d + off) - Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))) / 864e5);
}

// ─── route geometry ───
// prepare a route file once: trip index, shape segments with their distance along the route
export function prepRoute(R) {
  for (const P of R.patterns) {
    P.trip = new Map(P.trips.map((t, i) => [t[0], i]));
    P.seg = [];   // [d0, ax, ay, bx, by, len]
    for (const run of P.shape) {
      let d = run[0];
      for (let i = 1; i + 3 < run.length; i += 2) {
        const ax = run[i], ay = run[i + 1], bx = run[i + 2], by = run[i + 3];
        const L = Math.hypot(bx - ax, by - ay); P.seg.push([d, ax, ay, bx, by, L]); d += L;
      }
    }
  }
  return R;
}
// every place along the route within SNAP of (x, y): [{ d, off, ux, uy }] (a loop can pass twice)
function project(P, x, y) {
  const out = [];
  for (const [d0, ax, ay, bx, by, L] of P.seg) {
    if (x < Math.min(ax, bx) - SNAP || x > Math.max(ax, bx) + SNAP || y < Math.min(ay, by) - SNAP || y > Math.max(ay, by) + SNAP) continue;
    const dx = bx - ax, dy = by - ay, f = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (L * L))) : 0;
    const off = Math.hypot(x - ax - dx * f, y - ay - dy * f);
    if (off < SNAP) out.push({ d: d0 + L * f, off, ux: dx / (L || 1), uy: dy / (L || 1) });
  }
  // keep the closest point of each pass
  out.sort((a, b) => a.d - b.d);
  const res = [];
  for (const c of out) { const l = res[res.length - 1]; if (l && c.d - l.d < 80) { if (c.off < l.off) res[res.length - 1] = c; } else res.push(c); }
  return res;
}
// scheduled offset (s from trip start) at distance d along pattern P with profile prof
function timeAt(P, prof, d) {
  const D = P.d; if (d <= D[0]) return prof[0];
  for (let i = 1; i < D.length; i++) if (d <= D[i]) { const f = (d - D[i - 1]) / ((D[i] - D[i - 1]) || 1); return prof[i - 1] + (prof[i] - prof[i - 1]) * f; }
  return prof[prof.length - 1];
}

// ─── the estimator ───
export function createEta() {
  const hist = new Map();   // vehicle id → { x, y, ts, ux, uy }: direction of travel from successive fixes

  // vehicles: [{ id, op, line, route, dir, trip, x, y, ts, bearing, stop, status }]
  function remember(vs) {
    for (const v of vs) {
      const h = hist.get(v.id);
      if (!h) { hist.set(v.id, { x: v.x, y: v.y, ts: v.ts }); continue; }
      if (v.ts > h.ts) {
        const dx = v.x - h.x, dy = v.y - h.y, L = Math.hypot(dx, dy);
        if (L > 15) Object.assign(h, { ux: dx / L, uy: dy / L, x: v.x, y: v.y, ts: v.ts, moved: v.ts });
        else if (v.ts - h.ts > 300) Object.assign(h, { x: v.x, y: v.y, ts: v.ts });
      }
    }
    if (hist.size > 6000) hist.clear();
  }

  // stopId (GTFS id, no op prefix), routes: prepared route files of the lines calling there
  function arrivals(stopId, routes, cal, vehicles, nowS) {
    remember(vehicles);
    const insts = [];   // trip instances calling at the stop around now
    const byKey = new Map();
    const days = [0, -1].map((o) => ({ o, mid: midnight(nowS, o) }));
    for (const R of routes) {
      const svc = cal.svc[R.op] || [];
      for (const [o, mid] of days.map((x) => [x.o, x.mid])) {
        const di = dayIndex(cal, nowS, o);
        R.patterns.forEach((P, pi) => {
          for (let k = 0; k < P.stops.length - 1; k++) {   // not the terminus: nobody boards an arriving bus there
            if (P.stops[k] !== stopId) continue;
            for (let ti = 0; ti < P.trips.length; ti++) {
              const [tid, s, start, pr] = P.trips[ti];
              const tk = mid + start + P.prof[pr][k];
              if (tk < nowS - 40 * 60 || tk > nowS + WINDOW) continue;
              if (svc[s]?.[di] !== '1') continue;
              const it = { R, P, pi, k, ti, tid, mid, start, prof: P.prof[pr], sched: tk, v: null };
              insts.push(it); byKey.set(`${R.op}|${tid}|${o}`, it);
            }
          }
        });
      }
    }
    // candidate vehicle → trip matches, best first
    const cand = [];
    for (const v of vehicles) {
      const rs = routes.filter((R) => R.op === v.op && ((v.route && v.route === R.id) || (v.line && v.line === R.line)));
      if (!rs.length) continue;
      // 1) the feed names the trip: exact
      let exact = false;
      for (const o of [0, -1]) {
        const it = byKey.get(`${v.op}|${v.trip}|${o}`);
        if (it) for (const c of project(it.P, v.x, v.y)) { cand.push({ v, it, d: c.d, cost: -1 + Math.abs(it.mid + it.start + timeAt(it.P, it.prof, c.d) - v.ts) / 1e6 }); exact = true; }
      }
      if (exact) continue;
      // 2) otherwise: the trip of this line whose timetable puts a bus here at the fix time
      const h = hist.get(v.id), b = v.bearing >= 0 ? [Math.sin((v.bearing * Math.PI) / 180), Math.cos((v.bearing * Math.PI) / 180)] : h?.ux != null && v.ts - h.moved < 600 ? [h.ux, h.uy] : null;
      for (const it of insts) {
        if (!rs.includes(it.R) || (v.dir != null && v.route === it.R.id && it.P.dir !== v.dir)) continue;
        for (const c of project(it.P, v.x, v.y)) {
          if (b && c.ux * b[0] + c.uy * b[1] < 0.25) continue;                 // driving the other way
          const dt = v.ts - (it.mid + it.start + timeAt(it.P, it.prof, c.d));   // its delay if it is this trip
          if (dt < -12 * 60 || dt > 40 * 60) continue;
          const samePat = v.pattern && it.P.pats?.includes(v.pattern);   // Carris Metropolitana names the pattern it runs
          cand.push({ v, it, d: c.d, cost: Math.abs(dt - 90) / 60 + c.off / 20 + (b || samePat ? 0 : 4) + (v.pattern && !samePat ? 6 : 0) });   // buses run a little late more often than early
        }
      }
    }
    cand.sort((a, b) => a.cost - b.cost);
    const usedV = new Set();
    for (const c of cand) {
      if (usedV.has(c.v.id) || c.it.v) continue;
      usedV.add(c.v.id); c.it.v = c.v; c.it.d = c.d;
    }
    // rows
    const rows = [];
    for (const it of insts) {
      const dk = it.P.d[it.k];
      const row = { op: it.R.op, line: it.R.line, color: it.R.color, text: it.R.text, head: it.P.head || it.R.name, sched: it.sched, t: it.sched, live: false, key: `${it.R.op}|${it.tid}|${it.mid}` };
      if (it.v) {
        const v = it.v;
        if (it.d > dk + 25) continue;                                              // already past this stop
        const delay = v.ts - (it.mid + it.start + timeAt(it.P, it.prof, it.d));
        let t = it.sched + (delay > 0 ? delay : delay * 0.5);
        t = Math.max(t, v.ts + Math.max(0, dk - it.d) / SAFE_V);
        const away = Math.max(0, dk - it.d);
        if (it.k === 0) t = Math.max(t, it.sched);                                // at its first stop a bus lays over until its departure time
        if (t < nowS) t = nowS + Math.min(120, away / 6);                         // overdue by the timetable but not here yet
        Object.assign(row, { t, live: true, delay, age: nowS - v.ts, away, vid: v.id, here: away < 30 && (v.status === 1 || v.status === 'STOPPED_AT') });
      } else if (it.sched < nowS - 60) continue;                                   // its time has gone and no bus is seen
      rows.push(row);
    }
    rows.sort((a, b) => a.t - b.t);
    return rows;
  }
  return { arrivals };
}
