"""Sharper than one SPHEREx pixel: drizzle many dithered exposures onto a finer grid.

SPHEREx's 6.15″ pixels are larger than the telescope's blur, so one exposure cannot show detail finer than a
pixel. But every visit lands the sky at a slightly different place on the detector (the pointing differs by
fractions of a pixel), so hundreds of exposures of one spot sample the sky at many sub-pixel offsets.
Dropping each exposure's pixel centres onto a grid 2x (or 3x) finer and averaging what lands in each fine
pixel recovers detail no single exposure has (the "drizzle" method used for Hubble's deep fields, here with
a point kernel). Fine pixels that no exposure centre reached are filled from a smoother bilinear splat.

The same exposures are also stacked the ordinary way, on SPHEREx's own 6.15″ grid, so the page can show the
two side by side."""
from __future__ import annotations

import math
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from astropy.wcs import WCS

from . import config, stack


def out_wcs(ra, dec, n, scale_arcsec):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    s = scale_arcsec / 3600
    w.wcs.cdelt = [-s, s]
    return w


def _samples(exp, ra, dec, half, wfine: WCS, wnat: WCS):
    """Pixel centres of one exposure around (ra, dec): positions on the fine and native grids, values, weight."""
    cut = stack._cutout_cached(exp, ra, dec, half)
    if cut is None:
        return None
    win = WCS(cut.header)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        cx, cy = win.all_world2pix([[ra, dec]], 0, quiet=True)[0]
    ny, nx = cut.image.shape
    xa, xb = max(0, int(round(cx)) - half - cut.x0), min(nx, int(round(cx)) + half + 1 - cut.x0)
    ya, yb = max(0, int(round(cy)) - half - cut.y0), min(ny, int(round(cy)) + half + 1 - cut.y0)
    if xb - xa < 8 or yb - ya < 8:
        return None
    img = cut.image[ya:yb, xa:xb].astype(np.float64)
    var = cut.variance[ya:yb, xa:xb]
    flg = cut.flags[ya:yb, xa:xb]
    good = np.isfinite(img) & np.isfinite(var) & (var > 0) & ((flg & config.BAD_MASK) == 0)
    if good.sum() < 0.3 * good.size:
        return None
    img = img - stack._background(np.where(good, img, np.nan))
    # one weight per exposure (its typical noise): per-pixel weights would down-weight bright stars unevenly
    w = 1.0 / float(np.median(var[good]))
    yy, xx = np.nonzero(good)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wra, wdec = win.all_pix2world(xx + xa + cut.x0, yy + ya + cut.y0, 0)
    fx, fy = wfine.wcs_world2pix(wra, wdec, 0)
    nx_, ny_ = wnat.wcs_world2pix(wra, wdec, 0)
    return fx, fy, nx_, ny_, img[good], w


def _point(acc, wacc, x, y, v, w, n):
    i, j = np.rint(x).astype(np.int64), np.rint(y).astype(np.int64)
    m = (i >= 0) & (j >= 0) & (i < n) & (j < n)
    k = j[m] * n + i[m]
    acc += np.bincount(k, weights=v[m] * w, minlength=n * n)
    wacc += np.bincount(k, minlength=n * n) * w


def _bilinear(acc, wacc, x, y, v, w, n):
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    dx, dy = x - x0, y - y0
    for ox, oy, f in ((0, 0, (1 - dx) * (1 - dy)), (1, 0, dx * (1 - dy)), (0, 1, (1 - dx) * dy), (1, 1, dx * dy)):
        i, j = x0 + ox, y0 + oy
        m = (i >= 0) & (j >= 0) & (i < n) & (j < n)
        k = j[m] * n + i[m]
        acc += np.bincount(k, weights=v[m] * f[m] * w, minlength=n * n)
        wacc += np.bincount(k, weights=f[m] * w, minlength=n * n)


def drizzle(exps, ra, dec, fov_arcsec, factor=2, progress=None):
    nat = config.PIXEL_SCALE
    n_nat = int(round(fov_arcsec / nat)) | 1
    n = int(round(fov_arcsec / (nat / factor))) | 1
    wfine, wnat = out_wcs(ra, dec, n, nat / factor), out_wcs(ra, dec, n_nat, nat)
    half = int(math.ceil(n_nat / 2 * math.sqrt(2))) + 3
    pt, ptw = np.zeros(n * n), np.zeros(n * n)
    bl, blw = np.zeros(n * n), np.zeros(n * n)
    na, naw = np.zeros(n_nat * n_nat), np.zeros(n_nat * n_nat)
    used = 0
    with ThreadPoolExecutor(config.MAX_WORKERS) as pool:
        futs = [pool.submit(_samples, e, ra, dec, half, wfine, wnat) for e in exps]
        for k, fu in enumerate(as_completed(futs), 1):
            try:
                s = fu.result()
            except Exception as ex:  # noqa: BLE001  (one bad file must not sink the image)
                print("sharp: skip", repr(ex)[:160])
                s = None
            if s is not None:
                fx, fy, nx_, ny_, v, w = s
                _point(pt, ptw, fx, fy, v, w, n)
                _bilinear(bl, blw, fx, fy, v, w, n)
                _bilinear(na, naw, nx_, ny_, v, w, n_nat)
                used += 1
            if progress:
                progress(k, len(futs))
    if not used:
        return None
    with np.errstate(invalid="ignore", divide="ignore"):
        smooth = np.where(blw > 0, bl / blw, np.nan)
        # a fine pixel needs a few exposure centres of its own to be trusted; else take the smooth value
        hits = ptw / (np.median(ptw[ptw > 0]) if (ptw > 0).any() else 1)
        sharp = np.where(hits >= 0.25, pt / np.where(ptw > 0, ptw, 1), smooth)
        native = np.where(naw > 0, na / naw, np.nan)
    return {"n": n, "scale": nat / factor, "factor": factor, "ra": ra, "dec": dec, "count": used,
            "filled": round(float((hits >= 0.25).mean()), 3),
            "image": stack.b64(sharp.reshape(n, n).astype(np.float32)),
            "n_native": n_nat, "native_scale": nat, "native": stack.b64(native.reshape(n_nat, n_nat).astype(np.float32))}
