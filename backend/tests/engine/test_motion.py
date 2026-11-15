import numpy as np

from app.engine import motion
from tests.engine.test_measure import _manager


def test_motion_fit():
    pos = [dict(mjd=60900 + 182.6 * i, east=4.0 * 0.5 * i, north=-2.0 * 0.5 * i) for i in range(4)]
    got = motion.motion_fit(pos)
    assert got["ok"] and abs(got["pm_east"] - 4) < 0.01 and abs(got["pm_north"] + 2) < 0.01
    assert got["direction"] == "south-east" and got["significant"] and 0.2 < got["err"] < 0.4
    assert motion.motion_fit(pos[:1])["reason"] == "one_pass"


def test_centroid():
    yy, xx = np.mgrid[:40, :40]
    img = 5 * np.exp(-((xx - 21.3) ** 2 + (yy - 17.6) ** 2) / 8.0) + 0.01
    x, y = motion.centroid(img, 20, 18)
    assert abs(x - 21.3) < 0.15 and abs(y - 17.6) < 0.15
    img[17, 21] = np.nan
    assert motion.centroid(img, 20, 18) is None


def test_light_curve_counts_every_exposure_and_its_flags(tmp_path):
    mgr, st = _manager(tmp_path)
    lc = mgr.lightcurve(st["id"])
    assert lc["n_measured"] == 20 and isinstance(lc["flags"], dict)


def test_saturated_core_is_recorded_per_pass(tmp_path):
    """The share of exposures in which a pixel was saturated or blank is stored with the view
    (the page marks those pixels): high on the core of a saturated star, zero on empty sky."""
    mgr, st = _manager(tmp_path, peaks=(3000.0, 3000.0), saturate_above=40.0, wing=0.01)
    _, arr = mgr._load(st["id"])
    n = st["view"]["field"]["n"]
    c = (n - 1) // 2
    assert arr["Q0"].shape == (n, n) and arr["Q0"][c, c] >= 0.3 and arr["Q0"][5, 5] == 0
