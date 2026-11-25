"""Mean building height per ~90 m cell for the city bbox → data/raw/ghsl_h.json, from JRC GHSL R2023A (2020, 3 arc-second
WGS84 grids): built volume (m³) / built surface (m²) per cell. The AGBH product at this resolution averages in empty land,
so the ratio is taken here instead. The build uses it for footprints with no OSM height or storey count of their own,
and checks it against the cells where OSM does have heights. Reads windows straight out of the remote zips (GDAL
/vsizip//vsicurl/), so only a few MB move."""
import json, sys
import rasterio
from rasterio.windows import from_bounds
W, S, E, N = -9.2525, 38.6715, -9.0705, 38.8070
ROOT = 'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/'
def grid(kind):
    name = f'GHS_BUILT_{kind}_E2020_GLOBE_R2023A_4326_3ss'
    src = rasterio.open(f'/vsizip//vsicurl/{ROOT}GHS_BUILT_{kind}_GLOBE_R2023A/{name}/V1-0/{name}_V1_0.zip/{name}_V1_0.tif')
    win = from_bounds(W, S, E, N, src.transform).round_offsets().round_lengths()
    return src.read(1, window=win).astype('float64'), src.window_transform(win), src.nodata
V, t, nv = grid('V')
Sg, t2, ns = grid('S')
assert V.shape == Sg.shape and abs(t.c - t2.c) < 1e-9, (V.shape, Sg.shape)
print('shape', V.shape, 'transform', t, 'nodata', nv, ns)
vals = [[round(float(v / s), 1) if s >= 150 and v > 0 and v != nv and s != ns else 0 for v, s in zip(rv, rs)] for rv, rs in zip(V, Sg)]
json.dump({'src': 'GHSL R2023A E2020 BUILT_V / BUILT_S, 3ss', 'west': t.c, 'north': t.f, 'dx': t.a, 'dy': t.e, 'w': V.shape[1], 'h': V.shape[0], 'v': vals,
           'cover': [[round(float(s), 0) for s in rs] for rs in Sg]}, open('data/raw/ghsl_h.json', 'w'), separators=(',', ':'))
