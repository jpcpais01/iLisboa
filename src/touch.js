// Touch navigation in the style of Google / Apple Maps 3D.
//   one finger      drag the ground (the point under the finger stays under it)
//   two fingers     pinch = zoom about the pinch centre, twist = rotate, move = pan — all at once
//   two fingers ↑↓  side by side, moved vertically together = tilt
//   double tap      zoom in there; double tap then drag ↕ = one-handed zoom
//   two-finger tap  zoom out
// Every gesture is anchored: the world point under the fingers' centroid is solved for exactly each event
// (rigid rotation and scaling about that point keep it fixed on screen, a pan puts it back under the fingers),
// so fingers can be added or lifted at any time with no jump. Releasing with speed flings (pan, twist, pinch).
// Mouse input is left to MapControls; it is only switched off while a finger is down.
// While the chase camera follows something (orbit() true) one finger orbits round it instead of panning: drag sideways to
// circle, up and down to tilt. Pinch, twist and the two-finger tilt work as always; any pan is undone by the chase.
import * as THREE from 'three';

const ROT_ENGAGE = 0.14;   // rad of twist before rotation kicks in (stops a pinch from wobbling the heading)
const TILT_ENGAGE = 9;     // px both fingers must travel vertically together to start a tilt
const FLING_WINDOW = 110;  // ms of motion used to measure release speed
const FLING_STALE = 60;    // a finger resting this long before lift means no fling
const TAP_MS = 260, TAP_PX = 10, DTAP_MS = 320, DTAP_PX = 45;

