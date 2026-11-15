"""Brightness of one spot: through time (light curve) and across wavelength (spectrum).

SPHEREx has no filter wheel, so every exposure sees the spot at a different wavelength. A spectrum
is therefore just every exposure's flux at its own wavelength. A light curve needs more care:
brightness only compares at the same wavelength, so each measurement is divided by the spot's
typical brightness at that wavelength (a running median over all exposures sorted by wavelength).

Two estimators:
- box:  the background-subtracted sum over 5 x 5 detector pixels, in mJy.
- halo: for stars whose core saturates (all the bright challenge targets do): the light in a ring
        just outside the saturated area, minus the far edge of the cutout, in MJy/sr.
Pure functions on cutouts (see field.CutoutCache); no I/O.
"""
from __future__ import annotations

import math

import numpy as np

from . import stacking
from .fitsread import wavelength_at

BOX = 2                # 5 x 5 box: +-2 pixels
SKY_IN, SKY_OUT = 4, 7  # sky annulus: the 15 x 15 box without its central 9 x 9
EDGE = 5               # halo method: the background is the outermost EDGE pixels of the cutout
HALO_GAP, HALO_WIDTH = 1.5, 3.0
CLEAN_FRACTION = 0.6   # use the box estimator when at least this share of exposures is unsaturated
SNR_FOR_RATIO = 8.0


def pixel_area_sr(pmap: dict) -> float:
    """Solid angle of a detector pixel, from the linear part of the cutout's sky -> pixel map."""
    a, b = pmap["cx"][1] / 100.0, pmap["cx"][2] / 100.0          # pixels per arcsec
    c, d = pmap["cy"][1] / 100.0, pmap["cy"][2] / 100.0
    arcsec2 = 1.0 / abs(a * d - b * c)
    return arcsec2 * (math.pi / 180.0 / 3600.0) ** 2


def measure(c: dict, ra: float, dec: float) -> dict | None:
    """Forced photometry of one cutout at a sky position. None if the spot is too close to the
    cutout's edge. Fluxes carry no aperture correction: ratios are right, absolute values run low."""
    x, y = (float(v[0]) for v in stacking.apply_pixel_map(c["pmap"], ra, dec))
    x, y = x - c["x0"], y - c["y0"]
    img = c["img"]
    h, w = img.shape
    ix, iy = int(round(x)), int(round(y))
    if not (SKY_OUT <= ix < w - SKY_OUT and SKY_OUT <= iy < h - SKY_OUT):
        return None
    wave, width = wavelength_at(c["wave"], x + c["x0"], y + c["y0"])
    bad, sat = stacking.masks(c)
    rows = c.get("flag_rows")
    known = c.get("flags") is not None and rows is not None and rows[0] <= iy - BOX and iy + BOX < rows[1]
    big = (slice(iy - SKY_OUT, iy + SKY_OUT + 1), slice(ix - SKY_OUT, ix + SKY_OUT + 1))
    ring = np.where(bad[big] | sat[big], np.nan, img[big]).astype("f8")
    ring[SKY_OUT - SKY_IN:SKY_OUT + SKY_IN + 1, SKY_OUT - SKY_IN:SKY_OUT + SKY_IN + 1] = np.nan
    sky, noise = stacking.robust_stats(ring)
    out = dict(obs_id=c["obs_id"], det=c["det"], mjd=c["mjd"], wave_um=wave, width_um=width, x=x, y=y,
               flags_known=bool(known), flux_mJy=math.nan, err_mJy=math.nan, n_sat=0, saturated=False)
    if not np.isfinite(sky):
        return out
    to_mjy = pixel_area_sr(c["pmap"]) * 1e9
    box = (slice(iy - BOX, iy + BOX + 1), slice(ix - BOX, ix + BOX + 1))
    core = (slice(iy - 1, iy + 2), slice(ix - 1, ix + 2))
    side = 2 * BOX + 1
    out["n_sat"] = int(sat[box].sum())
    out["saturated"] = bool(sat[core].any())
    if np.isfinite(img[core]).all():
        out["flux_mJy"] = float(np.nansum(img[box] - sky) * to_mjy)
    err_sky = noise * side * to_mjy
    err_pipe = math.sqrt(max(float(np.nansum(c["var"][box])), 0.0)) * to_mjy if c.get("var") is not None else 0.0
    out["err_mJy"] = float(max(err_sky, err_pipe))
    out.update(sky_MJysr=sky, noise_MJysr=noise, n_bad=int(bad[box].sum()))
    if known:                                             # which quality flags touch the 5 x 5 box
        seen = int(np.bitwise_or.reduce(c["flags"][box].ravel()))
        out["flag_names"] = sorted(n for n, bit in (c.get("flag_names") or {}).items() if seen >> int(bit) & 1)
    return out


