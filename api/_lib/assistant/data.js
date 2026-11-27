// What the assistant knows about the city: the same files and live feeds the viewer uses, loaded once per warm
// function instance and kept for a TTL. Every fetch goes through ctx.get(url, ttl), so the eval can swap the
// network for recorded fixtures (pipeline/assistant/eval.mjs) and production shares the CDN cache with the viewer.
import { fwd, inv } from '../geo.js';

const mem = new Map();   // url → { at, p }
export function makeGetter(fetchImpl = fetch) {
  return async function get(url, ttl = 60, init) {
    const k = init ? null : url, hit = k && mem.get(k);
    if (hit && Date.now() - hit.at < ttl * 1000) return hit.p;
    const p = (async () => {
      const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(9000), headers: { 'user-agent': 'iLisboa assistant (https://i-lisboa.vercel.app)', ...(init?.headers || {}) } });
      if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
      return r.json();
    })();
    if (k) { mem.set(k, { at: Date.now(), p }); p.catch(() => mem.delete(k)); }
    return p;
  };
}

// ─── text matching: accents, case, Carris abbreviations ───
const ABBR = { pc: 'praca', 'pç': 'praca', av: 'avenida', r: 'rua', lg: 'largo', est: 'estacao', 'cç': 'calcada', cc: 'calcada', tv: 'travessa', estr: 'estrada', qta: 'quinta', urb: 'urbanizacao', b: 'bairro', bo: 'bairro', s: 'sao', sta: 'santa', sto: 'santo', dr: 'doutor', eng: 'engenheiro', gen: 'general', pq: 'parque', jd: 'jardim', esc: 'escola', hosp: 'hospital', mte: 'monte', alm: 'almirante', cap: 'capitao', cel: 'coronel', prof: 'professor' };
export const norm = (s) => String(s || '').toLowerCase().replace(/ç/g, 'c').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').map((w) => ABBR[w] || w).join(' ');
const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'the', 'of']);
// 0..1: how well `name` answers `q`
const strip = (s) => s.split(' ').filter((w) => !STOP.has(w)).join(' ');
export function score(q, name) {
  const a = strip(norm(q)), b = strip(norm(name));
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a + ' ') || b.endsWith(' ' + a)) return 0.92;
  if (b.includes(a)) return 0.85;
  const qa = a.split(' ').filter((w) => !STOP.has(w)), bb = new Set(b.split(' '));
  if (!qa.length) return 0;
  let hit = 0;
  for (const w of qa) if (bb.has(w)) hit++; else if (w.length > 3 && [...bb].some((x) => x.startsWith(w) || (x.length > 3 && w.startsWith(x)))) hit += 0.7;
  return 0.75 * (hit / qa.length) * Math.min(1, (qa.length + 1) / (bb.size + 1) + 0.4);
}

