"""Names to positions, and positions moved through time.

Name lookups go to CDS Sesame through the Harvard mirror (CDS itself is unreachable from some
networks). Positions come back at epoch J2000 with proper motion and parallax; `position_at`
moves them to any date, so a star found by name is shown where it is today, not where it was.
"""
from __future__ import annotations

import math
import re
import time
import urllib.parse
from functools import lru_cache

from astropy.coordinates import get_body_barycentric
from astropy.time import Time

from .http import Http

SESAME_URLS = (
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/S?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S?",
)


class ResolverDown(RuntimeError):
    """No name resolver answered."""


def parse_sesame(xml: str) -> dict | None:
    """Position, motion and parallax from a Sesame XML answer, or None if the name is unknown."""
    if "<jradeg>" not in xml:
        return None

    def first(tag: str, default=None):
        m = re.search(rf"<{tag}>\s*([^<]+?)\s*</{tag}>", xml)
        return m.group(1) if m else default

    plx = re.search(r"<plx>\s*<v>\s*([^<]+?)\s*</v>", xml)
    return dict(main_id=first("oname"), otype=first("otype"), ra=float(first("jradeg")), dec=float(first("jdedeg")),
                pmra=float(first("pmRA", 0.0)), pmdec=float(first("pmDE", 0.0)),
                plx=max(0.0, float(plx.group(1))) if plx else 0.0,       # negative parallax = too far to measure
                epoch=2000.0)


@lru_cache(maxsize=512)
def _resolve_cached(name: str, http: Http) -> dict:
    reached = False
    for base in SESAME_URLS:
        try:
            r = http.get(base + urllib.parse.quote(name), timeout=(6, 20))
        except Exception:  # noqa: BLE001  (try the other mirror)
            continue
        text = r.text if hasattr(r, "text") else r.content.decode("utf-8", "replace")
        if "<Sesame" not in text[:3000]:
            continue                                    # an error page is not an answer
        reached = True
        found = parse_sesame(text)
        if found:
            return dict(found, name=name)
    if reached:
        raise LookupError(f"no object called {name!r} is known")
    raise ResolverDown("the name resolver could not be reached")


def resolve(name: str, http: Http) -> dict:
    return _resolve_cached(name.strip(), http)


def jyear(mjd: float) -> float:
    return 2000.0 + (mjd - 51544.5) / 365.25


def now_mjd() -> float:
    return time.time() / 86400.0 + 40587.0


def position_at(obj: dict, mjd: float, parallax: bool = True) -> tuple[float, float]:
    """(ra, dec) in degrees at the date: linear proper motion (pmra includes cos dec, mas/yr) from
    the catalogue epoch, plus the parallax shift seen from Earth. Good to a few tenths of an
    arcsec over the SPHEREx mission."""
    years = jyear(mjd) - float(obj.get("epoch", 2000.0))
    dec0 = float(obj["dec"])
    dec = dec0 + float(obj.get("pmdec", 0.0)) * years / 3.6e6
    ra = float(obj["ra"]) + float(obj.get("pmra", 0.0)) * years / 3.6e6 / math.cos(math.radians(dec0))
    plx = float(obj.get("plx", 0.0) or 0.0)
    if parallax and plx > 0:
        earth = get_body_barycentric("earth", Time(mjd, format="mjd"))
        X, Y, Z = (float(c.to_value("au")) for c in (earth.x, earth.y, earth.z))
        a, d = math.radians(ra), math.radians(dec)
        ra += plx * (X * math.sin(a) - Y * math.cos(a)) / 3.6e6 / math.cos(d)
        dec += plx * (X * math.cos(a) * math.sin(d) + Y * math.sin(a) * math.sin(d) - Z * math.cos(d)) / 3.6e6
    return ra % 360.0, dec


def position_now(obj: dict) -> tuple[float, float]:
    """Where the object is today (no parallax: the map centre should not wobble)."""
    return position_at(obj, now_mjd(), parallax=False)
