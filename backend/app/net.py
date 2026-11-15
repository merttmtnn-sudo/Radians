"""Small shared helpers for talking to outside services (IRSA, CDS, VizieR, Gaia, the Exoplanet Archive):
a GET that retries when a server says it is busy, CSV parsing, and a JSON disk cache with a lifetime."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import threading
import time

import requests
import requests.adapters
from fastapi.responses import JSONResponse

from . import config

IRSA = "https://irsa.ipac.caltech.edu"
UA = {"User-Agent": "Radians/0.1 (NASA Space Apps 2026)"}


_session = None
_session_lock = threading.Lock()


def session() -> requests.Session:
    """One HTTP session for the whole server, so connections are kept open and used again. A new
    connection to IRSA costs about a second (TCP + TLS from Europe); a request on an open one about
    a quarter of that. The map's colour tiles need 3 to 12 small files each, so this matters most
    there."""
    global _session
    with _session_lock:
        if _session is None:
            s = requests.Session()
            s.headers.update(UA)
            adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=32)
            s.mount("https://", adapter)
            s.mount("http://", adapter)
            _session = s
    return _session


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
            r = session().get(url, params=params, timeout=timeout, stream=stream)
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
