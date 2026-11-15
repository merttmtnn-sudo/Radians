"""Build the pass images of one field in one band: choose exposures, fetch cutouts in parallel
(with a disk cache), resample onto one grid, group into sky passes and stack them.

Quality levels (measured trade-offs in docs/BUILD_NOTES.md §14):
- preview:  image only. Where the image search gave the exposures' sky footprints and the file
            layout is known, every exposure is read in one request each (Reader.read_fast), so the
            first picture already has the full depth. Otherwise PREVIEW_PER_PASS exposures per pass
            are chosen to cover the wavelengths all passes share (their headers are read first);
- standard: image + variance for every exposure, plus quality flags for the detector rows next to
            the target (so a saturated target is recognised). After a fast preview this is one more
            request per exposure (Reader.finish);
- full:     quality flags for the whole box (costly: whole compressed detector rows).

The HTTP view API (P5) wraps build_band(); this module has no web code.
"""
from __future__ import annotations

import json
import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

from . import settings, stacking, store
from .fitsread import LayoutMismatch, Reader, pipeline_version, wavelength_at

NATIVE_PIX_ARCSEC = 6.15
DEFAULT_SCALE_ARCSEC = 2.0
MAX_GRID = 180                 # bigger fields get coarser output pixels, to bound memory
SNAP_DEG = 0.002               # centres snap to ~7" so nearby clicks share one cache
PREVIEW_PER_PASS = 8           # exposures per pass in a preview
PROBE_PER_PASS = 24            # headers read per pass to choose them (deep fields have hundreds)
MIN_STACK = 3                  # a median of fewer frames keeps cosmic rays when flags are missing
QUALITY = {"preview": 0, "standard": 1, "full": 2}
FLAGS_FOR_LEVEL = {0: None, 1: "near", 2: "all"}


def snap(ra: float, dec: float, step: float = SNAP_DEG) -> tuple[float, float]:
    d = min(90.0, max(-90.0, round(dec / step) * step))
    rstep = step / max(math.cos(math.radians(d)), 0.02)
    return round((round(ra / rstep) * rstep) % 360.0, 6), round(d, 6)


def cutout_half(size_arcmin: float) -> int:
    """Half-size, in detector pixels, of a box that covers the field at any roll angle."""
    return int(math.ceil(size_arcmin * 60 / NATIVE_PIX_ARCSEC / 2 * math.sqrt(2))) + 3


def grid_size(size_arcmin: float) -> tuple[int, float]:
    scale = max(DEFAULT_SCALE_ARCSEC, round(size_arcmin * 60 / MAX_GRID, 3))
    return int(round(size_arcmin * 60 / scale)), scale


def field_key(ra: float, dec: float) -> str:
    return f"{ra:09.5f}{dec:+09.5f}"


def spread_in_time(exps: list[dict], per_pass: int) -> list[dict]:
    """At most per_pass exposures of each pass, evenly spaced in time."""
    chosen = []
    for members in stacking.group_passes([e["mjd"] for e in exps]):
        members = sorted(members, key=lambda i: exps[i]["mjd"])
        if len(members) > per_pass:
            members = [members[j] for j in np.unique(np.linspace(0, len(members) - 1, per_pass).round().astype(int))]
        chosen += [exps[i] for i in members]
    return sorted(chosen, key=lambda e: e["mjd"])


def spread_in_wavelength(probed: list[dict], band: int, per_pass: int = PREVIEW_PER_PASS) -> tuple[list[dict], dict]:
    """Choose preview exposures so every pass covers the same wavelengths.

    probed: on-detector exposures with 'wave_um' (from their headers). A plain min/max overlap is
    fooled by one stray frame (ε Indi B D5: a 5-frame pass with one frame at 3.83 µm 'overlaps'
    3.86-4.32 µm but really covers 4.07-4.32). So the pass with the fewest frames in the shared
    range is the anchor: the window is its wavelength span plus one resolution element (6% of the
    band) each side, and every pass takes up to per_pass frames inside the window, evenly spaced in
    wavelength. A pass with fewer than MIN_STACK there is topped up with the frames nearest the
    window, so no preview stack is a median of two frames. Returns (chosen, info)."""
    if not probed:
        return [], dict(matched=False, range_um=None, warning=None)
    passes = {p: np.asarray(m, int) for p, m in enumerate(stacking.group_passes([e["mjd"] for e in probed]))}
    lam = np.array([e["wave_um"] for e in probed], float)
    inside, info = stacking.shared_range(passes, lam, band, min_frames=MIN_STACK)
    anchor = min(inside, key=lambda p: (len(inside[p]), p))
    pool = inside[anchor] if len(inside[anchor]) else passes[anchor]
    b_lo, b_hi = stacking.BANDS_UM.get(band, (float(lam.min()), float(lam.max())))
    tol = stacking.MATCH_TOL_FRACTION * (b_hi - b_lo)
    lo, hi = float(lam[pool].min()) - tol, float(lam[pool].max()) + tol
    chosen = []
    for p, members in passes.items():
        window = members[(lam[members] >= lo) & (lam[members] <= hi)]
        window = window[np.argsort(lam[window], kind="stable")]
        if len(window) > per_pass:
            window = window[np.unique(np.linspace(0, len(window) - 1, per_pass).round().astype(int))]
        if len(window) < MIN_STACK:                     # top up with the frames nearest the window
            centre = 0.5 * (lo + hi)
            spare = [i for i in members[np.argsort(np.abs(lam[members] - centre), kind="stable")] if i not in set(window)]
            window = np.r_[window, spare[:MIN_STACK - len(window)]].astype(int)
        chosen += [probed[i] for i in window]
    info = dict(info, range_um=[round(lo, 4), round(hi, 4)], anchor_pass=int(anchor))
    return sorted(chosen, key=lambda e: e["mjd"]), info


