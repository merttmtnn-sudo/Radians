"""Does the brightness of a star change? Two honest questions about a SPHEREx light curve.

SPHEREx sees a spot at a different wavelength in every exposure, and comes back to most of the sky
only every six months for a week or two. So the points are first divided by the usual brightness at
their own wavelength (1 = usual), bad ones are left out, and then:

1. Between visits: is one visit brighter or fainter than another, and by how much? This needs no
   period and works with two visits.
2. A rhythm: a Lomb-Scargle search on what is left after each visit's own level is taken out, so a
   plain change between visits cannot pass for a period. Only periods that fit inside a visit about
   twice are tried. How strong the best peak is, is judged against the same measurements with their
   dates scrambled inside each visit: a peak the scrambles reach as well is noise.

Nothing is guessed: too few points, a spot too faint to measure, or a saturated star gives a reason
instead of a number. scripts/pulse_validate.py measures how often injected pulsations are found.
"""
from __future__ import annotations

import math

import numpy as np

from . import config, spectype

MIN_POINTS = 30                  # fewer usable measurements: nothing is said
MIN_SPAN_DAYS = 60.0
MIN_BIN_POINTS = 4               # a wavelength group needs this many points to know its usual brightness
GROUP_POINTS = 6                 # points per group: neighbours in wavelength inside one detector band
MAX_GROUP_WIDTH = 0.10           # ... no wider than this in ln(wavelength), about four resolution elements
MIN_BIN_SNR = 3.0                # ... and that usual brightness must stand this far above its own error
MIN_POINT_SNR = 3.0              # median signal-to-noise of single points; below: too faint to test
RUN_GAP_DAYS = config.EPOCH_GAP_DAYS
MIN_RUN_POINTS = 5               # a visit with fewer points has no level of its own
NEIGHBOUR_DAYS = 3.0             # a stray point is judged against the points within this many days
STRAY_SIGMA = 5.0
VISIT_FLOOR = 0.02               # calibration: two visits cannot be compared better than about 2%
CHANGE_SIGMA, CHANGE_MIN = 5.0, 0.05
PERIOD_MIN_DAYS, PERIOD_MAX_DAYS = 1.0, 1000.0
SAMPLES_PER_PEAK = 5
N_SCRAMBLES = 300
P_CONVINCING = 0.01
MIN_CYCLES = 2.0


def _num(v) -> float:
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else math.nan


def clean(points: list[dict], wings: bool = False) -> dict:
    """Relative brightness of the usable points: arrays t (MJD), r (1 = usual at that wavelength) and
    e (error of r), and how many points were left out and why.

    wings: the values are fluxes in the wings of a saturated star (the page's "wings" mode); then
    saturated and flagged points are what is being measured and are kept."""
    t = np.array([_num(p.get("mjd")) for p in points])
    w = np.array([_num(p.get("wavelength")) for p in points])
    v = np.array([_num(p.get("value")) for p in points])
    err = np.array([_num(p.get("err")) for p in points])
    dropped = {"flagged": 0, "saturated": 0, "faint": 0, "sparse": 0, "stray": 0}
    keep = np.isfinite(t) & np.isfinite(w) & np.isfinite(v)
    total = int(keep.sum())
    if not wings:
        sat = np.array([bool(p.get("saturated")) for p in points], bool)
        bad = np.array([bool(p.get("flagged")) for p in points], bool) & ~sat
        dropped["saturated"], dropped["flagged"] = int((keep & sat).sum()), int((keep & bad).sum())
        keep &= ~(sat | bad)
    t, w, v, err = t[keep], w[keep], v[keep], err[keep]
    r, e = np.full(t.size, np.nan), np.full(t.size, np.nan)
    for mine in wavelength_groups(w):
        if mine.size < MIN_BIN_POINTS or math.log(w[mine].max() / w[mine].min()) > MAX_GROUP_WIDTH:
            dropped["sparse"] += int(mine.size)              # too few neighbours in wavelength to compare with
            continue
        med = float(np.median(v[mine]))
        scatter = 1.4826 * float(np.median(np.abs(v[mine] - med)))
        formal = err[mine]
        typical = float(np.nanmedian(formal)) if np.isfinite(formal).any() else 0.0
        # the usual brightness of this bin must itself be well measured, or the ratios are noise
        if not med > MIN_BIN_SNR * 1.253 * max(scatter, typical) / math.sqrt(mine.size):
            dropped["faint"] += int(mine.size)
            continue
        r[mine] = v[mine] / med
        e[mine] = np.where(np.isfinite(formal) & (formal > 0), formal, max(scatter, 1e-6 * med)) / med
    dropped["sparse"] += int((~np.isfinite(r)).sum()) - dropped["faint"] - dropped["sparse"]   # outside the bands
    ok = np.isfinite(r)
    t, r, e = t[ok], r[ok], e[ok]
    order = np.argsort(t, kind="stable")
    t, r, e = t[order], r[order], e[order]
    # a stray point (a cosmic ray, a passing asteroid): far from the points taken within a few days
    stray = np.zeros(t.size, bool)
    lo = np.searchsorted(t, t - NEIGHBOUR_DAYS, side="left")
    hi = np.searchsorted(t, t + NEIGHBOUR_DAYS, side="right")
    for i in range(t.size):
        near = np.r_[r[lo[i]:i], r[i + 1:hi[i]]]
        if near.size < 4:
            continue
        med = float(np.median(near))
        spread = max(1.4826 * float(np.median(np.abs(near - med))), float(e[i]))
        stray[i] = abs(r[i] - med) > STRAY_SIGMA * spread
    dropped["stray"] = int(stray.sum())
    return {"t": t[~stray], "r": r[~stray], "e": e[~stray], "dropped": dropped, "total": total}


