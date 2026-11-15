"""Turn SPHEREx exposures into aligned frames: reproject, background-subtract, group, co-add."""
from __future__ import annotations

import base64
import hashlib
import math
import pickle
import threading
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.time import Time
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

from . import config, fitsrange
from .archive import Exposure


@dataclass
class Frame:
    exp: Exposure
    image: np.ndarray       # background-subtracted, on the output grid
    variance: np.ndarray
    flags: np.ndarray
    wavelength: float | None = None
    bandwidth: float | None = None
    phot: dict = field(default_factory=dict)
    header: object = None          # detector WCS header of the cutout (for wavelengths elsewhere)


def output_wcs(ra, dec, n):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    s = config.PIXEL_SCALE / 3600
    w.wcs.cdelt = [-s, s]
    return w


def propagate(ra, dec, pmra, pmdec, ref_year, mjd):
    """Linear proper-motion shift (mas/yr) from ref_year (Julian) to mjd."""
    if not pmra and not pmdec:
        return ra, dec
    dt = Time(mjd, format="mjd").jyear - ref_year
    dec2 = dec + (pmdec or 0) * dt / 3.6e6
    ra2 = ra + (pmra or 0) * dt / 3.6e6 / max(1e-6, math.cos(math.radians(dec)))
    return ra2 % 360, dec2


def _covers(cut, ra, dec, half) -> bool:
    """Does a cached cutout contain the box of +-half pixels around (ra, dec)?"""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        x, y = WCS(cut.header).all_world2pix([[ra, dec]], 0, quiet=True)[0]
    n = config.DETECTOR_SIZE
    ny, nx = cut.image.shape
    xa, xb = max(0, round(x) - half), min(n, round(x) + half + 1)
    ya, yb = max(0, round(y) - half), min(n, round(y) + half + 1)
    return cut.x0 <= xa and xb <= cut.x0 + nx and cut.y0 <= ya and yb <= cut.y0 + ny


def _load(p):
    try:
        return pickle.loads(p.read_bytes()) if p.exists() else None
    except Exception:
        return None


def _cutout_cached(exp: Exposure, ra, dec, half):
    """One cached cutout per exposure; reused whenever it already covers the requested box,
    so a smaller field of view or a slightly different centre costs no download."""
    cdir = config.CACHE_DIR / "cut"
    p = cdir / (hashlib.sha1(exp.url.encode()).hexdigest() + ".pkl")
    c = _load(p)
    if c is None:          # cache written by older versions (keyed on centre and size)
        c = _load(cdir / (hashlib.sha1(f"{exp.url}|{ra:.5f}|{dec:.5f}|{half}".encode()).hexdigest() + ".pkl"))
    if c is not None and _covers(c, ra, dec, half):
        if not p.exists():
            config.atomic_write(p, pickle.dumps(c))
        return c
    c = fitsrange.read_cutout(exp.url, ra, dec, half)
    p.parent.mkdir(parents=True, exist_ok=True)
    if c is not None:
        config.atomic_write(p, pickle.dumps(c))
    return c


def _background(img):
    m = np.isfinite(img)
    if m.sum() < 10:
        return 0.0
    _, med, _ = sigma_clipped_stats(img[m], sigma=3, maxiters=5)
    return float(med)


def _aperture(img, var, flg, px, py, r=config.APERTURE_PX):
    n = img.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    ap = (xx - px) ** 2 + (yy - py) ** 2 <= r * r
    if not ap.any():
        return None
    good = ap & np.isfinite(img)
    if not good.any():                      # e.g. a saturated core the pipeline blanked
        return None
    # MJy/sr * pixel solid angle -> microJansky
    pix_sr = (config.PIXEL_SCALE / 206264.806) ** 2
    to_ujy = pix_sr * 1e12
    return {
        "flux_ujy": float(np.nansum(img[good]) * to_ujy),
        "err_ujy": float(np.sqrt(np.nansum(var[good])) * to_ujy),
        "flagged": bool(((np.bitwise_or.reduce(flg[ap]) & config.BAD_MASK) != 0) or good.sum() < ap.sum()),
        "flags": int(np.bitwise_or.reduce(flg[ap])),
    }