export function initTouch({ camera, controls, canvas, onStart = () => {}, orbit = () => false, exclude = () => false }) {
  const pts = new Map();             // pointerId → { x, y, x0, y0 }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), dir = new THREE.Vector3();
  const W = new THREE.Vector3(), P = new THREE.Vector3(), d3 = new THREE.Vector3(), sph = new THREE.Spherical();
  let mode = 'none';                 // none | free | tilt | tapzoom
  let prev = null;                   // { cx, cy, dist, ang } at the last applied event
  let rotOn = false, rotAcc = 0, scaleAcc = 0, maxN = 0, twoDownT = 0, moved = false, tiltStart = null;
  let samples = [], saved = null, lastTap = null, downT = 0, tz = null;
  const vel = { x: 0, z: 0, rot: 0, zoom: 0, W: new THREE.Vector3() };
  let anim = null, wasActive = false;

  // ─── geometry ───
  const planeY = () => controls.target.y;
  function ground(cx, cy, out) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    ray.setFromCamera(ndc, camera);
    dir.copy(ray.ray.direction);
    dir.y = Math.min(dir.y, -0.1);   // rays near the horizon are bent down: the far ground can't fling to infinity
    const t = (planeY() - camera.position.y) / dir.y;
    return out.copy(camera.position).addScaledVector(dir, t);
  }
  const shift = (dx, dz) => { camera.position.x += dx; camera.position.z += dz; controls.target.x += dx; controls.target.z += dz; };
  function rotateAbout(c, a) {        // rigid yaw of the camera about the vertical through c
    const s = Math.sin(a), k = Math.cos(a);
    for (const v of [camera.position, controls.target]) {
      const x = v.x - c.x, z = v.z - c.z;
      v.x = c.x + x * k - z * s; v.z = c.z + x * s + z * k;
    }
    camera.lookAt(controls.target);
  }
  function scaleAbout(c, f) {         // homothety about c (on the ground plane): zoom without moving c on screen
    const dist = camera.position.distanceTo(controls.target);
    const nd = THREE.MathUtils.clamp(dist * f, controls.minDistance, controls.maxDistance);
    f = nd / dist;
    for (const v of [camera.position, controls.target]) v.sub(c).multiplyScalar(f).add(c);
    return Math.log(f);
  }
  function tilt(dPhi) {
    d3.subVectors(camera.position, controls.target);
    sph.setFromVector3(d3);
    sph.phi = THREE.MathUtils.clamp(sph.phi + dPhi, 0.02, controls.maxPolarAngle);
    camera.position.copy(controls.target).add(d3.setFromSpherical(sph));
    camera.lookAt(controls.target);
  }

  // ─── gesture state ───
  function snapshot() {
    const a = [...pts.values()];
    const cx = a.reduce((s, p) => s + p.x, 0) / a.length, cy = a.reduce((s, p) => s + p.y, 0) / a.length;
    if (a.length < 2) return { cx, cy, dist: 0, ang: 0 };
    return { cx, cy, dist: Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y), ang: Math.atan2(a[1].y - a[0].y, a[1].x - a[0].x) };
  }
  function rebase() {                 // finger set changed: new anchor under the new centroid, nothing moves
    prev = snapshot();
    ground(prev.cx, prev.cy, W);
    for (const p of pts.values()) { p.x0 = p.x; p.y0 = p.y; }
    tiltStart = null;
  }
  const stopMotion = () => { vel.x = vel.z = vel.rot = vel.zoom = 0; anim = null; };

  function applyFree(now) {
    const s = snapshot();
    if (pts.size === 1 && orbit()) {   // following: one finger orbits (same feel as MapControls' rotate drag)
      const h = canvas.clientHeight || innerHeight, a = (2 * Math.PI * (s.cx - prev.cx)) / h * 0.85;
      rotateAbout(controls.target, a);
      tilt((-2 * Math.PI * (s.cy - prev.cy)) / h * 0.6);
      samples.push({ t: now, dx: 0, dz: 0, dRot: a, dLog: 0 });
      while (samples.length && now - samples[0].t > FLING_WINDOW) samples.shift();
      prev = s;
      return;
    }
    let dRot = 0, dLog = 0;
    if (pts.size >= 2 && prev.dist > 0) {
      let da = s.ang - prev.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
      rotAcc += da;
      if (!rotOn && Math.abs(rotAcc) > ROT_ENGAGE) rotOn = true;     // engages from here: no catch-up jump
      else if (rotOn) { rotateAbout(W, -da); dRot = -da; }
      if (s.dist > 0) { dLog = scaleAbout(W, prev.dist / s.dist); scaleAcc += dLog; }
    }
    ground(s.cx, s.cy, P);
    const dx = W.x - P.x, dz = W.z - P.z;
    shift(dx, dz);
    samples.push({ t: now, dx, dz, dRot, dLog });
    while (samples.length && now - samples[0].t > FLING_WINDOW) samples.shift();
    prev = s;
  }

  function tryTilt() {                // two fingers side by side moving the same way vertically → tilt mode
    if (pts.size !== 2 || rotOn || Math.abs(scaleAcc) > 0.12) return false;
    const [a, b] = [...pts.values()];
    const dya = a.y - a.y0, dyb = b.y - b.y0, dxa = a.x - a.x0, dxb = b.x - b.x0;
    const side = Math.abs(Math.atan2(b.y - a.y, b.x - a.x));
    const sideBySide = side < 0.9 || side > Math.PI - 0.9;
    if (!sideBySide || Math.sign(dya) !== Math.sign(dyb)) return false;
    if (Math.min(Math.abs(dya), Math.abs(dyb)) < TILT_ENGAGE) return false;
    if (Math.abs(dxa) > Math.abs(dya) * 0.7 || Math.abs(dxb) > Math.abs(dyb) * 0.7) return false;
    return true;
  }

  // ─── events (window, capture phase: runs before MapControls and leaves the canvas listeners intact) ───
  function down(e) {
    if (e.pointerType !== 'touch' || e.target !== canvas || exclude(e)) return;
    controls.enabled = false;         // MapControls ignores touch from here on
    onStart();
    if (!pts.size) {
      stopMotion(); samples = []; saved = null; rotOn = false; rotAcc = 0; scaleAcc = 0; maxN = 0; moved = false; downT = e.timeStamp;
      controls.dispatchEvent({ type: 'start' });
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    maxN = Math.max(maxN, pts.size);
    if (pts.size === 2) twoDownT = e.timeStamp;
    if (pts.size === 1 && lastTap && e.timeStamp - lastTap.t < DTAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DTAP_PX) {
      mode = 'tapzoom'; tz = { y: e.clientY, y0: e.clientY, active: false }; ground(e.clientX, e.clientY, W); lastTap = null;
      return;
    }
    if (mode === 'tilt' && pts.size > 2) mode = 'free';
    if (mode !== 'tilt') mode = 'free';
    rebase();
  }
  function move(e) {
    const p = pts.get(e.pointerId);
    if (!p) return;
    // coalesced events: the latest is what matters for an anchored solve
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_PX) moved = true;
    if (mode === 'tapzoom') {
      if (!tz.active && Math.abs(p.y - tz.y0) > 6) { tz.active = true; tz.y = p.y; }
      if (tz.active) { scaleAbout(W, Math.exp(-(p.y - tz.y) * 0.009)); tz.y = p.y; }
      return;
    }
    if (mode === 'free' && tryTilt()) { mode = 'tilt'; samples = []; tiltStart = snapshot(); }
    if (mode === 'tilt') {
      const s = snapshot();
      tilt(-(s.cy - tiltStart.cy) * (Math.PI / innerHeight) * 0.9);
      tiltStart = s;
      return;
    }
    applyFree(e.timeStamp);
  }
  function up(e) {
    const p = pts.get(e.pointerId);
    if (!p) return;
    pts.delete(e.pointerId);
    const now = e.timeStamp;            // event time, not handling time: a janky frame must not kill a fling
    if (pts.size) {                    // a finger left, others stay: keep going from where they are
      if (mode === 'tapzoom') mode = 'free';
      if (pts.size === 1 && mode === 'tilt') mode = 'free';
      saved = { samples, t: now }; samples = [];
      rebase();
      return;
    }
    controls.enabled = true;
    const quick = e.timeStamp - downT < TAP_MS && !moved;
    if (mode === 'tapzoom') {
      if (!tz.active) zoomTo(W, 0.5);                                    // double tap: zoom in ×2 at the tap
    } else if (quick && maxN === 2 && e.timeStamp - twoDownT < TAP_MS) {
      ground(prev.cx, prev.cy, W); zoomTo(W, 2);                         // two-finger tap: zoom out ×2
    } else if (mode === 'free') {
      fling(now);
      if (quick && maxN === 1) lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    }
    mode = 'none';
    if (!anim && !flinging()) controls.dispatchEvent({ type: 'end' });
  }

  function fling(now) {
    let s = samples;
    // both fingers of a pinch lifted a few ms apart: use the two-finger motion, not the last finger's wobble
    if (saved && now - saved.t < 80 && s.reduce((a, q) => a + Math.abs(q.dx) + Math.abs(q.dz), 0) < 1e-3) s = saved.samples;
    if (!s.length) return;
    const last = s[s.length - 1].t;
    if (now - last > FLING_STALE + (s === samples ? 0 : 80)) return;
    const span = Math.max(16, last - s[0].t) / 1000;
    const sum = s.reduce((a, q) => ({ x: a.x + q.dx, z: a.z + q.dz, r: a.r + q.dRot, l: a.l + q.dLog }), { x: 0, z: 0, r: 0, l: 0 });
    const dist = camera.position.distanceTo(controls.target), vmax = dist * 4;
    vel.x = sum.x / span; vel.z = sum.z / span;
    const sp = Math.hypot(vel.x, vel.z);
    if (sp > vmax) { vel.x *= vmax / sp; vel.z *= vmax / sp; }
    if (sp < dist * 0.05) vel.x = vel.z = 0;
    vel.rot = THREE.MathUtils.clamp(sum.r / span, -4, 4); if (Math.abs(vel.rot) < 0.15) vel.rot = 0;
    vel.zoom = THREE.MathUtils.clamp(sum.l / span, -3, 3); if (Math.abs(vel.zoom) < 0.25) vel.zoom = 0;
    vel.W.copy(W);
  }
  const flinging = () => vel.x || vel.z || vel.rot || vel.zoom;
  function zoomTo(c, f) { stopMotion(); anim = { c: c.clone(), left: Math.log(f), t: 0 }; }

  // ─── per frame: fling and animated zooms ───
  function update(dt) {
    let active = false;
    if (anim) {
      let step = anim.left * (1 - Math.exp(-dt * 14));               // ease-out
      if (Math.abs(anim.left) < 0.004) step = anim.left;
      const applied = scaleAbout(anim.c, Math.exp(step));
      anim.left -= step;
      if (Math.abs(anim.left) < 1e-4 || Math.abs(applied) < 1e-6) anim = null;  // done, or at the zoom limit
      active = true;
    } else if (flinging() && !pts.size) {
      const dist = camera.position.distanceTo(controls.target);
      if (vel.x || vel.z) {
        const dx = vel.x * dt, dz = vel.z * dt; shift(dx, dz); vel.W.x += dx; vel.W.z += dz;
        const f = Math.exp(-dt * 3.2); vel.x *= f; vel.z *= f;
        if (Math.hypot(vel.x, vel.z) < dist * 0.02) vel.x = vel.z = 0;
      }
      if (vel.rot) { rotateAbout(vel.W, vel.rot * dt); vel.rot *= Math.exp(-dt * 4.5); if (Math.abs(vel.rot) < 0.02) vel.rot = 0; }
      if (vel.zoom) { scaleAbout(vel.W, Math.exp(vel.zoom * dt)); vel.zoom *= Math.exp(-dt * 6); if (Math.abs(vel.zoom) < 0.02) vel.zoom = 0; }
      active = true;
    }
    if (wasActive && !active && !pts.size) controls.dispatchEvent({ type: 'end' });
    wasActive = active;
    return active || pts.size > 0;
  }

  addEventListener('pointerdown', down, true);
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', up, true);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());            // long-press menu
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault()); // iOS page zoom
  // a mouse wheel or drag also cancels any fling
  canvas.addEventListener('wheel', stopMotion, { passive: true });
  canvas.addEventListener('mousedown', stopMotion);
  return { update, get busy() { return pts.size > 0 || !!anim || !!flinging(); } };
}
