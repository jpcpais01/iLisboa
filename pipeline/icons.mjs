// iLisboa app icon: a floating isometric slice of the city — hill and castle at the back,
// terracotta roofs stepping down to the Tagus, the river cut open on the slab's face.
// `node pipeline/icons.mjs` → public/icons/* (PNG set, maskable, apple-touch, iOS splash screens, SVG favicon)
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// ─── isometric scene ───
const C = Math.cos(Math.PI / 6), S = 0.5;
const P = (x, y, z) => [(x - y) * C, (x + y) * S - z];
const poly = (pts, fill, extra = '') => `<path d="M${pts.map((p) => P(...p).map((v) => v.toFixed(2)).join(' ')).join('L')}Z" fill="${fill}"${extra}/>`;

const shapes = [];           // [depth, svg]
const add = (d, s) => shapes.push([d, s]);
// a box with optional hip roof; walls: [top, lit(+x face), shade(+y face)]
function box(x, y, w, d, z0, h, walls, roof) {
  const x1 = x + w, y1 = y + d, z1 = z0 + h, k = x + y1 / 1 + w / 2 - d / 2 + z0;
  let s = poly([[x1, y, z0], [x1, y1, z0], [x1, y1, z1], [x1, y, z1]], walls[1])
        + poly([[x, y1, z0], [x1, y1, z0], [x1, y1, z1], [x, y1, z1]], walls[2]);
  if (roof) {
    const r = roof.rise, along = w >= d;
    const a = along ? [[x + d / 2, y + d / 2, z1 + r], [x1 - d / 2, y + d / 2, z1 + r]] : [[x + w / 2, y + w / 2, z1 + r], [x + w / 2, y1 - w / 2, z1 + r]];
    const [A, B] = a;
    const back = along
      ? [poly([[x, y, z1], [x1, y, z1], B, A], roof.back), poly([[x, y, z1], A, [x, y1, z1]], roof.back)]
      : [poly([[x, y, z1], [x1, y, z1], A], roof.back), poly([[x, y, z1], A, B, [x, y1, z1]], roof.back)];
    const front = along
      ? [poly([[x1, y, z1], [x1, y1, z1], B], roof.lit), poly([[x, y1, z1], [x1, y1, z1], B, A], roof.shade)]
      : [poly([[x1, y, z1], [x1, y1, z1], B, A], roof.lit), poly([[x, y1, z1], [x1, y1, z1], B], roof.shade)];
    s += back.join('') + front.join('');
  } else s += poly([[x, y, z1], [x1, y, z1], [x1, y1, z1], [x, y1, z1]], walls[0]);
  add(k, s);
}
// windows on the two visible façades: a row of small dark rectangles per storey
function windows(x, y, w, d, z0, h, col, rows) {
  const x1 = x + w, y1 = y + d; let s = '';
  for (let r = 0; r < rows; r++) {
    const zb = z0 + (h * (r + 0.32)) / rows, zt = zb + (h / rows) * 0.38;
    for (let i = 0, n = Math.max(1, Math.round(d / 0.62)); i < n; i++) { const a = y + (d * (i + 0.3)) / n, b = a + (d / n) * 0.4; s += poly([[x1 + 0.001, a, zb], [x1 + 0.001, b, zb], [x1 + 0.001, b, zt], [x1 + 0.001, a, zt]], col); }
    for (let i = 0, n = Math.max(1, Math.round(w / 0.62)); i < n; i++) { const a = x + (w * (i + 0.3)) / n, b = a + (w / n) * 0.4; s += poly([[a, y1 + 0.001, zb], [b, y1 + 0.001, zb], [b, y1 + 0.001, zt], [a, y1 + 0.001, zt]], col); }
  }
  add(x + y1 + w / 2 - d / 2 + z0 + 0.0005, s);
}

