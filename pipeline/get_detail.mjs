// Download an area's per-building detail sources (DGT photos + 50 cm LiDAR, fetched by the fetch-detail-city workflow) from
// the detail-city release into data/detail/city/. Files already there are kept. Usage: node pipeline/get_detail.mjs <area>…
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data/detail/city');
const BASE = 'https://github.com/jpcpais01/iLisboa/releases/download/detail-city/';
fs.mkdirSync(DIR, { recursive: true });
for (const area of process.argv.slice(2)) {
  for (const f of ['ndsm50.tif', 'ortho2025.tif', 'ortho2025.json', 'ortho2018.tif', 'ortho2018.json', 'orthosat2023.tif', 'orthosat2023.json']) {
    const dst = path.join(DIR, `${area}_${f}`);
    if (fs.existsSync(dst)) continue;
    const r = await fetch(BASE + `${area}_${f}`);
    if (!r.ok) { console.log(`${area}_${f}: HTTP ${r.status}`); continue; }
    fs.writeFileSync(dst + '.part', Buffer.from(await r.arrayBuffer())); fs.renameSync(dst + '.part', dst);
    console.log(`${area}_${f}: ${(fs.statSync(dst).size / 1048576).toFixed(1)} MB`);
  }
}
