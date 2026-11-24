// Hand-authored layer: places studied against 3D imagery and modelled on purpose rather than by rule.
// Pilot: Praça do Comércio, Arco da Rua Augusta, D. José I, and the Pombaline blocks of Rua Augusta.
// Imagery was used only as visual reference; all geometry here is our own.
import earcut from 'earcut';
import ClipperLib from 'clipper-lib';
import { KIND, box, wallQuad, triUp, tri as triRaw, polyArea, pip, obb } from './buildings.mjs';

// triangle with winding made to agree with the given normal (hand-built meshes stay front-facing)
function tri(S, a, b, c, n, ...rest) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const g = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] < 0) { const [sa, sb, sc, ...r2] = rest.slice(1); return triRaw(S, a, c, b, n, rest[0], sa, sc, sb, ...r2); }
  return triRaw(S, a, b, c, n, ...rest);
}

// ─── authored data ──────────────────────────────────────────────────────
// Baixa Pombalina pilot: blocks between Rua Áurea and Rua da Prata, Rua do Comércio to Rossio.
export const BAIXA_ZONE = [[38.70868, -9.13778], [38.71328, -9.13948], [38.71330, -9.13788], [38.70866, -9.13603]];

// Praça do Comércio wings: ochre arcaded ranges, two floors over the arcade, dormered roof.
const PRACA_WINGS = ['r1388351_0', 'w96313048', 'r3282309_0', 'r275363_0', 'r1388355_0', 'r1388352_0', 'w96315896', 'w249076538', 'w96315931', 'w96315948'];
const PRACA_OCHRE = '#d9b662', PRACA_ROOF = '#a8654f';
export const OVERRIDES = {
  ...Object.fromEntries(PRACA_WINGS.map((id) => [id, {
    variant: 6, wall: PRACA_OCHRE, roofCol: PRACA_ROOF, shape: 'mansard', h: 21.5, roofH: 5, floorH: 4.2, groundH: 7.6, bayW: 5.3,
    balconyFloors: [1], balconyChance: 1, stone: false, parapet: 0,
  }])),
  // torreões: the two riverside pavilions, a storey taller, under grey lead pavilion roofs
  ...Object.fromEntries(['w96313047', 'w96315907'].map((id) => [id, {
    variant: 6, wall: PRACA_OCHRE, roofCol: '#8e9396', shape: 'pyramidal', h: 33, roofH: 8.5, pitch: 58, floorH: 4.3, groundH: 7.6, bayW: 5.3,
    balconyFloors: [1, 2], balconyChance: 1, stone: false, parapet: 0, lantern: true,
  }])),
  w96315909: { wall: '#efe7d6' },
};
// drawn by hand below (or folded into the arcade shader)
export const DROP = new Set(['w41683195', 'w663318739']);
export const dropTag = (t) => t['building:part'] === 'pillar' || t.building === 'pillar';

// Pombaline façade palette, read off the reference by eye: mostly pale, a few warm ochres and pinks.
export const BAIXA_WALLS = [['#f0ebe0', 26], ['#ede1c3', 14], ['#e7cf8f', 12], ['#e8c3ad', 9], ['#dfc9c2', 5], ['#d3dbdc', 6], ['#f2dcb0', 9], ['#d9b48c', 4], ['#c8cfc1', 3]];
export const BAIXA_ROOFS = [['#ad6650', 5], ['#a05d4a', 4], ['#b8765c', 3], ['#94574a', 2], ['#b88a74', 1]];

// ─── helpers ────────────────────────────────────────────────────────────
const SCALE = 100;
const toC = (r) => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromC = (r) => r.map((p) => [p.X / SCALE, p.Y / SCALE]);
function dedupe(r, eps = 0.25) {
  const out = [];
  for (const p of r) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > eps) out.push(p);
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  // drop collinear points
  for (let i = 0; i < out.length && out.length > 3;) {
    const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    if (Math.abs(cr) / L < 0.12) out.splice(i, 1); else i++;
  }
  return out;
}