const N = 10, T = 1.9;                    // slab size, thickness
const RIVER = 7.8;                        // y beyond this is the Tagus
const roofT = { back: '#e79a6d', lit: '#d9714a', shade: '#a9502f', rise: 0.55 };
const roofT2 = { back: '#eca57a', lit: '#e07f55', shade: '#b35a36', rise: 0.5 };
const W = {
  cream: ['#fbf4e6', '#f6ecd9', '#d9c9ac'],
  yellow: ['#f7d98a', '#f2c763', '#cf9f3c'],
  pink: ['#f6c9b4', '#eeb196', '#c98a70'],
  blue: ['#d4e6ee', '#bcd8e4', '#8fb0c0'],
  white: ['#ffffff', '#f7f4ee', '#d6d0c4'],
  stone: ['#e6d6b6', '#d9c49c', '#b19c74'],
};

function scene() {
  shapes.length = 0;
  // slab: land top, river top, earth faces, the river's glass cross-section on the +y face
  add(-100, poly([[0, 0, 0], [N, 0, 0], [N, RIVER, 0], [0, RIVER, 0]], '#efe3c8'));
  add(-99, poly([[0, RIVER, -0.35], [N, RIVER, -0.35], [N, N, -0.35], [0, N, -0.35]], 'url(#river)'));
  add(-98, poly([[0, RIVER, 0], [N, RIVER, 0], [N, RIVER, -0.35], [0, RIVER, -0.35]], '#cbb48a'));            // quay wall
  add(-97, poly([[N, 0, 0], [N, RIVER, 0], [N, RIVER, -T], [N, 0, -T]], 'url(#earthR)'));
  add(-97, poly([[N, RIVER, -0.35], [N, N, -0.35], [N, N, -T], [N, RIVER, -T]], 'url(#waterR)'));
  add(-97, poly([[0, N, -0.35], [N, N, -0.35], [N, N, -T], [0, N, -T]], 'url(#waterL)'));
  add(-96, poly([[N, 0, 0], [N, RIVER, 0], [N, RIVER, -0.16], [N, 0, -0.16]], '#9cc07a'));                   // grass lip
  // street on the riverfront and a yellow tram
  add(-95, poly([[0, 6.85, 0.002], [N, 6.85, 0.002], [N, 7.6, 0.002], [0, 7.6, 0.002]], '#dccfb3'));
  box(5.6, 6.98, 1.6, 0.5, 0, 0.64, ['#fff3c4', '#f6c636', '#d49a14'], null);
  add(5.6 + 7.48 + 0.8 - 0.25 + 0.01, poly([[7.2, 7.481, 0.36], [7.2, 7.481, 0.5], [5.6, 7.481, 0.5], [5.6, 7.481, 0.36]], '#8a6a2a') + poly([[7.201, 7.05, 0.34], [7.201, 7.41, 0.34], [7.201, 7.41, 0.52], [7.201, 7.05, 0.52]], '#7a5c22'));
  // the hill with the castle: walls with merlons, corner towers, the keep and its flag
  box(0, 0, 4.6, 4.4, 0, 1.0, ['#a8c98a', '#d8c59e', '#bfa97f'], null);
  const z = 1.0, wh = 1.05, t = 0.28, x0 = 0.45, y0 = 0.45, L = 3.6;
  box(x0, y0, L, L, z, 0.05, ['#d7c7a3', '#d7c7a3', '#d7c7a3'], null);
  box(x0, y0, L, t, z, wh, W.stone, null); box(x0, y0, t, L, z, wh, W.stone, null);
  box(x0, y0 + L - t, L, t, z, wh, W.stone, null); box(x0 + L - t, y0, t, L, z, wh, W.stone, null);
  for (let i = 0; i < 5; i++) { const o = 0.55 + i * 0.62; box(x0 + o, y0 + L - t, 0.3, t, z + wh, 0.22, W.stone, null); box(x0 + L - t, y0 + o, t, 0.3, z + wh, 0.22, W.stone, null); }
  for (const [cx, cy] of [[0, 0], [L, 0], [0, L], [L, L]]) box(x0 + cx - 0.36, y0 + cy - 0.36, 0.72, 0.72, z, wh + 0.5, W.stone, null);
  box(1.55, 1.55, 1.4, 1.4, z, 2.6, W.stone, null);
  for (let i = 0; i < 3; i++) { box(1.55 + i * 0.55, 2.77, 0.3, 0.18, z + 2.6, 0.24, W.stone, null); box(2.77, 1.55 + i * 0.55, 0.18, 0.3, z + 2.6, 0.24, W.stone, null); }
  add(99, `${poly([[2.25, 2.25, z + 2.6], [2.25, 2.25, z + 3.75]], 'none', ' stroke="#6b4f33" stroke-width="0.07"')}${poly([[2.25, 2.25, z + 3.75], [2.25, 3.05, z + 3.52], [2.25, 2.25, z + 3.3]], '#2f8a4e')}${poly([[2.25, 2.25, z + 3.75], [2.25, 2.55, z + 3.66], [2.25, 2.55, z + 3.39], [2.25, 2.25, z + 3.3]], '#e0322b')}`);
  // houses stepping down to the river
  const H = [
    [5.0, 0.4, 2.0, 1.4, 0, 2.3, W.yellow, roofT, 3],
    [7.4, 0.4, 2.3, 1.4, 0, 1.9, W.pink, roofT2, 2],
    [5.0, 2.5, 1.5, 1.6, 0, 1.6, W.white, roofT2, 2],
    [6.9, 2.5, 2.8, 1.6, 0, 2.6, W.cream, roofT, 3],
    [0.3, 4.95, 1.7, 1.4, 0, 1.5, W.blue, roofT, 2],
    [2.4, 4.95, 1.9, 1.4, 0, 2.0, W.yellow, roofT2, 2],
    [4.7, 4.95, 1.6, 1.4, 0, 1.4, W.pink, roofT, 2],
    [6.8, 4.95, 2.9, 1.4, 0, 2.0, W.white, roofT2, 2],
  ];
  for (const [x, y, w, d, z0, h, wc, r, rows] of H) { box(x, y, w, d, z0, h, wc, r); windows(x, y, w, d, z0, h, 'rgba(60,70,90,0.55)', rows); }
  // trees
  for (const [tx, ty, tr] of [[4.75, 4.45, 0.4], [6.55, 2.2, 0.34], [9.55, 6.55, 0.38], [0.6, 6.6, 0.34]]) {
    const [sx, sy] = P(tx, ty, tr * 1.1);
    add(tx + ty + 0.3, `<circle cx="${sx.toFixed(2)}" cy="${sy.toFixed(2)}" r="${(tr * 1.05).toFixed(2)}" fill="#5d9b4f"/><circle cx="${(sx + tr * 0.25).toFixed(2)}" cy="${(sy - tr * 0.3).toFixed(2)}" r="${(tr * 0.55).toFixed(2)}" fill="#7db866"/>`);
  }
  return shapes.sort((a, b) => a[0] - b[0]).map((s) => s[1]).join('');
}

