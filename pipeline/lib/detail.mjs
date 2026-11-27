// Per-building detail from photographs and the LiDAR survey: what each building, tree and patch of ground really looks like.
//
// Sources (data/detail, fetched by pipeline/fetch_detail.py): DGT orthophotos (CC BY 4.0) as GeoTIFFs in EPSG:4326, each with a
// small JSON beside it that says how the photo was taken:
//   lean [ex, ey]  where a roof appears, per metre of building height, in local metres (x east, y north): an off-nadir photo
//                  shows every roof displaced away from the camera, and the façades that face the camera in the gap
//   sun  {az, el}  the sun when the photo was taken (degrees): cast shadows in the photo are found from the LiDAR heights
//
// Everything here is measured. Where no photo covers a point, every function returns null and the builder keeps its old rules.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fromFile } from 'geotiff';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// photo → albedo-like sRGB: satellite and aerial photos are hazy and low in contrast; lift mid-tones and restore saturation
const tone = (c, sat = 1.18) => {
  const t = c.map((v) => 255 * Math.pow(clamp(v, 0, 255) / 255, 0.86) * 1.04), l = (t[0] + t[1] + t[2]) / 3;
  return t.map((v) => clamp(l + (v - l) * sat, 0, 255));
};
// photo → the colour Google Earth shows (what João compares against): fitted on the 216 Telheiras buildings read by eye
// (data/detail/telheiras_looks.json) against this module's own photo reads. In log-linear light, a surface's colour is the
// class mean plus k × how far its photo read sits from the photo mean. Leave-one-out error (sRGB distance): tiles 13.3 at
// k 0.25 (old tone() 61), flat roofs 41 at k 0.5 (tone() 49). Walls: the aerial reads do not predict the wall colour at all
// (hue correlation 0.1–0.26, every k worse than the mean), so walls are not taken from the photos.
const CAL = { tile: { mX: [-0.4312, -1.2919, -1.6889], mY: [-0.4209, -1.6917, -2.191], k: 0.25 }, flat: { mX: [-0.6428, -0.8915, -1.0887], mY: [-0.6245, -0.7542, -0.748], k: 0.75 } };   // flat k .75 (LOO 43 vs 41 at .5): less pull to Telheiras' pinkish membranes
const calib = (c, C, k = C.k) => c.map((v, i) => 255 * Math.pow(clamp(Math.exp(C.mY[i] + k * (Math.log(Math.pow(clamp(v, 0, 255) / 255, 2.2) + 1e-3) - C.mX[i])), 0, 1), 1 / 2.2));
const median3 = (arr) => { if (!arr.length) return null; const m = [0, 1, 2].map((k) => arr.map((c) => c[k]).sort((a, b) => a - b)[arr.length >> 1]); return m; };
const isTile = ([r, g, b]) => r > g * 1.1 && r > b * 1.25 && r - b > 32;   // fired clay: orange to salmon to brown-red

