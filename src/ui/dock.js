// The layer dock, top right: every layer in src/layers/registry.js as a tile, grouped (Ao vivo · Tempo · Cidade),
// with its status line, the legends of whatever is on, and the actions (Conduzir). Folds into one "Camadas" button
// (with a count of what is on); open by default on wide screens, folded on phones, and remembered.
import { listLayers, listActions, onLayersChange, setLayer, GROUPS } from '../layers/registry.js';

const ICON_LAYERS = '<path d="M12 3.5 21 8l-9 4.5L3 8z"/><path d="m3.5 12 8.5 4.3 8.5-4.3"/><path d="m3.5 16 8.5 4.3 8.5-4.3"/>';
const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;

export function initDock() {
  const nav = document.createElement('nav');
  nav.className = 'dock'; nav.setAttribute('aria-label', 'Camadas');
  nav.innerHTML = `<button type="button" class="dock-toggle" aria-expanded="false">${svg(ICON_LAYERS)}<span>Camadas</span><b class="n" hidden></b><i class="chev"></i></button>
    <div class="dock-panel" id="dock-panel"></div><div class="dock-legends"></div>`;
  document.body.appendChild(nav);
  const toggle = nav.querySelector('.dock-toggle'), panel = nav.querySelector('.dock-panel'), legends = nav.querySelector('.dock-legends');
  toggle.setAttribute('aria-controls', 'dock-panel');

  const narrow = matchMedia('(max-width: 600px)');
  let open;
  try { open = JSON.parse(localStorage.getItem('ilisboa.dock') ?? 'null'); } catch { /* private mode */ }
  if (typeof open !== 'boolean' || narrow.matches) open = !narrow.matches;
  const setOpen = (v, save = true) => {
    open = v; nav.classList.toggle('open', v); toggle.setAttribute('aria-expanded', String(v));
    if (save && !narrow.matches) try { localStorage.setItem('ilisboa.dock', JSON.stringify(v)); } catch { /* ignore */ }
  };
  toggle.addEventListener('click', () => setOpen(!open));
  // phones: a tap on the map folds the dock away (the map is the point)
  addEventListener('pointerdown', (e) => { if (open && narrow.matches && !nav.contains(e.target)) setOpen(false, false); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && narrow.matches) setOpen(false, false); });

  const tiles = new Map(), groups = new Map(), legendEls = new Map();
  let actionsRow = null;
  function group(g) {
    if (!groups.has(g)) {
      const s = document.createElement('section');
      s.dataset.g = g; s.innerHTML = `<h2>${GROUPS[g] || g}</h2><div class="grid"></div>`;
      groups.set(g, s);
      // keep the groups in their canonical order, unknown ones last
      const order = Object.keys(GROUPS), at = order.indexOf(g);
      const next = [...groups.entries()].filter(([k]) => k !== g).map(([k, el]) => [order.indexOf(k) < 0 ? 99 : order.indexOf(k), el])
        .filter(([i]) => i > (at < 0 ? 99 : at)).sort((a, b) => a[0] - b[0])[0]?.[1];
      panel.insertBefore(s, next || actionsRow || null);
    }
    return groups.get(g).querySelector('.grid');
  }
  function render() {
    let n = 0;
    for (const l of listLayers()) {
      let t = tiles.get(l.id);
      if (!t) {
        t = document.createElement('button');
        t.type = 'button'; t.className = 'tile'; t.dataset.id = l.id;
        t.innerHTML = `${svg(l.icon)}<span class="tx"><span class="t"></span><span class="s"></span></span>`;
        t.addEventListener('click', () => setLayer(l.id));
        group(l.group).appendChild(t); tiles.set(l.id, t);
      }
      t.querySelector('.t').textContent = l.label;
      let st = ''; try { st = l.on ? l.status() || '' : ''; } catch { /* a layer's status must never break the dock */ }
      t.querySelector('.s').textContent = st;
      t.title = st ? `${l.label} · ${st}` : l.label;
      t.setAttribute('aria-pressed', String(l.on));
      t.classList.toggle('wide', !!st);
      if (l.on) n++;
      // legends: shown (outside the fold too) while the layer is on
      if (l.legend) {
        let lg = legendEls.get(l.id);
        if (!lg) {
          lg = typeof l.legend === 'string' ? Object.assign(document.createElement('div'), { innerHTML: l.legend }) : l.legend;
          lg.classList.add('legend'); legendEls.set(l.id, lg); legends.appendChild(lg);
        }
        lg.hidden = !l.on;
      }
    }
    const acts = listActions();
    if (acts.length) {
      if (!actionsRow) { actionsRow = document.createElement('div'); actionsRow.className = 'actions'; panel.appendChild(actionsRow); }
      for (const a of acts) {
        let b = actionsRow.querySelector(`[data-a="${a.id}"]`);
        if (!b) {
          b = document.createElement('button'); b.type = 'button'; b.dataset.a = a.id;
          b.innerHTML = `${svg(a.icon)}<span>${a.label}</span>`;
          b.addEventListener('click', () => { a.run(); if (narrow.matches) setOpen(false, false); });
          actionsRow.appendChild(b);
        }
        b.setAttribute('aria-pressed', String(!!a.active));
      }
    }
    const nb = toggle.querySelector('.n');
    nb.hidden = !n; nb.textContent = n;
  }
  let raf = 0;
  onLayersChange(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); });
  render();
  setOpen(open, false);
  return { open: () => setOpen(true), close: () => setOpen(false) };
}
