import os
import time

import numpy as np
import pytest

from app.engine import field, sia, stacking, store
from app.engine.field import CutoutCache, build_band, snap, spread_in_time, spread_in_wavelength
from app.engine.fitsread import Reader
from app.engine.http import Http
from tests.engine.fakes import FakeIrsa, make_file, sia_csv, region_of


# -- SIA ----------------------------------------------------------------------------------------
def test_sia_parse_keeps_science_level2_one_per_exposure():
    text = sia_csv([dict(obs_id="A", det=5, url="u1", mjd=60901.0, coll="spherex_qr3"),
                    dict(obs_id="A", det=5, url="u2", mjd=60901.0, coll="spherex_dr1"),
                    dict(obs_id="B", det=6, url="u3", mjd=60900.0)])
    text += "C,SPHEREx-D5,u4,spherex_dr1,calibration,2,60902,1\n"
    text += "D,SPHEREx-D5,u5,spherex_dr1_cube,science,2,60902,1\n"
    rows = sia.parse_sia_csv(text)
    assert [(r["obs_id"], r["det"], r["url"]) for r in rows] == [("B", 6, "u3"), ("A", 5, "u2")]


def test_sia_error_page_is_not_empty_list():
    with pytest.raises(ValueError):
        sia.parse_sia_csv("<VOTABLE><INFO name='QUERY_STATUS' value='ERROR'/></VOTABLE>")


def test_sia_cache_survives_archive_outage(tmp_path):
    good = FakeIrsa(sia_csv=sia_csv([dict(obs_id="A", det=5, url="u", mjd=60900.0)]))
    http = Http(session=good, sleep=lambda s: None)
    assert len(sia.exposures(http, 10.0, 20.0, tmp_path, ttl_hours=0)) == 1
    http.session = FakeIrsa(sia_csv="<html>down</html>")
    assert len(sia.exposures(http, 10.0, 20.0, tmp_path, ttl_hours=0)) == 1    # old list kept


# -- store --------------------------------------------------------------------------------------
def test_atomic_arrays_roundtrip_and_cap(tmp_path):
    store.save_arrays(tmp_path / "a.npz", img=np.arange(4.0), hdr="text", ok=True)
    z = store.load_arrays(tmp_path / "a.npz")
    assert z["hdr"] == "text" and bool(z["ok"]) and z["img"][3] == 3.0
    for i in range(5):
        store.write_bytes(tmp_path / "f" / f"{i}.bin", b"x" * 1000)
        os.utime(tmp_path / "f" / f"{i}.bin", (time.time() - 100 + i, time.time() - 100 + i))
    store.write_bytes(tmp_path / "demo" / "keep.bin", b"x" * 1000)
    os.utime(tmp_path / "demo" / "keep.bin", (0, 0))
    store.enforce_cap(tmp_path / "f", 2500)
    assert sorted(p.name for p in (tmp_path / "f").iterdir()) == ["3.bin", "4.bin"]
    store.enforce_cap(tmp_path, 1, protected=("demo",))
    assert (tmp_path / "demo" / "keep.bin").exists()


# -- stacking -----------------------------------------------------------------------------------
def test_group_passes_gaps_and_long_runs():
    t = [0, 1, 2, 100, 101, 300] + list(np.arange(400, 560, 5.0))
    groups = stacking.group_passes(t)
    assert groups[0] == [0, 1, 2] and groups[1] == [3, 4] and groups[2] == [5]
    assert len(groups) == 3 + 3                  # a 155-day continuous run splits into 3 bins


def test_pass_picture_is_a_clipped_mean():
    """Less noise than the median, and a cosmic ray in one frame still leaves no mark."""
    rng = np.random.default_rng(4)
    frames = rng.standard_normal((40, 60, 60)).astype("f4")
    frames[7, 10, 10] = 500.0                                   # a cosmic ray
    frames[:, 30, 30] += 50.0                                   # a star, in every frame
    frames[3, 5:8, 5:8] = np.nan                                # a blank patch in one frame
    idx = np.arange(40)
    med, mean = stacking.median_stack(frames, idx), stacking.pass_stack(frames, idx)
    quiet = np.ones((60, 60), bool)
    quiet[30, 30] = False
    assert 0.75 < mean[quiet].std() / med[quiet].std() < 0.9    # the median's error is 25% larger for Gaussian noise
    assert abs(mean[10, 10]) < 1 and abs(mean[30, 30] - 50) < 1 and np.isfinite(mean).all()
    few = stacking.pass_stack(frames, idx[:5])                  # too few frames to judge scatter: the median
    np.testing.assert_array_equal(few, stacking.median_stack(frames, idx[:5]))
    assert np.isnan(stacking.pass_stack(frames, [])).all()
    empty = np.full((8, 4, 4), np.nan, "f4")
    assert np.isnan(stacking.pass_stack(empty, np.arange(8))).all()


