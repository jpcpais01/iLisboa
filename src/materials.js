import * as THREE from 'three';

export const cityUniforms = { uNight: { value: 0 } };
// map overlay (src/layers/overlay.js): one texture draped over ground, walls and roofs alike (temperature, rain, freguesias)
export const overlayUniforms = { uOv: { value: null }, uOvBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uOvK: { value: 0 }, uOvLev: { value: 0 }, uOvMode: { value: 0 } };

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
// share of a pixel footprint [x − w/2, x + w/2] covered by a pulse train of period 1 lit on [a, b]: exact box filtering, so a
// window grid reads as rows of windows at any distance (no moiré) and only melts into its average once a bay is under a pixel
float fpulse(float x, float a, float b, float w) { w = max(w, 1e-4); float x0 = x - w * .5, x1 = x + w * .5;
  return ((floor(x1) * (b - a) + clamp(fract(x1), a, b) - a) - (floor(x0) * (b - a) + clamp(fract(x0), a, b) - a)) / w; }
float rect(vec2 lo, vec2 hi, vec2 p, float aa) { return box1(lo.x, hi.x, p.x, aa) * box1(lo.y, hi.y, p.y, aa); }
`;

export function buildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = cityUniforms.uNight; Object.assign(s.uniforms, overlayUniforms);
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
float ms = fract(seed * 23.17);                             // sub-style: modern (curtain wall, ribbons, punched) and apartment blocks (below)
// apartment blocks by era: 0 punched windows + roller shutters, 1 1960s–70s continuous balcony bands,
// 2 Estado Novo 'Português Suave' (stone-framed windows, stone ground floor), 3 1980s–90s aluminium windows and glazed marquises
float sub8 = variant > 7.5 ? (ms < .4 ? 0. : ms < .6 ? 1. : ms < .8 ? 2. : 3.) : -1.;
if (sub8 > 1.5 && sub8 < 2.5) frameC = stoneC * 1.04;
if (sub8 > 2.5) frameC = fract(seed * 7.3) < .62 ? vec3(.27, .2, .16) : vec3(.9, .9, .88);

if (kind < .5) {                                  // plain trims, chimneys
  col = base * (.94 + .08 * grime);
} else if (kind < 2.5) {                          // façades (1) and blank walls (2)
  float top = vInfo.x, fh = max(vInfo.y, 2.4), bays = floor(vInfo.z + .5), gh = max(vInfo.w, 2.6);
  float y = vSurf.y;
  flood = .3 * (1. - smoothstep(1., 11., y));   // after dusk the street lamps wash the lower floors in warm light
  // ambient occlusion: the street canyon darkens the lower floors and the ground contact most; the eave shades the top metre
  float ao = (.76 + .24 * smoothstep(0., 9., y)) * (1. - .1 * (1. - smoothstep(0., 1.2, top - y)));
  // weathering: soft patches of faded and repainted render, each building its own age, a damp splash band at the foot
  col = base * ao * (.9 + .12 * grime) * (.93 + .07 * fract(seed * 41.3));
  col = mix(col, col * vec3(.84, .85, .8), (1. - smoothstep(.2, 1.4, y)) * .6);
  // rain streaks
  col *= 1. - .05 * smoothstep(.55, 1., vnoise(vec2(vSurf.x * (kind > 1.5 ? 2.3 : 9.), y * .08))) * (1. - smoothstep(0., top, y) * .5);
  if (kind < 1.5 && bays > .5 && y < top - .15) {
    float bx = vSurf.x, bi = floor(bx), fu = fract(bx);
    float ux = (fu - .5) * bw;                               // metres from bay centre
    float pxm = max(fwidth(bx) * bw, fwidth(y)) + 1e-4;
    float aa = pxm * .7;
    float far = smoothstep(.38, 1.05, pxm);   // windows hold until a bay is ~1 px wide
    if (far > .995) {   // far façades: the window grid alone, box-filtered (cheap, and it holds from ~1 m a pixel out to the horizon)
      float wf = variant > 2.5 && variant < 3.5 ? (ms < .28 ? .94 : ms < .7 ? .84 : .5) : variant > 7.5 ? .55 : .44;
      float cxw = fpulse(bx, .5 - wf * .5, .5 + wf * .5, fwidth(bx));
      float above = step(gh, y), cyw = mix(.45, fpulse((y - gh) / fh, .28, .86, fwidth(y) / fh), above);
      float win = cxw * cyw;
      col = mix(col, vec3(.13, .15, .18), win * .8);
      glow = .8 * win * mix(step(h21(vec2(floor(bx), floor((y - gh) / fh)) + seed), .42), .42, smoothstep(.5, 1.5, fwidth(bx)));   // lit windows, averaged once a bay is under a pixel
    } else {
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
    if (variant > 6.5 && variant < 7.5 && y > .5) {
      vec2 dp = vec2(bx * bw / .62, y / .4); dp.x += mod(floor(dp.y), 2.) * .5;
      vec2 f = fract(dp) - .5; float side = step(abs(f.y), abs(f.x));
      float shade = mix(f.y > 0. ? .13 : -.16, f.x > 0. ? -.05 : .06, side) * (1. - far);
      float joint = 1. - .12 * (1. - far) * (1. - box1(-.46, .46, f.x, aa * 2.) * box1(-.45, .45, f.y, aa * 2.));
      wallC = base * (1. + shade) * joint * (.96 + .05 * grime);
      rough = .8;
    }
    col = wallC;
    // stone plinth, string course, cornice band, corner pilasters (Pombaline / palatial)
    float formal = (step(variant, .5) + step(3.5, variant)) * step(variant, 7.5) + step(1.5, sub8) * step(sub8, 2.5);
    float dEnd = min(bx, bays - bx) * bw;
    col = mix(col, stoneC * (.95 + .05 * grime), formal * (box1(-9., sub8 > 1.5 && sub8 < 2.5 ? gh : .85, y, aa) + box1(gh - .22, gh, y, aa) + box1(top - .45, top, y, aa) * .8 + step(dEnd, .42) * step(.9, y)));
    col = mix(col, base * .78, box1(top - .6, top - .45, y, aa) * formal);     // cornice shadow line
    // window geometry per variant
    float ww, y0, y1; float door = 0., shop = 0., balc = 0., shutters = 0.;
    float jit = variant > .5 && variant < 2.5 ? (rB - .5) * .25 * bw : 0.;
    float balc8 = 0.;
    if (variant > 7.5) {                                        // apartment block: punched windows with roller shutters, balcony columns
      ww = min(1.5, bw * .5); y0 = isG > .5 ? .1 : flH * .3; y1 = flH * .86; shop = isG;
      balc8 = step(h21(vec2(floor(bi / (1. + step(.5, ms))), seed * 13.)), .4 + .25 * ms) * (1. - isG);
      if (sub8 > .5 && sub8 < 1.5) balc8 = (1. - isG) * step(.2, h21(vec2(floor(bi / 3.), seed * 5.)));   // bands run across most bays
      if (sub8 > 1.5 && sub8 < 2.5) { ww = min(1.2, bw * .42); y0 = isG > .5 ? .1 : flH * .2; balc8 = (1. - isG) * step(abs(bx - bays * .5), 1.) * step(.5, fi) * step(fi, 3.5); }
      if (sub8 > 2.5) { ww = min(2.1, bw * .68); y0 = isG > .5 ? .1 : flH * .34; balc8 = (1. - isG) * step(h21(vec2(floor(bi / 2.), seed * 13.)), .5); }
      if (balc8 > .5) { ww = bw * (sub8 > .5 && sub8 < 1.5 || sub8 > 2.5 ? .92 : .78); y0 = .06; y1 = flH * .86; shutters = 0.; }
    } else if (variant > 2.5 && variant < 3.5) {                       // modern: ribbons / curtain wall
      if (ms < .28) { ww = bw * .97; y0 = .05; y1 = flH * .96; }
      else if (ms < .7) { ww = bw * .86; y0 = isG > .5 ? .1 : flH * .22; y1 = flH * .9; }
      else { ww = bw * .5; y0 = isG > .5 ? .1 : flH * .27; y1 = flH * .84; }
      shop = isG;
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
    if (variant > 2.5 && variant < 3.5 && ms < .28) glass = glass * (fract(seed * 5.9) < .5 ? vec3(.8, 1.06, 1.08) : vec3(1.08, 1., .86)) + vec3(.02, .04, .045) * (1. - rev);   // tinted curtain glass, teal or bronze
    float bars = (variant > 2.5 && variant < 3.5) ? box1(-.025, .025, fract(bx * 2.) - .5, aa) : max(box1(-.03, .03, p.x, aa), box1(-.03, .03, fy - mix(y0, y1, .62), aa));
    glass = mix(glass, frameC * .9, bars * (1. - shop) * .85);
    if (variant > 7.5) {                                       // roller shutters (estores) part-way down, slats catching the light
      float sh = y1 - fr - (y1 - y0 - 2. * fr) * (.15 + .7 * h21(vec2(bi * 3.1, fi) + seed));
      vec3 rc = fract(seed * 7.7) < .5 ? vec3(.80, .78, .73) : vec3(.62, .60, .56);
      glass = mix(glass, rc * (.86 + .14 * step(.5, fract(fy * 16.))), step(sh, fy));
    }
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
    if (balc8 > .5) {                                          // the balcony: a solid parapet to 1.05 m, its slab edge, the shadow it casts
      float bxw = bw * (sub8 > .5 && sub8 < 1.5 ? .51 : .47), inB = box1(-bxw, bxw, ux, aa);
      vec3 parC = fract(seed * 3.3) < .6 ? wallC * 1.04 : mix(wallC, vec3(.92, .91, .88), .6);
      if (sub8 > .5 && sub8 < 1.5) parC = fract(seed * 3.3) < .5 ? vec3(.93, .92, .9) : wallC * 1.06;   // white concrete bands
      if (sub8 > 2.5) {                                          // marquise: the balcony glazed in, aluminium mullions every ~80 cm
        float mul = box1(-.035, .035, fract(ux / .8) - .5, aa * 2.) + box1(1.0, 1.08, fy, aa) + box1(y1 - .08, y1, fy, aa);
        col = mix(col, mix(glass, frameC, .25), inB * box1(1.05, y1, fy, aa));
        col = mix(col, frameC, inB * clamp(mul, 0., 1.) * box1(-.05, y1, fy, aa));
      }
      col = mix(col, parC, inB * box1(-.05, 1.05, fy, aa));
      col = mix(col, parC * .82, inB * box1(-.2, -.05, fy, aa));
      col *= 1. - .25 * inB * box1(1.05, 1.3, fy, aa) * step(.5, glassAmt);
      glassAmt *= 1. - inB * step(fy, 1.05); glow *= 1. - inB * step(fy, 1.05);
    }
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
    glassAmt *= 1. - far; glow = mix(glow, .045 + .05 * fract(seed * 13.7), far);   // lit windows averaged over the wall: a faint warm wash, not a lit wall
    }
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
  col *= 1. - .14 * smoothstep(.45, .85, vnoise(vWP.xz * .18 + seed * 7.)) - .06 * smoothstep(.6, .9, vnoise(vWP.xz * .9));   // ponding stains, patched membrane
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
  m.customProgramCacheKey = () => 'ilisboa-buildings-v14';
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

// River: one mask-clipped plane. Everything is analytic, no textures beyond the mask:
//  · waves: 9 directional trains, each faded out once it falls below ~2 pixels; the slope energy it
//    loses goes into roughness, so the far river widens the sun's glitter instead of aliasing;
//  · depth: the mask's own mipmaps measure distance to the shore (≈4 m, 25 m, 150 m), giving silty
//    shallows at the quays, a teal middle and a deep slate channel;
//  · body light: crests glow green where the sun shines through them; lapping foam on the shore;
//  · night: the lit city smears into long warm streaks on the water near the banks.
export function waterMaterial(mask) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0.0, alphaMap: mask, alphaTest: 0.5 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = waterUniformTime;
    s.uniforms.uNight = cityUniforms.uNight; Object.assign(s.uniforms, overlayUniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <alphamap_fragment>', 'diffuseColor.a *= texture2D(alphaMap, vAlphaMapUv).r;');   // the mask is one channel (R8)
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos; uniform float uTime; uniform float uNight;
float wh(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float wn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(wh(i), wh(i + vec2(1, 0)), f.x), mix(wh(i + vec2(0, 1)), wh(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec2 p = vec2(vWPos.x, -vWPos.z);
  float t = uTime, dist = length(cameraPosition - vWPos);
  float fw = length(fwidth(p)) + 1e-4;                       // metres per pixel here
  vec2 w = p + 6.0 * vec2(sin(p.y * 0.013 + t * 0.07), sin(p.x * 0.011 - t * 0.05));   // slow warp: chop, not stripes
  const vec2 D[9] = vec2[9](vec2(.8,.6), vec2(-.5,.86), vec2(.97,-.24), vec2(-.2,-.98), vec2(.42,.91), vec2(-.93,.37), vec2(.6,-.8), vec2(.1,.99), vec2(-.7,-.71));
  const float K[9] = float[9](.06, .095, .15, .24, .38, .6, .95, 1.5, 2.4);   // rad/m: 105 m … 2.6 m wavelengths
  const float A[9] = float[9](.014, .02, .03, .042, .055, .065, .068, .064, .058);   // slope amplitude: long swell is gentle, wind chop is steep
  float grpL = .35 + 1.3 * wn(p / 140. + vec2(t * .01, 0.)), grpS = .3 + 1.4 * wn(p / 31. - vec2(0., t * .03));   // wave groups, not an endless corrugation
  float nL = wn(p / 60. + 11.3), nM = wn(p / 19. + 3.1), nS = wn(p / 6. + 7.7);
  vec2 g = vec2(0.); float h = 0., lost = 0.;   // h: crest height of the short trains, ≈ -1…1
  for (int i = 0; i < 9; i++) {
    float k = K[i], a = A[i] * (i < 4 ? grpL : grpS);
    float keep = 1. - smoothstep(.12, .45, fw * k / 6.2832);   // cycles per pixel → fade before it aliases
    if (keep <= 0.) { lost += a * a; continue; }               // far water: the short trains cost nothing
    // short-crested sea: each train's phase is bent by a noise field ~7 wavelengths across, so crests break up instead of running on forever
    float nz = i < 3 ? nL : i < 6 ? nM : nS;
    float ph = dot(D[i], w) * k + t * sqrt(9.81 * k) * .9 + float(i) * 1.7 + nz * (4.5 + float(i) * .9);   // deep-water dispersion
    float c = cos(ph);
    g += D[i] * c * a * keep; h += sin(ph) * keep * step(2.5, float(i)) * .3;
    lost += a * a * (1. - keep);
  }
  vec3 nW = normalize(vec3(-g.x, 1.0, g.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  roughnessFactor = clamp(.045 + sqrt(lost) * 1.6 + smoothstep(600., 6000., dist) * .08, .04, .34);

  // shore field from the mask's mipmaps (1 = open water at that scale)
  float s1 = textureLod(alphaMap, vAlphaMapUv, 1.2).r, s2 = textureLod(alphaMap, vAlphaMapUv, 3.8).r, s3 = textureLod(alphaMap, vAlphaMapUv, 6.3).r;
  float deep = smoothstep(.55, 1., s3) * smoothstep(.7, 1., s2);
  vec3 shallow = vec3(.105, .135, .105), mid = vec3(.045, .095, .105), abyss = vec3(.022, .05, .068);
  vec3 body = mix(shallow, mid, smoothstep(.75, 1., s2));
  body = mix(body, abyss, deep);
  body *= .92 + .16 * wn(p / 60. + t * .01);                  // slow turbidity patches
  diffuseColor.rgb = body;

  // light through the crests: green-teal, strongest looking towards the sun at low angles
  vec3 V = normalize(cameraPosition - vWPos);
#if NUM_DIR_LIGHTS > 0
  vec3 L = normalize((vec4(directionalLights[0].direction, 0.) * viewMatrix).xyz);   // view → world
  float back = pow(max(0., dot(-V.xz, L.xz) / max(1e-3, length(V.xz) * length(L.xz))), 3.);
  float sss = clamp(h * .6 + .35, 0., 1.) * (.25 + .75 * back) * (1. - V.y * .6);
  totalEmissiveRadiance += vec3(.05, .16, .13) * sss * directionalLights[0].color * .3 * (1. - smoothstep(1500., 5000., dist));
#endif

  // foam: lapping against quays and banks, broken up and drifting
  float edge = 1. - smoothstep(.5, .97, s1);
  float fn = wn(p * .9 + vec2(t * .25, -t * .18)) * .6 + wn(p * 2.7 - vec2(t * .4, t * .3)) * .4;
  float foam = edge * smoothstep(.62, .78, fn + edge * .45 + h * .15) * (1. - smoothstep(30., 140., fw * 400.));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.78, .8, .78), foam);
  roughnessFactor = mix(roughnessFactor, .8, foam);

  // night: lit banks smear into vertical streaks of warm light near the shore
  if (uNight > .01) {
    vec2 vd = normalize(vWPos.xz - cameraPosition.xz + 1e-4), vp = vec2(-vd.y, vd.x);
    float across = dot(vWPos.xz, vp), along = dot(vWPos.xz, vd);
    float streak = smoothstep(.55, .95, wn(vec2(across / 2.2, along / 35. + t * .05))) * (.6 + .8 * wn(vec2(across * 1.7, along * .6 - t * 1.3)));
    float bank = 1. - smoothstep(.35, 1., s3 * .5 + s2 * .5);
    totalEmissiveRadiance += vec3(1., .62, .3) * streak * bank * uNight * .35;
  }
}`);   // (the environment is the real sky now, at full strength: the water mirrors it as it is)
  };
  m.customProgramCacheKey = () => 'ilisboa-water-v4';
  return m;
}

