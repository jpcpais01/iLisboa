#!/usr/bin/env python3
"""Fetch the DGT 2024 LiDAR elevation models for every area and store them as compact per-area rasters.

Source: Centro de Dados DGT (https://cdd.dgterritorio.gov.pt), STAC collections MDS-2m (surface: roofs, trees)
and MDT-2m (bare terrain), both EPSG:3763. Downloads need a free CDD account, given as DGT_USER / DGT_PASSWORD
(GitHub secrets, never in the repo). Without them the script only probes the catalogue and reports what it sees.

Output (2026-11-26 first full run), per area of pipeline/areas.txt, in EPSG:4326 over the area plus a 0.004° margin:
  data/lidar/<area>_ndsm.tif   height above ground (MDS − MDT), int16 decimetres, ~2 m cells, 0 below 1 m
  data/lidar/<area>_dtm.tif    terrain height, uint16 decimetres, ~4 m cells, 65535 where there is no ground (water)
"""
import json, os, pathlib, subprocess, sys, time
from html.parser import HTMLParser
from urllib.parse import urlencode, urljoin

import numpy as np
import requests
from osgeo import gdal

SITE = "https://cdd.dgterritorio.gov.pt"
SEARCH = SITE + "/dgt-be/v1/search"
AUTH_HOST = "https://auth.cdd.dgterritorio.gov.pt"
AUTH = AUTH_HOST + "/realms/dgterritorio/protocol/openid-connect/auth"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data/lidar"
TMP = pathlib.Path("/tmp/lidar")
M = 0.004

areas = []
for line in open(ROOT / "pipeline/areas.txt"):
    if line.strip() and not line.startswith("#"):
        n, *b = line.split()
        areas.append((n, *map(float, b)))   # name, south, west, north, east
S = min(a[1] for a in areas) - M; W = min(a[2] for a in areas) - M
N = max(a[3] for a in areas) + M; E = max(a[4] for a in areas) + M


def say(*a):
    print(*a, flush=True)


class LoginForm(HTMLParser):
    """Keycloak's login page: the form with id kc-form-login, its action and its hidden fields."""
    def __init__(self):
        super().__init__(); self.action = None; self.hidden = {}; self._in = False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form" and a.get("id") == "kc-form-login": self.action = a.get("action"); self._in = True
        elif tag == "input" and self._in and a.get("type") == "hidden" and a.get("name"): self.hidden[a["name"]] = a.get("value", "")
    def handle_endtag(self, tag):
        if tag == "form": self._in = False


def login(s):
    s.get(SITE, timeout=30)
    q = dict(client_id="aai-oidc-dgt", response_type="code", redirect_uri=SITE + "/auth/callback", scope="openid profile email")
    r = s.get(AUTH + "?" + urlencode(q), timeout=30); r.raise_for_status()
    if r.url.startswith(SITE): say("session still valid"); return   # Keycloak sent us straight back: already signed in
    f = LoginForm(); f.feed(r.text)
    if not f.action: sys.exit("login page has no kc-form-login form")
    data = dict(f.hidden, username=os.environ["DGT_USER"], password=os.environ["DGT_PASSWORD"])
    r2 = s.post(urljoin(r.url, f.action), data=data, timeout=60, headers={"Origin": AUTH_HOST, "Referer": r.url})
    if not r2.url.startswith(SITE): sys.exit("login failed: check the DGT_USER / DGT_PASSWORD secrets")
    say("logged in")


def search(s, coll):
    body = {"bbox": [W, S, E, N], "limit": 1000, "collections": [coll]}
    feats, url, method = [], SEARCH, "POST"
    while url:
        r = s.post(url, json=body, timeout=60) if method == "POST" else s.get(url, timeout=60)
        say(f"search {coll}: HTTP {r.status_code}")
        r.raise_for_status()
        j = r.json(); feats += j.get("features", [])
        nxt = next((l for l in j.get("links", []) if l.get("rel") == "next"), None)
        if not nxt: break
        url, method = nxt["href"], nxt.get("method", "GET").upper()
        if method == "POST": body = {**body, **nxt.get("body", {})}
    return feats


def tiff_href(f):
    for a in f.get("assets", {}).values():
        if "tiff" in (a.get("type") or "") or (a.get("href") or "").lower().endswith((".tif", ".tiff")): return a["href"]
    hrefs = [a.get("href") for a in f.get("assets", {}).values() if a.get("href")]
    return hrefs[0] if len(hrefs) == 1 else None


