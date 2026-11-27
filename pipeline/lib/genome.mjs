// Façade genome: what each ordinary building's front is made of, decided from what is known about that building
// (construction era, use, mapped shops, the set it was built with), packed into 4 bytes the façade shader reads (_GENE).
//
//   byte 0: era (3 bits) | design (5 bits)            era 1 vernacular · 2 Pombaline · 3 Romantic/gaioleiro (1870–1930)
//                                                     4 Estado Novo / Português Suave (1935–60) · 5 modernist (1955–75)
//                                                     6 1975–95 · 7 contemporary (1995–). 0 = no genome (landmarks, halls).
//   byte 1: frame (2) | shutter (3) | shutter colour (3)
//   byte 2: balcony (3) | trim (3) | ground floor (2)
//   byte 3: finish (3) | finish colour (3) | life (2)
//
// The era comes from data: a mapped start_date, the INE census of the city block (when data/census holds it), then the
// building itself (storey height, roof, plot, height) read against the history of the district it stands in. The design
// is shared by every building of a set built together (same architect, or a row/estate of identical blocks: see
// designGroups), so an Olivais estate repeats as it really does while an Alfama street never does. Choices inside an era
// are weighted by how common each feature is in Lisbon (walking counts, not a style guide); the lived-in layer (closed-in
// balconies, odd shutters, air conditioners) varies flat by flat in the shader.

export const ERA = { VERN: 1, POMB: 2, GAIO: 3, SUAVE: 4, MODERN: 5, LATE: 6, CONTEMP: 7 };
export const FRAME = { WHITE: 0, STONE: 1, ALU: 2, DARK: 3 };
export const SHUT = { NONE: 0, PORTADA: 1, ROLLER: 2, PERSIANA: 3, INNER: 4, VENETIAN: 5 };
export const BALC = { NONE: 0, IRON_ALL: 1, IRON_NOBLE: 2, IRON_RUN: 3, SLAB_BAY: 4, SLAB_BAND: 5, LOGGIA: 6, MARQUISE: 7 };
export const TRIM = { NONE: 0, WHITE: 1, STONE: 2, COURSES: 3, SLABS: 4, STONE_GF: 5, TILE_GF: 6, BARRA: 7 };
export const GROUND = { HOME: 0, SHOPS: 1, GARAGE: 2, OPEN: 3 };
export const FIN = { RENDER: 0, AZULEJO: 1, AZ_PLAIN: 2, PASTILHA: 3, BRICK: 4, STONE: 5, PANEL: 6, RUSTIC: 7 };

// weighted pick: list of [value, weight]
const pickW = (list, u) => { const tot = list.reduce((s, x) => s + x[1], 0); let a = u * tot; for (const [v, w] of list) if ((a -= w) <= 0) return v; return list[list.length - 1][0]; };

