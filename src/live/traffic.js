// Road traffic, coloured like a web map: green flowing → orange → red → dark red jammed.
//  · LIVE when the site has a TomTom key: /api/traffic returns the city's flow (speed vs free-flow) every 3 min.
//  · Otherwise TYPICAL: the 8.7k main roads from OSM, coloured by a time-of-day model of Lisbon's rush hours
//    (weekday morning and evening peaks, lighter weekends, the busiest axes hit hardest). Clearly labelled as such.
import * as THREE from 'three';
import { buildRibbons, drape, ribbonMaterial } from './ribbons.js';
import { lisbonNow } from './clock.js';
import { getFlow } from './flow.js';

const POLL = 180000;
// Google-like palette
const C = [new THREE.Color(0x7d1a1a), new THREE.Color(0xe8352b), new THREE.Color(0xf7923a), new THREE.Color(0x49c25d)];
const colorFor = (r, out) => r < 0.25 ? out.copy(C[0]) : r < 0.5 ? out.copy(C[1]) : r < 0.75 ? out.copy(C[2]) : out.copy(C[3]);
const W = [1.25, 1.1, 1.0, 0.85, 0.72, 0.62, 0.55];   // band width by road class, motorway first

// rush-hour hot spots (lon, lat → local metres at runtime): where Lisbon queues every working day
export const HOT = [
  [-9.1500, 38.7253, 700, 1.0],  // Marquês de Pombal / Fontes Pereira de Melo
  [-9.1458, 38.7195, 900, 0.7],  // Av. da Liberdade
  [-9.1700, 38.7580, 1600, 1.0], // 2.ª Circular west
  [-9.1350, 38.7600, 1400, 0.9], // 2.ª Circular east / airport
  [-9.1560, 38.7360, 1300, 0.9], // Eixo Norte-Sul / Av. Berna
  [-9.1770, 38.6960, 900, 1.0],  // Ponte 25 de Abril approach, Alcântara
  [-9.1950, 38.7330, 1300, 0.9], // A5 / Monsanto
  [-9.1330, 38.7080, 700, 0.6],  // Baixa / Terreiro do Paço
  [-9.1050, 38.7460, 1200, 0.6], // Av. Infante D. Henrique / Marvila
  [-9.1600, 38.7470, 900, 0.7],  // Praça de Espanha / Sete Rios
];

// congestion pressure for Lisbon right now (0 empty … 1 gridlock)
export function pressure() {
  const { h: hh, weekend: wkd } = lisbonNow(), h = hh % 24;
  const g = (c, w) => Math.exp(-((h - c) ** 2) / (2 * w * w));
  if (wkd) return 0.08 + 0.32 * g(13, 2.6) + 0.22 * g(18.5, 1.6);
  return 0.05 + 0.78 * g(8.75, 0.75) + 0.88 * g(18.4, 1.05) + 0.3 * g(13.3, 1.4);
}

export function createTraffic(ctx) {
  const { scene, ground, ll } = ctx;
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const mat = ribbonMaterial({ px: 2.4, minW: 1.4, opacity: 0.9, casing: 0.58 });
  let mesh = null, roads = null, source = '', shownT = 0, timer = 0, on = false, lastDrape = -1, error = '', when = 0;
  const hot = HOT.map(([lon, lat, r, k]) => { const v = ll(lat, lon); return [v.x, -v.z, r, k]; });

  function setMesh(lines) {
    if (mesh) { group.remove(mesh); mesh.geometry.dispose(); }
    mesh = new THREE.Mesh(buildRibbons(lines), mat);
    mesh.frustumCulled = false; mesh.renderOrder = 9;
    group.add(mesh); lastDrape = -1;
  }

  async function loadRoads() {
    if (roads) return roads;
    const b = await (await fetch('/live/roads.bin')).arrayBuffer(), dv = new DataView(b);
    const n = dv.getUint32(0, true), out = [];
    let o = 4;
    for (let i = 0; i < n; i++) {
      const c = dv.getUint8(o), k = dv.getUint16(o + 1, true); o += 3;
      const pts = [];
      for (let j = 0; j < k; j++, o += 4) pts.push([dv.getInt16(o, true) / 2, dv.getInt16(o + 2, true) / 2]);
      const cls = c & 0x7f, mid = pts[pts.length >> 1];
      // per-road sensitivity: busier classes and hot spots queue more; a hash keeps neighbours from looking identical
      let hs = 0; for (const [hx, hy, r, kk] of hot) hs = Math.max(hs, kk * Math.exp(-((mid[0] - hx) ** 2 + (mid[1] - hy) ** 2) / (r * r)));
      const seed = Math.abs(Math.sin(mid[0] * 0.0123 + mid[1] * 0.0371) * 43758.5453) % 1;
      out.push({ cls, pts, sens: [1, 0.95, 0.8, 0.62, 0.45][cls] * (0.55 + 0.6 * seed) + hs * 0.7, seed });
    }
    return (roads = out);
  }

  function colourTypical() {
    const P = pressure(), t = Date.now() / 600000;   // drifts over ~10 min so the map breathes
    const ca = mesh.geometry.attributes.aColor.array, f = mesh.geometry.userData.first, c = new THREE.Color();
    roads.forEach((r, i) => {
      const wobble = 0.85 + 0.3 * Math.sin(t + r.seed * 40);
      colorFor(1 - Math.min(1, P * r.sens * wobble * 0.75), c);
      for (let v = f[i]; v < f[i + 1]; v++) { ca[v * 3] = c.r; ca[v * 3 + 1] = c.g; ca[v * 3 + 2] = c.b; }
    });
    mesh.geometry.attributes.aColor.needsUpdate = true;
  }

  async function poll() {
    if (!on) return;
    if (document.visibilityState === 'visible') {
      try {
        const d = await getFlow();
        if (d.source === 'tomtom' && d.segs?.length) {
          if (d.t === shownT && source === 'tomtom') { timer = setTimeout(poll, POLL); return; }   // same city as on screen (shared, cached feed)
          shownT = d.t;
          const c = new THREE.Color();
          setMesh(d.segs.filter((s) => s[1] <= 5).map((s) => {
            const pts = []; for (let i = 2; i + 1 < s.length; i += 2) pts.push([s[i], s[i + 1]]);
            return { pts, color: colorFor(s[0] / 100, c).toArray(), w: W[s[1]] ?? 0.6, off: 0.55 };   // drawn on its side of the road, like a map
          }));
          source = 'tomtom'; when = d.t ? d.t * 1000 : Date.now(); error = '';
        } else {
          if (source !== 'typical') { const rs = await loadRoads(); setMesh(rs.map((r) => ({ pts: r.pts, w: W[r.cls] }))); source = 'typical'; }
          colourTypical(); when = Date.now();
        }
      } catch (e) { error = String(e.message || e); }
      ctx.status();
    }
    timer = setTimeout(poll, source === 'typical' ? 60000 : POLL);
  }

  return {
    get on() { return on; },
    set(v) { on = v; group.visible = v; clearTimeout(timer); if (v) poll(); },
    update() {
      if (!on || !mesh) return;
      if (lastDrape !== ground.version) { drape(mesh.geometry, ground, 0.6); lastDrape = ground.version; }
    },
    status() {
      if (!on) return '';
      if (!source) return error ? 'sem dados' : 'a carregar…';
      if (source === 'tomtom') return `ao vivo · TomTom · ${new Date(when).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}`;
      return 'típico para esta hora (estimado)';
    },
    get source() { return source; },
    pickables: () => [],
  };
}
