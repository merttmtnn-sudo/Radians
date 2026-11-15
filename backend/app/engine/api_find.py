"""'Find things' endpoints: pins, search suggestions, name lookup and the fast coverage answer."""
from __future__ import annotations

import json
import unicodedata
from functools import lru_cache
from pathlib import Path

import requests
from fastapi import APIRouter, HTTPException, Query

from . import settings, sia, sky, stacking
from .field import iso_date, snap
from .http import Http

router = APIRouter(prefix="/api")
HTTP = Http()
PINS_FILE = Path(__file__).parent / "data" / "pins.json"


def fold(text: str) -> str:
    """Lower case without accents or punctuation, so 'Barnard's', 'barnards' and 'BARNARD' match,
    and Turkish letters match their plain forms (ü -> u, ş -> s, ı -> i)."""
    text = text.replace("ı", "i").replace("İ", "i")
    plain = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return " ".join("".join(ch if ch.isalnum() else " " for ch in plain.lower()).split())


@lru_cache(maxsize=1)
def pins() -> list[dict]:
    out = []
    for p in json.loads(PINS_FILE.read_text(encoding="utf-8")):
        ra_now, dec_now = sky.position_now(p)
        out.append(dict(p, ra_now=round(ra_now, 6), dec_now=round(dec_now, 6),
                        keys=[fold(k) for k in [p["name_en"], p["name_tr"], p["main_id"] or "", *p["aliases"]]]))
    return out


def public(p: dict) -> dict:
    return {k: v for k, v in p.items() if k not in ("keys", "lookup", "aliases")}


@router.get("/pins")
def get_pins():
    return [public(p) for p in pins()]


@router.get("/search")
def search(q: str = Query(..., min_length=1, max_length=100), limit: int = Query(8, ge=1, le=20)):
    """Suggestions as you type, from the curated objects: words that start the same come first."""
    want = fold(q)
    if not want:
        return []
    scored = []
    for p in pins():
        best = None
        for key in p["keys"]:
            if key == want:
                best = 0
            elif key.startswith(want):
                best = min(best if best is not None else 9, 1)
            elif any(word.startswith(want) for word in key.split()):
                best = min(best if best is not None else 9, 2)
            elif want in key.replace(" ", ""):
                best = min(best if best is not None else 9, 3)
        if best is not None:
            scored.append((best, p["name_en"], p))
    return [dict(public(p), match=s) for s, _, p in sorted(scored, key=lambda t: (t[0], t[1]))[:limit]]


@router.get("/resolve")
def resolve(name: str = Query(..., min_length=1, max_length=100)):
    """Any object name -> position today (proper motion applied). Curated objects answer at once."""
    want = fold(name)
    for p in pins():
        if want in p["keys"]:
            return dict(public(p), source="pins")
    try:
        r = sky.resolve(name, HTTP)
    except LookupError:
        raise HTTPException(404, f"No object called “{name}” is known.") from None
    except sky.ResolverDown:
        raise HTTPException(503, "The name lookup service can't be reached right now. Try coordinates instead.") from None
    ra_now, dec_now = sky.position_now(r)
    return dict(r, ra_now=round(ra_now, 6), dec_now=round(dec_now, 6), source="sesame",
                moving=abs(r["pmra"]) + abs(r["pmdec"]) > 500)


@router.get("/coverage")
def coverage(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)):
    """How SPHEREx covered a spot: exposures, sky passes and bands (archive search only, no pixels)."""
    ra_s, dec_s = snap(ra, dec)
    try:
        exps = sia.exposures(HTTP, ra_s, dec_s, settings.DATA / "sia")
    except (requests.RequestException, OSError, ValueError):
        raise HTTPException(503, "The SPHEREx archive can't be reached right now.") from None
    per_band = {str(b): 0 for b in range(1, 7)}
    for e in exps:
        per_band[str(e["det"])] = per_band.get(str(e["det"]), 0) + 1
    groups = stacking.group_passes([e["mjd"] for e in exps], max_span=0) if exps else []
    passes = [dict(start=iso_date(exps[g[0]]["mjd"]), end=iso_date(exps[g[-1]]["mjd"]), n=len(g)) for g in groups]
    return dict(ra=ra_s, dec=dec_s, n_exposures=len(exps), first_date=passes[0]["start"] if passes else None,
                last_date=passes[-1]["end"] if passes else None, passes=passes, per_band=per_band,
                deep=any(e["deep"] for e in exps), releases=sorted({e["collection"] for e in exps}))