// Where each era's fabric stands (lat, lon, radius m, weights by era for older party-wall buildings). From the history of
// the city's growth: the pre-1755 quarters, the Pombaline rebuild and its 19th-century fringe, the Avenidas and Arroios
// grids (1880–1930), Alvalade and the Estado Novo plans, the old village and town cores around the metro area.
const ZONES = [
  ['Alfama', 38.7115, -9.1300, 420, { 1: 7, 2: 2, 3: 1 }], ['Mouraria/Castelo', 38.7155, -9.1345, 330, { 1: 7, 2: 2, 3: 1 }],
  ['Baixa/Chiado', 38.7105, -9.1395, 420, { 2: 8, 3: 2 }], ['Bairro Alto', 38.7125, -9.1450, 300, { 1: 4, 2: 5, 3: 1 }],
  ['Madragoa/Santos', 38.7075, -9.1575, 520, { 1: 4, 2: 4, 3: 2 }], ['Lapa', 38.7105, -9.1630, 420, { 2: 5, 3: 4, 1: 1 }],
  ['São Bento/Príncipe Real', 38.7160, -9.1500, 450, { 2: 5, 3: 4, 1: 1 }], ['Graça', 38.7180, -9.1300, 420, { 3: 5, 1: 3, 2: 2 }],
  ['Estrela', 38.7135, -9.1590, 330, { 3: 6, 2: 4 }], ['Campo de Ourique', 38.7180, -9.1660, 700, { 3: 8, 4: 2 }],
  ['Arroios/Estefânia', 38.7290, -9.1390, 900, { 3: 7, 4: 3 }], ['Penha de França', 38.7275, -9.1290, 520, { 3: 6, 4: 4 }],
  ['Avenidas Novas', 38.7385, -9.1470, 950, { 3: 4, 4: 3, 5: 3 }], ['Alvalade/Areeiro', 38.7500, -9.1410, 950, { 4: 7, 5: 3 }],
  ['Alcântara', 38.7050, -9.1770, 520, { 3: 5, 1: 3, 5: 2 }], ['Ajuda', 38.7075, -9.1975, 520, { 1: 4, 3: 6 }],
  ['Belém velha', 38.6975, -9.2030, 380, { 1: 6, 2: 4 }], ['Beato/Xabregas', 38.7280, -9.1080, 520, { 3: 6, 1: 4 }],
  ['Benfica velha', 38.7480, -9.1980, 300, { 1: 5, 3: 5 }], ['Lumiar velho', 38.7720, -9.1600, 300, { 1: 6, 3: 4 }],
  ['Sintra vila', 38.7975, -9.3900, 650, { 1: 7, 3: 3 }], ['Cascais centro', 38.6970, -9.4215, 520, { 1: 6, 3: 4 }],
  ['Estoril', 38.7050, -9.3980, 900, { 3: 6, 1: 4 }], ['Paço de Arcos', 38.6960, -9.2920, 320, { 1: 7, 3: 3 }],
  ['Oeiras velha', 38.6915, -9.3115, 350, { 1: 7, 3: 3 }], ['Carcavelos', 38.6920, -9.3360, 300, { 1: 6, 3: 4 }],
  ['Almada velha', 38.6815, -9.1590, 420, { 1: 7, 3: 3 }], ['Cacilhas', 38.6870, -9.1480, 300, { 1: 6, 3: 4 }],
  ['Barreiro velho', 38.6640, -9.0760, 450, { 1: 7, 3: 3 }], ['Seixal velho', 38.6420, -9.1010, 300, { 1: 8, 3: 2 }],
  ['Colares', 38.7990, -9.4470, 400, { 1: 9, 3: 1 }], ['Loures', 38.8310, -9.1690, 400, { 1: 6, 3: 4 }],
  ['Sacavém', 38.7935, -9.1050, 350, { 1: 5, 3: 5 }], ['Queluz', 38.7560, -9.2550, 350, { 1: 5, 3: 5 }],
  ['Amadora velha', 38.7590, -9.2390, 300, { 1: 4, 3: 3, 4: 3 }], ['Moita', 38.6510, -8.9900, 350, { 1: 8, 3: 2 }],
  ['Alcochete', 38.7550, -8.9610, 350, { 1: 8, 3: 2 }], ['Montijo', 38.7060, -8.9740, 450, { 1: 6, 3: 4 }],
];

