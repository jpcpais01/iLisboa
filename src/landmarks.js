// Landmarks: every building OpenStreetMap links to Wikipedia / Wikidata (public/landmarks.json, from pipeline/landmarks.mjs).
// Hover one (or press it with a finger) and it lights up: a warm wash over its own walls and roofs plus a halo along its
// silhouette, both drawn from the very triangles the city shows. Tap it and the camera flies round to frame it while a
// card brings the Wikipedia summary, photo and a link.
//
// Picking needs no extra geometry: the pointer's ray is marched through the roof-height raster the live layers already keep
// (ground.roofAt, filled from the drawn building meshes), and the first roof it passes under is looked up in the
// landmark outlines. A wall of an ordinary building in front blocks it, as it should.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { claimTap, tapClaimed, setProbe } from './pick.js';

const PT = /^pt/i.test((navigator.languages && navigator.languages[0]) || navigator.language || 'pt');
const T = PT
  ? { read: 'Ler na Wikipédia', loading: 'A carregar…', none: 'Sem artigo na Wikipédia', close: 'Fechar', wd: 'Ver no Wikidata', src: 'Wikipédia · CC BY-SA' }
  : { read: 'Read on Wikipedia', loading: 'Loading…', none: 'No Wikipedia article', close: 'Close', wd: 'View on Wikidata', src: 'Wikipedia · CC BY-SA' };
const LANGS = PT ? ['pt', 'en'] : ['en', 'pt'];

const GOLD = new THREE.Color(1.0, 0.72, 0.32);

