// Airfields, painted as the DGT 2025 orthophotos show them (Humberto Delgado measured surface by surface; Montijo and Sintra
// read through the military blur). An airport is not one pale fill:
//  · the runway strip (≈75 m either side of every runway and taxiway) is graded and mown: olive to straw grass in long
//    mowing bands that run with the runway, each field a different shade (some islands green, some burnt to straw);
//  · beyond the strip the ground is left rough: dry grass, meadow and dark scrub, bare sandy patches;
//  · aprons are pale concrete slabs (7.5 m bays, dark joints, oil and tyre stains); taxiways are a mid grey with a yellow
//    centre line and light shoulders; runways are dark asphalt with ICAO paint (threshold keys, designators, aiming point,
//    touchdown bars, centre and edge lines) and black rubber smeared over the touchdown zones.
// Mapped paint (aeroway=aerodrome_marking + man_made=paint, e.g. Lisbon's runway keys and numbers) is drawn as mapped, and
// the procedural threshold paint is left off a runway end that has it. Everything here is the pipeline's palette scale
// (photo medians × the same ≈0.8 the rest of the ground palette sits at).
import { pointInRing, parseMeters } from './osm.mjs';
import { Raster } from './raster.mjs';

const srgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const P = {
  mownGreen: srgb('#6b7053'), mownOlive: srgb('#7d795d'), mownStraw: srgb('#988c71'),     // the strip: green, olive, burnt straw
  roughDry: srgb('#857e62'), roughMead: srgb('#727555'), scrub: srgb('#5d6346'), bare: srgb('#9d927b'),
  apron: srgb('#aaa6a0'), apronLane: srgb('#9a9792'), taxiConc: srgb('#a3a09b'), taxiAsph: srgb('#808183'),
  shoulder: srgb('#9c978e'), runway: srgb('#5d6064'), runwayConc: srgb('#9f9b94'),
  white: srgb('#e4e2dc'), yellow: srgb('#c9a54a'),
};
// integer hash and value noise (integer so it holds its precision at city coordinates)
const ih = (a, b) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const vn = (x, y) => { const i = Math.floor(x), j = Math.floor(y); let fx = x - i, fy = y - j; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  return (ih(i, j) * (1 - fx) + ih(i + 1, j) * fx) * (1 - fy) + (ih(i, j + 1) * (1 - fx) + ih(i + 1, j + 1) * fx) * fy; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const paved = (s) => !/grass|dirt|earth|ground|gravel|sand|unpaved/.test(s || '');

// 5×7 stencil digits for runway designators (rows top → bottom)
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], 3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
};

