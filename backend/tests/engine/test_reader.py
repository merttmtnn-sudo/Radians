import io

import numpy as np
import pytest
from astropy.io import fits

from astropy.wcs import WCS

from app.engine.fitsread import GUESS_PAD, Reader, guess_pixel, shape_key, wavelength_at
from app.engine.http import Http, RangeNotHonoured
from tests.engine.fakes import FakeIrsa, make_file, region_of

URL_RICE = "https://irsa.example/ibe/data/spherex/dr1/level2/x/l2b-v27-2026-228/5/a_D5.fits"
URL_PLAIN = "https://irsa.example/ibe/data/spherex/qr2/level2/x/l2b-v20-2025-300/5/b_D5.fits"


def truth(data: bytes):
    with fits.open(io.BytesIO(data)) as hl:
        return hl["IMAGE"].data.astype("f4"), hl["FLAGS"].data.astype("i4"), hl["VARIANCE"].data.astype("f4")


def make_reader(files, **kw):
    fake = FakeIrsa(files, **kw)
    return Reader(Http(session=fake, sleep=lambda s: None)), fake


@pytest.mark.parametrize("url,compressed", [(URL_RICE, True), (URL_PLAIN, False)])
def test_cutout_matches_file(url, compressed):
    data = make_file(compressed=compressed, stars=[(150.0, 10.0, 50.0)])
    rd, fake = make_reader({url: data})
    for _ in range(2):                         # second read uses the cached layout
        c = rd.read(url, 150.0, 10.0, half=10, full=True)
    img, flags, var = truth(data)
    y0, x0 = c["y0"], c["x0"]
    h, w = c["img"].shape
    assert (h, w) == (21, 21)
    assert np.array_equal(c["img"], img[y0:y0 + h, x0:x0 + w])
    assert np.array_equal(c["flags"], flags[y0:y0 + h, x0:x0 + w])
    assert np.array_equal(c["var"], var[y0:y0 + h, x0:x0 + w])
    assert c["flag_names"]["HOT"] == 10
    lam, bw = wavelength_at(c["wave"], c["xc"], c["yc"])
    assert 4.1 < lam < 4.2 and bw == pytest.approx(0.03)


def test_preview_is_two_requests():
    data = make_file()
    rd, fake = make_reader({URL_RICE: data})
    c = rd.read(URL_RICE, 150.0, 10.0, half=10, full=False)
    assert len(fake.calls) == 2 and "flags" not in c


def test_off_detector():
    rd, _ = make_reader({URL_RICE: make_file()})
    assert rd.read(URL_RICE, 155.0, 10.0, half=10)["off"] is True


def test_big_box_splits_into_chunks_of_100_ranges():
    data = make_file(compressed=False)
    rd, fake = make_reader({URL_PLAIN: data})
    c = rd.read(URL_PLAIN, 150.0, 10.0, half=60, full=True)      # 121 rows x 3 HDUs
    assert all(len(h.get("Range", "").split(",")) <= 100 for _, h in fake.calls)
    img, _, _ = truth(data)
    assert np.array_equal(c["img"], img[c["y0"]:c["y0"] + 121, c["x0"]:c["x0"] + 121])


def test_whole_file_answer_is_refused():
    fake = FakeIrsa({URL_PLAIN: make_file(compressed=False)})
    http = Http(session=fake, sleep=lambda s: None)
    too_many = "bytes=" + ",".join(f"{i * 10}-{i * 10 + 3}" for i in range(101))
    with pytest.raises(RangeNotHonoured):
        http.get(URL_PLAIN, headers={"Range": too_many})
    # get_ranges itself never sends more than 100 ranges, so 101 ranges still work
    parts = http.get_ranges(URL_PLAIN, [(i * 10, i * 10 + 3) for i in range(101)])
    assert len(parts) == 101 and all(len(p) == 4 for p in parts)


def test_connections_can_be_opened_ahead():
    fake = FakeIrsa({f"u{i}": make_file(seed=i) for i in range(3)})
    http = Http(session=fake, sleep=lambda s: None)
    assert http.open_connections([f"u{i}" for i in range(3)] + ["missing"], n=12) == 3      # a failure is not counted
    assert sorted(h["Range"] for _, h in fake.calls) == ["bytes=0-79"] * 4
    assert http.open_connections([]) == 0 and http.open_connections(["u0"], n=0) == 0


