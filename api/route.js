// Where is it going? Looked up once when someone follows a vehicle, cached at the CDN for an hour.
//   ?call=TAP1234&lat=38.7&lon=-9.1   flight route from adsb.lol's open route database (origin → destination airports)
//   ?pattern=1234_0_1                 Carris Metropolitana pattern → headsign
const UA = { 'user-agent': 'iLisboa diorama (live layer)' };
async function get(url, init) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
  try { const r = await fetch(url, { ...init, signal: ctl.signal }); if (!r.ok) throw new Error(`${r.status}`); return await r.json(); }
  finally { clearTimeout(t); }
}
const place = (a) => a && { iata: a.iata || a.icao || '', name: a.location || a.name || '', airport: a.name || '' };

export default async function handler(req, res) {
  const q = req.query || {};
  try {
    let out = null;
    if (q.call) {
      const call = String(q.call).trim().toUpperCase().slice(0, 10);
      const body = { planes: [{ callsign: call, lat: +q.lat || 38.77, lng: +q.lon || -9.13 }] };
      const r = await get('https://api.adsb.lol/api/0/routeset', { method: 'POST', headers: { ...UA, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const x = Array.isArray(r) ? r.find((e) => (e.callsign || '').toUpperCase() === call) || r[0] : null;
      const ap = x && Array.isArray(x._airports) ? x._airports : [];
      if (ap.length >= 2) out = { from: place(ap[0]), to: place(ap[ap.length - 1]), plausible: x.plausible !== false && x.plausible !== 0, codes: x._airport_codes_iata || '' };
    } else if (q.pattern) {
      const id = String(q.pattern).replace(/[^\w-]/g, '').slice(0, 40);
      const r = await get(`https://api.carrismetropolitana.pt/v2/patterns/${id}`, { headers: UA });
      const p = Array.isArray(r) ? r[0] : r;
      if (p && p.headsign) out = { headsign: p.headsign };
    }
    res.setHeader('Cache-Control', out ? 'public, s-maxage=3600, stale-while-revalidate=86400' : 'public, s-maxage=300');
    res.status(200).json(out || {});
  } catch (e) {
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    res.status(502).json({ error: String(e.message || e) });
  }
}
