// Rain radar over Lisbon from RainViewer (free, keyless; composite of national radars incl. IPMA's).
//   /api/radar          → { frames: [{ t, p }], tile: { z, x, y, size } }   the last ~2 h, 10-minute frames
//   /api/radar?p=<path> → that frame's PNG for the one z7 tile that holds the whole diorama (free tier stops at z7)
// Colour scheme 2 (Universal Blue, the only one left on the free tier): the viewer maps colours back to dBZ with its table.
const Z = 7, X = 60, Y = 49, SIZE = 512;
const opt = { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'iLisboa diorama (rain layer)' } };

export default async function handler(req, res) {
  const p = new URL(req.url, 'http://x').searchParams.get('p');
  try {
    if (p) {
      if (!/^\/v2\/radar\/[0-9a-f]+$/.test(p)) return res.status(400).send('bad path');
      const r = await fetch(`https://tilecache.rainviewer.com${p}/${SIZE}/${Z}/${X}/${Y}/2/0_0.png`, opt);
      if (!r.ok) throw new Error(`rainviewer ${r.status}`);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, s-maxage=86400, immutable');   // a frame never changes
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    }
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', opt);
    if (!r.ok) throw new Error(`rainviewer ${r.status}`);
    const m = await r.json();
    const frames = [...(m.radar?.past || []), ...(m.radar?.nowcast || [])].map((f) => ({ t: f.time, p: f.path }));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(JSON.stringify({ frames, tile: { z: Z, x: X, y: Y, size: SIZE } }));
  } catch (e) {
    res.setHeader('Cache-Control', 'public, s-maxage=30');
    return res.status(502).json({ error: String(e.message || e) });
  }
}
