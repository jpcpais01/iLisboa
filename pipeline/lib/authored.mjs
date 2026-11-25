// Hand-authored layer: places studied against 3D imagery and modelled on purpose rather than by rule.
// Pilot: Praça do Comércio, Arco da Rua Augusta, D. José I, and the Pombaline blocks of Rua Augusta.
// Imagery was used only as visual reference; all geometry here is our own.
import earcut from 'earcut';
import ClipperLib from 'clipper-lib';
import { KIND, box, wallQuad, triUp, tri as triRaw, polyArea, pip, obb, reliefBand, reliefPilaster, STONE_C } from './buildings.mjs';

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
  w821784762: { shape: 'flat', h: 9, wall: '#c8ccce', flatCol: [176, 180, 182], variant: 3 },   // Altice (MEO) Arena: the podium…
  w821784760: { shape: 'dome', minH: 9, h: 14, roofH: 24, roofCol: '#8f969b', wall: '#9aa0a4', variant: 3, floorH: 0 },   // …and the long zinc shell
  r8872281_0: { wall: '#a4473a', variant: 4, stone: false, h: 15, floorH: 4.6, groundH: 5.2, bayW: 4.2, shape: 'flat', parapet: 1.0, balconyFloors: [] },   // Campo Pequeno: red brick ring
  w709779008: { variant: 3, wall: '#a7b9c4', floorH: 3.3 },   // Myriad hotel at the Torre Vasco da Gama: glass sail
  w709779005: { shape: 'flat', h: 3, wall: '#cfccc4', flatCol: [196, 193, 186], variant: 3, floorH: 0, parapet: 0.9 },   // the tower's pier
  w1388115274: { shape: 'flat', h: 1.6, wall: '#cfccc4', flatCol: [200, 197, 190], variant: 3, floorH: 0, parapet: 0.9 },   // the hotel's river terrace
  ...Object.fromEntries(['w96502765', 'w96502767', 'w96502775'].map((id) => [id, { h: 58, shape: 'flat', wall: '#d99a93', variant: 3, floorH: 3.6, groundH: 4.4, parapet: 0 }])),   // Amoreiras towers: pink shafts (crowns authored)
  // Palácio de Belém (presidency): pink walls, white trims, tiled hip roofs
  ...Object.fromEntries(['r15475183_0', 'r15482569_0', 'r15482569_1'].map((id) => [id, { wall: '#e3a69c', roofCol: '#a9644e', variant: 4, stone: false }])),
  // Museu Nacional dos Coches (Paulo Mendes da Rocha, 2015): blank white concrete-and-metal boxes
  ...Object.fromEntries(['r5363219_0', 'r5363219_1', 'r5363219_2', 'r5363219_3', 'r15475185_0'].map((id) => [id, { wall: '#ebeae6', shape: 'flat', flatCol: [206, 206, 202], variant: 3, floorH: 0, parapet: 0.4 }])),
  w230062385: { h: 15, minH: 0, shape: 'flat', wall: '#97a9b6', flatCol: [214, 216, 214], variant: 3, floorH: 0, parapet: 1.2 },   // Oceanário: the box in the dock (roof authored)
  // Fundação Gulbenkian (1969): brutalist concrete under flat, partly planted roofs; CAM under Kengo Kuma's pale tiled eaves
  ...Object.fromEntries(['r17036063_0', 'w39784735'].map((id) => [id, { shape: 'flat', wall: '#bbb6ab', flatCol: [148, 156, 128], variant: 3, floorH: 4.2, groundH: 4.6, parapet: 0.8 }])),
  w188143627: { shape: 'flat', wall: '#c4c0b6', flatCol: [208, 208, 204], variant: 3, floorH: 4.2, groundH: 4.6, parapet: 0.6 },
  w174189905: { shape: 'flat', wall: '#d9dcd9', variant: 3, parapet: 0.8 },   // Sporting's multisports pavilion
  // modern institutions with courtyards that the rules read as old (tiled hips): flat-roofed, as built
  r17651166_0: { shape: 'flat', wall: '#dfe2e1', flatCol: [196, 199, 200], variant: 3, parapet: 0.8 },   // Aeroporto Terminal 1: light cladding and glass, metal roof
  w679256558: { shape: 'flat', wall: '#cfd3d4', flatCol: [176, 180, 182], variant: 3 },   // plant room on the terminal roof (no terracotta hip)
  w42645796: { h: 18, shape: 'flat', wall: '#c98f7f', flatCol: [200, 200, 196], variant: 3, parapet: 1 },   // Centro Colombo: one mass, its parts only where they rise above it
  // Colombo's twin office towers: salmon-brick slabs, each with a blue-glass drum at its corner (mapped as building=roof) under a pale disc
  w193025303: { h: 100, shape: 'flat', variant: 3, msBand: [0.02, 0.26], wall: '#4b6577', parapet: 0, floorH: 5.6, groundH: 7 },   // Torre de Monsanto: blue glass, slanted top (slopedCrown)
  w1054302774: { variant: 8, sub8: 1, wall: '#f2f1ed', shape: 'flat' },   // Infinity: white wrap-around balcony slabs
  ...Object.fromEntries(['w495968848', 'w495968849'].map((id) => [id, { h: 58, shape: 'flat', wall: '#b86a5c', flatCol: [176, 172, 166], variant: 3, floorH: 3.7, groundH: 5, parapet: 1.2 }])),
  ...Object.fromEntries(['w1453809581', 'w1453809582'].map((id) => [id, { h: 61, minH: 0, shape: 'flat', wall: '#3f6c86', flatCol: [214, 216, 214], variant: 3, floorH: 3.7, groundH: 5, parapet: 0.6 }])),
  ...Object.fromEntries(['w240817325', 'w1015870543'].map((id) => [id, { h: 96, shape: 'flat', wall: '#c9d6db', flatCol: [200, 205, 205], variant: 3, floorH: 3.6, parapet: 0 }])),   // São Rafael / São Gabriel (crowns authored)
  w240816973: { h: 21, shape: 'flat', wall: '#e3e1dc', flatCol: [214, 214, 210], variant: 3, floorH: 0, parapet: 1 },   // Centro Vasco da Gama (glass vault authored)
  w495968845: { h: 36, minH: 0, shape: 'dome', roofH: 11, roofCol: '#93a9b1', wall: '#d9d3c8', variant: 3, floorH: 0 },   // the glass dome over Praça Central
  w496232837: { h: 23, shape: 'flat', wall: '#d9d3c8', flatCol: [196, 196, 192], variant: 3, floorH: 0 },   // its drum terrace
  w495968846: { h: 11, minH: 0, shape: 'dome', roofH: 6, roofCol: '#5d8e93', wall: '#c98f7f', variant: 3, floorH: 0 },   // small teal dome at the front between the towers
  // Mesquita Central de Lisboa (checked against Earth): sand-coloured flat-roofed blocks, a pale blue-green dome over the prayer hall, a smaller green dome, a slender pointed minaret
  w96719280: { msBand: [0.3, 0.68], wall: '#cfcdc6', flatCol: [158, 160, 158] },   // El Corte Inglés: pale stone with dark horizontal window ribbons, a roof full of plant (Earth)
  // Cidade Universitária (Pardal Monteiro, 1950s–60s; checked against Earth): pale limestone, tall stone-framed windows, flat roofs
  r3177188_0: { h: 20, variant: 4, shape: 'flat', wall: '#eee8db', flatCol: [198, 196, 190], parapet: 1 },   // Reitoria
  r3177187_0: { h: 18, variant: 4, shape: 'flat', wall: '#ebe5d7', flatCol: [198, 196, 190], parapet: 1 },   // Faculdade de Letras
  r3220526_0: { h: 18, variant: 4, shape: 'flat', wall: '#ece7da', flatCol: [198, 196, 190], parapet: 1 },   // Faculdade de Direito
  w54754720: { h: 16, variant: 4, shape: 'flat', wall: '#eee8db', flatCol: [198, 196, 190], parapet: 1 },   // Aula Magna
  w663051574: { shape: 'flat', variant: 3, wall: '#f1f0ec', flatCol: [188, 190, 190] },   // white flat-roofed block (was a red hip)
  w54753984: { shape: 'flat', stone: true, wall: '#b8aea2', flatCol: [170, 164, 156], balconyFloors: [], parapet: 1.4 },   // Torre do Tombo: the windowless stone strongbox of the national archive
  w1266496435: { shape: 'flat', variant: 3, wall: '#dcdedd', flatCol: [196, 198, 198], floorH: 0 },   // Estádio do Restelo: the low south-end block (white, ad boards), not brick
  w1266496453: { shape: 'flat', variant: 3, wall: '#dcdedd', flatCol: [196, 198, 198], floorH: 0 },
  w1420989247: { h: 13, shape: 'flat', wall: '#d8c6a3', flatCol: [212, 200, 178], variant: 4, floorH: 0, parapet: 1.2 },   // musalla
  w1240194497: { minH: 13, h: 15, shape: 'flat', flatCol: [212, 200, 178], wall: '#d8c6a3', variant: 3, floorH: 0, parapet: 0, dome: { rise: 6.6, col: '#a8c8c5' } },   // drum; the dome is authored
  w940705830: { minH: 9.5, h: 10.5, shape: 'flat', flatCol: [212, 200, 178], wall: '#d8c6a3', variant: 3, floorH: 0, parapet: 0, dome: { rise: 3.9, col: '#95b9a7' } },
  w1367318284: { minH: 6, h: 6.5, shape: 'flat', flatCol: [212, 200, 178], wall: '#d8c6a3', variant: 3, floorH: 0, parapet: 0, dome: { rise: 2.4, col: '#a8c8c5' } },
  w1420989251: { h: 9.5, shape: 'flat', wall: '#d3c09c', flatCol: [210, 198, 176], variant: 4, floorH: 0 },
  w1420989255: { h: 9.5, shape: 'flat', wall: '#d3c09c', flatCol: [210, 198, 176], variant: 4, floorH: 0 },
  w1420989250: { h: 6, shape: 'flat', wall: '#d8c6a3', flatCol: [212, 200, 178], variant: 4, floorH: 0 },
  w1420989252: { h: 8, shape: 'flat', wall: '#d8c6a3', flatCol: [212, 200, 178], variant: 4, floorH: 0 },
  w1420989246: { h: 29, shape: 'flat', flatCol: [220, 208, 184], wall: '#e0d2b4', variant: 3, floorH: 0, parapet: 0, spire: { rise: 7, col: '#d6c9ad' } },   // minaret: shaft; gallery and spire authored
  w301676199: { h: 13, shape: 'flat', wall: '#efeee9', variant: 3, floorH: 0, flatCol: [214, 212, 206] },   // Teatro Aberto: white box, flat roof
  w155331041: { shape: 'flat', wall: '#efefeb', flatCol: [222, 222, 218], variant: 3, parapet: 0.8 },   // Fundação Champalimaud (Charles Correa)
  r3232954_0: { shape: 'flat', wall: '#ebebe6', flatCol: [214, 214, 210], variant: 3, parapet: 0.6 },   // Pavilhão do Conhecimento (Carrilho da Graça)
  r7873771_0: { shape: 'flat', wall: '#d9bfa9', variant: 3, parapet: 0.8 },   // Centro Ismaili (Raj Rewal)
  r6902258_0: { shape: 'flat', wall: '#e4e0d8', variant: 3, parapet: 0.8 },   // Hospital Fernando Fonseca
  ...Object.fromEntries(['r5742899_0', 'r21949748_0'].map((id) => [id, { shape: 'flat', variant: 3, parapet: 0.8 }])),   // Campus XXI, Edifício Fidelidade
  r6053715_0: { h: 21, wall: '#e3ded1', roofCol: '#a5604b', variant: 4, stone: false, floorH: 5.2, groundH: 6.2, bayW: 4.6, balconyFloors: [] },   // Palácio da Ajuda: neoclassical limestone (tagged 'house')
  r12988834_0: { h: 16, wall: '#dc9d8f', roofCol: '#a8624c', variant: 4, stone: false, floorH: 4.6, groundH: 5, bayW: 4.2 },   // Palácio das Necessidades: the pink palace
  w39735033: { h: 10.5, minH: 0, shape: 'flat', wall: '#d9d6cf', variant: 3, parapet: 1.1 },   // Gare do Oriente: the raised platform deck
  r16349886_0: { h: 41, minH: 39.6, shape: 'flat', wall: '#dfe2e3', flatCol: [224, 227, 229], variant: 3, parapet: 0 },   // Estádio da Luz: pale translucent roof
  r9143921_0: { h: 6, wall: '#bdbab3', variant: 3, shape: 'flat', parapet: 0, floorH: 0 },   // its podium; the bowl and façade are authored
  // Mosteiro dos Jerónimos: the monastery ranges in golden lioz under crested parapets (the church is authored)
  r11318401_0: { stone: false, wall: '#ddd0b1', shape: 'hipped', roofCol: '#b86a4e', h: 17, floorH: 5.2, groundH: 6.2, bayW: 4.4, variant: 4, parapet: 1.1, balconyFloors: [] },
  w1272872175: { shape: 'hipped', h: 13, wall: '#eeeae0', roofCol: '#b5694f', variant: 4, stone: false },   // Casa Pia (Belém): tiled hip roofs round its courts, not a flat hall
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
  'r19072300_0': { castle: true, stone: true, wall: '#cdbd9f', shape: 'flat', h: 12, floorH: 0, parapet: 0, crenel: true, variant: 5, flatCol: [178, 166, 140] },
  ...Object.fromEntries(['r19072289_0', 'r19072290_0', 'r19072291_0', 'r19072292_0', 'r19072293_0', 'r19072294_0', 'r19072296_0', 'r19072297_0', 'r19072298_0', 'r19072299_0']
    .map((id, k) => [id, { castle: true, stone: true, wall: '#c9b898', shape: 'flat', h: id === 'r19072289_0' ? 22 : 16 + (k % 3), floorH: 0, parapet: 0, crenel: true, variant: 5, flatCol: [178, 166, 140] }])),
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
export const DROP = new Set(['w151780623', 'w821784760', 'w297727868', 'w297727871', 'w39735031', 'w496232838', 'w1257751599', 'w41683195', 'w663318739', 'w663311597', 'w663318735',
  'w96301719', 'w115238861', 'w1387011981', 'w663347630', 'w1566332176', 'w678721536', 'w822816252', 'w87891338', 'w24341353', 'w152327819', 'w259346570', 
  'w118490305', 'w1386962088', 'w1386962089', 'w1386969006', 'w1386969007', 'w1386969008', 'w1466504958', 'w1466520766', 'w1466520767', 'w1466520768', 'r19133567_0', 'r20078664_0', 'r20078782_0', 'r20078783_0', 'r20078925_0', 'r11318402_0', 'w759763392', 'w683006891', 'w1268291335', 'w1268291336', 'w1268291337', 'w1387098203', 'w1387098204', 'w1387099961', 'w1387099962', 'w1387099963', 'w1387099964', 'w1387099965', 'w1387099966', 'w1387100761', 'w1387100762', 'w709779004', 'w1388124954', 'w1388124955', 'w1388126153', 'r11381632_0', 'w1069604938', 'w1069604939', 'w1069604940', 'w1069604941', 'w1016189633', 'r9159876_0']);   // Torre de Belém, Padrão and the tower's mapped parts (authored)
   // … + Cristo Rei (authored)   // + São Bento frontispiece (authored)
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
  const bands = [[0, prof.d1, ctx.noPaintedDormers || !ctx.noDormers ? KIND.TILES : KIND.MANSARD], [prof.d1, prof.dCap, KIND.TILES], [prof.dCap, 1e9, KIND.FLAT]];   // geometric dormers replace the painted ones
  for (const poly of sk.polygons) {
    const V = poly.map((k) => sk.vertices[k]);
    let ex = 1, ey = 0, eave = null;
    for (let i = 0; i < V.length; i++) { const a = V[i], b = V[(i + 1) % V.length]; if (a[2] < 1e-4 && b[2] < 1e-4) { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; ex = (b[0] - a[0]) / L; ey = (b[1] - a[1]) / L; eave = [a, b, L]; break; } }
    if (eave && prof.d1 > 0.9 && !ctx.noDormers) {   // one dormer per façade bay of this eave (the walls below use the same bays)
      const [a, b, L] = eave, bw = Math.max(1.6, ctx.bayW || 2.8), n = L >= 2.2 ? Math.max(1, Math.round(L / bw)) : 0;
      let nx = -ey, ny = ex; const far = V.find((v) => v[2] > 0.5); if (far && (far[0] - a[0]) * nx + (far[1] - a[1]) * ny < 0) { nx = -nx; ny = -ny; }
      dormers(S, { a, ex, ey, nx, ny, us: Array.from({ length: n }, (_, k) => ((k + 0.5) / n) * L).filter((u) => u > 0.8 && u < L - 0.8), wallTop, s1: prof.s1, colRoof, seed });
    }
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

// Dormers (trapeiras) standing out of the steep mansard band, one per façade bay, exactly where the shader would
// otherwise paint them: framed window, cheeks down to the slope, a small gabled roof running back into it.
export function dormers(S, { a, ex, ey, nx, ny, us, wallTop, s1, colRoof, seed }) {
  const white = [0.86, 0.85, 0.81], glass = [0.035, 0.045, 0.055], cheek = [0.78, 0.76, 0.72], I0 = [0, 0, 0, 0];
  const PL = [KIND.PLAIN / 8, 5 / 8, seed, 1], TL = [KIND.TILES / 8, 5 / 8, seed, 0.5];
  const z0 = 0.35, z1 = 1.95, zr = 2.5, hw = 0.55, d0 = z0 / s1 + 0.04;
  for (const u of us) {
    const P = (du, d, z) => [a[0] + ex * (u + du) + nx * d, wallTop + z, -(a[1] + ey * (u + du) + ny * d)];
    const dB = (z) => z / s1;                                   // depth where the slope reaches height z
    // front: white frame, glass set back 6 cm inside it
    tri(S, P(-hw, d0, z0), P(hw, d0, z0), P(hw, d0, z1), [-nx, 0, ny], white, [0, 0], [0, 0], [0, 0], I0, PL);
    tri(S, P(-hw, d0, z0), P(hw, d0, z1), P(-hw, d0, z1), [-nx, 0, ny], white, [0, 0], [0, 0], [0, 0], I0, PL);
    tri(S, P(-hw + 0.13, d0 - 0.01, z0 + 0.14), P(hw - 0.13, d0 - 0.01, z0 + 0.14), P(hw - 0.13, d0 - 0.01, z1 - 0.13), [-nx, 0, ny], glass, [0, 0], [0, 0], [0, 0], I0, PL);
    tri(S, P(-hw + 0.13, d0 - 0.01, z0 + 0.14), P(hw - 0.13, d0 - 0.01, z1 - 0.13), P(-hw + 0.13, d0 - 0.01, z1 - 0.13), [-nx, 0, ny], glass, [0, 0], [0, 0], [0, 0], I0, PL);
    tri(S, P(-0.03, d0 - 0.012, z0 + 0.14), P(0.03, d0 - 0.012, z0 + 0.14), P(0.03, d0 - 0.012, z1 - 0.13), [-nx, 0, ny], white, [0, 0], [0, 0], [0, 0], I0, PL);   // mullion
    tri(S, P(-0.03, d0 - 0.012, z0 + 0.14), P(0.03, d0 - 0.012, z1 - 0.13), P(-0.03, d0 - 0.012, z1 - 0.13), [-nx, 0, ny], white, [0, 0], [0, 0], [0, 0], I0, PL);
    // pediment
    tri(S, P(-hw - 0.08, d0 - 0.02, z1), P(hw + 0.08, d0 - 0.02, z1), P(0, d0 - 0.02, zr), [-nx, 0, ny], white, [0, 0], [0, 0], [0, 0], I0, PL);
    // cheeks back to the slope
    for (const sg of [-1, 1]) {
      const n = [ex * sg, 0, -ey * sg];
      tri(S, P(sg * hw, d0, z0), P(sg * hw, d0, z1), P(sg * hw, dB(z1), z1), n, cheek, [0, 0], [0, 0], [0, 0], I0, PL);
    }
    // gabled roof running back into the slope, a little proud of the front
    const dR = dB(zr), dE = dB(z1);
    for (const sg of [-1, 1]) {
      const A = P(sg * (hw + 0.12), d0 - 0.1, z1 - 0.05), B = P(0, d0 - 0.1, zr), C = P(0, dR, zr), D = P(sg * (hw + 0.12), dE, z1 - 0.05);
      const up = [0, 1, 0];
      tri(S, A, B, C, up, colRoof, [0, 0], [0, 0], [0, 0], I0, TL); tri(S, A, C, D, up, colRoof, [0, 0], [0, 0], [0, 0], I0, TL);
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
          if (!back && bays && env.getDetail) {   // stone socle, string course over the shops, cunhais where buildings meet
            const D = env.getDetail(cx, cy), ST = [KIND.PLAIN / 8, 0, hash(id + 'seed'), 0.9];
            reliefBand(D, p, q, gmin - 1.5, ground + 0.9, 0.07, STONE_C, ST);
            reliefBand(D, p, q, ground + groundH - 0.24, ground + groundH, 0.11, STONE_C, ST);
            reliefBand(D, p, q, ground + groundH + floorH - 0.16, ground + groundH + floorH, 0.06, STONE_C, ST);
            if (l > 2.5) { reliefPilaster(D, p, q, 0, 0.32, 0.07, ground + 0.9, wallTop - 0.35, STONE_C, ST); reliefPilaster(D, p, q, 1, 0.32, 0.07, ground + 0.9, wallTop - 0.35, STONE_C, ST); }
          }
          if (!back && bays) {   // trapeiras over every window bay, in the owner's roof colour
            const ex = (q[0] - p[0]) / l, ey = (q[1] - p[1]) / l, rc = m ? lin(jitter(pick(roofs, hash(m.id + 'r')), hash(m.id + 'rj'), 9)) : roofCol;
            dormers(S, { a: p, ex, ey, nx: -ey, ny: ex, us: Array.from({ length: bays }, (_, kk) => ((kk + 0.5) / bays) * l).filter((u) => u > 0.7 && u < l - 0.7), wallTop, s1: prof.s1, colRoof: rc, seed: hash(id + 'seed') });
          }
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
    const ctx = { wallTop, seed: seedB, colRoof: roofCol, ground, cx, cy, bayW: 2.9, variant: 0, parts, partsUnion: parts.map((m) => m.path), noDormers: true, noPaintedDormers: true };
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
      const FD = env.getDetail ? env.getDetail(mx, my) : S;   // near-only: fire walls and chimneys are sub-pixel from afar
      for (let k = 0; k < n; k++) {
        const s0 = (k / n) * L, s1 = ((k + 1) / n) * L;
        const P0 = [a[0] + dx * s0, a[1] + dy * s0], P1 = [a[0] + dx * s1, a[1] + dy * s1];
        const z0 = roofZ(P0[0], P0[1]) + 0.4, z1 = roofZ(P1[0], P1[1]) + 0.4, zb = wallTop - 0.2;
        const q = [[P0[0] + nx, P0[1] + ny], [P1[0] + nx, P1[1] + ny], [P1[0] - nx, P1[1] - ny], [P0[0] - nx, P0[1] - ny]];
        wallQuad(FD, q[3], q[2], zb, zb, z0, z1, fw, 0, 1, ground, I0, fwStyle);
        wallQuad(FD, q[1], q[0], zb, zb, z1, z0, fw, 0, 1, ground, I0, fwStyle);
        triUp(FD, [q[0][0], z0 + 0.02, -q[0][1]], [q[1][0], z1 + 0.02, -q[1][1]], [q[2][0], z1 + 0.02, -q[2][1]], fw, [0, 0], [0, 0], [0, 0], I0, fwStyle);
        triUp(FD, [q[0][0], z0 + 0.02, -q[0][1]], [q[2][0], z1 + 0.02, -q[2][1]], [q[3][0], z0 + 0.02, -q[3][1]], fw, [0, 0], [0, 0], [0, 0], I0, fwStyle);
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
        const CD = env.getDetail ? env.getDetail(x, y) : S;
        box(CD, x, y, po.ux, po.uy, 0.4, 0.3, z - 0.8, z + 1.3, fw, I0, fwStyle);
        box(CD, x, y, po.ux, po.uy, 0.5, 0.4, z + 1.3, z + 1.45, roofCol, I0, fwStyle);
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
      box(S, x, y, ux, uy, 0.92, 0.92, ground + 15.05, ground + 15.5, stone, I0, ST);
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
  // statues on the cornice above the paired columns, Praça side only: Viriato, Nuno Álvares, Pombal, Vasco da Gama (≈4 m)
  const L = (u0, v0, z0) => (a, b, z) => F(u0 + a, v0 + b, z0 + z);
  const poses = [{ cloak: true, arms: [[-0.25, 0.1, -0.05], [0.12, 0.25, -0.55]] }, { cloak: true, helmet: true, arms: [[-0.05, 0.15, -0.6], [0.3, 0.2, 0.05]] },
    { robe: true, cloak: true, arms: [[-0.1, 0.35, -0.3], [0.05, 0.1, -0.6]] }, { robe: true, cloak: true, arms: [[-0.05, 0.1, -0.6], [0.2, 0.4, -0.2]] }];
  [-10.2, -7.6, 7.6, 10.2].forEach((u, k) => {
    const [bx, by] = (() => { const p = F(u, D + 1.25, 0); return [p[0], -p[2]]; })();
    box(S, bx, by, ux, uy, 0.75, 0.6, ground + top + 0.2, ground + top + 0.75, shade, I0, ST);
    figure(S, L(u, D + 1.25, top + 0.75), 2.05, stone, ST, { stride: k % 2 ? 0.6 : -0.5, ...poses[k] });
  });
  // reclining river gods (Tejo and Douro) on the attic corners, propped on an urn
  for (const s of [-1, 1]) {
    const c = [s * 6.3, D - 0.5, top + 0.95], th = s * 1.2, co = Math.cos(th), si = Math.sin(th);
    const Rg = (a, b, z) => F(c[0] + a * co + z * si, c[1] + b, c[2] - a * si + z * co);
    figure(S, (a, b, z) => Rg(a, b, z * 0.95), 1.7, stone, ST, { robe: true, arms: [[-0.1, 0.15, -0.55], [0.35, 0.2, 0.25]] });
    ell(S, L(s * 7.1, D - 0.5, top + 0.3), [0, 0, 0.45], [0.38, 0.38, 0.45], shade, ST, 8);
  }
  // royal arms on the attic (Praça side): crowned shield with laurels
  { const A = L(0, D - 0.45, top + 3.0);
    slab4(S, [A(-1.35, 0.1, 1.9), A(1.35, 0.1, 1.9), A(1.2, 0.1, -1.2), A(-1.2, 0.1, -1.2)], 0.22, shade, ST);
    ell(S, A, [0, 0.12, -1.45], [1.1, 0.12, 0.65], shade, ST, 10);
    sweep(S, A, [[-1.1, 0.25, 2.0, 0.12, 0.12], [-0.6, 0.25, 2.45, 0.2, 0.2], [0, 0.25, 2.65, 0.26, 0.26], [0.6, 0.25, 2.45, 0.2, 0.2], [1.1, 0.25, 2.0, 0.12, 0.12]], stone, ST, 7);
    for (const t of [-1, 1]) sweep(S, A, [[t * 0.4, 0.3, -1.9, 0.12, 0.12], [t * 1.6, 0.3, -1.3, 0.2, 0.2], [t * 2.0, 0.3, 0.2, 0.22, 0.22], [t * 1.75, 0.3, 1.6, 0.16, 0.16], [t * 1.35, 0.3, 2.3, 0.05, 0.05]], shade, ST, 7);
    ell(S, A, [0, 0.35, 0.3], [0.55, 0.12, 0.7], stone, ST, 8); }
  // capitals and bases of the twelve columns
  for (const v of [D + 0.9, -D - 0.9]) for (const s of [-1, 1]) for (const u of [6.6, 8.6, 10.9]) {
    const C = L(s * u, v, 0);
    sweep(S, C, [[0, 0, 3.2, 0.78, 0.78], [0, 0, 3.42, 0.78, 0.78], [0, 0, 3.55, 0.66, 0.66], [0, 0, 3.75, 0.7, 0.7], [0, 0, 3.9, 0.62, 0.62]], stone, ST, 14, false);   // Attic base
    sweep(S, C, [[0, 0, 13.9, 0.58, 0.58], [0, 0, 14.25, 0.64, 0.64], [0, 0, 14.55, 0.78, 0.78], [0, 0, 14.75, 0.9, 0.9]], stone, ST, 14, false);   // bell
    for (let k = 0; k < 8; k++) { const t = (k / 8) * Math.PI * 2, x = Math.cos(t), y = Math.sin(t);
      sweep(S, C, [[x * 0.58, y * 0.58, 13.95, 0.09, 0.05], [x * 0.72, y * 0.72, 14.3, 0.1, 0.06], [x * 0.83, y * 0.83, 14.45, 0.06, 0.04]], shade, ST, 5); }   // acanthus leaves
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) ell(S, C, [a * 0.78, b * 0.78, 14.95], [0.13, 0.13, 0.16], stone, ST, 6);   // volutes
  }
  // Glory (Calmels, 7 m) on a plinth crowning Valour and Genius, seated
  const t0 = top + 7.6;
  { const p = F(0, 0, 0); box(S, p[0], -p[2], ux, uy, 2.2, 1.2, ground + t0, ground + t0 + 0.9, shade, I0, ST); }
  figure(S, L(0, 0, t0 + 0.9), 3.4, stone, ST, { robe: true, wings: true, arms: [[-0.55, 0.15, 0.45], [0.55, 0.15, 0.45]] });
  for (const s of [-1, 1]) {   // laurel wreaths in her raised hands
    const pts = []; for (let k = 0; k <= 12; k++) { const t = (k / 12) * Math.PI * 2; pts.push([s * 0.78 + Math.cos(t) * 0.17, 0.15 + Math.sin(t) * 0.17, 1.44 + 0.45 + 0.02, 0.035, 0.035]); }
    sweep(S, (a, b, z) => L(0, 0, t0 + 0.9)(a * 3.4, b * 3.4, z * 3.4), pts, stone, ST, 5, false);
  }
  figure(S, L(-2.75, 0.5, t0), 2.9, stone, ST, { seated: true, helmet: true, cloak: true, arms: [[-0.2, 0.3, -0.35], [0.25, 0.2, 0.4]] });   // Valour with shield and spear
  figure(S, L(2.75, 0.5, t0), 2.9, stone, ST, { seated: true, arms: [[-0.25, 0.3, 0.15], [0.15, 0.35, -0.3]] });   // Genius
  { const sp = L(-2.75, 0.5, t0); sweep(S, sp, [[-0.95, 0.4, 0.3, 0.05, 0.05], [-0.95, 0.5, 4.4, 0.04, 0.04]], stone, ST, 5); slab4(S, [sp(-1.4, 0.9, 0.2), sp(-0.6, 1.1, 0.2), sp(-0.6, 1.1, 1.6), sp(-1.4, 0.9, 1.6)], 0.15, stone, ST); }
  return 1;
}

// Equestrian statue of D. José I (Machado de Castro, 1775): bronze king on horseback
// trampling serpents, on a tall lioz pedestal flanked by sculpture groups, on an oval stepped base.
export function equestrianJose(S, { cx, cy, ground, heading, lin, srgb, plain = false }) {
  const bronze = lin(srgb('#4e5a4b')), bronzeHi = lin(srgb('#5f6d5b')), stone = lin(srgb('#e6dfcf')), shade = lin(srgb('#cfc6b2'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.61, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.61, 1], I0 = [0, 0, 0, 0];
  const fx = Math.sin(heading), fy = Math.cos(heading);   // facing direction (heading 180° = south)
  const F = frame(cx, cy, fy, -fx, ground);               // u = statue's right, v = forward
  const L = (a0, b0, z0, flip = 1) => (a, b, z) => F(a0 + a * flip, b0 + b * flip, z0 + z);   // local frame at an offset (flip = face backwards)
  // oval stepped platform
  const steps = plain ? [[6.5, 5.0, 0.4], [5.8, 4.4, 0.8], [5.2, 3.9, 1.4]] : [[9.5, 12.5, 0.35], [8.7, 11.6, 0.7], [7.9, 10.7, 1.05], [7.1, 9.8, 1.4]];
  let z = -0.6;
  for (const [ra, rb, zt] of steps) {
    const n = 36, ring = Array.from({ length: n }, (_, k) => { const a = (k / n) * Math.PI * 2; return [Math.cos(a) * ra, Math.sin(a) * rb]; });
    for (let k = 0; k < n; k++) { const a = ring[k], b = ring[(k + 1) % n]; const pa = F(a[0], a[1], 0), pb = F(b[0], b[1], 0); wallQuad(S, [pa[0], -pa[2]], [pb[0], -pb[2]], ground + z, ground + z, ground + zt, ground + zt, stone, 0, 1, ground, I0, ST); }
    const flat = ring.flat(), idx = earcut(flat);
    for (let k = 0; k < idx.length; k += 3) triUp(S, ...[idx[k], idx[k + 1], idx[k + 2]].map((q) => F(ring[q][0], ring[q][1], zt)), stone, [0, 0], [0, 0], [0, 0], I0, ST);
    z = zt - 0.05;
  }
  // pedestal, long along the horse: plinth, moulded die with sunk panels, cornice
  const P = (u, v) => { const p = F(u, v, 0); return [p[0], -p[2]]; };
  const [px, py] = P(0, 0), U = [fy, -fx];
  const hw = plain ? 1.6 : 2.3, hl = plain ? 2.6 : 3.9, z1 = 1.4;
  box(S, px, py, ...U, hw + 0.7, hl + 0.7, ground + z1, ground + z1 + 0.6, shade, I0, ST);
  box(S, px, py, ...U, hw + 0.45, hl + 0.45, ground + z1 + 0.6, ground + z1 + 1.1, stone, I0, ST);
  box(S, px, py, ...U, hw + 0.25, hl + 0.25, ground + z1 + 1.1, ground + z1 + 1.35, shade, I0, ST);
  box(S, px, py, ...U, hw, hl, ground + 2.75, ground + 7.4, stone, I0, ST);
  for (const s of [-1, 1]) {                       // raised frames around sunk panels on the long sides and ends
    for (const [z0, z1b] of [[2.95, 3.15], [7.0, 7.2]]) { const [qx, qy] = P(s * (hw + 0.06), 0); box(S, qx, qy, ...U, 0.08, hl - 0.35, ground + z0, ground + z1b, shade, I0, ST); }
    for (const v of [-1, 1]) { const [qx, qy] = P(s * (hw + 0.06), v * (hl - 0.45)); box(S, qx, qy, ...U, 0.08, 0.12, ground + 3.15, ground + 7.0, shade, I0, ST); }
    const [ex, ey] = P(0, s * (hl + 0.06)); box(S, ex, ey, ...U, hw - 0.35, 0.08, ground + 3.0, ground + 3.18, shade, I0, ST); box(S, ex, ey, ...U, hw - 0.35, 0.08, ground + 7.0, ground + 7.18, shade, I0, ST);
  }
  for (const [a, b, c, d] of [[7.4, 7.65, 0.12, shade], [7.65, 8.05, 0.32, stone], [8.05, 8.35, 0.5, shade], [8.35, 8.8, 0.25, stone]]) box(S, px, py, ...U, hw + c, hl + c, ground + a, ground + b, d, I0, ST);
  const h0 = 8.8;
  if (!plain) {
    // front: bronze medallion of Pombal in a wreath; back: royal arms
    const fm = L(0, hl + 0.05, 5.1);
    sweep(S, fm, [[0, 0, -0.01, 0.01, 0.01], [0, 0.04, 0, 0.95, 0.95], [0, 0.14, 0, 0.9, 0.9], [0, 0.18, 0, 0.01, 0.01]].map(([a, b, zz, r, q]) => [a, b, zz, r, q]), bronze, PL, 18, false);
    for (let k = 0; k < 14; k++) { const t = (k / 14) * Math.PI * 2; ell(S, fm, [Math.cos(t) * 1.05, 0.1, Math.sin(t) * 1.05], [0.16, 0.1, 0.12], bronzeHi, PL, 5); }
    ell(S, fm, [0, 0.18, 0.1], [0.32, 0.12, 0.4], bronzeHi, PL, 8);
    const bm = L(0, -hl - 0.05, 5.1, -1);
    slab4(S, [bm(-0.8, 0.08, 0.9), bm(0.8, 0.08, 0.9), bm(0.7, 0.08, -0.6), bm(-0.7, 0.08, -0.6)], 0.16, bronze, PL);
    ell(S, bm, [0, 0.12, -0.85], [0.45, 0.1, 0.35], bronze, PL, 8);
    sweep(S, bm, [[-0.55, 0.12, 1.0, 0.08, 0.08], [0, 0.12, 1.25, 0.14, 0.14], [0.55, 0.12, 1.0, 0.08, 0.08]], bronzeHi, PL, 6);   // crown
    // flank groups on lioz bases: Triumph leading a horse over the fallen (statue's right), Fame with an elephant (left)
    for (const s of [-1, 1]) {
      const gu = s * (hw + 2.3);
      const [gx, gy] = P(gu, 0.2);
      box(S, gx, gy, ...U, 1.55, 3.0, ground + 1.35, ground + 2.4, shade, I0, ST);
      box(S, gx, gy, ...U, 1.4, 2.85, ground + 2.4, ground + 2.65, stone, I0, ST);
      const G = L(gu, 0.2, 2.65);
      ell(S, G, [0, 0, 0.1], [1.2, 2.5, 0.35], bronze, PL, 12);                    // rocky ground of the group
      if (s > 0) {
        horse(S, L(gu - 0.25, -0.1, 2.7), 1.35, bronze, PL, { raise: true });
        figure(S, L(gu + 0.85, 1.1, 2.7), 1.2, bronzeHi, PL, { robe: true, arms: [[-0.3, 0.45, 0.0], [0.15, 0.3, 0.75]], helmet: true });
        figure(S, L(gu - 0.5, 1.9, 2.75, 1), 0.9, bronze, PL, { seated: true, arms: [[-0.2, 0.2, -0.45], [0.25, 0.25, 0.1]] });   // fallen captive
      } else {
        const E = L(gu - 0.2, -0.2, 2.7), sc = 1.0;
        const e = (a, b, zz) => E(a * sc, b * sc, zz * sc);
        sweep(S, e, [[0, -1.35, 1.65, 0.2, 0.2], [0, -1.15, 1.7, 0.62, 0.66], [0, -0.5, 1.75, 0.78, 0.82], [0, 0.3, 1.8, 0.8, 0.85], [0, 0.95, 1.85, 0.66, 0.72], [0, 1.2, 1.85, 0.3, 0.3]], bronze, PL, 14);
        ell(S, e, [0, 1.4, 2.15], [0.5, 0.55, 0.55], bronze, PL, 10);              // head
        sweep(S, e, [[0, 1.78, 2.1, 0.17, 0.2], [0, 2.0, 1.6, 0.12, 0.12], [0, 2.02, 1.05, 0.09, 0.09], [0, 2.2, 0.75, 0.07, 0.06], [0, 2.35, 0.8, 0.05, 0.04]], bronze, PL, 8);   // trunk
        for (const t of [-1, 1]) {
          sweep(S, e, [[t * 0.25, 1.7, 1.85, 0.06, 0.06], [t * 0.33, 2.1, 1.75, 0.045, 0.045], [t * 0.3, 2.3, 1.95, 0.02, 0.02]], bronzeHi, PL, 5);   // tusks
          slab4(S, [e(t * 0.4, 1.3, 2.55), e(t * 1.1, 1.0, 2.35), e(t * 1.05, 0.9, 1.5), e(t * 0.42, 1.2, 1.7)], 0.08, bronze, PL);   // ears
          for (const v of [-0.75, 0.75]) sweep(S, e, [[t * 0.45, v, 1.5, 0.27, 0.27], [t * 0.45, v + 0.03, 0.7, 0.24, 0.24], [t * 0.45, v + 0.05, 0.05, 0.27, 0.27]], bronze, PL, 9);
        }
        sweep(S, e, [[0, -1.35, 1.8, 0.05, 0.05], [0, -1.5, 1.2, 0.04, 0.04], [0, -1.48, 0.8, 0.06, 0.06]], bronze, PL, 5);   // tail
        slab4(S, [e(-0.75, -0.6, 2.5), e(0.75, -0.6, 2.5), e(0.85, 0.6, 2.45), e(-0.85, 0.6, 2.45)], 0.1, bronzeHi, PL);   // saddle cloth
        figure(S, L(gu + 0.95, 1.4, 2.7), 1.2, bronzeHi, PL, { robe: true, wings: true, arms: [[-0.15, 0.2, 0.8], [0.25, 0.35, 0.05]] });   // Fame with her trumpet raised
      }
    }
  }
  // horse walking over serpents, right fore raised; the king in armour, plumed helmet, mantle, baton forward
  const hs = plain ? 1.75 : 2.6, rs = plain ? 1.55 : 2.3;
  const H = L(0, 0, h0);
  horse(S, H, hs, bronze, PL, { raise: true });
  // harness: breast strap, reins, saddle cloth with fringe, stirrups
  sweep(S, H, [[-0.33 * hs, 0.85 * hs, 1.28 * hs, 0.04, 0.04], [0, 1.03 * hs, 1.3 * hs, 0.05, 0.05], [0.33 * hs, 0.85 * hs, 1.28 * hs, 0.04, 0.04]], bronzeHi, PL, 5);
  slab4(S, [H(-0.47 * hs, -0.45 * hs, 1.5 * hs), H(-0.47 * hs, 0.3 * hs, 1.5 * hs), H(-0.5 * hs, 0.32 * hs, 0.98 * hs), H(-0.5 * hs, -0.5 * hs, 0.98 * hs)], 0.08, bronzeHi, PL);
  slab4(S, [H(0.47 * hs, 0.3 * hs, 1.5 * hs), H(0.47 * hs, -0.45 * hs, 1.5 * hs), H(0.5 * hs, -0.5 * hs, 0.98 * hs), H(0.5 * hs, 0.32 * hs, 0.98 * hs)], 0.08, bronzeHi, PL);
  // serpents writhing under the raised hoof
  for (const [o, t] of [[0, 1], [0.6, -1]]) {
    const pts = []; for (let k = 0; k <= 10; k++) { const q = k / 10; pts.push([t * (0.5 - q) * 1.6 * hs * 0.5 + o, (0.9 + 0.5 * q) * hs + Math.sin(q * 9 + o) * 0.25, 0.12 + 0.1 * Math.sin(q * 6), 0.13 * (1 - 0.6 * q), 0.11 * (1 - 0.6 * q)]); }
    sweep(S, H, pts, bronzeHi, PL, 6);
  }
  const sd = -0.05 * hs, sz = 1.62 * hs;
  const R = L(0, sd, h0 + sz - 0.52 * rs);
  figure(S, R, rs, bronze, PL, { seated: true, rider: true, helmet: true, cloak: true, arms: [[-0.12, 0.42, -0.25], [0.32, 0.55, -0.02]] });
  sweep(S, H, [[0.53 * rs, sd + 0.55 * rs, sz + 0.5 * rs, 0.04, 0.04], [0.62 * rs, sd + 1.2 * rs, sz + 0.25 * rs, 0.035, 0.035]], bronzeHi, PL, 5);   // baton
  slab4(S, [R(-0.3, -0.1, 1.0), R(0.3, -0.1, 1.0), R(0.6, -0.55, 0.15), R(-0.6, -0.55, 0.15)], 0.06 * rs, bronze, PL);   // mantle over the croup
  for (let k = 0; k < 7; k++) { const t = (k / 6 - 0.5) * 1.6; sweep(S, R, [[t * 0.06, -0.02, 1.38, 0.025, 0.025], [t * 0.13, -0.12 - 0.05 * Math.abs(t), 1.6, 0.03, 0.02], [t * 0.2, -0.32, 1.55, 0.01, 0.01]], bronzeHi, PL, 4); }   // plumes
  return 1;
}

// Column of D. Pedro IV, Rossio (Davioud & Robert, 1870): 27.5 m. Stepped base, pedestal with four
// seated virtues, Corinthian shaft, bronze emperor on top.
// Corinthian capital in a local frame C(a, b, z): bell from radius r at z0, two rows of acanthus, corner volutes, abacus.
function corinthian(S, C, r, z0, h, col, dark, st) {
  sweep(S, C, [[0, 0, z0, r, r], [0, 0, z0 + h * 0.45, r * 1.08, r * 1.08], [0, 0, z0 + h * 0.8, r * 1.3, r * 1.3], [0, 0, z0 + h * 0.86, r * 1.36, r * 1.36]], col, st, 16, false);
  for (const [row, n, off] of [[0, 8, 0], [1, 8, 0.5]]) for (let k = 0; k < n; k++) {
    const t = ((k + off) / n) * Math.PI * 2, x = Math.cos(t), y = Math.sin(t), z1 = z0 + h * (row ? 0.25 : 0.02), z2 = z0 + h * (row ? 0.75 : 0.45);
    sweep(S, C, [[x * r, y * r, z1, 0.18 * r, 0.08 * r], [x * r * 1.16, y * r * 1.16, (z1 + z2) / 2, 0.2 * r, 0.1 * r], [x * r * 1.32, y * r * 1.32, z2, 0.1 * r, 0.06 * r], [x * r * 1.4, y * r * 1.4, z2 - 0.06 * h, 0.03 * r, 0.03 * r]], dark, st, 5);
  }
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) ell(S, C, [x * r * 1.05, y * r * 1.05, z0 + h * 0.86], [0.18 * r, 0.18 * r, 0.2 * r], col, st, 6);
  sweep(S, C, [[0, 0, z0 + h * 0.86, r * 1.45, r * 1.45], [0, 0, z0 + h, r * 1.45, r * 1.45]], col, st, 4, true);   // abacus (square)
}
// Fluted column shaft (loft with flutes) and an Attic base, in a local frame.
function flutedShaft(S, C, r0, r1, z0, z1, col, st, flutes = 20) {
  sweep(S, C, [[0, 0, z0, r0 * 1.32, r0 * 1.32], [0, 0, z0 + r0 * 0.3, r0 * 1.32, r0 * 1.32], [0, 0, z0 + r0 * 0.42, r0 * 1.12, r0 * 1.12], [0, 0, z0 + r0 * 0.6, r0 * 1.2, r0 * 1.2], [0, 0, z0 + r0 * 0.75, r0 * 1.02, r0 * 1.02]], col, st, 16, false);
  const secs = []; for (let k = 0; k <= 6; k++) { const q = k / 6, e = Math.sin(q * Math.PI) * 0.03; secs.push({ z: z0 + r0 * 0.75 + (z1 - z0 - r0 * 0.75) * q, rx: r0 + (r1 - r0) * q + e * r0, ry: r0 + (r1 - r0) * q + e * r0 }); }
  loft(S, C, secs, col, st, { sides: flutes * 2, folds: flutes, foldAmp: 0.035, cap: false });
}
// a lion lying or standing guard (≈1 m tall at the shoulder before scaling)
function lion(S, W0, sc, col, st) {
  const W = (a, b, z) => W0(a * sc, b * sc, z * sc);
  sweep(S, W, [[0, -0.75, 0.62, 0.14, 0.14], [0, -0.6, 0.65, 0.26, 0.28], [0, -0.1, 0.68, 0.28, 0.3], [0, 0.35, 0.72, 0.32, 0.36], [0, 0.55, 0.75, 0.2, 0.2]], col, st, 10);
  ell(S, W, [0, 0.58, 0.95], [0.38, 0.32, 0.42], col, st, 10);   // mane
  ell(S, W, [0, 0.82, 0.98], [0.17, 0.2, 0.18], col, st, 8);     // face
  for (const s of [-1, 1]) {
    sweep(S, W, [[s * 0.16, 0.45, 0.6, 0.1, 0.12], [s * 0.17, 0.5, 0.25, 0.06, 0.06], [s * 0.17, 0.58, 0.04, 0.07, 0.05]], col, st, 6);
    sweep(S, W, [[s * 0.17, -0.55, 0.62, 0.13, 0.16], [s * 0.18, -0.48, 0.3, 0.07, 0.07], [s * 0.18, -0.56, 0.05, 0.065, 0.05]], col, st, 6);
  }
  sweep(S, W, [[0, -0.78, 0.6, 0.04, 0.04], [0, -1.0, 0.35, 0.03, 0.03], [0, -1.05, 0.12, 0.05, 0.05]], col, st, 4);
}

// Column of D. Pedro IV, Rossio (Davioud & Robert, 1870): 27.5 m. Stepped base, pedestal with four
// seated virtues at its corners, fluted Corinthian shaft, bronze emperor holding the Charter.
export function pedroIVColumn(S, { cx, cy, ground, lin, srgb, heading = Math.PI }) {
  const stone = lin(srgb('#e8e1d1')), shade = lin(srgb('#d0c7b3')), bronze = lin(srgb('#4e5a4b')), bronzeHi = lin(srgb('#5f6d5b'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.23, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.23, 1], I0 = [0, 0, 0, 0];
  const fx = Math.sin(heading), fy = Math.cos(heading), F = frame(cx, cy, fy, -fx, ground), U = [fy, -fx];
  const L = (a0, b0, z0) => (a, b, z) => F(a0 + a, b0 + b, z0 + z), g = ground;
  for (const [h, z0, z1, c] of [[5.4, -0.5, 0.3, shade], [5.0, 0.3, 0.6, stone], [4.6, 0.6, 0.9, shade]]) box(S, cx, cy, ...U, h, h, g + z0, g + z1, c, I0, ST);
  box(S, cx, cy, ...U, 3.4, 3.4, g + 0.9, g + 1.6, shade, I0, ST);
  box(S, cx, cy, ...U, 3.0, 3.0, g + 1.6, g + 6.0, stone, I0, ST);
  for (const [a, b, c, d] of [[6.0, 6.25, 3.15, shade], [6.25, 6.6, 3.35, stone], [6.6, 6.85, 3.25, shade]]) box(S, cx, cy, ...U, c, c, g + a, g + b, d, I0, ST);
  // panels with bronze arms on each face
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const A = L(dx * 3.05, dy * 3.05, 3.8), o = [dx, dy];
    const Q = (a, z) => A(a * -o[1], a * o[0], z);
    slab4(S, [Q(-1.6, 1.6), Q(1.6, 1.6), Q(1.6, -1.6), Q(-1.6, -1.6)], 0.1, shade, ST);
    slab4(S, [Q(-0.55, 0.75), Q(0.55, 0.75), Q(0.5, -0.4), Q(-0.5, -0.4)], 0.22, bronze, PL);
    ell(S, A, [0, 0, -0.55], [0.4, 0.4, 0.3], bronze, PL, 7);
  }
  // four seated virtues (Justice, Wisdom, Strength, Moderation) on the corners, facing outwards
  [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(([dx, dy], k) => {
    const ang = Math.atan2(dx, dy), c = Math.cos(ang), s2 = Math.sin(ang), bx = dx * 3.45, by = dy * 3.45;
    const p = F(bx, by, 0); box(S, p[0], -p[2], ...U, 1.0, 1.0, g + 1.6, g + 2.2, shade, I0, ST);
    const V = (a, b, z) => F(bx + a * c + b * s2, by - a * s2 + b * c, 2.2 + z);
    figure(S, V, 1.55, stone, ST, { seated: true, robe: false, cloak: true, crown: k === 1, helmet: k === 2, arms: [[-0.25, 0.25, [0.4, -0.3, 0.1, -0.35][k]], [0.2, 0.3, [-0.2, 0.15, -0.35, 0.05][k]]] });
  });
  // fluted shaft and capital
  const C = L(0, 0, 0);
  sweep(S, C, [[0, 0, 6.85, 1.6, 1.6], [0, 0, 7.4, 1.6, 1.6], [0, 0, 7.4, 1.35, 1.35], [0, 0, 7.9, 1.3, 1.3]], stone, ST, 16, true);
  flutedShaft(S, C, 0.95, 0.8, 7.9, 21.6, stone, ST, 20);
  corinthian(S, C, 0.8, 21.6, 1.8, stone, shade, ST);
  box(S, cx, cy, ...U, 1.25, 1.25, g + 23.4, g + 24.1, shade, I0, ST);
  // D. Pedro IV in uniform and mantle, the Constitutional Charter in his right hand, crown wreath
  const K = L(0, 0, 24.1);
  figure(S, K, 2.05, bronze, PL, { cloak: true, stride: 0.4, arms: [[-0.15, 0.12, -0.55], [0.22, 0.42, -0.1]] });
  slab4(S, [K(0.95, 0.95, 2.85), K(1.25, 1.0, 2.9), K(1.25, 1.05, 2.45), K(0.95, 1.0, 2.4)], 0.06, bronzeHi, PL);
  sweep(S, K, [[-0.6, -0.15, 0.5, 0.15, 0.08], [-0.4, -0.4, 1.4, 0.35, 0.08], [0, -0.45, 2.6, 0.45, 0.08], [0.4, -0.4, 1.4, 0.35, 0.08], [0.6, -0.15, 0.5, 0.15, 0.08]], bronze, PL, 6);   // mantle folds
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

// Openings kit in a local frame (P2 for plan points, F for 3D): tbox = box along any local tangent;
// win = window/door on a wall at (u, v) facing (nu, nv): dark opening just proud of the wall, frame, hood ('cornice' | 'pediment' | 'arch' | 'round')
function openings(S, P2, F, ux, uy, ground, trim, dark, ST) {
  const I0 = [0, 0, 0, 0];
  const tbox = (u, v, tu, tv, ht, hn, z0, z1, col) => { const [x, y] = P2(u, v); box(S, x, y, ux * tu - uy * tv, uy * tu + ux * tv, ht, hn, ground + z0, ground + z1, col, I0, ST); };
  const arc = (u, v, tu, tv, z, r, rw, rh, col, n = 9) => sweep(S, F, Array.from({ length: n }, (_, k) => { const t = Math.PI * (k / (n - 1)); return [u + tu * Math.cos(t) * r, v + tv * Math.cos(t) * r, z + Math.sin(t) * r, rw, rh]; }), col, ST, 5);
  const win = (u, v, nu, nv, z0, w, h, hood = 'cornice', fd = 0.15) => {
    const tu = -nv, tv = nu, o = (d) => [u + nu * d, v + nv * d];
    tbox(...o(0.04), tu, tv, w / 2, 0.05, z0, z0 + h, dark);
    if (hood === 'round') { const c = o(0.04); sweep(S, F, Array.from({ length: 7 }, (_, k) => { const t = Math.PI * (k / 6); return [c[0] + tu * Math.cos(t) * w * 0.25, c[1] + tv * Math.cos(t) * w * 0.25, z0 + h + Math.sin(t) * w * 0.45, w * 0.25, 0.05]; }), dark, ST, 4); }
    for (const s of [-1, 1]) { const q = o(fd); tbox(q[0] + tu * s * (w / 2 + 0.17), q[1] + tv * s * (w / 2 + 0.17), tu, tv, 0.17, fd, z0 - 0.1, z0 + h + 0.1, trim); }
    tbox(...o(fd + 0.05), tu, tv, w / 2 + 0.4, fd + 0.05, z0 - 0.3, z0 - 0.08, trim);
    if (hood === 'cornice') { tbox(...o(fd), tu, tv, w / 2 + 0.34, fd, z0 + h, z0 + h + 0.3, trim); tbox(...o(fd + 0.1), tu, tv, w / 2 + 0.6, fd + 0.1, z0 + h + 0.3, z0 + h + 0.55, trim); }
    if (hood === 'pediment') { tbox(...o(fd), tu, tv, w / 2 + 0.34, fd, z0 + h, z0 + h + 0.3, trim); const c = o(0.2), A = F(c[0] - tu * (w / 2 + 0.6), c[1] - tv * (w / 2 + 0.6), z0 + h + 0.35), B = F(c[0] + tu * (w / 2 + 0.6), c[1] + tv * (w / 2 + 0.6), z0 + h + 0.35), T = F(c[0], c[1], z0 + h + 1.3); slab4(S, [A, B, T, T], 0.35, trim, ST); }
    if (hood === 'arch' || hood === 'round') arc(...o(fd * 0.8), tu, tv, z0 + h, w / 2 + 0.17, 0.17, fd + 0.05, trim);
  };
  return { tbox, win, arc };
}

// Sé de Lisboa (12th c., Romanesque with a Gothic chevet). West front with two crenellated towers,
// rose window and deep portal; three-aisled nave; transept with a crenellated lantern; apse and ambulatory.
// Frame from the OBB of the mapped cathedral parts: u runs west→east along the nave.
export function seCathedral(S, { cx, cy, ux, uy, hl, ground, gmin, lin, srgb }) {
  const stone = lin(srgb('#d8ccb2')), stone2 = lin(srgb('#cbbd9f')), dark = lin(srgb('#2f2e2c')), roof = lin(srgb('#a8604a')), trim = lin(srgb('#e2d7bf'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.53, 0.9], I0 = [0, 0, 0, 0], TL = [KIND.TILES / 8, 5 / 8, 0.53, 1];
  const zb = gmin - ground - 1.5;
  const { P2, W3, block, crenel, gable } = kit(S, { cx, cy, ux, uy, ground, zb, wall: stone, roof, ST, TL });
  const F = (u, v, z) => W3(u, v, z);
  const { tbox, win, arc } = openings(S, P2, F, ux, uy, ground, trim, dark, ST);
  const W = -hl;                                     // west front
  // towers: corner buttress strips, string courses, paired round-arched belfry openings, crenellations
  for (const s of [-1, 1]) {
    const v0 = s > 0 ? 6 : -16, v1 = s > 0 ? 16 : -6, vm = (v0 + v1) / 2;
    block(W, W + 10, v0, v1, 27.5);
    block(W - 0.3, W + 10.3, v0 - 0.3, v1 + 0.3, 1.0, stone2);
    for (const [a, b] of [[W, v0], [W, v1], [W + 10, s > 0 ? v1 : v0]]) tbox(a, b, 1, 0, 0.7, 0.7, zb, 26.6, stone2);
    for (const z of [9.5, 18.2]) { tbox(W - 0.15, vm, 0, 1, 5.2, 0.2, z, z + 0.35, trim); tbox(W + 5, s > 0 ? v1 + 0.15 : v0 - 0.15, 1, 0, 5.2, 0.2, z, z + 0.35, trim); }
    tbox(W + 5, vm, 1, 0, 5.4, 5.4, 26.6, 27.5, trim);
    crenel(W + 0.4, W + 9.6, v0 + 0.4, v1 - 0.4, 27.5);
    for (const t of [-1.25, 1.25]) {
      win(W, vm + t * 1.6, -1, 0, 20.5, 1.6, 3.6, 'arch', 0.2);
      win(W + 5 + t * 1.6, s > 0 ? v1 : v0, 0, s, 20.5, 1.6, 3.6, 'arch', 0.2);
    }
    tbox(W - 0.1, vm, 0, 1, 0.18, 0.18, 20.4, 24.3, trim);
    win(W, vm, -1, 0, 12.6, 0.7, 2.2, 'round', 0.12);           // narrow slit windows lower down
    win(W + 5, s > 0 ? v1 : v0, 0, s, 12.6, 0.7, 2.2, 'round', 0.12);
  }
  // central front: Romanesque portal with five receding archivolts on colonnettes, rose window with tracery, crenellated
  block(W, W + 10, -6, 6, 22.5);
  crenel(W + 0.4, W + 9.6, -5.6, 5.6, 22.5);
  tbox(W - 1.0, 0, 0, 1, 4.4, 1.0, zb, 9.2, stone2);
  tbox(W - 1.2, 0, 0, 1, 4.7, 1.2, 9.2, 9.6, trim);
  tbox(W - 2.05, 0, 0, 1, 1.75, 0.06, 0, 4.4, dark);
  arc(W - 2.04, 0, 0, 1, 4.4, 0.85, 0.85, 0.04, dark, 9);
  for (let k = 0; k < 5; k++) {
    const r = 1.95 + k * 0.42, d = -1.85 + k * 0.17;
    arc(W + d, 0, 0, 1, 4.6, r, 0.2, 0.22, k % 2 ? trim : stone2, 13);
    for (const s of [-1, 1]) { limb(S, F(W + d, s * r, 0.5), F(W + d, s * r, 4.4), 0.17, 0.15, 7, trim, ST); ell(S, F, [W + d, s * r, 4.5], [0.24, 0.24, 0.16], stone2, ST, 6); }
  }
  // rose window
  { const zc = 15.2, R = 2.9, A = (r, t) => F(W - 0.3, Math.cos(t) * r, zc + Math.sin(t) * r);
    sweep(S, F, Array.from({ length: 25 }, (_, k) => { const t = (k / 24) * Math.PI * 2; return [W - 0.3, Math.cos(t) * R, zc + Math.sin(t) * R, 0.25, 0.3]; }), trim, ST, 6, false);
    limb(S, F(W - 0.12, 0, zc), F(W - 0.05, 0, zc), R, R, 24, dark, ST);
    sweep(S, F, Array.from({ length: 13 }, (_, k) => { const t = (k / 12) * Math.PI * 2; return [W - 0.3, Math.cos(t) * 0.8, zc + Math.sin(t) * 0.8, 0.12, 0.14]; }), trim, ST, 5, false);
    for (let k = 0; k < 12; k++) { const t = (k / 12) * Math.PI * 2; limb(S, A(0.8, t), A(R, t), 0.08, 0.08, 4, trim, ST); }
    sweep(S, F, Array.from({ length: 25 }, (_, k) => { const t = (k / 24) * Math.PI * 2; return [W - 0.35, Math.cos(t) * (R + 0.5), zc + Math.sin(t) * (R + 0.5), 0.2, 0.2]; }), stone2, ST, 5, false); }
  // nave: clerestory with round-arched windows, corbel table; aisles with lean-to roofs, windows, buttresses
  const nE = hl - 22;
  block(W + 10, nE, -7, 7, 17.5); gable(W + 10, nE, -7.4, 7.4, 17.5, 22.5);
  for (const s of [-1, 1]) {
    const v0 = s > 0 ? 7 : -12, v1 = s > 0 ? 12 : -7, vo = s > 0 ? v1 : v0;
    block(W + 10, nE, v0, v1, 11);
    const vi = s > 0 ? v0 : v1, vr = s > 0 ? v1 + 0.4 : v0 - 0.4;
    triUp(S, W3(W + 10, vr, 11), W3(nE, vr, 11), W3(nE, vi, 13.2), roof, [0, 0], [1, 0], [0, 1], I0, TL);
    triUp(S, W3(W + 10, vr, 11), W3(nE, vi, 13.2), W3(W + 10, vi, 13.2), roof, [0, 0], [1, 0], [0, 1], I0, TL);
    tbox((W + 10 + nE) / 2, vo + s * 0.15, 1, 0, (nE - W - 10) / 2, 0.25, 10.4, 10.9, trim);   // corbel table
    tbox((W + 10 + nE) / 2, s * 7.15, 1, 0, (nE - W - 10) / 2, 0.25, 17.0, 17.5, trim);
    for (let u = W + 12.25; u < nE - 1; u += 4.5) {
      win(u, vo, 0, s, 4.2, 1.0, 3.2, 'arch', 0.18);
      win(u, s * 7, 0, s, 13.6, 0.9, 2.4, 'arch', 0.15);
      tbox(u + 2.25, vo + s * 0.55, 1, 0, 0.5, 0.55, zb, 9.2, stone2);
      slab4(S, [F(u + 1.85, vo + s * 1.1, 9.2), F(u + 2.65, vo + s * 1.1, 9.2), F(u + 2.65, vo, 10.6), F(u + 1.85, vo, 10.6)], 0.12, stone2, ST);
    }
  }
  // transept and crossing lantern (crenellated, with paired windows)
  block(nE - 10, nE, -16, 16, 17.5); gable(nE - 10, nE, -16.4, 16.4, 17.5, 22, false);
  for (const s of [-1, 1]) { win(nE - 5, s * 16, 0, s, 10.5, 1.4, 3.8, 'arch', 0.2); for (const u of [nE - 10, nE]) tbox(u, s * 15.6, 1, 0, 0.6, 0.6, zb, 16.8, stone2); }
  block(nE - 9.5, nE - 0.5, -4.5, 4.5, 27); crenel(nE - 9.1, nE - 0.9, -4.1, 4.1, 27);
  tbox(nE - 5, 0, 1, 0, 4.8, 4.8, 26.3, 26.7, trim);
  for (const s of [-1, 1]) for (const t of [-1.3, 1.3]) { win(nE - 5 + t, s * 4.5, 0, s, 22.0, 1.0, 2.8, 'arch', 0.15); win(nE - 9.5 + (s < 0 ? 0 : 9), t, s, 0, 22.0, 1.0, 2.8, 'arch', 0.15); }
  // Gothic chevet: ambulatory with radiating chapels, flying buttresses from the apse, crenellated tops
  const semi = (r, z1, zr, col, n = 10) => {
    const pts = Array.from({ length: n + 1 }, (_, k) => { const a = -Math.PI / 2 + (k / n) * Math.PI; return [nE + Math.cos(a) * r, Math.sin(a) * r]; });
    for (let k = 0; k < n; k++) {
      const a = P2(...pts[k + 1]), b = P2(...pts[k]);
      wallQuad(S, b, a, ground + zb, ground + zb, ground + z1, ground + z1, col, 0, 1, ground, I0, ST);
      triUp(S, W3(...pts[k], z1), W3(...pts[k + 1], z1), W3(nE, 0, zr), roof, [0, 0], [1, 0], [0, 1], I0, TL);
    }
    return pts;
  };
  semi(13, 10.5, 13, stone2);
  const apse = semi(8, 17.5, 22.5, stone);
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + ((k + 0.5) / 5) * Math.PI, c = Math.cos(a), sn = Math.sin(a);
    const CH = (r) => [nE + c * r, sn * r];
    // radiating chapel: a small polygonal block with a pointed window, pinnacles between
    const [pu, pv] = CH(14.2); tbox(pu, pv, -sn, c, 2.4, 1.6, zb, 8.6, stone2); tbox(pu, pv, -sn, c, 2.6, 1.8, 8.6, 9.1, trim);
    win(...CH(15.8), c, sn, 3.2, 0.9, 3.4, 'arch', 0.15);
    win(...CH(8), c, sn, 12.0, 0.9, 3.6, 'arch', 0.12);
    // flying buttress from an outer pier to the apse wall
    const b = -Math.PI / 2 + (k / 5) * Math.PI + (k ? 0 : 0.0001), cb = Math.cos(b), sb = Math.sin(b);
    if (k) {
      const pier = [nE + cb * 13.6, sb * 13.6];
      tbox(pier[0], pier[1], -sb, cb, 0.5, 0.8, zb, 15.2, stone2);
      limb(S, F(pier[0], pier[1], 15.2), F(pier[0], pier[1], 16.8), 0.4, 0.05, 4, trim, ST);
      slab4(S, [F(nE + cb * 13.2, sb * 13.2, 13.4), F(nE + cb * 8.1, sb * 8.1, 16.6), F(nE + cb * 8.1, sb * 8.1, 15.8), F(nE + cb * 13.2, sb * 13.2, 12.2)], 0.5, stone2, ST);
    }
  }
  void apse;
}

// Panteão Nacional (Santa Engrácia): white baroque Greek cross with undulating arms, four corner
// towers, a tall drum and dome with lantern (~80 m above the street on the slope; ~62 m to the cross).
export function panteao(S, { cx, cy, ux, uy, ground, gmin, lin, srgb }) {
  const white = lin(srgb('#f1eee6')), trim = lin(srgb('#ddd6c6')), dark = lin(srgb('#2f3134')), domeC = lin(srgb('#ebe7de')), pink = lin(srgb('#e3d3c6'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.67, 0.9], I0 = [0, 0, 0, 0];
  const P2 = (u, v) => [cx + ux * u - uy * v, cy + uy * u + ux * v];
  const F = frame(cx, cy, ux, uy, ground);
  const zb = gmin - ground - 1.5;
  const blk = (u, v, hu, hv, z0, z1, col = white) => { const [x, y] = P2(u, v); box(S, x, y, ux, uy, hu, hv, ground + z0, ground + z1, col, I0, ST); };
  // a box aligned with an arbitrary local direction (tu, tv) = tangent of a wall
  const tbox = (u, v, tu, tv, ht, hn, z0, z1, col) => { const [x, y] = P2(u, v); box(S, x, y, ux * tu - uy * tv, uy * tu + ux * tv, ht, hn, ground + z0, ground + z1, col, I0, ST); };
  // framed window on a wall at (u, v) facing (nu, nv): dark glass just proud of the wall, a lioz frame 0.3 deep around it, hood or pediment
  const win = (u, v, nu, nv, z0, w, h, hood = 'cornice') => {
    const tu = -nv, tv = nu, o = (d) => [u + nu * d, v + nv * d];
    tbox(...o(0.04), tu, tv, w / 2, 0.05, z0, z0 + h, dark);
    for (const s of [-1, 1]) { const q = o(0.15); tbox(q[0] + tu * s * (w / 2 + 0.17), q[1] + tv * s * (w / 2 + 0.17), tu, tv, 0.17, 0.15, z0 - 0.1, z0 + h + 0.1, trim); }
    tbox(...o(0.2), tu, tv, w / 2 + 0.45, 0.2, z0 - 0.35, z0 - 0.1, trim);
    tbox(...o(0.15), tu, tv, w / 2 + 0.34, 0.15, z0 + h, z0 + h + 0.3, trim);
    if (hood === 'cornice') tbox(...o(0.25), tu, tv, w / 2 + 0.6, 0.25, z0 + h + 0.3, z0 + h + 0.55, trim);
    if (hood === 'pediment') { const c = o(0.2), A = F(c[0] - tu * (w / 2 + 0.6), c[1] - tv * (w / 2 + 0.6), z0 + h + 0.35), B = F(c[0] + tu * (w / 2 + 0.6), c[1] + tv * (w / 2 + 0.6), z0 + h + 0.35), T = F(c[0], c[1], z0 + h + 1.3); slab4(S, [A, B, T, T], 0.35, trim, ST); }
    if (hood === 'arch') { const c = o(0.12); sweep(S, F, Array.from({ length: 9 }, (_, k) => { const t = Math.PI * (k / 8); return [c[0] + tu * Math.cos(t) * (w / 2 + 0.17), c[1] + tv * Math.cos(t) * (w / 2 + 0.17), z0 + h + Math.sin(t) * (w / 2 + 0.17), 0.17, 0.2]; }), trim, ST, 5); }
  };
  // cross arms and core, on a socle
  blk(0, 0, 27.6, 11.1, zb, 1.6, trim); blk(0, 0, 11.1, 23.6, zb, 1.6, trim);
  blk(0, 0, 27, 10.5, 1.6, 24); blk(0, 0, 10.5, 23, 1.6, 24); blk(0, 0, 15, 15, zb, 24);
  for (const [z0, z1, d] of [[22.4, 22.8, 0.15], [24, 24.7, 0.45], [24.7, 25.2, 0.7]]) { blk(0, 0, 27 + d, 10.5 + d, z0, z1, trim); blk(0, 0, 10.5 + d, 23 + d, z0, z1, trim); }
  // the arm faces: giant pilasters and framed windows on both storeys; balustraded attic; ends with doors and pediments
  const arms = [[1, 0, 27, 10.5], [-1, 0, 27, 10.5], [0, 1, 23, 10.5], [0, -1, 23, 10.5]];
  const sw = (() => { let best = -9, bi = 0; arms.forEach(([du, dv], i) => { const [x, y] = P2(du, dv), d = (x - cx) * -0.71 + (y - cy) * -0.71; if (d > best) { best = d; bi = i; } }); return bi; })();
  arms.forEach(([du, dv, len, half], i) => {
    const tu = -dv, tv = du;                                // across the arm end
    const end = (d, t) => [du * (len + d) + tu * t, dv * (len + d) + tv * t];
    // end façade: four giant pilasters, door, windows, pediment on the attic
    for (const t of [-8.6, -3.2, 3.2, 8.6]) { const [a, b] = end(0.25, t); tbox(a, b, tu, tv, 0.75, 0.3, 1.6, 22.4, trim); }
    if (i === sw) {
      // main front: a three-arched portico (galilee) with paired columns and a terrace above
      const [pa, pb] = end(3.2, 0); tbox(pa, pb, tu, tv, 10.2, 3.2, 1.6, 2.1, trim);
      for (const t of [-9.6, -6.4, -1.9, 1.9, 6.4, 9.6]) { const [a, b] = end(5.6, t); limb(S, F(a, b, 2.1), F(a, b, 11.2), 0.55, 0.5, 12, white, ST); tbox(a, b, tu, tv, 0.7, 0.7, 2.1, 2.7, trim); tbox(a, b, tu, tv, 0.75, 0.75, 11.0, 11.6, trim); }
      const [ea, eb] = end(3.2, 0); tbox(ea, eb, tu, tv, 10.4, 3.2, 11.6, 13.4, white); tbox(ea, eb, tu, tv, 10.7, 3.5, 13.4, 13.9, trim);
      for (let k = 0; k < 20; k++) { const [a, b] = end(6.2, -9.5 + k); limb(S, F(a, b, 13.9), F(a, b, 14.8), 0.14, 0.1, 6, trim, ST); }
      const [ra, rb] = end(6.2, 0); tbox(ra, rb, tu, tv, 10.2, 0.2, 14.8, 15.1, trim);
      for (const t of [-4.2, 0, 4.2]) { const [a, b] = end(0.05, t); tbox(a, b, tu, tv, 1.5, 0.08, 1.6, 8.4, dark); }
    } else { const [a, b] = end(0.05, 0); tbox(a, b, tu, tv, 1.6, 0.08, 1.6, 7.0, dark); const [c, d] = end(0.3, 0); tbox(c, d, tu, tv, 2.3, 0.3, 7.0, 7.5, trim); }
    for (const t of [-5.9, 0, 5.9]) { const [a, b] = end(0, t); win(a, b, du, dv, 12.5, 1.9, 4.6, t === 0 ? 'pediment' : 'cornice'); }
    // attic and pediment
    { const [a, b] = end(-0.4, 0); tbox(a, b, tu, tv, half - 0.4, 0.5, 25.2, 28.2, white); const [c, d] = end(-0.3, 0); tbox(c, d, tu, tv, half - 0.2, 0.6, 28.2, 28.7, trim);
      const P = end(0.1, 0), A = F(P[0] - tu * 9.5, P[1] - tv * 9.5, 28.7), B = F(P[0] + tu * 9.5, P[1] + tv * 9.5, 28.7), T = F(P[0], P[1], 32.2); slab4(S, [A, B, T, T], 1.0, white, ST);
      const P3 = end(0.75, 0), A2 = F(P3[0] - tu * 9.9, P3[1] - tv * 9.9, 28.6), B2 = F(P3[0] + tu * 9.9, P3[1] + tv * 9.9, 28.6), T2 = F(P3[0], P3[1], 32.6); slab4(S, [A2, B2, T2, T2], 0.3, trim, ST);
      ell(S, F, [P[0] + du * 0.6, P[1] + dv * 0.6, 30.0], [1.0, 1.0, 1.1], trim, ST, 8); }
    // side walls of the arm: windows between pilasters
    for (const s of [-1, 1]) for (const along of [len - 2.1]) {
      const a = du * along + tu * s * half, b = dv * along + tv * s * half;
      win(a, b, tu * s, tv * s, 4.5, 1.5, 3.4, 'cornice'); win(a, b, tu * s, tv * s, 13.2, 1.5, 3.8, 'arch');
      const pa = du * (len - 0.4) + tu * s * (half + 0.2), pb = dv * (len - 0.4) + tv * s * (half + 0.2); tbox(pa, pb, du, dv, 0.4, 0.2, 1.6, 22.4, trim);
    }
  });
  // corner towers: rusticated angles, windows, balustrade, ribbed cupola with a finial
  for (const su of [-1, 1]) for (const sv of [-1, 1]) {
    const tu0 = su * 17, tv0 = sv * 15.5;
    blk(tu0, tv0, 4.5, 4.5, zb, 31); blk(tu0, tv0, 4.9, 4.9, 31, 31.6, trim); blk(tu0, tv0, 5.1, 5.1, 31.6, 32, trim);
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) blk(tu0 + a * 4.3, tv0 + b * 4.3, 0.35, 0.35, 1.6, 31, trim);
    for (const [nu, nv] of [[su, 0], [0, sv]]) { win(tu0 + nu * 4.5, tv0 + nv * 4.5, nu, nv, 26.0, 1.4, 3.4, 'arch'); win(tu0 + nu * 4.5, tv0 + nv * 4.5, nu, nv, 17.5, 1.2, 2.8, 'cornice'); }
    const T = (a, b, z) => F(tu0 + a, tv0 + b, z);
    for (let k = 0; k < 16; k++) { const t = (k / 16) * Math.PI * 2; limb(S, T(Math.cos(t) * 4.5, Math.sin(t) * 4.5, 32), T(Math.cos(t) * 4.5, Math.sin(t) * 4.5, 33.0), 0.12, 0.09, 5, trim, ST); }
    sweep(S, T, [[0, 0, 32, 3.6, 3.6], [0, 0, 33.6, 3.5, 3.5], [0, 0, 35.0, 2.7, 2.7], [0, 0, 36.0, 1.5, 1.5], [0, 0, 36.5, 0.5, 0.5], [0, 0, 37.2, 0.35, 0.35], [0, 0, 37.7, 0.6, 0.6], [0, 0, 38.6, 0.05, 0.05]], domeC, ST, 16, true);
    for (let k = 0; k < 8; k++) { const t = (k / 8) * Math.PI * 2, c = Math.cos(t), s2 = Math.sin(t); sweep(S, T, [[c * 3.65, s2 * 3.65, 32.1, 0.12, 0.12], [c * 3.55, s2 * 3.55, 33.6, 0.12, 0.12], [c * 2.75, s2 * 2.75, 35.0, 0.11, 0.11], [c * 1.55, s2 * 1.55, 36.0, 0.09, 0.09], [c * 0.5, s2 * 0.5, 36.5, 0.06, 0.06]], trim, ST, 5); }
  }
  // drum: base, paired pilasters with arched windows between, entablature, balustrade
  const C = F;
  sweep(S, C, [[0, 0, 24, 14.2, 14.2], [0, 0, 28, 14.2, 14.2]], white, ST, 32, false);
  sweep(S, C, [[0, 0, 28, 14.6, 14.6], [0, 0, 28.8, 14.6, 14.6]], trim, ST, 32, true);
  sweep(S, C, [[0, 0, 28.8, 12.5, 12.5], [0, 0, 40, 12.5, 12.5]], white, ST, 32, false);
  for (let k = 0; k < 16; k++) {
    const t = (k / 16) * Math.PI * 2, c = Math.cos(t), s2 = Math.sin(t);
    for (const d of [-0.11, 0.11]) { const a = Math.cos(t + d) * 12.75, b = Math.sin(t + d) * 12.75; tbox(a, b, -Math.sin(t + d), Math.cos(t + d), 0.45, 0.3, 28.8, 39.6, trim); }
    const tw = t + Math.PI / 16; win(Math.cos(tw) * 12.5, Math.sin(tw) * 12.5, Math.cos(tw), Math.sin(tw), 31.0, 1.9, 5.2, 'arch');
    void c; void s2;
  }
  sweep(S, C, [[0, 0, 39.6, 13.1, 13.1], [0, 0, 40.4, 13.1, 13.1]], trim, ST, 32, false);
  sweep(S, C, [[0, 0, 40.4, 13.6, 13.6], [0, 0, 41.2, 13.6, 13.6]], trim, ST, 32, true);
  for (let k = 0; k < 64; k++) { const t = (k / 64) * Math.PI * 2; limb(S, F(Math.cos(t) * 13.3, Math.sin(t) * 13.3, 41.2), F(Math.cos(t) * 13.3, Math.sin(t) * 13.3, 42.2), 0.13, 0.1, 5, trim, ST, false); }
  sweep(S, C, [[0, 0, 42.2, 13.4, 13.4], [0, 0, 42.5, 13.4, 13.4]], trim, ST, 32, true);
  // dome: a smooth profile in 32 facets, 16 ribs, small oculi, lantern with columns, cupolino, finial
  const prof = []; for (let k = 0; k <= 10; k++) { const a = (k / 10) * Math.PI / 2; prof.push([0, 0, 41.2 + Math.sin(a) * 15.5, Math.max(0.05, Math.cos(a) * 12.5), Math.max(0.05, Math.cos(a) * 12.5)]); }
  sweep(S, C, prof.slice(0, 10).concat([[0, 0, 41.2 + Math.sin((9.4 / 10) * Math.PI / 2) * 15.5, 2.3, 2.3]]), domeC, ST, 32, true);
  for (let k = 0; k < 16; k++) { const t = (k / 16) * Math.PI * 2, c = Math.cos(t), s2 = Math.sin(t); sweep(S, C, Array.from({ length: 9 }, (_, q) => { const a = (q / 9) * Math.PI / 2 * 0.95; const r = Math.cos(a) * 12.65; return [c * r, s2 * r, 41.2 + Math.sin(a) * 15.65, 0.28, 0.2]; }), trim, ST, 5, false); }
  for (let k = 0; k < 8; k++) { const t = ((k + 0.5) / 8) * Math.PI * 2; ell(S, C, [Math.cos(t) * 10.9, Math.sin(t) * 10.9, 49.2], [0.7, 0.7, 0.7], trim, ST, 8); }
  sweep(S, C, [[0, 0, 56.4, 2.6, 2.6], [0, 0, 57.0, 2.6, 2.6]], trim, ST, 16, true);
  sweep(S, C, [[0, 0, 57, 1.6, 1.6], [0, 0, 61.6, 1.6, 1.6]], dark, ST, 12, false);
  for (let k = 0; k < 8; k++) { const t = (k / 8) * Math.PI * 2; limb(S, F(Math.cos(t) * 2.1, Math.sin(t) * 2.1, 57), F(Math.cos(t) * 2.1, Math.sin(t) * 2.1, 61.6), 0.24, 0.2, 8, white, ST); }
  sweep(S, C, [[0, 0, 61.6, 2.5, 2.5], [0, 0, 62.3, 2.5, 2.5], [0, 0, 62.3, 2.1, 2.1], [0, 0, 63.6, 1.6, 1.6], [0, 0, 64.5, 0.7, 0.7], [0, 0, 65.0, 0.3, 0.3], [0, 0, 65.6, 0.45, 0.45], [0, 0, 66.2, 0.05, 0.05]], domeC, ST, 16, true);
  limb(S, F(0, 0, 66.2), F(0, 0, 68.4), 0.08, 0.08, 4, dark, ST);
  limb(S, F(-0.5, 0, 67.7), F(0.5, 0, 67.7), 0.07, 0.07, 4, dark, ST);
  void pink;
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
  const white = lin(srgb(wall || '#f1ede4')), stone = lin(srgb('#d6cdb9')), dark = lin(srgb('#2f3033')), roof = lin(srgb(roofHex || '#a85e47'));
  const ST = [KIND.STONE / 8, 5 / 8, seed, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, seed, 1], TL = [KIND.TILES / 8, 5 / 8, seed, 1], I0 = [0, 0, 0, 0];
  const zb = gmin - ground - 1.5;
  const K = kit(S, { cx, cy, ux, uy, ground, zb, wall: white, roof, ST: PL, TL });
  const { P2, W3, blk, block, gable } = K;
  const { tbox, win } = openings(S, P2, W3, ux, uy, ground, stone, dark, ST);
  const urn = (u, v, z, r = 0.32) => { sweep(S, W3, [[u, v, z, r * 0.7, r * 0.7], [u, v, z + r * 0.4, r * 0.45, r * 0.45], [u, v, z + r * 1.1, r, r], [u, v, z + r * 1.8, r * 0.55, r * 0.55], [u, v, z + r * 2.4, 0.04, 0.04]], stone, ST, 8); };
  const cross = (u, v, z, h = 1.4) => { limb(S, W3(u, v, z), W3(u, v, z + h), 0.06, 0.06, 4, dark, ST); limb(S, W3(u, v - h * 0.3, z + h * 0.68), W3(u, v + h * 0.3, z + h * 0.68), 0.05, 0.05, 4, dark, ST); };
  const F = -hl, tw = Math.min(3.6, Math.max(2.2, hw * 0.42)), Tt = Math.min(11, Math.max(6, tw * 2.8));
  const chL = Math.min(hl * 0.32, hw * 1.1), hc = hw * 0.68, back = hl - chL;
  // nave: plinth, pilaster strips, cornice, framed arched windows
  block(F, back, -hw, hw, H); gable(F, back, -hw - 0.3, hw + 0.3, H, H + hw * 0.55);
  blk(F - 0.12, back + 0.12, -hw - 0.15, hw + 0.15, H - 0.55, H, stone, ST);
  blk(F - 0.08, back + 0.08, -hw - 0.1, hw + 0.1, zb, 0.6, stone, ST);
  for (const sv of [-1, 1]) {
    for (let u = F + 0.4; u <= back - 0.3; u += Math.max(4, (back - F - 0.8) / Math.max(1, Math.round((back - F) / 6)))) blk(u - 0.3, u + 0.3, sv * hw - 0.12, sv * hw + 0.12, zb, H - 0.55, stone, ST);
    for (let u = F + 5; u < back - 2; u += 5.5) win(u, sv * hw, 0, sv, H * 0.5, 1.1, Math.min(3.0, H * 0.26), 'arch', 0.12);
  }
  // chancel and sacristies
  block(back, hl, -hc, hc, H * 0.86); gable(back - 0.3, hl, -hc - 0.3, hc + 0.3, H * 0.86, H * 0.86 + hc * 0.55);
  for (const sv of [-1, 1]) { block(back, hl, sv > 0 ? hc : -hw, sv > 0 ? hw : -hc, H * 0.5); gable(back, hl + 0.2, sv > 0 ? hc : -hw - 0.2, sv > 0 ? hw + 0.2 : -hc, H * 0.5, H * 0.5 + (hw - hc) * 0.5); }
  // front: giant pilasters, entablature, pediment with urns and cross, portal with hood, choir window, niche
  const fw = towers === 2 ? hw - 2 * tw + 0.2 : hw, fc = towers === 1 ? -towerSide * tw : 0;
  const pedH = H + Math.max(hw * 0.55, 2) + 1.0;
  tri(S, W3(F - 0.06, fc - fw, H - 0.6), W3(F - 0.06, fc + fw, H - 0.6), W3(F - 0.06, fc, pedH + 0.35), W3(-1, 0, 0).map((v, i) => v - W3(0, 0, 0)[i]), stone, [0, 0], [1, 0], [0, 1], I0, ST);
  tri(S, W3(F - 0.12, fc - fw + 0.7, H - 0.1), W3(F - 0.12, fc + fw - 0.7, H - 0.1), W3(F - 0.12, fc, pedH - 0.45), W3(-1, 0, 0).map((v, i) => v - W3(0, 0, 0)[i]), white, [0, 0], [1, 0], [0, 1], I0, PL);
  { const L = Math.hypot(fw, pedH - H + 0.95), dv = fw / L, dz = (pedH - H + 0.95) / L;   // raking cornices
    for (const sg of [-1, 1]) slab4(S, [W3(F - 0.3, fc + sg * (fw + 0.2), H - 0.65), W3(F - 0.3, fc, pedH + 0.55), W3(F - 0.3, fc, pedH + 0.2), W3(F - 0.3, fc + sg * (fw + 0.2), H - 1.0)], 0.4, stone, ST); void dv; void dz; }
  blk(F - 0.25, F, fc - fw - 0.1, fc + fw + 0.1, H - 1.2, H - 0.1, stone, ST);
  for (const t of towers ? [-1, 1] : [-1, -0.35, 0.35, 1]) blk(F - 0.22, F, fc + t * (fw - 0.45) - 0.4, fc + t * (fw - 0.45) + 0.4, 0, H - 1.2, stone, ST);
  for (const sg of [-1, 1]) urn(F - 0.2, fc + sg * (fw - 0.3), H - 0.1);
  if (towers) { urn(F - 0.2, fc, pedH + 0.45, 0.25); cross(F - 0.2, fc, pedH + 1.05, 1.5); }
  const dw = Math.min(1.3, hw * 0.2), dh = Math.min(5, H * 0.38);
  win(F, fc, -1, 0, 0, dw * 2, dh, 'pediment', 0.3);
  if (H > 10) { win(F, fc, -1, 0, dh + 2.3, 1.3, 2.0, 'cornice', 0.15); if (fw > 3.5 && !towers) for (const sg of [-1, 1]) win(F, fc + sg * fw * 0.62, -1, 0, dh + 2.3, 0.9, 1.6, 'arch', 0.12); }
  ell(S, W3, [F - 0.15, fc, (H - 1.2 + pedH) / 2 - 0.2], [0.12, 0.7, 0.7], dark, ST, 8);   // oculus in the tympanum
  // bell towers: corner pilasters, cornices, arched belfry on every face, balustrade with urns, ribbed cupola or spire
  const tv = towers === 2 ? [-1, 1] : towers === 1 ? [towerSide] : [];
  for (const sv of tv) {
    const vc = sv * (hw - tw), u0 = F, u1 = F + 2 * tw, top = H + Tt, um = (u0 + u1) / 2;
    blk(u0, u1, vc - tw, vc + tw, zb, top, white);
    for (const [a, b] of [[u0, vc - tw], [u1, vc - tw], [u0, vc + tw], [u1, vc + tw]]) blk(a - 0.25, a + 0.25, b - 0.25, b + 0.25, zb, top, stone, ST);
    for (const z of [H - 0.55, top - 0.5]) blk(u0 - 0.2, u1 + 0.2, vc - tw - 0.2, vc + tw + 0.2, z, z + 0.55, stone, ST);
    const bo = Math.min(0.75, tw * 0.32), bz0 = top - 4.4, bh = 3.0;
    win(u0, vc, -1, 0, bz0, bo * 2, bh, 'arch', 0.15); win(u1, vc, 1, 0, bz0, bo * 2, bh, 'arch', 0.15);
    win(um, vc - tw, 0, -1, bz0, bo * 2, bh, 'arch', 0.15); win(um, vc + tw, 0, 1, bz0, bo * 2, bh, 'arch', 0.15);
    win(u0, vc, -1, 0, H + 1.2, 0.6, 1.4, 'cornice', 0.1);
    for (const [a, b] of [[u0, vc - tw], [u1, vc - tw], [u0, vc + tw], [u1, vc + tw]]) urn(a, b, top + 0.05, 0.28);
    const c = W3(um, vc, 0), at = (z) => [c[0], ground + z, c[2]];
    let tip = top;
    if (cap === 'spire') { limb(S, at(top), at(top + tw * 2.2), tw * 1.25, 0.08, 4, roof, TL); tip = top + tw * 2.2; }
    else {
      const T = (a, b, z) => W3(um + a, vc + b, z), r = tw * 0.92;
      sweep(S, T, [[0, 0, top, r, r], [0, 0, top + 0.7, r, r], [0, 0, top + 0.7, r * 0.96, r * 0.96], [0, 0, top + 0.7 + tw * 0.45, r * 0.85, r * 0.85], [0, 0, top + 0.7 + tw * 0.85, r * 0.5, r * 0.5], [0, 0, top + 0.7 + tw * 1.05, r * 0.2, r * 0.2], [0, 0, top + 0.7 + tw * 1.25, r * 0.16, r * 0.16], [0, 0, top + 0.7 + tw * 1.5, 0.03, 0.03]], white, PL, 12, true);
      for (let k = 0; k < 8; k++) { const t = (k / 8) * Math.PI * 2, cc = Math.cos(t), ss = Math.sin(t); sweep(S, T, [[cc * r, ss * r, top + 0.7, 0.08, 0.08], [cc * r * 0.86, ss * r * 0.86, top + 0.7 + tw * 0.45, 0.08, 0.08], [cc * r * 0.5, ss * r * 0.5, top + 0.7 + tw * 0.85, 0.07, 0.07], [cc * r * 0.2, ss * r * 0.2, top + 0.7 + tw * 1.05, 0.05, 0.05]], stone, ST, 4); }
      tip = top + 0.7 + tw * 1.5;
    }
    cross(um, vc, tip, 1.3);
  }
  if (!tv.length) {   // bell gable over the pediment
    blk(F - 0.05, F + 0.5, fc - 0.9, fc + 0.9, pedH - 0.6, pedH + 2.0, white);
    win(F - 0.05, fc, -1, 0, pedH + 0.2, 0.9, 1.2, 'arch', 0.1);
    cross(F + 0.2, fc, pedH + 2.0, 1.2);
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
export function marquesColumn(S, { cx, cy, ground, lin, srgb, heading = Math.PI }) {
  const stone = lin(srgb('#ece7dc')), shade = lin(srgb('#d3cbba')), bronze = lin(srgb('#4c5747')), bronzeHi = lin(srgb('#5d6a58'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.31, 0.9], PL = [KIND.PLAIN / 8, 5 / 8, 0.31, 1], I0 = [0, 0, 0, 0];
  const fx = Math.sin(heading), fy = Math.cos(heading), F = frame(cx, cy, fy, -fx, ground), U = [fy, -fx];
  const L = (a0, b0, z0) => (a, b, z) => F(a0 + a, b0 + b, z0 + z);
  const C = L(0, 0, 0);
  // round stepped platform with a balustrade ring
  for (let k = 0; k < 4; k++) sweep(S, C, [[0, 0, -0.6, 12.5 - k * 1.4, 12.5 - k * 1.4], [0, 0, 0.5 * (k + 1), 12.5 - k * 1.4, 12.5 - k * 1.4]], k % 2 ? shade : stone, ST, 40, true);
  // pedestal: base, die with relief panels and the four allegorical groups, cornice
  box(S, cx, cy, ...U, 5.4, 5.4, ground + 2, ground + 3.0, shade, I0, ST);
  box(S, cx, cy, ...U, 5.0, 5.0, ground + 3.0, ground + 3.6, stone, I0, ST);
  box(S, cx, cy, ...U, 4.2, 4.2, ground + 3.6, ground + 12.2, stone, I0, ST);
  for (const [a, b, c, d] of [[12.2, 12.5, 4.35, shade], [12.5, 13.0, 4.6, stone], [13.0, 13.4, 4.45, shade]]) box(S, cx, cy, ...U, c, c, ground + a, ground + b, d, I0, ST);
  [[0, 1], [1, 0], [0, -1], [-1, 0]].forEach(([dx, dy], k) => {
    const ang = Math.atan2(dx, dy), c = Math.cos(ang), s2 = Math.sin(ang);
    const O = (ox, oy, oz) => (a, b, z) => F(ox + a * c + b * s2, oy - a * s2 + b * c, oz + z);
    const G = O(dx * 4.2, dy * 4.2, 3.6);
    slab4(S, [G(-2.8, 0.06, 7.8), G(2.8, 0.06, 7.8), G(2.8, 0.06, 4.2), G(-2.8, 0.06, 4.2)], 0.14, bronze, PL);   // bronze relief panel
    for (let q = 0; q < 5; q++) ell(S, G, [-2.2 + q * 1.1, 0.18, 6.0], [0.3, 0.12, 0.9 + 0.2 * (q % 2)], bronzeHi, PL, 6);
    const B = O(dx * 6.0, dy * 6.0, 2);
    const p = F(dx * 6.0, dy * 6.0, 0); box(S, p[0], -p[2], ...U, dy ? 3.2 : 1.8, dy ? 1.8 : 3.2, ground + 2, ground + 3.4, shade, I0, ST);
    const BB = O(dx * 6.0, dy * 6.0, 3.4);
    if (k === 0) {   // front: the waters (1755) and Lisbon rising; broken masonry
      for (let q = 0; q < 6; q++) sweep(S, BB, [[-2.8 + q * 1.1, 0.6, 0, 0.35, 0.3], [-2.6 + q * 1.1, 1.1, 0.9, 0.25, 0.2], [-2.3 + q * 1.1, 1.3, 1.4, 0.06, 0.06]], bronzeHi, PL, 6);
      figure(S, O(dx * 6.0, dy * 6.0 - 0.2, 3.4), 1.6, bronze, PL, { robe: true, crown: true, arms: [[-0.4, 0.3, 0.6], [0.4, 0.3, 0.6]] });
    } else {
      figure(S, O(dx * 6.0 - 0.9 * c, dy * 6.0 + 0.9 * s2, 3.4), 1.45, bronze, PL, { seated: true, cloak: true, arms: [[-0.2, 0.3, -0.3], [0.2, 0.35, 0.05 * k]] });
      figure(S, O(dx * 6.0 + 1.0 * c, dy * 6.0 - 1.0 * s2, 3.4), 1.5, bronze, PL, { robe: k !== 2, stride: 0.5, arms: [[-0.25, 0.3, 0.1 * k], [0.1, 0.1, -0.55]] });
    }
    void B;
  });
  // the column: base, shaft, capital, die
  sweep(S, C, [[0, 0, 13.4, 2.25, 2.25], [0, 0, 13.9, 2.25, 2.25], [0, 0, 13.9, 2.0, 2.0], [0, 0, 14.3, 2.0, 2.0], [0, 0, 14.6, 1.8, 1.8]], shade, ST, 20, true);
  loft(S, C, [{ z: 14.6, rx: 1.75, ry: 1.75 }, { z: 24, rx: 1.68, ry: 1.68 }, { z: 34.0, rx: 1.5, ry: 1.5 }], stone, ST, { sides: 28, cap: false });
  corinthian(S, C, 1.5, 34.0, 2.6, stone, shade, ST);
  box(S, cx, cy, ...U, 2.1, 2.1, ground + 36.6, ground + 37.0, shade, I0, ST);
  box(S, cx, cy, ...U, 1.85, 1.85, ground + 37.0, ground + 37.6, stone, I0, ST);
  // the Marquês in coat and cloak, his hand on the lion
  const K = L(-0.3, 0, 37.6);
  figure(S, K, 2.4, bronze, PL, { cloak: true, stride: 0.3, arms: [[-0.12, 0.2, -0.5], [0.4, 0.15, -0.5]] });
  sweep(S, K, [[-0.55, -0.2, 0.5, 0.2, 0.08], [-0.45, -0.45, 1.6, 0.35, 0.08], [0, -0.5, 3.1, 0.5, 0.08], [0.45, -0.45, 1.6, 0.35, 0.08], [0.55, -0.2, 0.5, 0.2, 0.08]], bronze, PL, 6);
  lion(S, (a, b, z) => F(1.45 + b * 0 + a, -0.2 + b, 37.6 + z), 1.55, bronzeHi, PL);
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

// ─── sculpture kit 2: swept tubes, human figures, horses ─────────────────
// All in a local frame W(a, b, z): a = right, b = forward, z = up (metres before scaling).
const v3 = { sub: (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]], cross: (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]], norm: (p) => { const l = Math.hypot(...p) || 1; return p.map((c) => c / l); } };
// tube through path points [a, b, z, rw, rh]: elliptical sections, rw across (horizontal side), rh in the section's up
export function sweep(S, W, path, col, st, sides = 10, caps = true) {
  const I0 = [0, 0, 0, 0], o = W(0, 0, 0), WV = (v) => { const w = W(v[0], v[1], v[2]); return [w[0] - o[0], w[1] - o[1], w[2] - o[2]]; };
  const P = path.map((p) => p.slice(0, 3));
  const rings = path.map((p, i) => {
    const T = v3.norm(v3.sub(P[Math.min(P.length - 1, i + 1)], P[Math.max(0, i - 1)]));
    let side = v3.cross(T, [0, 0, 1]); if (Math.hypot(...side) < 0.2) side = v3.cross(T, [0, 1, 0]); side = v3.norm(side);
    const up = v3.norm(v3.cross(side, T));
    return Array.from({ length: sides }, (_, k) => {
      const t = (k / sides) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      const q = [p[0] + side[0] * c * p[3] + up[0] * s * p[4], p[1] + side[1] * c * p[3] + up[1] * s * p[4], p[2] + side[2] * c * p[3] + up[2] * s * p[4]];
      const nl = v3.norm([side[0] * c * p[4] + up[0] * s * p[3], side[1] * c * p[4] + up[1] * s * p[3], side[2] * c * p[4] + up[2] * s * p[3]]);
      return { w: W(...q), n: v3.norm(WV(nl)) };
    });
  });
  for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides, A = rings[i][k], B = rings[i][k2], C = rings[i + 1][k2], D = rings[i + 1][k];
    const n = v3.norm([A.n[0] + B.n[0] + C.n[0] + D.n[0], A.n[1] + B.n[1] + C.n[1] + D.n[1], A.n[2] + B.n[2] + C.n[2] + D.n[2]]);
    tri(S, A.w, B.w, C.w, n, col, [0, 0], [0, 0], [0, 0], I0, st); tri(S, A.w, C.w, D.w, n, col, [0, 0], [0, 0], [0, 0], I0, st);
  }
  if (caps) for (const [i, j] of [[0, 1], [rings.length - 1, rings.length - 2]]) {
    const c = W(...P[i]), d = v3.norm(v3.sub(c, W(...P[j])));
    for (let k = 0; k < sides; k++) tri(S, c, rings[i][k].w, rings[i][(k + 1) % sides].w, d, col, [0, 0], [0, 0], [0, 0], I0, st);
  }
}
const ell = (S, W, c, r, col, st, sides = 10) => sweep(S, W, [[c[0], c[1], c[2] - r[2], 0.01, 0.01], [c[0], c[1], c[2] - r[2] * 0.7, r[0] * 0.71, r[1] * 0.71], [c[0], c[1], c[2], r[0], r[1]], [c[0], c[1], c[2] + r[2] * 0.7, r[0] * 0.71, r[1] * 0.71], [c[0], c[1], c[2] + r[2], 0.01, 0.01]], col, st, sides, false);
// a human figure about 1.8 m tall before scaling: pose = { seated, robe, cloak, arms: [[a,b,z] left hand, right hand] relative to the shoulder, helmet, wings, stride }
export function figure(S, W0, sc, col, st, pose = {}) {
  const W = (a, b, z) => W0(a * sc, b * sc, z * sc);
  const seated = !!pose.seated, hip = seated ? 0.52 : 0.94, stride = pose.stride || 0;
  // legs (hidden by a robe when it falls to the feet)
  for (const s of [-1, 1]) {
    if (pose.rider) { sweep(S, W, [[s * 0.11, 0, hip, 0.095, 0.095], [s * 0.27, 0.3, hip - 0.2, 0.075, 0.075], [s * 0.3, 0.18, hip - 0.62, 0.055, 0.055], [s * 0.3, 0.38, hip - 0.68, 0.045, 0.04]], col, st, 7); }
    else if (seated) { sweep(S, W, [[s * 0.11, 0, hip, 0.09, 0.09], [s * 0.13, 0.42, hip + 0.02, 0.075, 0.075], [s * 0.13, 0.46, 0.08, 0.055, 0.055], [s * 0.13, 0.6, 0.03, 0.05, 0.04]], col, st, 7); }
    else if (!pose.robe) { const f = s * stride; sweep(S, W, [[s * 0.1, 0, hip, 0.085, 0.085], [s * 0.1, f * 0.16, 0.5, 0.06, 0.06], [s * 0.1, f * 0.28, 0.08, 0.045, 0.045], [s * 0.1, f * 0.28 + 0.16, 0.03, 0.045, 0.035]], col, st, 7); }
  }
  // robe / skirt to the feet, or a short tunic
  if (pose.robe) sweep(S, W, [[0, 0.02, 0.0, 0.27, 0.22], [0, 0.02, 0.35, 0.24, 0.19], [0, 0.0, 0.75, 0.2, 0.15], [0, 0, 1.0, 0.17, 0.12]], col, st, 12, true);
  else if (seated && !pose.rider) sweep(S, W, [[0, 0.32, hip - 0.12, 0.25, 0.1], [0, 0.05, hip, 0.2, 0.15], [0, 0, hip + 0.12, 0.17, 0.12]], col, st, 10, true);
  // torso: pelvis → chest → shoulders
  const z0 = seated ? hip : 0.94;
  sweep(S, W, [[0, 0, z0, 0.16, 0.11], [0, 0.01, z0 + 0.2, 0.15, 0.1], [0, 0.02, z0 + 0.4, 0.18, 0.11], [0, 0.0, z0 + 0.5, 0.2, 0.1], [0, -0.01, z0 + 0.56, 0.08, 0.06]], col, st, 10, true);
  const sh = z0 + 0.5, head = z0 + 0.7;
  ell(S, W, [0, 0.01, head], [0.1, 0.115, 0.125], col, st, 9);                                         // head
  sweep(S, W, [[0, 0, sh, 0.05, 0.05], [0, 0.01, head - 0.08, 0.045, 0.045]], col, st, 6, false);   // neck
  if (pose.helmet) sweep(S, W, [[0, 0, head + 0.06, 0.115, 0.125], [0, -0.02, head + 0.16, 0.09, 0.1], [0, -0.06, head + 0.36, 0.05, 0.03]], col, st, 8);
  if (pose.crown) for (let k = 0; k < 6; k++) { const t = (k / 6) * Math.PI * 2; sweep(S, W, [[Math.cos(t) * 0.09, Math.sin(t) * 0.1, head + 0.1, 0.02, 0.02], [Math.cos(t) * 0.1, Math.sin(t) * 0.11, head + 0.19, 0.012, 0.012]], col, st, 4); }
  // arms: shoulder → elbow → hand, hands given relative to the shoulder
  const arms = pose.arms || [[-0.05, 0.05, -0.6], [0.05, 0.05, -0.6]];
  for (const [k, s] of [[0, -1], [1, 1]]) {
    const S0 = [s * 0.21, 0, sh - 0.02], h = arms[k], H = [S0[0] + s * Math.abs(h[0]) * (h[0] * s >= 0 ? 1 : -1), S0[1] + h[1], S0[2] + h[2]];
    const M = [(S0[0] + H[0]) / 2 + s * 0.06, (S0[1] + H[1]) / 2 - 0.04, (S0[2] + H[2]) / 2 - 0.03];
    sweep(S, W, [[...S0, 0.055, 0.055], [...M, 0.045, 0.045], [...H, 0.035, 0.035]], col, st, 6);
    ell(S, W, H, [0.04, 0.05, 0.06], col, st, 5);
  }
  if (pose.cloak) slab4(S, [W(-0.22, -0.08, sh), W(0.22, -0.08, sh), W(0.3, -0.22, seated ? hip - 0.1 : 0.25), W(-0.3, -0.22, seated ? hip - 0.1 : 0.25)], 0.04 * sc, col, st);
  if (pose.wings) for (const s of [-1, 1]) slab4(S, [W(s * 0.08, -0.1, sh - 0.05), W(s * 0.5, -0.4, sh + 0.55), W(s * 0.62, -0.42, sh + 0.2), W(s * 0.2, -0.16, sh - 0.55)], 0.03 * sc, col, st);
  return { head: W(0, 0, head), hands: arms.map((h, k) => W((k ? 1 : -1) * 0.21 + h[0], h[1], sh + h[2])) };
}
// a horse ~1.6 m at the withers before scaling; pose.raise = lift the right foreleg (walking statue pose)
export function horse(S, W0, sc, col, st, pose = {}) {
  const W = (a, b, z) => W0(a * sc, b * sc, z * sc);
  sweep(S, W, [[0, -1.12, 1.3, 0.12, 0.12], [0, -1.02, 1.3, 0.3, 0.3], [0, -0.75, 1.27, 0.38, 0.41], [0, -0.35, 1.2, 0.38, 0.42], [0, 0.05, 1.16, 0.39, 0.46],
    [0, 0.42, 1.2, 0.35, 0.45], [0, 0.75, 1.27, 0.3, 0.38], [0, 0.93, 1.3, 0.2, 0.28], [0, 1.0, 1.32, 0.06, 0.08]], col, st, 14);               // body
  sweep(S, W, [[0, 0.72, 1.45, 0.19, 0.3], [0, 0.98, 1.78, 0.15, 0.25], [0, 1.18, 2.07, 0.12, 0.19], [0, 1.3, 2.22, 0.11, 0.14]], col, st, 10, false);   // neck
  sweep(S, W, [[0, 1.27, 2.26, 0.1, 0.12], [0, 1.42, 2.15, 0.11, 0.13], [0, 1.6, 1.92, 0.085, 0.1], [0, 1.7, 1.78, 0.07, 0.085], [0, 1.73, 1.74, 0.03, 0.04]], col, st, 9);   // head
  for (const s of [-1, 1]) sweep(S, W, [[s * 0.06, 1.28, 2.3, 0.025, 0.03], [s * 0.07, 1.25, 2.44, 0.005, 0.01]], col, st, 4);   // ears
  slab4(S, [W(0, 0.7, 1.68), W(0, 1.28, 2.33), W(0, 1.2, 2.18), W(0, 0.65, 1.5)], 0.06 * sc, col, st);                                   // mane
  sweep(S, W, [[0, -1.1, 1.36, 0.07, 0.08], [0, -1.24, 1.15, 0.09, 0.09], [0, -1.27, 0.85, 0.1, 0.08], [0, -1.2, 0.6, 0.06, 0.05]], col, st, 7);   // tail
  const leg = (pts) => sweep(S, W, pts, col, st, 7);
  for (const s of [-1, 1]) {
    if (s > 0 && pose.raise) leg([[s * 0.17, 0.68, 1.05, 0.13, 0.15], [s * 0.17, 0.86, 0.72, 0.075, 0.08], [s * 0.17, 0.8, 0.45, 0.055, 0.055], [s * 0.17, 0.92, 0.36, 0.065, 0.06]]);
    else leg([[s * 0.17, 0.68, 1.05, 0.13, 0.15], [s * 0.17, 0.7 + (s < 0 && pose.raise ? 0.06 : 0), 0.55, 0.075, 0.08], [s * 0.17, 0.72, 0.18, 0.055, 0.055], [s * 0.17, 0.74, 0.03, 0.07, 0.07]]);
    leg([[s * 0.19, -0.78, 1.05, 0.15, 0.18], [s * 0.19, -0.6, 0.75, 0.1, 0.11], [s * 0.18, -0.86, 0.5, 0.065, 0.07], [s * 0.18, -0.8, 0.18, 0.055, 0.055], [s * 0.18, -0.78, 0.03, 0.07, 0.07]]);
  }
  return { saddle: W(0, -0.05, 1.62) };
}

// Aqueduto das Águas Livres (1731–1748): the 941 m run of arches over the Alcântara valley, on the
// line OSM maps for it (way 675995512, with its 30° bend). 35 arches; the 14 big ones in the middle
// are pointed, the rest round; the Arco Grande spans 28.9 m and rises 65 m. Tall piers carry stepped
// buttresses on both faces; above the cornice runs the public walk between parapets, with the covered
// water gallery down the middle and ventilation turrets along it. Deck level is a straight grade
// between the two valley rims, the arch sizes follow the valley depth under each bay.
export const AQUEDUTO_LINE = [[38.733613, -9.172395], [38.732580, -9.172063], [38.730652, -9.171430], [38.726796, -9.166663]];
export function aqueduto(S, { fwd, groundAt, lin, srgb, log = () => {} }) {
  const stone = lin(srgb('#d4cbb5')), stone2 = lin(srgb('#c4b99f')), stoneD = lin(srgb('#b2a78e')), cap = lin(srgb('#bfb5a0')), dark = lin(srgb('#45423b'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.37, 0.9], I0 = [0, 0, 0, 0];
  const pts = AQUEDUTO_LINE.map(([la, lo]) => fwd(la, lo));
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const seg = (i) => { const [ax, ay] = pts[i], [bx, by] = pts[i + 1], d = Math.hypot(bx - ax, by - ay); return [(bx - ax) / d, (by - ay) / d]; };
  // centreline point and a direction blended over ±10 m around each bend, so strips stay continuous
  const at = (u) => {
    let i = 0; while (i < pts.length - 2 && cum[i + 1] < u) i++;
    const t = (u - cum[i]) / (cum[i + 1] - cum[i]), x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
    let [dx, dy] = seg(i);
    for (let k = 1; k < pts.length - 1; k++) {
      const w = 1 - Math.min(1, Math.abs(u - cum[k]) / 10);
      if (w > 0) { const a = seg(k - 1), b = seg(k), m = [a[0] + b[0], a[1] + b[1]], l = Math.hypot(...m); const f = u < cum[k] ? m.map((q, j) => (q / l) * w + a[j] * (1 - w)) : m.map((q, j) => (q / l) * w + b[j] * (1 - w)); const lf = Math.hypot(...f); dx = f[0] / lf; dy = f[1] / lf; }
    }
    return { x, y, dx, dy };
  };
  const P = (u, v, z) => { const a = at(u); return [a.x - a.dy * v, z, -(a.y + a.dx * v)]; };
  const P2 = (u, v) => { const a = at(u); return [a.x - a.dy * v, a.y + a.dx * v]; };
  const N = (u, nu, nv, nz) => { const a = at(u); return [a.dx * nu - a.dy * nv, nz, -(a.dy * nu + a.dx * nv)]; };
  const g = (u) => groundAt(...P2(u, 0));
  const quad = (A, B, C, D, n, sa, sb, sc, sd, col) => { tri(S, A, B, C, n, col, sa, sb, sc, I0, ST); tri(S, A, C, D, n, col, sa, sc, sd, I0, ST); };
  const wall = (u0, u1, v, s, zb0, zb1, zt0, zt1, col = stone) => quad(P(u0, v, zb0), P(u1, v, zb1), P(u1, v, zt1), P(u0, v, zt0), N((u0 + u1) / 2, 0, s, 0), [u0, zb0], [u1, zb1], [u1, zt1], [u0, zt0], col);
  const endw = (u, s, v0, v1, z0, z1, col = stone) => quad(P(u, v0, z0), P(u, v1, z0), P(u, v1, z1), P(u, v0, z1), N(u, s, 0, 0), [v0, z0], [v1, z0], [v1, z1], [v0, z1], col);
  const flat = (u0, u1, v0, v1, z0, z1, col = stone, s = 1) => quad(P(u0, v0, z0), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z0), N((u0 + u1) / 2, 0, 0, s), [u0, v0], [u1, v0], [u1, v1], [u0, v1], col);
  const blk = (u0, u1, v0, v1, z0, z1, col = stone) => { wall(u0, u1, v1, 1, z0, z0, z1, z1, col); wall(u0, u1, v0, -1, z0, z0, z1, z1, col); endw(u0, -1, v0, v1, z0, z1, col); endw(u1, 1, v0, v1, z0, z1, col); flat(u0, u1, v0, v1, z1, z1, col); };
  // a long run along u, cut into ≤ 6 m pieces so it follows the bend
  const run = (u0, u1, f) => { const n = Math.max(1, Math.ceil((u1 - u0) / 6)); for (let k = 0; k < n; k++) f(u0 + ((u1 - u0) * k) / n, u0 + ((u1 - u0) * (k + 1)) / n); };

  // deck grade between the two rims (highest ground within 25 m beyond each end)
  const rim = (u0, u1) => { let m = -Infinity; for (let u = u0; u <= u1; u += 2.5) m = Math.max(m, g(u)); return m; };
  const zA = rim(-25, 0) + 1.5, zB = rim(L, L + 25) + 1.5, zD = (u) => zA + ((zB - zA) * u) / L;   // walkway level
  const W = 6.4, hw = W / 2, zCo = (u) => zD(u) - 2.6;   // body width; cornice under the walk
  const depth = (u) => zCo(u) - g(u);
  // where arches are needed: depth over 4 m
  let uS = 0, uE = L; while (uS < L && depth(uS) < 4) uS += 1; while (uE > 0 && depth(uE) < 4) uE -= 1;
  // lay out bays on each straight run (a pier sits on every bend): pitch from the valley depth, then fit
  const piers = [];   // { c, w }
  const pierW = (d) => Math.min(7.2, Math.max(2.6, 2.2 + 0.078 * d)), spanOf = (d) => Math.min(28.9, Math.max(7.5, 5.5 + 0.37 * d));
  const dmax = (u0, u1) => { let m = 0; for (let u = u0; u <= u1; u += 2) m = Math.max(m, depth(u)); return m; };
  const marks = [uS, ...cum.slice(1, -1).filter((c) => c > uS && c < uE), uE];
  for (let r = 0; r + 1 < marks.length; r++) {
    const a = marks[r], b = marks[r + 1], seq = [a];
    while (seq[seq.length - 1] < b) { const c = seq[seq.length - 1], d = dmax(c, c + 30); seq.push(c + spanOf(d) + pierW(d)); }
    // land the last pier on b: squeeze to the overshoot or stretch to the step before, whichever is gentler
    const E = seq[seq.length - 1], Pv = seq[seq.length - 2], kE = (b - a) / (E - a), kP = Pv > a ? (b - a) / (Pv - a) : Infinity;
    const use = Math.abs(Math.log(kE)) <= Math.abs(Math.log(kP)) ? seq : seq.slice(0, -1), k = use === seq ? kE : kP;
    const fit = use.map((c) => a + (c - a) * k);
    for (const c of fit) if (!piers.length || Math.abs(piers[piers.length - 1].c - c) > 1) piers.push({ c, w: pierW(dmax(c - 12, c + 12)) });
  }
  let nPointed = 0, nRound = 0, tallest = 0;
  // solid wall over the rims, down into the slope
  const solid = (u0, u1) => run(u0, u1, (p, q) => { const zb0 = g(p) - 1.5, zb1 = g(q) - 1.5; for (const [v, s] of [[hw, 1], [-hw, -1]]) wall(p, q, v, s, zb0, zb1, zCo(p), zCo(q)); });
  solid(-14, piers[0].c - piers[0].w / 2); solid(piers[piers.length - 1].c + piers[piers.length - 1].w / 2, L + 14);
  // piers: core, plinth, stepped buttresses, impost band
  const springs = [];
  for (let i = 0; i + 1 < piers.length; i++) {
    const u0 = piers[i].c + piers[i].w / 2, u1 = piers[i + 1].c - piers[i + 1].w / 2, w = u1 - u0, crown = Math.min(zCo(u0), zCo(u1)) - 1.4;
    const pointed = w > 16.5, rise = pointed ? w * 0.74 : w / 2;
    let gmax = -Infinity; for (let u = u0; u <= u1; u += 1) gmax = Math.max(gmax, g(u));
    springs.push(Math.max(gmax + 0.4, crown - rise));
  }
  piers.forEach((p, i) => {
    const u0 = p.c - p.w / 2, u1 = p.c + p.w / 2, gb = Math.min(g(u0), g(u1), g(p.c)) - 1.5, top = zCo(p.c);
    const zs = Math.min(springs[i - 1] ?? Infinity, springs[i] ?? Infinity), h = zs - gb;
    blk(u0, u1, -hw, hw, gb, top);
    blk(u0 - 0.35, u1 + 0.35, -hw - 0.35, hw + 0.35, gb, Math.min(top, gb + 3.2), stone2);
    if (h > 6) blk(u0 - 0.18, u1 + 0.18, -hw - 0.18, hw + 0.18, zs - 0.5, zs, stone2);   // impost
    if (h > 14) {   // buttresses, stepping back three times
      const bw = Math.min(3.6, 0.055 * h + 0.6), lv = [gb, gb + h * 0.38, gb + h * 0.66, gb + h * 0.88];
      for (const s of [1, -1]) for (let k = 0; k < 3; k++) {
        const pr = bw * (1 - k / 3), hu = (p.w / 2) * (0.82 - k * 0.06);
        const v0 = s > 0 ? hw : -hw - pr, v1 = s > 0 ? hw + pr : -hw;
        blk(p.c - hu, p.c + hu, v0, v1, lv[k], lv[k + 1], k % 2 ? stone : stoneD);
        blk(p.c - hu - 0.12, p.c + hu + 0.12, s > 0 ? hw : -hw - pr - 0.15, s > 0 ? hw + pr + 0.15 : -hw, lv[k + 1] - 0.3, lv[k + 1], cap);   // coping
      }
    }
  });
  // arches: spandrel strips over a round or two-centred pointed intrados, soffit, and a projecting archivolt
  for (let i = 0; i + 1 < piers.length; i++) {
    const u0 = piers[i].c + piers[i].w / 2, u1 = piers[i + 1].c - piers[i + 1].w / 2, w = u1 - u0, zs = springs[i];
    const pointed = w > 16.5, R = pointed ? w * 0.8 : w / 2, off = R - w / 2, rise = Math.sqrt(R * R - off * off);
    if (pointed) nPointed++; else nRound++;
    tallest = Math.max(tallest, zs + rise - Math.min(g((u0 + u1) / 2), g(u0 + w * 0.3), g(u1 - w * 0.3)));
    const n = Math.max(10, Math.min(28, Math.round(w * 0.9)));
    const curve = (k) => {   // point on the intrados at parameter k/n, and its inward normal (towards the opening)
      const t = k / n, um = (u0 + u1) / 2;
      if (!pointed) { const a = Math.PI * (1 - t); return { u: um + Math.cos(a) * R, z: zs + Math.sin(a) * R, nu: -Math.cos(a), nz: -Math.sin(a) }; }
      const left = t <= 0.5, cu = left ? um + off : um - off, a0 = left ? Math.PI : 0, a1 = left ? Math.acos(-off / R) : Math.acos(off / R);
      const a = left ? a0 + (a1 - a0) * (t / 0.5) : a1 + (a0 - a1) * ((t - 0.5) / 0.5);
      return { u: cu + Math.cos(a) * R, z: zs + Math.sin(a) * R, nu: -Math.cos(a), nz: -Math.sin(a) };
    };
    for (let k = 0; k < n; k++) {
      const A = curve(k), B = curve(k + 1), topA = zCo(A.u), topB = zCo(B.u), nm = [(A.nu + B.nu) / 2, (A.nz + B.nz) / 2];
      for (const [v, s] of [[hw, 1], [-hw, -1]]) wall(A.u, B.u, v, s, A.z, B.z, topA, topB);
      quad(P(A.u, -hw, A.z), P(B.u, -hw, B.z), P(B.u, hw, B.z), P(A.u, hw, A.z), N((A.u + B.u) / 2, nm[0], 0, nm[1]), [A.u, -hw], [B.u, -hw], [B.u, hw], [A.u, hw], stoneD);
      // archivolt: 0.9 m ring of voussoirs standing 0.16 m proud of both faces
      const Ao = { u: A.u - A.nu * 0.9, z: A.z - A.nz * 0.9 }, Bo = { u: B.u - B.nu * 0.9, z: B.z - B.nz * 0.9 };
      for (const [v, s] of [[hw + 0.16, 1], [-hw - 0.16, -1]]) {
        quad(P(A.u, v, A.z), P(B.u, v, B.z), P(Bo.u, v, Bo.z), P(Ao.u, v, Ao.z), N(A.u, 0, s, 0), [A.u, A.z], [B.u, B.z], [Bo.u, Bo.z], [Ao.u, Ao.z], stone2);
        const vi = s > 0 ? hw : -hw;
        quad(P(Ao.u, vi, Ao.z), P(Bo.u, vi, Bo.z), P(Bo.u, v, Bo.z), P(Ao.u, v, Ao.z), N(A.u, -nm[0], 0, -nm[1]), [Ao.u, 0], [Bo.u, 0], [Bo.u, 0.16], [Ao.u, 0.16], stone2);
        quad(P(A.u, vi, A.z), P(B.u, vi, B.z), P(B.u, v, B.z), P(A.u, v, A.z), N(A.u, nm[0], 0, nm[1]), [A.u, 0], [B.u, 0], [B.u, 0.16], [A.u, 0.16], stone2);
      }
    }
  }
  // cornice, walk, parapets, the covered water gallery, turrets
  const u0 = -14, u1 = L + 14;
  run(u0, u1, (p, q) => {
    for (const [v, s] of [[hw + 0.4, 1], [-hw - 0.4, -1]]) wall(p, q, v, s, zCo(p), zCo(q), zCo(p) + 0.55, zCo(q) + 0.55, stone2);
    flat(p, q, -hw - 0.4, hw + 0.4, zCo(p), zCo(q), stone2, -1);
    for (const [v, s] of [[hw, 1], [-hw, -1]]) wall(p, q, v, s, zCo(p) + 0.55, zCo(q) + 0.55, zD(p) + 1.1, zD(q) + 1.1);
    for (const [v, s] of [[hw - 0.45, -1], [-hw + 0.45, 1]]) wall(p, q, v, s, zD(p), zD(q), zD(p) + 1.1, zD(q) + 1.1);
    flat(p, q, hw - 0.45, hw + 0.05, zD(p) + 1.1, zD(q) + 1.18, cap); flat(p, q, -hw - 0.05, -hw + 0.45, zD(p) + 1.1, zD(q) + 1.18, cap);
    flat(p, q, -hw + 0.45, -1.45, zD(p), zD(q), stoneD); flat(p, q, 1.45, hw - 0.45, zD(p), zD(q), stoneD);
    for (const [v, s] of [[1.45, 1], [-1.45, -1]]) wall(p, q, v, s, zD(p), zD(q), zD(p) + 2.5, zD(q) + 2.5);
    for (const s of [1, -1]) quad(P(p, s * 1.65, zD(p) + 2.45), P(q, s * 1.65, zD(q) + 2.45), P(q, 0, zD(q) + 3.25), P(p, 0, zD(p) + 3.25), N((p + q) / 2, 0, s * 0.8, 0.6), [p, 0], [q, 0], [q, 1.8], [p, 1.8], cap);
  });
  for (const u of [u0, u1]) { const s = u === u0 ? -1 : 1; endw(u, s, -hw - 0.4, hw + 0.4, zCo(u) - 6, zD(u) + 1.1); }
  for (let u = 60; u < L - 30; u += 115) {   // respiradouros
    const z = zD(u);
    blk(u - 1.8, u + 1.8, -1.8, 1.8, z, z + 4.6); blk(u - 2.05, u + 2.05, -2.05, 2.05, z + 4.6, z + 5.0, stone2);
    const [x, y] = P2(u, 0), a = at(u);
    frustum(S, x, y, a.dx, a.dy, 1.9, 0.05, z + 5.0, z + 7.4, cap, ST, false);
    for (const [nu, nv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const o = 1.81; blk(u + nu * o - (nv ? 0.35 : 0.02), u + nu * o + (nv ? 0.35 : 0.02), nv * o - (nu ? 0.35 : 0.02), nv * o + (nu ? 0.35 : 0.02), z + 2.6, z + 3.8, dark); }
  }
  log(`Aqueduto: ${L.toFixed(0)} m, deck ${zA.toFixed(1)} → ${zB.toFixed(1)}, ${nPointed} pointed + ${nRound} round arches, tallest ${tallest.toFixed(1)} m`);
}

// Torre de Belém (1514–1520): Manueline bastion-tower in lioz. The tower stands at the landward (north)
// end; the hexagonal bastion runs out into the river with shield-shaped merlons and corbelled sentry
// turrets under ribbed domes. Tower: four floors, the King's balcony and the Renaissance loggia on the
// river face, side balconies, a crenellated terrace with corner turrets. Frame from its mapped north edge.
const TORRE_SQ = [[38.691784, -9.215957], [38.691766, -9.215820], [38.691659, -9.215843], [38.691677, -9.215980]];   // NW, NE, SE, SW of the mapped tower part
export function torreBelem(S, { fwd, ring, ground, lin, srgb }) {
  const stone = lin(srgb('#e6dcc5')), stone2 = lin(srgb('#d5c9ae')), dark = lin(srgb('#36342f')), dome = lin(srgb('#d9cfb8'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.27, 0.9], TL = [KIND.TILES / 8, 5 / 8, 0.27, 1], I0 = [0, 0, 0, 0];
  const Q = TORRE_SQ.map((p) => fwd(...p)), a = Q[0], b = Q[1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const cx = Q.reduce((s, p) => s + p[0], 0) / 4, cy = Q.reduce((s, p) => s + p[1], 0) / 4;   // tower centre; v points inland (north)
  const K = kit(S, { cx, cy, ux, uy, ground, zb: -2, wall: stone, roof: stone2, ST, TL }), { P2, W3, blk } = K;
  const O = openings(S, P2, W3, ux, uy, ground, stone2, dark, ST);
  const toUV = ([x, y]) => { const dx = x - cx, dy = y - cy; return [dx * ux + dy * uy, -dx * uy + dy * ux]; };
  const T0 = -6, T1 = 6, V0 = -6, V1 = 6, ZB = 8, ZT = 25.6;   // tower box (u, v) and the bastion terrace / tower roof levels
  const inTower = (u, v) => u > T0 - 0.3 && u < T1 + 0.3 && v > V0 - 0.3 && v < V1 + 0.3;
  // bastion: the mapped outline raised to the terrace, a parapet and shield merlons on every edge clear of the tower
  const R = ring.map(toUV), n = R.length, sgn = polyArea(ring) > 0 ? 1 : -1;
  const flat = earcut(R.flat());
  for (let i = 0; i < flat.length; i += 3) triUp(S, ...[flat[i], flat[i + 1], flat[i + 2]].map((k) => W3(R[k][0], R[k][1], ZB)), stone2, [0, 0], [0, 0], [0, 0], I0, ST);
  const turrets = [];
  for (let i = 0; i < n; i++) {
    const p = R[i], q = R[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l < 0.3) continue;
    const eu = (q[0] - p[0]) / l, ev = (q[1] - p[1]) / l, nu = sgn * ev, nv = -sgn * eu;   // outward normal
    const [x0, y0] = P2(...p), [x1, y1] = P2(...q);
    wallQuad(S, sgn > 0 ? [x0, y0] : [x1, y1], sgn > 0 ? [x1, y1] : [x0, y0], ground - 2, ground - 2, ground + ZB, ground + ZB, stone, 0, l, ground, I0, ST);
    // a plinth course at the waterline and a cable moulding under the parapet
    for (const [z0, z1, o] of [[-2, 1.2, 0.35], [ZB - 0.45, ZB - 0.15, 0.18]]) O.tbox(p[0] / 2 + q[0] / 2 + nu * o / 2, p[1] / 2 + q[1] / 2 + nv * o / 2, eu, ev, l / 2 + o, o / 2, z0, z1, stone2);
    const mu = (p[0] + q[0]) / 2, mv = (p[1] + q[1]) / 2;
    if (inTower(mu, mv)) continue;
    O.tbox(mu - nu * 0.3, mv - nv * 0.3, eu, ev, l / 2, 0.3, ZB, ZB + 0.95, stone);
    const m = Math.max(1, Math.floor(l / 1.85));
    for (let k = 0; k < m; k++) {
      const t = (k + 0.5) / m, u = p[0] + (q[0] - p[0]) * t - nu * 0.3, v = p[1] + (q[1] - p[1]) * t - nv * 0.3;
      O.tbox(u, v, eu, ev, 0.42, 0.28, ZB + 0.95, ZB + 1.75, stone);
      const A = W3(u - eu * 0.42, v - ev * 0.42, ZB + 1.75), B = W3(u + eu * 0.42, v + ev * 0.42, ZB + 1.75), C = W3(u, v, ZB + 2.3);
      slab4(S, [A, B, C, C], 0.5, stone, ST);   // the shield's point
    }
    // sentry turrets on the bastion's corners
    const r = R[(i + 2) % n], l2 = Math.hypot(r[0] - q[0], r[1] - q[1]);
    if (l2 > 0.3 && !inTower(...q)) { const turn = Math.abs(eu * (r[1] - q[1]) / l2 - ev * (r[0] - q[0]) / l2); if (turn > 0.45) turrets.push([q[0] + (nu + sgn * (r[1] - q[1]) / l2) * 0.45, q[1] + (nv - sgn * (r[0] - q[0]) / l2) * 0.45, ZB - 1.6]); }
  }
  const guarita = (u, v, z0, r = 1.05) => {
    sweep(S, W3, [[u, v, z0 - 1.1, 0.2, 0.2], [u, v, z0 - 0.5, r * 0.75, r * 0.75], [u, v, z0, r, r]], stone2, ST, 12, false);   // corbel
    sweep(S, W3, [[u, v, z0, r, r], [u, v, z0 + 3.1, r, r], [u, v, z0 + 3.3, r + 0.12, r + 0.12], [u, v, z0 + 3.45, r, r]], stone, ST, 12, false);
    for (let k = 0; k < 4; k++) { const t = (k / 4) * Math.PI * 2 + 0.4; O.tbox(u + Math.cos(t) * (r + 0.01), v + Math.sin(t) * (r + 0.01), -Math.sin(t), Math.cos(t), 0.14, 0.04, z0 + 1.4, z0 + 2.4, dark); }
    const D = Array.from({ length: 7 }, (_, k) => { const t = (k / 6) * Math.PI / 2; return [u, v, z0 + 3.45 + Math.sin(t) * r * 1.35, Math.max(0.05, Math.cos(t) * r), Math.max(0.05, Math.cos(t) * r)]; });
    sweep(S, W3, D, dome, ST, 8);   // ribbed (8 facets) Moorish dome
    sweep(S, W3, [[u, v, z0 + 3.45 + r * 1.35, 0.1, 0.1], [u, v, z0 + 3.45 + r * 1.35 + 0.5, 0.03, 0.03]], stone2, ST, 5);
  };
  for (const [u, v, z] of turrets) guarita(u, v, z);
  // tower body, string courses at each floor, cable moulding at the terrace
  blk(T0, T1, V0, V1, -2, ZT);
  for (const z of [ZB + 0.2, 12.2, 16.6, 21.3, ZT - 0.6]) blk(T0 - 0.22, T1 + 0.22, V0 - 0.22, V1 + 0.22, z, z + 0.32, stone2);
  // top terrace: parapet, shield merlons, corner turrets
  K.crenel(T0 + 0.5, T1 - 0.5, V0 + 0.5, V1 - 0.5, ZT, 1.75, stone);
  for (const [u, v] of [[T0, V0], [T1, V0], [T1, V1], [T0, V1]]) guarita(u + Math.sign(u) * 0.3, v + Math.sign(v) * 0.3, ZT - 1.3, 1.1);
  // river face (v = V0): the King's balcony (floor 1) and the Renaissance loggia (floor 2)
  blk(T0 + 2.2, T1 - 2.2, V0 - 1.3, V0, 12.2, 12.6, stone2);
  for (let k = 0; k < 13; k++) { const u = T0 + 2.4 + (k / 12) * (T1 - T0 - 4.8); blk(u - 0.08, u + 0.08, V0 - 1.25, V0 - 1.05, 12.6, 13.5, stone); }
  blk(T0 + 2.2, T1 - 2.2, V0 - 1.3, V0 - 1.0, 13.5, 13.7, stone2);
  for (const u of [-2.6, 0, 2.6]) O.win(u, V0, 0, -1, 12.6, 1.6, 2.6, 'arch');
  blk(T0 + 0.6, T1 - 0.6, V0 - 2.0, V0, 16.6, 17.0, stone2);   // loggia floor
  blk(T0 + 0.6, T1 - 0.6, V0 - 0.06, V0, 17.0, 20.6, dark);
  for (let k = 0; k <= 6; k++) { const u = T0 + 0.8 + (k / 6) * (T1 - T0 - 1.6); limb(S, W3(u, V0 - 1.8, 17.0), W3(u, V0 - 1.8, 19.4), 0.17, 0.15, 8, stone, ST); if (k < 6) O.arc(u + (T1 - T0 - 1.6) / 12, V0 - 1.8, 1, 0, 19.4, (T1 - T0 - 1.6) / 12, 0.16, 0.2, stone2, 9); }
  blk(T0 + 0.6, T1 - 0.6, V0 - 2.0, V0, 20.7, 21.2, stone2);   // loggia roof
  for (let k = 0; k < 15; k++) { const u = T0 + 0.8 + (k / 14) * (T1 - T0 - 1.6); blk(u - 0.07, u + 0.07, V0 - 1.95, V0 - 1.75, 17.0, 17.9, stone); }
  blk(T0 + 0.6, T1 - 0.6, V0 - 2.0, V0 - 1.7, 17.9, 18.1, stone2);
  // royal arms between armillary spheres above the loggia
  blk(-1.3, 1.3, V0 - 0.25, V0, 22.0, 24.6, stone2); blk(-1.1, 1.1, V0 - 0.35, V0 - 0.2, 22.3, 24.3, stone);
  for (const u of [-3.6, 3.6]) { sweep(S, W3, [[u, V0 - 0.6, 22.6, 0.05, 0.05], [u, V0 - 0.6, 23.0, 0.62, 0.62], [u, V0 - 0.6, 23.6, 0.7, 0.7], [u, V0 - 0.6, 24.2, 0.62, 0.62], [u, V0 - 0.6, 24.6, 0.05, 0.05]], stone2, ST, 8); }
  // side faces: balconies with three arches on floor 2, twin windows above and below
  for (const [u, nu] of [[T0, -1], [T1, 1]]) {
    blk(nu < 0 ? u - 1.3 : u, nu < 0 ? u : u + 1.3, V0 + 3.2, V1 - 3.2, 16.6, 17.0, stone2);
    for (let k = 0; k < 11; k++) { const v = V0 + 3.4 + (k / 10) * (V1 - V0 - 6.8); blk(u + nu * 1.15 - 0.08, u + nu * 1.15 + 0.08, v - 0.08, v + 0.08, 17.0, 17.9, stone); }
    blk(nu < 0 ? u - 1.3 : u, nu < 0 ? u : u + 1.3, V0 + 3.2, V1 - 3.2, 17.9, 18.1, stone2);
    for (const v of [-2.6, 0, 2.6]) O.win(u, v, nu, 0, 17.0, 1.5, 2.7, 'arch');
    for (const v of [-1.2, 1.2]) { O.win(u, v, nu, 0, 12.9, 1.0, 2.3, 'round'); O.win(u, v, nu, 0, 22.2, 1.0, 2.2, 'round'); }
  }
  // landward face: door from the drawbridge, twin windows on every floor
  O.win(0, V1, 0, 1, 0.2, 2.0, 3.4, 'arch');
  for (const z of [12.9, 17.4, 22.2]) for (const u of [-2.2, 2.2]) O.win(u, V1, 0, 1, z, 1.1, 2.5, 'round');
}

// Padrão dos Descobrimentos (1960, Cottinelli Telmo and Leopoldo de Almeida): a 52 m slab carrying three
// stylised sails, a caravel's prow running out towards the river with the Infante D. Henrique at its head
// and 32 figures of the Discoveries climbing behind him on both flanks; the great sword on the landward face.
// Built on the mapped slab (u along it, + towards the river) and the mapped hull outline.
export function padraoDescobrimentos(S, { slab, hull, ground, lin, srgb }) {
  const stone = lin(srgb('#ece4d2')), stone2 = lin(srgb('#ddd3bd')), shade = lin(srgb('#c9bea6'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.53, 0.9], I0 = [0, 0, 0, 0];
  const o = obb(slab), [sx, sy] = [o.cx, o.cy];
  // orient u towards the hull's far point (the prow)
  let far = hull[0], fd = -1; for (const p of hull) { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d > fd) { fd = d; far = p; } }
  let ux = o.ux, uy = o.uy; if ((far[0] - sx) * ux + (far[1] - sy) * uy < 0) { ux = -ux; uy = -uy; }
  const P2 = (u, v) => [sx + ux * u - uy * v, sy + uy * u + ux * v], W3 = (u, v, z) => { const [x, y] = P2(u, v); return [x, ground + z, -y]; };
  const toUV = ([x, y]) => { const dx = x - sx, dy = y - sy; return [dx * ux + dy * uy, -dx * uy + dy * ux]; };
  const H = hull.map(toUV), hl = o.hl, hw = Math.max(1.8, o.hw);
  const uN = Math.min(...H.map((p) => p[0])), uP = Math.max(...H.map((p) => p[0]));
  const deck = (u) => 1.2 + 15.5 * Math.max(0, Math.min(1, (u - uN) / (uP - uN))) ** 1.25;   // the hull rises to the prow
  // hull: mapped outline, walls up to the sloping deck, deck surface
  const sgn = polyArea(hull) > 0 ? 1 : -1;
  for (let i = 0; i < H.length; i++) {
    const p = H[i], q = H[(i + 1) % H.length]; if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.2) continue;
    const [A, B] = sgn > 0 ? [p, q] : [q, p];
    wallQuad(S, P2(...A), P2(...B), ground - 1, ground - 1, ground + deck(A[0]), ground + deck(B[0]), stone, A[0], B[0], ground, I0, ST);
  }
  const tr = earcut(H.flat());
  for (let i = 0; i < tr.length; i += 3) triUp(S, ...[tr[i], tr[i + 1], tr[i + 2]].map((k) => W3(H[k][0], H[k][1], deck(H[k][0]))), stone2, [0, 0], [0, 0], [0, 0], I0, ST);
  // the slab and its sails: three swelling sail-forms stepped down towards the prow on both faces
  box(S, sx, sy, ux, uy, hl, hw, ground - 1, ground + 52, stone, I0, ST);
  for (const s of [1, -1]) for (let k = 0; k < 3; k++) {
    const u0 = -hl + 1.5 + k * 4.4, u1 = u0 + 9, z0 = 51.5 - k * 9.5, z1 = z0 - 16 + k * 1.5, bulge = 2.9 - k * 0.5;
    const sec = Array.from({ length: 6 }, (_, j) => { const t = j / 5, w = Math.sin(Math.PI * t) * bulge + 0.1; return [(u0 + u1) / 2, s * (hw + w / 2), z0 - (z0 - z1) * t, (u1 - u0) / 2 * (0.75 + 0.25 * Math.sin(Math.PI * t)), w / 2]; });
    sweep(S, W3, sec, k % 2 ? stone2 : stone, ST, 8);
  }
  // the sword on the landward face: blade down the slab, cross-guard with the Avis cross
  const uS = -hl - 0.35;
  box(S, ...P2(uS + 0.15, 0), ux, uy, 0.2, 0.55, ground + 3, ground + 38, stone2, I0, ST);
  box(S, ...P2(uS + 0.15, 0), ux, uy, 0.25, hw + 1.6, ground + 37.2, ground + 38.6, stone2, I0, ST);
  box(S, ...P2(uS + 0.15, 0), ux, uy, 0.25, 0.75, ground + 38.6, ground + 44.5, stone2, I0, ST);
  for (const z of [39.6, 42.4]) box(S, ...P2(uS + 0.05, 0), ux, uy, 0.12, 1.35, ground + z, ground + z + 0.55, stone, I0, ST);
  // the Infante at the prow, with a caravel in his hands, and the figures climbing behind him
  const fig = (u, v, sc, facing, pose, col = stone) => {
    const z = deck(u), fx = Math.cos(facing), fy = Math.sin(facing);   // facing in (u, v)
    figure(S, (a, b, zz) => W3(u + fx * b + fy * a, v + fy * b - fx * a, z + zz), sc, col, ST, pose);
  };
  const prowU = uP - 4.2;
  fig(prowU, 0, 4.6, 0, { robe: true, cloak: true, arms: [[-0.15, 0.3, -0.25], [0.15, 0.3, -0.25]] });
  sweep(S, W3, [[prowU + 1.6, -0.6, deck(prowU) + 4.6, 0.4, 0.25], [prowU + 1.6, 0, deck(prowU) + 4.9, 0.7, 0.3], [prowU + 1.6, 0.6, deck(prowU) + 4.6, 0.4, 0.25]], stone2, ST, 6);
  const poses = [{ robe: true, cloak: true }, { stride: 0.4, arms: [[-0.1, 0.35, 0.35], [0.05, 0.05, -0.6]] }, { robe: true, arms: [[-0.12, 0.3, -0.1], [0.1, 0.3, -0.1]] }, { stride: 0.3, cloak: true, arms: [[-0.05, 0.4, 0.05], [0.12, 0.2, -0.3]] }, { robe: true, crown: true }];
  for (const s of [1, -1]) for (let k = 0; k < 16; k++) {
    const u = prowU - 4.4 - k * ((prowU - 4.4 - uN - 3) / 15), [lo, hi] = halfWidth(H, u), half = Math.max(hw + 0.9, (s > 0 ? hi : -lo) - 1.1);
    fig(u, s * half, 3.0 - k * 0.04, s * 0.5, poses[(k + (s > 0 ? 0 : 2)) % poses.length], k % 3 ? stone : shade);
  }
}
function halfWidth(H, u) {   // half the hull's width at station u (from its outline)
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < H.length; i++) {
    const p = H[i], q = H[(i + 1) % H.length];
    if ((p[0] - u) * (q[0] - u) > 0 || p[0] === q[0]) continue;
    const v = p[1] + (q[1] - p[1]) * (u - p[0]) / (q[0] - p[0]); lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return isFinite(lo) ? [lo, hi] : [-2, 2];
}

// Mosteiro dos Jerónimos: the monastery's mapped outline is raised as one lioz range (build.mjs), and the
// church of Santa Maria de Belém is modelled over its own outline: walls of golden lioz with buttresses
// and pinnacles along the river side, tall Manueline windows, a crested parapet over a low tiled roof,
// João de Castilho's south portal rising above the roofline, and the domed bell tower at the south-west corner.
const JERONIMOS_PORTAL = [38.697660, -9.205299], JERONIMOS_TOWER = [38.697556, -9.205840];
export function jeronimosChurch(S, { ring, fwd, ground, lin, srgb }) {
  const stone = lin(srgb('#ddd0b1')), stone2 = lin(srgb('#cbbd9b')), dark = lin(srgb('#3a372f')), roofC = lin(srgb('#a7735c')), cap = lin(srgb('#d3c6a6'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.61, 0.9], TL = [KIND.TILES / 8, 5 / 8, 0.61, 1], I0 = [0, 0, 0, 0];
  const o = obb(ring); let ux = o.ux, uy = o.uy; if (ux < 0) { ux = -ux; uy = -uy; }   // u runs west → east (to the chancel)
  const cx = o.cx, cy = o.cy, H = 24.5;
  const K = kit(S, { cx, cy, ux, uy, ground, zb: -1, wall: stone, roof: roofC, ST, TL }), { P2, W3, blk } = K;
  const O = openings(S, P2, W3, ux, uy, ground, stone2, dark, ST);
  const toUV = ([x, y]) => { const dx = x - cx, dy = y - cy; return [dx * ux + dy * uy, -dx * uy + dy * ux]; };
  // walls stand 0.15 m proud of the mapped outline, so they never fight the monastery range under them
  const c0 = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
  const R = ring.map((p) => toUV([c0[0] + (p[0] - c0[0]) * 1.003, c0[1] + (p[1] - c0[1]) * 1.003])), n = R.length, sgn = polyArea(ring) > 0 ? 1 : -1;
  const uMin = Math.min(...R.map((p) => p[0])), uMax = Math.max(...R.map((p) => p[0]));
  for (let i = 0; i < n; i++) {
    const p = R[i], q = R[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l < 0.3) continue;
    const [A, B] = sgn > 0 ? [p, q] : [q, p];
    wallQuad(S, P2(...A), P2(...B), ground - 1, ground - 1, ground + H, ground + H, stone, 0, l, ground, I0, ST);
    // crested parapet: a low wall and little pinnacles all round the roof
    const eu = (q[0] - p[0]) / l, ev = (q[1] - p[1]) / l, nu = sgn * ev, nv = -sgn * eu, mu = (p[0] + q[0]) / 2, mv = (p[1] + q[1]) / 2;
    O.tbox(mu - nu * 0.2, mv - nv * 0.2, eu, ev, l / 2, 0.22, H, H + 0.9, stone2);
    O.tbox(mu + nu * 0.1, mv + nv * 0.1, eu, ev, l / 2 + 0.1, 0.22, H - 1.0, H - 0.7, stone2);   // cornice
    const m = Math.floor(l / 2.2);
    for (let k = 1; k < m; k++) { const t = k / m, [x, y] = P2(p[0] + (q[0] - p[0]) * t - nu * 0.2, p[1] + (q[1] - p[1]) * t - nv * 0.2); frustum(S, x, y, ux, uy, 0.2, 0.02, ground + H + 0.9, ground + H + 2.0, stone2, ST, false); }
  }
  const tr = earcut(R.flat());
  for (let i = 0; i < tr.length; i += 3) triUp(S, ...[tr[i], tr[i + 1], tr[i + 2]].map((k) => W3(R[k][0], R[k][1], H)), cap, [0, 0], [0, 0], [0, 0], I0, ST);
  // the outline's width at each station: south wall (lo) and north wall (hi)
  const side = (u) => halfWidth(R, u);
  const widths = []; for (let u = uMin + 4; u < uMax - 4; u += 2) { const [lo, hi] = side(u); widths.push([u, lo, hi]); }
  const nave = widths.slice().sort((a, b) => (a[2] - a[1]) - (b[2] - b[1]))[Math.floor(widths.length * 0.3)];
  const vL = nave[1] + 1.2, vH = nave[2] - 1.2;
  K.gable(uMin + 1.5, uMax - 1.5, vL, vH, H - 0.3, H + 4.2, true, stone);
  // south side: buttresses with pinnacles, and tall windows between them
  const [px, py] = fwd(...JERONIMOS_PORTAL), [pu] = toUV([px, py]);
  const [tx, ty] = fwd(...JERONIMOS_TOWER), [tu, tv] = toUV([tx, ty]);
  const bays = []; for (let u = uMin + 9; u < uMax - 6; u += 9.6) if (Math.abs(u - pu) > 8.5 && Math.abs(u - tu) > 7) bays.push(u);
  for (const u of bays) {
    const lo = side(u)[0];
    blk(u - 0.85, u + 0.85, lo - 1.7, lo, -1, H - 3, stone);
    blk(u - 1.0, u + 1.0, lo - 1.9, lo, -1, 1.2, stone2);
    for (const z of [8, 15]) blk(u - 0.95, u + 0.95, lo - 1.8, lo - 1.6, z, z + 0.35, stone2);
    const [x, y] = P2(u, lo - 0.85);
    frustum(S, x, y, ux, uy, 0.75, 0.75, ground + H - 3, ground + H + 1.2, stone, ST, false);
    frustum(S, x, y, ux, uy, 0.75, 0.04, ground + H + 1.2, ground + H + 6.5, stone2, ST, false);
  }
  for (let k = 0; k + 1 < bays.length; k++) {
    const u = (bays[k] + bays[k + 1]) / 2; if (bays[k + 1] - bays[k] > 12 || Math.abs(u - pu) < 7) continue;
    O.win(u, side(u)[0], 0, -1, 10.5, 3.0, 8.6, 'arch', 0.25);
  }
  // South portal: deep doorway, tiers of canopied niches with statues, pinnacled buttresses, a crowning spire
  {
    const lo = side(pu)[0] - 0.2, F = (du, dv, z) => W3(pu + du, lo + dv, z);
    blk(pu - 6.2, pu + 6.2, lo - 1.4, lo + 0.2, -1, 25.5, stone);
    blk(pu - 2.6, pu + 2.6, lo - 1.46, lo - 1.4, 0, 8.4, dark);                       // twin doors under one arch
    blk(pu - 0.25, pu + 0.25, lo - 1.9, lo - 1.4, 0, 8.4, stone2);                    // trumeau (with the Infante's statue)
    figure(S, (a, b, z) => F(a, -1.95 - b, 8.6 + z), 1.25, stone2, ST, { robe: true, cloak: true });
    for (let k = 0; k < 4; k++) O.arc(pu, lo - 1.45 - k * 0.12, 1, 0, 8.4, 2.6 + k * 0.35, 0.18, 0.12, stone2, 11);
    for (const s of [-1, 1]) {   // buttress-towers flanking the portal
      for (const [z0, z1, w] of [[-1, 12, 1.25], [12, 21, 1.05], [21, 27.5, 0.8]]) blk(pu + s * 5.4 - w, pu + s * 5.4 + w, lo - 2.4, lo - 1.4, z0, z1, k2(z0) ? stone : stone2);
      const [x, y] = P2(pu + s * 5.4, lo - 1.9); frustum(S, x, y, ux, uy, 0.8, 0.05, ground + 27.5, ground + 33, stone2, ST, false);
    }
    // niches with statues of apostles and prophets, three tiers
    for (const [z, nn] of [[10.2, 5], [14.8, 4], [19.4, 3]]) for (let k = 0; k < nn; k++) {
      const du = (k - (nn - 1) / 2) * 1.75;
      blk(pu + du - 0.6, pu + du + 0.6, lo - 1.55, lo - 1.4, z, z + 3.1, dark);
      figure(S, (a, b, zz) => F(du + a, -1.6 - b * 0.4, z + 0.25 + zz), 1.35, stone, ST, { robe: true, arms: [[-0.08, 0.2, -0.35], [0.08, 0.2, -0.35]] });
      blk(pu + du - 0.72, pu + du + 0.72, lo - 1.9, lo - 1.4, z + 3.1, z + 3.4, stone2);   // canopy
      const [x, y] = P2(pu + du, lo - 1.65); frustum(S, x, y, ux, uy, 0.42, 0.03, ground + z + 3.4, ground + z + 4.6, stone2, ST, false);
    }
    // the Virgin of Belém in the top niche and the spire over the roofline
    blk(pu - 1.1, pu + 1.1, lo - 1.6, lo - 1.4, 24.2, 27.6, dark);
    figure(S, (a, b, zz) => F(a, -1.7 - b * 0.4, 24.4 + zz), 1.6, stone, ST, { robe: true, crown: true });
    const [x, y] = P2(pu, lo - 0.7); frustum(S, x, y, ux, uy, 1.6, 0.6, ground + 25.5, ground + 30.5, stone, ST, false); frustum(S, x, y, ux, uy, 0.6, 0.04, ground + 30.5, ground + 36, stone2, ST, false);
    sweep(S, F, [[0, -0.7, 36, 0.06, 0.06], [0, -0.7, 37.4, 0.04, 0.04]], stone2, ST, 4);
  }
  // bell tower at the south-west corner: square shaft, belfry with paired openings, balustrade, ribbed dome
  {
    const hw = 4.6, zt = 33, F = W3;
    blk(tu - hw, tu + hw, tv - hw, tv + hw, -1, zt);
    for (const z of [H - 1.0, zt - 0.6]) blk(tu - hw - 0.25, tu + hw + 0.25, tv - hw - 0.25, tv + hw + 0.25, z, z + 0.4, stone2);
    for (const [nu, nv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const d of [-1.5, 1.5]) O.win(tu + nu * hw + nv * d, tv + nv * hw - nu * d, nu, nv, H + 1.6, 1.8, 4.6, 'arch', 0.2);
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const [x, y] = P2(tu + su * (hw - 0.3), tv + sv * (hw - 0.3)); frustum(S, x, y, ux, uy, 0.35, 0.03, ground + zt, ground + zt + 3.2, stone2, ST, false); }
    const D = Array.from({ length: 8 }, (_, k) => { const t = (k / 7) * Math.PI / 2, r = Math.max(0.1, Math.cos(t) * (hw - 0.6)); return [tu, tv, zt + Math.sin(t) * 7.5 + (1 - Math.cos(t)) * 1.5, r, r]; });
    sweep(S, F, [[tu, tv, zt, hw - 0.6, hw - 0.6], ...D], cap, ST, 8);
    sweep(S, F, [[tu, tv, zt + 9, 0.35, 0.35], [tu, tv, zt + 10.6, 0.06, 0.06]], stone2, ST, 6);
  }
  function k2(z) { return z < 0; }
}

// Estádio da Luz (2003): the bowl of red seats under a pale roof that hangs from four steel arches,
// one along each side. Seats are lofted from the edge of the roof's opening (round the pitch) out and up
// under the roof; the arches spring from the roof's corners.
export function estadioLuz(S, { roof, hole, outer = null, ground, lin, srgb }) {
  const red = lin(srgb('#b3272e')), red2 = lin(srgb('#9c2128')), steel = lin(srgb('#dcdedf')), conc = lin(srgb('#a9a7a2'));
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.7, 1], I0 = [0, 0, 0, 0];
  const c = hole.reduce((a, p) => [a[0] + p[0] / hole.length, a[1] + p[1] / hole.length], [0, 0]);
  const ring = (k, z) => hole.map((p) => [c[0] + (p[0] - c[0]) * k, ground + z, -(c[1] + (p[1] - c[1]) * k)]);
  const tiers = [[0.86, 1.5], [1.13, 15], [1.17, 17.5], [1.42, 35]];   // lower tier, gangway, upper tier
  for (let t = 0; t + 1 < tiers.length; t++) {
    const A = ring(...tiers[t]), B = ring(...tiers[t + 1]), col = t === 1 ? conc : t ? red2 : red;
    for (let i = 0; i < A.length; i++) {
      const j = (i + 1) % A.length, n = norm(A[i], A[j], B[j]);
      const up = n[1] < 0 ? n.map((q) => -q) : n;   // seats face up and in
      tri(S, A[i], A[j], B[j], up, col, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, A[i], B[j], B[i], up, col, [0, 0], [0, 0], [0, 0], I0, PL);
    }
  }
  // the bowl's outer wall on the stadium's own outline (checked against Earth): dark glazing in deep bands with pale ledges from the
  // podium up to ~34 m, and the pale membrane roof sloping up from that rim to the roof ring under the arches
  const hit = (r, a) => { const dx = Math.cos(a), dy = Math.sin(a); let best = 0;
    for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length], ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
      const wx = p[0] - c[0], wy = p[1] - c[1], t = (wx * ey - wy * ex) / den, s = (wx * dy - wy * dx) / den; if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t); } return best; };
  const N = 144, Ang = Array.from({ length: N }, (_, k) => (k / N) * Math.PI * 2);
  const W = outer || roof, Ro = Ang.map((a) => hit(W, a) - (outer ? 3 : 0)), Rr = Ang.map((a) => hit(roof, a));
  const Q = (k, r, z) => [c[0] + Math.cos(Ang[k % N]) * r, ground + z, -(c[1] + Math.sin(Ang[k % N]) * r)];
  const quad = (a, b, cc, d, col, up) => { let n = norm(a, b, cc); if ((up > 0 && n[1] < 0) || (up < 0 && n[1] > 0) || (up === 0 && n[0] * (a[0] - c[0]) + n[2] * (a[2] + c[1]) < 0)) n = n.map((q) => -q);
    tri(S, a, b, cc, n, col, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, a, cc, d, n, col, [0, 0], [0, 0], [0, 0], I0, PL); };
  const glass = lin(srgb('#39434d')), ledge = lin(srgb('#e3e4e2')), memb = lin(srgb('#d5d8d8')), memb2 = lin(srgb('#cbcfd0'));
  const bands = [[5.5, 6.5, ledge], [6.5, 12, glass], [12, 13, ledge], [13, 19, glass], [19, 20, ledge], [20, 26.5, glass], [26.5, 27.5, ledge], [27.5, 33, glass], [33, 34.5, ledge]];
  for (let k = 0; k < N; k++) { const k2 = (k + 1) % N;
    for (const [z0, z1, col] of bands) quad(Q(k, Ro[k], z0), Q(k + 1, Ro[k2], z0), Q(k + 1, Ro[k2], z1), Q(k, Ro[k], z1), col, 0);
    if (Rr[k] < Ro[k] - 1 && Rr[k2] < Ro[k2] - 1) quad(Q(k, Ro[k], 34.5), Q(k + 1, Ro[k2], 34.5), Q(k + 1, Rr[k2], 39.8), Q(k, Rr[k], 39.8), k % 8 < 4 ? memb : memb2, 1);
  }
  const o = obb(roof), zr = 41, archC = lin(srgb('#a3262c'));
  const P = (u, v, z) => [o.cx + o.ux * u - o.uy * v, ground + z, -(o.cy + o.uy * u + o.ux * v)];
  const arch = (a, b, rise) => {   // parabolic tube from a to b (local u, v)
    const pts = Array.from({ length: 17 }, (_, k) => { const t = k / 16, u = a[0] + (b[0] - a[0]) * t, v = a[1] + (b[1] - a[1]) * t; return [u, v, zr + 5 + 4 * rise * t * (1 - t)]; });
    for (let k = 0; k + 1 < pts.length; k++) limb(S, P(...pts[k]), P(...pts[k + 1]), 1.25, 1.25, 8, archC, PL, false);   // the four arches are painted Benfica red
    for (let k = 2; k < 15; k += 2) { const [u, v, z] = pts[k]; limb(S, P(u, v, z), P(u * 0.93, v * 0.93, zr + 0.3), 0.12, 0.12, 4, steel, PL, false); }   // hangers
  };
  const hl = o.hl * 0.94, hw = o.hw * 0.94;
  arch([-hl, hw], [hl, hw], 14); arch([-hl, -hw], [hl, -hw], 14); arch([-hl, -hw], [-hl, hw], 11); arch([hl, -hw], [hl, hw], 11);
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) limb(S, P(su * hl, sv * hw, -1), P(su * hl, sv * hw, zr + 6), 2.2, 1.6, 8, conc, PL, true);   // corner masts
}

// Gare do Oriente (Calatrava, 1998): over the raised platforms a forest of white steel trees, each trunk
// opening into ribs that arch out to meet its neighbours in pointed, palm-like vaults. Built over the
// mapped canopy (u along the tracks): four rows of trees on the island platforms, one every 17 m.
export function oriente(S, { canopy, ground, deck, lin, srgb }) {
  const white = lin(srgb('#eef0ef')), white2 = lin(srgb('#d9dcdc')), PL = [KIND.PLAIN / 8, 5 / 8, 0.8, 1];
  const o = obb(canopy), F = (u, v, z) => [o.cx + o.ux * u - o.uy * v, ground + z, -(o.cy + o.uy * u + o.ux * v)];
  const nU = Math.max(4, Math.round((2 * o.hl) / 17)), du = (2 * o.hl) / nU, rows = 4, dv = (2 * o.hw) / rows;
  const z0 = deck, zt = deck + 8.5, zc = deck + 16.5;
  for (let i = 0; i < nU; i++) for (let j = 0; j < rows; j++) {
    const u = -o.hl + du * (i + 0.5), v = -o.hw + dv * (j + 0.5);
    limb(S, F(u, v, z0), F(u, v, zt), 0.55, 0.42, 8, white, PL, false);
    for (let k = 0; k < 8; k++) {   // ribs out to the cell's edges and corners
      const a = (k / 8) * Math.PI * 2, eu = Math.cos(a), ev = Math.sin(a), s = Math.min(Math.abs(du / 2 / (eu || 1e-6)), Math.abs(dv / 2 / (ev || 1e-6)));
      const path = Array.from({ length: 6 }, (_, m) => { const t = m / 5, r = s * Math.pow(t, 0.85); return [u + eu * r, v + ev * r, zt + (zc - zt) * Math.sin((t * Math.PI) / 2), 0.2 - 0.08 * t, 0.2 - 0.08 * t]; });
      sweep(S, F, path, white, PL, 5, false);
    }
  }
  // ridge and valley ribs: the lines where the vaults meet
  for (let j = 0; j <= rows; j++) { const v = -o.hw + dv * j; limb(S, F(-o.hl, v, zc), F(o.hl, v, zc), 0.16, 0.16, 5, white2, PL, false); }
  for (let i = 0; i <= nU; i++) { const u = -o.hl + du * i; limb(S, F(u, -o.hw, zc), F(u, o.hw, zc), 0.16, 0.16, 5, white2, PL, false); }
}

// Praça de Touros do Campo Pequeno (1892): neo-Mudéjar bullring in red brick with cream bands. Its four
// gate towers (mapped as plain boxes) are modelled: horseshoe-arched openings, a stepped crest, corner
// turrets with little cupolas, and the big onion dome on an octagonal drum.
export function campoPequenoTower(S, { cx, cy, ux, uy, hw, ground, lin, srgb }) {
  const brick = lin(srgb('#a4473a')), cream = lin(srgb('#e3d2ae')), dark = lin(srgb('#2f2a26')), domeC = lin(srgb('#8a3d33'));
  const ST = [KIND.STONE / 8, 4 / 8, 0.33, 0.9], TL = [KIND.TILES / 8, 4 / 8, 0.33, 1];
  const K = kit(S, { cx, cy, ux, uy, ground, zb: -1, wall: brick, roof: domeC, ST, TL }), { W3, blk } = K;
  const O = openings(S, K.P2, W3, ux, uy, ground, cream, dark, ST);
  const H = 21;
  blk(-hw, hw, -hw, hw, -1, H, brick);
  for (const z of [0.9, 7.6, 14.2, H - 0.5]) blk(-hw - 0.15, hw + 0.15, -hw - 0.15, hw + 0.15, z, z + 0.4, cream);   // cream bands
  for (const [nu, nv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    O.win(nu * hw, nv * hw, nu, nv, 0.5, 3.2, 5.2, 'arch', 0.2);                                     // gate
    for (const d of [-2.4, 2.4]) { const tu = -nv, tv = nu; O.win(nu * hw + tu * d, nv * hw + tv * d, nu, nv, 9.0, 1.3, 3.4, 'arch', 0.16); O.win(nu * hw + tu * d, nv * hw + tv * d, nu, nv, 15.4, 1.1, 3.0, 'arch', 0.16); }
  }
  // stepped (Mudéjar) crest
  const m = Math.max(3, Math.floor((2 * hw) / 1.6));
  for (const [nu, nv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let k = 0; k < m; k++) {
    const t = -hw + (2 * hw * (k + 0.5)) / m, u = nu ? nu * (hw - 0.25) : t, v = nv ? nv * (hw - 0.25) : t;
    blk(u - 0.35, u + 0.35, v - 0.35, v + 0.35, H, H + 0.9, brick); blk(u - 0.2, u + 0.2, v - 0.2, v + 0.2, H + 0.9, H + 1.5, cream);
  }
  // corner turrets with small cupolas
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const u = su * (hw - 0.2), v = sv * (hw - 0.2);
    sweep(S, W3, [[u, v, H - 2, 0.9, 0.9], [u, v, H + 2.6, 0.9, 0.9], [u, v, H + 2.8, 1.05, 1.05]], brick, ST, 8, false);
    sweep(S, W3, [[u, v, H + 2.8, 0.95, 0.95], [u, v, H + 3.5, 1.08, 1.08], [u, v, H + 4.3, 0.7, 0.7], [u, v, H + 4.9, 0.12, 0.12], [u, v, H + 5.4, 0.04, 0.04]], domeC, ST, 8);
  }
  // octagonal drum with arched windows and the onion dome
  const r = hw * 0.62;
  sweep(S, W3, [[0, 0, H - 0.5, r, r], [0, 0, H + 4.2, r, r], [0, 0, H + 4.6, r + 0.25, r + 0.25], [0, 0, H + 4.9, r, r]], brick, ST, 8, false);
  for (let k = 0; k < 8; k++) { const a = ((k + 0.5) / 8) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a); O.win(ca * r * 0.93, sa * r * 0.93, ca, sa, H + 1.0, 0.9, 2.2, 'arch', 0.12); }
  const on = [[0, r * 1.0], [0.9, r * 1.18], [2.0, r * 1.22], [3.3, r * 1.0], [4.6, r * 0.55], [5.6, r * 0.2], [6.4, 0.08]];
  sweep(S, W3, on.map(([dz, rr]) => [0, 0, H + 4.9 + dz, rr, rr]), domeC, ST, 12);
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; sweep(S, W3, on.slice(0, 6).map(([dz, rr]) => [Math.cos(a) * rr, Math.sin(a) * rr, H + 4.9 + dz, 0.07, 0.07]), cream, ST, 4, false); }   // gilded ribs
  sweep(S, W3, [[0, 0, H + 11.2, 0.12, 0.12], [0, 0, H + 13.0, 0.03, 0.03]], cream, ST, 5);
}

// Torre Vasco da Gama (1998): a 145 m concrete blade with a white steel lattice "sail" curving out from it toward
// the river, the restaurant pod (blue glass band under a white cap) near the top. The sail is built from the mapped
// lattice rings (outer edge read by rays from the core), joined by verticals and alternating diagonals every ~4 m.
export function torreVascoGama(S, { core, pod, arcs, ground, lin, srgb }) {
  const white = lin(srgb('#eef0ef')), white2 = lin(srgb('#d6dad9')), conc = lin(srgb('#c9c6bd')), glass = lin(srgb('#47698f')), dark = lin(srgb('#2e3a46'));
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.8, 1], I0 = [0, 0, 0, 0];
  const W = (x, y, z) => [x, ground + z, -y];
  const cen = (r) => r.reduce((a, p) => [a[0] + p[0] / r.length, a[1] + p[1] / r.length], [0, 0]);
  const cc = cen(core), oc = obb(core);
  // tip direction from the biggest ring
  const big = arcs.reduce((a, b) => (Math.abs(polyArea(b.ring)) > Math.abs(polyArea(a.ring)) ? b : a));
  let far = big.ring[0]; for (const p of big.ring) if (Math.hypot(p[0] - cc[0], p[1] - cc[1]) > Math.hypot(far[0] - cc[0], far[1] - cc[1])) far = p;
  const t0 = Math.atan2(far[1] - cc[1], far[0] - cc[0]);
  const hit = (ring, a) => {   // farthest crossing of the ray from the core centre at angle a
    const dx = Math.cos(a), dy = Math.sin(a); let best = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length], ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = p[0] - cc[0], wy = p[1] - cc[1], t = (wx * ey - wy * ex) / den, s = (wx * dy - wy * dx) / den;
      if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
    }
    return best;
  };
  const phi = Math.min(...arcs.map(({ ring }) => Math.max(...ring.map((p) => { let d = Math.atan2(p[1] - cc[1], p[0] - cc[0]) - t0; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d); })))) * 0.97;
  const N = 15, ang = Array.from({ length: N }, (_, k) => t0 - phi + (2 * phi * k) / (N - 1));
  const curve = (ring) => ang.map((a) => { const r = Math.max(hit(ring, a), 2.2); return [cc[0] + Math.cos(a) * r, cc[1] + Math.sin(a) * r]; });
  const lv = arcs.slice().sort((a, b) => a.z - b.z).map((a) => ({ z: a.z, pts: curve(a.ring) }));
  lv.unshift({ z: 0, pts: lv[0].pts.map((p) => [cc[0] + (p[0] - cc[0]) * 0.92, cc[1] + (p[1] - cc[1]) * 0.92]) });
  const top = lv[lv.length - 1]; lv.push({ z: 139, pts: top.pts.map((p) => [cc[0] + (p[0] - cc[0]) * 0.45, cc[1] + (p[1] - cc[1]) * 0.45]) });
  // rows every ~4 m, linearly between the mapped rings
  const rows = [];
  for (let i = 0; i + 1 < lv.length; i++) {
    const A = lv[i], B = lv[i + 1], n = Math.max(1, Math.round((B.z - A.z) / 4.2));
    for (let s = 0; s < n; s++) { const t = s / n; rows.push({ z: A.z + (B.z - A.z) * t, main: s === 0, pts: A.pts.map((p, k) => [p[0] + (B.pts[k][0] - p[0]) * t, p[1] + (B.pts[k][1] - p[1]) * t]) }); }
  }
  rows.push({ ...lv[lv.length - 1], main: true });
  const P3 = (p, z) => W(p[0], p[1], z);
  for (let r = 0; r < rows.length; r++) {
    const R = rows[r], rr = R.main ? 0.42 : 0.15;
    for (let k = 0; k + 1 < N; k++) limb(S, P3(R.pts[k], R.z), P3(R.pts[k + 1], R.z), rr, rr, 4, R.main ? white : white2, PL, false);
    if (R.main && r) for (let k = 0; k + 1 < N; k++) {   // the walkway deck at each mapped ring
      const a = R.pts[k], b = R.pts[k + 1], ia = [cc[0] + (a[0] - cc[0]) * 0.93, cc[1] + (a[1] - cc[1]) * 0.93], ib = [cc[0] + (b[0] - cc[0]) * 0.93, cc[1] + (b[1] - cc[1]) * 0.93];
      slab4(S, [P3(a, R.z), P3(b, R.z), P3(ib, R.z), P3(ia, R.z)], 0.3, white2, PL);
    }
    if (r + 1 < rows.length) {
      const Q = rows[r + 1];
      for (let k = 0; k < N; k++) limb(S, P3(R.pts[k], R.z), P3(Q.pts[k], Q.z), 0.22, 0.22, 4, white, PL, false);
      for (let k = 0; k + 1 < N; k++) { const f = (k + r) % 2; limb(S, P3(R.pts[k + f], R.z), P3(Q.pts[k + 1 - f], Q.z), 0.11, 0.11, 4, white2, PL, false); }
    }
  }
  // the concrete blade, its top cut on a slant
  const B = (u, v, z) => W(oc.cx + oc.ux * u - oc.uy * v, oc.cy + oc.uy * u + oc.ux * v, z);
  const hu = oc.hl, hv = Math.max(1.4, oc.hw);
  box(S, oc.cx, oc.cy, oc.ux, oc.uy, hu, hv, ground - 2, ground + 136, conc, I0, PL);
  frustumAB(S, B, hu, hv, hu * 0.25, hv * 0.8, 136, 145, conc, PL);
  for (let z = 6; z < 132; z += 3.4) box(S, oc.cx, oc.cy, oc.ux, oc.uy, hu + 0.06, hv + 0.06, ground + z, ground + z + 0.18, white2, I0, PL);   // lift-shaft openings read as fine bands
  // restaurant pod
  if (pod) {
    const pc = cen(pod), r = Math.max(...pod.map((p) => Math.hypot(p[0] - pc[0], p[1] - pc[1]))) * 0.96;
    const L = (secs, col) => loft(S, W, secs.map(([z, k]) => ({ a: pc[0], b: pc[1], z, rx: r * k, ry: r * k })), col, PL, { sides: 28 });
    L([[104.5, 0.35], [107, 0.72], [109, 0.93], [111, 1]], white);
    L([[111, 1.01], [114.3, 1.01]], glass);
    L([[114.3, 1], [117, 1], [117.6, 0.97]], white);
    L([[117.6, 0.97], [119.6, 0.86], [121.5, 0.62], [122.8, 0.3], [123.2, 0.02]], white2);
    for (let k = 0; k < 28; k++) { const a = (k / 28) * Math.PI * 2, x = pc[0] + Math.cos(a) * r * 1.02, y = pc[1] + Math.sin(a) * r * 1.02; limb(S, W(x, y, 111), W(x, y, 114.3), 0.07, 0.07, 4, dark, PL, false); }
    loft(S, W, [{ a: pc[0], b: pc[1], z: 111.9, rx: r * 1.02, ry: r * 1.02 }, { a: pc[0], b: pc[1], z: 112.1, rx: r * 1.02, ry: r * 1.02 }], dark, PL, { sides: 28, cap: false });
  }
}

