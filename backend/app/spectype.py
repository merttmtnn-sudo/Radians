"""Spectral type from a SPHEREx spectrum, and the molecular "fingerprints" in it.

The measured points (one per exposure, each at its own wavelength) are binned to about one resolution
element and compared, by chi-square, with reference spectra as SPHEREx would see them:

- observed standards over 0.75-2.45 um: Pickles (1998) O-M stars of all luminosity classes and the
  SpeX Prism M-T dwarf standards;
- Sonora Bobcat brown-dwarf models (Marley et al. 2021) over the full 0.75-5 um.

Limits, said on the page too: dust reddening is not corrected for; saturated points are left out, and
a spectrum that is mostly saturated gets no fit; temperatures of the standards come from published
type-temperature tables and are approximate. The library (data/spectral_library.npz) is made by
scripts/build_spectral_library.py.
"""
from __future__ import annotations

import math
import re
from functools import lru_cache
from pathlib import Path

import numpy as np

LIBRARY = Path(__file__).parent / "data" / "spectral_library.npz"
BAND_EDGES_UM = [0.75, 1.10, 1.63, 2.42, 3.82, 4.42, 5.00]
RESOLVING_POWER = {1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128}
GRID_UM = np.exp(np.linspace(math.log(0.74), math.log(5.02), 640))
STANDARDS_UM = (0.75, 2.45)          # where the observed standards have data
BINS_PER_BAND = 17                   # about one resolution element each
SYSTEMATIC = 0.03                    # error floor: calibration, and real variability between visits
MIN_BINS = 12
MIN_SNR = 5.0
LETTERS = "OBAFGKMLTY"

# Effective temperature by type (K). Dwarfs O-M: Pecaut & Mamajek (2013); L-T: after Filippazzo et al.
# (2015); giants: typical literature values. Approximate by design.
TEFF_DWARF = {"O5": 41400, "O9": 33300, "B0": 31400, "B1": 26000, "B3": 17000, "B5": 15700, "B8": 12500, "A0": 9700,
              "A2": 8840, "A5": 8080, "A7": 7800, "F0": 7220, "F2": 6810, "F5": 6510, "F8": 6170, "G0": 5920, "G2": 5770,
              "G5": 5660, "G8": 5490, "K0": 5280, "K2": 5040, "K3": 4830, "K4": 4600, "K5": 4410, "K7": 4070, "M0": 3870,
              "M1": 3700, "M2": 3550, "M3": 3410, "M4": 3200, "M5": 3030, "M6": 2850, "M7": 2650, "M8": 2500, "M9": 2400,
              "L0": 2250, "L1": 2100, "L2": 1960, "L3": 1830, "L4": 1700, "L5": 1590, "L6": 1490, "L7": 1410, "L8": 1350,
              "L9": 1300, "T0": 1260, "T1": 1230, "T2": 1200, "T3": 1160, "T4": 1120, "T5": 1050, "T6": 960, "T7": 840,
              "T8": 700, "T9": 550, "Y0": 420, "Y2": 300}
TEFF_GIANT = {"G5": 5050, "G8": 4900, "K0": 4750, "K2": 4500, "K3": 4300, "K4": 4100, "K5": 3950, "M0": 3850, "M1": 3780,
              "M2": 3700, "M3": 3600, "M4": 3500, "M5": 3400, "M6": 3300, "M7": 3150, "M8": 3000, "M9": 2900}


def band_of(um: float) -> int:
    for b in range(6):
        if um < BAND_EDGES_UM[b + 1]:
            return b + 1
    return 6


def type_code(sptype) -> float:
    """'M4V' -> 64, 'K7' -> 57, 'T8.5' -> 88.5, 'dM4' -> 64, Pickles' 'B12III' (B1-2) -> 11.5. NaN if unreadable."""
    m = re.match(r"\s*(?:[a-z]{1,2})?([OBAFGKMLTY])\s*(\d+(?:\.\d+)?)?", str(sptype or "").strip())
    if not m:
        return math.nan
    sub = m.group(2) or "5"
    value = (float(sub[0]) + float(sub[1])) / 2 if re.fullmatch(r"\d\d", sub) else float(sub)
    return LETTERS.index(m.group(1)) * 10 + value


def luminosity_class(sptype) -> str:
    m = re.search(r"(III|II|IV|I|V)[ab]*$", str(sptype or "").strip())
    return m.group(1) if m else ""


