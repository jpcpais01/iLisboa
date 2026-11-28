#!/usr/bin/env python3
"""Per-building detail sources for one area of pipeline/areas.txt (the Telheiras pilot, citywide).

  <area>_ortho2025.tif     DGT Ortofotos 2025, aerial, 25 cm, JPEG-in-TIFF, EPSG:4326 (roofs, ground, façades in the lean)
  <area>_ortho2018.tif     DGT Ortofotos 2018, aerial, 25 cm: another flight, so every tower leans another way (more façades)
  <area>_orthosat2023.tif  DGT OrtoSat 2023 (Pléiades Neo, 30 cm) through the open WMS: a third look
  <area>_ndsm50.tif        DGT LiDAR 2024 MDS-50cm − MDT-50cm, int16 dm: roof forms, rooftop structures, crowns
plus a small JSON beside each photo (rank; lean null = searched building by building; sun null = fitted from the shadows
at build time). All DGT data is CC BY 4.0. Needs the DGT_USER / DGT_PASSWORD secrets.

Usage: AREA=<name> DETAIL_OUT=<dir> python3 pipeline/fetch_detail_city.py
The files are far too big for git (~150 MB an area): the workflow uploads them as assets of the `detail-city` release and
pipeline/get_detail.mjs downloads them into data/detail/city/ before a build.
"""
import json, os, pathlib, sys, time

import numpy as np
from osgeo import gdal

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import fetch_lidar as fl   # noqa: E402  (login, search, download)

AREA = os.environ["AREA"]
OUT = pathlib.Path(os.environ.get("DETAIL_OUT", ROOT / "data/detail/city")); OUT.mkdir(parents=True, exist_ok=True)
TMP = pathlib.Path("/tmp/detail-city"); TMP.mkdir(parents=True, exist_ok=True)
PAD = 0.0006   # ~60 m: a roof near the edge leans in from outside the area
box = None
for line in open(ROOT / "pipeline/areas.txt"):
    if line.strip() and not line.startswith("#") and line.split()[0] == AREA:
        s0, w0, n0, e0 = map(float, line.split()[1:5]); box = (s0 - PAD, w0 - PAD, n0 + PAD, e0 + PAD)
if not box: sys.exit(f"no area {AREA} in areas.txt")
PS, PW, PN, PE = box
fl.S, fl.W, fl.N, fl.E = PS, PW, PN, PE   # fetch_lidar.search() reads its default bbox from these
say = fl.say
coslat = np.cos(np.radians((PS + PN) / 2))


def fetch(s, coll):
    """Every file of a collection over the area, downloaded once (signing in again when the session lapses)."""
    items = fl.search(s, coll); files = []
    for f in items:
        href = fl.tiff_href(f)
        if not href: continue
        dst = TMP / (coll + "_" + str(f.get("id")).replace("/", "_") + ".tif")
        if fl.download(s, href, dst, lambda: fl.login(s)): files.append(str(dst))
        time.sleep(0.3)
    say(f"{AREA} {coll}: {len(files)} / {len(items)} files, {sum(pathlib.Path(x).stat().st_size for x in files) >> 20} MB")
    return files


def drop(files):
    for x in files: pathlib.Path(x).unlink(missing_ok=True)


def warp(files, res_m, **kw):
    v = gdal.BuildVRT(str(TMP / "src.vrt"), files, **({"bandList": [1, 2, 3]} if kw.pop("rgb", False) else {})); v.FlushCache(); v = None
    res = res_m / 111320.0
    return gdal.Warp(kw.pop("dst", ""), str(TMP / "src.vrt"), dstSRS="EPSG:4326", outputBounds=(PW, PS, PE, PN),
                     xRes=res / coslat, yRes=res, resampleAlg="bilinear", **kw)


def meta(tag, d):
    (OUT / f"{AREA}_{tag}.json").write_text(json.dumps(d) + "\n")


def main():
    s = fl.requests.Session(); s.headers["User-Agent"] = "ilisboa-detail-fetch"
    fl.login(s)
    say(f"{AREA}: {PS:.4f},{PW:.4f} → {PN:.4f},{PE:.4f}")

    # 50 cm surface minus 50 cm terrain: heights above ground in decimetres
    dst = OUT / f"{AREA}_ndsm50.tif"
    if not dst.exists():
        fs, ft = fetch(s, "MDS-50cm"), fetch(s, "MDT-50cm")
        if fs and ft:
            a_ = warp(fs, 0.5, format="MEM", dstNodata=-9999, outputType=gdal.GDT_Float32); a = a_.ReadAsArray()
            t = warp(ft, 0.5, format="MEM", dstNodata=-9999, outputType=gdal.GDT_Float32).ReadAsArray()
            ok = (a > -1000) & (t > -1000)
            nd = np.clip(np.round(np.where(ok, a - t, 0) * 10), 0, 32766).astype(np.int16); nd[nd < 5] = 0
            o = gdal.GetDriverByName("GTiff").Create(str(dst), a.shape[1], a.shape[0], 1, gdal.GDT_Int16,
                                                     ["COMPRESS=DEFLATE", "PREDICTOR=2", "ZLEVEL=9", "TILED=YES"])
            o.SetGeoTransform(a_.GetGeoTransform()); o.SetProjection(a_.GetProjection())
            o.GetRasterBand(1).WriteArray(nd); o.FlushCache(); o = None
            say(f"{AREA} ndsm50: {a.shape[1]}×{a.shape[0]}, {100 * ok.mean():.1f}% covered, {dst.stat().st_size >> 20} MB")
        drop(fs + ft)

    # the two aerial flights (25 cm COGs, ~600 MB a sheet: downloaded, cut to the area, deleted)
    for coll, rank in (("ORTOS-2025", 3), ("ORTOS-2018", 1)):
        tag = "ortho" + coll[-4:]; dst = OUT / f"{AREA}_{tag}.tif"
        if dst.exists(): continue
        fl.login(s); files = fetch(s, coll)
        if not files: continue
        warp(files, 0.25, dst=str(dst), rgb=True, creationOptions=["COMPRESS=JPEG", "JPEG_QUALITY=88", "PHOTOMETRIC=YCBCR", "TILED=YES"])
        drop(files)
        meta(tag, {"source": f"DGT Ortofotos {coll[-4:]} (aerial, 25 cm), CC BY 4.0", "rank": rank, "lean": None, "maxLean": 0.4, "sun": None})
        say(f"{AREA} {tag}: {dst.stat().st_size >> 20} MB")

    # the satellite look, through the open WMS (no account), with the pilot's tiling code
    tag = "orthosat2023"
    if not (OUT / f"{AREA}_{tag}.tif").exists():
        os.environ["PILOT"] = f"{AREA} {PS} {PW} {PN} {PE}"
        import fetch_detail as fd
        fd.OUT, fd.PNAME, fd.PS, fd.PW, fd.PN, fd.PE = OUT, AREA, PS, PW, PN, PE
        url = "https://ortos.dgterritorio.gov.pt/wms/ortosat2023"
        layers = fd.wms_layers(s, url)
        if layers:
            import re
            pick = next((l for l in layers if re.search(r"rgb|cor.?verdadeira|true", l, re.I)), layers[-1])
            if fd.wms_fetch(s, url, pick, res_m=0.3, tag=tag):
                meta(tag, {"source": "DGT OrtoSat 2023 (Pléiades Neo, 30 cm), CC BY 4.0", "rank": 2, "lean": None, "maxLean": 0.4, "sun": None})
    for f in sorted(OUT.glob(f"{AREA}_*")): say(f"  {f.name} {f.stat().st_size >> 20} MB")


if __name__ == "__main__":
    main()
