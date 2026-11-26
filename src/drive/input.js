// Driver input from every source at once, merged into { steer −1..1 (left +), throttle 0..1, brake 0..1, handbrake }.
//   phone   left thumb: a floating wheel anywhere in the lower-left (drag sideways to steer, it springs back);
//           right thumb: big accelerator, brake/reverse beside it, handbrake above. Multi-touch, no gestures.
//   keys    W/↑ gas, S/↓ brake & reverse, A D / ← → steer, Space handbrake
//   pad     left stick steer, RT gas, LT brake, A/✕ handbrake
// Keys and pedals are digital, so they ramp (≈0.2 s to full) instead of snapping: a tap is a gentle touch.
export function createInput(root) {
  const keys = new Set();
  const out = { steer: 0, throttle: 0, brake: 0, handbrake: false, any: false };
  const touch = { steer: 0, gas: false, brake: false, hand: false };
  let kSteer = 0, kGas = 0, kBrake = 0;

  const onKey = (e, down) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return false;
    const k = e.code;
    if (!/^(Key[WASD]|Arrow(Up|Down|Left|Right)|Space)$/.test(k)) return false;
    if (down) keys.add(k); else keys.delete(k);
    e.preventDefault();
    return true;
  };
  const kd = (e) => onKey(e, true), ku = (e) => onKey(e, false), blur = () => keys.clear();

  // ─── touch: wheel zone + pedals ───
  const ui = document.createElement('div');
  ui.className = 'drive-pads';
  ui.innerHTML = `
    <div class="wheel-zone"><div class="wheel" hidden><i></i></div><span class="hint">volante</span></div>
    <div class="pedals">
      <button type="button" class="hand" aria-label="Travão de mão"><svg viewBox="0 0 24 24"><path d="M6.5 6.5a8 8 0 0 0 0 11M17.5 6.5a8 8 0 0 1 0 11"/><path d="M10 16V8h2.6a2.4 2.4 0 0 1 0 4.8H10"/></svg></button>
      <button type="button" class="brake" aria-label="Travar e marcha-atrás"><svg viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="12" rx="2.5"/><path d="M8 10h8M8 14h8"/></svg></button>
      <button type="button" class="gas" aria-label="Acelerar"><svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="3"/><path d="M10 7h4M10 11h4M10 15h4"/></svg></button>
    </div>`;
  root.appendChild(ui);
  const zone = ui.querySelector('.wheel-zone'), wheel = ui.querySelector('.wheel'), knob = wheel.querySelector('i');
  let steerId = null, sx = 0, sy = 0;
  const RANGE = () => Math.min(90, innerWidth * 0.16);
  zone.addEventListener('pointerdown', (e) => {
    if (steerId !== null) return;
    steerId = e.pointerId; sx = e.clientX; sy = e.clientY; zone.setPointerCapture(e.pointerId);
    const r = zone.getBoundingClientRect();
    wheel.hidden = false; wheel.style.left = `${sx - r.left}px`; wheel.style.top = `${sy - r.top}px`; knob.style.transform = '';
    zone.classList.add('on'); e.preventDefault();
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== steerId) return;
    let dx = e.clientX - sx;
    const R = RANGE();
    if (Math.abs(dx) > R) { sx += dx - Math.sign(dx) * R; dx = Math.sign(dx) * R; }   // the wheel follows a thumb that overshoots
    const t = dx / R;
    touch.steer = -Math.sign(t) * Math.min(1, Math.abs(t) ** 1.35);              // finer near the centre
    knob.style.transform = `translateX(${dx}px) rotate(${t * 70}deg)`;
  });
  const endSteer = (e) => { if (e.pointerId !== steerId) return; steerId = null; touch.steer = 0; wheel.hidden = true; zone.classList.remove('on'); };
  zone.addEventListener('pointerup', endSteer); zone.addEventListener('pointercancel', endSteer);

  const pedal = (sel, key) => {
    const b = ui.querySelector(sel);
    const on = (e) => { touch[key] = true; b.classList.add('on'); try { b.setPointerCapture(e.pointerId); } catch { /* */ } e.preventDefault(); navigator.vibrate?.(8); };
    const off = () => { touch[key] = false; b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  };
  pedal('.gas', 'gas'); pedal('.brake', 'brake'); pedal('.hand', 'hand');

  const ramp = (v, target, dt, up = 5, down = 9) => (target > v ? Math.min(target, v + dt * up) : Math.max(target, v - dt * down));

  return {
    out,
    attach() { addEventListener('keydown', kd); addEventListener('keyup', ku); addEventListener('blur', blur); ui.hidden = false; },
    detach() { removeEventListener('keydown', kd); removeEventListener('keyup', ku); removeEventListener('blur', blur); keys.clear(); ui.hidden = true; Object.assign(touch, { steer: 0, gas: false, brake: false, hand: false }); },
    update(dt) {
      const L = keys.has('KeyA') || keys.has('ArrowLeft'), Rk = keys.has('KeyD') || keys.has('ArrowRight');
      const kS = (L ? 1 : 0) - (Rk ? 1 : 0);
      kSteer = kS ? ramp(kSteer * Math.sign(kS) > 0 ? kSteer : 0, kS, dt, 3.2, 3.2) : ramp(kSteer, 0, dt, 6, 6);
      kGas = ramp(kGas, keys.has('KeyW') || keys.has('ArrowUp') || touch.gas ? 1 : 0, dt);
      kBrake = ramp(kBrake, keys.has('KeyS') || keys.has('ArrowDown') || touch.brake ? 1 : 0, dt, 7, 12);
      let steer = kSteer + touch.steer, throttle = kGas, brake = kBrake, hand = keys.has('Space') || touch.hand;
      // gamepad (standard mapping)
      for (const p of navigator.getGamepads?.() || []) {
        if (!p || !p.connected) continue;
        const x = p.axes[0] || 0; if (Math.abs(x) > 0.12) steer -= Math.sign(x) * ((Math.abs(x) - 0.12) / 0.88) ** 1.3;
        throttle = Math.max(throttle, p.buttons[7]?.value || 0); brake = Math.max(brake, p.buttons[6]?.value || 0);
        hand = hand || !!p.buttons[0]?.pressed;
      }
      out.steer = Math.max(-1, Math.min(1, steer)); out.throttle = Math.min(1, throttle); out.brake = Math.min(1, brake); out.handbrake = hand;
      out.any = !!(out.steer || out.throttle || out.brake || hand);
      return out;
    },
  };
}
