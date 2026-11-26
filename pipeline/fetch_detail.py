#!/usr/bin/env python3
"""Fetch the per-building detail sources for the realism pilot (Telheiras) and probe what exists citywide.

Sources (all open: DGT data is CC BY 4.0):
  * DGT orthophotos (RGB, 25 cm) through the DGT WMS services: roof colours, façade colours where the
    photo leans a tall building over, real ground cover (dry grass, paving, parking, soil).
  * Centro de Dados DGT (cdd.dgterritorio.gov.pt) STAC catalogue: every collection is listed, and any finer
    LiDAR surface model (≤ 1 m) or point cloud over the pilot box is downloaded with the DGT_USER / DGT_PASSWORD
    secrets: balconies, rooftop boxes and roof forms need finer cells than the 2 m model we use for heights.

Output: data/detail/probe.txt (what was found), data/detail/<pilot>_ortho.tif (JPEG-in-TIFF, EPSG:4326),
data/detail/<pilot>_dsm.tif (finest surface model, int16 dm above the 2 m terrain, when available).
"""
import io, json, os, pathlib, re, sys, time
import xml.etree.ElementTree as ET

import numpy as np
import requests
from osgeo import gdal

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data/detail"
TMP = pathlib.Path("/tmp/detail")
PILOT = os.environ.get("PILOT", "telheiras 38.7520 -9.1830 38.7680 -9.1550").split()
PNAME, PS, PW, PN, PE = PILOT[0], *map(float, PILOT[1:])
log = []


def say(*a):
    s = " ".join(str(x) for x in a); print(s, flush=True); log.append(s)


WMS = [
    "https://ortos.dgterritorio.gov.pt/wms/ortos2023",
    "https://ortos.dgterritorio.gov.pt/wms/ortos2021",
    "https://ortos.dgterritorio.gov.pt/wms/ortos2018",
    "https://ortos.dgterritorio.gov.pt/wms/ortosat2023",
    "https://ortos.dgterritorio.gov.pt/wms-inspire/ortos2021",
    "https://ortos.dgterritorio.gov.pt/wms-inspire/ortos2023",
]


def wms_layers(s, url):
    try:
        r = s.get(url, params=dict(service="WMS", request="GetCapabilities", version="1.3.0"), timeout=60)
    except requests.RequestException as e:
        say(f"WMS {url}: {type(e).__name__}"); return []
    say(f"WMS {url}: HTTP {r.status_code} {len(r.content)} B")
    if r.status_code != 200: return []
    try: root = ET.fromstring(r.content)
    except ET.ParseError: say("  not XML:", r.text[:200].replace("\n", " ")); return []
    out = []
    for L in root.iter():
        if not L.tag.endswith("Layer"): continue
        name = next((c.text for c in L if c.tag.endswith("Name")), None)
        title = next((c.text for c in L if c.tag.endswith("Title")), None)
        if name: out.append(name); say(f"  layer {name!r} — {title}")
    return out


