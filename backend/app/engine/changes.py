"""What changed between two sky passes: things that moved, appeared, vanished, brightened or faded.

Input: the two pass stacks and their wavelength-matched difference (later minus earlier), all on
the view's north-up grid (row 0 = south, x grows to the west). How it decides:

1. The difference is smoothed with the PSF (a matched filter) and divided by its own noise, so a
   point-like change stands out and single noisy pixels do not.
2. Peaks above the threshold are collected: positive = brighter later, negative = brighter earlier.
3. Saturated stars (blank cores) are judged as one object each: moved if the core shifted and a
   bright lobe leads a dark one in the same direction; otherwise brightened or faded by the light
   in a ring around the core.
4. A negative peak with a positive peak nearby is a mover, IF the pair is about as strong as the
   source itself. A star that is merely misaligned by a fraction of a pixel leaves a pair worth a
   few percent of its brightness and is dropped. Two Gaussians fitted to the difference give the
   two positions and their error.
5. A peak with no partner is something that appeared or vanished (about as strong as the source
   there) or brightened or faded (weaker).
6. Residuals in the wings of much brighter stars are ignored; passes with few pictures list only
   what is robust; movers faster than any known star are kept but marked.
The numbers were chosen from the measurements in docs/BUILD_NOTES.md §7.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.ndimage import binary_dilation, binary_erosion, gaussian_filter, label, maximum_filter
from scipy.optimize import least_squares

from . import stacking

PSF_FWHM_ARCSEC = 9.0          # of the resampled stacks (measured 8.5-9.5" across the bands)
NATIVE_PIXEL_ARCSEC = 6.15
ALIGN_ERROR_ARCSEC = 0.35      # pass-to-pass alignment scatter of field stars
CORE_ERROR_ARCSEC = 1.0        # how well a blank core's centre is known
Z_PAIR = 5.0                   # each half of a mover
Z_LONE = 7.0                   # a change with no partner needs stronger evidence
PAIR_REACH_ARCSEC = 20.0
EDGE_PIXELS = 6
MOVER_CONTRAST = 0.35
NEW_CONTRAST = 0.65
CHANGE_MIN = 0.2
OWN_SOURCE_FWHM = 1.5
WING_FWHM = 3.0
WING_FRACTION = 0.03
SHIFT_SIGNIFICANCE = 3.0
SATURATED_MIN_SHIFT_ARCSEC = 3.0
LOBE_BALANCE = 0.2
MIN_FRAMES_MOVER = 4
MIN_FRAMES_LONE = 5
FASTEST_STAR_ARCSEC_YR = 15.0  # 1.5 x Barnard's Star; faster "movers" are most likely artefacts
COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]


def compass(deg: float) -> str:
    return COMPASS[int(((deg % 360) + 22.5) // 45) % 8]


def _smooth(img: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian smoothing that ignores blank pixels (normalised convolution)."""
    ok = np.isfinite(img)
    top = gaussian_filter(np.where(ok, img, 0.0), sigma, mode="nearest")
    weight = gaussian_filter(ok.astype("f8"), sigma, mode="nearest")
    return np.where(weight > 0.6, top / np.maximum(weight, 1e-6), np.nan)


