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
// Expanded 2026-11-24: the whole Pombaline grid, Rua do Crucifixo to Rua da Madalena, Rua do Comércio to Rossio/Figueira.
export const BAIXA_ZONES = [
  [[38.70895, -9.13888], [38.71139, -9.13935], [38.71322, -9.13995], [38.71332, -9.13655], [38.70885, -9.13468]],
  // Rossio and Praça da Figueira: the Pombaline ranges around both squares
  [[38.71322, -9.14002], [38.71520, -9.14062], [38.71522, -9.13868], [38.71458, -9.13850], [38.71452, -9.13660], [38.71332, -9.13650]],
];
// not part of a block: churches, monuments, banks with their own architecture stay procedural/authored
export const notBlock = (t) => ['church', 'cathedral', 'chapel', 'basilica', 'kiosk', 'roof', 'shed', 'hut', 'service', 'train_station'].includes(t.building) || t.amenity === 'place_of_worship' || !!t.historic || t.tourism === 'museum' || t.amenity === 'bank' || t.man_made === 'arch';

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
  w96390844: { h: 17, shape: 'flat', variant: 4, wall: '#eadcbc' },
  w1561006352: { h: 17, shape: 'flat', variant: 4, wall: '#eadcbc' },   // the drum itself
  w481570880: { shape: 'flat', variant: 3, wall: '#6f6b65', flatCol: [139, 160, 104], h: 10 },   // Lisbon cruise terminal (2017): dark concrete block under a planted roof terrace
  // Mercado da Ribeira: the two market halls are walled (OSM maps only their roofs), cream walls with tall openings
  w961075426: { h: 12.5, minH: 0, wall: '#ecdfc2', variant: 4, roofCol: '#c8c4bc', floorH: 6, groundH: 6.5, bayW: 4.2, balconyFloors: [], stone: false },
  w961075427: { h: 12.5, minH: 0, wall: '#ecdfc2', variant: 4, roofCol: '#c8c4bc', floorH: 6, groundH: 6.5, bayW: 4.2, balconyFloors: [], stone: false },
  // Hospital de São José (old Jesuit college of Santo Antão-o-Novo): whitewashed wings under tiled hip roofs
  ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`r8383242_${i}`, { shape: 'hipped', wall: '#efe9dc', roofCol: '#a9614b', variant: 4, stone: false }])),   // Coliseu dos Recreios: drum under an authored metal dome
  // Palácio de São Bento: the untagged parts of the palace are white like the rest
  ...Object.fromEntries(['w1570029244', 'w1570029245', 'w1570029246', 'w1571587396'].map((id) => [id, { wall: '#eee9de', variant: 4 }])),
  // Mosteiro de São Vicente de Fora: white mannerist monastery, tiled hip roofs
  'r3310877_0': { variant: 4, wall: '#f0ece2', roofCol: '#a8624c', stone: false, h: 24, roofH: 5, floorH: 4.6, groundH: 5, bayW: 4.4, balconyFloors: [], parapet: 0 },
  // Castelo de São Jorge, Castelejo: bare crenellated walls and square towers in weathered limestone
  'r19072300_0': { castle: true, stone: true, wall: '#cdbd9f', shape: 'flat', h: 12, floorH: 0, parapet: 0, crenel: true, variant: 5 },
  ...Object.fromEntries(['r19072289_0', 'r19072290_0', 'r19072291_0', 'r19072292_0', 'r19072293_0', 'r19072294_0', 'r19072296_0', 'r19072297_0', 'r19072298_0', 'r19072299_0']
    .map((id, k) => [id, { castle: true, stone: true, wall: '#c9b898', shape: 'flat', h: id === 'r19072289_0' ? 22 : 16 + (k % 3), floorH: 0, parapet: 0, crenel: true, variant: 5 }])),
  // Casa dos Bicos (1523): façade of diamond-pointed stones (shader variant 7), four storeys since the 1983 rebuild
  w96628628: { variant: 7, wall: '#e4ddcc', roofCol: '#a5604b', stone: false, shape: 'hipped', pitch: 24, h: 14.5, roofH: 3, floorH: 3.3, groundH: 4.4, bayW: 3.4, balconyFloors: [], parapet: 0 },
  // Santa Apolónia station: long pale neoclassical front (OSM paints it sky blue), tiled hip roof
  w9254766: { variant: 4, wall: '#eee6d3', roofCol: '#a7654f', stone: false, h: 15, roofH: 3.5, floorH: 4.8, groundH: 5.6, bayW: 3.6, balconyFloors: [1], balconyChance: 0.25, parapet: 0 },
  // Cais do Sodré platform canopy: a tall shelter over the tracks (default 3.5 m would sit on the trains' roofs)
  w636444743: { h: 6.8, minH: 6.1 },
  // Conceição Velha: Manueline church front in white lioz
  w96319788: { wall: '#e6e0d0' },
  // Estação do Rossio (1890): neo-Manueline stone front, its horseshoe portals and clock turret modelled separately
  w96530649: { variant: 4, wall: '#ddd3bd', roofCol: '#8f9194', stone: false, h: 21, roofH: 3, floorH: 4.4, groundH: 6, bayW: 3.2, balconyFloors: [], parapet: 0.8 },
  // Paços do Concelho: neoclassical, pale, with its pedimented centre (portico modelled separately)
  w95417254: { variant: 4, wall: '#efe9dc', roofCol: '#a5644e', stone: false, h: 21, roofH: 3.5, floorH: 5, groundH: 6, bayW: 3.8, balconyFloors: [1], balconyChance: 0.6, parapet: 0 },
  // Palácio Foz (Restauradores): rose-pink palace
  w96188746: { variant: 4, wall: '#e9bfae', roofCol: '#9e5f4c', stone: false, h: 20, roofH: 3.5, floorH: 4.4, groundH: 5, bayW: 3.6, balconyFloors: [1], balconyChance: 0.8, parapet: 0 },
  // Alfândega (Terreiro do Trigo): long four-storey Pombaline-era range under a tiled hip roof
  w96595183: { variant: 0, wall: '#ede2c6', roofCol: '#a3604b', stone: false, shape: 'hipped', h: 18, roofH: 4, floorH: 3.4, groundH: 4.6, bayW: 3.2, balconyFloors: [1], balconyChance: 0.7, parapet: 0 },
  // Cais do Sodré station (1928): white modernist-classical front
  w285355889: { variant: 4, wall: '#eeeae0', roofCol: '#a5644e', stone: false, h: 14, roofH: 3, floorH: 5, groundH: 6.5, bayW: 4, balconyFloors: [], parapet: 0.6 },
  // Teatro Nacional D. Maria II: neoclassical, pale stone, low roof; portico modelled separately
  w77473968: { variant: 4, wall: '#ece5d4', stone: false, shape: 'hipped', pitch: 20, h: 21, roofH: 3.4, floorH: 5.2, groundH: 6, bayW: 4.2, balconyFloors: [], parapet: 0 },
};
// Churches built by parishChurch(): known tower counts, façade ends (+1 = the OBB's +u end) and caps.
// Everything not listed is inferred from the footprint (size → towers, open side → façade).
export const CHURCHES = {
  w96359439: { towers: 2, force: true, H: 24 },   // Basílica da Estrela (cruciform plan; authored dome)
  w96758905: { towers: 2, cap: 'cupola' },          // São Miguel (Alfama): twin towers
  w142915549: { towers: 1, cap: 'cupola' },         // Santo Estêvão
  w96758903: { towers: 0 },                         // Santa Luzia, by the miradouro
  w97476164: { towers: 2 },                         // São Nicolau (Baixa)
  w246085829: { towers: 1, cap: 'spire' },          // Graça: single tall tower beside the church
  w95408993: { towers: 0 },                         // São Domingos: pedimented front, no front towers
  w1350027072: { towers: 0 },                       // São Roque: plain mannerist front
  w96359440: { towers: 2 },                         // Santa Catarina (Paulistas)
  w96359446: { towers: 1 },                         // Loreto (Chiado)
  w96758906: { towers: 1 },                         // Santa Cruz do Castelo
};
// Areas OSM leaves blank that are plainly something on the ground: [id, tags, ring as lat/lon].
export const AREAS = [
  // the castle's south slope below the Castelejo: pines, olives and dirt paths, unmapped in OSM
  ['castle-slope', { natural: 'wood' }, [[38.71356, -9.13435], [38.71356, -9.13372], [38.71332, -9.13350], [38.71266, -9.13370], [38.71231, -9.13305],
    [38.71192, -9.13330], [38.71176, -9.13370], [38.71176, -9.13415], [38.71223, -9.13445], [38.71282, -9.13453], [38.71332, -9.13443]]],
];
// drawn by hand below (or folded into the arcade shader)
export const DROP = new Set(['w41683195', 'w663318739', 'w663311597', 'w663318735',
  'w96301719', 'w115238861', 'w1387011981', 'w663347630', 'w1566332176', 'w678721536', 'w822816252', 'w87891338']);   // … + Cristo Rei (authored)   // + São Bento frontispiece (authored)
 //   // + Carmo church, Santa Justa lift (tower and its base)
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
export function equestrianJose(S, { cx, cy, ground, heading, lin, srgb, plain = false }) {
  const bronze = lin(srgb('#4e5a4b')), bronzeHi = lin(srgb('#66735f')), stone = lin(srgb('#e6dfcf')), shade = lin(srgb('#cfc6b2'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.61, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.61, 1], I0 = [0, 0, 0, 0];
  const fx = Math.sin(heading), fy = Math.cos(heading);   // facing direction (heading 180° = south)
  const F = frame(cx, cy, fy, -fx, ground);               // u = statue's right, v = forward
  // oval stepped platform: four steps
  const steps = plain ? [[6.5, 5.0, 0.4], [5.8, 4.4, 0.8], [5.2, 3.9, 1.4]] : [[12.5, 9.5, 0.35], [11.6, 8.7, 0.7], [10.7, 7.9, 1.05], [9.8, 7.1, 1.4]];
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
  if (!plain) for (const s of [-1, 1]) {
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

// Column of D. Pedro IV, Rossio (Davioud & Robert, 1870): 27.5 m. Stepped base, pedestal with four
// seated virtues, Corinthian shaft, bronze emperor on top.
export function pedroIVColumn(S, { cx, cy, ground, lin, srgb }) {
  const stone = lin(srgb('#e8e1d1')), shade = lin(srgb('#d0c7b3')), bronze = lin(srgb('#4e5a4b'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.23, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.23, 1], I0 = [0, 0, 0, 0];
  const g = ground, P = (z) => [cx, g + z, -cy];
  box(S, cx, cy, 1, 0, 5.2, 5.2, g - 0.5, g + 0.5, shade, I0, ST);
  box(S, cx, cy, 1, 0, 4.5, 4.5, g + 0.5, g + 1.0, stone, I0, ST);
  box(S, cx, cy, 1, 0, 3.0, 3.0, g + 1.0, g + 6.2, stone, I0, ST);
  box(S, cx, cy, 1, 0, 3.3, 3.3, g + 6.2, g + 6.8, shade, I0, ST);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {              // the four virtues at the corners of the base
    const x = cx + dx * 3.6, y = cy + dy * 3.6;
    box(S, x, y, 1, 0, 0.9, 0.9, g + 1.0, g + 1.8, stone, I0, ST);
    limb(S, [x, g + 1.8, -y], [x, g + 3.0, -y], 0.55, 0.42, 8, bronze, PL);
    limb(S, [x, g + 3.0, -y], [x, g + 3.5, -y], 0.2, 0.18, 6, bronze, PL);
  }
  limb(S, P(6.8), P(8.0), 1.25, 1.1, 16, stone, ST);                         // base moulding
  limb(S, P(8.0), P(21.8), 0.95, 0.82, 16, stone, ST);                        // shaft
  limb(S, P(21.8), P(23.2), 0.85, 1.2, 12, shade, ST);                        // capital
  box(S, cx, cy, 1, 0, 1.3, 1.3, g + 23.2, g + 23.8, stone, I0, ST);
  limb(S, P(23.8), P(25.4), 0.5, 0.42, 8, bronze, PL);                        // D. Pedro IV
  limb(S, P(25.4), P(26.6), 0.42, 0.36, 8, bronze, PL);
  limb(S, P(26.6), P(27.4), 0.2, 0.18, 6, bronze, PL);
  limb(S, [cx + 0.3, g + 26.3, -cy], [cx + 0.9, g + 27.1, -cy - 0.2], 0.09, 0.08, 4, bronze, PL);
}

// Rossio's twin bronze fountains (1889): wide stone basin, sculpted base, two bowls, crowning figure.
export function rossioFountain(S, { cx, cy, r, ground, lin, srgb }) {
  const stone = lin(srgb('#ded6c4')), bronze = lin(srgb('#56604f'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.41, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.41, 1], I0 = [0, 0, 0, 0];
  const n = 24, R = Math.max(3.5, r), ring = (rad) => Array.from({ length: n }, (_, k) => [cx + rad * Math.cos((k / n) * Math.PI * 2), cy + rad * Math.sin((k / n) * Math.PI * 2)]);
  const outer = ring(R), inner = ring(R - 0.5);
  for (let k = 0; k < n; k++) {                                                // basin rim: outside, inside, top
    const k2 = (k + 1) % n;
    wallQuad(S, outer[k], outer[k2], ground - 0.3, ground - 0.3, ground + 0.7, ground + 0.7, stone, 0, 1, ground, I0, ST);
    wallQuad(S, inner[k2], inner[k], ground - 0.3, ground - 0.3, ground + 0.7, ground + 0.7, stone, 0, 1, ground, I0, ST);
    triUp(S, [outer[k][0], ground + 0.7, -outer[k][1]], [outer[k2][0], ground + 0.7, -outer[k2][1]], [inner[k2][0], ground + 0.7, -inner[k2][1]], stone, [0, 0], [0, 0], [0, 0], I0, ST);
    triUp(S, [outer[k][0], ground + 0.7, -outer[k][1]], [inner[k2][0], ground + 0.7, -inner[k2][1]], [inner[k][0], ground + 0.7, -inner[k][1]], stone, [0, 0], [0, 0], [0, 0], I0, ST);
  }
  const P = (z) => [cx, ground + z, -cy];
  limb(S, P(0), P(1.8), 1.5, 1.0, 10, bronze, PL);                            // sculpted base (tritons)
  for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + 0.4; limb(S, [cx + Math.cos(a) * 1.6, ground + 0.2, -(cy + Math.sin(a) * 1.6)], [cx + Math.cos(a) * 1.1, ground + 1.6, -(cy + Math.sin(a) * 1.1)], 0.35, 0.25, 6, bronze, PL); }
  limb(S, P(1.8), P(2.4), 0.6, 2.4, 14, bronze, PL);                          // lower bowl
  limb(S, P(2.4), P(4.2), 0.45, 0.35, 8, bronze, PL);
  limb(S, P(4.2), P(4.7), 0.35, 1.3, 12, bronze, PL);                         // upper bowl
  limb(S, P(4.7), P(5.9), 0.3, 0.24, 8, bronze, PL);                          // crowning figure
  limb(S, P(5.9), P(6.3), 0.15, 0.13, 6, bronze, PL);
}

// Neoclassical hexastyle portico with pediment (Teatro D. Maria II), on a façade edge a→b (outward = right).
export function portico(S, { a, b, ground, depth = 6, colH = 11, lin, srgb, statue = true, cols = 6, span = null }) {
  const stone = lin(srgb('#efe8d8')), shade = lin(srgb('#d8cfbc'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.77, 0.9], I0 = [0, 0, 0, 0];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, ox = uy, oy = -ux;
  const W = span ?? Math.min(L * 0.5, 22), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const at = (u, v) => [mx + ux * u + ox * v, my + uy * u + oy * v];
  // stylobate steps
  for (let k = 0; k < 3; k++) { const [x, y] = at(0, depth / 2 + 0.6 - k * 0.5); box(S, x, y, ux, uy, W / 2 + 1.2 - k * 0.4, depth / 2 + 0.6 - k * 0.5, ground - 0.5, ground + 0.4 * (k + 1), shade, I0, ST); }
  const z0 = ground + 1.2;
  for (let k = 0; k < cols; k++) {
    const u = -W / 2 + 1 + (k * (W - 2)) / (cols - 1), [x, y] = at(u, depth - 0.9);
    box(S, x, y, ux, uy, 0.75, 0.75, z0, z0 + 0.6, stone, I0, ST);
    limb(S, [x, z0 + 0.6, -y], [x, z0 + colH, -y], 0.6, 0.52, 12, stone, ST);
    box(S, x, y, ux, uy, 0.75, 0.75, z0 + colH, z0 + colH + 0.5, stone, I0, ST);
  }
  const zE = z0 + colH + 0.5;
  { const [x, y] = at(0, depth / 2); box(S, x, y, ux, uy, W / 2 + 0.3, depth / 2 + 0.2, zE, zE + 1.8, stone, I0, ST); }
  // pediment: triangular prism
  const ph = 4.2, zP = zE + 1.8;
  const A = at(-W / 2 - 0.3, depth + 0.2), B = at(W / 2 + 0.3, depth + 0.2), C = at(0, depth + 0.2);
  const A2 = at(-W / 2 - 0.3, 0), B2 = at(W / 2 + 0.3, 0), C2 = at(0, 0);
  const V = (p, z) => [p[0], z, -p[1]], n = [ox, 0, -oy];
  tri(S, V(A, zP), V(B, zP), V(C, zP + ph), n, stone, [0, 0], [W, 0], [W / 2, ph], I0, ST);
  for (const [p, q, p2, q2] of [[A, C, A2, C2], [C, B, C2, B2]]) {
    const z1 = p === A ? zP : zP + ph, z2 = q === C ? zP + ph : zP;
    const e = [V(p, z1), V(q, z2), V(q2, z2), V(p2, z1)];
    const ex = e[1][0] - e[0][0], ey = e[1][1] - e[0][1], ez = e[1][2] - e[0][2], fx = e[3][0] - e[0][0], fy = e[3][1] - e[0][1], fz = e[3][2] - e[0][2];
    let nn = [ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx]; const l = Math.hypot(...nn); nn = nn.map((v) => v / l); if (nn[1] < 0) nn = nn.map((v) => -v);
    tri(S, e[0], e[1], e[2], nn, shade, [0, 0], [1, 0], [1, 1], I0, ST); tri(S, e[0], e[2], e[3], nn, shade, [0, 0], [1, 1], [0, 1], I0, ST);
  }
  if (statue) { const p = at(0, depth - 0.3); limb(S, [p[0], zP + ph, -p[1]], [p[0], zP + ph + 2.4, -p[1]], 0.4, 0.3, 8, stone, ST); limb(S, [p[0], zP + ph + 2.4, -p[1]], [p[0], zP + ph + 2.9, -p[1]], 0.18, 0.16, 6, stone, ST); }
}

// Local-frame kit for hand-built churches: u along the axis, v to its left, z up from `ground`.
function kit(S, { cx, cy, ux, uy, ground, zb, wall, roof, ST, TL }) {
  const I0 = [0, 0, 0, 0];
  const P2 = (u, v) => [cx + ux * u - uy * v, cy + uy * u + ux * v];
  const W3 = (u, v, z) => { const [x, y] = P2(u, v); return [x, ground + z, -y]; };
  const blk = (u0, u1, v0, v1, z0, z1, col = wall, st = ST) => { const [x, y] = P2((u0 + u1) / 2, (v0 + v1) / 2); box(S, x, y, ux, uy, Math.abs(u1 - u0) / 2, Math.abs(v1 - v0) / 2, ground + z0, ground + z1, col, I0, st); };
  const block = (u0, u1, v0, v1, z1, col = wall) => {            // walls of an axis-aligned block (local), flat top
    const c = [P2(u0, v0), P2(u1, v0), P2(u1, v1), P2(u0, v1)];
    for (let i = 0; i < 4; i++) wallQuad(S, c[i], c[(i + 1) % 4], ground + zb, ground + zb, ground + z1, ground + z1, col, 0, 1, ground, I0, ST);
    triUp(S, W3(u0, v0, z1), W3(u1, v0, z1), W3(u1, v1, z1), col, [0, 0], [0, 0], [0, 0], I0, ST);
    triUp(S, W3(u0, v0, z1), W3(u1, v1, z1), W3(u0, v1, z1), col, [0, 0], [0, 0], [0, 0], I0, ST);
  };
  const crenel = (u0, u1, v0, v1, z, step = 1.7, col = wall) => {  // merlons round a rectangle's rim
    const sides = [[u0, v0, u1, v0], [u1, v0, u1, v1], [u1, v1, u0, v1], [u0, v1, u0, v0]];
    for (const [a0, b0, a1, b1] of sides) {
      const L = Math.hypot(a1 - a0, b1 - b0), n = Math.max(1, Math.floor(L / step));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n, u = a0 + (a1 - a0) * t, v = b0 + (b1 - b0) * t, [x, y] = P2(u, v);
        box(S, x, y, ux, uy, 0.45, 0.45, ground + z, ground + z + 1.2, col, I0, ST);
      }
    }
  };
  const gable = (u0, u1, v0, v1, zE, zR, alongU = true, endCol = wall) => {  // gabled roof over a block (ridge along u or v)
    if (alongU) {
      const vm = (v0 + v1) / 2;
      for (const va of [v0, v1]) {
        const A = W3(u0, va, zE), B = W3(u1, va, zE), C = W3(u1, vm, zR), D = W3(u0, vm, zR);
        triUp(S, A, B, C, roof, [0, 0], [u1 - u0, 0], [u1 - u0, 6], I0, TL); triUp(S, A, C, D, roof, [0, 0], [u1 - u0, 6], [0, 6], I0, TL);
      }
      for (const u of [u0, u1]) { const n = W3(u > u0 ? 1 : -1, 0, 0).map((v, i) => v - W3(0, 0, 0)[i]); tri(S, W3(u, v0, zE), W3(u, v1, zE), W3(u, vm, zR), n, endCol, [0, 0], [1, 0], [0, 1], I0, ST); }
    } else {
      const um = (u0 + u1) / 2;
      for (const ua of [u0, u1]) {
        const A = W3(ua, v0, zE), B = W3(ua, v1, zE), C = W3(um, v1, zR), D = W3(um, v0, zR);
        triUp(S, A, B, C, roof, [0, 0], [v1 - v0, 0], [v1 - v0, 6], I0, TL); triUp(S, A, C, D, roof, [0, 0], [v1 - v0, 6], [0, 6], I0, TL);
      }
      for (const v of [v0, v1]) { const n = W3(0, v > v0 ? 1 : -1, 0).map((x, i) => x - W3(0, 0, 0)[i]); tri(S, W3(u0, v, zE), W3(u1, v, zE), W3(um, v, zR), n, endCol, [0, 0], [1, 0], [0, 1], I0, ST); }
    }
  };
  // pointed (Gothic) arch between springings (u0,v0)→(u1,v1) at height zs: k = radius/span, w thick across, d deep radially
  const arch = (u0, v0, u1, v1, zs, { w = 0.8, d = 0.7, k = 1, n = 5, col = wall, st = ST } = {}) => {
    const A = P2(u0, v0), B = P2(u1, v1), span = Math.hypot(B[0] - A[0], B[1] - A[1]), dx = (B[0] - A[0]) / span, dy = (B[1] - A[1]) / span, px = -dy, py = dx;
    const r = span * k, half = (R) => { const m = Math.acos(Math.min(1, (r - span / 2) / R)); return Array.from({ length: n + 1 }, (_, i) => { const f = (i / n) * m; return [r - R * Math.cos(f), R * Math.sin(f)]; }); };
    const prof = (R) => { const h = half(R); return [...h, ...h.slice(0, -1).reverse().map(([s, z]) => [span - s, z])]; };
    const In = prof(r), Out = prof(r + d);
    const at = ([s, z], t) => [A[0] + dx * s + px * t, ground + zs + z, -(A[1] + dy * s + py * t)];
    const N = [px, 0, -py];
    for (let i = 0; i + 1 < In.length; i++) {
      const a = In[i], b = In[i + 1], c = Out[i + 1], e = Out[i];
      const rad = [(c[0] + e[0] - a[0] - b[0]) / 2, (c[1] + e[1] - a[1] - b[1]) / 2], rl = Math.hypot(...rad) || 1;
      const nOut = [dx * rad[0] / rl, rad[1] / rl, -dy * rad[0] / rl], nIn = nOut.map((x) => -x);
      for (const [p0, p1, nn] of [[e, c, nOut], [a, b, nIn]]) {
        tri(S, at(p0, -w / 2), at(p1, -w / 2), at(p1, w / 2), nn, col, [0, 0], [1, 0], [1, 1], I0, st);
        tri(S, at(p0, -w / 2), at(p1, w / 2), at(p0, w / 2), nn, col, [0, 0], [1, 1], [0, 1], I0, st);
      }
      for (const t of [-w / 2, w / 2]) {
        const nn = t > 0 ? N : N.map((x) => -x);
        tri(S, at(a, t), at(b, t), at(c, t), nn, col, [0, 0], [1, 0], [1, 1], I0, st);
        tri(S, at(a, t), at(c, t), at(e, t), nn, col, [0, 0], [1, 1], [0, 1], I0, st);
      }
    }
    return span * k * Math.sin(Math.acos(Math.min(1, 1 - 1 / (2 * k))));   // apex rise
  };
  return { P2, W3, blk, block, crenel, gable, arch };
}

// Sé de Lisboa (12th c., Romanesque with a Gothic chevet). West front with two crenellated towers,
// rose window and deep portal; three-aisled nave; transept with a crenellated lantern; apse and ambulatory.
// Frame from the OBB of the mapped cathedral parts: u runs west→east along the nave.
export function seCathedral(S, { cx, cy, ux, uy, hl, ground, gmin, lin, srgb }) {
  const stone = lin(srgb('#d8ccb2')), stone2 = lin(srgb('#cbbd9f')), dark = lin(srgb('#3b3a37')), roof = lin(srgb('#a8604a'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.53, 0.9], I0 = [0, 0, 0, 0], TL = [KIND.TILES / 8, 5 / 8, 0.53, 1];
  const zb = gmin - ground - 1.5;
  const { P2, W3, block, crenel, gable } = kit(S, { cx, cy, ux, uy, ground, zb, wall: stone, roof, ST, TL });
  const W = -hl;                                     // west front
  // towers
  for (const s of [-1, 1]) {
    const v0 = s > 0 ? 6 : -16, v1 = s > 0 ? 16 : -6;
    block(W, W + 10, v0, v1, 27.5);
    block(W - 0.3, W + 10.3, v0 - 0.3, v1 + 0.3, 1.0, stone2);                       // plinth
    crenel(W + 0.4, W + 9.6, v0 + 0.4, v1 - 0.4, 27.5);
    for (const v of [v0 + 3, v1 - 3]) { const [x, y] = P2(W - 0.08, v); box(S, x, y, ux, uy, 0.12, 0.8, ground + 20, ground + 24.5, dark, I0, ST); }  // belfry openings
    for (const u of [W + 3, W + 7]) { const [x, y] = P2(u, s > 0 ? v1 + 0.08 : v0 - 0.08); box(S, x, y, ux, uy, 0.8, 0.12, ground + 20, ground + 24.5, dark, I0, ST); }
  }
  // central front: portal and rose window, crenellated
  block(W, W + 10, -6, 6, 22.5);
  crenel(W + 0.4, W + 9.6, -5.6, 5.6, 22.5);
  { const [x, y] = P2(W - 0.6, 0); box(S, x, y, ux, uy, 0.7, 3.4, ground + zb, ground + 9.5, stone2, I0, ST); }       // portal surround
  { const [x, y] = P2(W - 1.25, 0); box(S, x, y, ux, uy, 0.08, 2.0, ground, ground + 7, dark, I0, ST); }              // doors
  limb(S, W3(W - 0.15, 0, 15.5), W3(W - 0.05, 0, 15.5), 2.9, 2.9, 20, stone2, ST);                                     // rose window frame
  limb(S, W3(W - 0.25, 0, 15.5), W3(W - 0.15, 0, 15.5), 2.3, 2.3, 20, dark, ST);
  // nave + aisles
  const nE = hl - 22;
  block(W + 10, nE, -7, 7, 17.5); gable(W + 10, nE, -7.4, 7.4, 17.5, 22.5);
  for (const s of [-1, 1]) {
    const v0 = s > 0 ? 7 : -12, v1 = s > 0 ? 12 : -7;
    block(W + 10, nE, v0, v1, 11);
    const vi = s > 0 ? v0 : v1, vo = s > 0 ? v1 + 0.4 : v0 - 0.4;  // lean-to roof
    triUp(S, W3(W + 10, vo, 11), W3(nE, vo, 11), W3(nE, vi, 13.2), roof, [0, 0], [1, 0], [0, 1], I0, TL);
    triUp(S, W3(W + 10, vo, 11), W3(nE, vi, 13.2), W3(W + 10, vi, 13.2), roof, [0, 0], [1, 0], [0, 1], I0, TL);
    for (let u = W + 13; u < nE - 1; u += 4.5) { const [x, y] = P2(u, s > 0 ? v1 + 0.06 : v0 - 0.06); box(S, x, y, ux, uy, 0.45, 0.1, ground + 4, ground + 8, dark, I0, ST); }   // aisle windows
    for (let u = W + 13; u < nE - 1; u += 4.5) { const [x, y] = P2(u, s > 0 ? 7.06 : -7.06); box(S, x, y, ux, uy, 0.4, 0.1, ground + 13.8, ground + 16.4, dark, I0, ST); }  // clerestory
  }
  // transept and crossing lantern
  block(nE - 10, nE, -16, 16, 17.5); gable(nE - 10, nE, -16.4, 16.4, 17.5, 22, false);
  block(nE - 9.5, nE - 0.5, -4.5, 4.5, 27); crenel(nE - 9.1, nE - 0.9, -4.1, 4.1, 27);
  for (const s of [-1, 1]) { const [x, y] = P2(nE - 5, s * 4.56); box(S, x, y, ux, uy, 1.4, 0.1, ground + 21.5, ground + 25, dark, I0, ST); }
  // apse + ambulatory: half-polygons around (nE, 0)
  const semi = (r, z1, zr, col) => {
    const n = 10, pts = Array.from({ length: n + 1 }, (_, k) => { const a = -Math.PI / 2 + (k / n) * Math.PI; return [nE + Math.cos(a) * r, Math.sin(a) * r]; });
    for (let k = 0; k < n; k++) {
      const a = P2(...pts[k + 1]), b = P2(...pts[k]);
      wallQuad(S, b, a, ground + zb, ground + zb, ground + z1, ground + z1, col, 0, 1, ground, I0, ST);
      triUp(S, W3(...pts[k], z1), W3(...pts[k + 1], z1), W3(nE, 0, zr), roof, [0, 0], [1, 0], [0, 1], I0, TL);
    }
  };
  semi(13, 10.5, 13, stone2);
  semi(8, 17.5, 22.5, stone);
  for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + ((k + 0.5) / 5) * Math.PI; const [x, y] = P2(nE + Math.cos(a) * 13.1, Math.sin(a) * 13.1); box(S, x, y, Math.cos(a) * ux - Math.sin(a) * uy, Math.cos(a) * uy + Math.sin(a) * ux, 0.1, 0.45, ground + 3.5, ground + 7.5, dark, I0, ST); }
  // buttresses along the aisles
  for (const s of [-1, 1]) for (let u = W + 11; u < nE; u += 4.5) { const [x, y] = P2(u + 2.25, s * 12.6); box(S, x, y, ux, uy, 0.5, 0.6, ground + zb, ground + 9, stone2, I0, ST); }
}

// Panteão Nacional (Santa Engrácia): white baroque Greek cross with undulating arms, four corner
// towers, a tall drum and dome with lantern (~80 m above the street on the slope; ~62 m to the cross).
export function panteao(S, { cx, cy, ux, uy, ground, gmin, lin, srgb }) {
  const white = lin(srgb('#f1eee6')), trim = lin(srgb('#ddd6c6')), dark = lin(srgb('#3d3d3b')), domeC = lin(srgb('#e9e5dc'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.67, 0.9], I0 = [0, 0, 0, 0];
  const P2 = (u, v) => [cx + ux * u - uy * v, cy + uy * u + ux * v];
  const zb = gmin - ground - 1.5;
  const blk = (u, v, hu, hv, z0, z1, col = white) => { const [x, y] = P2(u, v); box(S, x, y, ux, uy, hu, hv, ground + z0, ground + z1, col, I0, ST); };
  // cross arms and core
  blk(0, 0, 27, 10.5, zb, 24); blk(0, 0, 10.5, 23, zb, 24); blk(0, 0, 15, 15, zb, 24);
  blk(0, 0, 27.4, 10.9, 24, 25.2, trim); blk(0, 0, 10.9, 23.4, 24, 25.2, trim);       // cornice
  for (const [u, v] of [[27, 0], [-27, 0], [0, 23], [0, -23]]) {                    // arm ends: pediment-like attics + doors
    const along = u !== 0;
    blk(u * 0.98, v * 0.98, along ? 0.6 : 6, along ? 6 : 0.6, 25.2, 28.5, white);
    blk(u * 1.005, v * 1.005, along ? 0.1 : 1.6, along ? 1.6 : 0.1, 0, 6.5, dark);
    for (const z of [9, 15.5]) for (const o of [-4, 0, 4]) blk(u * 1.005 + (along ? 0 : o), v * 1.005 + (along ? o : 0), along ? 0.1 : 0.7, along ? 0.7 : 0.1, z, z + 3.2, dark);
  }
  for (const su of [-1, 1]) for (const sv of [-1, 1]) {                             // corner towers with small cupolas
    blk(su * 17, sv * 15.5, 4.5, 4.5, zb, 31); blk(su * 17, sv * 15.5, 4.9, 4.9, 31, 32, trim);
    const [x, y] = P2(su * 17, sv * 15.5);
    limb(S, [x, ground + 32, -y], [x, ground + 35.5, -y], 3.4, 0.6, 12, domeC, ST);
    limb(S, [x, ground + 35.5, -y], [x, ground + 37, -y], 0.3, 0.15, 6, white, ST);
  }
  // drum, dome and lantern
  const c = [cx, 0, -cy], at = (z) => [cx, ground + z, -cy];
  limb(S, at(24), at(28), 14, 14, 24, white, ST);
  limb(S, at(28), at(40), 12.5, 12.5, 24, white, ST);
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2, x = cx + Math.cos(a) * 12.6, y = cy + Math.sin(a) * 12.6; box(S, x, y, -Math.sin(a), Math.cos(a), 0.9, 0.1, ground + 31, ground + 37, dark, I0, ST); }
  limb(S, at(40), at(41.2), 13.3, 13.3, 24, trim, ST);
  const rings = 6;
  for (let k = 0; k < rings; k++) {                                                   // dome as a stack of frusta
    const a0 = (k / rings) * Math.PI / 2, a1 = ((k + 1) / rings) * Math.PI / 2;
    limb(S, at(41.2 + Math.sin(a0) * 15), at(41.2 + Math.sin(a1) * 15), Math.max(0.3, Math.cos(a0) * 12.5), Math.max(2.2, Math.cos(a1) * 12.5), 24, domeC, ST, k === rings - 1);
  }
  limb(S, at(55.5), at(62), 2.2, 1.8, 12, white, ST);                                 // lantern
  limb(S, at(62), at(64.5), 1.9, 0.2, 12, domeC, ST);
  limb(S, at(64.5), at(66.5), 0.12, 0.12, 4, dark, ST);
  void c;
}

// box with an underside too (decks and bridges are seen from the street)
function slab(S, x, y, ux, uy, hu, hv, z0, z1, col, st) {
  const I0 = [0, 0, 0, 0];
  box(S, x, y, ux, uy, hu, hv, z0, z1, col, I0, st);
  const c = [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]].map(([a, b]) => [x + ux * a - uy * b, z0, -(y + uy * a + ux * b)]);
  tri(S, c[0], c[2], c[1], [0, -1, 0], col, [0, 0], [1, 1], [1, 0], I0, st);
  tri(S, c[0], c[3], c[2], [0, -1, 0], col, [0, 0], [0, 1], [1, 1], I0, st);
}

// Convento do Carmo (1389; roofless since the 1755 earthquake). Local frame from the mapped church:
// u from the west front (u=-39) to the apse (u≈39), v across (nave walls at ±12). The nave is open to
// the sky: clustered piers, tall pointed transverse arches and arcades; the chancel and apse chapels
// are roofed (the archaeological museum). Floor at zf (above the sampled terrain).
export function carmoRuins(S, { cx, cy, ux, uy, ground, gmin, zf, lin, srgb }) {
  const stone = lin(srgb('#d5cab0')), stone2 = lin(srgb('#c3b697')), dark = lin(srgb('#34332f')), roof = lin(srgb('#a45f4b')), floor = lin(srgb('#b0a687')), grass = lin(srgb('#8f9466'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.41, 0.9], TL = [KIND.TILES / 8, 5 / 8, 0.41, 1], PL = [KIND.PLAIN / 8, 5 / 8, 0.41, 1], I0 = [0, 0, 0, 0];
  const zb = gmin - ground - 1.5;
  const K = kit(S, { cx, cy, ux, uy, ground, zb, wall: stone, roof, ST, TL });
  const { W3, blk, block, gable, arch } = K;
  const quad = (u0, u1, v0, v1, z, col) => { triUp(S, W3(u0, v0, z), W3(u1, v0, z), W3(u1, v1, z), col, [0, 0], [1, 0], [1, 1], I0, PL); triUp(S, W3(u0, v0, z), W3(u1, v1, z), W3(u0, v1, z), col, [0, 0], [1, 1], [0, 1], I0, PL); };
  // nave floor: gravel with a lawn down the middle
  quad(-37.8, 9, -11.1, 11.3, zf, floor);
  quad(-36, 7, -4.4, 4.4, zf + 0.04, grass);
  // side walls, buttresses, lancets
  blk(-39, 9, -12.3, -11.1, zb, 17); blk(-39, 9, 11.3, 12.5, zb, 17);
  for (const u of [-28.1, -18.85, -9.6]) { blk(u - 0.7, u + 0.7, -13.8, -12.3, zb, 13.5); blk(u - 0.55, u + 0.55, -13.2, -12.3, 13.5, 15.2); }
  for (const u of [-33.4, -23.5, -14.2, -5]) for (const [v0, v1] of [[-12.36, -12.3], [-11.1, -11.04], [11.24, 11.3]]) blk(u - 0.8, u + 0.8, v0, v1, zf + 6.5, zf + 13.5, dark);
  // west front: porch with archivolts, rose window opening
  blk(-39, -37.8, -12.3, 12.5, zb, 20.5); blk(-39, -37.8, -5.5, 6.5, 20.5, 23);
  blk(-40.2, -39, -4.7, 6.9, zb, zf + 13.5);
  blk(-40.32, -40.2, -0.7, 2.9, zf, zf + 6.6, dark);
  for (let k = 0; k < 3; k++) arch(-40.35 - k * 0.05, -1.1 - k * 0.6, -40.35 - k * 0.05, 3.3 + k * 0.6, zf + 6.3, { w: 0.3, d: 0.35, k: 1, n: 4, col: k % 2 ? stone : stone2 });
  limb(S, W3(-39.17, 1, 17.2), W3(-39.0, 1, 17.2), 3.1, 3.1, 16, stone2, ST);
  limb(S, W3(-39.27, 1, 17.2), W3(-39.15, 1, 17.2), 2.5, 2.5, 16, dark, ST);
  // piers and arches: the nave skeleton
  const piers = [-28.1, -18.85, -9.6, -0.35], line = [-37.3, ...piers, 8.5];
  for (const u of line) for (const v of [-5.4, 5.4]) {
    limb(S, W3(u, v, zf), W3(u, v, 11), 0.85, 0.85, 8, stone, ST);
    limb(S, W3(u, v, 11), W3(u, v, 11.6), 1.05, 1.05, 8, stone2, ST);
  }
  for (const v of [-5.4, 5.4]) for (let i = 0; i + 1 < line.length; i++) arch(line[i], v, line[i + 1], v, 11.6, { w: 0.9, d: 0.8 });
  for (const u of piers) {
    arch(u, -5.4, u, 5.4, 11.6, { w: 0.8, d: 0.75 });
    arch(u, -11.1, u, -5.4, 8.2, { w: 0.6, d: 0.5, k: 0.8, n: 4 });
    arch(u, 5.4, u, 11.3, 8.2, { w: 0.6, d: 0.5, k: 0.8, n: 4 });
  }
  // roofed chancel (museum) with chancel arch towards the nave
  block(9, 30.6, -9.4, 11, 20); gable(8.7, 30.6, -9.8, 11.4, 20, 25.5);
  for (const u of [13.5, 19, 24.5]) for (const [v0, v1] of [[-9.46, -9.4], [11, 11.06]]) blk(u - 0.7, u + 0.7, v0, v1, 9, 16.5, dark);
  blk(9, 30.6, -9.55, 11.15, 18.6, 19.1, stone2);
  blk(8.85, 9.0, -3.4, 4.6, zf, zf + 13, dark);
  arch(8.82, -3.8, 8.82, 5.0, zf + 12.4, { w: 0.35, d: 0.6, k: 1, n: 4, col: stone2 });
  // polygonal apse with buttresses
  const ac = [30.6, 0.8], ar = 8.6, np = 5;
  const pts = Array.from({ length: np + 1 }, (_, k) => { const a = -Math.PI / 2 + (k / np) * Math.PI; return [ac[0] + Math.cos(a) * ar, ac[1] + Math.sin(a) * ar]; });
  for (let k = 0; k < np; k++) {
    wallQuad(S, K.P2(...pts[k]), K.P2(...pts[k + 1]), ground + zb, ground + zb, ground + 20, ground + 20, stone, 0, 1, ground, I0, ST);
    triUp(S, W3(...pts[k], 20), W3(...pts[k + 1], 20), W3(ac[0], ac[1], 24.5), roof, [0, 0], [1, 0], [0, 1], I0, TL);
    const m = [(pts[k][0] + pts[k + 1][0]) / 2 - ac[0], (pts[k][1] + pts[k + 1][1]) / 2 - ac[1]], ml = Math.hypot(...m);
    const wpt = K.P2(ac[0] + m[0] / ml * (ar * Math.cos(Math.PI / 10) + 0.06), ac[1] + m[1] / ml * (ar * Math.cos(Math.PI / 10) + 0.06));
    const dU = [(ux * m[0] - uy * m[1]) / ml, (uy * m[0] + ux * m[1]) / ml];
    box(S, wpt[0], wpt[1], -dU[1], dU[0], 0.45, 0.08, ground + zf + 5, ground + zf + 12, dark, I0, ST);
  }
  for (let k = 1; k < np; k++) { const a = -Math.PI / 2 + (k / np) * Math.PI, d = [Math.cos(a), Math.sin(a)], [x, y] = K.P2(ac[0] + d[0] * (ar + 0.5), ac[1] + d[1] * (ar + 0.5)); box(S, x, y, ux * d[0] - uy * d[1], uy * d[0] + ux * d[1], 0.9, 0.5, ground + zb, ground + 17, stone2, I0, ST); }
  // side ranges: south chapels, north sacristy range and annex, terrace to the lift walkway
  block(0.4, 20.3, -17.3, -12.3, 12); gable(0.1, 20.6, -17.6, -12.0, 12, 14.6);
  block(9, 20.3, -12.3, -9.4, 13);
  block(9, 30.9, 11, 21.9, 15); gable(8.7, 31.2, 10.7, 22.2, 15, 19.2);
  block(18, 28, 21.9, 27.3, 12); gable(17.7, 28.3, 21.9, 27.6, 12, 14.4);
  blk(18.9, 20.4, -29.4, -17.3, zb, zf, stone2);
}

// Elevador de Santa Justa (Raoul Mesnier du Ponsard, 1902): neo-Gothic iron tower, 45 m. Shaft of
// pointed-arch panels over two cabins, a deck where the walkway leaves for Largo do Carmo, an upper
// gallery, and the top viewing platform with its kiosk and spiral stair turret.
export function santaJustaLift(S, { cx, cy, ux, uy, hu, hv, ground, zWalk, bridge, lin, srgb }) {
  const zDeck = zWalk - 0.5;
  const iron = lin(srgb('#74777a')), ironD = lin(srgb('#5a5d60')), core = lin(srgb('#3b3f43')), plinth = lin(srgb('#cfc6b3'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.29, 0.9], I0 = [0, 0, 0, 0];
  const K = kit(S, { cx, cy, ux, uy, ground, zb: -1.5, wall: iron, roof: iron, ST, TL: ST });
  const { P2, W3, blk, arch } = K;
  blk(-hu - 0.4, hu + 0.4, -hv - 0.4, hv + 0.4, -1.5, 1.2, plinth);
  // the openwork shell: dark core, corner posts, bays of pointed arches, bands
  const shell = (z0, z1, a, b, bu, bv, lvl) => {
    blk(-a + 0.35, a - 0.35, -b + 0.35, b - 0.35, z0, z1, core);
    for (const su of [-1, 1]) for (const sv of [-1, 1]) blk(su * a - 0.3, su * a + 0.3, sv * b - 0.3, sv * b + 0.3, z0, z1 + 0.3, iron);
    const n = Math.max(1, Math.round((z1 - z0) / lvl)), lh = (z1 - z0) / n;
    for (let l = 0; l <= n; l++) blk(-a - 0.08, a + 0.08, -b - 0.08, b + 0.08, z0 + l * lh - 0.18, z0 + l * lh + 0.18, iron);
    for (let l = 0; l < n; l++) {
      const zs = z0 + l * lh + lh * 0.38;
      for (const sv of [-1, 1]) for (let k = 0; k < bu; k++) {
        const u0 = -a + (2 * a) * k / bu, u1 = -a + (2 * a) * (k + 1) / bu;
        if (k) blk(u0 - 0.07, u0 + 0.07, sv * b - 0.1, sv * b + 0.1, z0 + l * lh, z0 + (l + 1) * lh, ironD);
        arch(u0 + 0.12, sv * (b + 0.02), u1 - 0.12, sv * (b + 0.02), zs, { w: 0.14, d: 0.16, n: 3, col: iron });
      }
      for (const su of [-1, 1]) for (let k = 0; k < bv; k++) {
        const v0 = -b + (2 * b) * k / bv, v1 = -b + (2 * b) * (k + 1) / bv;
        if (k) blk(su * a - 0.1, su * a + 0.1, v0 - 0.07, v0 + 0.07, z0 + l * lh, z0 + (l + 1) * lh, ironD);
        arch(su * (a + 0.02), v0 + 0.12, su * (a + 0.02), v1 - 0.12, zs, { w: 0.14, d: 0.16, n: 3, col: iron });
      }
    }
  };
  shell(1.2, zDeck, hu, hv, 3, 2, 4.4);
  // deck where the walkway leaves, with railing
  const rail = (z, a, b) => { for (const s of [-1, 1]) { blk(-a, a, s * b - 0.05, s * b + 0.05, z, z + 1.1, ironD); blk(s * a - 0.05, s * a + 0.05, -b, b, z, z + 1.1, ironD); } };
  { const [x, y] = P2(0, 0); slab(S, x, y, ux, uy, hu + 0.9, hv + 0.9, ground + zDeck, ground + zDeck + 0.5, ironD, ST); }
  rail(zDeck + 0.5, hu + 0.85, hv + 0.85);
  // upper gallery and top platform
  shell(zDeck + 0.5, zDeck + 6, hu - 0.3, hv - 0.3, 2, 2, 5.5);
  { const [x, y] = P2(0, 0); slab(S, x, y, ux, uy, hu + 0.2, hv + 0.2, ground + zDeck + 6, ground + zDeck + 6.45, ironD, ST); }
  rail(zDeck + 6.45, hu + 0.15, hv + 0.15);
  blk(-1.9, 1.9, -1.5, 1.5, zDeck + 6.45, zDeck + 9.6, core);
  for (const su of [-1, 1]) for (const sv of [-1, 1]) blk(su * 1.9 - 0.15, su * 1.9 + 0.15, sv * 1.5 - 0.15, sv * 1.5 + 0.15, zDeck + 6.45, zDeck + 9.7, iron);
  limb(S, W3(0, 0, zDeck + 9.6), W3(0, 0, zDeck + 11.6), 2.7, 0.25, 4, iron, ST);
  limb(S, W3(-hu + 1.3, 0, zDeck + 6.45), W3(-hu + 1.3, 0, zDeck + 10.2), 0.95, 0.95, 10, iron, ST);
  limb(S, W3(-hu + 1.3, 0, zDeck + 10.2), W3(-hu + 1.3, 0, zDeck + 11.4), 1.05, 0.15, 10, ironD, ST);
  // walkway to Largo do Carmo: lattice girders either side of a deck
  if (bridge) {
    const s = Math.sign((bridge[0] - cx) * ux + (bridge[1] - cy) * uy) || -1;
    const [ax, ay] = P2(s * (hu + 0.9), 0), L = Math.hypot(bridge[0] - ax, bridge[1] - ay), bx = (bridge[0] - ax) / L, by = (bridge[1] - ay) / L;
    const mx = (ax + bridge[0]) / 2, my = (ay + bridge[1]) / 2, g = ground + zWalk;
    slab(S, mx, my, bx, by, L / 2, 1.4, g - 0.4, g, ironD, ST);
    for (const sv of [-1, 1]) {
      const [x, y] = [mx - by * sv * 1.35, my + bx * sv * 1.35];
      slab(S, x, y, bx, by, L / 2, 0.12, g - 2.2, g + 1.5, core, ST);
      box(S, x, y, bx, by, L / 2, 0.18, g + 1.4, g + 1.65, iron, I0, ST);
      slab(S, x, y, bx, by, L / 2, 0.18, g - 2.4, g - 2.1, iron, ST);
      const n = Math.max(2, Math.round(L / 2.2));
      for (let k = 0; k <= n; k++) { const t = -L / 2 + (L * k) / n; box(S, x + bx * t, y + by * t, bx, by, 0.09, 0.2, g - 2.2, g + 1.4, iron, I0, ST); }
    }
  }
}

// Cais das Colunas: marble steps into the Tagus from Praça do Comércio, guarded by two columns.
// a = river end of the steps, b = the square end.
export function caisColunas(S, { a, b, ground, lin, srgb }) {
  const marble = lin(srgb('#e9e3d4')), wet = lin(srgb('#9d998c')), ST = [KIND.STONE / 8, 5 / 8, 0.77, 0.9], I0 = [0, 0, 0, 0];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const P = (u, v) => [a[0] + ux * u - uy * v, a[1] + uy * u + ux * v];
  const n = 9, run = 0.75, top = ground;             // the flight: from the quay down past the waterline
  for (let k = 0; k < n; k++) {
    const z1 = top - (k + 1) * (top + 0.9) / n, [x, y] = P(n * run - (k + 0.5) * run, 0);
    box(S, x, y, ux, uy, run / 2, 7.5, -3, z1 + 0.18, z1 < 0.2 ? wet : marble, I0, ST);
  }
  for (const v of [-5.2, 5.2]) {
    const [x, y] = P(n * run + 1.2, v);
    box(S, x, y, ux, uy, 0.85, 0.85, -1, top + 1.3, marble, I0, ST);
    limb(S, [x, top + 1.3, -y], [x, top + 1.6, -y], 0.62, 0.55, 12, marble, ST);
    limb(S, [x, top + 1.6, -y], [x, top + 6.4, -y], 0.45, 0.4, 12, marble, ST);
    box(S, x, y, ux, uy, 0.62, 0.62, top + 6.4, top + 6.9, marble, I0, ST);
    limb(S, [x, top + 6.9, -y], [x, top + 7.6, -y], 0.35, 0.12, 8, marble, ST);
  }
}

// Lisbon parish church, built from its mapped footprint's OBB: whitewashed nave under a tiled gable,
// lioz pilasters and cornice, a pedimented front with portal and choir window, bell towers at the
// front corners (0, 1 or 2) with stone cupolas or tiled spires, a lower chancel and sacristies behind.
// The façade is at u = -hl (callers flip the axis so it faces the open street or square).
export function parishChurch(S, { cx, cy, ux, uy, hl, hw, ground, gmin, H, towers = 0, towerSide = 1, cap = 'cupola', wall, roofHex, lin, srgb, seed = 0.5 }) {
  const white = lin(srgb(wall || '#f1ede4')), stone = lin(srgb('#d6cdb9')), dark = lin(srgb('#36373a')), roof = lin(srgb(roofHex || '#a85e47'));
  const ST = [KIND.STONE / 8, 5 / 8, seed, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, seed, 1], TL = [KIND.TILES / 8, 5 / 8, seed, 1], I0 = [0, 0, 0, 0];
  const zb = gmin - ground - 1.5;
  const K = kit(S, { cx, cy, ux, uy, ground, zb, wall: white, roof, ST: PL, TL });
  const { W3, blk, block, gable } = K;
  const F = -hl, tw = Math.min(3.6, Math.max(2.2, hw * 0.42)), Tt = Math.min(11, Math.max(6, tw * 2.8));
  const chL = Math.min(hl * 0.32, hw * 1.1), hc = hw * 0.68, back = hl - chL;
  // nave
  block(F, back, -hw, hw, H); gable(F, back, -hw - 0.3, hw + 0.3, H, H + hw * 0.55);
  blk(F - 0.12, back + 0.12, -hw - 0.15, hw + 0.15, H - 0.55, H, stone, ST);
  for (const sv of [-1, 1]) {
    for (let u = F + 0.4; u <= back - 0.3; u += Math.max(4, (back - F - 0.8) / Math.max(1, Math.round((back - F) / 6)))) blk(u - 0.3, u + 0.3, sv * hw - 0.12, sv * hw + 0.12, zb, H - 0.55, stone, ST);
    for (let u = F + 5; u < back - 2; u += 5.5) blk(u - 0.55, u + 0.55, sv * (hw + 0.04) - 0.02, sv * (hw + 0.04) + 0.02, H * 0.5, H * 0.5 + Math.min(3.2, H * 0.28), dark, ST);
  }
  // chancel and sacristies
  block(back, hl, -hc, hc, H * 0.86); gable(back - 0.3, hl, -hc - 0.3, hc + 0.3, H * 0.86, H * 0.86 + hc * 0.55);
  for (const sv of [-1, 1]) { block(back, hl, sv > 0 ? hc : -hw, sv > 0 ? hw : -hc, H * 0.5); gable(back, hl + 0.2, sv > 0 ? hc : -hw - 0.2, sv > 0 ? hw + 0.2 : -hc, H * 0.5, H * 0.5 + (hw - hc) * 0.5); }
  // front: pediment, portal, choir window
  const fw = towers === 2 ? hw - 2 * tw + 0.2 : hw, fc = towers === 1 ? -towerSide * tw : 0;
  const pedH = H + Math.max(hw * 0.55, 2) + 1.0;
  tri(S, W3(F - 0.06, fc - fw, H - 0.6), W3(F - 0.06, fc + fw, H - 0.6), W3(F - 0.06, fc, pedH + 0.35), W3(-1, 0, 0).map((v, i) => v - W3(0, 0, 0)[i]), stone, [0, 0], [1, 0], [0, 1], I0, ST);
  tri(S, W3(F - 0.12, fc - fw + 0.7, H - 0.1), W3(F - 0.12, fc + fw - 0.7, H - 0.1), W3(F - 0.12, fc, pedH - 0.45), W3(-1, 0, 0).map((v, i) => v - W3(0, 0, 0)[i]), white, [0, 0], [1, 0], [0, 1], I0, PL);
  blk(F - 0.1, F, fc - fw, fc + fw, H - 0.6, H - 0.1, stone, ST);
  const dw = Math.min(1.3, hw * 0.2), dh = Math.min(5, H * 0.38);
  blk(F - 0.12, F, fc - dw - 0.45, fc + dw + 0.45, 0, dh + 0.7, stone, ST);
  blk(F - 0.18, F - 0.1, fc - dw, fc + dw, 0, dh, dark, ST);
  if (H > 10) { blk(F - 0.1, F, fc - 0.95, fc + 0.95, dh + 2.0, dh + 4.6, stone, ST); blk(F - 0.16, F - 0.08, fc - 0.65, fc + 0.65, dh + 2.3, dh + 4.3, dark, ST); }
  // bell towers
  const tv = towers === 2 ? [-1, 1] : towers === 1 ? [towerSide] : [];
  for (const sv of tv) {
    const vc = sv * (hw - tw), u0 = F, u1 = F + 2 * tw, top = H + Tt;
    blk(u0, u1, vc - tw, vc + tw, zb, top, white);
    for (const [a, b] of [[u0, vc - tw], [u1, vc - tw], [u0, vc + tw], [u1, vc + tw]]) blk(a - 0.25, a + 0.25, b - 0.25, b + 0.25, zb, top, stone, ST);
    for (const z of [H - 0.55, top - 0.5]) blk(u0 - 0.2, u1 + 0.2, vc - tw - 0.2, vc + tw + 0.2, z, z + 0.55, stone, ST);
    const bz0 = top - 4.2, bz1 = top - 1.0, bo = Math.min(0.7, tw * 0.3);
    blk(u0 - 0.06, u0 - 0.02, vc - bo, vc + bo, bz0, bz1, dark, ST); blk(u1 + 0.02, u1 + 0.06, vc - bo, vc + bo, bz0, bz1, dark, ST);
    blk((u0 + u1) / 2 - bo, (u0 + u1) / 2 + bo, vc - tw - 0.06, vc - tw - 0.02, bz0, bz1, dark, ST); blk((u0 + u1) / 2 - bo, (u0 + u1) / 2 + bo, vc + tw + 0.02, vc + tw + 0.06, bz0, bz1, dark, ST);
    const c = W3((u0 + u1) / 2, vc, 0), at = (z) => [c[0], ground + z, c[2]];
    if (cap === 'spire') limb(S, at(top), at(top + tw * 2.2), tw * 1.25, 0.08, 4, roof, TL);
    else {
      limb(S, at(top), at(top + 0.7), tw * 0.95, tw * 0.95, 8, stone, ST);
      limb(S, at(top + 0.7), at(top + 0.7 + tw * 0.8), tw * 0.95, tw * 0.45, 8, white, PL);
      limb(S, at(top + 0.7 + tw * 0.8), at(top + 0.7 + tw * 1.4), tw * 0.45, 0.1, 8, stone, ST);
    }
    limb(S, at(top + (cap === 'spire' ? tw * 2.2 : 0.7 + tw * 1.4)), at(top + (cap === 'spire' ? tw * 2.2 : 0.7 + tw * 1.4) + 1.2), 0.06, 0.06, 4, dark, ST);
  }
  if (!tv.length) {   // bell gable over the pediment
    blk(F - 0.05, F + 0.5, fc - 0.9, fc + 0.9, pedH - 0.6, pedH + 2.0, white);
    blk(F - 0.1, F, fc - 0.45, fc + 0.45, pedH + 0.3, pedH + 1.6, dark, ST);
  }
}

// Lisbon's yellow trams (Remodelado, line 28) and funicular cars: a body laid along the track from
// back (x0,y0,z0) to front (x1,y1,z1), following its slope. Yellow skirt and roof band, dark window
// band with pillars, white roof, trolley pole.
export function tramCar(S, { x0, y0, z0, x1, y1, z1, lin, srgb, funicular = false, seed = 0 }) {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, dx = (x1 - x0) / L, dy = (y1 - y0) / L, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const yellow = lin(srgb('#f1bf1c')), cream = lin(srgb('#efe8d6')), glass = lin(srgb('#2d3238')), skirt = lin(srgb('#3a3b3d')), roofC = lin(srgb('#d9d6cf'));
  const PL = [KIND.PLAIN / 8, 5 / 8, seed, 1], I0 = [0, 0, 0, 0], hw = funicular ? 1.25 : 1.15;
  const Q = (u, v, z) => [mx + dx * u - dy * v, (z0 + z1) / 2 + (z1 - z0) * (u / L) + z, -(my + dy * u + dx * v)];
  const cub = (u0, u1, v0, v1, za, zb, col) => {
    const c = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], sl = (z1 - z0) / L;
    for (let i = 0; i < 4; i++) {
      const [ua, va] = c[i], [ub, vb] = c[(i + 1) % 4], n = [(vb - va) * dx + (ua - ub) * -dy, 0, -((vb - va) * dy + (ua - ub) * dx)], l = Math.hypot(...n) || 1;
      const nn = n.map((x) => x / l);
      tri(S, Q(ua, va, za), Q(ub, vb, za), Q(ub, vb, zb), nn, col, [0, 0], [1, 0], [1, 1], I0, PL);
      tri(S, Q(ua, va, za), Q(ub, vb, zb), Q(ua, va, zb), nn, col, [0, 0], [1, 1], [0, 1], I0, PL);
    }
    const up = [-dx * sl, 1, dy * sl], ul = Math.hypot(...up), nu = up.map((x) => x / ul);
    tri(S, Q(u0, v0, zb), Q(u1, v0, zb), Q(u1, v1, zb), nu, col, [0, 0], [1, 0], [1, 1], I0, PL);
    tri(S, Q(u0, v0, zb), Q(u1, v1, zb), Q(u0, v1, zb), nu, col, [0, 0], [1, 1], [0, 1], I0, PL);
  };
  const h = L / 2;
  cub(-h + 0.6, h - 0.6, -hw + 0.15, hw - 0.15, 0.15, 0.45, skirt);
  cub(-h, h, -hw, hw, 0.45, 1.35, yellow);
  cub(-h + 0.05, h - 0.05, -hw + 0.04, hw - 0.04, 1.35, 2.35, glass);
  const nP = Math.max(3, Math.round(L / 1.3));
  for (let k = 0; k <= nP; k++) { const u = -h + 0.2 + (L - 0.4) * k / nP; for (const s of [-1, 1]) cub(u - 0.12, u + 0.12, s * hw - 0.03 * s - 0.05, s * hw - 0.03 * s + 0.05, 1.35, 2.35, yellow); }
  cub(-h, h, -hw, hw, 2.35, 2.75, yellow);
  cub(-h + 0.15, h - 0.15, -hw + 0.1, hw - 0.1, 2.75, 3.0, roofC);
  cub(-h * 0.5, h * 0.5, -hw * 0.55, hw * 0.55, 3.0, 3.2, cream);
  if (!funicular) limb(S, Q(-h * 0.2, 0, 3.2), Q(-h * 0.2 - 3.2, 0, 4.9), 0.05, 0.04, 4, skirt, PL, false);
}

// A railway carriage on broad gauge, laid along the chord (x0,y0,z0)→(x1,y1,z1): dark bogies and skirt,
// a long body in the livery colour, a dark window band with a thin accent stripe below, a grey roof with
// equipment boxes, and (on cab cars) a sloped nose. livery = [body, band, stripe, roof]; cab = +1 / -1 end.
export function trainCar(S, { x0, y0, z0, x1, y1, z1, lin, srgb, livery, cab = 0, pantograph = false, seed = 0 }) {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, dx = (x1 - x0) / L, dy = (y1 - y0) / L, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const [body, band, stripe, roofC] = livery.map((c) => lin(srgb(c))), dark = lin(srgb('#2b2c2e'));
  const PL = [KIND.PLAIN / 8, 5 / 8, seed, 1], I0 = [0, 0, 0, 0], hw = 1.5, sl = (z1 - z0) / L;
  const Q = (u, v, z) => [mx + dx * u - dy * v, (z0 + z1) / 2 + sl * u + z, -(my + dy * u + dx * v)];
  const cub = (u0, u1, v0, v1, za, zb, col, zb1 = zb) => {     // zb1: top height at the u1 end (for the nose slope)
    const c = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], top = (u) => (u === u1 ? zb1 : zb);
    for (let i = 0; i < 4; i++) {
      const [ua, va] = c[i], [ub, vb] = c[(i + 1) % 4], n = [(vb - va) * dx + (ua - ub) * -dy, 0, -((vb - va) * dy + (ua - ub) * dx)], l = Math.hypot(...n) || 1;
      const nn = n.map((x) => x / l);
      tri(S, Q(ua, va, za), Q(ub, vb, za), Q(ub, vb, top(ub)), nn, col, [0, 0], [1, 0], [1, 1], I0, PL);
      tri(S, Q(ua, va, za), Q(ub, vb, top(ub)), Q(ua, va, top(ua)), nn, col, [0, 0], [1, 1], [0, 1], I0, PL);
    }
    const g = (zb1 - zb) / (u1 - u0 || 1) + sl, up = [-dx * g, 1, dy * g], ul = Math.hypot(...up), nu = up.map((x) => x / ul);
    tri(S, Q(u0, v0, zb), Q(u1, v0, zb1), Q(u1, v1, zb1), nu, col, [0, 0], [1, 0], [1, 1], I0, PL);
    tri(S, Q(u0, v0, zb), Q(u1, v1, zb1), Q(u0, v1, zb), nu, col, [0, 0], [1, 1], [0, 1], I0, PL);
  };
  const h = L / 2, nose = cab ? 2.6 : 0, a = cab < 0 ? -h + nose : -h, b = cab > 0 ? h - nose : h;
  for (const u of [-h + 3, h - 3]) cub(u - 1.4, u + 1.4, -hw + 0.25, hw - 0.25, 0.15, 1.05, dark);          // bogies
  cub(a, b, -hw, hw, 1.05, 2.05, body);
  cub(a, b, -hw - 0.01, hw + 0.01, 1.3, 1.45, stripe);
  cub(a, b, -hw - 0.02, hw + 0.02, 2.05, 2.95, band);
  cub(a, b, -hw, hw, 2.95, 3.75, body);
  cub(a + 0.3, b - 0.3, -hw + 0.25, hw - 0.25, 3.75, 4.05, roofC);
  if (cab) {                                                                                   // sloped nose: body below, raked dark windscreen above
    const [n0, n1] = cab > 0 ? [b, h] : [a, -h], s = Math.sign(n1 - n0);
    const lo = s > 0 ? [n0, n1] : [n1, n0];
    cub(lo[0], lo[1], -hw, hw, 1.05, 2.05, body);
    if (s > 0) cub(n0, n1, -hw + 0.05, hw - 0.05, 2.05, 3.75, band, 2.25); else cub(n1, n0, -hw + 0.05, hw - 0.05, 2.05, 2.25, band, 3.75);
  }
  if (pantograph) {                                                                            // folded-down diamond frame on the roof
    const u = -h * 0.35; cub(u - 1.2, u + 1.2, -0.7, 0.7, 4.05, 4.2, dark);
    limb(S, Q(u - 1, 0, 4.2), Q(u + 0.6, 0, 4.85), 0.04, 0.04, 4, dark, PL, false);
    limb(S, Q(u + 0.6, -0.8, 4.85), Q(u + 0.6, 0.8, 4.85), 0.04, 0.04, 4, dark, PL, false);
  }
}

// Overhead-line mast beside an electrified track: a slim steel pole with a cantilever arm over the track.
export function catenaryMast(S, { x, y, z, nx, ny, lin, srgb, H = 7.2, arm = 2.8 }) {
  const steel = lin(srgb('#6f7378')), PL = [KIND.PLAIN / 8, 5 / 8, 0.4, 1];
  limb(S, [x, z, -y], [x, z + H, -y], 0.11, 0.09, 4, steel, PL, false);
  limb(S, [x, z + H - 0.6, -y], [x + nx * arm, z + H - 0.9, -(y + ny * arm)], 0.05, 0.05, 4, steel, PL, false);
  limb(S, [x, z + H - 1.6, -y], [x + nx * arm, z + H - 0.9, -(y + ny * arm)], 0.04, 0.04, 4, steel, PL, false);
}

// Cacilheiro: the double-ended Tagus ferry. Orange hull with a white rubbing band, white main-deck
// saloon with a dark window band, upper deck with the wheelhouse and a short funnel. Centre (x,y),
// heading (dx,dy), afloat on the river surface (y = 0).
export function cacilheiro(S, { x, y, dx, dy, lin, srgb, seed = 0 }) {
  const orange = lin(srgb('#d9662c')), white = lin(srgb('#f2f0ea')), glass = lin(srgb('#2f363d')), deck = lin(srgb('#8d8a84')), black = lin(srgb('#2a2a2a'));
  const PL = [KIND.PLAIN / 8, 5 / 8, seed, 1], I0 = [0, 0, 0, 0];
  const P = (u, v) => [x + dx * u - dy * v, y + dy * u + dx * v];
  const hull = (L, B, z0, z1, col, top) => {               // double-ended hull plan: chamfered both ends
    const r = [[-L, 0], [-L + 4, -B], [L - 4, -B], [L, 0], [L - 4, B], [-L + 4, B]].map(([u, v]) => P(u, v));
    for (let i = 0; i < r.length; i++) wallQuad(S, r[i], r[(i + 1) % r.length], z0, z0, z1, z1, col, 0, 1, z0, I0, PL);
    if (top) for (let i = 1; i + 1 < r.length; i++) triUp(S, [r[0][0], z1, -r[0][1]], [r[i][0], z1, -r[i][1]], [r[i + 1][0], z1, -r[i + 1][1]], top, [0, 0], [0, 0], [0, 0], I0, PL);
  };
  hull(16, 4.4, -1.2, 1.0, orange, null);
  hull(16.1, 4.5, 1.0, 1.45, white, deck);
  const [cx, cy] = P(0, 0);
  box(S, cx, cy, dx, dy, 11, 3.7, 1.45, 2.3, white, I0, PL);
  box(S, cx, cy, dx, dy, 11.05, 3.75, 2.3, 3.4, glass, I0, PL);
  box(S, cx, cy, dx, dy, 11, 3.7, 3.4, 3.9, white, I0, PL);
  box(S, cx, cy, dx, dy, 11.6, 4.1, 3.9, 4.05, deck, I0, PL);
  box(S, cx, cy, dx, dy, 3.2, 2.6, 4.05, 5.0, white, I0, PL);
  box(S, cx, cy, dx, dy, 3.25, 2.65, 5.0, 5.9, glass, I0, PL);
  box(S, cx, cy, dx, dy, 3.4, 2.8, 5.9, 6.15, white, I0, PL);
  const [fx, fy] = P(4.6, 0);
  limb(S, [fx, 4.05, -fy], [fx, 7.0, -fy], 0.55, 0.5, 8, orange, PL);
  limb(S, [fx, 7.0, -fy], [fx, 7.5, -fy], 0.52, 0.5, 8, black, PL);
}

// Miradouro: white balustrade along the edges that drop away (checked against the terrain), and for
// Santa Luzia the pergola of white columns under bougainvillea along the river side.
export function miradouro(S, { ring, groundAt, lin, srgb, pergola = false, seed = 0 }) {
  const white = lin(srgb('#efeadf')), stone = lin(srgb('#d9d1bf')), leaf = lin(srgb('#5b7f3c')), leaf2 = lin(srgb('#6f9147')), bloom = lin(srgb('#b4447e'));
  const ST = [KIND.STONE / 8, 5 / 8, seed, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, seed, 1], I0 = [0, 0, 0, 0];
  const inside = (x, y) => pip(x, y, ring);
  let best = null, bestL = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 2) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const s = inside(mx - uy * 1.5, my + ux * 1.5) ? -1 : 1, nx = -uy * s, ny = ux * s;     // outward normal
    if (inside(mx + nx * 1.5, my + ny * 1.5)) continue;
    if (groundAt(mx + nx * 6, my + ny * 6) > groundAt(mx - nx * 1.5, my - ny * 1.5) - 1.2) continue;   // not a drop
    const n = Math.max(1, Math.round(L / 4));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n * L, x = a[0] + ux * t - nx * 0.15, y = a[1] + uy * t - ny * 0.15, g = groundAt(x - nx, y - ny);
      box(S, x, y, ux, uy, L / n / 2, 0.15, g - 0.4, g + 0.95, white, I0, PL);
      box(S, x, y, ux, uy, L / n / 2 + 0.02, 0.22, g + 0.95, g + 1.1, stone, I0, ST);
    }
    if (L > bestL) { bestL = L; best = { a, ux, uy, nx, ny, L }; }
  }
  if (pergola && best) {
    const { a, ux, uy, nx, ny, L } = best, P = (t, d) => [a[0] + ux * t - nx * d, a[1] + uy * t - ny * d];
    const g0 = (t) => { const [x, y] = P(t, 1.6); return groundAt(x, y); };
    for (const d of [0.7, 3.4]) for (let t = 1.2; t <= L - 1.2; t += 2.8) { const [x, y] = P(t, d), g = groundAt(x, y); limb(S, [x, g, -y], [x, g + 3.0, -y], 0.19, 0.17, 8, white, PL); }
    for (let t = 0.8; t < L - 0.8; t += 4) {
      const L2 = Math.min(4, L - 0.8 - t), [x, y] = P(t + L2 / 2, 2.05), g = g0(t + L2 / 2);
      box(S, x, y, ux, uy, L2 / 2, 1.6, g + 3.0, g + 3.2, stone, I0, ST);
      box(S, x, y, ux, uy, L2 / 2, 1.85, g + 3.2, g + 3.55, (t * 7.3 + seed * 10) % 3 < 1 ? leaf2 : leaf, I0, PL);
      for (let j = 0; j < 2; j++) { const tt = t + L2 * (0.25 + 0.5 * j), [bx, by] = P(tt, 0.4 + ((tt * 3.7) % 3)); box(S, bx, by, ux, uy, 0.7, 0.55, g + 3.4, g + 3.65, bloom, I0, PL); }
    }
  }
}