const DEFS = `
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa6dd"/><stop offset="0.62" stop-color="#a9d3ee"/><stop offset="1" stop-color="#e6f2f6"/></linearGradient>
  <radialGradient id="sun" cx="0.78" cy="0.2" r="0.5"><stop offset="0" stop-color="#fff6dc" stop-opacity="0.9"/><stop offset="1" stop-color="#fff6dc" stop-opacity="0"/></radialGradient>
  <linearGradient id="river" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f9fd0"/><stop offset="1" stop-color="#2b78b4"/></linearGradient>
  <linearGradient id="waterR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f8fc4"/><stop offset="1" stop-color="#1d4f86"/></linearGradient>
  <linearGradient id="waterL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f78ae"/><stop offset="1" stop-color="#163d6d"/></linearGradient>
  <linearGradient id="earthR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c99a63"/><stop offset="0.5" stop-color="#b07a48"/><stop offset="1" stop-color="#8a5a34"/></linearGradient>
  <filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="0.9"/></filter>`;

// the scene's extent in iso units, measured once
const VB = (() => { const xs = [P(0, N, 0)[0], P(N, 0, 0)[0]], ys = [P(0, 0, 4.75)[1], P(N, N, -T)[1] + 1.4]; return { x: xs[0], y: ys[0], w: xs[1] - xs[0], h: ys[1] - ys[0] }; })();

