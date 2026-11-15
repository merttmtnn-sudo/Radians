import io

import numpy as np
import pytest
from astropy.io import fits

from app.engine.fitsread import Reader, wavelength_at
from app.engine.http import Http, RangeNotHonoured
from tests.engine.fakes import FakeIrsa, make_file

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


def test_retries_after_429():
    data = make_file()
    rd, fake = make_reader({URL_RICE: data}, fail_429=2)
    c = rd.read(URL_RICE, 150.0, 10.0, half=5, full=False)
    assert c["img"].shape == (11, 11)
    assert rd.http.stats.retries >= 1