def test_big_fields_keep_two_arcsec_pixels():
    assert field.grid_size(4.0) == (120, 2.0) and field.grid_size(10.0) == (300, 2.0)
    assert field.grid_size(10.0, 60) == (300, 2.0)              # an ordinary field: 60 exposures
    n, scale = field.grid_size(10.0, 600)                       # a deep field: coarser, so the cube fits in memory
    assert scale > 2.0 and 600 * n * n <= field.MAX_CUBE_PIXELS * 1.02 and abs(n * scale - 600) < scale


def test_a_short_return_visit_joins_its_neighbour():
    """SPHEREx came back 22 days after a visit for 3 exposures (the user's field at 240.869 -32.656):
    three exposures alone make a noisy picture, so they stay with the visit before."""
    t = list(np.linspace(60888, 60903, 19)) + list(np.linspace(61090, 61096, 18))         + list(np.linspace(61256, 61266, 18)) + [61288, 61289, 61290]
    assert [len(g) for g in stacking.group_passes(t)] == [19, 18, 21]
    # with enough exposures the return visit is a visit of its own (the same 20-day rule as all detectors)
    more = t + [61288.5, 61289.5, 61290.5]
    assert [len(g) for g in stacking.group_passes(more)] == [19, 18, 18, 6]
    # a small part far from everything stays alone rather than being glued across months
    assert [len(g) for g in stacking.group_passes([0, 1, 2, 100, 101, 102, 103, 104, 105])] == [3, 6]
    # the smaller neighbourless parts do not stop a later small part from joining
    assert [len(g) for g in stacking.group_passes([0, 200, 201, 202, 203, 204, 205, 230])] == [1, 7]


def test_shared_range_and_widening():
    waves = np.array([3.85, 3.9, 4.0, 4.1, 4.3, 4.35, 4.0, 4.05, 4.2])
    sel, info = stacking.shared_range({0: np.arange(6), 1: np.arange(6, 9)}, waves, band=5, min_frames=2)
    assert info["matched"] and set(sel[0]) == {2, 3}       # 4.0-4.2 is shared
    far = np.array([3.84, 3.86, 4.38, 4.40])
    sel, info = stacking.shared_range({0: [0, 1], 1: [2, 3]}, far, band=5)
    assert not info["matched"] and info["warning"]


def test_pair_by_wavelength_matches_mix():
    waves = np.array([3.85, 3.86, 4.39, 4.40] + list(np.linspace(3.84, 4.41, 20)))
    pairs = stacking.pair_by_wavelength(np.arange(4), np.arange(4, 24), waves, tol=0.035)
    a, b = pairs
    assert len(a) >= 3
    assert abs(np.median(waves[a]) - np.median(waves[b])) < 0.05


def test_robust_stats_ignores_outliers():
    v = np.r_[np.random.default_rng(1).normal(10, 1, 1000), [1e6] * 20]
    med, sig = stacking.robust_stats(v)
    assert med == pytest.approx(10, abs=0.1) and sig == pytest.approx(1, abs=0.1)