// icon: `scale` = width of the island as a fraction of the canvas
function iconSVG(px, { scale = 0.86, bg = true, round = 0 } = {}) {
  const s = (px * scale) / VB.w, ox = px / 2 - (VB.x + VB.w / 2) * s, oy = px / 2 - (VB.y + VB.h / 2) * s + px * 0.01;
  const shadowY = (P(N, N, -T)[1] + 0.95) * s + oy, shadowX = P(N / 2, N / 2, 0)[0] * s + ox;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}"><defs>${DEFS}</defs>`
    + (bg ? `<rect width="${px}" height="${px}" rx="${round * px}" fill="url(#sky)"/><rect width="${px}" height="${px}" rx="${round * px}" fill="url(#sun)"/>` : '')
    + `<ellipse cx="${shadowX}" cy="${shadowY}" rx="${VB.w * s * 0.36}" ry="${VB.w * s * 0.045}" fill="#1d3a5a" opacity="${bg ? 0.22 : 0.18}" filter="url(#sh)" transform="translate(0 0)"/>`
    + `<g transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${s.toFixed(4)})" stroke-linejoin="round">${scene()}</g></svg>`;
}
// splash: sky gradient, island, wordmark (iOS needs one bitmap per screen size)
function splashSVG(w, h) {
  const px = Math.min(w, h) * 0.5, s = (px * 0.9) / VB.w, ox = w / 2 - (VB.x + VB.w / 2) * s, oy = h * 0.44 - (VB.y + VB.h / 2) * s;
  const fs = Math.min(w, h) * 0.085, ty = h * 0.44 + (VB.h * s) / 2 + fs * 1.9;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${DEFS}
    <linearGradient id="bgS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7f1e6"/><stop offset="0.6" stop-color="#ece3d3"/><stop offset="1" stop-color="#ddd0bb"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#bgS)"/>
    <g transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${s.toFixed(4)})" stroke-linejoin="round">${scene()}</g>
    <text x="${w / 2}" y="${ty}" text-anchor="middle" font-family="Inter Display, Inter, sans-serif" font-weight="700" font-size="${fs}" letter-spacing="${-fs * 0.02}" fill="#2d2a26"><tspan fill="#b45a3a">i</tspan>Lisboa</text></svg>`;
}

const png = (svg, file) => sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: false }).toFile(new URL(file, OUT).pathname);
await Promise.all([
  png(iconSVG(512), 'icon-512.png'),
  png(iconSVG(192), 'icon-192.png'),
  png(iconSVG(96), 'icon-96.png'),
  png(iconSVG(512, { scale: 0.62 }), 'maskable-512.png'),     // fits the 80 % safe circle
  png(iconSVG(192, { scale: 0.62 }), 'maskable-192.png'),
  png(iconSVG(180, { scale: 0.82 }), 'apple-touch-icon.png'),
  png(iconSVG(64, { scale: 0.9, round: 0.22 }), 'favicon-64.png'),
  png(iconSVG(32, { scale: 0.94, round: 0.22 }), 'favicon-32.png'),
]);
writeFileSync(new URL('favicon.svg', OUT), iconSVG(64, { scale: 0.9, round: 0.22 }));
writeFileSync(new URL('island.svg', OUT), iconSVG(240, { bg: false, scale: 0.96 }));   // loading screen

// iOS startup images: [css w, css h, dpr] for current iPhones and iPads (portrait)
export const SPLASH = [
  [440, 956, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3], [375, 812, 3],
  [414, 896, 3], [414, 896, 2], [375, 667, 2], [320, 568, 2], [1032, 1376, 2], [1024, 1366, 2], [834, 1194, 2], [820, 1180, 2], [810, 1080, 2], [744, 1133, 2],
];
await Promise.all(SPLASH.map(([w, h, r]) => sharp(Buffer.from(splashSVG(w * r, h * r))).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(new URL(`splash-${w}x${h}@${r}x.png`, OUT).pathname)));
if (process.argv.includes('--links')) for (const [w, h, r] of SPLASH) console.log(`    <link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)" href="/icons/splash-${w}x${h}@${r}x.png" />`);