// Square-section frustum along local axes (obelisks, pedestals): half-sizes h0 → h1 from z0 to z1.
function frustum(S, cx, cy, ux, uy, h0, h1, z0, z1, col, st, top = true) {
  const I0 = [0, 0, 0, 0], c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const P = (k, h, z) => [cx + (ux * c[k][0] - uy * c[k][1]) * h, z, -(cy + (uy * c[k][0] + ux * c[k][1]) * h)];
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4, mx = (c[k][0] + c[k2][0]) / 2, my = (c[k][1] + c[k2][1]) / 2;
    const n = [ux * mx - uy * my, (h0 - h1) / (z1 - z0), -(uy * mx + ux * my)], l = Math.hypot(...n), nn = n.map((v) => v / l);
    tri(S, P(k, h0, z0), P(k2, h0, z0), P(k2, h1, z1), nn, col, [0, 0], [1, 0], [1, 1], I0, st);
    tri(S, P(k, h0, z0), P(k2, h1, z1), P(k, h1, z1), nn, col, [0, 0], [1, 1], [0, 1], I0, st);
  }
  if (top && h1 > 0.01) { tri(S, P(0, h1, z1), P(1, h1, z1), P(2, h1, z1), [0, 1, 0], col, [0, 0], [1, 0], [1, 1], I0, st); tri(S, P(0, h1, z1), P(2, h1, z1), P(3, h1, z1), [0, 1, 0], col, [0, 0], [1, 1], [0, 1], I0, st); }
}

