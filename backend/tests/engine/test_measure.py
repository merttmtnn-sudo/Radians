import numpy as np

from app.engine.http import Http
from app.engine.views import ViewManager, make_spec
from tests.engine.fakes import FakeIrsa, make_file, sia_csv
from tests.engine.test_views import _ready


def _manager(tmp_path, peaks=(30.0, 60.0), n_per_pass=10, **file_kw):
    """Two passes; the star at the centre has a different peak in each (it doubles by default)."""
    files, rows = {}, []
    for p, mjd in enumerate([60900.0, 61080.0]):
        for i in range(n_per_pass):
            url = f"https://irsa.example/l2b-v27-x/{p}_{i}.fits"
            files[url] = make_file(150.0 + 0.004 * i, 10.0, mjd + i, wave0=3.85 + 0.01 * i, rot_deg=5 * i,
                                   stars=[(150.0, 10.0, peaks[p]), (150.0 + 50 / 3600, 10.0 + 20 / 3600, 20.0)],
                                   seed=10 * p + i, **file_kw)
            rows.append(dict(obs_id=f"{p}_{i}", det=5, url=url, mjd=mjd + i))
    mgr = ViewManager(Http(session=FakeIrsa(files, sia_csv=sia_csv(rows)), sleep=lambda s: None),
                      tmp_path / "views", tmp_path / "cut")
    return mgr, _ready(mgr, make_spec(150.0, 10.0, 5, 3.0))


def test_light_curve_sees_a_star_double(tmp_path):
    mgr, st = _manager(tmp_path)
    lc = mgr.lightcurve(st["id"])
    assert lc["estimator"] == "box" and lc["mode"] == "ratio" and len(lc["points"]) == 20
    by_pass = {p["pass"]: p["median"] for p in lc["passes"]}
    assert 1.8 < by_pass[1] / by_pass[0] < 2.2
    # the neighbour star (clicked) stays flat
    f = st["view"]["field"]
    x = (f["n"] - 1) / 2 - 50 / f["scale_arcsec"]              # 50" east = smaller x
    y = (f["n"] - 1) / 2 - 20 / f["scale_arcsec"]              # 20" north = smaller y in the picture
    flat = mgr.lightcurve(st["id"], x, y)
    quiet = {p["pass"]: p["median"] for p in flat["passes"]}
    assert not flat["spot"]["target"] and abs(quiet[1] / quiet[0] - 1) < 0.08


def test_box_flux_is_right_in_mjy(tmp_path):
    mgr, st = _manager(tmp_path, peaks=(30.0, 30.0))
    lc = mgr.lightcurve(st["id"])
    # a Gaussian of peak 30 MJy/sr and sigma 1.5/2.355 px holds 2 pi sigma^2 x 30 MJy/sr x one pixel's solid angle
    pixel_sr = (6.15 / 3600 * np.pi / 180) ** 2
    total = 2 * np.pi * (1.5 / 2.355) ** 2 * 30.0 * pixel_sr * 1e9
    assert abs(np.median([p["value"] for p in lc["points"]]) / total - 1) < 0.05


def test_saturated_star_switches_to_the_halo(tmp_path):
    mgr, st = _manager(tmp_path, peaks=(3000.0, 6000.0), saturate_above=40.0, wing=0.01)
    lc = mgr.lightcurve(st["id"])
    assert lc["estimator"] == "halo" and lc["units"] == "MJy/sr"
    by_pass = {p["pass"]: p["median"] for p in lc["passes"]}
    assert 1.6 < by_pass[1] / by_pass[0] < 2.4