// Terrain: ground-map texture; fragments under the river are dropped so the water plane
// and the terrain share one crisp shoreline (same mask, same threshold).
export function terrainMaterial(map, mask, bounds) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uMask = { value: mask }; s.uniforms.uNight = cityUniforms.uNight; Object.assign(s.uniforms, overlayUniforms);
    s.uniforms.uBounds = { value: new THREE.Vector4(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY) };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; uniform sampler2D uMask; uniform vec4 uBounds; uniform float uNight;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  vec2 muv = vec2((vWPos.x - uBounds.x) / (uBounds.z - uBounds.x), (-vWPos.z - uBounds.y) / (uBounds.w - uBounds.y));
  if (texture2D(uMask, muv).r > 0.5) discard;
  float tLit = 0.;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  {   // close-up surface: the ground map is 0.5 m a pixel, so the pavement texture itself comes from here, by world position
    vec2 p = vec2(vWPos.x, -vWPos.z);
    float fw = max(fwidth(p.x), fwidth(p.y)) + 1e-5;
    vec3 c = diffuseColor.rgb; float L = dot(c, vec3(.3, .59, .11)), sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float grey = 1. - smoothstep(.04, .09, sat);
    float dL = fwidth(L);   // derivatives stay outside the distance branches below
    if (fw < .35) {   // crisp kerbs: the filtered map blurs road/pavement edges over a metre; re-threshold the transition band to a sub-pixel edge up close
      float t = clamp((L - .27) / .31, 0., 1.), band = step(.27, L) * step(L, .58) * grey * (1. - smoothstep(.12, .35, fw)) * smoothstep(.15, .3, dL / fw);
      float L2 = mix(.27, .58, smoothstep(.42, .58, t));
      c *= mix(1., L2 / max(L, 1e-3), band); L = mix(L, L2, band);
    }
    float near = 1. - smoothstep(.02, .06, fw);                    // fine patterns only while a few cm still span a pixel
    float macro = .96 + .08 * tvn(p / 9.) + .04 * tvn(p / 2.3);
    float k = 1.;
    if (fw < .15) {   // beyond ~15 cm a pixel none of this shows: skip it (most of the screen in a city view)
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
    k = mix(1., stone, wPave * near) * mix(1., grain, wAsph * near) * mix(1., sett, wSett * near) * mix(1., blades, wGrass * (1. - smoothstep(.04, .15, fw)));
    }
    float wGrass = smoothstep(.02, .06, c.g - max(c.r, c.b));
    diffuseColor.rgb = c * k * macro;
    // after dusk: streets and squares under the lamps, pools of warm light along the paved surfaces
    if (uNight > .01) tLit = grey * smoothstep(.1, .16, L) * (1. - wGrass) * (.1 + .38 * smoothstep(.4, .85, tvn(p / 9.)) + .08 * tvn(p / 2.7));
    // steep banks (the ground map smears there): Lisbon's retaining walls, coursed limestone with dark joints and rain streaks
    vec3 gn = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
    float steep = (1. - smoothstep(.5, .68, abs(gn.y))) * (1. - wGrass);
    if (steep > .001) {
      vec2 hz = normalize(vec2(-gn.z, gn.x) + 1e-4);
      vec2 w = vec2(dot(vWPos.xz, hz), vWPos.y);
      vec2 b = w / vec2(.62, .31); b.x += .5 * mod(floor(b.y), 2.); vec2 bf = fract(b) - .5;
      float fwW = max(fwidth(w.x), fwidth(w.y)) + 1e-5, nearW = 1. - smoothstep(.03, .12, fwW);
      float jn = smoothstep(.40, .5, max(abs(bf.x) * 1.0, abs(bf.y) * 1.0)) * nearW;
      vec3 wall = vec3(.69, .64, .56) * (.88 + .16 * th(floor(b))) * (1. - .3 * jn);
      wall *= .9 + .1 * tvn(vec2(w.x * 1.7, w.y * .12)) - .12 * smoothstep(.55, .9, tvn(vec2(w.x * 3.1, w.y * .25)));
      diffuseColor.rgb = mix(diffuseColor.rgb, wall * macro, steep);
    }
  }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1., .68, .38) * tLit * uNight;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
