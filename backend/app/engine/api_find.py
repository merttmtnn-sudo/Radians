"""The curated objects (challenge targets and famous sky): the list for the map and suggestions as you type."""
from __future__ import annotations

import json
import unicodedata
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Query

from . import sky
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