export async function loadDetail({ ROOT, proj, minX, minY, maxX, maxY, log, pointInRing, segDist, lidar, area }) {
  const dir0 = path.join(ROOT, 'data/detail');
  if (process.env.NO_DETAIL || !fs.existsSync(dir0)) return null;
  // the area's own sources (data/detail/city, from the detail-city release: node pipeline/get_detail.mjs <area>) cover all of
  // it; without them, whatever pilot sources overlap it (Telheiras)
  const cityDir = path.join(dir0, 'city'), own = area && fs.existsSync(path.join(cityDir, `${area}_ortho2025.tif`));
  const dir = own ? cityDir : dir0, mine = (f) => !own || f.startsWith(area + '_');
  if (own) log(`detail: ${area}'s own photos and 50 cm survey`);
  const photos = [];
  for (const f of fs.readdirSync(dir).filter((f) => /_ortho.*\.tif$/.test(f) && mine(f)).sort()) {
    const meta = path.join(dir, f.replace(/\.tif$/, '.json')); if (!fs.existsSync(meta)) continue;
    const img = await (await fromFile(path.join(dir, f))).getImage(), [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
    const w = img.getWidth(), h = img.getHeight();
    // does it overlap this area?
    const [la0, lo0] = proj.inv(minX, minY), [la1, lo1] = proj.inv(maxX, maxY);
    if (ox > lo1 || ox + rx * w < lo0 || oy < la0 || oy + ry * h > la1) continue;
    const { data } = await sharp(path.join(dir, f), { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
    photos.push({ name: f, ox, oy, rx, ry, w, h, data, ...JSON.parse(fs.readFileSync(meta, 'utf8')) });
    log(`detail photo ${f} ${w}×${h}, lean ${JSON.parse(fs.readFileSync(meta, 'utf8')).lean}`);
  }
  if (!photos.length) return null;
  // the 50 cm LiDAR surface (heights above ground, dm) where fetched: rooftop structures, crowns and shadows at 4× the detail
  const fines = [];
  for (const f of fs.readdirSync(dir).filter((f) => /_ndsm50\.tif$/.test(f) && mine(f))) {
    const img = await (await fromFile(path.join(dir, f))).getImage(), [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution(), [r] = await img.readRasters();
    fines.push({ ox, oy, rx, ry, w: img.getWidth(), h: img.getHeight(), r }); log(`detail survey ${f} ${img.getWidth()}×${img.getHeight()}`);
  }
  const fine = (x, y) => {
    const [la, lo] = proj.inv(x, y);
    for (const F of fines) { const c = Math.floor((lo - F.ox) / F.rx), k = Math.floor((la - F.oy) / F.ry); if (c >= 0 && k >= 0 && c < F.w && k < F.h) return F.r[k * F.w + c] / 10; }
    return lidar ? lidar(x, y) : NaN;
  };
  const fineCovers = (x, y) => { const [la, lo] = proj.inv(x, y); return fines.some((F) => { const c = Math.floor((lo - F.ox) / F.rx), k = Math.floor((la - F.oy) / F.ry); return c >= 0 && k >= 0 && c < F.w && k < F.h; }); };
  // how far the primary photo leans a point of height h: measured building by building (read), interpolated in between
  const leans = [];
  let leanG = null;
  const leanAt = (x, y) => {
    if (!leanG) {
      const LG = 25, lw = Math.ceil((maxX - minX) / LG) + 1, lh = Math.ceil((maxY - minY) / LG) + 1, g = new Float32Array(lw * lh * 2);
      const fb = P.lean || [0, 0];
      for (let r = 0; r < lh; r++) for (let c = 0; c < lw; c++) {
        const gx = minX + c * LG, gy = minY + r * LG; let sx = 0, sy = 0, sw_ = 0;
        for (const [bx, by, lx, ly] of leans) { const d2 = (bx - gx) ** 2 + (by - gy) ** 2; if (d2 > 250 * 250) continue; const w = 1 / (d2 + 900); sx += lx * w; sy += ly * w; sw_ += w; }
        const k = clamp(sw_ * 900 * 2, 0, 1);   // far from any measured building: the photo's mean lean
        g[(r * lw + c) * 2] = sw_ ? (sx / sw_) * k + fb[0] * (1 - k) : fb[0]; g[(r * lw + c) * 2 + 1] = sw_ ? (sy / sw_) * k + fb[1] * (1 - k) : fb[1];
      }
      leanG = { LG, lw, lh, g };
    }
    const { LG, lw, lh, g } = leanG, fx = clamp((x - minX) / LG, 0, lw - 1.001), fy = clamp((y - minY) / LG, 0, lh - 1.001), c = Math.floor(fx), r = Math.floor(fy), u = fx - c, v = fy - r;
    const at = (k) => (g[(r * lw + c) * 2 + k] * (1 - u) + g[(r * lw + c + 1) * 2 + k] * u) * (1 - v) + (g[((r + 1) * lw + c) * 2 + k] * (1 - u) + g[((r + 1) * lw + c + 1) * 2 + k] * u) * v;
    return [at(0), at(1)];
  };
  // photos are ranked in their JSON: the best one (newest, sharpest) gives roofs and ground; every photo is asked for façades
  photos.sort((a, b) => (b.rank || 0) - (a.rank || 0));
  const P = photos[0];
  // bilinear RGB at local metres; null outside the photo (with a 2 px border)
  const rgb = (x, y, ph = P) => {
    const [la, lo] = proj.inv(x, y), fx = (lo - ph.ox) / ph.rx - 0.5, fy = (la - ph.oy) / ph.ry - 0.5;
    const c = Math.floor(fx), r = Math.floor(fy); if (c < 2 || r < 2 || c >= ph.w - 3 || r >= ph.h - 3) return null;
    const u = fx - c, v = fy - r, i = (r * ph.w + c) * 3, j = i + ph.w * 3, d = ph.data, o = [0, 0, 0];
    for (let k = 0; k < 3; k++) o[k] = (d[i + k] * (1 - u) + d[i + 3 + k] * u) * (1 - v) + (d[j + k] * (1 - u) + d[j + 3 + k] * u) * v;
    return o;
  };
  const L3 = (c) => c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15;
  const lum = (x, y, ph) => { const c = rgb(x, y, ph); return c ? L3(c) : NaN; };
  const covers = (x, y) => rgb(x, y) !== null;

  // the sun when a photo was taken, measured from the photo itself: the survey casts shadows for any sun, and the right sun
  // is the one whose shadows fall where the photo is dark. For ~20k open-ground points, the steepest skyline towards each
  // azimuth (from the 50 cm survey); a point is in shade when that skyline is above the sun. Score = how well "in shade"
  // separates dark from light ground (point-biserial correlation), coarse then fine in azimuth, every degree of elevation.
  const fitSun = (ph, bx = [minX, minY, maxX, maxY], quiet = false) => {
    const t0 = Date.now(), st = 3, all = [];
    for (let y = bx[1] + st / 2; y < bx[3]; y += st) for (let x = bx[0] + st / 2; x < bx[2]; x += st) {
      const c = rgb(x, y, ph); if (!c) continue; const z0 = fine(x, y); if (!(z0 < 0.3)) continue; all.push([x, y, Math.max(0, z0), L3(c)]);
    }
    const every = Math.max(1, Math.floor(all.length / 20000)), smp = all.filter((_, i) => i % every === 0);
    if (smp.length < (quiet ? 1200 : 2000)) { if (!quiet) log(`detail ${ph.name}: too little open ground to fit the sun (${smp.length})`); return null; }
    const RS = []; for (let s = 1; s <= 70; s += s < 20 ? 1 : 2.5) RS.push(s);
    const els = []; for (let e = 20; e <= 80; e++) els.push(e);
    const score = (azd) => {
      const az = (azd * Math.PI) / 180, ux = Math.sin(az), uy = Math.cos(az), T = new Float32Array(smp.length);
      for (let i = 0; i < smp.length; i++) { const [x, y, z0] = smp[i]; let m = -1; for (const s of RS) { const z = fine(x + ux * s, y + uy * s); if (z > 0.5) { const t = (z - z0 - 0.3) / s; if (t > m) m = t; } } T[i] = m; }
      let best = [-2, 0], n = smp.length, sL = 0, sL2 = 0; for (const q of smp) { sL += q[3]; sL2 += q[3] * q[3]; }
      const sd = Math.sqrt(Math.max(1, sL2 / n - (sL / n) ** 2));
      for (const e of els) {
        const tn = Math.tan((e * Math.PI) / 180); let k = 0, sh = 0;
        for (let i = 0; i < n; i++) if (T[i] > tn) { k++; sh += smp[i][3]; }
        if (k < 30 || k > n - 30) continue;
        const r = ((sL - sh) / (n - k) - sh / k) / sd * Math.sqrt((k / n) * (1 - k / n)); if (r > best[0]) best = [r, e];
      }
      return best;
    };
    let top = [-2, 0, 0];
    for (let a = 0; a < 360; a += 10) { const [r, e] = score(a); if (r > top[0]) top = [r, e, a]; }
    const a0 = top[2]; for (let a = a0 - 8; a <= a0 + 8; a += 2) if (a !== a0) { const [r, e] = score((a + 360) % 360); if (r > top[0]) top = [r, e, (a + 360) % 360]; }
    if (!quiet) log(`detail ${ph.name}: sun fitted az ${top[2]}° el ${top[1]}° (r ${top[0].toFixed(3)}, ${smp.length} points, ${((Date.now() - t0) / 1000).toFixed(0)} s)${ph.sun ? ` — given az ${ph.sun.az} el ${ph.sun.el} scores r ${score(ph.sun.az)[0].toFixed(3)} at its best el ${score(ph.sun.az)[1]}` : ''}`);
    return top[0] > 0.05 ? { az: top[2], el: top[1], r: top[0], fitted: true } : null;
  };
  // an aerial survey is flown in strips, on different days and hours: the sun is fitted again for each ~1 km block, and a
  // block keeps the area's sun unless its own fit is clearly better at explaining its shadows
  const BK = 1000, bw = Math.max(1, Math.round((maxX - minX) / BK)), bh = Math.max(1, Math.round((maxY - minY) / BK));
  if (lidar) for (const ph of photos) if (!ph.sun || process.env.SUN_FIT) {
    const f = fitSun(ph); if (!f || ph.sun) continue; ph.sun = f; ph.suns = [];
    const own = [];
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      const bx = [minX + ((maxX - minX) * i) / bw, minY + ((maxY - minY) * j) / bh, minX + ((maxX - minX) * (i + 1)) / bw, minY + ((maxY - minY) * (j + 1)) / bh];
      const g = fitSun(ph, bx, true), useOwn = g && g.r > Math.max(0.15, f.r * 0.8) && (Math.abs(((g.az - f.az + 540) % 360) - 180) > 6 || Math.abs(g.el - f.el) > 4);
      ph.suns.push(useOwn ? g : f); if (useOwn) own.push(`${i},${j}: ${g.az}°/${g.el}°`);
    }
    if (own.length) log(`detail ${ph.name}: blocks flown under another sun: ${own.join(', ')}`);
  }
  const sunAt = (ph, x, y) => { if (!ph.suns) return ph.sun; const i = clamp(Math.floor(((x - minX) / (maxX - minX)) * bw), 0, bw - 1), j = clamp(Math.floor(((y - minY) / (maxY - minY)) * bh), 0, bh - 1); return ph.suns[j * bw + i]; };
  const bbox = (R) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of R) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; };
  const inside = (p, x, y) => pointInRing(x, y, p.outer) && !p.holes.some((hh) => pointInRing(x, y, hh));

  // where this building's roof appears in a photo. A satellite looks from one direction: its lean × height, refined. An aerial
  // survey is a mosaic of perspective frames: every building leans its own way, so the shift is searched in 2D (coarse, then
  // fine). The score is edge strength along the shifted outline: roof edges against façade, shadow or ground are the
  // strongest edges in a photo.
  const outlinePts = (R) => { const o = []; for (let i = 0; i < R.length; i++) { const a = R[i], b = R[(i + 1) % R.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let s = 0; s < L; s += 0.6) o.push([a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L]); } return o; };
  const edgeScore = (pts, dx, dy, ph) => { let s = 0, n = 0; for (const [x, y] of pts) { const a = lum(x + dx + 0.3, y + dy, ph), b = lum(x + dx - 0.3, y + dy, ph), c = lum(x + dx, y + dy + 0.3, ph), d = lum(x + dx, y + dy - 0.3, ph); if (isFinite(a + b + c + d)) { s += Math.hypot(a - b, c - d); n++; } } return n > pts.length * 0.8 ? s / n : -1; };
  const roofShift = (p, h, ph) => {
    const pts = outlinePts(p.outer); if (pts.length < 8) return ph.lean ? [ph.lean[0] * h, ph.lean[1] * h] : [0, 0];
    let best = -1, bd = [0, 0];
    const tryAt = (dx, dy) => { const s = edgeScore(pts, dx, dy, ph); if (s > best) { best = s; bd = [dx, dy]; } };
    if (ph.lean) {
      const [lx, ly] = ph.lean, L = Math.hypot(lx, ly), px = -ly / L, py = lx / L;
      for (let k = 0.5; k <= 1.5001; k += 0.1) for (let j = -1.5; j <= 1.5001; j += 0.75) tryAt(lx * h * k + px * j, ly * h * k + py * j);
    } else {
      const R = Math.max(1.5, h * (ph.maxLean || 0.4)), st = R > 6 ? 1.5 : 0.75;
      for (let dy = -R; dy <= R; dy += st) for (let dx = -R; dx <= R; dx += st) if (dx * dx + dy * dy <= R * R) tryAt(dx, dy);
      const [cx, cy] = bd; for (let dy = -st; dy <= st; dy += 0.5) for (let dx = -st; dx <= st; dx += 0.5) tryAt(cx + dx, cy + dy);
    }
    return bd;
  };

  // cast shadows in each photo, from the survey heights and the sun of that photo (2 m grid), and how much darker they are
  const S2 = 2, sw = Math.ceil((maxX - minX) / S2), shh = Math.ceil((maxY - minY) / S2);
  // computed cell by cell on demand (a whole area at 2 m is ~3M rays a photo): 0 not yet asked, 1 lit, 2 in shade
  const shadowCell = (ph, r, c) => {
    const g = ph.shg ||= new Uint8Array(sw * shh), i = r * sw + c; if (g[i]) return g[i] - 1;
    let v = 0;
    if (ph.sun && lidar) {
      const x = minX + (c + 0.5) * S2, y = maxY - (r + 0.5) * S2, z0 = rgb(x, y, ph) ? fine(x, y) : NaN;
      if (z0 < 1.5) {
        const sn = sunAt(ph, x, y), az = (sn.az * Math.PI) / 180, tn = Math.tan((sn.el * Math.PI) / 180), ux = Math.sin(az), uy = Math.cos(az);   // towards the sun
        for (let s = 1; s < 90; s += 1) { const z = fine(x + ux * s, y + uy * s); if (z > s * tn + Math.max(0, z0) + 0.3) { v = 1; break; } }
      }
    }
    g[i] = v + 1; return v;
  };
  const shadowAt = (x, y, ph = P) => { const c = Math.floor((x - minX) / S2), r = Math.floor((maxY - y) / S2); return c >= 0 && r >= 0 && c < sw && r < shh ? shadowCell(ph, r, c) : 0; };
  // per channel: sunlit over shaded open ground, just either side of the shadow edges (same pavement, same lawn)
  const ratio = (ph = P) => {
    if (ph.ratio) return ph.ratio;
    const sun = [[], [], []], shd = [[], [], []], at = (r, c) => shadowCell(ph, r, c), st = Math.max(1, Math.round(Math.sqrt((sw * shh) / 400000)));   // ~400k cells looked at
    for (let r = 3; r < shh - 3; r += st) for (let c = 3; c < sw - 3; c += st) {
      const x = minX + (c + 0.5) * S2, y = maxY - (r + 0.5) * S2;
      if (!(fine(x, y) < 0.3)) continue;
      const g = at(r, c); if (!(g !== at(r, c + 2) || g !== at(r, c - 2) || g !== at(r + 2, c) || g !== at(r - 2, c))) continue;
      const q = rgb(x, y, ph); if (!q) continue; const a = g ? shd : sun; for (let k = 0; k < 3; k++) a[k].push(q[k]);
    }
    const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1] || 1; };
    ph.ratio = [0, 1, 2].map((k) => clamp(med(sun[k]) / Math.max(8, med(shd[k])), 1, 5));
    log(`detail ${ph.name}: shadow lift ${ph.ratio.map((v) => v.toFixed(2)).join('/')} from ${sun[0].length}/${shd[0].length} edge samples`);
    return ph.ratio;
  };

  // façade band in one photo: the gap between the footprint and its leaned roof is the wall that faces the camera
  const facadeIn = (p, h, ph, [dx, dy]) => {
    if (Math.hypot(dx, dy) < 1.2) return null;   // seen from straight above: no wall in view
    const [x0, y0, x1, y1] = bbox(p.outer); let fac = [];
    const X0 = Math.min(x0, x0 + dx), X1 = Math.max(x1, x1 + dx), Y0 = Math.min(y0, y0 + dy), Y1 = Math.max(y1, y1 + dy);
    for (let y = Y0; y < Y1; y += 0.5) for (let x = X0; x < X1; x += 0.5) {
      if (inside(p, x - dx, y - dy)) continue;                       // roof
      let wall = false; for (let t = 0.2; t < 0.72; t += 0.08) if (inside(p, x - dx * t, y - dy * t)) { wall = true; break; }
      if (!wall) continue;
      const c = rgb(x, y, ph); if (c) fac.push(c);
    }
    if (fac.length < 24) return null;
    // clay-coloured pixels in the band are the tiled eaves and rims leaning into it, unless the wall itself is brick or salmon
    const nt = fac.filter((c) => !isTile(c)); if (nt.length >= Math.max(24, fac.length * 0.35)) fac = nt;
    // the brighter half: windows, balcony shade and the odd tree are darker than the render
    fac.sort((a, b) => L3(b) - L3(a)); const top = fac.slice(0, Math.max(12, fac.length >> 1));
    return { c: median3(top), n: fac.length };
  };

  // white balance of the façade reads: every photo is brought to the consensus of all of them (the geometric mean of their
  // casts on the same sunlit grey paving), so a yellow wall is yellow whichever photo saw it lit, and no one survey's cast
  // (the 2025 flight is cool, the 2018 one warm) decides the colour of the city
  let WB = null;
  const wb = (ph) => {
    if (!WB) {
      const S = photos.map(() => [[], [], []]);
      for (let y = minY + 5; y < maxY; y += 9) for (let x = minX + 5; x < maxX; x += 9) {
        if (!(fine(x, y) < 0.4) || photos.some((q) => shadowAt(x, y, q))) continue;
        const qs = photos.map((q) => rgb(x, y, q)); if (qs.some((q) => !q)) continue;
        const p = qs[0]; if (Math.max(...p) - Math.min(...p) > 22 || L3(p) < 90 || qs.some((q) => L3(q) > 235)) continue;
        qs.forEach((q, i) => { for (let k = 0; k < 3; k++) S[i][k].push(q[k]); });
      }
      const med = (v) => { v.sort((x, y) => x - y); return v[v.length >> 1] || 1; };
      const M = S.map((A) => A.map(med)), n = S[0][0].length;
      const G = [0, 1, 2].map((k) => Math.exp(M.reduce((a, m) => a + Math.log(m[k]), 0) / M.length));
      WB = n > 200 ? M.map((m) => { const w = [0, 1, 2].map((k) => clamp(G[k] / m[k], 0.6, 1.7)), l = L3(w); return w.map((v) => v / l); }) : photos.map(() => [1, 1, 1]);   // hue only: each photo keeps its own exposure
      photos.forEach((q, i) => log(`detail ${q.name}: façade white balance ${WB[i].map((v) => v.toFixed(2)).join('/')} (${n} paving samples)`));
    }
    return WB[photos.indexOf(ph)];
  };
  // one building: roof colours and how much of the roof is tiled (best photo), and the façade from the photo that sees it lit
  const read = (p, h) => {
    if (!covers(p.c[0], p.c[1]) || !(h > 2)) return null;
    const sh0 = roofShift(p, h, P), [dx, dy] = sh0;
    if (h > 8 && Math.abs(p.area) > 80 && Math.hypot(dx, dy) < 0.37 * h) leans.push([p.c[0], p.c[1], dx / h, dy / h]);
    const [x0, y0, x1, y1] = bbox(p.outer), st = Math.max(0.5, Math.sqrt(Math.abs(p.area) / 4000));
    const tile = [], flat = [], all = [];
    for (let y = y0 + st / 2; y < y1; y += st) for (let x = x0 + st / 2; x < x1; x += st) {
      if (!inside(p, x, y) || segDist(x, y, p.outer) < 0.9) continue;
      const c = rgb(x + dx, y + dy); if (c) all.push(c);
    }
    if (all.length < 6) return null;
    const lm = all.map(L3).sort((a, b) => a - b), roofL = lm[Math.floor(lm.length * 0.7)], dark = lm[Math.floor(lm.length * 0.5)] * 0.62;
    for (const c of all) { if (L3(c) < dark) continue; (isTile(c) ? tile : flat).push(c); }
    const n = tile.length + flat.length;
    let wall = null, wallSrc = null, wallRaw = null;
    if (h > 6) {
      const cand = [];
      for (const ph of photos) {
        const s = ph === P ? sh0 : roofShift(p, h, ph), f = facadeIn(p, h, ph, s); if (!f) continue;
        // lit when the wall is about as bright as the roof beside it in the same photo; else lift it out of the shade
        const rl = ph === P ? roofL : (() => { const v = []; for (let y = y0 + st / 2; y < y1; y += st * 2) for (let x = x0 + st / 2; x < x1; x += st * 2) if (inside(p, x, y) && segDist(x, y, p.outer) > 0.9) { const q = rgb(x + s[0], y + s[1], ph); if (q) v.push(L3(q)); } v.sort((a, b) => a - b); return v[Math.floor(v.length * 0.7)] || 1; })();
        const lit = L3(f.c) / rl;
        // which wall is in view: the one facing back from the lean (the camera's side). Is it facing the sun of that photo?
        const L = Math.hypot(s[0], s[1]) || 1, az = ((ph.sun ? sunAt(ph, p.c[0], p.c[1]).az : 180) * Math.PI) / 180, facing = (-s[0] / L) * Math.sin(az) + (-s[1] / L) * Math.cos(az);
        cand.push({ ph, lit, f, s, facing, sunny: facing > 0.12 && lit > 0.5 });
      }
      // a wall turned to the sun beats one in shade (most turned first; the newest photo on a near tie); in shade, the
      // brightest view, lifted by that photo's sun/shade ratio. Every photo is white-balanced to the newest.
      cand.sort((a, b) => (b.sunny - a.sunny) || (a.sunny ? b.facing + (b.ph === P ? 0.15 : 0) - a.facing - (a.ph === P ? 0.15 : 0) : b.lit - a.lit));
      for (const b of cand) {
        if (!b.sunny && (b.lit > 0.85 || isTile(b.f.c))) continue;   // a wall turned from the sun yet as bright as the roof, or clay-red: the band caught the roof, not the wall
        const c = b.f.c.map((v, k) => v * wb(b.ph)[k]);
        const c2 = b.sunny ? c : c.map((v, k) => v * ratio(b.ph)[k]), mx = Math.max(...c2), c3 = mx > 242 ? c2.map((v) => (v * 242) / mx) : c2;   // never burn a wall to paper: scale back, keep the hue
        const w = tone(c3, b.sunny ? 1.08 : 1.0);
        if (L3(w) < 110) continue;
        wall = w; wallRaw = c3; wallSrc = { photo: b.ph.name, lit: +b.lit.toFixed(2), facing: +b.facing.toFixed(2), n: b.f.n }; break;
      }
      var cands = cand.map((b) => [b.ph.name.slice(10, 22), +b.lit.toFixed(2), +b.facing.toFixed(2), b.f.c.map(Math.round)]);
    }
    const tileRaw = tile.length > 8 ? median3(tile).map((v, k) => v * wb(P)[k]) : null, flatRaw = flat.length > 8 ? median3(flat).map((v, k) => v * wb(P)[k]) : null;
    return { shift: sh0, n, tileFrac: n ? tile.length / n : 0, tile: tileRaw ? calib(tileRaw, CAL.tile) : null, flat: flatRaw ? calib(flatRaw, CAL.flat) : null, wall, wallSrc, cands, tileRaw, flatRaw, wallRaw };
  };

  // trees: canopy peaks of the survey, one per crown, kept only where the survey sees a full crown around the peak and the
  // photo sees leaves there (leaned like everything else in it). Not on buildings, roads or bridges: an overpass deck, a lamp
  // post, a parapet or a crane is tall and solid, but grey.
  const trees = ({ blockedAt, roadAt = () => false }) => {
    const G = fines.length ? 1 : 1.5, cand = [];
    for (let y = minY + G / 2; y < maxY; y += G) for (let x = minX + G / 2; x < maxX; x += G) {
      if (!covers(x, y)) continue;
      const z = fine(x, y); if (!(z > 3.2 && z < 26) || blockedAt(x, y) || roadAt(x, y)) continue;
      let top = true; for (const [a, b] of [[G, 0], [-G, 0], [0, G], [0, -G], [G, G], [-G, G], [G, -G], [-G, -G]]) if (fine(x + a, y + b) > z) { top = false; break; }
      if (top) cand.push([x, y, z]);
    }
    cand.sort((a, b) => b[2] - a[2]);
    const out = [], cell = new Map(), key = (x, y) => `${Math.floor(x / 8)},${Math.floor(y / 8)}`;
    let noCrown = 0, grey = 0;
    for (const [x, y, z] of cand) {
      const r = clamp(z * 0.35, 2.5, 7);   // crowns of Lisbon's broadleaves and pines are about a third as wide as tall
      let ok = true;
      for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) for (const q of cell.get(`${Math.floor(x / 8) + a},${Math.floor(y / 8) + b}`) || []) if (Math.hypot(q[0] - x, q[1] - y) < Math.max(r, q[3]) * 0.9) { ok = false; break; }
      if (!ok) continue;
      // a crown: most of a disc around the peak stands at least half as tall
      let full = 0, nf = 0; const cr = Math.min(r * 0.55, 3);
      for (let k = 0; k < 12; k++) { const t = (k * Math.PI) / 6, rr = k % 2 ? cr : cr * 0.5, v = fine(x + Math.cos(t) * rr, y + Math.sin(t) * rr); nf++; if (v > Math.max(2, z * 0.45)) full++; }
      if (full / nf < 0.6) { noCrown++; continue; }
      // leaves: the photo where this crown appears (leaned by its height), centre and a ring
      const [lx, ly] = leanAt(x, y), ox = lx * z * 0.85, oy = ly * z * 0.85;
      let eg = 0, sm = 0, ne = 0;
      for (let k = 0; k < 9; k++) { const t = (k * Math.PI) / 4, rr = k ? cr * 0.7 : 0, c = rgb(x + ox + Math.cos(t) * rr, y + oy + Math.sin(t) * rr); if (!c) continue; eg += 2 * c[1] - c[0] - c[2]; sm += c[0] + c[1] + c[2]; ne++; }
      if (!ne) continue; eg /= ne; sm /= ne;
      if (!(eg > 6 || (sm < 190 && eg > 1.5))) { grey++; continue; }
      // its shape, from the survey: how far out the crown stays above half the tree's height (8 rays), and how flat its top is.
      // A cypress is a narrow spire; a stone pine a broad flat umbrella high on a bare trunk; the rest are broadleaves
      const rad = []; for (let k = 0; k < 8; k++) { const t = (k * Math.PI) / 4; let d = 0.5; while (d < 10 && fine(x + Math.cos(t) * d, y + Math.sin(t) * d) > z * 0.5) d += 0.5; rad.push(d); }
      rad.sort((a, b) => a - b); const rh = rad[4];
      let flat = 0; for (let k = 0; k < 12; k++) { const t = (k * Math.PI) / 6; if (fine(x + Math.cos(t) * rh * 0.5, y + Math.sin(t) * rh * 0.5) > z * 0.88) flat++; }
      const kind = z >= 6 && rh <= Math.max(1.5, z * 0.16) ? 3 : z >= 8 && rh >= 3.5 && flat >= 8 ? 2 : 0;
      const t = [x, y, z, r, kind]; out.push(t); const k = key(x, y); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(t);
    }
    log(`detail trees: ${out.length} kept of ${cand.length} peaks (${noCrown} without a crown, ${grey} not green); ${out.filter((t) => t[4] === 3).length} cypress-shaped, ${out.filter((t) => t[4] === 2).length} umbrella pines`);
    return out;
  };

  // ground: the photo itself, with everything that stands up lifted out and cast shadows lightened. What stands up is taken
  // from the survey, not from the map: every cell over 2.2 m that is not leaves, swept along the photo's lean from its foot to
  // where its top appears, so roofs, walls and unmapped sheds all leave the ground (a squashed roof on the pavement otherwise).
  // The hole is filled with the photo's colour from around it over the painted ground's own texture (kerbs, paving, grass).
  const ground = ({ ground1, GW, GH, buildings, Raster, roadAt = () => false, ao = null, palette = null, cls = null, SURF = null }) => {
    const mpp = (maxX - minX) / GW, N = GW * GH;
    const cov = new Uint8Array(N), out = new Float32Array(N * 3), mask = new Uint8Array(N);
    const mark = (x, y) => { const c = Math.floor((x - minX) / mpp), r = Math.floor((maxY - y) / mpp); if (c >= 0 && r >= 0 && c < GW && r < GH) mask[r * GW + c] = 1; };
    const R = new Raster(minX, minY, maxX, maxY, mpp);
    for (const b of buildings) {   // mapped buildings, their leaned roofs and the façades between
      const [dx, dy] = b.shift || [leanAt(b.outer[0][0], b.outer[0][1])[0] * b.h, leanAt(b.outer[0][0], b.outer[0][1])[1] * b.h];
      for (let t = 0; t <= 1.0001; t += 0.125) R.fillRings([b.outer.map(([x, y]) => [x + dx * t, y + dy * t])], (i) => { mask[i] = 1; });
    }
    // (the survey is not swept cell by cell any more: every tree, car and lamp over 2.2 m became a hole, and holes merged
    // into whole erased blocks. Only the mapped buildings leave, along their measured lean, plus 1 m for eaves and blur.)
    const nSurv = 0;
    { const d = Math.round(1 / mpp);
      for (let pass = 0; pass < d; pass++) { const m2 = mask.slice(); for (let r = 1; r < GH - 1; r++) for (let c = 1; c < GW - 1; c++) { const i = r * GW + c; if (mask[i]) continue; if (mask[i - 1] || mask[i + 1] || mask[i - GW] || mask[i + GW]) m2[i] = 1; } mask.set(m2); }
    }
    const sh = new Float32Array(N);
    for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) sh[r * GW + c] = shadowAt(minX + (c + 0.5) * mpp, maxY - (r + 0.5) * mpp);
    for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) {
      const i = r * GW + c, x = minX + (c + 0.5) * mpp, y = maxY - (r + 0.5) * mpp, q = rgb(x, y);
      if (!q) continue; cov[i] = 1; out[i * 3] = q[0] * 1.01; out[i * 3 + 1] = q[1]; out[i * 3 + 2] = q[2] * 0.96;   // the survey's slight blue cast (grey paving reads B > R)
    }
    if (P.sun) {
      const ratio_ = ratio();
      // the 2 m shadow grid only says where to look: widen it 2 m, then the photo's own darkness decides, pixel by pixel
      const soft = boxBlur1(sh, GW, GH, Math.round(2 / mpp));
      for (let i = 0; i < N; i++) if (cov[i] && soft[i] > 0.01) {
        const l = out[i * 3] * 0.3 + out[i * 3 + 1] * 0.55 + out[i * 3 + 2] * 0.15, w = Math.min(1, soft[i] * 3) * clamp((105 - l) / 40, 0, 1);
        for (let k = 0; k < 3; k++) out[i * 3 + k] *= 1 + (ratio_[k] - 1) * w * 0.95;
      }
    }
    // The photo goes in as photographed: no gamma lift or saturation push (the renderer's exposure is calibrated so a sunlit
    // albedo comes out as itself, so any lift here is what made the floor milky). Where something stood up, the hole is filled
    // with the ground just outside it: only clean ground (2 m clear of the hole, not in shadow) is pulled in, pyramid
    // push-pull, so a pavement stays pavement and a lawn stays lawn and no façade or shadow colour can bleed into it. The
    // painted ground (kerbs, paving, lawn from the map) lends only its fine texture, as a luminance ratio to its own 6 m mean.
    const g0 = new Float32Array(N * 3); for (let i = 0; i < N * 3; i++) g0[i] = ground1[i];
    const notMask = new Uint8Array(N); for (let i = 0; i < N; i++) notMask[i] = mask[i] ? 0 : 1;
    const fromHole = distToZero(notMask, GW, GH, Math.ceil(2 / mpp));
    const clean = new Uint8Array(N); for (let i = 0; i < N; i++) clean[i] = cov[i] && fromHole[i] >= 1 / mpp ? 1 : 0;
    const fill = out.slice(); pushPull(fill, clean, new Uint8Array(N), GW, GH);
    if (process.env.DUMP_GROUND) {   // debugging: the masks as images over the area
      const d = process.env.DUMP_GROUND, img = Buffer.alloc(N * 3);
      for (let i = 0; i < N; i++) { img[i * 3] = mask[i] ? 255 : 0; img[i * 3 + 1] = clean[i] ? 255 : 0; img[i * 3 + 2] = sh[i] > 0.3 ? 255 : 0; }
      const fz = Buffer.alloc(N * 3); for (let i = 0; i < N; i++) { const z = fine(minX + ((i % GW) + 0.5) * mpp, maxY - (Math.floor(i / GW) + 0.5) * mpp); fz[i * 3] = fz[i * 3 + 1] = fz[i * 3 + 2] = Number.isFinite(z) ? clamp(z * 8, 0, 255) : 0; if (!Number.isFinite(z)) fz[i * 3] = 255; }
      sharp(img, { raw: { width: GW, height: GH, channels: 3 } }).png().toFile(`${d}/mask.png`); sharp(fz, { raw: { width: GW, height: GH, channels: 3 } }).png().toFile(`${d}/ndsm.png`);
    }
    if (palette && process.env.CALIB) {   // what each painted class really looks like in the photo (clean open ground only)
      const names = Object.keys(palette), acc = {};
      for (let i = 0; i < N; i += 3) { if (!clean[i]) continue;
        const a = ao ? Math.max(0.5, ao[i]) : 1, q = [0, 1, 2].map((k) => g0[i * 3 + k] / a); let best = null, bd = 1e9;
        for (const nm of names) { const c = palette[nm]; const d = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 + (q[2] - c[2]) ** 2; if (d < bd) { bd = d; best = nm; } }
        if (bd > 14 * 14 * 3) continue; (acc[best] ||= [[], [], []]).forEach((arr, k) => arr.push(out[i * 3 + k])); }
      for (const [nm, a] of Object.entries(acc)) { const m = a.map((arr) => { arr.sort((x, y) => x - y); return arr[arr.length >> 1]; }); log(`CALIB ${nm} n=${a[0].length} painted ${palette[nm].map(Math.round)} photo ${m.map(Math.round)} p25L ${Math.round(a[0][a[0].length >> 2])} p75L ${Math.round(a[0][(a[0].length * 3) >> 2])}`); }
    }
    // a hole is mostly the strip where the photo saw a leaning wall: the ground there is like the ground just beyond it, so it
    // is filled by reflection across the hole's edge (paving, kerbs, parked cars and grass continue with their real texture,
    // no blur). Nearest clean pixel by vector distance transform; the mirror image must itself be clean, else push-pull.
    const mir = new Int32Array(N).fill(-1);
    { const nx = new Int32Array(N).fill(-1), ny = new Int32Array(N).fill(-1), dd = new Float32Array(N).fill(1e9);
      for (let i = 0; i < N; i++) if (clean[i]) { nx[i] = i % GW; ny[i] = (i / GW) | 0; dd[i] = 0; }
      const relax = (i, j, x, y) => { if (nx[j] < 0) return; const d = (nx[j] - x) ** 2 + (ny[j] - y) ** 2; if (d < dd[i]) { dd[i] = d; nx[i] = nx[j]; ny[i] = ny[j]; } };
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { const i = y * GW + x; if (x) relax(i, i - 1, x, y); if (y) { relax(i, i - GW, x, y); if (x) relax(i, i - GW - 1, x, y); if (x < GW - 1) relax(i, i - GW + 1, x, y); } }
      for (let y = GH - 1; y >= 0; y--) for (let x = GW - 1; x >= 0; x--) { const i = y * GW + x; if (x < GW - 1) relax(i, i + 1, x, y); if (y < GH - 1) { relax(i, i + GW, x, y); if (x < GW - 1) relax(i, i + GW + 1, x, y); if (x) relax(i, i + GW - 1, x, y); } }
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { const i = y * GW + x; if (clean[i] || nx[i] < 0 || dd[i] > (14 / mpp) ** 2) continue;
        const mx = 2 * nx[i] - x, my = 2 * ny[i] - y; if (mx < 0 || my < 0 || mx >= GW || my >= GH) continue; const j = my * GW + mx; if (clean[j]) mir[i] = j; }
    }
    const gl = new Float32Array(N); for (let i = 0; i < N; i++) gl[i] = (ao ? 1 / Math.max(0.5, ao[i]) : 1) * (g0[i * 3] * 0.3 + g0[i * 3 + 1] * 0.59 + g0[i * 3 + 2] * 0.11);
    const glm = boxBlur1(gl, GW, GH, Math.round(3 / mpp));
    const edgeD = distToZero(cov, GW, GH, Math.ceil(25 / mpp));
    let n = 0, nm = 0;
    for (let i = 0; i < N; i++) {
      if (!cov[i]) continue;
      const f = clamp(edgeD[i] / (25 / mpp), 0, 1), ph = mask[i] ? 0 : clamp(fromHole[i] / (2 / mpp), 0, 1);
      const hp = clamp(gl[i] / Math.max(4, glm[i]), 0.8, 1.2);
      for (let k = 0; k < 3; k++) {
        const v = out[i * 3 + k] * ph + (mir[i] >= 0 ? out[mir[i] * 3 + k] : fill[i * 3 + k] * hp) * (1 - ph);
        ground1[i * 3 + k] = clamp(g0[i * 3 + k] * (1 - f) + v * f, 0, 255);
      }
      // ground the map leaves undescribed takes its close-up surface from what the photo shows: grey and light is paving,
      // grey and dark is asphalt, green is grass (the map's own classes stand)
      if (cls && SURF && cls[i] === SURF.plain && f > 0.5) {
        const r = ground1[i * 3], g = ground1[i * 3 + 1], b = ground1[i * 3 + 2], L = r * 0.3 + g * 0.59 + b * 0.11, sat = Math.max(r, g, b) - Math.min(r, g, b);
        cls[i] = g > r + 5 && g > b + 3 ? SURF.grass : sat < 24 && L > 128 ? SURF.calcada : sat < 18 && L < 100 ? SURF.asphalt : SURF.plain;
      }
      n++; if (mask[i]) nm++;
    }
    log(`detail ground: ${(n * mpp * mpp / 1e6).toFixed(2)} km² from the photo, ${(nm * mpp * mpp / 1e4).toFixed(1)} ha lifted out (${nSurv} survey cells standing)`);
    return { cov, edgeD, mpp };
  };

  return { photos, covers, fineCovers, leanAt, read, trees, ground, tone, rgb, calFlat: (c) => calib(c.map((v, k) => v * wb(P)[k]), CAL.flat, 1), shadowAt, fine, isTile, L3 };
}

