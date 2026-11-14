"""HTTP API. Every view is addressable by URL, e.g.
/api/frames?ra=133.7951&dec=-7.2451&fov=300&mode=epoch
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import archive, config, stack

app = FastAPI(title="SPHEREx sky-change viewer", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


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
):
    fov = min(max(fov, config.MIN_FOV), config.MAX_FOV)
    n = int(round(fov / config.PIXEL_SCALE)) | 1                     # odd -> target on a pixel centre
    dets = {int(d) for d in detectors.split(",") if d.strip().isdigit()}
    exps = [e for e in _exposures(ra, dec) if e.detector in dets]
    if len(exps) > max_exposures:                                   # thin evenly in time
        idx = np.linspace(0, len(exps) - 1, max_exposures).round().astype(int)
        exps = [exps[i] for i in sorted(set(idx))]
    if not exps:
        return {"grid": None, "frames": [], "exposures": [], "message": "SPHEREx has not observed this position yet."}

    # centre the grid on the target's mean position during the SPHEREx observations
    mean_mjd = float(np.mean([e.mjd for e in exps]))
    cra, cdec = stack.propagate(ra, dec, pmra, pmdec, ref_epoch, mean_mjd)
    target = lambda mjd: stack.propagate(ra, dec, pmra, pmdec, ref_epoch, mjd)
    frs = stack.build_frames(exps, cra, cdec, n, target)
    if not frs:
        raise HTTPException(502, "could not read any SPHEREx exposure for this position")
    out_frames = stack.group_frames(frs, mode)
    phot = sorted(({
        "obs_id": f.exp.obs_id, "detector": f.exp.detector, "mjd": f.exp.mjd, "date": stack.mjd_iso(f.exp.mjd),
        "wavelength": f.wavelength, "bandwidth": f.bandwidth, **f.phot} for f in frs), key=lambda p: p["mjd"])
    w = stack.output_wcs(cra, cdec, n)
    return {
        "grid": {"n": n, "pixel_scale": config.PIXEL_SCALE, "ra": cra, "dec": cdec,
                 "fov": n * config.PIXEL_SCALE, "wcs": dict(w.to_header())},
        "query": {"ra": ra, "dec": dec, "pmra": pmra, "pmdec": pmdec, "ref_epoch": ref_epoch, "mode": mode},
        "flag_bits": {str(b): name for b, name in config.FLAG_BITS.items()}, "bad_mask": config.BAD_MASK,
        "frames": out_frames, "exposures": phot, "n_exposures_read": len(frs),
    }


FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
if FRONTEND.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

    @app.get("/")
    def index():
        return FileResponse(FRONTEND / "index.html")
