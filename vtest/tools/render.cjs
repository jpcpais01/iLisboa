// Renders a 5 s fly-through between two camera views with the real viewer (photo-mode pipeline per frame),
// plus exact float depth and camera matrices per frame.  node render.cjs <outdir> [fps] [W] [H]
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2] || 'frames'; const FPS = +(process.argv[3] || 24); const DUR = 5;
const VW = +(process.env.VW || 640), VH = Math.round(VW * 9 / 16);   // screen aspect 16:9 -> photo 1080p = 1920x1080
const A = '38.7076,-9.1365,900,0,62', B = '38.7118,-9.1300,650,315,68';
const Q = 't=15.5&mes=10&tempo=limpo&layers=&stats';
fs.mkdirSync(OUT, { recursive: true });
const N = FPS * DUR + 1;
const START = +(process.env.START || 0);

(async () => {
  const br = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await br.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
  // simulated clock: while __sim(t) is set, performance.now/Date.now/rAF timestamps all read t, so boats, water, cars and
  // wakes advance exactly 1/FPS per frame however long the frame takes to render
  await page.addInitScript(() => {
    const rp = performance.now.bind(performance), RD = Date, rd = Date.now; let sim = null;
    const DBASE = RD.UTC(2026, 9, 14, 14, 30) - 1e6;   // sim time 1e6 ms = 14 Oct 2026 15:30 Lisbon, same in every process
    window.__sim = (t) => { sim = t; };
    performance.now = () => (sim == null ? rp() : sim);
    const now = () => (sim == null ? rd() : DBASE + sim);
    class SDate extends RD { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } }
    window.Date = SDate;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf(() => cb(performance.now()));
  });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text().slice(0, 200)); });
  const ready = async () => { await page.waitForFunction(() => window.__ready && window.__dbg, null, { timeout: 180000 }); };
  // the target of view B, from the viewer's own ?cam parser
  await page.goto(`http://localhost:5181/?cam=${B}&${Q}`); await ready();
  const tB = await page.evaluate(() => __dbg.controls.target.toArray());
  await page.goto(`http://localhost:5181/?cam=${A}&${Q}`); await ready();
  const tA = await page.evaluate(() => __dbg.controls.target.toArray());
  console.log('targets', tA, tB);
  await page.evaluate(() => { window.__T0 = 1e6; __photo.enter(); });
  const pa = A.split(',').map(Number), pb = B.split(',').map(Number);
  const meta = { fps: FPS, N, W: 1920, H: 1080, A, B, query: Q, frames: [] };
  const metaFile = process.env.META || `${OUT}/meta.json`;
  if (START && fs.existsSync(metaFile)) Object.assign(meta, JSON.parse(fs.readFileSync(metaFile)));
  for (let i = START; i < +(process.env.END || N); i++) {
    const k = i / (N - 1), e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;   // the saved-view flight's ease
    const lerp = (a, b) => a + (b - a) * e;
    const t = tA.map((v, j) => lerp(v, tB[j]));
    const d = lerp(pa[2], pb[2]), h = lerp(pa[3], pb[3] > 180 ? pb[3] - 360 : pb[3]), tl = lerp(pa[4], pb[4]);
    const hr = h * Math.PI / 180, tr = tl * Math.PI / 180;
    const p = [t[0] - Math.sin(hr) * Math.sin(tr) * d, t[1] + Math.cos(tr) * d, t[2] + Math.cos(hr) * Math.sin(tr) * d];
    const t0 = Date.now();
    await page.evaluate(({ p, t, i, FPS }) => { __sim(__T0 + i * 1000 / FPS); __view([...p, ...t]); const { camera, controls } = __dbg; camera.fov = 35; camera.updateProjectionMatrix(); camera.lookAt(controls.target); controls.update?.(); __photo.shoot('1080p'); }, { p, t, i, FPS });
    await page.waitForFunction(() => !__photo.busy, null, { timeout: 200000, polling: 200 });
    const t1 = Date.now();
    const r = await page.evaluate(async () => {
      const res = __photo.result(); const b = res.blob;
      const buf = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      // exact float depth (view-space distance along -z) at full res, same camera
      const { renderer, scene, camera, THREE } = __dbg; const W = res.W, H = res.H;
      const asp = camera.aspect; camera.aspect = W / H; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      const rt = new THREE.WebGLRenderTarget(W, H, { depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType), samples: 0 });
      const out = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType });
      const mat = new THREE.ShaderMaterial({ uniforms: { tD: { value: rt.depthTexture }, n: { value: camera.near }, f: { value: camera.far } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
        fragmentShader: 'uniform sampler2D tD; uniform float n, f; varying vec2 vUv; void main(){ float d = texture2D(tD, vUv).r; if (d >= 0.9999999) { gl_FragColor = vec4(-1.); return; } gl_FragColor = vec4((n * f) / (f - d * (f - n)), 0., 0., 1.); }',
        depthTest: false, depthWrite: false });
      const qs = new THREE.Scene(); qs.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)); const oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, camera);
      renderer.setRenderTarget(out); renderer.render(qs, oc);
      const px = new Float32Array(W * H * 4); renderer.readRenderTargetPixels(out, 0, 0, W, H, px);
      renderer.setRenderTarget(prev); rt.depthTexture.dispose(); rt.dispose(); out.dispose(); mat.dispose();
      const z = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) z[y * W + x] = px[((H - 1 - y) * W + x) * 4];
      const zb = new Uint8Array(z.buffer); let zs = ''; for (let i = 0; i < zb.length; i += 0x8000) zs += String.fromCharCode.apply(null, zb.subarray(i, i + 0x8000));
      const cam = { world: camera.matrixWorld.elements.slice(), proj: camera.projectionMatrix.elements.slice(), near: camera.near, far: camera.far, fov: camera.fov, aspect: camera.aspect };
      camera.aspect = asp; camera.updateProjectionMatrix();
      return { jpg: btoa(s), z: btoa(zs), cam, W, H, missing: res.missing };
    });
    const n = String(i).padStart(4, '0');
    fs.writeFileSync(`${OUT}/f${n}.jpg`, Buffer.from(r.jpg, 'base64'));
    fs.writeFileSync(`${OUT}/z${n}.f32`, Buffer.from(r.z, 'base64'));
    meta.frames[i] = { cam: r.cam, missing: r.missing };
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    console.log(`frame ${i}/${N - 1} shoot ${((t1 - t0) / 1000).toFixed(1)}s total ${((Date.now() - t0) / 1000).toFixed(1)}s ${r.missing?.length ? 'missing ' + r.missing.length : ''}`);
  }
  await br.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
