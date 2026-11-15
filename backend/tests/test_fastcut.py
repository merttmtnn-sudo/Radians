"""The all-detector reader's short cut: two requests per exposure instead of four, when the image
search gave the exposure's sky footprint. Against the fake IRSA of the engine tests. No network."""
import numpy as np
import pytest

from app import config, fitsrange
from tests.engine.fakes import NX, FakeIrsa, make_file, region_of

URL = "https://irsa.example/ibe/data/spherex/dr1/level2/x/l2b-v27-2026-228/5/a_D5.fits"
OTHER = "https://irsa.example/ibe/data/spherex/dr1/level2/x/l2b-v27-2026-229/5/b_D5.fits"


@pytest.fixture
def archive(tmp_path, monkeypatch):
    files = {URL: make_file(stars=[(150.0, 10.0, 50.0)], seed=1),
             OTHER: make_file(ra0=150.02, dec0=10.01, rot_deg=20, stars=[(150.0, 10.0, 50.0)], seed=2, flag_above=20.0)}
    fake = FakeIrsa(files)
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(config, "DETECTOR_SIZE", NX)
    monkeypatch.setattr(fitsrange, "session", lambda: fake)
    monkeypatch.setattr(fitsrange, "_templates", {})
    return files, fake


def same(a, b):
    assert (a.x0, a.y0) == (b.x0, b.y0) and a.x == pytest.approx(b.x) and a.y == pytest.approx(b.y)
    for name in ("image", "variance", "flags"):
        np.testing.assert_array_equal(getattr(a, name), getattr(b, name))


def test_two_requests_give_the_same_cutout_as_four(archive):
    files, fake = archive
    classic = fitsrange.read_cutout(OTHER, 150.0, 10.0, 12)          # also learns the layout of these files
    assert classic.image.shape == (25, 25) and classic.flags.any()
    before = len(fake.calls)
    fast = fitsrange.read_cutout_fast(OTHER, 150.0, 10.0, 12, region_of(files[OTHER]))
    assert len(fake.calls) - before == 2
    same(fast, classic)
    before = len(fake.calls)
    fitsrange.read_cutout(OTHER, 150.0, 10.0, 12)
    assert len(fake.calls) - before > 2                               # the classic way costs more round trips
    same(fitsrange.read_cutout_fast(URL, 150.0, 10.0, 12, region_of(files[URL])), fitsrange.read_cutout(URL, 150.0, 10.0, 12))


def test_the_short_cut_steps_aside(archive):
    files, fake = archive
    fitsrange.read_cutout(URL, 150.0, 10.0, 12)
    assert fitsrange.read_cutout_fast(URL, 150.0, 10.0, 12, None) is False                 # no footprint
    wrong = region_of(make_file(ra0=150.0 + 20 * 6.15 / 3600))
    assert fitsrange.read_cutout_fast(URL, 150.0, 10.0, 12, wrong) is False                # the guess missed
    assert fitsrange.read_cutout_fast(URL, 151.5, 10.0, 12, region_of(files[URL])) is False    # far off the detector: nothing read
    edge = 150.0 + (NX / 2 + 11.5) * 6.15 / 3600 / np.cos(np.radians(10.0))                # just outside the detector
    assert fitsrange.read_cutout_fast(URL, edge, 10.0, 12, region_of(files[URL])) is None