// Monumento aos Restauradores (1886): 30 m obelisk on a stepped pedestal, bronze Victory and
// Freedom groups on its long sides.
export function restauradoresObelisk(S, { cx, cy, ux, uy, ground, lin, srgb }) {
  const stone = lin(srgb('#ece6d7')), shade = lin(srgb('#d5ccb9')), bronze = lin(srgb('#4e5a4b'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.61, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.61, 1], g = ground;
  for (let k = 0; k < 3; k++) frustum(S, cx, cy, ux, uy, 6.2 - k * 0.6, 6.2 - k * 0.6, g - 1, g + 0.35 * (k + 1), shade, ST);
  frustum(S, cx, cy, ux, uy, 3.3, 3.1, g + 1.05, g + 4.6, stone, ST);
  frustum(S, cx, cy, ux, uy, 3.6, 3.6, g + 4.6, g + 5.1, shade, ST);
  frustum(S, cx, cy, ux, uy, 2.4, 2.2, g + 5.1, g + 7.0, stone, ST);
  frustum(S, cx, cy, ux, uy, 1.45, 0.8, g + 7.0, g + 28.6, stone, ST);
  frustum(S, cx, cy, ux, uy, 0.8, 0.02, g + 28.6, g + 30.2, shade, ST, false);
  for (const s of [-1, 1]) {                         // the two bronze groups, seated on plinths before the pedestal
    const x = cx + ux * s * 4.3, y = cy + uy * s * 4.3;
    frustum(S, x, y, ux, uy, 0.9, 0.9, g + 1.05, g + 2.6, stone, ST);
    limb(S, [x, g + 2.6, -y], [x, g + 4.0, -y], 0.7, 0.5, 8, bronze, PL);
    limb(S, [x, g + 4.0, -y], [x, g + 4.6, -y], 0.28, 0.24, 6, bronze, PL);
    limb(S, [x, g + 3.6, -y], [x + uy * 0.9, g + 5.3, -(y - ux * 0.9)], 0.12, 0.1, 4, bronze, PL);
  }
}

// Estação do Rossio: the neo-Manueline front on edge a→b (outward = right side). Two great horseshoe
// portals, a central clock turret over the cornice, corner turrets and a row of pinnacles.
export function rossioStationFront(S, { a, b, ground, H, lin, srgb }) {
  const stone = lin(srgb('#ddd3bd')), carve = lin(srgb('#cbbfa5')), dark = lin(srgb('#2f2f30')), white = lin(srgb('#f2efe6')), lead = lin(srgb('#7d8084'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.83, 0.9], I0 = [0, 0, 0, 0];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, ox = uy, oy = -ux;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, at = (u, v) => [mx + ux * u + ox * v, my + uy * u + oy * v];
  const V = (u, v, z) => { const [x, y] = at(u, v); return [x, ground + z, -y]; };
  const bx = (u, v, hu, hv, z0, z1, col) => { const [x, y] = at(u, v); box(S, x, y, ux, uy, hu, hv, ground + z0, ground + z1, col, I0, ST); };
  for (const s of [-1, 1]) {                         // horseshoe portals
    const u = s * 4.2;
    bx(u, 0.25, 3.6, 0.25, 0, 11.5, carve);
    limb(S, V(u, 0.5, 7.4), V(u, 0.62, 7.4), 3.3, 3.3, 20, stone, ST);
    limb(S, V(u, 0.62, 7.4), V(u, 0.72, 7.4), 2.7, 2.7, 20, dark, ST);
    bx(u, 0.67, 2.25, 0.05, 0, 7.4, dark);
  }
  bx(0, 0.4, 0.6, 0.4, 0, H + 1.5, carve);           // central pier rising into the turret
  bx(0, 0.6, 2.6, 1.2, H - 1, H + 6, stone);         // clock turret
  limb(S, V(0, 1.8, H + 3), V(0, 1.86, H + 3), 1.35, 1.35, 16, dark, ST);
  limb(S, V(0, 1.86, H + 3), V(0, 1.92, H + 3), 1.15, 1.15, 16, white, ST);
  { const [x, y] = at(0, 0.6); limb(S, [x, ground + H + 6, -y], [x, ground + H + 10.5, -y], 2.4, 0.1, 4, lead, ST); }
  for (const s of [-1, 1]) {                         // corner turrets with little spires
    bx(s * (L / 2 - 1.4), 0.4, 1.4, 1.4, 0, H + 3.5, stone);
    const [x, y] = at(s * (L / 2 - 1.4), 0.4); limb(S, [x, ground + H + 3.5, -y], [x, ground + H + 6.5, -y], 1.3, 0.08, 4, lead, ST);
  }
  for (let u = -L / 2 + 4.5; u < L / 2 - 4; u += 3.2) if (Math.abs(u) > 3.4) { const [x, y] = at(u, 0.3); limb(S, [x, ground + H - 0.2, -y], [x, ground + H + 2.2, -y], 0.35, 0.05, 4, carve, ST); }
  bx(0, 0.15, L / 2 - 0.2, 0.15, H - 1.2, H - 0.4, carve);   // cornice band
}

// Pelourinho de Lisboa (Praça do Município): twisted marble column on octagonal steps, iron crown.
export function pelourinho(S, { cx, cy, ground, lin, srgb }) {
  const marble = lin(srgb('#eeeae0')), shade = lin(srgb('#d3cbb9')), iron = lin(srgb('#3b3c3e'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.19, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.19, 1], P = (z) => [cx, ground + z, -cy];
  for (let k = 0; k < 4; k++) limb(S, P(-0.5 + k * 0.32 * (k > 0)), P(0.32 * (k + 1)), 2.6 - k * 0.5, 2.6 - k * 0.5, 8, shade, ST);
  limb(S, P(1.28), P(1.9), 0.75, 0.7, 8, marble, ST);
  for (let k = 0; k < 6; k++) limb(S, P(1.9 + k * 0.85), P(1.9 + (k + 1) * 0.85), 0.42 - k * 0.012, 0.36 - k * 0.012, 6, k % 2 ? shade : marble, ST);
  limb(S, P(7.0), P(7.5), 0.55, 0.7, 8, marble, ST);
  limb(S, P(7.5), P(8.6), 0.55, 0.06, 8, iron, PL);
}

// Mercado da Ribeira: the domed clock tower over the market's front on Avenida 24 de Julho.
export function domedTower(S, { cx, cy, ux, uy, ground, h = 20, half = 3.2, lin, srgb }) {
  const white = lin(srgb('#efe9dc')), trim = lin(srgb('#d6ccb7')), dome = lin(srgb('#8e9396')), dark = lin(srgb('#33363a'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.47, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.47, 1], I0 = [0, 0, 0, 0], P = (z) => [cx, ground + z, -cy];
  box(S, cx, cy, ux, uy, half, half, ground - 1, ground + h, white, I0, PL);
  for (const [a, b] of [[h * 0.55, h * 0.55 + 0.4], [h - 0.6, h]]) box(S, cx, cy, ux, uy, half + 0.25, half + 0.25, ground + a, ground + b, trim, I0, ST);
  for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {           // clock faces and arched openings
    const nx = ux * sx - uy * sy, ny = uy * sx + ux * sy, x = cx + nx * (half + 0.05), y = cy + ny * (half + 0.05);
    limb(S, [x, ground + h * 0.78, -y], [x + nx * 0.08, ground + h * 0.78, -(y + ny * 0.08)], 1.1, 1.1, 14, white, ST);
    limb(S, [x - nx * 0.02, ground + h * 0.78, -(y - ny * 0.02)], [x + nx * 0.02, ground + h * 0.78, -(y + ny * 0.02)], 1.25, 1.25, 14, dark, ST);
    box(S, x, y, -ny, nx, 0.9, 0.06, ground + h * 0.2, ground + h * 0.45, dark, I0, ST);
  }
  limb(S, P(h), P(h + 1.2), half * 1.05, half * 1.05, 16, trim, ST);
  for (let k = 0; k < 5; k++) { const a0 = (k / 5) * Math.PI / 2, a1 = ((k + 1) / 5) * Math.PI / 2; limb(S, P(h + 1.2 + Math.sin(a0) * half * 1.1), P(h + 1.2 + Math.sin(a1) * half * 1.1), Math.max(0.3, Math.cos(a0) * half), Math.max(0.5, Math.cos(a1) * half), 16, dome, ST, k === 4); }
  limb(S, P(h + 1.2 + half * 1.1), P(h + 2.6 + half * 1.1), 0.5, 0.45, 8, white, PL);
  limb(S, P(h + 2.6 + half * 1.1), P(h + 3.4 + half * 1.1), 0.55, 0.05, 8, dome, ST);
}

// Palácio de São Bento: hexastyle portico on its marble frontispiece, the grand staircase down to the Largo,
// and the four lions on pedestals that flank it. a→b runs along the façade with the outside on the right.
export function saoBentoFront(S, { a, b, zTop, zSq, lin, srgb }) {
  const stone = lin(srgb('#ece6d8')), step = lin(srgb('#ddd5c4')), lion = lin(srgb('#7a7468'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.77, 0.9], I0 = [0, 0, 0, 0];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, ox = uy, oy = -ux;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, at = (u, v) => [mx + ux * u + ox * v, my + uy * u + oy * v];
  const depth = 6.5, span = Math.min(L - 2, 28);
  portico(S, { a, b, ground: zTop, depth, colH: 14, cols: 6, span, statue: false, lin, srgb });
  // stair: risers of ~0.18 m and treads of 0.42 m, slightly narrower than the portico
  const v0 = depth + 1.2, rise = Math.max(0, zTop + 0.2 - zSq), n = Math.max(1, Math.round(rise / 0.18)), run = n * 0.42;
  const hw = span / 2 - 1;
  for (let k = 0; k < n; k++) {
    const zt = zTop + 0.2 - (k + 1) * (rise / n) + rise / n, vMid = v0 + (k + 0.5) * 0.42;
    const [x, y] = at(0, vMid);
    box(S, x, y, ux, uy, hw, 0.21, zSq - 0.6, zt, step, I0, ST);
  }
  // cheek walls and lions on pedestals: two at the top landing, two at the foot
  for (const s of [-1, 1]) {
    const [cx, cy] = at(s * (hw + 0.7), v0 + run / 2);
    box(S, cx, cy, ux, uy, 0.7, run / 2 + 0.3, zSq - 0.6, zSq + 0.9, stone, I0, ST);
    for (const [v, z] of [[v0 + 0.6, zTop + 0.2], [v0 + run - 0.4, zSq]]) {
      const [px, py] = at(s * (hw + 0.7), v);
      box(S, px, py, ux, uy, 0.8, 1.3, z - 0.3, z + 1.6, stone, I0, ST);
      const [lx, ly] = at(s * (hw + 0.7), v + 0.2);
      box(S, lx, ly, ux, uy, 0.45, 1.0, z + 1.6, z + 2.3, lion, I0, ST);              // couchant body
      const [hx, hy] = at(s * (hw + 0.7), v + 0.95);
      box(S, hx, hy, ux, uy, 0.4, 0.35, z + 1.9, z + 2.8, lion, I0, ST);              // raised head
    }
  }
}

// Small sailing yacht on the Tagus: white hull, cabin, mast, mainsail and jib (both faces), heeled a touch.
export function sailboat(S, { x, y, dx, dy, lin, srgb, seed = 0, len = 9 }) {
  const white = lin(srgb('#f4f2ec')), hullC = lin(srgb(seed < 0.3 ? '#1f3550' : '#f1efe8')), deck = lin(srgb('#b9a587')), sail = lin(srgb('#f7f5ee')), mastC = lin(srgb('#c9ccd0'));
  const PL = [KIND.PLAIN / 8, 5 / 8, seed, 1], I0 = [0, 0, 0, 0];
  const L = len / 2, B = len * 0.17;
  const P = (u, v) => [x + dx * u - dy * v, y + dy * u + dx * v];
  const r = [[L, 0], [L * 0.45, B], [-L * 0.85, B * 0.9], [-L, B * 0.6], [-L, -B * 0.6], [-L * 0.85, -B * 0.9], [L * 0.45, -B]].map(([u, v]) => P(u, v));
  for (let i = 0; i < r.length; i++) wallQuad(S, r[i], r[(i + 1) % r.length], -0.4, -0.4, 0.75, 0.75, hullC, 0, 1, -0.4, I0, PL);
  for (let i = 1; i + 1 < r.length; i++) triUp(S, [r[0][0], 0.75, -r[0][1]], [r[i][0], 0.75, -r[i][1]], [r[i + 1][0], 0.75, -r[i + 1][1]], deck, [0, 0], [0, 0], [0, 0], I0, PL);
  const [cx, cy] = P(-L * 0.15, 0);
  box(S, cx, cy, dx, dy, L * 0.3, B * 0.55, 0.75, 1.35, white, I0, PL);
  const m = P(L * 0.12, 0), H = len * 1.35, heel = (seed - 0.5) * 0.6;           // mast top leans to leeward
  const top = [m[0] - dy * heel, H, -(m[1] + dx * heel)];
  limb(S, [m[0], 0.75, -m[1]], top, 0.07, 0.05, 4, mastC, PL, false);
  const tack = P(-L * 0.62, (seed - 0.5) * 2.2), clewZ = 1.6;                    // boom swung out to the wind side
  const foot = [m[0], 1.5, -m[1]], clew = [tack[0], clewZ, -tack[1]], head = [top[0], H - 0.4, top[2]];
  const bow = P(L * 0.95, 0), jibFoot = [bow[0], 1.0, -bow[1]], jibClew = P(-L * 0.05, (seed - 0.5) * 1.6);
  const n = [-dy, 0, -dx];
  for (const s of [1, -1]) {
    tri(S, foot, clew, head, n.map((v) => v * s), sail, [0, 0], [1, 0], [0, 1], I0, PL);
    tri(S, jibFoot, [jibClew[0], 1.2, -jibClew[1]], [top[0], H * 0.85, top[2]], n.map((v) => v * s), sail, [0, 0], [1, 0], [0, 1], I0, PL);
  }
}

// Shallow ribbed metal dome on a round drum (Coliseu dos Recreios), with a small glazed lantern.
export function metalDome(S, { cx, cy, r, z0, rise, lin, srgb, seg = 28, cols = ['#73787d', '#5f6469', '#d9d2c2', '#3a4148'] }) {
  const [a, b, ring, glass] = cols.map((c) => lin(srgb(c)));
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.6, 1], I0 = [0, 0, 0, 0];
  const R = (r * r + rise * rise) / (2 * rise), zc = z0 + rise - R;                // sphere through the rim and the crown
  const rings = 5, phi0 = Math.asin(Math.min(1, r / R));
  const V = (i, k) => { const ph = phi0 * (1 - k / rings), th = (i / seg) * 2 * Math.PI, rr = R * Math.sin(ph); return [cx + rr * Math.cos(th), zc + R * Math.cos(ph), -(cy + rr * Math.sin(th))]; };
  const N = (p) => { const v = [p[0] - cx, p[1] - zc, p[2] + cy], l = Math.hypot(...v); return v.map((q) => q / l); };
  for (let i = 0; i < seg; i++) for (let k = 0; k < rings; k++) {
    const p00 = V(i, k), p10 = V(i + 1, k), p01 = V(i, k + 1), p11 = V(i + 1, k + 1), n = N(V(i + 0.5, k + 0.5)), c = i % 2 ? a : b;
    tri(S, p00, p10, p11, n, c, [0, 0], [1, 0], [1, 1], I0, PL);
    if (k < rings - 1) tri(S, p00, p11, p01, n, c, [0, 0], [1, 1], [0, 1], I0, PL);
  }
  limb(S, [cx, z0 - 0.6, -cy], [cx, z0 + 0.25, -cy], r + 0.6, r + 0.6, seg, ring, PL, true);   // cornice ring under the rim
  limb(S, [cx, z0 + rise - 0.3, -cy], [cx, z0 + rise + 2.2, -cy], 2.6, 2.6, 8, glass, PL, false);
  limb(S, [cx, z0 + rise + 2.2, -cy], [cx, z0 + rise + 3.4, -cy], 2.9, 0.3, 8, a, PL, true);
}

// Basílica da Estrela: twin-towered baroque front (parishChurch) crowned by a tall drum and dome over the crossing.
export function estrelaBasilica(S, o) {
  const { cx, cy, ux, uy, hl, hw, ground, lin, srgb } = o;
  parishChurch(S, { ...o, towers: 2, cap: 'cupola', wall: '#f2efe8', roofHex: '#9fa3a6' });
  const H = o.H, uc = hl * 0.22, x = cx + ux * uc, y = cy + uy * uc, r = Math.min(hw * 0.62, 9.5);
  const white = lin(srgb('#f1eee6')), stone = lin(srgb('#d9d4c8')), dark = lin(srgb('#34373b'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.4, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.4, 1];
  const P = (z) => [x, ground + z, -y];
  limb(S, P(H - 1), P(H + 2), r + 1.2, r + 1.2, 16, stone, ST, true);              // square-ish base ring
  limb(S, P(H + 2), P(H + 12), r, r, 16, white, PL, false);                          // drum
  for (let k = 0; k < 8; k++) {                                                      // drum windows
    const a = (k / 8) * 2 * Math.PI, wx = x + Math.cos(a) * (r + 0.05), wy = y + Math.sin(a) * (r + 0.05);
    box(S, wx, wy, -Math.sin(a), Math.cos(a), 0.8, 0.06, ground + H + 4.5, ground + H + 9.5, dark, [0, 0, 0, 0], ST);
  }
  limb(S, P(H + 12), P(H + 13), r + 0.6, r + 0.6, 16, stone, ST, true);              // cornice
  metalDome(S, { cx: x, cy: y, r: r + 0.2, z0: ground + H + 13, rise: r * 0.95, lin, srgb, seg: 20, cols: ['#e3e1dc', '#d2d0ca', '#efece5', '#3a3f45'] });
  limb(S, P(H + 13 + r * 0.95 + 3.4), P(H + 13 + r * 0.95 + 6.5), 0.5, 0.08, 6, stone, ST, true);   // lantern finial
}

// Marquês de Pombal: stepped plinth, sculpted pedestal, tall column, the Marquês with his lion on top.
export function marquesColumn(S, { cx, cy, ground, lin, srgb }) {
  const stone = lin(srgb('#ece7dc')), shade = lin(srgb('#d3cbba')), bronze = lin(srgb('#4c5747'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.31, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.31, 1], I0 = [0, 0, 0, 0], P = (z) => [cx, ground + z, -cy];
  for (let k = 0; k < 4; k++) limb(S, P(-0.6 + k * 0.5 * (k > 0)), P(0.5 * (k + 1)), 12.5 - k * 1.4, 12.5 - k * 1.4, 16, k % 2 ? shade : stone, ST, true);
  box(S, cx, cy, 1, 0, 5.2, 5.2, ground + 2, ground + 4, shade, I0, ST);
  box(S, cx, cy, 1, 0, 4.2, 4.2, ground + 4, ground + 12.5, stone, I0, ST);
  box(S, cx, cy, 1, 0, 4.6, 4.6, ground + 12.5, ground + 13.4, shade, I0, ST);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {                    // allegorical groups on each face
    box(S, cx + dx * 5.4, cy + dy * 5.4, 1, 0, 1.6, 1.6, ground + 2, ground + 5.5, bronze, I0, PL);
    box(S, cx + dx * 5.0, cy + dy * 5.0, 1, 0, 1.0, 1.0, ground + 5.5, ground + 7.2, bronze, I0, PL);
  }
  limb(S, P(13.4), P(14.6), 2.2, 2.0, 16, shade, ST, true);
  limb(S, P(14.6), P(34.5), 1.75, 1.5, 16, stone, ST, false);
  limb(S, P(34.5), P(35.6), 2.1, 2.1, 12, shade, ST, true);
  limb(S, P(35.6), P(36.3), 1.6, 1.6, 12, stone, ST, true);
  limb(S, P(36.3), P(40.2), 0.55, 0.42, 8, bronze, PL, true);                     // the Marquês, hand on the lion
  limb(S, P(40.2), P(40.9), 0.32, 0.28, 6, bronze, PL, true);
  box(S, cx + 0.9, cy - 0.3, 0.6, 0.8, 1.2, 0.45, ground + 36.3, ground + 37.6, bronze, I0, PL);
  box(S, cx + 1.6, cy + 0.4, 0.6, 0.8, 0.4, 0.38, ground + 37.2, ground + 38.1, bronze, I0, PL);
}

// Príncipe Real's Cupressus lusitanica: trained flat over an iron trellis into a ~25 m green parasol.
export function trellisCedar(S, { cx, cy, ground, lin, srgb }) {
  const leaf = lin(srgb('#3f5a35')), leafTop = lin(srgb('#4c6a3d')), bark = lin(srgb('#5b4636')), iron = lin(srgb('#2e3130'));
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.5, 1], P = (z) => [cx, ground + z, -cy];
  limb(S, P(0), P(3.4), 0.65, 0.5, 8, bark, PL, false);
  for (let k = 0; k < 14; k++) {                                                   // ring of iron posts carrying the canopy
    const a = (k / 14) * 2 * Math.PI, x = cx + Math.cos(a) * 11.2, y = cy + Math.sin(a) * 11.2;
    limb(S, [x, ground, -y], [x, ground + 3.1, -y], 0.07, 0.07, 4, iron, PL, false);
  }
  limb(S, P(2.9), P(3.6), 13.2, 13.4, 20, leaf, PL, true);                          // the flat parasol
  limb(S, P(3.6), P(4.3), 12.4, 7.5, 20, leafTop, PL, true);
  limb(S, P(4.3), P(6.5), 3.2, 0.6, 10, leafTop, PL, true);                         // leader rising out of the middle
}

// ─── Ponte 25 de Abril ───────────────────────────────────────────────────
// Suspension bridge, 1966 (Steinman): 483 + 1013 + 483 m spans, towers 190.5 m above the river, road deck at 70 m on a
// 10.7 m deep stiffening truss with the railway inside it, all in international orange; a curved truss viaduct on
// concrete piers carries it over Alcântara. Centreline from the OSM carriageways; anchorages and towers fall exactly
// on its spans (485 m, 1013 m apart). Built whole in world coordinates: the caller keeps the triangles it owns.
export const PONTE_LINE = [[38.708369, -9.17795], [38.708017, -9.178015], [38.707653, -9.178136], [38.707423, -9.178239], [38.706768, -9.178502], [38.706275, -9.178696], [38.705923, -9.178834], [38.705614, -9.178953], [38.705224, -9.179114], [38.70494, -9.179235], [38.704829, -9.179283], [38.704168, -9.179475], [38.703515, -9.179641], [38.702832, -9.179729], [38.702141, -9.179742], [38.701456, -9.179683], [38.700788, -9.179563], [38.700095, -9.179422], [38.699176, -9.179207], [38.698303, -9.179009], [38.693997, -9.178077], [38.685003, -9.176092], [38.680722, -9.175139], [38.679851, -9.174936], [38.679472, -9.174841]];
export function ponte25Abril(S, { fwd, ground, lin, srgb }) {
  const orange = lin(srgb('#b4472f')), orangeD = lin(srgb('#8f3a28')), asphalt = lin(srgb('#55534f')), concrete = lin(srgb('#bdb7ac')), PL = [KIND.PLAIN / 8, 5 / 8, 0.3, 1], I0 = [0, 0, 0, 0];
  const pts = PONTE_LINE.map(([la, lo]) => fwd(la, lo));
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const at = (s) => {   // point and unit direction along the centreline
    let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
    const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / (cum[i] - cum[i - 1]))), [ax, ay] = pts[i - 1], [bx, by] = pts[i], d = Math.hypot(bx - ax, by - ay);
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, ux: (bx - ax) / d, uy: (by - ay) / d };
  };
  const sNA = cum[19], sNT = cum[20], sST = cum[21], sSA = cum[22];   // anchorages and towers
  const DECK = 70, TRUSS = 10.7, HW = 11.5;
  const g0 = 46.5, g1 = 71.5;   // road level where the deck lands (fixed, so every area builds the same deck)
  const deckZ = (s) => s < sNA ? g0 + (DECK - g0) * Math.min(1, Math.pow(s / sNA, 0.6)) : s > sSA ? DECK + (g1 - DECK) * (s - sSA) / (L - sSA) : DECK;
  const P3 = (s, v, z) => { const a = at(s); return [a.x - a.uy * v, z, -(a.y + a.ux * v)]; };   // v: offset to the left (west) of the line
  const quad = (A, B, C, D, col, want) => {   // wound to face `want`
    let n = norm(A, B, C); if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) { [B, D] = [D, B]; n = n.map((q) => -q); }
    triRaw(S, A, B, C, n, col, [0, 0], [0, 0], [0, 0], I0, PL); triRaw(S, A, C, D, n, col, [0, 0], [0, 0], [0, 0], I0, PL);
  };
  const lat = (s, sign) => { const a = at(s); return [-a.uy * sign, 0, -a.ux * sign]; };   // world direction of +v (sign 1) or -v
  const slab = (s0, s1, w, z0, z1, top, side, bottom = true) => {   // a deck slab between stations, following the curve
    const A = P3(s0, -w, z1), B = P3(s1, -w, z1), C = P3(s1, w, z1), D = P3(s0, w, z1);
    quad(A, D, C, B, top, [0, 1, 0]);
    const A0 = P3(s0, -w, z0), B0 = P3(s1, -w, z0), C0 = P3(s1, w, z0), D0 = P3(s0, w, z0);
    quad(A0, B0, B, A, side, lat(s0, -1)); quad(C0, D0, D, C, side, lat(s0, 1));
    if (bottom) quad(A0, D0, C0, B0, side, [0, -1, 0]);
  };
  // deck: one slab every ~12 m along the whole line, the road on top
  const STEP = 11.5;
  for (let s = 0; s < L - 0.1; s += STEP) {
    const s1 = Math.min(L, s + STEP), z0 = deckZ(s), z1 = deckZ(s1);
    const A = P3(s, -HW, z0), B = P3(s1, -HW, z1), C = P3(s1, HW, z1), D = P3(s, HW, z0);
    quad(A, D, C, B, asphalt, [0, 1, 0]);
    const A0 = P3(s, -HW, z0 - 1.2), B0 = P3(s1, -HW, z1 - 1.2), C0 = P3(s1, HW, z1 - 1.2), D0 = P3(s, HW, z0 - 1.2);
    quad(A0, B0, B, A, orange, lat(s, -1)); quad(C0, D0, D, C, orange, lat(s, 1)); quad(A0, D0, C0, B0, orangeD, [0, -1, 0]);
    // parapet rails
    for (const v of [-HW, HW]) limb(S, P3(s, v, z0 + 1.1), P3(s1, v, z1 + 1.1), 0.12, 0.12, 3, orange, PL, false);
  }
  // stiffening truss: Warren panels down both sides, a lower chord and the rail deck inside, full length
  for (let s = 0; s < L - 0.1; s += STEP) {
    const s1 = Math.min(L, s + STEP), z0 = deckZ(s), z1 = deckZ(s1), depth = s > sNA - 30 && s < sSA + 30 ? TRUSS : 7;
    if (z0 - depth < ground(at(s).x, at(s).y) + 2) continue;   // where the approach meets the hill there is no room for a truss
    for (const v of [-HW + 0.4, HW - 0.4]) {
      const b0 = P3(s, v, z0 - depth), b1 = P3(s1, v, z1 - depth), t0 = P3(s, v, z0 - 1.2), t1 = P3(s1, v, z1 - 1.2);
      limb(S, b0, b1, 0.45, 0.45, 4, orange, PL, false);
      limb(S, b0, t0, 0.3, 0.3, 4, orange, PL, false);
      limb(S, (Math.round(s / STEP) % 2 ? b0 : t0), (Math.round(s / STEP) % 2 ? t1 : b1), 0.28, 0.28, 4, orange, PL, false);
    }
    slab(s, s1, 7.5, z0 - depth + 0.4, z0 - depth + 1.2, concrete, orangeD);   // the rail deck
  }
  // approach piers: pairs of concrete columns under the viaduct and the Almada end
  for (let s = 40; s < L; s += 68) {
    if (s > sNA - 20 && s < sSA + 20) continue;
    const z = deckZ(s) - (s < sNA ? 7 : 7), a = at(s);
    const gz = ground(a.x, a.y) - 1; if (z - gz < 4) continue;
    for (const v of [-6.5, 6.5]) { const [px, , pz] = P3(s, v, 0); box(S, px, -pz, a.ux, a.uy, 2.2, 1.8, gz, z, concrete, I0, PL); }
    const [cx, , cz] = P3(s, 0, 0); box(S, cx, -cz, a.ux, a.uy, 2.4, 9, z - 2.2, z, concrete, I0, PL);
  }
  // anchorages: massive concrete blocks the cables run into
  for (const [s, dir] of [[sNA, -1], [sSA, 1]]) {
    const a = at(s), gz = Math.min(ground(a.x, a.y), 2) - 2;
    box(S, a.x + a.ux * dir * 18, a.y + a.uy * dir * 18, a.ux, a.uy, 24, 17, gz, DECK - TRUSS - 1, concrete, I0, PL);
    box(S, a.x + a.ux * dir * 8, a.y + a.uy * dir * 8, a.ux, a.uy, 10, 15, DECK - TRUSS - 1, DECK - 1.2, concrete, I0, PL);
  }
  // towers: two legs on a river pier, braced by struts and the X panels that mark this bridge from the Golden Gate
  const TOP = 190.5, LEG = 13;
  for (const s of [sNT, sST]) {
    const a = at(s);
    box(S, a.x, a.y, a.ux, a.uy, 14, 22, -4, 9, concrete, I0, PL);
    const leg = (v) => { const [px, , pz] = P3(s, v, 0); box(S, px, -pz, a.ux, a.uy, 3.6, 2.6, 9, 40, orange, I0, PL); box(S, px, -pz, a.ux, a.uy, 3.2, 2.3, 40, 110, orange, I0, PL); box(S, px, -pz, a.ux, a.uy, 2.8, 2.0, 110, TOP - 2, orange, I0, PL); box(S, px, -pz, a.ux, a.uy, 3.2, 2.6, TOP - 2, TOP, orangeD, I0, PL); };
    leg(-LEG); leg(LEG);
    const strut = (z, h) => { const [px, , pz] = P3(s, 0, 0); box(S, px, -pz, a.ux, a.uy, 2.2, LEG, z - h, z, orange, I0, PL); };
    const levels = [DECK - TRUSS - 1, 104, 136, 164, TOP - 1];
    levels.forEach((z, k) => strut(z, k === 0 || k === levels.length - 1 ? 4 : 2.6));
    for (let k = 1; k + 1 < levels.length; k++) {   // X bracing between the struts above the deck
      const z0 = levels[k] + 0.5, z1 = levels[k + 1] - 2.6;
      for (const f of [-1, 1]) limb(S, P3(s, -LEG * f, z0), P3(s, LEG * f, z1), 0.8, 0.8, 4, orange, PL, false);
    }
    for (const f of [-1, 1]) limb(S, P3(s, -LEG * f, DECK + 1), P3(s, LEG * f, 104 - 2.6), 0.8, 0.8, 4, orange, PL, false);
  }
  // main cables: parabolas from saddle to saddle sagging to just above the deck, side spans down into the anchorages; hangers every 23 m
  const cableZ = (s) => {
    if (s <= sNT) { const t = (s - sNA) / (sNT - sNA); return (DECK - 8) + (TOP + 0.5 - (DECK - 8)) * t - 14 * 4 * t * (1 - t); }
    if (s >= sST) { const t = (sSA - s) / (sSA - sST); return (DECK - 8) + (TOP + 0.5 - (DECK - 8)) * t - 14 * 4 * t * (1 - t); }
    const t = (s - sNT) / (sST - sNT); return DECK + 4 + (TOP + 0.5 - DECK - 4) * (2 * t - 1) ** 2;
  };
  for (const v of [-LEG, LEG]) {
    for (let s = sNA - 8; s < sSA + 8 - 0.1; s += 23) {
      const s1 = Math.min(sSA + 8, s + 23);
      limb(S, P3(s, v, cableZ(Math.max(sNA, Math.min(sSA, s)))), P3(s1, v, cableZ(Math.max(sNA, Math.min(sSA, s1)))), 0.42, 0.42, 5, orangeD, PL, false);
    }
    for (let s = sNA + 23; s < sSA - 5; s += 23) {
      const z = cableZ(s); if (z - DECK < 2.5 || Math.abs(s - sNT) < 8 || Math.abs(s - sST) < 8) continue;
      limb(S, P3(s, v, DECK + 0.2), P3(s, v, z), 0.14, 0.14, 3, orangeD, PL, false);
    }
  }
}
const norm = (a, b, c) => { const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]; const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...n) || 1; return n.map((q) => q / l); };

