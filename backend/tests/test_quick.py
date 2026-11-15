"""/api/quick: an engine view of one band, answered in the Blink viewer's frame format (no network)."""
import base64

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import config, quick
from app.engine import api_views
from app.engine.http import Http
from app.engine.views import ViewManager
from app.main import app
from tests.engine.test_views import _archive

MOVER = dict(ra=150.0, dec=10.0, pmra=24000.0, pmdec=0.0, ref_epoch=2025.6)      # 24"/yr to the east


@pytest.fixture
def client(tmp_path, monkeypatch):
    """The site with the engine pointed at a fake archive: two passes, one star that moves, one that stays."""
    mgr = ViewManager(Http(session=_archive(), sleep=lambda s: None), tmp_path / "views", tmp_path / "cut")
    monkeypatch.setattr(api_views, "_manager", mgr)
    return TestClient(app)


def _follow(client, **params):
    """Ask like the page does until the build is finished; returns every answer that carried pictures."""
    have, with_pictures = -1, []
    for _ in range(100):
        d = client.get("/api/quick", params=dict(params, have=have, wait=2)).json()
        if d["frames"] is not None:
            with_pictures.append(d)
            have = d["quick"]["rev"]
        if d["quick"]["state"] in ("ready", "error"):
            return d, with_pictures
    raise AssertionError("the view never finished")


def _image(frame, n, key="image", dtype="<f4"):
    return np.frombuffer(base64.b64decode(frame[key]), dtype=dtype).reshape(n, n)


def test_quick_answers_in_the_viewers_format(client):
    last, pictures = _follow(client, fov=120, band=5, **MOVER)
    assert last["quick"]["state"] == "ready" and last["quick"]["quality"] == "standard"
    assert [d["quick"]["quality"] for d in pictures] == ["preview", "standard"]       # a preview first, then the band
    d = pictures[-1]
    g = d["grid"]
    n = g["n"]
    assert g["pixel_scale"] == 2.0 and g["fov"] == n * 2.0 == 120.0
    assert d["bad_mask"] == config.BAD_MASK and d["flag_bits"]["1"] == "OVERFLOW"
    assert d["query"]["band"] == 5 and d["wl_range"] == [3.83, 4.41]
    assert d["candidates"] == [] and d["exposures"] == []

    frames = d["frames"]
    assert [f["epoch"] for f in frames] == [1, 2] and all(f["detectors"] == [5] for f in frames)
    assert all(f["n_exposures"] > 0 and f["mjd_start"] <= f["mjd"] <= f["mjd_end"] for f in frames)
    assert frames[0]["date_start"].startswith("20") and len(frames[0]["date_start"]) == 16
    for f in frames:
        img = _image(f, n)
        assert np.isfinite(img).all()                                # saturated cores are filled for display
        assert (_image(f, n, "variance") > 0).all()
        assert _image(f, n, "flags", "<u4").shape == (n, n)

    # The star is where the engine predicts it, in the viewer's orientation (row 0 = south, x to the west),
    # and it moved east (to smaller x) between the two passes.
    spots = []
    for f in frames:
        img = _image(f, n)
        x, y = f["target_px"][0], n - 1 - f["target_px"][1]          # picture pixels (y down) -> array rows (y up)
        x0, y0 = int(round(x)) - 4, int(round(y)) - 4
        box = img[y0:y0 + 9, x0:x0 + 9]                               # (the field also holds a star that stays)
        iy, ix = np.unravel_index(np.argmax(box), box.shape)
        assert abs(x0 + ix - x) <= 2 and abs(y0 + iy - y) <= 2
        assert box.max() > 20 * np.median(np.abs(img))                # a real star, not noise
        spots.append(x0 + ix)
    assert spots[0] - spots[1] >= 3


def test_quick_does_not_resend_pictures_the_page_has(client):
    last, pictures = _follow(client, fov=120, band=5, **MOVER)
    again = client.get("/api/quick", params=dict(fov=120, band=5, have=last["quick"]["rev"], **MOVER)).json()
    assert again["frames"] is None and again["grid"]["n"] == pictures[-1]["grid"]["n"]
    assert again["quick"]["state"] == "ready" and len(again["quick"]["passes"]) == 2
    fresh = client.get("/api/quick", params=dict(fov=120, band=5, **MOVER)).json()
    assert len(fresh["frames"]) == 2


