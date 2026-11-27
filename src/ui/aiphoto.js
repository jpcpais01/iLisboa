// AI-enhanced photo: the photo-mode picture goes to /api/aiphoto, where an image model turns it into a real-looking photograph
// while being told to keep every building where it is. The model can still drift, so we measure, against the renderer's own
// exact depth, how much of the real geometry survived. That number ("fiel à geometria") is shown on the result.
//
// Depth is drawn once per photo at a small size (long side 960) from the same camera: a depth-texture pass, then a quad
// that stores log depth in RGB bytes (works on every WebGL2 phone, no float render targets needed).
import * as THREE from 'three';

const GRID = 960;   // long side of the depth grid and of the score

// ─── depth ───────────────────────────────────────────────────────────────
export function captureDepth(renderer, scene, camera, W, H) {
  const s = GRID / Math.max(W, H), w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
  const rt = new THREE.WebGLRenderTarget(w, h, { depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType), samples: 0 });
  const out = new THREE.WebGLRenderTarget(w, h);
  const n = camera.near, f = camera.far;
  const mat = new THREE.ShaderMaterial({
    uniforms: { tD: { value: rt.depthTexture }, n: { value: n }, f: { value: f } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: `uniform sampler2D tD; uniform float n, f; varying vec2 vUv;
      void main(){
        float d = texture2D(tD, vUv).r;
        if (d >= 0.999999) { gl_FragColor = vec4(1.); return; }   // sky
        float z = (n * f) / (f - d * (f - n));
        float v = clamp(log(z / n) / log(f / n), 0., 0.99999);    // 0..1, 24-bit
        vec3 e = fract(v * vec3(1., 255., 65025.)); e -= e.yzz * vec3(1. / 255., 1. / 255., 0.);
        gl_FragColor = vec4(e, 0.);
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat), qs = new THREE.Scene(); qs.add(quad);
  const oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevRT = renderer.getRenderTarget(), prevAuto = renderer.shadowMap.autoUpdate;
  const px = new Uint8Array(w * h * 4);
  try {
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, camera);
    renderer.setRenderTarget(out); renderer.render(qs, oc);
    renderer.readRenderTargetPixels(out, 0, 0, w, h, px);
  } finally {
    renderer.setRenderTarget(prevRT); renderer.shadowMap.autoUpdate = prevAuto;
    rt.depthTexture.dispose(); rt.dispose(); out.dispose(); mat.dispose(); quad.geometry.dispose();
  }
  const z = new Float32Array(w * h), L = Math.log(f / n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((h - 1 - y) * w + x) * 4, o = y * w + x;   // (GL rows are bottom-up)
    if (px[i + 3] === 255) { z[o] = -1; continue; }
    const v = px[i] / 255 + px[i + 1] / 65025 + px[i + 2] / 16581375;
    z[o] = n * Math.exp(v * L);
  }
  // seams where the sky shows through below real ground (water meets quay): real sky only has sky above it
  for (let x = 0; x < w; x++) { let last = -1; for (let y = 0; y < h; y++) { const o = y * w + x; if (z[o] >= 0) last = z[o]; else if (last > 0) z[o] = last; } }
  return { z, w, h };
}

// the depth map the model sees: near bright, far dark, sky black (MiDaS-like), PNG
export function depthPNG({ z, w, h }) {
  const lz = new Float32Array(z.length), vals = [];
  for (let i = 0; i < z.length; i++) { if (z[i] < 0) continue; lz[i] = -Math.log(z[i]); if (i % 7 === 0) vals.push(lz[i]); }
  vals.sort((p, q) => p - q);   // robust range (0.5–99.5 %): a lamp post at 4 m shouldn't flatten the city
  const lo = vals[Math.floor(vals.length * 0.005)] ?? 0, hi = vals[Math.floor(vals.length * 0.995)] ?? 1;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
  for (let i = 0; i < z.length; i++) {
    const v = z[i] < 0 ? 0 : Math.round(255 * (0.1 + 0.9 * Math.min(1, Math.max(0, (lz[i] - lo) / Math.max(1e-6, hi - lo)))));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

// ─── the score ───────────────────────────────────────────────────────────
// Geometry edges come only from our depth (silhouettes and creases: jumps and kinks in log depth). For each 20 px cell where
// the render itself shows those edges, we ask how many of them the AI picture also shows (within 1 px), relative to the
// render. Average over cells = "fiel à geometria". Calibrated on the Nov 2026 test: aligned results 78–92 %, reframed or
// reinvented ones 25–70 %.
function geoEdges({ z, w, h }) {
  const lz = new Float32Array(z.length);
  for (let i = 0; i < z.length; i++) lz[i] = Math.log(z[i] < 0 ? 1e5 : z[i]);
  const e = new Uint8Array(z.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = lz[i - 1], r = lz[i + 1], u = lz[i - w], d = lz[i + w];
    if (Math.abs(r - l) > 0.12 || Math.abs(d - u) > 0.12 || Math.abs(r - 2 * lz[i] + l) > 0.02 || Math.abs(d - 2 * lz[i] + u) > 0.02) e[i] = 1;
  }
  return e;
}
async function grey(src, w, h) {
  const bmp = src instanceof Blob ? await createImageBitmap(src) : src;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // cover-fit (the model's picture may differ a hair in aspect)
  const s = Math.max(w / bmp.width, h / bmp.height), dw = bmp.width * s, dh = bmp.height * s;
  ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return g;
}
function edges(g, w, h) {
  const b = new Float32Array(g.length);   // 3×3 gaussian
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    b[i] = (4 * g[i] + 2 * (g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) + g[i - w - 1] + g[i - w + 1] + g[i + w - 1] + g[i + w + 1]) / 16;
  }
  const m = new Float32Array(g.length);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    const gx = b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1] - b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1];
    const gy = b[i + w - 1] + 2 * b[i + w] + b[i + w + 1] - b[i - w - 1] - 2 * b[i - w] - b[i - w + 1];
    m[i] = Math.hypot(gx, gy);
  }
  const sorted = Float32Array.from(m).sort(), t = Math.max(8, sorted[Math.floor(sorted.length * 0.8)]);
  const e = new Uint8Array(g.length), n = new Uint8Array(g.length);
  for (let i = 0; i < m.length; i++) e[i] = m[i] > t ? 1 : 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {   // dilate 1 px
    const i = y * w + x;
    n[i] = e[i] | e[i - 1] | e[i + 1] | e[i - w] | e[i + w] | e[i - w - 1] | e[i - w + 1] | e[i + w - 1] | e[i + w + 1];
  }
  return n;
}
export async function fidelity(depth, renderBlob, aiBlob) {
  const { w, h } = depth, G = geoEdges(depth);
  const er = edges(await grey(renderBlob, w, h), w, h), ea = edges(await grey(aiBlob, w, h), w, h);
  const B = 20; let sum = 0, cells = 0;
  for (let y0 = 0; y0 < h; y0 += B) for (let x0 = 0; x0 < w; x0 += B) {
    let g = 0, r = 0, a = 0;
    for (let y = y0; y < Math.min(h, y0 + B); y++) for (let x = x0; x < Math.min(w, x0 + B); x++) {
      const i = y * w + x; if (!G[i]) continue; g++; r += er[i]; a += ea[i];
    }
    if (g < 12 || r / g < 0.3) continue;
    sum += Math.min(1, a / r); cells++;
  }
  return cells ? Math.round((100 * sum) / cells) : null;
}

// ─── the request ─────────────────────────────────────────────────────────
async function jpegData(blob, long) {
  const bmp = await createImageBitmap(blob), s = Math.min(1, long / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); c.width = c.height = 0;
  return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
}
export async function enhance(renderBlob, depth, signal) {
  const body = JSON.stringify({ image: await jpegData(renderBlob, 2048), depth: depthPNG(depth), aspect: depth.w / depth.h });
  const r = await fetch('/api/aiphoto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
  if (!r.ok) { let j = {}; try { j = await r.json(); } catch {} const e = new Error(j.error || `http ${r.status}`); e.code = j.error || r.status; e.scope = j.scope; throw e; }
  return await r.blob();
}
