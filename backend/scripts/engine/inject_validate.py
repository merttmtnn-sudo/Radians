"""Injection test of the difference-picture finder (app/engine/changes.py).

Fake objects are added to the real SPHEREx exposures of the five challenge fields (the pre-built
views in demo/engine, so no network is needed), the first and last sky pass are stacked at matching
wavelengths exactly as the site does, the finder runs, and what comes back is counted. It also
counts what the finder reports with nothing injected. The all-detector tracker has its own test
(scripts/inject_validate.py); this one covers the second finder, so both have a measured rate.

    cd backend && python scripts/engine/inject_validate.py [trials per field, kind and S/N] > table.md

What is injected (a Gaussian of 9 arcsec FWHM, the SPHEREx point-spread width, on empty sky):
  mover       9 arcsec/yr in a random direction, placed in every exposure at that exposure's date;
  brightened  a steady source that is twice as bright in the last pass;
  appeared    a source that is only there in the last pass.
S/N is per sky pass, as a matched filter sees it: the source's peak in one pass's stack, smoothed
with the point-spread function, over the robust noise of that smoothed stack.
"""
from __future__ import annotations

import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.engine import changes, settings, stacking, store  # noqa: E402
from app.engine.views import view_id  # noqa: E402

SNRS = [5, 8, 12, 20, 40]
KINDS = ["mover", "brightened", "appeared"]
MOVE_ARCSEC_YR = 9.0
BRIGHTER = 2.0
MATCH_ARCSEC = 7.0                 # a find this close to the injected spot counts
TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 8
rng = np.random.default_rng(0)
sys.stdout.reconfigure(encoding="utf-8")


def load(spec: dict):
    folder = settings.DEMO / "views" / view_id(spec)
    return store.read_json(folder / "meta.json"), store.load_arrays(folder / "arrays.npz")


def stacks(frames, meta, arr):
    """First and last pass, stacked from exposure pairs at matching wavelengths (as ViewManager._diff)."""
    a, b = 0, len(meta["passes"]) - 1
    lo, hi = stacking.BANDS_UM[meta["band"]["id"]]
    ia, ib = np.flatnonzero(arr["pass_of"] == a), np.flatnonzero(arr["pass_of"] == b)
    pairs = stacking.pair_by_wavelength(ia, ib, arr["waves"], stacking.MATCH_TOL_FRACTION * (hi - lo))
    if pairs is None:
        pairs = (ia, ib)
    return stacking.median_stack(frames, pairs[0]), stacking.median_stack(frames, pairs[1]), (len(pairs[0]), len(pairs[1]))


def run_finder(frames, meta, arr):
    sa, sb, counts = stacks(frames, meta, arr)
    years = (meta["passes"][-1]["mjd"] - meta["passes"][0]["mjd"]) / 365.25
    return changes.find_changes(sa, sb, sb - sa, meta["field"]["scale_arcsec"], years, counts), (sa, sb)


def psf(n, x, y, sigma):
    yy, xx = np.mgrid[0:n, 0:n]
    return np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2)).astype("f4")


def field_numbers(meta, arr):
    """Noise of a smoothed pass stack, and where the sky is empty."""
    n, scale = meta["field"]["n"], meta["field"]["scale_arcsec"]
    sigma = changes.PSF_FWHM_ARCSEC / scale / 2.355
    sa, sb, _ = stacks(arr["frames"], meta, arr)
    smooth = changes._smooth(sb, sigma)
    _, noise = stacking.robust_stats(smooth)
    bright = np.fmax(changes._smooth(sa, sigma), smooth) / noise
    empty = np.isfinite(bright) & (bright < 3)
    edge = 14
    empty[:edge] = empty[-edge:] = False
    empty[:, :edge] = empty[:, -edge:] = False
    # stay away from anything bright (its wings would hide the test object) and from the target
    from scipy.ndimage import binary_dilation
    empty &= ~binary_dilation(np.nan_to_num(bright) > 8, iterations=int(round(2 * changes.PSF_FWHM_ARCSEC / scale)))
    for p in meta["passes"]:
        if p.get("target_px"):
            yy, xx = np.mgrid[0:n, 0:n]
            empty &= np.hypot(xx - p["target_px"][0], yy - (n - 1 - p["target_px"][1])) > 12
    # peak of a unit source after the same smoothing (a Gaussian smoothed by itself: amplitude / 2)
    return dict(n=n, scale=scale, sigma=sigma, noise=float(noise), empty=np.argwhere(empty), unit_peak=0.5)


