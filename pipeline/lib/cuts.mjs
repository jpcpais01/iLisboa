// Cuttings and underpasses: where a road or railway runs below the terrain as the 8 m mesh draws it (a trench, the
// ramps down into an underpass or a tunnel, a road cut into a hillside), the mesh is re-cut along the road: the
// carriageway drops to its true level (the LiDAR terrain along its centreline) between vertical retaining walls,
// and a tunnel mouth gets a portal. Everything that sits on the ground (cars, lamps, the ambient traffic, drive mode)
// follows, because it all reads the terrain mesh.
import ClipperLib from 'clipper-lib';
import earcut from 'earcut';

const SC = 100;   // Clipper works in centimetres
const segInfo = (x, y, s) => { const dx = s.bx - s.ax, dy = s.by - s.ay, t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / (s.L2 || 1))); return { d: Math.hypot(s.ax + dx * t - x, s.ay + dy * t - y), t }; };
const run = (op, subj, clip, fill = ClipperLib.PolyFillType.pftNonZero) => { const c = new ClipperLib.Clipper(); c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true); if (clip) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true); const o = new ClipperLib.Paths(); c.Execute(op, o, fill, fill); return o; };
const P = (pts) => pts.map(([x, y]) => ({ X: Math.round(x * SC), Y: Math.round(y * SC) }));
const inPaths = (x, y, paths) => { let w = 0; for (const r of paths) { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i].X / SC, yi = r[i].Y / SC, xj = r[j].X / SC, yj = r[j].Y / SC; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } if (inside) w += ClipperLib.Clipper.Orientation(r) ? 1 : -1; } return w > 0; };

/**
 * lines: [{ pts, w, tunnel, rail }] — the painted roads and tracks, and tunnels (their open stretches are found here)
 * meshAt(x, y): the terrain mesh as drawn; levelAt(x, y): the true ground (LiDAR terrain)
 */
