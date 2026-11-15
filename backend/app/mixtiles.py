"""Colour pictures of the SPHEREx all-sky cube, served as ordinary colour HiPS so the map (Aladin Lite)
can show them like any other survey. All of it is false colour: infrared light has no colour of its own.

Three recipes, all made from the cube's 8-bit display tiles (read from IRSA, cached on disk):

1. Tinted layers, /hips/spherex-mix/{spec}/... : the page chooses up to three planes of the cube, a tint
   and a brightness gain for each. `spec` lists the layers, bottom to top, joined by "_":
   f<frame>c<rrggbb>g<gain x 100>, for example f21c0080ffg089_f46c00ff00g100_f72cff0000g146 . Used for
   "mix your own colours" (the shortest wavelength blue, the longest red) and for the two-colour science
   views (a feature wavelength in orange against its neighbouring continuum in blue: equal = white,
   absorbed = blue, glowing = orange). The tiles are already asinh-stretched; a layer is
   tint x min(1, gain x level^1.3)  (the gamma keeps the faint speckle down, the gain saturates towards
   the tint and never changes its hue), and layers are added with the "screen" rule
   1 - (1-a)(1-b)(1-c) , which cannot overflow.

2. Three planes as red, green and blue, at the same address with the spec "R-G-B" (three plane numbers,
   for example 88-65-18): each plane stretched on its own sky level. The map's three ready-made
   three-colour views (ices, hydrogen gas, warm dust) use it.

3. The fixed "Infrared RGB" palette, /hips/spherex-color/... : each colour is the average of four planes
   (B = D1+D2, G = D3+D4, R = D5+D6, skipping the blank dichroic frames 50/51), which colours the sky and
   beats down the noise. Background, gain, saturation and gamma as tuned by Emre Bozkaya on DR1 tiles.
"""
from __future__ import annotations

import hashlib
import io
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from fastapi import APIRouter
from fastapi.responses import Response

from . import config, irsa, net

HIPS_ROOT = net.IRSA + "/data/hips/SPHEREx/spherex_allsky_cube"
router = APIRouter(prefix="/hips/spherex-mix")
colour_router = APIRouter(prefix="/hips/spherex-color")

BLANK_FRAMES = {50, 51}             # the two channels next to the dichroic: the cube has no tiles for them
MAX_LAYERS = 3
GAMMA = 1.3
VERSION = "m1"
_LAYER = re.compile(r"^f(\d{1,3})c([0-9a-f]{6})g(\d{2,3})$")
_tile_pool = ThreadPoolExecutor(16)
_slots = threading.BoundedSemaphore(6)            # colour tiles being made at the same time
_HIPS_COMMON = ["dataproduct_type = image", "dataproduct_subtype = color", "hips_version = 1.4", "hips_frame = equatorial",
                "hips_order = 5", "hips_order_min = 0", "hips_tile_width = 512", "hips_tile_format = png",
                "hips_initial_fov = 60"]


warm_router = APIRouter()
WARM_CONNECTIONS = 12                 # as many as irsa.SLOTS lets through at once
WARM_AGAIN_S = 25.0                   # IRSA keeps an idle connection open for at least this long
_warmed = 0.0
_warm_lock = threading.Lock()


def warm() -> bool:
    """Open the connections the colour tiles will use, in the background. The first tile made on
    cold connections takes about 2 s (12 pieces, each with its own TCP + TLS set-up); on open ones
    about 0.6 s. False if this ran in the last WARM_AGAIN_S seconds."""
    global _warmed
    with _warm_lock:
        if time.time() - _warmed < WARM_AGAIN_S:
            return False
        _warmed = time.time()

    def one(_):
        try:
            with irsa.SLOTS:
                net.get(HIPS_ROOT + "/properties", timeout=20, tries=1)
        except net.Upstream:
            pass                      # a head start only
    for i in range(WARM_CONNECTIONS):
        _tile_pool.submit(one, i)
    return True


@warm_router.get("/hips/warm")
def warm_route():
    """The page calls this when the Map opens. It answers at once."""
    return {"started": warm()}


# ---------------------------------------------------------------- an empty sky for the map's bottom layer
# The sky viewer (Aladin Lite) needs a bottom layer, and cannot change the wavelength of a cube there:
# the chosen wavelength is a layer above it. This one is empty and comes from here, so the map shows
# nothing but the chosen wavelength, and no second set of tiles is fetched from the archive.
blank_router = APIRouter(prefix="/hips/blank")
BLANK_TILE_PX = 64
_blank_png = None


