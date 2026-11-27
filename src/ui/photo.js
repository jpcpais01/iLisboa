// Photo mode: every bit of UI steps aside, the view stays live (pan, orbit, follow a bus), and one tap saves the view as a
// 1080p, 2K or 4K picture. The picture is drawn again at its own size, not scaled up from the screen: streaming is told the
// photo's resolution and waits until the full-detail tiles around the view are in, then the frame is rendered in tiles of at
// most the GPU's limit (2048 px on phones) with an overlap, so lamps and beacons that straddle a seam are drawn whole.
// main.js owns the loop: it lends us the next frame (shoot) so the picture shows exactly the state the screen would.
import * as THREE from 'three';
import { registerAction } from '../layers/registry.js';
import './photo.css';

const SIZES = [{ id: '1080p', s: 1080 }, { id: '2K', s: 1440 }, { id: '4K', s: 2160 }];   // short side, as in "1080p"
const ICON = '<path d="M3 8.5h3l2-2.5h8l2 2.5h3V19H3z"/><circle cx="12" cy="13" r="3.4"/><path d="M18 11h.01"/>';
const MARGIN = 48;   // px of overlap around each tile (points and sprites whose centre is just past a seam still land)

export function initPhoto({ renderer, camera, canvas, controls, mobile, hooks }) {
  let on = false, busy = null, fadeT = 0;
  const ui = document.createElement('div');
  ui.className = 'photo-ui'; ui.hidden = true;
  ui.innerHTML = `
    <div class="ph-hint">Modo fotografia · enquadre a vista</div>
    <div class="ph-bar" role="toolbar" aria-label="Fotografia">
      ${SIZES.map((z) => `<button type="button" class="ph-go" data-s="${z.s}" data-id="${z.id}"><b>${z.id}</b><small></small></button>`).join('')}
      <button type="button" class="ph-x" aria-label="Sair do modo fotografia"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="ph-work" hidden><i class="ph-spin"></i><span class="ph-msg"></span><button type="button" class="ph-cancel">Cancelar</button></div>
    <div class="ph-done" hidden>
      <img alt="" />
      <div class="ph-info"><b></b><small></small></div>
      <div class="ph-acts"><button type="button" class="ph-save">Guardar</button><button type="button" class="ph-share" hidden>Partilhar</button><button type="button" class="ph-back">Fechar</button></div>
    </div>`;
  document.body.appendChild(ui);
  const $ = (s) => ui.querySelector(s);
  const bar = $('.ph-bar'), work = $('.ph-work'), msg = $('.ph-msg'), done = $('.ph-done');

  const dims = (s) => {   // the screen's shape, s pixels on the short side (even numbers: some encoders and players want them)
    const a = canvas.clientWidth / Math.max(1, canvas.clientHeight), even = (v) => Math.max(2, Math.round(v / 2) * 2);
    return a >= 1 ? [even(s * a), s] : [s, even(s / a)];
  };
  const paintSizes = () => { for (const b of ui.querySelectorAll('.ph-go')) { const [w, h] = dims(+b.dataset.s); b.querySelector('small').textContent = `${w}×${h}`; } };

  // the bar steps aside after a few still seconds, so the screen shows the clean picture; any touch or move brings it back
  const wake = () => { if (!on) return; bar.classList.remove('away'); clearTimeout(fadeT); fadeT = setTimeout(() => { if (!busy && !bar.matches(':hover')) bar.classList.add('away'); }, 3200); };
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) addEventListener(ev, wake, { passive: true });

  function enter() {
    if (on) return; on = true;
    document.body.classList.add('photo'); ui.hidden = false; paintSizes();
    ui.classList.remove('hinted'); void ui.offsetWidth; ui.classList.add('hinted');
    btn.setActive(true); wake(); hooks.invalidate();
  }
  function exit() {
    if (!on) return; cancel(); closeDone(); on = false;
    document.body.classList.remove('photo'); ui.hidden = true; btn.setActive(false); hooks.invalidate();
  }
  const btn = registerAction({ id: 'photo', label: 'Fotografia', icon: ICON, run: () => (on ? exit() : enter()) });
  addEventListener('photo', () => (on ? exit() : enter()));   // other UI (the drive HUD) asks for it with an event
  addEventListener('resize', () => on && paintSizes());
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if (e.code === 'KeyP' && !e.metaKey && !e.ctrlKey && !e.altKey) { on ? exit() : enter(); return; }
    if (on && e.code === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); if (!done.hidden) closeDone(); else if (busy) cancel(); else exit(); }
  }, true);   // (capture: Esc closes photo mode before drive mode sees it)
  $('.ph-x').onclick = exit;
  $('.ph-cancel').onclick = () => cancel();
  for (const b of ui.querySelectorAll('.ph-go')) b.onclick = () => shoot(+b.dataset.s, b.dataset.id);

  function cancel() { if (busy) busy.cancelled = true; }
  let result = null;
  function closeDone() { done.hidden = true; bar.hidden = false; if (result) { URL.revokeObjectURL(result.url); result = null; } wake(); }

  async function shoot(s, id) {
    if (busy) return;
    const job = (busy = { cancelled: false });
    const [W, H] = dims(s);
    bar.hidden = true; work.hidden = false; ui.classList.add('working');
    const was = controls.enabled; controls.enabled = false;   // the frame holds still while the detail comes in
    try {
      // 1. stream for the photo's resolution and wait for the tiles around the view (full ground, buildings, façade relief)
      hooks.begin(W, H);
      const t0 = performance.now(), LIMIT = mobile ? 40000 : 30000;
      let calm = 0;
      while (!job.cancelled) {
        const n = hooks.pending();
        msg.textContent = n ? `a carregar detalhe · ${n}` : 'a assentar a luz…';
        calm = n ? 0 : calm + 1;
        if (calm >= 6) break;   // nothing wanted or in flight for ~0.6 s: shadows have redrawn over the new tiles
        if (performance.now() - t0 > LIMIT) break;   // a slow network: take what is there rather than hang
        hooks.invalidate();
        await new Promise((r) => setTimeout(r, 100));
      }
      if (job.cancelled) return;
      // 2. render it, in the next frame of the main loop
      msg.textContent = `a revelar ${id}…`;
      await new Promise((r) => requestAnimationFrame(r));   // (lets the message paint before the GPU is busy)
      const out = await new Promise((res, rej) => hooks.shoot(() => { try { res(render(W, H)); } catch (e) { rej(e); } }));
      if (job.cancelled) return;
      // 3. encode and hand it over
      const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.94));
      out.width = out.height = 0;   // (frees the 2D canvas now: phones count canvas memory)
      if (!blob) throw new Error('encode failed');
      const d = new Date(), p = (v) => String(v).padStart(2, '0');
      const name = `lisboa-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${id.toLowerCase()}.jpg`;
      result = { blob, name, url: URL.createObjectURL(blob), W, H };
      window.__photo.last = { name, W, H, bytes: blob.size };
      showDone(result);
    } catch (e) {
      console.error(e);
      msg.textContent = 'Não foi possível criar a fotografia.';
      await new Promise((r) => setTimeout(r, 2200));
    } finally {
      hooks.end(); controls.enabled = was;
      work.hidden = true; ui.classList.remove('working');
      if (done.hidden) bar.hidden = false;
      busy = null; wake(); hooks.invalidate();
    }
  }

  function save(r) {
    const a = document.createElement('a'); a.href = r.url; a.download = r.name; document.body.appendChild(a); a.click(); a.remove();
  }
  function showDone(r) {
    done.querySelector('img').src = r.url;
    done.querySelector('.ph-info b').textContent = `${r.W} × ${r.H}`;
    done.querySelector('.ph-info small').textContent = `${(r.blob.size / 1048576).toFixed(1).replace('.', ',')} MB · JPEG`;
    const file = new File([r.blob], r.name, { type: 'image/jpeg' });
    const share = $('.ph-share'), canShare = mobile && !!navigator.canShare?.({ files: [file] });
    share.hidden = !canShare;
    share.onclick = () => navigator.share({ files: [file] }).catch(() => {});   // (a tap of its own: share needs one)
    $('.ph-save').onclick = () => save(r);
    $('.ph-back').onclick = closeDone;
    done.hidden = false;
    if (!mobile) save(r);   // desktop: straight to Downloads; phones choose (Partilhar → Guardar imagem puts it in Photos)
  }

  // ─── the render itself: W×H, tiled when bigger than the GPU allows, onto one 2D canvas ───
  function render(W, H) {
    const gl = renderer.getContext();
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS), rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    let T = Math.min(rb, vp[0], vp[1], mobile ? 2048 : 4096);
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#e9dfcf'; ctx.fillRect(0, 0, W, H);   // (the page colour, under anything the sky leaves clear)
    const size = renderer.getSize(new THREE.Vector2()), ratio = renderer.getPixelRatio(), aspect = camera.aspect;
    const unscale = hooks.scale(H);
    try {
      for (let tries = 0; ; tries++) {
        try { tiles(W, H, T, ctx); break; }
        catch (e) { if (e.message !== 'small' || tries > 3) throw e; T = Math.floor(T / 2); }   // the browser gave a smaller buffer: halve
      }
    } finally {
      unscale(); camera.clearViewOffset(); camera.aspect = aspect; camera.updateProjectionMatrix();
      renderer.setPixelRatio(ratio); renderer.setSize(size.x, size.y, false);
    }
    return out;
  }
  function tiles(W, H, T, ctx) {
    const gl = renderer.getContext(), one = W <= T && H <= T, M = one ? 0 : MARGIN, step = T - 2 * M;
    camera.aspect = W / H;
    renderer.setPixelRatio(1);
    let n = 0;
    for (let iy = 0; iy < H; iy += step) for (let ix = 0; ix < W; ix += step) {
      const iw = Math.min(step, W - ix), ih = Math.min(step, H - iy);
      const rx = Math.max(0, ix - M), ry = Math.max(0, iy - M), rw = Math.min(W, ix + iw + M) - rx, rh = Math.min(H, iy + ih + M) - ry;
      renderer.setSize(rw, rh, false);
      if (gl.drawingBufferWidth !== rw || gl.drawingBufferHeight !== rh) throw new Error('small');
      if (one) camera.clearViewOffset(); else camera.setViewOffset(W, H, rx, ry, rw, rh);
      camera.updateProjectionMatrix();
      renderer.render(hooks.scene, camera);
      ctx.drawImage(renderer.domElement, ix - rx, iy - ry, iw, ih, ix, iy, iw, ih);   // (same task as the draw: the buffer is still there)
      n++;
    }
    window.__photo.tiles = n; window.__photo.tileSize = T;
  }

  window.__photo = { enter, exit, shoot: (id = '1080p') => shoot(SIZES.find((z) => z.id === id).s, id), get busy() { return !!busy; }, get on() { return on; }, last: null, result: () => result };
  return { enter, exit, get on() { return on; } };
}
