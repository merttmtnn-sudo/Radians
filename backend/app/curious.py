"""The "for the curious" tools under the spectrum: where a star sits among its neighbours (H-R diagram),
how fast it crosses the sky, whether its light curve has a rhythm, and what other surveys list there.
Pure functions where possible; the catalogue lookups are cached on disk and say when a service is down."""
from __future__ import annotations

import math

import numpy as np

from . import net, pulse
from .external import GAIA_TAP

TTL = 30 * 86400
TIMEOUT = (6, 25)
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
    r = net.get(GAIA_TAP, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql},
                      timeout=TIMEOUT, tries=1)
    if not r.ok or "source_id" not in r.text.split("\n", 1)[0]:
        raise net.Upstream("Gaia unavailable")
    return net.rows(r.text)


# ---------------------------------------------------------------- one Gaia star: place in the H-R diagram, motion
def star_summary(row: dict) -> dict:
    """Colour, absolute magnitude, motion and speed of one Gaia row (values as text or numbers)."""
    n = lambda k: net.num(row.get(k))  # noqa: E731
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
    return net.cached_json("cugaia", adql, TTL, run)


def hr_field(ra: float, dec: float, radius: float = 0.5) -> list:
    """[[bp_rp, abs_g], ...] of the Gaia stars around the field that have good parallaxes, brightest first."""
    adql = ("SELECT TOP 2500 source_id, parallax, phot_g_mean_mag, bp_rp FROM gaiadr3.gaia_source WHERE "
            f"CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.2f}, {dec:.2f}, {radius:.2f})) = 1 "
            "AND parallax_over_error > 8 AND bp_rp IS NOT NULL ORDER BY phot_g_mean_mag")

    def run():
        out = []
        for row in _gaia(adql):
            plx, g, c = (net.num(row.get(k)) for k in ("parallax", "phot_g_mean_mag", "bp_rp"))
            if plx and plx > 0 and g is not None and c is not None:
                out.append([round(c, 3), round(g + 5 * math.log10(plx / 100.0), 3)])
        return out
    return net.cached_json("cuhr", adql, TTL, run)


# ---------------------------------------------------------------- does it pulse?
def relative_brightness(points: list[dict]):
    """SPHEREx sees a different wavelength in every exposure, so a light curve of raw fluxes mostly shows
    the spectrum. Each point is divided by the usual brightness at its own wavelength (the median of
    its resolution-sized bin): 1 = usual. Returns arrays (mjd, ratio) of the usable points (pulse.clean)."""
    c = pulse.clean(points)
    return c["t"], c["r"]


def period_search(points: list[dict], wings: bool = False) -> dict:
    """Did the brightness change between visits, and is there a rhythm? See app/pulse.py."""
    return pulse.analyse(points, wings)


# ---------------------------------------------------------------- is it a known variable star?
VSX_TABLE = "B/vsx/vsx"                 # AAVSO International Variable Star Index, as mirrored by VizieR
VSX_RADIUS_ARCSEC = 10.0


def vsx_star(ra: float, dec: float) -> dict:
    """The nearest VSX entry within 10 arcsec: {"found", "name", "type", "period_d", "max", "min", "sep_arcsec"}."""
    key = f"{VSX_TABLE}:{ra:.5f}:{dec:+.5f}"

    def run():
        r = net.get(VIZIER, {"-source": VSX_TABLE, "-c": f"{ra:.6f} {dec:+.6f}", "-c.rs": f"{VSX_RADIUS_ARCSEC:.0f}",
                                   "-out": "Name,RAJ2000,DEJ2000,Type,Period,max,min", "-out.max": "5"},
                          timeout=TIMEOUT, tries=1)
        if not r.ok or "#" not in r.text[:200]:
            raise net.Upstream("VizieR unavailable")
        return parse_tsv(r.text)
    rows = net.cached_json("cuvsx", key, TTL, run)
    cosd = math.cos(math.radians(dec))

    def apart(row):
        return math.hypot(((net.num(row.get("RAJ2000")) or 0) - ra) * cosd, (net.num(row.get("DEJ2000")) or 0) - dec) * 3600
    best = min(rows, key=apart, default=None)
    if best is None:
        return {"found": False}
    period = net.num(best.get("Period"))
    return {"found": True, "name": (best.get("Name") or "").strip(), "type": (best.get("Type") or "").strip() or None,
            "period_d": round(period, 3) if period and period > 0 else None,
            "max": net.num(best.get("max")), "min": net.num(best.get("min")), "sep_arcsec": round(apart(best), 1)}


GAIA_MAIN, GAIA_CLASSES = "I/355/gaiadr3", "I/358/vclassre"      # Gaia DR3 at VizieR: main table, variability classifier