def blank_png() -> bytes:
    global _blank_png
    if _blank_png is None:
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGBA", (BLANK_TILE_PX, BLANK_TILE_PX), (0, 0, 0, 0)).save(buf, "PNG")
        _blank_png = buf.getvalue()
    return _blank_png


@blank_router.get("/properties")
def blank_properties():
    txt = "\n".join(["creator_did = ivo://radians/P/blank", "obs_title = Empty sky (bottom layer of the map)",
                     "dataproduct_type = image", "hips_version = 1.4", "hips_frame = equatorial", "hips_order = 0",
                     "hips_order_min = 0", f"hips_tile_width = {BLANK_TILE_PX}", "hips_tile_format = png", ""])
    return Response(txt, media_type="text/plain", headers={"Cache-Control": "max-age=86400"})


_BLANK_CACHE = {"Cache-Control": "max-age=31536000, immutable"}


@blank_router.get("/Norder{order}/Dir{d}/Npix{npix}.png")
def blank_tile(order: int, d: int, npix: int):
    return Response(blank_png(), media_type="image/png", headers=_BLANK_CACHE)


@blank_router.get("/Norder3/Allsky.png")
def blank_allsky():
    """The whole-sky preview a HiPS client asks for first: 768 tiles of order 3 in a 27 x 29 grid, all empty."""
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGBA", (27 * BLANK_TILE_PX, 29 * BLANK_TILE_PX), (0, 0, 0, 0)).save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png", headers=_BLANK_CACHE)


@blank_router.get("/Moc.fits")
def blank_moc():
    """The coverage map a HiPS client asks for: the whole sky (the twelve cells of order 0)."""
    from astropy.io import fits
    table = fits.BinTableHDU.from_columns([fits.Column(name="UNIQ", format="1J", array=np.arange(4, 16, dtype="i4"))])
    for key, value in (("PIXTYPE", "HEALPIX"), ("ORDERING", "NUNIQ"), ("COORDSYS", "C"), ("MOCORDER", 0), ("MOCTOOL", "Radians")):
        table.header[key] = value
    buf = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), table]).writeto(buf)
    return Response(buf.getvalue(), media_type="application/fits", headers=_BLANK_CACHE)


def cube_tile(frame, order, npix):
    """One display tile of one plane of the cube as float32 grey levels 0..255; None where IRSA has none."""
    from PIL import Image
    d = npix // 10000 * 10000
    url = f"{HIPS_ROOT}/Norder{order}/Dir{d}/Npix{npix}{'_' + str(frame) if frame else ''}.png"
    try:
        with irsa.SLOTS:
            r = net.get(url, timeout=40, tries=3)
    except net.Upstream:
        return None
    if r.status_code != 200:
        return None
    return np.asarray(Image.open(io.BytesIO(r.content)).convert("L"), dtype=np.float32)


def _png(rgb: np.ndarray) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=False, compress_level=6)
    return buf.getvalue()


def _cached_tile(path, make) -> bytes | None:
    """The PNG at path, made once (make() returns uint8 RGB or None when IRSA has no tile)."""
    if path.exists():
        return path.read_bytes()
    with _slots:
        if path.exists():
            return path.read_bytes()
        rgb = make()
        if rgb is None:
            return None
        out = _png(rgb)
        config.atomic_write(path, out)
        return out


def _tile_reply(make_png, order, npix):
    if not 0 <= order <= 5 or not 0 <= npix < 12 * 4 ** order:
        return Response(status_code=404)
    try:
        png = make_png()
    except ValueError:
        return Response(status_code=404)
    except Exception as e:  # noqa: BLE001  (IRSA trouble: say so, never a traceback)
        return net.err(f"tile: {e}")
    if png is None:
        return Response(status_code=404)
    return Response(png, media_type="image/png", headers={"Cache-Control": "max-age=604800"})


def _properties(did, title, rights):
    txt = "\n".join([f"creator_did = ivo://radians/P/SPHEREx/DR1/{did}", f"obs_title = {title}", *_HIPS_COMMON,
                     f"obs_copyright = {rights}", ""])
    return Response(txt, media_type="text/plain", headers={"Cache-Control": "max-age=86400"})


# ---------------------------------------------------------------- 1. tinted layers
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
    name = hashlib.sha1(f"{VERSION}|{spec}".encode()).hexdigest()[:16]

    def make():
        jobs = [_tile_pool.submit(cube_tile, layer["frame"], order, npix) for layer in layers]
        return mix([j.result() for j in jobs], layers)
    return _cached_tile(config.CACHE_DIR / "sxmix" / name / f"{order}_{npix}.png", make)


