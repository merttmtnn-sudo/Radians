"""From cutouts to pass images: masks, background, resampling onto one north-up grid, sky passes,
wavelength matching and median stacks. Pure functions on numpy arrays, no I/O.

Why the wavelength matching matters: SPHEREx has no filter wheel, so every exposure sees a spot at
a different wavelength. Two passes that happened to sample different parts of a band differ in
colour, and a plain comparison makes static stars look as if they changed (by 6-11 sigma on real
data). See docs/BUILD_NOTES.md §4.
"""
from __future__ import annotations

import math
import warnings

import numpy as np
from astropy.wcs import WCS, FITSFixedWarning

for _quiet in ("All-NaN slice encountered", "Mean of empty slice"):
    warnings.filterwarnings("ignore", message=_quiet)
warnings.simplefilter("ignore", FITSFixedWarning)

# Flags that make a pixel unusable in a stack. PERSIST is not here: it also marks real star cores.
BAD_FLAGS = ("TRANSIENT", "NONFUNC", "MISSING_DATA", "HOT", "COLD", "SNOWBALL")
# Flags that mean the pixel is saturated (every blank pixel carries SUR_ERROR and OVERFLOW).
SATURATED_FLAGS = ("OVERFLOW", "SUR_ERROR", "NONLINEAR")

BANDS_UM = {1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41), 4: (2.42, 3.82), 5: (3.83, 4.41), 6: (4.42, 5.00)}
PASS_GAP_DAYS = 20.0            # the same rule as the all-detector view (config.EPOCH_GAP_DAYS)
PASS_JOIN_DAYS = 45.0           # a part with too few exposures joins a neighbour that is this close
PASS_MIN_FRAMES = 6             # ... too few: a median of fewer frames is noisy
PASS_MAX_SPAN_DAYS = 75.0
MATCH_TOL_FRACTION = 0.06       # frames pair up within ~one spectral resolution element (6% of a band)


def flag_bits(names_to_bit: dict, wanted) -> int:
    m = 0
    for n in wanted:
        if n in names_to_bit:
            m |= 1 << int(names_to_bit[n])
    return m


def masks(c: dict) -> tuple[np.ndarray, np.ndarray]:
    """(bad, saturated) boolean maps of a cutout. A preview cutout has no flags: then only blank
    pixels count as saturated."""
    img = c["img"]
    sat = ~np.isfinite(img)
    flags = c.get("flags")
    if flags is None:
        return np.zeros(img.shape, bool), sat
    names = c.get("flag_names") or {}
    sat |= (flags & flag_bits(names, SATURATED_FLAGS)) != 0
    bad = (flags & flag_bits(names, BAD_FLAGS)) != 0
    return bad, sat


def robust_stats(values) -> tuple[float, float]:
    """(median, sigma) after clipping 3-sigma outliers a few times; sigma = 1.4826 x the median
    absolute deviation, which equals the standard deviation for Gaussian noise."""
    data = np.asarray(values, float).ravel()
    data = data[np.isfinite(data)]
    if not data.size:
        return math.nan, math.nan
    centre = float(np.median(data))
    spread = 1.4826 * float(np.median(np.abs(data - centre)))
    rounds = 0
    while rounds < 3 and spread > 0:
        rounds += 1
        kept = data[np.abs(data - centre) < 3 * spread]
        if kept.size < 10:
            break
        centre = float(np.median(kept))
        spread = 1.4826 * float(np.median(np.abs(kept - centre)))
    return centre, spread


def grid_wcs(ra: float, dec: float, n: int, scale_arcsec: float) -> WCS:
    """North-up, east-left TAN grid of n x n pixels of scale_arcsec, centred on (ra, dec).
    Row 0 is the south edge (FITS convention)."""
    mid = (n + 1) / 2
    return WCS({"CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN", "CUNIT1": "deg", "CUNIT2": "deg",
                "CRVAL1": ra, "CRVAL2": dec, "CRPIX1": mid, "CRPIX2": mid,
                "CDELT1": -scale_arcsec / 3600.0, "CDELT2": scale_arcsec / 3600.0, "NAXIS1": n, "NAXIS2": n})


def grid_sky(w: WCS, n: int) -> tuple[np.ndarray, np.ndarray]:
    """(ra, dec) of every grid pixel, row-major."""
    cols = np.tile(np.arange(n), n)
    rows = np.repeat(np.arange(n), n)
    return w.all_pix2world(cols, rows, 0)


