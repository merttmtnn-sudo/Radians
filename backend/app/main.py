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

from . import archive, config, crossmatch, detect, external, net, stack

app = FastAPI(title="Radians", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

# ---------------------------------------------------------------- fair sharing of one server
_hits: dict = {}
_hits_lock = threading.Lock()
LIMITS = {"/api/frames": config.RATE_FRAMES, "/api/photometry": config.RATE_PHOT}
# endpoints that ask SIMBAD / Gaia / VizieR / IRSA for a visitor or fit on the server: one budget each
LIMITS.update({p: config.RATE_LOOKUP for p in ("/api/coverage", "/api/crossmatch", "/api/spectype", "/api/curious/hr",
                                              "/api/curious/facts", "/api/curious/motion", "/api/curious/period", "/api/curious/variable", "/api/curious/xmatch")})
LIMITS["/api/sharp"] = config.RATE_FRAMES
# the fast band's own lookups (its pictures, /api/quick, are long-polled and limited by the engine's build queue)
LIMITS.update({p: config.RATE_LOOKUP for p in ("/api/quick/changes", "/api/quick/diffs", "/api/quick/motion", "/api/quick/warm")})


def _client(request: Request) -> str:
    """Visitor address for rate limiting. A visitor can put anything at the left of X-Forwarded-For;
    the hosting proxy appends the address it actually saw, so only the right-most entry is trusted."""
    fwd = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
    return fwd[-1] if fwd else (request.client.host if request.client else "?")


@app.middleware("http")
async def _revalidate(request: Request, call_next):
    """The page and its scripts must be re-checked on every load (cheap with ETags), otherwise
    browsers keep running an old app.js / styles.css after a deploy."""
    resp = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


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
        known = _builtin_object(q)
        if known:
            return known
        raise HTTPException(404, str(e))
    except Exception as e:
        known = _builtin_object(q)                       # the resolver is down: the built-in list still knows its objects
        if known:
            return known
        raise HTTPException(502, f"name resolver unavailable: {e}")


def _builtin_object(q: str) -> dict | None:
    """One of the curated objects (challenge targets and famous sky) by any of its names, in the
    shape of a resolver answer. Used when the name resolver is unreachable or does not know the name."""
    from .engine import api_find
    want = api_find.fold(q)
    for p in api_find.pins():
        if want and want in p["keys"]:
            return {"name": p["name_en"], "ra": p["ra"], "dec": p["dec"], "pmra": p.get("pmra") or None,
                    "pmdec": p.get("pmdec") or None, "source": "built-in list"}
    return None


@app.get("/api/about")
def about(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
          q: str | None = Query(None, max_length=200)):
    """What is at this position: sky context always, object details when a name is known."""
    out = {"sky": archive.sky_context(ra, dec), "object": None}
    if q and not archive.parse_coords(q):
        try:
            name = archive.resolve(q).get("name") or q
            out["object"] = archive.details(name)
        except Exception:
            pass
    return out


def _exposures(ra, dec):
    try:
        return archive.query_exposures(ra, dec)
    except archive.ArchiveUnavailable as e:
        print("IRSA unavailable:", e)
        raise HTTPException(503, "IRSA_UNAVAILABLE", headers={"Retry-After": "60"})
    except Exception as e:
        print("IRSA query failed:", repr(e)[:300])
        raise HTTPException(502, "IRSA_FAILED")


@app.get("/api/observations")
def observations(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)):
    exps = _exposures(ra, dec)
    ep = stack.epochs([e.mjd for e in exps])
    return {"count": len(exps), "collections": config.COLLECTIONS, "exposures": [
        {"obs_id": e.obs_id, "detector": e.detector, "mjd": e.mjd, "date": stack.mjd_iso(e.mjd), "epoch": k + 1,
         "wl_min": e.wl_min, "wl_max": e.wl_max, "exptime": e.exptime, "collection": e.collection, "url": e.url}
        for e, k in zip(exps, ep)]}


