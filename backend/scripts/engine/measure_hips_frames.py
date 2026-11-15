"""Measure the displayed brightness of every frame of the SPHEREx all-sky HiPS cube.

The Skyshift map paints 1 to 3 wavelength frames of the SPHEREx DR1 all-sky
HiPS cube (https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube)
with colours and adds them together. The PNG tiles are display-only: 8-bit,
fixed 0-40 MJy/sr asinh stretch. This script measures what those tiles really
contain, frame by frame, so that the colour mixer can

  * skip frames that hold no data (BLANK_FRAMES), and
  * balance the layers so that an ordinary star looks white (FRAME_GAIN).

What it does
  1. Downloads a fixed sample of order-3 tiles (see SAMPLE_TILES) for all 102
     frames. Every file is cached under skyshift/data/hips_sample/ (git-ignored);
     a tile that the server does not have (HTTP 404) is remembered with an empty
     ``.missing`` marker, so a second run downloads nothing.
  2. Decodes the palette PNGs (see ``decode_tile``) and measures, per tile and
     pooled: the fraction of pixels without data and the median, mean, 90th,
     99th and 99.9th percentile of the displayed grey level (0..255).
  3. Finds blank frames (no tiles at all) and "veiled" frames (the dark sky is
     lit up by airglow), and derives one white-balance gain per frame (see
     ``level_at_fraction`` and ``derive_gains``).
  4. Writes skyshift/frontend/data/frame_levels.json and prints a table, a
     sanity check and ready-to-paste JavaScript arrays for
     skyshift/frontend/js/colourdata.js.

Run (from anywhere):
    skyshift/.venv/Scripts/python.exe -X utf8 skyshift/backend/scripts/measure_hips_frames.py

Options (each adds downloads the first time; everything is cached):
    --offline     never touch the network (fail if a tile is not cached)
    --order5      also derive the gains from four order-5 tiles, as a cross-check
    --census      count empty pixels in 48 tiles spread over the sky, for the
                  frames that colourdata.js uses by default
    --pins        check that every preset shows its effect at its map pin
    --no-write    do not write frame_levels.json

Dependencies: numpy, pillow, requests, astropy (all in requirements.txt).
The HEALPix maths needed here (NESTED pixel number <-> sky position) is about
50 lines and is implemented below, so astropy-healpix is NOT required and was
NOT added to the project. It was cross-checked once against astropy-healpix
2.0.1 installed in a scratch folder: all 768 order-3 and 12288 order-5 centres
agree to 1e-13 degrees, and 20000 random positions fall in the same pixels.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image

HIPS_BASE = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
N_FRAMES = 102
ORDER = 3
MAX_WORKERS = 8  # be polite to IRSA
USER_AGENT = "hips-frame-statistics/1.0 (python-requests)"

SKYSHIFT = Path(__file__).resolve().parents[2]
CACHE_DIR = SKYSHIFT / "data" / "hips_sample"
OUT_JSON = SKYSHIFT / "frontend" / "data" / "frame_levels.json"

# ---------------------------------------------------------------------------
# The sample: eight order-3 tiles (each about 7.3 x 7.3 degrees, 512 x 512 px,
# 51.5 arcsec per pixel). They were chosen from the list of all 768 order-3
# tile centres by Galactic latitude b, spread over both hemispheres and over
# ecliptic latitude (SPHEREx covers the ecliptic poles far more often than the
# ecliptic plane, and residual zodiacal light is strongest near the ecliptic):
#   "high"  |b| > 60 deg : ordinary star fields with almost no dust or nebulae.
#                          These four tiles define the white balance.
#   "mid"   |b| ~ 30 deg : more stars, a little Galactic cirrus.
#   "plane"              : star-forming gas and the crowded inner Milky Way.
# Centres and Galactic / ecliptic latitudes are recomputed and printed at run
# time; the comments give them for reference.
# ---------------------------------------------------------------------------
SAMPLE_TILES = [
    # (npix, group, note)
    (439, "high", "North Galactic Pole, Coma Berenices"),       # RA 191.25 Dec +24.62  b +87.1  ecl.lat +26.9
    (558, "high", "South Galactic Pole, Sculptor"),             # RA  16.88 Dec -30.00  b -85.5  ecl.lat -34.0
    (165, "high", "Bootes, high ecliptic latitude"),            # RA 219.38 Dec +41.81  b +63.8  ecl.lat +53.1
    (271, "high", "Pisces / Cetus, on the ecliptic"),           # RA   0.00 Dec  -4.78  b -64.5  ecl.lat  -4.4
    (100, "mid", "Lynx / Cancer, towards the anticentre"),      # RA 123.75 Dec +35.69  b +31.6  ecl.lat +15.5
    (743, "mid", "Sagittarius / Microscopium, inner side"),     # RA 303.75 Dec -35.69  b -31.6  ecl.lat -15.5
    (334, "plane", "Orion: M42 and the Orion A cloud"),         # RA  84.38 Dec  -9.59  b -20.7  ecl.lat -32.9
    (472, "plane", "Inner Galactic plane in Aquila, l = 28"),   # RA 281.25 Dec  -4.78  b  -0.7  ecl.lat +18.2
]

# Order-5 children of the four "high" tiles, used only by --order5.
# Child of order-3 tile N at order 5: N * 16 + k (k = 0..15); k = 6 is central.
ORDER5_TILES = [n * 16 + 6 for n, group, _ in SAMPLE_TILES if group == "high"]

REFERENCE_UM = 2.1      # the gain is 1.00 at the channel nearest this wavelength
GAIN_MIN, GAIN_MAX = 0.5, 4.0


# ---------------------------------------------------------------------------
# HEALPix (NESTED) pixel centre, after Gorski et al. 2005
# ---------------------------------------------------------------------------
_JRLL = (2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4)
_JPLL = (1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7)


def _every_second_bit(value: int) -> int:
    out = bit = 0
    while value:
        out |= (value & 1) << bit
        value >>= 2
        bit += 1
    return out


def nested_pixel_centre(order: int, pix: int) -> tuple[float, float]:
    """Centre (RA, Dec in degrees) of NESTED HEALPix pixel ``pix`` at ``order``."""
    nside = 1 << order
    face, sub = divmod(pix, nside * nside)
    ix, iy = _every_second_bit(sub), _every_second_bit(sub >> 1)
    jr = _JRLL[face] * nside - ix - iy - 1          # ring number, 1 = north
    if jr < nside:                                   # north polar cap
        nr, kshift = jr, 0
        z = 1.0 - nr * nr / (3.0 * nside * nside)
    elif jr > 3 * nside:                             # south polar cap
        nr, kshift = 4 * nside - jr, 0
        z = nr * nr / (3.0 * nside * nside) - 1.0
    else:                                            # equatorial belt
        nr, kshift = nside, (jr - nside) & 1
        z = (2 * nside - jr) * 2.0 / (3.0 * nside)
    jp = (_JPLL[face] * nr + ix - iy + 1 + kshift) // 2
    if jp > 4 * nr:
        jp -= 4 * nr
    if jp < 1:
        jp += 4 * nr
    phi = (jp - (kshift + 1) * 0.5) * (math.pi / 2.0 / nr)
    return math.degrees(phi) % 360.0, math.degrees(math.asin(z))


def describe_tile(order: int, pix: int) -> dict:
    from astropy import units as u
    from astropy.coordinates import SkyCoord

    ra, dec = nested_pixel_centre(order, pix)
    c = SkyCoord(ra * u.deg, dec * u.deg, frame="icrs")
    return {
        "order": order,
        "npix": pix,
        "ra_deg": round(ra, 3),
        "dec_deg": round(dec, 3),
        "gal_l_deg": round(float(c.galactic.l.deg), 2),
        "gal_b_deg": round(float(c.galactic.b.deg), 2),
        "ecl_lat_deg": round(float(c.barycentricmeanecliptic.lat.deg), 2),
    }


# ---------------------------------------------------------------------------
# Download with cache
# ---------------------------------------------------------------------------
def tile_url(order: int, pix: int, frame: int) -> str:
    suffix = "" if frame == 0 else f"_{frame}"
    return f"{HIPS_BASE}/Norder{order}/Dir{(pix // 10000) * 10000}/Npix{pix}{suffix}.png"


def cache_path(order: int, pix: int, frame: int) -> Path:
    return CACHE_DIR / f"Norder{order}" / f"Npix{pix}_{frame}.png"


def fetch(session: requests.Session, url: str, dest: Path, offline: bool) -> str:
    """Make sure ``dest`` (or its ``.missing`` marker) exists. Returns a status word."""
    missing = dest.with_suffix(".missing")
    if dest.exists() and dest.stat().st_size > 0:
        return "cached"
    if missing.exists():
        return "cached-missing"
    if offline:
        raise RuntimeError(f"--offline, but not cached: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    last_error = None
    for attempt in range(6):
        try:
            r = session.get(url, timeout=60)
            if r.status_code == 404:
                missing.touch()
                return "missing"
            r.raise_for_status()
            if not r.content.startswith(b"\x89PNG"):
                raise RuntimeError("answer is not a PNG file")
            tmp = dest.with_suffix(".part")
            tmp.write_bytes(r.content)
            tmp.replace(dest)
            return "downloaded"
        except Exception as exc:  # network trouble: wait and try again
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"could not download {url}: {last_error}")


def fetch_all(jobs: list[tuple[int, int, int]], offline: bool) -> dict:
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    counts: dict[str, int] = {}

    def work(job):
        order, pix, frame = job
        return fetch(session, tile_url(order, pix, frame), cache_path(order, pix, frame), offline)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for status in pool.map(work, jobs):
            counts[status] = counts.get(status, 0) + 1
    return counts


def load_wavelengths(offline: bool) -> list[float]:
    """The 102 channel wavelengths (micron) from the HiPS ``properties`` file."""
    dest = CACHE_DIR / "properties.txt"
    if not dest.exists():
        if offline:
            raise RuntimeError("--offline, but properties.txt is not cached")
        dest.parent.mkdir(parents=True, exist_ok=True)
        r = requests.get(f"{HIPS_BASE}/properties", timeout=60, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        dest.write_text(r.text, encoding="utf-8")
    for line in dest.read_text(encoding="utf-8").splitlines():
        if line.startswith("data_cube_crval3_arr"):
            waves = [float(x) for x in line.split("=", 1)[1].split()]
            if len(waves) != N_FRAMES:
                raise RuntimeError(f"expected {N_FRAMES} wavelengths, found {len(waves)}")
            return waves
    raise RuntimeError("data_cube_crval3_arr not found in the HiPS properties")


# ---------------------------------------------------------------------------
# Decoding
# ---------------------------------------------------------------------------
PALETTE_NOTE = None  # filled by decode_tile from the first tile, then checked on all


def decode_tile(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Return (grey level 0..255 per pixel, has-data mask) of one PNG tile.

    The tiles are 8-bit palette PNGs written by CDS HipsGen. What we found in
    every sample tile (and what this function verifies instead of assuming):
      * the palette is grey (R = G = B);
      * palette index 0 is black and fully transparent (tRNS chunk): "no data";
      * palette index i (1..255) is grey level i - 1, opaque.
    So the displayed grey level is ``index - 1`` (0..254) and "no data" is
    index 0, which a browser draws as a transparent pixel (alpha = 0).
    """
    global PALETTE_NOTE
    im = Image.open(path)
    idx = np.asarray(im)
    if im.mode == "P":
        pal = np.array(im.getpalette("RGB"), dtype=np.int16).reshape(-1, 3)
        if not ((pal[:, 0] == pal[:, 1]).all() and (pal[:, 1] == pal[:, 2]).all()):
            raise RuntimeError(f"{path.name}: palette is not grey")
        grey_of_index = np.zeros(256, dtype=np.int16)
        grey_of_index[: len(pal)] = pal[:, 0]
        alpha_of_index = np.full(256, 255, dtype=np.int16)
        trns = im.info.get("transparency")
        if isinstance(trns, int):
            alpha_of_index[trns] = 0
        elif isinstance(trns, (bytes, bytearray)):
            alpha_of_index[: len(trns)] = np.frombuffer(bytes(trns), dtype=np.uint8)
        note = {
            "mode": "P (8-bit palette)",
            "palette_entries": int(len(pal)),
            "palette_is_grey": True,
            "grey_equals_index_minus_1": bool((grey_of_index[1:len(pal)] == np.arange(len(pal) - 1)).all()),
            "transparent_indices": [int(i) for i in np.where(alpha_of_index == 0)[0]],
        }
        if PALETTE_NOTE is None:
            PALETTE_NOTE = note
        elif note != PALETTE_NOTE:
            raise RuntimeError(f"{path.name}: palette differs from the first tile: {note}")
        return grey_of_index[idx], alpha_of_index[idx] > 0
    # Not expected, but handled: grey or RGB(A) tiles.
    rgba = np.asarray(im.convert("RGBA"), dtype=np.int16)
    return rgba[..., 0], rgba[..., 3] > 0