// Merge touching footprints into street blocks: grow 0.45 m, union, shrink back.
export function mergeBlocks(polys) {
  const co = new ClipperLib.ClipperOffset(2, 25);
  for (const p of polys) co.AddPath(toC(p.outer), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const grown = new ClipperLib.Paths(); co.Execute(grown, 45);
  const c = new ClipperLib.Clipper(); c.AddPaths(grown, ClipperLib.PolyType.ptSubject, true);
  const uni = new ClipperLib.Paths(); c.Execute(ClipperLib.ClipType.ctUnion, uni, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const co2 = new ClipperLib.ClipperOffset(2, 25); co2.AddPaths(uni, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree(); co2.Execute(tree, -45);
  const blocks = [];
  const walk = (node) => {
    for (const ch of node.Childs()) {
      if (!ch.IsHole()) {
        let outer = dedupe(fromC(ClipperLib.Clipper.CleanPolygon(ch.Contour(), 30)));
        if (outer.length < 3) continue;
        if (polyArea(outer) < 0) outer.reverse();
        const holes = [];
        for (const h of ch.Childs()) {
          let r = dedupe(fromC(ClipperLib.Clipper.CleanPolygon(h.Contour(), 30)));
          if (r.length >= 3 && Math.abs(polyArea(r)) > 30) { if (polyArea(r) > 0) r.reverse(); holes.push(r); }
          walk(h);
        }
        blocks.push({ outer, holes });
      }
    }
  };
  walk(tree);
  return blocks;
}

// Distance from (x,y) to segment a-b, and the parameter along it.
const segDist = (x, y, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
  return [Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t), t];
};

// Mansard profile over a straight skeleton: steep 70° attic band with dormers, then a 24° slope, capped flat.
export function mansardProfile(d1 = 1.25, s1 = 2.6, s2 = 0.45, cap = 5.6) {
  const z1 = d1 * s1, dCap = d1 + (cap - z1) / s2;
  return { d1, s1, s2, cap, dCap, z: (d) => (d <= d1 ? d * s1 : Math.min(cap, z1 + (d - d1) * s2)) };
}

// Clip a 3D polygon (x,y,d) to d-range [lo, hi].
function clipD(poly, lo, hi) {
  const clip = (P, f) => {
    const out = [];
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length], fp = f(p), fq = f(q);
      if (fp <= 0) out.push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]); }
    }
    return out;
  };
  let P = clip(poly, (v) => lo - v[2]);
  if (P.length >= 3) P = clip(P, (v) => v[2] - hi);
  return P;
}

// Plane d = a·x + b·y + c through a planar 3D polygon (largest-area vertex triple).
function planeOf(P) {
  let best = null, ba = 0;
  for (let i = 1; i + 1 < P.length; i++) {
    const a = P[0], b = P[i], c = P[i + 1];
    const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (ar > ba) { ba = ar; best = [a, b, c]; }
  }
  const [a, b, c] = best, det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const A = ((b[2] - a[2]) * (c[1] - a[1]) - (c[2] - a[2]) * (b[1] - a[1])) / det;
  const B = ((c[2] - a[2]) * (b[0] - a[0]) - (b[2] - a[2]) * (c[0] - a[0])) / det;
  return [A, B, a[2] - A * a[0] - B * a[1]];
}

// Roof over a straight skeleton with a piecewise profile. Faces split into attic band / slope / cap.
export function profileRoof(S, sk, ctx, prof) {
  const { wallTop, seed, colRoof, ground, bayW = 2.8, variant = 0 } = ctx;
  const info = [Math.min(1, (wallTop - ground) / 128), 0, 0, 0];
  const ox = ctx.cx || 0, oy = ctx.cy || 0;
  const bands = [[0, prof.d1, KIND.MANSARD], [prof.d1, prof.dCap, KIND.TILES], [prof.dCap, 1e9, KIND.FLAT]];
  for (const poly of sk.polygons) {
    const V = poly.map((k) => sk.vertices[k]);
    let ex = 1, ey = 0;
    for (let i = 0; i < V.length; i++) { const a = V[i], b = V[(i + 1) % V.length]; if (a[2] < 1e-4 && b[2] < 1e-4) { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; ex = (b[0] - a[0]) / L; ey = (b[1] - a[1]) / L; break; } }
    for (const [lo, hi, kind] of bands) {
      const P = clipD(V, lo, hi);
      if (P.length < 3 || Math.abs(polyArea(P)) < 0.01) continue;
      const style = [kind / 8, variant / 8, seed, bayW / 6];
      const sf = (v) => kind === KIND.FLAT ? [v[0] - ox, v[1] - oy]
        : kind === KIND.MANSARD ? [ex * (v[0] - ox) + ey * (v[1] - oy), prof.z(v[2])]
        : [ex * (v[0] - ox) + ey * (v[1] - oy), (v[2] - prof.d1) * Math.sqrt(1 + prof.s2 * prof.s2)];
      const emit = (rings, base) => {           // rings: [outer, ...holes] with z=d on every vertex
        const flat = [], holes = [], pts = [];
        rings.forEach((r, i) => { if (i) holes.push(pts.length); for (const v of r) { pts.push(v); flat.push(v[0], v[1]); } });
        const idx = earcut(flat, holes);
        const col = kind === KIND.FLAT ? base.map((c) => c * 0.82) : base;
        for (let k = 0; k < idx.length; k += 3) {
          const W = [pts[idx[k]], pts[idx[k + 1]], pts[idx[k + 2]]];
          triUp(S, ...W.map((v) => [v[0], wallTop + prof.z(v[2]), -v[1]]), col, ...W.map(sf), info, style);
        }
      };
      if (!ctx.parts) { emit([P], colRoof); continue; }
      // per-building tiles: split the face by the member footprints (d is planar over the face)
      const pl = planeOf(P);
      const dAt = (x, y) => pl[0] * x + pl[1] * y + pl[2];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const v of P) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
      const subj = [toC(P)];
      const run = (clipPaths, type, col) => {
        const c = new ClipperLib.Clipper(); c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true); c.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
        const tree = new ClipperLib.PolyTree(); c.Execute(type, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
        const walk = (node) => { for (const ch of node.Childs()) { if (ch.IsHole()) { walk(ch); continue; }
          const rings = [ch.Contour(), ...ch.Childs().map((h) => h.Contour())].map((r) => fromC(r).map(([x, y]) => [x, y, dAt(x, y)]));
          if (rings[0].length >= 3 && Math.abs(polyArea(rings[0])) > 0.02) emit(rings, col);
          for (const h of ch.Childs()) walk(h); } };
        walk(tree);
      };
      for (const m of ctx.parts) {
        if (m.bb[0] > x1 || m.bb[2] < x0 || m.bb[1] > y1 || m.bb[3] < y0) continue;
        run([m.path], ClipperLib.ClipType.ctIntersection, m.col);
      }
      run(ctx.partsUnion, ClipperLib.ClipType.ctDifference, colRoof);
    }
  }
}

