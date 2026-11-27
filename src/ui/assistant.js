// Alfacinha: the Lisbon guide in the corner. A little ceramic swallow (the Bordallo Pinheiro andorinhas on Lisbon's
// façades) perches bottom right; a tap and it flies toward the middle and opens a calm chat. Answers stream from
// /api/assistant (Claude with the app's own data as tools + web search); it can move the camera, switch layers and
// follow vehicles, which happens here.
//   initAssistant({ camera, controls, marks, live, hud, ll, mobile })
import { setLayer, listLayers } from '../layers/registry.js';
import './assistant.css';

const PT = !/^en/i.test(navigator.language || 'pt');
const T = PT ? {
  title: 'Alfacinha', sub: 'a tua guia de Lisboa', ph: 'Pergunta sobre Lisboa…', hello: 'Olá! Sou a Alfacinha. Pergunta-me o que quiseres sobre Lisboa: transportes ao vivo, o tempo, os bairros, os monumentos…',
  tips: ['Onde anda o elétrico 28?', 'Vai chover hoje?', 'Mostra-me o Castelo', 'Qual a freguesia mais densa?', 'Há aviões a aterrar?'],
  open: 'Falar com a Alfacinha', close: 'Fechar', reset: 'Nova conversa', send: 'Enviar', thinking: 'a pensar', back: 'Toca para voltar à conversa',
  busy: 'Estou com muita gente a perguntar ao mesmo tempo. Tenta outra vez daqui a um minuto.', minute: 'Muitas perguntas seguidas! Dá-me um minuto para respirar.', day: 'Por hoje já falámos muito. Volta amanhã!',
  off: 'Ainda estou a acordar: o assistente não está configurado neste site.', fail: 'Perdi o fio à meada. Tenta outra vez?', retry: 'Tentar outra vez', sources: 'Fontes',
} : {
  title: 'Alfacinha', sub: 'your Lisbon guide', ph: 'Ask about Lisbon…', hello: "Olá! I'm Alfacinha. Ask me anything about Lisbon: live transport, the weather, neighbourhoods, landmarks…",
  tips: ['Where is tram 28 now?', 'Will it rain today?', 'Show me the castle', 'Densest parish?', 'Any planes landing?'],
  open: 'Talk to Alfacinha', close: 'Close', reset: 'New chat', send: 'Send', thinking: 'thinking', back: 'Tap to go back to the chat',
  busy: 'Lots of people are asking right now. Try again in a minute.', minute: 'Lots of questions in a row! Give me a minute.', day: "We've talked a lot today. Come back tomorrow!",
  off: "I'm still waking up: the assistant isn't configured on this site.", fail: 'I lost the thread. Try again?', retry: 'Try again', sources: 'Sources',
};

// the swallow, facing left (toward the city): glazed navy back, white belly, terracotta throat, amber beak
export const BIRD = `<svg class="alf-svg" viewBox="0 0 72 64" aria-hidden="true">
  <path class="tail" d="M44 35 C52 33 60 27 69 21 C64 30 62 33 59 36 C63 37 66 39 70 43 C61 43 52 42 44 40 Z"/>
  <g class="wing-b"><path d="M34 30 C42 18 52 13 62 12 C56 20 49 28 40 34 Z"/></g>
  <path class="body" d="M10 29 C10 19 17 13 25 13 C32 13 36 18 37 23 C42 24 47 28 49 34 C50 41 43 47 32 47 C20 47 10 40 10 29 Z"/>
  <path class="belly" d="M14 35 C18 43 26 46 34 45.6 C41 45.2 46 42 47 37 C41 41 33 42 25 40 C20 39 16 37 14 35 Z"/>
  <path class="throat" d="M11.5 31 C12.5 35 15.5 37 19 37.4 C17.8 34.6 16.6 32.4 15.8 30.4 Z"/>
  <path class="beak" d="M11 26.4 L3.6 28.6 L11.2 30.4 Z"/>
  <ellipse class="blush" cx="21.5" cy="31.5" rx="2.6" ry="1.5"/>
  <circle class="eye-w" cx="18.6" cy="24.2" r="3.6"/><circle class="eye" cx="18.2" cy="24.4" r="2.3"/><circle class="glint" cx="17.4" cy="23.5" r="0.85"/>
  <g class="wing"><path d="M27 29 C33 25 42 25 50 29 C56 32 59 35 61 39 C53 38 45 38 38 37 C32 36 28 33 27 29 Z"/><path class="feather" d="M38 31.5 C44 31.5 50 33.5 55 36.5"/></g>
  <path class="shine" d="M17 16.5 C20.5 14.6 25 14.6 28 16.4"/><path class="shine s2" d="M38 26.5 C41 27.3 44 29 46 31.4"/>
  <path class="foot" d="M27 46.5 v3.6 M32 46.6 v3.6"/>
</svg>`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// tiny, safe markdown: paragraphs, - lists, 1. lists, **bold**, *italic*, `code`, [text](https://…)
function md(src) {
  const inline = (s) => esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let list = null;
  for (const line of String(src).split('\n')) {
    const ul = /^\s*[-•*]\s+(.*)/.exec(line), ol = /^\s*\d+[.)]\s+(.*)/.exec(line);
    if (ul || ol) { const tag = ul ? 'ul' : 'ol'; if (!list || list.tag !== tag) { if (list) out.push(`</${list.tag}>`); list = { tag }; out.push(`<${tag}>`); } out.push(`<li>${inline((ul || ol)[1])}</li>`); continue; }
    if (list) { out.push(`</${list.tag}>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line.replace(/^#+\s*/, ''))}</p>`);
  }
  if (list) out.push(`</${list.tag}>`);
  return out.join('');
}

