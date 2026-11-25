// Map pins for live things: a constant-size dot with a white ring, so a bus 5 km away still reads as a bus.
// One Points object per layer; positions and colours are rewritten each frame (a few hundred floats).
import * as THREE from 'three';

export const beaconUniforms = { uDpr: { value: 1 } };

export function createBeacons(max, { size = 9, lift = 0 } = {}) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3), col = new Float32Array(max * 3), sz = new Float32Array(max);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1).setUsage(THREE.DynamicDrawUsage));
  g.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uDpr: beaconUniforms.uDpr, uSize: { value: size }, uLift: { value: lift } },
    vertexShader: `attribute vec3 aColor; attribute float aSize; uniform float uDpr, uSize, uLift; varying vec3 vColor; varying float vFade;
      void main() {
        vec4 wp = modelMatrix * vec4(position + vec3(0., uLift, 0.), 1.);
        float d = distance(cameraPosition, wp.xyz);
        vec4 mv = viewMatrix * wp;
        mv.xyz *= 1. - min(.6, 40. / max(d, 1.));            // a little in front of what it marks
        gl_Position = projectionMatrix * mv;
        vFade = smoothstep(90., 420., d);                     // close up the 3D model speaks for itself
        gl_PointSize = uSize * aSize * uDpr * mix(.55, 1., vFade);
        vColor = aColor;
      }`,
    fragmentShader: `varying vec3 vColor; varying float vFade;
      void main() {
        float r = length(gl_PointCoord - .5) * 2.;
        if (r > 1.) discard;
        float ring = smoothstep(.62, .72, r), edge = 1. - smoothstep(.86, 1., r);
        vec3 c = mix(vColor, vec3(1.), ring);
        gl_FragColor = vec4(c, edge * mix(.55, .96, vFade));
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false; pts.renderOrder = 12;
  let n = 0;
  return {
    obj: pts,
    begin() { n = 0; },
    push(x, y, z, c, s = 1) { if (n >= max) return; pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z; col[n * 3] = c.r; col[n * 3 + 1] = c.g; col[n * 3 + 2] = c.b; sz[n] = s; n++; },
    end() { g.setDrawRange(0, n); for (const k of ['position', 'aColor', 'aSize']) { const a = g.attributes[k]; a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; } },
  };
}
