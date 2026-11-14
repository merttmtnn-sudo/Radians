"""Find SPHEREx exposures covering a sky position (IRSA SIA2) and resolve target names (CDS Sesame)."""
from __future__ import annotations

import hashlib
import json
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass

import astropy.units as u
import requests
from astropy.coordinates import SkyCoord

from . import config


@dataclass
class Exposure:
    obs_id: str
    detector: int
    url: str
    mjd_start: float
    mjd_end: float
    wl_min: float        # micron
    wl_max: float
    exptime: float
    collection: str

    @property
    def mjd(self) -> float:
        return 0.5 * (self.mjd_start + self.mjd_end)


def _cache_path(kind, key):
    h = hashlib.sha1(key.encode()).hexdigest()[:16]
    p = config.CACHE_DIR / kind / f"{h}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p




class ArchiveUnavailable(ConnectionError):
    """IRSA did not answer (it returns 502 / 503 now and then); nothing cached to fall back on."""


def _sia_table(coll, ra, dec, tries=5):
    """One SIA2 query, straight to IRSA's query URL (no capabilities round trip, which fails on its own when IRSA
    is busy), retried with back-off on busy / gateway errors and dropped connections."""
    from astropy.io.votable import parse_single_table
    import io
    last = None
    for attempt in range(tries):
        try:
            r = requests.get(config.IRSA_SIA, params={"POS": f"CIRCLE {ra:.6f} {dec:.6f} 0.0002", "COLLECTION": coll},
                             timeout=60)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return parse_single_table(io.BytesIO(r.content)).to_table(use_names_over_ids=True)
        except (requests.RequestException, ValueError) as e:
            last = e
            if attempt < tries - 1:
                time.sleep(min(8.0, 1.0 * 2 ** attempt))
    raise ArchiveUnavailable(f"IRSA SIA ({coll}): {last}")


def _rows(t, coll):
    rows = []
    if len(t) == 0 or "access_url" not in t.colnames:
        return rows
    for row in t:
        if "dataproduct_subtype" in t.colnames and str(row["dataproduct_subtype"]) != "science":
            continue
        m = re.search(r"D(\d)", str(row["energy_bandpassname"]))
        rows.append(Exposure(
            obs_id=str(row["obs_id"]), detector=int(m.group(1)) if m else 0, url=str(row["access_url"]),
            mjd_start=float(row["t_min"]), mjd_end=float(row["t_max"]),
            wl_min=float(row["em_min"]) * 1e6, wl_max=float(row["em_max"]) * 1e6,
            exptime=float(row["t_exptime"]), collection=coll))
    return rows


def query_exposures(ra: float, dec: float) -> list[Exposure]:
    out: list[Exposure] = []
    for coll in config.COLLECTIONS:
        key = f"{coll}:{ra:.5f}:{dec:.5f}"
        path = _cache_path("sia", key)
        fresh = path.exists() and time.time() - path.stat().st_mtime < config.SIA_TTL_S
        if fresh:
            out += [Exposure(**e) for e in json.loads(path.read_text())]
            continue
        try:
            rows = _rows(_sia_table(coll, ra, dec), coll)
        except ArchiveUnavailable:
            if path.exists():                          # IRSA down: an older list is far better than nothing
                out += [Exposure(**e) for e in json.loads(path.read_text())]
                continue
            raise
        config.atomic_write(path, json.dumps([asdict(e) for e in rows]))
        out += rows
    # the same exposure can appear in two releases: keep the newest collection listed first
    seen, uniq = set(), []
    for e in out:
        if (e.obs_id, e.detector) not in seen:
            seen.add((e.obs_id, e.detector))
            uniq.append(e)
    return sorted(uniq, key=lambda e: e.mjd)


