"""Read small pieces of remote SPHEREx Level-2 FITS files with HTTP byte ranges.

A full Level-2 file is ~65 MB and IRSA's cutout service always ships the 4 MB PSF table, so we
read only the header blocks and the pixel rows we need (~30 kB per exposure). IRSA answers
multi-range requests with multipart/byteranges, which lets one request carry every row.
"""
from __future__ import annotations

import io
import json
import re
import threading
import time
import warnings
from dataclasses import dataclass

import numpy as np
import requests
from astropy.io import fits
from astropy.io.fits.hdu.compressed._codecs import Rice1
from astropy.wcs import WCS, FITSFixedWarning

from . import config

BLOCK = 2880
MAX_RANGES_PER_REQUEST = 90
_local = threading.local()
warnings.simplefilter("ignore", FITSFixedWarning)


def session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = "Radians/0.1 (NASA Space Apps 2026)"
        _local.s = s
    return s


# ---------------------------------------------------------------- byte ranges
def _merge(ranges):
    """Sort and merge touching (start, stop) ranges."""
    out = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [tuple(r) for r in out]


def _parse_multipart(body: bytes, ctype: str):
    m = re.search(r'boundary="?([^";]+)"?', ctype)
    delim = b"--" + m.group(1).encode()
    pieces, pos = [], body.find(delim)
    while pos != -1:
        pos += len(delim)
        if body[pos:pos + 2] == b"--":
            break
        hend = body.find(b"\r\n\r\n", pos)
        cr = re.search(r"Content-Range:\s*bytes\s+(\d+)-(\d+)", body[pos:hend].decode("latin-1"), re.I)
        a, b = int(cr[1]), int(cr[2])
        start = hend + 4
        pieces.append((a, body[start:start + b - a + 1]))
        pos = body.find(delim, start + b - a + 1)
    return pieces


# One cap on IRSA requests for the whole server, however many visitors and worker threads there are
# (config.IRSA_MAX_INFLIGHT; from Efe's PR #9). The Sky Explorer's cut-outs (explorer.py) share it.
IRSA_SLOTS = threading.BoundedSemaphore(max(1, config.IRSA_MAX_INFLIGHT))


def _get(url, merged, timeout=60):
    spec = ",".join(f"{a}-{b - 1}" for a, b in merged)
    last = None
    for attempt in range(4):
        try:
            with IRSA_SLOTS:                  # held for the request and its body, released before any retry wait
                r = session().get(url, headers={"Range": "bytes=" + spec}, timeout=timeout, stream=True)
                busy = r.status_code in (429, 502, 503, 504)
                if not busy and r.status_code not in (200,):
                    r.raise_for_status()
                    body, ctype = r.content, r.headers.get("Content-Type", "")
            if busy:                          # IRSA busy: wait as asked, then retry
                wait = r.headers.get("Retry-After", "")
                r.close()
                last = IOError(f"HTTP {r.status_code}")
                time.sleep(min(30.0, float(wait) if wait.isdigit() else 2.0 ** attempt))
                continue
            if r.status_code == 200:          # server ignored the ranges: never download 65 MB
                r.close()
                if len(merged) == 1:
                    raise IOError(f"{url} does not support byte ranges")
                return [p for rng in merged for p in _get(url, [rng], timeout)]
            if ctype.startswith("multipart/byteranges"):
                return _parse_multipart(body, ctype)
            m = re.match(r"bytes (\d+)-(\d+)/", r.headers.get("Content-Range", ""))
            return [(int(m[1]), body)]
        except (requests.RequestException, AttributeError, TypeError) as e:
            last = e
    raise IOError(f"range request failed for {url}: {last}")


def fetch_ranges(url: str, ranges) -> list[bytes]:
    """Fetch half-open (start, stop) byte ranges; returns one bytes object per range."""
    ranges = [(int(a), int(b)) for a, b in ranges]
    merged = _merge(ranges)
    pieces = []
    for i in range(0, len(merged), MAX_RANGES_PER_REQUEST):
        pieces += _get(url, merged[i:i + MAX_RANGES_PER_REQUEST])
    out = []
    for a, b in ranges:
        for start, data in pieces:
            if start <= a < start + len(data):   # may be short at end of file
                out.append(data[a - start:b - start])
                break
        else:
            raise IOError(f"bytes {a}-{b} missing from response for {url}")
    return out


