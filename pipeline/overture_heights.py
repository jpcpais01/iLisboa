"""Building heights and storey counts from Overture Maps (Esri Community Maps, Microsoft, … — not OSM, which the
build already reads) for the whole city bbox → data/raw/heights.csv.gz (lon, lat of the footprint centroid, area m²,
height m, floors, source). The build matches them to OSM footprints that carry no height of their own."""
import duckdb, gzip, csv, sys
REL = sys.argv[1] if len(sys.argv) > 1 else '2026-11-18.0'
W, S, E, N = -9.2525, 38.6715, -9.0705, 38.8070
con = duckdb.connect()
for s in ('INSTALL spatial', 'LOAD spatial', 'INSTALL httpfs', 'LOAD httpfs', "SET s3_region='us-west-2'"): con.execute(s)
try: con.execute('SET geometry_always_xy = true')   # lon, lat order (DuckDB 2.x asks for it explicitly)
except Exception: pass
q = f"""
SELECT ST_X(ST_Centroid(geometry)) AS lon, ST_Y(ST_Centroid(geometry)) AS lat,
       ST_Area_Spheroid(geometry) AS area, height, num_floors, sources[1].dataset AS src
FROM read_parquet('s3://overturemaps-us-west-2/release/{REL}/theme=buildings/type=building/*', hive_partitioning=1)
WHERE bbox.xmin > {W} AND bbox.xmax < {E} AND bbox.ymin > {S} AND bbox.ymax < {N}
  AND (height IS NOT NULL OR num_floors IS NOT NULL) AND sources[1].dataset <> 'OpenStreetMap'
"""
rows = con.execute(q).fetchall()
with gzip.open('data/raw/heights.csv.gz', 'wt', newline='') as f:
    w = csv.writer(f); w.writerow(['lon', 'lat', 'area', 'height', 'floors', 'src'])
    for r in rows: w.writerow([f'{r[0]:.7f}', f'{r[1]:.7f}', f'{(r[2] or 0):.0f}', '' if r[3] is None else f'{r[3]:.1f}', '' if r[4] is None else r[4], r[5]])
from collections import Counter
print(len(rows), 'buildings with heights;', Counter(r[5] for r in rows).most_common())
