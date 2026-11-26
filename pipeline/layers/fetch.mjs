// Static inputs for the map layers, run by the fetch-layers GitHub Action (the city sandbox can't reach these hosts).
//   node pipeline/layers/fetch.mjs /tmp/adm.geojson
// → public/layers/freguesias.json  freguesia + concelho borders over the diorama, with Censos 2021 population
// → public/layers/stations.json    IPMA weather stations around Lisbon
// → pipeline/layers/probe/*.txt    first bytes of every source, so formats can be checked from the sandbox
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fwd } from '../../api/_lib/geo.js';

const OUT = 'public/layers', PROBE = 'pipeline/layers/probe';
mkdirSync(OUT, { recursive: true }); mkdirSync(PROBE, { recursive: true });
const BOX = { W: -9.30, S: 38.645, E: -9.025, N: 38.81 };   // the 36 areas, with a little margin
const UA = { 'user-agent': 'iLisboa map layers (github.com/jpcpais01/iLisboa)' };

async function get(url, opt = {}) {
  const r = await fetch(url, { headers: { ...UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(60000), ...opt });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type'), buf, text: () => buf.toString('utf8') };
}
async function probe(name, url, opt) {
  try {
    const r = await get(url, opt);
    writeFileSync(`${PROBE}/${name}.txt`, `${r.status} ${r.type} ${r.buf.length} bytes\n${url}\n\n${r.text().slice(0, 6000)}`);
    console.log(name, r.status, r.buf.length);
    return r;
  } catch (e) { writeFileSync(`${PROBE}/${name}.txt`, `ERR ${e.message}\n${url}`); console.log(name, 'ERR', e.message); return null; }
}

// ─── weather sources (formats only; the live data is fetched by /api/weather at run time) ───
const om = 'https://api.open-meteo.com/v1/forecast?latitude=38.70,38.75,38.80&longitude=-9.25,-9.15,-9.05&current=temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m&daily=sunrise,sunset&forecast_days=2&timezone=Europe%2FLisbon&models=best_match';
await probe('open-meteo', om);
await probe('open-meteo-arome', om.replace('best_match', 'meteofrance_arome_france_hd'));
await probe('open-meteo-15', 'https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&minutely_15=precipitation,temperature_2m&forecast_minutely_15=8&past_minutely_15=8');
const st = await probe('ipma-stations', 'https://api.ipma.pt/open-data/observation/meteorology/stations/stations.json');
const ob = await probe('ipma-obs', 'https://api.ipma.pt/open-data/observation/meteorology/stations/observations.json');
await probe('ipma-obs3h', 'https://api.ipma.pt/open-data/observation/meteorology/stations/obs-surface.geojson');
await probe('rainviewer', 'https://api.rainviewer.com/public/weather-maps.json');
await probe('ipma-radar-list', 'https://api.ipma.pt/open-data/observation/meteorology/radar/radar.json');

if (st && st.status === 200) {
  try {
    const all = JSON.parse(st.text()), obs = ob && ob.status === 200 ? JSON.parse(ob.text()) : {};
    const latest = Object.keys(obs).sort().pop(), now = latest ? obs[latest] : {};
    const near = [];
    for (const f of all.features || all) {
      const [lon, lat] = f.geometry.coordinates, p = f.properties;
      if (lat < 38.45 || lat > 39.05 || lon < -9.55 || lon > -8.75) continue;
      const [x, y] = fwd(lat, lon);
      near.push({ id: String(p.idEstacao), name: p.localEstacao, lat, lon, x: Math.round(x), y: Math.round(y), has: !!now[p.idEstacao] });
    }
    writeFileSync(`${OUT}/stations.json`, JSON.stringify(near));
    console.log('stations', near.length, near.filter((s) => s.has).length, 'reporting');
  } catch (e) { console.log('stations ERR', e.message); }
}

// ─── census sources ───
await probe('ine-pop', 'https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0011609&Dim1=S7A2021&lang=PT');
await probe('ine-meta', 'https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0011609&lang=PT');

// ─── borders: OSM boundary relations (imported from the official CAOP) ───
const gj = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inBox = (r) => r.some(([lon, lat]) => lon > BOX.W && lon < BOX.E && lat > BOX.S && lat < BOX.N);
function simplify(pts, tol) {   // Douglas–Peucker on [x,y]
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const regions = [];
for (const f of gj.features) {
  const p = f.properties || {}, lvl = +p.admin_level;
  if (lvl !== 7 && lvl !== 8) continue;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
  if (!polys.some((pl) => inBox(pl[0]))) continue;
  const rings = [];
  let area = 0;
  for (const pl of polys) for (const [ri, ring] of pl.entries()) {
    const xy = simplify(ring.map(([lon, lat]) => fwd(lat, lon)), lvl === 8 ? 4 : 6).map(([x, y]) => [Math.round(x), Math.round(y)]);
    if (xy.length < 4) continue;
    let a = 0; for (let i = 0; i < xy.length - 1; i++) a += xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1];
    area += (ri === 0 ? 1 : -1) * Math.abs(a / 2);
    rings.push({ hole: ri > 0, p: xy.flat() });
  }
  regions.push({ lvl, name: p.name, ine: p['ref:INE'] || p['dicofre'] || p['ref'] || null, wd: p.wikidata || null, popOsm: p.population ? +p.population : null, popDate: p['population:date'] || p['source:population'] || null, area: Math.round(area), rings });
}
console.log('regions', regions.length, regions.filter((r) => r.lvl === 8).length, 'freguesias');
writeFileSync(`${PROBE}/osm-regions.txt`, regions.map((r) => `${r.lvl} ${r.ine} ${r.wd} ${r.popOsm} ${r.popDate} ${r.area} ${r.name}`).join('\n'));

// population: Censos 2021 from Wikidata (P1082 with point in time 2021), by the OSM wikidata link
const qids = regions.map((r) => r.wd).filter(Boolean);
if (qids.length) {
  const q = `SELECT ?f ?pop ?t ?code WHERE { VALUES ?f { ${qids.map((x) => 'wd:' + x).join(' ')} }
    OPTIONAL { ?f p:P1082 ?s . ?s ps:P1082 ?pop . OPTIONAL { ?s pq:P585 ?t } }
    OPTIONAL { ?f wdt:P6324 ?code } }`;
  const r = await probe('wikidata', 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { headers: { accept: 'application/sparql-results+json' } });
  try {
    const rows = JSON.parse(r.text()).results.bindings, by = {};
    for (const b of rows) {
      const id = b.f.value.split('/').pop(), t = b.t ? b.t.value.slice(0, 4) : '', pop = b.pop ? +b.pop.value : null;
      const e = (by[id] ||= { all: [] });
      if (pop) e.all.push([t, pop]);
      if (b.code) e.code = b.code.value;
    }
    for (const reg of regions) {
      const e = by[reg.wd]; if (!e) continue;
      const c21 = e.all.find(([t]) => t === '2021');
      const best = c21 || e.all.sort((a, b) => b[0].localeCompare(a[0]))[0];
      if (best) { reg.pop = best[1]; reg.popYear = best[0] || null; }
      if (e.code && !reg.ine) reg.ine = e.code;
    }
    writeFileSync(`${PROBE}/wikidata-pop.txt`, regions.map((r) => `${r.lvl} ${r.name}: ${r.pop} (${r.popYear}) all=${JSON.stringify(by[r.wd]?.all || [])}`).join('\n'));
  } catch (e) { console.log('wikidata parse ERR', e.message); }
}
writeFileSync(`${OUT}/freguesias.json`, JSON.stringify(regions.map(({ popOsm, popDate, ...r }) => ({ ...r, pop: r.pop ?? popOsm ?? null, popYear: r.popYear ?? (popOsm ? popDate : null) }))));
console.log('wrote', `${OUT}/freguesias.json`);
