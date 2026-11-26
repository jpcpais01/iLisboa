// Engine, tyres and knocks, synthesised (no samples to download). A four-cylinder's note is its firing rate
// (rpm / 30 Hz): two detuned oscillators through a low-pass that opens with throttle, an automatic gearbox
// (six ratios) so the pitch climbs and drops as it shifts. Tyre squeal is band-passed noise driven by slip.
export function createAudio() {
  let ctx = null, master, eng, tyre, tyreG, engG, filt, o1, o2, on = true;
  try { on = localStorage.getItem('ilisboa.drive.sound') !== '0'; } catch { /* private mode */ }
  const GEARS = [0, 13, 24, 36, 50, 64, 200];   // shift points, km/h
  let gear = 1, rpm = 900;

  function start() {
    if (ctx) { ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = on ? 0.55 : 0; master.connect(ctx.destination);
    filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 500; filt.Q.value = 2.5;
    engG = ctx.createGain(); engG.gain.value = 0.0;
    o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o2 = ctx.createOscillator(); o2.type = 'square';
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    o1.connect(filt); o2.connect(g2).connect(filt); filt.connect(engG).connect(master);
    o1.start(); o2.start();
    // noise for tyres and knocks
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    tyre = ctx.createBufferSource(); tyre.buffer = buf; tyre.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 6;
    tyreG = ctx.createGain(); tyreG.gain.value = 0;
    tyre.connect(bp).connect(tyreG).connect(master); tyre.start();
    eng = { buf };
  }
  function knock(k) {
    if (!ctx || !on) return;
    const s = ctx.createBufferSource(); s.buffer = eng.buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220 + 500 * k;
    const g = ctx.createGain(), t = ctx.currentTime;
    g.gain.setValueAtTime(0.9 * k, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    s.connect(lp).connect(g).connect(master); s.start(t, Math.random() * 0.5, 0.4);
  }
  function update(speed, throttle, slip, dt) {
    if (!ctx) return;
    const kmh = Math.abs(speed) * 3.6;
    while (gear < 6 && kmh > GEARS[gear] + 4) gear++;
    while (gear > 1 && kmh < GEARS[gear - 1] - 3) gear--;
    const lo = GEARS[gear - 1], hi = Math.min(GEARS[gear], 190), f = Math.min(1.1, (kmh - lo) / Math.max(1, hi - lo));
    const target = 850 + (throttle > 0.05 ? 900 * throttle : 0) + f * (gear === 1 ? 3600 : 2900) + (gear > 1 ? 1500 : 0) * (1 - f) * 0.6;
    rpm += (target - rpm) * Math.min(1, dt * 7);
    const t = ctx.currentTime, hz = rpm / 30;
    o1.frequency.setTargetAtTime(hz, t, 0.03); o2.frequency.setTargetAtTime(hz * 0.5 * 1.006, t, 0.03);
    filt.frequency.setTargetAtTime(300 + throttle * 1300 + rpm * 0.12, t, 0.05);
    engG.gain.setTargetAtTime(0.1 + throttle * 0.13, t, 0.06);
    tyreG.gain.setTargetAtTime(Math.min(0.22, Math.max(0, slip - 2.5) * 0.05), t, 0.05);
  }
  function stop() { if (ctx) { engG?.gain.setTargetAtTime(0, ctx.currentTime, 0.05); tyreG?.gain.setTargetAtTime(0, ctx.currentTime, 0.05); setTimeout(() => ctx?.suspend?.(), 300); } }
  return {
    start, stop, update, knock,
    get on() { return on; },
    toggle() { on = !on; try { localStorage.setItem('ilisboa.drive.sound', on ? '1' : '0'); } catch { /* */ } if (master) master.gain.value = on ? 0.55 : 0; return on; },
  };
}
