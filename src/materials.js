import * as THREE from 'three';

// Buildings: vertex-coloured walls/roofs + procedural windows, plinth and eave shading.
// Wall coordinates come from the pipeline: wall = (metres along façade, metres above ground),
// wallInfo = (wall height, floor height; 0 = no windows e.g. churches, castle).
export function buildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 wall; attribute vec2 wallInfo; varying vec2 vWall; varying vec2 vInfo;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = wall; vInfo = wallInfo;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vWall; varying vec2 vInfo;
float band(float a, float b, float x, float w) { return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x); }
float hash12(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float winMask = 0.0;
if (vInfo.y > 0.5 && vInfo.x > 2.0) {
  float fh = vInfo.y, top = vInfo.x;
  vec2 fw = fwidth(vWall);
  float w = max(fw.x, fw.y);
  float aa = w * 0.75 + 0.02;
  float fl = floor(vWall.y / fh), fy = mod(vWall.y, fh);
  float bayW = 2.9;
  float bay = floor(vWall.x / bayW), fu = mod(vWall.x, bayW);
  float inWall = step(0.0, vWall.y) * step(vWall.y, top - 0.7);
  float m;
  if (fl < 1.0) {           // ground floor: doors / shopfronts
    m = band(0.55, 2.35, fu, aa) * band(0.0, fh * 0.80, fy, aa);
  } else {                  // upper floors: tall Lisbon sash windows
    m = band(0.95, 1.95, fu, aa) * band(fh * 0.24, fh * 0.86, fy, aa);
  }
  float far = smoothstep(0.35, 1.1, w);   // distant: blend to average so it never shimmers
  winMask = mix(m, 0.2, far) * inWall;
  float lit = hash12(vec2(bay, fl) + floor(vWall.x / 97.0));
  vec3 glass = mix(vec3(0.10, 0.12, 0.14), vec3(0.32, 0.40, 0.48), lit * 0.6);
  diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask * 0.92);
  // stone plinth and eave shadow
  diffuseColor.rgb *= mix(1.0, 0.82, (1.0 - smoothstep(0.6, 0.9, vWall.y)) * step(-50.0, vWall.y));
  diffuseColor.rgb *= 1.0 - 0.22 * smoothstep(top - 0.9, top, vWall.y);
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.18, winMask);');
  };
  m.customProgramCacheKey = () => 'ilisboa-buildings-v1';
  return m;
}

export const waterUniformTime = { value: 0 };

// River: mask-clipped plane, sky reflections, animated multi-octave ripples.
export function waterMaterial(mask) {
  const m = new THREE.MeshStandardMaterial({ color: 0x2f6b80, roughness: 0.06, metalness: 0.0, alphaMap: mask, alphaTest: 0.5 });
  m.envMapIntensity = 1.4;
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
  vec2 dirs[4] = vec2[4](vec2(0.8, 0.6), vec2(-0.5, 0.86), vec2(0.97, -0.24), vec2(-0.2, -0.98));
  float fr[4] = float[4](0.035, 0.06, 0.11, 0.19);
  for (int i = 0; i < 4; i++) {
    float ph = dot(dirs[i], p) * fr[i] + t * (0.6 + float(i) * 0.35);
    g += dirs[i] * cos(ph) * (0.16 / (1.0 + float(i)));
  }
  float dist = length(cameraPosition - vWPos);
  g *= 1.0 - smoothstep(800.0, 4000.0, dist) * 0.7;
  vec3 nW = normalize(vec3(-g.x, 1.0, -g.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`);
  };
  m.customProgramCacheKey = () => 'ilisboa-water-v1';
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
  if (texture2D(uMask, muv).r > 0.5) discard;`);
  };
  m.customProgramCacheKey = () => 'ilisboa-terrain-v1';
  return m;
}
