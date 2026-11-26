// Drive mode: take a car through the real streets, on the real (LiDAR) ground, over the bridges, into the walls.
// main.js owns the renderer and streaming; this module owns the car, its camera while driving, input, sound and HUD.
//   const drive = initDrive({ scene, camera, controls, canvas, waterY, uNight });
//   drive.update(dt, now) → true while driving (the viewer then renders every frame and skips its map controls)
// While driving, controls.target rides just ahead of the car, so the viewer's tile streaming and shadow fitting
// follow it with no extra hooks.
import * as THREE from 'three';
import { registerAction } from '../layers/registry.js';
import { createWorld } from './world.js';
import { createCar } from './physics.js';
import { createCarModel } from './model.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { loadNetwork, loadNames } from '../live/network.js';

const VIEWS = [
  { name: 'perto', dist: 6.8, pitch: 0.2, ahead: 3, fov: 58, overRoofs: false },
  { name: 'longe', dist: 14, pitch: 0.34, ahead: 5, fov: 54, overRoofs: true },
  { name: 'capô', h: 1.3, fov: 66, hood: true },
];

export function initDrive({ scene, camera, controls, canvas, chase, live, waterY = 0, uNight, home, ll }) {
  const world = createWorld(scene);
  const car = createCar(world);
  const model = createCarModel();
  const input = createInput(document.body);
  const audio = createAudio();
  let net = null, active = false, entering = 0, view = 0, headlights = null, saved = null, lastSafe = null, safeT = 0, waitT = 0, impactCool = 0;
  input.detach();

  // ─── HUD ───
  const hud = document.createElement('div');
  hud.className = 'drive-hud'; hud.hidden = true;
  hud.innerHTML = `
    <div class="bar">
      <button type="button" class="exit" aria-label="Sair da condução"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg><span>Sair</span></button>
      <span class="msg"></span>
      <button type="button" class="reset" aria-label="Voltar à estrada"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg></button>
      <button type="button" class="view" aria-label="Mudar de câmara"><svg viewBox="0 0 24 24"><path d="M3 8.5h3l2-2.5h8l2 2.5h3V19H3z"/><circle cx="12" cy="13" r="3.4"/></svg></button>
      <button type="button" class="snd" aria-label="Som"><svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="w" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg></button>
    </div>
    <div class="speedo"><b>0</b><small>km/h</small></div>
    <div class="road" hidden></div>
    <div class="keys">W / ↑ acelerar · S / ↓ travar e marcha-atrás · A D / ← → virar · Espaço travão de mão · C câmara · R estrada · Esc sair</div>`;
  document.body.appendChild(hud);
  const speedEl = hud.querySelector('.speedo b'), msgEl = hud.querySelector('.msg'), roadEl = hud.querySelector('.road');
  let names = null, roadT = 0, roadName = '';
  hud.querySelector('.exit').onclick = () => exit();
  hud.querySelector('.reset').onclick = () => respawn();
  hud.querySelector('.view').onclick = () => { view = (view + 1) % VIEWS.length; film(0.35); flash(`câmara: ${VIEWS[view].name}`); };
  const sndBtn = hud.querySelector('.snd');
  const paintSnd = () => sndBtn.classList.toggle('off', !audio.on);
  sndBtn.onclick = () => { audio.toggle(); paintSnd(); }; paintSnd();
  let msgT = 0;
  const flash = (t, s = 1.8) => { msgEl.textContent = t; msgEl.classList.add('in'); msgT = s; };

  // the entry button sits in the layer dock, next to the live layers
  const btn = registerAction({
    id: 'drive', label: 'Conduzir', run: () => (active ? exit() : enter()),
    icon: '<path d="M5 16.5v-4l1.8-4.6A2 2 0 0 1 8.7 6.6h6.6a2 2 0 0 1 1.9 1.3l1.8 4.6v4"/><path d="M4 12.5h16v4H4z"/><circle cx="7.6" cy="16.8" r="1.6"/><circle cx="16.4" cy="16.8" r="1.6"/>',
  });

  const onKey = (e) => {
    if (!active) return;
    if (e.code === 'Escape') exit();
    else if (e.code === 'KeyC') hud.querySelector('.view').click();
    else if (e.code === 'KeyR') respawn();
    else if (e.code === 'KeyM') sndBtn.click();
  };
  addEventListener('keydown', onKey);

  // ─── camera: the shared chase camera (orbit / pinch it, it eases back behind the car), or our own from the bonnet ───
  const f = new THREE.Vector3(), tmp = new THREE.Vector3(), q = new THREE.Quaternion(), e3 = new THREE.Euler(0, 0, 0, 'YXZ');
  const nudge = new THREE.Vector3();
  const cam = { shake: 0, aim: new THREE.Vector3(), pos: new THREE.Vector3() };
  const carView = () => ({ pos: car.s.p, heading: car.s.psi, speed: Math.abs(car.speed) });
  function film(fly = 1.3) {
    const V = VIEWS[view];
    if (V.hood) { chase.release(false); controls.enabled = false; camera.near = 0.25; camera.fov = V.fov; camera.updateProjectionMatrix(); return; }
    controls.enabled = true;
    chase.follow(carView, {
      // a portrait phone sees a narrow slice: step back and up so the street ahead shows above the car
      dist: V.dist * (camera.aspect < 1 ? 1.45 : 1) + V.ahead,   // the arm is measured from the aim point, which is ahead of the car
      minDist: 3.2, maxDist: 60, pitch: V.pitch + (camera.aspect < 1 ? 0.08 : 0), turn: 4.5, recenter: 1.6, fly,
      height: 1.15, lookAhead: V.ahead, distPerSpeed: 0.06, fov: V.fov, fovPerSpeed: 0.3, near: 0.25, clearance: 0.9,
      overRoofs: V.overRoofs, occlude: (a, b) => world.cast(a, b),
      inputExclude: (e) => !!e.target.closest?.('.drive-pads button, .drive-pads .wheel-zone, .drive-hud button'),
    });
  }
  function hoodCamera(dt) {
    const s = car.s, V = VIEWS[view];
    f.set(Math.cos(s.psi), 0, -Math.sin(s.psi));
    const up = Math.sin(s.pitch);
    cam.pos.set(s.p.x + f.x * 0.9, s.p.y + V.h + up * 0.9, s.p.z + f.z * 0.9);
    cam.aim.set(s.p.x + f.x * 30, s.p.y + 1.0 + up * 30, s.p.z + f.z * 30);
    camera.position.copy(cam.pos); camera.lookAt(cam.aim);
    const fov = V.fov + Math.min(14, Math.abs(car.speed) * 0.28);
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 4); camera.updateProjectionMatrix(); }
    controls.target.set(s.p.x + s.vel.x * 2, s.p.y, s.p.z + s.vel.z * 2);   // the tile streamer follows controls.target when nothing is chased
  }

  // ─── spawn: the street nearest the view, heading the way the view looks ───
  async function spot(x, z, prefer) {
    net = net || await loadNetwork().catch(() => null);
    const sn = net?.snap(x, -z, false, 400);
    if (!sn) return { x, z, psi: prefer };
    let hd = null;
    const E = net.edges?.[sn.e];
    if (E) { let j = 1; while (j < E.cum.length - 1 && E.cum[j] < sn.s) j++; const A = E.pts[j - 1], B = E.pts[j]; hd = Math.atan2(B[1] - A[1], B[0] - A[0]); }
    else {   // no edge geometry in this network build: probe the street direction with two nearby snaps
      const a = net.snap(sn.x + Math.cos(prefer) * 6, sn.y + Math.sin(prefer) * 6, false, 12);
      if (a) hd = Math.atan2(a.y - sn.y, a.x - sn.x);
    }
    let psi = hd ?? prefer;   // plan angle (x east, y north) is the same as the yaw ψ
    if (Math.cos(psi - prefer) < 0) psi += Math.PI;
    // keep right: 1.6 m off the centreline
    const rx = Math.sin(psi), rz = Math.cos(psi);
    return { x: sn.x + rx * 1.6, z: -sn.y + rz * 1.6, psi };
  }

  async function enter() {
    if (active) return;
    active = true; entering = 1.6; waitT = 0;
    btn.setActive(true);
    document.body.classList.add('driving');
    audio.start();
    saved = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, near: camera.near };
    camera.getWorldDirection(tmp);
    let x = controls.target.x, z = controls.target.z;
    const dist = camera.position.distanceTo(controls.target);
    if (dist > 3000 && home) { x = home.x; z = home.z; }   // from far out: start in the Baixa
    const sp = await spot(x, z, Math.atan2(-tmp.z, tmp.x));
    if (!active) return;
    car.place(sp.x, sp.z, sp.psi);
    lastSafe = { x: sp.x, z: sp.z, psi: sp.psi };
    scene.add(model.object);
    film();
    if (!headlights && uNight && uNight.value > 0.3) {   // after dusk only: a light changes every material's shader once
      headlights = new THREE.SpotLight(0xfff1d6, 0, 90, 0.5, 0.55, 1.4);
      model.chassis.add(headlights, headlights.target); headlights.position.set(2.0, 0.75, 0); headlights.target.position.set(14, -1.2, 0);
    }
    input.attach(); hud.hidden = false;
    flash(matchMedia('(pointer: coarse)').matches ? 'polegar esquerdo: volante · direito: pedais' : 'W A S D ou setas · Espaço travão de mão', 3.5);
  }
  function exit() {
    if (!active) return;
    active = false;
    btn.setActive(false);
    document.body.classList.remove('driving');
    input.detach(); hud.hidden = true; audio.stop();
    scene.remove(model.object);
    // pull up into the map view over where the car stopped
    controls.enabled = true;
    if (chase.active) chase.release();
    else {   // from the bonnet: straight up to a map view
      const s = car.s;
      controls.target.set(s.p.x, s.p.y, s.p.z);
      camera.position.set(s.p.x - Math.cos(s.psi) * 260, s.p.y + 230, s.p.z + Math.sin(s.psi) * 260);
      camera.lookAt(controls.target);
    }
    camera.fov = saved?.fov ?? 32; camera.near = saved?.near ?? 4; camera.updateProjectionMatrix();
  }
  function respawn() {
    const L = lastSafe; if (!L) return;
    spot(L.x, L.z, L.psi).then((sp) => { car.place(sp.x, sp.z, sp.psi); flash('de volta à estrada'); });
  }

  let shownKmh = -1;
  return {
    get active() { return active; },
    world,
    debug: () => { const s = car.s; return { p: [s.p.x, s.p.y, s.p.z].map((v) => +v.toFixed(1)), psi: +s.psi.toFixed(2), kmh: +(car.speed * 3.6).toFixed(1), ground: s.grounded, on: s.onGround, meshes: world.size, pend: world.pending, fps: window.__perf?.fps }; },
    addParked: (x, y, z, yaw) => world.addCar(x, y, z, yaw),
    enter, exit,
    // after the camera has been placed this frame: knocks shake the picture; the car steps out of the way of a camera
    // pushed right up to it (backed against a wall)
    afterCamera(dt) {
      if (!active) return;
      const p0 = camera.position.clone();
      if (cam.shake > 0.01) { camera.position.x += (Math.random() - 0.5) * cam.shake * 0.5; camera.position.y += (Math.random() - 0.5) * cam.shake * 0.4; cam.shake *= Math.exp(-dt * 9); }
      // never under the street: the chase camera's own ground is the live layers' height grid, which is only kept while they're on
      if (!VIEWS[view].hood) { const g = world.ground(camera.position.x, camera.position.z, camera.position.y + 60, 120, true); if (g && camera.position.y < g.y + 0.8) { camera.position.y = g.y + 0.8; camera.lookAt(controls.target); } }
      model.object.visible = VIEWS[view].hood || camera.position.distanceTo(car.s.p) > 2.6;
      nudge.subVectors(camera.position, p0);   // taken back out next frame, so the chase camera never reads it as the user's orbit
    },
    // checks: put the car on the highest surface at lat, lon (a bridge deck counts), heading in degrees from north
    teleport(lat, lon, hdg = 0) { const v = ll(lat, lon), psi = Math.PI / 2 - (hdg * Math.PI) / 180; car.place(v.x, v.z, psi); const g = world.ground(v.x, v.z, 400, 800); if (g) car.s.p.y = g.y; },
    update(dt, now) {
      if (!active) return false;
      const s = car.s;
      camera.position.sub(nudge); nudge.set(0, 0, 0);
      world.update(s.p, now, entering > 0 ? 12 : 6);
      if (!s.grounded) {   // the ground under the car is still streaming in: wait for it, then drop the car onto it
        waitT += dt;
        const g = world.ground(s.p.x, s.p.z, 400, 800, true);
        if (g) { s.p.y = g.y; s.grounded = true; s.onGround = true; }
        else if (waitT > 0.6) flash('a carregar as ruas…', 0.5);
      }
      const inp = input.update(dt);
      // the traffic around is solid too
      const near = live?.cars?.near?.(s.p.x, -s.p.z, 25);
      world.setMovers(near || []);
      if (s.grounded) car.update(entering > 0.8 ? { steer: 0, throttle: 0, brake: 0, handbrake: false } : inp, dt);
      entering = Math.max(0, entering - dt);

      // safety nets: fell in the river, stuck in a wall, or flipped off the world
      if (s.p.y < waterY - 1.6) { flash('splash! de volta à estrada'); respawn(); }
      if (s.stuck > 2.5) { s.stuck = 0; flash('preso? toque em ↺ ou R para voltar à estrada', 3); }
      safeT += dt;
      if (safeT > 1 && s.onGround && Math.abs(car.speed) > 3) { safeT = 0; lastSafe = { x: s.p.x, z: s.p.z, psi: s.psi }; }

      // pose the car: heading, slope, and a little body roll / dive from the forces
      f.set(Math.cos(s.psi), 0, -Math.sin(s.psi));
      model.object.position.copy(s.p);
      e3.set(0, s.psi, 0, 'YXZ'); model.object.quaternion.setFromEuler(e3);
      q.setFromEuler(new THREE.Euler(s.roll, 0, s.pitch, 'XYZ')); model.object.quaternion.multiply(q);
      const roll = THREE.MathUtils.clamp(s.latAcc * 0.007, -0.06, 0.06), dive = THREE.MathUtils.clamp(s.longAcc * 0.004, -0.035, 0.035);   // lean out of the turn, dive under braking
      model.chassis.rotation.x += (roll - model.chassis.rotation.x) * Math.min(1, dt * 8);
      model.chassis.rotation.z += (dive - model.chassis.rotation.z) * Math.min(1, dt * 8);
      const night = uNight ? uNight.value : 0;
      model.pose(s.steer, s.rolled, s.braking, night, s.reversing);
      if (headlights) headlights.intensity = 60 * night;

      // knocks: shake and thud
      impactCool -= dt;
      if (s.impact > 0.12 && impactCool <= 0) { cam.shake = Math.max(cam.shake, s.impact * 1.4); audio.knock(s.impact); navigator.vibrate?.(Math.round(20 + 60 * s.impact)); impactCool = 0.25; }
      s.impact = 0;
      audio.update(car.speed, inp.throttle, s.slip, dt);

      if (VIEWS[view].hood) hoodCamera(dt);
      else if (!chase.active) film();   // something else took the chase camera (tapped a bus): take it back

      // the street you're on, from the road graph's names
      if ((roadT -= dt) <= 0) {
        roadT = 0.6;
        if (!names) { names = []; loadNames().then((n) => { names = n; }).catch(() => {}); }
        const sn = net?.snap(s.p.x, -s.p.z, false, 14), nm = sn ? names[net.edges?.[sn.e]?.name] || '' : '';
        if (nm && nm !== roadName) { roadName = nm; roadEl.textContent = nm; roadEl.hidden = false; roadEl.classList.remove('in'); void roadEl.offsetWidth; roadEl.classList.add('in'); }
        else if (!sn) { roadName = ''; roadEl.hidden = true; }
      }
      const kmh = Math.round(Math.abs(car.speed) * 3.6);
      if (kmh !== shownKmh) { shownKmh = kmh; speedEl.textContent = kmh; }
      if (msgT > 0 && (msgT -= dt) <= 0) msgEl.classList.remove('in');
      return true;
    },
  };
}
