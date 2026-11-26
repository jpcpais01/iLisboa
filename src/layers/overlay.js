// One map overlay draped over the whole city: ground, walls, roofs and river all take its colour, so a temperature
// field or a census choropleth reads like a thermal photo of Lisbon rather than a sheet hidden under the buildings.
// It rides the haze code (src/sky.js), which already knows each fragment's world position (camera + vFogRel), and
// is applied before the haze and tone mapping. Materials that share overlayUniforms (buildings, far blocks, terrain,
// water) take part; others (trees, cars, lamps) keep their colour. Off, it costs one uniform test per fragment.
//
// texture: RGBA8, sRGB colour; A is either a scalar (mode 0: drawn as contour lines every 1/uOvLev) or a weight (mode 1).
import * as THREE from 'three';
import { overlayUniforms as U } from '../materials.js';

THREE.ShaderChunk.fog_pars_fragment += /* glsl */`
#ifdef USE_FOG
uniform sampler2D uOv; uniform vec4 uOvBox; uniform float uOvK, uOvLev, uOvMode, uOvLift;
#endif`;
THREE.ShaderChunk.tonemapping_fragment = /* glsl */`
#ifdef USE_FOG
if (uOvK > 0.) {
  vec3 wp = cameraPosition + vFogRel;
  vec2 uv = (vec2(wp.x, -wp.z) - uOvBox.xy) / (uOvBox.zw - uOvBox.xy);
  vec4 o = texture2D(uOv, clamp(uv, 0., 1.));
  float inside = step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.);
  float w = (uOvMode > .5 ? o.a : 1.) * inside * uOvK;
  float L = dot(gl_FragColor.rgb, vec3(.2126, .7152, .0722));
  // colourise: the overlay's hue and saturation at the city's own brightness, so light and shade survive
  // (a lit wall stays brighter than a shaded one); a floor that rises after dusk keeps the map readable at night
  vec3 tint = o.rgb / max(dot(o.rgb, vec3(.2126, .7152, .0722)), .04) * (L * .92 + .012 + uOvLift);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, tint, w);
  if (uOvLev > 0. && uOvMode < .5) {   // contour lines (isotherms)
    float s = o.a * uOvLev, f = abs(fract(s + .5) - .5) / max(fwidth(s), 1e-4);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(L * 1.6 + .05), (1. - smoothstep(.5, 1.5, f)) * .8 * w);
  }
}
#endif
` + THREE.ShaderChunk.tonemapping_fragment;

// Every layer paints its own texture; only one is shown at a time (the last one switched on wins).
let owner = null;

// box: [minX, minY, maxX, maxY] local metres. Fill .data (RGBA bytes, row j = south→north), then upload().
export function createOverlay(box, W, H) {
  const data = new Uint8Array(W * H * 4);
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.generateMipmaps = false;
  U.uOvBox.value.set(...box);
  return {
    W, H, data, box,
    // cell centre of texel (i, j) in local metres
    x: (i) => box[0] + ((i + 0.5) / W) * (box[2] - box[0]),
    y: (j) => box[1] + ((j + 0.5) / H) * (box[3] - box[1]),
    // a layer takes the overlay (one at a time; the last one switched on wins)
    show(who, { k = 0.72, lev = 0, mode = 0 } = {}) {
      owner = who; U.uOv.value = tex; U.uOvK.value = k; U.uOvLev.value = lev; U.uOvMode.value = mode;
    },
    hide(who) { if (owner !== who) return; owner = null; U.uOvK.value = 0; },
    owns: (who) => owner === who,
    idle: () => owner === null,
    upload() { tex.needsUpdate = true; },
  };
}