// ─── Pombaline blocks ───────────────────────────────────────────────────
// One continuous dormered roof per street block (ridges follow the streets, hips at the corners),
// façades coloured building by building, and the fire walls that rise through the roof between them.
export function pombalineBlocks(blds, env) {
  const { SkeletonBuilder, groundAt, getSink, lin, srgb, jitter, pick, pal, hash, stats } = env;
  const walls = pal(BAIXA_WALLS), roofs = pal(BAIXA_ROOFS);
  const blocks = mergeBlocks(blds);
  const prof = mansardProfile();
  for (const [bi, B] of blocks.entries()) {
    const members = blds.filter((p) => pip(p.c[0], p.c[1], B.outer) && !B.holes.some((h) => pip(p.c[0], p.c[1], h)));
    if (!members.length) continue;
    const ob = obb(B.outer);
    const cx = ob.cx, cy = ob.cy;
    let gsum = 0, gn = 0, gmin = Infinity;
    for (const [x, y] of B.outer) { const g = groundAt(x, y); gsum += g; gn++; gmin = Math.min(gmin, g); }
    const ground = gsum / gn;
    // storeys: Pombaline norm is shop + 3 floors + attic; respect taller mapped blocks
    const lv = members.map((p) => parseFloat(p.tags['building:levels'])).filter(isFinite).sort((a, b) => a - b);
    const floors = Math.max(4, Math.min(6, lv.length ? Math.round(lv[lv.length >> 1]) : 4));
    const groundH = 4.3, floorH = 3.3;
    const wallTop = ground + groundH + (floors - 1) * floorH + 0.7;
    const S = getSink(cx, cy);
    const seedB = hash('blk' + bi);
    const roofCol = lin(jitter(pick(roofs, seedB), hash('rj' + bi), 8));
    // façade segments: split block edges where member buildings change
    const owner = (x, y) => {
      let best = null, bd = 1.6;
      for (const p of members) for (const r of [p.outer]) for (let i = 0; i < r.length; i++) {
        const [d] = segDist(x, y, r[i], r[(i + 1) % r.length]); if (d < bd) { bd = d; best = p; }
      }
      return best;
    };
    const rings = [B.outer, ...B.holes];
    rings.forEach((r, ri) => {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.3) continue;
        const ts = [0, 1];
        for (const p of members) for (const v of p.outer) { const [d, t] = segDist(v[0], v[1], a, b); if (d < 1.0 && t > 0.02 && t < 0.98) ts.push(t); }
        ts.sort((x, y) => x - y);
        const cuts = ts.filter((t, k) => k === 0 || t - ts[k - 1] > 1.2 / L || t === 1);
        for (let k = 0; k + 1 < cuts.length; k++) {
          const t0 = cuts[k], t1 = cuts[k + 1], l = (t1 - t0) * L; if (l < 0.05) continue;
          const p = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], q = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
          const m = owner((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
          const id = m ? m.id : 'blk' + bi + '_' + i;
          const back = ri > 0;
          const col = back ? lin(srgb('#e9e4d9')) : lin(jitter(pick(walls, hash(id + 'w')), hash(id + 'j'), 5));
          const bw = 2.6 + hash(id + 'bw') * 0.6;
          const bays = l >= 1.8 ? Math.max(1, Math.round(l / bw)) : 0;
          const variant = back ? 1 : hash(id + 'az') < 0.07 ? 2 : 0;
          const info = [Math.min(1, (wallTop - ground) / 128), floorH / 8, Math.min(1, bays / 128), groundH / 8];
          const style = [(bays ? KIND.FACADE : KIND.BLANK) / 8, variant / 8, hash(id + 'seed'), (l / Math.max(1, bays)) / 6];
          wallQuad(S, p, q, gmin - 1.5, gmin - 1.5, wallTop, wallTop, col, 0, bays, ground, info, style);
          // balconies on the first floor (and often the second) of street façades
          if (!back && bays) {
            const ox = (q[1] - p[1]) / l, oy = -(q[0] - p[0]) / l;
            for (const fl of [1, ...(hash(id + 'b2') < 0.5 ? [2] : [])]) {
              const z = ground + groundH + (fl - 1) * floorH;
              for (let kk = 0; kk < bays; kk++) {
                const t = (kk + 0.5) / bays;
                env.balconies(cx, cy).push([p[0] + (q[0] - p[0]) * t + ox * 0.02, z, -(p[1] + (q[1] - p[1]) * t + oy * 0.02), Math.atan2(ox, -oy), Math.min((l / bays) * 0.6, 1.6)]);
              }
            }
          }
        }
      }
    });
    // eave cornice: thin white band projecting 0.35 m all round the block
    const trim = lin(srgb('#f1ede4'));
    for (const r of rings) for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.3) continue;
      const ox = (b[1] - a[1]) / L * 0.35, oy = -(b[0] - a[0]) / L * 0.35;
      const A = [a[0] + ox, a[1] + oy], Bq = [b[0] + ox, b[1] + oy];
      wallQuad(S, A, Bq, wallTop - 0.35, wallTop - 0.35, wallTop + 0.02, wallTop + 0.02, trim, 0, 1, ground, [0, 0, 0, 0], [KIND.PLAIN / 8, 0, 0, 0.5]);
      triUp(S, [a[0], wallTop + 0.02, -a[1]], [b[0], wallTop + 0.02, -b[1]], [Bq[0], wallTop + 0.02, -Bq[1]], trim, [0, 0], [0, 0], [0, 0], [0, 0, 0, 0], [KIND.PLAIN / 8, 0, 0, 0.5]);
      triUp(S, [a[0], wallTop + 0.02, -a[1]], [Bq[0], wallTop + 0.02, -Bq[1]], [A[0], wallTop + 0.02, -A[1]], trim, [0, 0], [0, 0], [0, 0], [0, 0, 0, 0], [KIND.PLAIN / 8, 0, 0, 0.5]);
    }
    // roof
    let sk = null;
    try { sk = SkeletonBuilder.buildFromPolygon([[...B.outer, B.outer[0]], ...B.holes.map((h) => [...h, h[0]])]); } catch { sk = null; }
    const parts = members.map((p) => {
      const xs = p.outer.map((v) => v[0]), ys = p.outer.map((v) => v[1]);
      return { path: toC(p.outer), bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], col: lin(jitter(pick(roofs, hash(p.id + 'r')), hash(p.id + 'rj'), 9)) };
    });
    const ctx = { wallTop, seed: seedB, colRoof: roofCol, ground, cx, cy, bayW: 2.9, variant: 0, parts, partsUnion: parts.map((m) => m.path) };
    if (sk && sk.polygons.length) profileRoof(S, sk, ctx, prof);
    else { stats.skeletonFail++; continue; }
    // distance-to-eave → roof height, for fire walls and chimneys
    const dEdge = (x, y) => { let d = Infinity; for (const r of rings) for (let i = 0; i < r.length; i++) d = Math.min(d, segDist(x, y, r[i], r[(i + 1) % r.length])[0]); return d; };
    const roofZ = (x, y) => wallTop + prof.z(dEdge(x, y));
    // fire walls (paredes corta-fogo): party edges between members rise ~0.6 m through the roof
    const fw = lin(srgb('#cbbfae')), fwStyle = [KIND.PLAIN / 8, 0, 0, 0.5], I0 = [0, 0, 0, 0];
    const seen = new Set();
    for (const p of members) for (let i = 0; i < p.outer.length; i++) {
      const a = p.outer[i], b = p.outer[(i + 1) % p.outer.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 2) continue;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (dEdge(mx, my) < 1.2) continue;                     // on the street: that's a façade
      const key = [Math.round(mx), Math.round(my)].join(','); if (seen.has(key)) continue; seen.add(key);
      const n = Math.max(1, Math.ceil(L / 1.5)), dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L, nx = -dy * 0.16, ny = dx * 0.16;
      for (let k = 0; k < n; k++) {
        const s0 = (k / n) * L, s1 = ((k + 1) / n) * L;
        const P0 = [a[0] + dx * s0, a[1] + dy * s0], P1 = [a[0] + dx * s1, a[1] + dy * s1];
        const z0 = roofZ(P0[0], P0[1]) + 0.4, z1 = roofZ(P1[0], P1[1]) + 0.4, zb = wallTop - 0.2;
        const q = [[P0[0] + nx, P0[1] + ny], [P1[0] + nx, P1[1] + ny], [P1[0] - nx, P1[1] - ny], [P0[0] - nx, P0[1] - ny]];
        wallQuad(S, q[3], q[2], zb, zb, z0, z1, fw, 0, 1, ground, I0, fwStyle);
        wallQuad(S, q[1], q[0], zb, zb, z1, z0, fw, 0, 1, ground, I0, fwStyle);
        triUp(S, [q[0][0], z0 + 0.02, -q[0][1]], [q[1][0], z1 + 0.02, -q[1][1]], [q[2][0], z1 + 0.02, -q[2][1]], fw, [0, 0], [0, 0], [0, 0], I0, fwStyle);
        triUp(S, [q[0][0], z0 + 0.02, -q[0][1]], [q[2][0], z1 + 0.02, -q[2][1]], [q[3][0], z0 + 0.02, -q[3][1]], fw, [0, 0], [0, 0], [0, 0], I0, fwStyle);
      }
      stats.fireWalls = (stats.fireWalls || 0) + 1;
    }
    // chimney stacks: a couple per building, along the ridge zone
    for (const p of members) {
      const area = Math.abs(p.area); if (area < 60) continue;
      for (let c = 0; c < (area > 250 ? 2 : 1); c++) {
        const u = hash(p.id + 'cu' + c), v = hash(p.id + 'cv' + c);
        const po = obb(p.outer); if (!po) continue;
        const x = po.cx + po.ux * (u - 0.5) * po.hl * 1.2 + po.vx * (v - 0.5) * po.hw * 0.8, y = po.cy + po.uy * (u - 0.5) * po.hl * 1.2 + po.vy * (v - 0.5) * po.hw * 0.8;
        if (!pip(x, y, p.outer) || dEdge(x, y) < 3) continue;
        const z = roofZ(x, y);
        box(S, x, y, po.ux, po.uy, 0.4, 0.3, z - 0.8, z + 1.3, fw, I0, fwStyle);
        box(S, x, y, po.ux, po.uy, 0.5, 0.4, z + 1.3, z + 1.45, roofCol, I0, fwStyle);
      }
    }
    stats.blocks = (stats.blocks || 0) + 1;
    stats.blockMembers = (stats.blockMembers || 0) + members.length;
  }
}

