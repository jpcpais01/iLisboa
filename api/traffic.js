// Live road traffic from TomTom Traffic Flow vector tiles (free tier, needs TOMTOM_KEY in the Vercel env).
// Without a key it answers {source: "none"} and the viewer falls back to its typical-traffic estimate.
// The whole city is fetched as one CDN-cached response (~100 z14 tiles every 5 min at most, inside the free 50k-tile daily quota).
import { decodeTile } from './_lib/mvt.js';
import { fwd, BBOX, r1 } from './_lib/geo.js';

const Z = 14;
const tx = (lon) => ((lon + 180) / 360) * 2 ** Z;
const ty = (lat) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z;
const lonOf = (x) => (x / 2 ** Z) * 360 - 180;
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** Z))) * 180) / Math.PI;

export default async function handler(req, res) {
  const key = process.env.TOMTOM_KEY;
  res.setHeader('Content-Type', 'application/json');
  if (!key) { res.setHeader('Cache-Control', 'public, s-maxage=600'); return res.status(200).send('{"source":"none"}'); }
  const x0 = Math.floor(tx(BBOX.W)), x1 = Math.floor(tx(BBOX.E)), y0 = Math.floor(ty(BBOX.N)), y1 = Math.floor(ty(BBOX.S));
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  const segs = []; let failed = 0, lastErr = '';
  await Promise.all(jobs.map(async ([x, y]) => {
    const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${Z}/${x}/${y}.pbf?key=${encodeURIComponent(key.trim())}`;   // default tags already carry road_type, traffic_level, road_closure
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`tomtom ${r.status}: ${(await r.text()).slice(0, 160).replaceAll(key.trim(), '…')}`);
      for (const L of decodeTile(await r.arrayBuffer())) for (const F of L.feats) {
        const lvl = F.props.road_closure ? 0 : F.props.traffic_level;
        if (typeof lvl !== 'number') continue;
        const cls = { Motorway: 0, 'International road': 0, 'Major road': 1, 'Secondary road': 2, 'Connecting road': 3, 'Major local road': 4, 'Local road': 5, 'Minor local road': 6 }[F.props.road_type] ?? 4;
        if (cls > 5) continue;   // minor local streets: noise on a city-wide map, a third of the payload
        for (const line of F.lines) {
          const pts = [];
          for (const [px, py] of line) {
            const [mx, my] = fwd(latOf(y + py / L.extent), lonOf(x + px / L.extent));
            pts.push(Math.round(mx), Math.round(my));
          }
          if (pts.length >= 4) segs.push([Math.round(lvl * 100), cls, ...pts]);
        }
      }
    } catch (e) { failed++; lastErr = String(e.message || e); }
  }));
  if (failed === jobs.length) { res.setHeader('Cache-Control', 'public, s-maxage=60'); return res.status(502).send(JSON.stringify({ source: 'tomtom', error: lastErr })); }
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=120');   // ~100 tiles × 288/day stays well inside TomTom's free 50k tiles
  res.status(200).send(JSON.stringify({ source: 'tomtom', t: Math.round(Date.now() / 1000), tiles: jobs.length, failed, segs }));
}