def histogram(path: Path) -> tuple[np.ndarray, int]:
    """(histogram of grey levels of the pixels with data, number of empty pixels)."""
    grey, valid = decode_tile(path)
    return np.bincount(grey[valid].ravel(), minlength=256).astype(np.int64), int((~valid).sum())


# ---------------------------------------------------------------------------
# Statistics from histograms of grey levels
# ---------------------------------------------------------------------------
def percentile(hist: np.ndarray, q: float) -> int | None:
    """Nearest-rank percentile: the smallest grey level L with at least q percent
    of the pixels at or below L. This is a level that really occurs in the tile."""
    total = int(hist.sum())
    if total == 0:
        return None
    return int(np.searchsorted(np.cumsum(hist), q / 100.0 * total, side="left"))


def level_at_fraction(hist: np.ndarray, fraction: float) -> float | None:
    """The grey level at or above which ``fraction`` of the pixels lie, interpolated.

    The tiles use only ~116 of the 255 grey levels and the faint ones are far
    apart (0, 35, 58, 73, 84, 93, ...: the brightness was cut into 256 equal
    steps of about 0.16 MJy/sr BEFORE the asinh stretch). A plain percentile can
    therefore only take those few values and jumps by 20-60 percent when the
    true brightness changes by a few percent. Here we use the exact points we do
    know - for every occupied level L, the fraction S(L) of pixels at or above
    it - and interpolate L linearly in log S between the two levels that
    bracket the wanted fraction. The result moves smoothly from frame to frame.
    """
    total = hist.sum()
    if total == 0:
        return None
    occupied = np.flatnonzero(hist)
    above = np.cumsum(hist[::-1])[::-1][occupied] / total      # S(L) for each occupied level
    k = int(np.flatnonzero(above >= fraction).max())
    if k == len(occupied) - 1:
        return float(occupied[k])
    lo, hi = occupied[k], occupied[k + 1]
    t = (math.log(above[k]) - math.log(fraction)) / (math.log(above[k]) - math.log(above[k + 1]))
    return float(lo + (hi - lo) * t)