def test_a_band_without_pictures_is_reported_not_raised(client):
    last, pictures = _follow(client, fov=120, band=2, **MOVER)          # the fake archive only has band 5
    assert last["quick"]["state"] in ("ready", "error")
    assert not pictures or not pictures[-1]["frames"]


def test_a_challenge_target_gets_its_prebuilt_view():
    spec, pin = quick.quick_spec(331.044147, -56.782844, 240, None, 3981.977, -2466.832, 2000.0)
    assert pin["id"] == "eps-indi-b" and spec["band"] == 5
    assert api_views.demo_spec("eps-indi-b", 5, 4.0) == spec             # so it opens at once, whatever today's date
    spec, pin = quick.quick_spec(10.0, 10.0, 240, None, None, None, 2000.0)
    assert pin is None and spec["band"] == quick.DEFAULT_BAND and spec["target"] is None


def test_field_of_view_is_kept_within_what_the_engine_builds():
    spec, _ = quick.quick_spec(10.0, 10.0, 1200, 3, None, None, 2000.0)   # the viewer's 20 arcmin
    assert spec["size_arcmin"] == 10.0


def test_matched_differences_show_the_mover_as_a_pair(client):
    last, pictures = _follow(client, fov=120, band=5, **MOVER)
    n = pictures[-1]["grid"]["n"]
    d = client.get("/api/quick/diffs", params={"id": last["quick"]["id"]}).json()
    assert d["n"] == n and len(d["pairs"]) == 1
    pair = d["pairs"][0]
    assert (pair["a"], pair["b"]) == (0, 1) and pair["matched"] and pair["n_a"] == pair["n_b"] and pair["sigma"] > 0
    img = _image(pair, n)
    frames = pictures[-1]["frames"]
    was = (round(frames[0]["target_px"][0]), n - 1 - round(frames[0]["target_px"][1]))
    now = (round(frames[1]["target_px"][0]), n - 1 - round(frames[1]["target_px"][1]))
    box = lambda c: img[c[1] - 2:c[1] + 3, c[0] - 2:c[0] + 3]          # noqa: E731
    assert np.nanmin(box(was)) < -10 * pair["sigma"]                     # it was here: fainter now (blue)
    assert np.nanmax(box(now)) > 10 * pair["sigma"]                      # it is here now: brighter (orange)
    assert client.get("/api/quick/diffs", params={"id": "0" * 16}).status_code == 404


def test_difference_finds_come_back_as_viewer_candidates(client):
    last, pictures = _follow(client, fov=120, band=5, **MOVER)
    n = pictures[-1]["grid"]["n"]
    d = client.get("/api/quick/changes", params={"id": last["quick"]["id"]}).json()
    assert d["band"] == 5 and d["matched"] and d["notes"] == []
    movers = [c for c in d["candidates"] if c["type"] == "moving"]
    assert len(movers) == 1 and len(d["candidates"]) == 1            # the star that stays is not reported
    m = movers[0]
    assert m["method"] == "difference" and m["kind"] == "mover" and m["is_target"]
    # the fake star moves 12" east in half a year: about 24"/yr, towards position angle 90
    assert 20 < m["rate_arcsec_yr"] < 28 and 70 < m["pa_deg"] < 110 and m["rate_err"] > 0
    assert m["implausible"]                                          # faster than any real star: flagged
    # two points (was, is), in the viewer's orientation: east is towards smaller x
    was, now = m["points"]
    assert was["mjd"] < now["mjd"] and now["x"] < was["x"] and abs(now["y"] - was["y"]) < 2
    frames = pictures[-1]["frames"]
    assert abs(now["x"] - frames[1]["target_px"][0]) < 2 and abs(now["y"] - (n - 1 - frames[1]["target_px"][1])) < 2
    assert abs(m["ra"] - (150.0 + 12 / 3600 / np.cos(np.radians(10)))) * 3600 < 3 and abs(m["dec"] - 10.0) * 3600 < 3
    assert client.get("/api/quick/changes", params={"id": "0" * 16}).status_code == 404


