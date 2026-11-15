"""The fast first look: one detector band from the engine, in the frame format the Blink viewer reads.

`GET /api/quick` starts (or re-uses) an engine view of one band around a position and answers with
what is ready: first a preview (a few exposures per sky pass, in seconds), then the full band.
The answer has the same shape as `/api/frames`, so the viewer's player, stretches, palettes, zoom,
compare slider and GIF export work on it unchanged; the extra `quick` block says how far the build
is and which engine view (`/api/views/{id}/...`) holds the difference and colour-by-time pictures.

Frames are the engine's median stacks, one per sky pass, on its 2" north-up grid.
"""
from __future__ import annotations

import math
import threading

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from . import config, stack
from .engine import advanced, api_find, api_views, changes, render, sky, stacking
from .engine.views import SIZE_RANGE, _plain as engine_plain, demo_spec, make_spec

router = APIRouter()

DEFAULT_BAND = 5                    # good signal, and cold objects show (as in the engine)
PIN_MATCH_ARCSEC = 5.0              # a request this close to a curated object is that object
SATURATED_SHARE = 0.3               # a pixel saturated or blank in this share of a pass's exposures is marked
MOVING_MAS_YR = 20.0                # slower targets are not tracked from pass to pass

_BIT = {name: 1 << bit for bit, name in config.FLAG_BITS.items()}
FLAG_SATURATED = _BIT["OVERFLOW"] | _BIT["NONLINEAR"]
FLAG_BLANK = _BIT["OVERFLOW"] | _BIT["SUR_ERROR"]


def _separation_arcsec(ra1, dec1, ra2, dec2) -> float:
    dra = (ra1 - ra2 + 180.0) % 360.0 - 180.0
    return 3600.0 * math.hypot(dra * math.cos(math.radians(dec1)), dec1 - dec2)


def find_pin(ra: float, dec: float) -> dict | None:
    """The curated object at this catalogue position (its J2000 or today's position), if any."""
    for p in api_find.pins():
        if min(_separation_arcsec(ra, dec, p["ra"], p["dec"]),
               _separation_arcsec(ra, dec, p["ra_now"], p["dec_now"])) <= PIN_MATCH_ARCSEC:
            return p
    return None


def quick_spec(ra, dec, fov_arcsec, band, pmra, pmdec, ref_epoch, prefer=None) -> tuple[dict, dict | None]:
    """The engine view to build for a viewer request, and the curated object it belongs to (or None).
    A challenge target gets the spec of its pre-built demo view, so it opens at once on any date.
    band: asked for by name; prefer: the visitor's last choice, used only where the object has no band of its own."""
    size = min(max(float(fov_arcsec) / 60.0, SIZE_RANGE[0]), SIZE_RANGE[1])
    pin = find_pin(ra, dec)
    band = int(band or (pin or {}).get("band") or prefer or DEFAULT_BAND)
    if pin:
        spec = demo_spec(pin["id"], band, size)
        if spec:
            return spec, pin
        target = dict(pin, name=pin["name_en"])
    else:
        target = dict(ra=ra, dec=dec, pmra=pmra or 0.0, pmdec=pmdec or 0.0, plx=0.0, epoch=ref_epoch, name="")
    moving = abs(target.get("pmra") or 0.0) + abs(target.get("pmdec") or 0.0) > MOVING_MAS_YR
    if moving:                       # centred where it is today; its predicted spot is marked per pass
        ra, dec = sky.position_now(target)
    return make_spec(ra, dec, band, size, target if moving else None), pin


def _frames(meta: dict, arr: dict) -> list[dict]:
    """One viewer frame per sky pass, from the stored stacks of an engine view."""
    n = meta["field"]["n"]
    band = meta["band"]["id"]
    mjds, pass_of = np.asarray(arr["mjds"], float), np.asarray(arr["pass_of"])
    out = []
    for p in meta["passes"]:
        k = p["index"]
        raw = np.asarray(arr[f"S{k}"], dtype="f4")
        blank = ~np.isfinite(raw)
        sat = np.asarray(arr.get(f"Q{k}", np.zeros((n, n), "f4"))) >= SATURATED_SHARE
        flags = np.zeros((n, n), np.uint32)
        flags[sat] |= FLAG_SATURATED
        flags[blank] |= FLAG_BLANK
        sigma = stacking.robust_stats(raw)[1]
        variance = np.full((n, n), (sigma if math.isfinite(sigma) and sigma > 0 else 1.0) ** 2, "f4")
        mine = mjds[pass_of == k]
        m0, m1 = (float(mine.min()), float(mine.max())) if mine.size else (p["mjd"], p["mjd"])
        wl = p.get("wave_um") or [None, None]
        out.append({
            "epoch": k + 1, "detectors": [band], "detector": band,
            "n_exposures": p.get("n_used", p.get("n_frames", 0)), "n_frames": p.get("n_frames", 0),
            "matched": bool((meta.get("wavelengths") or {}).get("matched", True)),
            "mjd": p["mjd"], "mjd_start": m0, "mjd_end": m1,
            "date_start": stack.mjd_iso(m0), "date_end": stack.mjd_iso(m1),
            "wavelength_min": wl[0], "wavelength_max": wl[1],
            "saturated_fraction": p.get("saturated_fraction"), "target_px": p.get("target_px"),
            "exposures": [],
            "image": stack.b64(render.fill_holes(raw)),          # saturated cores as bright blobs, flagged
            "variance": stack.b64(variance), "flags": stack.b64(flags),
        })
    return out


