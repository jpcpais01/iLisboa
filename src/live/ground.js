// Ground height for the live layers, read off the terrain the viewer has actually drawn.
// Every terrain mesh that appears in the scene (far LOD "ft_*" first, then the finer near tiles "terrain*") is
// rasterised into one height grid, so buses, trams and road bands sit on exactly the ground the city shows —
// and follow it automatically when the tile build changes. Cost: one scene walk every 2 s while a layer is on.
import * as THREE from 'three';

export function createGround(scene, bounds, res = 10) {
  const pad = 600;
  const minX = bounds.minX - pad, minY = bounds.minY - pad;
  const W = Math.ceil((bounds.maxX + pad - minX) / res) + 1, H = Math.ceil((bounds.maxY + pad - minY) / res) + 1;
  const h = new Float32Array(W * H), prio = new Uint8Array(W * H);
  const seen = new WeakSet();
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let version = 0, lastScan = -1e9;

  function rasterise(mesh, p) {
    const g = mesh.geometry, P = g.attributes.position, I = g.index;
    if (!P) return;
    mesh.updateWorldMatrix(true, false);
    const M = mesh.matrixWorld, n = I ? I.count : P.count;
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(P, I ? I.getX(t + k) : t + k).applyMatrix4(M);
      // plan view: x east, y north (= -z)
      const ax = v[0].x, ay = -v[0].z, bx = v[1].x, by = -v[1].z, cx = v[2].x, cy = -v[2].z;
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 0.5) continue;                       // skirts and walls: vertical, no plan area
      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - minX) / res)), i1 = Math.min(W - 1, Math.floor((Math.max(ax, bx, cx) - minX) / res));
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - minY) / res)), j1 = Math.min(H - 1, Math.floor((Math.max(ay, by, cy) - minY) / res));
      for (let j = j0; j <= j1; j++) {
        const y = minY + j * res;
        for (let i = i0; i <= i1; i++) {
          const x = minX + i * res;
          const w0 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / area, w1 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / area, w2 = 1 - w0 - w1;
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
          const c = j * W + i;
          if (prio[c] > p) continue;
          h[c] = w0 * v[0].y + w1 * v[1].y + w2 * v[2].y; prio[c] = p;
        }
      }
    }
  }

  function scan(now) {
    if (now - lastScan < 2000) return false;
    lastScan = now;
    let added = 0;
    scene.traverse((o) => {
      if (!o.isMesh || seen.has(o)) return;
      const far = o.name.startsWith('ft_'), near = o.name.startsWith('terrain');
      if (!far && !near) return;
      seen.add(o); rasterise(o, near ? 2 : 1); added++;
    });
    if (added) version++;
    return added > 0;
  }

  // bilinear over the cells that have ground; unknown cells (outside every tile) fall back to sea level
  function at(x, y) {
    const fx = (x - minX) / res, fy = (y - minY) / res;
    const i = Math.max(0, Math.min(W - 2, Math.floor(fx))), j = Math.max(0, Math.min(H - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j));
    const c = j * W + i, ws = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty], cs = [c, c + 1, c + W, c + W + 1];
    let s = 0, n = 0;
    for (let k = 0; k < 4; k++) if (prio[cs[k]]) { s += h[cs[k]] * ws[k]; n += ws[k]; }
    return n > 1e-6 ? s / n : 0;
  }
  return { scan, at, get version() { return version; } };
}
