import pyvo, numpy as np, requests, io
from astropy.io import fits
sia = pyvo.dal.SIA2Service("https://irsa.ipac.caltech.edu/SIA")
t = sia.search(pos=(133.795129,-7.245147,0.0005), collection="spherex_dr1").to_table()
print(len(t), "rows; cols:", t.colnames)
r=t[0]
for c in t.colnames: print(" ", c, "=", str(r[c])[:150])
tm=np.sort(np.array(t["t_min"],float)); br=np.where(np.diff(tm)>20)[0]
edges=[tm[0]]+[x for i in br for x in (tm[i],tm[i+1])]+[tm[-1]]
print("epochs (MJD start/end pairs):", np.round(edges,1).reshape(-1,2).tolist())
if "energy_bandpassname" in t.colnames:
    import collections; print(collections.Counter(t["energy_bandpassname"].tolist()))
url=str(r["access_url"])
for cu in [url+"?center=133.795129,-7.245147&size=0.05", url]:
    try:
        h=requests.head(cu,timeout=60,allow_redirects=True); print("HEAD",h.status_code,h.headers.get("Content-Length"),cu[:160])
    except Exception as e: print("HEAD err",e)
resp=requests.get(url+"?center=133.795129,-7.245147&size=0.05",timeout=120)
print("cutout bytes", len(resp.content))
hd=fits.open(io.BytesIO(resp.content))
hd.info()
for h in hd:
    hh=h.header
    keys=[k for k in hh.keys() if k.startswith(("CTYPE","CRVAL","CDELT","CD1","PC1","BUNIT","DETECTOR","MJD","DATE","CWAVE","BAND","FLAG","MASK","PSF")) ]
    print("--",h.name,{k:hh[k] for k in keys[:30]})
open("C:/Users/mert1/Projects/planetx-spherex/explore/sample_cut.fits","wb").write(resp.content)
