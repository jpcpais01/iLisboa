"""Average building height per ~90 m cell (GHS-BUILT-H AGBH 2018, JRC, 3 arc-second WGS84 grid) for the city bbox
→ data/raw/ghsl_h.json. The build uses it for footprints without an OSM height or storey count, instead of a guess.
Reads the window straight out of the remote zip (GDAL /vsizip//vsicurl/), so only a few MB move."""
import json, sys, urllib.request, re
import rasterio
from rasterio.windows import from_bounds
W, S, E, N = -9.2525, 38.6715, -9.0705, 38.8070
ROOT = 'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_H_GLOBE_R2023A/'
NAME = 'GHS_BUILT_H_AGBH_E2018_GLOBE_R2023A_4326_3ss'
url = f'{ROOT}{NAME}/V1-0/{NAME}_V1_0.zip'
try:
    src = rasterio.open(f'/vsizip//vsicurl/{url}/{NAME}_V1_0.tif')
except Exception as e:
    print('open failed:', e)
    for d in (ROOT, f'{ROOT}{NAME}/V1-0/'):
        try: print(d, re.findall(r'href="([^"]+)"', urllib.request.urlopen(d).read().decode())[:40])
        except Exception as e2: print(d, e2)
    sys.exit(1)
win = from_bounds(W, S, E, N, src.transform).round_offsets().round_lengths()
a = src.read(1, window=win)
t = src.window_transform(win)
print('shape', a.shape, 'transform', t, 'nodata', src.nodata, 'max', float(a.max()))
vals = [[round(float(v), 1) if v == v and v > 0 and v != src.nodata else 0 for v in row] for row in a]
json.dump({'src': NAME, 'west': t.c, 'north': t.f, 'dx': t.a, 'dy': t.e, 'w': a.shape[1], 'h': a.shape[0], 'v': vals},
          open('data/raw/ghsl_h.json', 'w'), separators=(',', ':'))