def test_retries_after_429():
    data = make_file()
    rd, fake = make_reader({URL_RICE: data}, fail_429=2)
    c = rd.read(URL_RICE, 150.0, 10.0, half=5, full=False)
    assert c["img"].shape == (11, 11)
    assert rd.http.stats.retries >= 1


# -- the fast way: the sky footprint says where to read ------------------------------------------
URL_A = "https://irsa.example/ibe/data/spherex/dr1/level2/x/l2b-v27-2026-228/5/first_D5.fits"
URL_B = "https://irsa.example/ibe/data/spherex/dr1/level2/x/l2b-v27-2026-229/5/second_D5.fits"


def test_footprint_predicts_the_pixel():
    data = make_file(ra0=150.03, dec0=9.98, rot_deg=33)
    region = region_of(data)
    with fits.open(io.BytesIO(data)) as hl:
        w = WCS(hl["IMAGE"].header)
    for ra, dec in [(150.0, 10.0), (150.08, 9.93), (149.95, 10.1)]:
        x, y = (float(v) for v in w.all_world2pix(ra, dec, 0))
        gx, gy = guess_pixel(region, ra, dec, 256, 256)
        assert abs(gx - x) < 0.5 and abs(gy - y) < 0.5
    assert guess_pixel(None, 150.0, 10.0, 256, 256) is None
    assert guess_pixel(region[:6], 150.0, 10.0, 256, 256) is None
    assert guess_pixel(region, 330.0, -10.0, 256, 256) is None            # the other side of the sky


def test_fast_read_takes_one_request_and_one_more_for_the_rest():
    a = make_file(stars=[(150.0, 10.0, 50.0)], seed=1)
    b = make_file(ra0=150.02, dec0=10.01, rot_deg=20, stars=[(150.0, 10.0, 50.0)], seed=2, flag_above=20.0)
    rd, fake = make_reader({URL_A: a, URL_B: b})
    assert rd.read_fast(URL_B, 150.0, 10.0, 10, region_of(b)) is None     # nothing is known about these files yet
    assert not fake.calls
    assert rd.prime(URL_A) and rd.knows(URL_B)                             # learnt from one file of that pipeline version
    before = len(fake.calls)
    c = rd.read_fast(URL_B, 150.0, 10.0, half=10, region=region_of(b))
    assert len(fake.calls) == before + 1
    img, flags, var = truth(b)
    x0, y0 = c["x0"], c["y0"]
    h, w = c["img"].shape
    assert (h, w) == (21, 21) and np.array_equal(c["img"], img[y0:y0 + h, x0:x0 + w])
    assert 4.1 < wavelength_at(c["wave"], c["xc"], c["yc"])[0] < 4.2
    rest = rd.finish(URL_B, x0, y0, w, h, c["yc"], c["pending"], flags="near")
    assert len(fake.calls) == before + 2
    assert np.array_equal(rest["var"], var[y0:y0 + h, x0:x0 + w])
    r0, r1 = rest["flag_rows"]
    assert r1 - r0 == 13 and rest["flags"][r0:r1].any()                    # the rows next to the (saturated) target
    assert np.array_equal(rest["flags"][r0:r1], flags[y0 + r0:y0 + r1, x0:x0 + w])
    assert rest["flag_names"]["NONLINEAR"] == 15
    everything = rd.finish(URL_B, x0, y0, w, h, c["yc"], c["pending"], flags="all")
    assert np.array_equal(everything["flags"], flags[y0:y0 + h, x0:x0 + w])
    assert "flags" not in rd.finish(URL_B, x0, y0, w, h, c["yc"], c["pending"], flags=None)
    classic = rd.read(URL_B, 150.0, 10.0, half=10, full=True, flags="near")
    assert (classic["x0"], classic["y0"]) == (x0, y0)
    assert np.array_equal(classic["img"], c["img"]) and np.array_equal(classic["flags"], rest["flags"])