function boxBlur1(a, w, h, r) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) { let s = 0; for (let x = -r; x <= r; x++) s += a[y * w + clamp(x, 0, w - 1)]; for (let x = 0; x < w; x++) { t[y * w + x] = s / (2 * r + 1); s += a[y * w + clamp(x + r + 1, 0, w - 1)] - a[y * w + clamp(x - r, 0, w - 1)]; } }
  for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[clamp(y, 0, h - 1) * w + x]; for (let y = 0; y < h; y++) { o[y * w + x] = s / (2 * r + 1); s += t[clamp(y + r + 1, 0, h - 1) * w + x] - t[clamp(y - r, 0, h - 1) * w + x]; } }
  return o;
}

// chamfer distance (px) to the nearest pixel where m is 0, capped
function distToZero(m, w, h, cap) {
  const d = new Float32Array(w * h); for (let i = 0; i < d.length; i++) d[i] = m[i] ? cap : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!d[i]) continue; let v = d[i]; if (x) v = Math.min(v, d[i - 1] + 1); if (y) v = Math.min(v, d[i - w] + 1); d[i] = v; }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (!d[i]) continue; let v = d[i]; if (x < w - 1) v = Math.min(v, d[i + 1] + 1); if (y < h - 1) v = Math.min(v, d[i + w] + 1); d[i] = v; }
  return d;
}

