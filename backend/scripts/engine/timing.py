"""Measure where the time goes when Skyshift builds a view from the live archive.

Usage (from backend/):  ..\\.venv\\Scripts\\python -X utf8 scripts/timing.py "eps Indi B" --band 5 --quality preview
                        ..\\.venv\\Scripts\\python -X utf8 scripts/timing.py --ra 133.79 --dec -7.24 --band 5
Prints the SIA query time, how many exposures cover the spot, fetch time, requests, bytes,
resample time, and then the same build again from the disk cache.
"""
from __future__ import annotations

import argparse
import math
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.engine import settings, sia  # noqa: E402
from app.engine.field import CutoutCache, build_band  # noqa: E402
from app.engine.fitsread import Reader  # noqa: E402
from app.engine.http import Http  # noqa: E402

SESAME = "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/S?"


def resolve_now(http: Http, name: str, year: float = 2026.0):
    """Position of a named object moved to `year` with its proper motion (no parallax)."""
    import urllib.parse
    x = http.get(SESAME + urllib.parse.quote(name)).text

    def tag(t, default=0.0):
        m = re.search(rf"<{t}>([^<]+)</{t}>", x)
        return float(m.group(1)) if m else default

    ra, dec = tag("jradeg", None), tag("jdedeg", None)
    if ra is None:
        raise SystemExit(f"name not found: {name}")
    dt = year - 2000.0
    dec2 = dec + tag("pmDE") / 3.6e6 * dt
    ra2 = ra + tag("pmRA") / 3.6e6 * dt / math.cos(math.radians(dec))
    return ra2 % 360, dec2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", nargs="?")
    ap.add_argument("--ra", type=float)
    ap.add_argument("--dec", type=float)
    ap.add_argument("--band", type=int, default=5)
    ap.add_argument("--size", type=float, default=4.0)
    ap.add_argument("--quality", choices=["preview", "standard", "full"], default="preview")
    a = ap.parse_args()
    http = Http()
    ra, dec = (a.ra, a.dec) if a.name is None else resolve_now(http, a.name)
    print(f"position {ra:.5f} {dec:+.5f}  band D{a.band}  field {a.size}'  quality {a.quality}")
    t = time.time()
    exps = sia.exposures(http, ra, dec, ttl_hours=0)
    mine = [e for e in exps if e["det"] == a.band]
    print(f"SIA: {time.time() - t:.2f}s, {len(exps)} exposures in all bands, {len(mine)} in D{a.band}")
    cache = CutoutCache(Reader(http), settings.DATA / "cutouts")
    for label in ("cold", "cached"):
        r0, b0 = http.stats.requests, http.stats.bytes
        res = build_band(cache, exps, ra, dec, a.band, a.size, a.quality)
        tm = res["timing"]
        print(f"{label:>6}: total {tm['total_s']:.2f}s (fetch {tm['fetch_s']:.2f}s, resample {tm['resample_s']:.2f}s), "
              f"{tm['n_used']}/{tm['n_requested']} exposures, {http.stats.requests - r0} requests, "
              f"{(http.stats.bytes - b0) / 1e6:.2f} MB, retries so far {http.stats.retries}")
    for p in res["passes"]:
        print(f"  pass {p['index'] + 1}: {p['start']}..{p['end']}  frames {p['n_used']}/{p['n_frames']}  "
              f"wave {p['wave_um']}  saturated {p['saturated_fraction']:.3f}")
    for w in res["warnings"]:
        print("  warning:", w)
    for e in res["errors"][:5]:
        print("  error:", e)


if __name__ == "__main__":
    main()