# -- end to end: a fake archive with a moving and a static star --------------------------------
def test_build_band_shows_motion(tmp_path):
    ra0, dec0 = 150.0, 10.0
    static = (ra0 + 40 / 3600, dec0 - 30 / 3600, 30.0)
    files, rows = {}, []
    for p, (mjd, east) in enumerate([(60900.0, 0.0), (61080.0, 12.0)]):        # moves 12" east
        mover = (ra0 + east / 3600 / np.cos(np.radians(dec0)), dec0, 30.0)
        for i in range(6):
            url = f"https://irsa.example/l2b-v27-x/{p}_{i}.fits"
            files[url] = make_file(ra0 + 0.01 * i, dec0, mjd + i, wave0=3.85 + 0.01 * i, rot_deg=7 * i,
                                   stars=[mover, static], seed=10 * p + i)
            rows.append(dict(obs_id=f"{p}_{i}", det=5, url=url, mjd=mjd + i))
    fake = FakeIrsa(files, sia_csv=sia_csv(rows))
    http = Http(session=fake, sleep=lambda s: None)
    exps = sia.exposures(http, ra0, dec0, tmp_path / "sia")
    cache = CutoutCache(Reader(http), tmp_path / "cut")
    res = build_band(cache, exps, ra0, dec0, band=5, size_arcmin=2.0, quality="full")
    assert len(res["passes"]) == 2 and res["timing"]["n_used"] == 12
    n, scale = res["grid"]["n"], res["grid"]["scale_arcsec"]

    def peak(img, x_guess, y_guess, r=5):
        sub = np.nan_to_num(img[y_guess - r:y_guess + r + 1, x_guess - r:x_guess + r + 1], nan=-1)
        yy, xx = np.unravel_index(np.argmax(sub), sub.shape)
        return x_guess - r + xx, y_guess - r + yy

    c = (n - 1) // 2
    a = peak(res["stacks"][0], c, c)
    b = peak(res["stacks"][1], c - 6, c)
    assert (a[0] - b[0]) * scale == pytest.approx(12.0, abs=2.5)      # east = towards smaller x
    sx = c - int(round(40 / scale))
    sy = c - int(round(30 / scale))
    assert peak(res["stacks"][0], sx, sy) == peak(res["stacks"][1], sx, sy)   # static star stays
    # a second build comes entirely from the disk cache
    before = len(fake.calls)
    build_band(cache, exps, ra0, dec0, band=5, size_arcmin=2.0, quality="full")
    assert len(fake.calls) == before


def test_probe_sample_spread_in_time():
    exps = [dict(mjd=60900 + i * 0.1, det=5) for i in range(40)] + [dict(mjd=61100 + i * 0.1, det=5) for i in range(3)]
    assert len(spread_in_time(exps, 24)) == 24 + 3


def test_preview_spread_in_wavelength_covers_shared_range():
    rng = np.random.default_rng(3)
    a = [dict(mjd=60900 + i * 0.1, wave_um=w) for i, w in enumerate(rng.uniform(3.83, 4.41, 30))]
    b = [dict(mjd=61100 + i * 0.1, wave_um=w) for i, w in enumerate(np.r_[rng.uniform(4.0, 4.2, 10), [3.9, 4.35]])]
    chosen, info = spread_in_wavelength(a + b, band=5)
    pa = [c for c in chosen if c["mjd"] < 61000]
    pb = [c for c in chosen if c["mjd"] > 61000]
    assert len(pa) == 8 and len(pb) == 8
    lo, hi = info["range_um"]
    assert all(lo <= c["wave_um"] <= hi for c in chosen)
    wa = sorted(c["wave_um"] for c in pa)
    assert wa[-1] - wa[0] > 0.6 * (hi - lo)                # spread across the range, not bunched


def test_preview_never_stacks_two_frames_when_more_exist():
    a = [dict(mjd=60900 + i, wave_um=w) for i, w in enumerate([3.85, 3.86, 3.87, 3.88, 4.38, 4.39])]
    b = [dict(mjd=61100 + i, wave_um=w) for i, w in enumerate([4.36, 4.37, 4.40, 3.84])]
    chosen, _ = spread_in_wavelength(a + b, band=5)
    assert sum(c["mjd"] < 61000 for c in chosen) >= 3 and sum(c["mjd"] > 61000 for c in chosen) >= 3


def test_rice_codec_import_still_works():
    """Skyshift decodes FLAGS with astropy's private Rice codec. If an astropy upgrade moves it,
    this must fail loudly (pinned: astropy 8.0.2)."""
    from astropy.io.fits.hdu.compressed._codecs import Rice1
    from app.engine.fitsread import decode_rice_rows
    from astropy.io import fits
    row = (np.arange(64, dtype="i4") % 7) << 3
    blob = Rice1(blocksize=32, bytepix=4, tilesize=64).encode(row)
    hdr = fits.Header({"ZTILE1": 64, "ZNAME1": "BLOCKSIZE", "ZVAL1": 32, "ZNAME2": "BYTEPIX", "ZVAL2": 4})
    out = decode_rice_rows(hdr, [bytes(blob), bytes(blob)])
    assert out.shape == (2, 64) and np.array_equal(out[1], row)


