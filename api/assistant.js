// POST /api/assistant — Alfacinha, the Lisbon guide in the corner. Streams Server-Sent Events:
//   data: {"t":"text","d":"…"} | {"t":"tool","name","label"} | {"t":"action",…} | {"t":"sources","list"} | {"t":"done","usage"} | {"t":"error","msg"}
// Body: { messages: [{role, content}], state: { view, hour, live, selected, following, layers, lang } }
// Needs ANTHROPIC_API_KEY in the Vercel environment (never sent to the browser). ASSISTANT_MODEL overrides the model.
import { runAssistant, DEFAULT_MODEL } from './_lib/assistant/agent.js';
import { makeGetter } from './_lib/assistant/data.js';

// ─── abuse limits (per warm instance; Vercel reuses instances, so this holds well for a single site) ───
const PER_MIN = 8, PER_DAY = 60, GLOBAL_PER_HOUR = 600;
const hits = new Map();   // ip → [timestamps]
let global = [];
function limited(ip) {
  const now = Date.now();
  global = global.filter((t) => now - t < 3600e3);
  if (global.length >= GLOBAL_PER_HOUR) return 'busy';
  const a = (hits.get(ip) || []).filter((t) => now - t < 86400e3);
  if (a.filter((t) => now - t < 60e3).length >= PER_MIN) return 'minute';
  if (a.length >= PER_DAY) return 'day';
  a.push(now); hits.set(ip, a); global.push(now);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 86400e3) hits.delete(k);
  return null;
}
const ALLOWED = /^(https?:\/\/)?(localhost(:\d+)?|127\.0\.0\.1(:\d+)?|i-lisboa\.vercel\.app|[\w-]+-jpcpais01s-projects\.vercel\.app|ilisboa[\w-]*\.vercel\.app)$/i;

const get = makeGetter();

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const from = (req.headers.origin || req.headers.referer || '').replace(/^https?:\/\//, '').split('/')[0];
  if (from && !ALLOWED.test(from) && from !== host) return res.status(403).json({ error: 'origin not allowed' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured', msg: 'ANTHROPIC_API_KEY is not set in the Vercel environment.' });
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
  const lim = limited(ip);
  if (lim) {
    res.setHeader('Retry-After', lim === 'minute' ? '60' : '3600');
    return res.status(429).json({ error: 'rate_limited', scope: lim });
  }

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch { body = null; }
  const raw = Array.isArray(body?.messages) ? body.messages : [];
  // plain-text history, alternating, ending on the user; trimmed to the last turns and a size budget
  let msgs = raw.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, m.role === 'user' ? 1200 : 2400) })).slice(-14);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  msgs = msgs.filter((m, i) => i === 0 || m.role !== msgs[i - 1].role);
  let total = 0; for (let i = msgs.length - 1; i >= 0; i--) { total += msgs[i].content.length; if (total > 14000) { msgs = msgs.slice(i + 1); break; } }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'last message must be from the user' });
  const s = body.state && typeof body.state === 'object' ? body.state : {};
  const state = {
    view: s.view && isFinite(+s.view.lat) ? { lat: +s.view.lat, lon: +s.view.lon, range: +s.view.range || 0 } : null,
    hour: typeof s.hour === 'string' ? s.hour.slice(0, 5) : null, live: s.live !== false,
    selected: typeof s.selected === 'string' ? s.selected.slice(0, 120) : null,
    following: typeof s.following === 'string' ? s.following.slice(0, 120) : null,
    layers: Array.isArray(s.layers) ? s.layers.filter((x) => typeof x === 'string').slice(0, 12).map((x) => x.slice(0, 20)) : [],
    lang: typeof s.lang === 'string' ? s.lang.slice(0, 12) : 'pt-PT',
  };

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ } };
  const ac = new AbortController();
  req.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
  const origin = process.env.ASSISTANT_DATA_ORIGIN || `${proto}://${host}`;
  try {
    // live state of the parish under the camera is cheap to add here, so the model doesn't need a tool for "aqui"
    const r = await runAssistant({ apiKey: key, model: process.env.ASSISTANT_MODEL || DEFAULT_MODEL, effort: process.env.ASSISTANT_EFFORT || 'low', messages: msgs, state, signal: ac.signal, emit: send, ctx: { origin, get, now: () => new Date() } });
    console.log(JSON.stringify({ assistant: 1, ip: ip.replace(/\.\d+$/, '.x'), steps: r.usage.steps, tools: r.usage.tools.map((t) => t.name), in: r.usage.input, out: r.usage.output, ws: r.usage.web_searches }));
  } catch (e) {
    if (!ac.signal.aborted) { console.error('assistant', e?.status || '', e?.message || e); send({ t: 'error', msg: e?.status === 429 || e?.status === 529 ? 'busy' : 'failed' }); }
  }
  res.end();
}
