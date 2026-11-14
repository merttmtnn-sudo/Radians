import requests
from astropy.io import fits
u="https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
def g(a,b): return requests.get(u,headers={"Range":f"bytes={a}-{b-1}"},timeout=60).content
h=fits.Header.fromstring(g(16672320,16689600).decode())
print({k:h[k] for k in h if k[:1]=="Z" or k in("XTENSION","BITPIX","NAXIS1","NAXIS2","PCOUNT","TFORM1","TTYPE1")})
print([ (k,h[k],h.comments[k]) for k in h if "FLAG" in k.upper() or k.startswith(("MP","HIERARCH"))][:40])
print(repr(h)[:6000])
w=fits.Header.fromstring(g(65784960,65787840).decode()); print(repr(w))
im=fits.Header.fromstring(g(2880,25920).decode()); print([k for k in im if k.endswith("W") or "WAVE" in k])
