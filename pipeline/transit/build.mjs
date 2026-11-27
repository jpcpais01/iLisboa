// Bus stops and timetables for the station cards, run by the fetch-transit GitHub Action (the city sandbox can't
// reach the operators). Reads two unzipped GTFS feeds and writes compact files the viewer loads on demand:
//   node pipeline/transit/build.mjs c:/tmp/carris m:/tmp/cm
// → public/transit/stops.json        every stop in the live box: id, name, position, the routes that call there
// → public/transit/r/<op>_<route>.json   one per route: its patterns (stop sequence, distance of each stop along
//                                      the route shape, the shape itself clipped to the box), timing profiles, trips
// → public/transit/cal.json           which service ids run on which day (a bitmap per service, from cal.start)
// → pipeline/transit/probe/*.txt      first lines of every GTFS file, so formats can be checked from the sandbox
// Positions use the diorama's tangent plane (api/_lib/geo.js), metres, x east / y north.
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fwd, inBox } from '../../api/_lib/geo.js';

const OUT = 'public/transit', PROBE = 'pipeline/transit/probe';
const OPS = { c: 'Carris', m: 'Carris Metropolitana' };
rmSync(`${OUT}/r`, { recursive: true, force: true });
mkdirSync(`${OUT}/r`, { recursive: true }); mkdirSync(PROBE, { recursive: true });
const DAYS = 100;   // service bitmap length: the weekly refresh keeps ~3 months ahead

function splitCsv(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
// stream a GTFS table: fn(row) with row a {column: value} accessor built from the header
async function table(dir, name, fn) {
  const f = `${dir}/${name}.txt`;
  if (!existsSync(f)) { console.log('  (no', name + ')'); return false; }
  const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
  let idx = null, n = 0;
  for await (let line of rl) {
    if (!idx) { line = line.replace(/^\uFEFF/, ''); idx = Object.fromEntries(splitCsv(line).map((h, i) => [h.trim(), i])); continue; }
    if (!line) continue;
    const a = splitCsv(line);
    fn((k) => { const i = idx[k]; return i == null ? '' : (a[i] ?? '').trim(); }); n++;
  }
  console.log('  ', name, n); return true;
}
const hms = (s) => { if (!s) return NaN; const [h, m, x] = s.split(':'); return +h * 3600 + +m * 60 + +(x || 0); };
const r1 = (v) => Math.round(v * 10) / 10;

// Douglas–Peucker on [x,y] points
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// distance of each stop along the shape, walking forward (a route can pass the same corner twice)
function stopDistances(shape, cum, stopXY) {
  const out = []; let seg = 0, prev = null;
  for (const [x, y] of stopXY) {
    const crow = prev ? Math.hypot(x - prev[0], y - prev[1]) : Infinity;
    const limit = prev ? out[out.length - 1] + crow * 3 + 600 : Infinity;
    let best = Infinity, bs = seg, bd = cum[seg];
    for (let i = seg; i < shape.length - 1 && cum[i] <= limit; i++) {
      const [ax, ay] = shape[i], [bx, by] = shape[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
      const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), px = ax + dx * f, py = ay + dy * f;
      const d = Math.hypot(x - px, y - py);
      if (d < best - 0.01) { best = d; bs = i; bd = cum[i] + Math.sqrt(L2) * f; }
    }
    out.push(bd); seg = bs; prev = [x, y];
  }
  return out;
}

const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
const start = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - 2));
const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const dayIdx = (s) => Math.round((Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) - start) / 864e5);