// fill masked pixels of an RGB float image from the valid ones around them (pyramid push-pull)
function pushPull(img, cov, mask, w, h) {
  const levels = [{ w, h, c: img, a: new Float32Array(w * h) }];
  for (let i = 0; i < w * h; i++) levels[0].a[i] = cov[i] && !mask[i] ? 1 : 0;
  for (let i = 0; i < w * h; i++) if (!levels[0].a[i]) { img[i * 3] = img[i * 3 + 1] = img[i * 3 + 2] = 0; }
  while (levels.at(-1).w > 4 && levels.at(-1).h > 4) {
    const L = levels.at(-1), W2 = Math.ceil(L.w / 2), H2 = Math.ceil(L.h / 2), c = new Float32Array(W2 * H2 * 3), a = new Float32Array(W2 * H2);
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) { const i = y * L.w + x, j = (y >> 1) * W2 + (x >> 1), wa = L.a[i]; if (!wa) continue; a[j] += wa; for (let k = 0; k < 3; k++) c[j * 3 + k] += L.c[i * 3 + k] * wa; }
    for (let j = 0; j < W2 * H2; j++) if (a[j]) { for (let k = 0; k < 3; k++) c[j * 3 + k] /= a[j]; a[j] = Math.min(1, a[j]); }
    levels.push({ w: W2, h: H2, c, a });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], U = levels[l + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x; if (L.a[i] >= 1) continue;
      // bilinear from the coarser level
      const fx = (x + 0.5) / 2 - 0.5, fy = (y + 0.5) / 2 - 0.5, x0 = clamp(Math.floor(fx), 0, U.w - 1), y0 = clamp(Math.floor(fy), 0, U.h - 1), x1 = Math.min(U.w - 1, x0 + 1), y1 = Math.min(U.h - 1, y0 + 1), u = clamp(fx - x0, 0, 1), v = clamp(fy - y0, 0, 1);
      const wa = L.a[i];
      for (let k = 0; k < 3; k++) {
        const up = (U.c[(y0 * U.w + x0) * 3 + k] * (1 - u) + U.c[(y0 * U.w + x1) * 3 + k] * u) * (1 - v) + (U.c[(y1 * U.w + x0) * 3 + k] * (1 - u) + U.c[(y1 * U.w + x1) * 3 + k] * u) * v;
        L.c[i * 3 + k] = L.c[i * 3 + k] * wa + up * (1 - wa);
      }
      L.a[i] = 1;
    }
  }
}
