// Sanity scan of built tiles: reports vertices far below the diorama (stray geometry).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import fs from 'node:fs';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const dir = 'public/tiles/baixa-alfama/';
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.glb'))) {
  const doc = await io.read(dir + f);
  for (const node of doc.getRoot().listNodes()) {
    const m = node.getMesh(); if (!m) continue;
    const t = node.getTranslation(), s = node.getScale();
    for (const pr of m.listPrimitives()) {
      const pos = pr.getAttribute('POSITION'); const n = pos.getCount(); let bad = 0, minY = 1e9; const ex = [];
      const idx = pr.getIndices();
      for (let i = 0; i < n; i++) { const v = pos.getElement(i, []); const y = v[1] * s[1] + t[1]; minY = Math.min(minY, y); if (y < -30) { bad++; if (ex.length < 3) ex.push(v.map((a, k) => (a * s[k] + t[k]).toFixed(1))); } }
      console.log(f, node.getName(), n, 'minY', minY.toFixed(1), 'below-30:', bad, ex.join(' | '));
    }
  }
}