const allStops = [], routesOut = {}, cal = { start: ymd(start), days: DAYS, svc: {} }, stats = {};
for (const arg of process.argv.slice(2)) {
  const [op, dir] = arg.split(':');
  console.log(OPS[op], dir);
  // probe: first lines of each file
  let probe = '';
  for (const f of ['agency', 'routes', 'trips', 'stops', 'stop_times', 'shapes', 'calendar', 'calendar_dates', 'feed_info']) {
    const p = `${dir}/${f}.txt`;
    if (!existsSync(p)) { probe += `## ${f}: missing\n\n`; continue; }
    const fd = readFileSync(p, { encoding: 'utf8', flag: 'r' }).slice(0, 1200).split('\n').slice(0, 6).join('\n');
    probe += `## ${f}\n${fd}\n\n`;
  }
  writeFileSync(`${PROBE}/${op}-gtfs.txt`, probe);

  // stops
  const stops = new Map();   // stop_id → {name, x, y, inBox, routes:Set}
  await table(dir, 'stops', (r) => {
    const lat = +r('stop_lat'), lon = +r('stop_lon'), lt = r('location_type');
    if (lt && lt !== '0') return;
    const [x, y] = fwd(lat, lon);
    stops.set(r('stop_id'), { name: r('stop_name'), x: r1(x), y: r1(y), box: inBox(lat, lon), routes: new Set() });
  });
  const routes = new Map();
  await table(dir, 'routes', (r) => routes.set(r('route_id'), { short: r('route_short_name') || r('route_id'), long: r('route_long_name'), color: r('route_color'), text: r('route_text_color'), type: +r('route_type') }));
  const trips = new Map();
  await table(dir, 'trips', (r) => trips.set(r('trip_id'), { route: r('route_id'), svc: r('service_id'), shape: r('shape_id'), dir: +r('direction_id') || 0, head: r('trip_headsign'), pat: r('pattern_id') }));

  // services → day bitmaps
  const svcDays = new Map();
  const bits = (s) => { let b = svcDays.get(s); if (!b) svcDays.set(s, (b = new Uint8Array(DAYS))); return b; };
  await table(dir, 'calendar', (r) => {
    const b = bits(r('service_id')), wd = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((k) => r(k) === '1');
    const s0 = dayIdx(r('start_date')), s1 = dayIdx(r('end_date'));
    for (let i = Math.max(0, s0); i <= Math.min(DAYS - 1, s1); i++) if (wd[new Date(+start + i * 864e5).getUTCDay()]) b[i] = 1;
  });
  await table(dir, 'calendar_dates', (r) => { const i = dayIdx(r('date')); if (i >= 0 && i < DAYS) bits(r('service_id'))[i] = r('exception_type') === '1' ? 1 : 0; });
  const svcIdx = new Map(), svcList = [];
  const svcOf = (s) => { let i = svcIdx.get(s); if (i == null) { i = svcList.length; svcIdx.set(s, i); svcList.push(s); } return i; };

  // stop_times, trip by trip (feeds are sorted by trip; an unsorted feed is merged at the end)
  const patterns = new Map();   // key → {route, shape, dir, head, stops[], profiles Map, trips[]}
  const pending = new Map();    // trip → rows (only if the feed isn't sorted)
  let cur = null, rows = [], kept = 0, dropped = 0;
  const finish = (tid, rs) => {
    const t = trips.get(tid); if (!t || rs.length < 2) return;
    rs.sort((a, b) => a[0] - b[0]);
    if (!rs.some((x) => stops.get(x[1])?.box)) { dropped++; return; }
    const ids = rs.map((x) => x[1]);
    const key = `${t.route}|${t.shape}|${ids.join(',')}`;
    let p = patterns.get(key);
    if (!p) patterns.set(key, (p = { route: t.route, shape: t.shape, dir: t.dir, head: t.head, stops: ids, profiles: new Map(), trips: [] }));
    const t0 = rs[0][2];
    const prof = rs.map((x) => (isFinite(x[2]) ? x[2] - t0 : -1));
    // missing times (untimed stops) interpolated by order
    for (let i = 1; i < prof.length; i++) if (prof[i] < 0) { let j = i; while (j < prof.length && prof[j] < 0) j++; const a = prof[i - 1], b = j < prof.length ? prof[j] : a; for (let k = i; k < j; k++) prof[k] = Math.round(a + ((b - a) * (k - i + 1)) / (j - i + 1)); i = j; }
    const pk = prof.join(',');
    let pi = p.profiles.get(pk); if (pi == null) p.profiles.set(pk, (pi = p.profiles.size));
    p.trips.push([tid, svcOf(t.svc), t0, pi]); kept++;
  };
  const seenTrips = new Set();
  await table(dir, 'stop_times', (r) => {
    const tid = r('trip_id');
    if (tid !== cur) {
      if (cur != null) { if (seenTrips.has(cur)) pending.set(cur, (pending.get(cur) || []).concat(rows)); else { seenTrips.add(cur); finish(cur, rows); } }
      cur = tid; rows = [];
    }
    const t = hms(r('arrival_time')) || hms(r('departure_time'));
    rows.push([+r('stop_sequence'), r('stop_id'), t]);
  });
  if (cur != null) finish(cur, rows);
  for (const [tid, rs] of pending) finish(tid, rs);   // (rare) unsorted remainder — best effort

  // shapes (only those used)
  const need = new Set([...patterns.values()].map((p) => p.shape).filter(Boolean));
  const shapes = new Map();
  await table(dir, 'shapes', (r) => { const id = r('shape_id'); if (!need.has(id)) return; let s = shapes.get(id); if (!s) shapes.set(id, (s = [])); s.push([+r('shape_pt_sequence'), +r('shape_pt_lat'), +r('shape_pt_lon')]); });
  const shapeXY = new Map();
  for (const [id, s] of shapes) { s.sort((a, b) => a[0] - b[0]); shapeXY.set(id, simplify(s.map(([, la, lo]) => fwd(la, lo)), 1.5)); }

  // per route files
  const byRoute = new Map();
  for (const p of patterns.values()) { let a = byRoute.get(p.route); if (!a) byRoute.set(p.route, (a = [])); a.push(p); }
  let nPat = 0, nTrip = 0, bytes = 0;
  for (const [rid, ps] of byRoute) {
    const R = routes.get(rid) || { short: rid, long: '', color: '', text: '', type: 3 };
    const key = `${op}_${rid}`.replace(/[^\w.-]/g, '_');
    const outP = ps.sort((a, b) => b.trips.length - a.trips.length).map((p, pi) => {
      const sxy = p.stops.map((s) => { const st = stops.get(s); return st ? [st.x, st.y] : [NaN, NaN]; });
      let shape = shapeXY.get(p.shape);
      if (!shape || shape.length < 2) shape = sxy.filter((q) => isFinite(q[0]));
      const cum = [0]; for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + Math.hypot(shape[i][0] - shape[i - 1][0], shape[i][1] - shape[i - 1][1]));
      const d = stopDistances(shape, cum, sxy.map((q) => (isFinite(q[0]) ? q : [0, 0])));
      // the shape is only needed where live vehicles can be (the feed box): keep runs of in-box points with their distance
      const runs = []; let run = null;
      const inb = ([x, y]) => x > -15500 && x < 10500 && y > -8300 && y < 10700;   // ≈ BBOX in local metres
      for (let i = 0; i < shape.length; i++) {
        if (inb(shape[i]) || (i + 1 < shape.length && inb(shape[i + 1])) || (i > 0 && inb(shape[i - 1]))) { if (!run) runs.push((run = [Math.round(cum[i])])); run.push(Math.round(shape[i][0]), Math.round(shape[i][1])); }
        else run = null;
      }
      for (const s of p.stops) { const st = stops.get(s); if (st) st.routes.add(key); }
      nPat++; nTrip += p.trips.length;
      return { dir: p.dir, head: p.head, stops: p.stops, d: d.map(Math.round), shape: runs, prof: [...p.profiles.keys()].map((k) => k.split(',').map(Number)), trips: p.trips.sort((a, b) => a[2] - b[2]) };
    });
    const json = JSON.stringify({ op, id: rid, line: R.short, name: R.long, color: R.color, text: R.text, type: R.type, patterns: outP });
    writeFileSync(`${OUT}/r/${key}.json`, json); bytes += json.length;
    routesOut[key] = [R.short, R.color ? '#' + R.color : '', R.text ? '#' + R.text : '', R.type, op];
  }
  cal.svc[op] = svcList.map((s) => { const b = svcDays.get(s) || new Uint8Array(DAYS); let h = ''; for (let i = 0; i < DAYS; i++) h += b[i]; return h; });
  for (const [id, s] of stops) if (s.box && s.routes.size) allStops.push([`${op}:${id}`, s.name, s.x, s.y, [...s.routes]]);
  stats[op] = { stops: [...stops.values()].filter((s) => s.box && s.routes.size).length, routes: byRoute.size, patterns: nPat, trips: nTrip, droppedTrips: dropped, routeBytes: bytes, pendingUnsorted: pending.size };
  console.log(stats[op]);
}
writeFileSync(`${OUT}/stops.json`, JSON.stringify({ built: new Date().toISOString().slice(0, 10), ops: OPS, routes: routesOut, stops: allStops }));
writeFileSync(`${OUT}/cal.json`, JSON.stringify(cal));
writeFileSync(`${PROBE}/stats.json`, JSON.stringify(stats, null, 1));
