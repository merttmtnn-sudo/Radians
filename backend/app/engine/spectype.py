"""Spectral type from a SPHEREx spectrum: three independent answers, shown side by side.

1. Our own fit: the measured spectrum is compared (chi-square) with reference spectra as SPHEREx
   would see them: observed standards (Pickles O-M stars of all luminosity classes, SpeX Prism M-T
   dwarfs) over 0.75-2.45 um, and Sonora brown-dwarf models over the full 0.75-5 um.
2. Fingerprints: how deep the water, CO, methane and ice bands are, straight from the data.
3. The catalogue answer (SIMBAD type, Gaia DR3 parameters) is looked up elsewhere (views.py).

Limits, stated to the user: no correction for dust reddening; saturated points are left out (and
if most of the spectrum is saturated there is no fit at all); temperatures of the observed
standards come from published type-temperature tables and are approximate.
The library is built by scripts/build_spectral_library.py.
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
EMPIRICAL_RANGE_UM = (0.75, 2.45)          # where the observed standards have data
CHANNELS_PER_BAND = 17
SYSTEMATIC = 0.03                          # error floor: calibration and real variability between passes
MIN_BINS = 12
MIN_SNR = 5.0
LETTERS = "OBAFGKMLTY"

# Effective temperature by spectral type (K). Dwarfs O-M: Pecaut & Mamajek (2013); L-T: after
# Filippazzo et al. (2015); giants K-M: typical literature values. Approximate by design.
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


def type_code(sptype: str) -> float:
    """'M4V' -> 64, 'K7' -> 57, 'T8.5' -> 88.5, 'B12III' (Pickles' B1-2) -> 11.5. NaN if unreadable."""
    m = re.match(r"\s*(?:[a-z]{1,2})?([OBAFGKMLTY])\s*(\d+(?:\.\d+)?)?", str(sptype or "").strip())
    if not m:
        return math.nan
    sub = m.group(2) or "5"
    # Pickles writes ranges without a dash: 'B12III' = B1-2, 'B57V' = B5-7, 'K01II' = K0-1
    value = (float(sub[0]) + float(sub[1])) / 2 if re.fullmatch(r"\d\d", sub) else float(sub)
    return LETTERS.index(m.group(1)) * 10 + value


def luminosity_class(sptype: str) -> str:
    m = re.search(r"(III|II|IV|I|V)[ab]*$", str(sptype or "").strip())
    return m.group(1) if m else ""


def type_name(code: float) -> str:
    if not np.isfinite(code):
        return "?"
    letter = LETTERS[int(min(max(code, 0), 99.9) // 10)]
    sub = code % 10
    return f"{letter}{sub:.0f}" if abs(sub - round(sub)) < 0.05 else f"{letter}{sub:.1f}"


def _table_curve(table: dict):
    codes = np.array(sorted(type_code(k) for k in table))
    temps = np.array([table[k] for k in sorted(table, key=type_code)], float)
    return codes, temps


def teff_of(sptype: str) -> float | None:
    """Approximate effective temperature for a spectral type (interpolated in the tables)."""
    code = type_code(sptype)
    if not np.isfinite(code):
        return None
    giant = luminosity_class(sptype) in ("I", "II", "III") and code >= type_code("G5")
    codes, temps = _table_curve(TEFF_GIANT if giant else TEFF_DWARF)
    return float(np.interp(code, codes, temps))


def type_at_teff(teff: float) -> str:
    """The dwarf type whose table temperature is closest (for model fits, which give a temperature)."""
    codes, temps = _table_curve(TEFF_DWARF)
    return type_name(float(codes[np.argmin(np.abs(temps - teff))]))


@lru_cache(maxsize=1)
def library() -> dict | None:
    if not LIBRARY.exists():
        return None
    with np.load(LIBRARY, allow_pickle=False) as z:
        return {k: z[k] for k in z.files}


# ---------------------------------------------------------------------------------------------
# from measured points to one clean spectrum
# ---------------------------------------------------------------------------------------------
def bin_edges() -> np.ndarray:
    """17 bins per detector band, equal in log wavelength: about one resolution element each."""
    edges = []
    for b in range(6):
        edges.extend(np.exp(np.linspace(math.log(BAND_EDGES_UM[b]), math.log(BAND_EDGES_UM[b + 1]), CHANNELS_PER_BAND + 1))[:-1])
    return np.array(edges + [BAND_EDGES_UM[-1]])


def bin_spectrum(points: list[dict]) -> dict:
    """Median spectrum in resolution-sized bins from every unsaturated exposure.
    Returns wave, flux, err (arrays, one entry per bin with data), n per bin, and how much of the
    input was saturated."""
    usable = [p for p in points if not p.get("saturated") and np.isfinite(p.get("flux_mJy", math.nan))]
    saturated_fraction = 1 - len(usable) / len(points) if points else 0.0
    edges = bin_edges()
    w = np.array([p["wave_um"] for p in usable])
    f = np.array([p["flux_mJy"] for p in usable])
    e = np.array([p["err_mJy"] if np.isfinite(p.get("err_mJy", math.nan)) else math.nan for p in usable])
    which = np.searchsorted(edges, w, side="right") - 1
    wave, flux, err, count = [], [], [], []
    for k in range(len(edges) - 1):
        mine = which == k
        n = int(mine.sum())
        if n == 0:
            continue
        med = float(np.median(f[mine]))
        spread = 1.4826 * float(np.median(np.abs(f[mine] - med))) if n >= 3 else math.nan
        stat = 1.253 * spread / math.sqrt(n) if np.isfinite(spread) else 0.0
        formal = float(np.nanmedian(e[mine])) / math.sqrt(n) if np.isfinite(e[mine]).any() else 0.0
        wave.append(float(np.median(w[mine])))
        flux.append(med)
        err.append(math.hypot(max(stat, formal), SYSTEMATIC * abs(med)))
        count.append(n)
    return dict(wave=np.array(wave), flux=np.array(flux), err=np.array(err), n=np.array(count),
                saturated_fraction=saturated_fraction, n_points=len(usable))


# ---------------------------------------------------------------------------------------------
# the fit
# ---------------------------------------------------------------------------------------------
def _chi2(wave, flux, err, grid, template):
    t = np.interp(wave, grid, template, left=np.nan, right=np.nan)
    ok = np.isfinite(t) & np.isfinite(flux) & (err > 0)
    n = int(ok.sum())
    if n < MIN_BINS:
        return None
    weight = 1 / err[ok] ** 2
    scale = float(np.sum(flux[ok] * t[ok] * weight) / np.sum(t[ok] ** 2 * weight))
    chi2 = float(np.sum((flux[ok] - scale * t[ok]) ** 2 * weight))
    return chi2, n, scale


def _rank(binned: dict, lib: dict, sources: tuple[str, ...], window: tuple[float, float]) -> list[dict]:
    inside = (binned["wave"] >= window[0]) & (binned["wave"] <= window[1])
    w, f, e = binned["wave"][inside], binned["flux"][inside], binned["err"][inside]
    out = []
    if inside.sum() < MIN_BINS:
        return out
    for i, source in enumerate(lib["sources"]):
        if str(source) not in sources:
            continue
        got = _chi2(w, f, e, lib["grid_um"], lib["spectra"][i])
        if got is None or got[1] < 0.6 * inside.sum():
            continue                                         # the template misses too much of the data
        chi2, n, scale = got
        out.append(dict(index=i, name=str(lib["names"][i]), source=str(source), chi2=chi2, n=n, chi2_red=chi2 / max(1, n - 1),
                        scale=scale, code=float(lib["codes"][i]), teff=float(lib["teffs"][i])))
    return sorted(out, key=lambda r: r["chi2_red"])


def fit(points: list[dict]) -> dict:
    """Best-matching type from observed standards, model temperature from Sonora, and the data
    and curves for the overlay chart."""
    lib = library()
    binned = bin_spectrum(points)
    out = dict(n_points=binned["n_points"], n_bins=int(binned["wave"].size), saturated_fraction=round(binned["saturated_fraction"], 3),
               standards=None, model=None, note=None,
               data=dict(wave=binned["wave"].round(4).tolist(), flux=binned["flux"].tolist(), err=binned["err"].tolist()))
    if lib is None:
        out["note"] = "no_library"
        return out
    if binned["saturated_fraction"] > 0.5:
        out["note"] = "saturated"                            # what is left are lower limits: no fit
        return out
    lo, hi = EMPIRICAL_RANGE_UM
    short = (binned["wave"] >= lo) & (binned["wave"] <= hi)
    snr_short = float(np.median(binned["flux"][short] / binned["err"][short])) if short.sum() >= MIN_BINS else 0.0
    snr_all = float(np.median(binned["flux"] / binned["err"])) if binned["wave"].size else 0.0

    def curve(row, window):
        grid, template = lib["grid_um"], lib["spectra"][row["index"]]
        keep = np.isfinite(template) & (grid >= window[0]) & (grid <= window[1])
        return dict(wave=grid[keep].round(4).tolist(), flux=(row["scale"] * template[keep]).tolist())

    if snr_short >= MIN_SNR:
        ranked = _rank(binned, lib, ("Pickles", "SpeX"), EMPIRICAL_RANGE_UM)
        if ranked:
            best = ranked[0]
            # errors are rescaled so the best fit has chi2 = dof; types within delta-chi2 of 4 form the range
            near = [r for r in ranked if (r["chi2"] - best["chi2"]) / best["chi2_red"] <= 4 and abs(r["n"] - best["n"]) <= 3]
            codes = [r["code"] for r in near if np.isfinite(r["code"])] or [best["code"]]
            seen, others = {best["name"]}, []
            for r in ranked[1:]:
                if r["name"] not in seen and len(others) < 3:
                    seen.add(r["name"])
                    others.append(dict(type=r["name"], source=r["source"], chi2_red=round(r["chi2_red"], 2)))
            out["standards"] = dict(type=best["name"], source=best["source"], chi2_red=round(best["chi2_red"], 2), n_bins=best["n"],
                                    range=[type_name(min(codes)), type_name(max(codes))], teff=teff_of(best["name"]),
                                    alternatives=others, snr=round(snr_short, 1), curve=curve(best, EMPIRICAL_RANGE_UM))
    if snr_all >= MIN_SNR or binned["wave"].size >= MIN_BINS:
        models = _rank(binned, lib, ("Sonora",), (BAND_EDGES_UM[0], BAND_EDGES_UM[-1]))
        if models and float(np.median(binned["flux"] / binned["err"])) >= 3:
            best = models[0]
            near = [r["teff"] for r in models if (r["chi2"] - best["chi2"]) / best["chi2_red"] <= 4]
            out["model"] = dict(teff=best["teff"], teff_range=[min(near), max(near)], chi2_red=round(best["chi2_red"], 2), n_bins=best["n"],
                                type=type_at_teff(best["teff"]), curve=curve(best, (BAND_EDGES_UM[0], BAND_EDGES_UM[-1])),
                                at_edge=best["teff"] in (float(np.nanmin(lib["teffs"])), float(np.nanmax(lib["teffs"]))))
    cold = cold_signature(binned)
    if cold and out["standards"] and (out["standards"]["teff"] or 0) > 3000:
        # a methane-dark, 4.5 um-bright object cannot also be a warm star: two sources share the pixels
        out.update(note="blend", cold=cold, model=None)
        out["standards"]["neighbour"] = True
    if out["standards"] is None and out["model"] is None:
        out["note"] = "too_faint"
    return out


def cold_signature(binned: dict) -> dict | None:
    """A cold brown dwarf is dark at 3.2-3.95 um (methane) and bright at 4.15-4.95 um; no star does
    that (their light falls smoothly with wavelength there). Returns the peak/dip ratio if seen."""
    w, f, e = binned["wave"], binned["flux"], binned["err"]
    sides = []
    for lo, hi in ((3.2, 3.95), (4.15, 4.95)):
        m = (w >= lo) & (w <= hi) & np.isfinite(f) & (e > 0)
        if m.sum() < 2:
            return None
        wt = 1 / e[m] ** 2
        sides.append((float((f[m] * wt).sum() / wt.sum()), float(1 / np.sqrt(wt.sum()))))
    (dip, dip_err), (peak, peak_err) = sides
    if peak - dip < 3 * math.hypot(dip_err, peak_err) or peak < 2 * max(dip, 0.0):
        return None
    return dict(ratio=round(peak / dip, 1) if dip > 0 else None)


# ---------------------------------------------------------------------------------------------
# fingerprints
# ---------------------------------------------------------------------------------------------
# (id, feature window, continuum windows): depth = 1 - feature / continuum at the feature's wavelength
FEATURES = [
    ("water", (1.36, 1.46), [(1.24, 1.31), (1.56, 1.68)]),
    ("co", (2.30, 2.40), [(2.10, 2.25)]),
    ("methane", (3.20, 3.40), [(3.90, 4.15)]),
    ("water_ice", (2.95, 3.15), [(2.55, 2.75), (3.55, 3.75)]),
    ("co2_ice", (4.23, 4.30), [(4.12, 4.20), (4.34, 4.40)]),
]


def _window(binned: dict, lo: float, hi: float):
    m = (binned["wave"] >= lo) & (binned["wave"] <= hi)
    if not m.any():
        return None
    f, e = binned["flux"][m], binned["err"][m]
    return float(np.mean(binned["wave"][m])), float(np.mean(f)), float(np.sqrt(np.sum(e ** 2)) / m.sum())


def fingerprints(points: list[dict]) -> list[dict]:
    """How deep each molecular band is: 0 = no band, 1 = no light left, below 0 = it glows there."""
    binned = bin_spectrum(points)
    out = []
    for name, feature, sides in FEATURES:
        feat = _window(binned, *feature)
        cont = [c for c in (_window(binned, *s) for s in sides) if c]
        if feat is None or len(cont) != len(sides):
            out.append(dict(id=name, um=round(sum(feature) / 2, 2), depth=None, err=None, verdict="no_data"))
            continue
        if len(cont) == 2:                                    # straight line between the two sides
            (w1, f1, e1), (w2, f2, e2) = cont
            t = (feat[0] - w1) / (w2 - w1)
            level, level_err = f1 + (f2 - f1) * t, math.hypot((1 - t) * e1, t * e2)
        else:
            # only one side is clean: carry it to the feature with the slope of plain starlight
            # (Rayleigh-Jeans, flux ~ wavelength^-2), so an ordinary star comes out with depth 0
            w1, f1, e1 = cont[0]
            tilt = (w1 / feat[0]) ** 2
            level, level_err = f1 * tilt, e1 * tilt
        if level <= 0 or level < 3 * level_err:
            out.append(dict(id=name, um=round(sum(feature) / 2, 2), depth=None, err=None, verdict="too_faint"))
            continue
        depth = 1 - feat[1] / level
        err = math.hypot(feat[2] / level, feat[1] * level_err / level ** 2)
        need = max(0.1 if len(cont) == 2 else 0.15, 3 * err)      # one-sided estimates lean on an assumed slope
        verdict = "present" if depth >= need else "glows" if depth <= -need else "absent"
        out.append(dict(id=name, um=round(sum(feature) / 2, 2), depth=round(depth, 3), err=round(err, 3), verdict=verdict))
    return out


def agreement(catalog_type: str | None, catalog_teff: float | None, result: dict) -> str:
    """'agree', 'close', 'differ', 'blend' or 'unknown': catalogue type or temperature against our fit."""
    if result.get("note") == "blend":
        return "blend"
    ours = result.get("standards")
    model = result.get("model")
    code = type_code(catalog_type) if catalog_type else math.nan
    if np.isfinite(code) and ours:
        gap = abs(type_code(ours["type"]) - code)
        return "agree" if gap <= 2 else "close" if gap <= 5 else "differ"
    if np.isfinite(code) and model:
        gap = abs(type_code(model["type"]) - code)
        return "agree" if gap <= 2 else "close" if gap <= 5 else "differ"
    our_teff = (ours or {}).get("teff") or (model or {}).get("teff")
    if catalog_teff and our_teff:
        gap = abs(our_teff - catalog_teff) / catalog_teff
        return "agree" if gap <= 0.1 else "close" if gap <= 0.25 else "differ"
    return "unknown"
