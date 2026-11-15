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

from . import advanced, catalogs, changes, photometry, render, settings, sia, sky, spectype, stacking, store
from .field import CutoutCache, build_band, cutout_half, fetch_all, snap
from .fitsread import Reader
from .http import Http

VERSION = 2                     # bump to invalidate stored views after a processing change
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
        self.gaia_dir = self.root.parent / "gaia"
        self.jobs: dict[str, dict] = {}
        self.changed = threading.Condition()
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="view")
        self._arrays: dict[str, tuple[float, dict]] = {}           # id -> (file time, arrays)
        self.spectra: dict[str, dict] = {}                         # spectrum jobs, by view and spot

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

    def _levels(self, meta: dict, stretch: str) -> tuple[float, float]:
        levels = meta["levels"]
        if not levels:
            raise KeyError("no image")
        name = levels["default"] if stretch in (None, "auto") else stretch
        if name not in ("faint", "bright"):
            raise KeyError(f"unknown stretch {stretch!r}")
        return tuple(levels[name])

    def _stack(self, meta: dict, arr: dict, p: int) -> np.ndarray:
        if not 0 <= p < len(meta["passes"]):
            raise KeyError(f"no pass {p}")
        return arr[f"S{p}"]

    def frame_png(self, vid: str, p: int, stretch: str = "auto") -> bytes:
        meta, arr = self._load(vid)
        return render.frame_png(self._stack(meta, arr, p), *self._levels(meta, stretch))

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
            stack_a = stacking.median_stack(arr["frames"], pairs[0])
            stack_b = stacking.median_stack(arr["frames"], pairs[1])
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

    def diff_png(self, vid: str, a: int, b: int) -> bytes:
        d, how = self.diff(vid, a, b)
        return render.diff_png(d, 10 * how["sigma"])

    def timecolor_png(self, vid: str, stretch: str = "auto") -> bytes:
        meta, arr = self._load(vid)
        n = len(meta["passes"])
        if n < 2:
            raise KeyError("colour-by-time needs at least two passes")
        first, last = arr["S0"], arr[f"S{n - 1}"]
        middle = arr[f"S{n // 2}"] if n > 2 else np.nanmean([first, last], axis=0)
        return render.timecolor_png(first, middle, last, *self._levels(meta, stretch))

    def blink_gif(self, vid: str, stretch: str = "auto") -> bytes:
        meta, arr = self._load(vid)
        lo, hi = self._levels(meta, stretch)
        frames = [render.stretch(render.fill_holes(arr[f"S{p['index']}"]), lo, hi) for p in meta["passes"]]
        if not frames:
            raise KeyError("no image")
        return render.gif(frames, [f"{p['start']}  band {meta['band']['id']}" for p in meta["passes"]])

    def catalog(self, vid: str, p: int) -> list[dict]:
        """Gaia DR3 stars in the field, at their positions on the date of pass p, in picture pixels."""
        meta = self._stored(vid)
        if meta is None or not 0 <= p < len(meta["passes"]):
            raise KeyError(vid)
        f = meta["field"]
        radius = f["size_arcmin"] / 60 * 0.75                     # reaches the corners
        stars = catalogs.at_date(catalogs.gaia_cone(self.http, f["ra"], f["dec"], round(radius, 4), self.gaia_dir),
                                 meta["passes"][p]["mjd"])
        grid = stacking.grid_wcs(f["ra"], f["dec"], f["n"], f["scale_arcsec"])
        if not stars:
            return []
        x, y = grid.all_world2pix([s["ra"] for s in stars], [s["dec"] for s in stars], 0)
        out = []
        for s, xi, yi in zip(stars, x, y):
            px, py = float(xi), f["n"] - 1 - float(yi)
            if -2 <= px <= f["n"] + 1 and -2 <= py <= f["n"] + 1:
                out.append(dict(id=s["id"], x=round(px, 2), y=round(py, 2), g=round(s["g"], 2),
                                pm=round((s["pmra"] ** 2 + s["pmdec"] ** 2) ** 0.5, 1)))
        return out


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

    # The target's slow results are kept next to the view, so they travel with the demo data.
    def _saved(self, meta: dict, name: str):
        got = store.read_json(self._dir(meta["id"]) / f"{name}.json")
        return got["data"] if got and got.get("built") == meta["built"] else None

    def _keep(self, meta: dict, name: str, data) -> None:
        store.write_json(self._dir(meta["id"]) / f"{name}.json", dict(built=meta["built"], data=data))

    def _spectrum_key(self, vid: str, meta: dict, x, y) -> str:
        _, spot = self._spot(meta, x, y)
        return f"{vid}:{'centre' if 'x' not in spot else f'{x:.0f},{y:.0f}'}"

    def spectrum(self, vid: str, x: float | None = None, y: float | None = None, wait: float = 0.0) -> dict:
        """Spectrum at a spot from every exposure in all six bands. The other bands' pictures are
        fetched in the background; the answer carries the progress until it is ready."""
        meta = self._stored(vid)
        if meta is None:
            raise KeyError(vid)
        key = self._spectrum_key(vid, meta, x, y)
        with self.changed:
            job = self.spectra.get(key)
            if job is None and key.endswith(":centre"):
                saved = self._saved(meta, "spectrum")
                if saved:
                    job = self.spectra[key] = dict(saved)
                    classified = self._saved(meta, "classify")
                    if classified:
                        job["classified"] = classified
            if job is None or job["state"] == "error":
                job = self.spectra[key] = dict(state="running", progress=dict(done=0, total=0), result=None, error=None)
                self.pool.submit(self._run_spectrum, key, meta, x, y)
            deadline = time.time() + wait
            seen = json.dumps(job["progress"])
            while wait > 0 and job["state"] == "running" and json.dumps(job["progress"]) == seen:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.changed.wait(left)
            return dict(state=job["state"], progress=job["progress"], error=job["error"], **(job["result"] or {}))

    def _run_spectrum(self, key: str, meta: dict, x, y):
        job = self.spectra[key]
        try:
            where, spot = self._spot(meta, x, y)
            f = meta["field"]
            exps = sia.exposures(self.http, f["ra"], f["dec"], self.sia_dir)
            first = meta["band"]["id"]
            order = [first] + [b for b in stacking.BANDS_UM if b != first]
            done_before, cuts = 0, []
            for band in order:
                n_band = sum(1 for e in exps if e["det"] == band)

                def progress(done, total, base=done_before):
                    with self.changed:
                        job["progress"] = dict(done=base + done, total=len(exps))
                        self.changed.notify_all()
                cuts += self._cuts(meta, band, progress)
                done_before += n_band
            result = photometry.spectrum(cuts, where, self._pass_of(meta))
            result.update(spot=spot, dates=[dict(index=p["index"], start=p["start"]) for p in meta["passes"]])
            with self.changed:
                job.update(state="ready", result=_plain(result), progress=dict(done=len(exps), total=len(exps)))
                self.changed.notify_all()
            if key.endswith(":centre"):
                self._keep(meta, "spectrum", dict(state="ready", progress=job["progress"], result=job["result"], error=None))
        except Exception as err:  # noqa: BLE001
            with self.changed:
                job.update(state="error", error=f"{type(err).__name__}: {err}"[:300])
                self.changed.notify_all()

    def classify(self, vid: str, x: float | None = None, y: float | None = None, wait: float = 0.0) -> dict:
        """Spectral type of a spot, three ways: the catalogues, our fit to the SPHEREx spectrum,
        and the molecular fingerprints. Needs the six-band spectrum, so it reports progress first."""
        sp = self.spectrum(vid, x, y, wait)
        if sp["state"] != "ready":
            return dict(state=sp["state"], progress=sp["progress"], error=sp["error"])
        meta = self._stored(vid)
        spot = sp["spot"]
        key = self._spectrum_key(vid, meta, x, y)
        job = self.spectra[key]
        if "classified" not in job:
            result = spectype.fit(sp["points"])
            prints = spectype.fingerprints(sp["points"])
            f = meta["field"]
            radius = round(f["size_arcmin"] * 0.75 / 60 + 2 / 60, 4)
            mjd = meta["passes"][-1]["mjd"] if meta["passes"] else sky.now_mjd()
            where, _ = self._spot(meta, x, y)
            ra, dec = where(mjd)
            catalog = dict(simbad=None, gaia=None, checked=[])
            simbad = catalogs.simbad_cone(self.http, f["ra"], f["dec"], radius, self.root.parent / "simbad")
            if simbad:
                catalog["checked"].append("SIMBAD")
                hits = catalogs.matches(simbad, ra, dec, mjd, 6.0)
                # several entries can sit on one spot (a star and its components): take one with a type
                typed = [h for h in hits if h[0].get("sp_type") and h[1] <= hits[0][1] + 2.0]
                hit = (typed or hits or [None])[0]
                if hit:
                    catalog["simbad"] = dict(id=hit[0]["id"], sp_type=hit[0].get("sp_type"), otype=hit[0].get("otype"), sep_arcsec=round(hit[1], 2))
            try:
                gaia = catalogs.gaia_cone(self.http, f["ra"], f["dec"], radius, self.gaia_dir)
            except Exception:  # noqa: BLE001  (catalogue not reachable)
                gaia = None
            if gaia:
                catalog["checked"].append("Gaia DR3")
                hit = catalogs.nearest(gaia, ra, dec, mjd, 4.0)
                if hit:
                    params = catalogs.gaia_parameters(self.http, hit[0]["id"], self.gaia_dir) or {}
                    catalog["gaia"] = dict(id=hit[0]["id"], g=hit[0]["g"], sep_arcsec=round(hit[1], 2), **params)
            cat_type = (catalog["simbad"] or {}).get("sp_type")
            cat_teff = (catalog["gaia"] or {}).get("teff_gspphot")
            job["classified"] = _plain(dict(fit=result, fingerprints=prints, catalog=catalog,
                                            agreement=spectype.agreement(cat_type, cat_teff, result)))
            if key.endswith(":centre") and (catalog["simbad"] or catalog["gaia"]):
                self._keep(meta, "classify", job["classified"])     # not kept when the catalogues were down
        return dict(state="ready", spot=spot, **job["classified"])

    # -- advanced drawer -----------------------------------------------------------------------
    def flags_png(self, vid: str, p: int) -> bytes:
        """Red where a pixel was saturated or blank in at least 30% of the pass's pictures."""
        meta, arr = self._load(vid)
        if f"Q{p}" not in arr:
            raise KeyError("no flag map")
        return render.mask_png(arr[f"Q{p}"] >= 0.3)

    def stack_fits(self, vid: str, p: int) -> bytes:
        """One pass's stacked image as a FITS file with its sky coordinates."""
        import io

        from astropy.io import fits
        meta, arr = self._load(vid)
        f = meta["field"]
        header = stacking.grid_wcs(f["ra"], f["dec"], f["n"], f["scale_arcsec"]).to_header()
        info = meta["passes"][p] if 0 <= p < len(meta["passes"]) else None
        if info is None:
            raise KeyError("no such pass")
        header["BUNIT"] = "MJy/sr"
        header["DATE-BEG"], header["DATE-END"] = info["start"], info["end"]
        header["NFRAMES"] = (info["n_used"], "exposures in this median stack")
        header["BAND"] = (meta["band"]["id"], "SPHEREx detector band")
        header["COMMENT"] = "Skyshift: sky-subtracted median stack of SPHEREx level-2 exposures (IRSA)."
        buf = io.BytesIO()
        fits.PrimaryHDU(arr[f"S{p}"].astype("f4"), header).writeto(buf)
        return buf.getvalue()

    def _gaia_at(self, meta: dict, x, y) -> dict | None:
        f = meta["field"]
        radius = round(f["size_arcmin"] * 0.75 / 60 + 2 / 60, 4)
        mjd = meta["passes"][-1]["mjd"] if meta["passes"] else sky.now_mjd()
        ra, dec = self._spot(meta, x, y)[0](mjd)
        try:
            hit = catalogs.nearest(catalogs.gaia_cone(self.http, f["ra"], f["dec"], radius, self.gaia_dir), ra, dec, mjd, 4.0)
        except Exception:  # noqa: BLE001
            return None
        if not hit:
            return None
        return dict(hit[0], **(catalogs.gaia_parameters(self.http, hit[0]["id"], self.gaia_dir) or {}))

    def period(self, vid: str, x: float | None = None, y: float | None = None) -> dict:
        lc = self.lightcurve(vid, x, y)
        return _plain(dict(advanced.period_search(lc["points"], lc["mode"]), units=lc["units"], mode=lc["mode"]))

    def motion(self, vid: str, x: float | None = None, y: float | None = None) -> dict:
        """Proper motion from the star's position in each pass, next to the catalogue's value."""
        meta, arr = self._load(vid)
        f = meta["field"]
        n, scale = f["n"], f["scale_arcsec"]
        centre = (n - 1) / 2
        positions = []
        for p in meta["passes"]:
            px = p.get("target_px") if (x is None or y is None) else [x, y]
            px = px or [centre, centre]
            got = advanced.centroid(arr[f"S{p['index']}"], px[0], n - 1 - px[1])
            if got:
                positions.append(dict(mjd=p["mjd"], start=p["start"], east=-(got[0] - centre) * scale, north=(got[1] - centre) * scale))
        fit = advanced.motion_fit(positions)
        gaia = self._gaia_at(meta, x, y)
        catalog = None
        if gaia:
            rate = math.hypot(gaia["pmra"], gaia["pmdec"]) / 1000
            catalog = dict(id=gaia["id"], rate=rate, direction=changes.compass(math.degrees(math.atan2(gaia["pmra"], gaia["pmdec"])) % 360),
                           parallax=gaia.get("parallax") or gaia.get("plx"),
                           speed_kms=advanced.tangential_speed(rate, gaia.get("parallax") or gaia.get("plx")))
            if fit.get("ok"):
                fit["speed_kms"] = advanced.tangential_speed(fit["rate"], catalog["parallax"])
        return _plain(dict(fit, positions=positions, catalog=catalog))

    def hr(self, vid: str, x: float | None = None, y: float | None = None) -> dict:
        """Gaia stars around the field for the H-R and reduced proper-motion diagrams, and the measured star among them."""
        meta = self._stored(vid)
        if meta is None:
            raise KeyError(vid)
        stars = advanced.hr_field(self.http, round(meta["field"]["ra"], 3), round(meta["field"]["dec"], 3), 0.5, self.gaia_dir)
        gaia = self._gaia_at(meta, x, y)
        star = advanced.hr_point(dict(source_id=gaia["id"], parallax=gaia.get("parallax"), phot_g_mean_mag=gaia.get("phot_g_mean_mag"),
                                      bp_rp=gaia.get("bp_rp"), pmra=gaia["pmra"], pmdec=gaia["pmdec"])) if gaia else None
        return _plain(dict(stars=stars, star=star, reachable=stars is not None))

    def star(self, vid: str, x: float | None = None, y: float | None = None) -> dict:
        """The measured star in other catalogues: Gaia DR3, 2MASS, AllWISE."""
        meta = self._stored(vid)
        if meta is None:
            raise KeyError(vid)
        gaia = self._gaia_at(meta, x, y)
        mjd = meta["passes"][-1]["mjd"] if meta["passes"] else sky.now_mjd()
        if gaia:
            where = gaia
        else:
            ra, dec = self._spot(meta, x, y)[0](mjd)
            where = dict(ra=ra, dec=dec, pmra=0.0, pmdec=0.0, epoch=sky.jyear(mjd))
        ra, dec = sky.position_at(where, mjd, parallax=False)
        return _plain(dict(ra=ra, dec=dec, gaia=gaia, surveys=advanced.cross_match(self.http, where, cache_dir=self.root.parent / "xmatch")))

    def changes(self, vid: str, a: int | None = None, b: int | None = None) -> dict:
        """What changed between two passes (default: first and last), checked against catalogues."""
        meta = self._stored(vid)
        if meta is None or len(meta["passes"]) < 2:
            raise KeyError(vid)
        n_pass = len(meta["passes"])
        a, b = (0 if a is None else a), (n_pass - 1 if b is None else b)
        if not (0 <= a < n_pass and 0 <= b < n_pass) or a == b:
            raise KeyError("no such pair of passes")
        a, b = min(a, b), max(a, b)
        path = self._dir(vid) / f"changes_{a}_{b}.json"
        cached = store.read_json(path)
        if cached and cached.get("built") == meta["built"] and cached.get("version") == changes.__name__ + str(VERSION):
            return cached
        stack_a, stack_b, d, how = self._diff(vid, a, b)
        f, pa, pb = meta["field"], meta["passes"][a], meta["passes"][b]
        years = (pb["mjd"] - pa["mjd"]) / 365.25
        found, notes = changes.find_changes(stack_a, stack_b, d, f["scale_arcsec"], years, (how["n_a"], how["n_b"]))
        radius = round(f["size_arcmin"] * 0.75 / 60 + 2 / 60, 4)
        def gaia():
            try:
                return catalogs.gaia_cone(self.http, f["ra"], f["dec"], radius, self.gaia_dir)
            except Exception:  # noqa: BLE001  (not reachable: this catalogue could not be checked)
                return None
        lookups = {"Gaia DR3": gaia,
                   "CatWISE2020": lambda: catalogs.catwise_cone(self.http, f["ra"], f["dec"], radius, self.root.parent / "catwise"),
                   "SIMBAD": lambda: catalogs.simbad_cone(self.http, f["ra"], f["dec"], radius, self.root.parent / "simbad")}
        # the three services answer slowly (tens of seconds each, once per field): ask them together
        with ThreadPoolExecutor(max_workers=3) as asks:
            waiting = {name: asks.submit(fn) for name, fn in lookups.items()}
            cats = {name: job.result() for name, job in waiting.items()}
        # an empty list is a hole in the catalogue (e.g. CatWISE near very bright stars), not a check
        checked = [name for name, rows in cats.items() if rows]
        n = f["n"]
        items = []
        for it in found:
            ends = [(it["x1"], it["y1"], pa["mjd"]), (it["x2"], it["y2"], pb["mjd"])] if it["kind"] == "mover" else \
                [(it["x"], it["y"], pa["mjd"] if it["kind"] in ("vanished", "faded") else pb["mjd"])]
            spots = [(*_where(meta, gx, n - 1 - gy), mjd) for gx, gy, mjd in ends]
            reach = 6.0 if it.get("saturated") else 4.0
            known = {}
            for name in checked:
                hits = [h for h in (catalogs.nearest(cats[name], ra, dec, mjd, reach) for ra, dec, mjd in spots) if h]
                if hits:
                    star, sep = min(hits, key=lambda h: h[1])
                    known[name] = dict(id=star["id"], sep_arcsec=round(sep, 2), otype=star.get("otype"),
                                       pm_arcsec_yr=round(math.hypot(star["pmra"], star["pmdec"]) / 1000, 3))
            out = {k: v for k, v in it.items() if k not in ("x", "y", "x1", "y1", "x2", "y2")}
            if it["kind"] == "mover":
                out.update(x1=it["x1"], y1=n - 1 - it["y1"], x2=it["x2"], y2=n - 1 - it["y2"], x=it["x2"], y=n - 1 - it["y2"])
            else:
                out.update(x=it["x"], y=n - 1 - it["y"])
            out.update(ra=spots[-1][0], dec=spots[-1][1], known=known,
                       possibly_new=not known and len(checked) == len(cats))
            target = [p.get("target_px") for p in (pa, pb) if p.get("target_px")]
            out["is_target"] = any(math.hypot(t[0] - out["x"], t[1] - out["y"]) * f["scale_arcsec"] <= 8 for t in target)
            items.append(out)
        result = _plain(dict(version=changes.__name__ + str(VERSION), built=meta["built"], a=a, b=b, start_a=pa["start"],
                             start_b=pb["start"], years=years, matched=how["matched"], n_a=how["n_a"], n_b=how["n_b"],
                             items=items, notes=notes, checked=checked,
                             unchecked=[name for name in cats if name not in checked]))
        if self._dir(vid) == self.root / vid:
            store.write_json(path, result)
        return result



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