// Amoreiras (Tomás Taveira, 1985): postmodern office towers in salmon pink banded with dark glass. The mapped
// shaft keeps the generic curtain-wall façade (lit windows at night); this adds what makes them Amoreiras:
// dark corner pylons running past the roof, a black cornice, a pink setback storey and the blue glass pyramid.
export function amoreirasCrown(S, { ring, ground, zTop, H = 75, lin, srgb }) {
  const pink = lin(srgb('#d99a93')), pink2 = lin(srgb('#c98a84')), black = lin(srgb('#2b2d33')), glass = lin(srgb('#3a5a84'));
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.6, 1], I0 = [0, 0, 0, 0];
  const o = obb(ring), F = (u, v, z) => [o.cx + o.ux * u - o.uy * v, ground + z, -(o.cy + o.uy * u + o.ux * v)];
  const sg = polyArea(ring) > 0 ? 1 : -1;
  const grow = (r, d) => { const c = [o.cx, o.cy]; return r.map((p) => { const dx = p[0] - c[0], dy = p[1] - c[1], l = Math.hypot(dx, dy) || 1; return [p[0] + (dx / l) * d, p[1] + (dy / l) * d]; }); };
  const band = (r, z0, z1, col) => { for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; const [p, q] = sg > 0 ? [a, b] : [b, a]; wallQuad(S, p, q, ground + z0, ground + z0, ground + z1, ground + z1, col, 0, 1, ground, I0, PL); } };
  const R = grow(ring, 0.35);
  band(R, zTop - 0.2, zTop + 1.3, black);   // cornice
  const flat = (r, z, col) => { const flatArr = r.flat(), idx = earcut(flatArr); for (let k = 0; k < idx.length; k += 3) { const [a, b, c] = [idx[k], idx[k + 1], idx[k + 2]].map((i) => [r[i][0], ground + z, -r[i][1]]); tri(S, a, b, c, [0, 1, 0], col, [0, 0], [0, 0], [0, 0], I0, PL); } };
  flat(R, zTop + 1.3, black);
  const a = o.hl - 3.2, b = o.hw - 3.2, zs = zTop + 1.3, zc = zs + 5.2;
  frustumAB(S, F, a, b, a, b, zs, zc, pink, PL);
  for (let k = 0; k < 2; k++) frustumAB(S, F, a + 0.12, b + 0.12, a + 0.12, b + 0.12, zs + 1.2 + k * 2, zs + 2.2 + k * 2, glass, PL);   // ribbon windows in the setback
  frustumAB(S, F, a + 0.4, b + 0.4, a + 0.4, b + 0.4, zc, zc + 0.9, black, PL);
  frustumAB(S, F, a, b, 0.35, 0.35, zc + 0.9, Math.max(H, zc + 6), glass, PL);   // glass pyramid
  limb(S, F(0, 0, Math.max(H, zc + 6) - 0.5), F(0, 0, Math.max(H, zc + 6) + 4), 0.18, 0.05, 6, black, PL);   // finial
  // corner pylons: dark shafts banded in pink, rising past the cornice with pyramid caps
  const cu = o.hl - 1.2, cv = o.hw - 1.2, s = 2.3;
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const W2 = (u, v, z) => F(su * cu + u, sv * cv + v, z);
    frustumAB(S, W2, s, s, s, s, -1.5, zTop + 6, black, PL);
    for (let z = 3.6; z < zTop + 5; z += 7.2) frustumAB(S, W2, s + 0.08, s + 0.08, s + 0.08, s + 0.08, z, z + 0.9, pink2, PL);
    frustumAB(S, W2, s + 0.25, s + 0.25, s + 0.25, s + 0.25, zTop + 6, zTop + 6.8, pink, PL);
    frustumAB(S, W2, s + 0.1, s + 0.1, 0.1, 0.1, zTop + 6.8, zTop + 10.5, pink, PL);
  }
}