def stats_from_hist(hist: np.ndarray, n_empty: int) -> dict:
    n = int(hist.sum())
    if n == 0:
        return {"blank_fraction": 1.0, "median": None, "mean": None, "p90": None, "p99": None, "p999": None}
    return {
        "blank_fraction": round(n_empty / (n + n_empty), 5),
        "median": percentile(hist, 50.0),
        "mean": round(float((hist * np.arange(256)).sum() / n), 2),
        "p90": percentile(hist, 90.0),
        "p99": percentile(hist, 99.0),
        "p999": percentile(hist, 99.9),
    }


def measure(order: int, tiles: list[int], frames) -> dict:
    """{frame: {npix: (hist, n_empty)}}; a tile the server does not have is fully empty."""
    out: dict[int, dict[int, tuple[np.ndarray, int]]] = {}
    for frame in frames:
        out[frame] = {}
        for pix in tiles:
            path = cache_path(order, pix, frame)
            if path.exists():
                out[frame][pix] = histogram(path)
            else:
                out[frame][pix] = (np.zeros(256, dtype=np.int64), 512 * 512)
    return out


def pooled(per_tile: dict, tiles: list[int]) -> tuple[np.ndarray, int]:
    hist = sum((per_tile[p][0] for p in tiles), np.zeros(256, dtype=np.int64))
    return hist, sum(per_tile[p][1] for p in tiles)


