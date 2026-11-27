# render.mp4 (1080p24, the render itself) and depth.mp4 (720p24, one fixed log-depth range for the whole clip: no flicker in the control)
import lib, cv2, numpy as np, subprocess, os
m = lib.meta(); N = m['N']
os.makedirs('dpng', exist_ok=True)
vals = np.concatenate([(-np.log(lib.depth(i)[::9, ::9][lib.depth(i)[::9, ::9] > 0])) for i in range(0, N, 10)])
lo, hi = np.quantile(vals, 0.005), np.quantile(vals, 0.995)
for i in range(N):
    z = cv2.resize(lib.depth(i), (1280, 720), interpolation=cv2.INTER_NEAREST); sky = z < 0
    lz = -np.log(np.where(sky, 1, z)); o = np.round(255 * (0.1 + 0.9 * np.clip((lz - lo) / (hi - lo), 0, 1))); o[sky] = 0
    cv2.imwrite(f'dpng/d{i:04d}.png', o.astype(np.uint8))
V = '/home/claude/iLisboa/vtest/in'
enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', '24', '-i', 'frames/f%04d.jpg', *enc, '-crf', '14', f'{V}/render1080.mp4'], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', '24', '-i', 'frames/f%04d.jpg', '-vf', 'scale=1280:720:flags=lanczos', *enc, '-crf', '14', f'{V}/render720.mp4'], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', '24', '-i', 'dpng/d%04d.png', *enc, '-crf', '12', f'{V}/depth720.mp4'], check=True)
print(os.popen(f'ls -la {V}').read())