class CutoutCache:
    """Cutouts on disk, one .npz per exposure and detector, in a folder per field centre, plus a
    small header record per exposure (so probing and fetching never read the headers twice)."""

    def __init__(self, reader: Reader, root: Path | None = None):
        self.reader = reader
        self.root = Path(root or settings.DATA / "cutouts")

    def path(self, e: dict, ra: float, dec: float, kind: str = "npz") -> Path:
        return self.root / field_key(ra, dec) / f"{e['obs_id']}_D{e['det']}.{kind}"

    # -- headers ------------------------------------------------------------------------------
    def probe(self, e: dict, ra: float, dec: float) -> dict:
        """Header record of an exposure: on (target on the detector), wave_um at the target, and
        what read() needs to skip its own header request."""
        p = self.path(e, ra, dec, "head.npz")
        z = store.load_arrays(p) if p.exists() else None
        if z is None:
            h = self.reader.probe(e["url"], ra, dec)
            wx, wy, wv = h["wave"]
            store.save_arrays(p, hdr=h["hdr"].tostring(), wave_x=wx, wave_y=wy, wave_v=wv, total=h["total"],
                              n0=h["n0"], n1=h["n1"], on=h["on"], wave_um=np.nan if h["wave_um"] is None else h["wave_um"])
            z = store.load_arrays(p)
        return dict(e, on=bool(z["on"]), wave_um=float(z["wave_um"]),
                    head=dict(hdr=fits.Header.fromstring(z["hdr"]), wave=(z["wave_x"], z["wave_y"], z["wave_v"]),
                              total=int(z["total"]), n0=int(z["n0"]), n1=int(z["n1"])))

    # -- cutouts ------------------------------------------------------------------------------
    def get(self, e: dict, ra: float, dec: float, half: int, level: int) -> dict | None:
        """The cutout (fetched if needed), or None if the position is not on this detector."""
        p = self.path(e, ra, dec)
        z = store.load_arrays(p) if p.exists() else None
        if z is not None and bool(z["off"]):
            return None
        if z is not None and int(z["half"]) >= half and int(z.get("level", 0)) >= level:
            return _unpack(z, e)
        flags = FLAGS_FOR_LEVEL[level]
        url = e["url"]
        # a fast preview left the image here and what the rest needs: one request finishes the job
        if z is not None and level >= 1 and int(z["half"]) >= half and "pend_tiles" in z:
            try:
                h, w = z["img"].shape
                rest = self.reader.finish(url, int(z["x0"]), int(z["y0"]), w, h, float(z["yc"]), _pending(z), flags)
                record = {k: v for k, v in z.items() if not k.startswith("pend_")}
                record.update(level=level, var=rest["var"])
                if "flags" in rest:
                    record.update(flags=rest["flags"], flag_names=json.dumps(rest["flag_names"]), flag_rows=rest["flag_rows"])
                store.save_arrays(p, **record)
                return _unpack(store.load_arrays(p), e)
            except (LayoutMismatch, OSError, ValueError, KeyError):
                pass                                        # read it again the classic way
        c, pending = None, None
        if e.get("region"):
            try:
                c = self.reader.read_fast(url, ra, dec, half, e["region"])
            except (LayoutMismatch, OSError, ValueError):
                c = None
        if c is not None and not c["off"]:
            pending = c.pop("pending")
            if level >= 1:
                h, w = c["img"].shape
                try:
                    c.update(self.reader.finish(url, c["x0"], c["y0"], w, h, c["yc"], pending, flags))
                    pending = None
                except LayoutMismatch:
                    c = None
        if c is None:
            head = e.get("head")
            if head is None and self.path(e, ra, dec, "head.npz").exists():
                head = self.probe(e, ra, dec)["head"]          # headers already read for a preview
            c = self.reader.read(url, ra, dec, half, full=level >= 1, flags=flags, head=head)
        wx, wy, wv = c["wave"]
        record = dict(hdr=c["hdr"], mjd=c["mjd"], wave_x=wx, wave_y=wy, wave_v=wv, half=half,
                      level=level, off=c["off"], collection=e["collection"], url=url)
        if c["off"]:
            store.save_arrays(p, **record)
            return None
        h, w = c["img"].shape
        pm = stacking.fit_pixel_map(WCS(fits.Header.fromstring(c["hdr"])), c["x0"], c["y0"], c["x0"] + w, c["y0"] + h)
        record.update(img=c["img"], x0=c["x0"], y0=c["y0"], pm_center=pm["center"], pm_cx=pm["cx"], pm_cy=pm["cy"])
        if "var" in c:
            record["var"] = c["var"]
        if "flags" in c:
            record.update(flags=c["flags"], flag_names=json.dumps(c["flag_names"]), flag_rows=c["flag_rows"])
        if pending:                                         # kept for the request that adds variance and flags
            record.update(yc=c["yc"], pend_key=json.dumps(pending["key"]), pend_var_hdu=pending["var_hdu"],
                          pend_tiles=pending["tiles"], pend_y0=pending["tiles_y0"])
        store.save_arrays(p, **record)
        return _unpack(store.load_arrays(p), e)

    def fast(self, exps: list[dict]) -> bool:
        """Can these exposures be read in one request each? They need their sky footprints, and the
        layout of their files must be known; it is learnt here from one file per pipeline version
        (three requests, once: the answer is kept on disk)."""
        if not exps or not all(e.get("region") for e in exps):
            return False
        first = {}
        for e in exps:
            first.setdefault(pipeline_version(e["url"]), e["url"])
        try:
            return all(self.reader.prime(url) for url in first.values())
        except (OSError, ValueError):
            return False


