// Bridge decks, ramps and piers from data/decks.json (pipeline/decks.mjs): the roads, paths and railways that OSM
// maps as bridges stand on their measured deck level, with parapets, a slab, piers between the roads below and
// abutment walls where they land. Walled ramps (approaches the survey's ground filter left out) are solid down to
// the ground. All plain-shaded geometry in the building meshes, so drive mode can drive on them and under them.
import { KIND, tri as triRaw } from './buildings.mjs';

const I0 = [0, 0, 0, 0], UV0 = [0, 0];
const PL = [KIND.PLAIN / 8, 5 / 8, 0.3, 1];

// world: [x, up, -y]
const W = (x, y, z) => [x, z, -y];
const norm = (a, b, c) => { const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]; const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...n) || 1; return n.map((q) => q / l); };
function quad(S, A, B, C, D, col, want) {   // A B C D in order round the face, wound to face `want`
  let n = norm(A, B, C);
  if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) { [B, D] = [D, B]; n = n.map((q) => -q); }
  triRaw(S, A, B, C, n, col, UV0, UV0, UV0, I0, PL); triRaw(S, A, C, D, n, col, UV0, UV0, UV0, I0, PL);
}
// an upright box on a centre, its long axis along (ux, uy): no bottom face
function post(S, x, y, ux, uy, hu, hv, z0, z1, col, colTop = col) {
  const P = (a, b, z) => W(x + ux * a - uy * b, y + uy * a + ux * b, z);
  const c = [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]];
  for (let k = 0; k < 4; k++) {
    const [a0, b0] = c[k], [a1, b1] = c[(k + 1) % 4], mx = (a0 + a1) / 2, my = (b0 + b1) / 2, l = Math.hypot(mx, my) || 1;
    const want = [(ux * mx - uy * my) / l, 0, -(uy * mx + ux * my) / l];
    quad(S, P(a0, b0, z0), P(a1, b1, z0), P(a1, b1, z1), P(a0, b0, z1), col, want);
  }
  quad(S, P(-hu, -hv, z1), P(hu, -hv, z1), P(hu, hv, z1), P(-hu, hv, z1), colTop, [0, 1, 0]);
}

/**
 * decks: entries of data/decks.json touching this area. env:
 *   meshAt(x, y)   rendered terrain height       clearOK(x, y)  may a pier stand here (no road, rail, water below)
 *   lin, srgb      colours                       lamps          street-lamp list to extend (x, up, -y)
 * Returns { S (triangles), far: bool per triangle run, stats }.
 */
