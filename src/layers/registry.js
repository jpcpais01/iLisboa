// Layer registry: every toggleable layer (live, weather, city) registers here; the dock (src/ui/dock.js) renders it.
// registerLayer({ id, label, group: 'live' | 'weather' | 'city', icon, set(on), on?, status?, legend?, exclusive? })
//   icon: inner markup of a 24×24 stroke SVG; status(): short line under the label; legend: HTMLElement or html string shown while on;
//   exclusive: layers sharing this key switch each other off (e.g. the weather maps).
// Returns { id, setOn(v), refresh() }. On/off state persists in localStorage and ?layers=a,b (?live=… still works).
const KEY = 'ilisboa.layers';
const layers = new Map();
const subs = new Set();
const Q = new URLSearchParams(location.search);
const fromUrl = Q.get('layers') ?? Q.get('live');
let saved;
try { saved = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem('ilisboa.live') ?? '[]'); } catch { saved = []; }
const initial = new Set(fromUrl != null ? fromUrl.split(',').filter(Boolean) : saved);
// layers this browser has already been offered: a default-on layer that ships later switches on once for everyone
let known; try { known = new Set(JSON.parse(localStorage.getItem('ilisboa.layers.known') || '[]')); } catch { known = new Set(); }
const emit = (id) => { for (const f of subs) try { f(id); } catch (e) { console.error(e); } };
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify([...layers.values()].filter((l) => l.on).map((l) => l.id))); } catch { /* private mode */ } };

export const GROUPS = { live: 'Ao vivo', weather: 'Tempo', city: 'Cidade' };

export function setLayer(id, v) {
  const l = layers.get(id);
  if (!l) return;
  v = v == null ? !l.on : !!v;
  if (v === l.on) return;
  if (v && l.exclusive) for (const o of layers.values()) if (o !== l && o.on && o.exclusive === l.exclusive) { o.on = false; o.set(false); emit(o.id); }
  l.on = v; l.set(v); persist(); emit(id);
}

export function registerLayer(def) {
  if (!def?.id || typeof def.set !== 'function') throw new Error('registerLayer needs { id, set }');
  const l = { group: 'city', icon: '', status: () => '', ...def, on: false };
  layers.set(l.id, l);
  const handle = { id: l.id, setOn: (v) => setLayer(l.id, v), refresh: () => emit(l.id), get on() { return l.on; } };
  emit(l.id);
  if (initial.has(l.id) || (def.on && fromUrl == null && (!saved.length || !known.has(l.id)))) setLayer(l.id, true);
  if (!known.has(l.id)) { known.add(l.id); try { localStorage.setItem('ilisboa.layers.known', JSON.stringify([...known])); } catch { /* private mode */ } }
  return handle;
}

export const listLayers = () => [...layers.values()];
export const getLayer = (id) => layers.get(id);
export function onLayersChange(cb) { subs.add(cb); return () => subs.delete(cb); }

// Actions (e.g. "Conduzir") sit in the dock next to the layers but are buttons, not on/off state that persists.
const actions = new Map();
export function registerAction(def) {
  const a = { icon: '', active: false, ...def };
  actions.set(a.id, a); emit(a.id);
  return { id: a.id, setActive: (v) => { a.active = !!v; emit(a.id); } };
}
export const listActions = () => [...actions.values()];
