// Live ships on the Tagus from AIS, via aisstream.io (free key, websocket only, no browser connections).
// Each call listens to the Lisbon box for a few seconds and answers with everything this instance has heard in the last
// 20 minutes: moving ships report every 2–10 s, so a few seconds catches all of them, while ships at anchor or alongside
// report every 3–6 min and names/types/destinations every 6 min, so a warm instance keeps what it heard before
// (in memory) and the client keeps merging too. CDN-cached for 25 s, so many viewers share one websocket.
// Needs AISSTREAM_KEY in the Vercel environment; without it answers { error: 'nokey' } (the boats layer then shows the
// timetable ferries and illustrative traffic).
import { fwd, r1 } from './_lib/geo.js';

const BOX = [[38.55, -9.55], [38.90, -8.85]];   // the bar to Alcochete, Cascais to Seixal
const LISTEN = 6500, KEEP = 20 * 60 * 1000;
const mem = (globalThis.__ais ??= { pos: new Map(), stat: new Map(), t: 0, err: '', diag: {} });

function listen(key) {
  return new Promise((resolve) => {
    let ws, done = false;
    const t0 = Date.now(), dg = (mem.diag = { opened: false, msgs: 0, types: {}, close: null, ms: 0 });
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); dg.ms = Date.now() - t0; try { ws?.close(); } catch { /* closed */ } if (err) mem.err = err; resolve(); };
    const timer = setTimeout(() => finish(), LISTEN);
    try { ws = new WebSocket('wss://stream.aisstream.io/v0/stream'); } catch (e) { return finish(`websocket: ${e.message}`); }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => (dg.opened = true) && ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [BOX],
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'] }));
    ws.onerror = (e) => finish(`websocket error ${e?.message || ''}`);
    ws.onclose = (e) => { dg.close = [e?.code, e?.reason]; finish(); };
    const dec = new TextDecoder();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : dec.decode(ev.data)); } catch { return; }
      if (m.error) return finish(`aisstream: ${m.error}`);
      dg.msgs++; dg.types[m.MessageType] = (dg.types[m.MessageType] || 0) + 1;
      take(m);
    };
  });
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function take(m) {
  const md = m.MetaData || {}, mmsi = md.MMSI ?? md.mmsi, t = m.MessageType, b = m.Message?.[t];
  if (!mmsi || !b) return;
  const now = Date.now(), st = mem.stat.get(mmsi) || {};
  const name = (md.ShipName || '').trim();
  if (name) st.name = name;
  if (t === 'PositionReport' || t === 'StandardClassBPositionReport' || t === 'ExtendedClassBPositionReport') {
    const lat = num(b.Latitude) ?? num(md.latitude) ?? num(md.Latitude), lon = num(b.Longitude) ?? num(md.longitude) ?? num(md.Longitude);
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    mem.pos.set(mmsi, { lat, lon, sog: num(b.Sog) ?? 0, cog: num(b.Cog), hdg: num(b.TrueHeading), nav: num(b.NavigationalStatus) ?? 15, t: now });
    if (t === 'ExtendedClassBPositionReport') { if (b.Name) st.name = b.Name.trim(); if (b.Type) st.type = b.Type; if (b.Dimension) st.dim = b.Dimension; }
  } else if (t === 'ShipStaticData') {
    if (b.Name) st.name = b.Name.trim(); if (b.Type) st.type = b.Type; if (b.Dimension) st.dim = b.Dimension;
    if (b.Destination) st.dest = b.Destination.trim(); if (b.CallSign) st.call = b.CallSign.trim();
  } else if (t === 'StaticDataReport') {
    if (b.ReportA?.Valid && b.ReportA.Name) st.name = b.ReportA.Name.trim();
    if (b.ReportB?.Valid) { if (b.ReportB.ShipType) st.type = b.ReportB.ShipType; if (b.ReportB.Dimension) st.dim = b.ReportB.Dimension; if (b.ReportB.CallSign) st.call = b.ReportB.CallSign.trim(); }
  }
  st.t = now; mem.stat.set(mmsi, st);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.AISSTREAM_KEY;
  if (!key) { res.setHeader('Cache-Control', 'public, s-maxage=300'); return res.status(200).send(JSON.stringify({ error: 'nokey' })); }
  if (typeof WebSocket === 'undefined') { res.setHeader('Cache-Control', 'public, s-maxage=60'); return res.status(500).send(JSON.stringify({ error: 'no WebSocket in this Node runtime (needs Node 22+)' })); }
  mem.err = '';
  if (Date.now() - mem.t > 15000) { await listen(key); mem.t = Date.now(); }
  const now = Date.now(), out = [];
  for (const [mmsi, p] of mem.pos) {
    if (now - p.t > KEEP) { mem.pos.delete(mmsi); continue; }
    const s = mem.stat.get(mmsi) || {}, d = s.dim || {};
    const L = (d.A || 0) + (d.B || 0), B = (d.C || 0) + (d.D || 0);
    const [x, y] = fwd(p.lat, p.lon);
    // [mmsi, name, AIS type, x, y, speed m/s, course °, heading ° (null if unknown), nav status, length m, beam m, destination, age s, call sign]
    out.push([mmsi, s.name || '', s.type || 0, r1(x), r1(y), r1(p.sog * 0.5144), p.cog != null && p.cog < 360 ? r1(p.cog) : null,
      p.hdg != null && p.hdg < 360 ? p.hdg : null, p.nav, L > 0 && L < 500 ? L : 0, B > 0 && B < 80 ? B : 0, s.dest || '', Math.round((now - p.t) / 1000), s.call || '']);
  }
  for (const [mmsi, s] of mem.stat) if (now - s.t > 6 * KEEP) mem.stat.delete(mmsi);
  if (!out.length && mem.err) { res.setHeader('Cache-Control', 'public, s-maxage=20'); return res.status(502).send(JSON.stringify({ error: mem.err })); }
  res.setHeader('Cache-Control', 'public, s-maxage=25, stale-while-revalidate=60');
  res.status(200).send(JSON.stringify({ t: Math.round(now / 1000), s: out, err: mem.err || undefined, diag: req.query?.diag ? mem.diag : undefined }));
}
