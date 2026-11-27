# Probe INE's BGRI (census by statistical subsection) downloads: list the links on the download pages and the sizes of
# candidate files. The sandbox can't reach INE; this runs in the fetch-census Action and commits its findings.
import re, urllib.request, sys, os
os.makedirs('pipeline/census/probe', exist_ok=True)
out = open('pipeline/census/probe/links.txt', 'w')
UA = {'User-Agent': 'Mozilla/5.0 (ilisboa data fetch)'}
def get(u, n=None):
    r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60)
    return r.read(n) if n else r.read()
for page in ['https://mapas.ine.pt/download/index2011.phtml', 'https://mapas.ine.pt/download/index2021.phtml', 'https://mapas.ine.pt/download/index.phtml',
             'https://mapas.ine.pt/download/index2001.phtml']:
    try:
        t = get(page).decode('latin-1')
        out.write(f'## {page} {len(t)}\n')
        for l in sorted(set(re.findall(r'(?:href|value)=["\']([^"\']+)["\']', t))): out.write(l + '\n')
        for l in sorted(set(re.findall(r'filesGPG[^"\'\s<>]+', t))): out.write('F ' + l + '\n')
    except Exception as e: out.write(f'## {page} ERR {e}\n')
for u in ['https://mapas.ine.pt/download/filesGPG/2021/BGRI21_CONT.zip', 'https://mapas.ine.pt/download/filesGPG/2021/nuts3/BGRI21_170.zip',
          'https://mapas.ine.pt/download/filesGPG/2021/concelhos/BGRI21_1106.zip', 'https://mapas.ine.pt/download/filesGPG/2011/BGRI11_CONT.zip',
          'https://mapas.ine.pt/download/filesGPG/2011/concelhos/BGRI11_1106.zip', 'https://mapas.ine.pt/download/filesGPG/2011/nuts3/BGRI11_170.zip']:
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA, method='HEAD'), timeout=60)
        out.write(f'OK {u} {r.headers.get("Content-Length")} {r.headers.get("Content-Type")}\n')
    except Exception as e: out.write(f'NO {u} {e}\n')
out.close()