def coverage_summary(exps):
    """How SPHEREx covered a spot, from its exposure list alone (no pixels): how many exposures, since
    when, in which sky passes and in which detector bands."""
    ep = stack.epochs([e.mjd for e in exps])
    passes = []
    for e, k in zip(exps, ep):
        if not passes or passes[-1]["epoch"] != k + 1:
            passes.append({"epoch": k + 1, "start": stack.mjd_iso(e.mjd_start)[:10], "end": "", "n": 0})
        passes[-1]["end"] = stack.mjd_iso(e.mjd_end)[:10]
        passes[-1]["n"] += 1
    per = {str(d): 0 for d in config.DETECTORS}
    for e in exps:
        per[str(e.detector)] = per.get(str(e.detector), 0) + 1
    span = exps[-1].mjd_end - exps[0].mjd_start if exps else 0.0
    return {"count": len(exps), "first": passes[0]["start"] if passes else None,
            "last": passes[-1]["end"] if passes else None, "span_days": round(span, 1),
            "passes": passes, "detectors": per}


@app.get("/api/coverage")
def coverage(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)):
    """Has SPHEREx seen this spot, how often and in which bands? One archive search, cached under the same
    key a blink of the same coordinates uses, so "Blink this spot" does not ask IRSA again."""
    return coverage_summary(_exposures(round(ra, 5), round(dec, 5)))


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


def _live_preview(job, n, total):
    """While exposures are read, share the co-add of those read so far (in reading order) with the progress
    poller, so the page can show the image sharpening as it loads."""
    acc = stack.DepthAccumulator(n)
    every = max(1, total // 40)

    def add(f):
        acc.add(f)
        if acc.count in (1, 2, 3, 5) or acc.count % every == 0:
            img, noise, stars = acc.stats()
            _report(job, preview={"n": n, "count": acc.count, "noise": noise, "stars": stars, "image": stack.b64(img)})
    return add


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
        frs = stack.build_frames(exps, cra, cdec, n, target, progress=lambda i, k: _report(job, done=i, total=k),
                                 on_frame=_live_preview(job, n, len(exps)) if job else None)
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
    wl_min: float | None = Query(None, ge=0.5, le=5.5, description="wavelength window, micron: keep exposures that saw the target at >= wl_min"),
    wl_max: float | None = Query(None, ge=0.5, le=5.5, description="... and <= wl_max (no extra reads: every exposure is already read)"),
    sharp: int | None = Query(None, ge=2, le=3, description="one super-resolution picture per visit, on pixels this many times finer (mode, matched and candidates are then ignored)"),
):
    b = _build(ra, dec, fov, detectors, pmra, pmdec, ref_epoch, max_exposures, job)
    if b is None:
        return {"grid": None, "frames": [], "exposures": [], "message": "SPHEREx has not observed this position yet."}
    frs, n, w = b["frs"], b["n"], b["w"]
    wls = [f.wavelength for f in frs if f.wavelength]
    wl_range = [round(min(wls), 3), round(max(wls), 3)] if wls else None
    window = None
    if wl_min is not None or wl_max is not None:
        lo = wl_min if wl_min is not None else 0.0
        hi = wl_max if wl_max is not None else 9.0
        if lo > hi:
            lo, hi = hi, lo
        window = [lo, hi]
        frs = stack.in_window(frs, lo, hi)
        matched = False                            # the window already compares visits at the same wavelengths
        if not frs:
            return {"grid": None, "frames": [], "exposures": [], "wl_range": wl_range, "wl_window": window,
                    "message": "No SPHEREx exposure saw this position in that wavelength window."}
    if sharp:
        # every exposure of a visit, all detector bands together, drizzled onto finer pixels (app/sharp.py);
        # kept with the build, so going back and forth costs nothing
        kept = b.setdefault("sharp", {})
        key = (sharp, tuple(window) if window else None)
        if key not in kept:
            kept[key] = sharp_views.visits(frs, b["ra"], b["dec"], n, sharp)
        out = kept[key]
        if out is None:
            return {"grid": None, "frames": [], "exposures": [], "wl_range": wl_range, "wl_window": window,
                    "message": "No exposure could be used for a sharpened picture here."}
        return {**out, "query": {"ra": ra, "dec": dec, "pmra": pmra, "pmdec": pmdec, "ref_epoch": ref_epoch, "mode": "epoch"},
                "flag_bits": {str(bit): name for bit, name in config.FLAG_BITS.items()}, "bad_mask": config.BAD_MASK,
                "exposures": [], "candidates": [], "n_exposures_read": len(frs), "detectors": config.DETECTORS,
                "wl_range": wl_range, "wl_window": window}
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
        # is there a star where the target should be? (followed across the grid if it moves)
        "spot": stack.spot_check(frs, [(f.phot.get("x", (n - 1) / 2), f.phot.get("y", (n - 1) / 2)) for f in frs]),
        "candidates": cands, "detectors": config.DETECTORS, "wl_range": wl_range, "wl_window": window,
    }


