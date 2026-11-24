// plan view of a bbox with OSM building ids → SVG (authoring aid)
import fs from 'node:fs';
import { loadOverpass, extractPolygons, extractLines, makeProjection } from './lib/osm.mjs';
const [S, W, N, E] = process.argv.slice(2, 6).map(Number), out = process.argv[6];
const els = loadOverpass('data/raw/baixa-alfama.osm.json.gz');
const proj = makeProjection(38.71275, -9.136);
const polys = extractPolygons(els, proj, (t) => t.building || t['building:part']);
const [x0, y0] = proj.fwd(S, W), [x1, y1] = proj.fwd(N, E);
const sc = 1400 / (x1 - x0), H = (y1 - y0) * sc;
const X = (x) => ((x - x0) * sc).toFixed(1), Y = (y) => ((y1 - y) * sc).toFixed(1);
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="${H | 0}" style="background:#fff;font:9px sans-serif">`;
const roads = extractLines(els, proj, (t) => t.highway);
for (const r of roads) svg += `<polyline points="${r.pts.map(([x, y]) => X(x) + ',' + Y(y)).join(' ')}" fill="none" stroke="#ccc" stroke-width="3"/>`;
const list = [];
for (const p of polys) {
  if (p.c[0] < x0 || p.c[0] > x1 || p.c[1] < y0 || p.c[1] > y1) continue;
  const d = [p.outer, ...p.holes].map((r) => 'M' + r.map(([x, y]) => X(x) + ',' + Y(y)).join('L') + 'Z').join('');
  svg += `<path d="${d}" fill="${p.tags['building:part'] ? '#cde' : '#f4e6d0'}" fill-opacity=".8" fill-rule="evenodd" stroke="#844" stroke-width=".7"/>`;
  svg += `<text x="${X(p.c[0])}" y="${Y(p.c[1])}" text-anchor="middle">${p.id}</text>`;
  const t = p.tags; list.push({ id: p.id, area: Math.round(Math.abs(p.area)), c: proj.inv ? proj.inv(...p.c) : p.c, levels: t['building:levels'], h: t.height, name: t.name, b: t.building || 'part:' + t['building:part'], roof: t['roof:shape'] });
}
fs.writeFileSync(out + '.svg', svg + '</svg>');
fs.writeFileSync(out + '.json', JSON.stringify(list, null, 1));
console.log(list.length, 'polys');
