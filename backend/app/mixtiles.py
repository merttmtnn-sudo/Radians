"""Colour mixes of the SPHEREx all-sky cube as a HiPS: any two or three wavelengths, each in its own tint.

The all-sky map's "Infrared RGB" palette is a fixed recipe (explorer.py). This is the open version
of the same idea: the page chooses up to three planes of the cube, a tint and a brightness gain for
each, and gets an ordinary colour HiPS back that Aladin Lite shows like any other survey:

    /hips/spherex-mix/{spec}/properties
    /hips/spherex-mix/{spec}/Norder{o}/Dir{d}/Npix{n}.png

`spec` lists the layers, bottom to top, joined by "_": f<frame>c<rrggbb>g<gain x 100>, for example
f21c0080ffg089_f46c00ff00g100_f72cff0000g146 . It is used for the "mix your own colours" tool
(the shortest wavelength blue, the longest red) and for the science views (a feature wavelength in
orange against its neighbouring continuum in blue: equal = white, absorbed = blue, glowing = orange).

The maths is the one measured for the map tiles (docs/COLOUR_DATA.md of the merged-in engine): the
tiles are 8-bit and already asinh-stretched; a layer is  tint x min(1, gain x level^1.3)  (the
gamma keeps the faint speckle down, the gain saturates towards the tint and never changes its hue),
and layers are added with the "screen" rule  1 - (1-a)(1-b)(1-c) , which cannot overflow.
All of it is false colour: infrared light has no colour of its own.

A second, simpler spec is served at the same address: three plane numbers "R-G-B" (for example
88-65-18), the recipe in explorer.py (mix_tile): pure red, green and blue, each plane stretched on
its own sky level. The map's three ready-made three-colour views (ices, hydrogen gas, warm dust) use it.
"""
from __future__ import annotations

import hashlib
import io
import re

import numpy as np
from fastapi import APIRouter
from fastapi.responses import Response

from . import config, explorer

router = APIRouter(prefix="/hips/spherex-mix")

BLANK_FRAMES = {50, 51}             # the two channels next to the dichroic: the cube has no tiles for them
MAX_LAYERS = 3
GAMMA = 1.3
VERSION = "m1"
_LAYER = re.compile(r"^f(\d{1,3})c([0-9a-f]{6})g(\d{2,3})$")


def parse_spec(spec: str) -> list[dict]:
    """[{frame, rgb: (r, g, b) 0..1, gain}], bottom layer first. ValueError on anything else."""
    parts = spec.split("_")
    if not 1 <= len(parts) <= MAX_LAYERS:
        raise ValueError("one to three layers")
    layers = []
    for part in parts:
        m = _LAYER.match(part)
        if not m:
            raise ValueError(f"bad layer {part!r}")
        frame, gain = int(m.group(1)), int(m.group(3)) / 100
        if not 0 <= frame <= 101 or frame in BLANK_FRAMES:
            raise ValueError(f"no such plane {frame}")
        if not 0.1 <= gain <= 8:
            raise ValueError("gain out of range")
        hexa = m.group(2)
        layers.append({"frame": frame, "gain": gain, "rgb": tuple(int(hexa[i:i + 2], 16) / 255 for i in (0, 2, 4))})
    return layers


def mix(tiles: list[np.ndarray | None], layers: list[dict]) -> np.ndarray | None:
    """Screen-blend tinted layers. tiles: grey levels 0..255 per layer (None where IRSA has no tile).
    Returns uint8 RGB, or None when no layer has a tile."""
    if all(t is None for t in tiles):
        return None
    shape = next(t for t in tiles if t is not None).shape
    dark = np.ones(shape + (3,), np.float32)                 # the product of (1 - layer)
    for tile, layer in zip(tiles, layers):
        if tile is None:
            continue
        level = np.minimum(1.0, layer["gain"] * np.power(np.clip(tile / 254.0, 0, 1), GAMMA))
        dark *= 1.0 - level[..., None] * np.asarray(layer["rgb"], np.float32)
    return np.clip((1.0 - dark) * 255 + 0.5, 0, 255).astype(np.uint8)


def mix_tile(spec: str, order: int, npix: int) -> bytes | None:
    layers = parse_spec(spec)
    key = hashlib.sha1(f"{VERSION}|{spec}".encode()).hexdigest()[:16]
    p = config.CACHE_DIR / "sxmix" / key / f"{order}_{npix}.png"
    if p.exists():
        return p.read_bytes()
    from PIL import Image
    with explorer._color_slots:
        if p.exists():
            return p.read_bytes()
        jobs = [explorer._tile_pool.submit(explorer._cube_tile, layer["frame"], order, npix) for layer in layers]
        rgb = mix([j.result() for j in jobs], layers)
        if rgb is None:
            return None
        buf = io.BytesIO()
        Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=False, compress_level=6)
        out = buf.getvalue()
        config.atomic_write(p, out)
        return out


@router.get("/{spec}/properties")
def properties(spec: str):
    if explorer._mix_ok(spec):                      # "R-G-B": three planes as red, green and blue
        return explorer.mix_properties(spec)
    try:
        layers = parse_spec(spec)
    except ValueError:
        return Response(status_code=404)
    txt = "\n".join([
        f"creator_did = ivo://radians/P/SPHEREx/DR1/mix/{spec}",
        f"obs_title = SPHEREx DR1 false colour: planes {', '.join(str(layer['frame']) for layer in layers)} of the all-sky cube",
        "dataproduct_type = image", "dataproduct_subtype = color", "hips_version = 1.4", "hips_frame = equatorial",
        "hips_order = 5", "hips_order_min = 0", "hips_tile_width = 512", "hips_tile_format = png", "hips_initial_fov = 60",
        "obs_copyright = NASA/JPL-Caltech/IPAC SPHEREx; false-colour mix made by Radians", ""])
    return Response(txt, media_type="text/plain", headers={"Cache-Control": "max-age=86400"})


@router.get("/{spec}/Norder{order}/Dir{d}/Npix{npix}.png")
def tile(spec: str, order: int, d: int, npix: int):
    if explorer._mix_ok(spec):
        return explorer.mix_tile_route(spec, order, d, npix)
    if not 0 <= order <= 5 or not 0 <= npix < 12 * 4 ** order:
        return Response(status_code=404)
    try:
        png = mix_tile(spec, order, npix)
    except ValueError:
        return Response(status_code=404)
    except Exception as e:  # noqa: BLE001  (IRSA trouble: say so, never a traceback)
        return explorer._err(f"tile: {e}")
    if png is None:
        return Response(status_code=404)
    return Response(png, media_type="image/png", headers={"Cache-Control": "max-age=604800"})