// MAAT (Amanda Levete, 2016): a long, low wave on the riverfront clad in white crackle-glazed tiles. The roof is a
// walkable shell that rises from the promenade at the west end to ~13 m, domed gently across; under it the river
// face is a band of dark glass. Roof built as a height field on 3 m cells clipped exactly to the mapped outline.
export function maat(S, { ring, holes = [], ground, lin, srgb }) {
  const tile = lin(srgb('#eeedea')), tile2 = lin(srgb('#e7e6e2')), glassC = lin(srgb('#33414b'));
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.4, 1], I0 = [0, 0, 0, 0];
  const o = obb(ring), H = 13;
  const lu = (x, y) => [(x - o.cx) * o.ux + (y - o.cy) * o.uy, -(x - o.cx) * o.uy + (y - o.cy) * o.ux];
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const zAt = (x, y) => { const [u, v] = lu(x, y), t = (u + o.hl) / (2 * o.hl), w = v / o.hw;
    return 0.4 + (H - 0.4) * sm(0.02, 0.6, t) * (1 - 0.3 * sm(0.88, 1.02, t)) * (0.84 + 0.16 * (1 - w * w)); };
  // roof cells
  const toC = (r) => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
  const cs = 3, bx = ring.map((p) => p[0]), by = ring.map((p) => p[1]);
  for (let x0 = Math.min(...bx); x0 < Math.max(...bx); x0 += cs) for (let y0 = Math.min(...by); y0 < Math.max(...by); y0 += cs) {
    const c = new ClipperLib.Clipper();
    c.AddPaths([toC(ring), ...holes.map(toC)], ClipperLib.PolyType.ptSubject, true);
    c.AddPath(toC([[x0, y0], [x0 + cs, y0], [x0 + cs, y0 + cs], [x0, y0 + cs]]), ClipperLib.PolyType.ptClip, true);
    const out = new ClipperLib.Paths(); c.Execute(ClipperLib.ClipType.ctIntersection, out, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftNonZero);
    for (const path of out) {
      const pts = path.map((q) => [q.X / SCALE, q.Y / SCALE]); if (pts.length < 3) continue;
      const idx = earcut(pts.flat());
      for (let k = 0; k < idx.length; k += 3) {
        const P = [idx[k], idx[k + 1], idx[k + 2]].map((i) => [pts[i][0], ground + zAt(...pts[i]), -pts[i][1]]);
        const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]], e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...n) || 1; n = n.map((q) => q / l); if (n[1] < 0) n = n.map((q) => -q);
        tri(S, P[0], P[1], P[2], n, ((Math.floor(x0 / cs) + Math.floor(y0 / cs)) & 1) ? tile : tile2, [0, 0], [0, 0], [0, 0], I0, PL);
      }
    }
  }
  // walls: outline (densified) up to the roof; dark glass in a band under the eaves, deeper on the river side
  const sg = polyArea(ring) > 0 ? 1 : -1;
  const wall = (r, outward) => {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 3));
      for (let k = 0; k < n; k++) {
        const p0 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], p1 = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n];
        const [p, q] = (sg > 0) === outward ? [p0, p1] : [p1, p0], zp = zAt(...p), zq = zAt(...q);
        const river = lu((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)[1] < 0, gl = Math.min(river ? 4.2 : 2.8, Math.min(zp, zq) - 0.9);
        if (gl > 0.6) { wallQuad(S, p, q, ground - 1, ground - 1, ground + gl, ground + gl, glassC, 0, 1, ground, I0, PL); wallQuad(S, p, q, ground + gl, ground + gl, ground + zp, ground + zq, tile, 0, 1, ground, I0, PL); }
        else wallQuad(S, p, q, ground - 1, ground - 1, ground + zp, ground + zq, tile, 0, 1, ground, I0, PL);
      }
    }
  };
  wall(ring, true); for (const h of holes) wall(h, false);
}