def inject(kind, snr, meta, arr, num):
    n, scale, sigma = num["n"], num["scale"], num["sigma"]
    y, x = (float(v) for v in num["empty"][rng.integers(len(num["empty"]))])
    amp = snr * num["noise"] / num["unit_peak"]
    frames = np.array(arr["frames"], dtype="f4", copy=True)
    mjds, pass_of = arr["mjds"], arr["pass_of"]
    last = len(meta["passes"]) - 1
    t_end = float(np.mean(mjds[pass_of == last]))
    ang = rng.uniform(0, 2 * math.pi)
    for i in range(len(frames)):
        if kind == "mover":                                   # where it is on this exposure's date; ends at (x, y)
            back = MOVE_ARCSEC_YR / scale * (t_end - float(mjds[i])) / 365.25
            frames[i] += amp * psf(n, x - back * math.cos(ang), y - back * math.sin(ang), sigma)
        elif kind == "brightened":
            frames[i] += amp * (BRIGHTER if pass_of[i] == last else 1.0) / BRIGHTER * psf(n, x, y, sigma)
        elif pass_of[i] == last:                              # appeared
            frames[i] += amp * psf(n, x, y, sigma)
    return frames, (x, y)


def recovered(items, kind, spot, scale):
    for it in items:
        ix, iy = (it["x2"], it["y2"]) if it["kind"] == "mover" else (it["x"], it["y"])
        if it["kind"] == kind and math.hypot(ix - spot[0], iy - spot[1]) * scale <= MATCH_ARCSEC:
            return True
    return False


def main():
    index = store.read_json(settings.DEMO / "index.json")
    hits = {(k, s): [0, 0] for k in KINDS for s in SNRS}
    per_field, empty_rows = [], []
    t0 = time.time()
    for key, spec in index.items():
        meta, arr = load(spec)
        name = spec["target"]["name"] if spec.get("target") else key
        (items, notes), _ = run_finder(arr["frames"], meta, arr)
        num = field_numbers(meta, arr)
        n = meta["field"]["n"]
        targets = [(p["target_px"][0], n - 1 - p["target_px"][1]) for p in meta["passes"] if p.get("target_px")]
        others = [it for it in items
                  if not any(math.hypot((it.get("x2", it.get("x")) - tx), (it.get("y2", it.get("y")) - ty)) * num["scale"] <= 10 for tx, ty in targets)]
        runs = not notes
        empty_rows.append((name, meta["band"]["id"], len(meta["passes"]), len(others), "; ".join(notes)))
        if not runs or not len(num["empty"]):
            per_field.append((name, "not run: " + ("; ".join(notes) or "no empty sky")))
            continue
        got = 0
        for kind in KINDS:
            for snr in SNRS:
                for _ in range(TRIALS):
                    frames, spot = inject(kind, snr, meta, arr, num)
                    (found, _), _ = run_finder(frames, meta, arr)
                    ok = recovered(found, kind, spot, num["scale"])
                    hits[(kind, snr)][0] += ok
                    hits[(kind, snr)][1] += 1
                    got += ok
        per_field.append((name, f"{got} of {len(KINDS) * len(SNRS) * TRIALS} recovered"))
        print(f"<!-- {name}: done after {time.time() - t0:.0f} s -->", file=sys.stderr)

    label = {"mover": f"Mover, {MOVE_ARCSEC_YR:g}″/yr", "brightened": f"Brightened (×{BRIGHTER:g} in the last pass)",
             "appeared": "Appeared (last pass only)"}
    print("| Injected | " + " | ".join(f"S/N {s}" for s in SNRS) + " |")
    print("|---|" + "---|" * len(SNRS))
    for kind in KINDS:
        cells = []
        for s in SNRS:
            a, b = hits[(kind, s)]
            cells.append(f"{round(100 * a / b)}% ({a}/{b})" if b else "–")
        print(f"| {label[kind]} | " + " | ".join(cells) + " |")
    print()
    print("| Field (nothing injected) | Band | Passes | Finds besides the target | Finder's own note |")
    print("|---|---|---|---|---|")
    for name, band, passes, n_other, note in empty_rows:
        print(f"| {name} | {band} | {passes} | {n_other} | {note or '–'} |")
    print()
    for name, what in per_field:
        print(f"- {name}: {what}")


if __name__ == "__main__":
    main()
