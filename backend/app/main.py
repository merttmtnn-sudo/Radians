"""HTTP API. Every view is addressable by URL, e.g.
/api/frames?ra=133.7951&dec=-7.2451&fov=300&mode=epoch
"""
from __future__ import annotations

import math
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import archive, config, detect, external, stack

app = FastAPI(title="Radians", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

# ---------------------------------------------------------------- fair sharing of one server
_hits: dict = {}
_hits_lock = threading.Lock()
LIMITS = {"/api/frames": config.RATE_FRAMES, "/api/photometry": config.RATE_PHOT}


def _client(request: Request) -> str:
    """Visitor address for rate limiting. A visitor can put anything at the left of X-Forwarded-For;
    the hosting proxy appends the address it actually saw, so only the right-most entry is trusted."""
    fwd = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
    return fwd[-1] if fwd else (request.client.host if request.client else "?")


@app.middleware("http")
async def _rate_limit(request: Request, call_next):
    limit = LIMITS.get(request.url.path)
    if limit:
        now, key = time.time(), (_client(request), request.url.path)
        with _hits_lock:
            recent = [t for t in _hits.get(key, []) if now - t < 60]
            if len(recent) >= limit:
                wait = int(60 - (now - recent[0])) + 1
                return JSONResponse({"detail": f"Too many requests: try again in {wait} s."}, status_code=429,
                                    headers={"Retry-After": str(wait)})
            recent.append(now)
            _hits[key] = recent
            if len(_hits) > 5000:                  # forget idle visitors
                for k in [k for k, v in _hits.items() if now - v[-1] > 60]:
                    del _hits[k]
    return await call_next(request)


# positions read from IRSA at once; more would share the bandwidth and all be slow
_cold = threading.BoundedSemaphore(config.MAX_COLD_BUILDS)


@app.get("/api/health")
def health():
    return {"ok": True, "collections": config.COLLECTIONS}


@app.get("/api/resolve")
def resolve(q: str = Query(..., min_length=1, max_length=200)):
    try:
        return archive.resolve(q)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(502, f"name resolver unavailable: {e}")


def _exposures(ra, dec):
    try:
        return archive.query_exposures(ra, dec)
    except Exception as e:
        raise HTTPException(502, f"IRSA archive query failed: {e}")


@app.get("/api/observations")
def observations(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)):
    exps = _exposures(ra, dec)
    ep = stack.epochs([e.mjd for e in exps])
    return {"count": len(exps), "collections": config.COLLECTIONS, "exposures": [
        {"obs_id": e.obs_id, "detector": e.detector, "mjd": e.mjd, "date": stack.mjd_iso(e.mjd), "epoch": k + 1,
         "wl_min": e.wl_min, "wl_max": e.wl_max, "exptime": e.exptime, "collection": e.collection, "url": e.url}
        for e, k in zip(exps, ep)]}


# The last few prepared frame sets stay in memory, so clicking a star for its spectrum or
# switching views does not re-read hundreds of exposures.
_built: OrderedDict = OrderedDict()
_pinned: set = set()          # demo views baked into the image: never evicted


def _evict(keep=6):
    extra = [k for k in _built if k not in _pinned]
    for k in extra[:max(0, len(extra) - keep)]:
        del _built[k]


def load_demo():
    """Load the demo targets baked by scripts/bake_demo.py: aligned frames into memory, small
    look-up caches into CACHE_DIR (without overwriting newer files)."""
    import gzip
    import pickle
    import shutil
    demo = Path(__file__).resolve().parents[1] / "demo"
    src = demo / "cache"
    if src.exists():
        for f in src.rglob("*"):
            if f.is_file():
                d = config.CACHE_DIR / f.relative_to(src)
                if not d.exists():
                    d.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(f, d)
    path = demo / "built.pkl.gz"
    if path.exists():
        t0 = time.time()
        with gzip.open(path, "rb") as fh:
            built = pickle.load(fh)
        with _built_lock:
            for k, v in built.items():
                _built[k] = v
                _pinned.add(k)
        print(f"demo: {len(built)} views loaded in {time.time() - t0:.1f}s", flush=True)

_built_lock = threading.Lock()
# progress of running /api/frames requests, keyed by a client-chosen job id (polled by the page)
_progress: OrderedDict = OrderedDict()


def _report(job, **kw):
    if not job:
        return
    with _built_lock:
        _progress[job] = {**_progress.get(job, {}), **kw}
        _progress.move_to_end(job)
        while len(_progress) > 200:
            _progress.popitem(last=False)


