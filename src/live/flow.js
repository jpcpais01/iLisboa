// One shared copy of the city's live road flow (/api/traffic: TomTom speeds vs free flow, CDN-cached for 5 min).
// The Trânsito map layer and the ambient cars both read it, so the city is downloaded once per refresh.
const MAX_AGE = 290000;
let data = null, at = 0, inflight = null;

// latest flow ({ source: 'tomtom', t, segs } or { source: 'none' }); refetched when older than ~5 min
export function getFlow() {
  if (data && Date.now() - at < MAX_AGE) return Promise.resolve(data);
  if (!inflight) {
    inflight = fetch('/api/traffic')
      .then((r) => (r.ok ? r.json() : { source: 'none', error: `${r.status}` }))
      .catch((e) => ({ source: 'none', error: String(e.message || e) }))
      .then((d) => {
        // a failed refresh keeps the last good city (stale by minutes beats no data)
        if (d.source === 'tomtom' && d.segs?.length) { data = d; at = Date.now(); }
        else if (!data || data.source !== 'tomtom') { data = d; at = Date.now() - MAX_AGE + 60000; }
        inflight = null;
        return data;
      });
  }
  return inflight;
}