def wms_fetch(s, url, layer, res_m=0.25, tag="ortho"):
    """GetMap the pilot box at res_m in EPSG:4326 as 2048 px JPEG tiles, mosaicked into one GeoTIFF."""
    dlat = res_m / 111320.0; dlon = res_m / (111320.0 * np.cos(np.radians((PS + PN) / 2)))
    W = int(round((PE - PW) / dlon)); H = int(round((PN - PS) / dlat))
    T = 2048
    dst = OUT / f"{PNAME}_{tag}.tif"
    variant = None
    for ver, crs, fmt in [("1.3.0", "EPSG:4326", "image/jpeg"), ("1.1.1", "EPSG:4326", "image/jpeg"), ("1.3.0", "EPSG:4326", "image/png"),
                          ("1.1.1", "EPSG:4326", "image/png"), ("1.3.0", "CRS:84", "image/png")]:
        bb = (PS, PW, PS + 256 * dlat, PW + 256 * dlon) if ver == "1.3.0" and crs == "EPSG:4326" else (PW, PS, PW + 256 * dlon, PS + 256 * dlat)
        p = dict(service="WMS", request="GetMap", version=ver, layers=layer, styles="", width=256, height=256, format=fmt,
                 bbox=",".join(f"{v:.7f}" for v in bb), **({"crs": crs} if ver == "1.3.0" else {"srs": crs}))
        try: r = s.get(url, params=p, timeout=120)
        except requests.RequestException as e: say(f"  probe {ver} {crs} {fmt}: {type(e).__name__}"); continue
        if r.headers.get("content-type", "").startswith("image"): variant = (ver, crs, fmt); say(f"  GetMap works as {variant}"); break
        say(f"  probe {ver} {crs} {fmt}: {re.sub(r'\s+', ' ', r.text)[-300:]}")
    if not variant: return None
    ver, crs, fmt = variant
    ds = gdal.GetDriverByName("GTiff").Create(str(dst), W, H, 3, gdal.GDT_Byte,
                                              ["COMPRESS=JPEG", "JPEG_QUALITY=88", "PHOTOMETRIC=YCBCR", "TILED=YES"])
    ds.SetGeoTransform((PW, dlon, 0, PN, 0, -dlat)); ds.SetProjection("EPSG:4326")
    n = 0
    for y0 in range(0, H, T):
        for x0 in range(0, W, T):
            w, h = min(T, W - x0), min(T, H - y0)
            bb = (PN - (y0 + h) * dlat, PW + x0 * dlon, PN - y0 * dlat, PW + (x0 + w) * dlon)   # WMS 1.3.0 EPSG:4326 = lat,lon
            if not (ver == "1.3.0" and crs == "EPSG:4326"): bb = (bb[1], bb[0], bb[3], bb[2])
            p = dict(service="WMS", request="GetMap", version=ver, layers=layer, styles="", bbox=",".join(f"{v:.7f}" for v in bb),
                     width=w, height=h, format=fmt, **({"crs": crs} if ver == "1.3.0" else {"srs": crs}))
            for k in range(4):
                try:
                    r = s.get(url, params=p, timeout=180)
                    if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"): break
                    say(f"  tile {x0},{y0}: HTTP {r.status_code} {r.headers.get('content-type')} {r.text[:200]!r}")
                except requests.RequestException as e: say(f"  tile {x0},{y0}: {type(e).__name__}")
                time.sleep(4)
            else:
                ds = None; dst.unlink(missing_ok=True); return None
            gdal.FileFromMemBuffer("/vsimem/t.img", r.content)
            t = gdal.Open("/vsimem/t.img").ReadAsArray()[:3]
            for b in range(3): ds.GetRasterBand(b + 1).WriteArray(t[b], x0, y0)
            n += 1; time.sleep(0.4)
    ds.FlushCache(); ds = None
    say(f"ortho {layer}: {W}×{H} px in {n} tiles → {dst.name} {dst.stat().st_size >> 20} MB")
    return dst


# ---------------------------------------------------------------- CDD catalogue
SITE = "https://cdd.dgterritorio.gov.pt"
sys.path.insert(0, str(ROOT / "pipeline"))


def cdd_collections(s):
    try:
        r = s.get(SITE + "/dgt-be/v1/collections", timeout=60)
        say(f"CDD collections: HTTP {r.status_code}")
        j = r.json(); say("  raw:", json.dumps(j)[:600])
        cols = (j.get("data") or j).get("collections", []) if isinstance(j, dict) else j
    except Exception as e:
        say(f"CDD collections: {type(e).__name__} {e}"); return []
    for c in cols: say(f"  {c.get('id')!r} — {c.get('title') or c.get('name')}")
    return [c.get("id") for c in cols]


def cdd_items(s, coll):
    body = {"bbox": [PW, PS, PE, PN], "limit": 200, "collections": [coll]}
    try:
        r = s.post(SITE + "/dgt-be/v1/search", json=body, timeout=60); j = r.json()
    except Exception as e:
        say(f"  {coll}: {type(e).__name__}"); return []
    return j.get("features", [])


