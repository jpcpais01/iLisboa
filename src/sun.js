// Sun direction for a local clock time in Lisbon (WEST, UTC+1) on a late-spring day.
// Output frame: x = east, y = up, -z = north.
export function sunDirection(clockHours, latDeg, lonDeg, out, dayOfYear = 135) {
  const rad = Math.PI / 180;
  const decl = 23.44 * rad * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));
  const solar = clockHours - 1 + lonDeg / 15; // UTC+1 → local solar time
  const H = (solar - 12) * 15 * rad;
  const lat = latDeg * rad;
  const el = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI; // from north, clockwise
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}