def test_fast_read_steps_aside_when_it_cannot_be_sure():
    a, b = make_file(seed=1), make_file(ra0=150.02, rot_deg=20, seed=2)
    rd, fake = make_reader({URL_A: a, URL_B: b, URL_PLAIN: make_file(compressed=False)})
    rd.prime(URL_A)
    good = region_of(b)
    assert rd.read_fast(URL_B, 150.0, 10.0, 10, None) is None              # no footprint
    wrong = region_of(make_file(ra0=150.02 + (GUESS_PAD + 6) * 6.15 / 3600, rot_deg=20))
    assert rd.read_fast(URL_B, 150.0, 10.0, 10, wrong) is None             # the guess missed by more than the padding
    assert rd.read_fast(URL_B, 150.0, 10.0, 10, good) is not None
    edge = 150.0 + 126 * 6.15 / 3600 / np.cos(np.radians(10.0))            # two pixels inside the detector's edge
    assert rd.read_fast(URL_A, edge, 10.0, 10, region_of(a))["off"] is True    # the header says: too close to the edge
    assert rd.read_fast(URL_B, 150.9, 10.0, 10, good) is None              # far outside the footprint: nothing is read
    assert rd.prime(URL_PLAIN) is False and rd.read_fast(URL_PLAIN, 150.0, 10.0, 10, good) is None    # older, uncompressed files


def test_each_detector_band_has_its_own_header_length():
    """In the real v27 files the IMAGE header of bands 1-2 is a block longer than that of bands 3-6,
    and longer than the nine blocks a first look reads. Each band is learnt and read on its own."""
    short = "https://irsa.example/ibe/data/spherex/qr3/level2/w/l2b-v27-2026-222/5/level2_w_0001_1D5_spx_l2b-v27-2026-222.fits"
    long_ = "https://irsa.example/ibe/data/spherex/qr3/level2/w/l2b-v27-2026-222/1/level2_w_0001_1D1_spx_l2b-v27-2026-222.fits"
    long2 = long_.replace("0001", "0002")
    a = make_file(stars=[(150.0, 10.0, 50.0)], seed=1)
    b = make_file(stars=[(150.0, 10.0, 50.0)], seed=2, extra_cards=330)
    c = make_file(ra0=150.01, rot_deg=15, stars=[(150.0, 10.0, 50.0)], seed=3, extra_cards=330)
    rd, fake = make_reader({short: a, long_: b, long2: c})
    assert shape_key(short) == "27/D5" and shape_key(long_) == "27/D1"
    assert rd.prime(short) and not rd.knows(long_)                      # band 5 says nothing about band 1
    assert rd.read_fast(long_, 150.0, 10.0, 10, region_of(b)) is None and rd.prime(long_)
    assert rd.shapes["27/D1"]["n1"] > rd.shapes["27/D5"]["n1"] and rd.shapes["27/D1"]["n1"] > 9 * 2880
    before = len(fake.calls)
    got = rd.read_fast(long2, 150.0, 10.0, 10, region_of(c))
    assert len(fake.calls) == before + 1
    img, _, var = truth(c)
    h, w = got["img"].shape
    assert np.array_equal(got["img"], img[got["y0"]:got["y0"] + h, got["x0"]:got["x0"] + w])
    rest = rd.finish(long2, got["x0"], got["y0"], w, h, got["yc"], got["pending"])
    assert np.array_equal(rest["var"], var[got["y0"]:got["y0"] + h, got["x0"]:got["x0"] + w])
    assert rd.read_fast(short, 150.0, 10.0, 10, region_of(a))["img"].shape == (21, 21)      # band 5 still reads its own way


def test_layouts_are_kept_between_runs(tmp_path):
    a = make_file(seed=1)
    fake = FakeIrsa({URL_A: a})
    kept = tmp_path / "data" / "layouts.json"
    rd = Reader(Http(session=fake, sleep=lambda s: None), layout_file=kept)
    assert rd.prime(URL_A) and kept.exists()
    calls = len(fake.calls)
    again = Reader(Http(session=fake, sleep=lambda s: None), layout_file=kept)
    assert again.knows(URL_B) and again.prime(URL_B) and len(fake.calls) == calls      # nothing is asked again
    assert again.read_fast(URL_A, 150.0, 10.0, 10, region_of(a))["img"].shape == (21, 21)
    seeded = Reader(Http(session=fake, sleep=lambda s: None), seed_file=kept)
    assert seeded.knows(URL_A)
    kept.write_text("not json")
    assert not Reader(Http(session=fake, sleep=lambda s: None), layout_file=kept).knows(URL_A)
