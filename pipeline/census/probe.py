# Probe INE's BGRI (census by statistical subsection) sources: WFS capabilities/schema and candidate zip URLs.
# The sandbox can't reach INE; this runs in the fetch-census Action and commits its findings.
import urllib.request, os
os.makedirs('pipeline/census/probe', exist_ok=True)
out = open('pipeline/census/probe/links.txt', 'w')
UA = {'User-Agent': 'Mozilla/5.0 (ilisboa data fetch)'}
def get(u, n=200000, rng=False):
    h = dict(UA); 
    if rng: h['Range'] = 'bytes=0-1023'
    r = urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=90)
    return r, r.read(n)
W = 'https://inspire.ine.pt/geoserver/BGRI2021/wfs'
for u in [W + '?service=WFS&version=2.0.0&request=GetCapabilities', W + '?service=WFS&version=2.0.0&request=DescribeFeatureType',
          W + '?service=WFS&version=2.0.0&request=GetFeature&count=2&outputFormat=application/json&typeNames=' ]:
    try:
        r, b = get(u, 60000); out.write(f'## {u} {r.status}\n{b.decode("utf-8", "replace")[:30000]}\n')
    except Exception as e: out.write(f'## {u} ERR {e}\n')
for yr, codes in [('2021', ['1106']), ('2011', ['1106'])]:
    for c in codes:
        for pat in [f'https://mapas.ine.pt/download/filesGPG/{yr}/concelhos/BGRI{yr}_{c}.zip', f'https://mapas.ine.pt/download/filesGPG/{yr}/concelhos/BGRI{yr[2:]}_{c}.zip',
                    f'https://mapas.ine.pt/download/filesGPG/{yr}/BGRI{yr}_{c}.zip', f'http://mapas.ine.pt/download/filesGPG/{yr}/concelhos/BGRI{yr}_{c}.zip']:
            try: r, b = get(pat, 2048, True); out.write(f'OK {pat} {r.status} {r.headers.get("Content-Range")} {r.headers.get("Content-Type")} {b[:4]}\n')
            except Exception as e: out.write(f'NO {pat} {e}\n')
out.close()
