import * as THREE from 'three';

export const cityUniforms = { uNight: { value: 0 } };

// Buildings: one material for walls, roofs, trims and monuments. Everything a façade shows
// (bays, frames, shutters, balconies, shopfronts, azulejos, roof tiles, dormers, ashlar) is
// drawn procedurally from per-vertex metadata baked by the pipeline — zero textures.
//   surf  = façade: (bay coordinate, metres above ground) · roof: (metres along eave, metres up-slope)
//   aInfo = (wallTop, floorH, bays, groundFloorH) normalised · aStyle = (kind, variant, seed, bayW) normalised
const BUILDING_GLSL = /* glsl */ `
varying vec2 vSurf; varying vec4 vInfo; varying vec4 vStyle; varying vec3 vWP;
uniform float uNight;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float box1(float a, float b, float x, float aa) { return smoothstep(a - aa, a + aa, x) - smoothstep(b - aa, b + aa, x); }
float rect(vec2 lo, vec2 hi, vec2 p, float aa) { return box1(lo.x, hi.x, p.x, aa) * box1(lo.y, hi.y, p.y, aa); }
`;

export function buildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = cityUniforms.uNight;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 surf; attribute vec4 aInfo; attribute vec4 aStyle;\nvarying vec2 vSurf; varying vec4 vInfo; varying vec4 vStyle; varying vec3 vWP;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vSurf = (surf - .5) * 512.; vInfo = aInfo * vec4(128., 8., 128., 8.); vStyle = aStyle * vec4(8., 8., 1., 6.);
vWP = (modelMatrix * vec4(transformed, 1.)).xyz;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + BUILDING_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
float kind = floor(vStyle.x + .5), variant = floor(vStyle.y + .5), bw = max(vStyle.w, .5);
float seed = floor(vStyle.z * 4096. + .5) / 4096.;   // snap: perspective interpolation wobbles a constant in the last bits, and the hashes amplify that into speckle up close
vec3 base = diffuseColor.rgb;
vec3 col = base;
float rough = .9, glassAmt = 0., glow = 0., flood = 0.;
float grime = vnoise(vWP.xz * .35 + vWP.y * .2) * .5 + vnoise(vWP.xz * 1.7 + vWP.y) * .5;
vec3 stoneC = vec3(.80, .76, .68);
vec3 frameC = mix(vec3(.93, .92, .88), stoneC, step(.5, fract(seed * 7.3)));

