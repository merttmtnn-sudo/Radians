"""Catalogue stars for overlays: Gaia DR3 through IRSA's TAP service, cached on disk for good
(Gaia DR3 does not change), and moved to any date with their proper motion."""
from __future__ import annotations

import csv
import io
import math
from pathlib import Path

from . import settings, sky, store
from .http import Http

IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
GAIA_EPOCH = 2016.0
GAIA_G_LIMIT = 19.5            # fainter stars rarely show in a SPHEREx stack
ESA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
SLOW_SERVICE_S = 30            # a catalogue that takes longer than this counts as unreachable


def _num(text, default=0.0):
    try:
        v = float(text)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def gaia_cone(http: Http, ra: float, dec: float, radius_deg: float, cache_dir: Path | None = None) -> list[dict]:
    """Gaia DR3 stars in a cone: [{id, ra, dec, pmra, pmdec, plx, g, epoch}] (brightest first).
    Asks ESA's Gaia archive first and IRSA's copy second (IRSA's cone search takes minutes in
    crowded fields). Raises IOError if neither answers in time."""
    path = Path(cache_dir or settings.DATA / "gaia") / f"{ra:.4f}_{dec:+.4f}_{radius_deg:.4f}.json"
    cached = store.read_json(path)
    if cached is not None:
        return cached
    where = (f"CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {radius_deg:.5f})) = 1 "
             f"AND phot_g_mean_mag < {GAIA_G_LIMIT} ORDER BY phot_g_mean_mag")
    columns = "source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag"
    services = [(ESA_TAP, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": f"SELECT TOP 3000 {columns} FROM gaiadr3.gaia_source WHERE {where}"}),
                (IRSA_TAP, {"QUERY": f"SELECT TOP 3000 {columns} FROM gaia_dr3_source WHERE {where}", "FORMAT": "CSV"})]
    problem = None
    for url, params in services:
        try:
            r = http.get(url, params=params, timeout=(8, SLOW_SERVICE_S), tries=1)
            text = r.text if hasattr(r, "text") else r.content.decode("utf-8", "replace")
            rows = _rows(text, "source_id")
        except Exception as err:  # noqa: BLE001  (try the other copy)
            problem = err
            continue
        stars = [dict(id=row["source_id"], ra=_num(row["ra"]), dec=_num(row["dec"]), pmra=_num(row["pmra"]),
                      pmdec=_num(row["pmdec"]), plx=max(0.0, _num(row["parallax"])), g=_num(row["phot_g_mean_mag"], 99.0),
                      epoch=GAIA_EPOCH) for row in rows]
        store.write_json(path, stars)
        return stars
    raise IOError(f"no Gaia service answered: {problem}")


def at_date(stars: list[dict], mjd: float) -> list[dict]:
    """The same stars with ra/dec moved to the date (proper motion only: parallax is tiny here)."""
    out = []
    for s in stars:
        ra, dec = sky.position_at(s, mjd, parallax=False)
        out.append(dict(s, ra=ra, dec=dec))
    return out


SIMBAD_TAP = "https://simbad.harvard.edu/simbad/sim-tap/sync"      # the CDS original is blocked on some networks
CATWISE_EPOCH = 2015.4         # MJD 57170, the reference date of CatWISE2020's motion fit
FAST_MAS_YR = 200.0


def _rows(text: str, first_column: str) -> list[dict]:
    if first_column not in text.split("\n", 1)[0]:
        raise IOError(f"unexpected catalogue answer: {text[:120]!r}")
    return list(csv.DictReader(io.StringIO(text)))


def _cached(path: Path, fetch, max_age_s: float | None = None):
    """fetch() with a disk cache. When the service fails, an old copy is better than nothing;
    with no copy at all the answer is None ("could not be checked")."""
    import time
    old = store.read_json(path)
    if old is not None and (max_age_s is None or time.time() - old["at"] < max_age_s):
        return old["rows"]
    try:
        rows = fetch()
    except Exception:  # noqa: BLE001  (network, format: the catalogue is optional)
        return old["rows"] if old is not None else None
    store.write_json(path, {"at": time.time(), "rows": rows})
    return rows


def catwise_cone(http: Http, ra: float, dec: float, radius_deg: float, cache_dir: Path | None = None):
    """CatWISE2020 sources with their motions (mas/yr), or None if the service can't be reached."""
    path = Path(cache_dir or settings.DATA / "catwise") / f"{ra:.4f}_{dec:+.4f}_{radius_deg:.4f}.json"

    def fetch():
        query = ("SELECT TOP 3000 source_name, ra_pm, dec_pm, pmra, pmdec, w1mpro, w2mpro FROM catwise_2020 "
                 f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {radius_deg:.5f})) = 1")
        r = http.get(IRSA_TAP, params={"QUERY": query, "FORMAT": "CSV"}, timeout=(8, SLOW_SERVICE_S), tries=1)
        return [dict(id=row["source_name"].strip(), ra=_num(row["ra_pm"]), dec=_num(row["dec_pm"]),
                     pmra=_num(row["pmra"]) * 1000, pmdec=_num(row["pmdec"]) * 1000, plx=0.0,
                     w1=_num(row["w1mpro"], 99.0), w2=_num(row["w2mpro"], 99.0), epoch=CATWISE_EPOCH)
                for row in _rows(r.text, "source_name")]
    return _cached(path, fetch)