// ─── geometry ───
function inRing(p, x, y) {
  let inside = false;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inRegion = (f, x, y) => { let o = false; for (const r of f.rings) if (inRing(r.p, x, y)) { if (r.hole) return false; o = true; } return o; };
function centroid(f) {
  let best = null, A = 0;
  for (const r of f.rings) if (!r.hole) { const a = Math.abs(area(r.p)); if (a > A) { A = a; best = r.p; } }
  if (!best) return [0, 0];
  let cx = 0, cy = 0, s = 0;
  for (let i = 0, n = best.length, j = n - 2; i < n; j = i, i += 2) { const c = best[j] * best[i + 1] - best[i] * best[j + 1]; s += c; cx += (best[j] + best[i]) * c; cy += (best[j + 1] + best[i + 1]) * c; }
  return s ? [cx / (3 * s), cy / (3 * s)] : [best[0], best[1]];
}
function area(p) { let s = 0; for (let i = 0, n = p.length; i < n; i += 2) { const j = (i + 2) % n; s += p[i] * p[j + 1] - p[j] * p[i + 1]; } return s / 2; }
export const ll = ([lat, lon]) => ({ lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 });

// ─── the static layers, prepared once ───
let cityP = null;
export function city(get, origin) {
  if (cityP) return cityP;
  cityP = (async () => {
    const [fr, lm, metro, stops] = await Promise.all([
      get(`${origin}/layers/freguesias.json`, 86400),
      get(`${origin}/landmarks.json`, 86400),
      get(`${origin}/live/metro.json`, 86400),
      get(`${origin}/transit/stops.json`, 3600).catch(() => null),
    ]);
    // parishes (lvl 8) and the municipalities (lvl 7) they sit in
    const munis = fr.filter((f) => f.lvl === 7), parishes = [];
    for (const f of fr.filter((f) => f.lvl === 8)) {
      const [cx, cy] = centroid(f);
      const m = munis.find((m) => inRegion(m, cx, cy));
      parishes.push({ f, name: f.name, muni: m?.name || '', pop: f.pop || null, popSrc: f.popSrc || '', area: f.area, km2: Math.round(f.area / 1e4) / 100, density: f.pop ? Math.round(f.pop / (f.area / 1e6)) : null, cx, cy, wd: f.wd });
    }
    for (const m of munis) {
      const ps = parishes.filter((p) => p.muni === m.name);
      m.parishes = ps.length; m.popSum = ps.reduce((s, p) => s + (p.pop || 0), 0); m.missing = ps.filter((p) => !p.pop).map((p) => p.name);
    }
    // landmarks grouped by Wikidata id (as the viewer does)
    const marks = new Map();
    for (const it of lm.items) {
      const [id, name, nameEn, wd, wp, kind, cx, cy] = it;
      const key = wd || wp || id;
      const g = marks.get(key);
      if (g) { g.n++; g.x += cx; g.y += cy; if (!g.name && name) g.name = name; continue; }
      marks.set(key, { key, name, nameEn, wd, wp, kind, x: cx, y: cy, n: 1 });
    }
    const landmarks = [...marks.values()].filter((g) => g.name).map((g) => ({ ...g, x: g.x / g.n, y: g.y / g.n }));
    // Metro stations along each line's track
    const stations = new Map();
    for (const l of metro.lines) {
      const cum = [0]; for (let i = 1; i < l.track.length; i++) cum.push(cum[i - 1] + Math.hypot(l.track[i][0] - l.track[i - 1][0], l.track[i][1] - l.track[i - 1][1]));
      const at = (s) => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const f = Math.max(0, Math.min(1, (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1))), A = l.track[i - 1], B = l.track[i]; return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f]; };
      l.L = cum[cum.length - 1];
      for (const s of l.stops) {
        const [x, y] = at(s.s);
        const st = stations.get(s.name) || stations.set(s.name, { name: s.name, x, y, lines: [] }).get(s.name);
        st.lines.push(l.name);
      }
    }
    return { parishes, munis, landmarks, metro: metro.lines, stations: [...stations.values()], stops: stops ? stops.stops : [], routes: stops ? stops.routes : {}, stopsBuilt: stops?.built };
  })();
  cityP.catch(() => { cityP = null; });
  return cityP;
}

// where a point is: parish, municipality
export function whereIs(C, x, y) {
  const p = C.parishes.find((p) => inRegion(p.f, x, y));
  return p ? { parish: p.name, municipality: p.muni } : { parish: null, municipality: null };
}
// a short "near …" for a point: the closest Metro station, landmark or stop within reach
export function nearName(C, x, y, maxD = 450) {
  let best = null, bd = maxD;
  for (const s of C.stations) { const d = Math.hypot(s.x - x, s.y - y) * 0.8; if (d < bd) { bd = d; best = `Metro ${s.name}`; } }
  for (const g of C.landmarks) { const d = Math.hypot(g.x - x, g.y - y); if (d < bd) { bd = d; best = g.name; } }
  for (const s of C.stops) { const d = Math.hypot(s[2] - x, s[3] - y) * 1.15; if (d < bd) { bd = d; best = s[1]; } }
  return best;
}
export { fwd, inv };
