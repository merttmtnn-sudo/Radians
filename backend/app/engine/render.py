"""Turn stacked images into pictures: PNG frames, difference images, colour-by-time, GIF.

Grid row 0 is the south edge, so every picture is flipped to put north at the top (east is left).
"""
from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageDraw


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


def stretch(img: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """asinh display stretch to 0..255 (blank pixels black)."""
    x = (np.asarray(img, "f8") - lo) / (hi - lo if hi > lo else 1.0)
    x = np.arcsinh(np.clip(x, 0, None) * 10) / np.arcsinh(10)
    return (np.clip(np.nan_to_num(x), 0, 1) * 255).astype("u1")


def _png(pixels: np.ndarray, mode: str | None = None) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(pixels[::-1]), mode).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def frame_png(img: np.ndarray, lo: float, hi: float) -> bytes:
    return _png(stretch(fill_holes(img), lo, hi))


def diff_png(diff: np.ndarray, limit: float) -> bytes:
    """Grey + alpha: 128 = no change, brighter = brighter later; alpha 0 = no data (saturated)."""
    v = np.clip(np.nan_to_num(diff) / (limit if limit > 0 else 1.0), -1, 1)
    grey = np.round(127.5 + 127.5 * v).astype("u1")
    alpha = np.where(np.isfinite(diff), 255, 0).astype("u1")
    return _png(np.dstack([grey, alpha]), "LA")


def timecolor_png(first: np.ndarray, middle: np.ndarray, last: np.ndarray, lo: float, hi: float) -> bytes:
    """Colour by time: the first pass in blue, the middle in green, the last in red. Something that
    stays put adds up to white; something that moves leaves a blue -> green -> red trail."""
    rgb = np.dstack([stretch(fill_holes(c), lo, hi) for c in (last, middle, first)])
    return _png(rgb, "RGB")


def gif(frames8: list[np.ndarray], labels: list[str], size: int = 360, ms: int = 700) -> bytes:
    pics = []
    for a, label in zip(frames8, labels):
        im = Image.fromarray(np.ascontiguousarray(a[::-1])).resize((size, size), Image.NEAREST).convert("RGB")
        draw = ImageDraw.Draw(im)
        draw.rectangle([0, 0, 8 + 7 * len(label), 18], fill=(0, 0, 0))
        draw.text((5, 4), label, fill=(255, 210, 90))
        pics.append(im.convert("P", palette=Image.ADAPTIVE))
    buf = io.BytesIO()
    pics[0].save(buf, format="GIF", save_all=True, append_images=pics[1:], duration=ms, loop=0)
    return buf.getvalue()


def mask_png(mask: np.ndarray) -> bytes:
    """A see-through overlay: red where the mask is set, nothing elsewhere."""
    rgba = np.zeros(mask.shape + (4,), "u1")
    rgba[mask] = (255, 70, 70, 150)
    return _png(rgba, "RGBA")