def _build(ra, dec, fov, detectors, pmra, pmdec, ref_epoch, max_exposures, job=None):
    fov = min(max(fov, config.MIN_FOV), config.MAX_FOV)
    n = int(round(fov / config.PIXEL_SCALE)) | 1                     # odd -> target on a pixel centre
    dets = tuple(sorted({int(d) for d in detectors.split(",") if d.strip().isdigit()}))
    key = (round(ra, 6), round(dec, 6), n, dets, pmra, pmdec, ref_epoch, max_exposures)
    with _built_lock:
        if key in _built:
            _built.move_to_end(key)
            return _built[key]
    _report(job, stage="search")
    exps = [e for e in _exposures(ra, dec) if e.detector in dets]
    if len(exps) > max_exposures:                                   # thin evenly in time
        idx = np.linspace(0, len(exps) - 1, max_exposures).round().astype(int)
        exps = [exps[i] for i in sorted(set(idx))]
    if not exps:
        return None
    # centre the grid on the target's mean position during the SPHEREx observations
    mean_mjd = float(np.mean([e.mjd for e in exps]))
    cra, cdec = stack.propagate(ra, dec, pmra, pmdec, ref_epoch, mean_mjd)
    target = lambda mjd: stack.propagate(ra, dec, pmra, pmdec, ref_epoch, mjd)  # noqa: E731
    _report(job, stage="queue")
    if not _cold.acquire(timeout=120):
        raise HTTPException(503, "The server is busy reading other positions; please try again in a minute.",
                            headers={"Retry-After": "60"})
    try:
        _report(job, stage="read", done=0, total=len(exps))
        frs = stack.build_frames(exps, cra, cdec, n, target, progress=lambda i, k: _report(job, done=i, total=k))
    finally:
        _cold.release()
    threading.Thread(target=stack.prune_cache, daemon=True).start()
    _report(job, stage="process")
    if not frs:
        raise HTTPException(502, "could not read any SPHEREx exposure for this position")
    built = {"frs": frs, "n": n, "ra": cra, "dec": cdec, "w": stack.output_wcs(cra, cdec, n)}
    with _built_lock:
        _built[key] = built
        _evict()
    return built


@app.get("/api/frames")
def frames(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    fov: float = Query(config.DEFAULT_FOV, description="field of view, arcsec"),
    mode: str = Query("epoch", pattern="^(epoch|epoch_detector|exposure)$"),
    detectors: str = Query("1,2,3,4,5,6"),
    pmra: float | None = Query(None, description="proper motion RA*cos(dec), mas/yr"),
    pmdec: float | None = Query(None, description="proper motion Dec, mas/yr"),
    ref_epoch: float = Query(2000.0, description="Julian year of ra/dec when pm is given"),
    max_exposures: int = Query(400, ge=1, le=2000),
    candidates: bool = Query(True, description="run the moving / variable / transient finder"),
    job: str | None = Query(None, max_length=40, pattern=r"^[A-Za-z0-9_-]+$", description="id for /api/progress"),
    matched: bool = Query(True, description="co-add only wavelength-matched exposures (visits compared like for like)"),
):
    b = _build(ra, dec, fov, detectors, pmra, pmdec, ref_epoch, max_exposures, job)
    if b is None:
        return {"grid": None, "frames": [], "exposures": [], "message": "SPHEREx has not observed this position yet."}
    frs, n, w = b["frs"], b["n"], b["w"]
    raw = {m: stack.group_raw(frs, m, matched) for m in {mode, "epoch", "epoch_detector"} if m == mode or candidates}
    out_frames = stack.encode(raw[mode])
    cands = []
    if candidates:
        try:
            cands = detect.find_candidates(raw["epoch"], raw["epoch_detector"], w, ((n - 1) / 2, (n - 1) / 2))
        except Exception as e:                       # the finder is a helper, never break the viewer
            print("candidate finder failed:", repr(e))
    phot = sorted(({
        "obs_id": f.exp.obs_id, "detector": f.exp.detector, "mjd": f.exp.mjd, "date": stack.mjd_iso(f.exp.mjd),
        "wavelength": f.wavelength, "bandwidth": f.bandwidth, **f.phot} for f in frs), key=lambda p: p["mjd"])
    return {
        "grid": {"n": n, "pixel_scale": config.PIXEL_SCALE, "ra": b["ra"], "dec": b["dec"],
                 "fov": n * config.PIXEL_SCALE, "wcs": dict(w.to_header())},
        "query": {"ra": ra, "dec": dec, "pmra": pmra, "pmdec": pmdec, "ref_epoch": ref_epoch, "mode": mode},
        "flag_bits": {str(bit): name for bit, name in config.FLAG_BITS.items()}, "bad_mask": config.BAD_MASK,
        "frames": out_frames, "exposures": phot, "n_exposures_read": len(frs),
        "candidates": cands, "detectors": config.DETECTORS,
    }


