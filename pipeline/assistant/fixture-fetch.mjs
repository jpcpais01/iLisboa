// A fetch() for the eval: static app files come from public/, live feeds and web APIs from a recorded snapshot
// (fixtures.json: { at: unix s, urls: { url: json } }). Open-Meteo points match the nearest recorded point; anything
// missing is logged so it can be captured next time.
import { readFileSync, existsSync } from 'node:fs';
export const missing = new Set();
export function fixtureFetch(fx, root = 'public') {
  const urls = fx.urls || {};
  const om = Object.keys(urls).filter((u) => u.includes('api.open-meteo.com/v1/forecast'));
  const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (url) => {
    const u = new URL(url);
    if (u.host === 'app.local') {
      if (u.pathname.startsWith('/api/')) {
        const k = u.pathname + u.search, hit = urls[k] ?? urls[u.pathname];
        if (hit != null) return ok(hit);
        missing.add(k); return new Response('{}', { status: 404 });
      }
      const f = `${root}${decodeURIComponent(u.pathname)}`;
      if (existsSync(f)) return new Response(readFileSync(f), { status: 200 });
      missing.add(url); return new Response('nf', { status: 404 });
    }
    if (urls[url] != null) return ok(urls[url]);
    if (url.includes('api.open-meteo.com/v1/forecast') && om.length) {
      const la = +u.searchParams.get('latitude'), lo = +u.searchParams.get('longitude');
      const best = om.map((k) => { const q = new URL(k).searchParams; return [Math.hypot(+q.get('latitude') - la, +q.get('longitude') - lo), k]; }).sort((a, b) => a[0] - b[0])[0];
      if (best[0] < 0.03) return ok(urls[best[1]]);
    }
    missing.add(url); return new Response('{"error":"not recorded"}', { status: 503 });
  };
}
