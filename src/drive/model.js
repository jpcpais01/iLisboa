// The drivable car: a Lisbon taxi (black, green roof, roof sign), modelled a step above the parked cars because it is
// always a few metres from the camera. Body, glass and lamps are one merged mesh; the four wheels are separate so they
// spin and the front pair steers. Brake lamps, headlamps and the roof sign glow through emissive materials.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const tint = (g, hex) => {
  g = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
};
// side profile (x along the car, y up) extruded across its width, softly bevelled
const prof = (pts, width, bevel) => {
  const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4 });
  return g.translate(0, 0, -(width - 2 * bevel) / 2);
};
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

export const CAR_DIM = { L: 4.5, W: 1.8, wheelbase: 2.7, track: 1.52, wheelR: 0.34, axleF: 1.36, axleR: -1.34 };

export function createCarModel() {
  const BLACK = 0x141518, GREEN = 0x2f6b45, GLASS = 0x1b2229, TRIM = 0x0b0b0c, CHROME = 0xb9bec4;
  const body = prof([[-2.22, 0.3], [2.2, 0.3], [2.27, 0.5], [2.22, 0.76], [1.32, 0.9], [-1.78, 0.97], [-2.18, 0.9], [-2.27, 0.6]], 1.8, 0.09);
  // wheel arches: dark boxes inset into the sill read as cut-outs at driving distance
  const arches = [];
  for (const x of [CAR_DIM.axleF, CAR_DIM.axleR]) for (const z of [-0.86, 0.86]) arches.push(tint(box(0.95, 0.42, 0.12, x, 0.48, z), TRIM));
  const glass = prof([[-1.7, 0.95], [1.26, 0.93], [0.45, 1.4], [-1.44, 1.44], [-1.72, 1.15]], 1.62, 0.05);
  const roof = prof([[-1.48, 1.39], [0.47, 1.37], [0.38, 1.48], [-1.36, 1.5]], 1.54, 0.03);
  const pillar = (x) => tint(box(0.1, 0.44, 1.64, x, 1.17, 0), BLACK);
  const parts = [
    tint(body, BLACK), ...arches, tint(glass, GLASS), tint(roof, GREEN), pillar(-0.42),
    tint(box(4.42, 0.12, 1.84, 0, 0.36, 0), TRIM),                           // rubbing strip / sills
    tint(box(0.08, 0.22, 1.5, 2.26, 0.42, 0), TRIM),                         // front bumper
    tint(box(0.08, 0.22, 1.5, -2.3, 0.44, 0), TRIM),                         // rear bumper
    tint(box(0.06, 0.14, 1.1, 2.24, 0.62, 0), CHROME),                       // grille
    tint(box(0.05, 0.15, 0.52, -2.29, 0.62, 0), 0xe6dfbf),                    // number plates
    tint(box(0.05, 0.12, 0.52, 2.27, 0.38, 0), 0xe6dfbf),
    tint(box(0.12, 0.08, 0.18, 0.62, 1.0, -0.95), TRIM), tint(box(0.12, 0.08, 0.18, 0.62, 1.0, 0.95), TRIM),   // mirrors
  ];
  const shell = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 2.2 }));
  shell.castShadow = true; shell.receiveShadow = true;

  // lamps: separate emissive meshes so they can glow on their own
  const lampMat = (hex) => new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0, roughness: 0.2 });
  const head = new THREE.Mesh(mergeGeometries([box(0.06, 0.13, 0.34, 2.24, 0.68, 0.6), box(0.06, 0.13, 0.34, 2.24, 0.68, -0.6)]), lampMat(0xfff6e0));
  const tail = new THREE.Mesh(mergeGeometries([box(0.06, 0.16, 0.32, -2.28, 0.78, 0.62), box(0.06, 0.16, 0.32, -2.28, 0.78, -0.62)]), lampMat(0xd0160f));
  const sign = new THREE.Mesh(box(0.34, 0.16, 0.62, -0.55, 1.58, 0), lampMat(0xf5ecd0));
  head.material.emissiveIntensity = 0.15;

  // wheels: tyre + rim + hub, axis along z; front ones sit in a steering pivot
  const wheelGeo = mergeGeometries([
    tint(new THREE.CylinderGeometry(CAR_DIM.wheelR, CAR_DIM.wheelR, 0.22, 18).rotateX(Math.PI / 2), 0x111113),
    tint(new THREE.CylinderGeometry(0.21, 0.21, 0.235, 10).rotateX(Math.PI / 2), 0x9ea3a8),
    tint(new THREE.BoxGeometry(0.36, 0.05, 0.24), 0x6d7277), tint(new THREE.BoxGeometry(0.05, 0.36, 0.24), 0x6d7277),   // spokes show the spin
  ]);
  const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 });
  const wheels = [];
  const car = new THREE.Group(), chassis = new THREE.Group();
  car.add(chassis); chassis.add(shell, head, tail, sign);
  for (const [x, front] of [[CAR_DIM.axleF, true], [CAR_DIM.axleR, false]]) for (const z of [-CAR_DIM.track / 2, CAR_DIM.track / 2]) {
    const pivot = new THREE.Group(), w = new THREE.Mesh(wheelGeo, wheelMat);
    pivot.position.set(x, CAR_DIM.wheelR, z); w.castShadow = true;
    pivot.add(w); car.add(pivot);
    wheels.push({ pivot, w, front });
  }
  // a soft contact shadow so the car sits on the street even outside the sun's shadow map
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, opacity: 0.5,
    map: (() => { const c = document.createElement('canvas'); c.width = 64; c.height = 32; const x = c.getContext('2d'); const g = x.createRadialGradient(32, 16, 2, 32, 16, 30); g.addColorStop(0, 'rgba(0,0,0,.75)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.setTransform(1, 0, 0, 0.5, 0, 8); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })(),
    polygonOffset: true, polygonOffsetFactor: -2,
  }));
  blob.position.y = 0.04; blob.renderOrder = 1; car.add(blob);

  let spin = 0;
  return {
    object: car, chassis,
    // steer (rad), distance rolled (m), braking 0..1, night 0..1
    pose(steer, rolled, braking, night, reversing) {
      spin = -rolled / CAR_DIM.wheelR;
      for (const k of wheels) { k.w.rotation.z = spin; k.pivot.rotation.y = k.front ? steer : 0; }
      tail.material.emissiveIntensity = Math.max(0.25 * night + 0.05, braking * 2.4) + (reversing ? 0.6 : 0);
      head.material.emissiveIntensity = 0.15 + 2.2 * night;
      sign.material.emissiveIntensity = 0.1 + 1.4 * night;
    },
  };
}
