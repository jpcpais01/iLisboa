// Video test runner (GitHub Action): fal.ai jobs from a JSON list. "@file" strings → uploaded to fal storage (data URI fallback).
// JOBS=jobs1.json → out/<name>.<ext>, out/<jobs>.result.json (latency, request ids, errors)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
const D = new URL('.', import.meta.url).pathname;
const KEY = process.env.FAL_KEY; const H = { Authorization: `Key ${KEY}` };
mkdirSync(D + 'out', { recursive: true });
const MIME = { mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', zip: 'application/zip' };
const cache = {};
async function upload(f) {
  if (cache[f]) return cache[f];
  const buf = readFileSync(D + 'in/' + f), ct = MIME[f.split('.').pop()] || 'application/octet-stream';
  try {
    const r = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ content_type: ct, file_name: f.replace(/\//g, '_') }) });
    const j = await r.json(); if (!r.ok || !j.upload_url) throw new Error('initiate ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
    const p = await fetch(j.upload_url, { method: 'PUT', headers: { 'Content-Type': ct }, body: buf }); if (!p.ok) throw new Error('put ' + p.status);
    console.log('uploaded', f, buf.length, j.file_url); return (cache[f] = j.file_url);
  } catch (e) { console.log('upload fallback data URI', f, e.message); return (cache[f] = `data:${ct};base64,${buf.toString('base64')}`); }
}
async function fill(x) {
  if (typeof x === 'string' && x.startsWith('@')) return upload(x.slice(1));
  if (Array.isArray(x)) return Promise.all(x.map(fill));
  if (x && typeof x === 'object') return Object.fromEntries(await Promise.all(Object.entries(x).map(async ([k, v]) => [k, await fill(v)])));
  return x;
}
async function fal(id, body, maxMs) {
  const h = { ...H, 'Content-Type': 'application/json' }, t0 = Date.now();
  const r = await fetch(`https://queue.fal.run/${id}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const s = await r.json(); if (!r.ok) throw new Error(`submit ${r.status}: ${JSON.stringify(s).slice(0, 1500)}`);
  let st;
  for (;;) {
    await new Promise((res) => setTimeout(res, 3000));
    st = await (await fetch(s.status_url + '?logs=1', { headers: h })).json();
    if (st.status === 'COMPLETED') break;
    if (st.status !== 'IN_QUEUE' && st.status !== 'IN_PROGRESS') throw new Error('status ' + JSON.stringify(st).slice(0, 1500));
    if (Date.now() - t0 > maxMs) throw new Error('timeout ' + s.request_id);
  }
  const resp = await fetch(s.response_url, { headers: h }); const out = await resp.json();
  if (!resp.ok || out.detail) throw new Error('result ' + JSON.stringify(out).slice(0, 1500));
  return { out, ms: Date.now() - t0, id: s.request_id, inference_s: st.metrics?.inference_time };
}
const name = process.env.JOBS; const J = JSON.parse(readFileSync(D + name));
const res = [];
await Promise.all(J.map(async (j) => {
  try {
    const body = await fill(j.body);
    const r = await fal(j.endpoint, body, (j.max_min || 25) * 60000);
    const f = r.out.video || r.out.images?.[0] || r.out.image; if (!f?.url) throw new Error('no file: ' + JSON.stringify(r.out).slice(0, 800));
    const ext = (f.content_type || '').includes('png') ? 'png' : (f.content_type || '').includes('image') ? 'jpg' : 'mp4';
    writeFileSync(D + `out/${j.name}.${ext}`, Buffer.from(await (await fetch(f.url)).arrayBuffer()));
    res.push({ name: j.name, endpoint: j.endpoint, ok: true, ms: r.ms, inference_s: r.inference_s, request: r.id, seed: r.out.seed, file: `${j.name}.${ext}` });
    console.log('ok', j.name, r.ms);
  } catch (e) { res.push({ name: j.name, endpoint: j.endpoint, ok: false, error: String(e.message).slice(0, 2000) }); console.log('FAIL', j.name, e.message); }
}));
writeFileSync(D + `out/${name.replace(/\W/g, '_')}.result.json`, JSON.stringify(res, null, 1));
try { const b = await fetch('https://rest.alpha.fal.ai/billing/user_balance', { headers: H }); console.log('balance', b.status, (await b.text()).slice(0, 200)); } catch (e) { console.log('balance n/a', e.message); }