# ---------------------------------------------------------------- targets
def parse_coords(text: str):
    t = text.strip()
    # decimal commas ("269,45 4,69") vs a comma between the two numbers ("269.45, 4.69")
    if re.fullmatch(r"[+-]?\d+,\d+\s+[+-]?\d+,\d+", t):
        t = t.replace(",", ".")
    t = t.replace(",", " ")
    parts = t.split()
    try:
        if len(parts) == 2 and all(re.fullmatch(r"[+-]?\d+(\.\d*)?", p) for p in parts):
            ra, dec = float(parts[0]), float(parts[1])
        else:
            c = SkyCoord(t, unit=(u.hourangle, u.deg))
            ra, dec = c.ra.deg, c.dec.deg
    except Exception:
        return None
    if 0 <= ra < 360 and -90 <= dec <= 90:
        return ra, dec
    return None


def resolve(query: str) -> dict:
    """Coordinates (any common format) or an object name. Names also return proper motion."""
    c = parse_coords(query)
    if c:
        return {"name": None, "ra": c[0], "dec": c[1], "pmra": None, "pmdec": None, "source": "coordinates"}
    path = _cache_path("sesame", query.strip().lower())
    if path.exists():
        return json.loads(path.read_text())
    root, last = None, None
    for base in config.SESAME:
        try:
            r = requests.get(base + "?" + requests.utils.quote(query.strip()), timeout=12)
            r.raise_for_status()
            root = ET.fromstring(r.text)
            break
        except Exception as e:          # try the next mirror
            last = e
    if root is None:
        raise ConnectionError(f"all name resolvers failed: {last}")
    for res in root.iter("Resolver"):
        ra, dec = res.findtext("jradeg"), res.findtext("jdedeg")
        if ra and dec:
            def num(tag):
                v = res.findtext(".//" + tag)
                return float(v) if v not in (None, "") else None
            out = {"name": res.findtext("oname") or query, "ra": float(ra), "dec": float(dec),
                   "pmra": num("pmRA"), "pmdec": num("pmDE"), "source": res.get("name", "Sesame")}
            config.atomic_write(path, json.dumps(out))
            return out
    raise LookupError(f"'{query}' could not be resolved")


ALIAS_PREFIXES = ("HIP ", "HD ", "GJ ", "LHS ", "2MASS J", "Gaia DR3 ", "WISEA J", "TYC ", "BD", "IRAS ", "AAVSO ")


def details(name: str) -> dict | None:
    """Object type, spectral type, parallax, radial velocity and a few catalogue names (CDS Sesame / SIMBAD)."""
    key = name.strip().lower()
    path = _cache_path("sesamex", key)
    if path.exists():
        return json.loads(path.read_text())
    root = None
    for base in config.SESAME:
        try:
            r = requests.get(base.replace("/-oxp/", "/-oxpI/") + "?" + requests.utils.quote(name.strip()), timeout=12)
            r.raise_for_status()
            root = ET.fromstring(r.text)
            break
        except Exception:
            continue
    if root is None:
        return None
    for res in root.iter("Resolver"):
        if res.findtext("jradeg") is None:
            continue
        def num(tag):
            v = res.findtext(tag)
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
        aliases = [a.text for a in res.iter("alias") if a.text]
        picked = []
        for pre in ALIAS_PREFIXES:
            hit = next((a for a in aliases if a.startswith(pre)), None)
            if hit and hit not in picked:
                picked.append(hit)
        out = {"name": res.findtext("oname"), "otype": res.findtext("otype"), "sptype": res.findtext("spType"),
               "plx_mas": num("plx/v"), "plx_err": num("plx/e"), "rv_kms": num("Vel/v"),
               "pm_mas": num("pm/v"), "pm_pa": num("pm/pa"), "aliases": picked[:5], "n_aliases": len(aliases)}
        config.atomic_write(path, json.dumps(out))
        return out
    return None


def sky_context(ra: float, dec: float) -> dict:
    """Constellation, galactic and ecliptic coordinates of a position."""
    from astropy.coordinates import SkyCoord, get_constellation
    import astropy.units as u
    c = SkyCoord(ra * u.deg, dec * u.deg, frame="icrs")
    g = c.galactic
    e = c.barycentrictrueecliptic
    return {"constellation": str(get_constellation(c)).replace("Ophiucus", "Ophiuchus"), "con_abbr": str(get_constellation(c, short_name=True)),
            "l": float(g.l.deg), "b": float(g.b.deg), "elon": float(e.lon.deg), "elat": float(e.lat.deg)}
