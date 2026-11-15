"""Simple candidate finder: sources that move, change brightness, or appear in one epoch only.

Works on the epoch co-adds (positions) and epoch x detector co-adds (brightness, so that we only
ever compare a source with itself at the same detector / wavelength range).
"""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

from . import config
from .stack import _aperture

POS_FLOOR = 0.08        # px, systematic floor on centroid errors (visit of >= FLOOR_N exposures)
FLOOR_N = 40
MATCH_R = 3.0           # px, how far a source may move between epochs and still be linked
STATIC_R = 1.0          # px, alignment matches
MIN_SNR_TRACK = 8.0
MAX_PER_TYPE = 12


def robust_sigma(img):
    v = img[np.isfinite(img)]
    if v.size < 10:
        return np.inf
    return float(1.4826 * np.median(np.abs(v - np.median(v))))


def _disk(r):
    k = int(math.ceil(r))
    yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    return ((xx ** 2 + yy ** 2) <= r * r).astype(float)


def find_sources(img, var, snr_min=5.0):
    good = np.isfinite(img)
    im = np.where(good, img, 0.0)
    sig = robust_sigma(img)
    if not np.isfinite(sig) or sig <= 0:
        return []
    nv = np.where(np.isfinite(var) & (var > 0), var, sig ** 2)
    nv = np.maximum(nv, sig ** 2)            # formal variance underestimates confusion noise
    d = _disk(config.APERTURE_PX)
    ap = ndimage.convolve(im, d, mode="constant")
    snr = ap / np.sqrt(ndimage.convolve(nv, d, mode="constant"))
    sm = ndimage.gaussian_filter(im, 0.8)
    cover = ndimage.uniform_filter(good.astype(float), 5)
    peaks = (sm == ndimage.maximum_filter(sm, size=3)) & (snr >= snr_min) & (cover > 0.9)
    peaks[:3, :] = peaks[-3:, :] = peaks[:, :3] = peaks[:, -3:] = False
    out = []
    for y, x in zip(*np.nonzero(peaks)):
        # refine on the brightest pixel near the smoothed peak
        win = im[y - 1:y + 2, x - 1:x + 2]
        dy, dx = np.unravel_index(np.argmax(win), win.shape)
        py, px = y + dy - 1, x + dx - 1
        if not (1 <= px < im.shape[1] - 1 and 1 <= py < im.shape[0] - 1):
            continue
        ox = _gauss3(im[py, px - 1], im[py, px], im[py, px + 1])
        oy = _gauss3(im[py - 1, px], im[py, px], im[py + 1, px])
        out.append({"x": float(px + ox), "y": float(py + oy), "snr": float(snr[y, x]), "flux": float(ap[y, x])})
    return out


def _gauss3(l, c, r):
    """Sub-pixel peak offset from three samples assuming a Gaussian profile (unbiased for
    undersampled PSFs, unlike a centroid); falls back to a parabola if any sample is <= 0."""
    if l > 0 and c > 0 and r > 0:
        a, b, d = math.log(l), math.log(c), math.log(r)
        den = 2 * (a - 2 * b + d)
    else:
        a, b, d = l, c, r
        den = 2 * (l - 2 * c + r)
    if den >= 0:          # not a maximum
        return 0.0
    return float(max(-0.5, min(0.5, (a - d) / den)))


def _sigma_pos(snr, n_exposures=None):
    """Centroid error (px): photon noise plus a systematic floor. A visit co-added from few exposures
    (or a saturated star, whose S/N says little) has a larger floor: dithering, PSF and distortion
    errors only average down with many exposures."""
    floor = POS_FLOOR * (max(1.0, math.sqrt(FLOOR_N / n_exposures)) if n_exposures else 1.0)
    return math.hypot(0.7 / max(snr, 1e-3), floor)


def _nearest(s, sources, r):
    best, bd = None, r
    for j, t in enumerate(sources):
        d = math.hypot(t["x"] - s["x"], t["y"] - s["y"])
        if d <= bd:
            best, bd = j, d
    return best, bd


def _align(ref, other):
    """Median offset of bright common sources (relative astrometry between epochs)."""
    pairs = []
    for s in ref:
        if s["snr"] < 15:
            continue
        j, _ = _nearest(s, other, STATIC_R)
        if j is not None and other[j]["snr"] >= 15:
            pairs.append((other[j]["x"] - s["x"], other[j]["y"] - s["y"]))
    if len(pairs) < 5:
        return 0.0, 0.0
    dx, dy = np.median(np.array(pairs), axis=0)
    return (float(dx), float(dy)) if math.hypot(dx, dy) < 1.0 else (0.0, 0.0)


