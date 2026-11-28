"""Approach B: AI keyframes reprojected through our exact depth and cameras.

python3 bproj.py <outdir> <mode colour|delta> k0:file k1:file ...
  each keyframe file = the AI image for render frame k (any size, 16:9 crop of rows 4..1076 as sent).
Per output frame: every pixel → world point (our depth) → each keyframe camera; taken from a keyframe only where that keyframe
saw the same surface (its own depth agrees within 1 %). Keyframes are blended with tent weights in time.
colour: the keyframe's pixels themselves.  delta: the keyframe's change over our render (log ratio) laid on this frame's
render, so anything the render animates (water, boats, shadows) keeps moving under the AI look.
Pixels no keyframe saw: delta filled from the neighbourhood (pull-push) over this frame's render."""
import sys, os, json, numpy as np, cv2, lib

out, mode = sys.argv[1], sys.argv[2]
keys = [(int(a.split(':')[0]), a.split(':')[1]) for a in sys.argv[3:]]
os.makedirs(out, exist_ok=True)
m = lib.meta()
N = m['N']
W, H = lib.W, lib.H
EPS = 6.0


def align(ai, ren):
    """AI image back onto the render's pixel grid: resize into the crop, then an affine ECC fit on gradients (fixes the
    model's small shifts/zooms)"""
    a = ren.copy()
    a[4:1076] = cv2.resize(ai, (1920, 1072), interpolation=cv2.INTER_AREA)
    def grad(x):
        g = cv2.GaussianBlur(cv2.cvtColor(x, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 2)
        return cv2.magnitude(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
    M = np.eye(2, 3, dtype=np.float32)
    try:
        s = 0.5
        gr, ga = cv2.resize(grad(ren), None, fx=s, fy=s), cv2.resize(grad(a), None, fx=s, fy=s)
        _, M = cv2.findTransformECC(gr, ga, M, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
        M[:, 2] /= s
    except cv2.error as e:
        print('ECC failed', e)
    al = cv2.warpAffine(a, M, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    if os.environ.get('SNAP'):
        # local snap: dense flow render→AI on gradient images, heavily smoothed and capped, pulls redrawn edges back onto ours
        gr8 = lambda x: cv2.normalize(grad(x), None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        fl = dis.calc(gr8(ren), gr8(al), None)
        sg = float(os.environ.get('SNAP'))
        fl = cv2.GaussianBlur(fl, (0, 0), sg)
        mag = np.linalg.norm(fl, axis=2, keepdims=True); fl = fl * np.minimum(1, 6 / np.maximum(mag, 1e-6))
        gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
        al = cv2.remap(al, gx + fl[..., 0], gy + fl[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        print('snap mean px', float(mag.mean()))
    al[:4] = ren[:4]; al[1076:] = ren[1076:]
    return al, M


def pullpush(v, w):
    """fill where w==0 from the neighbourhood (pyramid average)"""
    if min(v.shape[:2]) < 4:
        return v
    small_w = cv2.resize(w, (v.shape[1] // 2, v.shape[0] // 2), interpolation=cv2.INTER_AREA)
    small_v = cv2.resize(v * w[..., None], (v.shape[1] // 2, v.shape[0] // 2), interpolation=cv2.INTER_AREA) / np.maximum(small_w, 1e-6)[..., None]
    filled = pullpush(small_v, (small_w > 1e-4).astype(np.float32))
    up = cv2.resize(filled, (v.shape[1], v.shape[0]), interpolation=cv2.INTER_LINEAR)
    return np.where(w[..., None] > 0, v, up)


K = []
GRADE0 = []
for k, f in keys:
    ren = lib.frame(k)
    al, M = align(cv2.imread(f), ren)
    cv2.imwrite(os.path.join(out, f'key{k:03d}_aligned.jpg'), al, [cv2.IMWRITE_JPEG_QUALITY, 92])
    Wk, Pk = lib.cam(k, m)
    # where the model painted sky or sea over real ground (the far map edge: it invents a horizon), that keyframe is not used
    zk0 = lib.depth(k); a32 = al.astype(np.float32); r32 = ren.astype(np.float32)
    skyish = (a32[..., 0] > a32[..., 2] + 8) & (a32.mean(-1) > r32.mean(-1) + 25)
    bad = skyish & (zk0 > 0); bad[int(0.35 * H):] = False
    bad = cv2.dilate(cv2.morphologyEx(bad.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)), np.ones((7, 7), np.uint8)) > 0
    # everything above the lowest invented-horizon pixel in each column goes too
    print('key', k, 'invented-horizon px %.3f' % bad.mean())
    if os.environ.get('GRADE'):
        # colour lock: each keyframe's global grade over our render (per channel, log-affine) is replaced by the first keyframe's,
        # so a chain of keyframes can't drift warmer / hazier; local detail is untouched
        ok = (~bad) & (zk0 > 0); ok[:4] = ok[1076:] = False
        lr, la = np.log(r32[ok][::7] + EPS), np.log(a32[ok][::7] + EPS)
        fit = [np.polyfit(lr[:, c], la[:, c], 1) for c in range(3)]
        if not GRADE0: GRADE0.extend(fit)
        lR = np.log(r32 + EPS)
        corr = np.stack([(GRADE0[c][0] - fit[c][0]) * lR[..., c] + (GRADE0[c][1] - fit[c][1]) for c in range(3)], -1)
        al = np.clip((a32 + EPS) * np.exp(corr) - EPS, 0, 255).astype(np.uint8)
        print('   grade', [np.round(f, 3).tolist() for f in fit])
    K.append(dict(bad=bad, k=k, A=al.astype(np.float32), R=ren.astype(np.float32), z=lib.depth(k), Wm=Wk, P=Pk,
                  D=np.log((al.astype(np.float32) + EPS) / (ren.astype(np.float32) + EPS))))
    print('key', k, 'affine', np.round(M, 4).tolist())
times = [x['k'] for x in K]


def tent(f, k):
    i = times.index(k)
    if f == k: return 1.0
    if f < k:
        return 1.0 if i == 0 else max(0.0, (f - times[i - 1]) / (k - times[i - 1]))
    return 1.0 if i == len(times) - 1 else max(0.0, (times[i + 1] - f) / (times[i + 1] - k))


stats = []
frames = range(N) if not os.environ.get('ONLY') else map(int, os.environ['ONLY'].split(','))
for f in frames:
    zf = lib.depth(f)
    Rf = lib.frame(f).astype(np.float32)
    Wf, Pf = lib.cam(f, m)
    sky = zf < 0
    X = lib.world_points(np.where(sky, 1e5, zf), Wf, Pf)   # sky: a far point along the ray (direction only matters)
    acc = np.zeros((H, W, 3), np.float32)
    wsum = np.zeros((H, W), np.float32)
    acc2 = np.zeros((H, W, 3), np.float32)
    dmax = np.zeros((H, W), np.float32)
    wsum2 = np.zeros((H, W), np.float32)
    for K_ in K:
        u, v, dz = lib.project(X, K_['Wm'], K_['P'])
        mx, my = (u - 0.5).astype(np.float32), (v - 0.5).astype(np.float32)
        inside = (u >= 0) & (u < W) & (v >= 4) & (v < 1076)
        zk = cv2.remap(K_['z'], mx, my, cv2.INTER_NEAREST, borderValue=-1)
        vis = inside & np.where(sky, zk < 0, (zk > 0) & (np.abs(zk - dz) < 0.01 * dz + 0.3))
        vis &= cv2.remap(K_['bad'].astype(np.uint8), mx, my, cv2.INTER_NEAREST, borderValue=0) == 0
        src = K_['D'] if mode == 'delta' else K_['A']
        val = cv2.remap(src, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        # sharper source = closer to the surface than we are; mild preference
        q = np.clip(np.where(sky, 1, zf / np.maximum(dz, 1e-3)), 0.3, 3) ** 0.5
        # sampling density: keyframe pixels per output pixel (Jacobian of the reprojection). Where a keyframe saw a surface at a
        # grazing angle or from much farther away, its texture would be smeared across many pixels: that keyframe barely counts there
        uy, ux = np.gradient(u); vy, vx = np.gradient(v)
        dens = np.abs(ux * vy - uy * vx)
        q = q * np.clip(dens, 0, 1) ** 2
        if f == K_['k']: q = np.where(vis, 1.0, q)
        dmax = np.maximum(dmax, np.where(vis, dens, 0))
        # feather near the keyframe's picture edges: no hard seam where one keyframe's view ends
        edge = np.clip(np.minimum.reduce([u, W - u, v - 4, 1076 - v]) / 80.0, 0.02, 1)
        q = q * edge
        w = vis * tent(f, K_['k']) * q
        acc += val * w[..., None]; wsum += w
        w2 = vis * q / (1 + abs(f - K_['k']))   # any keyframe that saw it, nearest in time first (outside its tent)
        acc2 += val * w2[..., None]; wsum2 += w2
    use2 = (wsum < 1e-4) & (wsum2 > 1e-4)
    val = np.where(use2[..., None], acc2 / np.maximum(wsum2, 1e-6)[..., None], acc / np.maximum(wsum, 1e-6)[..., None])
    have = ((wsum > 1e-4) | use2).astype(np.float32)
    if mode == 'delta':
        main = (wsum > 1e-4).astype(np.float32)
        smooth = pullpush(cv2.GaussianBlur(val * main[..., None], (0, 0), 25) / np.maximum(cv2.GaussianBlur(main, (0, 0), 25), 1e-3)[..., None], (cv2.GaussianBlur(main, (0, 0), 25) > 0.05).astype(np.float32))
        Dm = np.where(main[..., None] > 0, val, np.clip(smooth, -0.7, 0.7))
        o = (Rf + EPS) * np.exp(Dm) - EPS
    else:
        Dfill = np.clip(pullpush(np.clip(np.log((val + EPS) / (Rf + EPS)), -0.6, 0.6) * have[..., None], have), -0.6, 0.6)   # holes: the neighbours' change over the render
        o = np.where(have[..., None] > 0, val, (Rf + EPS) * np.exp(Dfill) - EPS)
        if os.environ.get('GREYHOLES'):   # chain reference: only what an earlier photo saw sharply; the rest mid-grey ("missing")
            good = (have > 0) & (dmax > 0.45)
            good = cv2.erode(good.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            o = np.where(good[..., None], o, 128)
    o = np.clip(o, 0, 255).astype(np.uint8)
    cv2.imwrite(os.path.join(out, f'o{f:04d}.png'), o)
    stats.append(dict(f=f, hole=float(1 - have.mean()), fallback=float(use2.mean())))
    print(f, 'holes %.4f fallback %.4f' % (1 - have.mean(), use2.mean()), flush=True)
json.dump(stats, open(os.path.join(out, 'stats.json'), 'w'))
