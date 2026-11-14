"""Offline unit tests (no network)."""
import sys
from pathlib import Path

import math

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import archive, config, fitsrange, stack  # noqa: E402
from app.archive import Exposure  # noqa: E402


def test_merge_ranges():
    assert fitsrange._merge([(10, 20), (0, 5), (20, 30), (4, 8)]) == [(0, 8), (10, 30)]


def test_parse_multipart():
    body = (b"--XYZ\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-3/100\r\n\r\nABCD\r\n"
            b"--XYZ\r\nContent-Range: bytes 50-51/100\r\n\r\n\r\n\r\n--XYZ--\r\n")
    parts = fitsrange._parse_multipart(body, "multipart/byteranges; boundary=XYZ")
    assert parts == [(0, b"ABCD"), (50, b"\r\n")]          # payload may itself contain CRLF


def test_parse_header_and_size():
    from astropy.io import fits
    h = fits.Header({"XTENSION": "IMAGE", "BITPIX": -32, "NAXIS": 2, "NAXIS1": 10, "NAXIS2": 3,
                     "PCOUNT": 0, "GCOUNT": 1, "EXTNAME": "IMAGE"})
    raw = h.tostring().encode()
    parsed, hlen = fitsrange.parse_header(raw)
    assert hlen == 2880 and parsed["EXTNAME"] == "IMAGE"
    assert fitsrange.data_size(parsed) == 120
    assert fitsrange.parse_header(raw[:160]) is None


@pytest.mark.parametrize("text,ra,dec", [
    ("08h55m10.831s -07d14m42.53s", 133.795129, -7.245147),
    ("133.795129, -7.245147", 133.795129, -7.245147),
    ("08 55 10.831 -07 14 42.53", 133.795129, -7.245147),
])
def test_parse_coords(text, ra, dec):
    got = archive.parse_coords(text)
    assert got and abs(got[0] - ra) < 1e-5 and abs(got[1] - dec) < 1e-5


def test_parse_coords_rejects_names():
    assert archive.parse_coords("Barnard's Star") is None


def test_epochs():
    assert stack.epochs([1, 2, 3, 100, 101, 300]) == [0, 0, 0, 1, 1, 2]


def test_propagate_barnard_moves_north():
    ra, dec = stack.propagate(269.452, 4.693, -801.551, 10362.394, 2000.0, 61000.0)   # ~2025.8
    assert 0.07 < dec - 4.693 < 0.08          # ~265 arcsec north
    assert ra < 269.452


def _frame(img, var=1.0, flag=0):
    e = Exposure("x", 1, "u", 0, 0, 1, 2, 100, "c")
    n = img.shape[0]
    return stack.Frame(e, img.astype(np.float32), np.full((n, n), var, np.float32), np.full((n, n), flag, np.uint32))


def test_coadd_inverse_variance_and_mask():
    a = _frame(np.full((3, 3), 1.0), var=1.0)
    b = _frame(np.full((3, 3), 4.0), var=3.0)
    bad = _frame(np.full((3, 3), 1000.0), flag=1 << 6)       # NONFUNC: must be ignored
    img, var, flg = stack.coadd([a, b, bad])
    assert np.allclose(img, (1 * 1 + 4 / 3) / (1 + 1 / 3))
    assert np.allclose(var, 1 / (1 + 1 / 3))
    assert (flg & (1 << 6)).all()                              # flags are still reported


def test_bad_mask_keeps_bright_star_bits():
    for name in ("SOURCE", "OVERFLOW", "TRANSIENT", "OUTLIER"):
        bit = next(b for b, n in config.FLAG_BITS.items() if n == name)
        assert not config.BAD_MASK & (1 << bit)


def test_coadd_fills_all_flagged_pixels():
    a = _frame(np.full((3, 3), 2.0), flag=1 << 26)           # BLOOM everywhere
    b = _frame(np.full((3, 3), 4.0), flag=1 << 26)
    img, var, flg = stack.coadd([a, b])
    assert np.allclose(img, 3.0) and np.isfinite(var).all()
    assert (flg & (1 << 26)).all()


def test_gauss3_peak_recovers_subpixel_shift():
    from app import detect
    for true in (-0.4, -0.1, 0.0, 0.25, 0.45):
        prof = [math.exp(-((i - true) ** 2) / (2 * 0.51 ** 2)) for i in (-1, 0, 1)]
        assert abs(detect._gauss3(*prof) - true) < 1e-9


def test_finder_sees_moving_star():
    from astropy.wcs import WCS
    from app import detect
    n = 31
    rng = np.random.default_rng(1)

    def epoch(i, x, mjd, with_var=False):
        yy, xx = np.mgrid[0:n, 0:n]
        img = 50 * np.exp(-((xx - x) ** 2 + (yy - 15) ** 2) / (2 * 0.6 ** 2))
        img += 30 * np.exp(-((xx - 7.3) ** 2 + (yy - 22.6) ** 2) / (2 * 0.6 ** 2))   # static star
        img += rng.normal(0, 0.1, (n, n))
        return {"epoch": i, "mjd": mjd, "image": img, "variance": np.full((n, n), 0.01),
                "flags": np.zeros((n, n), np.uint32), "detector": 1}

    eps = [epoch(1, 15.0, 60800), epoch(2, 15.5, 60983), epoch(3, 16.0, 61165)]
    w = stack.output_wcs(10.0, 0.0, n)
    c = detect.find_candidates(eps, eps, w, (15, 15))
    mov = [k for k in c if k["type"] == "moving"]
    assert len(mov) == 1
    assert abs(mov[0]["rate_arcsec_yr"] - 1.0 * 6.15) < 0.5          # 1 px/yr
    assert abs(mov[0]["pa_deg"] - 270) < 5                             # +x is west


def test_cached_cutout_reused_when_it_covers_the_box():
    from app.fitsrange import Cutout
    w = stack.output_wcs(10.0, 0.0, 2041)                 # stand-in for a detector WCS
    h = w.to_header()
    big = Cutout(np.zeros((41, 41), np.float32), np.zeros((41, 41), np.float32), np.zeros((41, 41), np.uint32),
                 1000, 1000, h, 1020.0, 1020.0)
    assert stack._covers(big, 10.0, 0.0, 15)               # smaller field of view: reuse
    assert not stack._covers(big, 10.0, 0.0, 30)           # larger: must download
    assert not stack._covers(big, 10.0, 0.05, 15)          # moved 30 px: must download
