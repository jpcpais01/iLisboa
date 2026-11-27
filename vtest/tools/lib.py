"""Shared helpers for the fly-through test: frames, depth, cameras, the photo-mode fidelity metric, true-motion warps."""
import json, os, numpy as np, cv2

ROOT = os.path.dirname(os.path.abspath(__file__))
FR = os.path.join(ROOT, 'frames')
W, H = 1920, 1080


def meta():
    return json.load(open(os.path.join(FR, 'meta.json')))


def frame(i):
    return cv2.imread(os.path.join(FR, f'f{i:04d}.jpg'))  # BGR uint8


def depth(i):
    return np.fromfile(os.path.join(FR, f'z{i:04d}.f32'), dtype=np.float32).reshape(H, W)  # -1 = sky


def cam(i, m=None):
    m = m or meta()
    c = m['frames'][i]['cam']
    Wm = np.array(c['world'], dtype=np.float64).reshape(4, 4).T  # three.js column-major
    P = np.array(c['proj'], dtype=np.float64).reshape(4, 4).T
    return Wm, P


# ─── maps the image model sees (same as src/ui/aiphoto.js) ───
def depth_png(z):
    sky = z < 0
    lz = -np.log(np.where(sky, 1, z))
    v = lz[~sky][::7]
    lo, hi = np.quantile(v, 0.005), np.quantile(v, 0.995)
    o = np.round(255 * (0.1 + 0.9 * np.clip((lz - lo) / max(1e-6, hi - lo), 0, 1)))
    o[sky] = 0
    return o.astype(np.uint8)


def geo_edges(z):
    lz = np.log(np.where(z < 0, 1e5, z))
    e = np.zeros(z.shape, bool)
    l, r, u, d, c = lz[1:-1, :-2], lz[1:-1, 2:], lz[:-2, 1:-1], lz[2:, 1:-1], lz[1:-1, 1:-1]
    e[1:-1, 1:-1] = (np.abs(r - l) > 0.12) | (np.abs(d - u) > 0.12) | (np.abs(r - 2 * c + l) > 0.02) | (np.abs(d - 2 * c + u) > 0.02)
    return e


def resample_depth(z, long=960):
    s = long / max(z.shape[1], z.shape[0])
    w, h = round(z.shape[1] * s), round(z.shape[0] * s)
    ys = np.minimum(z.shape[0] - 1, ((np.arange(h) + 0.5) / s).astype(int))
    xs = np.minimum(z.shape[1] - 1, ((np.arange(w) + 0.5) / s).astype(int))
    return z[ys][:, xs]


def img_edges(bgr, w, h):
    g = cv2.resize(bgr, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
    g = 0.299 * g[..., 2] + 0.587 * g[..., 1] + 0.114 * g[..., 0]
    k = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]], np.float32) / 16
    b = cv2.filter2D(g, -1, k, borderType=cv2.BORDER_CONSTANT)
    gx = cv2.Sobel(b, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(b, cv2.CV_32F, 0, 1, ksize=3)
    m = np.hypot(gx, gy)
    m[:2] = m[-2:] = 0
    m[:, :2] = m[:, -2:] = 0
    t = max(8, np.sort(m.ravel())[int(m.size * 0.8)])
    e = (m > t).astype(np.uint8)
    return cv2.dilate(e, np.ones((3, 3), np.uint8)) > 0


def fidelity(z, render_bgr, ai_bgr, G=None):
    """photo-mode 'fiel à geometria' (0–100): per 20 px cell, AI edge recall on geometry edges relative to the render's"""
    d = resample_depth(z, 960)
    h, w = d.shape
    G = geo_edges(d) if G is None else G
    er, ea = img_edges(render_bgr, w, h), img_edges(ai_bgr, w, h)
    B = 20
    s, n = 0.0, 0
    for y0 in range(0, h, B):
        for x0 in range(0, w, B):
            g = G[y0:y0 + B, x0:x0 + B]
            gc = g.sum()
            if gc < 12:
                continue
            r = (er[y0:y0 + B, x0:x0 + B] & g).sum()
            a = (ea[y0:y0 + B, x0:x0 + B] & g).sum()
            if r / gc < 0.3:
                continue
            s += min(1, a / r)
            n += 1
    return round(100 * s / n) if n else None


# ─── geometry: pixels ↔ world ───
def pix_grid():
    x, y = np.meshgrid(np.arange(W, dtype=np.float64) + 0.5, np.arange(H, dtype=np.float64) + 0.5)
    return x, y


_grid = None


def world_points(z, Wm, P):
    """world xyz (H,W,3) of every pixel from linear view depth z (distance along -z)"""
    global _grid
    if _grid is None:
        _grid = pix_grid()
    x, y = _grid
    ndx, ndy = x / W * 2 - 1, 1 - y / H * 2
    vx = ndx * z / P[0, 0]
    vy = ndy * z / P[1, 1]
    vz = -z
    pts = np.stack([vx, vy, vz, np.ones_like(z, dtype=np.float64)], -1)
    return (pts @ Wm.T)[..., :3]


def project(X, Wm, P):
    """world → (u px, v px, view depth) for camera (Wm, P)"""
    V = np.linalg.inv(Wm)
    Xh = np.concatenate([X, np.ones(X.shape[:-1] + (1,))], -1)
    v = Xh @ V.T
    c = v @ P.T
    ndc = c[..., :3] / c[..., 3:4]
    u = (ndc[..., 0] + 1) / 2 * W
    vv = (1 - ndc[..., 1]) / 2 * H
    return u, vv, -v[..., 2]


def flow_to(i, j, m=None, tol=0.01):
    """for each pixel of frame i: where it is in frame j (map_x, map_y) and whether it is visible there"""
    m = m or meta()
    zi = depth(i)
    Wi, Pi = cam(i, m)
    Wj, Pj = cam(j, m)
    X = world_points(np.where(zi < 0, 1, zi), Wi, Pi)
    u, v, dz = project(X, Wj, Pj)
    zj = depth(j)
    ui, vi = np.clip(u.astype(int), 0, W - 1), np.clip(v.astype(int), 0, H - 1)
    inside = (u >= 0) & (u < W) & (v >= 0) & (v < H) & (zi > 0)
    zs = zj[vi, ui]
    vis = inside & (zs > 0) & (np.abs(zs - dz) < tol * dz)
    return (u - 0.5).astype(np.float32), (v - 0.5).astype(np.float32), vis