// Oceanário (Peter Chermayeff, 1998): a box standing in the dock, blue-grey below and white above, with the four
// habitats on its upper level under glazed corner roofs around the raised central tank.
export function oceanario(S, { corners, core, ground, zTop = 15, lin, srgb }) {
  const glass = lin(srgb('#8fb4c8')), frame = lin(srgb('#eef0ef')), white = lin(srgb('#e4e6e5')), blue = lin(srgb('#5d7f99'));
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.5, 1];
  for (const r of corners) {
    const o = obb(r), F = (u, v, z) => [o.cx + o.ux * u - o.uy * v, ground + z, -(o.cy + o.uy * u + o.ux * v)];
    const a = o.hl * 0.92, b = o.hw * 0.92;
    frustumAB(S, F, a, b, a, b, zTop - 0.5, zTop + 2.2, white, PL);                       // parapet ring of the habitat
    frustumAB(S, F, a * 0.97, b * 0.97, a * 0.3, b * 0.3, zTop + 2.2, zTop + 9.5, glass, PL);   // glazed hip
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) limb(S, F(su * a * 0.97, sv * b * 0.97, zTop + 2.2), F(su * a * 0.3, sv * b * 0.3, zTop + 9.5), 0.18, 0.18, 4, frame, PL, false);   // hip ribs
    for (const t of [-0.5, 0, 0.5]) { limb(S, F(t * a * 0.97, -b * 0.97, zTop + 2.2), F(t * a * 0.3, -b * 0.3, zTop + 9.5), 0.1, 0.1, 4, frame, PL, false); limb(S, F(t * a * 0.97, b * 0.97, zTop + 2.2), F(t * a * 0.3, b * 0.3, zTop + 9.5), 0.1, 0.1, 4, frame, PL, false);
      limb(S, F(-a * 0.97, t * b * 0.97, zTop + 2.2), F(-a * 0.3, t * b * 0.3, zTop + 9.5), 0.1, 0.1, 4, frame, PL, false); limb(S, F(a * 0.97, t * b * 0.97, zTop + 2.2), F(a * 0.3, t * b * 0.3, zTop + 9.5), 0.1, 0.1, 4, frame, PL, false); }
    frustumAB(S, F, a * 0.3, b * 0.3, a * 0.3, b * 0.3, zTop + 9.5, zTop + 9.9, frame, PL);
  }
  if (core) {
    const o = obb(core), F = (u, v, z) => [o.cx + o.ux * u - o.uy * v, ground + z, -(o.cy + o.uy * u + o.ux * v)];
    frustumAB(S, F, o.hl, o.hw, o.hl, o.hw, zTop - 0.5, zTop + 6, blue, PL);
    frustumAB(S, F, o.hl + 0.3, o.hw + 0.3, o.hl + 0.3, o.hw + 0.3, zTop + 6, zTop + 7, white, PL);
  }
}