// ─── sculpture kit: lofted ellipse sections (robes, torsos, heads) and slabs (drapery) ───
// W(a, b, z) maps local right/forward/up into world [x, y_up, -y]. Sections: { z, rx, ry, b? (forward shift), a? }.
export function loft(S, W, secs, col, st, { sides = 16, folds = 0, foldAmp = 0, cap = true } = {}) {
  const I0 = [0, 0, 0, 0];
  const ring = (s) => Array.from({ length: sides }, (_, k) => {
    const t = (k / sides) * Math.PI * 2, m = 1 + (folds ? foldAmp * Math.sin(t * folds) * Math.min(1, s.fold ?? 1) : 0);
    return { p: W((s.a || 0) + Math.cos(t) * s.rx * m, (s.b || 0) + Math.sin(t) * s.ry * m, s.z), t };
  });
  const R = secs.map(ring);
  const nrm = (s, t) => { const c = W(s.a || 0, s.b || 0, s.z), p = W((s.a || 0) + Math.cos(t) * s.rx, (s.b || 0) + Math.sin(t) * s.ry, s.z); const v = [p[0] - c[0], 0, p[2] - c[2]]; const l = Math.hypot(...v) || 1; return [v[0] / l, 0, v[2] / l]; };
  for (let i = 0; i + 1 < R.length; i++) {
    const s0 = secs[i], s1 = secs[i + 1], dr = Math.max(s0.rx, s0.ry) - Math.max(s1.rx, s1.ry), dz = s1.z - s0.z || 1e-3;
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides, a0 = R[i][k].p, b0 = R[i][k2].p, a1 = R[i + 1][k].p, b1 = R[i + 1][k2].p;
      const h = nrm(s0, R[i][k].t + Math.PI / sides), sl = dr / dz, l = Math.hypot(1, sl), n = [h[0] / l, sl / l, h[2] / l];
      tri(S, a0, b0, b1, n, col, [k, s0.z], [k + 1, s0.z], [k + 1, s1.z], I0, st);
      tri(S, a0, b1, a1, n, col, [k, s0.z], [k + 1, s1.z], [k, s1.z], I0, st);
    }
  }
  if (cap) for (const [i, up] of [[0, -1], [R.length - 1, 1]]) {
    const s = secs[i]; if (s.rx < 0.02) continue; const c = W(s.a || 0, s.b || 0, s.z);
    for (let k = 0; k < sides; k++) { const p = R[i][k].p, q = R[i][(k + 1) % sides].p; if (up > 0) tri(S, c, q, p, [0, 1, 0], col, [0, 0], [0, 0], [0, 0], I0, st); else tri(S, c, p, q, [0, -1, 0], col, [0, 0], [0, 0], [0, 0], I0, st); }
  }
}
// a solid slab through four corners (in order), `t` thick along its normal: drapery, wings, banners
export function slab4(S, P, t, col, st) {
  const I0 = [0, 0, 0, 0], sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const u = sub(P[1], P[0]), v = sub(P[3], P[0]), n0 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n0) || 1, n = n0.map((q) => q / l);
  const F = P.map((p) => p.map((c, i) => c + n[i] * t / 2)), B = P.map((p) => p.map((c, i) => c - n[i] * t / 2));
  const face = (a, b, c, d, nn) => { tri(S, a, b, c, nn, col, [0, 0], [1, 0], [1, 1], I0, st); tri(S, a, c, d, nn, col, [0, 0], [1, 1], [0, 1], I0, st); };
  face(F[0], F[1], F[2], F[3], n); face(B[0], B[3], B[2], B[1], n.map((q) => -q));
  for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4, e = sub(F[k2], F[k]), m = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]], ml = Math.hypot(...m) || 1; face(F[k], B[k], B[k2], F[k2], m.map((q) => -q / ml)); }
}

