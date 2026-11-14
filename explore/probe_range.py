import time, numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import skycoord_to_pixel
from astropy.coordinates import SkyCoord
c=SkyCoord(133.795129,-7.245147,unit="deg")
for label,uri,kw in [
 ("s3","s3://nasa-irsa-spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits",{"anon":True}),
 ("http","https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits",{}),
]:
    t0=time.time()
    try:
        with fits.open(uri,use_fsspec=True,fsspec_kwargs=kw,lazy_load_hdus=True) as h:
            w=WCS(h["IMAGE"].header); x,y=[int(round(float(v))) for v in skycoord_to_pixel(c,w)]
            r=15; im=h["IMAGE"].section[y-r:y+r+1,x-r:x+r+1]; fl=h["FLAGS"].section[y-r:y+r+1,x-r:x+r+1]
            ww=h["WCS-WAVE"].data
            print(label, "ok %.1fs"%(time.time()-t0), "pix",x,y, im.shape, "med %.3f"%np.nanmedian(im), "flags uniq", np.unique(fl)[:10], "wave cols", ww.columns.names)
            fh=h["FLAGS"].header; print("flag keys:", {k:fh[k] for k in fh if k.startswith("MP_") or "BIT" in k}  )
    except Exception as e: print(label,"ERR %.1fs"%(time.time()-t0),repr(e)[:300])
