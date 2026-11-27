// The assistant's tools: each one reads what the viewer reads (static layers, live feeds) and answers with a small,
// already-summarised JSON so a small model can't get lost in raw data. Tools that change the view (show_on_map,
// set_layer, follow_vehicle) don't run here: they are queued as actions and the browser performs them.
import { city, whereIs, nearName, score, norm, fwd, inv, ll } from './data.js';

const CM = 'https://api.carrismetropolitana.pt/v2';
const LIS = fwd(38.7813, -9.1359);   // Humberto Delgado airport
const KIND = { bus: 'Carris bus', tram: 'Carris tram (elétrico)', lift: 'Carris funicular/lift (elevador)', cm: 'Carris Metropolitana bus' };
const LAYERS = ['traffic', 'transit', 'planes', 'temperatura', 'vento', 'chuva', 'freguesias', 'densidade'];
const dist = (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]));
const pt = (p) => (p && isFinite(p.lat) && isFinite(p.lon) ? fwd(+p.lat, +p.lon) : null);

export function lisbonClock(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' })
    .formatToParts(now).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const sec = +p.hour * 3600 + +p.minute * 60 + +p.second;
  return { ymd: `${p.year}${p.month}${p.day}`, date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, hm: `${p.hour}:${p.minute}`, sec };
}
const hm = (s) => { s = ((Math.round(s / 60) % 1440) + 1440) % 1440; return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// ─── definitions (what the model sees) ───
export const TOOL_DEFS = [
  {
    name: 'find_place',
    description: 'Find a place in or around Lisbon by name: landmarks, parishes (freguesias), Metro stations, bus/tram stops, streets, neighbourhoods. Returns coordinates, type, parish and ids (stop_id for stops, qid for landmarks). Use it before any tool that needs a location or a stop.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Place name, e.g. "Cais do Sodré", "Alfama", "Rua Augusta", "Torre de Belém"' }, kind: { type: 'string', enum: ['any', 'stop', 'metro', 'landmark', 'parish', 'street'], description: 'Restrict to one kind (default any)' }, line: { type: 'string', description: 'With kind "stop": only stops served by this line, e.g. "728"' } }, required: ['query'] },
  },
  {
    name: 'parish_stats',
    description: "Population, area and density of the freguesias (parishes) shown in the app (INE Census 2021), with rankings, and municipality totals. Give a name for one parish or municipality, or leave it out and sort to rank them.",
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Parish or municipality name (optional)' }, sort: { type: 'string', enum: ['density', 'population', 'area'], description: 'Ranking order when no name is given' }, municipality: { type: 'string', description: 'Limit the ranking to one municipality, e.g. "Lisboa"' }, limit: { type: 'integer' } } },
  },
  {
    name: 'weather',
    description: 'Weather at a point in Lisbon: current conditions (model, downscaled to the point), the nearest IPMA weather-station reading, the next 24 h and the next 7 days, sunrise/sunset. Defaults to the city centre.',
    input_schema: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, label: { type: 'string', description: 'Name of the place, for the answer' } } },
  },
  {
    name: 'transit_vehicles',
    description: 'LIVE positions of Carris buses, trams (elétricos), funiculars and Carris Metropolitana buses right now (GPS, refreshed every ~15 s). Filter by line and/or by distance to a point. Gives where each vehicle is (near what, which parish), speed, age of the fix. Without filters: a city-wide summary.',
    input_schema: { type: 'object', properties: { line: { type: 'string', description: 'Line number, e.g. "28E", "15E", "728", "736", "3001"' }, lat: { type: 'number' }, lon: { type: 'number' }, radius_m: { type: 'integer', description: 'Default 700' } } },
  },
  {
    name: 'stop_arrivals',
    description: 'Next arrivals at a bus/tram stop (Carris or Carris Metropolitana). Carris Metropolitana: real-time estimates where available, else timetable. Carris: timetable. Get stop_id from find_place (kind "stop"). Several stops can share a name (one per direction): pass each id you care about.',
    input_schema: { type: 'object', properties: { stop_id: { type: 'string', description: 'e.g. "c:12345" or "m:060001"' }, line: { type: 'string', description: 'Only this line (optional)' }, minutes: { type: 'integer', description: 'Look ahead window, default 60' } }, required: ['stop_id'] },
  },
  {
    name: 'metro',
    description: "Metro de Lisboa: lines, stations, and typical train frequency now (from the timetable model; the Metro doesn't publish live train positions). Give a station and/or line.",
    input_schema: { type: 'object', properties: { station: { type: 'string' }, line: { type: 'string', description: 'Azul, Amarela, Verde or Vermelha' } } },
  },
  {
    name: 'planes',
    description: 'LIVE aircraft around Lisbon (ADS-B, within ~80 km): counts, arrivals and departures at Humberto Delgado airport (LIS), altitude, speed, and the route (origin → destination) of a flight by callsign.',
    input_schema: { type: 'object', properties: { callsign: { type: 'string', description: 'e.g. "TAP1234" (optional)' }, lat: { type: 'number', description: 'Optional point: planes overhead / nearest' }, lon: { type: 'number' } } },
  },
  {
    name: 'traffic',
    description: 'LIVE road traffic (TomTom flow): city-wide congestion on main roads and the slowest areas, or around a point (speed as % of free flow).',
    input_schema: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, radius_m: { type: 'integer', description: 'Default 1200' } } },
  },
  {
    name: 'landmark_info',
    description: "Facts about a landmark or famous building from Wikipedia (the same card the app shows when you tap it): description, summary, link, location. Accepts a name or a Wikidata id.",
    input_schema: { type: 'object', properties: { name: { type: 'string' }, qid: { type: 'string' }, lang: { type: 'string', enum: ['pt', 'en'] } } },
  },
  {
    name: 'show_on_map',
    description: "Move the 3D map camera: fly to a landmark (opens its card) or to a point. Use when the user asks to see/show/go to a place, or when showing it clearly helps. Don't use it for every answer.",
    input_schema: { type: 'object', properties: { qid: { type: 'string', description: 'Landmark Wikidata id from find_place/landmark_info (preferred for landmarks)' }, lat: { type: 'number' }, lon: { type: 'number' }, scale: { type: 'string', enum: ['street', 'neighbourhood', 'city'] }, label: { type: 'string' } } },
  },
  {
    name: 'set_layer',
    description: 'Turn a map layer on or off: traffic, transit (live buses/trams/Metro), planes, temperatura, vento (wind), chuva (rain radar), freguesias (parish borders), densidade (population density).',
    input_schema: { type: 'object', properties: { layer: { type: 'string', enum: LAYERS }, on: { type: 'boolean' } }, required: ['layer', 'on'] },
  },
  {
    name: 'follow_vehicle',
    description: 'Follow a live vehicle or plane with the 3rd-person camera. Use the id returned by transit_vehicles (e.g. "c2799") or planes (hex, e.g. "4ca80b").',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['transit', 'planes'] }, id: { type: 'string' } }, required: ['kind', 'id'] },
  },
];
export const TOOL_LABELS = {
  find_place: ['a procurar o sítio', 'looking it up'], parish_stats: ['a ver as freguesias', 'checking the parishes'], weather: ['a ver o tempo', 'checking the weather'],
  transit_vehicles: ['a ver os transportes ao vivo', 'checking live transport'], stop_arrivals: ['a ver as chegadas', 'checking arrivals'], metro: ['a ver o Metro', 'checking the Metro'],
  planes: ['a ver os aviões', 'checking the planes'], traffic: ['a ver o trânsito', 'checking traffic'], landmark_info: ['a ler a Wikipédia', 'reading Wikipedia'],
  show_on_map: ['a mostrar no mapa', 'showing it on the map'], set_layer: ['a ligar a camada', 'switching the layer'], follow_vehicle: ['a seguir o veículo', 'following it'],
  web_search: ['a pesquisar na internet', 'searching the web'],
};

