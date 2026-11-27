# compose.py out.mp4 cols "Label=source" ...   source: frames dir (o%04d.png), 'render', or decoded dir dec/<name>
import sys, os, cv2, numpy as np, subprocess, lib
out, cols = sys.argv[1], int(sys.argv[2]); items = [a.split('=', 1) for a in sys.argv[3:]]
N = lib.meta()['N']; rows = (len(items) + cols - 1) // cols
cw = 1920 // cols if cols <= 2 else 960; ch = cw * 9 // 16
def get(src, i):
    if src == 'render': return lib.frame(i)
    p = os.path.join(src, f'o{i:04d}.png'); return cv2.imread(p)
ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{cw*cols}x{ch*rows}', '-r', '24', '-i', '-',
                       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow', '-movflags', '+faststart', out], stdin=subprocess.PIPE)
for i in range(N):
    canvas = np.zeros((ch * rows, cw * cols, 3), np.uint8)
    for j, (lab, src) in enumerate(items):
        im = cv2.resize(get(src, i), (cw, ch), interpolation=cv2.INTER_AREA)
        cv2.rectangle(im, (0, 0), (12 + 13 * len(lab), 34), (0, 0, 0), -1)
        cv2.putText(im, lab, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 1, cv2.LINE_AA)
        canvas[(j // cols) * ch:(j // cols + 1) * ch, (j % cols) * cw:(j % cols + 1) * cw] = im
    ff.stdin.write(canvas.tobytes())
ff.stdin.close(); ff.wait(); print('wrote', out)
