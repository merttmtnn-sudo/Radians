"""What the catalogues say about a star's type, to set next to our own fit of its SPHEREx spectrum:
SIMBAD's spectral type and Gaia DR3's temperature, gravity, metallicity, distance and star
probability. Each answers on its own; one being down is reported as {"ok": false}."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from . import archive, explorer
from .external import GAIA_TAP

TTL = 30 * 86400
TIMEOUT = (6, 20)
MATCH_DEG = 7 / 3600                 # about one SPHEREx pixel
SIMBAD_HOSTS = ("https://simbad.cds.unistra.fr", "https://simbad.cfa.harvard.edu")
GAIA_COLUMNS = ("teff_gspphot", "logg_gspphot", "mh_gspphot", "distance_gspphot", "parallax", "parallax_over_error",
                "classprob_dsc_combmod_star")
_pool = ThreadPoolExecutor(4)


def _clean(v):
    return (v or "").strip().strip('"').strip()


def simbad_type(ra, dec, name=None):
    """{"found", "id", "sptype", "otype"}: by name when the target has one (its catalogue position can be
    arcminutes from where a fast star is now), else the SIMBAD object closest to the position."""
    if name:
        d = archive.details(name)
        if d and d.get("name"):
            return {"found": True, "id": d["name"], "sptype": _clean(d.get("sptype")) or None, "otype": d.get("otype")}
    adql = ("SELECT TOP 20 main_id, sp_type, otype, ra, dec FROM basic WHERE "
            f"CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',{ra:.6f},{dec:.6f},{MATCH_DEG:.5f}))=1")

    def run():
        last = None
        for host in SIMBAD_HOSTS:
            try:
                r = explorer._get(host + "/simbad/sim-tap/sync",
                                  {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql},
                                  timeout=TIMEOUT, tries=1)
                if not r.ok or "main_id" not in r.text.split("\n", 1)[0]:
                    raise explorer.Upstream(host + " unavailable")
                rows = [x for x in explorer._csv(r.text) if _clean(x.get("otype")) != "Pl"
                        and explorer._num(x.get("ra")) is not None]
                if not rows:
                    return {"found": False}
                # the closest one; among equals, one that has a spectral type
                best = min(rows, key=lambda x: ((explorer._num(x["ra"]) - ra) ** 2 + (explorer._num(x["dec"]) - dec) ** 2,
                                                not _clean(x.get("sp_type"))))
                return {"found": True, "id": _clean(best.get("main_id")), "sptype": _clean(best.get("sp_type")) or None,
                        "otype": _clean(best.get("otype")) or None}
            except Exception as e:  # noqa: BLE001  (try the mirror)
                last = e
        raise explorer.Upstream(str(last or "SIMBAD unavailable"))
    return explorer._cached_json("tcsimbad", adql, TTL, run)


def gaia_params(source_id):
    """Gaia DR3 astrophysical parameters of one source (ESA archive)."""
    sid = str(source_id).replace("Gaia DR3", "").strip()
    if not sid.isdigit():
        return {"found": False}
    cols = ", ".join(f"s.{c}" for c in GAIA_COLUMNS)
    adql = (f"SELECT s.source_id, {cols}, a.spectraltype_esphs FROM gaiadr3.gaia_source AS s "
            f"LEFT JOIN gaiadr3.astrophysical_parameters AS a ON a.source_id = s.source_id WHERE s.source_id = {sid}")

    def run():
        r = explorer._get(GAIA_TAP, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql},
                          timeout=TIMEOUT, tries=1)
        if not r.ok or "source_id" not in r.text.split("\n", 1)[0]:
            raise explorer.Upstream("Gaia unavailable")
        rows = explorer._csv(r.text)
        if not rows:
            return {"found": False}
        row = rows[0]
        n = lambda k: explorer._num(row.get(k))  # noqa: E731
        plx = n("parallax")
        good_plx = plx is not None and plx > 0 and (n("parallax_over_error") or 0) >= 5
        dist = 1000 / plx if good_plx else n("distance_gspphot")
        return {"found": True, "id": sid, "teff": n("teff_gspphot"), "logg": n("logg_gspphot"), "mh": n("mh_gspphot"),
                "distance_pc": round(dist, 2) if dist else None, "parallax_mas": round(plx, 3) if plx is not None else None,
                "p_star": n("classprob_dsc_combmod_star"), "hot_type": _clean(row.get("spectraltype_esphs")) or None}
    return explorer._cached_json("tcgaia", adql, TTL, run)


def lookup(ra, dec, name=None, gaia_id=None):
    """{"simbad": {"ok", ...}, "gaia": {"ok", ...}}. gaia_id: the Gaia source the page matched to the spot
    (it has the Gaia stars of the field, moved to the image date); without one Gaia is "not found"."""
    def one(fn, *args):
        try:
            return {"ok": True, **fn(*args)}
        except Exception as e:  # noqa: BLE001  (optional services)
            return {"ok": False, "error": str(e)[:200]}
    s = _pool.submit(one, simbad_type, ra, dec, name)
    g = _pool.submit(one, gaia_params, gaia_id) if gaia_id else None
    return {"simbad": s.result(), "gaia": g.result() if g else {"ok": True, "found": False}}