# ---------------------------------------------------------------- 2. three planes as red, green, blue
def rgb_planes(spec: str) -> tuple[int, int, int] | None:
    """The three plane numbers of an "R-G-B" spec, or None when it is not one."""
    m = re.fullmatch(r"(\d{1,3})-(\d{1,3})-(\d{1,3})", spec)
    if not m:
        return None
    t = tuple(int(x) for x in m.groups())
    return t if all(0 <= x < 102 for x in t) else None


def rgb_tile(order: int, npix: int, r: int, g: int, b: int) -> bytes | None:
    def make():
        tiles = list(_tile_pool.map(lambda f: cube_tile(f, order, npix), (r, g, b)))
        any_t = next((t for t in tiles if t is not None), None)
        if any_t is None:
            return None
        rgb = np.zeros(any_t.shape + (3,), np.float32)
        for ci, t in enumerate(tiles):
            if t is not None:          # each plane's own sky level off (zodiacal light differs a lot per band)
                lit = t[t > 0]
                bk = float(np.percentile(lit, 25)) if lit.size > 100 else 4.0
                rgb[..., ci] = np.maximum(0, t - bk) / max(40.0, 255 - bk)
        return np.clip(np.power(rgb, 1 / 1.15) * 255, 0, 255).astype(np.uint8)
    return _cached_tile(config.CACHE_DIR / "sxmix" / "rgb" / f"{r}-{g}-{b}_{order}_{npix}.png", make)


@router.get("/{spec}/properties")
def properties(spec: str):
    if rgb_planes(spec):
        return _properties(f"mix/{spec}", f"SPHEREx DR1 planes {spec} as R-G-B", "NASA/JPL-Caltech/IPAC SPHEREx")
    try:
        layers = parse_spec(spec)
    except ValueError:
        return Response(status_code=404)
    planes = ", ".join(str(layer["frame"]) for layer in layers)
    return _properties(f"mix/{spec}", f"SPHEREx DR1 false colour: planes {planes} of the all-sky cube",
                       "NASA/JPL-Caltech/IPAC SPHEREx; false-colour mix made by Radians")


@router.get("/{spec}/Norder{order}/Dir{d}/Npix{npix}.png")
def tile(spec: str, order: int, d: int, npix: int):
    planes = rgb_planes(spec)
    if planes:
        return _tile_reply(lambda: rgb_tile(order, npix, *planes), order, npix)
    return _tile_reply(lambda: mix_tile(spec, order, npix), order, npix)


# ---------------------------------------------------------------- 3. the fixed "Infrared RGB" palette
COLOR_FRAMES = {"r": [72, 78, 89, 97], "g": [38, 46, 55, 63], "b": [4, 12, 21, 29]}
COLOR_BAL = {"r": (4, 1.35), "g": (4, 1.1), "b": (4, 1.0)}             # background level, gain
COLOR_SAT, COLOR_GAMMA, COLOR_VERSION = 1.45, 1.6, "v3"


def color_tile(order: int, npix: int) -> bytes | None:
    def make():
        jobs = {c: [_tile_pool.submit(cube_tile, f, order, npix) for f in fr] for c, fr in COLOR_FRAMES.items()}
        chans = {c: [t for t in (j.result() for j in js) if t is not None] for c, js in jobs.items()}
        any_t = next((t for ts in chans.values() for t in ts), None)
        if any_t is None:
            return None
        lin = np.zeros(any_t.shape + (3,), np.float32)
        for ci, c in enumerate("rgb"):
            if chans[c]:
                bk, gain = COLOR_BAL[c]
                lin[..., ci] = np.maximum(0, np.mean(chans[c], axis=0) - bk) * gain / 255
        L = lin.mean(axis=2, keepdims=True)
        with np.errstate(divide="ignore", invalid="ignore"):
            k = np.where(L > 0, np.power(np.minimum(L, 1.5), COLOR_GAMMA) / np.where(L > 0, L, 1), 0)
        return np.clip((L + (lin - L) * COLOR_SAT) * k * 255, 0, 255).astype(np.uint8)
    return _cached_tile(config.CACHE_DIR / "sxcolor" / f"{COLOR_VERSION}_{order}_{npix}.png", make)


@colour_router.get("/properties")
def color_properties():
    return _properties("color", "SPHEREx DR1 infrared colour (B 0.75-1.6, G 1.6-3.8, R 3.8-5 um)",
                       "NASA/JPL-Caltech/IPAC SPHEREx; colour composite after Emre Bozkaya")


@colour_router.get("/Norder{order}/Dir{d}/Npix{npix}.png")
def color_tile_route(order: int, d: int, npix: int):
    return _tile_reply(lambda: color_tile(order, npix), order, npix)
