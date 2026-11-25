// Minimal Mapbox Vector Tile decoder (protobuf wire format, no dependencies): line features with their tags.
export function decodeTile(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const td = new TextDecoder();
  function walk(s, e, fn) {
    let p = s;
    const varint = () => { let r = 0, m = 1, b; do { b = u8[p++]; r += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return r; };
    while (p < e) {
      const key = varint(), f = Math.floor(key / 8), w = key & 7;
      if (w === 0) fn(f, 0, varint());
      else if (w === 1) { fn(f, 1, dv.getFloat64(p, true)); p += 8; }
      else if (w === 5) { fn(f, 5, dv.getFloat32(p, true)); p += 4; }
      else if (w === 2) { const n = varint(); fn(f, 2, [p, p + n]); p += n; }
      else throw new Error('wire type ' + w);
    }
  }
  const packed = ([a, b]) => { const out = []; let p = a; while (p < b) { let r = 0, m = 1, c; do { c = u8[p++]; r += (c & 0x7f) * m; m *= 128; } while (c & 0x80); out.push(r); } return out; };
  const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
  const layers = [];
  walk(0, u8.length, (f, w, v) => {
    if (f !== 3 || w !== 2) return;
    const L = { name: '', extent: 4096, keys: [], values: [], feats: [] };
    walk(v[0], v[1], (f2, w2, v2) => {
      if (f2 === 1) L.name = td.decode(u8.subarray(v2[0], v2[1]));
      else if (f2 === 5) L.extent = v2;
      else if (f2 === 3) L.keys.push(td.decode(u8.subarray(v2[0], v2[1])));
      else if (f2 === 4) { let val = null; walk(v2[0], v2[1], (f3, w3, v3) => { val = f3 === 1 ? td.decode(u8.subarray(v3[0], v3[1])) : f3 === 6 ? zz(v3) : f3 === 7 ? !!v3 : v3; }); L.values.push(val); }
      else if (f2 === 2) { const F = { type: 0, tags: [], geom: [] }; walk(v2[0], v2[1], (f3, w3, v3) => { if (f3 === 3) F.type = v3; else if (f3 === 2) F.tags = packed(v3); else if (f3 === 4) F.geom = packed(v3); }); L.feats.push(F); }
    });
    layers.push(L);
  });
  // geometry commands → arrays of [x, y] in tile units
  for (const L of layers) for (const F of L.feats) {
    const props = {}; for (let i = 0; i + 1 < F.tags.length; i += 2) props[L.keys[F.tags[i]]] = L.values[F.tags[i + 1]];
    const lines = []; let x = 0, y = 0, cur = null;
    for (let i = 0; i < F.geom.length;) {
      const c = F.geom[i++], id = c & 7, n = c >> 3;
      if (id === 7) { if (cur && cur.length) cur.push(cur[0].slice()); continue; }
      for (let k = 0; k < n; k++) {
        x += zz(F.geom[i++]); y += zz(F.geom[i++]);
        if (id === 1) { cur = [[x, y]]; lines.push(cur); } else cur.push([x, y]);
      }
    }
    F.props = props; F.lines = lines; delete F.tags; delete F.geom;
  }
  return layers;
}