def main():
    OUT.mkdir(parents=True, exist_ok=True); TMP.mkdir(parents=True, exist_ok=True)
    s = requests.Session(); s.headers["User-Agent"] = "ilisboa-detail-fetch"
    say(f"pilot {PNAME}: {PS},{PW} → {PN},{PE}")

    cols = cdd_collections(s)
    interesting = {}
    for c in cols:
        items = cdd_items(s, c)
        if not items: continue
        f = items[0]
        assets = {k: (a.get("type"), a.get("href")) for k, a in f.get("assets", {}).items()}
        say(f"  {c}: {len(items)} items over the pilot; first {f.get('id')} {json.dumps(f.get('properties', {}))[:300]}")
        for k, (t, h) in list(assets.items())[:4]: say(f"      asset {k}: {t} {h}")
        interesting[c] = items

    # finer surface model or point cloud: anything whose id mentions MDS/DSM/LAZ/nuvem at < 2 m
    have_login = bool(os.environ.get("DGT_USER") and os.environ.get("DGT_PASSWORD"))
    fine = [c for c in interesting if re.search(r"(MDS|DSM|surface).*(50|25|1m|0\.5)", c, re.I)]
    say("finer surface collections over the pilot:", fine or "none")
    def grab(c):
        files = []
        for f in interesting[c]:
            href = fetch_lidar.tiff_href(f)
            if not href: continue
            dst = TMP / (c + "_" + str(f.get("id")).replace("/", "_") + ".tif")
            if fetch_lidar.download(s, href, dst, lambda: fetch_lidar.login(s)): files.append(str(dst))
            time.sleep(0.3)
        say(f"{c}: {len(files)} / {len(interesting[c])} files")
        if not files: return None, None
        v = gdal.BuildVRT(str(TMP / f"{c}.vrt"), files); v.FlushCache()
        res = 0.5 / 111320.0
        ds = gdal.Warp("", str(TMP / f"{c}.vrt"), format="MEM", dstSRS="EPSG:4326", outputBounds=(PW, PS, PE, PN),
                       xRes=res / np.cos(np.radians((PS + PN) / 2)), yRes=res, resampleAlg="bilinear", dstNodata=-9999,
                       outputType=gdal.GDT_Float32)
        return ds.ReadAsArray(), ds
    tdt = next((c for c in interesting if re.match(r"MDT-50cm", c, re.I)), None)
    if fine and have_login and not (OUT / f"{PNAME}_ndsm50.tif").exists():
        import fetch_lidar
        fetch_lidar.login(s)
        c = sorted(fine, key=lambda c: (("50" not in c), c))[0]
        a, ds = grab(c)
        t, _ = grab(tdt) if tdt else (None, None)
        if a is not None and t is not None:
            ok = (a > -1000) & (t > -1000)
            nd = np.clip(np.round(np.where(ok, a - t, 0) * 10), 0, 32766).astype(np.int16); nd[nd < 5] = 0
            o = gdal.GetDriverByName("GTiff").Create(str(OUT / f"{PNAME}_ndsm50.tif"), a.shape[1], a.shape[0], 1, gdal.GDT_Int16,
                                                     ["COMPRESS=DEFLATE", "PREDICTOR=2", "ZLEVEL=9", "TILED=YES"])
            o.SetGeoTransform(ds.GetGeoTransform()); o.SetProjection(ds.GetProjection())
            o.GetRasterBand(1).WriteArray(nd); o.FlushCache(); o = None
            say(f"ndsm 50 cm from {c} − {tdt}: {a.shape[1]}×{a.shape[0]} → {PNAME}_ndsm50.tif ({100 * ok.mean():.1f}% covered)")

    # aerial orthophotos (25 cm COGs in the CDD): an aerial survey photographs each block from its own side of a wide-angle
    # frame, so towers lean every way and between them every façade shows somewhere — unlike one satellite look
    if have_login:
        import fetch_lidar
        for c in ("ORTOS-2025", "ORTOS-2018"):
            tag = "ortho" + c[-4:]
            if c not in interesting or (OUT / f"{PNAME}_{tag}.tif").exists(): continue
            fetch_lidar.login(s)
            files = []
            for f in interesting[c]:
                href = fetch_lidar.tiff_href(f)
                if not href: continue
                dst = TMP / (c + "_" + str(f.get("id")).replace("/", "_") + ".tif")
                if fetch_lidar.download(s, href, dst, lambda: fetch_lidar.login(s)): files.append(str(dst))
            say(f"{c}: {len(files)} / {len(interesting[c])} files, {sum(pathlib.Path(x).stat().st_size for x in files) >> 20} MB")
            if not files: continue
            v = gdal.BuildVRT(str(TMP / f"{c}.vrt"), files, bandList=[1, 2, 3]); v.FlushCache()
            res = 0.25 / 111320.0
            gdal.Warp(str(OUT / f"{PNAME}_{tag}.tif"), str(TMP / f"{c}.vrt"), dstSRS="EPSG:4326", outputBounds=(PW, PS, PE, PN),
                      xRes=res / np.cos(np.radians((PS + PN) / 2)), yRes=res, resampleAlg="bilinear",
                      creationOptions=["COMPRESS=JPEG", "JPEG_QUALITY=88", "PHOTOMETRIC=YCBCR", "TILED=YES"])
            say(f"{c} → {PNAME}_{tag}.tif {(OUT / f'{PNAME}_{tag}.tif').stat().st_size >> 20} MB")
            for x in files: pathlib.Path(x).unlink()

    # orthophotos: newest WMS that answers
    got = []
    for url in WMS:
        tag = "ortho" + (re.search(r"(sat)?20\d\d", url).group(0) if re.search(r"(sat)?20\d\d", url) else "")
        if (OUT / f"{PNAME}_{tag}.tif").exists() or any(g.endswith(tag) for g in got): say(f"{tag}: have it"); continue
        layers = wms_layers(s, url)
        if not layers: continue
        pick = next((l for l in layers if re.search(r"rgb|cor.?verdadeira|true", l, re.I)), layers[-1])
        say(f"fetching {pick} from {url} as {tag}")
        if wms_fetch(s, url, pick, tag=tag): got.append(tag)
    if not got: say("no new orthophoto")
    (OUT / "probe.txt").write_text("\n".join(log) + "\n")


if __name__ == "__main__":
    main()