// ─── implementations ───
export async function runTool(name, input, ctx) {
  const f = IMPL[name];
  if (!f) return { error: `unknown tool ${name}` };
  try { return await f(input || {}, ctx); } catch (e) { return { error: String(e.message || e).slice(0, 300) }; }
}

const IMPL = {
  async find_place({ query, kind = 'any', line }, ctx) {
    const C = await city(ctx.get, ctx.origin);
    if (!query) return { error: 'query is required' };
    const out = [], want = (k) => kind === 'any' || kind === k;
    const push = (o, s, x, y) => out.push({ ...o, score: Math.round(s * 100) / 100, ...ll(inv(x, y)), ...whereIs(C, x, y), _x: x, _y: y });
    if (want('landmark')) for (const g of C.landmarks) { const s = Math.max(score(query, g.name), g.nameEn ? score(query, g.nameEn) : 0); if (s > 0.5) push({ type: 'landmark', name: g.name, qid: g.wd || undefined, osm_kind: g.kind }, s, g.x, g.y); }
    if (want('parish')) for (const p of C.parishes) { const s = score(query, p.name); if (s > 0.5) push({ type: 'parish', name: p.name }, s, p.cx, p.cy); }
    if (want('metro')) for (const st of C.stations) { const s = Math.max(score(query, st.name), score(query, 'metro ' + st.name)); if (s > 0.5) push({ type: 'metro_station', name: st.name, lines: st.lines }, s + 0.02, st.x, st.y); }
    if (want('stop')) {
      const hits = [];
      const ln = line ? norm(line).replace(/\s/g, '') : null;
      for (const s of C.stops) {
        const sc = score(query, s[1]); if (sc <= 0.55) continue;
        if (ln && !s[4].some((k) => norm(C.routes[k]?.[0] || '').replace(/\s/g, '') === ln)) continue;
        hits.push([sc, s]);
      }
      hits.sort((a, b) => b[0] - a[0]);
      for (const [sc, s] of hits.slice(0, 8)) push({ type: 'stop', name: s[1], stop_id: s[0], operator: s[0][0] === 'c' ? 'Carris' : 'Carris Metropolitana', lines: [...new Set(s[4].map((k) => C.routes[k]?.[0]).filter(Boolean))].slice(0, 14) }, sc - 0.01, s[2], s[3]);
    }
    out.sort((a, b) => b.score - a.score);
    let res = out.slice(0, kind === 'stop' ? 8 : 6);
    // streets, neighbourhoods and anything else: OpenStreetMap's geocoder, limited to the Lisbon region
    if ((want('street') && (!res.length || res[0].score < 0.8)) || kind === 'street') {
      try {
        const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&accept-language=pt&countrycodes=pt&viewbox=-9.32,38.84,-8.95,38.6&bounded=1&q=${encodeURIComponent(query)}`;
        const r = await ctx.get(u, 86400);
        for (const n of r || []) { const [x, y] = fwd(+n.lat, +n.lon); push({ type: n.type === 'administrative' ? 'area' : n.category === 'highway' ? 'street' : n.type || 'place', name: n.display_name.split(',').slice(0, 2).join(','), source: 'OpenStreetMap' }, 0.7, x, y); }
        res = out.sort((a, b) => b.score - a.score).slice(0, 6);
      } catch { /* geocoder offline: local matches only */ }
    }
    // stops of the same name sit on both sides of the street: say how many and how far apart
    return { query, results: res.map(({ _x, _y, ...r }) => r), note: res.length ? undefined : 'No match in the app data. Try another spelling, or web_search.' };
  },

  async parish_stats({ name, sort = 'density', municipality, limit = 10 }, ctx) {
    const C = await city(ctx.get, ctx.origin);
    const all = C.parishes.filter((p) => p.pop);
    const rank = (key) => { const a = [...all].sort((x, y) => y[key] - x[key]); return (p) => a.indexOf(p) + 1; };
    const lisbon = all.filter((p) => p.muni === 'Lisboa'), rkL = (key) => { const a = [...lisbon].sort((x, y) => y[key] - x[key]); return (p) => (p.muni === 'Lisboa' ? a.indexOf(p) + 1 : undefined); };
    const card = (p) => ({ parish: p.name, municipality: p.muni, population: p.pop, area_km2: p.km2, density_per_km2: p.density, source: p.popSrc, rank_density_in_app: `${rank('density')(p)}/${all.length}`, rank_density_in_lisbon: rkL('density')(p) ? `${rkL('density')(p)}/${lisbon.length}` : undefined, rank_population_in_lisbon: rkL('pop')(p) ? `${rkL('pop')(p)}/${lisbon.length}` : undefined, ...ll(inv(p.cx, p.cy)) });
    const munis = C.munis.map((m) => ({ municipality: m.name, parishes_in_app: m.parishes, population_sum: m.popSum, area_km2: Math.round(m.area / 1e4) / 100, density_per_km2: m.popSum ? Math.round(m.popSum / (m.area / 1e6)) : null, parishes_without_population: m.missing.length ? m.missing : undefined }));
    if (name) {
      const best = C.parishes.map((p) => [score(name, p.name), p]).sort((a, b) => b[0] - a[0])[0];
      const bm = munis.map((m) => [score(name, m.municipality), m]).sort((a, b) => b[0] - a[0])[0];
      if (bm && bm[0] >= 0.99) return { municipality: bm[1], note: 'Only the parishes inside the app area are counted; Lisboa is complete (24 parishes).' };
      if (best && best[0] > 0.6) return best[1].pop ? card(best[1]) : { parish: best[1].name, municipality: best[1].muni, area_km2: best[1].km2, population: null, note: 'No population figure for this parish in the data.' };
      return { error: `No parish named ${name}.`, parishes: C.parishes.map((p) => p.name) };
    }
    const key = sort === 'population' ? 'pop' : sort === 'area' ? 'area' : 'density';
    const pool = municipality ? all.filter((p) => norm(p.muni) === norm(municipality)) : all;
    const lim = Math.max(1, Math.min(30, limit));
    const sorted = [...pool].sort((a, b) => b[key] - a[key]);
    return { sort, municipality: municipality || 'all in app', count: pool.length, top: sorted.slice(0, lim).map(card), bottom: sorted.slice(-3).reverse().map((p) => ({ parish: p.name, municipality: p.muni, [key === 'pop' ? 'population' : key === 'area' ? 'area_km2' : 'density_per_km2']: key === 'area' ? p.km2 : p[key] })), municipalities: munis };
  },

  async weather({ lat = 38.7139, lon = -9.1394, label }, ctx) {
    const H = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover';
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${(+lat).toFixed(4)}&longitude=${(+lon).toFixed(4)}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,uv_index&hourly=${H}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset,uv_index_max&forecast_days=7&timezone=Europe%2FLisbon`;
    const [om, city] = await Promise.allSettled([ctx.get(u, 600), ctx.get(`${ctx.origin}/api/weather`, 300)]);
    if (om.status !== 'fulfilled') throw new Error('weather service unavailable');
    const v = om.value, c = v.current, i0 = Math.max(0, v.hourly.time.indexOf(c.time.slice(0, 13) + ':00'));
    const hours = [];
    for (let i = i0 + 1; i < Math.min(v.hourly.time.length, i0 + 25); i += 3) hours.push({ time: v.hourly.time[i].slice(11), temp_c: v.hourly.temperature_2m[i], feels_c: v.hourly.apparent_temperature[i], sky: wmo(v.hourly.weather_code[i]), rain_prob: v.hourly.precipitation_probability[i], rain_mm: v.hourly.precipitation[i], wind_kmh: v.hourly.wind_speed_10m[i], gust_kmh: v.hourly.wind_gusts_10m[i] });
    const D = v.daily, days = D.time.map((t, k) => ({ date: t, sky: wmo(D.weather_code[k]), min_c: D.temperature_2m_min[k], max_c: D.temperature_2m_max[k], rain_mm: D.precipitation_sum[k], rain_prob: D.precipitation_probability_max[k], wind_max_kmh: D.wind_speed_10m_max[k], uv_max: D.uv_index_max[k] }));
    let station;
    if (city.status === 'fulfilled' && city.value.stations?.length) {
      const p = fwd(+lat, +lon), st = city.value.stations.map((s) => [dist(p, [s.x, s.y]), s]).sort((a, b) => a[0] - b[0])[0];
      if (st && st[0] < 9000) station = { name: st[1].name, km_away: Math.round(st[0] / 100) / 10, observed_utc: st[1].at, temp_c: st[1].T, humidity: st[1].hum, wind_kmh: st[1].ws, wind_from_deg: st[1].wd, rain_mm_last_hour: st[1].P, source: 'IPMA (measured)' };
    }
    return {
      place: label || 'Lisboa (centro)', ...ll([+lat, +lon]),
      now: { time: c.time.slice(11), temp_c: c.temperature_2m, feels_c: c.apparent_temperature, sky: wmo(c.weather_code), humidity: c.relative_humidity_2m, cloud_pct: c.cloud_cover, rain_mm: c.precipitation, wind_kmh: c.wind_speed_10m, wind_from: compass(c.wind_direction_10m), gust_kmh: c.wind_gusts_10m, uv: c.uv_index, source: 'Open-Meteo model at this point' },
      station, next_24h: hours, next_7_days: days, sunrise: D.sunrise[0]?.slice(11), sunset: D.sunset[0]?.slice(11),
    };
  },

  async transit_vehicles({ line, lat, lon, radius_m = 700 }, ctx) {
    const [C, d] = await Promise.all([city(ctx.get, ctx.origin), ctx.get(`${ctx.origin}/api/transit`, 15)]);
    const age = Math.max(0, Math.round(ctx.now().getTime() / 1000 - d.t));
    let vs = d.v.map(([kind, id, ln, x, y, bearing, speed, a, name, pattern]) => ({ kind, id, line: ln, x, y, bearing, speed, age: a + age, name, pattern }));
    const p = pt({ lat, lon });
    const want = line ? norm(line).replace(/\s/g, '') : null;
    if (want) vs = vs.filter((v) => { const l = norm(v.line).replace(/\s/g, ''); return l === want || l === want + 'e' || l.replace(/e$/, '') === want.replace(/e$/, ''); });
    if (p) vs = vs.map((v) => ({ ...v, d: dist(p, [v.x, v.y]) })).filter((v) => v.d <= Math.max(100, Math.min(5000, radius_m)) || (want && !lat)).sort((a, b) => a.d - b.d);
    const sum = {}; for (const v of d.v) sum[v[0]] = (sum[v[0]] || 0) + 1;
    if (!want && !p) {
      const byLine = {}; for (const v of vs) byLine[v.line] = (byLine[v.line] || 0) + 1;
      return { live: true, feed_age_s: age, vehicles_in_service: sum, kinds: KIND, busiest_lines: Object.entries(byLine).sort((a, b) => b[1] - a[1]).slice(0, 12), trams_by_line: count(d.v.filter((v) => v[0] === 'tram'), 2), feeds: d.status };
    }
    // Carris Metropolitana headsigns (one cached lookup per pattern)
    const show = vs.slice(0, 12);
    await Promise.all(show.filter((v) => v.pattern).slice(0, 6).map(async (v) => { try { v.headsign = (await ctx.get(`${ctx.origin}/api/route?pattern=${encodeURIComponent(v.pattern)}`, 3600)).headsign; } catch { /* optional */ } }));
    return {
      live: true, line: line || undefined, near: p ? { ...ll([+lat, +lon]), radius_m } : undefined, count: vs.length, feed_age_s: age,
      vehicles: show.map((v) => ({ id: v.id, type: KIND[v.kind], line: v.line, route: v.name || undefined, to: v.headsign, distance_m: v.d, near: nearName(C, v.x, v.y) || undefined, ...whereIs(C, v.x, v.y), speed_kmh: v.speed >= 0 ? Math.round(v.speed * 3.6) : undefined, gps_age_s: v.age, heading: v.bearing >= 0 ? compass(v.bearing) : undefined, ...ll(inv(v.x, v.y)) })),
      note: vs.length ? undefined : (want ? `No vehicle of line ${line} is reporting a position right now (it may not be running at this hour, or its GPS is off).` : 'No vehicles in that radius right now.'),
    };
  },

  async stop_arrivals({ stop_id, line, minutes = 60 }, ctx) {
    const C = await city(ctx.get, ctx.origin);
    const stop = C.stops.find((s) => s[0] === stop_id) || C.stops.find((s) => s[0].split(':')[1] === String(stop_id));
    if (!stop) return { error: `Unknown stop_id ${stop_id}. Use find_place with kind "stop" first.` };
    const [op, sid] = stop[0].split(':'), win = Math.max(10, Math.min(180, minutes)) * 60, clock = lisbonClock(ctx.now());
    const lineOk = (l) => !line || norm(l).replace(/\s/g, '') === norm(line).replace(/\s/g, '') || norm(l).replace(/e$/, '') === norm(line).replace(/e$/, '');
    let rows = [], source;
    if (op === 'm') {
      try {
        const a = await ctx.get(`${CM}/arrivals/by_stop/${encodeURIComponent(sid)}`, 20);
        const nowU = ctx.now().getTime() / 1000;
        for (const r of a) {
          const est = r.estimated_arrival_unix, sch = r.scheduled_arrival_unix, t = est ?? sch;
          if (t == null || t < nowU - 60 || t > nowU + win || r.observed_arrival_unix) continue;
          const ln = String(r.line_id || '').replace(/^\[[^\]]*\]/, '');
          if (!lineOk(ln)) continue;
          rows.push({ line: ln, to: r.headsign, in_min: Math.max(0, Math.round((t - nowU) / 60)), at: hm((t - nowU) + clock.sec), realtime: est != null, vehicle_id: r.vehicle_id ? 'm' + r.vehicle_id : undefined });
        }
        source = 'Carris Metropolitana API (real-time estimates where a bus is tracked, else timetable)';
      } catch (e) { source = 'Carris Metropolitana real-time unavailable (' + e.message + '); timetable'; }
    }
    if (!rows.length) {
      rows = await scheduled(ctx, C, stop, sid, op, clock, win, lineOk);
      source = source && op === 'm' ? source : op === 'c' ? 'Carris timetable (GTFS; Carris does not publish real-time arrival estimates)' : 'timetable (GTFS)';
    }
    rows.sort((a, b) => a.in_min - b.in_min);
    // the next one per line and direction first, then the rest: a stop with 15 lines shouldn't show only one line
    const seen = new Set(), first = [], rest = [];
    for (const r of rows) { const k = r.line + '|' + r.to; (seen.has(k) ? rest : first).push(r); seen.add(k); }
    const list = [...first, ...rest].slice(0, 14).sort((a, b) => a.in_min - b.in_min);
    return { stop: stop[1], stop_id: stop[0], ...ll(inv(stop[2], stop[3])), local_time: clock.hm, lines_here: [...new Set(stop[4].map((k) => C.routes[k]?.[0]).filter(Boolean))], arrivals: list, source, note: list.length ? undefined : `No departures in the next ${Math.round(win / 60)} min${line ? ' for line ' + line : ''}.` };
  },

  async metro({ station, line }, ctx) {
    const C = await city(ctx.get, ctx.origin), clock = lisbonClock(ctx.now());
    const weekend = /Saturday|Sunday/.test(clock.weekday), h = clock.sec / 3600;
    const lines = C.metro.filter((l) => !line || norm(l.name).includes(norm(line)));
    const st = station ? C.stations.map((s) => [score(station, s.name), s]).sort((a, b) => b[0] - a[0])[0] : null;
    if (station && (!st || st[0] < 0.6)) return { error: `No Metro station named ${station}.`, stations: C.stations.map((s) => s.name) };
    const pick = st ? lines.filter((l) => st[1].lines.includes(l.name)) : lines;
    return {
      local_time: clock.hm, day: clock.weekday, service_hours: '06:30–01:00 every day',
      station: st ? { name: st[1].name, lines: st[1].lines, ...ll(inv(st[1].x, st[1].y)), ...whereIs(C, st[1].x, st[1].y) } : undefined,
      lines: pick.map((l) => {
        const hw = headway(l.name, h < 3 ? h + 24 : h, weekend);
        const i = st ? l.stops.findIndex((s) => s.name === st[1].name) : -1;
        return { line: l.name, colour: l.colour, length_km: Math.round(l.L / 100) / 10, termini: [l.stops[0].name, l.stops[l.stops.length - 1].name], stations: l.stops.length, typical_frequency_now: hw ? `every ~${Math.round(hw / 60)} min` : 'closed now (service 06:30–01:00)', minutes_to_termini_from_station: i >= 0 ? [Math.round(tripTime(l.stops.slice(0, i + 1)) / 60), Math.round(tripTime(l.stops.slice(i)) / 60)] : undefined, stops: st ? undefined : l.stops.map((s) => s.name) };
      }),
      source: "estimated from Metro de Lisboa's typical timetable; the Metro publishes no live train positions. For disruptions (greves, perturbações) use web_search on metrolisboa.pt.",
    };
  },

  async planes({ callsign, lat, lon }, ctx) {
    const d = await ctx.get(`${ctx.origin}/api/planes`, 5);
    const age = Math.max(0, Math.round(ctx.now().getTime() / 1000 - d.t));
    const all = d.a.map(([hex, call, type, reg, x, y, alt, track, gs, vr, seen]) => ({ hex, call, type, reg, x, y, alt, track, gs, vr, seen }));
    const fmt = (a) => ({ id: a.hex, callsign: a.call || undefined, aircraft: a.type || undefined, registration: a.reg || undefined, on_ground: a.alt < 0 || undefined, altitude_m: a.alt >= 0 ? a.alt : undefined, speed_kmh: Math.round(a.gs * 3.6), heading: compass(a.track), climb: a.vr > 2 ? 'climbing' : a.vr < -2 ? 'descending' : 'level', km_from_airport: Math.round(dist([a.x, a.y], LIS) / 100) / 10, ...ll(inv(a.x, a.y)) });
    if (callsign) {
      const c = callsign.replace(/\s/g, '').toUpperCase(), a = all.find((p) => p.call.toUpperCase() === c || p.reg.replace('-', '').toUpperCase() === c.replace('-', ''));
      let route = null;
      try { const [la, lo] = a ? inv(a.x, a.y) : [38.77, -9.13]; route = await ctx.get(`${ctx.origin}/api/route?call=${encodeURIComponent(c)}&lat=${la.toFixed(3)}&lon=${lo.toFixed(3)}`, 3600); } catch { /* optional */ }
      return { live: true, found_in_lisbon_airspace: !!a, plane: a ? fmt(a) : undefined, route: route?.from ? { from: route.from, to: route.to, plausible: route.plausible } : 'unknown', note: a ? undefined : `${c} is not within ~80 km of Lisbon right now.` };
    }
    const near = (a) => dist([a.x, a.y], LIS) < 30000;
    const arriving = all.filter((a) => a.alt >= 0 && a.alt < 3500 && a.vr < -1.5 && near(a)).sort((a, b) => dist([a.x, a.y], LIS) - dist([b.x, b.y], LIS));
    const departing = all.filter((a) => a.alt >= 0 && a.alt < 4000 && a.vr > 1.5 && near(a)).sort((a, b) => a.alt - b.alt);
    const p = pt({ lat, lon });
    return {
      live: true, feed_age_s: age, total_tracked: all.length, airborne: all.filter((a) => a.alt >= 0).length, on_ground_at_airport: all.filter((a) => a.alt < 0).length,
      landing_soon: arriving.slice(0, 5).map(fmt), just_departed: departing.slice(0, 5).map(fmt),
      overhead: p ? all.filter((a) => a.alt >= 0).map((a) => [dist(p, [a.x, a.y]), a]).sort((x, y) => x[0] - y[0]).slice(0, 4).map(([dd, a]) => ({ ...fmt(a), km_from_point: Math.round(dd / 100) / 10 })) : undefined,
      highest: all.filter((a) => a.alt >= 0).sort((a, b) => b.alt - a.alt).slice(0, 2).map(fmt),
      source: 'ADS-B (adsb.lol community network)',
    };
  },

  async traffic({ lat, lon, radius_m = 1200 }, ctx) {
    const [C, d] = await Promise.all([city(ctx.get, ctx.origin), ctx.get(`${ctx.origin}/api/traffic`, 120)]);
    if (d.source === 'none' || !d.segs) return { live: false, note: 'Live traffic is not available right now (no TomTom key). The map shows a typical-traffic estimate.' };
    // segments: [level % of free-flow speed, road class 0 motorway … 5 local, x0, y0, x1, y1 …]
    const segs = d.segs.map((s) => { if (s.length === 5) return { lvl: s[0], cls: s[1], x: s[2], y: s[3], L: s[4] }; let L = 0; for (let i = 2; i + 3 < s.length; i += 2) L += Math.hypot(s[i + 2] - s[i], s[i + 3] - s[i + 1]); const k = 2 + 2 * Math.floor((s.length - 2) / 4); return { lvl: s[0], cls: s[1], x: s[k], y: s[k + 1], L }; });
    const stats = (arr) => { let L = 0, W = 0, slow = 0, jam = 0; for (const s of arr) { L += s.L; W += s.L * s.lvl; if (s.lvl < 60) slow += s.L; if (s.lvl < 30) jam += s.L; } return L ? { km_measured: Math.round(L / 100) / 10, avg_speed_pct_of_free_flow: Math.round(W / L), slow_pct: Math.round((100 * slow) / L), jammed_pct: Math.round((100 * jam) / L) } : null; };
    const main = segs.filter((s) => s.cls <= 2);
    const p = pt({ lat, lon });
    // the slowest parishes on main roads (≥ 3 km of main road measured)
    const by = new Map();
    for (const s of main) { const w = whereIs(C, s.x, s.y).parish; if (!w) continue; let a = by.get(w); if (!a) by.set(w, (a = [])); a.push(s); }
    const slowest = [...by].map(([k, a]) => [k, stats(a)]).filter(([, s]) => s && s.km_measured >= 3).sort((a, b) => a[1].avg_speed_pct_of_free_flow - b[1].avg_speed_pct_of_free_flow).slice(0, 5).map(([k, s]) => ({ parish: k, ...s }));
    let around;
    if (p) {
      const r = Math.max(300, Math.min(4000, radius_m)), loc = segs.filter((s) => dist(p, [s.x, s.y]) <= r);
      const worst = loc.filter((s) => s.cls <= 3 && s.lvl < 50).sort((a, b) => a.lvl - b.lvl).slice(0, 5).map((s) => ({ speed_pct: s.lvl, road_class: ['motorway', 'major road', 'secondary road', 'connecting road', 'local road', 'local road'][s.cls], near: nearName(C, s.x, s.y, 600) || whereIs(C, s.x, s.y).parish, ...ll(inv(s.x, s.y)) }));
      around = { ...ll([+lat, +lon]), radius_m: r, all_roads: stats(loc), main_roads: stats(loc.filter((s) => s.cls <= 2)), slowest_spots: worst };
    }
    return { live: true, source: 'TomTom traffic flow', age_s: Math.max(0, Math.round(ctx.now().getTime() / 1000 - d.t)), citywide_main_roads: stats(main), slowest_parishes_main_roads: slowest, around, scale: '100 = free flow; <60 slow; <30 jammed' };
  },

  async landmark_info({ name, qid, lang = 'pt' }, ctx) {
    const C = await city(ctx.get, ctx.origin);
    let g = qid ? C.landmarks.find((x) => x.wd === qid) : null;
    if (!g && name) { const b = C.landmarks.map((x) => [Math.max(score(name, x.name), x.nameEn ? score(name, x.nameEn) : 0), x]).sort((a, b) => b[0] - a[0])[0]; if (b && b[0] > 0.6) g = b[1]; }
    const wdId = g?.wd || qid;
    const titles = {};
    let desc = '', label = '';
    if (wdId) {
      try {
        const e = (await ctx.get(`https://www.wikidata.org/wiki/Special:EntityData/${wdId}.json`, 86400)).entities?.[wdId];
        for (const l of ['pt', 'en']) if (e?.sitelinks?.[`${l}wiki`]) titles[l] = e.sitelinks[`${l}wiki`].title;
        desc = e?.descriptions?.[lang]?.value || e?.descriptions?.en?.value || ''; label = e?.labels?.[lang]?.value || e?.labels?.pt?.value || '';
      } catch { /* fall back to the OSM wikipedia tag */ }
    }
    if (g?.wp) { const m = g.wp.match(/^([a-z-]+):(.+)$/); if (m && !titles[m[1]]) titles[m[1]] = m[2]; }
    if (!g && !wdId) {
      if (!name) return { error: 'name or qid required' };
      titles[lang] = name;   // not one of the app's landmarks: try Wikipedia directly
    }
    const order = [lang, lang === 'pt' ? 'en' : 'pt'];
    for (const l of order) {
      if (!titles[l]) continue;
      try {
        const s = await ctx.get(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titles[l].replace(/ /g, '_'))}?redirect=true`, 86400);
        if (s.type === 'disambiguation') continue;
        return { in_app: !!g, name: g?.name || s.title, qid: wdId || undefined, wikipedia_title: s.title, description: s.description || desc, summary: s.extract, url: s.content_urls?.desktop?.page, ...(g ? { ...ll(inv(g.x, g.y)), ...whereIs(C, g.x, g.y) } : s.coordinates ? ll([s.coordinates.lat, s.coordinates.lon]) : {}) };
      } catch { /* next language */ }
    }
    return g || wdId ? { in_app: !!g, name: g?.name || label, qid: wdId, description: desc, summary: null, note: 'No Wikipedia article found.', ...(g ? { ...ll(inv(g.x, g.y)), ...whereIs(C, g.x, g.y) } : {}) } : { error: `${name} is not one of the app's landmarks and has no Wikipedia page by that name. Try web_search.` };
  },

  // ─── actions the browser carries out ───
  async show_on_map({ qid, lat, lon, scale = 'neighbourhood', label }, ctx) {
    if (!qid && !(isFinite(lat) && isFinite(lon))) return { error: 'give qid or lat+lon' };
    if (isFinite(lat) && !inArea(+lat, +lon)) return { error: 'That point is outside the 3D map (Lisbon and the river banks).' };
    ctx.action({ type: 'show', qid, lat, lon, scale, label });
    return { ok: true, shown: label || qid || `${lat},${lon}` };
  },
  async set_layer({ layer, on }, ctx) {
    if (!LAYERS.includes(layer)) return { error: `layer must be one of ${LAYERS.join(', ')}` };
    ctx.action({ type: 'layer', layer, on: on !== false });
    return { ok: true, layer, on: on !== false };
  },
  async follow_vehicle({ kind, id }, ctx) {
    if (!['transit', 'planes'].includes(kind) || !id) return { error: 'kind (transit|planes) and id required' };
    ctx.action({ type: 'follow', kind, id: String(id) });
    return { ok: true, following: id, note: 'The camera follows it; the user taps Sair to stop.' };
  },
};

// ─── helpers ───
function inArea(lat, lon) { return lat > 38.55 && lat < 38.9 && lon > -9.45 && lon < -8.85; }
function count(arr, i) { const o = {}; for (const v of arr) o[v[i]] = (o[v[i]] || 0) + 1; return o; }
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function compass(deg) { return isFinite(deg) && deg >= 0 ? COMPASS[Math.round(deg / 45) % 8] : undefined; }
function wmo(code) {
  if (code === 0) return 'clear'; if (code === 1) return 'mostly clear'; if (code === 2) return 'partly cloudy'; if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog'; if (code >= 51 && code <= 57) return 'drizzle'; if (code >= 61 && code <= 67) return code >= 65 ? 'heavy rain' : 'rain';
  if (code >= 71 && code <= 77) return 'snow'; if (code >= 80 && code <= 82) return 'showers'; if (code >= 95) return 'thunderstorm'; return 'unknown';
}
// typical Metro headway (s) by Lisbon hour (same model the map's Metro trains run on, src/live/transit.js)
const PEAK = { 'Linha Azul': 330, 'Linha Amarela': 300, 'Linha Verde': 290, 'Linha Vermelha': 390 };
function headway(line, h, weekend) {
  if (h < 6.5 || h >= 25) return null;
  if (weekend) return h >= 7.5 && h < 21 ? 510 : 660;
  if ((h >= 7 && h < 10) || (h >= 17 && h < 20)) return PEAK[line] || 330;
  if (h >= 10 && h < 17) return 450;
  if (h >= 20 && h < 22) return 540;
  return h < 7 ? 540 : 660;
}
function tripTime(stops) { let t = 0; for (let i = 1; i < stops.length; i++) t += (stops[i].s - stops[i - 1].s) / 14 + 18 + 25; return t; }

// timetable departures at one stop from the route files (public/transit/r, built by pipeline/transit/build.mjs)
async function scheduled(ctx, C, stop, sid, op, clock, win, lineOk) {
  const cal = await ctx.get(`${ctx.origin}/transit/cal.json`, 3600);
  const start = Date.UTC(+cal.start.slice(0, 4), +cal.start.slice(4, 6) - 1, +cal.start.slice(6, 8));
  const today = Math.round((Date.UTC(+clock.ymd.slice(0, 4), +clock.ymd.slice(4, 6) - 1, +clock.ymd.slice(6, 8)) - start) / 864e5);
  const svc = cal.svc[op] || [];
  const runs = (s, day) => day >= 0 && svc[s]?.[day] === '1';
  const rows = [];
  await Promise.all(stop[4].filter((k) => lineOk(C.routes[k]?.[0] || '')).slice(0, 24).map(async (key) => {
    let R; try { R = await ctx.get(`${ctx.origin}/transit/r/${key}.json`, 3600); } catch { return; }
    for (const p of R.patterns) {
      const i = p.stops.indexOf(sid); if (i < 0 || i === p.stops.length - 1) continue;   // the last stop is an arrival, not a departure
      const to = p.head || (C.stops.find((s) => s[0] === `${op}:${p.stops[p.stops.length - 1]}`)?.[1]) || '';
      for (const [, s, t0, pi] of p.trips) {
        for (const [day, shift] of [[today, 0], [today - 1, 86400]]) {
          if (!runs(s, day)) continue;
          const t = t0 + p.prof[pi][i] - shift, dt = t - clock.sec;
          if (dt >= -30 && dt <= win) rows.push({ line: R.line, to, in_min: Math.max(0, Math.round(dt / 60)), at: hm(t), realtime: false });
        }
      }
    }
  }));
  return rows;
}