@app.get("/api/depth")
def depth(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    fov: float = Query(config.DEFAULT_FOV),
    detectors: str = Query("1,2,3,4,5,6"),
    pmra: float | None = Query(None),
    pmdec: float | None = Query(None),
    ref_epoch: float = Query(2000.0),
    max_exposures: int = Query(400, ge=1, le=2000),
):
    """How the image sharpens as exposures pile up: co-adds of the first 1, 2, 4 ... all exposures in time
    order (int16, multiply by `scale`), the noise and star count at each step, and how many exposures cover
    every pixel. Uses the exposures already read for /api/frames with the same parameters."""
    b = _build(ra, dec, fov, detectors, pmra, pmdec, ref_epoch, max_exposures)
    if b is None:
        return {"steps": []}
    return {"n": b["n"], **stack.depth_series(b["frs"], b["n"])}


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
    return {**stack.photometry_at(b["frs"], b["w"], x, y), "spot": stack.spot_check(b["frs"], [(x, y)] * len(b["frs"]))}


from pydantic import BaseModel, Field  # noqa: E402

from . import spectype, typecat  # noqa: E402


class SpecPoint(BaseModel):
    wavelength: float | None = None
    flux_ujy: float | None = None
    err_ujy: float | None = None
    saturated: bool = False


class SpecTypeRequest(BaseModel):
    points: list[SpecPoint] = Field(..., max_length=5000)
    ra: float = Field(..., ge=0, lt=360)
    dec: float = Field(..., ge=-90, le=90)
    name: str | None = Field(None, max_length=200)
    gaia_id: str | None = Field(None, max_length=40)
    catalogues: bool = False


@app.post("/api/spectype")
def spectral_type(req: SpecTypeRequest):
    """Spectral type and molecular fingerprints of a spectrum the page already has (the points of
    /api/frames or /api/photometry). With catalogues=true, also what SIMBAD and Gaia DR3 say about
    the object and whether that agrees with our fit; the page asks without them first, so its own
    answer does not wait for the catalogues."""
    pts = [p.model_dump() for p in req.points]
    out = {"fit": spectype.fit(pts), "fingerprints": spectype.fingerprints(pts), "catalogue": None, "agreement": None}
    if req.catalogues:
        cat = typecat.lookup(req.ra, req.dec, req.name, req.gaia_id)
        out["catalogue"] = cat
        out["agreement"] = spectype.agreement(cat["simbad"].get("sptype"), cat["gaia"].get("teff"), out["fit"])
    return out


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


@app.get("/api/crossmatch")
def crossmatch_route(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                     radius: float = Query(0.06, gt=0, le=0.5),
                     cat: str = Query("", pattern="^(simbad|catwise)?$")):
    """SIMBAD and CatWISE2020 objects in the field (or only `cat`), each with its own "ok": the candidates
    are checked against them (and Gaia DR3) in the page. A catalogue that is down does not fail the request."""
    return crossmatch.crossmatch(round(ra, 5), round(dec, 5), round(radius, 4), cat or None)


