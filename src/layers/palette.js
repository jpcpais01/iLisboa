// Colour ramps shared by the map layers: stops are sRGB hex, sampled with linear blending between neighbours.
const cache = new Map();
const parse = (stops) => {
  let p = cache.get(stops);
  if (!p) { p = stops.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]); cache.set(stops, p); }
  return p;
};
export function ramp(stops, f, out = [0, 0, 0]) {
  const p = parse(stops), x = Math.min(0.99999, Math.max(0, f)) * (p.length - 1), i = Math.floor(x), t = x - i, a = p[i], b = p[i + 1];
  out[0] = Math.round(a[0] + (b[0] - a[0]) * t); out[1] = Math.round(a[1] + (b[1] - a[1]) * t); out[2] = Math.round(a[2] + (b[2] - a[2]) * t);
  return out;
}
export const rampCss = (stops) => `linear-gradient(90deg, ${stops.join(', ')})`;
