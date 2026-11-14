"""Planetarium back end (ported from Emre Bozkaya's Node server): pure parts, no network."""
import json
import struct

import numpy as np
from fastapi.testclient import TestClient

from app import explorer
from app.main import app


def test_wave_seed_table_gives_detector_wavelengths():
    for det, (lo, hi) in {1: (0.7, 1.15), 6: (4.3, 5.1)}.items():
        key = next(p.stem for p in explorer.WAVE_SEED.glob(f"D{det}_*.json"))
        t = explorer._wave_table(key)
        h = {"CRPIX1W": 0, "CRPIX2W": 0, "CRVAL1W": 1, "CRVAL2W": 1, "CDELT1W": 1, "CDELT2W": 1}
        wl, bw = explorer._wave_maps(t, h, 2040, 4)
        assert lo < np.nanmin(wl) and np.nanmax(wl) < hi
        assert np.all(bw > 0)


def test_cutout_rejects_foreign_urls():
    c = TestClient(app)
    for uri in ["https://evil.example/x.fits", "ibe/data/spherex/../../etc/passwd.fits", "ibe/data/other/x.fits"]:
        r = c.get("/api/sx/cutout", params={"uri": uri, "ra": 10, "dec": 10})
        assert r.status_code == 400


def test_blob_layout():
    from astropy.io import fits
    n = 3 * 2
    hdus, buf = {}, bytearray()
    for name, data in [("IMAGE", np.arange(n, dtype=">f4").reshape(2, 3)), ("FLAGS", np.ones((2, 3), ">i4"))]:
        hdu = fits.ImageHDU(data, name=name)
        start = len(buf) + len(hdu.header.tostring())
        buf += hdu.header.tostring().encode() + data.tobytes() + b"\0" * (-(data.nbytes) % 2880)
        hdus[name] = (hdu.header, start)
    blob = explorer._blob(hdus, buf, None)
    assert blob[:4] == b"SPX1"
    m = struct.unpack("<I", blob[4:8])[0]
    meta = json.loads(blob[8:8 + m])
    assert (meta["nx"], meta["ny"]) == (3, 2)
    off = 8 + m + (-(8 + m) % 4)
    img = np.frombuffer(blob[off:off + 4 * n], "<f4")
    assert img.tolist() == list(range(n))
    assert len(blob) - off == 6 * 4 * n