export function makeCuts({ lines, meshAt, levelAt, tunnelEnds = [], bounds = null }) {
  const inB = (x, y) => !bounds || (x > bounds[0] - 12 && x < bounds[2] + 12 && y > bounds[1] - 12 && y < bounds[3] + 12);
  const segs = [], runs = [], quads = [];
  const CELL = 24, grid = new Map(), key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  for (const ln of lines) {
    // densify to ≤ 4 m
    const pts = [];
    for (let i = 0; i < ln.pts.length; i++) {
      if (i) { const [ax, ay] = ln.pts[i - 1], [bx, by] = ln.pts[i], d = Math.hypot(bx - ax, by - ay); if (d < 0.05) continue; const n = Math.ceil(d / 4); for (let k = 1; k < n; k++) pts.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]); }
      pts.push(ln.pts[i]);
    }
    const n = pts.length; if (n < 2) continue;
    const m = pts.map(([x, y]) => meshAt(x, y)), z0 = pts.map(([x, y]) => levelAt(x, y));
    const cum = [0]; for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const zf = z0.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (Math.abs(cum[j] - cum[i]) <= 5 && Number.isFinite(z0[j])) { s += z0[j]; c++; } return c ? s / c : NaN; });
    const depth = zf.map((z, i) => (Number.isFinite(z) && inB(...pts[i]) ? m[i] - z : 0));
    const CORE = ln.tunnel ? 1.6 : 1.1;
    for (let i = 0; i < n; ) {
      if (!(depth[i] > 0.25)) { i++; continue; }
      let j = i; while (j + 1 < n && depth[j + 1] > 0.25) j++;
      const core = depth.slice(i, j + 1).filter((d) => d > CORE).length;
      if (core >= 2 && cum[j] - cum[i] >= 8) {
        // ordinary roads ease back onto the ground one vertex beyond the run; a tunnel's open ramp ends at the portal
        const a = ln.tunnel || i === 0 ? i : i - 1, b = ln.tunnel || j === n - 1 ? j : j + 1;
        const zr = zf.slice(a, b + 1).map((z, k) => ((a + k < i || a + k > j) ? m[a + k] : z));
        runs.push({ pts: pts.slice(a, b + 1), z: zr, w: ln.w, tunnel: ln.tunnel, rail: ln.rail, depth: depth.slice(a, b + 1), endsAtLine: [a === 0, b === n - 1] });
      }
      i = j + 1;
    }
  }
  // corridors: a quad per segment, a disc at every inner joint
  for (const r of runs) {
    const hw = r.w / 2 + (r.rail ? 1.8 : r.tunnel ? 0.6 : 1.4); r.hw = hw;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1], L = Math.hypot(bx - ax, by - ay); if (L < 0.01) continue;
      const nx = -(by - ay) / L * hw, ny = (bx - ax) / L * hw;
      const s = { ax, ay, bx, by, L2: L * L, za: r.z[i], zb: r.z[i + 1], hw };
      segs.push(s);
      const k = segs.length - 1;
      for (let gx = Math.floor((Math.min(ax, bx) - hw) / CELL); gx <= Math.floor((Math.max(ax, bx) + hw) / CELL); gx++) for (let gy = Math.floor((Math.min(ay, by) - hw) / CELL); gy <= Math.floor((Math.max(ay, by) + hw) / CELL); gy++) (grid.get(`${gx},${gy}`) || grid.set(`${gx},${gy}`, []).get(`${gx},${gy}`)).push(k);
      quads.push(P([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]));
      if (i > 0) quads.push(P(Array.from({ length: 10 }, (_, q) => [ax + Math.cos((q / 10) * Math.PI * 2) * hw, ay + Math.sin((q / 10) * Math.PI * 2) * hw])));
    }
  }
  const fixed = quads.map((q) => (ClipperLib.Clipper.Orientation(q) ? q : q.slice().reverse()));
  const union = fixed.length ? run(ClipperLib.ClipType.ctUnion, fixed) : [];
  const near = (x, y) => grid.get(key(x, y)) || [];
  // the road level at a point of a corridor (lowest of the corridors that hold it); NaN outside them
  const levelIn = (x, y, tol = 0.03) => {
    let z = NaN;
    for (const k of near(x, y)) { const s = segs[k], { d, t } = segInfo(x, y, s); if (d <= s.hw + tol) { const v = s.za + (s.zb - s.za) * t; if (!(v >= z)) z = v; } }
    return z;
  };
  const inCut = (x, y) => { const z = levelIn(x, y, 0); return Number.isFinite(z) && z < meshAt(x, y) - 0.02; };
  // portals: where a cut ends deep against a tunnel
  const portals = [];
  for (const r of runs) for (const e of [0, 1]) {
    const i = e ? r.pts.length - 1 : 0, d = r.depth[i]; if (!(d > 2.2)) continue;
    const [x, y] = r.pts[i];
    if (!r.tunnel && !(r.endsAtLine[e] && tunnelEnds.some(([tx, ty]) => Math.hypot(tx - x, ty - y) < 2))) continue;
    if (r.tunnel && r.endsAtLine[e]) continue;   // a tunnel way that is open to its very end runs on as an open road
    const [px, py] = r.pts[e ? i - 1 : 1], l = Math.hypot(x - px, y - py) || 1;
    portals.push({ x, y, ux: (x - px) / l, uy: (y - py) / l, z: r.z[i], depth: d, w: r.w, hw: r.hw });
  }
  return { runs, segs, union, levelIn, inCut, portals, near: (x0, y0, x1, y1) => { const s = new Set(); for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) for (const k of grid.get(`${gx},${gy}`) || []) s.add(k); return [...s].map((k) => segs[k]); } };
}