def wavelength_groups(w: np.ndarray) -> list[np.ndarray]:
    """Index groups of points that share one "usual brightness": GROUP_POINTS neighbours in wavelength
    inside one detector band (a short tail joins the group before it). Fixed resolution-sized bins
    would leave a third of the points of an ordinary field without enough company."""
    edges = np.asarray(spectype.BAND_EDGES_UM)
    band = np.searchsorted(edges, w, side="right") - 1
    out = []
    for b in range(len(edges) - 1):
        idx = np.flatnonzero(band == b)
        idx = idx[np.argsort(w[idx], kind="stable")]
        start = 0
        while start < idx.size:
            end = min(start + GROUP_POINTS, idx.size)
            if idx.size - end < MIN_BIN_POINTS:
                end = idx.size
            out.append(idx[start:end])
            start = end
    return out


def runs_of(t: np.ndarray, gap: float = RUN_GAP_DAYS) -> list[np.ndarray]:
    """Index arrays of the visits: a gap of more than `gap` days starts a new one. t must be sorted."""
    if not t.size:
        return []
    return np.split(np.arange(t.size), np.flatnonzero(np.diff(t) > gap) + 1)


def visit_levels(t, r, runs) -> list[dict]:
    """Level of each visit with enough points: the median, with an error from the scatter inside the
    visit (so real flickering widens it) and a calibration floor."""
    out = []
    for run in runs:
        if run.size < MIN_RUN_POINTS:
            continue
        med = float(np.median(r[run]))
        spread = 1.4826 * float(np.median(np.abs(r[run] - med)))
        err = math.hypot(1.253 * spread / math.sqrt(run.size), VISIT_FLOOR)
        out.append({"mjd": round(float(np.mean(t[run])), 2), "mjd_start": round(float(t[run[0]]), 2),
                    "mjd_end": round(float(t[run[-1]]), 2), "n": int(run.size), "level": round(med, 4), "err": round(err, 4)})
    return out


def biggest_change(visits: list[dict]) -> dict | None:
    """The pair of visits that differ most for their errors. {"pct", "err_pct", "sigma", "significant", ...}"""
    best = None
    for i, a in enumerate(visits):
        for b in visits[i + 1:]:
            err = math.hypot(a["err"], b["err"])
            diff = b["level"] - a["level"]
            sigma = abs(diff) / err
            if best is None or sigma > best["sigma"]:
                base = (a["level"] + b["level"]) / 2
                best = {"from_mjd": a["mjd"], "to_mjd": b["mjd"], "brighter": diff > 0, "sigma": round(sigma, 1),
                        "pct": round(100 * abs(diff) / base, 1), "err_pct": round(100 * err / base, 1)}
    if best:
        best["significant"] = bool(best["sigma"] >= CHANGE_SIGMA and best["pct"] >= 100 * CHANGE_MIN)
    return best