def payload(mgr, job: dict, have: int, query: dict) -> dict:
    """The viewer's answer for an engine job. Pictures are sent only when the build moved past `have`."""
    view = job.get("view")
    out = {
        "grid": None, "frames": None, "exposures": [], "candidates": [],
        "query": query, "detectors": config.DETECTORS,
        "flag_bits": {str(bit): name for bit, name in config.FLAG_BITS.items()}, "bad_mask": config.BAD_MASK,
        "quick": {"id": job["id"], "state": job["state"], "rev": job["rev"], "progress": job["progress"],
                  "error": job["error"], "band": query["band"], "quality": view["quality"] if view else None},
    }
    if not view:
        return out
    f, band = view["field"], view["band"]
    n, scale = f["n"], f["scale_arcsec"]
    out["grid"] = {"n": n, "pixel_scale": scale, "ra": f["ra"], "dec": f["dec"], "fov": n * scale,
                   "wcs": dict(stacking.grid_wcs(f["ra"], f["dec"], n, scale).to_header())}
    out["wl_range"], out["wl_window"] = band["um"], None
    out["n_exposures_read"] = view.get("n_band", 0)
    out["quick"].update(band_um=band["um"], n_exposures=view.get("n_exposures"), n_band=view.get("n_band"),
                        skipped=view.get("skipped", 0), warnings=view.get("warnings") or [],
                        wavelengths=view.get("wavelengths"), levels=view.get("levels"),
                        target=view["spec"].get("target"), size_arcmin=f["size_arcmin"],
                        passes=[{k: p.get(k) for k in ("index", "start", "end", "mjd", "n_frames", "n_used",
                                                       "wave_um", "saturated_fraction", "target_px")}
                                for p in view["passes"]])
    if job["rev"] > have:
        meta, arr = mgr._load(job["id"])
        out["frames"] = _frames(meta, arr)
    return out


@router.get("/api/quick")
def quick(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    fov: float = Query(240.0, ge=30, le=3600, description="field of view, arcsec (the engine builds 1 to 10 arcmin)"),
    band: int | None = Query(None, ge=1, le=6, description="detector band; default: the object's own, else `prefer`, else 5"),
    prefer: int | None = Query(None, ge=1, le=6, description="the band the visitor picked last time"),
    pmra: float | None = Query(None, description="proper motion RA*cos(dec), mas/yr"),
    pmdec: float | None = Query(None, description="proper motion Dec, mas/yr"),
    ref_epoch: float = Query(2000.0, description="Julian year of ra/dec when pm is given"),
    have: int = Query(-1, ge=-1, description="the build revision the page already shows (-1: nothing)"),
    wait: float = Query(0.0, ge=0, le=25, description="seconds to wait for news before answering"),
):
    """One band, fast: a preview within seconds, then the full band. Ask again with `have` and `wait`
    to follow the build; the pictures come back whenever a newer revision is ready."""
    try:
        spec, pin = quick_spec(ra, dec, fov, band, pmra, pmdec, ref_epoch, prefer)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    mgr = api_views.manager()
    job = mgr.submit(spec)
    if wait > 0 and job["state"] in ("queued", "running") and job["rev"] <= have:
        job = mgr.status(job["id"], wait)
    query = {"ra": ra, "dec": dec, "pmra": pmra, "pmdec": pmdec, "ref_epoch": ref_epoch, "mode": "epoch",
             "band": spec["band"], "pin": pin["id"] if pin else None}
    return payload(mgr, job, have, query)


# ---------------------------------------------------------------- a head start while the visitor is still choosing
_warming: set[str] = set()
_warmed: dict[str, float] = {}          # spot -> when its head start last ran
_warm_lock = threading.Lock()
WARM_AGAIN_S = 25.0                     # connections opened ahead of time stay usable about this long