def gaia_variable(source_id) -> dict:
    """Gaia DR3's own verdict on one source: {"found", "variable", "class", "score"}. `class` is the
    best class of Gaia's variability classifier (e.g. RR, DSCT|GDOR|SXPHE, LPV, ECL), if it has one.
    Asked from VizieR's copy of Gaia DR3, the same service as VSX, so the answer does not depend on
    the Gaia archive being up."""
    sid = str(source_id or "").replace("Gaia DR3", "").strip()
    if not sid.isdigit():
        return {"found": False}

    def table(source, cols):
        def run():
            r = net.get(VIZIER, {"-source": source, "Source": sid, "-out": cols, "-out.max": "1"}, timeout=TIMEOUT, tries=1)
            if not r.ok or "#" not in r.text[:200]:
                raise net.Upstream("VizieR unavailable")
            return parse_tsv(r.text)
        return net.cached_json("cugvar", f"{source}:{sid}", TTL, run)
    main = table(GAIA_MAIN, "Source,VarFlag")
    if not main:
        return {"found": False}
    classes = table(GAIA_CLASSES, "Source,Class,ClassSc")
    cls = (classes[0].get("Class") or "").strip() or None if classes else None
    score = net.num(classes[0].get("ClassSc")) if classes else None
    return {"found": True, "variable": (main[0].get("VarFlag") or "").strip().upper() == "VARIABLE" or cls is not None,
            "class": cls, "score": round(score, 2) if score is not None else None}


# ---------------------------------------------------------------- the star itself
GAIA_PARAMS = "I/355/paramp"                # Gaia DR3 astrophysical parameters (FLAME: radius, luminosity, mass, age)
EXOPLANETS = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
PLANET_RADIUS_DEG = 0.004                   # 14 arcsec around the star's Gaia position
NSS = {1: "astrometric", 2: "spectroscopic", 4: "eclipsing"}
RUWE_DOUBLE = 1.4                           # above this Gaia's single-star fit is poor: often an unseen companion


def _vizier_rows(source: str, params: dict, cols: str, kind: str, key: str) -> list[dict]:
    def run():
        r = net.get(VIZIER, {"-source": source, **params, "-out": cols, "-out.max": "1"}, timeout=TIMEOUT, tries=1)
        if not r.ok or "#" not in r.text[:200]:
            raise net.Upstream("VizieR unavailable")
        return parse_tsv(r.text)
    return net.cached_json(kind, f"{source}:{key}", TTL, run)


def star_facts(source_id) -> dict:
    """What Gaia DR3 knows about one star beyond its place in the H-R diagram: distance, speed
    along the line of sight and in space, where it will be in a thousand years, signs of a
    companion, and (where Gaia's FLAME module has them) radius, luminosity, mass and age.
    From VizieR's copy of Gaia DR3. {"found": False} if the source is unknown."""
    sid = str(source_id or "").replace("Gaia DR3", "").strip()
    if not sid.isdigit():
        return {"found": False}
    rows = _vizier_rows(GAIA_MAIN, {"Source": sid}, "Source,Plx,e_Plx,pmRA,pmDE,RV,e_RV,RUWE,Teff,logg,Dist,NSS,Dup", "cufacts", sid)
    if not rows:
        return {"found": False}
    n = lambda k: net.num(rows[0].get(k))  # noqa: E731
    plx, e_plx = n("Plx"), n("e_Plx")
    good = plx is not None and plx > 0 and e_plx and plx / e_plx >= 5
    dist_pc = 1000.0 / plx if good else n("Dist")
    pmra, pmdec = n("pmRA") or 0.0, n("pmDE") or 0.0
    rate = math.hypot(pmra, pmdec) / 1000.0                      # arcsec per year
    across = tangential_speed(rate, plx) if good else None
    rv = n("RV")
    nss = int(n("NSS") or 0)
    out = {"found": True, "id": sid, "distance_ly": round(dist_pc * 3.2616, 2) if dist_pc else None,
           "distance_from": "parallax" if good else ("model" if dist_pc else None),
           "rv_kms": round(rv, 1) if rv is not None else None, "rv_err": n("e_RV"),
           "across_kms": round(across, 1) if across is not None else None,
           "space_kms": round(math.hypot(across, rv), 1) if across is not None and rv is not None else None,
           "rate": round(rate, 4), "direction": compass(math.degrees(math.atan2(pmra, pmdec))) if rate > 0 else None,
           "in_1000yr_arcmin": round(rate * 1000 / 60, 2),
           "ruwe": n("RUWE"), "double_hint": bool((n("RUWE") or 0) > RUWE_DOUBLE),
           "binary": [name for bit, name in NSS.items() if nss & bit], "teff": n("Teff"), "logg": n("logg"),
           "radius_sun": None, "luminosity_sun": None, "mass_sun": None, "age_gyr": None}
    try:
        flame = _vizier_rows(GAIA_PARAMS, {"Source": sid}, "Source,Rad-Flame,Lum-Flame,Mass-Flame,Age-Flame", "cuflame", sid)
    except Exception:  # noqa: BLE001  (an extra: the facts above stand without it)
        flame = []
    if flame:
        f = lambda k: net.num(flame[0].get(k))  # noqa: E731
        out.update(radius_sun=f("Rad-Flame"), luminosity_sun=f("Lum-Flame"), mass_sun=f("Mass-Flame"), age_gyr=f("Age-Flame"))
    return out