@app.get("/api/sso")
def sso(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
        radius: float = Query(300, gt=0, le=3600, description="arcsec"),
        mjd: str = Query(..., description="comma-separated MJDs")):
    """Known asteroids and comets in the field at the given times (IMCCE SkyBoT)."""
    mjds = [float(m) for m in mjd.split(",") if m.strip()]
    return _external(external.skybot, ra, dec, radius, mjds)


FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
if FRONTEND.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

    @app.get("/")
    def index():
        return FileResponse(FRONTEND / "index.html")


# ---------------------------------------------------------------- warm-up of the demo targets
# (name, detectors, wavelength matching) exactly as the page's "Try" buttons ask for them.
# WISE 0855: D5+D6 without matching. With D6 alone (45 exposures) the finder sees no motion; with
# matching across D5+D6 only 1-2 exposures per epoch remain. D5+D6 unmatched recovers 8.16"/yr (catalogue 8.15).
DEMO = [("Barnard's Star", "1,2,3,4,5,6", True), ("eps Indi B", "1,2,3,4,5,6", True),
        ("WISE J085510.83-071442.5", "5,6", False), ("RW Aur", "1,2,3,4,5,6", True), ("R Dra", "1,2,3,4,5,6", True)]


def warm(targets=DEMO, fov=240):
    """Run the demo targets exactly as the page asks for them (same rounding, so every cache key
    matches): frames, Gaia, SkyBoT and NEOSSat. Slow the first time, instant afterwards."""
    r6 = lambda v: float(f"{v:.6f}")  # noqa: E731
    for q, dets, *rest in targets:
        matched = rest[0] if rest else True
        t0 = time.time()
        try:
            tg = archive.resolve(q)
            d = frames(ra=r6(tg["ra"]), dec=r6(tg["dec"]), fov=fov, mode="epoch", detectors=dets, pmra=tg.get("pmra"),
                       pmdec=tg.get("pmdec"), ref_epoch=2000.0, max_exposures=400, candidates=True, job=None, matched=matched)
            g = d["grid"]
            if g:
                ra, dec, rdeg = r6(g["ra"]), r6(g["dec"]), g["fov"] / 3600 / math.sqrt(2)
                for fn, args in ((external.gaia, (ra, dec, round(rdeg, 4), 19.0)),
                                 (external.skybot, (ra, dec, math.ceil(rdeg * 3600), [round(f["mjd"], 3) for f in d["frames"][:40]]))):
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


# ---------------------------------------------------------------- "for the curious" tools under the spectrum
from . import curious  # noqa: E402


def _try(fn, *args):
    """A catalogue tool's answer, or {"reachable": false} when its service is down (never a 5xx)."""
    try:
        return {"reachable": True, **fn(*args)}
    except Exception as e:  # noqa: BLE001  (optional services)
        return {"reachable": False, "error": str(e)[:200]}


@app.get("/api/curious/hr")
def curious_hr(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
               gaia_id: str | None = Query(None, max_length=40)):
    """Gaia stars within half a degree with good parallaxes (colour, absolute magnitude), and this star."""
    out = _try(lambda: {"stars": curious.hr_field(ra, dec)})
    if out["reachable"]:
        out["star"] = _try(curious.gaia_star, gaia_id) if gaia_id else {"reachable": True, "found": False}
    return out


@app.get("/api/curious/motion")
def curious_motion(gaia_id: str = Query(..., max_length=40)):
    """Gaia DR3 proper motion, direction, parallax and speed across the sky of one source."""
    return _try(curious.gaia_star, gaia_id)


class PeriodPoint(BaseModel):
    mjd: float | None = None
    wavelength: float | None = None
    value: float | None = None
    err: float | None = None
    flagged: bool = False
    saturated: bool = False


class PeriodRequest(BaseModel):
    points: list[PeriodPoint] = Field(..., max_length=5000)
    wings: bool = False            # the values are wing fluxes of a saturated star: saturated points are kept


@app.post("/api/curious/period")
def curious_period(req: PeriodRequest):
    """Did the brightness change between visits, and does it have a rhythm? Brightness relative to the
    usual at each wavelength; a rhythm is judged against date-scrambled copies (app/pulse.py)."""
    return curious.period_search([p.model_dump() for p in req.points], req.wings)


