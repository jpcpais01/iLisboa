// Weather over the diorama, one CDN-cached answer for every viewer (10 min):
//  · grid: Open-Meteo current conditions on a 7×5 lattice over the city (model, ~1–2 km AROME/ICON, already downscaled
//    by Open-Meteo to each point's real elevation) — the shape of the temperature and wind fields;
//  · stations: IPMA's latest hourly readings at its weather stations around Lisbon — measured, used to correct the model;
//  · now / hourly / daily: city-centre conditions and a 48 h forecast for the HUD.
// Free sources, no key. Open-Meteo is free for non-commercial use (10k calls/day: this is ≤ 144×36 a day).
import { fwd, BBOX, r1 } from './_lib/geo.js';

const NX = 7, NY = 5;
const CUR = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,showers,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';
const HOURLY = 'temperature_2m,weather_code,is_day,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m,cloud_cover';
// IPMA wind direction classes (idDireccVento): 1 N, 2 NE … 8 NW, 9 N again (obs-surface labels 9 as "N"); 0 calm
const DIR8 = [null, 0, 45, 90, 135, 180, 225, 270, 315, 0];

const timed = (url, ms = 9000) => fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'iLisboa diorama (weather layer)' } });

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const lats = [], lons = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    lats.push((BBOX.S + ((j + 0.5) / NY) * (BBOX.N - BBOX.S)).toFixed(4));
    lons.push((BBOX.W + ((i + 0.5) / NX) * (BBOX.E - BBOX.W)).toFixed(4));
  }
  const om = 'https://api.open-meteo.com/v1/forecast';
  const gridUrl = `${om}?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=${CUR}&timezone=Europe%2FLisbon`;
  const cityUrl = `${om}?latitude=38.7139&longitude=-9.1394&current=${CUR}&hourly=${HOURLY}&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min&past_hours=6&forecast_hours=48&timezone=Europe%2FLisbon`;
  const [g, c, st, ob] = await Promise.allSettled([
    timed(gridUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`open-meteo ${r.status}`)))),
    timed(cityUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`open-meteo ${r.status}`)))),
    timed('https://api.ipma.pt/open-data/observation/meteorology/stations/stations.json').then((r) => r.json()),
    timed('https://api.ipma.pt/open-data/observation/meteorology/stations/observations.json').then((r) => r.json()),
  ]);
  if (g.status !== 'fulfilled' && c.status !== 'fulfilled') {
    res.setHeader('Cache-Control', 'public, s-maxage=30');
    return res.status(502).send(JSON.stringify({ error: String(g.reason?.message || g.reason) }));
  }
  const out = { t: Math.round(Date.now() / 1000), src: ['Open-Meteo'] };

  if (g.status === 'fulfilled') {
    const pts = Array.isArray(g.value) ? g.value : [g.value];
    const f = (k) => pts.map((p) => r1(p.current?.[k] ?? NaN));
    out.grid = {
      nx: NX, ny: NY,
      // the lattice as asked (Open-Meteo answers with its model cell's centre, which repeats across neighbours)
      x: lons.slice(0, NX).map((lon) => Math.round(fwd(+lats[0], +lon)[0])),
      y: lats.filter((_, k) => k % NX === 0).map((lat) => Math.round(fwd(+lat, +lons[0])[1])),
      elev: pts.map((p) => Math.round(p.elevation ?? 0)),
      T: f('temperature_2m'), rh: f('relative_humidity_2m'), ws: f('wind_speed_10m'), wd: f('wind_direction_10m'), gust: f('wind_gusts_10m'),
      P: f('precipitation'), cc: f('cloud_cover'), code: f('weather_code'),
      time: pts[0]?.current?.time,
    };
  }
  if (c.status === 'fulfilled') {
    const v = c.value;
    out.current = v.current; out.hourly = v.hourly; out.daily = v.daily; out.utcOffset = v.utc_offset_seconds;
  }
  if (st.status === 'fulfilled' && ob.status === 'fulfilled') {
    try {
      const times = Object.keys(ob.value).sort();
      const stations = [];
      for (const ft of st.value.features || st.value) {
        const [lon, lat] = ft.geometry.coordinates, p = ft.properties, id = String(p.idEstacao);
        if (lat < 38.55 || lat > 38.92 || lon < -9.45 || lon > -8.9) continue;
        // newest hour that has a real temperature for this station (-99 = missing)
        let o = null, at = null;
        for (let k = times.length - 1; k >= 0 && !o; k--) { const r = ob.value[times[k]]?.[id]; if (r && r.temperatura > -50) { o = r; at = times[k]; } }
        if (!o) continue;
        const [x, y] = fwd(lat, lon), ok = (v) => (v != null && v > -50 ? v : null);
        stations.push({
          id, name: p.localEstacao, x: Math.round(x), y: Math.round(y), at,
          T: ok(o.temperatura), hum: ok(o.humidade), P: ok(o.precAcumulada),
          ws: ok(o.intensidadeVentoKM) ?? (ok(o.intensidadeVento) != null ? r1(o.intensidadeVento * 3.6) : null),
          wd: DIR8[o.idDireccVento] ?? null, hPa: ok(o.pressao),
        });
      }
      out.stations = stations; out.src.push('IPMA');
    } catch { /* stations are a refinement only */ }
  }
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
  res.status(200).send(JSON.stringify(out));
}