// ─── Cristo Rei (Almada, 1959) ──────────────────────────────────────────
// A 75 m pedestal (a four-legged portico with great arches, then a ribbed tapering shaft and the viewing deck) under
// a 28 m Christ with outspread arms, facing Lisbon across the Tejo.
export function cristoRei(S, { cx, cy, ux, uy, hl, hw, ground, lin, srgb }) {
  const con = lin(srgb('#dcd8cf')), conD = lin(srgb('#c9c4ba')), conL = lin(srgb('#e6e3dc')), statue = lin(srgb('#d8d4cc')), dark = lin(srgb('#7d7a74'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.52, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.52, 1], I0 = [0, 0, 0, 0];
  if (uy < 0) { ux = -ux; uy = -uy; }                 // u along the long (east–west) axis, v = the face towards Lisbon (north)
  let vx = -uy, vy = ux; if (vy < 0) { vx = -vx; vy = -vy; }
  const W = (a, b, z) => [cx + ux * a + vx * b, ground + z, -(cy + uy * a + vy * b)];
  const B = (a, b, ha, hb, z0, z1, col, st = ST) => box(S, cx + ux * a + vx * b, cy + uy * a + vy * b, ux, uy, ha, hb, ground + z0, ground + z1, col, I0, st);
  const A = Math.max(11, Math.min(hl, 16)), Bw = Math.max(8, Math.min(hw, 12));   // half sizes of the base
  // stepped platform
  for (let k = 0; k < 3; k++) B(0, 0, A + 6 - k * 1.6, Bw + 6 - k * 1.6, -2 + k * 0.6, -1.4 + k * 0.6 + 0.6, k % 2 ? conD : conL);
  // four legs with chamfered inner faces
  const LA = A * 0.34, LB = Bw * 0.42, Z1 = 27;
  for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
    B(sa * (A - LA), sb * (Bw - LB), LA, LB, 0, Z1, con);
    B(sa * (A - LA), sb * (Bw - LB), LA + 0.5, LB + 0.5, 0, 2.2, conD);                  // plinth
    B(sa * (A + 0.2), sb * (Bw - LB), 0.35, LB * 0.6, 3, Z1 - 1, conD);                   // pilaster strip on the outer face
  }
  // arches: spandrel strips whose soffit follows a semicircle (long faces) and a narrower arch (short faces)
  const arch = (along, half, depth, spring, crown, zTop, off) => {
    const n = 14;
    for (let k = 0; k < n; k++) {
      const x0 = -half + (2 * half * k) / n, x1 = x0 + (2 * half) / n, xm = (x0 + x1) / 2, R = half;
      const zb = spring + (crown - spring) * Math.sqrt(Math.max(0, 1 - (xm / R) ** 2));
      if (along) B(xm, off, (x1 - x0) / 2 + 0.02, depth, zb, zTop, con); else B(off, xm, depth, (x1 - x0) / 2 + 0.02, zb, zTop, con);
    }
  };
  const ha = A - 2 * LA, hb = Bw - 2 * LB;
  for (const sb of [-1, 1]) arch(true, ha, LB, Z1 - ha * 0.9, Z1 - 1, Z1 + 3, sb * (Bw - LB));
  for (const sa of [-1, 1]) arch(false, Math.max(1, hb), LA, Z1 - hb * 1.3 - 4, Z1 - 1, Z1 + 3, sa * (A - LA));
  B(0, 0, A - 0.5, Bw - 0.5, Z1 + 1, Z1 + 3, con);                                         // vault over the portico
  B(0, 0, A + 0.8, Bw + 0.8, Z1 + 3, Z1 + 4.6, conL);                                      // cornice band
  // ribbed shaft, tapering to the deck
  const Z2 = 73, a0 = A * 0.92, b0 = Bw * 0.9, a1 = A * 0.6, b1 = Bw * 0.62;
  frustumAB(S, W, a0, b0, a1, b1, Z1 + 4.6, Z2, con, ST);
  for (const sb of [-1, 1]) for (let k = -3; k <= 3; k++) {   // vertical ribs on the long faces
    const f = k / 3.6; limb(S, W(f * a0, sb * (b0 + 0.25), Z1 + 4.6), W(f * a1, sb * (b1 + 0.25), Z2), 0.55, 0.45, 4, conD, ST, false);
  }
  for (const sa of [-1, 1]) for (let k = -1; k <= 1; k++) { const f = k / 1.8; limb(S, W(sa * (a0 + 0.25), f * b0, Z1 + 4.6), W(sa * (a1 + 0.25), f * b1, Z2), 0.55, 0.45, 4, conD, ST, false); }
  // capital: corbelled cornice, viewing deck with its parapet and the statue's drum
  B(0, 0, a1 + 1.2, b1 + 1.2, Z2, Z2 + 1.4, conL);
  B(0, 0, a1 + 2.4, b1 + 2.4, Z2 + 1.4, Z2 + 2.6, con);
  for (const sb of [-1, 1]) B(0, sb * (b1 + 2.2), a1 + 2.4, 0.2, Z2 + 2.6, Z2 + 3.7, conD);
  for (const sa of [-1, 1]) B(sa * (a1 + 2.2), 0, 0.2, b1 + 2.4, Z2 + 2.6, Z2 + 3.7, conD);
  B(0, 0, 4.2, 4.2, Z2 + 2.6, Z2 + 6.5, conD);
  B(0, 0, 4.6, 4.6, Z2 + 6.5, Z2 + 7.2, conL);
  // the statue, 28 m, robe with folds, arms spread wide with hanging sleeves, facing +v
  const z0 = Z2 + 7.2, Ws = (a, b, z) => W(a, b, z0 + z);
  loft(S, Ws, [
    { z: 0, rx: 3.9, ry: 3.0, fold: 1 }, { z: 1.2, rx: 3.95, ry: 3.0, fold: 1 }, { z: 5, rx: 3.5, ry: 2.6, fold: 1 }, { z: 10, rx: 2.95, ry: 2.15, fold: 0.8 },
    { z: 13.5, rx: 2.45, ry: 1.8, b: 0.1, fold: 0.5 }, { z: 17, rx: 2.7, ry: 1.85, b: 0.15, fold: 0.3 }, { z: 19.6, rx: 3.0, ry: 1.8, b: 0.1, fold: 0.2 },
    { z: 20.6, rx: 2.6, ry: 1.6, fold: 0 }, { z: 21.2, rx: 1.3, ry: 1.2, fold: 0 }, { z: 21.6, rx: 0.75, ry: 0.8, fold: 0 },
  ], statue, PL, { sides: 24, folds: 9, foldAmp: 0.06 });
  loft(S, Ws, [   // head with the hair falling to the shoulders behind
    { z: 21.5, rx: 0.78, ry: 0.85, b: -0.05 }, { z: 22.4, rx: 1.05, ry: 1.12, b: -0.12 }, { z: 23.6, rx: 1.12, ry: 1.2, b: -0.08 }, { z: 24.6, rx: 1.0, ry: 1.1, b: -0.05 },
    { z: 25.3, rx: 0.7, ry: 0.78, b: -0.05 }, { z: 25.65, rx: 0.2, ry: 0.22, b: -0.05 },
  ], statue, PL, { sides: 14 });
  loft(S, Ws, [{ z: 21.0, rx: 0.9, ry: 0.5, b: -0.9 }, { z: 22.6, rx: 1.05, ry: 0.55, b: -0.95 }, { z: 24.2, rx: 0.95, ry: 0.5, b: -0.75 }], conD, PL, { sides: 10 });   // hair
  loft(S, Ws, [{ z: 22.0, rx: 0.55, ry: 0.35, b: 0.85 }, { z: 22.6, rx: 0.62, ry: 0.4, b: 0.9 }, { z: 23.1, rx: 0.45, ry: 0.3, b: 0.95 }], conD, PL, { sides: 8 });       // beard
  for (const sa of [-1, 1]) {
    const sh = [sa * 2.55, 0.15, 19.9], el = [sa * 7.2, 0.55, 20.3], wr = [sa * 11.2, 0.9, 20.9];
    limb(S, Ws(...sh), Ws(...el), 1.05, 0.85, 10, statue, PL, true);
    limb(S, Ws(...el), Ws(...wr), 0.85, 0.6, 10, statue, PL, true);
    limb(S, Ws(...wr), Ws(sa * 12.6, 1.0, 21.3), 0.55, 0.32, 8, statue, PL, true);             // hand, palm forward
    limb(S, Ws(sa * 12.1, 1.0, 21.1), Ws(sa * 12.4, 1.25, 22.0), 0.18, 0.12, 5, statue, PL, true);   // thumb
    // sleeve drapery: hangs from the forearm and upper arm back to the robe's side
    slab4(S, [Ws(sa * 2.7, 0.1, 19.6), Ws(sa * 7.2, 0.5, 19.7), Ws(sa * 6.6, 0.45, 16.2), Ws(sa * 2.9, 0.15, 13.6)], 0.5, statue, PL);
    slab4(S, [Ws(sa * 7.2, 0.5, 19.7), Ws(sa * 10.6, 0.85, 20.2), Ws(sa * 10.2, 0.8, 18.3), Ws(sa * 6.6, 0.45, 16.2)], 0.4, statue, PL);
  }
  for (const sa of [-1, 1]) limb(S, Ws(sa * 0.9, 1.9, 0.1), Ws(sa * 0.95, 2.4, 0.5), 0.45, 0.35, 6, conD, PL, true);   // feet under the hem
}
// a rectangular frustum (half sizes a×b at z0 to a1×b1 at z1) in a local frame W
function frustumAB(S, W, a0, b0, a1, b1, z0, z1, col, st) {
  const I0 = [0, 0, 0, 0], c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const P = (k, top) => W(c[k][0] * (top ? a1 : a0), c[k][1] * (top ? b1 : b0), top ? z1 : z0);
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4, p0 = P(k, 0), p1 = P(k2, 0), p2 = P(k2, 1), p3 = P(k, 1);
    const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], v = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n) || 1; n = n.map((q) => q / l);
    const mid = W((c[k][0] + c[k2][0]) / 2 * a0, (c[k][1] + c[k2][1]) / 2 * b0, z0), ctr = W(0, 0, z0), out = [mid[0] - ctr[0], 0, mid[2] - ctr[2]];
    if (n[0] * out[0] + n[2] * out[2] < 0) { tri(S, p0, p2, p1, n.map((q) => -q), col, [0, 0], [1, 1], [1, 0], I0, st); tri(S, p0, p3, p2, n.map((q) => -q), col, [0, 0], [0, 1], [1, 1], I0, st); }
    else { tri(S, p0, p1, p2, n, col, [0, 0], [1, 0], [1, 1], I0, st); tri(S, p0, p2, p3, n, col, [0, 0], [1, 1], [0, 1], I0, st); }
  }
}