// The terrain cells a cut crosses, re-triangulated: the part outside the corridor on the cell's own surface, the part
// inside on the road level, and the vertical wall between them (returned for the building mesh, concrete).
// cellH(x, y): the cell's original surface. Returns { tris: [[x, y, z] × 3 …], walls: [{ p, q, zf0, zf1, zl0, zl1, nx, ny }] } or null.
export function clipUnion(cuts, x0, y0, x1, y1) { return run(ClipperLib.ClipType.ctIntersection, cuts.union, [P([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])]); }
export function cutCell(cuts, x0, y0, x1, y1, cellH, union = cuts.union) {
  const sq = P([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  const near = cuts.near(x0 - 1, y0 - 1, x1 + 1, y1 + 1); if (!near.length) return null;
  const clip = run(ClipperLib.ClipType.ctIntersection, union, [sq]);
  if (!clip.length) return null;
  let area = 0; for (const r of clip) area += Math.abs(ClipperLib.Clipper.Area(r)); if (area < 0.05 * SC * SC) return null;
  const rest = run(ClipperLib.ClipType.ctDifference, [sq], union);
  const tris = [], walls = [];
  // Clipper rounds to the centimetre: put points that sit on the cell's border back exactly on it
  const snap = (x, y) => [Math.abs(x - x0) < 0.012 ? x0 : Math.abs(x - x1) < 0.012 ? x1 : x, Math.abs(y - y0) < 0.012 ? y0 : Math.abs(y - y1) < 0.012 ? y1 : y];
  const lvl = (x, y) => { const z = cuts.levelIn(x, y, 0.05); const h = cellH(x, y); return Number.isFinite(z) ? Math.min(z, h) : h; };
  const tri = (paths, H, cut) => {
    // group holes under outers
    const outers = paths.filter((p) => ClipperLib.Clipper.Orientation(p)), holes = paths.filter((p) => !ClipperLib.Clipper.Orientation(p));
    for (const o of outers) {
      const hs = holes.filter((h) => inPaths(h[0].X / SC, h[0].Y / SC, [o]));
      const flat = [], holeIx = [];
      for (const q of o) flat.push(...snap(q.X / SC, q.Y / SC));
      for (const h of hs) { holeIx.push(flat.length / 2); for (const q of h) flat.push(...snap(q.X / SC, q.Y / SC)); }
      const ix = earcut(flat, holeIx);
      for (let k = 0; k < ix.length; k += 3) { const t = [ix[k], ix[k + 1], ix[k + 2]].map((v) => [flat[v * 2], flat[v * 2 + 1], H(flat[v * 2], flat[v * 2 + 1])]); t.cut = cut; tris.push(t); }
    }
  };
  tri(rest, cellH, false);
  tri(clip, lvl, true);
  // walls: edges of the cut part that are not on the cell's border
  const E = 1e-4, onB = (a, b) => (Math.abs(a[0] - x0) < E && Math.abs(b[0] - x0) < E) || (Math.abs(a[0] - x1) < E && Math.abs(b[0] - x1) < E) || (Math.abs(a[1] - y0) < E && Math.abs(b[1] - y0) < E) || (Math.abs(a[1] - y1) < E && Math.abs(b[1] - y1) < E);
  for (const r of clip) for (let i = 0; i < r.length; i++) {
    const a = snap(r[i].X / SC, r[i].Y / SC), b = snap(r[(i + 1) % r.length].X / SC, r[(i + 1) % r.length].Y / SC);
    if (onB(a, b) || Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.01) continue;
    const zf0 = lvl(...a), zf1 = lvl(...b), zl0 = cellH(...a), zl1 = cellH(...b);
    if (zl0 - zf0 < 0.12 && zl1 - zf1 < 0.12) continue;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), lx = -(b[1] - a[1]) / L, ly = (b[0] - a[0]) / L, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const inside = inPaths(mx + lx * 0.05, my + ly * 0.05, clip);
    walls.push({ p: a, q: b, zf0, zf1, zl0, zl1, nx: inside ? lx : -lx, ny: inside ? ly : -ly });
  }
  return { tris, walls };
}
