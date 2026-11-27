// Scenery rain for the weather picker: falling streaks around the camera, all animated on the GPU (no per-frame CPU work).
// Each drop is one line segment; its position is a hash of its index wrapped into a box that follows the camera, so the
// field is endless and costs one draw. The box grows with the camera's height above the ground, and drops thin out with
// distance, so a street view is in the rain and a view from the air sees a grey veil (the haze does the rest).
import * as THREE from 'three';

export function createRain({ mobile = false } = {}) {
  const N = mobile ? 4000 : 12000;
  const g = new THREE.BufferGeometry();
  const seed = new Float32Array(N * 2 * 2);
  for (let i = 0; i < N; i++) for (let e = 0; e < 2; e++) { seed[(i * 2 + e) * 2] = i; seed[(i * 2 + e) * 2 + 1] = e; }
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
  const U = { uTime: { value: 0 }, uBox: { value: 120 }, uAmt: { value: 0 }, uLight: { value: new THREE.Color(0.5, 0.52, 0.55) }, uWind: { value: new THREE.Vector2(2.5, 0.8) } };
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false,
    vertexShader: /* glsl */`
      attribute vec2 aSeed; uniform float uTime, uBox; uniform vec2 uWind; varying float vA;
      float h(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
      void main() {
        float i = aSeed.x, sp = 8.5 + 2. * h(i + 3.1);                       // m/s
        vec3 r = vec3(h(i), h(i + 1.7), h(i + 5.3));
        vec3 box = vec3(uBox, uBox * .6, uBox);
        vec3 p = vec3(r.x, r.y - uTime * sp / box.y, r.z) * box;                // falling in the box's own units
        p.xz += uWind * uTime;                                                 // drift with the wind
        p = mod(p - cameraPosition + box * .5, box) + cameraPosition - box * .5;   // wrapped around the camera
        p.y -= box.y * .15;
        p.xz -= uWind * aSeed.y * .1; p.y += sp * .1 * aSeed.y;                // the streak: where it was 100 ms ago (a camera shutter)
        vec4 mv = modelViewMatrix * vec4(p, 1.);
        vA = (.5 + .5 * h(i + 9.7)) * (1. - smoothstep(uBox * .25, uBox * .5, length(mv.xyz))) * (1. - aSeed.y * .7);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uAmt; uniform vec3 uLight; varying float vA;
      void main() { gl_FragColor = vec4(uLight, vA * uAmt * .8); }`,
  });
  const lines = new THREE.LineSegments(g, mat);
  lines.frustumCulled = false; lines.visible = false; lines.renderOrder = 4; lines.name = 'scenery-rain'; lines.userData.farMerged = true;
  return {
    mesh: lines,
    set amount(a) { U.uAmt.value = a; lines.visible = a > 0.01; },
    get amount() { return U.uAmt.value; },
    update(t, camera, groundY, light) {
      if (!lines.visible) return;
      U.uTime.value = t;
      U.uBox.value = THREE.MathUtils.clamp((camera.position.y - groundY) * 0.9 + 60, 80, 420);
      U.uLight.value.copy(light);
    },
  };
}
