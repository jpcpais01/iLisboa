# chain_input.py <t> k:file ... → vtest/in/c<t>_photo.jpg: earlier final keyframes carried into view t through our depth (colour mode)
import sys, subprocess, os, cv2, shutil
t = int(sys.argv[1]); keys = sys.argv[2:]
d = f'chain/w{t:03d}'; shutil.rmtree(d, ignore_errors=True)
subprocess.run(['python3', 'bproj.py', d, 'colour', *keys], env={**os.environ, 'ONLY': str(t)}, check=True, capture_output=True)
o = cv2.imread(f'{d}/o{t:04d}.png')
cv2.imwrite(f'/home/claude/iLisboa/vtest/in/c{t:03d}_photo.jpg', o[4:1076], [cv2.IMWRITE_JPEG_QUALITY, 93])
print(open(f'{d}/stats.json').read())
