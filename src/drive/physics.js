// Car dynamics: a kinematic-bicycle car with tyre grip, run at a fixed 120 Hz. Arcade enough for a thumb on a phone,
// physical enough that Lisbon's hills matter (gravity along the slope, you crest a hill and go light, you can't
// floor it up Calçada da Glória as fast as down it). Ground and walls come from the world (the drawn meshes).
//
// Frame: three.js world, y up. Heading ψ is the yaw about +y; the nose points along f = (cos ψ, 0, −sin ψ), the
// right side along r = (sin ψ, 0, cos ψ). Positive steer turns left (ψ grows).
import * as THREE from 'three';
import { CAR_DIM } from './model.js';

const G = 9.81, STEP = 1 / 120;
const TOP = 47;          // m/s ≈ 170 km/h on the flat
const REV_TOP = 9;       // m/s reverse
const ACCEL = 7.2;       // m/s² from rest, fades towards TOP
const BRAKE = 12;        // m/s²
const GRIP = 9;          // 1/s: how fast sideways slip dies on tarmac
const SPHERES = [1.45, 0, -1.45];   // collision spheres along the car (m from centre), radius R, 1 m up
const R = 0.92, HUB = 1.0;

export function createCar(world) {
  const s = {
    p: new THREE.Vector3(), vel: new THREE.Vector3(), psi: 0, yawRate: 0, steer: 0, vy: 0,
    onGround: false, pitch: 0, roll: 0, rolled: 0, braking: 0, reversing: false, slip: 0, impact: 0, airT: 0,
    latAcc: 0, longAcc: 0, lastV: 0, groundN: new THREE.Vector3(0, 1, 0), stuck: 0, grounded: false,
  };
  let acc = 0;
  const f = new THREE.Vector3(), r = new THREE.Vector3(), c = new THREE.Vector3();

  function place(x, z, psi) {
    s.psi = psi; s.vel.set(0, 0, 0); s.yawRate = 0; s.vy = 0; s.steer = 0; s.airT = 0;
    const g = world.ground(x, z, 400, 800, true);
    s.p.set(x, g ? g.y : 0, z); s.grounded = !!g; s.onGround = !!g;
  }

  // wheel contact heights → ride height, pitch, roll
  const wh = [0, 0, 0, 0], WX = [CAR_DIM.axleF, CAR_DIM.axleF, CAR_DIM.axleR, CAR_DIM.axleR], WZ = [-CAR_DIM.track / 2, CAR_DIM.track / 2, -CAR_DIM.track / 2, CAR_DIM.track / 2];
  function sample() {
    f.set(Math.cos(s.psi), 0, -Math.sin(s.psi)); r.set(Math.sin(s.psi), 0, Math.cos(s.psi));
    let n = 0, sum = 0;
    for (let i = 0; i < 4; i++) {
      const x = s.p.x + f.x * WX[i] + r.x * WZ[i], z = s.p.z + f.z * WX[i] + r.z * WZ[i];
      const g = world.ground(x, z, s.p.y + 0.75, 40);   // from just above a kerb: a parapet rail or a bench is not road
      wh[i] = g ? g.y : NaN; if (g) { sum += g.y; n++; }
    }
    if (!n) return null;
    const avg = sum / n;
    for (let i = 0; i < 4; i++) if (Number.isNaN(wh[i])) wh[i] = avg;
    const front = (wh[0] + wh[1]) / 2, rear = (wh[2] + wh[3]) / 2, left = (wh[0] + wh[2]) / 2, right = (wh[1] + wh[3]) / 2;
    return { y: Math.max(avg, (front + rear) / 2), pitch: Math.atan2(front - rear, CAR_DIM.wheelbase), roll: Math.atan2(left - right, CAR_DIM.track) };
  }

  function step(inp, dt) {
    f.set(Math.cos(s.psi), 0, -Math.sin(s.psi)); r.set(Math.sin(s.psi), 0, Math.cos(s.psi));
    let vf = s.vel.dot(f), vl = s.vel.dot(r);
    const speed = Math.abs(vf);

    // steering: full lock at parking speed, gentle at speed (≈ the lateral grip limit), eased so taps don't twitch
    const lock = 0.62 / (1 + (speed / 17) ** 2) + 0.04;
    s.steer += (inp.steer * lock - s.steer) * Math.min(1, dt * (inp.steer ? 7 : 10));

    // longitudinal: engine (fading with speed), brakes, reverse once stopped, gravity along the slope, drag
    let a = 0;
    const gas = inp.throttle, brk = inp.brake;
    s.reversing = false; s.braking = 0;
    if (gas > 0) { if (vf < -0.4) { a += BRAKE * gas; s.braking = gas; } else a += ACCEL * gas * Math.max(0, 1 - (Math.max(0, vf) / TOP) ** 1.6); }
    if (brk > 0) {
      if (vf > 0.4) { a -= BRAKE * brk; s.braking = brk; }
      else if (!gas) { a -= 4.2 * brk * Math.max(0, 1 + vf / REV_TOP); s.reversing = true; }
    }
    if (s.onGround) {
      a -= G * Math.sin(s.pitch) * 0.85;                                     // Lisbon's hills
      a -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, 0.18 + 0.0011 * vf * vf * 1.4 + (inp.handbrake ? 3.5 : 0));   // rolling + air drag (+ handbrake)
    } else a -= 0.0004 * vf * Math.abs(vf);
    if (!gas && !brk && s.onGround && speed < 0.25 && Math.abs(Math.sin(s.pitch)) < 0.12) { vf = 0; a = 0; }   // parked on the flat stays put
    vf += a * dt;

    // lateral: tyres kill sideways slip (much less with the handbrake up, almost none in the air)
    const grip = !s.onGround ? 0.15 : inp.handbrake ? 1.4 : GRIP * (speed > 30 ? 0.85 : 1);
    s.slip = Math.abs(vl);
    vl *= Math.exp(-grip * dt);

    // yaw: the bicycle model's rate, followed quickly on tarmac; the handbrake lets the tail come round
    const target = (vf * Math.tan(s.steer)) / CAR_DIM.wheelbase * (inp.handbrake && speed > 4 ? 1.45 : 1);
    s.yawRate += (target - s.yawRate) * Math.min(1, dt * (s.onGround ? 11 : 0.6));
    s.psi += s.yawRate * dt;

    s.vel.copy(f).multiplyScalar(vf).addScaledVector(r, vl);
    s.p.x += s.vel.x * dt; s.p.z += s.vel.z * dt;
    s.longAcc = a; s.latAcc = vf * s.yawRate;

    // vertical: follow the ground while it doesn't fall away faster than gravity; otherwise fly
    const g = sample();
    if (g) {
      const gap = s.p.y - g.y;
      if (s.onGround) {
        const vyG = (g.y - s.p.y) / dt;
        if (vyG < s.vy - G * dt * 1.6 && gap > -0.05 && speed > 6) { s.onGround = false; s.vy = Math.max(s.vy, 0); }   // crest: go light
        else { s.p.y = g.y; s.vy = THREE.MathUtils.clamp(vyG, -20, 20); }
      }
      if (!s.onGround) {
        s.vy -= G * dt; s.p.y += s.vy * dt; s.airT += dt;
        if (s.p.y <= g.y) { s.impact = Math.max(s.impact, Math.min(1, -s.vy / 8)); s.p.y = g.y; s.vy = 0; s.onGround = true; s.airT = 0; }
      }
      s.pitch += (g.pitch - s.pitch) * Math.min(1, dt * (s.onGround ? 18 : 2));
      s.roll += (g.roll - s.roll) * Math.min(1, dt * (s.onGround ? 18 : 2));
      s.grounded = true;
    } else { s.vy = 0; s.grounded = false; }   // nothing loaded under the car yet: hold height

    // walls: push each sphere out of the building meshes, lose the speed into the wall, scrape along it
    let hitAny = false;
    for (const off of SPHERES) {
      c.set(s.p.x + f.x * off, s.p.y + HUB, s.p.z + f.z * off);
      const w = world.wall(c, R);
      if (!w) continue;
      hitAny = true;
      s.p.x += w.nx * w.depth; s.p.z += w.nz * w.depth;
      const vn = s.vel.x * w.nx + s.vel.z * w.nz;
      if (vn < 0) {
        s.impact = Math.max(s.impact, Math.min(1, -vn / 14));
        s.vel.x -= w.nx * vn * 1.3; s.vel.z -= w.nz * vn * 1.3;           // a little bounce
        s.vel.multiplyScalar(1 - Math.min(0.25, -vn * 0.02));              // scrape
        s.yawRate *= 0.6;
      }
    }
    s.stuck = hitAny && gas > 0 && speed < 1 ? s.stuck + dt : Math.max(0, s.stuck - dt);
    s.rolled += s.vel.dot(f) * dt;
  }

  return {
    s, place,
    update(inp, dt) {
      acc = Math.min(acc + dt, 0.1);
      const v0 = s.vel.dot(f);
      while (acc >= STEP) { step(inp, STEP); acc -= STEP; }
      s.lastV = v0;
    },
    get forward() { return f; },
    get speed() { return s.vel.dot(f); },
  };
}
