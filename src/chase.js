// Third-person chase camera, shared by "follow a plane / bus / tram" and the drive mode.
//
// The camera stays glued to the thing it follows: every frame the orbit target is put exactly on it (no positional spring,
// so nothing drifts at any speed) and the camera keeps an offset from it. That offset is the user's: they orbit, tilt and
// pinch it with the usual mouse and touch gestures (pan is off), and it is carried round as the vehicle turns, smoothed, so
// the view swings in behind a bus at a corner instead of snapping. A ground callback keeps the camera above the terrain, an
// optional occlusion callback pulls it in front of walls, and focus() tells the tile streamer where the view is heading.
//
//   const chase = createChase({ camera, controls, ground: (x, yNorth) => metres })
//   chase.follow(getter, opts)   getter() → { pos: Vector3 (scene), heading: yaw about +Y (0 = nose along +x), speed?: m/s } | null
//   chase.update(dt)             once per frame, after the controls have applied this frame's input
//   chase.release()              eases back out to a map view over where the vehicle was; the controls get their settings back
import * as THREE from 'three';

const Y = new THREE.Vector3(0, 1, 0);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const DEFAULTS = {
  dist: 70, minDist: 20, maxDist: 4000, pitch: 0.5,   // arm length (m) and elevation above the vehicle's horizon (rad)
  turn: 2.2,               // 1/s: how fast the offset swings round with the vehicle's heading (0 = keep a fixed compass view)
  fov: null, fovPerSpeed: 0, near: null, distPerSpeed: 0, lookAhead: 0, height: 0,
  recenter: 0,             // s of no input after which the camera eases back behind the vehicle (0 = never)
  clearance: 5,            // m the camera keeps above the ground
  overRoofs: true,         // with a roofs(x, yNorth) height callback: tilt up until the vehicle is not hidden behind roofs
  occlude: null,           // (aim: Vector3, cam: Vector3) → distance to the first wall in between, or null
  inputExclude: null,      // (PointerEvent) → true: this touch never moves the camera (drive pedals)
  fly: 1.3,                // s of the swoop in
  onLost: null,
};