if (kind < .5) {                                  // plain trims, chimneys
  col = base * (.94 + .08 * grime);
} else if (kind < 2.5) {                          // façades (1) and blank walls (2)
  float top = vInfo.x, fh = max(vInfo.y, 2.4), bays = floor(vInfo.z + .5), gh = max(vInfo.w, 2.6);
  float y = vSurf.y;
  col = base * (.9 + .1 * smoothstep(0., 5., y)) * (.95 + .07 * grime);
  // rain streaks
  col *= 1. - .05 * smoothstep(.55, 1., vnoise(vec2(vSurf.x * (kind > 1.5 ? 2.3 : 9.), y * .08))) * (1. - smoothstep(0., top, y) * .5);
  if (kind < 1.5 && bays > .5 && y < top - .15) {
    float bx = vSurf.x, bi = floor(bx), fu = fract(bx);
    float ux = (fu - .5) * bw;                               // metres from bay centre
    float pxm = max(fwidth(bx) * bw, fwidth(y)) + 1e-4;
    float aa = pxm * .7;
    float far = smoothstep(.38, 1.05, pxm);   // windows hold until a bay is ~1 px wide
    float isG = step(y, gh);
    float fi = isG > .5 ? 0. : 1. + floor((y - gh) / fh);
    float fy = isG > .5 ? y : mod(y - gh, fh);
    float flH = isG > .5 ? gh : fh;
    float rB = h21(vec2(bi, seed * 91.7)), rW = h21(vec2(bi, fi) + seed * 37.1);
    vec3 wallC = col;
    // azulejo cladding: 14 cm tiles with a four-fold motif
    if (variant > 1.5 && variant < 2.5 && y > (isG > .5 ? .9 : 0.)) {
      vec2 tp = vec2(bx * bw, y) / .14; vec2 tf = fract(tp) - .5; float tile = h21(floor(tp / 2.) + seed);
      float motif = smoothstep(.36, .3, length(abs(tf) - .22)) + smoothstep(.12, .06, abs(abs(tf.x) - abs(tf.y)));
      vec3 glaze = mix(vec3(.93, .93, .9), seed > .5 ? vec3(.16, .3, .62) : vec3(.2, .48, .4), clamp(motif, 0., 1.) * .85);
      glaze *= .93 + .07 * tile;
      wallC = mix(glaze, mix(base, glaze, .5), far);
      rough = .35;
    }
    // Casa dos Bicos: diamond-point ashlar, every stone a little pyramid catching the light
    if (variant > 6.5 && y > .5) {
      vec2 dp = vec2(bx * bw / .62, y / .4); dp.x += mod(floor(dp.y), 2.) * .5;
      vec2 f = fract(dp) - .5; float side = step(abs(f.y), abs(f.x));
      float shade = mix(f.y > 0. ? .13 : -.16, f.x > 0. ? -.05 : .06, side) * (1. - far);
      float joint = 1. - .12 * (1. - far) * (1. - box1(-.46, .46, f.x, aa * 2.) * box1(-.45, .45, f.y, aa * 2.));
      wallC = base * (1. + shade) * joint * (.96 + .05 * grime);
      rough = .8;
    }
    col = wallC;
    // stone plinth, string course, cornice band, corner pilasters (Pombaline / palatial)
    float formal = step(variant, .5) + step(3.5, variant);
    float dEnd = min(bx, bays - bx) * bw;
    col = mix(col, stoneC * (.95 + .05 * grime), formal * (box1(-9., .85, y, aa) + box1(gh - .22, gh, y, aa) + box1(top - .45, top, y, aa) * .8 + step(dEnd, .42) * step(.9, y)));
    col = mix(col, base * .78, box1(top - .6, top - .45, y, aa) * formal);     // cornice shadow line
    // window geometry per variant
    float ww, y0, y1; float door = 0., shop = 0., balc = 0., shutters = 0.;
    float jit = variant > .5 && variant < 2.5 ? (rB - .5) * .25 * bw : 0.;
    if (variant > 2.5 && variant < 3.5) {                       // modern: ribbons / curtain wall
      ww = bw * .86; y0 = isG > .5 ? .1 : flH * .22; y1 = flH * .9; shop = isG;
    } else if (variant > 3.5) {                                 // palatial
      ww = min(1.45, bw * .45); y0 = isG > .5 ? .45 : (fi < 1.5 ? .08 : flH * .26); y1 = flH * (isG > .5 ? .72 : .84);
      balc = step(.5, fi) * step(fi, 1.5);
    } else if (variant < .5) {                                  // Pombaline
      ww = min(1.2, bw * .44); y0 = fi < 1.5 || rW < .25 ? .06 : flH * .28; y1 = flH * .86;
      balc = step(fi, 3.5) * step(.5, fi) * step(y0, .1);
      shop = isG;
    } else {                                                    // vernacular
      ww = clamp(bw * (.34 + .12 * rB), .75, 1.25); y0 = rW < .3 ? .06 : flH * .3; y1 = flH * (.78 + .06 * rB);
      balc = step(y0, .1) * step(.5, fi);
      shutters = step(rW, .3);
      door = isG * step(rB, .4);
      if (rB > .9 && isG < .5) ww = 0.;                          // blind bay
    }
    if (isG > .5 && shop < .5) {                                // doors / small ground-floor windows
      if (door > .5 || variant > 3.5) { ww = min(1.3, bw * .5); y0 = 0.; y1 = min(2.5, flH * .86); }
      else { ww = min(.8, bw * .3); y0 = 1.2; y1 = 2.1; }
    }
    if (shop > .5) { ww = bw * (variant > 2.5 ? .9 : .62); y0 = .12; y1 = flH * .7; }
    vec2 p = vec2(ux - jit, fy);
    float inWin = rect(vec2(-ww * .5, y0), vec2(ww * .5, y1), p, aa) * step(.01, ww);
    float fr = (variant > 2.5 && variant < 3.5) ? .04 : .13;
    float inGlass = rect(vec2(-ww * .5 + fr, y0 + fr), vec2(ww * .5 - fr, y1 - fr), p, aa);
    // the opening is a real recess: the glass stands ~22 cm back, so seen at an angle the ray meets a jamb, the head or the
    // sill before it reaches the glass (parallax from the view direction on the wall's own frame)
    vec3 dPx = dFdx(vWP), dPy = dFdy(vWP);
    vec3 Nw = normalize(cross(dPx, dPy)); vec3 Vw = normalize(cameraPosition - vWP); if (dot(Nw, Vw) < 0.) Nw = -Nw;
    float dux = dFdx(ux), duy = dFdy(ux);
    vec3 Tu = abs(dux) > abs(duy) ? (dPx - vec3(0., dFdx(y), 0.)) / dux : (dPy - vec3(0., dFdy(y), 0.)) / duy;
    Tu = normalize(Tu - Nw * dot(Tu, Nw) + 1e-5);
    float vn = max(dot(Vw, Nw), .12), depth = (variant > 2.5 && variant < 3.5 ? .12 : .24) * (1. - far);
    vec2 pg = p - vec2(dot(Vw, Tu), Vw.y) / vn * depth;           // where the ray meets the glass plane
    float gx = ww * .5 - fr, inBack = rect(vec2(-gx, y0 + fr), vec2(gx, y1 - fr), pg, aa);
    // reveal: jambs take the side light, the head is in shadow, the sill catches the sky
    float sideL = step(pg.x, -gx), sideR = step(gx, pg.x), head = step(y1 - fr, pg.y);
    vec3 revealC = frameC * mix(mix(.86, .72, sideR) , .5, head) * mix(1., 1.08, step(pg.y, y0 + fr) * (1. - head));
    vec2 pf = p; float fyf = fy; fy = pg.y; p = pg;   // glass, bars and shutters are seen through the recess
    // glass: depth shading at top of the reveal, sash bars, sky reflection
    float rev = smoothstep(y1 - fr - .28, y1 - fr, fy) * .55 + smoothstep(-ww * .5 + fr + .14, -ww * .5 + fr, p.x) * .3;
    vec3 sky = mix(vec3(.30, .38, .46), vec3(.62, .70, .78), h21(vec2(bi, fi) + 3.1 + floor(vWP.y)));
    vec3 glass = mix(vec3(.07, .085, .10), sky, .28 + .3 * rW) * (1. - rev);
    float bars = (variant > 2.5 && variant < 3.5) ? box1(-.025, .025, fract(bx * 2.) - .5, aa) : max(box1(-.03, .03, p.x, aa), box1(-.03, .03, fy - mix(y0, y1, .62), aa));
    glass = mix(glass, frameC * .9, bars * (1. - shop) * .85);
    if (shutters > .5) {                                       // closed wooden shutters (portadas)
      vec3 sc = rB < .35 ? vec3(.22, .33, .24) : rB < .6 ? vec3(.36, .24, .16) : rB < .8 ? vec3(.45, .17, .13) : vec3(.86, .85, .8);
      glass = sc * (.82 + .18 * step(.5, fract(fy * 14.))) * (1. - .4 * box1(-.02, .02, p.x, aa));
    }
    p = pf; fy = fyf;                                          // signs, railings and sills stand at the wall face
    if (shop > .5) {                                           // shop sign band above the opening
      vec3 sign = h21(vec2(bi, seed)) < .5 ? vec3(.12, .2, .16) : h21(vec2(bi, seed + 1.)) < .5 ? vec3(.35, .08, .09) : vec3(.08, .1, .2);
      col = mix(col, sign, rect(vec2(-ww * .5, y1 + .12), vec2(ww * .5, y1 + .55), p, aa) * step(.3, h21(vec2(bi, 7.) + seed)));
    }
    // railing (wrought iron) over the lower metre of balcony doors
    float rail = balc * step(fy, y0 + 1.05) * step(y0 - .02, fy);
    float railM = rail * max(box1(-.012, .012, fract(p.x / .11) - .5, aa * 3.) * step(fy, y0 + 1.0), box1(y0 + .98, y0 + 1.05, fy, aa));
    glass = mix(revealC, glass, inBack);
    vec3 winC = mix(frameC, glass, inGlass);
    winC = mix(winC, vec3(.06), railM * .9);
    // sill
    col = mix(col, frameC, rect(vec2(-ww * .5 - .1, y0 - .1), vec2(ww * .5 + .1, y0), p, aa) * step(.3, y0) * (1. - shop));
    col = mix(col, winC, inWin);
    glassAmt = inGlass * (1. - shutters);
    glow = glassAmt * step(h21(vec2(bi * 1.7, fi) + seed * 5.), .42) * (1. - shop * .3);
    if (variant > 5.5 && variant < 6.5 && isG > .5) {                           // Praça do Comércio: arcade of round arches on square piers
      float hwA = bw * .5 - .9, spring = gh - .8 - hwA;
      float sd = y < spring ? abs(ux) - hwA : length(vec2(ux, y - spring)) - hwA;
      float inA = 1. - smoothstep(-aa, aa, sd);
      vec3 back = mix(vec3(.10, .09, .085), vec3(.24, .22, .2), smoothstep(0., gh, y));
      back = mix(back, vec3(.06, .055, .05), rect(vec2(-.75, 0.), vec2(.75, 3.1), vec2(ux, y), aa));   // shop door at the back
      vec3 pier = wallC * (.97 + .03 * grime);
      pier = mix(pier, stoneC, box1(-9., .7, y, aa) + box1(spring - .35, spring, y, aa) * step(hwA - .05, abs(ux)));
      pier = mix(pier, stoneC * 1.04, (1. - smoothstep(.35 - aa, .35 + aa, abs(sd + .18))) * step(spring - .1, y));  // voussoir ring
      col = mix(pier, back, inA);
      glassAmt = 0.; glow = inA * .45 * smoothstep(1., 4., y);
    }
    // far away: blend everything to the façade's average tone (no shimmer)
    vec3 avg = mix(wallC, vec3(.16, .18, .2), .22);
    col = mix(col, avg, far);
    glassAmt *= 1. - far; glow = mix(glow, .035, far);   // lit windows averaged over the wall: a faint warm wash, not a lit wall
  }
} else if (kind < 3.5 || kind > 4.5 && kind < 5.5) {      // roof tiles (3) and mansard (5)
  vec2 t = vSurf;
  float pxm = max(fwidth(t.x), fwidth(t.y)) + 1e-4, aa = pxm;
  float far = smoothstep(.08, .26, pxm);
  float row = floor(t.y / .34), fv = fract(t.y / .34);
  float cu = t.x / .23 + .5 * mod(row, 2.), ci = floor(cu), fuu = fract(cu);
  float shade = (.78 + .22 * smoothstep(0., .8, fv)) * (.86 + .14 * sin(fuu * 3.1416)) * (.9 + .2 * h21(vec2(ci, row) + seed));
  shade = mix(shade, .93, far);
  float lich = smoothstep(.55, .9, vnoise(vWP.xz * .9 + seed * 10.));
  float soot = smoothstep(.5, .85, vnoise(vWP.xz * .21 + seed * 3.7)) * (1. - far * .4);
  col = base * shade * (1. - .2 * lich) + vec3(.03, .03, .01) * lich;
  col = mix(col, col * vec3(.62, .6, .6), soot * .55);                    // weathered, sooty patches
  col *= (.86 + .14 * fract(seed * 13.7)) * (.9 + .12 * vnoise(vWP.xz * .25));
  rough = .75;
  if (kind > 4.5) {                                          // mansard: dormer / attic windows
    float bx = t.x / bw, fu = fract(bx) - .5, ux = fu * bw;
    float d = rect(vec2(-.5, .35), vec2(.5, 1.75), vec2(ux, t.y), aa * 1.5);
    float g = rect(vec2(-.38, .47), vec2(.38, 1.62), vec2(ux, t.y), aa * 1.5);
    vec3 dc = mix(vec3(.93, .92, .88), mix(vec3(.08, .09, .11), vec3(.5, .58, .66), .25), g);
    col = mix(col, dc, d * (1. - far * .7));
    glassAmt = g * (1. - far); glow = g * step(h21(vec2(floor(bx), seed)), .35);
  }
} else if (kind < 4.5) {                                   // flat roofs / terraces
  vec2 t = vSurf;
  float pxm = max(fwidth(t.x), fwidth(t.y)) + 1e-4;
  float grid = max(box1(-.02, .02, fract(t.x / .6) - .5, pxm), box1(-.02, .02, fract(t.y / .6) - .5, pxm)) * (1. - smoothstep(.05, .15, pxm));
  col = base * (.88 + .14 * grime) * (1. - .1 * grid);
  rough = .95;
} else {                                                   // dressed lioz stone (monuments, castle, churches)
  vec2 t = vec2(vSurf.x * (vInfo.z > .5 ? bw : 1.), vSurf.y);
  float pxm = max(fwidth(t.x), fwidth(t.y)) + 1e-4;
  float row = floor(t.y / .48);
  float j = max(box1(-.02, .02, fract(t.y / .48) - .5, pxm), box1(-.02, .02, fract(t.x / .95 + .5 * mod(row, 2.)) - .5, pxm)) * (1. - smoothstep(.05, .2, pxm));
  col = base * (.86 + .16 * grime) * (1. - .22 * j) * (.95 + .1 * h21(vec2(floor(t.x / .95), row) + seed));
  rough = .8;
  flood = .55 + .45 * (1. - smoothstep(0., 30., t.y));             // monuments are floodlit from below after dusk
}
diffuseColor.rgb = col;
`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(rough, .12, glassAmt);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1., .72, .4) * glow * uNight * 1.6 + diffuseColor.rgb * vec3(1., .8, .55) * flood * uNight * .55;');
  };
  m.customProgramCacheKey = () => 'ilisboa-buildings-v9';
  return m;
}

// Balconies: instanced slab + wrought-iron railing panels (bars cut with alpha test).
import { mergeGeometries as mergeSlab } from 'three/addons/utils/BufferGeometryUtils.js';
export function balconyGeometry() {
  const parts = [];
  // slab: top, front edge and underside only (backs are hidden in the wall)
  const top = new THREE.PlaneGeometry(1, 0.55).rotateX(-Math.PI / 2).translate(0, 0, 0.275);
  const edge = new THREE.PlaneGeometry(1, 0.1).translate(0, -0.05, 0.55);
  const under = new THREE.PlaneGeometry(1, 0.55).rotateX(Math.PI / 2).translate(0, -0.1, 0.275);
  const slab = mergeSlab([top, edge, under]);
  const front = new THREE.PlaneGeometry(1, 1.0).translate(0, 0.5, 0.55);
  const left = new THREE.PlaneGeometry(0.55, 1.0).rotateY(-Math.PI / 2).translate(-0.5, 0.5, 0.275);
  const right = new THREE.PlaneGeometry(0.55, 1.0).rotateY(Math.PI / 2).translate(0.5, 0.5, 0.275);
  return { slab, rail: [front, left, right] };
}
export function railingMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide, alphaTest: 0.5, transparent: false });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vRUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRUv = uv;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vRUv;')
      .replace('#include <alphatest_fragment>', `{
  float x = vRUv.x * 9., y = vRUv.y;
  float far = step(.35, fwidth(x));
  float bar = step(abs(fract(x) - .5), .09) * (1. - far);
  float rail = step(.93, y) + step(y, .05);
  float curl = step(abs(length(vec2(fract(x * .5) - .5, (y - .78) * 2.2)) - .3), .05) * step(.62, y) * step(y, .93) * (1. - far);
  if (max(max(bar, rail), curl) < .5) discard;
}`);
  };
  m.customProgramCacheKey = () => 'ilisboa-rail-v1';
  return m;
}

export const waterUniformTime = { value: 0 };

// River: mask-clipped plane, sky reflections, animated multi-octave ripples.
export function waterMaterial(mask) {
  const m = new THREE.MeshStandardMaterial({ color: 0x2c5d6b, roughness: 0.12, metalness: 0.0, alphaMap: mask, alphaTest: 0.5 });   // Tagus: deep slate teal
  m.envMapIntensity = 1.15;
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = waterUniformTime;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; uniform float uTime;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec2 p = vWPos.xz;
  float t = uTime;
  vec2 g = vec2(0.0);
  // six short, irregular wave trains with a slow domain warp: chop, not stripes
  vec2 w = p + 7.0 * vec2(sin(p.y * 0.013 + t * 0.07), sin(p.x * 0.011 - t * 0.05));
  vec2 dirs[6] = vec2[6](vec2(0.8, 0.6), vec2(-0.5, 0.86), vec2(0.97, -0.24), vec2(-0.2, -0.98), vec2(0.42, 0.91), vec2(-0.93, 0.37));
  float fr[6] = float[6](0.085, 0.13, 0.21, 0.34, 0.55, 0.9);
  for (int i = 0; i < 6; i++) {
    float ph = dot(dirs[i], w) * fr[i] + t * (0.7 + float(i) * 0.33) + float(i) * 1.7;
    g += dirs[i] * cos(ph) * (0.11 / (1.0 + float(i) * 0.55));
  }
  float dist = length(cameraPosition - vWPos);
  g *= 1.0 - smoothstep(150.0, 1400.0, dist) * 0.93;   // fade the chop out before it aliases into a checkerboard
  vec3 nW = normalize(vec3(-g.x, 1.0, -g.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`);
  };
  m.customProgramCacheKey = () => 'ilisboa-water-v2';
  return m;
}

