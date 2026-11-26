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
const median3 = (arr) => { if (!arr.length) return null; const m = [0, 1, 2].map((k) => arr.map((c) => c[k]).sort((a, b) => a - b)[arr.length >> 1]); return m; };
const isTile = ([r, g, b]) => r > g * 1.1 && r > b * 1.25 && r - b > 32;   // fired clay: orange to salmon to brown-red

export async function loadDetail({ ROOT, proj, minX, minY, maxX, maxY, log, pointInRing, segDist, lidar }) {
  const dir = path.join(ROOT, 'data/detail');
  if (process.env.NO_DETAIL || !fs.existsSync(dir)) return null;
  const photos = [];
  for (const f of fs.readdirSync(dir).filter((f) => /_ortho.*\.tif$/.test(f)).sort()) {
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
  for (const f of fs.readdirSync(dir).filter((f) => /_ndsm50\.tif$/.test(f))) {
    const img = await (await fromFile(path.join(dir, f))).getImage(), [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution(), [r] = await img.readRasters();
    fines.push({ ox, oy, rx, ry, w: img.getWidth(), h: img.getHeight(), r }); log(`detail survey ${f} ${img.getWidth()}×${img.getHeight()}`);
  }
  const fine = (x, y) => {
    const [la, lo] = proj.inv(x, y);
    for (const F of fines) { const c = Math.floor((lo - F.ox) / F.rx), k = Math.floor((la - F.oy) / F.ry); if (c >= 0 && k >= 0 && c < F.w && k < F.h) return F.r[k * F.w + c] / 10; }
    return lidar ? lidar(x, y) : NaN;
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
  const shadowGrid = (ph = P) => {
    if (ph.shg) return ph.shg;
    const g = ph.shg = new Uint8Array(sw * shh);
    if (!ph.sun || !lidar) return g;
    const az = (ph.sun.az * Math.PI) / 180, tn = Math.tan((ph.sun.el * Math.PI) / 180), ux = Math.sin(az), uy = Math.cos(az);   // towards the sun
    for (let r = 0; r < shh; r++) for (let c = 0; c < sw; c++) {
      const x = minX + (c + 0.5) * S2, y = maxY - (r + 0.5) * S2; if (!rgb(x, y, ph)) continue;
      const z0 = fine(x, y); if (!(z0 < 1.5)) continue;
      for (let s = 1; s < 90; s += 1) { const z = fine(x + ux * s, y + uy * s); if (z > s * tn + Math.max(0, z0) + 0.3) { g[r * sw + c] = 1; break; } }
    }
    return g;
  };
  const shadowAt = (x, y, ph = P) => { const g = shadowGrid(ph), c = Math.floor((x - minX) / S2), r = Math.floor((maxY - y) / S2); return c >= 0 && r >= 0 && c < sw && r < shh ? g[r * sw + c] : 0; };
  // per channel: sunlit over shaded open ground, just either side of the shadow edges (same pavement, same lawn)
  const ratio = (ph = P) => {
    if (ph.ratio) return ph.ratio;
    const g = shadowGrid(ph), sun = [[], [], []], shd = [[], [], []];
    for (let r = 3; r < shh - 3; r++) for (let c = 3; c < sw - 3; c++) {
      const i = r * sw + c, x = minX + (c + 0.5) * S2, y = maxY - (r + 0.5) * S2;
      if (!(g[i] !== g[i + 2] || g[i] !== g[i - 2] || g[i] !== g[i + 2 * sw] || g[i] !== g[i - 2 * sw])) continue;
      if (!(fine(x, y) < 0.3)) continue;
      const q = rgb(x, y, ph); if (!q) continue; const a = g[i] ? shd : sun; for (let k = 0; k < 3; k++) a[k].push(q[k]);
    }
    const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1] || 1; };
    ph.ratio = [0, 1, 2].map((k) => clamp(med(sun[k]) / Math.max(8, med(shd[k])), 1, 5));
    log(`detail ${ph.name}: shadow lift ${ph.ratio.map((v) => v.toFixed(2)).join('/')} from ${sun[0].length}/${shd[0].length} edge samples`);
    return ph.ratio;
  };

  // façade band in one photo: the gap between the footprint and its leaned roof is the wall that faces the camera
  const facadeIn = (p, h, ph, [dx, dy]) => {
    if (Math.hypot(dx, dy) < 1.2) return null;   // seen from straight above: no wall in view
    const [x0, y0, x1, y1] = bbox(p.outer), fac = [];
    const X0 = Math.min(x0, x0 + dx), X1 = Math.max(x1, x1 + dx), Y0 = Math.min(y0, y0 + dy), Y1 = Math.max(y1, y1 + dy);
    for (let y = Y0; y < Y1; y += 0.5) for (let x = X0; x < X1; x += 0.5) {
      if (inside(p, x - dx, y - dy)) continue;                       // roof
      let wall = false; for (let t = 0.15; t < 0.85; t += 0.1) if (inside(p, x - dx * t, y - dy * t)) { wall = true; break; }
      if (!wall) continue;
      const c = rgb(x, y, ph); if (c) fac.push(c);
    }
    if (fac.length < 24) return null;
    // the brighter half: windows, balcony shade and the odd tree are darker than the render
    fac.sort((a, b) => L3(b) - L3(a)); const top = fac.slice(0, Math.max(12, fac.length >> 1));
    return { c: median3(top), n: fac.length };
  };

  // one building: roof colours and how much of the roof is tiled (best photo), and the façade from the photo that sees it lit
  const read = (p, h) => {
    if (!covers(p.c[0], p.c[1]) || !(h > 2)) return null;
    const sh0 = roofShift(p, h, P), [dx, dy] = sh0, [x0, y0, x1, y1] = bbox(p.outer), st = Math.max(0.5, Math.sqrt(Math.abs(p.area) / 4000));
    const tile = [], flat = [], all = [];
    for (let y = y0 + st / 2; y < y1; y += st) for (let x = x0 + st / 2; x < x1; x += st) {
      if (!inside(p, x, y) || segDist(x, y, p.outer) < 0.9) continue;
      const c = rgb(x + dx, y + dy); if (c) all.push(c);
    }
    if (all.length < 6) return null;
    const lm = all.map(L3).sort((a, b) => a - b), roofL = lm[Math.floor(lm.length * 0.7)], dark = lm[Math.floor(lm.length * 0.5)] * 0.62;
    for (const c of all) { if (L3(c) < dark) continue; (isTile(c) ? tile : flat).push(c); }
    const n = tile.length + flat.length;
    let wall = null, wallSrc = null;
    if (h > 6) {
      const cand = [];
      for (const ph of photos) {
        const s = ph === P ? sh0 : roofShift(p, h, ph), f = facadeIn(p, h, ph, s); if (!f) continue;
        // lit when the wall is about as bright as the roof beside it in the same photo; else lift it out of the shade
        const rl = ph === P ? roofL : (() => { const v = []; for (let y = y0 + st / 2; y < y1; y += st * 2) for (let x = x0 + st / 2; x < x1; x += st * 2) if (inside(p, x, y) && segDist(x, y, p.outer) > 0.9) { const q = rgb(x + s[0], y + s[1], ph); if (q) v.push(L3(q)); } v.sort((a, b) => a - b); return v[Math.floor(v.length * 0.7)] || 1; })();
        const lit = L3(f.c) / rl;
        cand.push({ ph, lit, f, s });
      }
      cand.sort((a, b) => b.lit - a.lit);
      // the most brightly lit view wins; a wall that still comes out dark is a wall in deep shade or behind trees, not a dark
      // render (Lisbon has very few): try the next view, and with none left keep the district palette
      for (const b of cand) {
        const w = b.lit > 0.62 ? tone(b.f.c, 1.08) : tone(b.f.c.map((v, k) => v * ratio(b.ph)[k]), 1.0);
        if (L3(w) < 110) continue;
        wall = w; wallSrc = { photo: b.ph.name, lit: +b.lit.toFixed(2), n: b.f.n }; break;
      }
    }
    return { shift: sh0, n, tileFrac: n ? tile.length / n : 0, tile: tile.length > 8 ? tone(median3(tile), 1.08) : null, flat: flat.length > 8 ? tone(median3(flat), 1.05) : null, wall, wallSrc };
  };

  // trees: canopy cells of the survey away from every building, thinned to one tree per crown
  const trees = ({ blockedAt }) => {
    const G = fines.length ? 1 : 1.5, cand = [], lidar_ = fine;
    for (let y = minY + G / 2; y < maxY; y += G) for (let x = minX + G / 2; x < maxX; x += G) {
      if (!covers(x, y)) continue;
      const z = lidar_(x, y); if (!(z > 2.6 && z < 26) || blockedAt(x, y)) continue;
      const c = rgb(x, y); if (!c) continue;
      const exg = 2 * c[1] - c[0] - c[2]; if (exg < -6 && (c[0] + c[1] + c[2] > 330 || z > 14)) continue;   // tall and not green: a mast, a lamp, a building edge   // bright, not green: a lamp post, a mast, a canopy
      // local maximum in a 3 m window
      let top = true; for (const [a, b] of [[G, 0], [-G, 0], [0, G], [0, -G], [G, G], [-G, G], [G, -G], [-G, -G]]) if (lidar_(x + a, y + b) > z) { top = false; break; }
      if (top) cand.push([x, y, z, c]);
    }
    cand.sort((a, b) => b[2] - a[2]);
    const out = [], cell = new Map(), key = (x, y) => `${Math.floor(x / 8)},${Math.floor(y / 8)}`;
    for (const [x, y, z, c] of cand) {
      const r = clamp(z * 0.3, 2.2, 6);   // crowns of Lisbon's broadleaves and pines are about a third as wide as tall
      let ok = true;
      for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) for (const q of cell.get(`${Math.floor(x / 8) + a},${Math.floor(y / 8) + b}`) || []) if (Math.hypot(q[0] - x, q[1] - y) < Math.max(r, q[3]) * 0.9) { ok = false; break; }
      if (!ok) continue;
      const t = [x, y, z, r, c]; out.push(t); const k = key(x, y); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(t);
    }
    return out;
  };

  // ground: the photo itself, with every building lifted out (filled from the ground around it) and cast shadows lightened
  const ground = ({ ground1, GW, GH, buildings, Raster }) => {
    const mpp = (maxX - minX) / GW, N = GW * GH;
    const cov = new Uint8Array(N), out = new Float32Array(N * 3), mask = new Uint8Array(N);
    // buildings, their leaned roofs and the façades between: one swept polygon per building, 1 m wider
    const R = new Raster(minX, minY, maxX, maxY, mpp);
    for (const b of buildings) {
      const [dx, dy] = b.shift || roofShift({ outer: b.outer }, b.h, P);
      for (let t = 0; t <= 1.0001; t += 0.125) R.fillRings([b.outer.map(([x, y]) => [x + dx * t, y + dy * t])], (i) => { mask[i] = 1; });
    }
    { // dilate by 1 m (2 px): roof edges and eaves bleed in the photo
      const m2 = mask.slice(); for (let r = 2; r < GH - 2; r++) for (let c = 2; c < GW - 2; c++) { const i = r * GW + c; if (mask[i]) continue; for (const o of [-2, 2, -2 * GW, 2 * GW, -1 - GW, 1 + GW]) if (mask[i + o]) { m2[i] = 1; break; } } mask.set(m2);
    }
    const sh = new Float32Array(N);
    for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) sh[r * GW + c] = shadowAt(minX + (c + 0.5) * mpp, maxY - (r + 0.5) * mpp);
    // photo into the grid
    for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) {
      const i = r * GW + c, x = minX + (c + 0.5) * mpp, y = maxY - (r + 0.5) * mpp, q = rgb(x, y);
      if (!q) continue; cov[i] = 1; out[i * 3] = q[0]; out[i * 3 + 1] = q[1]; out[i * 3 + 2] = q[2];
    }
    if (P.sun) {
      const ratio_ = ratio();
      // the 2 m shadow grid only says where to look: widen it 2 m, then the photo's own darkness decides, pixel by pixel
      const soft = boxBlur1(sh, GW, GH, Math.round(2 / mpp));
      for (let i = 0; i < N; i++) if (cov[i] && soft[i] > 0.01) {
        const l = out[i * 3] * 0.3 + out[i * 3 + 1] * 0.55 + out[i * 3 + 2] * 0.15, w = Math.min(1, soft[i] * 3) * clamp((100 - l) / 40, 0, 1);
        for (let k = 0; k < 3; k++) out[i * 3 + k] *= 1 + (ratio_[k] - 1) * w * 0.92;
      }
    }
    // fill under buildings: push-pull (average of the valid ground at coarser and coarser levels, pulled back down)
    pushPull(out, cov, mask, GW, GH);
    // into the painted ground, feathered 25 m at the edge of the photo
    const edgeD = distToZero(cov, GW, GH, Math.ceil(25 / mpp));
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (!cov[i]) continue;
      const f = clamp(edgeD[i] / (25 / mpp), 0, 1), t = tone([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]], 1.12);
      for (let k = 0; k < 3; k++) ground1[i * 3 + k] = ground1[i * 3 + k] * (1 - f) + t[k] * f;
      n++;
    }
    log(`detail ground: ${(n * mpp * mpp / 1e6).toFixed(2)} km² from the photo`);
    return { cov, edgeD, mpp };
  };

  return { photos, covers, read, trees, ground, tone, rgb, shadowAt, fine };
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
