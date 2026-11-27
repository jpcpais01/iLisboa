// POST /api/aiphoto — turns a photo-mode render into a real-looking photograph (fal.ai, Nano Banana 2 edit).
// Body: { image: data:image/jpeg (long side ≤ 2048), depth: data:image/png (exact depth from the renderer), aspect: w/h }
// Returns image/jpeg. Needs FAL_KEY in the Vercel environment (never sent to the browser).
// Chosen in the Nov 2026 test (project files ai-photo/REPORT.md): it keeps the framing and the city's layout; Nano Banana Pro
// reframed, Seedream invented new compositions. The client scores the result against our depth; nothing is retried here.
const MODEL = 'fal-ai/nano-banana-2/edit';
const PROMPT = 'Turn this 3D render of Lisbon, Portugal into a real photograph. ' +
  'It is a pixel-aligned retouch, not a new photo: same camera, same framing, same field of view and same horizon line. Do not zoom, crop, rotate or extend the view. ' +
  'Every building, roof, street, square, quay, bridge and the shoreline stay exactly where they are, with the same shapes and sizes. Do not add, remove, move or resize any building or landmark. ' +
  'Keep the same time of day, sun direction, light, weather and season as the render. ' +
  'Replace the flat 3D-render look with real-world materials: weathered terracotta roof tiles, limestone and painted plaster façades with real windows and shutters, Portuguese calçada pavement, real trees, real cars, natural water with reflections, light atmospheric haze. Photorealistic, sharp. ' +
  'The second image is the exact depth map of the first: the geometry must match it.';
const EDGES = ' The third image shows the exact outlines of every building, roof and street of the first: every edge must stay exactly where it is.';
const RATIOS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];

// ─── abuse and cost limits (per warm instance) ───
const PER_MIN = 3, PER_DAY = 20, GLOBAL_PER_DAY = 200;   // ≈ $0.12 each
const hits = new Map();
let global = [];
function limited(ip) {
  const now = Date.now();
  global = global.filter((t) => now - t < 86400e3);
  if (global.length >= GLOBAL_PER_DAY) return 'busy';
  const a = (hits.get(ip) || []).filter((t) => now - t < 86400e3);
  if (a.filter((t) => now - t < 60e3).length >= PER_MIN) return 'minute';
  if (a.length >= PER_DAY) return 'day';
  a.push(now); hits.set(ip, a); global.push(now);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 86400e3) hits.delete(k);
  return null;
}
const ALLOWED = /^(https?:\/\/)?(localhost(:\d+)?|127\.0\.0\.1(:\d+)?|i-lisboa\.vercel\.app|[\w-]+-jpcpais01s-projects\.vercel\.app|ilisboa[\w-]*\.vercel\.app)$/i;
const okData = (s, type, max) => typeof s === 'string' && s.startsWith(`data:${type};base64,`) && s.length < max;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const from = (req.headers.origin || req.headers.referer || '').replace(/^https?:\/\//, '').split('/')[0];
  if (from && !ALLOWED.test(from) && from !== host) return res.status(403).json({ error: 'origin not allowed' });
  const key = process.env.FAL_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });
  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch { body = null; }
  if (!body || !okData(body.image, 'image/jpeg', 3.0e6) || !okData(body.depth, 'image/png', 1.0e6) || (body.edges != null && !okData(body.edges, 'image/png', 0.6e6))) return res.status(400).json({ error: 'bad_input' });
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
  const lim = limited(ip);
  if (lim) { res.setHeader('Retry-After', lim === 'minute' ? '60' : '3600'); return res.status(429).json({ error: 'rate_limited', scope: lim }); }

  const a = Math.min(3, Math.max(0.3, +body.aspect || 16 / 9));
  const ratio = RATIOS.includes(body.ratio) ? body.ratio : RATIOS.reduce((b, r) => { const [x, y] = r.split(':').map(Number); return Math.abs(Math.log(x / y / a)) < Math.abs(Math.log(b.v / a)) ? { r, v: x / y } : b; }, { r: '16:9', v: 16 / 9 }).r;
  const t0 = Date.now();
  try {
    const r = await fetch(`https://fal.run/${MODEL}`, {
      method: 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: PROMPT + (body.edges ? EDGES : ''), image_urls: body.edges ? [body.image, body.depth, body.edges] : [body.image, body.depth], aspect_ratio: ratio, resolution: '2K', output_format: 'jpeg', num_images: 1 }),
      signal: AbortSignal.timeout(85000),
    });
    const j = await r.json().catch(() => ({}));
    const url = j.images?.[0]?.url;
    if (!r.ok || !url) { console.error('aiphoto', r.status, JSON.stringify(j).slice(0, 300)); return res.status(502).json({ error: r.status === 422 ? 'refused' : 'failed' }); }
    const img = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(20000) })).arrayBuffer());
    console.log(JSON.stringify({ aiphoto: 1, ip: ip.replace(/\.\d+$/, '.x'), ms: Date.now() - t0, ratio, bytes: img.length }));
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Model', MODEL);
    return res.status(200).send(img);
  } catch (e) {
    console.error('aiphoto', e?.name, e?.message);
    return res.status(e?.name === 'TimeoutError' ? 504 : 502).json({ error: e?.name === 'TimeoutError' ? 'timeout' : 'failed' });
  }
}