@app.get("/api/curious/facts")
def curious_facts(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                  gaia_id: str | None = Query(None, max_length=40)):
    """The star itself: Gaia DR3's distance, speeds, companion hints, radius, luminosity, mass and age,
    and the planets the NASA Exoplanet Archive lists around it. Each part says when its service is down."""
    return {"star": _try(curious.star_facts, gaia_id) if gaia_id else {"reachable": True, "found": False},
            "planets": _try(curious.known_planets, ra, dec)}


@app.get("/api/curious/variable")
def curious_variable(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                     gaia_id: str | None = Query(None, max_length=40)):
    """Is this a known variable star? The AAVSO index (VSX, through VizieR) and Gaia DR3's variability
    classifier, each {"reachable": false} when its service is down."""
    return {"vsx": _try(curious.vsx_star, ra, dec),
            "gaia": _try(curious.gaia_variable, gaia_id) if gaia_id else {"reachable": True, "found": False}}


@app.get("/api/curious/xmatch")
def curious_xmatch(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                   pmra: float = Query(0.0), pmdec: float = Query(0.0), mjd: float = Query(51544.5)):
    """The same star in 2MASS and AllWISE (VizieR), looked for where it was when each survey saw it."""
    return {"surveys": curious.cross_match(ra, dec, pmra, pmdec, mjd)}


# ---------------------------------------------------------------- sharper than one pixel (drizzle)
from . import sharp  # noqa: E402
sharp_views = sharp          # /api/frames has a parameter called "sharp"


@app.get("/api/sharp")
def sharp_view(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
               fov: float = Query(300, ge=60, le=900, description="arcsec"), det: int = Query(1, ge=1, le=6),
               factor: int = Query(2, ge=2, le=3), max_exposures: int = Query(300, ge=10, le=600),
               job: str | None = Query(None, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")):
    """One detector band of a spot drizzled onto a grid `factor` times finer than SPHEREx's 6.15″ pixels, plus
    the ordinary stack on the native grid for comparison. Cached on disk for a week."""
    ra, dec, fov = round(ra, 5), round(dec, 5), round(fov)
    key = f"{ra}|{dec}|{fov}|{det}|{factor}|{max_exposures}"

    def run():
        _report(job, stage="search")
        exps = [e for e in _exposures(ra, dec) if e.detector == det]
        if len(exps) > max_exposures:
            idx = np.linspace(0, len(exps) - 1, max_exposures).round().astype(int)
            exps = [exps[i] for i in sorted(set(idx))]
        if not exps:
            return {"count": 0}
        _report(job, stage="queue")
        if not _cold.acquire(timeout=120):
            raise HTTPException(503, "The server is busy reading other positions; please try again in a minute.",
                                headers={"Retry-After": "60"})
        try:
            _report(job, stage="read", done=0, total=len(exps))
            out = sharp.drizzle(exps, ra, dec, fov, factor, progress=lambda i, k: _report(job, done=i, total=k))
        finally:
            _cold.release()
        threading.Thread(target=stack.prune_cache, daemon=True).start()
        return {**out, "det": det} if out else {"count": 0}

    out = net.cached_json("sharp", key, 7 * 86400, run)
    _report(job, stage="done")
    return JSONResponse(out, headers={"Cache-Control": "public, max-age=3600"})


# ---------------------------------------------------------------- the fast engine (merged in from Skyshift)
# /api/quick (the fast band in the viewer's frame format), /api/views/{id}/lightcurve, /api/pins and
# /api/search.
from . import mixtiles, quick  # noqa: E402
from .engine import main as engine  # noqa: E402

app.include_router(quick.router)        # /api/quick: an engine view in the viewer's frame format
app.include_router(mixtiles.router)          # /hips/spherex-mix: false-colour mixes of the all-sky cube for the map
app.include_router(mixtiles.colour_router)   # /hips/spherex-color: the map's fixed "Infrared RGB" palette
for _router in engine.routers:
    app.include_router(_router)