def _pending(z: dict) -> dict:
    return dict(key=json.loads(str(z["pend_key"])), var_hdu=int(z["pend_var_hdu"]), tiles=z["pend_tiles"], tiles_y0=int(z["pend_y0"]))


def _unpack(z: dict, e: dict) -> dict:
    x0, y0 = (int(z[key]) for key in ("x0", "y0"))
    if "pm_cx" in z:
        pmap = dict(center=z["pm_center"], cx=z["pm_cx"], cy=z["pm_cy"])
    else:                                   # older cache file: fit the map now
        h, w = z["img"].shape
        pmap = stacking.fit_pixel_map(WCS(fits.Header.fromstring(z["hdr"])), x0, y0, x0 + w, y0 + h)
    return dict(obs_id=e["obs_id"], det=e["det"], collection=str(z["collection"]), url=str(z["url"]),
                mjd=float(z["mjd"]), img=z["img"], var=z.get("var"), flags=z.get("flags"),
                flag_names=json.loads(z["flag_names"]) if "flag_names" in z else {},
                flag_rows=[int(v) for v in z["flag_rows"]] if "flag_rows" in z else None,
                x0=x0, y0=y0, hdr=z["hdr"], pmap=pmap, wave=(z["wave_x"], z["wave_y"], z["wave_v"]),
                level=int(z.get("level", 0)))


_POOL = ThreadPoolExecutor(max_workers=settings.IRSA_CONCURRENCY, thread_name_prefix="fetch")


def run_parallel(fn, items: list, progress=None, pool: ThreadPoolExecutor | None = None):
    """fn(item) for every item on the fetch pool. Returns (results in item order with None for
    failures, error messages). One bad file never stops a view."""
    pool = pool or _POOL
    jobs = {pool.submit(fn, it): k for k, it in enumerate(items)}
    results, errors = [None] * len(items), []
    for count, job in enumerate(as_completed(jobs), 1):
        k = jobs[job]
        try:
            results[k] = job.result()
        except Exception as err:  # noqa: BLE001  (network or format problem with one file)
            it = items[k]
            errors.append(f"{it.get('obs_id')} D{it.get('det')}: {err}")
        if progress:
            progress(count, len(items))
    return results, errors


def fetch_all(cache: CutoutCache, exps: list[dict], ra: float, dec: float, half: int, level: int,
              progress=None, pool: ThreadPoolExecutor | None = None) -> tuple[list[dict], list[str]]:
    """Cutouts of every exposure that covers the position, sorted by time."""
    got, errors = run_parallel(lambda e: cache.get(e, ra, dec, half, level), exps, progress, pool)
    return sorted((c for c in got if c is not None), key=lambda c: c["mjd"]), errors


def iso_date(mjd: float) -> str:
    return Time(float(mjd), format="mjd").isot[:10]