SATURATION_MASK = sum(1 << b for b, nm in config.FLAG_BITS.items() if nm in ("OVERFLOW", "NONLINEAR", "BLOOM"))
R_BG_IN, R_BG_OUT = 5.0, 8.0          # px, local background annulus
R_WING_IN, R_WING_OUT = 2.5, 4.5      # px, PSF wings: still measurable when the core saturates


def measure(img, var, flg, px, py, r=config.APERTURE_PX):
    """Aperture photometry with a local sigma-clipped annulus background (as in the IRSA SPHEREx
    notebooks), plus the flux in the PSF wings, which tracks the brightness of saturated stars."""
    n = img.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    r2 = (xx - px) ** 2 + (yy - py) ** 2
    fin = np.isfinite(img)
    ap = r2 <= r * r
    if not ap.any():
        return {}
    ann = (r2 >= R_BG_IN ** 2) & (r2 <= R_BG_OUT ** 2) & fin & ((flg & config.BAD_MASK) == 0)
    bg = 0.0
    if ann.sum() >= 8:
        _, bg, _ = sigma_clipped_stats(img[ann], sigma=3, maxiters=5)
        bg = float(bg)
    to_ujy = (config.PIXEL_SCALE / 206264.806) ** 2 * 1e12        # MJy/sr * pixel -> microJansky
    good = ap & fin
    ap_flags = int(np.bitwise_or.reduce(flg[ap]))
    out = {"flags": ap_flags, "background": bg,
           "saturated": bool(ap_flags & SATURATION_MASK) or bool(good.sum() < ap.sum())}
    if good.any():
        out.update({
            "flux_ujy": float((img[good].sum() - bg * good.sum()) * to_ujy),
            "err_ujy": float(np.sqrt(np.nansum(var[good])) * to_ujy),
            "flagged": bool((ap_flags & config.BAD_MASK) != 0 or good.sum() < ap.sum()),
        })
    else:
        out.update({"flux_ujy": None, "err_ujy": None, "flagged": True})
    wing = (r2 >= R_WING_IN ** 2) & (r2 <= R_WING_OUT ** 2) & fin & ((flg & config.BAD_MASK) == 0)
    if wing.sum() >= 6:
        out["wing_ujy"] = float((img[wing].sum() - bg * wing.sum()) * to_ujy * (np.pi * (R_WING_OUT ** 2 - R_WING_IN ** 2) / wing.sum()))
    return out


_wcs_cache: dict = {}
_wcs_lock = threading.Lock()


def frame_wcs(f: "Frame") -> WCS:
    """Detector WCS of an exposure, parsed once (parsing ~20 ms is most of a spectrum's cost)."""
    key = (f.exp.obs_id, f.exp.detector)
    w = _wcs_cache.get(key)
    if w is None:
        w = WCS(f.header)
        with _wcs_lock:
            _wcs_cache[key] = w
            while len(_wcs_cache) > 4000:
                _wcs_cache.pop(next(iter(_wcs_cache)))
    return w


