// Live aircraft (adsb.lol via /api/planes, every 8 s). Between reports each plane flies on by dead reckoning
// (track, ground speed, climb rate) and a correction blends in over 3 s, so motion is continuous, never jumpy.
// Each keeps a fading trail of where it has been since the layer was switched on.
import * as THREE from 'three';
import { planeGeometry } from './models.js';
import { createBeacons } from './beacons.js';

const POLL = 8000, TRAIL = 48, MAX = 160;

export function createPlanes(ctx) {
  const { scene, ground } = ctx;
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
  const mesh = new THREE.InstancedMesh(planeGeometry(), mat, MAX);
  mesh.count = 0; mesh.frustumCulled = false;
  group.add(mesh);
  const beacons = createBeacons(MAX, { size: 12 });
  group.add(beacons.obj);
  // trails: one LineSegments for all planes, alpha fading towards the tail
  const tg = new THREE.BufferGeometry();
  const tpos = new Float32Array(MAX * TRAIL * 2 * 3), talpha = new Float32Array(MAX * TRAIL * 2);
  tg.setAttribute('position', new THREE.BufferAttribute(tpos, 3).setUsage(THREE.DynamicDrawUsage));
  tg.setAttribute('aAlpha', new THREE.BufferAttribute(talpha, 1).setUsage(THREE.DynamicDrawUsage));
  const trails = new THREE.LineSegments(tg, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: 'attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(1., 1., 1., vA * .55); }',
  }));
  trails.frustumCulled = false; group.add(trails);

  const planes = new Map();
  const C_AIR = new THREE.Color(0x2f6fd6), C_GROUND = new THREE.Color(0x8b95a1);
  let timer = 0, on = false, lastOk = 0, error = '', lastTrail = 0;

  async function poll() {
    if (!on) return;
    if (document.visibilityState === 'visible') {
      try {
        const r = await fetch('/api/planes');
        if (!r.ok) throw new Error(`${r.status}`);
        ingest(await r.json()); lastOk = Date.now(); error = '';
      } catch (e) { error = String(e.message || e); }
      ctx.status();
    }
    timer = setTimeout(poll, POLL);
  }
  function ingest(d) {
    const now = performance.now() / 1000, seen = new Set();
    for (const [hex, call, type, reg, x, y, alt, track, gs, vr, age] of d.a) {
      seen.add(hex);
      const tr = (track * Math.PI) / 180;
      // where the report says the plane is right now
      const nx = x + Math.sin(tr) * gs * age, ny = y + Math.cos(tr) * gs * age, nz = alt < 0 ? null : alt + vr * age;
      let p = planes.get(hex);
      if (!p) { p = { hex, x: nx, y: ny, z: nz ?? 0, ex: 0, ey: 0, ez: 0, roll: 0, trail: [] }; planes.set(hex, p); }
      else {
        // error between our dead-reckoned position and the report, faded out over the next 3 s
        const jump = Math.hypot(nx - p.x, ny - p.y);
        if (jump > 3000) { p.x = nx; p.y = ny; p.z = nz ?? 0; p.ex = p.ey = p.ez = 0; }
        else { p.ex = nx - p.x; p.ey = ny - p.y; p.ez = nz == null ? 0 : nz - p.z; }
        const dTr = Math.atan2(Math.sin(tr - p.tr), Math.cos(tr - p.tr));
        p.roll = THREE.MathUtils.clamp((dTr / Math.max(1, now - p.t)) * 8, -0.45, 0.45);   // bank into the turn (rate-one turn ≈ 25°)
      }
      Object.assign(p, { call, type, reg, tr, gs, vr, onGround: alt < 0, t: now, alt, seen: now });
    }
    for (const [k, p] of planes) if (!seen.has(k) && now - p.seen > 40) planes.delete(k);
  }

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qr = new THREE.Quaternion(), X = new THREE.Vector3(1, 0, 0), e = new THREE.Euler(0, 0, 0, 'YZX'), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  function update(dt, nowMs) {
    if (!on) return;
    const now = nowMs / 1000, k = Math.min(1, dt / 3);
    let i = 0;
    beacons.begin();
    const addTrail = nowMs - lastTrail > 1500; if (addTrail) lastTrail = nowMs;
    let ti = 0;
    for (const p of planes.values()) {
      // dead reckoning + error blend
      p.x += Math.sin(p.tr) * p.gs * dt + p.ex * k; p.ex -= p.ex * k;
      p.y += Math.cos(p.tr) * p.gs * dt + p.ey * k; p.ey -= p.ey * k;
      const gz = ground.at(p.x, p.y);
      if (p.onGround) p.z = gz; else { p.z += p.vr * dt + p.ez * k; p.ez -= p.ez * k; p.z = Math.max(p.z, gz + 2); }
      p.roll *= 1 - Math.min(1, dt * 0.5);
      const pitch = p.onGround ? 0 : Math.atan2(p.vr, Math.max(40, p.gs));
      e.set(0, Math.PI / 2 - p.tr, pitch); q.setFromEuler(e);
      q.multiply(qr.setFromAxisAngle(X, p.roll));
      m.compose(v.set(p.x, p.z + 2.2, -p.y), q, one);
      if (i < MAX) { mesh.setMatrixAt(i, m); p.slot = i; i++; }
      beacons.push(p.x, p.z + 2.2, -p.y, p.onGround ? C_GROUND : C_AIR, p.onGround ? 0.7 : 1);
      if (addTrail && !p.onGround) { p.trail.push([p.x, p.z + 2.2, -p.y]); if (p.trail.length > TRAIL) p.trail.shift(); }
      const tl = p.trail, nT = tl.length;
      for (let j = 0; j + 1 < nT && ti < MAX * TRAIL; j++, ti++) {
        tpos.set(tl[j], ti * 6); tpos.set(j + 2 === nT ? [p.x, p.z + 2.2, -p.y] : tl[j + 1], ti * 6 + 3);
        talpha[ti * 2] = j / nT; talpha[ti * 2 + 1] = (j + 1) / nT;
      }
    }
    mesh.count = i; mesh.instanceMatrix.needsUpdate = true;
    beacons.end();
    tg.setDrawRange(0, ti * 2); tg.attributes.position.needsUpdate = true; tg.attributes.aAlpha.needsUpdate = true;
  }

  return {
    get on() { return on; },
    set(v) {
      on = v; group.visible = v;
      clearTimeout(timer);
      if (v) poll(); else { planes.clear(); mesh.count = 0; }
    },
    update,
    status() {
      if (!on) return '';
      if (error && !lastOk) return 'sem ligação ao ADS-B';
      const air = [...planes.values()].filter((p) => !p.onGround).length;
      return `ao vivo · ${air} no ar${planes.size - air ? ` · ${planes.size - air} em terra` : ''}`;
    },
    // tap-to-inspect: candidates with a scene position
    pickables() { return [...planes.values()].map((p) => ({ pos: [p.x, p.z + 2.2, -p.y], info: () => info(p) })); },
  };
  function info(p) {
    const ft = Math.round((p.z / 0.3048) / 100) * 100, kt = Math.round(p.gs / 0.5144);
    return {
      icon: '✈', title: p.call || p.reg || p.hex.toUpperCase(),
      sub: [p.type, p.reg].filter(Boolean).join(' · '),
      lines: p.onGround ? ['Em terra · aeroporto'] : [`${Math.round(p.z).toLocaleString('pt-PT')} m (${ft.toLocaleString('pt-PT')} ft)`, `${Math.round(p.gs * 3.6)} km/h (${kt} kt)${p.vr > 2 ? ' · a subir' : p.vr < -2 ? ' · a descer' : ''}`],
      src: 'ao vivo · ADS-B (adsb.lol)',
    };
  }
}