def _two_pass_archive(stars_for_pass, n_per_pass=6, **file_kw):
    files, rows = {}, []
    for p, mjd in enumerate([60900.0, 61080.0]):
        for i in range(n_per_pass):
            url = f"https://irsa.example/l2b-v27-x/{p}_{i}.fits"
            files[url] = make_file(150.0 + 0.01 * i, 10.0, mjd + i, wave0=3.85 + 0.01 * i, rot_deg=7 * i,
                                   stars=stars_for_pass(p), seed=10 * p + i, **file_kw)
            rows.append(dict(obs_id=f"{p}_{i}", det=5, url=url, mjd=mjd + i))
    return files, rows


def test_fast_preview_reads_every_exposure_in_one_request(tmp_path):
    """With the exposures' sky footprints the preview is one request per exposure and already has
    the full depth; the standard pass is one more request each and gives the classic result."""
    files, rows = _two_pass_archive(lambda p: [(150.0 + p * 12 / 3600 / np.cos(np.radians(10)), 10.0, 30.0)],
                                    n_per_pass=12, flag_above=20.0)
    for r in rows:
        r["region"] = region_of(files[r["url"]])
    fake = FakeIrsa(files, sia_csv=sia_csv(rows))
    http = Http(session=fake, sleep=lambda s: None)
    exps = sia.exposures(http, 150.0, 10.0, tmp_path / "sia")
    assert all(len(e["region"]) == 8 for e in exps)
    cache = CutoutCache(Reader(http), tmp_path / "cut")
    start = len(fake.calls)
    prev = build_band(cache, exps, 150.0, 10.0, band=5, size_arcmin=2.0, quality="preview")
    assert prev["timing"]["fast"] and [p["n_frames"] for p in prev["passes"]] == [12, 12]
    assert not prev["sats"].any()                                              # no flags yet
    assert 24 <= len(fake.calls) - start <= 24 + 4                             # 24 exposures + learning the layout once
    before = len(fake.calls)
    std = build_band(cache, exps, 150.0, 10.0, band=5, size_arcmin=2.0, quality="standard")
    assert len(fake.calls) - before == 24 and not std["timing"]["fast"]
    assert std["sats"].any()                                                   # the saturated target is now marked
    # the same pictures as the classic way (no footprints: headers first, then the rows)
    plain = FakeIrsa(files, sia_csv=sia_csv([{k: v for k, v in r.items() if k != "region"} for r in rows]))
    http2 = Http(session=plain, sleep=lambda s: None)
    exps2 = sia.exposures(http2, 150.0, 10.0, tmp_path / "sia2")
    assert all(e["region"] is None for e in exps2)
    classic = build_band(CutoutCache(Reader(http2), tmp_path / "cut2"), exps2, 150.0, 10.0, band=5, size_arcmin=2.0, quality="standard")
    assert len(plain.calls) > len(fake.calls)
    for p in (0, 1):
        np.testing.assert_array_equal(std["stacks"][p], classic["stacks"][p])
    np.testing.assert_array_equal(std["sats"], classic["sats"])
    # a preview of the classic kind (no footprints) still picks a few exposures per pass
    old = build_band(CutoutCache(Reader(http2), tmp_path / "cut3"), exps2, 150.0, 10.0, band=5, size_arcmin=2.0, quality="preview")
    assert not old["timing"]["fast"] and [p["n_used"] for p in old["passes"]] == [8, 8]


def test_standard_quality_sees_saturated_but_finite_target(tmp_path):
    """Bright stars in D5-D6 saturate without going blank: only FLAGS tell. Standard quality must
    still mark the target as saturated (flags of the rows near the target are fetched)."""
    files, rows = _two_pass_archive(lambda p: [(150.0, 10.0, 80.0)], flag_above=40.0)
    http = Http(session=FakeIrsa(files, sia_csv=sia_csv(rows)), sleep=lambda s: None)
    exps = sia.exposures(http, 150.0, 10.0, tmp_path / "sia")
    cache = CutoutCache(Reader(http), tmp_path / "cut")
    res = build_band(cache, exps, 150.0, 10.0, band=5, size_arcmin=2.0, quality="standard")
    n = res["grid"]["n"]
    c = (n - 1) // 2
    assert res["sats"][:, c - 1:c + 2, c - 1:c + 2].any(axis=(1, 2)).all()      # every frame
    assert all(p["saturated_fraction"] > 0 for p in res["passes"])
    prev = build_band(CutoutCache(Reader(http), tmp_path / "cut2"), exps, 150.0, 10.0, band=5,
                      size_arcmin=2.0, quality="preview")
    assert not prev["sats"].any()                                              # preview has no flags


