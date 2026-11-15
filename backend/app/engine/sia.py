"""Which SPHEREx exposures cover a sky position (IRSA SIA2), cached with a time-to-live.

One query over the whole SPHEREx facility picks up every current release (DR1, QR3, the deep
fields) and any new weekly QR3 data, with no hard-coded file lists.
"""
from __future__ import annotations

import csv
import hashlib
import io
import time
from pathlib import Path

import requests

from . import settings, store
from .http import Http

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
COVER_RADIUS_DEG = 0.003     # we want images that contain the point, not ones that merely touch a cone
LIST_VERSION = 2             # cached lists older than this lack the footprints: they are asked again


def parse_sia_csv(text: str) -> list[dict]:
    """Science (level-2) exposures from an SIA CSV answer, one per (obs_id, detector), sorted by
    time. Raises ValueError if the answer is not an SIA table (an error page is not 'no data')."""
    first = text.lstrip()[:4000].split("\n", 1)[0]
    if "obs_id" not in first or "access_url" not in first:
        raise ValueError(f"unexpected answer from the SPHEREx image search: {text[:120]!r}")
    best: dict[tuple, dict] = {}
    for row in csv.DictReader(io.StringIO(text)):
        coll = (row.get("obs_collection") or "").strip()
        if not coll.startswith("spherex") or coll.endswith("_cube"):
            continue
        if (row.get("dataproduct_subtype") or "").strip() != "science" or str(row.get("calib_level")).strip() != "2":
            continue
        band = (row.get("energy_bandpassname") or "").strip()
        if not band[-1:].isdigit():
            continue
        det = int(band[-1])
        e = dict(obs_id=row["obs_id"].strip(), det=det, url=row["access_url"].strip(), collection=coll,
                 mjd=float(row["t_min"]), size_kb=float(row.get("access_estsize") or 0),
                 deep=coll.endswith("_deep"), region=parse_region(row.get("s_region")))
        key = (e["obs_id"], det)
        # the same exposure can be listed by more than one release: keep the newest release
        if key not in best or _release_rank(coll) > _release_rank(best[key]["collection"]):
            best[key] = e
    return sorted(best.values(), key=lambda e: (e["mjd"], e["det"]))


def parse_region(text) -> list[float] | None:
    """The four corners of an exposure's sky footprint, [ra1, dec1, ... ra4, dec4] in degrees, from
    the s_region column ("POLYGON ICRS ra dec ra dec ..."), or None. The reader uses it to guess
    where a position falls on the detector before it has read the file's header."""
    nums = []
    for word in str(text or "").replace("(", " ").replace(")", " ").replace(",", " ").split():
        try:
            nums.append(float(word))
        except ValueError:
            continue
    return [round(v, 7) for v in nums[:8]] if len(nums) >= 8 else None


def _release_rank(coll: str) -> int:
    order = ("qr1", "qr2", "qr3", "dr1", "qr4", "dr2")
    for i, tag in enumerate(order):
        if tag in coll:
            return i
    return -1


def query(http: Http, ra: float, dec: float, radius: float = COVER_RADIUS_DEG) -> list[dict]:
    r = http.get(SIA_URL, params={"POS": f"circle {ra:.6f} {dec:.6f} {radius}", "FACILITY": "SPHEREx",
                                  "RESPONSEFORMAT": "CSV", "MAXREC": 200000}, timeout=(10, 120))
    return parse_sia_csv(r.text if hasattr(r, "text") else r.content.decode("utf-8", "replace"))


def cache_key(ra: float, dec: float) -> str:
    return hashlib.sha1(f"{ra:.4f},{dec:.4f}".encode()).hexdigest()[:16]


def is_fresh(ra: float, dec: float, cache_dir: Path | None = None, ttl_hours: float = settings.SIA_TTL_HOURS) -> bool:
    """True if exposures() would answer from its cache, without asking the archive."""
    cached = store.read_json(Path(cache_dir or settings.DATA / "sia") / f"{cache_key(ra, dec)}.json")
    return bool(cached and cached.get("v") == LIST_VERSION and time.time() - cached.get("at", 0) < ttl_hours * 3600)


def exposures(http: Http, ra: float, dec: float, cache_dir: Path | None = None,
              ttl_hours: float = settings.SIA_TTL_HOURS) -> list[dict]:
    """Cached query(). After ttl_hours the archive is asked again so new data appears; if it can't
    be reached, the old list is used."""
    path = Path(cache_dir or settings.DATA / "sia") / f"{cache_key(ra, dec)}.json"
    cached = store.read_json(path)
    if cached and cached.get("v") == LIST_VERSION and time.time() - cached.get("at", 0) < ttl_hours * 3600:
        return cached["exposures"]
    try:
        exps = query(http, ra, dec)
    except (requests.RequestException, OSError, ValueError):
        if cached:
            return cached["exposures"]
        raise
    store.write_json(path, {"v": LIST_VERSION, "at": time.time(), "ra": ra, "dec": dec, "exposures": exps})
    return exps


def group_by_band(exps: list[dict]) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {d: [] for d in range(1, 7)}
    for e in exps:
        out.setdefault(e["det"], []).append(e)
    return out
