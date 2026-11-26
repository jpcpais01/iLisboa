// Freguesias and Densidade: the real parish borders (OSM, imported from the official CAOP) standing on the terrain as
// glowing curtains, each parish softly filled in its own colour with its name, and a census choropleth of people per km²
// (INE Censos 2021). Tap anywhere on the map for that freguesia's card. Concelho borders stand taller.
import * as THREE from 'three';
import { createOverlay } from './overlay.js';
import { ramp, rampCss } from './palette.js';

const FILL = ['#f4a259', '#5b8e7d', '#bc4b51', '#8cb369', '#6c8ead', '#e9c46a', '#a77dc2'];   // 7 colours: neighbours never share
export const DENS_STOPS = ['#fff7d6', '#fde39a', '#fdbf6f', '#f98e52', '#e8553f', '#c22a4f', '#8a1a63', '#4f0f5e'];
const densF = (d) => Math.min(1, Math.max(0, Math.log10(Math.max(d, 1) / 1000) / Math.log10(25000 / 1000)));   // 1 000…25 000 /km², log
const nf = (n) => Math.round(n).toLocaleString('pt-PT');

export function createRegions({ ground, camera, controls, canvas, labelsF, labelsD, box, mobile, card }) {
  const ov = createOverlay(box, mobile ? 768 : 1024, mobile ? 600 : 800);
  const id = new Uint8Array(ov.W * ov.H);   // 0 = none, else 1 + index into frg
  let frg = [], conc = [], loaded = null, curtain = null, curtainVer = -1, curtainT = 0, sel = -1;
  let fregOn = false, densOn = false, painted = '';
  const uH = { value: 30 };

  async function load() {
    if (loaded) return loaded;
    loaded = fetch('/layers/freguesias.json').then((r) => r.json()).then((all) => {
      conc = all.filter((r) => r.lvl === 7);
      frg = all.filter((r) => r.lvl === 8).slice(0, 250);
      rasterise();
      for (const f of frg) {
        f.mun = conc.find((c) => insideAny(c, f.lx, f.ly))?.name || '';
        f.km2 = f.area / 1e6; f.dens = f.pop && f.km2 ? f.pop / f.km2 : null;
      }
      colour();
    });
    return loaded;
  }
  // even–odd over every ring of a region (holes included)
  function insideAny(r, x, y) {
    let c = false;
    for (const { p } of r.rings) for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if ((p[i + 1] > y) !== (p[j + 1] > y) && x < ((p[j] - p[i]) * (y - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
    }
    return c;
  }
  // scanline fill of each freguesia into the id raster; label point = the region's own cell nearest its cell centroid
  function rasterise() {
    const { W, H } = ov, xs = [];
    frg.forEach((f, fi) => {
      let y0 = Infinity, y1 = -Infinity;
      for (const { p } of f.rings) for (let k = 1; k < p.length; k += 2) { y0 = Math.min(y0, p[k]); y1 = Math.max(y1, p[k]); }
      const j0 = Math.max(0, Math.floor(((y0 - box[1]) / (box[3] - box[1])) * H)), j1 = Math.min(H - 1, Math.ceil(((y1 - box[1]) / (box[3] - box[1])) * H));
      let sx = 0, sy = 0, n = 0;
      for (let j = j0; j <= j1; j++) {
        const y = ov.y(j); xs.length = 0;
        for (const { p } of f.rings) for (let i = 0, k = p.length - 2; i < p.length; k = i, i += 2) {
          if ((p[i + 1] > y) !== (p[k + 1] > y)) xs.push(((p[k] - p[i]) * (y - p[i + 1])) / (p[k + 1] - p[i + 1]) + p[i]);
        }
        xs.sort((a, b) => a - b);
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const i0 = Math.max(0, Math.ceil(((xs[q] - box[0]) / (box[2] - box[0])) * W - 0.5)), i1 = Math.min(W - 1, Math.floor(((xs[q + 1] - box[0]) / (box[2] - box[0])) * W - 0.5));
          for (let i = i0; i <= i1; i++) { id[j * W + i] = fi + 1; sx += i; sy += j; n++; }
        }
      }
      f.cells = n;
      if (!n) { f.lx = f.rings[0].p[0]; f.ly = f.rings[0].p[1]; return; }
      let ci = sx / n, cj = sy / n, best = 1e18;
      for (let j = j0; j <= j1; j++) for (let i = 0; i < W; i++) if (id[j * W + i] === fi + 1) { const d = (i - ci) ** 2 + (j - cj) ** 2; if (d < best) { best = d; f.li = i; f.lj = j; } }
      f.lx = ov.x(f.li); f.ly = ov.y(f.lj);
    });
  }
  // greedy colouring on the raster's adjacency, biggest first
  function colour() {
    const { W, H } = ov, adj = frg.map(() => new Set());
    for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
      const a = id[j * W + i]; if (!a) continue;
      for (const b of [id[j * W + i + 1], id[(j + 1) * W + i]]) if (b && b !== a) { adj[a - 1].add(b - 1); adj[b - 1].add(a - 1); }
    }
    const order = frg.map((_, k) => k).sort((a, b) => adj[b].size - adj[a].size);
    for (const k of order) { const used = new Set([...adj[k]].map((n) => frg[n].c)); let c = 0; while (used.has(c)) c++; frg[k].c = c % FILL.length; }
  }
  function paint(mode) {
    const key = `${mode}|${sel}`; if (painted === key) return; painted = key;
    const cols = frg.map((f) => {
      const c = mode === 'dens' ? (f.dens ? ramp(DENS_STOPS, densF(f.dens)) : [200, 200, 200]) : ramp([FILL[f.c], FILL[f.c]], 0);
      return c;
    });
    const d = ov.data, { W, H } = ov;
    for (let k = 0; k < W * H; k++) {
      const a = id[k];
      if (!a) { d[k * 4 + 3] = 0; continue; }
      // a thin dark seam where the parish changes, so borders read even from straight above
      const i = k % W, edge = (i + 1 < W && id[k + 1] !== a) || (k + W < W * H && id[k + W] !== a) || (i > 0 && id[k - 1] !== a) || (k >= W && id[k - W] !== a);
      const c = cols[a - 1], s = a - 1 === sel;
      d[k * 4] = edge ? c[0] * 0.35 : c[0]; d[k * 4 + 1] = edge ? c[1] * 0.35 : c[1]; d[k * 4 + 2] = edge ? c[2] * 0.35 : c[2];
      d[k * 4 + 3] = mode === 'dens' ? (s ? 255 : 215) : edge ? 230 : s ? 200 : sel >= 0 ? 70 : 120;
    }
    ov.upload();
  }

  // ─── curtains: every border as a vertical band standing on the terrain, glowing at the foot, fading upwards ───
  function buildCurtains() {
    const pos = [], top = [], kk = [], col = [];
    const add = (r, lvl) => {
      const c = lvl === 7 ? [0.11, 0.3, 0.61] : [0.2, 0.45, 0.85], hk = lvl === 7 ? 1.8 : 1;   // azulejo cobalt; concelhos darker and taller
      for (const { p } of r.rings) {
        for (let i = 0; i + 3 < p.length; i += 2) {
          const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3], L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / 40));
          for (let s = 0; s < n; s++) {
            const x0 = ax + ((bx - ax) * s) / n, y0 = ay + ((by - ay) * s) / n, x1 = ax + ((bx - ax) * (s + 1)) / n, y1 = ay + ((by - ay) * (s + 1)) / n;
            const z0 = Math.max(0, ground.at(x0, y0)) - 2, z1 = Math.max(0, ground.at(x1, y1)) - 2;
            pos.push(x0, z0, -y0, x1, z1, -y1, x1, z1, -y1, x0, z0, -y0, x1, z1, -y1, x0, z0, -y0);
            top.push(0, 0, 1, 0, 1, 1);
            for (let q = 0; q < 6; q++) kk.push(hk);
            for (let q = 0; q < 6; q++) col.push(...c);
          }
        }
      }
    };
    for (const f of frg) add(f, 8);
    for (const c of conc) add(c, 7);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1));
    g.setAttribute('aK', new THREE.Float32BufferAttribute(kk, 1));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    if (!curtain) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uH }, transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexColors: true,
        vertexShader: /* glsl */`
          attribute float aTop, aK; uniform float uH; varying float vT; varying vec3 vC;
          void main() { vec3 p = position; p.y += aTop * aK * uH; vT = aTop; vC = color;
            gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.); }`,
        fragmentShader: /* glsl */`
          varying float vT; varying vec3 vC;
          void main() { float a = .62 * pow(1. - vT, 1.8) + .5 * smoothstep(.9, 1., vT); gl_FragColor = vec4(mix(vC, vec3(1.), vT * .35), a); }`,
      });
      curtain = new THREE.Mesh(g, mat); curtain.frustumCulled = false; curtain.renderOrder = 4; curtain.name = 'freguesias';
      scene.add(curtain);
    } else { curtain.geometry.dispose(); curtain.geometry = g; }
    curtainVer = ground.version; curtainT = performance.now();
  }

  function setLabels() {
    labelsF.set([
      ...frg.filter((f) => f.cells > 30).map((f) => ({ x: f.lx, y: f.ly, z: ground.at(f.lx, f.ly) + 40, maxD: 7500, cls: 'frg', html: `<b>${f.name}</b>${f.pop ? `<span>${nf(f.pop)} hab.</span>` : ''}`, onClick: () => select(frg.indexOf(f)) })),
      ...conc.map((c) => { const f = frg.find((q) => q.mun === c.name && q.cells > 30); return f ? { x: f.lx, y: f.ly + 300, z: ground.at(f.lx, f.ly) + 120, minD: 7000, maxD: 30000, cls: 'conc', html: `<b>${c.name}</b>` } : null; }).filter(Boolean),
    ]);
    labelsD.set(frg.filter((f) => f.cells > 30 && f.dens).map((f) => ({ x: f.lx, y: f.ly, z: ground.at(f.lx, f.ly) + 40, maxD: 7500, cls: 'frg dens', html: `<b>${nf(f.dens)}</b><span>${f.name}</span>`, onClick: () => select(frg.indexOf(f)) })));
  }

  function select(k) {
    sel = k; painted = '';
    if (k < 0) { card.hide(); return; }
    const f = frg[k], rank = f.dens ? frg.filter((q) => q.dens && q.dens > f.dens).length + 1 : null, nDens = frg.filter((q) => q.dens).length;
    card.show({
      title: f.name, sub: f.mun ? `freguesia · ${f.mun}` : 'freguesia',
      rows: [
        f.pop ? ['População', `${nf(f.pop)}`] : null,
        ['Área', `${f.km2.toLocaleString('pt-PT', { maximumFractionDigits: 2 })} km²`],
        f.dens ? ['Densidade', `${nf(f.dens)} hab./km²`] : null,
        rank ? ['', `${rank}.ª mais densa de ${nDens} no mapa`] : null,
      ].filter(Boolean),
      src: `${f.popSrc || 'Censos 2021'} · limites OSM/CAOP`, onClose: () => { sel = -1; painted = ''; },
    });
  }
  // a tap on the map (not on a vehicle, landmark or label) picks the freguesia under it
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function groundHit(cx, cy) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    if (d.y > -1e-3) return null;
    let h = 0, t = 0;
    for (let it = 0; it < 4; it++) { t = (h - o.y) / d.y; h = Math.max(0, ground.at(o.x + d.x * t, -(o.z + d.z * t))); }
    return [o.x + d.x * t, -(o.z + d.z * t)];
  }
  // the vehicle card (src/live) answers taps first; if it changed, this tap was a vehicle's
  const liveCard = () => document.querySelector('.live-card:not([hidden])')?.innerHTML || '';
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), card: liveCard() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!(fregOn || densOn) || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 400) return;
    const cx = e.clientX, cy = e.clientY, before = down.card;
    // after the other tap handlers had their turn (vehicles, landmarks): they claim the tap
    setTimeout(() => {
      if (window.__tapClaimed?.() || window.__chase?.active || window.__drive?.active) return;
      const now = liveCard(); if (now && now !== before) return;
      const p = groundHit(cx, cy); if (!p) return;
      const i = Math.floor(((p[0] - box[0]) / (box[2] - box[0])) * ov.W), j = Math.floor(((p[1] - box[1]) / (box[3] - box[1])) * ov.H);
      const a = i >= 0 && j >= 0 && i < ov.W && j < ov.H ? id[j * ov.W + i] : 0;
      select(a ? (a - 1 === sel ? -1 : a - 1) : -1);
    }, 0);
  });

  let scene = null;
  const mode = () => (densOn ? 'dens' : 'fill');
  function sync() {
    const any = fregOn || densOn;
    if (curtain) curtain.visible = any;
    labelsF.show(fregOn && !densOn); labelsD.show(densOn);
    if (!any) { ov.hide(fill); ov.hide(dens); if (sel >= 0) select(-1); }
  }
  const fill = {}, dens = {};   // overlay owners
  async function ensure() {
    await load();
    if (!curtain) buildCurtains();
    setLabels(); sync();
  }
  const densLegend = document.createElement('div'); densLegend.className = 'wx-legend';
  densLegend.innerHTML = `<div class="bar" style="background:${rampCss(DENS_STOPS)}"></div><div class="ends"><span>1 000</span><span>5 000</span><span>25 000 hab./km²</span></div><small>residentes por km² de freguesia · INE Censos 2021</small>`;

  return {
    attach(s) { scene = s; },
    freguesias: {
      get on() { return fregOn; },
      status: () => (fregOn && frg.length ? `${frg.length} freguesias` : ''),
      set(v) { fregOn = v; if (v) ensure(); else { ov.hide(fill); sync(); } },
    },
    densidade: {
      get on() { return densOn; }, legend: densLegend,
      status: () => (densOn && frg.length ? 'Censos 2021' : ''),
      set(v) {
        densOn = v; painted = '';
        if (v) ensure().then(() => { if (densOn) { paint('dens'); ov.show(dens, { k: 0.72, mode: 1 }); } });
        else { ov.hide(dens); sync(); }
      },
    },
    update() {
      if (!(fregOn || densOn) || !frg.length) return;
      const dist = camera.position.distanceTo(controls.target);
      uH.value = THREE.MathUtils.clamp(dist * 0.011, 10, 110);
      if (ground.version !== curtainVer && performance.now() - curtainT > 15000) buildCurtains();
      // the soft fill takes the overlay whenever no map (temperature, rain, density) holds it
      const m = mode();
      if (m === 'dens') { paint('dens'); if (!ov.owns(dens)) ov.show(dens, { k: 0.72, mode: 1 }); }
      else if (fregOn && ov.idle()) { paint('fill'); ov.show(fill, { k: 0.42, mode: 1 }); }
      else if (fregOn && ov.owns(fill)) paint('fill');
    },
  };
}