def _linfit(t, v, s):
    w = 1 / np.asarray(s) ** 2
    t, v = np.asarray(t), np.asarray(v)
    S, St, Stt = w.sum(), (w * t).sum(), (w * t * t).sum()
    D = S * Stt - St * St
    slope = (S * (w * t * v).sum() - St * (w * v).sum()) / D
    icpt = ((w * v).sum() - slope * St) / S
    chi2 = float((w * (v - icpt - slope * t) ** 2).sum())
    return float(slope), float(math.sqrt(S / D)), chi2


def _motion(pts):
    """Linear fit of positions vs time (years). Returns vx, ex, vy, ey, chi2, -chi2/dof, t."""
    t = np.array([p[0] for p in pts]) / 365.25
    t = t - t.mean()
    sp = [_sigma_pos(p[1]["snr"], p[1].get("n")) for p in pts]
    vx, ex, cx = _linfit(t, [p[1]["x"] for p in pts], sp)
    vy, ey, cy = _linfit(t, [p[1]["y"] for p in pts], sp)
    chi = cx + cy
    return vx, ex, vy, ey, chi, -chi / max(1, 2 * len(pts) - 4), t


def find_candidates(epoch_groups, ed_groups, wout, target_xy=None):
    """epoch_groups: [{epoch, mjd, image, variance, flags}], ed_groups: same plus detector."""
    if len(epoch_groups) < 2:
        return []
    for g in epoch_groups:
        g["sources"] = find_sources(g["image"], g["variance"])
    # reference = the deepest visit (most exposures): a thin visit can show spurious sources next to a
    # saturated star, which would then look "crowded" and be skipped
    ref_i = max(range(len(epoch_groups)), key=lambda i: (epoch_groups[i].get("n_exposures") or 0, len(epoch_groups[i]["sources"])))
    ref = epoch_groups[ref_i]
    for g in epoch_groups:
        g["offset"] = (0.0, 0.0) if g is ref else _align(ref["sources"], g["sources"])
        g["aligned"] = [{**s, "x": s["x"] - g["offset"][0], "y": s["y"] - g["offset"][1], "n": g.get("n_exposures")}
                        for s in g["sources"]]

    def sky(x, y):
        ra, dec = wout.wcs_pix2world([[x, y]], 0)[0]
        return float(ra), float(dec)

    def is_target(x, y):
        return bool(target_xy and math.hypot(x - target_xy[0], y - target_xy[1]) < 2.0)

    moving, static = [], []
    for s in ref["aligned"]:
        if s["snr"] < MIN_SNR_TRACK:
            continue
        crowded = any(o is not s and math.hypot(o["x"] - s["x"], o["y"] - s["y"]) < 2.5 for o in ref["aligned"])
        pts = [(ref["mjd"], s)]
        for g in epoch_groups:
            if g is ref:
                continue
            j, _ = _nearest(s, g["aligned"], MATCH_R)
            if j is None:
                continue
            cand = g["aligned"][j]
            back, _ = _nearest(cand, ref["aligned"], MATCH_R)      # mutual nearest neighbours only
            if back is not None and ref["aligned"][back] is s:
                pts.append((g["mjd"], cand))
        if len(pts) < 2:
            continue
        pts.sort(key=lambda p: p[0])
        fit = _motion(pts)
        if fit[4] / max(1, 2 * len(pts) - 4) >= 4.0 and len(pts) >= 4:
            # one bad epoch (few exposures, saturated core...) should not hide a real mover
            worst = max(range(len(pts)), key=lambda i: _motion(pts[:i] + pts[i + 1:])[5])
            pts = pts[:worst] + pts[worst + 1:]
            fit = _motion(pts)
        vx, ex, vy, ey, chi, _, t = fit
        cx, cy = chi, 0.0
        v = math.hypot(vx, vy)
        ev = math.sqrt((vx * ex) ** 2 + (vy * ey) ** 2) / v if v > 0 else 1.0
        sig = v / ev if ev > 0 else 0.0
        span = t.max() - t.min()
        dof = max(1, 2 * len(pts) - 4)
        enough = len(pts) >= min(3, len(epoch_groups))     # two points can't show a straight line
        consistent = enough and (len(pts) == 2 or (cx + cy) / dof < 4.0)
        track = {"x": s["x"], "y": s["y"], "snr": s["snr"],
                 "points": [{"mjd": p[0], "x": p[1]["x"], "y": p[1]["y"]} for p in pts]}
        if sig >= 5 and v * span >= 0.4 and consistent and not crowded:
            ra, dec = sky(s["x"], s["y"])
            moving.append({**track, "type": "moving", "ra": ra, "dec": dec, "significance": round(sig, 1),
                           "rate_arcsec_yr": round(v * config.PIXEL_SCALE, 2),
                           "pa_deg": round(math.degrees(math.atan2(-vx, vy)) % 360, 1),
                           "is_target": is_target(s["x"], s["y"])})
        elif sig < 3:
            static.append(track)

    variable = _variables(static, ed_groups, sky, is_target)
    transients = _transients(epoch_groups, sky, is_target)
    _second_opinion(moving, variable, transients, difference_finds(epoch_groups, ref))
    out = (sorted(moving, key=lambda c: -c["significance"])[:MAX_PER_TYPE]
           + sorted(variable, key=lambda c: -c["significance"])[:MAX_PER_TYPE]
           + sorted(transients, key=lambda c: -c["significance"])[:MAX_PER_TYPE])
    for c in out:
        c.pop("snr", None)
    return out


