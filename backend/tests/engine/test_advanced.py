import io

import numpy as np
from astropy.io import fits
from PIL import Image

from app.engine import advanced
from tests.engine.test_measure import _manager


def test_period_is_found_in_a_noisy_curve():
    rng = np.random.default_rng(4)
    t = np.sort(rng.uniform(60800, 61300, 400))
    pts = [dict(mjd=float(ti), ratio=float(1 + 0.3 * np.sin(2 * np.pi * ti / 246) + 0.03 * rng.standard_normal())) for ti in t]
    got = advanced.period_search(pts, "ratio")
    assert got["ok"] and abs(got["period_d"] - 246) < 12 and got["false_alarm"] < 1e-6 and got["cycles"] > 1.5
    assert len(got["folded"]) == 400 and got["err_d"] > 0
    assert advanced.period_search(pts[:10], "ratio") == dict(ok=False, reason="too_few")


def test_motion_fit_and_speed():
    pos = [dict(mjd=60900 + 182.6 * i, east=4.0 * 0.5 * i, north=-2.0 * 0.5 * i) for i in range(4)]
    got = advanced.motion_fit(pos)
    assert got["ok"] and abs(got["pm_east"] - 4) < 0.01 and abs(got["pm_north"] + 2) < 0.01
    assert got["direction"] == "south-east" and got["significant"] and 0.2 < got["err"] < 0.4
    assert advanced.motion_fit(pos[:1])["reason"] == "one_pass"
    assert abs(advanced.tangential_speed(10.4, 547.0) - 90.1) < 0.5          # Barnard's Star: about 90 km/s
    assert advanced.tangential_speed(1.0, None) is None


def test_centroid_and_hr_point():
    yy, xx = np.mgrid[:40, :40]
    img = 5 * np.exp(-((xx - 21.3) ** 2 + (yy - 17.6) ** 2) / 8.0) + 0.01
    x, y = advanced.centroid(img, 20, 18)
    assert abs(x - 21.3) < 0.15 and abs(y - 17.6) < 0.15
    img[17, 21] = np.nan
    assert advanced.centroid(img, 20, 18) is None
    sun_like = advanced.hr_point(dict(source_id=1, parallax=100.0, phot_g_mean_mag=4.67, bp_rp=0.82, pmra=300, pmdec=400))
    assert sun_like["abs_g"] == 4.67 and abs(sun_like["rpm"] - (4.67 + 5 * np.log10(0.5) + 5)) < 0.01
    assert advanced.hr_point(dict(parallax=-1, phot_g_mean_mag=10, bp_rp=1)) is None


def test_view_extras(tmp_path):
    mgr, st = _manager(tmp_path, peaks=(3000.0, 3000.0), saturate_above=40.0, wing=0.01)
    vid = st["id"]
    mask = np.asarray(Image.open(io.BytesIO(mgr.flags_png(vid, 0))))
    n = st["view"]["field"]["n"]
    c = (n - 1) // 2
    assert mask.shape == (n, n, 4) and mask[c, c, 3] > 0 and mask[5, 5, 3] == 0      # red on the saturated core only
    with fits.open(io.BytesIO(mgr.stack_fits(vid, 1))) as hl:
        assert hl[0].data.shape == (n, n) and hl[0].header["CTYPE1"] == "RA---TAN" and hl[0].header["BAND"] == 5
    mgr2, st2 = _manager(tmp_path / "b")
    mo = mgr2.motion(st2["id"])
    assert mo["ok"] and not mo["significant"] and mo["rate"] < 1.5 and mo["catalog"] is None   # a still star, no Gaia offline
    lc = mgr2.lightcurve(st2["id"])
    assert lc["n_measured"] == 20 and isinstance(lc["flags"], dict)
    assert mgr2.period(st2["id"])["ok"] is False
    star = mgr2.star(st2["id"])
    assert star["gaia"] is None and [s["state"] for s in star["surveys"]] == ["unreachable", "unreachable"]
    assert mgr2.hr(st2["id"])["reachable"] is False


def test_catalogue_helpers_exist():
    """Functions the live paths call but the offline tests cannot reach: keep them from vanishing."""
    from app.engine import catalogs
    for name in ("gaia_cone", "gaia_parameters", "catwise_cone", "simbad_cone", "matches", "nearest", "at_date"):
        assert callable(getattr(catalogs, name)), name


def test_vizier_table_parsing():
    text = "\n".join(["#comment", "#more", "", "AllWISE\tRAJ2000\tDEJ2000\tW1mag", " \tdeg\tdeg\tmag", "----\t---\t---\t---",
                      "J2204-5647\t331.078\t-56.791\t17.568", "", ""])
    rows = advanced.parse_tsv(text)
    assert rows == [{"AllWISE": "J2204-5647", "RAJ2000": "331.078", "DEJ2000": "-56.791", "W1mag": "17.568"}]
    assert advanced.parse_tsv("#only comments\n") == []
