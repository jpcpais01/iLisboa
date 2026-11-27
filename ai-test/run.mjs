// AI photo test runner (GitHub Action): structure-locked photoreal passes on fal.ai + Wikimedia reference photos.
// in/<view>_render.jpg, in/<view>_depth.png → out/<view>_<approach>.jpg, out/runs.json (latency, cost, errors)
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
const D = new URL('.', import.meta.url).pathname;
const views = JSON.parse(readFileSync(D + 'views.json'));
const only = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (process.env.APPROACHES || '').split(',').filter(Boolean);
mkdirSync(D + 'out', { recursive: true }); mkdirSync(D + 'ref', { recursive: true });
const KEY = process.env.FAL_KEY;
const uri = (f) => `data:${f.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${readFileSync(D + 'in/' + f).toString('base64')}`;

const PROMPT = (v) => `A real aerial photograph of ${v.place}, Lisbon, Portugal, taken from a helicopter on a clear autumn afternoon. ` +
  `Keep the exact composition: every building, roof, street, square, quay, the Tagus shoreline${v.id === 'ponte' ? ' and the suspension bridge' : ''} stay exactly where they are with the same shapes and sizes. Do not add, remove, move or resize any building. ` +
  `Replace the flat 3D-render look with real-world materials: weathered terracotta roof tiles, limestone and painted plaster façades with real windows and shutters, Portuguese calçada pavement, real trees, real cars, the river with natural reflections, natural sunlight and soft shadows, light atmospheric haze. Photorealistic, sharp, DSLR photo.`;

const A = {
  // FLUX dev + Control-LoRA depth, img2img from our render: geometry pinned twice (init image + exact depth)
  flux_depth_045: (v) => ['fal-ai/flux-control-lora-depth/image-to-image', { prompt: PROMPT(v), image_url: uri(`${v.id}_render.jpg`), control_lora_image_url: uri(`${v.id}_depth.png`), control_lora_strength: 1, strength: 0.45, image_size: { width: 1920, height: 1088 }, num_inference_steps: 30, guidance_scale: 3.5, output_format: 'jpeg', seed: 7 }, 0.08],
  flux_depth_065: (v) => ['fal-ai/flux-control-lora-depth/image-to-image', { prompt: PROMPT(v), image_url: uri(`${v.id}_render.jpg`), control_lora_image_url: uri(`${v.id}_depth.png`), control_lora_strength: 1, strength: 0.65, image_size: { width: 1920, height: 1088 }, num_inference_steps: 30, guidance_scale: 3.5, output_format: 'jpeg', seed: 7 }, 0.08],
  // instruction editors: render + exact depth map as a second reference
  nano2: (v) => ['fal-ai/nano-banana-2/edit', { prompt: PROMPT(v) + ' The second image is the exact depth map of the first: the geometry must match it.', image_urls: [uri(`${v.id}_render.jpg`), uri(`${v.id}_depth.png`)], aspect_ratio: '16:9', resolution: '2K', output_format: 'jpeg', num_images: 1 }, 0.12],
  nanopro: (v) => ['fal-ai/nano-banana-pro/edit', { prompt: PROMPT(v) + ' The second image is the exact depth map of the first: the geometry must match it.', image_urls: [uri(`${v.id}_render.jpg`), uri(`${v.id}_depth.png`)], aspect_ratio: '16:9', resolution: '2K', output_format: 'jpeg', num_images: 1 }, 0.15],
  seedream: (v) => ['bytedance/seedream/v5/pro/edit', { prompt: PROMPT(v), image_urls: [uri(`${v.id}_render.jpg`)], image_size: { width: 1920, height: 1080 }, output_format: 'jpeg', num_images: 1 }, 0.135],
};

async function fal(id, body) {
  const h = { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' };
  const t0 = Date.now();
  const r = await fetch(`https://queue.fal.run/${id}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const s = await r.json(); if (!r.ok) throw new Error(`submit ${r.status}: ${JSON.stringify(s).slice(0, 400)}`);
  let st;
  for (;;) {
    await new Promise((res) => setTimeout(res, 1500));
    st = await (await fetch(s.status_url, { headers: h })).json();
    if (st.status === 'COMPLETED') break;
    if (st.status !== 'IN_QUEUE' && st.status !== 'IN_PROGRESS') throw new Error('status ' + JSON.stringify(st).slice(0, 400));
    if (Date.now() - t0 > 300000) throw new Error('timeout');
  }
  const out = await (await fetch(s.response_url, { headers: h })).json();
  const url = out.images?.[0]?.url; if (!url) throw new Error('no image: ' + JSON.stringify(out).slice(0, 400));
  const img = Buffer.from(await (await fetch(url)).arrayBuffer());
  return { img, ms: Date.now() - t0, queue_ms: st.metrics?.inference_time ? undefined : undefined, inference_s: st.metrics?.inference_time, out };
}

const runs = existsSync(D + 'out/runs.json') ? JSON.parse(readFileSync(D + 'out/runs.json')) : [];
if (KEY) {
  const jobs = [];
  for (const v of views) for (const [k, f] of Object.entries(A)) {
    if (only.length && !only.includes(v.id)) continue; if (want.length && !want.includes(k)) continue;
    if (!existsSync(D + `in/${v.id}_render.jpg`)) continue;
    jobs.push((async () => {
      const [id, body, usd] = f(v);
      try { const r = await fal(id, body); writeFileSync(D + `out/${v.id}_${k}.jpg`, r.img); runs.push({ view: v.id, approach: k, endpoint: id, ms: r.ms, inference_s: r.inference_s, usd_est: usd, ok: true }); console.log('ok', v.id, k, r.ms + 'ms'); }
      catch (e) { runs.push({ view: v.id, approach: k, endpoint: id, ok: false, error: String(e.message).slice(0, 500) }); console.log('FAIL', v.id, k, e.message); }
    })());
  }
  await Promise.all(jobs);
  writeFileSync(D + 'out/runs.json', JSON.stringify(runs, null, 1));
} else console.log('no FAL_KEY: skipping AI passes');

// Wikimedia Commons reference photos: top candidates per view
if (process.env.REFS !== '0') {
  const UA = { 'User-Agent': 'ilisboa-test/0.1 (research script)' };
  const cands = {};
  for (const v of views) for (const q of v.refq || []) {
    const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap')}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600`;
    try {
      const j = await (await fetch(u, { headers: UA })).json();
      const pages = Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index);
      for (const p of pages) {
        const ii = p.imageinfo?.[0]; if (!ii || ii.width < ii.height || ii.width < 1200) continue;
        (cands[v.id] ||= []).push({ q, title: p.title, thumb: ii.thumburl, page: ii.descriptionurl, w: ii.width, h: ii.height, artist: (ii.extmetadata?.Artist?.value || '').replace(/<[^>]+>/g, '').trim(), license: ii.extmetadata?.LicenseShortName?.value });
      }
    } catch (e) { console.log('wm fail', q, e.message); }
  }
  for (const [id, list] of Object.entries(cands)) {
    const seen = new Set(); let n = 0;
    for (const c of list) {
      if (seen.has(c.title) || n >= 8) continue; seen.add(c.title);
      try { const b = Buffer.from(await (await fetch(c.thumb, { headers: UA })).arrayBuffer()); c.file = `${id}_ref${n}.jpg`; writeFileSync(D + 'ref/' + c.file, b); n++; } catch {}
    }
    cands[id] = list.filter((c) => c.file);
  }
  writeFileSync(D + 'ref/refs.json', JSON.stringify(cands, null, 1));
}