# ---------------------------------------------------------------------------
# White-balance gains
# ---------------------------------------------------------------------------
STAR_FRACTION = 0.01     # "ordinary stars" = the brightest 1 percent of star-field pixels


def smooth_over_frames(values: np.ndarray, usable: np.ndarray) -> np.ndarray:
    """Bridge unusable frames, then running median (5 frames) and a Gaussian
    (sigma = 2 frames). Removes single-frame jumps, keeps the broad trend."""
    n = len(values)
    x = np.arange(n)
    y = np.interp(x, x[usable], values[usable])
    med = np.array([np.median(y[max(0, i - 2): i + 3]) for i in range(n)])
    out = np.empty(n)
    for i in range(n):
        j = np.arange(max(0, i - 6), min(n, i + 7))
        wgt = np.exp(-0.5 * ((j - i) / 2.0) ** 2)
        out[i] = (wgt * med[j]).sum() / wgt.sum()
    return out


def derive_gains(star_level: list[float | None], unusable: set[int], waves: list[float]) -> tuple[list[float], int, np.ndarray]:
    """One gain per frame from the star level (see STAR_FRACTION).

    gain(frame) = smooth star level at the reference wavelength / smooth star level of the frame

    Multiplying a frame by its gain puts ordinary stars at the same displayed
    level in every frame, so a star comes out white when frames are mixed.
    ``unusable`` frames (blank, or veiled by airglow) do not take part in the
    fit; they get the value of the smooth curve (veiled) or 1 (blank).
    """
    n = len(waves)
    usable = np.array([i not in unusable and star_level[i] is not None for i in range(n)])
    logs = np.array([math.log(v) if (v is not None and v > 0) else 0.0 for v in star_level])
    smooth = smooth_over_frames(logs, usable)
    ref = int(np.argmin(np.abs(np.array(waves) - REFERENCE_UM)))
    gains = np.exp(smooth[ref] - smooth)
    gains = np.clip(gains, GAIN_MIN, GAIN_MAX)
    return [round(float(g), 2) for g in gains], ref, np.exp(smooth)


