"""The pictures on the home page's five target cards (frontend/media/<target>.webp).

Each is a short animation, one frame per SPHEREx visit, made from the app's sharpest product: every
exposure of a visit, all detector bands together, drizzled onto 3-arcsecond pixels (app/sharp.py,
the viewer's "Sharpened" source). All frames of a target share one brightness scale, so a star that
brightens really is brighter. The 78 x 78 picture is smoothed very slightly and enlarged smoothly
for the screen: that adds no detail, it only removes speckle and pixel blocks. Real data
throughout; nothing is drawn in but the four tick marks around the target and the date.

    cd backend && python scripts/make_cards.py        (the five targets come from the pre-built demo data)
"""
import base64
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import binary_dilation, gaussian_filter, grey_closing, median_filter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import archive, sharp  # noqa: E402
from app.engine.render import fill_holes  # noqa: E402
from app.main import DEMO, _build, load_demo  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "frontend" / "media"
SIZE = 640                       # picture side on the card, px
FOV = 240                        # arcsec
SMOOTH_PX = 0.6                  # Gaussian sigma in 3-arcsecond pixels
SKY, INK = (111, 195, 255), (238, 240, 246)
SLUGS = {"Barnard's Star": "barnard-s-star", "eps Indi B": "eps-indi-b", "WISE J085510.83-071442.5": "wise-0855",
         "RW Aur": "rw-aur", "R Dra": "r-dra"}


def font(size):
    for name in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def render(q: str, dets: str) -> list[Image.Image]:
    tg = archive.resolve(q)
    r6 = lambda v: float(f"{v:.6f}")  # noqa: E731
    b = _build(r6(tg["ra"]), r6(tg["dec"]), FOV, dets, tg.get("pmra"), tg.get("pmdec"), 2000.0, 400)
    got = sharp.visits(b["frs"], b["ra"], b["dec"], b["n"], 2)
    if not got:
        raise SystemExit(f"{q}: no sharpened pictures")
    n = got["grid"]["n"]
    frames = got["frames"]
    images = [np.frombuffer(base64.b64decode(f["image"]), "<f4").reshape(n, n) for f in frames]
    finite = np.concatenate([im[np.isfinite(im)] for im in images])
    # one scale for every visit: black just under the sky level, a knee at a few times the noise so
    # faint stars show next to a bright one, white at the 99.85th percentile
    sky = float(np.median(finite))
    noise = 1.4826 * float(np.median(np.abs(finite - sky))) or 1e-9
    lo, hi, soft = sky - noise, float(np.percentile(finite, 99.85)), 2.5 * noise
    k = SIZE / n
    out = []
    for f, im in zip(frames, images):
        # a touch of smoothing (1.8 arcsec, far below a star's 9 arcsec width) takes out the
        # pixel-to-pixel speckle that drizzling leaves where few exposures overlap
        holes = ~np.isfinite(im)
        im = np.nan_to_num(fill_holes(im), nan=sky)
        # single pixels far below their surroundings (a bad pixel that slipped through): the local median
        around = median_filter(im, size=5, mode="nearest")
        im = np.where(im < around - 5 * noise, around, im)
        core = holes & (im >= hi)
        if core.any():
            # a saturated core (R Draconis) has no honest pixel values: the few unsaturated samples leave
            # dark spokes in it. Around such a core only, it is closed up to an even white blob.
            im = np.where(binary_dilation(core, iterations=7), grey_closing(im, size=9), im)
        im = gaussian_filter(im, SMOOTH_PX, mode="nearest")
        x = np.arcsinh(np.clip(im - lo, 0, None) / soft) / np.arcsinh((hi - lo) / soft)
        x = np.nan_to_num(np.flipud(np.clip(x, 0, 1)), nan=0.0)   # row 0 is south: north goes to the top
        # stretched first, enlarged after: the bright cores are already compressed, so no ringing
        big = Image.fromarray(x.astype(np.float32), "F").resize((SIZE, SIZE), Image.BICUBIC)
        grey = Image.fromarray(np.clip(np.asarray(big) * 255, 0, 255).astype(np.uint8)).convert("RGB")
        d = ImageDraw.Draw(grey, "RGBA")
        if f.get("target_px"):
            cx, cy = (f["target_px"][0] + 0.5) * k, (f["target_px"][1] + 0.5) * k
            r = SIZE * 0.045
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                d.line([(cx + dx * r, cy + dy * r), (cx + dx * 2.2 * r, cy + dy * 2.2 * r)], fill=SKY + (230,), width=3)
        label = f["date_start"][:7] if f["date_start"][:7] == f["date_end"][:7] else f"{f['date_start'][:7]} → {f['date_end'][5:7]}"
        d.rectangle([0, SIZE - 40, 20 + 12 * len(label), SIZE], fill=(0, 0, 0, 150))
        d.text((12, SIZE - 33), label, font=font(22), fill=INK)
        out.append(grey)
    print(f"{q}: {len(out)} visits, {n} px at {got['grid']['pixel_scale']:.2f} arcsec, exposures per visit "
          f"{[f['n_exposures'] for f in frames]}, thin {[bool(f.get('thin')) for f in frames]}")
    return out


if __name__ == "__main__":
    load_demo()
    for q, dets, *_ in DEMO:
        frames = render(q, dets)
        path = OUT / f"{SLUGS[q]}.webp"
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=900, loop=0, quality=90, method=6)
        print("  ", path.name, f"{path.stat().st_size / 1024:.0f} kB")
