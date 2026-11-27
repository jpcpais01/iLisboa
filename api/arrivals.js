// Next buses at a stop, the same estimate the station cards show (api/_lib/eta.js), for callers without a map
// (e.g. the assistant).
//   /api/arrivals?stop=c:3824          one stop by key (c = Carris, m = Carris Metropolitana; key as in /transit/stops.json)
//   /api/arrivals?name=Corpo Santo     every stop with that name (accents and case ignored), merged
//   &line=728                          only that line          &limit=12   rows (default 12, max 40)
// → { t, stops: [{ key, name, x, y }], rows: [{ line, op, head, eta, inMin, live, delay, sched, age, away }], note }
//   eta / sched: unix seconds; delay s (+ late); live = matched to a GPS-tracked bus, else the GTFS timetable.
// Static data comes from this deployment (/transit), the vehicles from /api/transit (CDN-cached, ~15 s).
import { createEta, prepRoute } from './_lib/eta.js';

const cache = new Map();   // per warm instance: static files rarely change (weekly)
async function getJSON(base, path, ttl = 3600e3) {
  const c = cache.get(path);
  if (c && Date.now() - c.t < ttl) return c.v;
  const r = await fetch(base + path, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  const v = await r.json(); cache.set(path, { t: Date.now(), v }); if (cache.size > 400) cache.clear();
  return v;
}
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const eta = createEta();

export default async function handler(req, res) {
  const q = req.query || {};
  const base = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  try {
    const st = await getJSON(base, '/transit/stops.json');
    let stops = [];
    if (q.stop) stops = st.stops.filter((s) => s[0] === String(q.stop));
    else if (q.name) { const n = norm(q.name); stops = st.stops.filter((s) => norm(s[1]) === n); if (!stops.length) stops = st.stops.filter((s) => norm(s[1]).includes(n)).slice(0, 6); }
    if (!stops.length) { res.status(404).json({ error: 'stop not found', hint: 'use ?name= (stop name) or ?stop=c:<id>' }); return; }
    stops = stops.slice(0, 8);
    const [cal, feed, routes] = await Promise.all([
      getJSON(base, '/transit/cal.json'),
      fetch(base + '/api/transit', { signal: AbortSignal.timeout(9000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      Promise.all([...new Set(stops.flatMap((s) => s[4]))].map((k) => getJSON(base, `/transit/r/${k}.json`).then((R) => (R.patterns[0]?.seg ? R : prepRoute(R))).catch(() => null))),
    ]);
    const now = Date.now() / 1000;
    const vehicles = (feed?.v || []).map((a) => ({ op: a[0] === 'cm' ? 'm' : 'c', id: a[1], line: a[2], x: a[3], y: a[4], bearing: a[5], ts: feed.t - a[7], pattern: (a[9] || '').replace(/^\[[^\]]+\](?=\[)/, ''), trip: a[10] || '', stop: a[11] || '', status: a[12], route: a[13] || '', dir: a[14] >= 0 ? a[14] : null }));
    let rows = [];
    for (const s of stops) {
      const op = s[0][0], id = s[0].slice(2);
      rows.push(...eta.arrivals(id, routes.filter((R) => R && R.op === op), cal, vehicles.filter((v) => v.op === op), now));
    }
    if (q.line) rows = rows.filter((r) => r.line.toLowerCase() === String(q.line).toLowerCase());
    rows.sort((a, b) => a.t - b.t);
    const seen = new Set();
    rows = rows.filter((r) => !seen.has(r.key) && seen.add(r.key)).slice(0, Math.min(40, +q.limit || 12));
    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=15');
    res.status(200).json({
      t: Math.round(now),
      stops: stops.map((s) => ({ key: s[0], name: s[1], x: s[2], y: s[3] })),
      rows: rows.map((r) => ({ line: r.line, op: r.op === 'c' ? 'Carris' : 'Carris Metropolitana', head: r.head, eta: Math.round(r.t), inMin: Math.max(0, Math.round((r.t - now) / 60)), live: r.live, delay: r.live ? Math.round(r.delay) : null, sched: Math.round(r.sched), age: r.live ? Math.round(r.age) : null, away: r.live ? Math.round(r.away) : null })),
      note: feed ? 'live = GPS bus matched to its trip, ETA = timetable + delay measured at the GPS fix; otherwise timetable (GTFS)' : 'live feed unavailable: timetable only',
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'public, s-maxage=30');
    res.status(502).json({ error: String(e.message || e) });
  }
}
