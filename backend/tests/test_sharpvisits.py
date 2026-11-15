"""One sharpened picture per visit for the Blink viewer (sharp.visits, /api/frames?sharp=2). No network."""
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from app import config, fitsrange, sharp, stack
from app.archive import Exposure

N = 21                      # native pixels across the field
SIG = 0.55                  # the star's width in native pixels: narrower than a pixel, as for SPHEREx
SEP = 12.0                  # arcsec between the two test stars


def cutout(k, ra0, dec0, star, rng):
    """A 61x61 detector cutout whose pointing is shifted by a random fraction of a pixel and rotated."""
    size = 61
    rot = np.radians(rng.uniform(0, 360))
    h = fits.Header()
    h["NAXIS"], h["NAXIS1"], h["NAXIS2"] = 2, size, size
    h["CTYPE1"], h["CTYPE2"] = "RA---TAN", "DEC--TAN"
    h["CRVAL1"], h["CRVAL2"] = ra0, dec0
    h["CRPIX1"], h["CRPIX2"] = size / 2 + rng.uniform(-0.5, 0.5), size / 2 + rng.uniform(-0.5, 0.5)
    s = config.PIXEL_SCALE / 3600
    h["CD1_1"], h["CD1_2"], h["CD2_1"], h["CD2_2"] = -s * np.cos(rot), s * np.sin(rot), s * np.sin(rot), s * np.cos(rot)
    w = WCS(h)
    yy, xx = np.mgrid[0:size, 0:size]
    img = 0.02 * rng.standard_normal((size, size))
    for ra, dec, peak in star:
        x, y = w.all_world2pix(ra, dec, 0)
        # what a pixel collects: the star's light integrated over the pixel (a Gaussian blurred by the pixel)
        img += peak * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * (SIG ** 2 + 1 / 12)))
    return fitsrange.Cutout(img.astype("f4"), np.full((size, size), 0.02 ** 2, "f4"), np.zeros((size, size), np.uint32), 0, 0, h, size / 2, size / 2)


def build(monkeypatch, visits=(60900.0, 61080.0), per_visit=40, ra0=150.0, dec0=10.0):
    rng = np.random.default_rng(3)
    cosd = np.cos(np.radians(dec0))
    # two stars 12 arcsec apart: just under two native pixels
    stars = [(ra0, dec0, 10.0), (ra0 + SEP / 3600 / cosd, dec0, 10.0)]
    cuts, frames = {}, []
    wout = stack.output_wcs(ra0, dec0, N)
    for mjd0 in visits:
        for i in range(per_visit):
            exp = Exposure(obs_id=f"{mjd0:.0f}_{i}", detector=1 + i % 6, url=f"u{mjd0:.0f}_{i}", mjd_start=mjd0 + i * 0.1,
                           mjd_end=mjd0 + i * 0.1 + 0.001, wl_min=1.0, wl_max=1.1, exptime=100.0, collection="x")
            cuts[exp.url] = cutout(i, ra0, dec0, stars, rng)
            frames.append(exp)
    monkeypatch.setattr(stack, "_cutout_cached", lambda exp, ra, dec, half: cuts[exp.url])
    frs = [f for f in (stack.build_frame(e, ra0, dec0, N, wout, lambda mjd: (ra0, dec0)) for e in frames) if f is not None]
    return frs, stars


def dip(img, scale_arcsec):
    """Brightness half-way between the two stars over the fainter of their peaks (1 = no dip at all)."""
    n = img.shape[0]
    c = (n - 1) / 2
    row = img[int(np.floor(c)):int(np.ceil(c)) + 1].mean(axis=0)
    at = lambda x: float(np.interp(x, np.arange(n), row))  # noqa: E731
    other = c - SEP / scale_arcsec                          # east is towards smaller x
    return at((c + other) / 2) / min(at(c), at(other))


def test_each_visit_gets_a_sharper_picture_on_the_same_sky(monkeypatch):
    monkeypatch.setattr(fitsrange, "wave_table", lambda url, det: (_ for _ in ()).throw(IOError("no table in this test")))
    frs, stars = build(monkeypatch)
    out = sharp.visits(frs, 150.0, 10.0, N, 2)
    g = out["grid"]
    assert g["n"] == 2 * N and g["pixel_scale"] == config.PIXEL_SCALE / 2 and abs(g["fov"] - N * config.PIXEL_SCALE) < 1e-9
    assert [f["epoch"] for f in out["frames"]] == [1, 2] and all(f["n_exposures"] == 40 and not f["thin"] for f in out["frames"])
    assert all(f["filled"] > 0.9 for f in out["frames"])
    n = g["n"]
    fine = np.frombuffer(__import__("base64").b64decode(out["frames"][0]["image"]), "<f4").reshape(n, n)
    native = stack.group_raw(frs, "epoch")[0]["image"]
    # the same sky: the pair sits at the same place (the first star at the centre, the second 9" to the east = smaller x)
    w = WCS(fits.Header(g["wcs"]))
    x1, y1 = (float(v) for v in w.all_world2pix(stars[0][0], stars[0][1], 0))
    x2, y2 = (float(v) for v in w.all_world2pix(stars[1][0], stars[1][1], 0))
    assert abs(x1 - (n - 1) / 2) < 1e-6 and abs(y1 - (n - 1) / 2) < 1e-6 and abs((x1 - x2) - SEP / g["pixel_scale"]) < 0.01
    # the pair is split clearly in the sharpened picture and only just in the ordinary one
    # (measured: 0.68 against 0.91 at 12 arcsec; a single star is 8.9 arcsec wide instead of 10.3)
    assert dip(fine, g["pixel_scale"]) < 0.78 and dip(native, config.PIXEL_SCALE) > 0.85
    # the target marker follows the fine grid (picture pixels, y down)
    assert out["frames"][0]["target_px"] == [n / 2 - 0.5, n / 2 - 0.5]
    assert out["sharp"]["factor"] == 2


def test_a_visit_with_few_exposures_is_kept_and_marked(monkeypatch):
    monkeypatch.setattr(fitsrange, "wave_table", lambda url, det: (_ for _ in ()).throw(IOError("no table in this test")))
    frs, _ = build(monkeypatch, per_visit=6)
    out = sharp.visits(frs, 150.0, 10.0, N, 2)
    assert all(f["thin"] and f["n_exposures"] == 6 for f in out["frames"])
    assert sharp.visits([], 150.0, 10.0, N, 2) is None
