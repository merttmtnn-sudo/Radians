"""Offline unit tests (no network)."""
import sys
from pathlib import Path

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
