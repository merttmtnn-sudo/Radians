"""For display: fill the blank cores of saturated stars in a stacked image."""
from __future__ import annotations

import numpy as np


def fill_holes(img: np.ndarray, rounds: int = 12) -> np.ndarray:
    """For display only: blank pixels (saturated star cores) take the brightest neighbouring
    value, so a core shows as a bright blob and not as a black hole."""
    from scipy.ndimage import maximum_filter
    out = np.array(img, dtype="f4", copy=True)
    for _ in range(rounds):
        holes = ~np.isfinite(out)
        if not holes.any():
            break
        grown = maximum_filter(np.where(holes, -np.inf, out), size=3, mode="nearest")
        fill = holes & np.isfinite(grown)
        if not fill.any():
            break
        out[fill] = grown[fill]
    return out
