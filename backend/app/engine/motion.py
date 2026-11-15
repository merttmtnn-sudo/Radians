"""Where a star is in each sky pass, and the straight-line motion through those positions."""
from __future__ import annotations

import math

import numpy as np

from .changes import ALIGN_ERROR_ARCSEC, compass


def centroid(stack: np.ndarray, x: float, y: float, reach: int = 5) -> tuple[float, float] | None:
    """Brightness-weighted centre of the source near grid pixel (x, y); None if it is blank."""
    for _ in range(3):
        ix, iy = int(round(x)), int(round(y))
        y0, y1, x0, x1 = iy - reach, iy + reach + 1, ix - reach, ix + reach + 1
        if y0 < 0 or x0 < 0 or y1 > stack.shape[0] or x1 > stack.shape[1]:
            return None
        patch = stack[y0:y1, x0:x1]
        if not np.isfinite(patch).all():
            return None                                        # saturated core: no honest centre
        w = np.clip(patch - np.median(patch), 0, None)
        if w.sum() <= 0:
            return None
        yy, xx = np.mgrid[y0:y1, x0:x1]
        x, y = float((xx * w).sum() / w.sum()), float((yy * w).sum() / w.sum())
    return x, y


def motion_fit(positions: list[dict]) -> dict:
    """Straight-line motion through per-pass positions [{mjd, east, north}] (arcsec).
    Each position is good to about the pass-to-pass alignment error."""
    if len(positions) < 2:
        return dict(ok=False, reason="one_pass")
    t = np.array([(p["mjd"] - positions[0]["mjd"]) / 365.25 for p in positions])
    if np.ptp(t) < 0.2:
        return dict(ok=False, reason="short")
    out = {}
    for axis in ("east", "north"):
        v = np.array([p[axis] for p in positions])
        slope, offset = np.polyfit(t, v, 1)
        out[axis] = float(slope)
        out[axis + "_resid"] = float(np.std(v - (slope * t + offset))) if len(v) > 2 else 0.0
    err = ALIGN_ERROR_ARCSEC / math.sqrt(float(np.sum((t - t.mean()) ** 2)))
    rate = math.hypot(out["east"], out["north"])
    direction = math.degrees(math.atan2(out["east"], out["north"])) % 360
    return dict(ok=True, pm_east=out["east"], pm_north=out["north"], rate=rate, err=err, direction_deg=direction,
                direction=compass(direction), years=float(np.ptp(t)), n=len(positions),
                significant=rate >= 3 * err, resid=max(out["east_resid"], out["north_resid"]))