def test_preview_build_end_to_end(tmp_path):
    files, rows = _two_pass_archive(lambda p: [(150.0 + p * 12 / 3600 / np.cos(np.radians(10)), 10.0, 30.0)],
                                    n_per_pass=12)
    fake = FakeIrsa(files, sia_csv=sia_csv(rows))
    http = Http(session=fake, sleep=lambda s: None)
    exps = sia.exposures(http, 150.0, 10.0, tmp_path / "sia")
    cache = CutoutCache(Reader(http), tmp_path / "cut")
    res = build_band(cache, exps, 150.0, 10.0, band=5, size_arcmin=2.0, quality="preview")
    assert [p["n_used"] for p in res["passes"]] == [8, 8]
    before = len(fake.calls)
    std = build_band(cache, exps, 150.0, 10.0, band=5, size_arcmin=2.0, quality="standard")
    assert std["timing"]["n_used"] == 24
    # standard reuses the cached headers: 2 requests for each of the 16 previewed exposures, 3 for the rest
    assert len(fake.calls) - before <= 16 * 2 + 8 * 3 + 2


def test_snap_is_stable():
    assert snap(150.0001, 10.0001) == snap(150.0, 10.0)


def test_coarse_mapping_matches_exact_sip():
    """Real DR1 IMAGE header (SIP distortion): the fast coarse mapping agrees with the exact one."""
    from pathlib import Path
    from astropy.io import fits
    from astropy.wcs import WCS
    hdr = fits.Header.fromstring((Path(__file__).parent / "data" / "dr1_d6_image_header.txt").read_text())
    det = WCS(hdr)
    ra, dec = det.all_pix2world(1700.0, 300.0, 0)           # near a corner, where distortion is largest
    n = 120
    gw = stacking.grid_wcs(float(ra), float(dec), n, 2.0)
    fast = stacking.detector_coords(det, gw, n)
    exact = det.all_world2pix(*stacking.grid_sky(gw, n), 0)
    assert np.max(np.abs(fast[0] - exact[0])) < 0.01 and np.max(np.abs(fast[1] - exact[1])) < 0.01


def test_standard_level_has_variance_but_no_flags():
    from tests.engine.fakes import make_file as mk
    url = "https://irsa.example/l2b-v27-x/s.fits"
    fake = FakeIrsa({url: mk()})
    rd = Reader(Http(session=fake, sleep=lambda s: None))
    c = rd.read(url, 150.0, 10.0, half=8, full=True, flags=False)
    assert c["var"].shape == c["img"].shape and "flags" not in c


def test_pixel_map_matches_exact_sip():
    """The per-cutout polynomial map agrees with the full SIP WCS on a real DR1 header."""
    from pathlib import Path
    from astropy.io import fits
    from astropy.wcs import WCS
    hdr = fits.Header.fromstring((Path(__file__).parent / "data" / "dr1_d6_image_header.txt").read_text())
    det = WCS(hdr)
    for x0, y0 in [(5, 5), (1900, 1950), (1000, 1000)]:
        pm = stacking.fit_pixel_map(det, x0, y0, x0 + 95, y0 + 85)
        assert pm["max_err_px"] < 1e-3
        gx, gy = np.meshgrid(np.linspace(x0, x0 + 94, 13), np.linspace(y0, y0 + 84, 11))
        ra, dec = det.all_pix2world(gx.ravel(), gy.ravel(), 0)
        x, y = stacking.apply_pixel_map(pm, ra, dec)
        assert np.max(np.abs(x - gx.ravel())) < 2e-3 and np.max(np.abs(y - gy.ravel())) < 2e-3


def test_preview_window_ignores_one_stray_frame():
    """ε Indi B D5 on real data: a 5-frame pass with one stray frame at 3.83 µm. The preview window
    must follow where that pass really has frames (4.07-4.32 µm), not the stray one."""
    rich = [dict(mjd=60900 + i * 0.1, wave_um=w) for i, w in enumerate(np.linspace(3.83, 4.42, 24))]
    sparse = [dict(mjd=61100 + i, wave_um=w) for i, w in enumerate([3.829, 4.068, 4.103, 4.139, 4.175, 4.32])]
    chosen, info = spread_in_wavelength(rich + sparse, band=5)
    first = [c["wave_um"] for c in chosen if c["mjd"] < 61000]
    assert min(first) > 4.0 and len(first) == 8
    assert info["range_um"][0] > 4.0
