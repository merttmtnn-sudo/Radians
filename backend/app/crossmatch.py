"""Catalogues a candidate is checked against besides Gaia DR3: SIMBAD (CDS, Harvard mirror) and
CatWISE2020 (IRSA). Each one answers on its own: a catalogue that cannot be reached is reported
as {"ok": false}, so the page can say "could not check" instead of calling a known star new."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from . import net

TTL = 30 * 86400
TIMEOUT = (6, 25)            # connect, read: a catalogue slower than this counts as unreachable
FAST_MAS_YR = 200.0          # SIMBAD positions are for 2000: fast stars are looked for in a wider cone
WIDE_DEG = 0.12              # 20"/yr over 27 years is about 0.15 deg; 0.12 covers every known star but a few
SIMBAD_HOSTS = ("https://simbad.cds.unistra.fr", "https://simbad.cfa.harvard.edu")
IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"

_pool = ThreadPoolExecutor(4)


def _circle(ra, dec, r):
    return f"CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',{ra:.6f},{dec:.6f},{r:.5f}))=1"


def _clean(v):
    return (v or "").strip().strip('"').strip()


def simbad(ra, dec, radius):
    """SIMBAD objects in the cone, plus fast-moving stars from a wider one (they are listed where they
    were in 2000). Rows: {id, type, ra, dec, pmra, pmdec (mas/yr), epoch}."""
    wide = max(radius, WIDE_DEG)
    adql = ("SELECT TOP 2000 main_id, otype, ra, dec, pmra, pmdec FROM basic WHERE "
            f"{_circle(ra, dec, wide)} AND ({_circle(ra, dec, radius)} "
            f"OR pmra*pmra + pmdec*pmdec > {FAST_MAS_YR ** 2:.0f}) ORDER BY nbref DESC")

    def run():
        last = None
        for host in SIMBAD_HOSTS:
            try:
                r = net.get(host + "/simbad/sim-tap/sync",
                                  {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql},
                                  timeout=TIMEOUT, tries=1)
                if not r.ok or "main_id" not in r.text.split("\n", 1)[0]:
                    raise net.Upstream(host + " unavailable")
                rows = []
                for x in net.rows(r.text):
                    pra, pdec = net.num(x.get("ra")), net.num(x.get("dec"))
                    otype = _clean(x.get("otype"))
                    # a planet shares its star's position and is not what the image shows
                    if pra is None or pdec is None or otype == "Pl":
                        continue
                    rows.append({"id": _clean(x.get("main_id")), "type": otype, "ra": pra, "dec": pdec,
                                 "pmra": net.num(x.get("pmra")) or 0, "pmdec": net.num(x.get("pmdec")) or 0,
                                 "epoch": 2000.0})
                return rows
            except Exception as e:  # noqa: BLE001  (try the mirror)
                last = e
        raise net.Upstream(str(last or "SIMBAD unavailable"))
    return net.cached_json("xmsimbad", adql, TTL, run)


def catwise(ra, dec, radius):
    """CatWISE2020 sources in the cone. Rows: {id, ra, dec, pmra, pmdec (mas/yr), mag (W1), epoch}."""
    adql = ("SELECT TOP 4000 source_name, ra, dec, pmra, pmdec, w1mpro, meanobsmjd FROM catwise_2020 WHERE "
            + _circle(ra, dec, radius))

    def run():
        r = net.get(IRSA_TAP, {"LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}, timeout=TIMEOUT, tries=1)
        if not r.ok or "source_name" not in r.text.split("\n", 1)[0]:
            raise net.Upstream("CatWISE2020 unavailable")
        rows = []
        for x in net.rows(r.text):
            pra, pdec = net.num(x.get("ra")), net.num(x.get("dec"))
            if pra is None or pdec is None:
                continue
            mjd = net.num(x.get("meanobsmjd")) or 57170.0
            rows.append({"id": "CatWISE2020 " + _clean(x.get("source_name")), "ra": pra, "dec": pdec,
                         "pmra": (net.num(x.get("pmra")) or 0) * 1000,       # arcsec/yr in the catalogue
                         "pmdec": (net.num(x.get("pmdec")) or 0) * 1000,
                         "mag": net.num(x.get("w1mpro")), "epoch": round(2000 + (mjd - 51544.5) / 365.25, 3)})
        return rows
    return net.cached_json("xmcatwise", adql, TTL, run)


CATALOGUES = {"simbad": simbad, "catwise": catwise}


def crossmatch(ra, dec, radius, only=None):
    """{"simbad": {"ok", "rows"}, "catwise": {"ok", "rows"}}, or just the one named by `only` (the page
    asks for each on its own, so a slow catalogue does not hold back a fast one). Never raises for a
    catalogue that is down."""
    def one(fn):
        try:
            return {"ok": True, "rows": fn(ra, dec, radius)}
        except Exception as e:  # noqa: BLE001  (optional services)
            return {"ok": False, "rows": [], "error": str(e)[:200]}
    jobs = {name: _pool.submit(one, fn) for name, fn in CATALOGUES.items() if only in (None, name)}
    return {name: job.result() for name, job in jobs.items()}