// ─── hand-modelled landmarks ────────────────────────────────────────────
// Oriented cylinder/prism between two 3D points (y up). Used for columns, limbs, bodies.
export function limb(S, p0, p1, r0, r1, sides, col, style, caps = true) {
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], L = Math.hypot(...d) || 1, w = d.map((v) => v / L);
  const ref = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [w[1] * ref[2] - w[2] * ref[1], w[2] * ref[0] - w[0] * ref[2], w[0] * ref[1] - w[1] * ref[0]];
  const ul = Math.hypot(...u); u = u.map((v) => v / ul);
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const ring = (c, r) => Array.from({ length: sides }, (_, k) => { const a = (k / sides) * Math.PI * 2, ca = Math.cos(a) * r, sa = Math.sin(a) * r; return [c[0] + u[0] * ca + v[0] * sa, c[1] + u[1] * ca + v[1] * sa, c[2] + u[2] * ca + v[2] * sa]; });
  const A = ring(p0, r0), B = ring(p1, r1), I = [0, 0, 0, 0];
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides, a = (k + 0.5) / sides * Math.PI * 2;
    const n = [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
    tri(S, A[k], A[k2], B[k2], n, col, [k, 0], [k + 1, 0], [k + 1, L], I, style);
    tri(S, A[k], B[k2], B[k], n, col, [k, 0], [k + 1, L], [k, L], I, style);
  }
  if (caps) for (let k = 1; k + 1 < sides; k++) {
    tri(S, B[0], B[k], B[k + 1], w, col, [0, 0], [0, 0], [0, 0], I, style);
    tri(S, A[0], A[k + 1], A[k], w.map((x) => -x), col, [0, 0], [0, 0], [0, 0], I, style);
  }
}