@app.get("/api/progress")
def progress(job: str = Query(..., max_length=40)):
    """How far a running /api/frames request with the same job id has got."""
    with _built_lock:
        return _progress.get(job, {})


@app.get("/api/photometry")
def photometry(
    x: float = Query(..., description="grid pixel (0-based, as in /api/frames)"),
    y: float = Query(...),
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    fov: float = Query(config.DEFAULT_FOV),
    detectors: str = Query("1,2,3,4,5,6"),
    pmra: float | None = Query(None),
    pmdec: float | None = Query(None),
    ref_epoch: float = Query(2000.0),
    max_exposures: int = Query(400, ge=1, le=2000),
):
    """Spectrum and light curve of any pixel of a /api/frames view (same parameters)."""
    b = _build(ra, dec, fov, detectors, pmra, pmdec, ref_epoch, max_exposures)
    if b is None:
        raise HTTPException(404, "no SPHEREx data here")
    if not (0 <= x < b["n"] and 0 <= y < b["n"]):
        raise HTTPException(400, "pixel outside the view")
    return stack.photometry_at(b["frs"], b["w"], x, y)


def _external(fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        raise HTTPException(502, f"service unavailable: {e}")


@app.get("/api/gaia")
def gaia(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
         radius: float = Query(0.06, gt=0, le=0.5), gmax: float = Query(19.0, le=21)):
    """Gaia DR3 sources (ESA) with proper motions, epoch 2016.0."""
    return _external(external.gaia, ra, dec, radius, gmax)


@app.get("/api/sso")
def sso(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
        radius: float = Query(300, gt=0, le=3600, description="arcsec"),
        mjd: str = Query(..., description="comma-separated MJDs")):
    """Known asteroids and comets in the field at the given times (IMCCE SkyBoT)."""
    mjds = [float(m) for m in mjd.split(",") if m.strip()]
    return _external(external.skybot, ra, dec, radius, mjds)


@app.get("/api/neossat")
def neossat(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
            radius: float = Query(0.25, gt=0, le=2)):
    """NEOSSat (Canadian Space Agency) observations of this position, from the CADC archive."""
    return _external(external.neossat, ra, dec, radius)


FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
if FRONTEND.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

    @app.get("/")
    def index():
        return FileResponse(FRONTEND / "index.html")


# ---------------------------------------------------------------- warm-up of the demo targets
DEMO = [("Barnard's Star", "1,2,3,4,5,6"), ("eps Indi B", "1,2,3,4,5,6"), ("WISE J085510.83-071442.5", "6"),
        ("RW Aur", "1,2,3,4,5,6"), ("R Dra", "1,2,3,4,5,6")]


def warm(targets=DEMO, fov=240):
    """Run the demo targets exactly as the page asks for them (same rounding, so every cache key
    matches): frames, Gaia, SkyBoT and NEOSSat. Slow the first time, instant afterwards."""
    r6 = lambda v: float(f"{v:.6f}")  # noqa: E731
    for q, dets in targets:
        t0 = time.time()
        try:
            tg = archive.resolve(q)
            d = frames(ra=r6(tg["ra"]), dec=r6(tg["dec"]), fov=fov, mode="epoch", detectors=dets, pmra=tg.get("pmra"),
                       pmdec=tg.get("pmdec"), ref_epoch=2000.0, max_exposures=400, candidates=True, job=None, matched=True)
            g = d["grid"]
            if g:
                ra, dec, rdeg = r6(g["ra"]), r6(g["dec"]), g["fov"] / 3600 / math.sqrt(2)
                for fn, args in ((external.gaia, (ra, dec, round(rdeg, 4), 19.0)),
                                 (external.skybot, (ra, dec, math.ceil(rdeg * 3600), [round(f["mjd"], 3) for f in d["frames"][:40]])),
                                 (external.neossat, (ra, dec, 0.25))):
                    try:
                        fn(*args)
                    except Exception as e:           # an external service being down must not stop the warm-up
                        print(f"warm {q}: {fn.__name__} failed: {e!r}"[:200])
            print(f"warm {q}: {len(d['frames'])} frames in {time.time() - t0:.0f}s", flush=True)
        except Exception as e:
            print(f"warm {q} failed: {e!r}"[:300], flush=True)


@app.on_event("startup")
def _warm_on_start():
    try:
        load_demo()
    except Exception as e:                       # a broken demo file must never stop the server
        print("demo load failed:", repr(e), flush=True)
    if os.getenv("WARM_ON_START", "0") == "1":
        threading.Thread(target=warm, name="warm", daemon=True).start()
