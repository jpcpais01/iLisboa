// What the car can touch: exactly the meshes the viewer is drawing near it. Terrain tiles ("terrain", or the far
// "ft_*" ground where a tile isn't in yet) and building meshes ("buildings", "fb_*") get a BVH the first time the
// car comes near them, so ground rays and wall tests stay sub-millisecond. Bridge decks, parapets and towers are
// authored into the building meshes, so the car rides the Ponte 25 de Abril and stops at its railings for free.
// Only visible meshes count: the far ground under a loaded full tile is hidden, so it never fights the near ground.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const NEAR = 260;   // metres around the car whose meshes are kept queryable

export function createWorld(scene) {
  let active = [];            // { mesh, ground, solid, bvh, inv, scale, box }
  const info = new WeakMap(); // mesh → its entry (world box, BVH once built)
  const todo = [];            // meshes waiting for a BVH, nearest first
  let lastScan = -1e9;
  const _ray = new THREE.Ray(), _p = new THREE.Vector3(), _q = new THREE.Vector3(), _s = new THREE.Vector3(), _hit = {};

  const kindOf = (n) => n.startsWith('terrain') || n.startsWith('ft_') ? 'ground' : n.startsWith('buildings') || n.startsWith('fb_') ? 'solid' : null;
  const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };

  function entry(mesh, kind) {
    let e = info.get(mesh);
    if (e) return e;
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    mesh.updateWorldMatrix(true, false);
    e = { mesh, ground: true, solid: kind === 'solid', bvh: null, inv: new THREE.Matrix4(), scale: 1, box: g.boundingBox.clone().applyMatrix4(mesh.matrixWorld) };
    info.set(mesh, e);
    return e;
  }
  let buildMs = 0, maxMs = 0;
  function build(e) {
    const g = e.mesh.geometry, t = performance.now();
    e.bvh = g.boundsTree || (g.boundsTree = new MeshBVH(g, { indirect: true, maxLeafSize: 8 }));   // indirect: the render index stays untouched
    e.mesh.updateWorldMatrix(true, false);
    e.inv.copy(e.mesh.matrixWorld).invert();
    e.scale = e.mesh.matrixWorld.getMaxScaleOnAxis();
    const ms = performance.now() - t; buildMs += ms; maxMs = Math.max(maxMs, ms);
  }

  // refresh the set of meshes around p; builds at most `budget` ms of BVHs per call (nearest first), the rest next time
  function update(p, now, budget = 6) {
    if (now - lastScan > 400) {
      lastScan = now;
      const next = [];
      todo.length = 0;
      scene.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh) return;
        const kind = kindOf(o.name);
        if (!kind || !shown(o)) return;
        const e = entry(o, kind), d = e.box.distanceToPoint(p);
        if (d > NEAR) return;
        if (e.bvh) next.push(e); else todo.push([d, e]);
      });
      active = next;
      todo.sort((a, b) => a[0] - b[0]);
    }
    const t0 = performance.now();
    while (todo.length && performance.now() - t0 < budget) { const [, e] = todo.shift(); build(e); if (shown(e.mesh)) active.push(e); }
    return todo.length;
  }

  // highest surface under (x, z) between yTop and yTop − depth; { y, n (world normal), solid } or null
  const _n = new THREE.Vector3(), _m3 = new THREE.Matrix3();
  function ground(x, z, yTop, depth = 60, terrainOnly = false) {
    let best = null;
    for (const e of active) {
      if (!e.ground || (terrainOnly && e.solid) || x < e.box.min.x || x > e.box.max.x || z < e.box.min.z || z > e.box.max.z || yTop < e.box.min.y) continue;
      _ray.origin.set(x, yTop, z).applyMatrix4(e.inv); _ray.direction.set(0, -1, 0).transformDirection(e.inv);
      const h = e.bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (!h) continue;
      _p.copy(h.point).applyMatrix4(e.mesh.matrixWorld);
      if (_p.y < yTop - depth || (best && _p.y <= best.y)) continue;
      _n.copy(h.face.normal).applyMatrix3(_m3.getNormalMatrix(e.mesh.matrixWorld)).normalize();
      if (_n.y < 0) _n.negate();
      best = { y: _p.y, n: _n.clone(), solid: e.solid };
    }
    return best;
  }

  // the nearest wall point to a sphere (centre c, radius r) among building meshes, as a horizontal push-out
  // { nx, nz, depth } — or null. Floors and decks under the sphere (mostly vertical separation) are not walls.
  function wall(c, r) {
    let best = null;
    for (const e of active) {
      if (!e.solid) continue;
      const b = e.box;
      if (c.x < b.min.x - r || c.x > b.max.x + r || c.z < b.min.z - r || c.z > b.max.z + r || c.y < b.min.y - r || c.y > b.max.y + r) continue;
      _s.copy(c).applyMatrix4(e.inv);
      const h = e.bvh.closestPointToPoint(_s, _hit, 0, r / e.scale);
      if (!h) continue;
      _q.copy(h.point).applyMatrix4(e.mesh.matrixWorld);
      const dx = c.x - _q.x, dy = c.y - _q.y, dz = c.z - _q.z, dh = Math.hypot(dx, dz), d = Math.hypot(dx, dh, dy);
      if (d >= r || Math.abs(dy) > dh * 1.2) continue;   // under the wheels (deck, kerb top): not a wall
      const depth = r - d;
      if (!best || depth > best.depth) best = dh > 1e-4 ? { nx: dx / dh, nz: dz / dh, depth } : null;
    }
    return best;
  }

  // first wall hit along a segment (camera occlusion): distance from a, or null
  const _dir = new THREE.Vector3();
  function cast(a, b) {
    _dir.subVectors(b, a); const L = _dir.length(); if (L < 1e-3) return null; _dir.divideScalar(L);
    let best = null;
    for (const e of active) {
      if (!e.solid) continue;
      _ray.origin.copy(a).applyMatrix4(e.inv); _ray.direction.copy(_dir).transformDirection(e.inv);
      const h = e.bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (!h) continue;
      const d = _p.copy(h.point).applyMatrix4(e.mesh.matrixWorld).distanceTo(a);
      if (d < L && (best === null || d < best)) best = d;
    }
    return best;
  }

  // parked cars (static obstacles): two circles each, front and rear, on a 24 m grid
  const CELL = 24, cars = new Map();
  function addCar(x, y, z, yaw) {
    const k = Math.floor(x / CELL) * 65536 + Math.floor(z / CELL);
    let c = cars.get(k); if (!c) cars.set(k, (c = []));
    const fx = Math.cos(yaw) * 1.15, fz = -Math.sin(yaw) * 1.15;
    c.push(x + fx, y, z + fz, x - fx, y, z - fz);
  }
  function carPush(c, r) {
    const R = r + 0.92, cx = Math.floor(c.x / CELL), cz = Math.floor(c.z / CELL);
    let best = null;
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
      const L = cars.get(i * 65536 + j); if (!L) continue;
      for (let q = 0; q < L.length; q += 3) {
        if (Math.abs(L[q + 1] + 0.8 - c.y) > 2) continue;
        const dx = c.x - L[q], dz = c.z - L[q + 2], d = Math.hypot(dx, dz);
        if (d < R && d > 1e-4 && (!best || R - d > best.depth)) best = { nx: dx / d, nz: dz / d, depth: R - d, car: true };
      }
    }
    for (let q = 0; q < movers.length; q += 3) {   // the traffic around (circles, refreshed every frame)
      if (Math.abs(movers[q + 1] + 0.8 - c.y) > 3) continue;
      const dx = c.x - movers[q], dz = c.z - movers[q + 2], d = Math.hypot(dx, dz);
      if (d < R && d > 1e-4 && (!best || R - d > best.depth)) best = { nx: dx / d, nz: dz / d, depth: R - d, car: true };
    }
    return best;
  }
  // moving cars near the player, from the ambient traffic: [{ x, y (north), z (height), head (atan2(dx, dy)), half: [L, W] }]
  let movers = [];
  function setMovers(list) {
    movers = [];
    for (const m of list) {
      const ux = Math.sin(m.head), uz = -Math.cos(m.head), off = Math.max(0, m.half[0] - 1);
      for (const k of off > 1.6 ? [-1, 0, 1] : [-1, 1]) movers.push(m.x + ux * off * k, m.z, -m.y + uz * off * k);
    }
  }

  return { update, ground, setMovers, wall: (c, r) => { const a = wall(c, r), b = carPush(c, r); return !a ? b : !b ? a : a.depth > b.depth ? a : b; }, cast, addCar, get size() { return active.length; }, get stats() { return { buildMs: Math.round(buildMs), maxMs: Math.round(maxMs) }; }, get pending() { return todo.length; } };
}