def _variables(static, ed_groups, sky, is_target):
    by_det: dict[int, list] = {}
    for g in ed_groups:
        by_det.setdefault(g["detector"], []).append(g)
    out = []
    for s in static:
        per_det, n_dets = [], 0
        for det, gs in sorted(by_det.items()):
            if len(gs) < 2:
                continue
            meas, flagged = [], []
            for g in gs:
                p = _aperture(g["image"], g["variance"], g["flags"], s["x"], s["y"])
                if p and np.isfinite(p["flux_ujy"]) and p["err_ujy"] > 0:
                    (flagged if p["flagged"] else meas).append((g["epoch"], p["flux_ujy"], p["err_ujy"]))
            low_conf = len(meas) < 2
            if low_conf:                 # bright stars are almost always flagged: use them, but say so
                meas = meas + flagged
            if len(meas) < 2:
                continue
            n_dets += 1
            lo = min(meas, key=lambda m: m[1])
            hi = max(meas, key=lambda m: m[1])
            if lo[1] <= 0:
                continue
            ratio = hi[1] / lo[1]
            sig = (hi[1] - lo[1]) / math.hypot(hi[2], lo[2])
            if ratio >= 1.3 and sig >= 6:
                per_det.append({"detector": det, "ratio": round(ratio, 2), "significance": round(sig, 1),
                                "low_confidence": low_conf,
                                "fluxes": [{"epoch": m[0], "flux_ujy": round(m[1], 1), "err_ujy": round(m[2], 1)}
                                           for m in meas]})
        # the SPHEREx filters sample different wavelengths each visit: insist on two detectors agreeing
        # real variables brighten in several bands at once; filter-sampling artefacts point anywhere
        if len(per_det) >= 2:
            pairs = {}
            for d in per_det:
                hi_e = max(d["fluxes"], key=lambda f: f["flux_ujy"])["epoch"]
                lo_e = min(d["fluxes"], key=lambda f: f["flux_ujy"])["epoch"]
                pairs.setdefault((hi_e, lo_e), []).append(d)
            per_det = max(pairs.values(), key=len)
        if len(per_det) >= 2 or (per_det and n_dets == 1):
            ra, dec = sky(s["x"], s["y"])
            best = max(per_det, key=lambda d: d["ratio"])
            out.append({"type": "variable", "x": s["x"], "y": s["y"], "ra": ra, "dec": dec,
                        "points": s["points"], "significance": best["significance"],
                        "ratio": best["ratio"], "detectors": per_det, "is_target": is_target(s["x"], s["y"]),
                        "low_confidence": all(d["low_confidence"] for d in per_det)})
    return out