def warm(mgr, spec: dict) -> bool:
    """A head start for the build of an engine view, in the background: ask the archive which
    exposures cover the spot (one request, cached for days), let the reader learn the file layout
    if it does not know it, and open the connections the build will use (no pixels are read).
    False if that is running, or ran for this spot in the last WARM_AGAIN_S seconds."""
    import time

    from .engine import sia
    key = f"{sia.cache_key(spec['ra'], spec['dec'])}:{spec['band']}"
    with _warm_lock:
        if key in _warming or len(_warming) >= 4 or time.time() - _warmed.get(key, 0.0) < WARM_AGAIN_S:
            return False
        _warming.add(key)

    def run():
        try:
            exps = sia.exposures(mgr.http, spec["ra"], spec["dec"], mgr.sia_dir)
            band = [e for e in exps if e["det"] == spec["band"]]
            mgr.cache.fast(band[:3])
            mgr.http.open_connections(e["url"] for e in band)
        except Exception:  # noqa: BLE001  (a head start only: the real request reports problems)
            pass
        finally:
            with _warm_lock:
                _warming.discard(key)
                _warmed[key] = time.time()
                for old in [k for k, at in _warmed.items() if time.time() - at > 600]:
                    del _warmed[old]
    threading.Thread(target=run, daemon=True, name="warm").start()
    return True


@router.get("/api/quick/warm")
def quick_warm(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
               band: int | None = Query(None, ge=1, le=6), prefer: int | None = Query(None, ge=1, le=6)):
    """The page calls this while the visitor is still typing or choosing a suggestion. It answers at
    once; the archive is asked in the background (no pixels are read)."""
    try:
        spec, _ = quick_spec(ra, dec, 240.0, band, None, None, 2000.0, prefer)
    except ValueError:
        return {"started": False}
    return {"started": warm(api_views.manager(), spec)}


@router.get("/api/quick/diffs")
def quick_diffs(id: str = Query(..., min_length=8, max_length=40, pattern=r"^[0-9a-f]+$")):
    """Every later sky pass minus the first one, each compared at matching wavelengths only (the two
    stacks are rebuilt from exposure pairs that saw the same wavelength). Float images in the
    viewer's orientation; NaN = no data. `sigma` is the noise of each difference; `matched` says
    whether pairs were found (if not, the passes saw different colours and the page warns)."""
    mgr = api_views.manager()
    try:
        meta, _ = mgr._load(id)
        out = []
        for p in meta["passes"][1:]:
            d, how = mgr.diff(id, 0, p["index"])
            out.append({**how, "image": stack.b64(np.asarray(d, dtype="f4"))})
    except (KeyError, FileNotFoundError):
        raise HTTPException(404, "That view does not exist (yet).") from None
    return {"id": id, "n": meta["field"]["n"], "built": meta["built"], "pairs": out}


# ---------------------------------------------------------------- what changed, from the difference picture
# The engine's finder works on the wavelength-matched difference of two sky passes. Its finds are
# answered here in the shape of the viewer's candidate cards, so the page can show them in one list
# with the finds of the all-detector tracker (app/detect.py) and say which method saw what.
CARD_TYPE = {"mover": "moving", "appeared": "transient", "vanished": "transient",
             "brightened": "variable", "faded": "variable"}
NOTE_CODES = {"movers": "few_movers", "single": "few_single"}


