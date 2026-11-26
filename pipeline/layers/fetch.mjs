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
const rv = await probe('rainviewer', 'https://api.rainviewer.com/public/weather-maps.json');
try {
  const m = JSON.parse(rv.text()), last = m.radar.past.at(-1);
  for (const [z, x, y] of [[6, 30, 24], [7, 60, 48], [8, 121, 97], [10, 486, 391]]) for (const c of [0, 2]) {
    const u = `${m.host}${last.path}/256/${z}/${x}/${y}/${c}/0_0.png`, r = await get(u);
    writeFileSync(`${PROBE}/rv-${z}-${c}.txt`, `${r.status} ${r.type} ${r.buf.length} cors=${r.status} ${u}`);
  }
} catch (e) { console.log('rv tiles ERR', e.message); }

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
function simplify(pts, tol) {   // Douglas–Peucker on [x,y]; a closed ring is split at its farthest point first
  if (pts.length < 4) return pts;
  const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
  if (fx === lx && fy === ly) {
    let far = 1, fd = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = Math.hypot(pts[i][0] - fx, pts[i][1] - fy); if (d > fd) { fd = d; far = i; } }
    return [...simplify(pts.slice(0, far + 1), tol).slice(0, -1), ...simplify(pts.slice(far), tol)];
  }
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

// population: OSM carries the Censos 2021 count on most boundaries; INE's own table fills the gaps (and checks the rest)
const norm = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
try {
  const ine = JSON.parse((await get('https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0011609&Dim1=S7A2021&Dim3=T&Dim4=T&lang=PT')).text());
  const rows = ine[0].Dados['2021'], by = new Map();
  writeFileSync(`${PROBE}/ine-rows.txt`, JSON.stringify(rows.slice(0, 5), null, 1));
  for (const r of rows) if ((r.dim_3 === 'T' || r.dim_3_t === 'HM') && (r.dim_4 === 'T' || /total/i.test(r.dim_4_t || ''))) {
    const k = norm(r.geodsg); if (!by.has(k)) by.set(k, []); by.get(k).push({ code: r.geocod, pop: +r.valor });
  }
  const log = [];
  for (const reg of regions) {
    const c = by.get(norm(reg.name)) || [];
    // only codes of the concelhos around the diorama (names repeat across the country: Alvalade, São Vicente, Seixal…)
    const AREA = /^(1106|1107|1110|1111|1115|1116|1502|1503|1504|1506|1507|1510)/;
    const pick = c.find((e) => AREA.test(e.code) && (reg.lvl === 8 ? e.code.length === 6 : e.code.length === 4));
    if (pick) { reg.ine = reg.ine || pick.code; reg.popIne = pick.pop; }
    log.push(`${reg.lvl} ${reg.name}: osm ${reg.popOsm} (${reg.popDate}) ine ${pick?.pop} ${pick?.code} [${c.length}]`);
  }
  writeFileSync(`${PROBE}/ine-match.txt`, log.join('\n'));
} catch (e) { console.log('ine ERR', e.message); }
writeFileSync(`${OUT}/freguesias.json`, JSON.stringify(regions.map(({ popOsm, popDate, popIne, ...r }) => ({ ...r, pop: popIne ?? popOsm ?? null, popSrc: popIne ? 'INE Censos 2021' : popOsm ? `OSM (${popDate || '?'})` : null }))));
console.log('wrote', `${OUT}/freguesias.json`);