def type_name(code: float) -> str:
    if not np.isfinite(code):
        return "?"
    letter = LETTERS[int(min(max(code, 0), 99.9) // 10)]
    sub = code % 10
    return f"{letter}{sub:.0f}" if abs(sub - round(sub)) < 0.05 else f"{letter}{sub:.1f}"


def _curve(table: dict):
    keys = sorted(table, key=type_code)
    return np.array([type_code(k) for k in keys]), np.array([table[k] for k in keys], float)


def teff_of(sptype) -> float | None:
    """Approximate effective temperature of a spectral type (interpolated in the tables)."""
    code = type_code(sptype)
    if not np.isfinite(code):
        return None
    giant = luminosity_class(sptype) in ("I", "II", "III") and code >= type_code("G5")
    codes, temps = _curve(TEFF_GIANT if giant else TEFF_DWARF)
    return float(np.interp(code, codes, temps))


def type_at_teff(teff: float) -> str:
    """The dwarf type whose table temperature is closest (models give a temperature, not a type)."""
    codes, temps = _curve(TEFF_DWARF)
    return type_name(float(codes[np.argmin(np.abs(temps - teff))]))


@lru_cache(maxsize=1)
def library() -> dict | None:
    if not LIBRARY.exists():
        return None
    with np.load(LIBRARY, allow_pickle=False) as z:
        return {k: z[k] for k in z.files}


# ---------------------------------------------------------------- from exposures to one clean spectrum
def bin_edges() -> np.ndarray:
    edges = []
    for b in range(6):
        lo, hi = math.log(BAND_EDGES_UM[b]), math.log(BAND_EDGES_UM[b + 1])
        edges.extend(np.exp(np.linspace(lo, hi, BINS_PER_BAND + 1))[:-1])
    return np.array(edges + [BAND_EDGES_UM[-1]])


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and math.isfinite(v)


def bin_spectrum(points: list[dict]) -> dict:
    """Median spectrum in resolution-sized bins from every unsaturated exposure (Radians photometry
    points: wavelength in um, flux_ujy, err_ujy, saturated). Returns arrays wave, flux, err, and how
    much of the input was saturated."""
    good = [p for p in points if not p.get("saturated") and _finite(p.get("flux_ujy")) and _finite(p.get("wavelength"))]
    sat = sum(1 for p in points if p.get("saturated")) / len(points) if points else 0.0
    edges = bin_edges()
    w = np.array([p["wavelength"] for p in good], float)
    f = np.array([p["flux_ujy"] for p in good], float)
    e = np.array([p["err_ujy"] if _finite(p.get("err_ujy")) and p["err_ujy"] > 0 else math.nan for p in good], float)
    which = np.searchsorted(edges, w, side="right") - 1
    wave, flux, err = [], [], []
    for k in range(len(edges) - 1):
        mine = which == k
        n = int(mine.sum())
        if not n:
            continue
        med = float(np.median(f[mine]))
        # scatter between exposures if there are enough, else their formal errors; never below the floor
        spread = 1.4826 * float(np.median(np.abs(f[mine] - med))) if n >= 3 else math.nan
        stat = 1.253 * spread / math.sqrt(n) if np.isfinite(spread) else 0.0
        formal = float(np.nanmedian(e[mine])) / math.sqrt(n) if np.isfinite(e[mine]).any() else 0.0
        wave.append(float(np.median(w[mine])))
        flux.append(med)
        err.append(math.hypot(max(stat, formal), SYSTEMATIC * abs(med)))
    return {"wave": np.array(wave), "flux": np.array(flux), "err": np.array(err),
            "saturated_fraction": sat, "n_points": len(good)}


# ---------------------------------------------------------------- the fit
def _chi2(wave, flux, err, grid, template):
    t = np.interp(wave, grid, template, left=np.nan, right=np.nan)
    ok = np.isfinite(t) & np.isfinite(flux) & (err > 0)
    n = int(ok.sum())
    if n < MIN_BINS:
        return None
    wt = 1 / err[ok] ** 2
    scale = float(np.sum(flux[ok] * t[ok] * wt) / np.sum(t[ok] ** 2 * wt))
    return float(np.sum((flux[ok] - scale * t[ok]) ** 2 * wt)), n, scale


def _rank(b: dict, lib: dict, sources: tuple, window: tuple) -> list[dict]:
    inside = (b["wave"] >= window[0]) & (b["wave"] <= window[1])
    if inside.sum() < MIN_BINS:
        return []
    w, f, e = b["wave"][inside], b["flux"][inside], b["err"][inside]
    out = []
    for i, source in enumerate(lib["sources"]):
        if str(source) not in sources:
            continue
        got = _chi2(w, f, e, lib["grid_um"], lib["spectra"][i])
        if got is None or got[1] < 0.6 * inside.sum():       # the template misses too much of the data
            continue
        chi2, n, scale = got
        out.append({"index": i, "scale": scale, "name": str(lib["names"][i]), "source": str(source), "chi2": chi2, "n": n,
                    "chi2_red": chi2 / max(1, n - 1), "code": float(lib["codes"][i]), "teff": float(lib["teffs"][i])})
    return sorted(out, key=lambda r: r["chi2_red"])


def fit(points: list[dict]) -> dict:
    """{"standards": best observed-standard type or None, "model": brown-dwarf model or None, "note"}.
    note: None, "saturated", "too_faint", "blend" (a cold object and a warm star share the pixels)
    or "no_library"."""
    lib = library()
    b = bin_spectrum(points)
    out = {"n_points": b["n_points"], "n_bins": int(b["wave"].size), "saturated_fraction": round(b["saturated_fraction"], 3),
           "standards": None, "model": None, "note": None,
           # the binned spectrum the fit used, for drawing it against the best match
           "data": {"wave": b["wave"].round(4).tolist(), "flux": b["flux"].tolist(), "err": b["err"].tolist()}}

    def curve(row, window):
        """The reference spectrum of a ranked row, scaled to the data, inside the fitted window."""
        grid, template = lib["grid_um"], lib["spectra"][row["index"]]
        keep = np.isfinite(template) & (grid >= window[0]) & (grid <= window[1])
        return {"wave": grid[keep].round(4).tolist(), "flux": (row["scale"] * template[keep]).tolist()}

    if lib is None:
        out["note"] = "no_library"
        return out
    if b["saturated_fraction"] > 0.5:                        # what is left are lower limits: no fit
        out["note"] = "saturated"
        return out
    short = (b["wave"] >= STANDARDS_UM[0]) & (b["wave"] <= STANDARDS_UM[1])
    snr_short = float(np.median(b["flux"][short] / b["err"][short])) if short.sum() >= MIN_BINS else 0.0
    snr_all = float(np.median(b["flux"] / b["err"])) if b["wave"].size else 0.0

    if snr_short >= MIN_SNR:
        ranked = _rank(b, lib, ("Pickles", "SpeX"), STANDARDS_UM)
        if ranked:
            best = ranked[0]
            # errors rescaled so the best fit has chi2 = dof; types within delta-chi2 = 4 give the range
            near = [r for r in ranked if (r["chi2"] - best["chi2"]) / best["chi2_red"] <= 4 and abs(r["n"] - best["n"]) <= 3]
            codes = [r["code"] for r in near if np.isfinite(r["code"])] or [best["code"]]
            seen, others = {best["name"]}, []
            for r in ranked[1:]:
                if r["name"] not in seen and len(others) < 3:
                    seen.add(r["name"])
                    others.append({"type": r["name"], "chi2_red": round(r["chi2_red"], 2)})
            teff = teff_of(best["name"])
            out["standards"] = {"type": best["name"], "source": best["source"], "chi2_red": round(best["chi2_red"], 2),
                                "n_bins": best["n"], "range": [type_name(min(codes)), type_name(max(codes))],
                                "teff": round(teff) if teff else None, "alternatives": others, "snr": round(snr_short, 1),
                                "curve": curve(best, STANDARDS_UM)}
    if snr_all >= 3 and b["wave"].size >= MIN_BINS:
        models = _rank(b, lib, ("Sonora",), (BAND_EDGES_UM[0], BAND_EDGES_UM[-1]))
        if models:
            best = models[0]
            near = [r["teff"] for r in models if (r["chi2"] - best["chi2"]) / best["chi2_red"] <= 4]
            edge = best["teff"] in (float(np.nanmin(lib["teffs"])), float(np.nanmax(lib["teffs"])))
            out["model"] = {"teff": round(best["teff"]), "teff_range": [round(min(near)), round(max(near))],
                            "chi2_red": round(best["chi2_red"], 2), "n_bins": best["n"],
                            "type": type_at_teff(best["teff"]), "at_edge": edge,
                            "curve": curve(best, (BAND_EDGES_UM[0], BAND_EDGES_UM[-1]))}
    # the models only describe brown dwarfs: next to a star that the standards fit better, they say nothing
    st, mo = out["standards"], out["model"]
    if st and mo and (st["teff"] or 0) > 2600 and mo["at_edge"]:
        out["model"] = None
    cold = cold_signature(b)
    if cold and st and (st["teff"] or 0) > 3000:
        # dark in methane and bright at 4.5 um cannot also be a warm star: two sources share the pixels
        out.update(note="blend", cold=cold, model=None)
    if out["standards"] is None and out["model"] is None:
        out["note"] = "too_faint"
    return out


def cold_signature(b: dict) -> dict | None:
    """A cold brown dwarf is dark at 3.2-3.95 um (methane) and bright at 4.15-4.95 um; a star's light
    falls smoothly there. Returns the peak/dip ratio if that is seen."""
    sides = []
    for lo, hi in ((3.2, 3.95), (4.15, 4.95)):
        m = (b["wave"] >= lo) & (b["wave"] <= hi) & np.isfinite(b["flux"]) & (b["err"] > 0)
        if m.sum() < 2:
            return None
        wt = 1 / b["err"][m] ** 2
        sides.append((float((b["flux"][m] * wt).sum() / wt.sum()), float(1 / np.sqrt(wt.sum()))))
    (dip, dip_err), (peak, peak_err) = sides
    if peak - dip < 3 * math.hypot(dip_err, peak_err) or peak < 2 * max(dip, 0.0):
        return None
    return {"ratio": round(peak / dip, 1) if dip > 0 else None}


# ---------------------------------------------------------------- fingerprints
# (id, feature window, continuum windows), um: depth = 1 - feature / continuum at the feature
FEATURES = [
    ("water", (1.36, 1.46), [(1.24, 1.31), (1.56, 1.68)]),
    ("co", (2.30, 2.40), [(2.10, 2.25)]),
    ("methane", (3.20, 3.40), [(3.90, 4.15)]),
    ("water_ice", (2.95, 3.15), [(2.55, 2.75), (3.55, 3.75)]),
    ("co2_ice", (4.23, 4.30), [(4.12, 4.20), (4.34, 4.40)]),
]


def _window(b: dict, lo: float, hi: float):
    m = (b["wave"] >= lo) & (b["wave"] <= hi)
    if not m.any():
        return None
    return float(np.mean(b["wave"][m])), float(np.mean(b["flux"][m])), float(np.sqrt(np.sum(b["err"][m] ** 2)) / m.sum())


def fingerprints(points: list[dict]) -> list[dict]:
    """How deep each molecular band is: 0 = no band, 1 = no light left, below 0 = it glows there.
    verdict: "present", "absent", "glows", "no_data" or "too_faint"."""
    b = bin_spectrum(points)
    out = []
    for name, feature, sides in FEATURES:
        row = {"id": name, "um": round(sum(feature) / 2, 2), "depth": None, "err": None}
        feat = _window(b, *feature)
        cont = [c for c in (_window(b, *s) for s in sides) if c]
        if feat is None or len(cont) != len(sides):
            out.append({**row, "verdict": "no_data"})
            continue
        if len(cont) == 2:                                   # a straight line between the two sides
            (w1, f1, e1), (w2, f2, e2) = cont
            t = (feat[0] - w1) / (w2 - w1)
            level, level_err = f1 + (f2 - f1) * t, math.hypot((1 - t) * e1, t * e2)
        else:
            # one clean side only: carry it to the feature with the slope of plain starlight
            # (Rayleigh-Jeans, flux ~ wavelength^-2), so an ordinary star comes out with depth 0
            w1, f1, e1 = cont[0]
            tilt = (w1 / feat[0]) ** 2
            level, level_err = f1 * tilt, e1 * tilt
        if level <= 0 or level < 3 * level_err:
            out.append({**row, "verdict": "too_faint"})
            continue
        depth = 1 - feat[1] / level
        err = math.hypot(feat[2] / level, feat[1] * level_err / level ** 2)
        need = max(0.1 if len(cont) == 2 else 0.15, 3 * err)  # one-sided estimates lean on an assumed slope
        verdict = "present" if depth >= need else "glows" if depth <= -need else "absent"
        out.append({**row, "depth": round(depth, 3), "err": round(err, 3), "verdict": verdict})
    return out


def agreement(catalog_type, catalog_teff, result: dict) -> str:
    """'agree', 'close', 'differ', 'blend' or 'unknown': the catalogue's type (or temperature) against ours."""
    if result.get("note") == "blend":
        return "blend"
    ours, model = result.get("standards"), result.get("model")
    code = type_code(catalog_type) if catalog_type else math.nan
    mine = ours or model
    if np.isfinite(code) and mine:
        gap = abs(type_code(mine["type"]) - code)
        return "agree" if gap <= 2 else "close" if gap <= 5 else "differ"
    our_teff = (ours or {}).get("teff") or (model or {}).get("teff")
    if catalog_teff and our_teff:
        gap = abs(our_teff - catalog_teff) / catalog_teff
        return "agree" if gap <= 0.1 else "close" if gap <= 0.25 else "differ"
    return "unknown"