# ---------------------------------------------------------------------------
# Optional checks
# ---------------------------------------------------------------------------
# Keep these in step with skyshift/frontend/js/colourdata.js.
NATURAL_UM = (1.254, 2.089, 3.570)
PRESETS = [
    # id, pin id, feature wavelengths, continuum wavelengths
    ("water-ice", "tmc-1", (3.033,), (2.719, 3.667)),
    ("co2-ice", "tmc-1", (4.257,), (4.184, 4.368)),
    ("methane", "eps-indi-b", (3.293,), (3.118, 3.768)),
    ("paschen-alpha", "m42", (1.861,), (1.775, 1.949)),
    ("brackett-gamma", "m16", (2.189,), (2.089, 2.240)),
]
PINS_JSON = SKYSHIFT / "backend" / "app" / "data" / "pins.json"
PIN_EPOCH = 2025.85          # middle of the DR1 observations, for proper motion
CENSUS_TILES = list(range(8, 768, 16))   # 48 order-3 tiles, 4 in each of the 12 base pixels


def frame_of(um: float, waves: list[float]) -> int:
    return int(np.argmin(np.abs(np.array(waves) - um)))


def colourdata_frames(waves: list[float]) -> list[int]:
    ums = set(NATURAL_UM)
    for _, _, feature, continuum in PRESETS:
        ums.update(feature)
        ums.update(continuum)
    return sorted(frame_of(u, waves) for u in ums)


def gap_census(waves: list[float], offline: bool) -> None:
    """How much of the sky is empty in the frames that colourdata.js uses?"""
    frames = colourdata_frames(waves)
    fetch_all([(ORDER, t, f) for t in CENSUS_TILES for f in frames], offline)
    print("\nGap census: 48 order-3 tiles spread over the whole sky (6 percent of it)")
    print("frame  wave_um  empty pixels  tiles with > 100 empty px  worst tile")
    for f in frames:
        empty = np.array([histogram(cache_path(ORDER, t, f))[1] for t in CENSUS_TILES])
        worst = CENSUS_TILES[int(empty.argmax())]
        print(f"{f:5d}  {waves[f]:7.3f}  {100 * empty.sum() / (len(CENSUS_TILES) * 512 * 512):10.4f} %"
              f"  {int((empty > 100).sum()):12d} / 48        {100 * empty.max() / (512 * 512):.2f} % (Npix{worst})")


def _spread_bits(value: int) -> int:
    out = bit = 0
    while value:
        out |= (value & 1) << (2 * bit)
        value >>= 1
        bit += 1
    return out


def nested_pixel_of(order: int, ra: float, dec: float) -> int:
    """NESTED HEALPix pixel that contains (RA, Dec in degrees)."""
    nside = 1 << order
    z = math.sin(math.radians(dec))
    tt = (ra % 360.0) / 90.0
    if abs(z) <= 2.0 / 3.0:
        t1, t2 = nside * (0.5 + tt), nside * z * 0.75
        jp, jm = int(t1 - t2), int(t1 + t2)
        ifp, ifm = jp // nside, jm // nside
        face = (ifp & 3) | 4 if ifp == ifm else (ifp & 3 if ifp < ifm else (ifm & 3) + 8)
        ix, iy = jm & (nside - 1), nside - (jp & (nside - 1)) - 1
    else:
        ntt = min(3, int(tt))
        tp = tt - ntt
        tmp = nside * math.sqrt(3.0 * (1.0 - abs(z)))
        jp, jm = min(nside - 1, int(tp * tmp)), min(nside - 1, int((1.0 - tp) * tmp))
        if z >= 0:
            face, ix, iy = ntt, nside - jm - 1, nside - jp - 1
        else:
            face, ix, iy = ntt + 8, jp, jm
    return face * nside * nside + _spread_bits(ix) + (_spread_bits(iy) << 1)


def tile_row_col(order: int, ra: float, dec: float) -> tuple[int, int, int]:
    """(tile number, PNG row, PNG column) of a sky position in a 512 px HiPS tile.

    A 512 px tile at order K is the block of 512 x 512 HEALPix pixels of order
    K + 9. With (ix, iy) the HEALPix coordinates inside the tile, the PNG stores
    row = ix, column = iy (checked with the bright star eps Indi A, which lands
    exactly on the predicted pixel).
    """
    idx = nested_pixel_of(order + 9, ra, dec)
    tile, sub = idx >> 18, idx & ((1 << 18) - 1)
    return tile, _every_second_bit(sub), _every_second_bit(sub >> 1)