export function makeAirfield({ els, proj, extractPolygons, extractLines, minX, minY, maxX, maxY, photo = null, log = () => {} }) {
  const fields = extractPolygons(els, proj, (t) => t.aeroway === 'aerodrome' || t.aeroway === 'airstrip');
  if (!fields.length) return null;
  const runways = extractLines(els, proj, (t) => t.aeroway === 'runway' && t.area !== 'yes');
  const taxis = extractLines(els, proj, (t) => t.aeroway === 'taxiway' && t.area !== 'yes');
  const aprons = extractPolygons(els, proj, (t) => t.aeroway === 'apron' || ((t.aeroway === 'taxiway' || t.aeroway === 'runway') && t.area === 'yes'));
  const paint = extractPolygons(els, proj, (t) => t.aeroway === 'aerodrome_marking' && t.area === 'yes');
  const holds = extractLines(els, proj, (t) => t.aeroway === 'holding_position');
  const stands = extractLines(els, proj, (t) => t.aeroway === 'parking_position');
  const rwW = (r) => parseMeters(r.tags.width) ?? 45;
  const lenOf = (pts) => { let L = 0; for (let i = 0; i + 1 < pts.length; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return L; };
  // which field a point is in, on a 4 m grid; each field mows along its longest runway
  const G = 4, mask = new Raster(minX - 40, minY - 40, maxX + 40, maxY + 40, G), dist = new Float32Array(mask.w * mask.h).fill(1e4);
  const fm = new Raster(minX - 40, minY - 40, maxX + 40, maxY + 40, 1);   // which field, at 1 m (the fence line stays clean)
  const axis = [], wTaxi = [];
  fields.forEach((f, k) => {
    mask.fillRings([f.outer, ...f.holes], (i) => { mask.data[i] = k + 1; });
    fm.fillRings([f.outer, ...f.holes], (i) => { fm.data[i] = k + 1; });
    let best = null, bl = 0, bw = 0;
    for (const r of runways) { const m = r.pts[Math.floor(r.pts.length / 2)]; const L = lenOf(r.pts); if (pointInRing(m[0], m[1], f.outer) && L > bl) { bl = L; best = r; bw = rwW(r); } }
    const a = best ? Math.atan2(best.pts.at(-1)[1] - best.pts[0][1], best.pts.at(-1)[0] - best.pts[0][0]) : 0;
    axis.push([Math.cos(a), Math.sin(a)]);
    wTaxi.push(Math.max(10.5, Math.min(23, (bw || 30) * 0.5)));
  });
  const fieldAt = (x, y) => { const c = Math.floor(x - fm.minX), r = Math.floor(fm.maxY - y); return c >= 0 && r >= 0 && c < fm.w && r < fm.h ? fm.data[r * fm.w + c] : 0; };
  // distance to the nearest pavement (runway, taxiway, apron): the mown strip is the first ~75 m of it
  const pv = (i) => { dist[i] = 0; };
  for (const r of runways) mask.strokeLine(r.pts, rwW(r), pv);
  for (const r of taxis) mask.strokeLine(r.pts, 15, pv);
  for (const p of aprons) mask.fillRings([p.outer, ...p.holes], pv);
  for (let pass = 0; pass < 2; pass++) for (let k = 0; k < dist.length; k++) {
    const i = pass ? dist.length - 1 - k : k, r = Math.floor(i / mask.w), c = i % mask.w, s = pass ? 1 : -1; let d = dist[i]; if (!d) continue;
    for (const [dc, drow, w] of [[s, 0, G], [0, s, G], [s, s, G * 1.414], [-s, s, G * 1.414]]) { const cc = c + dc, rr = r + drow; if (cc >= 0 && rr >= 0 && cc < mask.w && rr < mask.h) d = Math.min(d, dist[rr * mask.w + cc] + w); }
    dist[i] = d;
  }
  // pavement closed over gaps under 2·12 m: OSM leaves slivers between adjoining aprons and taxiways, which are paved, not
  // grass (the real islands between taxiways are 40 m and more)
  const RC = 12, out = new Float32Array(dist.length).fill(1e4);
  for (let i = 0; i < dist.length; i++) if (dist[i] > RC) out[i] = 0;
  for (let pass = 0; pass < 2; pass++) for (let k = 0; k < out.length; k++) {
    const i = pass ? out.length - 1 - k : k, r = Math.floor(i / mask.w), c = i % mask.w, s = pass ? 1 : -1; let d = out[i]; if (!d) continue;
    for (const [dc, drow, w] of [[s, 0, G], [0, s, G], [s, s, G * 1.414], [-s, s, G * 1.414]]) { const cc = c + dc, rr = r + drow; if (cc >= 0 && rr >= 0 && cc < mask.w && rr < mask.h) d = Math.min(d, out[rr * mask.w + cc] + w); }
    out[i] = d;
  }
  const infillAt = (x, y) => { const fx = (x - mask.minX) / G - 0.5, fy = (mask.maxY - y) / G - 0.5, c = Math.floor(fx), r = Math.floor(fy); if (c < 0 || r < 0 || c >= mask.w - 1 || r >= mask.h - 1) return false;
    const u = fx - c, v = fy - r, i = r * mask.w + c;
    return (out[i] * (1 - u) + out[i + 1] * u) * (1 - v) + (out[i + mask.w] * (1 - u) + out[i + mask.w + 1] * u) * v > RC + 1 + 2 * (vn(x / 2.5 + 1, y / 2.5 + 2) - 0.5); };
  // OSM's aprons leave out whole paved bays at Lisbon (the remote stands west of the terminal). Where an orthophoto covers a
  // civil field, its undescribed ground is read as grass or pavement from the photo's colour (only the class: the surface is
  // still painted here). Grass in these photos has g and r over b; concrete and asphalt are neutral to bluish. 9 samples per
  // 4 m cell, then a 3×3 mean, so paint, stains and single bushes don't flip a cell. Military fields are blurred in the
  // photos: they keep OSM's reading.
  let vegS = null, lumS = null;
  if (photo) {
    const civil = fields.map((f) => !(f.tags.landuse === 'military' || f.tags.military));
    const raw = new Float32Array(dist.length).fill(-1), lumR = new Float32Array(dist.length); let nc = 0;
    for (let r = 0; r < mask.h; r++) for (let c = 0; c < mask.w; c++) {
      const i = r * mask.w + c, k = mask.data[i]; if (!k || !civil[k - 1] || !dist[i]) continue;
      const x = mask.minX + (c + 0.5) * G, y = mask.maxY - (r + 0.5) * G; let n = 0, v = 0, lsum = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const q = photo(x + a * 1.33, y + b * 1.33); if (!q) continue; n++; const L = 0.3 * q[0] + 0.59 * q[1] + 0.11 * q[2];
        lsum += L; if ((q[1] - q[2]) + 0.5 * (q[0] - q[2]) - 0.04 * (L - 120) > 4) v++; }
      if (n >= 6) { raw[i] = v / n; lumR[i] = lsum / n; nc++; }
    }
    if (nc) {
      vegS = new Float32Array(dist.length).fill(-1); lumS = lumR;
      for (let i = 0; i < dist.length; i++) if (!dist[i] && mask.data[i] && civil[mask.data[i] - 1]) raw[i] = 0;   // mapped pavement reads as pavement
      for (let r = 1; r < mask.h - 1; r++) for (let c = 1; c < mask.w - 1; c++) { const i = r * mask.w + c; if (raw[i] < 0) continue; let sum = 0, n = 0;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const v = raw[i + a * mask.w + b]; if (v >= 0) { sum += v; n++; } else if (dist[i + a * mask.w + b] === 0) n++; }   // pavement neighbours count as not-grass
        vegS[i] = sum / n; }
      log(`airfield: photo read ${nc} cells of undescribed civil airfield ground`);
    }
  }
  const pavedPhoto = (x, y) => { if (!vegS) return false; const fx = (x - mask.minX) / G - 0.5, fy = (mask.maxY - y) / G - 0.5, c = Math.floor(fx), r = Math.floor(fy); if (c < 0 || r < 0 || c >= mask.w - 1 || r >= mask.h - 1) return false;
    const u = fx - c, v = fy - r, i = r * mask.w + c, q = [vegS[i], vegS[i + 1], vegS[i + mask.w], vegS[i + mask.w + 1]]; if (q.some((e) => e < 0)) return false;
    return ((q[0] * (1 - u) + q[1] * u) * (1 - v) + (q[2] * (1 - u) + q[3] * u) * v) < 0.33 + 0.14 * (vn(x / 2.5 + 3, y / 2.5 + 8) - 0.5); };
  const darkPhoto = (x, y) => { if (!lumS) return false; const c = Math.floor((x - mask.minX) / G), r = Math.floor((mask.maxY - y) / G), i = r * mask.w + c; return lumS[i] > 0 && lumS[i] < 112; };
  const distAt = (x, y) => { const fx = (x - mask.minX) / G - 0.5, fy = (mask.maxY - y) / G - 0.5, c = Math.max(0, Math.min(mask.w - 2, Math.floor(fx))), r = Math.max(0, Math.min(mask.h - 2, Math.floor(fy))), u = fx - c, v = fy - r, i = r * mask.w + c;
    return (dist[i] * (1 - u) + dist[i + 1] * u) * (1 - v) + (dist[i + mask.w] * (1 - u) + dist[i + mask.w + 1] * u) * v; };
  const hasPaved = runways.length + taxis.length + aprons.length > 0;

  // the ground of the field itself, for land OSM leaves undescribed inside the fence: [r, g, b, surface] or null
  const GRASS = 135, PLAIN = 128;
  const grass = (x, y) => {
    const k = fieldAt(x, y); if (!k) return null;
    const [ax, ay] = axis[k - 1], u = x * ax + y * ay, v = -x * ay + y * ax;
    if (hasPaved && (infillAt(x, y) || pavedPhoto(x, y))) {   // paved: asphalt where the photo reads dark, else concrete slabs
      if (darkPhoto(x, y)) { const n = 0.97 + 0.06 * vn(x / 9, y / 9); return [P.taxiAsph[0] * n, P.taxiAsph[1] * n, P.taxiAsph[2] * n, 175]; }
      const n = (0.975 + 0.05 * ih(Math.floor(x / 7.5), Math.floor(y / 7.5))) * (x / 7.5 - Math.floor(x / 7.5) < 0.045 || y / 7.5 - Math.floor(y / 7.5) < 0.045 ? 0.92 : 1); return [P.apron[0] * n, P.apron[1] * n, P.apron[2] * n, PLAIN]; }
    const d = hasPaved ? distAt(x, y) : 1e4, edge = 70 + 30 * vn(x / 60 + 7, y / 60 + 3), mown = 1 - sstep(edge - 12, edge + 12, d);
    // each field (≈150 m) its own shade, drifting within it
    const t = Math.min(1, Math.max(0, 0.85 * vn(x / 130 + 13, y / 130 + 5) + 0.35 * vn(x / 34 + 2, y / 34 + 17) - 0.08));
    let c = t < 0.5 ? mix(P.mownGreen, P.mownOlive, t * 2) : mix(P.mownOlive, P.mownStraw, (t - 0.5) * 2), cls = GRASS;
    // mowing: faint passes with the runway, and the cut's fine lengthwise streaks
    const band = Math.sin((v / 6) * Math.PI + 1.7 * vn(u / 80, v / 80)), streak = vn(u / 14 + 5, v / 1.3);
    c = c.map((q) => q * (1 + 0.012 * band) * (0.975 + 0.05 * streak));
    if (mown < 1) {   // rough ground: dry grass and meadow, dark scrub, bare sand
      const m = vn(x / 55 + 3, y / 55 + 9) * 0.75 + vn(x / 13 + 3, y / 13) * 0.25, sc = vn(x / 16 + 41, y / 16) * 0.45 + vn(x / 70 + 1, y / 70 + 21) * 0.75;
      const bare = vn(x / 40 + 61, y / 40 + 8) * 0.7 + vn(x / 7, y / 7 + 5) * 0.3 > 0.84;
      let r = bare ? P.bare : sc > 0.8 ? P.scrub : m > 0.5 ? P.roughDry : P.roughMead;
      r = r.map((q) => q * (0.96 + 0.08 * vn(x / 3.5 + 9, y / 3.5)));
      c = mix(r, c, mown); if (mown < 0.5 && bare) cls = PLAIN;
    } else { const b = vn(x / 18 + 91, y / 18 + 4) * 0.6 + vn(x / 4 + 7, y / 4 + 33) * 0.4; if (b > 0.72) c = mix(c, P.bare, Math.min(0.35, (b - 0.72) * 3)); }   // sun-burnt, worn ground in the strip
    return [c[0], c[1], c[2], cls];
  };

  // pavements and paint, drawn after the roads (gm: the 3-channel ground raster, gcls: its surface classes)
  const draw = (gm, gcls, SURF, polysArea) => {
    const SS = gm.mpp, X0 = gm.minX, Y1 = gm.maxY;
    const xy = (i) => [X0 + ((i % gm.w) + 0.5) * SS, Y1 - (Math.floor(i / gm.w) + 0.5) * SS];
    const put = (i, c, cl) => { gm.data[i * 3] = Math.min(255, c[0]); gm.data[i * 3 + 1] = Math.min(255, c[1]); gm.data[i * 3 + 2] = Math.min(255, c[2]); if (cl != null) gcls[i] = cl; };
    const flat = (c, cl) => (i) => put(i, c, cl);
    const ink = (c) => (i) => { if (gcls[i] !== GRASS) put(i, c); };   // paint only lands on pavement (holding lines and stand lines run on past it)
    // mapped grass inside the fence is airfield grass too (not the city's park green)
    for (const p of polysArea) {
      const t = p.tags; if (!(t.landuse === 'grass' || t.landuse === 'meadow' || t.natural === 'grassland' || t.natural === 'scrub' || t.natural === 'heath')) continue;
      if (!fieldAt(p.c[0], p.c[1])) continue;
      gm.fillRings([p.outer, ...p.holes], (i) => { const [x, y] = xy(i), g = grass(x, y); if (g) put(i, g, g[3]); });
    }
    // aprons (and taxiway/runway areas): concrete slabs aligned with the apron's long side
    for (const p of aprons) {
      let bx = 1, by = 0, bl = 0; for (let i = 0; i < p.outer.length; i++) { const a = p.outer[i], b = p.outer[(i + 1) % p.outer.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > bl) { bl = L; bx = (b[0] - a[0]) / L; by = (b[1] - a[1]) / L; } }
      const asph = /asphalt/.test(p.tags.surface || '') || (p.tags.aeroway === 'runway' && !/concrete/.test(p.tags.surface || ''));
      if (!paved(p.tags.surface)) continue;
      gm.fillRings([p.outer, ...p.holes], (i) => {
        const [x, y] = xy(i), u = x * bx + y * by, v = -x * by + y * bx;
        if (asph) { put(i, P.taxiAsph.map((q) => q * (0.97 + 0.06 * vn(x / 9, y / 9))), SURF.asphalt); return; }
        const su = Math.floor(u / 7.5), sv = Math.floor(v / 7.5), fu = u / 7.5 - su, fv = v / 7.5 - sv;
        let k = 0.975 + 0.05 * ih(su, sv);
        if (fu < 0.045 || fv < 0.045) k *= 0.9;                                    // joints
        const lane = vn(x / 40 + 3, y / 40 + 11); let c = lane > 0.62 ? mix(P.apron, P.apronLane, Math.min(1, (lane - 0.62) * 4)) : P.apron;   // worn taxilanes
        if (vn(x / 2.2 + 5, y / 2.2 + 1) > 0.84 && vn(x / 25, y / 25) > 0.6) k *= 0.93;   // oil and tyre stains round the stands
        put(i, c.map((q) => q * k), SURF.plain);
      });
    }
    const fieldK = (pts) => { const m = pts[Math.floor(pts.length / 2)]; return Math.max(0, fieldAt(m[0], m[1]) - 1); };
    // light concrete shoulders under every taxiway and runway
    for (const r of taxis) if (paved(r.tags.surface)) gm.strokeLine(r.pts, (parseMeters(r.tags.width) ?? wTaxi[fieldK(r.pts)]) + 12, flat(P.shoulder, SURF.plain));
    for (const r of runways) if (paved(r.tags.surface)) gm.strokeLine(r.pts, rwW(r) + 15, flat(P.shoulder, SURF.plain));
    for (const r of taxis) {
      if (!paved(r.tags.surface)) continue;
      const w = parseMeters(r.tags.width) ?? wTaxi[fieldK(r.pts)], asph = /asphalt/.test(r.tags.surface || '');
      gm.strokeLine(r.pts, w, (i) => { const [x, y] = xy(i), n = 0.96 + 0.08 * vn(x / 12 + 4, y / 12); put(i, (asph ? P.taxiAsph : P.taxiConc).map((q) => q * n), asph ? SURF.asphalt : SURF.plain); });
    }
    for (const r of taxis) if (paved(r.tags.surface)) gm.strokeLine(r.pts, 0.45, ink(P.yellow));
    for (const r of stands) gm.strokeLine(r.pts, 0.3, ink(P.yellow));
    // runways: one pass over a ribbon, everything from (s along, l across)
    let nRw = 0;
    for (const r of runways) {
      if (!paved(r.tags.surface)) continue;
      const w = rwW(r), hw = w / 2, pts = r.pts, Lt = lenOf(pts); if (Lt < 200) continue;
      const conc = /concrete/.test(r.tags.surface || ''), base = conc ? P.runwayConc : P.runway;
      const brg = (Math.atan2(pts.at(-1)[0] - pts[0][0], pts.at(-1)[1] - pts[0][1]) * 180) / Math.PI;   // from the first end, towards the last
      const refs = String(r.tags.ref || '').split('/').map((s) => s.trim()).filter((s) => /^\d{1,2}[LRC]?$/.test(s));
      const desig = (b) => { const want = ((Math.round((((b % 360) + 360) % 360) / 10) + 35) % 36) + 1;   // the end you land on reads your heading
        let best = refs[0], bd = 99; for (const s of refs) { const n = parseInt(s, 10), dd = Math.min(Math.abs(n - want), 36 - Math.abs(n - want)); if (dd < bd) { bd = dd; best = s; } }
        return best ?? String(want).padStart(2, '0'); };
      const ends = [pts[0], pts.at(-1)];
      // an end someone has mapped the paint of keeps the mapped paint only
      const mapped = ends.map((e) => paint.filter((q) => Math.hypot(q.c[0] - e[0], q.c[1] - e[1]) < 1100 && distToLine(q.c, pts) < hw + 2).length >= 4);
      const desigs = [desig(brg), desig(brg + 180)];
      const nKeys = w >= 45 ? 12 : w >= 30 ? 8 : w >= 23 ? 6 : 4, keyPitch = (hw - 3) / (nKeys / 2 + 0.25);
      const long = Lt >= 2400, aim = long ? 400 : Lt >= 1200 ? 300 : 250, aimLen = long ? 50 : 45, aimW = w >= 45 ? 10 : w >= 30 ? 6 : 4, aimIn = w >= 45 ? 9 : w >= 30 ? 7 : 5;
      const tdz = long ? [[150, 3], [450, 2], [600, 2], [750, 1], [900, 1]] : Lt >= 1200 ? [[150, 2], [450, 1], [600, 1]] : [[150, 1]];
      const glyph = (txt, s0, l) => {   // l across (pilot's left → right), s0 = metres past the threshold to the digit bottom
        const H = 9, Wd = 3.6, gap = 1.6, n = txt.length, tot = n * Wd + (n - 1) * gap;
        const sy = 6 - Math.floor(((s0) / H) * 7); if (sy < 0 || sy > 6) return false;
        const lx = l + tot / 2; if (lx < 0 || lx >= tot) return false;
        const ci = Math.floor(lx / (Wd + gap)), within = lx - ci * (Wd + gap); if (within >= Wd) return false;
        const f = FONT[txt[ci]]; return !!f && f[sy][Math.floor((within / Wd) * 5)] === '1';
      };
      const shade = (s, l, end, sFrom) => {   // colour at s along the whole runway (sFrom from this end), l across (positive = left of the travel)
        const al = Math.abs(l);
        let c = base, cls = conc ? SURF.plain : SURF.asphalt;
        // asphalt laid in 7.5 m lanes and ~60 m pulls, each its own age
        let k = 0.97 + 0.06 * ih(Math.floor(s / 60), Math.floor((l + 100) / 7.5));
        if (conc) { const fu = s / 7.5 - Math.floor(s / 7.5), fv = (l + 100) / 7.5 - Math.floor((l + 100) / 7.5); if (fu < 0.04 || fv < 0.04) k *= 0.91; }
        let white = false;
        if (al > hw - 1.1 && al < hw - 0.2) white = true;                                                      // edge lines
        if (!mapped[end]) {
          if (sFrom >= 6 && sFrom < 36) { const kk = (al - 1.8) / keyPitch; if (al >= 1.8 && kk < nKeys / 2 && kk - Math.floor(kk) < 0.5) white = true; }   // threshold keys
          if (sFrom >= 48 && sFrom < 57 && glyph(desigs[end], sFrom - 48, -l)) white = true;            // designator, read from the approach
          if (sFrom >= aim && sFrom < aim + aimLen && al >= aimIn && al < aimIn + aimW) white = true;          // aiming point
          for (const [s0, n] of tdz) if (sFrom >= s0 && sFrom < s0 + 22.5 && al >= aimIn) { const q = (al - aimIn) / 3.3; if (q < n && q - Math.floor(q) < 0.55) white = true; }   // touchdown bars
        }
        if (al < 0.45 && sFrom >= 66 && ((sFrom - 66) % 50) < 30) white = true;                              // centre line
        if (white) { c = P.white; k = 0.97 + 0.03 * ih(Math.floor(s * 3), Math.floor(l * 3)); }
        // rubber: black smears over the touchdown zone, densest on the centre, in streaks along the wheel paths
        const rz = sstep(120, 300, sFrom) * (1 - sstep(800, 1200, sFrom)) * Math.exp(-((l / (w * 0.24)) ** 2));
        if (rz > 0.01) k *= 1 - (conc ? 0.45 : 0.42) * rz * (0.55 + 0.45 * ih(Math.floor(s / 6), Math.floor((l + 100) / 0.55)));
        return [c.map((q) => q * k), cls];
      };
      for (let i = 0; i + 1 < pts.length; i++) {   // ribbon: one quad per segment, (s, l) from the pixel centre
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1], L = Math.hypot(x2 - x1, y2 - y1); if (L < 1e-6) continue;
        const ux = (x2 - x1) / L, uy = (y2 - y1) / L, s0 = lenOf(pts.slice(0, i + 1));
        gm.fillRings([[[x1 - uy * hw, y1 + ux * hw], [x2 - uy * hw, y2 + ux * hw], [x2 + uy * hw, y2 - ux * hw], [x1 + uy * hw, y1 - ux * hw]]], (j) => {
          const [x, y] = xy(j), a = (x - x1) * ux + (y - y1) * uy, l = -(x - x1) * uy + (y - y1) * ux, s = s0 + a;
          if (a < -0.01 && i > 0 || a > L + 0.01 && i + 2 < pts.length) return;
          const end = s < Lt - s ? 0 : 1, sFrom = end ? Lt - s : s;
          const [c, cls] = shade(s, end ? -l : l, end, sFrom); put(j, c, cls);
        });
      }
      nRw++;
    }
    // mapped paint, as mapped
    for (const p of paint) gm.fillRings([p.outer, ...p.holes], flat(p.tags.colour === 'yellow' ? P.yellow : P.white));
    // holding positions: two solid and two dashed yellow lines across the taxiway
    for (const h of holds) {
      const off = (d) => h.pts.map((p, i) => { const a = h.pts[Math.max(0, i - 1)], b = h.pts[Math.min(h.pts.length - 1, i + 1)], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [p[0] - ((b[1] - a[1]) / L) * d, p[1] + ((b[0] - a[0]) / L) * d]; });
      for (const d of [-0.45, -0.15]) gm.strokeLine(off(d), 0.15, ink(P.yellow));
      for (const d of [0.15, 0.45]) { const q = off(d); let acc = 0; for (let i = 0; i + 1 < q.length; i++) { const L = Math.hypot(q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]);
        for (let s = 0; s < L; s += 0.5) { if (((acc + s) % 1.8) < 0.9) { const t0 = s / L, t1 = Math.min(1, (s + 0.5) / L); gm.strokeLine([[q[i][0] + (q[i + 1][0] - q[i][0]) * t0, q[i][1] + (q[i + 1][1] - q[i][1]) * t0], [q[i][0] + (q[i + 1][0] - q[i][0]) * t1, q[i][1] + (q[i + 1][1] - q[i][1]) * t1]], 0.15, ink(P.yellow)); } }
        acc += L; } }
    }
    log(`airfield: ${fields.length} field(s), ${nRw} runway(s), ${taxis.length} taxiways, ${aprons.length} aprons, ${paint.length} mapped paint`);
  };
  return { grass, draw, fieldAt };
}
function distToLine(p, pts) { let m = 1e9; for (let i = 0; i + 1 < pts.length; i++) { const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L)); m = Math.min(m, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy)); } return m; }