def build_band(cache: CutoutCache, exps: list[dict], ra: float, dec: float, band: int,
               size_arcmin: float = 4.0, quality: str = "preview", progress=None) -> dict:
    """Pass stacks of one band. exps: SIA rows (any bands; only `band` is used).

    Returns a dict with: grid (n, scale, wcs header), frames (k,n,n), sats, waves, mjds, pass_of,
    passes (metadata per pass), stacks {pass: image}, levels, warnings, timing.
    """
    started = time.time()
    ra, dec = snap(ra, dec)
    level = QUALITY[quality]
    todo = [e for e in exps if e["det"] == band]
    errors: list[str] = []
    preview_info: dict = {}
    choose_first = False                 # the classic preview: read headers, then a few exposures per pass
    if level == 0:
        sample = spread_in_time(todo, PROBE_PER_PASS)
        if cache.fast(sample):           # one request per exposure: the preview uses all of them
            todo = sample
        else:
            choose_first = True
            probed, errors = run_parallel(lambda e: cache.probe(e, ra, dec), sample)
            todo, preview_info = spread_in_wavelength([p for p in probed if p and p["on"]], band)
    half = cutout_half(size_arcmin)
    cuts, fetch_errors = fetch_all(cache, todo, ra, dec, half, level, progress)
    errors += fetch_errors
    t_fetch = time.time() - started

    n, scale = grid_size(size_arcmin)
    gw = stacking.grid_wcs(ra, dec, n, scale)
    sky = stacking.grid_sky(gw, n)
    k = len(cuts)
    frames = np.empty((k, n, n), "f4")
    frames.fill(np.nan)
    sats = np.zeros_like(frames, dtype=bool)
    waves = np.full(k, np.nan)
    mjds = np.fromiter((c["mjd"] for c in cuts), float, count=k)
    for i, c in enumerate(cuts):
        tx, ty = stacking.apply_pixel_map(c["pmap"], ra, dec)
        waves[i] = wavelength_at(c["wave"], float(tx[0]), float(ty[0]))[0]
        frames[i], sats[i] = stacking.resample(c, c["pmap"], sky, n)
    t_resample = time.time() - started - t_fetch

    notes = [f"{len(errors)} exposure(s) could not be read and were skipped."] if errors else []
    pass_lists = stacking.group_passes(mjds)
    pass_of = np.full(k, -1, "i4")
    for number, members in enumerate(pass_lists):
        pass_of[members] = number
    members_of = {number: np.flatnonzero(pass_of == number) for number in range(len(pass_lists))}
    if choose_first:
        # the preview frames were already chosen to cover one shared range: stack all of them
        used_of, winfo = members_of, dict(preview_info, warning=preview_info.get("warning"))
    else:
        used_of, winfo = stacking.shared_range(members_of, waves, band, min_frames=MIN_STACK)
    notes += [winfo["warning"]] if winfo["warning"] else []
    stacks, passes = {}, []
    for number, members in members_of.items():
        used = used_of[number]
        stacks[number] = stacking.median_stack(frames, used)
        basis = used if len(used) else members
        info = dict(index=number, start=iso_date(mjds[members].min()), end=iso_date(mjds[members].max()),
                    mjd=round(float(mjds[basis].mean()), 3), n_frames=int(len(members)), n_used=int(len(used)),
                    wave_um=[round(float(np.nanmin(waves[used])), 3), round(float(np.nanmax(waves[used])), 3)] if len(used) else None,
                    saturated_fraction=float(sats[used].mean()) if len(used) else 0.0)
        passes.append(info)
        if len(used) < MIN_STACK:
            notes.append(f"Pass {number + 1} ({info['start']}) has only {len(used)} frame(s) at matching wavelengths: "
                         "its image is noisy and may keep cosmic-ray hits.")
    first_good = [stacks[p] for p in sorted(stacks) if np.isfinite(stacks[p]).any()]
    levels = stacking.display_levels(first_good[0]) if first_good else None
    if k == 0:
        notes.append(f"No SPHEREx exposures in band {band} cover this position yet.")
    return dict(ra=ra, dec=dec, band=band, size_arcmin=size_arcmin, quality=quality,
                grid=dict(n=n, scale_arcsec=scale, wcs=gw.to_header_string()),
                frames=frames, sats=sats, waves=waves, mjds=mjds, pass_of=pass_of,
                obs_ids=[c["obs_id"] for c in cuts], passes=passes, stacks=stacks, wavelengths=winfo,
                levels=levels, warnings=notes, errors=errors,
                timing=dict(fetch_s=round(t_fetch, 2), resample_s=round(t_resample, 2),
                            total_s=round(time.time() - started, 2), n_requested=len(todo), n_used=k,
                            fast=level == 0 and not choose_first))
