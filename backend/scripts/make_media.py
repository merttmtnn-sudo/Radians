"""Animated GIFs of the demo targets from real SPHEREx frames (for the README, slides and the submission).

    python scripts/make_media.py            -> docs/media/<target>.gif and docs/media/radians-demo.gif
Uses the same cache as the app, so run scripts/warm.py first (or accept a slow first run)."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import archive, stack  # noqa: E402
from app.main import DEMO, _build  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "docs" / "media"
SIZE = 480                       # image side in px
BAR = 64                         # caption band
AMBER, SKY, INK, NIGHT = (255, 179, 71), (111, 195, 255), (238, 240, 246), (11, 16, 32)
NICE = {"Barnard's Star": "Barnard's Star — fastest-moving star", "eps Indi B": "ε Indi B — nearby brown dwarfs",
        "WISE J085510.83-071442.5": "WISE 0855−0714 — coldest brown dwarf (4.4–5 µm)",
        "RW Aur": "RW Aurigae — variable young star", "R Dra": "R Draconis — Mira variable"}


def font(size):
    for name in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def render(q, dets, fov=240):
    tg = archive.resolve(q)
    r6 = lambda v: float(f"{v:.6f}")  # noqa: E731
    b = _build(r6(tg["ra"]), r6(tg["dec"]), fov, dets, tg.get("pmra"), tg.get("pmdec"), 2000.0, 400)
    groups = stack.group_raw(b["frs"], "epoch")
    stackv = np.concatenate([g["image"][np.isfinite(g["image"])] for g in groups])
    lo, hi = np.percentile(stackv, [5, 99.7])
    soft = max(hi - lo, 1e-6) / 30
    n = b["n"]
    k = SIZE / n
    f_big, f_small = font(24), font(18)
    frames = []
    for g in groups:
        x = np.clip((g["image"] - lo) / (hi - lo), 0, 1)
        x = np.arcsinh(x * (hi - lo) / soft) / np.arcsinh((hi - lo) / soft)
        x = np.nan_to_num(np.flipud(x), nan=0.0)                     # row 0 is south: flip so north is up
        img = Image.fromarray((x * 255).astype(np.uint8)).resize((SIZE, SIZE), Image.NEAREST).convert("RGB")
        canvas = Image.new("RGB", (SIZE, SIZE + BAR), NIGHT)
        canvas.paste(img, (0, BAR))
        d = ImageDraw.Draw(canvas)
        ra, dec = stack.propagate(tg["ra"], tg["dec"], tg.get("pmra"), tg.get("pmdec"), 2000.0, g["mjd"])
        px, py = b["w"].wcs_world2pix([[ra, dec]], 0)[0]
        cx, cy = (px + 0.5) * k, BAR + (n - 1 - py + 0.5) * k
        r = max(14, 3 * k)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            d.line([(cx + dx * r, cy + dy * r), (cx + dx * 2 * r, cy + dy * 2 * r)], fill=SKY, width=3)
        d.text((12, 8), NICE.get(q, q), font=f_big, fill=INK)
        dets_txt = ", ".join(f"D{v}" for v in g["detectors"]) if len(g["detectors"]) < 6 else "all detectors"
        d.text((12, 38), f"{g['date_start'][:10]}  ·  visit {g['epoch']} of {len(groups)}  ·  {dets_txt}", font=f_small, fill=AMBER)
        d.text((SIZE - 128, SIZE + BAR - 26), f"{fov / 60:.0f}′ × {fov / 60:.0f}′  N↑ E←", font=f_small, fill=INK)
        frames.append(canvas)
    return frames


def pair(frames, path):
    """First and last visit side by side (for print, where a GIF shows only its first frame)."""
    a, b = frames[0], frames[-1]
    gap = 16
    out = Image.new("RGB", (a.width * 2 + gap, a.height), NIGHT)
    out.paste(a, (0, 0))
    out.paste(b, (a.width + gap, 0))
    out.save(path, optimize=True)
    print(path.name, f"{path.stat().st_size / 1024:.0f} kB")


def save(frames, path, ms=700):
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=ms, loop=0, optimize=True)
    print(path.name, f"{path.stat().st_size / 1024:.0f} kB", len(frames), "frames")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    reel = []
    for q, dets in DEMO:
        fr = render(q, dets)
        slug = "".join(c if c.isalnum() else "-" for c in q.lower()).strip("-")
        save(fr, OUT / f"{slug}.gif")
        pair(fr, OUT / f"{slug}-pair.png")
        reel += fr * 3                                               # each target blinks three times in the reel
    save(reel, OUT / "radians-demo.gif")
