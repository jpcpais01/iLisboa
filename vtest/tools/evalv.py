"""Score an output against the render, by the win conditions fixed upfront.
python3 evalv.py <name> <frames dir with o%04d.png | video.mp4> -> scores/<name>.json"""
import sys, os, json, subprocess, numpy as np, cv2, lib

name, src = sys.argv[1], sys.argv[2]
m = lib.meta()
N = m['N']
os.makedirs('scores', exist_ok=True)


def load_outputs():
    if os.path.isdir(src):
        return lambda i: cv2.imread(os.path.join(src, f'o{i:04d}.png'))
    d = f'dec/{name}'
    os.makedirs(d, exist_ok=True)
    if not os.path.exists(f'{d}/o0000.png'):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', 'scale=1920:1080:flags=lanczos', '-start_number', '0', f'{d}/o%04d.png'], check=True)
    n = len([f for f in os.listdir(d) if f.endswith('.png')])
    print('decoded frames', n)
    if n != N:
        print(f'WARNING: {n} frames vs {N} rendered; mapping by time')
    return lambda i: cv2.imread(os.path.join(d, f'o{min(n - 1, round(i * (n - 1) / (N - 1))):04d}.png'))


out = load_outputs()
luma = lambda x: (0.299 * x[..., 2] + 0.587 * x[..., 1] + 0.114 * x[..., 0])
fid, werr_o, werr_r, L_o, L_r = [], [], [], [], []
prev_o = prev_r = None
for i in range(N):
    o, r, z = out(i), lib.frame(i), lib.depth(i)
    fid.append(lib.fidelity(z, r, o))
    L_o.append(float(luma(o.astype(np.float32)).mean())); L_r.append(float(luma(r.astype(np.float32)).mean()))
    if i > 0:
        u, v, vis = lib.flow_to(i, i - 1, m)       # pixels of frame i, where they were in frame i-1
        wo = cv2.remap(prev_o, u, v, cv2.INTER_LINEAR).astype(np.float32)
        wr = cv2.remap(prev_r, u, v, cv2.INTER_LINEAR).astype(np.float32)
        werr_o.append(float(np.abs(wo - o)[vis].mean())); werr_r.append(float(np.abs(wr - r)[vis].mean()))
    prev_o, prev_r = o, r
    if i % 20 == 0: print(i, fid[-1], werr_o[-1] if werr_o else '', werr_r[-1] if werr_r else '', flush=True)


def flicker(L):
    L = np.array(L)
    return float(np.abs(L[2:] - 2 * L[1:-1] + L[:-2]).mean())   # 2nd difference: jumps, not the slow trend


fv = [f for f in fid if f is not None]
res = dict(name=name, fid_mean=float(np.mean(fv)), fid_min=int(np.min(fv)), warp_out=float(np.mean(werr_o)), warp_render=float(np.mean(werr_r)),
           warp_ratio=float(np.mean(werr_o) / np.mean(werr_r)), flick_out=flicker(L_o), flick_render=flicker(L_r),
           flick_ratio=flicker(L_o) / max(1e-6, flicker(L_r)), fid=fid, werr_o=werr_o, werr_r=werr_r, L_o=L_o, L_r=L_r)
res['pass_structure'] = res['fid_mean'] >= 80 and res['fid_min'] >= 70
res['pass_warp'] = res['warp_ratio'] <= 1.5
res['pass_flicker'] = res['flick_ratio'] <= 2
json.dump(res, open(f'scores/{name}.json', 'w'))
print(json.dumps({k: v for k, v in res.items() if not isinstance(v, list)}, indent=1))
