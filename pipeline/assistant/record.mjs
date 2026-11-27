// Records one snapshot of everything the assistant's tools read from the network, so the eval runs every model on
// exactly the same live data (and can be re-run later). Run by the record-assistant GitHub Action (the cloud sandbox
// can't reach these hosts): node pipeline/assistant/record.mjs → pipeline/assistant/fixtures.json
import { writeFileSync } from 'node:fs';

const SITE = process.env.SITE || 'https://i-lisboa.vercel.app';
const UA = { 'user-agent': 'iLisboa assistant eval recorder (https://i-lisboa.vercel.app)' };
const urls = {};
async function J(u, key = u, map = (x) => x) {
  for (let k = 0; k < 2; k++) {
    try { const r = await fetch(u.startsWith('/') ? SITE + u : u, { headers: UA, signal: AbortSignal.timeout(20000) }); if (r.ok) { urls[key] = map(await r.json()); return urls[key]; } console.log(r.status, u); }
    catch (e) { console.log('ERR', u, e.message); }
  }
  return null;
}
const at = Math.round(Date.now() / 1000);
for (const k of ['/api/transit', '/api/weather', '/api/planes']) await J(k);
// traffic: main roads only, each segment as [level, class, mid x, mid y, length] (the tool accepts this compact form)
await J('/api/traffic', '/api/traffic', (tr) => ({ ...tr, segs: (tr.segs || []).filter((s) => s[1] <= 2).map((s) => { let L = 0; for (let i = 2; i + 3 < s.length; i += 2) L += Math.hypot(s[i + 2] - s[i], s[i + 3] - s[i + 1]); const k = 2 + 2 * Math.floor((s.length - 2) / 4); return [s[0], s[1], s[k], s[k + 1], Math.round(L)]; }) }));

const H = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover';
const om = (la, lo) => `https://api.open-meteo.com/v1/forecast?latitude=${la.toFixed(4)}&longitude=${lo.toFixed(4)}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,uv_index&hourly=${H}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset,uv_index_max&forecast_days=7&timezone=Europe%2FLisbon`;
// a lattice over the city (the eval matches the nearest point within ~3 km)
for (let la = 38.66; la <= 38.80; la += 0.025) for (let lo = -9.26; lo <= -9.05; lo += 0.03)
  await J(om(la, lo), om(la, lo), (v) => { for (const h of Object.keys(v.hourly)) v.hourly[h] = v.hourly[h].slice(0, 48); delete v.hourly_units; delete v.daily_units; delete v.current_units; return v; });

// landmarks the cases touch: Wikidata (only the fields the tool reads) and both Wikipedias
for (const q of ['Q215003', 'Q1601019', 'Q272781', 'Q432290', 'Q1464499', 'Q652806', 'Q168001', 'Q636780', 'Q1133712', 'Q2657972']) {
  const u = `https://www.wikidata.org/wiki/Special:EntityData/${q}.json`;
  const e = (await J(u))?.entities?.[q];
  if (!e) continue;
  urls[u] = { entities: { [q]: { sitelinks: Object.fromEntries(['ptwiki', 'enwiki'].filter((k) => e.sitelinks?.[k]).map((k) => [k, { title: e.sitelinks[k].title }])), descriptions: { pt: e.descriptions?.pt, en: e.descriptions?.en }, labels: { pt: e.labels?.pt, en: e.labels?.en } } } };
  for (const l of ['pt', 'en']) {
    const t = e.sitelinks?.[l + 'wiki']?.title;
    if (t) await J(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}?redirect=true`, undefined, (s) => ({ type: s.type, title: s.title, description: s.description, extract: s.extract, content_urls: { desktop: { page: s.content_urls?.desktop?.page } }, coordinates: s.coordinates }));
  }
}
// Carris Metropolitana real-time arrivals: Cacilhas terminal bays and Cais do Sodré
for (const id of ['320037', '320113', '320403', '320429', '320449', '320489', '320955', '320959', '320973', '321007', '360419', '360451', '360452'])
  await J(`https://api.carrismetropolitana.pt/v2/arrivals/by_stop/${id}`, undefined, (v) => v.filter((r) => { const t = r.estimated_arrival_unix ?? r.scheduled_arrival_unix; return t > at - 120 && t < at + 3 * 3600; }).map((r) => ({ line_id: r.line_id, headsign: r.headsign, estimated_arrival_unix: r.estimated_arrival_unix, scheduled_arrival_unix: r.scheduled_arrival_unix, observed_arrival_unix: r.observed_arrival_unix, vehicle_id: r.vehicle_id })));
// a TAP flight in the air, and its route (the flight-route case asks about it)
const pl = urls['/api/planes']?.a || [];
const call = ((pl.find((p) => /^TAP/.test(p[1]) && p[6] > 0) || pl.find((p) => p[1] && p[6] > 0)) || [])[1];
if (call) {
  const p = pl.find((x) => x[1] === call), la = 38.71375 + p[5] / 111013.6, lo = -9.13975 + p[4] / 86935.5;
  await J(`/api/route?call=${encodeURIComponent(call)}&lat=${la.toFixed(3)}&lon=${lo.toFixed(3)}`);
}
// headsigns of the Carris Metropolitana buses the tools may list
for (const v of (urls['/api/transit']?.v || []).filter((v) => v[0] === 'cm' && v[9]).slice(0, 120)) await J(`/api/route?pattern=${encodeURIComponent(v[9])}`);
for (const q of ['Segunda Circular', '2ª Circular', 'Avenida da Liberdade', 'Rua Augusta'])
  await J(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&accept-language=pt&countrycodes=pt&viewbox=-9.32,38.84,-8.95,38.6&bounded=1&q=${encodeURIComponent(q)}`);

writeFileSync('pipeline/assistant/fixtures.json', JSON.stringify({ at, site: SITE, call, urls }));
console.log('recorded', Object.keys(urls).length, 'urls at', new Date(at * 1000).toISOString(), 'call', call);