const KEY = 'ilisboa.alfacinha';
export function initAssistant({ camera, controls, marks, live, hud, ll, mobile }) {
  const root = document.createElement('div'); root.className = 'alf';
  root.innerHTML = `
    <button type="button" class="alf-nest" aria-label="${T.open}"><span class="alf-slot"></span></button>
    <section class="alf-panel" role="dialog" aria-label="${T.title}" hidden>
      <header class="alf-head"><span class="alf-perch"></span>
        <div class="alf-name"><b>${T.title}</b><small>${T.sub}</small></div>
        <button type="button" class="alf-reset" title="${T.reset}" aria-label="${T.reset}"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg></button>
        <button type="button" class="alf-x" title="${T.close}" aria-label="${T.close}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </header>
      <div class="alf-body"><div class="alf-log" aria-live="polite"></div><div class="alf-rail" aria-hidden="true"><i></i></div></div>
      <form class="alf-form"><textarea rows="1" maxlength="1000" placeholder="${T.ph}" enterkeyhint="send"></textarea>
        <button type="submit" class="alf-send" aria-label="${T.send}"><svg viewBox="0 0 24 24"><path d="M5 12h12M12 6l6 6-6 6"/></svg></button></form>
    </section>
    <button type="button" class="alf-peek" hidden></button>
    <div class="alf-bird">${BIRD}</div>`;
  document.body.appendChild(root);
  const $ = (s) => root.querySelector(s);
  const nest = $('.alf-nest'), panel = $('.alf-panel'), log = $('.alf-log'), form = $('.alf-form'), ta = $('textarea'), bird = $('.alf-bird'), peek = $('.alf-peek');

  // ─── history (this browser only) ───
  let msgs = [];
  try { msgs = JSON.parse(localStorage.getItem(KEY) || '[]').filter((m) => m && typeof m.content === 'string').slice(-24); } catch { msgs = []; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(msgs.slice(-24))); } catch { /* private mode */ } };

  function bubble(role, html, cls = '') {
    const el = document.createElement('div'); el.className = `alf-m ${role} ${cls}`; el.innerHTML = html; log.appendChild(el); return el;
  }
  function render() {
    log.innerHTML = '';
    bubble('a', md(T.hello), 'hello');
    for (const m of msgs) bubble(m.role === 'user' ? 'u' : 'a', m.role === 'user' ? `<p>${esc(m.content)}</p>` : md(m.content) + (m.sources?.length ? srcs(m.sources) : ''));
    if (!msgs.length) {
      const t = document.createElement('div'); t.className = 'alf-tips';
      t.innerHTML = T.tips.map((q) => `<button type="button">${esc(q)}</button>`).join('');
      t.onclick = (e) => { const b = e.target.closest('button'); if (b) ask(b.textContent); };
      log.appendChild(t);
    }
    scroll(true);
  }
  const srcs = (list) => `<div class="alf-src"><span>${T.sources}</span>${list.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(host(s.url))}</a>`).join('')}</div>`;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  let stick = true;
  log.addEventListener('scroll', () => { stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40; });
  const scroll = (force) => { if (force || stick) log.scrollTop = log.scrollHeight; };

  // ─── opening: the swallow flies from its nest to the panel's perch ───
  let open = false, flying = null;
  const place = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  // where the perch will be once the panel has settled (offsets ignore the panel's opening transform)
  const perchAt = () => { const h = $('.alf-head'), p = $('.alf-perch'); return { x: panel.offsetLeft + h.offsetLeft + p.offsetLeft, y: panel.offsetTop + h.offsetTop + p.offsetTop }; };
  function flyBird(from, to, dur, done) {
    flying?.cancel();
    const dx = to.x - from.x, dy = to.y - from.y, lift = -Math.min(120, 40 + Math.hypot(dx, dy) * 0.22);
    bird.style.left = `${to.x}px`; bird.style.top = `${to.y}px`;
    bird.classList.add('fly'); if (dx > 0) bird.classList.add('east'); else bird.classList.remove('east');
    flying = bird.animate([
      { transform: `translate(-50%,-50%) translate(${-dx}px,${-dy}px) scale(1)` },
      { transform: `translate(-50%,-50%) translate(${-dx * 0.45}px,${-dy * 0.45 + lift}px) scale(1.18)`, offset: 0.5 },
      { transform: 'translate(-50%,-50%) translate(0,0) scale(1)' },
    ], { duration: dur, easing: 'cubic-bezier(.45,.05,.3,1)' });
    flying.onfinish = () => { bird.classList.remove('fly', 'east'); flying = null; done?.(); };
  }
  function sit() {   // park the bird on its current spot without animation
    const pk = root.classList.contains('peeking') && peek.getBoundingClientRect();
    const to = pk ? { x: pk.left + 34, y: pk.top + pk.height / 2 } : open ? perchAt() : place($('.alf-slot'));
    bird.style.left = `${to.x}px`; bird.style.top = `${to.y}px`;
    bird.classList.toggle('perched', open);
  }
  // wide screens: the chat docks on the right edge where the layer dock lives, so the dock folds away while it's open
  // (and comes back after); opening the dock while chatting closes the chat
  const dock = document.querySelector('.dock'), dockBtn = dock?.querySelector('.dock-toggle'), wide = matchMedia('(min-width: 641px)');
  let dockWas = false, dockBusy = false;
  const foldDock = (v) => { if (!dockBtn || !wide.matches) return; if (v) { dockWas = dock.classList.contains('open'); if (dockWas) { dockBusy = true; dockBtn.click(); dockBusy = false; } } else if (dockWas && !dock.classList.contains('open')) { dockBusy = true; dockBtn.click(); dockBusy = false; dockWas = false; } };
  if (dock) new MutationObserver(() => { if (!dockBusy && open && wide.matches && dock.classList.contains('open')) { dockWas = false; setOpen(false); } }).observe(dock, { attributes: true, attributeFilter: ['class'] });
  function setOpen(v) {
    if (v === open) return;
    foldDock(v);
    const from = place(bird);
    open = v; root.classList.toggle('open', v); peek.hidden = true;
    if (v) {
      panel.hidden = false; render(); panel.classList.remove('in'); void panel.offsetWidth;
      setTimeout(() => panel.classList.add('in'), 120);
      flyBird(from, perchAt(), 820, () => { bird.classList.add('perched'); if (!mobile) ta.focus(); });
    } else {
      panel.classList.remove('in'); bird.classList.remove('perched'); ta.blur();
      flyBird(from, place($('.alf-slot')), 760);
      setTimeout(() => { if (!open) panel.hidden = true; }, 320);
    }
  }
  // ─── hand-made scrollbar: a glazed cobalt pill on a dotted rail (the native one is hidden) ───
  const rail = $('.alf-rail'), thumb = rail.firstElementChild;
  let idle;
  function railSync(show) {
    const H = log.clientHeight, S = log.scrollHeight, over = S - H > 2;
    rail.classList.toggle('off', !over); if (!over) return;
    const rh = rail.clientHeight, th = Math.max(28, (rh * H) / S), y = ((rh - th) * log.scrollTop) / (S - H);
    thumb.style.height = `${th}px`; thumb.style.transform = `translateY(${y}px)`;
    if (show) { rail.classList.add('on'); clearTimeout(idle); idle = setTimeout(() => rail.classList.remove('on'), 1300); }
  }
  log.addEventListener('scroll', () => railSync(true), { passive: true });
  new ResizeObserver(() => railSync()).observe(log);
  new MutationObserver(() => railSync()).observe(log, { childList: true, subtree: true, characterData: true });
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); thumb.setPointerCapture(e.pointerId); rail.classList.add('drag'); log.style.scrollBehavior = 'auto';
    const y0 = e.clientY, s0 = log.scrollTop, k = (log.scrollHeight - log.clientHeight) / Math.max(1, rail.clientHeight - thumb.offsetHeight);
    const mv = (ev) => { log.scrollTop = s0 + (ev.clientY - y0) * k; };
    const up = () => { rail.classList.remove('drag'); log.style.scrollBehavior = ''; thumb.removeEventListener('pointermove', mv); thumb.removeEventListener('pointerup', up); thumb.removeEventListener('pointercancel', up); railSync(true); };
    thumb.addEventListener('pointermove', mv); thumb.addEventListener('pointerup', up); thumb.addEventListener('pointercancel', up);
  });
  rail.addEventListener('pointerdown', (e) => {   // a click on the rail pages toward it
    if (e.target !== rail) return;
    const r = thumb.getBoundingClientRect();
    log.scrollBy({ top: (e.clientY < r.top ? -1 : 1) * log.clientHeight * 0.85, behavior: 'smooth' });
  });

  nest.onclick = () => setOpen(true);
  bird.onclick = () => { if (!open) setOpen(true); else if (root.classList.contains('peeking')) unpeek(); };
  $('.alf-x').onclick = () => setOpen(false);
  $('.alf-reset').onclick = () => { if (busy) ctl?.abort(); msgs = []; save(); render(); ta.focus(); };
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && document.activeElement === ta) setOpen(false); });
  addEventListener('resize', () => { if (!flying) sit(); });
  requestAnimationFrame(sit);
  // phones: when something is shown on the map, the sheet folds down to a peek so the city is visible
  function peekAt(text) {
    if (!mobile && innerWidth > 640) return;
    root.classList.add('peeking'); panel.classList.remove('in');
    setTimeout(() => { if (root.classList.contains('peeking')) { panel.hidden = true; sit(); } }, 300);
    peek.hidden = false; peek.innerHTML = `<span>${esc(text.replace(/[*_`#]/g, '').slice(0, 140))}${text.length > 140 ? '…' : ''}</span><small>${T.back}</small>`;
    requestAnimationFrame(() => { const pk = peek.getBoundingClientRect(); flyBird(place(bird), { x: pk.left + 34, y: pk.top + pk.height / 2 }, 600); });
  }
  function unpeek() { const from = place(bird); root.classList.remove('peeking'); peek.hidden = true; panel.hidden = false; void panel.offsetWidth; panel.classList.add('in'); flyBird(from, perchAt(), 600); scroll(true); }
  peek.onclick = unpeek;

  // ─── the keyboard on phones: keep the sheet above it ───
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => { const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop); root.style.setProperty('--kb', `${kb}px`); if (open && !flying) sit(); };
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit);
  }
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(110, ta.scrollHeight)}px`; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.onsubmit = (e) => { e.preventDefault(); const q = ta.value.trim(); if (q && !busy) { ta.value = ''; ta.style.height = 'auto'; ask(q); } };

  // ─── what the viewer is doing, for "aqui" questions ───
  function state() {
    const t = controls.target, [lat, lon] = toLatLon(t.x, -t.z);
    const f = live.following;
    return {
      view: { lat, lon, range: Math.round(camera.position.distanceTo(t)) },
      live: hud.live(), hour: hud.live() ? null : hhmm(hud.hour()),
      selected: marks.selected?.name || null, following: f ? `${f.key} ${f.id}` : null,
      layers: listLayers().filter((l) => l.on).map((l) => l.id), lang: navigator.language || 'pt-PT',
    };
  }
  const o = ll(0, 0), e1 = ll(0, 0.01), n1 = ll(0.01, 0);   // the viewer's tangent plane, inverted from two probes
  const mLon = (e1.x - o.x) / 0.01, mLat = -(n1.z - o.z) / 0.01, lat0 = o.z / mLat, lon0 = -o.x / mLon;
  const toLatLon = (x, y) => [lat0 + y / mLat, lon0 + x / mLon].map((v) => Math.round(v * 1e5) / 1e5);
  const hhmm = (h) => { const H = Math.floor(h), M = Math.round((h - H) * 60); return `${String(H % 24).padStart(2, '0')}:${String(M % 60).padStart(2, '0')}`; };

  // ─── actions the assistant asks for ───
  const SCALE = { street: 350, neighbourhood: 1100, city: 4200 };
  function act(a, lastText) {
    if (a.type === 'show') {
      const ok = a.qid && marks.select(a.qid, { orbit: true });
      if (!ok && isFinite(a.lat)) { const p = ll(a.lat, a.lon); marks.flyTo(p.x, -p.z, SCALE[a.scale] || 1100, { orbit: true }); }
      peekAt(lastText() || a.label || '');
    } else if (a.type === 'layer') setLayer(a.layer, a.on);
    else if (a.type === 'follow') {
      if (a.kind !== 'planes') setLayer(a.kind, true);   // planes always fly; their toggle is only the markers
      let n = 0; const tick = () => { live.follow(a.kind, a.id); if (!live.following && n++ < 20) setTimeout(tick, 400); };
      tick(); peekAt(lastText() || '');
    }
  }

  // ─── asking ───
  let busy = false, ctl = null;
  async function ask(q) {
    if (busy) return;
    if (root.classList.contains('peeking')) unpeek();
    busy = true; root.classList.add('busy');
    log.querySelector('.alf-tips')?.remove();
    msgs.push({ role: 'user', content: q }); save();
    bubble('u', `<p>${esc(q)}</p>`); stick = true; scroll(true);
    const el = bubble('a', '<div class="alf-status"><i></i><i></i><i></i><span></span></div>', 'live');
    const status = el.querySelector('.alf-status span'); status.textContent = T.thinking;
    let text = '', sources = [], pending = [], gotText = false;
    const paint = () => { el.innerHTML = md(text) + (pending.length ? `<div class="alf-status"><i></i><i></i><i></i><span>${esc(pending[pending.length - 1])}</span></div>` : '') + (sources.length ? srcs(sources) : ''); scroll(); };
    ctl = new AbortController();
    const fail = (msg, retry) => {
      el.classList.add('err'); el.innerHTML = `<p>${esc(msg)}</p>` + (retry ? `<button type="button" class="alf-retry">${T.retry}</button>` : '');
      if (retry) el.querySelector('button').onclick = () => { el.remove(); msgs.pop(); log.lastElementChild?.remove(); ask(q); };
      msgs.pop(); save();
    };
    try {
      const r = await fetch('/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: msgs.map(({ role, content }) => ({ role, content })), state: state() }), signal: ctl.signal });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        fail(r.status === 429 ? T[j.scope] || T.minute : r.status === 503 ? T.off : T.fail, r.status >= 500 && r.status !== 503);
        return;
      }
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).replace(/^data: /, ''); buf = buf.slice(i + 2);
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.t === 'text') { text += ev.d; gotText = true; pending = []; paint(); }
          else if (ev.t === 'tool') { pending.push(ev.label); paint(); }
          else if (ev.t === 'action') act(ev, () => text.trim());
          else if (ev.t === 'sources') { sources = ev.list || []; paint(); }
          else if (ev.t === 'error') { if (!text) { fail(ev.msg === 'busy' ? T.busy : T.fail, true); return; } }
        }
      }
      if (!text.trim()) { fail(T.fail, true); return; }
      pending = []; paint(); el.classList.remove('live');
      msgs.push({ role: 'assistant', content: text.trim(), sources }); save();
    } catch (err) {
      if (err.name !== 'AbortError') fail(T.fail, true); else el.remove();
    } finally { busy = false; ctl = null; root.classList.remove('busy'); }
  }

  return { open: () => setOpen(true), close: () => setOpen(false), ask: (q) => { setOpen(true); setTimeout(() => ask(q), 500); }, get isOpen() { return open; } };
}
