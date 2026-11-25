// Live public transport: Carris (Lisbon city buses, trams, lifts) + Carris Metropolitana (regional buses).
// Both sources are open and keyless. One CDN-cached response serves every viewer: upstream sees at most one
// request per ~15 s however many people are watching.
import { decodeVehicles } from './_lib/gtfsrt.js';
import ROUTES from './_lib/carris-routes.js';
import { fwd, inBox, r1 } from './_lib/geo.js';

const CARRIS = 'https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS/realtime/vehiclepositions';
const CM = 'https://api.carrismetropolitana.pt/v2/vehicles';
const STALE = 300;   // s: a vehicle silent for longer than this has left service

async function get(url, as) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'iLisboa diorama (live layer)' } }); if (!r.ok) throw new Error(`${r.status}`); return as === 'buf' ? new Uint8Array(await r.arrayBuffer()) : await r.json(); }
  finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  const now = Date.now() / 1000;
  const [carris, cm] = await Promise.allSettled([get(CARRIS, 'buf'), get(CM, 'json')]);
  const out = [];   // [kind, id, line, x, y, bearing|-1, speed m/s|-1, age s, headsign]
  const status = {};
  if (carris.status === 'fulfilled') {
    const { vehicles } = decodeVehicles(carris.value);
    let n = 0;
    for (const v of vehicles) {
      if (!isFinite(v.lat) || !inBox(v.lat, v.lon) || now - v.ts > STALE) continue;
      const [line, name] = ROUTES[v.route] || [v.route.split('_')[0], ''];
      const m = /^(\d+)E$/.exec(line);
      const kind = m ? (+m[1] < 50 ? 'tram' : 'lift') : 'bus';
      const [x, y] = fwd(v.lat, v.lon);
      out.push([kind, 'c' + v.id, line, r1(x), r1(y), v.bearing || -1, v.speed >= 0 ? r1(v.speed) : -1, Math.round(now - v.ts), name]); n++;
    }
    status.carris = n;
  } else status.carris = 'error: ' + carris.reason?.message;
  if (cm.status === 'fulfilled') {
    let n = 0;
    for (const v of cm.value) {
      const ts = v.timestamp / 1000;
      if (!inBox(v.lat, v.lon) || now - ts > STALE) continue;
      const [x, y] = fwd(v.lat, v.lon);
      out.push(['cm', 'm' + v.id, v.line_id || '', r1(x), r1(y), v.bearing ?? -1, v.speed >= 0 ? r1(v.speed / 3.6) : -1, Math.round(now - ts), '']); n++;
    }
    status.cm = n;
  } else status.cm = 'error: ' + cm.reason?.message;
  res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ t: Math.round(now), status, v: out }));
}
