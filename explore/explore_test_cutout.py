"""Smoke test: one WISE 0855 exposure through the range reader, compared with astropy on the cutout service file."""
import sys, time
import numpy as np
from astropy.io import fits
sys.path.insert(0, ".")
from app import fitsrange

URL = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
RA, DEC = 133.795129, -7.245147
t0 = time.time()
c = fitsrange.read_cutout(URL, RA, DEC, 15)
print("cutout %.2fs" % (time.time() - t0), c.image.shape, "x,y", round(c.x, 2), round(c.y, 2), "x0,y0", c.x0, c.y0)
t0 = time.time()
c = fitsrange.read_cutout(URL, RA, DEC, 15)
print("2nd (template cached) %.2fs" % (time.time() - t0))
print("img med %.4f var med %.3g flags uniq %s" % (np.nanmedian(c.image), np.nanmedian(c.variance), np.unique(c.flags)[:8]))
# reference: cutout service file saved during exploration (29x29 centred similarly)
ref = fits.open("../explore/sample_cut.fits")
ri, rf = ref["IMAGE"], ref["FLAGS"]
# The cutout-service header has LTV1/LTV2 giving the detector offset
ltv1, ltv2 = round(1020.5 - ri.header["CRPIX1"]), round(1020.5 - ri.header["CRPIX2"])
print("ref offset", ltv1, ltv2, ri.data.shape)
ox, oy = int(ltv1) - c.x0, int(ltv2) - c.y0
sub = c.image[oy:oy + ri.data.shape[0], ox:ox + ri.data.shape[1]]
fsub = c.flags[oy:oy + ri.data.shape[0], ox:ox + ri.data.shape[1]]
print("image match:", np.allclose(sub, ri.data, equal_nan=True), " flags match:", np.array_equal(fsub, rf.data.astype(np.uint32)))
t0 = time.time()
tab = fitsrange.wave_table(URL, 3)
print("wave table %.2fs" % (time.time() - t0), fitsrange.wavelength_at(c.header, tab, c.x, c.y), "em range from SIA: 1.630-2.435")
