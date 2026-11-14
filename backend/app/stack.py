"""Turn SPHEREx exposures into aligned frames: reproject, background-subtract, group, co-add."""
from __future__ import annotations

import base64
import hashlib
import math
import pickle
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import numpy as np
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
            p.write_bytes(pickle.dumps(c))
        return c
    c = fitsrange.read_cutout(exp.url, ra, dec, half)
    p.parent.mkdir(parents=True, exist_ok=True)
    if c is not None:
        p.write_bytes(pickle.dumps(c))
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


def wavelength_for(f: "Frame", ra, dec):
    """Wavelength SPHEREx saw at sky position (ra, dec) in this exposure (linear-variable filter)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        dx, dy = WCS(f.header).all_world2pix([[ra, dec]], 0, quiet=True)[0]
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
    f = Frame(exp, img, var.astype(np.float32), flg, header=cut.header)

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


def build_frames(exps: list[Exposure], ra, dec, n, target, progress=None) -> list[Frame]:
    wout = output_wcs(ra, dec, n)
    out: list[Frame | None] = [None] * len(exps)
    with ThreadPoolExecutor(config.MAX_WORKERS) as pool:
        futs = {pool.submit(build_frame, e, ra, dec, n, wout, target): i for i, e in enumerate(exps)}
        for k, fu in enumerate(as_completed(futs), 1):
            i = futs[fu]
            try:
                out[i] = fu.result()
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


def coadd(frames: list[Frame]):
    num = den = None
    flg = None
    for f in frames:
        good = np.isfinite(f.image) & np.isfinite(f.variance) & (f.variance > 0) & ((f.flags & config.BAD_MASK) == 0)
        w = np.where(good, 1.0 / np.where(good, f.variance, 1.0), 0.0)
        v = np.where(good, f.image, 0.0) * w
        num = v if num is None else num + v
        den = w if den is None else den + w
        flg = f.flags.copy() if flg is None else flg | f.flags
    with np.errstate(invalid="ignore", divide="ignore"):
        img = np.where(den > 0, num / den, np.nan).astype(np.float32)
        var = np.where(den > 0, 1.0 / den, np.nan).astype(np.float32)
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


def group_raw(frames: list[Frame], mode: str):
    """Group frames ('epoch', 'epoch_detector' or 'exposure') and co-add each group (arrays kept)."""
    frames = sorted(frames, key=lambda f: f.exp.mjd)
    ep = epochs([f.exp.mjd for f in frames])
    groups: dict[tuple, list[Frame]] = {}
    for f, e in zip(frames, ep):
        key = {"epoch": (e,), "epoch_detector": (e, f.exp.detector)}.get(mode, (e, f.exp.mjd, f.exp.detector))
        groups.setdefault(key, []).append(f)
    out = []
    for key, fs in sorted(groups.items(), key=lambda kv: (kv[0][0], min(f.exp.mjd for f in kv[1]), kv[0][1:])):
        img, var, flg = coadd(fs) if len(fs) > 1 else (fs[0].image, fs[0].variance, fs[0].flags)
        m0, m1 = min(f.exp.mjd_start for f in fs), max(f.exp.mjd_end for f in fs)
        dets = sorted({f.exp.detector for f in fs})
        wls = [f.wavelength for f in fs if f.wavelength]
        out.append({
            "epoch": key[0] + 1, "detectors": dets, "detector": dets[0] if len(dets) == 1 else None,
            "n_exposures": len(fs),
            "mjd": float(np.mean([f.exp.mjd for f in fs])), "mjd_start": m0, "mjd_end": m1,
            "date_start": mjd_iso(m0), "date_end": mjd_iso(m1),
            "wavelength_min": min(wls) if wls else None, "wavelength_max": max(wls) if wls else None,
            "exposures": [{"obs_id": f.exp.obs_id, "detector": f.exp.detector, "date": mjd_iso(f.exp.mjd),
                           "wavelength": f.wavelength} for f in fs][:200],
            "image": img, "variance": var, "flags": flg.astype(np.uint32),
        })
    return out


def encode(groups):
    return [{**g, "image": b64(g["image"]), "variance": b64(g["variance"]), "flags": b64(g["flags"])}
            for g in groups]


def group_frames(frames: list[Frame], mode: str):
    return encode(group_raw(frames, mode))
