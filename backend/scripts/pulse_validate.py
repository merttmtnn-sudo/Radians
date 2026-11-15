"""Injection test of the pulse check (app/pulse.py), on the real observing dates of the challenge fields.

Field stars are taken from the pre-built demo fields (demo/built.pkl.gz, so no network is needed).
For each star its real measurements are turned into a steady star with the same dates, wavelengths,
spectrum and noise (the real scatter of the points, shuffled), and then:

  nothing injected   how often a rhythm or a change between visits is reported that is not there;
  a pulsation        brightness x (1 + A sin(2 pi t / P)), random phase: found = reported as convincing
                     with a period within 10% of the true one;
  a step             the last visit that has at least 30 measurements brighter by a given amount:
                     found = reported as a significant brightening between visits.

    cd backend && python scripts/pulse_validate.py [stars per field] [trials per star and cell] [runs with nothing injected per star] > table.md
"""
from __future__ import annotations

import gzip
import pickle
import sys
import time
import warnings
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import pulse, stack  # noqa: E402

PERIODS = [1.7, 3.0, 6.0, 11.0]
AMPLITUDES = [0.05, 0.10, 0.20, 0.40]
STEPS = [0.10, 0.20, 0.40]
STARS_PER_FIELD = int(sys.argv[1]) if len(sys.argv) > 1 else 2
TRIALS = int(sys.argv[2]) if len(sys.argv) > 2 else 1
NULL_TRIALS = int(sys.argv[3]) if len(sys.argv) > 3 else 5
STEP_VISIT_POINTS = 30
rng = np.random.default_rng(0)
sys.stdout.reconfigure(encoding="utf-8")


def field_stars(b: dict, want: int) -> list[dict]:
    """Unsaturated stars of a built field that the pulse check can work on, brightest first."""
    frs, n, w = b["frs"], b["n"], b["w"]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        deep = np.nanmedian(np.stack([f.image for f in frs]), axis=0)
    noise = 1.4826 * np.nanmedian(np.abs(deep - np.nanmedian(deep)))
    c = (n - 1) / 2
    found = []
    for y in range(6, n - 6):
        for x in range(6, n - 6):
            v = deep[y, x]
            if not np.isfinite(v) or v < 10 * noise or v < np.nanmax(deep[y - 1:y + 2, x - 1:x + 2]):
                continue
            if np.hypot(x - c, y - c) < 4:                    # the challenge target itself: not a steady star
                continue
            found.append((float(v), x, y))
    out = []
    for v, x, y in sorted(found, reverse=True):
        if stack.spot_check(frs, [(x, y)] * len(frs))["state"] != "star":
            continue
        raw = stack.photometry_at(frs, w, x, y)["points"]
        pts = [{"mjd": p["mjd"], "wavelength": p["wavelength"], "value": p.get("flux_ujy"), "err": p.get("err_ujy"),
                "flagged": bool(p.get("flagged")), "saturated": bool(p.get("saturated"))} for p in raw]
        c0 = pulse.clean(pts)
        if c0["t"].size < 120 or np.median(c0["r"] / c0["e"]) < 8:
            continue
        out.append({"x": x, "y": y, "points": pts, "snr": float(np.median(c0["r"] / c0["e"])), "n": int(c0["t"].size)})
        if len(out) == want:
            break
    return out


def steady(points: list[dict]) -> tuple[list[dict], np.ndarray]:
    """The usable points with their usual brightness, and each point's real relative deviation."""
    good = [p for p in points if not p["flagged"] and not p["saturated"] and p["value"] is not None and p["wavelength"]]
    w = np.array([p["wavelength"] for p in good])
    v = np.array([p["value"] for p in good])
    usual = np.full(v.size, np.nan)
    for g in pulse.wavelength_groups(w):
        usual[g] = np.median(v[g])
    keep = np.isfinite(usual) & (usual > 0)
    good = [dict(p, usual=float(u)) for p, u, k in zip(good, usual, keep) if k]
    resid = v[keep] / usual[keep] - 1
    resid = resid[np.abs(resid) < 5 * 1.4826 * np.median(np.abs(resid - np.median(resid)))]      # without the cosmic rays
    return good, resid


