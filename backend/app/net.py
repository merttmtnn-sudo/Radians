"""Small shared helpers for talking to outside services (IRSA, CDS, VizieR, Gaia, the Exoplanet Archive):
a GET that retries when a server says it is busy, CSV parsing, and a JSON disk cache with a lifetime."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import time

import requests
from fastapi.responses import JSONResponse

from . import config

IRSA = "https://irsa.ipac.caltech.edu"
UA = {"User-Agent": "Radians/0.1 (NASA Space Apps 2026)"}


class Upstream(ConnectionError):
    """An outside service could not be reached or answered with an error."""


def err(msg, code=502):
    return JSONResponse({"error": msg}, status_code=code, headers={"Cache-Control": "no-store"})


def key(s):
    return hashlib.sha1(s.encode()).hexdigest()


def cached_json(kind, name, ttl, fn):
    """fn()'s JSON-able answer, kept on disk under CACHE_DIR/kind for ttl seconds. None is never stored."""
    p = config.CACHE_DIR / kind / (key(name)[:24] + ".json")
    try:
        if time.time() - p.stat().st_mtime < ttl:
            return json.loads(p.read_text())
    except OSError:
        pass
    out = fn()
    if out is not None:
        config.atomic_write(p, json.dumps(out))
    return out


def get(url, params=None, timeout=60, tries=4, stream=False):
    """GET with retries: IRSA answers 429/502/503/504 ("server busy") now and then."""
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout, stream=stream)
            if r.status_code in (429, 502, 503, 504):
                last = Upstream(f"HTTP {r.status_code}")
                r.close()
            else:
                return r
        except requests.RequestException as e:
            last = e
        time.sleep(min(1.5 * 2 ** i, 12))
    raise Upstream(str(last))


def rows(text):
    return list(csv.DictReader(io.StringIO(text)))


def num(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None
