"""The advanced drawer's calculations: period search, motion fit, H-R diagram data, cross-match.
Pure functions where possible; the catalogue lookups take an Http client and cache on disk."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from . import catalogs, settings, sky
from .changes import ALIGN_ERROR_ARCSEC, compass
from .http import Http

PERIOD_RANGE_DAYS = (20.0, 1000.0)


# ---------------------------------------------------------------------------------------------
def period_search(points: list[dict], mode: str | None) -> dict:
    """Lomb-Scargle period of a light curve (points with mjd and ratio/delta)."""
    from astropy.timeseries import LombScargle
    key = mode or "ratio"
    t = np.array([p["mjd"] for p in points if p.get(key) is not None and np.isfinite(p[key])])
    y = np.array([p[key] for p in points if p.get(key) is not None and np.isfinite(p[key])])
    if t.size < 30 or np.ptp(t) < 60:
        return dict(ok=False, reason="too_few")
    span = float(np.ptp(t))
    longest = min(PERIOD_RANGE_DAYS[1], 2 * span)
    ls = LombScargle(t, y - np.median(y))
    freq, power = ls.autopower(minimum_frequency=1 / longest, maximum_frequency=1 / PERIOD_RANGE_DAYS[0], samples_per_peak=12)
    best = int(np.argmax(power))
    period = float(1 / freq[best])
    # half-width of the peak at half its height: a rough error on the period
    above = power >= power[best] / 2
    lo = best
    while lo > 0 and above[lo - 1]:
        lo -= 1
    hi = best
    while hi < len(power) - 1 and above[hi + 1]:
        hi += 1
    err = float(abs(1 / freq[lo] - 1 / freq[hi]) / 2)
    amplitude = float(np.sqrt(2 * power[best]) * np.std(y)) if power[best] > 0 else 0.0
    step = max(1, len(freq) // 300)
    return dict(ok=True, period_d=period, err_d=err, power=float(power[best]),
                false_alarm=float(ls.false_alarm_probability(power[best])), cycles=span / period, amplitude=amplitude,
                periodogram=dict(period=(1 / freq[::step]).round(2).tolist(), power=power[::step].round(4).tolist()),
                folded=[dict(phase=float(((ti - t.min()) / period) % 1), value=float(yi)) for ti, yi in zip(t, y)])


# ---------------------------------------------------------------------------------------------
def centroid(stack: np.ndarray, x: float, y: float, reach: int = 5) -> tuple[float, float] | None:
    """Brightness-weighted centre of the source near grid pixel (x, y); None if it is blank."""
    for _ in range(3):
        ix, iy = int(round(x)), int(round(y))
        y0, y1, x0, x1 = iy - reach, iy + reach + 1, ix - reach, ix + reach + 1
        if y0 < 0 or x0 < 0 or y1 > stack.shape[0] or x1 > stack.shape[1]:
            return None
        patch = stack[y0:y1, x0:x1]
        if not np.isfinite(patch).all():
            return None                                        # saturated core: no honest centre
        w = np.clip(patch - np.median(patch), 0, None)
        if w.sum() <= 0:
            return None
        yy, xx = np.mgrid[y0:y1, x0:x1]
        x, y = float((xx * w).sum() / w.sum()), float((yy * w).sum() / w.sum())
    return x, y


def motion_fit(positions: list[dict]) -> dict:
    """Straight-line motion through per-pass positions [{mjd, east, north}] (arcsec).
    Each position is good to about the pass-to-pass alignment error."""
    if len(positions) < 2:
        return dict(ok=False, reason="one_pass")
    t = np.array([(p["mjd"] - positions[0]["mjd"]) / 365.25 for p in positions])
    if np.ptp(t) < 0.2:
        return dict(ok=False, reason="short")
    out = {}
    for axis in ("east", "north"):
        v = np.array([p[axis] for p in positions])
        slope, offset = np.polyfit(t, v, 1)
        out[axis] = float(slope)
        out[axis + "_resid"] = float(np.std(v - (slope * t + offset))) if len(v) > 2 else 0.0
    err = ALIGN_ERROR_ARCSEC / math.sqrt(float(np.sum((t - t.mean()) ** 2)))
    rate = math.hypot(out["east"], out["north"])
    direction = math.degrees(math.atan2(out["east"], out["north"])) % 360
    return dict(ok=True, pm_east=out["east"], pm_north=out["north"], rate=rate, err=err, direction_deg=direction,
                direction=compass(direction), years=float(np.ptp(t)), n=len(positions),
                significant=rate >= 3 * err, resid=max(out["east_resid"], out["north_resid"]))


def tangential_speed(rate_arcsec_yr: float, parallax_mas: float | None) -> float | None:
    """km/s across the sky from proper motion and parallax."""
    if not parallax_mas or parallax_mas <= 0:
        return None
    return 4.74 * rate_arcsec_yr * (1000.0 / parallax_mas)


# ---------------------------------------------------------------------------------------------
def hr_field(http: Http, ra: float, dec: float, radius_deg: float = 0.5, cache_dir: Path | None = None):
    """Gaia stars around the field with good parallaxes, for an H-R diagram and a reduced
    proper-motion diagram. None if Gaia can't be reached."""
    path = Path(cache_dir or settings.DATA / "gaia") / f"hr_{ra:.3f}_{dec:+.3f}_{radius_deg:.2f}.json"

    def fetch():
        query = ("SELECT TOP 2500 source_id, parallax, phot_g_mean_mag, bp_rp, pmra, pmdec FROM gaiadr3.gaia_source WHERE "
                 f"CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.5f}, {dec:.5f}, {radius_deg:.3f})) = 1 "
                 "AND parallax_over_error > 8 AND bp_rp IS NOT NULL ORDER BY phot_g_mean_mag")
        r = http.get(catalogs.ESA_TAP, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query},
                     timeout=(8, catalogs.SLOW_SERVICE_S), tries=1)
        return [star for star in (hr_point(row) for row in catalogs._rows(r.text, "source_id")) if star]
    return catalogs._cached(path, fetch)