// Estádio José Alvalade (Tomás Taveira, 2003): the bowl of green seats, a façade of coloured ceramic panels
// (Sporting green, yellow, white, a little blue), and a pale roof ring on yellow trusses over the stands.
export function alvaladeStadium(S, { ring, hole, ground, lin, srgb, H = 36 }) {
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.6, 1], I0 = [0, 0, 0, 0];
  const green = lin(srgb('#1d7347')), green2 = lin(srgb('#25845a')), conc = lin(srgb('#b4b2ac')), roofC = lin(srgb('#e9ebea')), yellow = lin(srgb('#e3b92c'));
  const tiles = ['#2f8a52', '#e0bd3a', '#eeeeea', '#1f6b45', '#8fc3a1', '#5f86b3'].map((h) => lin(srgb(h)));
  const c = hole.reduce((a, p) => [a[0] + p[0] / hole.length, a[1] + p[1] / hole.length], [0, 0]);
  const hit = (r, a) => { const dx = Math.cos(a), dy = Math.sin(a); let best = 0;
    for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length], ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
      const wx = p[0] - c[0], wy = p[1] - c[1], t = (wx * ey - wy * ex) / den, s = (wx * dy - wy * dx) / den; if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t); } return best; };
  const N = 120, A = Array.from({ length: N }, (_, k) => (k / N) * Math.PI * 2);
  const Ro = A.map((a) => hit(ring, a)), Ri = A.map((a) => hit(hole, a));
  const P = (k, r, z) => [c[0] + Math.cos(A[k % N]) * r, ground + z, -(c[1] + Math.sin(A[k % N]) * r)];
  const nrm = (a, b, d) => { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]; const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n) || 1; return n.map((q) => q / l); };
  const quad = (a, b, cc, d, col, up) => { let n = nrm(a, b, d); if ((up > 0 && n[1] < 0) || (up < 0 && n[1] > 0)) n = n.map((q) => -q); tri(S, a, b, cc, n, col, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, a, cc, d, n, col, [0, 0], [0, 0], [0, 0], I0, PL); };
  // stands: lower tier, a concourse band, upper tier, rising to the roof's inner shadow line
  const seatC = ['#1f5a44', '#1a4637', '#2a4862', '#262f36', '#3a7853', '#c4a33a', '#d6d6cf'].map((h) => lin(srgb(h)));
  const tiers = [[0, 1.2], [0.42, 15], [0.45, 17], [0.86, 33]];   // fraction of the way from the pitch edge to the outer wall, height
  const rAt = (k, f) => Ri[k] + (Ro[k] - Ri[k]) * f;
  for (let t = 0; t + 1 < tiers.length; t++) for (let k = 0; k < N; k++) {
    const hs = Math.sin(k * 91.7 + t * 37.3) * 43758.5453, hv = hs - Math.floor(hs);   // seats: a dark mosaic of greens, navy and charcoal with yellow and white flecks (reads dark from the air, as on Earth)
    const col = t === 1 ? conc : seatC[hv < 0.3 ? 0 : hv < 0.52 ? 1 : hv < 0.7 ? 2 : hv < 0.84 ? 3 : hv < 0.93 ? 4 : hv < 0.97 ? 5 : 6];
    quad(P(k, rAt(k, tiers[t][0]), tiers[t][1]), P(k + 1, rAt((k + 1) % N, tiers[t][0]), tiers[t][1]), P(k + 1, rAt((k + 1) % N, tiers[t + 1][0]), tiers[t + 1][1]), P(k, rAt(k, tiers[t + 1][0]), tiers[t + 1][1]), col, 1);
  }
  // façade: coloured ceramic panels, 3 m wide, 4.5 m tall, a deterministic mosaic
  const hsh = (i, j) => { const x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return x - Math.floor(x); };
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    for (let j = 0; j < 8; j++) {
      const z0 = j * 4.5, z1 = z0 + 4.5, h = hsh(k, j), col = j === 0 ? conc : tiles[h < 0.3 ? 0 : h < 0.5 ? 1 : h < 0.72 ? 2 : h < 0.85 ? 3 : h < 0.94 ? 4 : 5];
      quad(P(k, Ro[k], z0 - (j ? 0 : 1)), P(k + 1, Ro[k2], z0 - (j ? 0 : 1)), P(k + 1, Ro[k2], z1), P(k, Ro[k], z1), col, 0);
    }
  }
  // roof: a round, pale sage translucent disc reaching right to the rectangular opening over the pitch, with cream opaque
  // panels along each side of the opening (not at the corners); hung by cables from four green lattice masts on the diagonals
  const sage = lin(srgb('#b3ca8f')), sage2 = lin(srgb('#a8c086')), cream = lin(srgb('#e4dcc2')), mastC = lin(srgb('#2f7a55'));
  const oh = obb(hole);
  const sideMid = (k) => { const x = c[0] + Math.cos(A[k]) * Ri[k] - oh.cx, y = c[1] + Math.sin(A[k]) * Ri[k] - oh.cy;
    const u = x * oh.ux + y * oh.uy, v = -x * oh.uy + y * oh.ux; return !(Math.abs(u) > oh.hl * 0.8 && Math.abs(v) > oh.hw * 0.72); };   // anywhere along a side, not round a corner
  const rIn = (k) => Ri[k] + 1.5, rMid = (k) => Ri[k] + Math.min(24, (Ro[k] - Ri[k]) * 0.45);
  const zR = (r, k) => H + 3 * (Ro[k] - r) / Math.max(1, Ro[k] - Ri[k]);   // rises 3 m toward the opening
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N, cr = sideMid(k) && sideMid(k2);
    quad(P(k, Ro[k], H), P(k + 1, Ro[k2], H), P(k + 1, rMid(k2), zR(rMid(k2), k2)), P(k, rMid(k), zR(rMid(k), k)), k % 6 < 3 ? sage : sage2, 1);
    quad(P(k, rMid(k), zR(rMid(k), k)), P(k + 1, rMid(k2), zR(rMid(k2), k2)), P(k + 1, rIn(k2), zR(rIn(k2), k2)), P(k, rIn(k), zR(rIn(k), k)), cr ? cream : sage, 1);
    quad(P(k, Ro[k], H - 0.6), P(k + 1, Ro[k2], H - 0.6), P(k + 1, rIn(k2), zR(rIn(k2), k2) - 0.6), P(k, rIn(k), zR(rIn(k), k) - 0.6), conc, -1);
    quad(P(k, rIn(k), zR(rIn(k), k) - 0.6), P(k + 1, rIn(k2), zR(rIn(k2), k2) - 0.6), P(k + 1, rIn(k2), zR(rIn(k2), k2)), P(k, rIn(k), zR(rIn(k), k)), conc, 0);
    quad(P(k, Ro[k], H - 0.6), P(k + 1, Ro[k2], H - 0.6), P(k + 1, Ro[k2], H + 0.4), P(k, Ro[k], H + 0.4), mastC, 0);   // green edge beam
  }
  // four lattice masts on the diagonals, just outside the roof edge, leaning out; stays to the roof's inner edge
  for (const q of [0.125, 0.375, 0.625, 0.875]) {
    const ang = Math.atan2(oh.uy, oh.ux) + q * Math.PI * 2;
    let k = Math.round(((ang % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * N) % N;
    const base = P(k, Ro[k] + 6, -1), top = P(k, Ro[k] + 14, H + 34);
    for (const [dx, dz] of [[-1.3, -1.3], [1.3, -1.3], [1.3, 1.3], [-1.3, 1.3]]) limb(S, [base[0] + dx * 1.6, base[1], base[2] + dz * 1.6], [top[0] + dx * 0.4, top[1], top[2] + dz * 0.4], 0.45, 0.3, 5, mastC, PL, false);
    for (let z = 4; z < H + 32; z += 5) { const t = (z + 1) / (H + 35), x = base[0] + (top[0] - base[0]) * t, y = base[1] + (top[1] - base[1]) * t, w = base[2] + (top[2] - base[2]) * t, r = 1.6 * (1 - t) + 0.4 * t;
      limb(S, [x - r * 1.3, y, w - r * 1.3], [x + r * 1.3, y + 2.5, w + r * 1.3], 0.15, 0.15, 4, mastC, PL, false);
      limb(S, [x + r * 1.3, y, w - r * 1.3], [x - r * 1.3, y + 2.5, w + r * 1.3], 0.15, 0.15, 4, mastC, PL, false); }
    for (const dk of [-9, -4, 0, 4, 9]) { const kk = (k + dk + N) % N; limb(S, top, P(kk, rMid(kk), zR(rMid(kk), kk) + 0.3), 0.09, 0.09, 3, lin(srgb('#d7dbd8')), PL, false); }
    limb(S, top, P(k, Ro[k] + 40, 0), 0.12, 0.12, 3, lin(srgb('#d7dbd8')), PL, false);   // back stay
  }
}

// Jerónimos monastery range (the long south wing, drawn by the generic builder at OVERRIDES h): Manueline dress on top of it —
// a cornice band, buttresses with crocketed pinnacles along the south front, and a crest of small pinnacles round the parapet
export function jeronimosWing(S, { ring, ground, H, lin, srgb }) {
  const stone = lin(srgb('#ddd0b1')), stone2 = lin(srgb('#cbbd9b')), dark = lin(srgb('#3a372f'));
  const ST = [KIND.STONE / 8, 5 / 8, 0.61, 0.9];
  const P2 = (u, v) => [u, v], W3 = (u, v, z) => [u, ground + z, -v];
  const O = openings(S, P2, W3, 1, 0, ground, stone2, dark, ST);
  const sgn = polyArea(ring) > 0 ? 1 : -1, n = ring.length, yS = Math.min(...ring.map((p) => p[1]));
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l < 1.5) continue;
    const eu = (q[0] - p[0]) / l, ev = (q[1] - p[1]) / l, nu = sgn * ev, nv = -sgn * eu, mu = (p[0] + q[0]) / 2, mv = (p[1] + q[1]) / 2;
    O.tbox(mu + nu * 0.12, mv + nv * 0.12, eu, ev, l / 2 + 0.12, 0.26, H - 1.0, H - 0.65, stone2);   // cornice
    O.tbox(mu + nu * 0.08, mv + nv * 0.08, eu, ev, l / 2 + 0.08, 0.18, 1.0, 1.3, stone2);            // plinth band
    const m = Math.max(1, Math.round(l / 2.2));
    for (let k = 0; k <= m; k++) { const t = k / m, x = p[0] + (q[0] - p[0]) * t - nu * 0.12, y = p[1] + (q[1] - p[1]) * t - nv * 0.12;
      frustum(S, x, y, eu, ev, 0.17, 0.17, ground + H + 0.9, ground + H + 1.5, stone2, ST, false);
      frustum(S, x, y, eu, ev, 0.17, 0.02, ground + H + 1.5, ground + H + 2.4, stone2, ST, false); }
    if (nv > -0.55 || l < 14 || mv > yS + 25) continue;   // buttresses only on the south front (the range's back walls face a yard)
    const nb = Math.round(l / 8.8);
    for (let k = 0; k <= nb; k++) {
      const t = k / nb, x = p[0] + (q[0] - p[0]) * t + nu * 0.55, y = p[1] + (q[1] - p[1]) * t + nv * 0.55;
      O.tbox(x, y, eu, ev, 0.65, 0.6, -1, H - 1.6, stone);
      O.tbox(x + nu * 0.08, y + nv * 0.08, eu, ev, 0.8, 0.7, -1, 1.4, stone2);
      for (const z of [6.2, 11.4]) O.tbox(x + nu * 0.05, y + nv * 0.05, eu, ev, 0.75, 0.66, z, z + 0.3, stone2);
      frustum(S, x, y, eu, ev, 0.62, 0.62, ground + H - 1.6, ground + H + 1.8, stone, ST, false);
      frustum(S, x, y, eu, ev, 0.7, 0.7, ground + H + 1.8, ground + H + 2.1, stone2, ST, false);
      frustum(S, x, y, eu, ev, 0.55, 0.04, ground + H + 2.1, ground + H + 6.2, stone2, ST, false);
    }
  }
}

