// Live aircraft around Lisbon from adsb.lol (community ADS-B network, open data, no key).
import { fwd, r1 } from './_lib/geo.js';

const URL = 'https://api.adsb.lol/v2/point/38.73/-9.15/45';   // 45 nm: arrivals and departures of Humberto Delgado
const GEOID = 55;   // m: WGS-84 ellipsoid above mean sea level at Lisbon (ADS-B geometric altitude is ellipsoidal)

export default async function handler(req, res) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  let body;
  try {
    const r = await fetch(URL, { signal: ctl.signal, headers: { 'user-agent': 'iLisboa diorama (live layer)' } });
    if (!r.ok) throw new Error(`adsb.lol ${r.status}`);
    body = await r.json();
  } catch (e) {
    res.setHeader('Cache-Control', 'public, s-maxage=5');
    return res.status(502).json({ error: String(e.message || e) });
  } finally { clearTimeout(t); }
  const now = (body.now || Date.now()) / 1000;
  const out = [];   // [hex, callsign, type, reg, x, y, alt m (or -1 on ground), track°, ground speed m/s, vertical m/s, age s]
  for (const a of body.ac || []) {
    if (a.lat == null || a.lon == null) continue;
    if (a.t === 'TWR' || a.type === 'adsb_icao_nt' && a.gs === 0) continue;   // ground stations and parked transponders
    if ((a.seen_pos ?? 0) > 30) continue;
    const ground = a.alt_baro === 'ground';
    const alt = ground ? -1 : a.alt_geom != null ? a.alt_geom * 0.3048 - GEOID : (+a.alt_baro || 0) * 0.3048;
    const [x, y] = fwd(a.lat, a.lon);
    out.push([a.hex, (a.flight || '').trim(), a.t || '', a.r || '', r1(x), r1(y), Math.round(alt), r1(a.track ?? a.true_heading ?? 0), r1((a.gs || 0) * 0.5144), r1(((a.geom_rate ?? a.baro_rate) || 0) * 0.00508), r1(a.seen_pos ?? 0)]);
  }
  res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=10');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ t: Math.round(now), a: out }));
}