// Local frame helper: (u along façade, v outwards, z up) → world.
const frame = (cx, cy, ux, uy, z0) => (u, v, z) => [cx + ux * u - uy * v, z0 + z, -(cy + uy * u + ux * v)];

// Arco da Rua Augusta (1875): lioz triumphal arch, six columns a side, statues on the cornice,
// an attic with the royal arms, and Calmels' group of Glory crowning Valour and Genius on top.
export function arcoRuaAugusta(S, { cx, cy, ux, uy, ground, lin, srgb }) {
  const F = frame(cx, cy, ux, uy, ground);
  const stone = lin(srgb('#ebe4d3')), shade = lin(srgb('#d7cfbd')), dark = lin(srgb('#5d5a54'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.37, 0.9], I0 = [0, 0, 0, 0];
  const W = 12.5, D = 6.2;               // half-width, half-depth of the body
  const R = 5.6, spring = 12.2;          // arch radius and springing height
  const top = 21.5;
  const quad = (a, b, c, d, n, col) => { tri(S, F(...a), F(...b), F(...c), n, col, [a[0], a[2]], [b[0], b[2]], [c[0], c[2]], I0, ST); tri(S, F(...a), F(...c), F(...d), n, col, [a[0], a[2]], [c[0], c[2]], [d[0], d[2]], I0, ST); };
  const N = (u, v, z) => { const w = F(u, v, z), o = F(0, 0, 0); return [w[0] - o[0], w[1] - o[1], w[2] - o[2]]; };
  const nF = N(0, 1, 0), nB = N(0, -1, 0), nL = N(-1, 0, 0), nR = N(1, 0, 0);
  // front & back faces with the arch cut out (piers + spandrels), via earcut on the face outline
  const seg = 14, arch = [];
  for (let k = 0; k <= seg; k++) { const a = Math.PI - (k / seg) * Math.PI; arch.push([R * Math.cos(a), spring + R * Math.sin(a)]); }
  const outline = [[-W, -1.5], [-R, -1.5], ...arch, [R, -1.5], [W, -1.5], [W, top], [-W, top]];
  const idx = earcut(outline.flat());
  for (const [v, n, flip] of [[D, nF, false], [-D, nB, true]]) for (let k = 0; k < idx.length; k += 3) {
    const t = [outline[idx[k]], outline[idx[k + 1]], outline[idx[k + 2]]].map(([u, z]) => [u, v, z]);
    if (flip) tri(S, F(...t[0]), F(...t[2]), F(...t[1]), n, stone, [t[0][0], t[0][2]], [t[2][0], t[2][2]], [t[1][0], t[1][2]], I0, ST);
    else tri(S, F(...t[0]), F(...t[1]), F(...t[2]), n, stone, [t[0][0], t[0][2]], [t[1][0], t[1][2]], [t[2][0], t[2][2]], I0, ST);
  }
  // sides
  quad([-W, -D, -1.5], [-W, D, -1.5], [-W, D, top], [-W, -D, top], nL, stone);
  quad([W, D, -1.5], [W, -D, -1.5], [W, -D, top], [W, D, top], nR, stone);
  // passage: jambs and barrel vault (inner faces, darker)
  quad([-R, D, -1.5], [-R, -D, -1.5], [-R, -D, spring], [-R, D, spring], nR, shade);
  quad([R, -D, -1.5], [R, D, -1.5], [R, D, spring], [R, -D, spring], nL, shade);
  for (let k = 0; k < seg; k++) {
    const a = arch[k], b = arch[k + 1], m = Math.PI - ((k + 0.5) / seg) * Math.PI;
    quad([a[0], -D, a[1]], [b[0], -D, b[1]], [b[0], D, b[1]], [a[0], D, a[1]], N(-Math.cos(m), 0, -Math.sin(m)), shade);
  }
  // keystone & impost bands
  box(S, ...[F(0, D + 0.25, 0)].map((p) => [p[0], -p[2]])[0], ux, uy, 0.7, 0.3, ground + spring + R - 0.6, ground + spring + R + 0.9, stone, I0, ST);
  for (const s of [-1, 1]) for (const v of [D + 0.1, -D - 0.1]) { const p = F(s * (R + 0.8), v, 0); box(S, p[0], -p[2], ux, uy, 0.9, 0.18, ground + spring - 0.5, ground + spring, stone, I0, ST); }
  // columns: three a side on each face, on tall pedestals, with entablature above
  for (const v of [D + 0.9, -D - 0.9]) {
    for (const s of [-1, 1]) for (const u of [6.6, 8.6, 10.9]) {
      const p = F(s * u, v, 0), x = p[0], y = -p[2];
      box(S, x, y, ux, uy, 0.95, 0.95, ground - 0.5, ground + 3.2, stone, I0, ST);
      limb(S, [x, ground + 3.2, -y], [x, ground + 14.6, -y], 0.62, 0.56, 12, stone, ST);
      box(S, x, y, ux, uy, 0.85, 0.85, ground + 14.6, ground + 15.5, stone, I0, ST);
    }
    const sgn = v > 0 ? 1 : -1;
    const e = F(0, v - sgn * 0.15, 0);
    box(S, e[0], -e[2], ux, uy, W + 0.4, 1.15, ground + 15.5, ground + 17.2, stone, I0, ST);
    box(S, e[0], -e[2], ux, uy, W + 0.7, 1.45, ground + 17.2, ground + 17.8, shade, I0, ST);
  }
  // crowning cornice of the body
  box(S, cx, cy, ux, uy, W + 0.6, D + 2.4, ground + top - 0.6, ground + top + 0.2, shade, I0, ST);
  // attic with the royal arms (front) and clock (back)
  box(S, cx, cy, ux, uy, 7.6, D - 0.6, ground + top + 0.2, ground + top + 6.2, stone, I0, ST);
  box(S, cx, cy, ux, uy, 8.0, D - 0.2, ground + top + 6.2, ground + top + 6.8, shade, I0, ST);
  box(S, cx, cy, ux, uy, 5.4, D - 2.0, ground + top + 6.8, ground + top + 7.6, stone, I0, ST);
  { const a = F(0, D - 0.45, 0); box(S, a[0], -a[2], ux, uy, 2.2, 0.25, ground + top + 1.2, ground + top + 5.4, shade, I0, ST); }
  { const c = F(0, -D + 0.45, 0); limb(S, [c[0], ground + top + 3.2, c[2]], F(0, -D + 0.15, top + 3.2), 1.25, 1.25, 16, dark, ST); }
  // statues on the cornice above the paired columns (Viriato, Nuno Álvares, Pombal, Vasco da Gama)
  const person = (u, v, z, sc, col, seated = false) => {
    const b = F(u, v, z);
    limb(S, [b[0], b[1], b[2]], [b[0], b[1] + (seated ? 0.9 : 1.6) * sc, b[2]], 0.42 * sc, 0.34 * sc, 8, col, ST);
    limb(S, [b[0], b[1] + (seated ? 0.9 : 1.6) * sc, b[2]], [b[0], b[1] + (seated ? 1.7 : 2.35) * sc, b[2]], 0.34 * sc, 0.28 * sc, 8, col, ST);
    limb(S, [b[0], b[1] + (seated ? 1.7 : 2.35) * sc, b[2]], [b[0], b[1] + (seated ? 2.05 : 2.72) * sc, b[2]], 0.16 * sc, 0.15 * sc, 6, col, ST);
  };
  for (const s of [-1, 1]) for (const u of [7.6, 10.2]) { person(s * u, D + 1.4, top + 0.2, 1.35, stone); person(s * u, -D - 1.4, top + 0.2, 1.2, stone); }
  // reclining river figures (Tejo and Douro) at the attic corners
  for (const s of [-1, 1]) { const a = F(s * 6.2, D - 0.6, top + 0.9), b = F(s * 4.2, D - 0.6, top + 1.6); limb(S, a, b, 0.55, 0.45, 8, stone, ST); }
  // Glory crowning Valour and Genius
  const t0 = top + 7.6;
  person(0, 0, t0, 1.9, stone);
  { const h = F(0, 0, t0 + 5.2); for (const s of [-1, 1]) limb(S, h, F(s * 1.6, 0.3, t0 + 4.6), 0.18, 0.14, 6, stone, ST); }      // raised arms with wreaths
  for (const s of [-1, 1]) person(s * 2.6, 0.4, t0, 1.5, stone, true);
  for (const s of [-1, 1]) { const w0 = F(s * 0.3, -0.5, t0 + 3.6), w1 = F(s * 1.5, -0.9, t0 + 5.4); limb(S, w0, w1, 0.4, 0.08, 4, stone, ST); } // wings
  return 1;
}

// Equestrian statue of D. José I (Machado de Castro, 1775): bronze king on horseback
// trampling serpents, on a tall lioz pedestal flanked by sculpture groups, on an oval stepped base.
export function equestrianJose(S, { cx, cy, ground, heading, lin, srgb }) {
  const bronze = lin(srgb('#4e5a4b')), bronzeHi = lin(srgb('#66735f')), stone = lin(srgb('#e6dfcf')), shade = lin(srgb('#cfc6b2'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.61, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.61, 1], I0 = [0, 0, 0, 0];
  const fx = Math.sin(heading), fy = Math.cos(heading);   // facing direction (heading 180° = south)
  const F = frame(cx, cy, fy, -fx, ground);               // u = statue's right, v = forward
  // oval stepped platform: four steps
  const steps = [[12.5, 9.5, 0.35], [11.6, 8.7, 0.7], [10.7, 7.9, 1.05], [9.8, 7.1, 1.4]];
  let z = -0.6;
  for (const [ra, rb, zt] of steps) {
    const n = 28, ring = Array.from({ length: n }, (_, k) => { const a = (k / n) * Math.PI * 2; return [Math.cos(a) * ra, Math.sin(a) * rb]; });
    for (let k = 0; k < n; k++) { const a = ring[k], b = ring[(k + 1) % n]; const pa = F(a[0], a[1], 0), pb = F(b[0], b[1], 0); wallQuad(S, [pa[0], -pa[2]], [pb[0], -pb[2]], ground + z, ground + z, ground + zt, ground + zt, stone, 0, 1, ground, I0, ST); }
    const flat = ring.flat(), idx = earcut(flat);
    for (let k = 0; k < idx.length; k += 3) triUp(S, ...[idx[k], idx[k + 1], idx[k + 2]].map((q) => F(ring[q][0], ring[q][1], zt)), stone, [0, 0], [0, 0], [0, 0], I0, ST);
    z = zt - 0.05;
  }
  // pedestal: plinth, die, cornice
  const P = (u, v) => { const p = F(u, v, 0); return [p[0], -p[2]]; };
  const [px, py] = P(0, 0);
  box(S, px, py, fy, -fx, 4.2, 2.9, ground + 1.4, ground + 2.6, shade, I0, ST);
  box(S, px, py, fy, -fx, 3.6, 2.4, ground + 2.6, ground + 7.6, stone, I0, ST);
  box(S, px, py, fy, -fx, 4.0, 2.75, ground + 7.6, ground + 8.3, shade, I0, ST);
  box(S, px, py, fy, -fx, 3.5, 2.3, ground + 8.3, ground + 8.8, stone, I0, ST);
  // allegorical groups on both flanks (Triumph with a horse, Fame with an elephant), bronze
  for (const s of [-1, 1]) {
    const [gx, gy] = P(s * 5.2, 0.4);
    box(S, gx, gy, fy, -fx, 1.6, 1.9, ground + 1.4, ground + 2.4, stone, I0, ST);
    limb(S, F(s * 5.2, -0.9, 2.4), F(s * 5.2, 1.2, 3.6), 0.95, 0.7, 8, bronze, PL);
    limb(S, F(s * 5.0, 0.2, 2.4), F(s * 4.9, 0.1, 5.4), 0.45, 0.3, 8, bronzeHi, PL);
    limb(S, F(s * 4.9, 0.1, 5.4), F(s * 4.9, 0.1, 5.9), 0.2, 0.18, 6, bronzeHi, PL);
  }
  // horse (walking, near fore-leg raised) and rider, scale ≈ 1.8× life
  const h0 = 8.8;
  const Bp = (u, v, zz) => F(u, v, h0 + zz);
  limb(S, Bp(0, -2.1, 3.0), Bp(0, 1.9, 3.35), 1.05, 1.15, 10, bronze, PL);                 // barrel
  limb(S, Bp(0, -2.4, 3.0), Bp(0, -2.1, 3.0), 0.75, 1.05, 10, bronze, PL);                 // rump
  limb(S, Bp(0, 1.7, 3.4), Bp(0, 2.9, 5.2), 0.75, 0.45, 8, bronze, PL);                    // neck
  limb(S, Bp(0, 2.8, 5.3), Bp(0, 3.95, 4.55), 0.42, 0.26, 8, bronze, PL);                  // head
  limb(S, Bp(0, 2.2, 5.0), Bp(0, 2.6, 5.6), 0.12, 0.05, 4, bronze, PL);                    // mane crest
  limb(S, Bp(0, -2.5, 3.3), Bp(0, -3.0, 1.6), 0.28, 0.12, 6, bronze, PL);                  // tail
  for (const [u, v, raised] of [[-0.55, 1.55, false], [0.55, 1.55, true], [-0.55, -1.7, false], [0.55, -1.7, false]]) {
    if (raised) { limb(S, Bp(u, v, 2.6), Bp(u, v + 0.75, 1.55), 0.24, 0.17, 6, bronze, PL); limb(S, Bp(u, v + 0.75, 1.55), Bp(u, v + 0.45, 0.85), 0.17, 0.14, 6, bronze, PL); }
    else limb(S, Bp(u, v, 2.6), Bp(u, v + (v > 0 ? 0.1 : -0.15), 0), 0.26, 0.15, 6, bronze, PL);
  }
  limb(S, Bp(0.2, 3.2, 0.05), Bp(-0.8, 2.2, 0.25), 0.18, 0.1, 5, bronze, PL);              // serpents
  limb(S, Bp(-0.6, -0.1, 3.9), Bp(0.6, -0.1, 3.9), 0.3, 0.3, 6, bronze, PL, false);        // rider's legs / saddle cloth
  for (const s of [-1, 1]) limb(S, Bp(s * 0.95, 0, 3.9), Bp(s * 1.0, 0.45, 2.4), 0.2, 0.15, 6, bronze, PL);
  limb(S, Bp(0, -0.05, 3.95), Bp(0, 0.1, 5.5), 0.55, 0.45, 8, bronze, PL);                 // torso
  limb(S, Bp(0, -0.25, 4.6), Bp(0, -0.9, 3.5), 0.55, 0.85, 8, bronze, PL);                 // cloak
  limb(S, Bp(0, 0.1, 5.5), Bp(0, 0.15, 5.95), 0.24, 0.24, 8, bronzeHi, PL);                // head
  limb(S, Bp(0, 0.15, 5.95), Bp(0, 0.1, 6.6), 0.36, 0.08, 8, bronzeHi, PL);                // plumed helmet
  limb(S, Bp(0.45, 0.2, 5.2), Bp(0.75, 1.1, 5.0), 0.12, 0.1, 5, bronze, PL);               // sceptre arm
  return 1;
}