def wavelength_for(f: "Frame", ra, dec):
    """Wavelength SPHEREx saw at sky position (ra, dec) in this exposure (linear-variable filter)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        dx, dy = frame_wcs(f).all_world2pix([[ra, dec]], 0, quiet=True)[0]
        try:
            tab = fitsrange.wave_table(f.exp.url, f.exp.detector)
            return fitsrange.wavelength_at(f.header, tab, float(dx), float(dy))
        except Exception:
            return 0.5 * (f.exp.wl_min + f.exp.wl_max), None


def photometry_at(frames: list["Frame"], wout, x, y):
    """Per-exposure brightness and wavelength at a fixed grid position: an on-the-fly spectrum."""
    ra, dec = (float(v) for v in wout.wcs_pix2world([[x, y]], 0)[0])
    pts = []
    for f in frames:
        m = measure(f.image, f.variance, f.flags, x, y)
        if not m:
            continue
        lam, bw = wavelength_for(f, ra, dec)
        pts.append({"obs_id": f.exp.obs_id, "detector": f.exp.detector, "mjd": f.exp.mjd, "date": mjd_iso(f.exp.mjd),
                    "wavelength": lam, "bandwidth": bw, "x": float(x), "y": float(y), **m})
    return {"x": float(x), "y": float(y), "ra": ra, "dec": dec, "points": sorted(pts, key=lambda p: p["mjd"])}


# ---------------------------------------------------------------- is a star there at all?
SPOT_HALF = 9               # px: the box around the spot that is looked at
SPOT_PEAK_R = 1.5           # px: a star at the spot peaks this close to it
SPOT_MIN_SNR = 5.0          # the peak must stand this far above the noise of the picture
SPOT_WING_RATIO = 2.0       # a neighbour this many times brighter owns the light on its slope


def spot_check(frames: list["Frame"], positions) -> dict:
    """Is there a point of light at a spot? Photometry gives a number anywhere, also on empty sky and
    on the slope of a brighter star, and a spectral type or a period fitted to that says nothing.

    Looks at the median of all exposures in a small box around the spot (positions: the spot's grid
    pixel in each frame, so a moving target is followed). Returns {"state", "snr", "neighbour", "n"}:
    state "star" (a peak at the spot), "empty" (nothing stands out) or "wing" (the light there is
    the slope of a brighter neighbour); snr: height of the peak over the picture's noise;
    neighbour: brightest pixel within 6 px, in units of the spot's own peak. A wing also says where
    that neighbour is ("offset": [dx, dy] in grid pixels), so the page can measure it instead."""
    h = SPOT_HALF
    boxes = []
    for f, (x, y) in zip(frames, positions):
        ix, iy = int(round(x)), int(round(y))
        n = f.image.shape[0]
        y0, y1, x0, x1 = max(0, iy - h), min(n, iy + h + 1), max(0, ix - h), min(n, ix + h + 1)
        if y1 <= y0 or x1 <= x0:
            continue
        box = np.full((2 * h + 1, 2 * h + 1), np.nan, "f4")
        box[y0 - (iy - h):y1 - (iy - h), x0 - (ix - h):x1 - (ix - h)] = f.image[y0:y1, x0:x1]
        boxes.append(box)
    out = {"state": "star", "snr": None, "neighbour": None, "n": len(boxes)}
    if len(boxes) < 3:
        return out                                        # too little to judge: do not get in the way
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")                   # pixels blank in every exposure
        deep = np.nanmedian(np.stack(boxes), axis=0)
    yy, xx = np.mgrid[-h:h + 1, -h:h + 1]
    r = np.hypot(xx, yy)
    fin = np.isfinite(deep)
    core = fin & (r <= SPOT_PEAK_R)
    sky = fin & (r >= R_BG_IN) & (r <= R_BG_OUT)
    if not core.any() or sky.sum() < 8:
        return out                                        # a blanked (saturated) core is a very bright star
    bg = float(np.median(deep[sky]))
    rest = deep[fin & (r > 3)]
    noise = 1.4826 * float(np.median(np.abs(rest - np.median(rest))))
    if not noise > 0:
        return out
    where = np.flatnonzero(core.ravel())
    k = int(where[np.argmax(deep.ravel()[where])])
    py, px = divmod(k, 2 * h + 1)
    peak = float(deep[py, px]) - bg
    around = deep[max(0, py - 1):py + 2, max(0, px - 1):px + 2]
    is_peak = bool(deep[py, px] >= np.nanmax(around))
    near = fin & (r > SPOT_PEAK_R) & (r <= 6)
    neighbour, offset = 0.0, None
    if near.any():
        where = np.flatnonzero(near.ravel())
        k = int(where[np.argmax(deep.ravel()[where])])
        neighbour = (float(deep.ravel()[k]) - bg) / max(peak, noise)
        offset = [int(k % (2 * h + 1)) - h, int(k // (2 * h + 1)) - h]
    snr = peak / noise
    out.update(snr=round(snr, 1), neighbour=round(neighbour, 1))
    if snr < SPOT_MIN_SNR:
        out["state"] = "empty"
    elif not is_peak and neighbour >= SPOT_WING_RATIO:
        out.update(state="wing", offset=offset)
    return out


def build_frame(exp: Exposure, ra, dec, n, wout, target) -> Frame | None:
    half = int(math.ceil(n / 2 * math.sqrt(2))) + 2
    cut = _cutout_cached(exp, ra, dec, half)
    if cut is None:
        return None
    yy, xx = np.mgrid[0:n, 0:n]
    wra, wdec = wout.wcs_pix2world(xx, yy, 0)
    win = WCS(cut.header)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        px, py = win.all_world2pix(wra.ravel(), wdec.ravel(), 0, quiet=True)
    coords = [py.reshape(n, n) - cut.y0, px.reshape(n, n) - cut.x0]
    img = map_coordinates(cut.image, coords, order=1, cval=np.nan)
    var = map_coordinates(cut.variance, coords, order=1, cval=np.nan)
    flg = map_coordinates(cut.flags.astype(np.float64), coords, order=0, cval=0).astype(np.uint32)
    if np.isfinite(img).sum() < 0.2 * n * n:
        return None
    img = (img - _background(img)).astype(np.float32)
    f = Frame(exp, img, var.astype(np.float32), flg, header=cut.header.tostring())   # text: ~10x less memory

    # where is the (moving) target on the detector and on our grid at this exposure?
    tra, tdec = target(exp.mjd)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        dx, dy = win.all_world2pix([[tra, tdec]], 0, quiet=True)[0]
        gx, gy = wout.wcs_world2pix([[tra, tdec]], 0)[0]
        try:
            tab = fitsrange.wave_table(exp.url, exp.detector)
            f.wavelength, f.bandwidth = fitsrange.wavelength_at(cut.header, tab, float(dx), float(dy))
        except Exception:
            f.wavelength = 0.5 * (exp.wl_min + exp.wl_max)
    f.phot = measure(img, f.variance, flg, gx, gy)
    f.phot.update({"x": float(gx), "y": float(gy)})
    return f


def build_frames(exps: list[Exposure], ra, dec, n, target, progress=None, on_frame=None) -> list[Frame]:
    wout = output_wcs(ra, dec, n)
    out: list[Frame | None] = [None] * len(exps)
    with ThreadPoolExecutor(config.MAX_WORKERS) as pool:
        futs = {pool.submit(build_frame, e, ra, dec, n, wout, target): i for i, e in enumerate(exps)}
        for k, fu in enumerate(as_completed(futs), 1):
            i = futs[fu]
            try:
                out[i] = fu.result()
                if on_frame and out[i] is not None:
                    on_frame(out[i])
            except Exception as ex:      # one bad file must not sink the whole request
                print("skip", exps[i].obs_id, exps[i].detector, repr(ex)[:200])
            if progress:
                progress(k, len(futs))
    return [f for f in out if f is not None]


# ---------------------------------------------------------------- grouping
def epochs(mjds: list[float]) -> list[int]:
    """Epoch index per (sorted) mjd: a gap longer than EPOCH_GAP_DAYS starts a new epoch."""
    out, k = [], 0
    for i, m in enumerate(mjds):
        if i and m - mjds[i - 1] > config.EPOCH_GAP_DAYS:
            k += 1
        out.append(k)
    return out


def prune_cache(max_mb=None):
    """Delete the least recently used cached cut-outs once the cache is larger than CACHE_MAX_MB."""
    limit = (config.CACHE_MAX_MB if max_mb is None else max_mb) * 1e6
    files = [(p.stat().st_atime, p.stat().st_size, p) for p in (config.CACHE_DIR / "cut").glob("*") if p.is_file()]
    total = sum(f[1] for f in files)
    for _, size, p in sorted(files):
        if total <= limit:
            break
        try:
            p.unlink()
            total -= size
        except OSError:
            pass


def coadd(frames: list[Frame], weights=None):
    """Inverse-variance co-add; optional extra weight per frame (wavelength matching gives every
    spectral bin the same total weight). Variance is propagated for the weighted mean."""
    num = den = var_num = None
    flg = None
    for k, f in enumerate(frames):
        c = 1.0 if weights is None else float(weights[k])
        good = np.isfinite(f.image) & np.isfinite(f.variance) & (f.variance > 0) & ((f.flags & config.BAD_MASK) == 0)
        a = np.where(good, c / np.where(good, f.variance, 1.0), 0.0)
        v = np.where(good, f.image, 0.0) * a
        vv = a * a * np.where(good, f.variance, 0.0)
        num = v if num is None else num + v
        den = a if den is None else den + a
        var_num = vv if var_num is None else var_num + vv
        flg = f.flags.copy() if flg is None else flg | f.flags
    with np.errstate(invalid="ignore", divide="ignore"):
        img = np.where(den > 0, num / den, np.nan).astype(np.float32)
        var = np.where(den > 0, var_num / den ** 2, np.nan).astype(np.float32)
        # pixels where every exposure is flagged (e.g. a saturated star's core): show the plain
        # mean of what exists rather than a hole; the flags still say it is unreliable
        hole = ~(den > 0)
        if hole.any():
            stack_img = np.stack([f.image for f in frames])
            stack_var = np.stack([f.variance for f in frames])
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                img[hole] = np.nanmean(stack_img, axis=0)[hole]
                var[hole] = (np.nanmean(stack_var, axis=0) / np.maximum(1, np.isfinite(stack_img).sum(0)))[hole]
    return img, var, flg


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=a.dtype.newbyteorder("<")).tobytes()).decode()


def mjd_iso(m):
    return Time(m, format="mjd").isot[:16].replace("T", " ")


# ---------------------------------------------------------------- wavelength matching
# SPHEREx resolving power per detector (bands 1-4 ~ 41, 35 at the long end of band 4; 5-6 ~ 110-130)
RES_POWER = {1: 41, 2: 41, 3: 41, 4: 35, 5: 110, 6: 130}
BIN_ELEMENTS = 2.0          # spectral bin width in resolution elements
MIN_MATCHED_PER_VISIT = 4   # otherwise matching is skipped for the field
MIN_MATCHED_FRACTION = 0.2


def match_wavelengths(frames: list[Frame], all_detectors: bool):
    """SPHEREx has no filters: each exposure sees a position at its own wavelength, so two visits
    that sampled a band differently differ in colour, and colour looks like change. Keep, per
    detector, only exposures in spectral bins (BIN_ELEMENTS resolution elements wide) that every
    visit sampled, each bin weighted equally. With all_detectors, a detector missing from any visit
    is dropped too (so whole-visit co-adds share the same detectors).
    Returns (frames, weights, info) or None when matching would empty a visit."""
    frames = sorted(frames, key=lambda f: f.exp.mjd)
    ep = dict(zip((id(f) for f in frames), epochs([f.exp.mjd for f in frames])))
    visits = set(ep.values())
    by_det: dict[int, list[Frame]] = {}
    for f in frames:
        by_det.setdefault(f.exp.detector, []).append(f)
    kept, weights, info = [], [], {}
    for det, fs in sorted(by_det.items()):
        lo = config.DETECTORS.get(det, [min(f.wavelength or 1 for f in fs)])[0]
        width = BIN_ELEMENTS / RES_POWER.get(det, 41)
        binned: dict[tuple, list[Frame]] = {}
        for f in fs:
            if not f.wavelength:
                continue
            b = int(math.floor(math.log(f.wavelength / lo) / width))
            binned.setdefault((ep[id(f)], b), []).append(f)
        det_visits = {v for v, _ in binned}
        if all_detectors and det_visits != visits:
            info[det] = {"shared_bins": 0, "kept": 0, "of": len(fs), "dropped": "not in every visit"}
            continue
        bins_by_visit = [{b for v2, b in binned if v2 == v} for v in det_visits]
        shared = set.intersection(*bins_by_visit) if bins_by_visit else set()
        n_kept = 0
        for (v, b), group in binned.items():
            if b in shared:
                for f in group:
                    kept.append(f)
                    weights.append(1.0 / len(group))
                    n_kept += 1
        info[det] = {"shared_bins": len(shared), "kept": n_kept, "of": len(fs)}
    if {ep[id(f)] for f in kept} != visits:
        return None
    # too little left to compare (e.g. two detectors that sampled different wavelengths each visit):
    # an unmatched comparison of enough exposures beats a matched one of almost none
    per_visit = [sum(1 for f in kept if ep[id(f)] == v) for v in visits]
    if min(per_visit) < MIN_MATCHED_PER_VISIT or len(kept) < MIN_MATCHED_FRACTION * len(frames):
        return None
    return kept, weights, info


def in_window(frames: list[Frame], lo: float, hi: float) -> list[Frame]:
    """Exposures that saw the target at a wavelength in [lo, hi] micron. SPHEREx's linear-variable
    filters give each exposure its own wavelength, so this picks one slice of the 102-band spectrum
    from data already read; the wavelength is taken at the target, which holds across a few arcminutes."""
    return [f for f in frames if f.wavelength is not None and lo <= f.wavelength <= hi]


def group_raw(frames: list[Frame], mode: str, matched: bool = False):
    """Group frames ('epoch', 'epoch_detector' or 'exposure') and co-add each group (arrays kept).
    matched: co-add only wavelength-matched exposures (see match_wavelengths)."""
    frames = sorted(frames, key=lambda f: f.exp.mjd)
    visit_of = dict(zip((id(f) for f in frames), epochs([f.exp.mjd for f in frames])))   # from all frames
    weight_of, match_info = None, None
    if matched and mode in ("epoch", "epoch_detector"):
        m = match_wavelengths(frames, all_detectors=(mode == "epoch"))
        if m is None and mode == "epoch":      # visits share no detector: match within each detector only
            m = match_wavelengths(frames, all_detectors=False)
        # (still None: too few exposures survive matching; co-add everything, reported as matched=False)
        if m is not None:
            frames, w, match_info = m
            weight_of = {id(f): wi for f, wi in zip(frames, w)}
    frames = sorted(frames, key=lambda f: f.exp.mjd)
    ep = [visit_of[id(f)] for f in frames]
    groups: dict[tuple, list[Frame]] = {}
    for f, e in zip(frames, ep):
        key = {"epoch": (e,), "epoch_detector": (e, f.exp.detector)}.get(mode, (e, f.exp.mjd, f.exp.detector))
        groups.setdefault(key, []).append(f)
    out = []
    for key, fs in sorted(groups.items(), key=lambda kv: (kv[0][0], min(f.exp.mjd for f in kv[1]), kv[0][1:])):
        if len(fs) > 1 or weight_of:
            img, var, flg = coadd(fs, [weight_of[id(f)] for f in fs] if weight_of else None)
        else:
            img, var, flg = fs[0].image, fs[0].variance, fs[0].flags
        m0, m1 = min(f.exp.mjd_start for f in fs), max(f.exp.mjd_end for f in fs)
        dets = sorted({f.exp.detector for f in fs})
        wls = [f.wavelength for f in fs if f.wavelength]
        out.append({
            "epoch": key[0] + 1, "detectors": dets, "detector": dets[0] if len(dets) == 1 else None,
            "n_exposures": len(fs), "matched": match_info is not None,
            "mjd": float(np.mean([f.exp.mjd for f in fs])), "mjd_start": m0, "mjd_end": m1,
            "date_start": mjd_iso(m0), "date_end": mjd_iso(m1),
            "wavelength_min": min(wls) if wls else None, "wavelength_max": max(wls) if wls else None,
            "exposures": [{"obs_id": f.exp.obs_id, "detector": f.exp.detector, "date": mjd_iso(f.exp.mjd),
                           "wavelength": f.wavelength} for f in fs][:200],
            "image": img, "variance": var, "flags": flg.astype(np.uint32),
        })
    if out and match_info is not None:
        out[0]["match_info"] = {str(k): v for k, v in match_info.items()}
    return out


def encode(groups):
    return [{**g, "image": b64(g["image"]), "variance": b64(g["variance"]), "flags": b64(g["flags"])}
            for g in groups]


def group_frames(frames: list[Frame], mode: str):
    return encode(group_raw(frames, mode))


# ---------------------------------------------------------------- depth (how the image sharpens with more exposures)
class Accumulator:
    """Running inverse-variance co-add, one exposure at a time (same weighting as coadd())."""

    def __init__(self, n):
        self.num = np.zeros((n, n))
        self.den = np.zeros((n, n))
        self.cov = np.zeros((n, n), np.uint16)
        self.count = 0

    def add(self, f: Frame):
        good = np.isfinite(f.image) & np.isfinite(f.variance) & (f.variance > 0) & ((f.flags & config.BAD_MASK) == 0)
        a = np.where(good, 1.0 / np.where(good, f.variance, 1.0), 0.0)
        self.num += np.where(good, f.image, 0.0) * a
        self.den += a
        self.cov += good.astype(np.uint16)
        self.count += 1

    def image(self):
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(self.den > 0, self.num / self.den, np.nan).astype(np.float32)

    def sigma(self):
        """Pipeline (propagated) noise of the co-add: median of sqrt(1 / sum of weights)."""
        d = self.den[self.den > 0]
        return float(np.median(1.0 / np.sqrt(d))) if d.size else None


class DepthAccumulator(Accumulator):
    """Co-add for the sharpening view. The noise is SPHEREx's own: the per-pixel uncertainty maps of the exposures,
    propagated through the co-add. (Measuring the scatter of the image itself does not work here: in a crowded
    Milky Way field it is set by the stars, and alternate exposures come from different detectors, i.e. different
    wavelengths, so even a half-difference keeps the stars' colours.)"""

    def stats(self):
        """(image, noise, stars): stars are local maxima more than 5 noise above the local sky."""
        img = self.image()
        noise = self.sigma()
        return img, noise, count_stars(img, noise)


def count_stars(img, noise):
    from scipy.ndimage import maximum_filter, median_filter
    if not noise or not np.isfinite(img).any():
        return 0
    a = np.where(np.isfinite(img), img, np.nanmedian(img))
    sky = median_filter(a, size=9, mode="nearest")
    peak = (a == maximum_filter(a, size=3, mode="nearest")) & (a - sky > 5 * noise) & np.isfinite(img)
    peak[:2, :] = peak[-2:, :] = peak[:, :2] = peak[:, -2:] = False
    return int(peak.sum())


def quantize(img, scale):
    """float image -> int16 in units of `scale` (NaN = -32768): half the bytes of float32 for the depth series."""
    q = np.where(np.isfinite(img), np.clip(np.round(img / scale), -32767, 32767), -32768)
    return q.astype(np.int16)


def depth_series(frames: list[Frame], n: int, max_steps: int = 12):
    """Co-adds of the first 1, 2, 4 ... all exposures in time order, with noise and star counts at every step."""
    frames = sorted(frames, key=lambda f: f.exp.mjd)
    total = len(frames)
    ks = sorted({int(k) for k in np.unique(np.round(np.geomspace(1, total, min(max_steps, total))))} | {total})
    acc, steps = DepthAccumulator(n), []
    for i, f in enumerate(frames, 1):
        acc.add(f)
        if i in ks:
            img, noise, stars = acc.stats()
            steps.append({"n_exposures": i, "date": mjd_iso(f.exp.mjd), "noise": noise, "stars": stars, "img": img})
    final_noise = steps[-1]["noise"] or float(np.nanstd(steps[-1]["img"])) or 1.0
    peak = max(float(np.nanmax(np.abs(s["img"]))) for s in steps)
    scale = max(float(final_noise) / 20.0, peak / 32000.0)          # fine steps, but never clip a bright star
    for s in steps:
        s["image"] = b64(quantize(s.pop("img"), scale))
    return {"steps": steps, "scale": scale, "coverage": b64(acc.cov), "max_coverage": int(acc.cov.max()),
            "total": total, "first_date": mjd_iso(frames[0].exp.mjd), "last_date": mjd_iso(frames[-1].exp.mjd)}