def difference_finds(epoch_groups, ref=None, snr_min=6.0):
    """The second, independent finder: each visit minus the median of the other visits (shifted onto it).
    Whatever stays put cancels; what remains is "is here now" (positive, orange in the viewer) or "was here"
    (negative, blue). Returns [{x, y, epoch, sign, snr}] in reference-visit pixels. Residuals next to very
    bright stars (saturated cores, slightly different PSFs) are dropped unless they are a large part of the star."""
    if len(epoch_groups) < 2:
        return []
    ref = ref or epoch_groups[0]
    bright = [s for s in ref.get("aligned", []) if s["snr"] > 60]
    out = []
    for g in epoch_groups:
        others = [o for o in epoch_groups if o is not g]
        stackd = []
        for o in others:
            dx = int(round(o["offset"][0] - g["offset"][0]))
            dy = int(round(o["offset"][1] - g["offset"][1]))
            stackd.append(np.roll(np.roll(o["image"], -dy, 0), -dx, 1))
        with np.errstate(all="ignore"):
            med = np.nanmedian(np.array(stackd), axis=0)
            mvar = np.nanmean(np.array([o["variance"] for o in others]), axis=0) * (math.pi / 2) / len(others)
            diff = g["image"] - med
            var = g["variance"] + mvar
        for sign in (1, -1):
            for s in find_sources(sign * diff, var, snr_min):
                x, y = s["x"] - g["offset"][0], s["y"] - g["offset"][1]
                if any(math.hypot(b["x"] - x, b["y"] - y) < 5 and s["snr"] < 0.15 * b["snr"] for b in bright):
                    continue
                out.append({"x": x, "y": y, "epoch": g["epoch"], "sign": sign, "snr": s["snr"]})
    return out


def _second_opinion(moving, variable, transients, finds, r=2.0):
    """Mark candidates the difference pictures also show ("found two ways")."""
    def near(x, y, epoch=None, sign=None):
        return any(math.hypot(f["x"] - x, f["y"] - y) < r and (epoch is None or f["epoch"] == epoch)
                   and (sign is None or f["sign"] == sign) for f in finds)
    for c in moving:
        c["found_by"] = ["track", "difference"] if any(near(p["x"], p["y"]) for p in c["points"]) else ["track"]
    for c in variable:
        c["found_by"] = ["track", "difference"] if near(c["x"], c["y"]) else ["track"]
    for c in transients:
        c["found_by"] = ["track", "difference"] if near(c["x"], c["y"], c["epoch"], 1) else ["track"]


def _ap_snr(g, x, y):
    """Aperture S/N at (x, y) against robust noise; inf when the aperture is off the image or not finite."""
    d = _disk(config.APERTURE_PX)
    k = d.shape[0] // 2
    ix, iy = int(round(x)), int(round(y))
    img = g["image"]
    if not (k <= ix < img.shape[1] - k and k <= iy < img.shape[0] - k):
        return math.inf
    cut = img[iy - k:iy + k + 1, ix - k:ix + k + 1]
    if not np.isfinite(cut[d > 0]).all():
        return math.inf
    if "robust" not in g:
        g["robust"] = robust_sigma(img)
    noise = g["robust"] * math.sqrt(d.sum())
    return float((cut * d).sum() / noise) if noise > 0 else math.inf


def _transients(epoch_groups, sky, is_target):
    out = []
    for g in epoch_groups:
        bright = [s for s in g["aligned"] if s["snr"] > 50]
        for s in g["aligned"]:
            if s["snr"] < 8 or any(b is not s and math.hypot(b["x"] - s["x"], b["y"] - s["y"]) < 4 for b in bright):
                continue
            others = [o for o in epoch_groups if o is not g]
            if any(_nearest(s, o["aligned"], 1.5)[0] is not None for o in others):
                continue
            # it must really be absent elsewhere, not just below the detection threshold
            # (noise as find_sources measures it: the formal error leaves out confusion and would call
            # every noise bump "present")
            absent = True
            for o in others:
                ox, oy = s["x"] + o["offset"][0], s["y"] + o["offset"][1]
                if _ap_snr(o, ox, oy) > 4:
                    absent = False
                    break
            if absent:
                ra, dec = sky(s["x"], s["y"])
                out.append({"type": "transient", "x": s["x"], "y": s["y"], "ra": ra, "dec": dec,
                            "epoch": g["epoch"], "significance": round(s["snr"], 1),
                            "points": [{"mjd": g["mjd"], "x": s["x"], "y": s["y"]}],
                            "is_target": is_target(s["x"], s["y"])})
    return out