def detector_coords(det_wcs: WCS, grid: WCS, n: int, step: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """Full-detector pixel position of every grid pixel (flattened, row-major).

    The SIP world->pixel inversion is the slow part of resampling, so it runs on a coarse grid
    (every `step` pixels, 16" at 2"/px) and is interpolated in between. Over a few arcminutes the
    mapping is smooth: the interpolation error is far below 0.01 detector pixel.
    """
    from scipy.ndimage import map_coordinates
    ticks = np.unique(np.r_[np.arange(0, n, step), n - 1])
    gy, gx = np.meshgrid(ticks, ticks, indexing="ij")
    ra, dec = grid.all_pix2world(gx.ravel(), gy.ravel(), 0)
    cx, cy = det_wcs.all_world2pix(ra, dec, 0, quiet=True)
    cx, cy = cx.reshape(gx.shape), cy.reshape(gx.shape)
    # fractional index of every fine pixel inside the coarse tick list
    frac = np.interp(np.arange(n), ticks, np.arange(len(ticks)))
    fy, fx = np.meshgrid(frac, frac, indexing="ij")
    at = np.vstack([fy.ravel(), fx.ravel()])
    return (map_coordinates(cx, at, order=1, mode="nearest"),
            map_coordinates(cy, at, order=1, mode="nearest"))


def _poly_terms(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    u, v = u / 100.0, v / 100.0                      # keeps the cubic terms well conditioned
    return np.stack([np.ones_like(u), u, v, u * u, u * v, v * v, u ** 3, u * u * v, u * v * v, v ** 3], axis=-1)


def _tangent(ra, dec, ra_c: float, dec_c: float):
    """Small offsets (arcsec) of (ra, dec) from a centre, east and north."""
    dra = (np.asarray(ra, float) - ra_c + 180.0) % 360.0 - 180.0
    return dra * math.cos(math.radians(dec_c)) * 3600.0, (np.asarray(dec, float) - dec_c) * 3600.0


def fit_pixel_map(det_wcs: WCS, x0: int, y0: int, x1: int, y1: int) -> dict:
    """A cubic polynomial (sky offset -> full-detector pixel) valid over one cutout box.

    Building an astropy WCS with SIP distortion costs ~25 ms, more than everything else we do with
    a cached cutout, so the mapping is fitted once when the cutout is fetched and stored with it.
    Over a cutout of ~1-2 arcmin the fit is good to ~1e-4 pixel (max_err_px says)."""
    xs = np.linspace(x0 - 2, x1 + 1, 9)
    ys = np.linspace(y0 - 2, y1 + 1, 9)
    gx, gy = np.meshgrid(xs, ys)
    ra, dec = det_wcs.all_pix2world(gx.ravel(), gy.ravel(), 0)
    ra_c, dec_c = float(np.median(ra)), float(np.median(dec))
    u, v = _tangent(ra, dec, ra_c, dec_c)
    A = _poly_terms(u, v)
    cx = np.linalg.lstsq(A, gx.ravel(), rcond=None)[0]
    cy = np.linalg.lstsq(A, gy.ravel(), rcond=None)[0]
    err = float(max(np.abs(A @ cx - gx.ravel()).max(), np.abs(A @ cy - gy.ravel()).max()))
    return dict(center=np.array([ra_c, dec_c]), cx=cx, cy=cy, max_err_px=err)


def apply_pixel_map(pmap: dict, ra, dec) -> tuple[np.ndarray, np.ndarray]:
    u, v = _tangent(ra, dec, float(pmap["center"][0]), float(pmap["center"][1]))
    A = _poly_terms(np.atleast_1d(u), np.atleast_1d(v))
    return A @ np.asarray(pmap["cx"]), A @ np.asarray(pmap["cy"])


def resample(c: dict, det_wcs, sky, n: int):
    """Background-subtract one cutout and interpolate it onto the grid.

    det_wcs is the full-detector WCS (with SIP distortion); the cutout's origin is (x0, y0).
    `sky` is either (ra, dec) of every grid pixel or ('grid', grid_wcs) to use the fast coarse
    mapping. det_wcs may also be a pixel map from fit_pixel_map() (then sky must be (ra, dec)).
    Returns (frame, saturated): frame is NaN where no usable data fell; saturated marks grid
    pixels that landed on saturated detector pixels.
    """
    from scipy.ndimage import distance_transform_edt, map_coordinates
    img = c["img"].astype("f8")
    bad, sat = masks(c)
    use = np.logical_not(bad | sat)
    blank = np.full((n, n), np.nan, "f4"), np.zeros((n, n), bool)
    if use.sum() < 20:
        return blank
    src = None
    if c.get("flags") is not None:
        src = (c["flags"] & flag_bits(c.get("flag_names") or {}, ("SOURCE",))) != 0
    sky_px = img[use & ~src] if src is not None and (use & ~src).sum() > 50 else img[use]
    level, _ = robust_stats(sky_px)
    if not np.isfinite(level):
        return blank
    if isinstance(det_wcs, dict):
        xf, yf = apply_pixel_map(det_wcs, sky[0], sky[1])
    elif isinstance(sky[0], str):
        xf, yf = detector_coords(det_wcs, sky[1], n)
    else:
        xf, yf = det_wcs.all_world2pix(sky[0], sky[1], 0, quiet=True)
    x, y = xf - c["x0"], yf - c["y0"]
    h, w = img.shape
    inside = np.isfinite(x) & np.isfinite(y) & (x > -0.5) & (x < w - 0.5) & (y > -0.5) & (y < h - 0.5)
    filled = img - level
    holes = np.logical_not(use)
    if holes.any():
        # cubic interpolation rings next to holes: give each hole the value of its nearest good pixel
        nearest = distance_transform_edt(holes, return_distances=False, return_indices=True)
        filled = filled[tuple(nearest)]
    coords = np.vstack([np.nan_to_num(y), np.nan_to_num(x)])
    out = map_coordinates(filled, coords, order=3, mode="nearest")
    unusable = map_coordinates((~use).astype("f8"), coords, order=1, mode="nearest")
    satf = map_coordinates(sat.astype("f8"), coords, order=1, mode="nearest")
    out[np.logical_or(~inside, unusable > 0.2)] = np.nan
    return out.reshape(n, n).astype("f4"), (inside & (satf > 0.2)).reshape(n, n)


def join_small(runs: list, t, min_frames: int, join_gap: float) -> list:
    """Runs (index arrays in time order) with fewer than min_frames members are joined to the nearer
    neighbour, if that one is at most join_gap days away. SPHEREx sometimes comes back a few weeks
    after a visit for a handful of exposures: on their own they make a noisy picture."""
    runs = [np.asarray(r) for r in runs]
    alone: set[int] = set()                         # first index of small runs with no neighbour close enough
    while len(runs) > 1:
        small = [k for k, r in enumerate(runs) if len(r) < min_frames and int(r[0]) not in alone]
        if not small:
            break
        k = min(small, key=lambda j: len(runs[j]))
        before = t[runs[k][0]] - t[runs[k - 1][-1]] if k > 0 else np.inf
        after = t[runs[k + 1][0]] - t[runs[k][-1]] if k < len(runs) - 1 else np.inf
        if min(before, after) > join_gap:
            alone.add(int(runs[k][0]))
            continue
        j = k - 1 if before <= after else k
        runs[j:j + 2] = [np.concatenate(runs[j:j + 2])]
    return runs


def group_passes(mjds, gap: float = PASS_GAP_DAYS, max_span: float = PASS_MAX_SPAN_DAYS,
                 min_frames: int = PASS_MIN_FRAMES, join_gap: float = PASS_JOIN_DAYS) -> list[list[int]]:
    """Indices of each sky pass, in time order. A gap > `gap` days starts a new pass; a part with
    fewer than min_frames exposures joins a neighbour within join_gap days (see join_small); a pass
    longer than max_span days (deep fields are observed almost continuously) is cut into equal bins."""
    t = np.asarray(mjds, float)
    if not t.size:
        return []
    order = np.argsort(t, kind="stable")
    cuts = np.flatnonzero(np.diff(t[order]) > gap) + 1
    passes: list[list[int]] = []
    for run in join_small(np.split(order, cuts), t, min_frames, join_gap):
        first, last = t[run[0]], t[run[-1]]
        nbins = max(1, math.ceil((last - first) / max_span)) if max_span and max_span > 0 else 1
        width = (last - first) / nbins if nbins > 1 else 0.0
        if nbins == 1:
            passes.append([int(i) for i in run])
            continue
        slot = np.minimum(((t[run] - first) / width).astype(int), nbins - 1)
        passes += [[int(i) for i in run[slot == b]] for b in range(nbins) if np.any(slot == b)]
    return passes


def shared_range(groups: dict[int, np.ndarray], waves, band: int, min_frames: int = 3):
    """Frames of each pass inside the wavelength range all passes share (for a fair blink).

    If that leaves a pass with fewer than min_frames, the range is widened in steps of 5% of the
    band, up to 25% each side. Returns ({pass: indices}, info). info['matched'] is False when no
    shared range works; then all frames are used and info['warning'] says the passes saw different
    colours.
    """
    lam = np.asarray(waves, float)
    members = {p: np.asarray(ix, int) for p, ix in groups.items()}
    if len(members) < 2 or min(len(ix) for ix in members.values()) == 0:
        return members, dict(matched=len(members) == 1, range_um=None, widened_um=0.0, warning=None)
    lows = [float(np.nanmin(lam[ix])) for ix in members.values()]
    highs = [float(np.nanmax(lam[ix])) for ix in members.values()]
    common_lo, common_hi = max(lows), min(highs)
    if common_lo > common_hi:                       # no overlap: start from the middle of the gap
        common_lo = common_hi = 0.5 * (common_lo + common_hi)
    band_lo, band_hi = BANDS_UM.get(band, (min(lows), max(highs)))
    widen_step = 0.05 * (band_hi - band_lo)
    for steps in range(6):
        lo, hi = common_lo - steps * widen_step, common_hi + steps * widen_step
        picked = {p: ix[(lam[ix] >= lo) & (lam[ix] <= hi)] for p, ix in members.items()}
        if min(len(ix) for ix in picked.values()) >= min_frames:
            return picked, dict(matched=True, range_um=[round(lo, 4), round(hi, 4)],
                                widened_um=round(steps * widen_step, 4), warning=None)
    spans = ", ".join(f"pass {p + 1}: {a:.2f}-{b:.2f} µm" for p, a, b in zip(members, lows, highs))
    return members, dict(matched=False, range_um=None, widened_um=0.0,
                         warning="These passes saw different parts of the band (" + spans + "), so some "
                                 "brightness differences may be colour rather than real change.")


def pair_by_wavelength(ia, ib, waves, tol: float, min_pairs: int = 2):
    """Frames of passes a and b chosen so both stacks see the same mix of wavelengths.

    Every frame of the pass with fewer frames claims its `per` closest-in-wavelength partners from
    the other pass (within tol; a partner is claimed once). `per` starts as large as the frame
    counts allow and drops until at least 3/4 of the smaller pass finds partners.
    Returns (frames of a, frames of b) or None if fewer than min_pairs frames pair up.
    """
    lam = np.asarray(waves, float)
    a_idx, b_idx = np.asarray(ia, int), np.asarray(ib, int)
    a_is_small = len(a_idx) <= len(b_idx)
    small, large = (a_idx, b_idx) if a_is_small else (b_idx, a_idx)
    if len(small) < min_pairs:
        return None
    need = max(min_pairs, math.ceil(0.75 * len(small)))
    best = None
    for per in range(max(1, len(large) // len(small)), 0, -1):
        taken = ~np.isfinite(lam[large])
        mine, theirs = [], []
        for s_frame in small[np.argsort(lam[small], kind="stable")]:
            gap = np.abs(lam[large] - lam[s_frame])
            gap[taken | (gap > tol)] = np.inf
            closest = np.argsort(gap, kind="stable")[:per]
            if np.isfinite(gap[closest]).all() and len(closest) == per:
                taken[closest] = True
                mine.append(s_frame)
                theirs.extend(large[closest])
        if len(mine) >= need or (per == 1 and len(mine) >= min_pairs):
            best = (np.sort(np.asarray(mine, int)), np.sort(np.asarray(theirs, int)))
            break
    if best is None:
        return None
    return best if a_is_small else (best[1], best[0])


def median_stack(frames: np.ndarray, idx) -> np.ndarray:
    idx = np.asarray(idx, int)
    if idx.size == 0:
        return np.full(frames.shape[1:], np.nan, "f4")
    return np.nanmedian(frames[idx], axis=0).astype("f4")


def display_levels(stack: np.ndarray) -> dict:
    """Shared display levels for every pass of a view (so the blink is fair): faint = -3..25 sigma
    of the sky noise, bright = -3 sigma .. the 99.9th percentile of the central half."""
    _, sig = robust_stats(stack)
    sig = sig if np.isfinite(sig) and sig > 0 else 1e-3
    n = stack.shape[0]
    core = stack[n // 4:3 * n // 4, n // 4:3 * n // 4]
    top = float(np.nanpercentile(core, 99.9)) if np.isfinite(core).any() else 25 * sig
    return dict(sigma=sig, faint=[-3 * sig, 25 * sig], bright=[-3 * sig, max(top, 25 * sig)],
                default="bright" if top > 300 * sig else "faint")