def _search(t, y, e, runs, rng) -> dict | None:
    """Lomb-Scargle on y (each visit's level already removed) and how often scrambled data do as well."""
    from astropy.timeseries import LombScargle
    longest = max(float(t[run[-1]] - t[run[0]]) for run in runs)
    lo, hi = PERIOD_MIN_DAYS, min(PERIOD_MAX_DAYS, 2 * longest)
    if hi < 2 * lo:
        return None
    span = float(np.ptp(t))
    kw = dict(minimum_frequency=1 / hi, maximum_frequency=1 / lo, samples_per_peak=SAMPLES_PER_PEAK)
    ls = LombScargle(t, y, e)
    freq, power = ls.autopower(**kw)
    best = int(np.argmax(power))
    period = float(1 / freq[best])
    if len(runs) > 1:
        # only parts of the cycles were seen: the peak is a comb of look-alikes one visit wide
        err = period ** 2 / (2 * longest)
    else:
        above = power >= power[best] / 2                     # half-width of the peak at half its height
        a = b = best
        while a > 0 and above[a - 1]:
            a -= 1
        while b < len(power) - 1 and above[b + 1]:
            b += 1
        err = abs(1 / freq[a] - 1 / freq[b]) / 2
    tops = np.empty(N_SCRAMBLES)
    for k in range(N_SCRAMBLES):
        ys, es = y.copy(), e.copy()
        for run in runs:                                     # dates scrambled inside each visit
            perm = rng.permutation(run)
            ys[run], es[run] = y[perm], e[perm]
        tops[k] = LombScargle(t, ys, es).autopower(**kw)[1].max()
    p_value = (1 + int((tops >= power[best]).sum())) / (1 + N_SCRAMBLES)
    theta = ls.model_parameters(freq[best])
    amplitude = float(math.hypot(theta[1], theta[2]))
    seen = sum(float(t[run[-1]] - t[run[0]]) for run in runs)
    step = max(1, len(freq) // 300)
    return {"lo_d": lo, "hi_d": round(hi, 1), "period_d": round(period, 2 if period < 20 else 1), "err_d": round(float(err), 2),
            "power": round(float(power[best]), 4), "threshold": round(float(np.quantile(tops, 1 - P_CONVINCING)), 4),
            "p_value": round(p_value, 4), "cycles": round(seen / period, 2), "amplitude_pct": round(100 * amplitude, 1),
            "aliased": len(runs) > 1, "span_d": round(span, 1),
            "periodogram": [[round(float(1 / f), 2), round(float(p), 4)] for f, p in zip(freq[::step], power[::step])],
            "folded": [[round(float(((ti - t[0]) / period) % 1), 4), round(float(1 + yi), 4)] for ti, yi in zip(t, y)]}


def analyse(points: list[dict], wings: bool = False) -> dict:
    """{"ok": False, "reason": "too_few" | "too_faint" | "saturated"} or the two answers (see the module text)."""
    c = clean(points, wings)
    t, r, e = c["t"], c["r"], c["e"]
    d = c["dropped"]
    if t.size < MIN_POINTS or (t.size and np.ptp(t) < MIN_SPAN_DAYS):
        if wings and sum(bool(p.get("saturated")) for p in points) > len(points) / 2:
            # so bright that even the light around the core is unusable in most exposures
            return {"ok": False, "reason": "saturated", "wings": True, "dropped": d}
        if c["total"] >= MIN_POINTS and d["saturated"] > c["total"] / 2:
            return {"ok": False, "reason": "saturated", "dropped": d}
        if c["total"] >= MIN_POINTS and d["faint"] > (c["total"] - d["flagged"] - d["saturated"]) / 2:
            return {"ok": False, "reason": "too_faint", "dropped": d}
        return {"ok": False, "reason": "too_few", "dropped": d} if any(d.values()) else {"ok": False, "reason": "too_few"}
    snr = float(np.median(r / e))
    if snr < MIN_POINT_SNR:
        return {"ok": False, "reason": "too_faint", "dropped": d, "snr": round(snr, 1)}
    runs = runs_of(t)
    visits = visit_levels(t, r, runs)
    big = [run for run in runs if run.size >= MIN_RUN_POINTS]
    used = np.concatenate(big) if big else np.array([], int)
    y = r.copy()
    for run in big:
        y[run] -= np.median(r[run])
    out = {"ok": True, "n": int(t.size), "dropped": d, "snr": round(snr, 1), "visits": visits,
           "change": biggest_change(visits) if len(visits) > 1 else None,
           "scatter_pct": round(100 * 1.4826 * float(np.median(np.abs(y[used]))), 1) if used.size else None,
           "points": [[round(float(a), 3), round(float(b), 4)] for a, b in zip(t, r)],
           "search": None, "convincing": False}
    if used.size >= MIN_POINTS:
        tu, yu, eu = t[used], y[used], e[used]
        local = runs_of(tu)
        found = _search(tu, yu, eu, local, np.random.default_rng(0))
        if found:
            out["search"] = {"lo_d": found.pop("lo_d"), "hi_d": found.pop("hi_d")}
            out.update(found)
            out["false_alarm"] = out["p_value"]
            out["convincing"] = bool(out["p_value"] < P_CONVINCING and out["cycles"] >= MIN_CYCLES)
    return out
