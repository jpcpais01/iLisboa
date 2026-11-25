// Map-style bands draped on the city: constant on-screen width at any zoom (like a web map), a darker casing
// at the edges, optional dashes, and a pull towards the camera so the band never sinks into the hills.
// One mesh, one draw call per layer, whatever the number of roads.
import * as THREE from 'three';

// lines: [{ pts: [[x, y], ...] (local metres, y north), color: [r, g, b], w: width factor, off: lateral offset factor }]
export function buildRibbons(lines) {
  let nv = 0, ni = 0;
  for (const l of lines) if (l.pts.length >= 2) { nv += l.pts.length * 2; ni += (l.pts.length - 1) * 6; }
  const pos = new Float32Array(nv * 3), dir = new Float32Array(nv * 2), side = new Float32Array(nv * 3), col = new Float32Array(nv * 3), along = new Float32Array(nv);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const first = new Uint32Array(lines.length + 1);
  let v = 0, k = 0;
  lines.forEach((l, li) => {
    first[li] = v;
    const p = l.pts, n = p.length;
    if (n < 2) return;
    let s = 0;
    for (let i = 0; i < n; i++) {
      // tangent: average of the neighbouring segments (a soft miter)
      const a = p[Math.max(0, i - 1)], b = p[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      if (i) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      for (const sd of [-1, 1]) {
        pos[v * 3] = p[i][0]; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = -p[i][1];
        dir[v * 2] = dx; dir[v * 2 + 1] = -dy;                                  // scene xz (z = -north)
        side[v * 3] = sd; side[v * 3 + 1] = l.w ?? 1; side[v * 3 + 2] = l.off ?? 0;   // side, width factor, offset (in half-widths)
        col[v * 3] = l.color?.[0] ?? 1; col[v * 3 + 1] = l.color?.[1] ?? 1; col[v * 3 + 2] = l.color?.[2] ?? 1;
        along[v] = s; v++;
      }
      if (i < n - 1) { const q = v - 2; idx.set([q, q + 1, q + 2, q + 1, q + 3, q + 2], k); k += 6; }
    }
  });
  first[lines.length] = v;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 2));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.userData.first = first;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);   // the layer spans the city: never frustum-cull it whole
  return g;
}

// re-seat every vertex on the ground (called when the height grid learns more terrain)
export function drape(g, ground, lift = 0) {
  const P = g.attributes.position, a = P.array;
  for (let i = 0; i < P.count; i++) a[i * 3 + 1] = ground.at(a[i * 3], -a[i * 3 + 2]) + lift;
  P.needsUpdate = true;
}

export function setLineColor(g, li, r, gg, b) {
  const f = g.userData.first, c = g.attributes.aColor.array;
  for (let v = f[li]; v < f[li + 1]; v++) { c[v * 3] = r; c[v * 3 + 1] = gg; c[v * 3 + 2] = b; }
}

export const ribbonUniforms = { uPx: { value: 0.002 } };   // metres of half-width per metre of camera distance, per px

export function ribbonMaterial({ px = 2.6, minW = 1.2, dash = 0, opacity = 0.92, casing = 0.55 } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uPx: ribbonUniforms.uPx, uWpx: { value: px }, uMinW: { value: minW }, uDash: { value: dash }, uOpacity: { value: opacity }, uCasing: { value: casing } },
    vertexShader: `
      attribute vec2 aDir; attribute vec3 aSide; attribute vec3 aColor; attribute float aAlong;
      uniform float uPx, uWpx, uMinW;
      varying vec3 vColor; varying float vSide, vAlong, vW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.);
        float d = distance(cameraPosition, wp.xyz);
        float w = max(uMinW, d * uPx * uWpx) * aSide.y;
        vec2 n = vec2(-aDir.y, aDir.x);
        wp.xz += n * w * (aSide.x + aSide.z);
        vec4 mv = viewMatrix * wp;
        mv.xyz *= 1. - min(.5, (2.5 + d * .004) / max(d, 1.));
        gl_Position = projectionMatrix * mv;
        vColor = aColor; vSide = aSide.x; vAlong = aAlong; vW = w;
      }`,
    fragmentShader: `
      uniform float uDash, uOpacity, uCasing;
      varying vec3 vColor; varying float vSide, vAlong, vW;
      void main() {
        float e = abs(vSide);
        float aa = fwidth(e) * 1.2;
        float alpha = 1. - smoothstep(1. - aa, 1., e);
        if (uDash > 0. && fract(vAlong / (uDash * max(1., vW))) > .62) discard;
        vec3 c = mix(vColor, vColor * uCasing, smoothstep(.62 - aa, .62 + aa, e));
        gl_FragColor = vec4(c, alpha * uOpacity);
      }`,
  });
}
