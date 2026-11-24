// Building geometry: Lisbon-aware roofs (gables between party walls, hips, mansards),
// eaves, parapets, chimneys, per-wall façade metadata and balcony placements.
import earcut from 'earcut';

// ─── small 2D helpers ───────────────────────────────────────────────────
const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
export function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross2(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross2(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// Minimum-area oriented bounding box. u = long axis.
export function obb(ring) {
  const h = convexHull(ring);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, vx = -uy, vy = ux;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of h) { const u = q[0] * ux + q[1] * uy, v = q[0] * vx + q[1] * vy; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uy, vx, vy, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ux, uy, vx, vy, u0, u1, v0, v1 } = best;
  if (v1 - v0 > u1 - u0) { [ux, uy, vx, vy] = [vx, vy, -ux, -uy]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { ux, uy, vx, vy, cx: cu * ux + cv * vx, cy: cu * uy + cv * vy, hl: (u1 - u0) / 2, hw: (v1 - v0) / 2, area: best.area };
}
// Sutherland–Hodgman: keep a·p + c <= 0
function clipHalf(poly, ax, ay, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = ax * p[0] + ay * p[1] + c, fq = ax * q[0] + ay * q[1] + c;
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}
const polyArea = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const pip = (x, y, r) => { let s = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) s = !s; } return s; };

// ─── party walls ────────────────────────────────────────────────────────
// An edge is a party wall when another building's edge runs along it (≤0.7 m, near-parallel).
export function markPartyWalls(polys) {
  const CELL = 12, grid = new Map();
  const add = (k, v) => { let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(v); };
  polys.forEach((p, pi) => p.outer.forEach((a, i) => {
    const b = p.outer[(i + 1) % p.outer.length];
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) add(`${x},${y}`, [pi, a, b]);
  }));
  const segDist = (px, py, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2));
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  };
  polys.forEach((p, pi) => {
    p.party = p.outer.map((a, i) => {
      const b = p.outer[(i + 1) % p.outer.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) return false;
      const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
      let hits = 0;
      for (const t of [0.2, 0.5, 0.8]) {
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
        const cand = grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) || [];
        if (cand.some(([qi, c, d]) => {
          if (qi === pi) return false;
          const l = Math.hypot(d[0] - c[0], d[1] - c[1]); if (l < 0.3) return false;
          return Math.abs(((d[0] - c[0]) * dx + (d[1] - c[1]) * dy) / l) > 0.94 && segDist(x, y, c, d) < 0.7;
        })) hits++;
      }
      return hits >= 2;
    });
  });
}

// ─── geometry sink ──────────────────────────────────────────────────────
// Per vertex: position, normal, colour, surf (2D surface coords in metres),
// info (wallTopRel/128, floorH/8, bays/128, groundFloorH/8) — normalised so they quantise, style (kind/8, variant/8, seed, bayW/6).
export const KIND = { PLAIN: 0, FACADE: 1, BLANK: 2, TILES: 3, FLAT: 4, MANSARD: 5, STONE: 6 };
export function makeSink() { return { pos: [], nrm: [], col: [], surf: [], info: [], style: [] }; }
function tri(S, a, b, c, n, col, sa, sb, sc, info, style) {
  S.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  for (let k = 0; k < 3; k++) { S.nrm.push(n[0], n[1], n[2]); S.col.push(col[0], col[1], col[2]); S.info.push(info[0], info[1], info[2], info[3]); S.style.push(style[0], style[1], style[2], style[3]); }
  S.surf.push(sa[0], sa[1], sb[0], sb[1], sc[0], sc[1]);
}
const normal3 = (a, b, c) => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
};
// Upward-facing triangle (fixes winding).
function triUp(S, a, b, c, col, sa, sb, sc, info, style) {
  let n = normal3(a, b, c);
  if (n[1] < 0) { [b, c] = [c, b]; [sb, sc] = [sc, sb]; n = n.map((v) => -v); }
  tri(S, a, b, c, n, col, sa, sb, sc, info, style);
}
// Vertical quad on segment p→q (2D, CCW-outer convention: outward = right side), heights per end.
function wallQuad(S, p, q, b0, b1, t0, t1, col, u0, u1, ground, info, style, flip = false) {
  const L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L < 1e-4) return;
  let n = [(q[1] - p[1]) / L, 0, (q[0] - p[0]) / L];
  const A = [p[0], b0, -p[1]], B = [q[0], b1, -q[1]], C = [q[0], t1, -q[1]], D = [p[0], t0, -p[1]];
  const sA = [u0, b0 - ground], sB = [u1, b1 - ground], sC = [u1, t1 - ground], sD = [u0, t0 - ground];
  if (!flip) { tri(S, A, B, C, n, col, sA, sB, sC, info, style); tri(S, A, C, D, n, col, sA, sC, sD, info, style); }
  else { n = n.map((v) => -v); tri(S, A, C, B, n, col, sA, sC, sB, info, style); tri(S, A, D, C, n, col, sA, sD, sC, info, style); }
}
function box(S, cx, cy, ux, uy, hu, hv, z0, z1, col, info, style, top = true) {
  const vx = -uy, vy = ux;
  const c = [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]].map(([a, b]) => [cx + ux * a + vx * b, cy + uy * a + vy * b]);
  for (let i = 0; i < 4; i++) wallQuad(S, c[i], c[(i + 1) % 4], z0, z0, z1, z1, col, 0, 1, z0, info, style);
  if (top) { const T = c.map((p) => [p[0], z1, -p[1]]); triUp(S, T[0], T[1], T[2], col, [0, 0], [1, 0], [1, 1], info, style); triUp(S, T[0], T[2], T[3], col, [0, 0], [1, 1], [0, 1], info, style); }
}