def known_planets(ra: float, dec: float) -> dict:
    """Planets the NASA Exoplanet Archive lists around a star within 14 arcsec of (ra, dec):
    {"host", "planets": [{"name", "period_d", "mass_earth", "radius_earth", "year", "method"}]}."""
    adql = ("select pl_name,hostname,pl_orbper,pl_bmasse,pl_rade,disc_year,discoverymethod from pscomppars "
            f"where contains(point('icrs',ra,dec),circle('icrs',{ra:.5f},{dec:.5f},{PLANET_RADIUS_DEG}))=1 order by pl_orbper")

    def run():
        r = net.get(EXOPLANETS, {"query": adql, "format": "csv"}, timeout=TIMEOUT, tries=1)
        if not r.ok or not r.text.lstrip().startswith("pl_name"):
            raise net.Upstream("Exoplanet Archive unavailable")
        return net.rows(r.text)
    rows = net.cached_json("cuplanets", adql, TTL, run)
    planets = [{"name": (row.get("pl_name") or "").strip(), "period_d": net.num(row.get("pl_orbper")),
                "mass_earth": net.num(row.get("pl_bmasse")), "radius_earth": net.num(row.get("pl_rade")),
                "year": int(net.num(row.get("disc_year")) or 0) or None, "method": (row.get("discoverymethod") or "").strip() or None}
               for row in rows]
    return {"host": (rows[0].get("hostname") or "").strip() if rows else None, "planets": planets}


# ---------------------------------------------------------------- other catalogues
# Flux of a zero-magnitude star (Jy) and the band's wavelength (micron), to put catalogue magnitudes
# next to the SPHEREx spectrum: 2MASS (Cohen et al. 2003), WISE (Jarrett et al. 2011).
ZERO_POINTS = {"J": (1594.0, 1.235), "H": (1024.0, 1.662), "K": (666.7, 2.159),
               "W1": (309.54, 3.353), "W2": (171.787, 4.603), "W3": (31.674, 11.56), "W4": (8.363, 22.09)}


def band_fluxes(mags: dict) -> list[dict]:
    """[{"band", "um", "ujy"}] for the magnitudes of one survey (bands inside SPHEREx's range first)."""
    out = []
    for band, mag in (mags or {}).items():
        if band in ZERO_POINTS and isinstance(mag, (int, float)):
            f0, um = ZERO_POINTS[band]
            out.append({"band": band, "um": um, "ujy": f0 * 10 ** (-0.4 * mag) * 1e6})
    return out


def parse_tsv(text: str) -> list[dict]:
    """Rows of a VizieR tab-separated answer (comment lines, then names, units, dashes, data)."""
    lines = [ln for ln in text.splitlines() if not ln.startswith("#")]
    # the names are two lines above the dashes; the units line between is blank when no column has a unit
    dash = next((i for i, ln in enumerate(lines) if ln.startswith("-")), None)
    if dash is None or dash < 2:
        return []
    names = [n.strip() for n in lines[dash - 2].split("\t")]
    return [dict(zip(names, (v.strip() for v in ln.split("\t")))) for ln in lines[dash + 1:] if ln.strip()]


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
            r = net.get(VIZIER, {"-source": table, "-c": f"{sra:.6f} {sdec:+.6f}", "-c.rs": f"{radius_arcsec:.1f}",
                                       "-out": ",".join((idcol, "RAJ2000", "DEJ2000", *mags)), "-out.max": "5"},
                              timeout=TIMEOUT, tries=1)
            if not r.ok or "#" not in r.text[:200]:
                raise net.Upstream("VizieR unavailable")
            return parse_tsv(r.text)
        try:
            rows = net.cached_json("cuxmatch", key, TTL, run)
        except Exception:  # noqa: BLE001  (optional service)
            out.append({"survey": name, "state": "unreachable"})
            continue
        cosd = math.cos(math.radians(sdec))

        def apart(r, sra=sra, sdec=sdec, cosd=cosd):
            return math.hypot(((net.num(r.get("RAJ2000")) or 0) - sra) * cosd, (net.num(r.get("DEJ2000")) or 0) - sdec) * 3600
        best = min(rows, key=apart, default=None)
        if best is None:
            out.append({"survey": name, "state": "none"})
            continue
        found = {m.replace("mag", ""): net.num(best.get(m)) for m in mags}
        out.append({"survey": name, "state": "found", "id": best.get(idcol, "").strip(), "sep_arcsec": round(apart(best), 2),
                    "epoch": epoch, "mags": found, "fluxes": band_fluxes(found)})
    return out