export function createChase({ camera, controls, ground = () => 0, roofs = null }) {
  let get = null, o = null, saved = null, fly = null, out = null;
  let yaw = 0, base = 70, extra = 0, speed = 0, fovNow = camera.fov, idle = 0, lift = 0, lastT = 0;
  const uDir = new THREE.Vector3();
  const aim = new THREE.Vector3(), prevPos = new THREE.Vector3(), vel = new THREE.Vector3(), applied = new THREE.Vector3(), dir = new THREE.Vector3();
  const cur = new THREE.Vector3(), goalCam = new THREE.Vector3(), tmp = new THREE.Vector3(), lead = new THREE.Vector3(), focusPt = { x: 0, y: 0, d: 0 };

  function aimAt(s, out) {   // the orbit point: the vehicle, or a little ahead of / above it
    out.copy(s.pos);
    if (o.lookAhead) out.add(tmp.set(Math.cos(s.heading), 0, -Math.sin(s.heading)).multiplyScalar(o.lookAhead));
    out.y += o.height;
    return out;
  }
  function behind(heading, pitch, len, out) {
    const h = Math.cos(pitch) * len;
    return out.set(-Math.cos(heading) * h, Math.sin(pitch) * len, Math.sin(heading) * h);
  }
  function restore() {
    if (!saved) return;
    Object.assign(controls, { enablePan: saved.enablePan, zoomToCursor: saved.zoomToCursor, minDistance: saved.minDistance, maxDistance: saved.maxDistance });
    controls.mouseButtons.LEFT = saved.left;
    if (camera.fov !== saved.fov || camera.near !== saved.near) { camera.fov = saved.fov; camera.near = saved.near; camera.updateProjectionMatrix(); }
    saved = null;
  }

  function follow(getter, opts = {}) {
    const s = getter();
    if (!s) return false;
    if (!saved) saved = { enablePan: controls.enablePan, zoomToCursor: controls.zoomToCursor, minDistance: controls.minDistance, maxDistance: controls.maxDistance, left: controls.mouseButtons.LEFT, fov: camera.fov, near: camera.near };
    get = getter; o = { ...DEFAULTS, ...opts }; out = null;
    controls.enablePan = false; controls.zoomToCursor = false; controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.minDistance = o.minDist; controls.maxDistance = o.maxDist;
    if (o.near != null && camera.near !== o.near) { camera.near = o.near; camera.updateProjectionMatrix(); }
    fovNow = camera.fov;
    yaw = s.heading; base = o.dist; extra = 0; idle = 0; lift = 0; speed = s.speed ?? 0; lastT = performance.now();
    behind(yaw, o.pitch, 1, uDir);
    prevPos.copy(s.pos); vel.set(0, 0, 0);
    behind(yaw, o.pitch, base, applied);
    fly = { t: 0, cam: camera.position.clone(), tgt: controls.target.clone() };
    return true;
  }

  function release(viewFrom) {
    if (!get) return;
    get = null; fly = null;
    restore();
    // a short glide up and back to a map view over the last position (the vehicle may be in the air or underground)
    const g = ground(aim.x, -aim.z), t1 = aim.clone(); t1.y = g;
    const d = THREE.MathUtils.clamp(camera.position.distanceTo(aim) * 2.5, 300, 2500);
    tmp.subVectors(camera.position, aim).setY(0); if (tmp.lengthSq() < 1) tmp.set(0, 0, 1);
    tmp.normalize().multiplyScalar(d * Math.sin(0.85)); tmp.y = d * Math.cos(0.85);
    out = viewFrom === false ? null : { t: 0, cam: camera.position.clone(), tgt: controls.target.clone(), cam1: t1.clone().add(tmp), tgt1: t1 };
  }

  const ease = (t) => 1 - (1 - t) ** 3;
  function update(dt) {
    if (out) {   // gliding back out after a release
      out.t = Math.min(1, out.t + dt / 1.1); const e = ease(out.t);
      camera.position.lerpVectors(out.cam, out.cam1, e); controls.target.lerpVectors(out.tgt, out.tgt1, e); camera.lookAt(controls.target);
      if (out.t >= 1) out = null;
      return true;
    }
    if (!get || !dt) return !!get;
    const s = get();
    if (!s) { const cb = o.onLost; release(); cb?.(); return true; }

    // motion: speed (the source's, else measured) and a lead for the streamer
    // measured on the wall clock: the frame dt is capped at 0.1 s, the vehicles move in real time
    const t = performance.now(), rdt = Math.max(1e-3, (t - lastT) / 1000); lastT = t;
    tmp.subVectors(s.pos, prevPos); prevPos.copy(s.pos);
    if (tmp.lengthSq() < 4e6 && rdt < 2) vel.lerp(tmp.divideScalar(rdt), 1 - Math.exp(-rdt * 2));   // a teleport (new GPS fix far away) is not speed
    speed = s.speed != null && s.speed >= 0 ? s.speed : Math.hypot(vel.x, vel.z);

    // the user's offset (uDir, base): changed only when the controls or fingers moved the camera since last frame. Our own
    // adjustments (speed extra, roof lift, occlusion pull-in, ground clearance) are applied on top and never stick.
    if (!fly) {
      cur.subVectors(camera.position, controls.target);
      const L = cur.length(), La = applied.length();
      if (cur.distanceToSquared(applied) > 1e-4 * La * La) {
        idle = 0;
        base = THREE.MathUtils.clamp(L * (base / Math.max(1e-3, La)), o.minDist, o.maxDist);
        uDir.copy(cur).normalize();
      } else idle += dt;
    } else behind(yaw, o.pitch, 1, uDir);
    // swing round with the vehicle
    if (o.turn) {
      const dy = wrap(s.heading - yaw), step = speed > 0.5 || fly ? dy * (1 - Math.exp(-dt * o.turn)) : 0;
      yaw += step; uDir.applyAxisAngle(Y, step);
    } else yaw = s.heading;
    if (o.recenter && idle > o.recenter && !fly) {   // ease back to straight behind after the user lets go
      behind(yaw, o.pitch, 1, tmp);
      uDir.lerp(tmp, 1 - Math.exp(-dt * 1.6)).normalize();
    }
    extra = o.distPerSpeed * speed;
    let len = base + extra;
    aimAt(s, aim);
    dir.copy(uDir);
    // rise over the roofs: the lowest elevation from which the line to the vehicle clears every roof along the arm (narrow
    // Alfama streets need a steep view; an open avenue keeps the user's own). Rises quickly, settles back slowly.
    if (roofs && o.overRoofs) {
      const a0 = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), hx = dir.x, hz = dir.z, hl = Math.hypot(hx, hz) || 1, span = len * Math.cos(a0);
      let need = -Infinity;
      for (let d = 9; d < span; d += Math.max(3, span / 48)) {
        const r = roofs(aim.x + (hx / hl) * d, -(aim.z + (hz / hl) * d));
        if (r > -Infinity) need = Math.max(need, Math.atan2(r + 2 - aim.y, d));
      }
      need = Math.min(need, 1.3);
      const want = Math.max(0, need - a0);
      lift += (want - lift) * (1 - Math.exp(-dt * (want > lift ? 5 : 0.8)));
      if (lift > 1e-3) {
        const a = Math.min(1.35, a0 + lift);
        dir.set((hx / hl) * Math.cos(a), Math.sin(a), (hz / hl) * Math.cos(a));
      }
    }
    if (o.occlude) {
      goalCam.copy(aim).addScaledVector(dir, len);
      const hit = o.occlude(aim, goalCam);
      if (hit != null && hit < len) len = Math.max(o.near ?? 1, hit - 0.4);
    }
    goalCam.copy(aim).addScaledVector(dir, len);
    const gy = ground(goalCam.x, -goalCam.z) + o.clearance;
    if (goalCam.y < gy) goalCam.y = gy;
    if (o.fov != null || o.fovPerSpeed) {
      const f = (o.fov ?? saved.fov) + o.fovPerSpeed * speed;
      fovNow += (f - fovNow) * (1 - Math.exp(-dt * 3));
      if (Math.abs(camera.fov - fovNow) > 0.01) { camera.fov = fovNow; camera.updateProjectionMatrix(); }
    }

    if (fly) {   // swoop in: from wherever the map view was to the chase position, rising over anything in between
      fly.t = Math.min(1, fly.t + dt / o.fly); const e = ease(fly.t);
      controls.target.lerpVectors(fly.tgt, aim, e);
      camera.position.lerpVectors(fly.cam, goalCam, e);
      camera.position.y += Math.sin(Math.PI * e) * Math.min(400, fly.cam.distanceTo(goalCam) * 0.25);
      if (fly.t >= 1) fly = null;
    } else {
      controls.target.copy(aim); camera.position.copy(goalCam);
    }
    applied.subVectors(camera.position, controls.target);
    camera.lookAt(controls.target);
    return true;
  }

  return {
    follow, release, update,
    get active() { return !!get; },
    get busy() { return !!get || !!out; },
    get speed() { return speed; },
    // where tiles should stream: a few seconds ahead of the vehicle, on the ground, with a view distance that accounts for its
    // height above the ground (a plane at 3 km sees a wide area even with the camera 150 m behind it)
    focus() {
      if (!get) return null;
      lead.copy(vel).setY(0).multiplyScalar(4); if (lead.length() > 700) lead.setLength(700);
      const x = aim.x + lead.x, z = aim.z + lead.z, agl = Math.max(0, aim.y - ground(aim.x, -aim.z));
      focusPt.x = x; focusPt.y = -z; focusPt.d = Math.max(camera.position.distanceTo(controls.target), agl * 1.3);
      focusPt.gy = ground(x, -z);
      return focusPt;
    },
    exclude(e) { return !!(get && o.inputExclude && o.inputExclude(e)); },
  };
}