// Terrain: ground-map texture; fragments under the river are dropped so the water plane
// and the terrain share one crisp shoreline (same mask, same threshold).
export function terrainMaterial(map, mask, bounds) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uMask = { value: mask };
    s.uniforms.uBounds = { value: new THREE.Vector4(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY) };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; uniform sampler2D uMask; uniform vec4 uBounds;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  vec2 muv = vec2((vWPos.x - uBounds.x) / (uBounds.z - uBounds.x), (-vWPos.z - uBounds.y) / (uBounds.w - uBounds.y));
  if (texture2D(uMask, muv).r > 0.5) discard;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  {   // close-up surface: the ground map is 0.5 m a pixel, so the pavement texture itself comes from here, by world position
    vec2 p = vec2(vWPos.x, -vWPos.z);
    float fw = max(fwidth(p.x), fwidth(p.y)) + 1e-5;
    vec3 c = diffuseColor.rgb; float L = dot(c, vec3(.3, .59, .11)), sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float grey = 1. - smoothstep(.04, .09, sat);
    float near = 1. - smoothstep(.02, .06, fw);                    // fine patterns only while a few cm still span a pixel
    float macro = .96 + .08 * tvn(p / 9.) + .04 * tvn(p / 2.3);
    // calçada portuguesa: small limestone setts with dark joints
    float wPave = smoothstep(.5, .62, L) * grey;
    vec2 q = p / .085; q.x += .5 * mod(floor(q.y), 2.); vec2 cf = fract(q) - .5, ci = floor(q);
    float joint = smoothstep(.36, .5, max(abs(cf.x), abs(cf.y)));
    float stone = (.9 + .14 * th(ci)) * (1. - .28 * joint);
    // asphalt: grain and worn patches
    float wAsph = smoothstep(.31, .25, L) * smoothstep(.1, .15, L) * grey;
    float grain = .93 + .12 * th(floor(p / .035));
    // granite setts (tram streets): bigger, darker blocks
    float wSett = smoothstep(.22, .17, L) * grey * (1. - wAsph);
    vec2 q2 = p / .14; q2.x += .5 * mod(floor(q2.y), 2.); vec2 cf2 = fract(q2) - .5;
    float sett = (.86 + .2 * th(floor(q2))) * (1. - .35 * smoothstep(.38, .5, max(abs(cf2.x), abs(cf2.y))));
    // grass
    float wGrass = smoothstep(.02, .06, c.g - max(c.r, c.b));
    float blades = .88 + .2 * tvn(p / .35) + .08 * th(floor(p / .06));
    float k = mix(1., stone, wPave * near) * mix(1., grain, wAsph * near) * mix(1., sett, wSett * near) * mix(1., blades, wGrass * (1. - smoothstep(.04, .15, fw)));
    diffuseColor.rgb = c * k * macro;
  }`);
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
float th(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float tvn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(th(i), th(i + vec2(1, 0)), f.x), mix(th(i + vec2(0, 1)), th(i + vec2(1, 1)), f.x), f.y); }`);
  };
  m.customProgramCacheKey = () => 'ilisboa-terrain-v2';
  return m;
}