float th(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float tvn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(th(i), th(i + vec2(1, 0)), f.x), mix(th(i + vec2(0, 1)), th(i + vec2(1, 1)), f.x), f.y); }`);
  };
  m.customProgramCacheKey = () => 'ilisboa-terrain-v7';
  return m;
}

// Far blocks (one extruded footprint per building, past the mid tier): flat-shaded walls in the façade colour, with the same
// box-filtered window grid the full buildings fall back to at range (bays ~3.4 m, storeys ~3.1 m, anchored in world space), so
// the hand-over from full to far keeps rows of windows instead of turning into blank boxes; after dusk a share of them is lit.
export function farBuildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = cityUniforms.uNight; Object.assign(s.uniforms, overlayUniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFW = (modelMatrix * vec4(transformed, 1.)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFW;\n' + BUILDING_GLSL.replace(/varying[^\n]*\n/, ''))
      .replace('#include <color_fragment>', `#include <color_fragment>
float glow = 0.;
{
  vec3 nW = normalize(cross(dFdx(vFW), dFdy(vFW)));
  float wall = 1. - smoothstep(.35, .6, abs(nW.y));
  if (wall > 0.) {
    vec2 tg = normalize(vec2(-nW.z, nW.x) + 1e-5);
    float u = dot(vFW.xz, tg) / 3.4, v = vFW.y / 3.1;
    float fu = fwidth(u), fv = fwidth(v);
    float win = fpulse(u, .28, .72, fu) * fpulse(v, .3, .86, fv) * wall;
    float k = .5 + .5 * h21(floor(vFW.xz / 23.) + .37);   // blocks differ: some darker glass, some shuttered
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.13, .15, .18), win * mix(.62, .82, k));
    glow = .8 * win * mix(step(h21(vec2(floor(u), floor(v)) + floor(vFW.xz / 40.)), .42), .42, smoothstep(.5, 1.5, fu));
  }
}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1., .72, .4) * glow * uNight * 1.6;');
  };
  m.customProgramCacheKey = () => 'ilisboa-far-buildings-v1';
  return m;
}