export function makeGenome({ proj, hash }) {
  const Z = ZONES.map(([name, la, lo, r, w]) => { const [x, y] = proj.fwd(la, lo); return { name, x, y, r, w: Object.entries(w).map(([e, k]) => [+e, k]) }; });
  const zoneAt = (x, y) => { let best = null, bd = 1; for (const z of Z) { const d = Math.hypot(x - z.x, y - z.y) / z.r; if (d < bd) { bd = d; best = z; } } return best; };
  const kmFromBaixa = (x, y) => Math.hypot(x, y * 1.15) / 1000;

  // era from data, in order of trust: a mapped date, the census of the block (fraction by era), the building itself
  function eraOf(p, spec, census, key = p.id) {
    const t = p.tags, sd = parseInt(String(t.start_date || t.construction_date || '').match(/1[4-9]\d\d|20\d\d/)?.[0]);
    if (sd) return sd < 1755 ? ERA.VERN : sd < 1860 ? ERA.POMB : sd < 1933 ? ERA.GAIO : sd < 1955 ? ERA.SUAVE : sd < 1976 ? ERA.MODERN : sd < 1996 ? ERA.LATE : ERA.CONTEMP;
    const [x, y] = p.c, u = (k) => hash(key + k), v = spec.variant;
    if (spec.newTown) return ERA.CONTEMP;
    if (v === 8) return spec.sub8 === 2 ? ERA.SUAVE : spec.sub8 === 3 ? (u('e7') < 0.25 ? ERA.CONTEMP : ERA.LATE) : ERA.MODERN;
    if (v === 3) return spec.msBand || (spec.h > 40 && u('e3') < 0.6) ? ERA.CONTEMP : kmFromBaixa(x, y) < 3.5 ? pickW([[ERA.MODERN, 5], [ERA.LATE, 3], [ERA.CONTEMP, 4]], u('e3')) : pickW([[ERA.LATE, 5], [ERA.CONTEMP, 5], [ERA.MODERN, 2]], u('e3'));
    // older party-wall and low buildings: the block's census mix if known, else the district's history
    const fh = spec.floorH || 0, z = zoneAt(x, y);
    let w = census ? census.slice() : null;   // [_, vern, pomb, gaio, suave, modern, late, contemp] fractions
    if (!w) {
      if (z) { w = [0, 0, 0, 0, 0, 0, 0, 0]; for (const [e, k] of z.w) w[e] = k; }
      else if (spec.villa) w = kmFromBaixa(x, y) < 6 ? [0, 1, 0, 2, 3, 3, 2, 2] : [0, 1, 0, 1, 1, 2, 5, 4];
      else if (v === 0 || v === 2) w = kmFromBaixa(x, y) < 5 ? [0, 1, 1, 5, 3, 2, 1, 0] : [0, 2, 0, 3, 2, 3, 3, 1];
      else w = kmFromBaixa(x, y) < 5 ? [0, 4, 1, 3, 1, 1, 1, 0] : [0, 4, 0, 1, 1, 2, 4, 2];
    }
    // the building's own evidence: storey height (old floors are tall), roof, and height for a party-wall row
    if (fh >= 3.6) { w[5] *= 0.2; w[6] *= 0.1; w[7] *= 0.3; } else if (fh > 0 && fh <= 2.95) { w[1] *= 0.4; w[2] *= 0.2; w[3] *= 0.3; }
    if (spec.shape === 'flat' && !spec.villa) { w[1] *= 0.5; w[2] *= 0.4; w[3] *= 0.6; } else if (spec.shape !== 'flat') { w[5] *= 0.6; w[7] *= 0.5; }
    if (spec.h > 24) { w[1] = 0; w[2] *= 0.3; }
    if (v === 2) { w[1] += 0.5; w[3] *= 2; }   // azulejo fronts: mostly the 1860–1930 town
    const list = w.map((k, e) => [e, k]).filter(([e, k]) => e > 0 && k > 0);
    return list.length ? pickW(list, u('era')) : ERA.GAIO;
  }

  // the genome proper. `g` (design seed) is shared by the building's set; per-building draws use the building's own id.
  function geneOf(p, spec, { era, design, shops }) {
    const ud = (k) => hash(design + k), ub = (k) => hash(p.id + k), resi = !/office|commercial|retail|hotel|industrial|school|hospital|university|public|civic|government/.test(spec.kind || '');
    let frame, shut, shutC, balc, trim, ground, fin = FIN.RENDER, finC = 0, life;
    const low = spec.h < 10;
    switch (era) {
      case ERA.VERN:
        frame = pickW([[FRAME.WHITE, 7], [FRAME.STONE, 2], [FRAME.ALU, 2]], ud('fr'));
        shut = pickW([[SHUT.PORTADA, 3], [SHUT.INNER, 4], [SHUT.PERSIANA, 2], [SHUT.NONE, 1]], ud('sh'));
        shutC = pickW([[0, 4], [1, 2], [2, 3], [3, 1], [4, 2]], ud('sc'));
        balc = low ? pickW([[BALC.NONE, 5], [BALC.IRON_ALL, 3], [BALC.IRON_NOBLE, 2]], ud('ba')) : pickW([[BALC.IRON_ALL, 4], [BALC.IRON_NOBLE, 4], [BALC.NONE, 2]], ud('ba'));
        trim = pickW([[TRIM.BARRA, 4], [TRIM.WHITE, 3], [TRIM.STONE, 2], [TRIM.NONE, 2]], ud('tr'));
        if (ud('az') < 0.12) { fin = FIN.AZULEJO; finC = Math.floor(ud('fc') * 8); }
        finC = trim === TRIM.BARRA ? pickW([[0, 4], [1, 3], [2, 2], [3, 2], [4, 1], [5, 1]], ud('bc')) : finC;
        life = 2 + (ub('lf') < 0.5 ? 1 : 0); break;
      case ERA.POMB:
        frame = pickW([[FRAME.STONE, 6], [FRAME.WHITE, 4]], ud('fr'));
        shut = pickW([[SHUT.INNER, 6], [SHUT.PORTADA, 2], [SHUT.PERSIANA, 2]], ud('sh'));
        shutC = pickW([[0, 3], [2, 3], [3, 1], [4, 3]], ud('sc'));
        balc = pickW([[BALC.IRON_NOBLE, 4], [BALC.IRON_ALL, 4], [BALC.IRON_RUN, 1]], ud('ba'));
        trim = pickW([[TRIM.STONE, 7], [TRIM.WHITE, 3]], ud('tr'));
        if (ud('az') < 0.18) { fin = FIN.AZULEJO; finC = Math.floor(ud('fc') * 8); }
        life = 1 + (ub('lf') < 0.5 ? 1 : 0); break;
      case ERA.GAIO:
        frame = pickW([[FRAME.WHITE, 6], [FRAME.STONE, 3], [FRAME.ALU, 1]], ud('fr'));
        shut = pickW([[SHUT.INNER, 4], [SHUT.PERSIANA, 3], [SHUT.ROLLER, 2], [SHUT.PORTADA, 1]], ud('sh'));
        shutC = pickW([[0, 3], [1, 2], [2, 3], [4, 3], [5, 1]], ud('sc'));
        balc = pickW([[BALC.IRON_ALL, 6], [BALC.IRON_NOBLE, 2], [BALC.IRON_RUN, 2], [BALC.NONE, 1]], ud('ba'));
        trim = pickW([[TRIM.STONE, 5], [TRIM.WHITE, 4], [TRIM.COURSES, 2]], ud('tr'));
        { const a = ud('az'); if (spec.variant === 2 || a < 0.3) { fin = a < 0.6 ? FIN.AZULEJO : FIN.AZ_PLAIN; finC = Math.floor(ud('fc') * 8); } }   // Campo de Ourique, Arroios, Graça: about a third tiled
        life = 1 + (ub('lf') < 0.6 ? 1 : 0); break;
      case ERA.SUAVE:
        frame = pickW([[FRAME.STONE, 5], [FRAME.WHITE, 4], [FRAME.ALU, 1]], ud('fr'));
        shut = pickW([[SHUT.ROLLER, 6], [SHUT.PERSIANA, 3], [SHUT.INNER, 1]], ud('sh'));
        shutC = pickW([[2, 4], [0, 2], [4, 2], [5, 2], [6, 1]], ud('sc'));
        balc = pickW([[BALC.SLAB_BAY, 2], [BALC.IRON_NOBLE, 3], [BALC.LOGGIA, 2], [BALC.NONE, 4]], ud('ba'));
        trim = pickW([[TRIM.STONE_GF, 6], [TRIM.STONE, 3], [TRIM.WHITE, 1]], ud('tr'));
        if (ud('az') < 0.1) { fin = FIN.AZ_PLAIN; finC = Math.floor(ud('fc') * 8); }
        life = 1 + (ub('lf') < 0.5 ? 1 : 0); break;
      case ERA.MODERN:
        frame = pickW([[FRAME.WHITE, 4], [FRAME.ALU, 4], [FRAME.DARK, 1]], ud('fr'));
        shut = pickW([[SHUT.ROLLER, 8], [SHUT.VENETIAN, 1], [SHUT.NONE, 1]], ud('sh'));
        shutC = pickW([[4, 4], [6, 3], [2, 2], [0, 1], [5, 2], [7, 1]], ud('sc'));
        balc = spec.sub8 === 1 ? BALC.SLAB_BAND : pickW([[BALC.SLAB_BAY, 3], [BALC.SLAB_BAND, 2], [BALC.LOGGIA, 3], [BALC.NONE, 3]], ud('ba'));
        trim = pickW([[TRIM.SLABS, 4], [TRIM.TILE_GF, 3], [TRIM.NONE, 3], [TRIM.STONE_GF, 1]], ud('tr'));
        { const a = ud('az'); if (a < 0.3) { fin = FIN.PASTILHA; finC = Math.floor(ud('fc') * 8); } else if (a < 0.36) { fin = FIN.BRICK; } }
        life = 2 + (ub('lf') < 0.6 ? 1 : 0); break;
      case ERA.LATE:
        frame = pickW([[FRAME.ALU, 5], [FRAME.DARK, 4], [FRAME.WHITE, 2]], ud('fr'));
        shut = pickW([[SHUT.ROLLER, 9], [SHUT.NONE, 1]], ud('sh'));
        shutC = pickW([[2, 5], [4, 3], [5, 3], [6, 1]], ud('sc'));
        balc = pickW([[BALC.MARQUISE, 4], [BALC.SLAB_BAY, 2], [BALC.LOGGIA, 2], [BALC.NONE, 3]], ud('ba'));
        trim = pickW([[TRIM.TILE_GF, 5], [TRIM.NONE, 3], [TRIM.STONE_GF, 2], [TRIM.SLABS, 1]], ud('tr'));
        { const a = ud('az'); if (a < 0.14) { fin = FIN.BRICK; } else if (a < 0.24) { fin = FIN.PASTILHA; finC = Math.floor(ud('fc') * 8); } }
        life = 1 + (ub('lf') < 0.7 ? 1 : 0) + (ub('lf2') < 0.3 ? 1 : 0); break;
      default:   // contemporary
        frame = pickW([[FRAME.DARK, 5], [FRAME.ALU, 4], [FRAME.WHITE, 1]], ud('fr'));
        shut = pickW([[SHUT.NONE, 4], [SHUT.VENETIAN, 3], [SHUT.ROLLER, 3]], ud('sh'));
        shutC = pickW([[6, 4], [7, 3], [4, 2]], ud('sc'));
        balc = pickW([[BALC.SLAB_BAND, 3], [BALC.LOGGIA, 3], [BALC.SLAB_BAY, 2], [BALC.NONE, 3]], ud('ba'));
        trim = pickW([[TRIM.NONE, 6], [TRIM.SLABS, 2], [TRIM.STONE_GF, 2]], ud('tr'));
        { const a = ud('az'); if (a < 0.3) fin = FIN.STONE; else if (a < 0.45) fin = FIN.PANEL; }
        life = ub('lf') < 0.6 ? 0 : 1;
    }
    if (!resi) { life = Math.min(life, 1); if (era >= ERA.MODERN && balc !== BALC.NONE && ud('nb') < 0.6) balc = BALC.NONE; }
    if (spec.villa) { if (balc === BALC.SLAB_BAND || balc === BALC.MARQUISE) balc = BALC.SLAB_BAY; life = Math.min(life, 1); }
    // ground floor: shops where OSM maps them (≥1 shop node in or against the footprint); garages on suburban blocks
    ground = shops > 0 ? GROUND.SHOPS : spec.villa || low ? GROUND.HOME
      : era >= ERA.MODERN && ub('gg') < (era === ERA.MODERN ? 0.12 : 0.22) ? (ub('go') < 0.35 && era === ERA.MODERN ? GROUND.OPEN : GROUND.GARAGE) : GROUND.HOME;
    if (!resi && era >= ERA.MODERN) ground = shops > 0 || ub('gs') < 0.6 ? GROUND.SHOPS : ground;
    const d5 = Math.floor(hash(design + 'd') * 32);
    return { era, design: d5, frame, shut, shutC, balc, trim, ground, fin, finC, life,
      bytes: [era | (d5 << 3), frame | (shut << 2) | (shutC << 5), balc | (trim << 3) | (ground << 6), fin | (finC << 3) | (life << 6)] };
  }

  // era colours (sRGB hex, weathered), shared by a set; walls already chosen by data (building:colour, LOOKS) win
  const ERA_WALLS = {
    1: [['#ebe7de', 34], ['#e4dfd4', 8], ['#efe9dc', 8], ['#eadcbf', 7], ['#ecd69a', 7], ['#dcb466', 4], ['#e1b2a2', 6], ['#e6c4b8', 4], ['#b5c7d4', 3], ['#c4cfa8', 2], ['#cdbfcc', 1]],
    2: [['#dcb466', 11], ['#ecd69a', 11], ['#e1b2a2', 10], ['#eadcbf', 12], ['#ebe7de', 16], ['#e6c4b8', 5], ['#d99a7e', 4], ['#b5c7d4', 5], ['#c99a4f', 3], ['#c4cfa8', 3], ['#a75b47', 2], ['#cdbfcc', 2]],
    3: [['#eadcbf', 14], ['#ecd69a', 10], ['#e1b2a2', 9], ['#ebe7de', 14], ['#e6d8b6', 6], ['#dcd2bf', 7], ['#d99a7e', 5], ['#b5c7d4', 5], ['#c4cfa8', 4], ['#dcb466', 5], ['#cdbfcc', 2], ['#a9b9c2', 3]],
    4: [['#eadcbf', 20], ['#e6d8b6', 10], ['#dcd2bf', 12], ['#ecd69a', 12], ['#e6c4b8', 9], ['#ebe7de', 12], ['#e1b2a2', 7], ['#cfc4ae', 6], ['#dcb466', 4]],
    5: [['#ebe7de', 16], ['#efe9dc', 8], ['#cfccc5', 5], ['#ddcfb5', 13], ['#eadcbf', 13], ['#bcb8af', 2], ['#e6c4b8', 9], ['#ecd69a', 9], ['#a9b9c2', 4], ['#c4cfa8', 3], ['#e1b2a2', 4], ['#dcb466', 3]],
    6: [['#ebe7de', 18], ['#e6c4b8', 12], ['#d99a7e', 7], ['#ddcfb5', 14], ['#eadcbf', 9], ['#ecd69a', 7], ['#cfccc5', 6], ['#e1b2a2', 8], ['#c9a988', 5], ['#a65d46', 3]],
    7: [['#efede8', 26], ['#e4e1da', 12], ['#cfccc5', 12], ['#dcd2bf', 12], ['#8c8a86', 5], ['#b7a58c', 5], ['#ddcfb5', 8], ['#a6a49e', 5]],
  };
  const eraWall = (era, design) => pickW(ERA_WALLS[era], hash(design + 'wall'));
  return { eraOf, geneOf, eraWall, zoneAt };
}