export function buildBridges(S, decks, { meshAt, clearOK, lin, srgb, lamps, keepFar }) {
  const col = (h) => lin(srgb(h));
  const C = {
    asphalt: col('#85827e'), asphaltRamp: col('#85827e'), kerb: col('#c4beb2'), concrete: col('#bcb6aa'), concreteD: col('#9a958c'),
    under: col('#7d7972'), pier: col('#b3ada2'), pierTop: col('#c2bcb1'), ballast: col('#8c8274'), rail: col('#5d5a57'), foot: col('#c9c1b1'),
    wall: col('#b0a99c'), line: col('#e9e6de'),
  };
  const st = { decks: 0, ramps: 0, piers: 0, abutments: 0, m: 0 };
  for (const d of decks) {
    const n = d.pts.length; if (n < 2) continue;
    const isRail = d.k === 'rail' || d.k === 'metro' || d.k === 'tram', isFoot = d.k === 'foot';
    const pL = [...d.pL].map(Number), pR = [...d.pR].map(Number);
    const z = d.z.slice();
    // where a deck or ramp lands on the ground, it meets the terrain as drawn (8 m mesh), not the survey's 4 m grid
    for (const e of [0, 1]) if (!d.onDeck[e]) {
      const i0 = e ? n - 1 : 0, gz = meshAt(d.pts[i0][0], d.pts[i0][1]) + 0.04, dz = gz - z[i0];
      if (Math.abs(dz) > 1.5 && !d.ramp) continue;   // the mesh is far off: keep the survey (abutment walls cover it)
      let s = 0; for (let k = 0; k < n; k++) { const i = e ? n - 1 - k : k; if (k) s += Math.hypot(d.pts[i][0] - d.pts[e ? i + 1 : i - 1][0], d.pts[i][1] - d.pts[e ? i + 1 : i - 1][1]); if (s > 10) break; z[i] += dz * (1 - s / 10); }
    }
    const dir = d.pts.map((_, i) => { const a = d.pts[Math.max(0, i - 1)], b = d.pts[Math.min(n - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; });
    const T = isFoot ? 0.55 : isRail ? 1.7 : d.ramp ? 0.6 : 1.35;   // slab depth
    const PH = isRail ? 1.1 : isFoot ? 1.05 : 0.95, PT = isFoot ? 0.12 : 0.28;   // parapet height, thickness
    const g = d.pts.map(([x, y]) => meshAt(x, y));
    const clear = z.map((v, i) => v - T - g[i]);
    const solid = clear.map((c) => d.ramp || c < 2.2);
    const L = (i, off) => [d.pts[i][0] - dir[i][1] * off, d.pts[i][1] + dir[i][0] * off];   // + = left
    const top = isFoot ? C.foot : isRail ? C.ballast : C.asphalt;
    const lefts = (i) => [L(i, d.hwL[i]), L(i, d.hwL[i] - PT), L(i, d.hwL[i] - PT - (isRail || isFoot ? 0 : 0.45))];
    const rights = (i) => [L(i, -d.hwR[i]), L(i, -d.hwR[i] + PT), L(i, -d.hwR[i] + PT + (isRail || isFoot ? 0 : 0.45))];
    for (let i = 0; i + 1 < n; i++) {
      const j = i + 1, za = z[i], zb = z[j];
      const [la0, la1, la2] = lefts(i), [lb0, lb1, lb2] = lefts(j), [ra0, ra1, ra2] = rights(i), [rb0, rb1, rb2] = rights(j);
      const lat = [-(dir[i][1] + dir[j][1]) / 2, 0, -(dir[i][0] + dir[j][0]) / 2];   // world direction of the left side
      const latR = lat.map((q) => -q);
      // road surface between the kerbs, kerb strips under the parapets
      quad(S, W(...la2, za), W(...lb2, zb), W(...rb2, zb), W(...ra2, za), top, [0, 1, 0]);
      if (!isRail && !isFoot) { quad(S, W(...la1, za), W(...lb1, zb), W(...lb2, zb), W(...la2, za), C.kerb, [0, 1, 0]); quad(S, W(...ra1, za), W(...rb1, zb), W(...rb2, zb), W(...ra2, za), C.kerb, [0, 1, 0]); }
      else { quad(S, W(...la1, za), W(...lb1, zb), W(...lb2, zb), W(...la2, za), top, [0, 1, 0]); quad(S, W(...ra1, za), W(...rb1, zb), W(...rb2, zb), W(...ra2, za), top, [0, 1, 0]); }
      // sides: down to the slab soffit, or to the ground where it is solid (ramp, abutment, low deck)
      const sol = solid[i] && solid[j];
      const bot = (k, p) => (sol ? Math.min(z[k] - T, meshAt(p[0], p[1]) - 0.6) : z[k] - T);
      for (const [o0, o1, i0, i1, par, lt] of [[la0, lb0, la1, lb1, pL[i] && pL[j], lat], [ra0, rb0, ra1, rb1, pR[i] && pR[j], latR]]) {
        const h = par ? PH : 0;
        quad(S, W(...o0, bot(i, o0)), W(...o1, bot(j, o1)), W(...o1, zb + h), W(...o0, za + h), sol ? C.wall : C.concrete, lt);
        if (par) {
          quad(S, W(...o0, za + h), W(...o1, zb + h), W(...i1, zb + h), W(...i0, za + h), C.concreteD, [0, 1, 0]);
          quad(S, W(...i0, za), W(...i1, zb), W(...i1, zb + h), W(...i0, za + h), C.concrete, lt.map((q) => -q));
        }
      }
      if (!sol) quad(S, W(...la0, za - T), W(...lb0, zb - T), W(...rb0, zb - T), W(...ra0, za - T), C.under, [0, -1, 0]);
      // rails: two per track, on the ballast
      if (isRail) {
        const gauge = d.k === 'rail' ? 1.668 : d.k === 'metro' ? 1.435 : 1.0;
        for (const sd of [-0.5, 0.5]) {
          const a = L(i, sd * gauge), b = L(j, sd * gauge), w = 0.06, nl = [-dir[i][1] * w, dir[i][0] * w];
          quad(S, W(a[0] - nl[0], a[1] - nl[1], za + 0.2), W(b[0] - nl[0], b[1] - nl[1], zb + 0.2), W(b[0] + nl[0], b[1] + nl[1], zb + 0.2), W(a[0] + nl[0], a[1] + nl[1], za + 0.2), C.rail, [0, 1, 0]);
        }
      }
      st.m += Math.hypot(d.pts[j][0] - d.pts[i][0], d.pts[j][1] - d.pts[i][1]);
    }
    // abutments: where an open span meets solid ground (or ends), a wall across the deck from the soffit to the ground
    for (let i = 0; i < n; i++) {
      const end = i === 0 || i === n - 1;
      if (solid[i] || !(end || solid[i - 1] || solid[i + 1])) continue;
      const [l0] = lefts(i), [r0] = rights(i), zb = Math.min(meshAt(...l0), meshAt(...r0)) - 0.6;
      if (z[i] - T - zb < 0.4) continue;
      const fw = i === 0 ? [dir[i][0], 0, -dir[i][1]] : [-dir[i][0], 0, dir[i][1]];
      for (const f of [fw, fw.map((q) => -q)]) quad(S, W(...l0, zb), W(...r0, zb), W(...r0, z[i] - T), W(...l0, z[i] - T), C.wall, f);
      st.abutments++;
    }
    // piers under the open spans, every ~28 m (22 for rail, 18 for footbridges), nudged off the roads and water below
    const cum = [0]; for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(d.pts[i][0] - d.pts[i - 1][0], d.pts[i][1] - d.pts[i - 1][1]));
    const len = cum[n - 1], SP = isFoot ? 18 : isRail ? 22 : 28;
    const at = (s) => { let i = 1; while (i < n - 1 && cum[i] < s) i++; const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1))); return { i: t < 0.5 ? i - 1 : i, x: d.pts[i - 1][0] + (d.pts[i][0] - d.pts[i - 1][0]) * t, y: d.pts[i - 1][1] + (d.pts[i][1] - d.pts[i - 1][1]) * t, z: z[i - 1] + (z[i] - z[i - 1]) * t, hl: d.hwL[i - 1] + (d.hwL[i] - d.hwL[i - 1]) * t, hr: d.hwR[i - 1] + (d.hwR[i] - d.hwR[i - 1]) * t, ux: dir[i][0], uy: dir[i][1] }; };
    if (len > SP * 0.9) {
      const nP = Math.max(1, Math.round(len / SP) - 1), sp = len / (nP + 1);
      for (let k = 1; k <= nP; k++) {
        let placed = false;
        for (const off of [0, 1.5, -1.5, 3, -3, 4.5, -4.5, 6, -6, 8, -8]) {
          const s = k * sp + off; if (s < 4 || s > len - 4) continue;
          const p = at(s), wid = p.hl + p.hr, mid = (p.hl - p.hr) / 2, cx = p.x - p.uy * mid, cy = p.y + p.ux * mid;
          const gz = meshAt(cx, cy), soff = p.z - T;
          if (soff - gz < 2.2) continue;
          const cols = isFoot ? [[0, 0.3, 0.3]] : isRail ? [[0, 0.9, Math.min(wid * 0.36, 3)]] : wid <= 13 ? [[0, 0.85, Math.min(wid * 0.18, 2.2)]] : [[-wid / 4, 0.75, 0.75], [wid / 4, 0.75, 0.75]];
          const ok = cols.every(([v, , hv]) => [-1, 0, 1].every((e) => clearOK(cx - p.uy * (v + e * hv), cy + p.ux * (v + e * hv))));
          if (!ok) continue;
          const cap = isFoot ? 0 : 0.7;
          for (const [v, hu, hv] of cols) post(S, cx - p.uy * v, cy + p.ux * v, p.ux, p.uy, hu, hv, gz - 0.6, soff - cap, C.pier, C.pierTop);
          if (cap) post(S, cx, cy, p.ux, p.uy, isRail ? 1.0 : 1.05, Math.max(1.2, wid / 2 - 0.6), soff - cap, soff - 0.02, C.pierTop);
          st.piers++; placed = true; break;
        }
      }
    }
    // lamp posts along the busier road decks, on alternate parapets
    if (lamps && d.k === 'road' && /motorway|trunk|primary|secondary/.test(d.hw)) {
      for (let s = 12, side = 1; s < len - 4; s += 34, side = -side) {
        const p = at(s), off = side > 0 ? p.hl - 0.3 : -(p.hr - 0.3);
        lamps.push(p.x - p.uy * off, p.z + 7.5, -(p.y + p.ux * off));
      }
    }
    if (d.ramp) st.ramps++; else st.decks++;
  }
  return st;
}