// ─── planar roofs: f(p) = min_i plane_i(p) ──────────────────────────────
function plane(nx, ny, px, py, h0, s, kind = KIND.TILES) { // inward normal n, side point p, value h0 on the side
  return { nx, ny, k: h0 - s * (nx * px + ny * py), s, kind, h0 };
}
const pv = (P, x, y) => P.k + P.s * (P.nx * x + P.ny * y);

export function buildRoofAndWalls(S, ctx) {
  const { outer, holes, party, ground, bottom, wallTop, spec, seed, colWall, colRoof, colTrim, colFlat, rng } = ctx;
  const ox0 = ctx.cx || 0, oy0 = ctx.cy || 0; // local origin keeps surface coords small (they get quantised)
  const out = { planes: null, f: null, eaveSlope: 0, balconies: [] };
  const box_ = obb(outer);
  const fill = box_ ? Math.abs(polyArea(outer)) / (4 * box_.hl * box_.hw) : 0;
  let shape = spec.shape;
  let planes = null;
  const pitchDeg = spec.pitch;
  const s = Math.tan((pitchDeg * Math.PI) / 180);
  const planar = box_ && !holes.length && fill > 0.72 && outer.length <= 40;

  if (shape !== 'flat' && !shape.startsWith('skeleton') && planar && !['dome', 'onion', 'cone'].includes(shape)) {
    const { ux, uy, vx, vy, cx, cy, hl, hw } = box_;
    // classify outline edges into the 4 OBB sides; a side is "party" if most of its length is party wall
    const sideLen = [0, 0, 0, 0], sideParty = [0, 0, 0, 0]; // +u, -u, +v, -v (outward)
    outer.forEach((a, i) => {
      const b = outer[(i + 1) % outer.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-3) return;
      const ox = (b[1] - a[1]) / L, oy = -(b[0] - a[0]) / L; // outward normal (CCW)
      const du = ox * ux + oy * uy, dv = ox * vx + oy * vy;
      const k = Math.abs(du) > Math.abs(dv) ? (du > 0 ? 0 : 1) : dv > 0 ? 2 : 3;
      sideLen[k] += L; if (party[i]) sideParty[k] += L;
    });
    const isParty = sideLen.map((L, k) => L > 0 && sideParty[k] / L > 0.45);
    const sides = [
      [-ux, -uy, cx + ux * hl, cy + uy * hl], [ux, uy, cx - ux * hl, cy - uy * hl],
      [-vx, -vy, cx + vx * hw, cy + vy * hw], [vx, vy, cx - vx * hw, cy - vy * hw],
    ];
    let use = [0, 1, 2, 3];
    if (shape === 'gabled' || shape === 'saltbox' || shape === 'side_hipped') use = [2, 3];
    else if (shape === 'skillion') use = [isParty[3] ? 2 : 3];
    else if (shape === 'hipped' || shape === 'mansard' || shape === 'gambrel' || shape === 'pyramidal') {
      use = [0, 1, 2, 3].filter((k) => !isParty[k]);
      if (use.length === 0) use = [2, 3];
      if (use.length === 1 && (use[0] === 0 || use[0] === 1)) use = [2, 3];  // lone hip end → gable along the long axis
    }
    const mans = shape === 'mansard' || shape === 'gambrel';
    const s1 = mans ? Math.tan((68 * Math.PI) / 180) : shape === 'pyramidal' ? Math.tan(((spec.pitch || 40) * Math.PI) / 180) : s;
    planes = use.map((k) => plane(sides[k][0], sides[k][1], sides[k][2], sides[k][3], wallTop, s1, mans ? KIND.MANSARD : KIND.TILES));
    if (mans) { // upper shallow pitch starts at capH
      const capH = Math.min(2.9, spec.roofH || 2.9), d0 = capH / s1;
      for (const k of use) { const [nx, ny, px, py] = sides[k]; planes.push(plane(nx, ny, px + nx * d0, py + ny * d0, wallTop + capH, Math.tan((22 * Math.PI) / 180))); }
    }
    // height cap → flat terrace on very wide roofs
    const maxH = spec.roofH ? spec.roofH : mans ? 4.6 : Math.min(5.5, Math.max(2.2, hw * s * 0.999));
    planes.push({ nx: 0, ny: 0, k: wallTop + maxH, s: 0, kind: KIND.FLAT, h0: wallTop + maxH, cap: true });
    out.eaveSlope = s1;
  }

  const f = planes ? (x, y) => Math.max(wallTop, Math.min(...planes.map((P) => pv(P, x, y)))) : () => wallTop;
  out.f = f;
  const info = (bays) => [Math.min(1, (wallTop - ground) / 128), spec.floorH / 8, Math.min(1, bays / 128), spec.groundH / 8];
  const style = (kind, ri = 0) => [kind / 8, (ri > 0 && spec.variant === 6 ? 4 : spec.variant) / 8, seed, spec.bayW / 6]; // courtyards: no arcade

  // ── walls (split where the roof plane changes so gables follow the roof) ──
  const isFlat = !planes && !shape.startsWith('skeleton');
  const parapet = isFlat && spec.parapet ? spec.parapet : 0;
  const rings = [outer, ...holes];
  rings.forEach((r, ri) => {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.05) continue;
      const isP = ri === 0 && party[i];
      const facade = !isP && spec.floorH > 0 && L >= 1.6;
      const bays = facade ? Math.max(1, Math.round(L / spec.bayW)) : 0;
      const kind = isP ? KIND.BLANK : spec.stone ? KIND.STONE : facade ? KIND.FACADE : KIND.BLANK;
      const ts = [0, 1];
      if (planes) for (let m = 0; m < planes.length; m++) for (let n = m + 1; n < planes.length; n++) {
        const ga = pv(planes[m], a[0], a[1]) - pv(planes[n], a[0], a[1]), gb = pv(planes[m], b[0], b[1]) - pv(planes[n], b[0], b[1]);
        if ((ga < 0 && gb > 0) || (ga > 0 && gb < 0)) ts.push(ga / (ga - gb));
      }
      ts.sort((x, y) => x - y);
      for (let k = 0; k + 1 < ts.length; k++) {
        if (ts[k + 1] - ts[k] < 1e-5) continue;
        const p = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]], q = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
        const t0 = f(p[0], p[1]) + (isP ? 0 : parapet), t1 = f(q[0], q[1]) + (isP ? 0 : parapet);
        wallQuad(S, p, q, bottom, bottom, t0, t1, colWall, ts[k] * bays, ts[k + 1] * bays, ground, info(bays), style(kind, ri));
        if (parapet && !isP) wallQuad(S, p, q, wallTop, wallTop, t0, t1, colWall, 0, 1, ground, info(0), style(KIND.BLANK), true);
      }
      // balconies: on façades of styles that have them
      if (facade && spec.balconyFloors.length && L >= 2.2) {
        const ox = (b[1] - a[1]) / L, oy = -(b[0] - a[0]) / L;
        const bw = L / bays;
        for (const fl of spec.balconyFloors) {
          const z = ground + spec.groundH + (fl - 1) * spec.floorH;
          if (z + 2.4 > wallTop) continue;
          for (let k = 0; k < bays; k++) {
            if (spec.balconyChance < 1 && rng(`${i}_${k}_${fl}`) > spec.balconyChance) continue;
            const t = (k + 0.5) / bays;
            out.balconies.push([a[0] + (b[0] - a[0]) * t + ox * 0.02, z, -(a[1] + (b[1] - a[1]) * t + oy * 0.02), Math.atan2(ox, -oy), Math.min(bw * 0.62, 1.7)]);
          }
        }
      }
    }
  });

  // ── roof surface ──
  if (planes) {
    planes.forEach((P, i) => {
      let poly = outer.slice();
      for (let j = 0; j < planes.length && poly.length >= 3; j++) {
        if (j === i) continue;
        const Q = planes[j];
        poly = clipHalf(poly, P.s * P.nx - Q.s * Q.nx, P.s * P.ny - Q.s * Q.ny, P.k - Q.k);
      }
      if (poly.length < 3 || Math.abs(polyArea(poly)) < 0.02) return;
      const flat = poly.flatMap((p) => p);
      const idx = earcut(flat);
      const tx = -P.ny, ty = P.nx, sec = Math.sqrt(1 + P.s * P.s);
      const kind = P.cap ? KIND.FLAT : P.kind;
      const sf = (x, y) => (P.cap ? [x - ox0, y - oy0] : kind === KIND.MANSARD ? [tx * (x - ox0) + ty * (y - oy0), pv(P, x, y) - wallTop] : [tx * (x - ox0) + ty * (y - oy0), ((pv(P, x, y) - P.h0) / (P.s || 1)) * sec]);
      for (let k = 0; k < idx.length; k += 3) {
        const v = [idx[k], idx[k + 1], idx[k + 2]].map((q) => [flat[q * 2], flat[q * 2 + 1]]);
        triUp(S, ...v.map(([x, y]) => [x, pv(P, x, y), -y]), P.cap ? ctx.colCap : kind === KIND.FLAT ? colFlat : colRoof, ...v.map(([x, y]) => sf(x, y)), info(0), style(kind));
      }
    });
    // eaves: overhang along edges that sit at wall-top height
    const e = 0.5;
    outer.forEach((a, i) => {
      if (party[i]) return;
      const b = outer[(i + 1) % outer.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.8) return;
      if (f(a[0], a[1]) > wallTop + 0.05 || f(b[0], b[1]) > wallTop + 0.05) return;
      const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L, ox = dy, oy = -dx;
      const ea = [a[0] - dx * e * 0.98, a[1] - dy * e * 0.98], eb = [b[0] + dx * e * 0.98, b[1] + dy * e * 0.98];
      const drop = e * out.eaveSlope;
      const A = [a[0], wallTop + 0.02, -a[1]], B = [b[0], wallTop + 0.02, -b[1]];
      const C = [eb[0] + ox * e, wallTop - drop, -(eb[1] + oy * e)], D = [ea[0] + ox * e, wallTop - drop, -(ea[1] + oy * e)];
      triUp(S, A, B, C, colRoof, [0, 0], [L, 0], [L, -e], info(0), style(KIND.TILES));
      triUp(S, A, C, D, colRoof, [0, 0], [L, -e], [0, -e], info(0), style(KIND.TILES));
      // fascia + soffit (white trim reads as the classic Lisbon cornice)
      const C2 = [C[0], C[1] - 0.22, C[2]], D2 = [D[0], D[1] - 0.22, D[2]];
      const nF = [ox, 0, -oy];
      tri(S, D2, C2, C, nF, colTrim, [0, 0], [1, 0], [1, 1], info(0), style(KIND.PLAIN));
      tri(S, D2, C, D, nF, colTrim, [0, 0], [1, 1], [0, 1], info(0), style(KIND.PLAIN));
      const A2 = [A[0], wallTop - 0.2, A[2]], B2 = [B[0], wallTop - 0.2, B[2]];
      tri(S, A2, C2, B2, [0, -1, 0], colTrim, [0, 0], [1, 1], [1, 0], info(0), style(KIND.PLAIN));
      tri(S, A2, D2, C2, [0, -1, 0], colTrim, [0, 0], [0, 1], [1, 1], info(0), style(KIND.PLAIN));
    });
  } else if (shape !== 'skeleton-done') {
    // flat roof
    const flat = [], hIdx = [];
    rings.forEach((r, ri) => { if (ri) hIdx.push(flat.length / 2); r.forEach(([x, y]) => flat.push(x, y)); });
    const idx = earcut(flat, hIdx);
    for (let k = 0; k < idx.length; k += 3) {
      const v = [idx[k], idx[k + 1], idx[k + 2]].map((q) => [flat[q * 2], flat[q * 2 + 1]]);
      triUp(S, ...v.map(([x, y]) => [x, wallTop, -y]), colFlat, ...v.map(([x, y]) => [x - ox0, y - oy0]), info(0), style(KIND.FLAT));
    }
  }
  return out;
}

