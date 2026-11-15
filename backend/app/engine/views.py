"""Time-lapse views: one sky field in one band, as a stacked image per SPHEREx sky pass.

A view is built in the background in two steps, so there is something to look at quickly:
a preview (a few exposures per pass), then the standard build (every exposure). Finished products
(stacks, frames, metadata) are kept on disk, so a view opens at once the next time, and the demo
targets can ship pre-built in the demo/ folder.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from . import photometry, settings, sia, sky, stacking, store
from .field import CutoutCache, build_band, cutout_half, fetch_all, snap
from .fitsread import Reader
from .http import Http

VERSION = 3                     # bump to invalidate stored views after a processing change
                                # (3: clipped-mean pass pictures, 20-day visits, 2" pixels on big fields)
SIZE_RANGE = (1.0, 10.0)        # arcmin
QUALITIES = ("preview", "standard")
TARGET_KEYS = ("ra", "dec", "pmra", "pmdec", "plx", "epoch")


def make_spec(ra: float, dec: float, band: int = 5, size_arcmin: float = 4.0, target: dict | None = None) -> dict:
    """A normalised request. target (optional): a catalogue entry with proper motion, whose
    predicted position is marked on every pass."""
    ra, dec = snap(float(ra), float(dec))
    size = min(max(round(float(size_arcmin) * 2) / 2, SIZE_RANGE[0]), SIZE_RANGE[1])
    if int(band) not in stacking.BANDS_UM:
        raise ValueError("band must be 1 to 6")
    tgt = None
    if target:
        tgt = {k: round(float(target.get(k) or (2000.0 if k == "epoch" else 0.0)), 6) for k in TARGET_KEYS}
        tgt["name"] = str(target.get("name") or "")[:80]
    return dict(ra=ra, dec=dec, band=int(band), size_arcmin=size, target=tgt)


def demo_spec(pin: str, band: int, size: float) -> dict | None:
    """The stored spec of a pre-built demo view, so a curated target opens instantly whatever
    today's date (a moving star's 'position now' would otherwise give a new view id)."""
    index = store.read_json(settings.DEMO / "index.json") or {}
    return index.get(f"{pin};{band};{size:g}")


def view_id(spec: dict) -> str:
    return hashlib.sha1(json.dumps([VERSION, spec], sort_keys=True).encode()).hexdigest()[:16]


class ViewManager:
    def __init__(self, http: Http | None = None, root: Path | None = None, cutouts: Path | None = None,
                 workers: int = 2, seed_layouts: Path | None = None):
        self.http = http or Http()
        self.root = Path(root or settings.DATA / "views")
        # file layouts learnt while reading are kept next to the views; seed_layouts ships known ones
        self.cache = CutoutCache(Reader(self.http, layout_file=self.root.parent / "layouts.json", seed_file=seed_layouts), cutouts)
        self.sia_dir = self.root.parent / "sia"
        self.jobs: dict[str, dict] = {}
        self.changed = threading.Condition()
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="view")
        self._arrays: dict[str, tuple[float, dict]] = {}           # id -> (file time, arrays)

    # -- where things are ---------------------------------------------------------------------
    def _dir(self, vid: str) -> Path:
        demo = settings.DEMO / "views" / vid
        return demo if (demo / "meta.json").exists() else self.root / vid

    def _stored(self, vid: str) -> dict | None:
        return store.read_json(self._dir(vid) / "meta.json")

    # -- building -----------------------------------------------------------------------------
    def submit(self, spec: dict) -> dict:
        vid = view_id(spec)
        with self.changed:
            job = self.jobs.get(vid)
            if job is None or job["state"] == "error":
                stored = self._stored(vid)
                if stored and stored.get("quality") == QUALITIES[-1]:
                    job = dict(id=vid, state="ready", rev=1, progress=None, error=None)
                else:
                    job = dict(id=vid, state="queued", rev=0, progress=dict(done=0, total=0, stage="search"), error=None)
                    self.pool.submit(self._run, vid, spec)
                self.jobs[vid] = job
        return self.status(vid)

    def _set(self, vid: str, **changes):
        with self.changed:
            self.jobs[vid].update(changes)
            self.changed.notify_all()

    def _run(self, vid: str, spec: dict):
        try:
            self._set(vid, state="running")
            exps = sia.exposures(self.http, spec["ra"], spec["dec"], self.sia_dir)
            in_band = sum(1 for e in exps if e["det"] == spec["band"])
            for quality in QUALITIES:
                def progress(done, total, quality=quality):
                    self._set(vid, progress=dict(done=done, total=total, stage=quality))
                self._set(vid, progress=dict(done=0, total=0, stage=quality))
                res = build_band(self.cache, exps, spec["ra"], spec["dec"], spec["band"], spec["size_arcmin"], quality, progress)
                # a preview is the final picture only if nothing can be added: every exposure is in it
                # and none is waiting for its variance and flags
                final = quality == QUALITIES[-1] or (res["timing"]["n_requested"] >= in_band and not res["timing"]["fast"])
                self._save(vid, spec, res, QUALITIES[-1] if final else quality, len(exps))
                self._set(vid, rev=self.jobs[vid]["rev"] + 1)
                if final:
                    break
            self._set(vid, state="ready", progress=None)
        except Exception as err:  # noqa: BLE001  (reported to the user as a plain message)
            self._set(vid, state="error", error=f"{type(err).__name__}: {err}"[:300])

    def _save(self, vid: str, spec: dict, res: dict, quality: str, n_all: int):
        n, scale = res["grid"]["n"], res["grid"]["scale_arcsec"]
        grid = stacking.grid_wcs(spec["ra"], spec["dec"], n, scale)
        passes = []
        for p in res["passes"]:
            p = dict(p)
            if spec["target"]:
                ra_t, dec_t = sky.position_at(spec["target"], p["mjd"])
                x, y = (float(v) for v in grid.all_world2pix(ra_t, dec_t, 0))
                p["target_px"] = [round(x, 2), round(n - 1 - y, 2)]          # picture pixels: x right, y down
            passes.append(p)
        lo, hi = stacking.BANDS_UM[spec["band"]]
        meta = dict(id=vid, version=VERSION, quality=quality, spec=spec, built=time.time(),
                    field=dict(ra=spec["ra"], dec=spec["dec"], size_arcmin=spec["size_arcmin"], n=n, scale_arcsec=scale),
                    band=dict(id=spec["band"], um=[lo, hi]), passes=passes, levels=res["levels"],
                    wavelengths=res["wavelengths"], warnings=res["warnings"], n_exposures=n_all,
                    n_band=int(len(res["mjds"])), skipped=len(res["errors"]))
        arrays = dict(frames=res["frames"], waves=res["waves"], mjds=res["mjds"], pass_of=res["pass_of"])
        arrays.update({f"S{p}": s for p, s in res["stacks"].items()})
        # how often each pixel was saturated or blank in a pass: drawn over the picture as a warning
        for p in res["stacks"]:
            mine = res["pass_of"] == p
            blank = ~np.isfinite(res["frames"][mine])
            arrays[f"Q{p}"] = ((res["sats"][mine] | blank).mean(axis=0) if mine.any() else np.zeros_like(res["stacks"][p])).astype("f4")
        folder = self.root / vid
        store.save_arrays(folder / "arrays.npz", **arrays)
        store.write_json(folder / "meta.json", _plain(meta))
        self._arrays.pop(vid, None)

    # -- reading ------------------------------------------------------------------------------
    def status(self, vid: str, wait: float = 0.0) -> dict:
        """What the page shows: state, progress, and the metadata of the best build so far.
        With wait > 0 it returns as soon as something changes, or after that many seconds."""
        deadline = time.time() + wait
        with self.changed:
            job = self.jobs.get(vid)
            if job is None:
                stored = self._stored(vid)
                if stored is None:
                    raise KeyError(vid)
                job = self.jobs[vid] = dict(id=vid, state="ready", rev=1, progress=None, error=None)
            seen = (job["state"], job["rev"], json.dumps(job["progress"]))
            while wait > 0 and job["state"] in ("queued", "running"):
                left = deadline - time.time()
                if left <= 0 or (job["state"], job["rev"], json.dumps(job["progress"])) != seen:
                    break
                self.changed.wait(left)
            out = dict(job)
        out["view"] = self._stored(vid) if out["rev"] else None
        return out

    def _load(self, vid: str) -> tuple[dict, dict]:
        meta = self._stored(vid)
        if meta is None:
            raise KeyError(vid)
        path = self._dir(vid) / "arrays.npz"
        stamp = path.stat().st_mtime
        hit = self._arrays.get(vid)
        if hit is None or hit[0] != stamp:
            if len(self._arrays) >= 6:                       # a handful of views in memory is plenty
                self._arrays.pop(next(iter(self._arrays)))
            hit = self._arrays[vid] = (stamp, store.load_arrays(path))
        return meta, hit[1]

    def _stack(self, meta: dict, arr: dict, p: int) -> np.ndarray:
        if not 0 <= p < len(meta["passes"]):
            raise KeyError(f"no pass {p}")
        return arr[f"S{p}"]

    def diff(self, vid: str, a: int, b: int) -> tuple[np.ndarray, dict]:
        """Pass b minus pass a at matching wavelengths, and how it was made."""
        return self._diff(vid, a, b)[2:]

    def _diff(self, vid: str, a: int, b: int):
        meta, arr = self._load(vid)
        if a == b:
            raise KeyError("a difference needs two different passes")
        stack_a, stack_b = self._stack(meta, arr, a), self._stack(meta, arr, b)
        lo, hi = stacking.BANDS_UM[meta["band"]["id"]]
        ia, ib = np.flatnonzero(arr["pass_of"] == a), np.flatnonzero(arr["pass_of"] == b)
        pairs = stacking.pair_by_wavelength(ia, ib, arr["waves"], stacking.MATCH_TOL_FRACTION * (hi - lo))
        if pairs is not None:
            stack_a = stacking.pass_stack(arr["frames"], pairs[0])
            stack_b = stacking.pass_stack(arr["frames"], pairs[1])
            used = np.concatenate(pairs)
            how = dict(matched=True, n_a=int(len(pairs[0])), n_b=int(len(pairs[1])),
                       wave_um=[round(float(np.nanmin(arr["waves"][used])), 3), round(float(np.nanmax(arr["waves"][used])), 3)])
        else:
            how = dict(matched=False, n_a=int(len(ia)), n_b=int(len(ib)), wave_um=None)
        d = stack_b - stack_a
        _, sigma = stacking.robust_stats(d)
        how.update(a=a, b=b, sigma=sigma if np.isfinite(sigma) and sigma > 0 else 1e-3,
                   start_a=meta["passes"][a]["start"], start_b=meta["passes"][b]["start"])
        return stack_a, stack_b, d, _plain(how)

    # -- measurements -------------------------------------------------------------------------
    def _spot(self, meta: dict, x: float | None, y: float | None):
        """(mjd -> (ra, dec), description) of the spot to measure: the view's own target or centre
        when no pixel is given or the click is on the target's track, else the fixed sky position."""
        f, target = meta["field"], meta["spec"]["target"]
        if x is not None and y is not None and target:
            near = [math.hypot(p["target_px"][0] - x, p["target_px"][1] - y) * f["scale_arcsec"]
                    for p in meta["passes"] if p.get("target_px")]
            if near and min(near) <= 10.0:
                x = y = None
        if x is None or y is None:
            if target:
                return (lambda mjd: sky.position_at(target, mjd)), dict(target=True, name=target["name"], ra=f["ra"], dec=f["dec"])
            return (lambda mjd: (f["ra"], f["dec"])), dict(target=True, name="", ra=f["ra"], dec=f["dec"])
        ra, dec = _where(meta, x, y)
        return (lambda mjd: (ra, dec)), dict(target=False, name="", ra=ra, dec=dec, x=x, y=y)

    def _cuts(self, meta: dict, band: int, progress=None) -> list[dict]:
        f = meta["field"]
        exps = [e for e in sia.exposures(self.http, f["ra"], f["dec"], self.sia_dir) if e["det"] == band]
        return fetch_all(self.cache, exps, f["ra"], f["dec"], cutout_half(f["size_arcmin"]), 1, progress)[0]

    @staticmethod
    def _pass_of(meta: dict):
        means = [p["mjd"] for p in meta["passes"]]
        return lambda mjd: int(np.argmin([abs(mjd - m) for m in means])) if means else 0

    def lightcurve(self, vid: str, x: float | None = None, y: float | None = None) -> dict:
        """Brightness over time at a spot, in the view's band."""
        meta = self._stored(vid)
        if meta is None:
            raise KeyError(vid)
        where, spot = self._spot(meta, x, y)
        centre = "x" not in spot
        saved = self._saved(meta, "lightcurve") if centre else None
        if saved:
            return saved
        rows, info = photometry.series(self._cuts(meta, meta["band"]["id"]), where)
        out = photometry.light_curve(rows, info, self._pass_of(meta))
        out = _plain(dict(out, spot=spot, band=meta["band"]["id"],
                          dates=[dict(index=p["index"], start=p["start"], mjd=p["mjd"]) for p in meta["passes"]]))
        if centre:
            self._keep(meta, "lightcurve", out)
        return out

    # The target's light curve is kept next to the view, so it travels with the demo data.
    def _saved(self, meta: dict, name: str):
        got = store.read_json(self._dir(meta["id"]) / f"{name}.json")
        return got["data"] if got and got.get("built") == meta["built"] else None

    def _keep(self, meta: dict, name: str, data) -> None:
        store.write_json(self._dir(meta["id"]) / f"{name}.json", dict(built=meta["built"], data=data))


def _where(meta: dict, x: float, y: float) -> tuple[float, float]:
    """Sky position of a picture pixel (x right, y down) of a view."""
    f = meta["field"]
    grid = stacking.grid_wcs(f["ra"], f["dec"], f["n"], f["scale_arcsec"])
    ra, dec = grid.all_pix2world(x, f["n"] - 1 - y, 0)
    return float(ra), float(dec)


def _plain(o):
    """JSON-safe: numpy numbers to Python, NaN and infinity to None."""
    if isinstance(o, dict):
        return {str(k): _plain(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, np.ndarray)):
        return [_plain(v) for v in o]
    if isinstance(o, (bool, np.bool_)):
        return bool(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (float, np.floating)):
        return float(o) if np.isfinite(o) else None
    return o