def pin_check(waves: list[float], gains: list[float], offline: bool) -> None:
    """Does each preset show its effect at its pin? (order-5 tiles, 12.9 arcsec pixels)

    Levels are multiplied by the frame gains first, exactly as the map does.
    'peak' is the brightest pixel in the 3 x 3 box on the pin; 'area' is the
    median over the bright pixels (level > 60) within 20 px (4.3 arcmin) of it.
    feature - continuum < 0 means the feature layer is darker (absorption),
    > 0 means it is brighter (emission).
    """
    pins = {p["id"]: p for p in json.loads(PINS_JSON.read_text(encoding="utf-8"))}
    print("\nPreset check at the pins (levels after gain)")
    for pid, pin_id, feature, continuum in PRESETS:
        pin = pins[pin_id]
        ra, dec = pin["ra"], pin["dec"]
        if pin.get("moving"):
            years = PIN_EPOCH - pin.get("epoch", 2000.0)
            ra += pin["pmra"] * years / 3.6e6 / math.cos(math.radians(dec))
            dec += pin["pmdec"] * years / 3.6e6
        tile, row, col = tile_row_col(5, ra, dec)
        frames = [frame_of(u, waves) for u in feature + continuum]
        fetch_all([(5, tile, f) for f in frames], offline)
        images = {}
        for f in frames:
            grey, valid = decode_tile(cache_path(5, tile, f))
            images[f] = np.where(valid, grey, np.nan) * gains[f]
        feat = np.mean([images[frame_of(u, waves)] for u in feature], axis=0)
        cont = np.mean([images[frame_of(u, waves)] for u in continuum], axis=0)
        box = (slice(max(0, row - 1), row + 2), slice(max(0, col - 1), col + 2))
        area = (slice(max(0, row - 20), row + 21), slice(max(0, col - 20), col + 21))
        bright = np.fmax(feat[area], cont[area]) > 60
        diff = (feat[area] - cont[area])[bright]
        print(f"  {pid:15s} pin {pin_id:11s} Norder5/Npix{tile} row {row} col {col}")
        if np.isnan(feat[box]).all() or np.isnan(cont[box]).all():
            print("      the pin itself lies in a hole (no data: the source is too bright there)")
        else:
            peaks = "  ".join(f"{waves[f]:.3f}: {np.nanmax(images[f][box]):3.0f}" for f in sorted(frames))
            print(f"      peak on the pin        {peaks}")
            print(f"      peak feature - continuum {np.nanmax(feat[box]) - np.nanmax(cont[box]):+6.1f}")
        if diff.size >= 10:
            print(f"      area ({diff.size} bright px) feature - continuum: median {np.nanmedian(diff):+6.1f}, "
                  f"{100 * np.mean(diff < -20):.0f} % darker by > 20, {100 * np.mean(diff > 20):.0f} % brighter by > 20")
    # The same measurement on ordinary stars (four high-latitude order-5 tiles):
    # a preset must be neutral there, otherwise its colours would mean nothing.
    blue, green, red = NATURAL_UM
    pairs = [(pid, feature, continuum) for pid, _, feature, continuum in PRESETS]
    pairs += [("natural blue-green", (blue,), (green,)), ("natural red-green", (red,), (green,))]
    frames = sorted({frame_of(u, waves) for _, fe, co in pairs for u in fe + co})
    fetch_all([(5, t, f) for t in ORDER5_TILES for f in frames], offline)
    print("  control: ordinary stars in four high-latitude tiles, bright pixels (level > 100)")
    for pid, feature, continuum in pairs:
        diffs = []
        for t in ORDER5_TILES:
            layer = {}
            for u in feature + continuum:
                grey, valid = decode_tile(cache_path(5, t, frame_of(u, waves)))
                layer[u] = np.where(valid, grey, np.nan) * gains[frame_of(u, waves)]
            feat = np.mean([layer[u] for u in feature], axis=0)
            cont = np.mean([layer[u] for u in continuum], axis=0)
            diffs.append((feat - cont)[np.fmax(feat, cont) > 100])
        d = np.concatenate(diffs)
        print(f"      {pid:18s} feature - continuum: median {np.nanmedian(d):+5.1f}  (16th to 84th percentile {np.nanpercentile(d, 16):+5.1f} to {np.nanpercentile(d, 84):+5.1f})")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--offline", action="store_true", help="use only cached files")
    ap.add_argument("--order5", action="store_true", help="cross-check the gains on four order-5 tiles")
    ap.add_argument("--census", action="store_true", help="count empty pixels over 48 tiles for the frames colourdata.js uses")
    ap.add_argument("--pins", action="store_true", help="check every preset at its pin (order-5 tiles)")
    ap.add_argument("--no-write", action="store_true", help="do not write frame_levels.json")
    args = ap.parse_args()

    waves = load_wavelengths(args.offline)
    tiles = [n for n, _, _ in SAMPLE_TILES]
    high = [n for n, g, _ in SAMPLE_TILES if g == "high"]
    plane_tile = [n for n, g, note in SAMPLE_TILES if g == "plane"][-1]
    frames = range(N_FRAMES)

    counts = fetch_all([(ORDER, n, f) for n in tiles for f in frames], args.offline)
    print("tiles:", ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    data = measure(ORDER, tiles, frames)

    tile_info = []
    print("\nSample tiles (order 3)")
    print(" Npix  group  RA      Dec     gal l   gal b   ecl lat  note")
    for n, group, note in SAMPLE_TILES:
        d = describe_tile(ORDER, n)
        tile_info.append({"npix": n, "group": group, "note": note, **{k: d[k] for k in ("ra_deg", "dec_deg", "gal_l_deg", "gal_b_deg", "ecl_lat_deg")}})
        print(f" {n:4d}  {group:5s}  {d['ra_deg']:6.2f}  {d['dec_deg']:+6.2f}  {d['gal_l_deg']:6.1f}  {d['gal_b_deg']:+6.1f}  {d['ecl_lat_deg']:+6.1f}   {note}")
    print("\nPNG format:", PALETTE_NOTE)
    levels_used = np.flatnonzero(sum(data[f][p][0] for f in frames for p in tiles))
    print(f"grey levels that occur: {len(levels_used)} of 255; the faintest are {levels_used[:12].tolist()}")

    # --- per-frame statistics -------------------------------------------------
    records = []
    star_level: list[float | None] = []
    lit = np.full(N_FRAMES, np.nan)
    for f in frames:
        hist_all, empty_all = pooled(data[f], tiles)
        hist_star, _ = pooled(data[f], high)
        rec = {"frame": f, "band": f // 17 + 1, "channel": f % 17 + 1, "wave_um": waves[f]}
        rec.update(stats_from_hist(hist_all, empty_all))
        rec["star_p99"] = percentile(hist_star, 99.0)
        level = level_at_fraction(hist_star, STAR_FRACTION)
        star_level.append(level)
        rec["star_p99_smooth"] = None if level is None else round(level, 1)
        rec["star_mean"] = None if hist_star.sum() == 0 else round(float((hist_star * np.arange(256)).sum() / hist_star.sum()), 2)
        if hist_star.sum():
            lit[f] = hist_star[1:].sum() / hist_star.sum()
        rec["star_lit_fraction"] = None if np.isnan(lit[f]) else round(float(lit[f]), 4)
        rec["plane_median"] = percentile(data[f][plane_tile][0], 50.0)
        rec["tile_blank_fraction"] = [round(data[f][p][1] / (512 * 512), 5) for p in tiles]
        rec["tile_median"] = [percentile(data[f][p][0], 50.0) for p in tiles]
        rec["tile_p99"] = [percentile(data[f][p][0], 99.0) for p in tiles]
        rec["tile_p999"] = [percentile(data[f][p][0], 99.9) for p in tiles]
        records.append(rec)

    # (a) blank: (nearly) all pixels empty in every sample tile
    blank = [r["frame"] for r in records if min(r["tile_blank_fraction"]) > 0.99]
    # (b) veiled: far more lit pixels in the dark star fields than in the neighbouring frames
    veiled = []
    for f in frames:
        if f in blank:
            continue
        near = [lit[g] for g in range(max(0, f - 4), min(N_FRAMES, f + 5)) if g != f and g not in blank]
        if lit[f] > 1.4 * np.median(near):
            veiled.append(f)
    gappy = [(r["frame"], max(r["tile_blank_fraction"])) for r in records
             if r["frame"] not in blank and max(r["tile_blank_fraction"]) > 0.0025]

    gains, ref, smooth_level = derive_gains(star_level, set(blank) | set(veiled), waves)
    for f in blank:
        gains[f] = 1.0
    for r in records:
        r["veiled"] = r["frame"] in veiled
        r["gain"] = gains[r["frame"]]

    # --- table ----------------------------------------------------------------
    print("\nframe band ch wave_um  empty%  median  mean   p90  p99 p99.9 | star fields: p99 p99smooth mean lit% | plane median | gain")
    for r in records:
        f = r["frame"]
        if f in blank:
            print(f"{f:5d} {r['band']:4d} {r['channel']:2d} {r['wave_um']:7.3f}  100.00  -- no tiles on the server (HTTP 404): blank frame --                        | {r['gain']:.2f}")
            continue
        flag = "  veiled (airglow)" if r["veiled"] else ""
        print(f"{f:5d} {r['band']:4d} {r['channel']:2d} {r['wave_um']:7.3f}  {100 * r['blank_fraction']:6.3f}  {r['median']:6d} {r['mean']:5.1f}  {r['p90']:4d} {r['p99']:4d}  {r['p999']:4d} |"
              f"             {r['star_p99']:4d}     {r['star_p99_smooth']:5.1f} {r['star_mean']:5.2f} {100 * r['star_lit_fraction']:5.2f} |"
              f"     {r['plane_median']:4d}     | {r['gain']:.2f}{flag}")

    print("\n(a) blank frames:", blank)
    print("(b) veiled frames (background lit up in dark star fields):", veiled)
    print("(b) frames with a gap > 0.25 % in at least one sample tile:", ", ".join(f"{f} ({100 * x:.2f} %)" for f, x in gappy) or "none")

    # --- sanity check ---------------------------------------------------------
    print(f"\nGain: reference frame {ref} ({waves[ref]} um), min {min(gains):.2f}, max {max(gains):.2f}")
    print("Sanity check in the four star-field tiles (level x gain):")
    for um in (1.25, 2.1, 3.5):
        f = frame_of(um, waves)
        r = records[f]
        print(f"  {waves[f]:.3f} um (frame {f:2d}): gain {gains[f]:.2f}  smooth p99 {r['star_p99_smooth']:5.1f} -> {r['star_p99_smooth'] * gains[f]:5.1f}"
              f"   plain p99 {r['star_p99']:3d} -> {r['star_p99'] * gains[f]:5.1f}")
    print("Natural-colour frames, level x gain, in the inner Galactic plane tile (median):")
    for um in NATURAL_UM:
        f = frame_of(um, waves)
        print(f"  {waves[f]:.3f} um: {records[f]['plane_median']} -> {records[f]['plane_median'] * gains[f]:.0f}")

    if args.order5:
        fetch_all([(5, n, f) for n in ORDER5_TILES for f in frames], args.offline)
        d5 = measure(5, ORDER5_TILES, frames)
        lvl5 = [level_at_fraction(pooled(d5[f], ORDER5_TILES)[0], STAR_FRACTION) for f in frames]
        g5, _, _ = derive_gains(lvl5, set(blank) | set(veiled), waves)
        print("\nCross-check: gains derived the same way from four order-5 tiles", ORDER5_TILES)
        print("  wave_um  order 3  order 5")
        for um in (0.80, 1.00, 1.25, 1.60, 2.10, 2.50, 3.00, 3.50, 4.00, 4.50, 4.95):
            f = frame_of(um, waves)
            print(f"  {waves[f]:7.3f}  {gains[f]:7.2f}  {g5[f]:7.2f}")

    if args.census:
        gap_census(waves, args.offline)
    if args.pins:
        pin_check(waves, gains, args.offline)

    # --- output ---------------------------------------------------------------
    print("\n// paste into frontend/js/colourdata.js")
    print(f"export const BLANK_FRAMES = {json.dumps(blank)};")
    print("export const FRAME_GAIN = [")
    for b in range(6):
        row = ", ".join(f"{g:.2f}" for g in gains[b * 17:(b + 1) * 17])
        print(f"  {row},  // band {b + 1}: {waves[b * 17]:.3f}-{waves[b * 17 + 16]:.3f} um")
    print("];")

    if not args.no_write:
        out = {
            "source": HIPS_BASE,
            "generated_by": "backend/scripts/measure_hips_frames.py",
            "order": ORDER,
            "level_scale": "displayed grey level 0..254 = palette index - 1; palette index 0 is transparent = no data",
            "png_format": PALETTE_NOTE,
            "levels_used": [int(v) for v in levels_used],
            "tiles": tile_info,
            "blank_frames": blank,
            "veiled_frames": veiled,
            "star_tiles": high,
            "plane_tile": plane_tile,
            "gain_reference_frame": ref,
            "frames": records,
        }
        OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(out, indent=1)
        # keep the short per-tile arrays on one line each
        import re
        text = re.sub(r"\[\s+([^\[\]{}]*?)\s+\]", lambda m: "[" + " ".join(m.group(1).split()) + "]", text)
        OUT_JSON.write_text(text + "\n", encoding="utf-8")
        print(f"\nwrote {OUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
