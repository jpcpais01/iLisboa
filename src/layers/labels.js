// Map labels: small HTML pills pinned to points of the city (x east, y north, z up, local metres).
// Repositioned on every rendered frame while shown; hidden behind the camera, beyond maxD, or off screen.
import * as THREE from 'three';

let root = null;
const v = new THREE.Vector3();

export function createLabels(camera, canvas, cls = '') {
  if (!root) { root = document.createElement('div'); root.className = 'maplabels'; document.body.appendChild(root); }
  const box = document.createElement('div'); box.className = `maplabel-set ${cls}`; box.hidden = true; root.appendChild(box);
  let items = [];
  return {
    set(list) {   // [{ x, y, z, html, cls?, minD?, maxD?, onClick? }]
      box.textContent = '';
      items = list.map((it) => {
        const el = document.createElement(it.onClick ? 'button' : 'div');
        el.className = `maplabel ${it.cls || ''}`; el.innerHTML = it.html;
        if (it.onClick) { el.type = 'button'; el.addEventListener('click', (e) => { e.stopPropagation(); it.onClick(e); }); }
        box.appendChild(el);
        return { ...it, el, shown: null };
      });
    },
    show(on) { box.hidden = !on; },
    update() {
      if (box.hidden) return;
      const w = canvas.clientWidth, h = canvas.clientHeight, cp = camera.position;
      for (const it of items) {
        v.set(it.x, it.z, -it.y);
        const d = v.distanceTo(cp);
        v.project(camera);
        const vis = v.z < 1 && d < (it.maxD ?? 9000) && d > (it.minD ?? 0) && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        if (vis !== it.shown) { it.el.style.display = vis ? '' : 'none'; it.shown = vis; }
        if (!vis) continue;
        it.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
        it.el.style.opacity = String(Math.min(1, ((it.maxD ?? 9000) - d) / 800, it.minD ? (d - it.minD) / 800 : 1));
      }
    },
  };
}
