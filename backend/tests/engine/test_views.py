import numpy as np

from app.engine import sia
from app.engine.http import Http
from app.engine.views import ViewManager, make_spec, view_id
from tests.engine.fakes import FakeIrsa, make_file, sia_csv


def _archive(n_per_pass=12, shift_arcsec=12.0):
    """Two passes half a year apart; one star moves east between them, one stays."""
    files, rows = {}, []
    static = (150.0 + 40 / 3600, 10.0 - 30 / 3600, 30.0)
    for p, mjd in enumerate([60900.0, 61080.0]):
        mover = (150.0 + p * shift_arcsec / 3600 / np.cos(np.radians(10)), 10.0, 30.0)
        for i in range(n_per_pass):
            url = f"https://irsa.example/l2b-v27-x/{p}_{i}.fits"
            files[url] = make_file(150.0 + 0.01 * i, 10.0, mjd + i, wave0=3.85 + 0.01 * i, rot_deg=7 * i,
                                   stars=[mover, static], seed=10 * p + i)
            rows.append(dict(obs_id=f"{p}_{i}", det=5, url=url, mjd=mjd + i))
    return FakeIrsa(files, sia_csv=sia_csv(rows))


def _ready(mgr, spec):
    st = mgr.submit(spec)
    for _ in range(200):
        if st["state"] in ("ready", "error"):
            break
        st = mgr.status(st["id"], wait=1.0)
    assert st["state"] == "ready", st
    return st


def test_view_builds_in_two_steps_and_its_difference_shows_the_mover(tmp_path):
    fake = _archive()
    mgr = ViewManager(Http(session=fake, sleep=lambda s: None), tmp_path / "views", tmp_path / "cut")
    target = dict(ra=150.0, dec=10.0, pmra=24000.0 * np.cos(np.radians(10)) / np.cos(np.radians(10)), pmdec=0.0,
                  plx=0.0, epoch=2025.6, name="Mover")
    spec = make_spec(150.0, 10.0, 5, 2.0, target)
    st = _ready(mgr, spec)
    v = st["view"]
    assert st["rev"] == 2 and v["quality"] == "standard"                 # preview, then everything
    assert [p["n_frames"] for p in v["passes"]] == [12, 12] and v["n_band"] == 24
    n = v["field"]["n"]
    # the predicted marker moves west->east (smaller x) by about the proper motion
    dx = (v["passes"][0]["target_px"][0] - v["passes"][1]["target_px"][0]) * v["field"]["scale_arcsec"]
    assert 8 < dx < 16
    _, arr = mgr._load(st["id"])
    assert arr["S0"].shape == (n, n)
    d, how = mgr.diff(st["id"], 0, 1)
    assert how["matched"] and how["n_a"] == how["n_b"] == 12
    d = np.nan_to_num(d)[::-1]                                            # picture orientation: north up, y down
    ys, xs = np.nonzero(d >= 0.8 * d.max())                               # the bright half = where it is now
    assert abs(xs.mean() - v["passes"][1]["target_px"][0]) < 2 and abs(ys.mean() - v["passes"][1]["target_px"][1]) < 2
    ys, xs = np.nonzero(d <= 0.8 * d.min())                               # the dark half = where it was
    assert abs(xs.mean() - v["passes"][0]["target_px"][0]) < 2 and abs(ys.mean() - v["passes"][0]["target_px"][1]) < 2
    # a second manager finds the finished view on disk and fetches nothing
    calls = len(fake.calls)
    again = ViewManager(Http(session=fake, sleep=lambda s: None), tmp_path / "views", tmp_path / "cut").submit(spec)
    assert again["state"] == "ready" and again["view"]["passes"] and len(fake.calls) == calls


def test_small_field_skips_the_second_step(tmp_path):
    fake = _archive(n_per_pass=4)
    mgr = ViewManager(Http(session=fake, sleep=lambda s: None), tmp_path / "views", tmp_path / "cut")
    st = _ready(mgr, make_spec(150.0, 10.0, 5, 2.0))
    assert st["rev"] == 1 and st["view"]["quality"] == "standard"         # the preview already used every exposure
    assert "target_px" not in st["view"]["passes"][0]


def test_empty_band_and_bad_requests(tmp_path):
    mgr = ViewManager(Http(session=_archive(n_per_pass=3), sleep=lambda s: None), tmp_path / "views", tmp_path / "cut")
    st = _ready(mgr, make_spec(150.0, 10.0, 2, 2.0))                      # no exposures in band 2
    assert st["view"]["passes"] == [] and st["view"]["warnings"]
    for call in (lambda: mgr.diff(st["id"], 0, 1), lambda: mgr.status("nope"), lambda: mgr.diff(st["id"], 0, 0)):
        try:
            call()
            raise AssertionError("expected KeyError")
        except KeyError:
            pass


def test_spec_is_normalised():
    a = make_spec(150.00001, 10.00001, 5, 4.2)
    b = make_spec(150.0, 10.0, 5, 4.0)
    assert a == b and view_id(a) == view_id(b)
    assert make_spec(10, 10, 5, 99)["size_arcmin"] == 10.0
