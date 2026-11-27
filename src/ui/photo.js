// Photo mode: every bit of UI steps aside, the view stays live (pan, orbit, follow a bus), and one tap saves the view as a
// 1080p, 2K or 4K picture. The picture is drawn again at its own size, not scaled up from the screen: streaming is told the
// photo's resolution and waits until the full-detail tiles around the view are in, then the frame is rendered in tiles of at
// most the GPU's limit (2048 px on phones) with an overlap, so lamps and beacons that straddle a seam are drawn whole.
// main.js owns the loop: it lends us the next frame (shoot) so the picture shows exactly the state the screen would.
import * as THREE from 'three';
import { registerAction } from '../layers/registry.js';
import './photo.css';
import { captureDepth, enhance, fidelity } from './aiphoto.js';

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
      <button type="button" class="ph-vw" aria-label="Vistas guardadas" aria-expanded="false"><svg viewBox="0 0 24 24"><path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-4-6 4v-16a1 1 0 0 1 1-1z"/></svg><i class="ph-n" hidden></i></button>
      <button type="button" class="ph-x" aria-label="Sair do modo fotografia"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="ph-views" hidden>
      <header><b>Vistas guardadas</b><button type="button" class="pv-add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Guardar esta vista</button></header>
      <ol class="pv-list"></ol>
      <p class="pv-empty">Enquadre a cidade, escolha a hora e o tempo, e guarde: volta a esta vista exata quando quiser.</p>
      <p class="pv-toast" hidden></p>
    </div>
    <div class="ph-work" hidden><i class="ph-spin"></i><span class="ph-msg"></span><button type="button" class="ph-cancel">Cancelar</button></div>
    <div class="ph-done" hidden>
      <div class="ph-pic"><img alt="" /><span class="ph-badge" hidden title="Quanto da geometria real (arestas tiradas do mapa de profundidade exato da cena) se mantém na imagem da IA"></span></div>
      <div class="ph-seg" role="tablist" hidden><button type="button" data-v="0" role="tab">Original</button><button type="button" data-v="1" role="tab">IA</button></div>
      <div class="ph-info"><b></b><small></small></div>
      <button type="button" class="ph-ai"><svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.5l-1.8-5L5 9.7l5.2-1.8zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg><span>Tornar real com IA</span></button>
      <div class="ph-acts"><button type="button" class="ph-save">Guardar</button><button type="button" class="ph-share" hidden>Partilhar</button><button type="button" class="ph-back">Fechar</button></div>
    </div>`;
  document.body.appendChild(ui);
  const $ = (s) => ui.querySelector(s);
  const bar = $('.ph-bar'), work = $('.ph-work'), msg = $('.ph-msg'), done = $('.ph-done'), panel = $('.ph-views');

  const dims = (s) => {   // the screen's shape, s pixels on the short side (even numbers: some encoders and players want them)
    const a = canvas.clientWidth / Math.max(1, canvas.clientHeight), even = (v) => Math.max(2, Math.round(v / 2) * 2);
    return a >= 1 ? [even(s * a), s] : [s, even(s / a)];
  };
  const paintSizes = () => { for (const b of ui.querySelectorAll('.ph-go')) { const [w, h] = dims(+b.dataset.s); b.querySelector('small').textContent = `${w}×${h}`; } };

  // the bar steps aside after a few still seconds, so the screen shows the clean picture; any touch or move brings it back
  const wake = () => { if (!on) return; bar.classList.remove('away'); clearTimeout(fadeT); fadeT = setTimeout(() => { if (!busy && panel.hidden && !bar.matches(':hover')) bar.classList.add('away'); }, 3200); };
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) addEventListener(ev, wake, { passive: true });

  function enter() {
    if (on) return; on = true;
    document.body.classList.add('photo'); ui.hidden = false; paintSizes();
    ui.classList.remove('hinted'); void ui.offsetWidth; ui.classList.add('hinted');
    btn.setActive(true); wake(); hooks.invalidate();
  }
  function exit() {
    if (!on) return; cancel(); closeDone(); showViews(false); on = false;
    document.body.classList.remove('photo'); ui.hidden = true; btn.setActive(false); hooks.invalidate();
  }
  const btn = registerAction({ id: 'photo', label: 'Fotografia', icon: ICON, run: () => (on ? exit() : enter()) });
  addEventListener('photo', () => (on ? exit() : enter()));   // other UI (the drive HUD) asks for it with an event
  addEventListener('resize', () => on && paintSizes());
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if (e.code === 'KeyP' && !e.metaKey && !e.ctrlKey && !e.altKey) { on ? exit() : enter(); return; }
    if (on && e.code === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); if (renaming) return; if (!done.hidden) closeDone(); else if (!panel.hidden) showViews(false); else if (busy) cancel(); else exit(); }
  }, true);   // (capture: Esc closes photo mode before drive mode sees it)
  $('.ph-x').onclick = exit;
  $('.ph-cancel').onclick = () => cancel();
  for (const b of ui.querySelectorAll('.ph-go')) b.onclick = () => { showViews(false); shoot(+b.dataset.s, b.dataset.id); };

  function cancel() { if (busy) busy.cancelled = true; }
  let result = null, aiJob = null, shotDepth = null;
  function closeDone() {
    aiJob?.abort(); aiJob = null;
    done.hidden = true; bar.hidden = false;
    if (result) { URL.revokeObjectURL(result.url); if (result.ai) URL.revokeObjectURL(result.ai.url); result = null; }
    wake();
  }

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
      result = { blob, name, url: URL.createObjectURL(blob), W, H, depth: shotDepth };
      shotDepth = null;
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
  function show(r, v) {   // v: the picture on show (the original or the AI version); save and share follow it
    done.querySelector('img').src = v.url;
    done.querySelector('.ph-info b').textContent = `${v.W} × ${v.H}`;
    done.querySelector('.ph-info small').textContent = `${(v.blob.size / 1048576).toFixed(1).replace('.', ',')} MB · JPEG${v === r.ai ? ' · IA' : ''}`;
    const badge = $('.ph-badge');
    badge.hidden = v !== r.ai || r.ai.score == null;
    if (!badge.hidden) { badge.textContent = `${r.ai.score}% fiel à geometria`; badge.dataset.q = r.ai.score >= 80 ? 'hi' : r.ai.score >= 70 ? 'mid' : 'lo'; }
    for (const b of ui.querySelectorAll('.ph-seg button')) b.setAttribute('aria-selected', String((+b.dataset.v === 1) === (v === r.ai)));
    const file = new File([v.blob], v.name, { type: 'image/jpeg' });
    const share = $('.ph-share'), canShare = mobile && !!navigator.canShare?.({ files: [file] });
    share.hidden = !canShare;
    share.onclick = () => navigator.share({ files: [file] }).catch(() => {});   // (a tap of its own: share needs one)
    $('.ph-save').onclick = () => save(v);
  }
  function showDone(r) {
    show(r, r);
    $('.ph-seg').hidden = true;
    const ai = $('.ph-ai'); ai.hidden = !r.depth; ai.disabled = false; ai.classList.remove('busy', 'err'); ai.querySelector('span').textContent = 'Tornar real com IA';
    ai.onclick = () => (aiJob ? aiJob.abort() : makeReal(r));
    for (const b of ui.querySelectorAll('.ph-seg button')) b.onclick = () => r.ai && show(r, +b.dataset.v ? r.ai : r);
    $('.ph-back').onclick = closeDone;
    done.hidden = false;
    if (!mobile) save(r);   // desktop: straight to Downloads; phones choose (Partilhar → Guardar imagem puts it in Photos)
  }

  // ─── the AI version: sent to /api/aiphoto, then scored against this frame's exact depth (no retries: the number tells) ───
  const AI_ERR = { not_configured: 'A IA ainda não está configurada.', rate_limited: 'Limite de fotografias IA atingido. Tente mais tarde.', refused: 'A IA recusou esta imagem.', timeout: 'A IA demorou demasiado. Tente outra vez.' };
  async function makeReal(r) {
    const ai = $('.ph-ai'), label = ai.querySelector('span'), ac = new AbortController(), t0 = performance.now();
    aiJob = ac; ai.classList.add('busy'); ai.classList.remove('err');
    const tick = setInterval(() => { label.textContent = `A revelar com IA · ${Math.round((performance.now() - t0) / 1000)} s · tocar para cancelar`; }, 250);
    label.textContent = 'A revelar com IA…';
    try {
      const blob = await enhance(r.blob, r.depth, ac.signal);
      if (ac.signal.aborted || result !== r) return;
      const bmp = await createImageBitmap(blob);
      r.ai = { blob, url: URL.createObjectURL(blob), name: r.name.replace(/\.jpg$/, '-ia.jpg'), W: bmp.width, H: bmp.height, score: null };
      bmp.close?.();
      label.textContent = 'A medir a fidelidade…';
      try { r.ai.score = await fidelity(r.depth, r.blob, blob); } catch (e) { console.warn('score', e); }
      window.__photo.lastAI = { W: r.ai.W, H: r.ai.H, bytes: blob.size, score: r.ai.score, ms: Math.round(performance.now() - t0) };
      ai.hidden = true; $('.ph-seg').hidden = false;
      show(r, r.ai);
    } catch (e) {
      if (ac.signal.aborted) { label.textContent = 'Tornar real com IA'; return; }
      console.error('aiphoto', e);
      ai.classList.add('err'); label.textContent = AI_ERR[e.code] || 'Não foi possível. Tocar para tentar outra vez.';
    } finally {
      clearInterval(tick); ai.classList.remove('busy'); if (aiJob === ac) aiJob = null;
    }
  }


  // ─── saved views: the exact camera (position, aim, lens) and its light (hour, month, weather), kept on this device ───
  const KEY = 'ilisboa.views', MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const load = () => { try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch { return []; } };
  let views = load(), renaming = null, undo = null, toastT = 0, tween = 0;
  const store = () => { try { localStorage.setItem(KEY, JSON.stringify(views)); return true; } catch { return false; } };
  const list = $('.pv-list'), count = $('.ph-n'), vwBtn = $('.ph-vw');
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hhmm = (h) => { const m = Math.round(h * 60) % 1440; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const toast = (t) => { const el = $('.pv-toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2200); };
  function showViews(v = panel.hidden) {
    panel.hidden = !v; vwBtn.setAttribute('aria-expanded', String(v));
    if (v) paintViews(); else if (renaming) renaming.blur();
    wake();
  }
  vwBtn.onclick = () => showViews();
  function paintViews() {
    count.hidden = !views.length; count.textContent = views.length;
    $('.pv-empty').hidden = views.length > 0;
    list.innerHTML = views.map((v) => `<li data-id="${v.id}">
      <button type="button" class="pv-go" aria-label="Ir para ${esc(v.name)}">${v.img ? `<img src="${v.img}" alt="">` : ''}</button>
      <div class="pv-tx"><input class="pv-name" value="${esc(v.name)}" maxlength="40" readonly aria-label="Nome da vista"><small>${hhmm(v.hour)} · ${v.mes ? MONTHS[v.mes - 1] : 'hoje'}${v.tempo ? ' · ' + esc(hooks.hud.picks?.[v.tempo] || v.tempo) : ''}</small></div>
      <div class="pv-acts">
        <button type="button" class="pv-ren" aria-label="Mudar o nome"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></button>
        <button type="button" class="pv-link" aria-label="Copiar link"><svg viewBox="0 0 24 24"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg></button>
        <button type="button" class="pv-del" aria-label="Apagar"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg></button>
      </div></li>`).join('') + (undo ? `<li class="pv-undo"><span>«${esc(undo.v.name)}» apagada</span><button type="button">Desfazer</button></li>` : '');
  }
  const byId = (id) => views.find((v) => v.id === id);
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.closest('.pv-undo')) { views.splice(Math.min(undo.i, views.length), 0, undo.v); undo = null; store(); paintViews(); return; }
    const li = b.closest('li'), v = byId(li?.dataset.id); if (!v) return;
    if (b.classList.contains('pv-go')) go(v);
    else if (b.classList.contains('pv-ren')) { const inp = li.querySelector('.pv-name'); inp.readOnly = false; renaming = inp; inp.focus(); inp.select(); }
    else if (b.classList.contains('pv-link')) shareView(v);
    else if (b.classList.contains('pv-del')) { const i = views.indexOf(v); views.splice(i, 1); undo = { v, i }; store(); paintViews(); setTimeout(() => { if (undo?.v === v) { undo = null; if (!panel.hidden) paintViews(); } }, 6000); }
  });
  const finishRename = (inp, keep = true) => {
    const v = byId(inp.closest('li')?.dataset.id); renaming = null; inp.readOnly = true;
    if (v && keep && inp.value.trim()) { v.name = inp.value.trim(); store(); } else if (v) inp.value = v.name;
  };
  list.addEventListener('focusout', (e) => { if (e.target === renaming) finishRename(e.target); });
  list.addEventListener('keydown', (e) => {
    if (e.target !== renaming) return;
    if (e.key === 'Enter') { e.preventDefault(); finishRename(e.target); e.target.blur(); }
    else if (e.key === 'Escape') { finishRename(e.target, false); e.target.blur(); }
  });

  function snapshot() {
    const hud = hooks.hud, now = new Date();
    return { p: camera.position.toArray(), t: controls.target.toArray(), fov: camera.fov,
      hour: hud.hour(), mes: hud.month() || now.getMonth() + 1, tempo: hud.tempo() };   // (a live clock is pinned at this minute: the same light every time)
  }
  $('.pv-add').onclick = async () => {
    if (busy) return;
    const v = { id: Math.random().toString(36).slice(2, 10), name: `Vista ${views.reduce((n, x) => Math.max(n, +(/^Vista (\d+)$/.exec(x.name)?.[1] || 0)), 0) + 1}`, at: Date.now(), ...snapshot(), img: '' };
    try {   // the thumbnail is the photo pipeline at 320 px: the view itself, without the UI
      const a = canvas.clientWidth / Math.max(1, canvas.clientHeight), W = a >= 1 ? 320 : Math.round(320 * a), H = a >= 1 ? Math.round(320 / a) : 320;
      const c = await new Promise((res, rej) => hooks.shoot(() => { try { res(render(W, H)); } catch (e) { rej(e); } }));
      v.img = c.toDataURL('image/jpeg', 0.78); c.width = c.height = 0;
    } catch (e) { console.error(e); }
    views.unshift(v);
    if (!store()) { v.img = ''; if (!store()) { views.shift(); toast('Sem espaço para mais vistas neste aparelho'); return paintViews(); } }
    paintViews(); toast('Vista guardada');
  };

  // back to a view: a short flight to the exact camera, the light set at once
  function go(v) {
    hooks.free(); hooks.hud.setScene({ hour: v.hour, mes: v.mes, tempo: v.tempo });
    const p0 = camera.position.clone(), t0 = controls.target.clone(), f0 = camera.fov;
    const p1 = new THREE.Vector3().fromArray(v.p), t1 = new THREE.Vector3().fromArray(v.t), f1 = v.fov || f0;
    const dur = 700 + Math.min(1300, p0.distanceTo(p1) / 4), start = performance.now(), me = ++tween;
    const stop = () => { if (me === tween) tween++; };   // a touch of the user's takes over
    canvas.addEventListener('pointerdown', stop, { once: true }); canvas.addEventListener('wheel', stop, { once: true, passive: true });
    const step = () => {
      if (me !== tween) return;
      const k = Math.min(1, (performance.now() - start) / dur), e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      camera.position.lerpVectors(p0, p1, e); controls.target.lerpVectors(t0, t1, e);
      camera.fov = f0 + (f1 - f0) * e; camera.updateProjectionMatrix(); camera.lookAt(controls.target);
      hooks.invalidate();
      if (k < 1) requestAnimationFrame(step);
      else { canvas.removeEventListener('pointerdown', stop); canvas.removeEventListener('wheel', stop); controls.update?.(); history.replaceState(null, '', '#' + [...v.p, ...v.t].map((n) => Math.round(n)).join(',')); }
    };
    requestAnimationFrame(step);
    if (mobile) showViews(false);   // (a phone needs the whole screen to see it)
  }
  // a link that opens this exact view: #x,y,z,tx,ty,tz,fov plus the light in the query (?t, ?mes, ?tempo)
  const linkOf = (v) => {
    const q = new URLSearchParams({ t: (+v.hour).toFixed(3), mes: v.mes }); if (v.tempo) q.set('tempo', v.tempo);
    return `${location.origin}${location.pathname}?${q}#${[...v.p, ...v.t].map((n) => (+n).toFixed(1)).join(',')},${(+v.fov).toFixed(2)}`;
  };
  async function shareView(v) {
    const url = linkOf(v);
    if (mobile && navigator.share) { try { await navigator.share({ title: `${v.name} · Lisboa`, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(url); toast('Link copiado'); } catch { toast(url); }
  }
  paintViews();

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
      // exact depth of the same frame (small): what the AI version is told to follow and scored against
      shotDepth = null;
      try { camera.clearViewOffset(); camera.aspect = W / H; camera.updateProjectionMatrix(); shotDepth = captureDepth(renderer, hooks.scene, camera, W, H); }
      catch (e) { console.warn('depth', e); }
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

  window.__photo = { enter, exit, shoot: (id = '1080p') => shoot(SIZES.find((z) => z.id === id).s, id), get busy() { return !!busy; }, get on() { return on; }, last: null, result: () => result, makeReal: () => result && makeReal(result), lastAI: null, views: () => views, save: () => $('.pv-add').onclick(), go: (i) => go(views[i]), link: (i) => linkOf(views[i]), panel: showViews };
  return { enter, exit, get on() { return on; } };
}