def download(s, href, dst, relogin=None):
    if dst.exists() and dst.stat().st_size > 0: return True
    for k in range(3):
        try:
            with s.get(href, stream=True, timeout=120) as r:
                ct = r.headers.get("content-type", "")
                if (r.status_code in (401, 403) or "html" in ct) and relogin and k < 2:
                    say(f"  {dst.name}: signed out, signing in again"); relogin(); continue
                if r.status_code != 200 or "html" in ct:
                    say(f"  {dst.name}: HTTP {r.status_code} {ct}"); return False
                tmp = dst.with_suffix(".part")
                with open(tmp, "wb") as fh:
                    for chunk in r.iter_content(1 << 20): fh.write(chunk)
                tmp.rename(dst); return True
        except requests.RequestException as e:
            say(f"  {dst.name}: {type(e).__name__}, retrying"); time.sleep(5)
    return False


def main():
    s = requests.Session(); s.headers["User-Agent"] = "ilisboa-lidar-fetch"
    have_login = bool(os.environ.get("DGT_USER") and os.environ.get("DGT_PASSWORD"))
    if have_login: login(s)
    else: say("no DGT_USER / DGT_PASSWORD: probing the catalogue only")
    found = {}
    for coll in ("MDS-2m", "MDT-2m"):
        feats = search(s, coll)
        found[coll] = [(f.get("id"), tiff_href(f), f.get("bbox")) for f in feats]
        say(f"{coll}: {len(feats)} items")
        for fid, href, bb in found[coll][:3]: say(f"  {fid} {bb} {href}")
    if not have_login:
        # can the files be read without an account? one small range request tells
        fid, href, _ = found["MDT-2m"][0] if found["MDT-2m"] else (None, None, None)
        if href:
            r = s.get(href, headers={"Range": "bytes=0-1023"}, timeout=60, allow_redirects=True)
            say(f"anonymous download probe: HTTP {r.status_code} {r.headers.get('content-type')} {len(r.content)} bytes")
            if r.status_code in (200, 206) and "html" not in r.headers.get("content-type", ""):
                say("downloads are open: continuing without an account")
            else:
                return
        else:
            return
    files = {}
    for coll, items in found.items():
        d = TMP / coll; d.mkdir(parents=True, exist_ok=True); files[coll] = []
        for i, (fid, href, _) in enumerate(items):
            if not href: continue
            dst = d / (str(fid).replace("/", "_") + ".tif")
            if download(s, href, dst, (lambda: login(s)) if have_login else None): files[coll].append(str(dst))
            time.sleep(0.3)   # be gentle with the national server
            if i % 50 == 49: say(f"  {coll}: {i + 1} / {len(items)}")
        say(f"{coll}: {len(files[coll])} / {len(items)} files")
        if not files[coll]: sys.exit(f"no {coll} files downloaded")
    vrt = {c: gdal.BuildVRT(str(TMP / f"{c}.vrt"), files[c]) for c in files}
    for v in vrt.values(): v.FlushCache()
    OUT.mkdir(parents=True, exist_ok=True)
    opts = ["COMPRESS=DEFLATE", "PREDICTOR=2", "ZLEVEL=9", "TILED=YES"]
    for name, s0, w0, n0, e0 in areas:
        bb = (w0 - M, s0 - M, e0 + M, n0 + M)
        warp = lambda c, tr: gdal.Warp("", str(TMP / f"{c}.vrt"), format="MEM", dstSRS="EPSG:4326", outputBounds=bb,
                                       xRes=tr[0], yRes=tr[1], resampleAlg="bilinear", dstNodata=-9999, outputType=gdal.GDT_Float32)
        ds_s, ds_t = warp("MDS-2m", (2.3e-5, 1.8e-5)), warp("MDT-2m", (2.3e-5, 1.8e-5))
        mds, mdt = ds_s.ReadAsArray(), ds_t.ReadAsArray()
        ok = (mds > -1000) & (mdt > -1000)
        nd = np.where(ok, mds - mdt, 0); nd[nd < 1] = 0
        nd = np.clip(np.round(nd * 10), 0, 32767).astype(np.int16)
        write(OUT / f"{name}_ndsm.tif", nd, ds_s, gdal.GDT_Int16, opts)
        ds_t4 = warp("MDT-2m", (4.6e-5, 3.6e-5)); t4 = ds_t4.ReadAsArray()
        dtm = np.where(t4 > -1000, np.clip(np.round(t4 * 10), 0, 65534), 65535).astype(np.uint16)
        write(OUT / f"{name}_dtm.tif", dtm, ds_t4, gdal.GDT_UInt16, opts)
        say(f"{name}: ndsm {nd.shape[1]}×{nd.shape[0]}, {100 * ok.mean():.1f}% covered, {(OUT / f'{name}_ndsm.tif').stat().st_size >> 10} KB")


def write(path, arr, like, dtype, opts):
    ds = gdal.GetDriverByName("GTiff").Create(str(path), arr.shape[1], arr.shape[0], 1, dtype, opts)
    ds.SetGeoTransform(like.GetGeoTransform()); ds.SetProjection(like.GetProjection())
    ds.GetRasterBand(1).WriteArray(arr); ds.FlushCache(); ds = None


if __name__ == "__main__":
    main()