def _saturated_radius(c: dict, x: float, y: float) -> float:
    """Radius (pixels) of the saturated blob that touches the star; 0 if the core is fine. Stray
    flagged pixels elsewhere (cosmic rays, other stars) do not count."""
    from scipy.ndimage import label
    _, sat = stacking.masks(c)
    blobs, _ = label(sat, structure=np.ones((3, 3)))
    ix, iy = int(round(x)), int(round(y))
    mine = set(np.unique(blobs[max(0, iy - 1):iy + 2, max(0, ix - 1):ix + 2]).tolist()) - {0}
    if not mine:
        return 0.0
    yy, xx = np.nonzero(np.isin(blobs, list(mine)))
    return float(np.hypot(xx - x, yy - y).max())


def _ring_median(c: dict, x: float, y: float, r1: float, r2: float, need: float) -> float:
    img = c["img"]
    bad, sat = stacking.masks(c)
    yy, xx = np.indices(img.shape)
    r = np.hypot(xx - x, yy - y)
    zone = (r >= r1) & (r < r2)
    good = zone & ~bad & ~sat & np.isfinite(img)
    if zone.sum() == 0 or good.sum() < need * zone.sum():
        return math.nan
    return float(np.median(img[good]))


def series(cuts: list[dict], position_at) -> tuple[list[dict], dict]:
    """Measure every cutout at position_at(mjd) -> (ra, dec) and choose the estimator.
    Each row gets 'value' in the estimator's units (NaN where unusable)."""
    rows, kept = [], []
    for c in cuts:
        m = measure(c, *position_at(c["mjd"]))
        if m is not None:
            rows.append(m)
            kept.append(c)
    info = dict(estimator=None, units=None, n=len(rows), message=None, flags_known=bool(rows) and all(r["flags_known"] for r in rows))
    if not rows:
        info["message"] = "This spot is too close to the edge of the pictures to be measured."
        return rows, info
    clean = [np.isfinite(r["flux_mJy"]) and r["n_sat"] == 0 for r in rows]
    if sum(clean) >= CLEAN_FRACTION * len(rows):
        info.update(estimator="box", units="mJy")
        for r, ok in zip(rows, clean):
            r["value"] = r["flux_mJy"] if ok else math.nan
        return rows, info
    # saturated star: ring just outside the saturated area, minus the cutout's far edge
    info.update(estimator="halo", units="MJy/sr")
    half = int(np.median([min(c["img"].shape) for c in kept])) // 2
    radii = np.array([_saturated_radius(c, r["x"], r["y"]) for c, r in zip(kept, rows)])
    r1 = (float(np.percentile(radii, 95)) if radii.max() > 0 else 1.0) + HALO_GAP
    r2 = min(r1 + HALO_WIDTH, half - EDGE - 1.0)
    if r2 - r1 < 1.0:
        info["message"] = "This star is saturated across most of the field. Try a larger field of view."
        for r in rows:
            r["value"] = math.nan
        return rows, info
    info.update(halo_px=[round(r1, 1), round(r2, 1)])
    for c, r in zip(kept, rows):
        r["value"] = _ring_median(c, r["x"], r["y"], r1, r2, 0.6) - _ring_median(c, r["x"], r["y"], half - EDGE, half, 0.4)
    return rows, info