// Altice Arena (Pavilhão Atlântico): the zinc hull over the bowl — one smooth elliptic shell on the mapped roof outline,
// rising from the drum's roof (z0) to the crown (z1), standing-seam strips running crown to rim
export function arenaShell(S, { ring, ground, z0, z1, lin, srgb }) {
  const zinc = lin(srgb('#a9adae')), zinc2 = lin(srgb('#9a9fa1')), rimC = lin(srgb('#d9dbd8'));
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.4, 1], I0 = [0, 0, 0, 0];
  const per = ring.reduce((a, p, i) => a + Math.hypot(ring[(i + 1) % ring.length][0] - p[0], ring[(i + 1) % ring.length][1] - p[1]), 0);
  const N = 120, pts = [];   // resample the outline evenly
  for (let k = 0, i = 0, acc = 0; k < N; k++) {
    const want = (k / N) * per;
    while (true) { const p = ring[i % ring.length], q = ring[(i + 1) % ring.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (acc + l >= want || i > 4 * ring.length) { const t = l ? (want - acc) / l : 0; pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); break; } acc += l; i++; }
  }
  const c = [pts.reduce((a, p) => a + p[0], 0) / N, pts.reduce((a, p) => a + p[1], 0) / N];
  const M = 16, at = (k, j) => { const s = 1 - j / M, p = pts[k % N]; return [c[0] + (p[0] - c[0]) * s, ground + z0 + (z1 - z0) * Math.pow(1 - s * s, 0.62), -(c[1] + (p[1] - c[1]) * s)]; };
  for (let k = 0; k < N; k++) for (let j = 0; j < M; j++) {
    const a = at(k, j), b = at(k + 1, j), d = at(k, j + 1), e = at(k + 1, j + 1);
    for (const [A, B, C] of [[a, b, e], [a, e, d]]) {
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...n) || 1; n = n.map((q) => q / l); if (n[1] < 0) n = n.map((q) => -q);
      tri(S, A, B, C, n, (k >> 2) & 1 ? zinc : zinc2, [0, 0], [0, 0], [0, 0], I0, PL);
    }
  }
  // the row of skylight slats across the crown (dark glass louvres), as seen from above
  { const o = obb(pts), glass = lin(srgb('#3d4a52')), zs = (u, v) => ground + z0 + (z1 - z0) * Math.pow(Math.max(0, 1 - (u / o.hl) ** 2 - (v / o.hw) ** 2), 0.62);
    for (let i = 0; i < 8; i++) { const u = -0.42 * o.hl + (0.84 * o.hl * i) / 7, hv = 0.3 * o.hw * Math.sqrt(1 - (u / o.hl) ** 2);
      const x = o.cx + o.ux * u, y = o.cy + o.uy * u, z = zs(u, 0);
      box(S, x, y, o.ux, o.uy, 1.6, hv, z - 0.4, z + 0.5, glass, I0, PL); } }
  // a pale rim beam where the shell meets the drum
  for (let k = 0; k < N; k++) { const p = pts[k], q = pts[(k + 1) % N], l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l < 0.05) continue;
    box(S, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (q[0] - p[0]) / l, (q[1] - p[1]) / l, l / 2 + 0.1, 0.5, ground + z0 - 0.6, ground + z0 + 0.5, rimC, I0, PL); }
}