def _brightest_near(img: np.ndarray, x: float, y: float, radius: float) -> float:
    y0, y1 = max(0, int(y - radius)), min(img.shape[0], int(y + radius) + 2)
    x0, x1 = max(0, int(x - radius)), min(img.shape[1], int(x + radius) + 2)
    if y0 >= y1 or x0 >= x1:
        return math.nan
    yy, xx = np.mgrid[y0:y1, x0:x1]
    inside = img[y0:y1, x0:x1][(xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2]
    inside = inside[np.isfinite(inside)]
    return float(inside.max()) if inside.size else math.nan


def _centroid(z: np.ndarray, x: int, y: int, sign: int) -> tuple[float, float]:
    ys, xs = slice(max(0, y - 1), y + 2), slice(max(0, x - 1), x + 2)
    w = np.clip(np.nan_to_num(sign * z[ys, xs]), 0, None)
    if w.sum() <= 0:
        return float(x), float(y)
    yy, xx = np.mgrid[ys, xs]
    return float((xx * w).sum() / w.sum()), float((yy * w).sum() / w.sum())


def _fit_two(diff: np.ndarray, old: tuple, new: tuple, sigma: float):
    """Fit new_amp * G(new) - old_amp * G(old) + offset to the difference around a pair. The two
    amplitudes are free: the passes can see the source at slightly different wavelengths.
    Returns (old xy, new xy, blank fraction, separation error in pixels) or None."""
    pad = 3 * sigma
    x0, x1 = int(max(0, min(old[0], new[0]) - pad)), int(min(diff.shape[1], max(old[0], new[0]) + pad + 1))
    y0, y1 = int(max(0, min(old[1], new[1]) - pad)), int(min(diff.shape[0], max(old[1], new[1]) + pad + 1))
    patch = diff[y0:y1, x0:x1]
    ok = np.isfinite(patch)
    if ok.sum() < 20:
        return None
    yy, xx = np.mgrid[y0:y1, x0:x1]

    def blob(cx, cy):
        return np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))

    def miss(p):
        return (p[5] * blob(p[2], p[3]) - p[4] * blob(p[0], p[1]) + p[6] - patch)[ok]

    reach = 2.5 * sigma
    start = [old[0], old[1], new[0], new[1], max(-float(np.nanmin(patch)), 1e-9), max(float(np.nanmax(patch)), 1e-9), 0.0]
    low = [old[0] - reach, old[1] - reach, new[0] - reach, new[1] - reach, 0.0, 0.0, -np.inf]
    high = [old[0] + reach, old[1] + reach, new[0] + reach, new[1] + reach, np.inf, np.inf, np.inf]
    try:
        fit = least_squares(miss, start, bounds=(low, high))
        dof = max(1, fit.fun.size - fit.x.size)
        cov = np.linalg.pinv(fit.jac.T @ fit.jac) * float(np.sum(fit.fun ** 2)) / dof
        err = math.sqrt(max(0.0, cov[0, 0] + cov[1, 1] + cov[2, 2] + cov[3, 3]) / 2)
    except (ValueError, np.linalg.LinAlgError):
        return None
    return (float(fit.x[0]), float(fit.x[1])), (float(fit.x[2]), float(fit.x[3])), float(1 - ok.mean()), err


def _blank_stars(a: np.ndarray, b: np.ndarray, fwhm: float) -> list[dict]:
    """Saturated stars: connected blank regions, with the blank core's centre in each pass."""
    blank_a, blank_b = ~np.isfinite(a), ~np.isfinite(b)
    regions, count = label(blank_a | blank_b, structure=np.ones((3, 3)))
    out = []
    for k in range(1, count + 1):
        region = regions == k
        area = int(region.sum())
        if area < 3:
            continue
        around = binary_dilation(region, iterations=3)
        centres, areas = [], []
        for blank in (blank_a, blank_b):
            ys, xs = np.nonzero(blank & around)
            centres.append((float(xs.mean()), float(ys.mean())) if xs.size else None)
            areas.append(int(xs.size))
        ys, xs = np.nonzero(region)
        out.append(dict(old=centres[0], new=centres[1], area=max(areas + [1]), x=float(xs.mean()), y=float(ys.mean()),
                        reach=math.sqrt(area / math.pi) + 2.5 * fwhm))
    return out


def _halo_ratio(a: np.ndarray, b: np.ndarray, star: dict, fwhm: float, scale: float):
    """Later / earlier brightness of a saturated star from a ring 1.5 to 3.5 PSF widths outside
    its blank core (closer in, saturation still spoils the light)."""
    r1 = math.sqrt(star["area"] / math.pi) + NATIVE_PIXEL_ARCSEC / scale + 1.5 * fwhm
    yy, xx = np.mgrid[:a.shape[0], :a.shape[1]]
    r = np.hypot(xx - star["x"], yy - star["y"])
    ring = (r >= r1) & (r <= r1 + 2 * fwhm) & np.isfinite(a) & np.isfinite(b)
    if ring.sum() < 20:
        return None
    before = float(np.sum(a[ring] - np.nanmedian(a)))
    after = float(np.sum(b[ring] - np.nanmedian(b)))
    return after / before if before > 0 and after > 0 else None