// Sets built together (same developer, same drawings): buildings that share a party wall and match in plan and height,
// estates of identical blocks nearby, and buildings mapped with the same architect. Returns Map building id → set id.
export function designGroups(polys, heightOf) {
  const parent = new Map(polys.map((p) => [p, p]));
  const find = (p) => { while (parent.get(p) !== p) { parent.set(p, parent.get(parent.get(p))); p = parent.get(p); } return p; };
  const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const sig = new Map();
  for (const p of polys) {
    const h = heightOf(p), o = p.obb; if (!o || !(h > 0)) continue;
    p._sig = { h, L: o.hl * 2, W: o.hw * 2, ang: Math.atan2(o.uy, o.ux), a: Math.abs(p.area) };
  }
  const same = (a, b, tol) => { const s = a._sig, t = b._sig; if (!s || !t) return false;
    const dAng = Math.abs(((s.ang - t.ang) % Math.PI + Math.PI * 1.5) % Math.PI - Math.PI / 2);   // 0 = parallel
    return Math.abs(s.h - t.h) <= Math.max(0.8, 0.05 * s.h) && Math.abs(s.L - t.L) <= tol * Math.max(s.L, t.L) && Math.abs(s.W - t.W) <= tol * Math.max(s.W, t.W) && (dAng < 0.09 || Math.abs(dAng - Math.PI / 2) < 0.09) && (a.tags.building || '') === (b.tags.building || ''); };
  // 1) a row: neighbours across a party wall, alike in height and plan (12 %)
  for (const p of polys) for (const q of p.nbrs || []) if (parent.has(q) && same(p, q, 0.12)) join(p, q);
  // 2) an estate: free-standing blocks within 160 m that are the same block (6 %), 4+ storeys or in a row of houses
  const G = 160, grid = new Map();
  for (const p of polys) if (p._sig && p._sig.a > 120) { const k = `${Math.floor(p.c[0] / G)},${Math.floor(p.c[1] / G)}`; (grid.get(k) || grid.set(k, []).get(k)).push(p); }
  for (const p of polys) {
    if (!p._sig || p._sig.a <= 120) continue;
    const gx = Math.floor(p.c[0] / G), gy = Math.floor(p.c[1] / G);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const q of grid.get(`${gx + a},${gy + b}`) || [])
      if (q !== p && Math.hypot(q.c[0] - p.c[0], q.c[1] - p.c[1]) < G && same(p, q, 0.06)) join(p, q);
  }
  // 3) the same architect(s) within 400 m
  const byArch = new Map();
  for (const p of polys) { const a = p.tags.architect; if (a) (byArch.get(a) || byArch.set(a, []).get(a)).push(p); }
  for (const list of byArch.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
    if (Math.hypot(list[i].c[0] - list[j].c[0], list[i].c[1] - list[j].c[1]) < 400) join(list[i], list[j]);
  const out = new Map(); for (const p of polys) out.set(p.id, find(p).id); return out;
}