// ─── glow materials: a wash over the surfaces (fresnel-weighted, a sweep rises on selection) and a halo shell ───
const washMat = () => new THREE.ShaderMaterial({
  uniforms: { uCol: { value: GOLD }, uK: { value: 0 }, uSweep: { value: -1 }, uY: { value: new THREE.Vector2(0, 1) } },
  vertexShader: `varying vec3 vN; varying vec3 vV; varying float vH;
    uniform vec2 uY;
    void main() { vec4 w = modelMatrix * vec4(position, 1.); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz);
      vH = clamp((w.y - uY.x) / max(1., uY.y - uY.x), 0., 1.); gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `varying vec3 vN; varying vec3 vV; varying float vH; uniform vec3 uCol; uniform float uK; uniform float uSweep;
    void main() { float f = pow(1. - abs(dot(normalize(vN), vV)), 2.);
      float s = uSweep < 0. ? 0. : exp(-pow((vH - uSweep) * 9., 2.)) * (1. - uSweep * .5);
      gl_FragColor = vec4(uCol * uK * (.16 + .5 * f + .22 * vH + 1.1 * s), 1.); }`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthFunc: THREE.LessEqualDepth,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, toneMapped: false, fog: false,
});
const haloMat = () => new THREE.ShaderMaterial({
  uniforms: { uCol: { value: GOLD }, uK: { value: 0 }, uW: { value: 1 } },
  vertexShader: `uniform float uW; varying float vF;
    void main() { vec3 n = normalize(normal); vec4 w = modelMatrix * vec4(position + n * uW, 1.);
      vec3 v = normalize(cameraPosition - w.xyz); vF = 1. - abs(dot(normalize(mat3(modelMatrix) * n), v)); gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform vec3 uCol; uniform float uK; varying float vF;
    void main() { gl_FragColor = vec4(uCol * uK * (.55 + .6 * vF), 1.); }`,
  side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
});

export function initLandmarks({ scene, camera, controls, canvas, ground, chase, drive, invalidate, mobile = false }) {
  // ─── data ───
  let groups = [], grid = new Map();
  const GC = 100, gk = (i, j) => i * 100003 + j;
  fetch('/landmarks.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d) return;
    const byKey = new Map();
    for (const it of d.items) {
      const [id, name, nameEn, wd, wp, kind, cx, cy] = it, ring = new Float32Array(it.length - 8);
      for (let k = 8; k < it.length; k += 2) { ring[k - 8] = cx + it[k] / 2; ring[k - 7] = cy + it[k + 1] / 2; }
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < ring.length; k += 2) { bb[0] = Math.min(bb[0], ring[k]); bb[1] = Math.min(bb[1], ring[k + 1]); bb[2] = Math.max(bb[2], ring[k]); bb[3] = Math.max(bb[3], ring[k + 1]); }
      const key = wd || wp || id;
      let g = byKey.get(key);
      if (!g) { g = { key, id, name, nameEn, wd, wp, kind, parts: [], bb: [Infinity, Infinity, -Infinity, -Infinity], area: 0, glow: null }; byKey.set(key, g); groups.push(g); }
      if (!g.name && name) g.name = name;
      const part = { ring, bb, area: Math.abs(ringArea(ring)), g };
      g.parts.push(part); g.area += part.area;
      for (let k = 0; k < 4; k++) g.bb[k] = k < 2 ? Math.min(g.bb[k], bb[k]) : Math.max(g.bb[k], bb[k]);
      for (let i = Math.floor(bb[0] / GC); i <= Math.floor(bb[2] / GC); i++) for (let j = Math.floor(bb[1] / GC); j <= Math.floor(bb[3] / GC); j++) {
        const c = gk(i, j); (grid.get(c) || grid.set(c, []).get(c)).push(part);
      }
    }
    ground.roofAt(0, 0);   // wake the roof raster now, so the first hover already finds its building
  }).catch(() => {});

  function at(x, y) {   // the smallest landmark outline holding (x, y): a chapel inside a palace's grounds wins over the grounds
    let best = null;
    for (const p of grid.get(gk(Math.floor(x / GC), Math.floor(y / GC))) || []) {
      if (x < p.bb[0] || x > p.bb[2] || y < p.bb[1] || y > p.bb[3] || !inRing(p.ring, x, y)) continue;
      if (!best || p.area < best.area) best = p;
    }
    return best && best.g;
  }

  // ─── picking: march the pointer ray through the roof raster ───
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), P = new THREE.Vector3();
  function pick(clientX, clientY) {
    if (!groups.length) return null;
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, d = ray.ray.direction, TOP = 330;
    let t = 0;
    if (o.y > TOP) { if (d.y >= 0) return null; t = (o.y - TOP) / -d.y; }
    for (let n = 0; n < 6000 && t < 14000; n++) {
      P.copy(o).addScaledVector(d, t);
      if (P.y < ground.at(P.x, -P.z) - 2) return null;            // reached open ground first
      const roof = ground.roofAt(P.x, -P.z);
      if (P.y <= roof) {
        // the raster is a little generous at the edges: look a few metres on into the building for the outline
        for (let k = 0; k <= 8; k++) { P.copy(o).addScaledVector(d, t + k * 0.75); const g = at(P.x, -P.z); if (g) return g; }
        return null;                                               // an ordinary building is in the way
      }
      t += Math.min(6, Math.max(0.8, t * 0.0012));
    }
    return null;
  }

  setProbe('landmark', (x, y) => (blocked() ? null : pick(x, y)));

  // ─── glow geometry: the building's own triangles, cut out of every loaded tile mesh by its outline ───
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _box = new THREE.Box3();
  function buildingMeshes() { const out = []; scene.traverse((o) => { if (o.isMesh && o.name.startsWith('buildings') && !o.userData.farMerged) out.push(o); }); return out; }
  function glowFor(g) {
    const meshes = buildingMeshes().filter((m) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      _box.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      return !(_box.max.x < g.bb[0] - 2 || _box.min.x > g.bb[2] + 2 || -_box.max.z > g.bb[3] + 2 || -_box.min.z < g.bb[1] - 2);
    });
    const sig = meshes.map((m) => m.uuid).join();
    if (g.glow && g.glow.sig === sig) return g.glow;
    if (g.glow) disposeGlow(g.glow);
    const pos = [];
    for (const m of meshes) {
      m.updateWorldMatrix(true, false);
      const G = m.geometry, A = G.attributes.position, I = G.index, n = I ? I.count : A.count, M = m.matrixWorld;
      for (let t = 0; t < n; t += 3) {
        _a.fromBufferAttribute(A, I ? I.getX(t) : t).applyMatrix4(M);
        _b.fromBufferAttribute(A, I ? I.getX(t + 1) : t + 1).applyMatrix4(M);
        _c.fromBufferAttribute(A, I ? I.getX(t + 2) : t + 2).applyMatrix4(M);
        const x = (_a.x + _b.x + _c.x) / 3, y = -(_a.z + _b.z + _c.z) / 3;
        if (x < g.bb[0] - 1 || x > g.bb[2] + 1 || y < g.bb[1] - 1 || y > g.bb[3] + 1) continue;
        if (!g.parts.some((p) => inRing(p.ring, x, y) || ringDist(p.ring, x, y) < 0.6)) continue;
        pos.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z);
      }
    }
    const glow = { sig, wash: null, halo: null, box: new THREE.Box3() };
    if (pos.length) {
      let geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo = mergeVertices(geo, 0.05); geo.computeVertexNormals();   // shared, averaged normals: the halo shell inflates without gaps at corners
      geo.computeBoundingBox(); glow.box.copy(geo.boundingBox);
      glow.wash = new THREE.Mesh(geo, washMat()); glow.halo = new THREE.Mesh(geo, haloMat());
      for (const o of [glow.wash, glow.halo]) { o.frustumCulled = false; o.renderOrder = 10; o.matrixAutoUpdate = false; o.userData.noPick = true; }
      glow.wash.material.uniforms.uY.value.set(glow.box.min.y, glow.box.max.y);
    }
    g.glow = glow;
    return glow;
  }
  function disposeGlow(gl) { for (const o of [gl.wash, gl.halo]) if (o) { o.parent?.remove(o); o.material.dispose(); } gl.wash?.geometry.dispose(); }

  // lit = { g, k (current), want (target), sweep } — hover and selection each hold one
  const lit = new Map();
  function light(g, want, sweep = false) {
    if (!g) return;
    const gl = glowFor(g);
    if (!gl.wash) return;
    let L = lit.get(g);
    if (!L) { L = { g, k: 0, want, sweep: -1 }; lit.set(g, L); }
    if (!gl.wash.parent) scene.add(gl.wash, gl.halo);
    L.want = want; if (sweep) L.sweep = 0;
    invalidate();
  }
  function unlight(g) { const L = g && lit.get(g); if (L) { L.want = 0; invalidate(); } }

  // ─── state ───
  let hover = null, pressed = null, selected = null, ptr = null, ptrDirty = false, fly = null;
  const blocked = () => chase.active || drive.active;
  const setHover = (g) => {
    if (g === hover) return;
    if (hover && hover !== selected) unlight(hover);
    hover = g;
    if (g && g !== selected) light(g, 0.75);
    canvas.style.cursor = g ? 'pointer' : '';
  };

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') { if (pressed && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { unlightPress(); } return; }
    ptr = e.buttons ? null : { x: e.clientX, y: e.clientY }; ptrDirty = true;
  });
  canvas.addEventListener('pointerleave', () => { ptr = null; ptrDirty = true; });
  let down = null, fingers = 0;
  const unlightPress = () => { if (pressed && pressed !== selected && pressed !== hover) unlight(pressed); pressed = null; };
  canvas.addEventListener('pointerdown', (e) => {
    fly = null;   // any touch takes the camera back
    if (e.pointerType === 'touch') fingers++;
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    if (e.pointerType === 'mouse') { setHover(null); return; }
    // a finger has no hover: the building under it lights up as it goes down, and goes out if the finger starts to drag
    if (fingers > 1 || blocked()) { unlightPress(); return; }
    const g = pick(e.clientX, e.clientY);
    unlightPress();
    if (g && g !== selected) { pressed = g; light(g, 0.85); }
  });
  const lift = (e) => { if (e.pointerType === 'touch') fingers = Math.max(0, fingers - 1); };
  canvas.addEventListener('pointercancel', (e) => { lift(e); unlightPress(); });
  // runs after the live layers' own pointerup (registered earlier): a vehicle under the finger wins
  canvas.addEventListener('pointerup', (e) => {
    lift(e);
    const p = pressed; pressed = null;
    const tap = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 6 && e.timeStamp - down.t <= 450;
    down = null;
    if (!tap || blocked() || tapClaimed()) { if (p && p !== selected) unlight(p); return; }
    const g = p || pick(e.clientX, e.clientY);
    if (g) { claimTap('landmark'); select(g); }
    else if (selected) { claimTap('landmark'); deselect(); }
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && selected) deselect(); });

  // ─── fly to frame it ───
  function frame(g) {
    const box = g.glow && g.glow.wash ? g.glow.box : null;
    const c = new THREE.Vector3(), size = new THREE.Vector3();
    if (box) { box.getCenter(c); box.getSize(size); }
    else { c.set((g.bb[0] + g.bb[2]) / 2, ground.at((g.bb[0] + g.bb[2]) / 2, (g.bb[1] + g.bb[3]) / 2) + 10, -(g.bb[1] + g.bb[3]) / 2); size.set(g.bb[2] - g.bb[0], 20, g.bb[3] - g.bb[1]); }
    const r = Math.max(14, 0.5 * Math.hypot(size.x, size.y, size.z));
    const vf = THREE.MathUtils.degToRad(camera.fov) / 2, hf = Math.atan(Math.tan(vf) * camera.aspect);
    let dist = (r / Math.sin(Math.min(vf, hf))) * (mobile ? 1.3 : 1.2);
    dist = THREE.MathUtils.clamp(dist, Math.max(controls.minDistance, 90), controls.maxDistance * 0.9);
    // keep the bearing the viewer already has; look down at ~35° (lower for tall, slender things)
    const off = new THREE.Vector3().subVectors(camera.position, controls.target); off.y = 0;
    if (off.lengthSq() < 1) off.set(0, 0, 1);
    off.normalize();
    const tall = size.y / Math.max(8, Math.hypot(size.x, size.z));
    const pitch = THREE.MathUtils.degToRad(tall > 1.2 ? 22 : tall > 0.6 ? 30 : 38);
    const target = c.clone(); target.y = (box ? box.min.y : c.y) + size.y * (tall > 1.2 ? 0.5 : 0.35);
    const pos = target.clone().addScaledVector(off, Math.cos(pitch) * dist); pos.y += Math.sin(pitch) * dist;
    // the card covers part of the screen: aim off-centre so the building sits in the free space
    // (phone: the sheet takes the bottom, so the building goes up; desktop: the card is on the left, so it goes right)
    const fwd = new THREE.Vector3().subVectors(target, pos).normalize(), perPx = (2 * Math.tan(vf) * dist) / Math.max(1, canvas.clientHeight);
    if (mobile || canvas.clientWidth < 600) {
      const up = new THREE.Vector3(0, 1, 0).sub(fwd.clone().multiplyScalar(fwd.y)).normalize();
      const shift = up.multiplyScalar(-canvas.clientHeight * 0.21 * perPx); target.add(shift); pos.add(shift);
    } else {
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const shift = right.multiplyScalar(-Math.min(200, canvas.clientWidth * 0.15) * perPx); target.add(shift); pos.add(shift);
    }
    pos.y = Math.max(pos.y, ground.at(pos.x, -pos.z) + 25);
    const from = { p: camera.position.clone(), t: controls.target.clone() };
    const travel = from.t.distanceTo(target);
    fly = { from, to: { p: pos, t: target }, u: 0, dur: THREE.MathUtils.clamp(0.9 + travel / 2500, 1.1, 2.4), arc: Math.min(1200, travel * 0.25) };
  }
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

  // ─── card ───
  const card = document.createElement('aside');
  card.className = 'lm-card'; card.hidden = true; card.setAttribute('aria-live', 'polite');
  document.body.appendChild(card);
  const cache = new Map();
  function select(g) {
    if (selected && selected !== g) unlight(selected);
    selected = g; if (pressed === g) pressed = null;
    light(g, 1, true);
    frame(g);
    document.querySelector('.live-card:not(.follow)')?.setAttribute('hidden', '');
    render(g, null);
    info(g).then((i) => { if (selected === g) render(g, i); });
    window.__pickedLandmark = g.key;
  }
  function deselect() {
    if (selected && selected !== hover) unlight(selected);
    selected = null; card.hidden = true; card.classList.remove('in');
    window.__pickedLandmark = null;
  }
  function render(g, i) {
    const name = (i && i.title) || (!PT && g.nameEn) || g.name;
    const img = i && i.img ? `<div class="ph"><img src="${esc(i.img)}" alt="" loading="eager" decoding="async"></div>` : (i ? '' : '<div class="ph sk"></div>');
    const body = !i ? `<p class="ex sk">${T.loading}</p>`
      : i.extract ? `<p class="ex">${esc(i.extract)}</p>` : `<p class="ex none">${T.none}</p>`;
    const link = i && i.url ? `<a class="go" href="${esc(i.url)}" target="_blank" rel="noopener">${i.wd ? T.wd : T.read}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>` : '';
    card.innerHTML = `${img}<div class="tx"><b class="ti">${esc(name)}</b>${i && i.desc ? `<small>${esc(i.desc)}</small>` : ''}${body}<div class="ft">${link}${i && i.url && !i.wd ? `<em>${T.src}</em>` : ''}</div></div>`
      + `<button type="button" class="x" aria-label="${T.close}">×</button>`;
    card.querySelector('.x').onclick = deselect;
    const im = card.querySelector('.ph img'); if (im) im.onerror = () => im.parentElement.remove();
    if (card.hidden) { card.hidden = false; requestAnimationFrame(() => card.classList.add('in')); }
  }

  // Wikidata → the article in the viewer's language (else the other one) → its REST summary
  async function info(g) {
    if (cache.has(g.key)) return cache.get(g.key);
    const job = (async () => {
      let titles = {}, desc = '', label = '';
      if (g.wd) {
        try {
          const u = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${g.wd}&props=sitelinks|descriptions|labels&sitefilter=ptwiki|enwiki&languages=pt|en&format=json&origin=*`;
          const e = (await (await fetch(u)).json()).entities?.[g.wd];
          for (const l of LANGS) if (e?.sitelinks?.[`${l}wiki`]) titles[l] = e.sitelinks[`${l}wiki`].title;
          desc = e?.descriptions?.[LANGS[0]]?.value || e?.descriptions?.[LANGS[1]]?.value || '';
          label = e?.labels?.[LANGS[0]]?.value || '';
        } catch { /* offline: fall through to the OSM link */ }
      }
      if (g.wp) { const m = g.wp.match(/^([a-z-]+):(.+)$/); if (m && !titles[m[1]]) titles[m[1]] = m[2]; }
      for (const l of [...LANGS, ...Object.keys(titles)]) {
        if (!titles[l]) continue;
        try {
          const r = await fetch(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titles[l].replace(/ /g, '_'))}?redirect=true`);
          if (!r.ok) continue;
          const s = await r.json();
          if (s.type === 'disambiguation') continue;
          return { title: s.title, desc: s.description || desc, extract: s.extract, img: s.thumbnail?.source || s.originalimage?.source,
            url: (mobile ? s.content_urls?.mobile?.page : s.content_urls?.desktop?.page) || `https://${l}.wikipedia.org/wiki/${encodeURIComponent(titles[l])}` };
        } catch { /* try the next language */ }
      }
      return { title: label || null, desc, extract: '', img: null, url: g.wd ? `https://www.wikidata.org/wiki/${g.wd}` : null, wd: !!g.wd };
    })();
    cache.set(g.key, job);
    return job;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ─── per frame ───
  let lastT = 0, retryT = 0;
  return {
    // before the controls: returns true while the camera is flying (the viewer keeps full frame rate)
    update(_dt, now) {
      const dt = Math.min(0.1, lastT ? (now - lastT) / 1000 : 0); lastT = now;
      // a landmark chosen before its tile was in (a far tap, ?landmark=): light it once its buildings arrive
      if (selected && !(selected.glow && selected.glow.wash) && now - retryT > 1000) { retryT = now; selected.glow = null; light(selected, 1, true); }
      if (blocked()) { if (hover) setHover(null); if (selected) deselect(); fly = null; }
      else if (ptrDirty && !fly) { ptrDirty = false; setHover(ptr ? pick(ptr.x, ptr.y) : null); }
      // fades and the selection sweep
      let anim = false;
      for (const [g, L] of lit) {
        const k = L.k + Math.sign(L.want - L.k) * Math.min(Math.abs(L.want - L.k), dt * 6);
        L.k = k; if (Math.abs(L.want - k) > 1e-3) anim = true;
        if (L.sweep >= 0) { L.sweep += dt / 1.3; anim = true; if (L.sweep > 1) L.sweep = -1; }
        const gl = g.glow;
        if (!gl || !gl.wash) { lit.delete(g); continue; }
        gl.wash.material.uniforms.uK.value = k; gl.wash.material.uniforms.uSweep.value = L.sweep;
        gl.halo.material.uniforms.uK.value = k * 0.9;
        gl.halo.material.uniforms.uW.value = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.0035, 0.5, 9);
        if (k <= 1e-3 && L.want === 0) { gl.wash.parent?.remove(gl.wash); gl.halo.parent?.remove(gl.halo); lit.delete(g); }
      }
      if (anim) invalidate();
      if (!fly) return false;
      fly.u = Math.min(1, fly.u + dt / fly.dur);
      const e = ease(fly.u);
      controls.target.lerpVectors(fly.from.t, fly.to.t, e);
      camera.position.lerpVectors(fly.from.p, fly.to.p, e);
      camera.position.y += Math.sin(Math.PI * e) * fly.arc;
      camera.lookAt(controls.target);
      if (fly.u >= 1) fly = null;
      return true;
    },
    get flying() { return !!fly; },
    get selected() { return selected && { key: selected.key, name: selected.name }; },
    // for checks: select by name or Wikidata id, pick at a screen point
    select: (q) => { const g = groups.find((x) => x.key === q || x.name === q || x.wd === q); if (g) select(g); return !!g; },
    pick: (x, y) => pick(x, y)?.name || null,
    deselect,
    get count() { return groups.length; },
  };
}

function ringArea(r) { let s = 0; for (let i = 0, n = r.length; i < n; i += 2) { const j = (i + 2) % n; s += r[i] * r[j + 1] - r[j] * r[i + 1]; } return s / 2; }
function inRing(r, x, y) {
  let inside = false;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ringDist(r, x, y) {
  let d = Infinity;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
    const ax = r[j], ay = r[j + 1], dx = r[i] - ax, dy = r[i + 1] - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    d = Math.min(d, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return d;
}