def simbad_cone(http: Http, ra: float, dec: float, radius_deg: float, cache_dir: Path | None = None):
    """SIMBAD objects in the cone, plus fast-moving stars from a wider one (their catalogue position
    is for the year 2000 and can be arcminutes from where they are now). None if unreachable."""
    path = Path(cache_dir or settings.DATA / "simbad") / f"{ra:.4f}_{dec:+.4f}_{radius_deg:.4f}_v2.json"
    wide = max(radius_deg, 0.12)

    def fetch():
        circle = "CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {:.6f}, {:.6f}, {:.5f})) = 1"
        query = ("SELECT TOP 2000 main_id, otype, sp_type, ra, dec, pmra, pmdec, plx_value FROM basic WHERE "
                 + circle.format(ra, dec, wide) + " AND (" + circle.format(ra, dec, radius_deg)
                 + f" OR pmra * pmra + pmdec * pmdec > {FAST_MAS_YR ** 2:.0f})")
        r = http.get(SIMBAD_TAP, params={"request": "doQuery", "lang": "adql", "format": "csv", "query": query}, timeout=(8, SLOW_SERVICE_S), tries=1)
        return [dict(id=row["main_id"].strip().strip('"'), otype=(row.get("otype") or "").strip().strip('"'),
                     sp_type=(row.get("sp_type") or "").strip().strip('"') or None,
                     ra=_num(row["ra"]), dec=_num(row["dec"]), pmra=_num(row["pmra"]), pmdec=_num(row["pmdec"]),
                     plx=max(0.0, _num(row.get("plx_value"))), epoch=2000.0)
                for row in _rows(r.text, "main_id") if row.get("ra") and row.get("dec")]
    rows = _cached(path, fetch, max_age_s=7 * 86400)
    # planets share their star's position and would win the match by a hair: they are not what we see
    return rows if rows is None else [r for r in rows if r.get("otype") != "Pl"]


def matches(stars: list[dict], ra: float, dec: float, mjd: float, radius_arcsec: float) -> list[tuple[dict, float]]:
    """Catalogue entries within the radius of (ra, dec) once moved to the date, closest first."""
    found = []
    cosd = math.cos(math.radians(dec))
    for s in stars:
        if abs(s["dec"] - dec) > 0.3:          # cheap cut: nothing moves a quarter of a degree in 40 years
            continue
        sra, sdec = sky.position_at(s, mjd, parallax=False)
        sep = math.hypot(((sra - ra + 180) % 360 - 180) * cosd, sdec - dec) * 3600
        if sep <= radius_arcsec:
            found.append((s, sep))
    return sorted(found, key=lambda hit: hit[1])


def nearest(stars: list[dict], ra: float, dec: float, mjd: float, radius_arcsec: float):
    """The closest such entry as (entry, separation in arcsec), or None."""
    found = matches(stars, ra, dec, mjd, radius_arcsec)
    return found[0] if found else None


GAIA_PARAMS = ("teff_gspphot", "logg_gspphot", "mh_gspphot", "distance_gspphot", "parallax", "phot_g_mean_mag", "bp_rp",
               "classprob_dsc_combmod_star", "classprob_dsc_combmod_galaxy", "classprob_dsc_combmod_quasar")


def gaia_parameters(http: Http, source_id: str, cache_dir: Path | None = None) -> dict | None:
    """Gaia DR3 astrophysical parameters of one star (temperature, gravity, metallicity, hot-star
    spectral type, star/galaxy/quasar probabilities), from ESA's archive. None if unreachable."""
    if not str(source_id).isdigit():
        return None
    path = Path(cache_dir or settings.DATA / "gaia") / f"params_{source_id}.json"

    def fetch():
        columns = ", ".join(f"s.{c}" for c in GAIA_PARAMS)
        query = (f"SELECT s.source_id, {columns}, a.spectraltype_esphs, a.teff_esphs FROM gaiadr3.gaia_source AS s "
                 f"LEFT JOIN gaiadr3.astrophysical_parameters AS a ON a.source_id = s.source_id WHERE s.source_id = {source_id}")
        r = http.get(ESA_TAP, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query},
                     timeout=(8, SLOW_SERVICE_S), tries=1)
        rows = _rows(r.text, "source_id")
        if not rows:
            return [{}]
        row = rows[0]
        out = {c: (_num(row.get(c), None) if row.get(c) not in (None, "") else None) for c in (*GAIA_PARAMS, "teff_esphs")}
        out["spectraltype_esphs"] = (row.get("spectraltype_esphs") or "").strip().strip('"') or None
        return [out]
    rows = _cached(path, fetch)
    return (rows[0] or None) if rows else None
