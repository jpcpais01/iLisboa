// Instanced screen-facing streaks (wind, rain): each instance is a quad from tail A to head B, a few pixels wide at any
// zoom, tapering from nothing at the tail; colour + alpha per instance (sRGB, no tone mapping: map ink, not scenery).
import * as THREE from 'three';

export function createStreaks(N, width) {
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const A = new Float32Array(N * 3), B = new Float32Array(N * 3), C = new Float32Array(N * 4);
  const attrs = [['iA', A, 3], ['iB', B, 3], ['iC', C, 4]].map(([n, a, s]) => {
    const at = new THREE.InstancedBufferAttribute(a, s).setUsage(THREE.DynamicDrawUsage); quad.setAttribute(n, at); return at;
  });
  quad.instanceCount = N;
  const uniforms = { uRes: { value: new THREE.Vector2(1, 1) }, uW: { value: width } };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: /* glsl */`
      attribute vec3 iA, iB; attribute vec4 iC; uniform vec2 uRes; uniform float uW; varying vec4 vC; varying float vS;
      void main() {
        vec4 a = projectionMatrix * viewMatrix * vec4(iA, 1.), b = projectionMatrix * viewMatrix * vec4(iB, 1.);
        vec2 sa = a.xy / a.w * uRes, sb = b.xy / b.w * uRes, d = sb - sa;
        float L = length(d); d = L > 1e-3 ? d / L : vec2(1., 0.);
        vec4 p = mix(a, b, position.x);
        p.xy += vec2(-d.y, d.x) * position.y * uW * (.25 + .75 * position.x) / uRes * p.w;
        gl_Position = p; vC = iC; vS = position.x;
      }`,
    fragmentShader: /* glsl */`
      varying vec4 vC; varying float vS;
      void main() { gl_FragColor = vec4(vC.rgb, vC.a * vS * vS); }`,
  });
  const mesh = new THREE.Mesh(quad, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 5; mesh.visible = false;
  return {
    mesh, A, B, C,
    commit(canvas, n = N) { uniforms.uRes.value.set(canvas.clientWidth / 2, canvas.clientHeight / 2); quad.instanceCount = n; for (const a of attrs) a.needsUpdate = true; },
  };
}
