"""The "for the curious" tools under the spectrum: where a star sits among its neighbours (H-R diagram),
how fast it crosses the sky, whether its light curve has a rhythm, and what other surveys list there.
Pure functions where possible; the catalogue lookups are cached on disk and say when a service is down."""
from __future__ import annotations

import math

import numpy as np

from . import explorer, spectype
from .external import GAIA_TAP

TTL = 30 * 86400
TIMEOUT = (6, 25)
PERIOD_RANGE_DAYS = (20.0, 1000.0)
VIZIER = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv"      # the Harvard mirror answers when CDS does not
SURVEYS = [
    # name, VizieR table, id column, magnitude columns, year its positions are for
    ("2MASS", "II/246/out", "2MASS", ("Jmag", "Hmag", "Kmag"), 1999.5),
    ("AllWISE", "II/328/allwise", "AllWISE", ("W1mag", "W2mag", "W3mag", "W4mag"), 2010.5),
]
DIRS = ["north", "north_east", "east", "south_east", "south", "south_west", "west", "north_west"]


def compass(pa_deg: float) -> str:
    return DIRS[round((pa_deg % 360) / 45) % 8]


def tangential_speed(rate_arcsec_yr: float, parallax_mas) -> float | None:
    """km/s across the sky from proper motion and parallax."""
    if not parallax_mas or parallax_mas <= 0:
        return None
    return 4.74 * rate_arcsec_yr * (1000.0 / parallax_mas)


def _gaia(adql):
    r = explorer._get(GAIA_TAP, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql},
                      timeout=TIMEOUT, tries=1)
    if not r.ok or "source_id" not in r.text.split("\n", 1)[0]:
        raise explorer.Upstream("Gaia unavailable")
    return explorer._csv(r.text)


# ---------------------------------------------------------------- one Gaia star: place in the H-R diagram, motion
def star_summary(row: dict) -> dict:
    """Colour, absolute magnitude, motion and speed of one Gaia row (values as text or numbers)."""
    n = lambda k: explorer._num(row.get(k))  # noqa: E731
    plx, g, colour = n("parallax"), n("phot_g_mean_mag"), n("bp_rp")
    good = plx is not None and plx > 0 and (n("parallax_over_error") or 0) >= 5
    pmra, pmdec = n("pmra") or 0.0, n("pmdec") or 0.0
    rate = math.hypot(pmra, pmdec) / 1000.0
    speed = tangential_speed(rate, plx) if good else None
    return {"found": True, "id": str(row.get("source_id")), "g": g, "bp_rp": colour,
            "abs_g": round(g + 5 * math.log10(plx / 100.0), 3) if good and g is not None else None,
            "parallax_mas": round(plx, 3) if plx is not None else None, "parallax_ok": good,
            "rate": round(rate, 4), "direction": compass(math.degrees(math.atan2(pmra, pmdec))) if rate > 0 else None,
            "speed_kms": round(speed, 1) if speed is not None else None}


def gaia_star(source_id) -> dict:
    sid = str(source_id or "").replace("Gaia DR3", "").strip()
    if not sid.isdigit():
        return {"found": False}
    adql = ("SELECT source_id, parallax, parallax_over_error, phot_g_mean_mag, bp_rp, pmra, pmdec "
            f"FROM gaiadr3.gaia_source WHERE source_id = {sid}")

    def run():
        rows = _gaia(adql)
        return star_summary(rows[0]) if rows else {"found": False}
    return explorer._cached_json("cugaia", adql, TTL, run)


def hr_field(ra: float, dec: float, radius: float = 0.5) -> list:
    """[[bp_rp, abs_g], ...] of the Gaia stars around the field that have good parallaxes, brightest first."""
    adql = ("SELECT TOP 2500 source_id, parallax, phot_g_mean_mag, bp_rp FROM gaiadr3.gaia_source WHERE "
            f"CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.2f}, {dec:.2f}, {radius:.2f})) = 1 "
            "AND parallax_over_error > 8 AND bp_rp IS NOT NULL ORDER BY phot_g_mean_mag")

    def run():
        out = []
        for row in _gaia(adql):
            plx, g, c = (explorer._num(row.get(k)) for k in ("parallax", "phot_g_mean_mag", "bp_rp"))
            if plx and plx > 0 and g is not None and c is not None:
                out.append([round(c, 3), round(g + 5 * math.log10(plx / 100.0), 3)])
        return out
    return explorer._cached_json("cuhr", adql, TTL, run)


# ---------------------------------------------------------------- does it pulse?
def relative_brightness(points: list[dict]):
    """SPHEREx sees a different wavelength in every exposure, so a light curve of raw fluxes mostly shows
    the spectrum. Each point is divided by the usual brightness at its own wavelength (the median of
    its resolution-sized bin): 1 = usual. Returns arrays (mjd, ratio)."""
    edges = spectype.bin_edges()
    ok = [p for p in points if all(isinstance(p.get(k), (int, float)) and math.isfinite(p[k]) for k in ("mjd", "wavelength", "value"))]
    if not ok:
        return np.array([]), np.array([])
    t = np.array([p["mjd"] for p in ok])
    w = np.array([p["wavelength"] for p in ok])
    v = np.array([p["value"] for p in ok])
    which = np.searchsorted(edges, w, side="right") - 1
    keep, ratio = np.zeros(t.size, bool), np.zeros(t.size)
    for k in np.unique(which):
        mine = which == k
        med = float(np.median(v[mine]))
        if mine.sum() >= 4 and med > 0:
            keep |= mine
            ratio[mine] = v[mine] / med
    return t[keep], ratio[keep]