def difference_finds(mgr, vid: str) -> dict:
    """Finds between the first and the last sky pass of an engine view, as viewer candidates.
    Positions are grid pixels in the viewer's orientation (x to the west, y to the north).
    No catalogue is asked here: the page checks every card against Gaia, SIMBAD and CatWISE itself."""
    meta = mgr._stored(vid)
    if meta is None:
        raise KeyError(vid)
    passes = meta["passes"]
    out = {"id": vid, "built": meta["built"], "band": meta["band"]["id"], "candidates": [], "notes": [],
           "passes": len(passes)}
    if len(passes) < 2:
        out["notes"].append("one_pass")
        return out
    a, b = 0, len(passes) - 1
    stack_a, stack_b, d, how = mgr._diff(vid, a, b)
    f, pa, pb = meta["field"], passes[a], passes[b]
    n, scale = f["n"], f["scale_arcsec"]
    grid = stacking.grid_wcs(f["ra"], f["dec"], n, scale)
    years = (pb["mjd"] - pa["mjd"]) / 365.25
    found, notes = changes.find_changes(stack_a, stack_b, d, scale, years, (how["n_a"], how["n_b"]))
    out.update(a=a, b=b, start_a=pa["start"], start_b=pb["start"], mjd_a=pa["mjd"], mjd_b=pb["mjd"],
               matched=how["matched"], n_a=how["n_a"], n_b=how["n_b"],
               notes=[code for key, code in NOTE_CODES.items() if any(key in note for note in notes)])
    if not how["matched"]:
        out["notes"].append("unmatched")

    def sky(x, y):
        ra, dec = grid.all_pix2world(x, y, 0)
        return float(ra), float(dec)

    targets = [(p["target_px"][0], n - 1 - p["target_px"][1]) for p in (pa, pb) if p.get("target_px")]
    for it in found:
        kind = it["kind"]
        card = {"type": CARD_TYPE[kind], "kind": kind, "method": "difference",
                "significance": round(float(it["z"]), 1), "contrast": it.get("contrast"),
                "saturated": bool(it.get("saturated")), "low_confidence": bool(it.get("saturated")),
                "implausible": bool(it.get("implausible")), "mjd_a": pa["mjd"], "mjd_b": pb["mjd"]}
        if kind == "mover":
            ends = [(it["x1"], it["y1"], pa["mjd"]), (it["x2"], it["y2"], pb["mjd"])]
            card.update(x=it["x2"], y=it["y2"], rate_arcsec_yr=round(it["rate_arcsec_yr"], 2),
                        rate_err=round(it["rate_err"], 2), pa_deg=round(it["direction_deg"]),
                        shift_arcsec=round(it["shift_arcsec"], 2),
                        shift_err_arcsec=it["shift_err_arcsec"], mjd=pb["mjd"])
        else:
            later = kind in ("appeared", "brightened")
            mjd = pb["mjd"] if kind in ("appeared", "brightened", "faded") else pa["mjd"]
            ends = [(it["x"], it["y"], mjd)]
            card.update(x=it["x"], y=it["y"], mjd=mjd)
            if kind in ("appeared", "vanished"):
                card.update(epoch_mjd=pb["mjd"] if later else pa["mjd"])
            else:                                             # later / earlier brightness, as a ratio >= 1
                change = it.get("change")
                ratio = None if change is None else (1 + change if change >= 0 else 1 / max(1e-3, 1 + change))
                card.update(ratio=ratio, brighter=later, detectors=[])
        card["points"] = [{"mjd": m, "x": x, "y": y} for x, y, m in ends]
        card["ra"], card["dec"] = sky(card["x"], card["y"])
        card["is_target"] = any(math.hypot(tx - card["x"], ty - card["y"]) * scale <= 8 for tx, ty in targets)
        out["candidates"].append(card)
    return engine_plain(out)


@router.get("/api/quick/changes")
def quick_changes(id: str = Query(..., min_length=8, max_length=40, pattern=r"^[0-9a-f]+$")):
    """What moved, appeared, vanished, brightened or faded between the first and the last sky pass of
    the fast band, found on the wavelength-matched difference picture (see app/engine/changes.py)."""
    try:
        return difference_finds(api_views.manager(), id)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404, "That view does not exist (yet).") from None


# ---------------------------------------------------------------- motion of any star in the fast band
@router.get("/api/quick/motion")
def quick_motion(id: str = Query(..., min_length=8, max_length=40, pattern=r"^[0-9a-f]+$"),
                 x: float | None = Query(None, description="grid pixel in the viewer's orientation; omit both for the target"),
                 y: float | None = Query(None)):
    """A straight line through the star's position in every sky pass (brightness-weighted centre of
    each pass's stack): proper motion with its error, direction and whether it is significant.
    A saturated or blank core gives no centre, and the answer says so instead of guessing."""
    mgr = api_views.manager()
    try:
        meta, arr = mgr._load(id)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404, "That view does not exist (yet).") from None
    f = meta["field"]
    n, scale = f["n"], f["scale_arcsec"]
    centre = (n - 1) / 2
    positions, blank = [], 0
    for p in meta["passes"]:
        if x is None or y is None:
            tp = p.get("target_px")
            px, py = (tp[0], n - 1 - tp[1]) if tp else (centre, centre)
        else:
            px, py = x, y
        got = advanced.centroid(arr[f"S{p['index']}"], px, py)
        if got:
            positions.append({"mjd": p["mjd"], "start": p["start"], "east": -(got[0] - centre) * scale,
                              "north": (got[1] - centre) * scale})
        else:
            blank += 1
    fit = advanced.motion_fit(positions)
    if not fit.get("ok") and blank and len(positions) < 2:
        fit["reason"] = "saturated"                  # too few passes with an honest centre
    return engine_plain({**fit, "positions": positions, "passes": len(meta["passes"]), "band": meta["band"]["id"]})
