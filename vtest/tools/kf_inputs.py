import sys, lib, cv2, numpy as np, os
os.makedirs('/home/claude/iLisboa/vtest/in', exist_ok=True)
for i in map(int, sys.argv[1:]):
    f, z = lib.frame(i), lib.depth(i)
    f, z = f[4:1076], z[4:1076]       # 16:9 photo → NB2's 2752×1536 shape (1.7917)
    cv2.imwrite(f'/home/claude/iLisboa/vtest/in/k{i:03d}_render.jpg', f, [cv2.IMWRITE_JPEG_QUALITY, 92])
    s = 1536 / 1920; zs = cv2.resize(z, (1536, round(1072 * s)), interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(f'/home/claude/iLisboa/vtest/in/k{i:03d}_depth.png', lib.depth_png(zs))
    cv2.imwrite(f'/home/claude/iLisboa/vtest/in/k{i:03d}_edges.png', (lib.geo_edges(zs) * 255).astype(np.uint8))
    print(i, 'ok')
