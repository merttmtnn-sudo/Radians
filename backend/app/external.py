"""Catalogues drawn over the SPHEREx pictures: Gaia DR3 (ESA) and known Solar System objects
(IMCCE SkyBoT)."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor

import astropy.units as u
import requests
from astropy.coordinates import Angle

from . import config

GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
SKYBOT = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
UA = {"User-Agent": "Radians/0.1 (NASA Space Apps 2026)"}


def _cached(kind, key, ttl, fn):
    p = config.CACHE_DIR / kind / (hashlib.sha1(key.encode()).hexdigest()[:20] + ".json")
    if p.exists() and time.time() - p.stat().st_mtime < ttl:
        return json.loads(p.read_text())
    out = fn()
    p.parent.mkdir(parents=True, exist_ok=True)
    config.atomic_write(p, json.dumps(out))
    return out


def _tap_csv(url, adql, timeout=60):
    r = requests.get(url, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
                                  "RESPONSEFORMAT": "csv", "QUERY": adql}, headers=UA, timeout=timeout)
    r.raise_for_status()
    return list(csv.DictReader(io.StringIO(r.text)))


def _f(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- Gaia DR3
def gaia(ra: float, dec: float, radius: float, gmax: float = 19.0, limit: int = 1500):
    """Gaia DR3 sources (epoch 2016.0) in a cone. The cone is padded so stars with large proper
    motion that have moved into the field since 2016 are included."""
    r = radius + 0.04
    adql = (f"SELECT TOP {limit} source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, bp_rp "
            f"FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra:.6f},{dec:.6f},{r:.5f})) "
            f"AND phot_g_mean_mag < {gmax} ORDER BY phot_g_mean_mag")

    def run():
        rows = _tap_csv(GAIA_TAP, adql)
        return [{"id": row["source_id"], "ra": _f(row["ra"]), "dec": _f(row["dec"]), "pmra": _f(row["pmra"]),
                 "pmdec": _f(row["pmdec"]), "plx": _f(row["parallax"]), "g": _f(row["phot_g_mean_mag"]),
                 "bp_rp": _f(row["bp_rp"])} for row in rows]
    return {"epoch": 2016.0, "sources": _cached("gaia", f"{ra:.4f}:{dec:.4f}:{r:.4f}:{gmax}", 30 * 86400, run)}


# ---------------------------------------------------------------- SkyBoT
def _skybot_one(ra, dec, radius_arcsec, mjd):
    jd = mjd + 2400000.5
    params = {"-ep": f"{jd:.5f}", "-ra": f"{ra:.6f}", "-dec": f"{dec:.6f}", "-rs": f"{radius_arcsec:.0f}",
              "-mime": "json", "-output": "basic", "-observer": "500", "-filter": "120", "-objFilter": "111",
              "-refsys": "EQJ2000", "-from": "Radians"}

    def run():
        r = requests.get(SKYBOT, params=params, headers=UA, timeout=40)
        r.raise_for_status()
        try:
            rows = r.json()
        except ValueError:            # SkyBoT answers with plain text when the field is empty
            return []
        out = []
        for row in rows if isinstance(rows, list) else []:
            try:
                ra_d = Angle(row["RA (hms)"], unit=u.hourangle).deg
                dec_d = Angle(row["DEC (dms)"], unit=u.deg).deg
            except Exception:
                continue
            out.append({"name": row.get("Name"), "class": row.get("Class"), "ra": ra_d, "dec": dec_d,
                        "vmag": _f(row.get("VMag (mag)")), "err_arcsec": _f(row.get("Err (arcsec)")),
                        "dra_arcsec_h": _f(row.get("dRA (arcsec/h)")), "ddec_arcsec_h": _f(row.get("dDEC (arcsec/h)"))})
        return out
    return _cached("skybot", json.dumps(params, sort_keys=True), 365 * 86400, run)


def skybot(ra: float, dec: float, radius_arcsec: float, mjds: list[float]):
    """Known asteroids and comets in the field at each requested time (geocentric; SPHEREx's low
    orbit shifts main-belt objects by well under a pixel)."""
    mjds = [round(m, 3) for m in mjds][:40]
    with ThreadPoolExecutor(8) as pool:
        res = list(pool.map(lambda m: _skybot_one(ra, dec, radius_arcsec, m), mjds))
    return [{"mjd": m, "objects": r} for m, r in zip(mjds, res)]
