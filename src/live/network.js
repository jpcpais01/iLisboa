// Street + tram-rail graph (public/live/net.bin, from pipeline/network.mjs). Vehicles snap onto it and, between GPS
// fixes, follow the shortest way along it — so a bus turns the corner instead of driving through the block.
const CELL = 40;

// street names, indexed by edges[e].name ('' when unnamed); a separate file so only what shows names downloads it
let namesP = null;
export const loadNames = () => (namesP ||= fetch('/live/names.json').then((r) => r.json()));

let netP = null;
// one shared copy of the network for every layer (buses, trams, ambient cars, driving)
export const loadNetwork = () => (netP ||= parseNetwork());

async function parseNetwork() {
  const b = await (await fetch('/live/net.bin')).arrayBuffer(), dv = new DataView(b);
  let o = 0;
  const v2 = dv.getUint32(0, true) === 0x3254454e;   // 'NET2': road class, one-way, lanes, tunnel, bridge decks
  if (v2) o += 4;
  const nV = dv.getUint32(o, true); o += 4;
  const VX = new Float32Array(nV), VY = new Float32Array(nV);
  for (let i = 0; i < nV; i++, o += 4) { VX[i] = dv.getInt16(o, true) / 2; VY[i] = dv.getInt16(o + 2, true) / 2; }
  const nE = dv.getUint32(o, true); o += 4;
  const edges = new Array(nE), adj = Array.from({ length: nV }, () => []);
  const grid = new Map();
  for (let e = 0; e < nE; e++) {
    const a = dv.getUint32(o, true), bb = dv.getUint32(o + 4, true), k = dv.getUint8(o + 8);
    let cls = k === 1 ? 3 : 5, flags = 0, lanes = 0, n;
    let name = 0;
    if (v2) { cls = dv.getUint8(o + 9); flags = dv.getUint8(o + 10); lanes = dv.getUint8(o + 11); name = dv.getUint16(o + 12, true); n = dv.getUint16(o + 14, true); o += 16; }
    else { n = dv.getUint16(o + 9, true); o += 11; }
    const pts = [[VX[a], VY[a]]];
    for (let j = 0; j < n; j++, o += 4) pts.push([dv.getInt16(o, true) / 2, dv.getInt16(o + 2, true) / 2]);
    pts.push([VX[bb], VY[bb]]);
    let z = null;
    if (flags & 8) { z = new Float32Array(n + 2); for (let j = 0; j < n + 2; j++, o += 2) { const q = dv.getInt16(o, true); z[j] = q === -32768 ? NaN : q / 10; } }
    const cum = [0]; for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
    edges[e] = { a, b: bb, k, cls, oneway: !!(flags & 1), bridge: !!(flags & 2), tunnel: !!(flags & 4), vg: !!(flags & 16), lanes, name, z, pts, cum, L: cum[cum.length - 1] };
    adj[a].push(e); adj[bb].push(e);
    // index every segment in the cells its bounding box touches
    for (let j = 0; j + 1 < pts.length; j++) {
      const x0 = Math.floor(Math.min(pts[j][0], pts[j + 1][0]) / CELL), x1 = Math.floor(Math.max(pts[j][0], pts[j + 1][0]) / CELL);
      const y0 = Math.floor(Math.min(pts[j][1], pts[j + 1][1]) / CELL), y1 = Math.floor(Math.max(pts[j][1], pts[j + 1][1]) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const key = x * 100003 + y; let c = grid.get(key); if (!c) grid.set(key, (c = [])); c.push(e, j); }
    }
  }
  const ok = (k, rail) => (rail ? k === 2 : k !== 2);

  // nearest point on the network (rail: tram rails only); { e, s, x, y, d } or null beyond maxD metres
  function snap(x, y, rail, maxD = 45) {
    let best = null, bd = maxD;
    const r = Math.ceil(maxD / CELL), cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let gx = cx - r; gx <= cx + r; gx++) for (let gy = cy - r; gy <= cy + r; gy++) {
      const c = grid.get(gx * 100003 + gy); if (!c) continue;
      for (let i = 0; i < c.length; i += 2) {
        const E = edges[c[i]]; if (!ok(E.k, rail)) continue;
        const j = c[i + 1], [ax, ay] = E.pts[j], [bx, by] = E.pts[j + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), px = ax + dx * t, py = ay + dy * t, d = Math.hypot(px - x, py - y);
        if (d < bd) { bd = d; const l = Math.sqrt(L2); best = { e: c[i], s: E.cum[j] + t * l, x: px, y: py, d, ux: dx / l, uy: dy / l }; }
      }
    }
    return best;
  }

  // points of edge e between distances s0 and s1 (either order)
  function piece(e, s0, s1) {
    const E = edges[e], out = [], fwd = s1 >= s0, lo = Math.min(s0, s1), hi = Math.max(s0, s1);
    out.push(at(E, lo));
    for (let j = 1; j < E.pts.length - 1; j++) if (E.cum[j] > lo && E.cum[j] < hi) out.push(E.pts[j]);
    out.push(at(E, hi));
    return fwd ? out : out.reverse();
  }
  function at(E, s) {
    let j = 1; while (j < E.cum.length - 1 && E.cum[j] < s) j++;
    const f = Math.max(0, Math.min(1, (s - E.cum[j - 1]) / ((E.cum[j] - E.cum[j - 1]) || 1))), A = E.pts[j - 1], B = E.pts[j];
    return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f];
  }

  // shortest way from snap p to snap q along the network (Dijkstra, bounded by maxLen); polyline [[x, y], ...] or null
  function route(p, q, rail, maxLen) {
    if (p.e === q.e) return piece(p.e, p.s, q.s);
    const dist = new Map(), prev = new Map(), heap = [];
    const push = (v, d, from) => { if (d > maxLen || d >= (dist.get(v) ?? Infinity)) return; dist.set(v, d); prev.set(v, from); heap.push([d, v]); up(heap.length - 1); };
    const up = (i) => { while (i) { const pa = (i - 1) >> 1; if (heap[pa][0] <= heap[i][0]) break; [heap[pa], heap[i]] = [heap[i], heap[pa]]; i = pa; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const P = edges[p.e], Q = edges[q.e];
    push(P.a, p.s, { e: p.e, start: true }); push(P.b, P.L - p.s, { e: p.e, start: true });
    const goal = new Map([[Q.a, q.s], [Q.b, Q.L - q.s]]);
    let best = Infinity, bestV = -1;
    while (heap.length) {
      const [d, v] = pop();
      if (d > (dist.get(v) ?? Infinity) || d >= best) continue;
      if (goal.has(v) && d + goal.get(v) < best) { best = d + goal.get(v); bestV = v; }
      for (const e of adj[v]) {
        const E = edges[e]; if (!ok(E.k, rail) || e === p.e) continue;
        const w = v === E.a ? E.b : E.a;
        push(w, d + E.L, { e, from: v });
      }
    }
    if (bestV < 0) return null;
    // walk back: vertices bestV ← … ← first vertex reached from p's edge
    const chain = []; let v = bestV;
    for (let guard = 0; guard < 5000; guard++) { const pr = prev.get(v); chain.push({ v, ...pr }); if (pr.start) break; v = pr.from; }
    chain.reverse();
    const first = chain[0];
    const path = piece(p.e, p.s, first.v === P.a ? 0 : P.L);
    for (const c of chain.slice(1)) { const E = edges[c.e]; const pts = c.from === E.a ? E.pts : E.pts.slice().reverse(); path.push(...pts.slice(1)); }
    path.push(...piece(q.e, bestV === Q.a ? 0 : Q.L, q.s).slice(1));
    return path;
  }
  // deck height on an authored bridge at distance s along edge e, or NaN off the decks
  function deckAt(e, s) {
    const E = edges[e]; if (!E.z) return NaN;
    let j = 1; while (j < E.cum.length - 1 && E.cum[j] < s) j++;
    const f = Math.max(0, Math.min(1, (s - E.cum[j - 1]) / ((E.cum[j] - E.cum[j - 1]) || 1))), a = E.z[j - 1], b = E.z[j];
    return Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : Number.isFinite(a) ? a : b;
  }
  return { snap, route, deckAt, edges, adj, VX, VY };
}

// arc-length helpers for a polyline
export function measure(path) { const c = [0]; for (let i = 1; i < path.length; i++) c.push(c[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])); return c; }
export function along(path, cum, s, out) {
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const A = path[i - 1], B = path[i] || A, f = Math.max(0, Math.min(1, (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)));
  out.x = A[0] + (B[0] - A[0]) * f; out.y = A[1] + (B[1] - A[1]) * f;
  if (B !== A && (B[0] !== A[0] || B[1] !== A[1])) out.head = Math.atan2(B[0] - A[0], B[1] - A[1]);
  return out;
}