def hr_point(row: dict) -> dict | None:
    """One star's place in the diagrams: colour, absolute magnitude, reduced proper motion."""
    plx, g, colour = (catalogs._num(row.get(k), None) for k in ("parallax", "phot_g_mean_mag", "bp_rp"))
    if not plx or plx <= 0 or g is None or colour is None:
        return None
    pm = math.hypot(catalogs._num(row.get("pmra")), catalogs._num(row.get("pmdec"))) / 1000.0     # arcsec/yr
    return dict(id=str(row.get("source_id")), bp_rp=round(colour, 3), abs_g=round(g + 5 * math.log10(plx / 100.0), 3),
                rpm=round(g + 5 * math.log10(pm) + 5, 3) if pm > 0 else None)


# ---------------------------------------------------------------------------------------------
VIZIER = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv"      # the Harvard mirror; IRSA's TAP takes minutes for these
SURVEYS = [
    # name, VizieR table, id column, magnitude columns, epoch (Julian year) of its positions
    ("2MASS", "II/246/out", "2MASS", ("Jmag", "Hmag", "Kmag"), 1999.5),
    ("AllWISE", "II/328/allwise", "AllWISE", ("W1mag", "W2mag", "W3mag", "W4mag"), 2010.5),
]


def parse_tsv(text: str) -> list[dict]:
    """Rows of a VizieR tab-separated answer (comment lines, then names, units, dashes, data)."""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    if len(lines) < 3 or not lines[2].startswith("-"):
        return []
    names = [n.strip() for n in lines[0].split("	")]
    return [dict(zip(names, (v.strip() for v in ln.split("	")))) for ln in lines[3:]]


def cross_match(http: Http, target: dict, radius_arcsec: float = 6.0, cache_dir: Path | None = None) -> list[dict]:
    """The same star in 2MASS and AllWISE. target = {ra, dec, pmra, pmdec, epoch}: a fast mover is
    looked for where it was when each survey observed it."""
    out = []
    for name, table, idcol, mags, epoch in SURVEYS:
        mjd = 51544.5 + (epoch - 2000.0) * 365.25
        ra, dec = sky.position_at(target, mjd, parallax=False)
        path = Path(cache_dir or settings.DATA / "xmatch") / f"{table.replace('/', '_')}_{ra:.5f}_{dec:+.5f}.json"

        def fetch(table=table, idcol=idcol, mags=mags, ra=ra, dec=dec):
            params = {"-source": table, "-c": f"{ra:.6f} {dec:+.6f}", "-c.rs": f"{radius_arcsec:.1f}",
                      "-out": ",".join((idcol, "RAJ2000", "DEJ2000", *mags)), "-out.max": "5"}
            r = http.get(VIZIER, params=params, timeout=(8, catalogs.SLOW_SERVICE_S), tries=1)
            if "#" not in r.text[:200]:
                raise IOError("unexpected answer from VizieR")
            return parse_tsv(r.text)
        rows = catalogs._cached(path, fetch)
        if rows is None:
            out.append(dict(survey=name, state="unreachable"))
            continue
        cosd = math.cos(math.radians(dec))

        def apart(r, ra=ra, dec=dec, cosd=cosd):
            return math.hypot((catalogs._num(r["RAJ2000"]) - ra) * cosd, catalogs._num(r["DEJ2000"]) - dec) * 3600
        best = min(rows, key=apart, default=None)
        if best is None:
            out.append(dict(survey=name, state="none"))
            continue
        out.append(dict(survey=name, state="found", id=best[idcol], sep_arcsec=round(apart(best), 2), epoch=epoch,
                        mags={m.replace("mag", ""): catalogs._num(best.get(m), None) for m in mags}))
    return out