def _motion(old: tuple, new: tuple, scale: float, years: float, err_arcsec: float) -> dict:
    east, north = -(new[0] - old[0]) * scale, (new[1] - old[1]) * scale
    shift = math.hypot(east, north)
    direction = math.degrees(math.atan2(east, north)) % 360
    return dict(x1=old[0], y1=old[1], x2=new[0], y2=new[1], shift_arcsec=shift, shift_err_arcsec=err_arcsec,
                east_arcsec=east, north_arcsec=north, direction_deg=direction, direction=compass(direction),
                rate_arcsec_yr=shift / years if years > 0 else None, rate_err=err_arcsec / years if years > 0 else None)


def find_changes(stack_a: np.ndarray, stack_b: np.ndarray, diff: np.ndarray, scale_arcsec: float, years: float,
                 n_frames: tuple[int, int] | None = None, limit: int = 12) -> tuple[list[dict], list[str]]:
    """Returns (items, notes). Positions are grid pixels (x to the west, y to the north).
    n_frames: pictures in each stack; with few of them only robust kinds of change are listed."""
    notes: list[str] = []
    fewest = min(n_frames) if n_frames else None
    fwhm = PSF_FWHM_ARCSEC / scale_arcsec
    sigma = fwhm / 2.355
    smooth = _smooth(diff, sigma)
    _, noise = stacking.robust_stats(smooth)
    if not (np.isfinite(noise) and noise > 0):
        return [], notes
    z = smooth / noise
    src_a, src_b = _smooth(stack_a, sigma) / noise, _smooth(stack_b, sigma) / noise
    valid = binary_erosion(np.isfinite(z) & np.isfinite(diff), iterations=2)
    valid[:EDGE_PIXELS] = valid[-EDGE_PIXELS:] = False
    valid[:, :EDGE_PIXELS] = valid[:, -EDGE_PIXELS:] = False
    zv = np.where(valid, z, 0.0)
    window = max(3, 2 * int(round(sigma)) + 1)
    peaks = []
    for sign in (1, -1):
        field = sign * zv
        for y, x in np.argwhere((field == maximum_filter(field, size=window)) & (field >= Z_PAIR)):
            px, py = _centroid(z, int(x), int(y), sign)
            peaks.append(dict(x=px, y=py, ix=int(x), iy=int(y), z=float(field[y, x]), sign=sign))
    brightest = np.fmax(src_a, src_b)

    def in_wing(p):
        level = _brightest_near(brightest, p["x"], p["y"], WING_FWHM * fwhm)
        return bool(np.isfinite(level) and p["z"] < WING_FRACTION * level)

    def contrast(p, src, own_pixel):
        level = src[p["iy"], p["ix"]] if own_pixel else _brightest_near(src, p["x"], p["y"], OWN_SOURCE_FWHM * fwhm)
        return 1.0 if not np.isfinite(level) or level <= 0 else float(min(1.5, p["z"] / level))

    items: list[dict] = []
    yy, xx = np.mgrid[:z.shape[0], :z.shape[1]]
    # -- saturated stars: all the peaks around a blank core belong to that one star
    for star in _blank_stars(stack_a, stack_b, fwhm):
        mine = [p for p in peaks if math.hypot(p["x"] - star["x"], p["y"] - star["y"]) <= star["reach"]]
        if not mine:
            continue
        peaks = [p for p in peaks if p not in mine]
        strength = max(p["z"] for p in mine)
        near = (np.hypot(xx - star["x"], yy - star["y"]) <= star["reach"]) & valid
        gain, loss = near & (z >= Z_PAIR), near & (z <= -Z_PAIR)
        up, down = float(z[gain].sum()), float(-z[loss].sum())
        if star["old"] and star["new"] and min(up, down) >= LOBE_BALANCE * max(up, down) > 0:
            sx, sy = star["new"][0] - star["old"][0], star["new"][1] - star["old"][1]
            lx = np.average(xx[gain], weights=z[gain]) - np.average(xx[loss], weights=-z[loss])
            ly = np.average(yy[gain], weights=z[gain]) - np.average(yy[loss], weights=-z[loss])
            shift, lobe = math.hypot(sx, sy), math.hypot(lx, ly)
            same_way = sx * lx + sy * ly >= math.cos(math.radians(45)) * shift * lobe
            if shift * scale_arcsec >= SATURATED_MIN_SHIFT_ARCSEC and lobe >= 0.4 * star["reach"] and same_way:
                items.append(dict(kind="mover", z=strength, contrast=1.0, saturated=True,
                                  **_motion(star["old"], star["new"], scale_arcsec, years, CORE_ERROR_ARCSEC)))
                continue
        if max(up, down) < Z_LONE:
            continue
        ratio = _halo_ratio(stack_a, stack_b, star, fwhm, scale_arcsec)
        if ratio is not None and abs(ratio - 1) >= CHANGE_MIN:
            items.append(dict(kind="brightened" if ratio > 1 else "faded", z=strength, contrast=None, saturated=True,
                              x=star["x"], y=star["y"], change=ratio - 1))
        elif ratio is None and max(up, down) > 2 * min(up, down):
            items.append(dict(kind="brightened" if up > down else "faded", z=strength, contrast=None, saturated=True,
                              x=star["x"], y=star["y"], change=None))

    gains = [p for p in peaks if p["sign"] > 0]
    losses = [p for p in peaks if p["sign"] < 0]
    used_gain, used_loss = set(), set()
    # -- movers: a loss with a gain nearby, strongest pairs first
    if fewest is not None and fewest < MIN_FRAMES_MOVER:
        notes.append("too few pictures at matching wavelengths to look for movers")
    else:
        reach = PAIR_REACH_ARCSEC / scale_arcsec
        pairs = sorted(((g["z"] + q["z"], i, j) for i, g in enumerate(gains) for j, q in enumerate(losses)
                        if math.hypot(g["x"] - q["x"], g["y"] - q["y"]) <= reach and max(g["z"], q["z"]) <= 4 * min(g["z"], q["z"])),
                       reverse=True)
        for _, i, j in pairs:
            if i in used_gain or j in used_loss:
                continue
            g, q = gains[i], losses[j]
            used_gain.add(i)
            used_loss.add(j)
            if in_wing(g) or in_wing(q):
                continue
            c = min(contrast(g, src_b, True), contrast(q, src_a, True))
            if c < MOVER_CONTRAST:
                continue                                   # a still star, slightly misaligned
            fit = _fit_two(diff, (q["x"], q["y"]), (g["x"], g["y"]), sigma)
            old, new, blank, err_px = fit if fit else ((q["x"], q["y"]), (g["x"], g["y"]), 0.0, sigma)
            # resampled noise is correlated over a native pixel, so the fit's error is scaled up to it
            err = math.hypot(err_px * NATIVE_PIXEL_ARCSEC, ALIGN_ERROR_ARCSEC)
            move = _motion(old, new, scale_arcsec, years, err)
            if move["shift_arcsec"] < SHIFT_SIGNIFICANCE * err:
                continue
            items.append(dict(kind="mover", z=min(g["z"], q["z"]), contrast=c, saturated=blank > 0.15, **move))
    # -- lone changes
    if fewest is not None and fewest < MIN_FRAMES_LONE:
        notes.append("too few pictures at matching wavelengths to trust single changes")
    else:
        for i, g in enumerate(gains):
            if i in used_gain or g["z"] < Z_LONE or in_wing(g):
                continue
            c = contrast(g, src_b, False)
            if c >= NEW_CONTRAST:
                items.append(dict(kind="appeared", z=g["z"], contrast=c, x=g["x"], y=g["y"], saturated=False))
            elif c >= CHANGE_MIN:
                items.append(dict(kind="brightened", z=g["z"], contrast=c, x=g["x"], y=g["y"], change=c / (1 - c), saturated=False))
        for j, q in enumerate(losses):
            if j in used_loss or q["z"] < Z_LONE or in_wing(q):
                continue
            c = contrast(q, src_a, False)
            if c >= NEW_CONTRAST:
                items.append(dict(kind="vanished", z=q["z"], contrast=c, x=q["x"], y=q["y"], saturated=False))
            elif c >= CHANGE_MIN:
                items.append(dict(kind="faded", z=q["z"], contrast=c, x=q["x"], y=q["y"], change=-c, saturated=False))
    for it in items:
        it["implausible"] = bool(it["kind"] == "mover" and (it.get("rate_arcsec_yr") or 0) > FASTEST_STAR_ARCSEC_YR)
    rank = {"mover": 0, "appeared": 1, "vanished": 1, "brightened": 2, "faded": 2}
    items.sort(key=lambda it: (it["implausible"], rank[it["kind"]], -it["z"]))
    return items[:limit], notes
