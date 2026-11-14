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


def test_measure_recovers_flux_over_background():
    n = 31
    img = np.full((n, n), 5.0, dtype=np.float32)            # flat background, MJy/sr
    img[15, 15] += 100.0                                     # point source in one pixel
    var = np.full_like(img, 0.01)
    flg = np.zeros((n, n), dtype=np.int64)
    m = stack.measure(img, var, flg, 15, 15)
    to_ujy = (config.PIXEL_SCALE / 206264.806) ** 2 * 1e12
    assert m["background"] == pytest.approx(5.0)
    assert m["flux_ujy"] == pytest.approx(100.0 * to_ujy, rel=1e-4)
    assert not m["flagged"] and not m["saturated"]
    # a bad pixel inside the aperture marks the measurement as flagged
    flg[15, 16] = 1 << 10                                  # HOT
    assert stack.measure(img, var, flg, 15, 15)["flagged"]


def test_progress_is_reported_per_job():
    from fastapi.testclient import TestClient

    from app import main
    main._report("t1", stage="read", done=3, total=10)
    main._report(None, stage="ignored")
    c = TestClient(main.app)
    assert c.get("/api/progress", params={"job": "t1"}).json() == {"stage": "read", "done": 3, "total": 10}
    assert c.get("/api/progress", params={"job": "nope"}).json() == {}


def test_parse_coords_decimal_commas():
    assert archive.parse_coords("269,45 4,69") == pytest.approx((269.45, 4.69))
    assert archive.parse_coords("269.45, 4.69") == pytest.approx((269.45, 4.69))


def _wl_frame(det, mjd, wl, value=1.0):
    e = Exposure(f"o{det}-{mjd}-{wl}", det, "u", mjd - 0.01, mjd + 0.01, 0, 0, 100, "c")
    return stack.Frame(e, np.full((3, 3), value, np.float32), np.ones((3, 3), np.float32),
                       np.zeros((3, 3), np.uint32), wavelength=wl)


def test_wavelength_matching_keeps_shared_bins_only(monkeypatch):
    monkeypatch.setattr(stack, "MIN_MATCHED_PER_VISIT", 1)
    monkeypatch.setattr(stack, "MIN_MATCHED_FRACTION", 0.0)
    lo = config.DETECTORS[1][0]
    # visit 1 samples a blue and a red bin of detector 1, visit 2 only the blue one: red must go
    v1 = [_wl_frame(1, 60800, lo * 1.01, 1.0), _wl_frame(1, 60800.1, lo * 1.2, 10.0)]
    v2 = [_wl_frame(1, 60990, lo * 1.012, 1.0)]
    groups = stack.group_raw(v1 + v2, "epoch", matched=True)
    assert [g["n_exposures"] for g in groups] == [1, 1]
    assert np.allclose(groups[0]["image"], 1.0) and np.allclose(groups[1]["image"], 1.0)
    plain = stack.group_raw(v1 + v2, "epoch", matched=False)
    assert plain[0]["n_exposures"] == 2 and not np.allclose(plain[0]["image"], 1.0)


def test_wavelength_matching_drops_detector_missing_from_a_visit(monkeypatch):
    monkeypatch.setattr(stack, "MIN_MATCHED_PER_VISIT", 1)
    monkeypatch.setattr(stack, "MIN_MATCHED_FRACTION", 0.0)
    lo1, lo2 = config.DETECTORS[1][0], config.DETECTORS[2][0]
    fr = [_wl_frame(1, 60800, lo1 * 1.01), _wl_frame(2, 60800.1, lo2 * 1.01, 5.0), _wl_frame(1, 60990, lo1 * 1.01)]
    groups = stack.group_raw(fr, "epoch", matched=True)
    assert all(g["detectors"] == [1] for g in groups)


def test_weighted_coadd_variance():
    a, b = _wl_frame(1, 1, 1.0, 2.0), _wl_frame(1, 2, 1.0, 4.0)
    img, var, _ = stack.coadd([a, b], [1.0, 0.5])
    assert np.allclose(img, (2 + 0.5 * 4) / 1.5)
    assert np.allclose(var, (1 + 0.25) / 1.5 ** 2)


def test_rate_limit_answers_429():
    from fastapi.testclient import TestClient

    from app import main
    main._hits.clear()
    old = main.LIMITS["/api/photometry"]
    main.LIMITS["/api/photometry"] = 2
    try:
        c = TestClient(main.app)
        codes = [c.get("/api/photometry").status_code for _ in range(3)]
        assert codes[:2] == [422, 422] and codes[2] == 429
    finally:
        main.LIMITS["/api/photometry"] = old
        main._hits.clear()


def test_matching_skipped_when_too_little_survives():
    lo1 = config.DETECTORS[1][0]
    fr = [_wl_frame(1, 60800 + i * 0.01, lo1 * 1.01, 1.0) for i in range(5)] +          [_wl_frame(1, 60990 + i * 0.01, lo1 * 1.3, 1.0) for i in range(5)]
    groups = stack.group_raw(fr, "epoch", matched=True)        # no shared wavelength: keep everything
    assert [g["n_exposures"] for g in groups] == [5, 5] and not groups[0]["matched"]


def test_rate_limit_trusts_only_the_proxy_entry():
    from types import SimpleNamespace

    from app import main
    req = SimpleNamespace(headers={"x-forwarded-for": "1.2.3.4, 9.9.9.9"}, client=SimpleNamespace(host="10.0.0.1"))
    assert main._client(req) == "9.9.9.9"


def test_depth_series_noise_falls_and_stars_appear():
    rng = np.random.default_rng(1)
    n, frames = 41, []
    sky = np.zeros((n, n))
    for k, (x, y) in enumerate([(8, 9), (20, 30), (31, 12), (12, 25), (28, 22)]):
        sky[y, x] = 3.0 + k * 0.2                       # faint stars: below 5 sigma in one exposure
    for i in range(64):
        e = Exposure(f"o{i}", 1 + i % 6, "u", 60000 + i - 0.01, 60000 + i + 0.01, 0, 0, 100, "c")
        img = (sky + rng.normal(0, 1, (n, n))).astype(np.float32)
        frames.append(stack.Frame(e, img, np.ones((n, n), np.float32), np.zeros((n, n), np.uint32)))
    d = stack.depth_series(list(reversed(frames)), n)
    st = d["steps"]
    assert st[0]["n_exposures"] == 1 and st[-1]["n_exposures"] == 64 and d["total"] == 64
    assert st[-1]["noise"] < st[0]["noise"] / 6                         # ~1/sqrt(64) = 1/8
    assert st[-1]["stars"] >= 5 and st[0]["stars"] < 5
    assert d["max_coverage"] == 64
    q = np.frombuffer(__import__("base64").b64decode(st[-1]["image"]), np.int16).reshape(n, n)
    assert abs(q[30, 20] * d["scale"] - sky[30, 20]) < 0.6


def test_live_preview_reports_partial_coadd():
    from app import main
    add = main._live_preview("jobdepth", 5, 10)
    for _ in range(3):
        add(_frame(np.ones((5, 5))))
    p = main._progress["jobdepth"]["preview"]
    assert p["count"] == 3 and p["n"] == 5 and p["image"]