// Skeleton (CGAL) roof for complex footprints, courtyards, domes.
export function skeletonRoof(S, sk, ctx, pitchSlope, maxH, dome) {
  const { wallTop, spec, seed, colRoof } = ctx;
  const zmax = Math.max(...sk.vertices.map((v) => v[2]));
  if (zmax <= 0) return 0;
  const roofH = dome ? Math.min(zmax * 1.6, 30) : Math.min(zmax * pitchSlope, maxH);
  const scale = roofH / zmax;
  const sec = Math.sqrt(1 + scale * scale);
  const zf = (z) => wallTop + (dome ? roofH * Math.sqrt(Math.max(0, 1 - (1 - z / zmax) ** 2)) : z * scale);
  const info = [Math.min(1, (wallTop - ctx.ground) / 128), 0, 0, 0], style = [KIND.TILES / 8, spec.variant / 8, seed, spec.bayW / 6];
  for (const poly of sk.polygons) {
    const V = poly.map((k) => sk.vertices[k]);
    let ex = 1, ey = 0;
    for (let i = 0; i < V.length; i++) { const a = V[i], b = V[(i + 1) % V.length]; if (a[2] < 1e-4 && b[2] < 1e-4) { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; ex = (b[0] - a[0]) / L; ey = (b[1] - a[1]) / L; break; } }
    const flat = V.flatMap((v) => [v[0], v[1]]);
    const idx = earcut(flat);
    for (let k = 0; k < idx.length; k += 3) {
      const W = [V[idx[k]], V[idx[k + 1]], V[idx[k + 2]]];
      triUp(S, ...W.map((v) => [v[0], zf(v[2]), -v[1]]), colRoof, ...W.map((v) => [ex * (v[0] - (ctx.cx || 0)) + ey * (v[1] - (ctx.cy || 0)), v[2] * sec]), info, style);
    }
  }
  return roofH;
}