def test_motion_fit_of_the_target_and_of_a_star_that_stays(client):
    last, pictures = _follow(client, fov=120, band=5, **MOVER)
    vid, n = last["quick"]["id"], pictures[-1]["grid"]["n"]
    m = client.get("/api/quick/motion", params={"id": vid}).json()             # the target: 24"/yr to the east
    assert m["ok"] and m["n"] == 2 and m["significant"]
    assert 20 < m["rate"] < 28 and 70 < m["direction_deg"] < 110 and m["err"] > 0
    # the other star of the fake field does not move: 40" east and 30" south of (150, 10)
    g = pictures[-1]["grid"]
    east = ((150.0 + 40 / 3600 - g["ra"]) * np.cos(np.radians(10))) * 3600
    north = (10.0 - 30 / 3600 - g["dec"]) * 3600
    x, y = (n - 1) / 2 - east / g["pixel_scale"], (n - 1) / 2 + north / g["pixel_scale"]
    still = client.get("/api/quick/motion", params={"id": vid, "x": x, "y": y}).json()
    assert still["ok"] and not still["significant"] and still["rate"] < 2
    assert client.get("/api/quick/motion", params={"id": "0" * 16}).status_code == 404


def test_the_band_picked_last_time_is_used_only_where_the_object_has_none():
    spec, pin = quick.quick_spec(10.0, 10.0, 240, None, None, None, 2000.0, prefer=3)
    assert pin is None and spec["band"] == 3                               # an ordinary spot: the visitor's last band
    spec, _ = quick.quick_spec(10.0, 10.0, 240, 6, None, None, 2000.0, prefer=3)
    assert spec["band"] == 6                                               # a band asked for by name wins
    spec, pin = quick.quick_spec(331.044147, -56.782844, 240, None, 3981.977, -2466.832, 2000.0, prefer=3)
    assert pin["id"] == "eps-indi-b" and spec["band"] == 5                 # a curated object keeps its own band


def test_the_fast_bands_lookups_are_rate_limited():
    from app import main
    for p in ("/api/quick/changes", "/api/quick/diffs", "/api/quick/motion"):
        assert main.LIMITS[p] == config.RATE_LOOKUP
    assert "/api/quick" not in main.LIMITS                                 # long-polled: the build queue limits it


def test_a_head_start_asks_the_archive_once_and_reads_no_pixels(client, tmp_path):
    """While the visitor is still choosing a target the page calls /api/quick/warm: the exposure list
    is fetched in the background, so the build that follows does not wait for it."""
    import time
    mgr = api_views.manager()
    fake = mgr.http.session
    assert client.get("/api/quick/warm", params={"ra": 150.0, "dec": 10.0, "band": 5}).json() == {"started": True}
    for _ in range(100):
        if not quick._warming:
            break
        time.sleep(0.02)
    lists = [u for u, _ in fake.calls if u.endswith("/SIA")]
    assert len(lists) == 1 and (mgr.sia_dir).exists()
    assert not any(h.get("Range", "").count(",") > 5 for _, h in fake.calls)       # headers at most: no image rows
    opened = [h for u, h in fake.calls if h.get("Range") == "bytes=0-79"]
    assert 1 <= len(opened) <= 12                                                    # connections opened ahead of the build
    before = len(fake.calls)
    last, _ = _follow(client, fov=120, band=5, ra=150.0, dec=10.0)
    assert last["quick"]["state"] == "ready"
    assert not [u for u, _ in fake.calls[before:] if u.endswith("/SIA")]            # the list was already there
    # not again for the same spot within seconds; and a band that does not exist is refused
    assert client.get("/api/quick/warm", params={"ra": 150.0, "dec": 10.0, "band": 5}).json() == {"started": False}
    assert client.get("/api/quick/warm", params={"ra": 150.0, "dec": 10.0, "band": 9}).status_code == 422
