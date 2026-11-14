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




def query_exposures(ra: float, dec: float) -> list[Exposure]:
    out: list[Exposure] = []
    for coll in config.COLLECTIONS:
        key = f"{coll}:{ra:.5f}:{dec:.5f}"
        path = _cache_path("sia", key)
        if path.exists() and time.time() - path.stat().st_mtime < config.SIA_TTL_S:
            out += [Exposure(**e) for e in json.loads(path.read_text())]
            continue
        import pyvo
        t = pyvo.dal.SIA2Service(config.IRSA_SIA).search(
            pos=(ra, dec, 0.0002), collection=coll).to_table()
        rows = []
        for row in t:
            if str(row["dataproduct_subtype"]) != "science":
                continue
            m = re.search(r"D(\d)", str(row["energy_bandpassname"]))
            rows.append(Exposure(
                obs_id=str(row["obs_id"]), detector=int(m.group(1)) if m else 0, url=str(row["access_url"]),
                mjd_start=float(row["t_min"]), mjd_end=float(row["t_max"]),
                wl_min=float(row["em_min"]) * 1e6, wl_max=float(row["em_max"]) * 1e6,
                exptime=float(row["t_exptime"]), collection=coll))
        path.write_text(json.dumps([asdict(e) for e in rows]))
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
    t = text.strip().replace(",", " ")
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
    r = requests.get(config.SESAME + "?" + requests.utils.quote(query.strip()), timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    for res in root.iter("Resolver"):
        ra, dec = res.findtext("jradeg"), res.findtext("jdedeg")
        if ra and dec:
            def num(tag):
                v = res.findtext(".//" + tag)
                return float(v) if v not in (None, "") else None
            out = {"name": res.findtext("oname") or query, "ra": float(ra), "dec": float(dec),
                   "pmra": num("pmRA"), "pmdec": num("pmDE"), "source": res.get("name", "Sesame")}
            path.write_text(json.dumps(out))
            return out
    raise LookupError(f"'{query}' could not be resolved")
