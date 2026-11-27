// Minimal GTFS-Realtime VehiclePosition decoder (protobuf wire format, no dependencies).
// Only the fields the map needs: trip.route_id / trip_id / direction, vehicle id + label, position, status, timestamp.
export function decodeVehicles(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const td = new TextDecoder();
  // walk one message between [s, e): calls fn(field, wireType, valueOrRange)
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
  const str = ([a, b]) => td.decode(u8.subarray(a, b));
  const out = [];
  let headerTs = 0;
  walk(0, u8.length, (f, w, v) => {
    if (f === 1 && w === 2) walk(v[0], v[1], (f2, w2, v2) => { if (f2 === 3 && w2 === 0) headerTs = v2; });
    if (f !== 2 || w !== 2) return;
    let veh = null;
    walk(v[0], v[1], (f2, w2, v2) => { if (f2 === 4 && w2 === 2) veh = v2; });
    if (!veh) return;
    const o = { route: '', trip: '', dir: -1, id: '', label: '', lat: NaN, lon: NaN, bearing: 0, speed: -1, status: 2, ts: 0, stop: '' };
    walk(veh[0], veh[1], (f3, w3, v3) => {
      if (f3 === 1 && w3 === 2) walk(v3[0], v3[1], (f4, w4, v4) => { if (f4 === 1) o.trip = str(v4); else if (f4 === 5) o.route = str(v4); else if (f4 === 6) o.dir = v4; });
      else if (f3 === 8 && w3 === 2) walk(v3[0], v3[1], (f4, w4, v4) => { if (f4 === 1) o.id = str(v4); else if (f4 === 2) o.label = str(v4); });
      else if (f3 === 2 && w3 === 2) walk(v3[0], v3[1], (f4, w4, v4) => { if (f4 === 1) o.lat = v4; else if (f4 === 2) o.lon = v4; else if (f4 === 3) o.bearing = v4; else if (f4 === 5) o.speed = v4; });
      else if (f3 === 4 && w3 === 0) o.status = v3;
      else if (f3 === 5 && w3 === 0) o.ts = v3;
      else if (f3 === 7 && w3 === 2) o.stop = str(v3);
    });
    out.push(o);
  });
  return { ts: headerTs, vehicles: out };
}