// a jazigo: the family chapel-tomb that fills Lisbon's cemeteries in streets — a stone cell with a cornice and a
// pyramid or gabled cap, its door to the path (u = along the path, v = towards it)
export function jazigo(S, { x, y, ux, uy, ground, h, w, d, col, trim, cap }) {
  const I0 = [0, 0, 0, 0], ST = [KIND.PLAIN / 8, 5 / 8, 0.37, 1];
  box(S, x, y, ux, uy, w / 2, d / 2, ground - 0.4, ground + h, col, I0, ST);
  box(S, x, y, ux, uy, w / 2 + 0.12, d / 2 + 0.12, ground + h, ground + h + 0.22, trim, I0, ST);
  box(S, x, y, ux, uy, w / 2 + 0.1, d / 2 + 0.1, ground - 0.4, ground + 0.35, trim, I0, ST);
  if (cap === 0) frustum(S, x, y, ux, uy, Math.min(w, d) / 2, 0.05, ground + h + 0.22, ground + h + 0.22 + Math.min(w, d) * 0.55, trim, ST, false);
  else if (cap === 1) { frustum(S, x, y, ux, uy, Math.min(w, d) / 2 - 0.1, Math.min(w, d) / 2 - 0.1, ground + h + 0.22, ground + h + 0.6, trim, ST, true);
    frustum(S, x, y, ux, uy, 0.12, 0.12, ground + h + 0.6, ground + h + 1.5, trim, ST, true); }   // a plinth and a stone cross shaft
  // the door: a dark slot on the path face
  box(S, x - uy * (d / 2 + 0.02), y + ux * (d / 2 + 0.02), ux, uy, Math.min(0.5, w * 0.25), 0.04, ground + 0.35, ground + Math.min(h - 0.4, 2.3), [0.05, 0.05, 0.05], I0, ST);
}

// Open raked stands (leisure=bleachers / building=grandstand without a roof of their own, e.g. Restelo's horseshoe): the
// outer edge stands at H on a plain concrete wall, the seating falls in rows to a low wall at the pitch side. Each outer
// edge point is paired with its nearest point on the pitch-facing edges and the band between is laid in rows: seats in the
// club colour, every fourth row a grey gangway.
export function bleachers(S, { ring, centre, ground, H = 13, seat = '#2b4167', lin, srgb }) {
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.7, 1], I0 = [0, 0, 0, 0];
  const conc = lin(srgb('#d8d6d0')), conc2 = lin(srgb('#bdbab3')), seatC = lin(srgb(seat)), seat2 = lin(srgb('#e9e9e6'));
  const sg = polyArea(ring) > 0 ? 1 : -1, n = ring.length;
  const inner = [], outer = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l < 0.3) continue;
    const nx = sg * (b[1] - a[1]) / l, ny = -sg * (b[0] - a[0]) / l, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = centre[0] - mx, dy = centre[1] - my, dl = Math.hypot(dx, dy) || 1, dot = (nx * dx + ny * dy) / dl;
    (dot > 0.35 ? inner : dot < -0.35 ? outer : []).push([a, b]);
  }
  if (!inner.length || !outer.length) return false;
  const onOuter = (p) => outer.some(([a, b]) => (a[0] === p[0] && a[1] === p[1]) || (b[0] === p[0] && b[1] === p[1]));
  const ends = [];   // the stand's ends: walls whose top follows the rake
  for (let i = 0; i < n; i++) { const a = ring[i], b = ring[(i + 1) % n];
    if (!inner.some((e) => e[0] === a) && !outer.some((e) => e[0] === a) && Math.hypot(b[0] - a[0], b[1] - a[1]) >= 0.3) ends.push([a, b]); }
  const nearestInner = (p) => { let best = null, bd = Infinity;
    for (const [a, b] of inner) { const ex = b[0] - a[0], ey = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey)));
      const q = [a[0] + ex * t, a[1] + ey * t], d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } } return best; };
  const W = (p, z) => [p[0], ground + z, -p[1]];
  const nrm = (a, b, d) => { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]; const m = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...m) || 1; return m.map((q) => q / l); };
  const quad = (a, b, c, d, col, up) => { let m = nrm(a, b, d); if ((up > 0 && m[1] < 0) || (up < 0 && m[1] > 0)) m = m.map((q) => -q); tri(S, a, b, c, m, col, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, a, c, d, m, col, [0, 0], [0, 0], [0, 0], I0, PL); };
  const LOW = 1.6;
  for (const [a, b] of ends) quad(W(a, -1), W(b, -1), W(b, onOuter(b) ? H : LOW), W(a, onOuter(a) ? H : LOW), conc, 0);
  for (const [a, b] of outer) {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]), m = Math.max(1, Math.round(l / 3));
    // outer wall (faces away from the pitch)
    quad(W(a, -1), W(b, -1), W(b, H + 1.1), W(a, H + 1.1), conc, 0);
    for (let k = 0; k < m; k++) {
      const p0 = [a[0] + (b[0] - a[0]) * k / m, a[1] + (b[1] - a[1]) * k / m], p1 = [a[0] + (b[0] - a[0]) * (k + 1) / m, a[1] + (b[1] - a[1]) * (k + 1) / m];
      const q0 = nearestInner(p0), q1 = nearestInner(p1);
      if (Math.hypot(q0[0] - p0[0], q0[1] - p0[1]) > 60) continue;
      quad(W(p0, H + 1.1), W(p1, H + 1.1), W(p1, H), W(p0, H), conc, 1);   // parapet top
      const R = Math.max(3, Math.round(Math.hypot(q0[0] - p0[0], q0[1] - p0[1]) / 2.4));
      for (let r = 0; r < R; r++) {
        const f0 = r / R, f1 = (r + 1) / R, L0 = (p, q, f) => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
        const z0 = H - (H - LOW) * f0, z1 = H - (H - LOW) * f1;
        quad(W(L0(p0, q0, f0), z0), W(L0(p1, q1, f0), z0), W(L0(p1, q1, f1), z1), W(L0(p0, q0, f1), z1), r % 4 === 3 ? conc2 : (k % 9 === 4 ? seat2 : seatC), 1);
      }
      quad(W(q0, -1), W(q1, -1), W(q1, LOW), W(q0, LOW), conc, 0);   // pitch-side wall
    }
  }
  return true;
}