// Chimneys / rooftop structures.
export function roofExtras(S, ctx, f, rng, pitched) {
  const { outer, wallTop, colTrim, seed, spec } = ctx;
  const b = obb(outer); if (!b) return;
  const area = Math.abs(polyArea(outer));
  const info = [0, 0, 0, 0], st = [KIND.PLAIN / 8, spec.variant / 8, seed, 0.5];
  if (pitched) {
    if (area < 35) return;
    const n = area > 350 ? 2 : 1;
    for (let c = 0; c < n; c++) for (let tries = 0; tries < 8; tries++) {
      const u = (rng(`ch${c}${tries}u`) - 0.5) * 1.6 * (b.hl - 1.2), v = (rng(`ch${c}${tries}v`) - 0.5) * 1.2 * (b.hw - 1.2);
      const x = b.cx + b.ux * u + b.vx * v, y = b.cy + b.uy * u + b.vy * v;
      if (!pip(x, y, outer)) continue;
      const z = Math.max(f(x - 0.5, y - 0.5), f(x + 0.5, y + 0.5), f(x - 0.5, y + 0.5), f(x + 0.5, y - 0.5));
      box(S, x, y, b.ux, b.uy, 0.32 + rng(`cw${c}`) * 0.2, 0.32, z - 1.2, z + 0.9 + rng(`chh${c}`) * 0.5, colTrim, info, st);
      box(S, x, y, b.ux, b.uy, 0.45, 0.42, z + 0.9 + rng(`chh${c}`) * 0.5, z + 1.05 + rng(`chh${c}`) * 0.5, ctx.colRoof, info, st);
      break;
    }
  } else if (area > 220) {
    const x = b.cx + b.ux * b.hl * 0.25, y = b.cy + b.uy * b.hl * 0.25;
    if (pip(x, y, outer)) box(S, x, y, b.ux, b.uy, 1.8, 1.4, wallTop, wallTop + 2.6, colTrim, info, st);
    if (area > 600) { const x2 = b.cx - b.ux * b.hl * 0.4, y2 = b.cy - b.uy * b.hl * 0.4; if (pip(x2, y2, outer)) box(S, x2, y2, b.ux, b.uy, 1.1, 0.8, wallTop, wallTop + 1.3, colTrim, info, st); }
  }
}

export { box, wallQuad, triUp, tri, polyArea, pip };
