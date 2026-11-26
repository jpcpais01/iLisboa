// Sun direction for a local clock time in Lisbon on a given day of the year (default: late spring) and UTC offset (WET 0, WEST 1).
// Output frame: x = east, y = up, -z = north.
export function sunDirection(clockHours, latDeg, lonDeg, out, dayOfYear = 135, utcOffset = 1) {
  const rad = Math.PI / 180;
  const decl = 23.44 * rad * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));
  const solar = clockHours - utcOffset + lonDeg / 15; // clock → UTC → local solar time
  const H = (solar - 12) * 15 * rad;
  const lat = latDeg * rad;
  const el = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI; // from north, clockwise
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}