def normalise(rows: list[dict], pass_of=None, with_errors: bool = True) -> tuple[str | None, float | None]:
    """Divide each usable value by the spot's typical value at that wavelength, so that what is
    left is the change with time. Adds 'typical', 'ratio', 'delta' to the rows.

    The typical value at a wavelength is taken from the exposures nearest in wavelength (all dates
    mixed): the median of each sky pass among them, averaged over the passes. Averaging per pass
    matters: a plain median would follow whichever pass has more exposures at that wavelength, and
    a star that doubled between two passes would come out flat.
    Returns (mode, snr): 'ratio' for a clearly detected spot, 'delta' for a faint or blank one."""
    good = sorted((r for r in rows if np.isfinite(r.get("value", math.nan))), key=lambda r: r["wave_um"])
    if len(good) < 6:
        return None, None
    v = np.array([r["value"] for r in good])
    which = np.array([pass_of(r["mjd"]) if pass_of else 0 for r in good])
    n = len(v)
    reach = max(3, n // 10)
    typical = np.empty(n)
    for i in range(n):
        lo, hi = max(0, i - reach), min(n, i + reach + 1)
        typical[i] = np.mean([np.median(v[lo:hi][which[lo:hi] == p]) for p in np.unique(which[lo:hi])])
    # the halo estimator has no per-exposure error (and other units): it always counts as detected
    err = np.array([r["err_mJy"] if with_errors and np.isfinite(r["err_mJy"]) else math.nan for r in good])
    snr = float(np.median(np.abs(typical)) / np.nanmedian(err)) if np.isfinite(err).any() and np.nanmedian(err) > 0 else math.inf
    mode = "ratio" if (typical > 0).all() and snr >= SNR_FOR_RATIO else "delta"
    for r, ty in zip(good, typical):
        r.update(typical=float(ty), ratio=float(r["value"] / ty) if ty > 0 else math.nan, delta=float(r["value"] - ty))
    return mode, snr


def light_curve(rows: list[dict], info: dict, pass_of) -> dict:
    """The series as the API returns it. pass_of(mjd) -> pass index."""
    box = info.get("estimator") == "box"
    mode, snr = normalise(rows, pass_of, with_errors=box)
    points = []
    for r in sorted(rows, key=lambda r: r["mjd"]):
        if "typical" not in r:
            continue
        err = None
        if box and np.isfinite(r["err_mJy"]):
            err = r["err_mJy"] / r["typical"] if mode == "ratio" and r["typical"] > 0 else r["err_mJy"]
        points.append(dict(mjd=round(r["mjd"], 5), wave_um=round(r["wave_um"], 4), value=r["value"], typical=r["typical"],
                           ratio=r["ratio"], delta=r["delta"], err=err, saturated=r["saturated"], **{"pass": pass_of(r["mjd"])}))
    scatter = None
    if points and mode:
        _, scatter = stacking.robust_stats([p[mode] for p in points])
    by_pass: dict[int, list[float]] = {}
    for p in points:
        if mode and np.isfinite(p[mode]):
            by_pass.setdefault(p["pass"], []).append(p[mode])
    summary = [dict(**{"pass": k}, median=float(np.median(v)), n=len(v)) for k, v in sorted(by_pass.items())]
    flags: dict[str, int] = {}
    for r in rows:
        for name in r.get("flag_names", []):
            flags[name] = flags.get(name, 0) + 1
    info = dict(info, flags=dict(sorted(flags.items(), key=lambda kv: -kv[1])), n_measured=len(rows))
    if not points and not info.get("message"):
        info = dict(info, message="Not enough usable measurements here for a light curve.")
    return dict(info, mode=mode, snr=snr if snr is None or math.isfinite(snr) else None, scatter=scatter,
                points=points, passes=summary)