def period_search(points: list[dict]) -> dict:
    """Lomb-Scargle period of the relative light curve. {"ok": false, "reason"} if there is too little to go on."""
    from astropy.timeseries import LombScargle
    t, y = relative_brightness(points)
    if t.size < 30 or np.ptp(t) < 60:
        return {"ok": False, "reason": "too_few"}
    span = float(np.ptp(t))
    longest = min(PERIOD_RANGE_DAYS[1], 2 * span)
    ls = LombScargle(t, y - np.median(y))
    freq, power = ls.autopower(minimum_frequency=1 / longest, maximum_frequency=1 / PERIOD_RANGE_DAYS[0], samples_per_peak=12)
    best = int(np.argmax(power))
    period = float(1 / freq[best])
    # half-width of the peak at half its height: a rough error on the period
    above = power >= power[best] / 2
    lo = hi = best
    while lo > 0 and above[lo - 1]:
        lo -= 1
    while hi < len(power) - 1 and above[hi + 1]:
        hi += 1
    err = float(abs(1 / freq[lo] - 1 / freq[hi]) / 2)
    fap = float(ls.false_alarm_probability(power[best]))
    cycles = span / period
    step = max(1, len(freq) // 250)
    return {"ok": True, "period_d": round(period, 1), "err_d": round(err, 1), "power": round(float(power[best]), 4),
            "false_alarm": fap, "cycles": round(cycles, 2), "convincing": bool(fap < 0.001 and cycles >= 1.5), "n": int(t.size),
            "periodogram": [[round(float(1 / f), 2), round(float(p), 4)] for f, p in zip(freq[::step], power[::step])],
            "folded": [[round(float(((ti - t.min()) / period) % 1), 4), round(float(yi), 4)] for ti, yi in zip(t, y)]}


# ---------------------------------------------------------------- other catalogues
def parse_tsv(text: str) -> list[dict]:
    """Rows of a VizieR tab-separated answer (comment lines, then names, units, dashes, data)."""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    if len(lines) < 3 or not lines[2].startswith("-"):
        return []
    names = [n.strip() for n in lines[0].split("\t")]
    return [dict(zip(names, (v.strip() for v in ln.split("\t")))) for ln in lines[3:]]


def position_at(ra, dec, pmra, pmdec, mjd_from, year_to):
    """Where a star at (ra, dec) on mjd_from was (or will be) in year_to; pm in mas/yr."""
    dt = year_to - (2000.0 + (mjd_from - 51544.5) / 365.25)
    return (ra + (pmra or 0) * dt / 3.6e6 / math.cos(math.radians(dec))) % 360, dec + (pmdec or 0) * dt / 3.6e6


def cross_match(ra, dec, pmra=0.0, pmdec=0.0, mjd=51544.5, radius_arcsec=6.0) -> list[dict]:
    """The same star in 2MASS and AllWISE. A fast mover is looked for where it was when each survey
    observed it. Each survey: {"survey", "state": "found" | "none" | "unreachable", ...}."""
    out = []
    # a survey took years to cover the sky: a fast star may be two years of motion from where its
    # nominal epoch puts it
    radius_arcsec = min(40.0, radius_arcsec + 2 * math.hypot(pmra or 0, pmdec or 0) / 1000.0)
    for name, table, idcol, mags, epoch in SURVEYS:
        sra, sdec = position_at(ra, dec, pmra, pmdec, mjd, epoch)
        key = f"{table}:{sra:.5f}:{sdec:+.5f}:{radius_arcsec}"

        def run(table=table, idcol=idcol, mags=mags, sra=sra, sdec=sdec):
            r = explorer._get(VIZIER, {"-source": table, "-c": f"{sra:.6f} {sdec:+.6f}", "-c.rs": f"{radius_arcsec:.1f}",
                                       "-out": ",".join((idcol, "RAJ2000", "DEJ2000", *mags)), "-out.max": "5"},
                              timeout=TIMEOUT, tries=1)
            if not r.ok or "#" not in r.text[:200]:
                raise explorer.Upstream("VizieR unavailable")
            return parse_tsv(r.text)
        try:
            rows = explorer._cached_json("cuxmatch", key, TTL, run)
        except Exception:  # noqa: BLE001  (optional service)
            out.append({"survey": name, "state": "unreachable"})
            continue
        cosd = math.cos(math.radians(sdec))

        def apart(r, sra=sra, sdec=sdec, cosd=cosd):
            return math.hypot(((explorer._num(r.get("RAJ2000")) or 0) - sra) * cosd, (explorer._num(r.get("DEJ2000")) or 0) - sdec) * 3600
        best = min(rows, key=apart, default=None)
        if best is None:
            out.append({"survey": name, "state": "none"})
            continue
        out.append({"survey": name, "state": "found", "id": best.get(idcol, "").strip(), "sep_arcsec": round(apart(best), 2),
                    "epoch": epoch, "mags": {m.replace("mag", ""): explorer._num(best.get(m)) for m in mags}})
    return out