# ---------------------------------------------------------------- FITS layout
def _padded(n):
    return -(-n // BLOCK) * BLOCK


def parse_header(raw: bytes):
    """(Header, header length in bytes) or None if the END card is not in raw yet."""
    for i in range(0, len(raw) - 79, 80):
        if raw[i:i + 80].rstrip() == b"END":
            return fits.Header.fromstring(raw[:i + 80].decode("ascii")), _padded(i + 80)
    return None


def data_size(h) -> int:
    if h.get("NAXIS", 0) == 0:
        return 0
    n = abs(h["BITPIX"]) // 8
    for k in range(1, h["NAXIS"] + 1):
        n *= h[f"NAXIS{k}"]
    return n + h.get("PCOUNT", 0)


@dataclass
class HDUInfo:
    name: str
    start: int        # header start
    data_start: int
    size: int         # data bytes (unpadded)
    header: fits.Header

    @property
    def end(self):
        return self.data_start + _padded(self.size)


def read_hdu_at(url, off) -> HDUInfo:
    raw = b""
    while True:
        raw += fetch_ranges(url, [(off + len(raw), off + len(raw) + 4 * BLOCK)])[0]
        p = parse_header(raw)
        if p:
            h, hlen = p
            return HDUInfo(h.get("EXTNAME", "PRIMARY"), off, off + hlen, data_size(h), h)


def walk(url, until: str) -> dict[str, HDUInfo]:
    hdus, off = {}, 0
    while True:
        info = read_hdu_at(url, off)
        hdus[info.name] = info
        if info.name == until:
            return hdus
        off = info.end


# Header lengths are fixed by the pipeline version; learn them once, then a single request
# gives both the IMAGE header (per-exposure WCS) and the FLAGS header (variable heap size).
_templates: dict[str, dict] = {}
_tlock = threading.Lock()


def pipeline_version(url: str) -> str:
    m = re.search(r"(l2b-v\d+)", url)
    return m.group(1) if m else "unknown"


def _template(url):
    key = pipeline_version(url)
    with _tlock:
        if key in _templates:
            return _templates[key]
    path = config.CACHE_DIR / "layout" / f"{key}.json"
    if path.exists():
        t = json.loads(path.read_text())
    else:
        h = walk(url, "VARIANCE")
        t = {"image_hdr": h["IMAGE"].start, "image_hlen": h["IMAGE"].data_start - h["IMAGE"].start,
             "flags_hlen": h["FLAGS"].data_start - h["FLAGS"].start,
             "var_hlen": h["VARIANCE"].data_start - h["VARIANCE"].start}
        path.parent.mkdir(parents=True, exist_ok=True)
        config.atomic_write(path, json.dumps(t))
    with _tlock:
        _templates[key] = t
    return t


def image_and_flags_headers(url):
    t = _template(url)
    img_start = t["image_hdr"]
    img_data = img_start + t["image_hlen"]
    flags_start = img_data + _padded(config.DETECTOR_SIZE ** 2 * 4)
    raw_img, raw_flags = fetch_ranges(url, [(img_start, img_data), (flags_start, flags_start + t["flags_hlen"])])
    pi, pf = parse_header(raw_img), parse_header(raw_flags)
    if not pi or not pf or pf[0].get("EXTNAME") != "FLAGS":   # layout changed: walk it properly
        h = walk(url, "FLAGS")
        return h["IMAGE"], h["FLAGS"]
    img = HDUInfo("IMAGE", img_start, img_data, data_size(pi[0]), pi[0])
    flg = HDUInfo("FLAGS", flags_start, flags_start + pf[1], data_size(pf[0]), pf[0])
    return img, flg


# ---------------------------------------------------------------- cutouts
@dataclass
class Cutout:
    image: np.ndarray      # float32 [y, x], MJy/sr
    variance: np.ndarray   # float32
    flags: np.ndarray      # uint32
    x0: int                # detector pixel (0-based) of column 0
    y0: int
    header: fits.Header    # IMAGE header (celestial WCS)
    x: float               # target position on the detector (0-based)
    y: float


def _rows(data_start, ys, xa, xb, width, bytepix=4):
    return [(data_start + (y * width + xa) * bytepix, data_start + (y * width + xb) * bytepix) for y in ys]


def read_cutout(url: str, ra: float, dec: float, half: int) -> Cutout | None:
    """Square cutout of IMAGE/VARIANCE/FLAGS around (ra, dec), clipped to the detector."""
    img, flg = image_and_flags_headers(url)
    w = WCS(img.header)
    x, y = (float(v) for v in w.all_world2pix([[ra, dec]], 0, quiet=True)[0])
    n = config.DETECTOR_SIZE
    xa, xb = max(0, int(round(x)) - half), min(n, int(round(x)) + half + 1)
    ya, yb = max(0, int(round(y)) - half), min(n, int(round(y)) + half + 1)
    if xb - xa < 3 or yb - ya < 3:
        return None
    ys = range(ya, yb)
    t = _template(url)
    var_start = flg.end
    var_data = var_start + t["var_hlen"]

    img_r = _rows(img.data_start, ys, xa, xb, n)
    var_r = _rows(var_data, ys, xa, xb, n)
    desc_r = [(flg.data_start + y * 8, flg.data_start + y * 8 + 8) for y in ys]
    got = fetch_ranges(url, img_r + var_r + desc_r + [(var_start, var_data)])
    k = len(img_r)
    var_hdr = parse_header(got[-1])
    if not var_hdr or var_hdr[0].get("EXTNAME") != "VARIANCE" or var_hdr[1] != t["var_hlen"]:
        info = read_hdu_at(url, var_start)
        got[k:2 * k] = fetch_ranges(url, _rows(info.data_start, ys, xa, xb, n))

    image = np.frombuffer(b"".join(got[:k]), ">f4").reshape(len(ys), xb - xa).astype(np.float32)
    var = np.frombuffer(b"".join(got[k:2 * k]), ">f4").reshape(len(ys), xb - xa).astype(np.float32)
    flags = _read_flags(url, flg, got[2 * k:3 * k], xa, xb)
    return Cutout(image, var, flags, xa, ya, img.header, x, y)


def _read_flags(url, flg: HDUInfo, descriptors, xa, xb):
    h = flg.header
    if h.get("ZCMPTYPE", "").strip() != "RICE_1" or h.get("ZTILE2", 1) != 1:
        raise IOError(f"unsupported FLAGS compression in {url}")
    heap = flg.data_start + h.get("THEAP", h["NAXIS1"] * h["NAXIS2"])
    tiles = [np.frombuffer(d, ">i4") for d in descriptors]          # (nbytes, offset)
    raw = fetch_ranges(url, [(heap + int(o), heap + int(o) + int(nb)) for nb, o in tiles])
    width = h["ZTILE1"]
    codec = Rice1(blocksize=int(h.get("ZVAL1", 32)), bytepix=int(h.get("ZVAL2", 4)), tilesize=width)
    rows = [np.asarray(codec.decode(np.frombuffer(r, np.uint8))).view(np.int32).ravel()[:width][xa:xb] for r in raw]
    return np.array(rows).view(np.uint32)


# ---------------------------------------------------------------- spectral WCS
_wave: dict[str, fits.BinTableHDU] = {}
_wlock = threading.Lock()


def wave_table(url: str, detector: int) -> fits.BinTableHDU:
    """WCS-WAVE lookup table; fixed per detector and pipeline version, so cached on disk."""
    key = f"{pipeline_version(url)}_D{detector}"
    with _wlock:
        if key in _wave:
            return _wave[key]
    path = config.CACHE_DIR / "wave" / f"{key}.fits"
    if not path.exists():
        info = walk(url, "WCS-WAVE")["WCS-WAVE"]
        raw = fetch_ranges(url, [(info.start, info.data_start + info.size)])[0]
        buf = io.BytesIO()
        fits.PrimaryHDU().writeto(buf)
        buf.write(raw + b"\0" * (_padded(len(raw)) - len(raw)))
        path.parent.mkdir(parents=True, exist_ok=True)
        config.atomic_write(path, buf.getvalue())
    with fits.open(io.BytesIO(path.read_bytes()), memmap=False) as f:
        tab = fits.BinTableHDU(data=f[1].data.copy(), header=f[1].header.copy())
    with _wlock:
        _wave[key] = tab
    return tab


_wwcs: dict = {}


def wavelength_at(header, table: fits.BinTableHDU, x: float, y: float):
    """(wavelength, bandwidth) in micron at 0-based detector pixel (x, y). header: Header or its text.
    The spectral WCS (alternate key W, a lookup table) is the same for every exposure of a detector,
    so it is built once per distinct set of W keywords."""
    if isinstance(header, str):
        header = fits.Header.fromstring(header)
    cards = [c for c in header.cards if c.keyword.endswith("W") or c.keyword in ("NAXIS", "NAXIS1", "NAXIS2")]
    key = (id(table), tuple((c.keyword, str(c.value)) for c in cards))
    w = _wwcs.get(key)
    if w is None:
        hdul = fits.HDUList([fits.PrimaryHDU(), table])
        w = WCS(fits.Header(cards), fobj=hdul, key="W")
        _wwcs[key] = w
        if len(_wwcs) > 64:
            _wwcs.pop(next(iter(_wwcs)))
    lam, bw = w.wcs_pix2world([[x, y]], 0)[0]
    return float(lam), float(bw)
