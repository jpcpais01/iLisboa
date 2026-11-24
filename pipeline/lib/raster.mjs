// Tiny CPU rasterizer for the ground map: polygons, thick polylines, discs.
// A Raster maps local metres (x east, y north) onto a pixel grid (row 0 = north).
export class Raster {
  constructor(minX, minY, maxX, maxY, mpp, channels = 1, Type = Uint8Array) {
    this.minX = minX; this.maxY = maxY; this.mpp = mpp;
    this.w = Math.ceil((maxX - minX) / mpp);
    this.h = Math.ceil((maxY - minY) / mpp);
    this.ch = channels;
    this.data = new Type(this.w * this.h * channels);
  }
  px(x) { return (x - this.minX) / this.mpp; }
  py(y) { return (this.maxY - y) / this.mpp; }

  // Even-odd scanline fill of rings (arrays of [x,y] in metres). cb(index) per covered pixel.
  fillRings(rings, cb) {
    const edges = [];
    let y0 = Infinity, y1 = -Infinity;
    for (const r of rings) {
      for (let i = 0, n = r.length; i < n; i++) {
        const ax = this.px(r[i][0]), ay = this.py(r[i][1]);
        const b = r[(i + 1) % n], bx = this.px(b[0]), by = this.py(b[1]);
        if (ay === by) continue;
        edges.push(ay < by ? [ay, by, ax, (bx - ax) / (by - ay)] : [by, ay, bx, (ax - bx) / (ay - by)]);
        y0 = Math.min(y0, ay, by); y1 = Math.max(y1, ay, by);
      }
    }
    const rs = Math.max(0, Math.floor(y0)), re = Math.min(this.h - 1, Math.ceil(y1));
    const xs = [];
    for (let row = rs; row <= re; row++) {
      const yc = row + 0.5;
      xs.length = 0;
      for (const e of edges) if (yc >= e[0] && yc < e[1]) xs.push(e[2] + (yc - e[0]) * e[3]);
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(this.w - 1, Math.floor(xs[k + 1] - 0.5));
        for (let c = c0; c <= c1; c++) cb(row * this.w + c);
      }
    }
  }

  // Thick polyline: one quad per segment + round joins.
  strokeLine(pts, width, cb) {
    const hw = width / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      const nx = (-dy / L) * hw, ny = (dx / L) * hw;
      this.fillRings([[[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]], cb);
    }
    if (width > this.mpp * 2) for (const p of pts) this.disc(p[0], p[1], hw, cb);
  }

  disc(x, y, r, cb) {
    const cx = this.px(x), cy = this.py(y), rp = r / this.mpp;
    const r0 = Math.max(0, Math.floor(cy - rp)), r1 = Math.min(this.h - 1, Math.ceil(cy + rp));
    for (let row = r0; row <= r1; row++) {
      const dy = row + 0.5 - cy, span = Math.sqrt(Math.max(0, rp * rp - dy * dy));
      const c0 = Math.max(0, Math.ceil(cx - span - 0.5)), c1 = Math.min(this.w - 1, Math.floor(cx + span - 0.5));
      for (let c = c0; c <= c1; c++) cb(row * this.w + c);
    }
  }
}

// Separable box blur on a single-channel Float32 grid, repeated n times (≈ gaussian).
export function boxBlur(src, w, h, r, n = 3) {
  let a = Float32Array.from(src), b = new Float32Array(a.length);
  for (let pass = 0; pass < n; pass++) {
    for (let y = 0; y < h; y++) {
      let acc = 0; const o = y * w;
      for (let x = -r; x <= r; x++) acc += a[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[o + x] = acc / (2 * r + 1);
        acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / (2 * r + 1);
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}