def simulate(good: list[dict], resid: np.ndarray, signal) -> list[dict]:
    t = np.array([p["mjd"] for p in good])
    noise = rng.choice(resid, size=t.size, replace=True)
    factor = signal(t) if signal else np.ones(t.size)
    return [dict(mjd=p["mjd"], wavelength=p["wavelength"], value=p["usual"] * (1 + e) * f, err=p["err"], flagged=False, saturated=False)
            for p, e, f in zip(good, noise, factor)]


def main():
    path = Path(__file__).resolve().parents[1] / "demo" / "built.pkl.gz"
    with gzip.open(path, "rb") as fh:
        built = pickle.load(fh)
    stars = []
    for key, b in built.items():
        got = field_stars(b, STARS_PER_FIELD)
        for s in got:
            s["field"] = f"{b['ra']:.3f} {b['dec']:+.3f}"
        stars += got
        print(f"<!-- field {b['ra']:.3f} {b['dec']:+.3f}: {len(got)} star(s) -->", file=sys.stderr)
    t0 = time.time()
    false_rhythm = false_change = nulls = 0
    hits = {(a, p): [0, 0] for a in AMPLITUDES for p in PERIODS}
    steps = {s: [0, 0] for s in STEPS}
    for k, s in enumerate(stars):
        good, resid = steady(s["points"])
        ts = np.sort(np.array([p["mjd"] for p in good]))
        runs = pulse.runs_of(ts)
        big = [r for r in runs if r.size >= STEP_VISIT_POINTS]
        lo, hi = (float(ts[big[-1][0]]) - 0.5, float(ts[big[-1][-1]]) + 0.5) if len(big) > 1 else (None, None)
        for _ in range(NULL_TRIALS):
            r = pulse.analyse(simulate(good, resid, None))
            if r["ok"]:
                nulls += 1
                false_rhythm += r["convincing"]
                false_change += bool(r["change"] and r["change"]["significant"])
        for a in AMPLITUDES:
            for p in PERIODS:
                for _ in range(TRIALS):
                    phase = rng.uniform(0, 2 * np.pi)
                    r = pulse.analyse(simulate(good, resid, lambda t, a=a, p=p, phase=phase: 1 + a * np.sin(2 * np.pi * t / p + phase)))
                    ok = bool(r["ok"] and r["convincing"] and abs(r["period_d"] / p - 1) < 0.10)
                    hits[(a, p)][0] += ok
                    hits[(a, p)][1] += 1
        if lo is not None:
            for step in STEPS:
                for _ in range(TRIALS):
                    r = pulse.analyse(simulate(good, resid, lambda t, step=step: np.where((t > lo) & (t < hi), 1 + step, 1.0)))
                    ch = r.get("change") if r["ok"] else None
                    steps[step][0] += bool(ch and ch["significant"] and ch["brighter"])
                    steps[step][1] += 1
        print(f"<!-- star {k + 1} of {len(stars)} done after {time.time() - t0:.0f} s -->", file=sys.stderr)

    snrs = sorted(s["snr"] for s in stars)
    print(f"{len(stars)} field stars from {len(built)} challenge fields; signal-to-noise of single measurements "
          f"{snrs[0]:.0f} to {snrs[-1]:.0f} (median {np.median(snrs):.0f}); {int(np.median([s['n'] for s in stars]))} usable measurements per star (median).")
    print()
    print("| Pulsation injected | " + " | ".join(f"period {p:g} d" for p in PERIODS) + " |")
    print("|---|" + "---|" * len(PERIODS))
    for a in AMPLITUDES:
        cells = [f"{round(100 * h / n)}% ({h}/{n})" if n else "–" for h, n in (hits[(a, p)] for p in PERIODS)]
        print(f"| ±{round(100 * a)}% | " + " | ".join(cells) + " |")
    print()
    print("| One visit brighter by | Found as a change between visits |")
    print("|---|---|")
    for step in STEPS:
        h, n = steps[step]
        print(f"| {round(100 * step)}% | {round(100 * h / n)}% ({h}/{n}) |" if n else f"| {round(100 * step)}% | – |")
    print()
    print(f"Nothing injected ({nulls} runs): a rhythm reported in {false_rhythm}, a change between visits in {false_change}.")


if __name__ == "__main__":
    main()