// Shallow barrel vault over a rectangular plan (sports pavilions, markets, hangars): runs along the plan's long axis,
// standing on the walls at z0 and rising by `rise` at the crown; the gable ends are closed in the wall colour.
export function barrelRoof(S, { ob, z0, rise, col, under, N = 12 }) {
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.55, 1], I0 = [0, 0, 0, 0];
  const P = (u, v, z) => [ob.cx + ob.ux * u - ob.uy * v, z, -(ob.cy + ob.uy * u + ob.ux * v)];
  const zAt = (t) => z0 + rise * (1 - t * t);
  const nrm = (a, b, d) => { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]; const m = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...m) || 1; return m.map((q) => q / l); };
  const hl = ob.hl, hw = ob.hw;
  for (let i = 0; i < N; i++) {
    const t0 = -1 + (2 * i) / N, t1 = -1 + (2 * (i + 1)) / N;
    const a = P(-hl, t0 * hw, zAt(t0)), b = P(hl, t0 * hw, zAt(t0)), c = P(hl, t1 * hw, zAt(t1)), d = P(-hl, t1 * hw, zAt(t1));
    let n = nrm(a, b, d); if (n[1] < 0) n = n.map((q) => -q);
    const shade = col.map((q) => q * (0.94 + 0.06 * (i % 2)));   // standing-seam sheets
    tri(S, a, b, c, n, shade, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, a, c, d, n, shade, [0, 0], [0, 0], [0, 0], I0, PL);
    for (const su of [-1, 1]) {   // gable ends
      const nE = [ob.ux * su, 0, -ob.uy * su];
      tri(S, P(su * hl, t0 * hw, z0), P(su * hl, t1 * hw, z0), P(su * hl, t1 * hw, zAt(t1)), nE, under, [0, 0], [0, 0], [0, 0], I0, PL);
      tri(S, P(su * hl, t0 * hw, z0), P(su * hl, t1 * hw, zAt(t1)), P(su * hl, t0 * hw, zAt(t0)), nE, under, [0, 0], [0, 0], [0, 0], I0, PL);
    }
  }
}

// Pavilhão de Portugal (Siza, 1998): the "pala", a 20 cm concrete sheet hung in a shallow catenary 65 m between two
// porticoes of parallel concrete fins. Built over its mapped outline (u along the span).
export function palaSiza(S, { ring, ground, lin, srgb, top = 13.5, sag = 3.2 }) {
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.5, 1], I0 = [0, 0, 0, 0];
  const conc = lin(srgb('#d9d5cc')), under = lin(srgb('#bdb8ae'));
  const o = obb(ring), hl = o.hl, hw = o.hw;
  const P = (u, v, z) => [o.cx + o.ux * u - o.uy * v, ground + z, -(o.cy + o.uy * u + o.ux * v)];
  const N = 24, zAt = (u) => top - sag * (1 - (u / hl) ** 2);
  for (let i = 0; i < N; i++) {
    const u0 = -hl + (2 * hl * i) / N, u1 = -hl + (2 * hl * (i + 1)) / N;
    const a = P(u0, -hw, zAt(u0)), b = P(u1, -hw, zAt(u1)), c = P(u1, hw, zAt(u1)), d = P(u0, hw, zAt(u0));
    tri(S, a, b, c, [0, 1, 0], conc, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, a, c, d, [0, 1, 0], conc, [0, 0], [0, 0], [0, 0], I0, PL);
    const a2 = P(u0, -hw, zAt(u0) - 0.25), b2 = P(u1, -hw, zAt(u1) - 0.25), c2 = P(u1, hw, zAt(u1) - 0.25), d2 = P(u0, hw, zAt(u0) - 0.25);
    tri(S, a2, c2, b2, [0, -1, 0], under, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, a2, d2, c2, [0, -1, 0], under, [0, 0], [0, 0], [0, 0], I0, PL);
    for (const sv of [-1, 1]) { const n = [o.uy * -sv, 0, -o.ux * sv];   // thin edges
      tri(S, P(u0, sv * hw, zAt(u0) - 0.25), P(u1, sv * hw, zAt(u1) - 0.25), P(u1, sv * hw, zAt(u1)), [-o.uy * sv, 0, -o.ux * sv], conc, [0, 0], [0, 0], [0, 0], I0, PL);
      tri(S, P(u0, sv * hw, zAt(u0) - 0.25), P(u1, sv * hw, zAt(u1)), P(u0, sv * hw, zAt(u0)), [-o.uy * sv, 0, -o.ux * sv], conc, [0, 0], [0, 0], [0, 0], I0, PL); }
  }
  // porticoes: nine parallel fins at each end, the sheet's anchors
  for (const su of [-1, 1]) for (let k = 0; k < 9; k++) {
    const v = -hw + (2 * hw * (k + 0.5)) / 9;
    const c = P(su * (hl + 4), v, 0);
    box(S, c[0], -c[2], o.ux, o.uy, 4.2, 0.6, ground - 1, ground + top + 0.6, conc, I0, PL);
  }
}

// Torres São Gabriel and São Rafael (1998–2004): the 110 m twins by the Vasco da Gama centre end in a raked glass crown
// that climbs to a point at one end of their lens-shaped plan
export function sailCrown(S, { ring, z0, rise, toward = 1, col, lin, srgb }) {
  const PL = [KIND.PLAIN / 8, 3 / 8, 0.4, 1], I0 = [0, 0, 0, 0];
  const o = obb(ring), apex = [o.cx + o.ux * o.hl * 0.78 * toward, o.cy + o.uy * o.hl * 0.78 * toward];
  const K = 8, c = lin(srgb(col));
  const at = (p, t) => [p[0] + (apex[0] - p[0]) * t, p[1] + (apex[1] - p[1]) * t];
  for (let k = 0; k < K; k++) {
    const t0 = k / K, t1 = (k + 1) / K;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const A = at(p, t0), B = at(q, t0), C = at(q, t1), D = at(p, t1);
      const W = (xy, t) => [xy[0], z0 + rise * t, -xy[1]];
      const a = W(A, t0), b = W(B, t0), cc = W(C, t1), d = W(D, t1);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n) || 1; n = n.map((x) => x / l);
      const mid = [(a[0] + cc[0]) / 2 - apex[0], 0, (a[2] + cc[2]) / 2 + apex[1]];
      if (n[0] * mid[0] + n[2] * mid[2] < 0 && n[1] < 0.98) n = n.map((x) => -x);
      tri(S, a, b, cc, n, c.map((x, j) => x * (0.92 + 0.08 * (k % 2))), [0, 0], [0, 0], [0, 0], I0, PL); tri(S, a, cc, d, n, c, [0, 0], [0, 0], [0, 0], I0, PL);
    }
  }
}

// Ponte Vasco da Gama (1998), the stretch inside the diorama: the north viaduct from Sacavém, the cable-stayed main
// bridge (420 m span between two H pylons 148 m tall, 203 m side spans, deck ~50 m over the channel) and the long
// low viaduct heading for Montijo. Centreline averaged from both mapped carriageways; pylons where they are mapped.
export const VG_LINE = [[38.786526, -9.099728], [38.786635, -9.098699], [38.786688, -9.097675], [38.786703, -9.096621], [38.786665, -9.095593], [38.786592, -9.094564], [38.786471, -9.093533], [38.786357, -9.092505], [38.786233, -9.091469], [38.786119, -9.090408], [38.786, -9.089392], [38.785878, -9.08836], [38.78576, -9.087324], [38.785646, -9.086283], [38.78553, -9.085248], [38.785408, -9.084218], [38.785296, -9.083186], [38.785164, -9.082138], [38.785045, -9.081115], [38.784905, -9.080093], [38.784732, -9.079056], [38.784523, -9.078013], [38.78427, -9.076963], [38.784006, -9.075945], [38.783703, -9.074898], [38.783353, -9.073862], [38.782977, -9.072839], [38.782551, -9.071793], [38.782085, -9.070759], [38.78178, -9.070123]];
const VG_PYLONS = [[38.78583, -9.09057], [38.78529, -9.08578]];
export function ponteVascoGama(S, { fwd, ground, lin, srgb }) {
  const conc = lin(srgb('#d2cec6')), concD = lin(srgb('#aaa59c')), asphalt = lin(srgb('#5a5853')), cable = lin(srgb('#e6e6e2'));
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.3, 1], I0 = [0, 0, 0, 0];
  const pts = VG_LINE.map(([la, lo]) => fwd(la, lo));
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum.at(-1);
  const at = (s) => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
    const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / (cum[i] - cum[i - 1]))), [ax, ay] = pts[i - 1], [bx, by] = pts[i], d = Math.hypot(bx - ax, by - ay);
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, ux: (bx - ax) / d, uy: (by - ay) / d }; };
  const sOf = ([x, y]) => { let best = 0, bd = Infinity; for (let s = 0; s <= L; s += 1) { const a = at(s), d = Math.hypot(a.x - x, a.y - y); if (d < bd) { bd = d; best = s; } } return best; };
  const [s1, s2] = VG_PYLONS.map(([la, lo]) => sOf(fwd(la, lo))).sort((a, b) => a - b), sm = (s1 + s2) / 2, half = (s2 - s1) / 2;
  const HW = 15, deckZ = (s) => {
    const z = s >= s1 && s <= s2 ? 50.5 - 2.5 * ((s - sm) / half) ** 2 : s < s1 ? Math.max(12, 48 - 0.036 * (s1 - s)) : Math.max(14, 48 - 0.036 * (s - s2));
    const a = at(s); return Math.max(z, ground(a.x, a.y) + 7);
  };
  const P3 = (s, v, z) => { const a = at(s); return [a.x - a.uy * v, z, -(a.y + a.ux * v)]; };
  const quad = (A, B, C, D, col, want) => { let n = norm(A, B, C); if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) { [B, D] = [D, B]; n = n.map((q) => -q); }
    triRaw(S, A, B, C, n, col, [0, 0], [0, 0], [0, 0], I0, PL); triRaw(S, A, C, D, n, col, [0, 0], [0, 0], [0, 0], I0, PL); };
  const lat = (s, sign) => { const a = at(s); return [-a.uy * sign, 0, -a.ux * sign]; };
  // deck: a 30 m box girder, road on top, parapets and a central barrier
  const STEP = 12;
  for (let s = 0; s < L - 0.1; s += STEP) {
    const e = Math.min(L, s + STEP), z0 = deckZ(s), z1 = deckZ(e), dep = s > s1 - 210 && s < s2 + 210 ? 3.2 : 2.6;
    quad(P3(s, -HW, z0), P3(e, -HW, z1), P3(e, HW, z1), P3(s, HW, z0), asphalt, [0, 1, 0]);
    quad(P3(s, -HW, z0 - dep), P3(e, -HW, z1 - dep), P3(e, -HW, z1 + 1), P3(s, -HW, z0 + 1), conc, lat(s, -1));
    quad(P3(s, HW, z0 - dep), P3(e, HW, z1 - dep), P3(e, HW, z1 + 1), P3(s, HW, z0 + 1), conc, lat(s, 1));
    quad(P3(s, -HW + 2, z0 - dep), P3(e, -HW + 2, z1 - dep), P3(e, HW - 2, z1 - dep), P3(s, HW - 2, z0 - dep), concD, [0, -1, 0]);
    quad(P3(s, -HW, z0 - dep), P3(e, -HW, z1 - dep), P3(e, -HW + 2, z1 - dep), P3(s, -HW + 2, z0 - dep), concD, [0, -1, 0]);
    quad(P3(s, HW - 2, z0 - dep), P3(e, HW - 2, z1 - dep), P3(e, HW, z1 - dep), P3(s, HW, z0 - dep), concD, [0, -1, 0]);
    limb(S, P3(s, 0, z0 + 0.5), P3(e, 0, z1 + 0.5), 0.35, 0.35, 4, conc, PL, false);   // central barrier
  }
  // piers: twin columns with a cap, every 78 m on the viaducts and twice in each side span
  const piers = [];
  for (let s = s1 - 78; s > 20; s -= 78) if (s < s1 - 60) piers.push(s);
  for (let s = s2 + 78; s < L - 10; s += 78) piers.push(s);
  for (const s of piers) {
    const a = at(s), g = ground(a.x, a.y), zt = deckZ(s) - 3.2;
    if (zt - g < 3) continue;
    for (const v of [-8, 8]) { const c = P3(s, v, 0); box(S, c[0], -c[2], a.ux, a.uy, 1.4, 2.2, g - 3, zt, conc, I0, PL); }
    const c = P3(s, 0, 0); box(S, c[0], -c[2], a.ux, a.uy, 1.6, 11.5, zt - 2, zt, conc, I0, PL);
  }
  // pylons: two legs outside the deck, rising to 148 m, crossbeams under the deck and at the head
  const TOP = 148;
  for (const sp of [s1, s2]) {
    const a = at(sp), g = Math.min(0, ground(a.x, a.y)), zd = deckZ(sp);
    for (const v of [-(HW + 3.5), HW + 3.5]) { const c = P3(sp, v, 0);
      limb(S, [c[0], g - 3, c[2]], [c[0], zd - 4, c[2]], 3.4, 3.0, 4, conc, PL, true);
      limb(S, [c[0], zd - 4, c[2]], [c[0], TOP, c[2]], 3.0, 2.0, 4, conc, PL, true); }
    for (const z of [zd - 6, TOP - 12]) { const c = P3(sp, 0, 0); box(S, c[0], -c[2], a.ux, a.uy, 2.2, HW + 3.5, z - (z < 60 ? 3 : 2.5), z, conc, I0, PL); }
    // stays: two planes of semi-harp cables, 12 each way from each leg
    for (const v of [-(HW + 3.5), HW + 3.5]) for (const dir of [-1, 1]) for (let k = 0; k < 12; k++) {
      const sd = sp + dir * (24 + k * 15.5), zp = 92 + k * 4.4, vd = v > 0 ? HW - 0.6 : -HW + 0.6;
      limb(S, P3(sp, v * 0.92, zp), P3(sd, vd, deckZ(sd) + 0.6), 0.16, 0.16, 3, cable, PL, false);
    }
  }
}

// A tower top cut on a slope (Torre de Monsanto): the façade runs on up to a plane rising `rise` metres toward `up`
// (unit vector in plan), and that plane is glazed over. Walls are dark glass, the cut edge a bright metal rim.
export function slopedCrown(S, { ring, z0, rise, up, col, rim = '#c9d0d4', lin, srgb }) {
  const PL = [KIND.PLAIN / 8, 3 / 8, 0.2, 1], I0 = [0, 0, 0, 0], c = lin(srgb(col)), cr = lin(srgb(rim));
  const pr = ring.map((q) => q[0] * up[0] + q[1] * up[1]), lo = Math.min(...pr), hi = Math.max(...pr);
  const zt = (i) => z0 + rise * (pr[i] - lo) / (hi - lo || 1);
  const ccw = polyArea(ring) > 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length, p = ring[i], q = ring[j];
    let n = [q[1] - p[1], 0, q[0] - p[0]]; if (!ccw) n = n.map((x) => -x);
    const l = Math.hypot(n[0], n[2]) || 1; n = [n[0] / l, 0, n[2] / l];
    const a = [p[0], z0 - 0.2, -p[1]], b = [q[0], z0 - 0.2, -q[1]], cc = [q[0], zt(j), -q[1]], d = [p[0], zt(i), -p[1]];
    tri(S, a, b, cc, n, c, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, a, cc, d, n, c, [0, 0], [0, 0], [0, 0], I0, PL);
    const e = [q[0], zt(j) + 0.9, -q[1]], f = [p[0], zt(i) + 0.9, -p[1]];   // rim fin standing proud of the glazed cut
    tri(S, d, cc, e, n, cr, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, d, e, f, n, cr, [0, 0], [0, 0], [0, 0], I0, PL);
  }
  const flat = ring.flat(), idx = earcut(flat);
  const nz = [-up[0] * rise, hi - lo, up[1] * rise]; const nl = Math.hypot(...nz); const N = nz.map((x) => x / nl);
  for (let k = 0; k < idx.length; k += 3) {
    const [A, B, C] = [idx[k], idx[k + 1], idx[k + 2]].map((i) => [ring[i][0], zt(i), -ring[i][1]]);
    tri(S, A, B, C, N, c.map((x) => x * 0.8), [0, 0], [0, 0], [0, 0], I0, PL); tri(S, A, C, B, N, c.map((x) => x * 0.8), [0, 0], [0, 0], [0, 0], I0, PL);
  }
}

// Torre da Galp (the old Sacor refinery flare tower, kept in Parque Tejo): a square steel lattice, four legs braced in
// X panels between ring girders, a gallery near the top and the flare stack rising out of it.
export function flareTower(S, { c, ground, H = 90, half = 5.4, top = 2.2, col = '#d8d9d6', stack = '#b8402f', lin, srgb }) {
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.6, 1], st = lin(srgb(col)), sk = lin(srgb(stack));
  const zTop = ground + H - 8, lvls = 9;
  const leg = (sx, sy, z) => { const t = (z - ground) / (zTop - ground), h = half + (top - half) * t; return [c[0] + sx * h, z, -(c[1] + sy * h)]; };
  const S4 = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (const [sx, sy] of S4) limb(S, leg(sx, sy, ground), leg(sx, sy, zTop), 0.38, 0.26, 6, st, PL);
  for (let k = 0; k < lvls; k++) {
    const z0 = ground + (zTop - ground) * k / lvls, z1 = ground + (zTop - ground) * (k + 1) / lvls;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = S4[i], [bx, by] = S4[(i + 1) % 4];
      limb(S, leg(ax, ay, z1), leg(bx, by, z1), 0.16, 0.16, 4, st, PL, false);
      limb(S, leg(ax, ay, z0), leg(bx, by, z1), 0.11, 0.11, 4, st, PL, false);
      limb(S, leg(bx, by, z0), leg(ax, ay, z1), 0.11, 0.11, 4, st, PL, false);
    }
  }
  box(S, c[0], c[1], 1, 0, top + 1.4, top + 1.4, zTop - 0.3, zTop + 0.2, st, [0, 0, 0, 0], PL);   // gallery deck
  limb(S, [c[0], ground, -c[1]], [c[0], ground + H, -c[1]], 0.75, 0.6, 10, sk, PL);   // the stack
  limb(S, [c[0], ground + H, -c[1]], [c[0], ground + H + 1.2, -c[1]], 0.95, 0.95, 10, lin(srgb('#3a3a38')), PL);
}

// Factory and warehouse halls under a big flat outline: the north-light sawtooth (shed) roof of Lisbon's old industrial
// belts (Amadora, Marvila, Alcântara). Teeth run along the hall's long axis every 12 m, the steep glazed face to the north.
export function sawtoothRoof(S, { outer, holes = [], z0, metal = '#a7aaab', glass = '#3e4b56', lin, srgb, pitch = 12, w = 7, rise = 2.4, sym = false }) {   // sym: a row of plain twin-sloped spans (the old Marvila / Xabregas naves), no glazing
  const o = obb(outer); if (!o) return 0;
  const PL = [KIND.PLAIN / 8, 5 / 8, 0.3, 1], I0 = [0, 0, 0, 0], cm = lin(srgb(metal)), cg = lin(srgb(glass));
  // steep face toward whichever cross axis points more to the north
  const sg = o.vy >= 0 ? 1 : -1, vx = o.vx * sg, vy = o.vy * sg;
  const inside = (x, y) => pip(x, y, outer) && !holes.some((h) => pip(x, y, h));
  const ok = (x, y) => inside(x, y) && inside(x + vx * w, y + vy * w) && inside(x + o.ux * 1.5, y + o.uy * 1.5) && inside(x - o.ux * 1.5, y - o.uy * 1.5) &&
    inside(x - vx * 1.5, y - vy * 1.5) && inside(x + vx * (w + 1.5), y + vy * (w + 1.5));
  const W = (x, y, z) => [x, z, -y];
  let n = 0;
  for (let t = -o.hw + 2; t + w < o.hw - 1; t += pitch) {
    let run = null;
    const flush = (u1) => {
      if (!run || u1 - run < 4) { run = null; return; }
      const p0 = [o.cx + o.ux * run + vx * t, o.cy + o.uy * run + vy * t], p1 = [o.cx + o.ux * u1 + vx * t, o.cy + o.uy * u1 + vy * t];
      const q0 = [p0[0] + vx * w, p0[1] + vy * w], q1 = [p1[0] + vx * w, p1[1] + vy * w];
      if (sym) {   // two slopes up to a ridge down the middle of the span, gable triangles at the ends
        const m0 = [p0[0] + vx * w / 2, p0[1] + vy * w / 2], m1 = [p1[0] + vx * w / 2, p1[1] + vy * w / 2], h2 = w / 2;
        const NA = (() => { const v = [-vx * rise, h2, vy * rise], l = Math.hypot(...v); return v.map((c) => c / l); })(), NB = (() => { const v = [vx * rise, h2, -vy * rise], l = Math.hypot(...v); return v.map((c) => c / l); })();
        tri(S, W(...p0, z0), W(...p1, z0), W(...m1, z0 + rise), NA, cm, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, W(...p0, z0), W(...m1, z0 + rise), W(...m0, z0 + rise), NA, cm, [0, 0], [0, 0], [0, 0], I0, PL);
        tri(S, W(...m0, z0 + rise), W(...m1, z0 + rise), W(...q1, z0), NB, cm, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, W(...m0, z0 + rise), W(...q1, z0), W(...q0, z0), NB, cm, [0, 0], [0, 0], [0, 0], I0, PL);
        const cw = cm.map((c) => c * 0.85);
        tri(S, W(...p0, z0), W(...m0, z0 + rise), W(...q0, z0), [-o.ux, 0, o.uy], cw, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, W(...p1, z0), W(...q1, z0), W(...m1, z0 + rise), [o.ux, 0, -o.uy], cw, [0, 0], [0, 0], [0, 0], I0, PL);
        n++; run = null; return;
      }
      // sloping metal face from the low edge (p) up to the ridge over q, vertical glazing at q facing north
      const nm = [-vx * rise, w, vy * rise], l = Math.hypot(...nm); const N = nm.map((c) => c / l);
      tri(S, W(...p0, z0), W(...p1, z0), W(...q1, z0 + rise), N, cm, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, W(...p0, z0), W(...q1, z0 + rise), W(...q0, z0 + rise), N, cm, [0, 0], [0, 0], [0, 0], I0, PL);
      const NG = [vx, 0, -vy];
      tri(S, W(...q0, z0), W(...q1, z0), W(...q1, z0 + rise), NG, cg, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, W(...q0, z0), W(...q1, z0 + rise), W(...q0, z0 + rise), NG, cg, [0, 0], [0, 0], [0, 0], I0, PL);
      for (const [a, b] of [[p0, q0], [p1, q1]]) { const NE = a === p0 ? [-o.ux, 0, o.uy] : [o.ux, 0, -o.uy]; tri(S, W(...a, z0), W(...b, z0), W(...b, z0 + rise), NE, cm, [0, 0], [0, 0], [0, 0], I0, PL); }
      n++; run = null;
    };
    for (let u = -o.hl; u <= o.hl; u += 2) {
      const x = o.cx + o.ux * u + vx * t, y = o.cy + o.uy * u + vy * t;
      if (ok(x, y)) { if (run === null) run = u; } else flush(u - 2);
    }
    flush(o.hl);
  }
  return n;
}

// A smooth masonry or tiled dome: a spherical cap from the rim (z0) up by rise, with a short finial.
export function plainDome(S, { cx, cy, r, z0, rise, col, lin, srgb, seg = 24, finial = '#c8b98f' }) {
  const c = Array.isArray(col) ? col : lin(srgb(col)), PL = [KIND.PLAIN / 8, 5 / 8, 0.55, 1], I0 = [0, 0, 0, 0];
  const R = (r * r + rise * rise) / (2 * rise), zc = z0 + rise - R, rings = 7, phi0 = Math.asin(Math.min(1, r / R));
  const V = (i, k) => { const ph = phi0 * (1 - k / rings), th = (i / seg) * 2 * Math.PI, rr = R * Math.sin(ph); return [cx + rr * Math.cos(th), zc + R * Math.cos(ph), -(cy + rr * Math.sin(th))]; };
  const N = (p) => { const v = [p[0] - cx, p[1] - zc, p[2] + cy], l = Math.hypot(...v); return v.map((q) => q / l); };
  for (let i = 0; i < seg; i++) for (let k = 0; k < rings; k++) {
    const p00 = V(i, k), p10 = V(i + 1, k), p01 = V(i, k + 1), p11 = V(i + 1, k + 1);
    tri(S, p00, p10, p11, N(p00), c, [0, 0], [1, 0], [1, 1], I0, PL);
    if (k < rings - 1) tri(S, p00, p11, p01, N(p00), c, [0, 0], [1, 1], [0, 1], I0, PL);
  }
  const f = lin(srgb(finial));
  limb(S, [cx, z0 + rise - 0.1, -cy], [cx, z0 + rise + Math.max(1, r * 0.25), -cy], 0.12 + r * 0.02, 0.08, 6, f, PL, true);
}
// Minaret top: a gallery ring on brackets, then a slender cone.
export function minaretTop(S, { cx, cy, r, z0, rise, col, lin, srgb }) {
  const c = lin(srgb(col)), PL = [KIND.PLAIN / 8, 5 / 8, 0.55, 1];
  limb(S, [cx, z0 - 4.2, -cy], [cx, z0 - 3.6, -cy], r + 0.9, r + 0.9, 12, c, PL, true);   // gallery floor
  limb(S, [cx, z0 - 3.6, -cy], [cx, z0 - 2.6, -cy], r + 0.85, r + 0.85, 12, c, PL, false);   // its parapet
  limb(S, [cx, z0, -cy], [cx, z0 + 0.5, -cy], r + 0.3, r + 0.3, 12, c, PL, true);
  limb(S, [cx, z0 + 0.5, -cy], [cx, z0 + rise, -cy], r + 0.1, 0.08, 12, c, PL, true);
  limb(S, [cx, z0 + rise, -cy], [cx, z0 + rise + 1.2, -cy], 0.07, 0.05, 4, lin(srgb('#c8b98f')), PL, true);
}

// A glazed half-round vault swept along a plan polyline (Colombo's long skylit malls), half-width hw, rise, on a roof at z0,
// with a metal rib every third section.
export function vaultAlong(S, { path, hw, rise, z0, col = '#8fa9ad', rib = '#d8dcdc', lin, srgb }) {
  const g = lin(srgb(col)), g2 = g.map((v) => v * 0.86), m = lin(srgb(rib)), PL = [KIND.PLAIN / 8, 5 / 8, 0.25, 1], I0 = [0, 0, 0, 0], nV = 6;
  const nrm = path.map((p, i) => { const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; });
  const P = (i, j) => { const v = -1 + (2 * j) / nV, [x, y] = path[i], [nx, ny] = nrm[i]; return [x + nx * hw * v, z0 + rise * Math.sqrt(Math.max(0, 1 - v * v)), -(y + ny * hw * v)]; };
  for (let i = 0; i + 1 < path.length; i++) for (let j = 0; j < nV; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    let n = norm(a, b, c); if (n[1] < 0) n = n.map((q) => -q);
    const col = (i + j) % 2 ? g : g2;
    tri(S, a, b, c, n, col, [0, 0], [0, 0], [0, 0], I0, PL); tri(S, a, c, d, n, col, [0, 0], [0, 0], [0, 0], I0, PL);
  }
  for (let i = 0; i < path.length; i += 3) for (let j = 0; j < nV; j++) limb(S, P(i, j), P(i, j + 1), 0.13, 0.13, 4, m, PL, false);
  for (const i of [0, path.length - 1]) { const pts = Array.from({ length: nV + 1 }, (_, j) => P(i, j)), cc = [path[i][0], z0, -path[i][1]];   // glazed end walls
    for (let j = 0; j < nV; j++) { let n = norm(cc, pts[j], pts[j + 1]); tri(S, cc, pts[j], pts[j + 1], n, g2, [0, 0], [0, 0], [0, 0], I0, PL); } }
}
