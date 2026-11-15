"""Read a small box of pixels from a SPHEREx level-2 file over HTTP, without downloading the file.

A level-2 file (~65 MB) holds, in order: an empty primary HDU, IMAGE (float32, MJy/sr), FLAGS,
VARIANCE (float32), ZODI, PSF/EPSF, and finally WCS-WAVE (a small wavelength lookup table).
Image row y of a box from x0 to x1 is one contiguous run of bytes, so a box of h rows is h byte
ranges per HDU. See docs/BUILD_NOTES.md §2 for the reasoning.

Round trips per exposure:
1. headers + tail: the first 9 blocks (primary and IMAGE headers) and the last 3 blocks (the
   WCS-WAVE table) in one request. It gives the WCS, so we know which rows we need.
2. IMAGE rows (preview stops here). For full quality also the FLAGS descriptors and the first block
   of the FLAGS header, whose PCOUNT says where VARIANCE starts.
3. full quality: the FLAGS heap bytes of those rows, the VARIANCE header and VARIANCE rows.
The first file of each pipeline version also costs one or two requests to learn its layout
(header lengths), which is then cached.

Two FLAGS forms exist: older files store a plain int32 image; pipeline v27 (DR1, QR3) stores a
Rice-compressed binary table with one tile per image row.
"""
from __future__ import annotations

import bisect
import re
import threading
import warnings

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from .http import Http

warnings.simplefilter("ignore", FITSFixedWarning)

BLOCK = 2880
HEAD_BLOCKS = 9
TAIL_BYTES = 3 * BLOCK
EDGE_MARGIN = 4                  # the target must be at least this many pixels inside the detector

_TFORM_BYTES = {"L": 1, "B": 1, "I": 2, "J": 4, "K": 8, "E": 4, "D": 8, "A": 1}
_TFORM_DTYPE = {"B": ">u1", "I": ">i2", "J": ">i4", "K": ">i8", "E": ">f4", "D": ">f8"}


class LayoutMismatch(IOError):
    """The cached layout did not fit this file."""


def pad(n: int) -> int:
    return -(-n // BLOCK) * BLOCK


def parse_header(buf: bytes, off: int = 0):
    """(Header, padded length) of the FITS header starting at buf[off], or (None, None) if the END
    card is not inside buf. Cards are 80 bytes; the header ends at a card that reads 'END'."""
    for card_start in range(off, len(buf) - 79, 80):
        if buf[card_start:card_start + 8] == b"END     ":
            size = pad(card_start + 80 - off)
            if off + size > len(buf):
                return None, None
            return fits.Header.fromstring(buf[off:off + size].decode("latin-1")), size
    return None, None


def card_value(block: bytes, key: str):
    """Value of one integer/logical card read straight from raw header bytes."""
    for i in range(0, len(block) - 79, 80):
        if block[i:i + 8] == key.ljust(8).encode():
            v = block[i + 10:i + 80].split(b"/")[0].strip()
            return int(v) if v.lstrip(b"-").isdigit() else v.decode("latin-1")
    return None


def flag_names(hdr) -> dict[str, int]:
    """{flag name: bit} from a FLAGS header. Newer files: MSKNnnnn = 'NAME'; older: MP_NAME = bit."""
    names = {key[3:]: int(val) for key, val in hdr.items() if key.startswith("MP_")}
    names.update({str(val).strip(): int(key[4:]) for key, val in hdr.items()
                  if key[:4] == "MSKN" and key[4:].isdigit()})
    return names


def pipeline_version(url: str) -> str:
    m = re.search(r"-v(\d+)-", url)
    return m.group(1) if m else "?"


def read_table_row(hdr, data: bytes) -> dict[str, np.ndarray]:
    """Columns of the first row of a binary table (fixed-size columns only), shaped by TDIMn."""
    out, pos = {}, 0
    for i in range(1, int(hdr["TFIELDS"]) + 1):
        form = hdr[f"TFORM{i}"].strip()
        m = re.fullmatch(r"(\d*)([A-Z])", form)
        if not m:
            raise ValueError(f"unsupported column format {form!r}")
        count, code = int(m.group(1) or 1), m.group(2)
        nbytes = count * _TFORM_BYTES[code]
        if code in _TFORM_DTYPE:
            arr = np.frombuffer(data[pos:pos + nbytes], _TFORM_DTYPE[code]).astype(_TFORM_DTYPE[code][1:])
            tdim = hdr.get(f"TDIM{i}")
            if tdim:
                dims = [int(d) for d in tdim.strip("() ").split(",")]
                arr = arr.reshape(dims[::-1])
            out[hdr[f"TTYPE{i}"].strip()] = arr
        pos += nbytes
    return out


def find_wave_table(tail: bytes):
    """(X, Y, VALUES) of the WCS-WAVE table inside the last bytes of a file, or None."""
    i = tail.find(b"XTENSION= 'BINTABLE'")
    while i != -1:
        h, n = parse_header(tail, i)
        if h is not None and h.get("EXTNAME") == "WCS-WAVE":
            size = int(h["NAXIS1"]) * int(h["NAXIS2"])
            if i + n + size > len(tail):
                return None
            cols = read_table_row(h, tail[i + n:i + n + size])
            return cols["X"].astype("f8"), cols["Y"].astype("f8"), cols["VALUES"].astype("f4")
        i = tail.find(b"XTENSION= 'BINTABLE'", i + 1)
    return None


def wavelength_at(wave, x: float, y: float) -> tuple[float, float]:
    """(wavelength, bandwidth) in microns at a 0-based full-detector pixel. The table's sample
    positions are 1-based pixels; values are bilinearly interpolated (about 1 nm accurate)."""
    X, Y, V = wave
    fx = float(np.interp(x + 1, X, np.arange(len(X))))
    fy = float(np.interp(y + 1, Y, np.arange(len(Y))))
    ix, iy = min(int(fx), len(X) - 2), min(int(fy), len(Y) - 2)
    tx, ty = fx - ix, fy - iy
    v = (V[iy, ix] * (1 - tx) * (1 - ty) + V[iy, ix + 1] * tx * (1 - ty)
         + V[iy + 1, ix] * (1 - tx) * ty + V[iy + 1, ix + 1] * tx * ty)
    return float(v[0]), float(v[1])


def decode_rice_rows(flags_hdr, blobs: list[bytes]) -> np.ndarray:
    """Decompress Rice tiles (one image row each) of a tile-compressed FLAGS HDU -> int32 rows."""
    from astropy.io.fits.hdu.compressed._codecs import Rice1
    params = {str(flags_hdr.get(f"ZNAME{i}", "")).upper(): flags_hdr.get(f"ZVAL{i}") for i in range(1, 10)}
    width = int(flags_hdr["ZTILE1"])
    codec = Rice1(blocksize=int(params.get("BLOCKSIZE") or 32), bytepix=int(params.get("BYTEPIX") or 4),
                  tilesize=width)
    bytepix = int(params.get("BYTEPIX") or 4)
    rows = np.empty((len(blobs), width), "i4")
    for k, b in enumerate(blobs):
        raw = codec.decode(np.frombuffer(b, np.uint8))
        rows[k] = np.frombuffer(np.asarray(raw).tobytes(), dtype=f"i{bytepix}")[:width]
    return rows


FLAG_NEAR_ROWS = 6              # "near" flags: detector rows within this many pixels (37") of the target


def _expect(hdr, extname: str, url: str) -> None:
    found = hdr.get("EXTNAME") if hdr is not None else None
    if found != extname:
        raise IOError(f"{url}: expected the {extname} HDU here, got {found!r}")


class Reader:
    """Reads cutouts; remembers each pipeline version's layout so later files cost fewer requests."""

    def __init__(self, http: Http):
        self.http = http
        self.layouts: dict[tuple, dict] = {}
        self.lock = threading.Lock()

    # -- step 1 ---------------------------------------------------------------------------
    def head(self, url: str) -> dict:
        """Primary + IMAGE headers and the WCS-WAVE table, in one request when they fit."""
        nblk = HEAD_BLOCKS
        (buf, tail), total = self.http.fetch_ranges(url, [(0, nblk * BLOCK - 1), (-TAIL_BYTES, None)])
        h0, n0 = parse_header(buf, 0)
        h1, n1 = parse_header(buf, n0) if h0 is not None else (None, None)
        while h1 is None:
            if nblk > 200:
                raise IOError(f"FITS headers too long in {url}")
            nblk *= 3
            buf = self.http.get_ranges(url, [(0, nblk * BLOCK - 1)])[0]
            h0, n0 = parse_header(buf, 0)
            h1, n1 = parse_header(buf, n0) if h0 is not None else (None, None)
        _expect(h1, "IMAGE", url)
        if int(h1["BITPIX"]) != -32:
            raise IOError(f"{url}: IMAGE is not 32-bit float")
        wave = find_wave_table(tail)
        if wave is None:
            wave = find_wave_table(self.http.get_ranges(url, [(-20 * BLOCK, None)])[0])
        if wave is None:
            raise IOError(f"no WCS-WAVE table at the end of {url}")
        return dict(total=total, n0=n0, n1=n1, hdr=h1, wave=wave)

    def probe(self, url: str, ra: float, dec: float) -> dict:
        """One request: is (ra, dec) on this exposure, and at which wavelength? The result can be
        passed back to read() so the headers are not fetched twice."""
        head = self.head(url)
        b = self.box(head["hdr"], ra, dec, 0)
        head["on"] = b is not None
        head["wave_um"] = wavelength_at(head["wave"], b[4], b[5])[0] if b else None
        return head

    @staticmethod
    def box(hdr, ra: float, dec: float, half: int):
        """(x0, y0, x1, y1, xc, yc): pixel box around (ra, dec), clipped to the detector, or None
        if the position is off the detector or too close to its edge."""
        try:
            px = WCS(hdr).all_world2pix(ra, dec, 0, quiet=True)
        except Exception:  # noqa: BLE001  (a failed SIP inversion means "not on this detector")
            return None
        xc, yc = float(px[0]), float(px[1])
        nx, ny = int(hdr["NAXIS1"]), int(hdr["NAXIS2"])
        inside = (np.isfinite(xc) and np.isfinite(yc) and EDGE_MARGIN <= xc < nx - EDGE_MARGIN
                  and EDGE_MARGIN <= yc < ny - EDGE_MARGIN)
        if not inside:
            return None
        cx, cy = int(round(xc)), int(round(yc))
        return max(0, cx - half), max(0, cy - half), min(nx, cx + half + 1), min(ny, cy + half + 1), xc, yc

    # -- layout ---------------------------------------------------------------------------
    def _learn_layout(self, url: str, head: dict, key: tuple) -> dict:
        """Read the FLAGS and VARIANCE headers once for this kind of file."""
        hdr = head["hdr"]
        flags_hdu = head["n0"] + head["n1"] + pad(int(hdr["NAXIS1"]) * int(hdr["NAXIS2"]) * 4)
        fh, fn = self._header_at(url, flags_hdu)
        _expect(fh, "FLAGS", url)
        lay = dict(flags_hlen=fn, flag_names=flag_names(fh))
        width, nrow = int(fh["NAXIS1"]), int(fh["NAXIS2"])
        if fh["XTENSION"].strip() == "BINTABLE":
            row_tiled = bool(fh.get("ZIMAGE")) and int(fh.get("ZTILE2", 1)) == 1 and int(fh["ZTILE1"]) == int(fh["ZNAXIS1"])
            if not row_tiled:
                raise IOError(f"{url}: compressed FLAGS must use one tile per image row")
            lay.update(form="rice", row_bytes=width, flags_hdr=fh.tostring(), theap=int(fh.get("THEAP", width * nrow)))
            var_hdu = flags_hdu + fn + pad(width * nrow + int(fh.get("PCOUNT", 0)))
        else:
            lay["form"] = "plain"
            var_hdu = flags_hdu + fn + pad(abs(int(fh["BITPIX"])) // 8 * width * nrow)
        vh, vn = self._header_at(url, var_hdu)
        _expect(vh, "VARIANCE", url)
        lay["var_hlen"] = vn
        with self.lock:
            self.layouts[key] = lay
        return lay

    def _header_at(self, url: str, off: int):
        for nblk in (8, 24, 72, 216):
            h, n = parse_header(self.http.get_ranges(url, [(off, off + nblk * BLOCK - 1)])[0], 0)
            if h is not None:
                return h, n
        raise IOError(f"header at byte {off} too long in {url}")

    # -- the cutout -----------------------------------------------------------------------
    def read(self, url: str, ra: float, dec: float, half: int, full: bool = True, flags="all",
             head: dict | None = None) -> dict:
        """A cutout around (ra, dec): dict with img (float32), x0, y0, hdr (IMAGE header text),
        wave (X, Y, VALUES), mjd, xc/yc (target pixel on the detector).

        full=True adds var (float32). flags: "all" (every row of the box), "near" (only the rows
        within FLAG_NEAR_ROWS of the target, enough to see whether the target itself saturated;
        other rows are 0 and flag_rows says which rows are known) or None. Flags of v27 files are
        the expensive part (whole compressed detector rows, ~6 KB per row), hence the choice.
        `head` can be a result of probe() to save a request. {'off': True, ...} if the position
        is not on this detector."""
        head = head or self.head(url)
        hdr = head["hdr"]
        meta = dict(hdr=hdr.tostring(), mjd=float(hdr.get("MJD-AVG", hdr.get("MJD-OBS", np.nan))),
                    wave=head["wave"], total=head["total"])
        b = self.box(hdr, ra, dec, half)
        if b is None:
            return dict(meta, off=True)
        x0, y0, x1, y1, xc, yc = b
        nx, ny = int(hdr["NAXIS1"]), int(hdr["NAXIS2"])
        img_off = head["n0"] + head["n1"]
        box = _Box(x0, y0, x1, y1, nx)
        out = dict(meta, off=False, x0=x0, y0=y0, xc=xc, yc=yc)
        if not full:
            out["img"] = box.image(self.http.get_ranges(url, box.rows(img_off)), ">f4")
            return out
        flag_span = None
        if flags == "all":
            flag_span = (y0, y1)
        elif flags == "near":
            cy = int(round(yc))
            flag_span = (max(y0, cy - FLAG_NEAR_ROWS), min(y1, cy + FLAG_NEAR_ROWS + 1))
        key = (pipeline_version(url), head["n0"], head["n1"], nx, ny)
        flags_hdu = img_off + pad(nx * ny * 4)
        for attempt in (0, 1):
            lay = self.layouts.get(key) or self._learn_layout(url, head, key)
            reader = self._full_plain if lay["form"] == "plain" else self._full_rice
            try:
                out.update(reader(url, lay, img_off, flags_hdu, box, ny, flag_span))
            except LayoutMismatch:
                with self.lock:
                    self.layouts.pop(key, None)
                if attempt:
                    raise
                continue
            if flag_span:
                out["flag_names"] = lay["flag_names"]
                out["flag_rows"] = [flag_span[0] - y0, flag_span[1] - y0]
            return out
        raise AssertionError("unreachable")

    def _full_plain(self, url, lay, img_off, flags_hdu, box, ny, flag_span) -> dict:
        flags_data = flags_hdu + lay["flags_hlen"]
        var_hdu = flags_data + pad(box.nx * ny * 4)
        var_data = var_hdu + lay["var_hlen"]
        flag_ranges = box.rows(flags_data, flag_span) if flag_span else []
        wanted = box.rows(img_off) + box.rows(var_data) + flag_ranges
        got = self.http.get_ranges(url, wanted + [(flags_hdu, flags_hdu + 7), (var_hdu, var_hdu + 7)])
        if got[-2:] != [b"XTENSION", b"XTENSION"]:
            raise LayoutMismatch("FLAGS/VARIANCE not where the cached layout says")
        h = box.h
        out = dict(img=box.image(got[:h], ">f4"), var=box.image(got[h:2 * h], ">f4"))
        if flag_span:
            out["flags"] = box.partial_flags(np.frombuffer(b"".join(got[2 * h:len(wanted)]), ">i4")
                                             .reshape(-1, box.w).astype("i4"), flag_span)
        return out

    def _full_rice(self, url, lay, img_off, flags_hdu, box, ny, flag_span) -> dict:
        rb = int(lay["row_bytes"])                   # bytes per table row (one tile descriptor)
        flags_data = flags_hdu + lay["flags_hlen"]
        fa, fb = flag_span if flag_span else (box.y0, box.y0 + 1)
        # the FLAGS header's first block holds PCOUNT (the heap size): that is where VARIANCE starts
        got = self.http.get_ranges(url, box.rows(img_off) + [(flags_data + fa * rb, flags_data + fb * rb - 1),
                                                             (flags_hdu, flags_hdu + BLOCK - 1)])
        img_parts, desc_bytes, first_block = got[:box.h], got[box.h], got[box.h + 1]
        if not first_block.startswith(b"XTENSION") or card_value(first_block, "NAXIS1") != rb:
            raise LayoutMismatch("FLAGS header not where the cached layout says")
        var_hdu = flags_data + pad(rb * card_value(first_block, "NAXIS2") + card_value(first_block, "PCOUNT"))
        var_data = var_hdu + lay["var_hlen"]
        tiles = np.frombuffer(desc_bytes, ">i4" if rb == 8 else ">i8").reshape(-1, 2)   # (length, heap offset)
        heap = flags_data + lay["theap"]
        spans = _merge_spans([(heap + int(off), int(n)) for n, off in tiles]) if flag_span else []
        got2 = self.http.get_ranges(url, spans + [(var_hdu, var_data - 1)] + box.rows(var_data))
        vh, vn = parse_header(got2[len(spans)], 0)
        if vh is None or vh.get("EXTNAME") != "VARIANCE" or vn != lay["var_hlen"]:
            raise LayoutMismatch("VARIANCE header not where the cached layout says")
        out = dict(img=box.image(img_parts, ">f4"), var=box.image(got2[len(spans) + 1:], ">f4"))
        if flag_span:
            starts = [a for a, _ in spans]
            blobs = []
            for n, off in tiles:
                pos = heap + int(off)
                k = bisect.bisect_right(starts, pos) - 1          # the span holding this tile
                blobs.append(got2[k][pos - starts[k]:pos - starts[k] + int(n)])
            rows = decode_rice_rows(fits.Header.fromstring(lay["flags_hdr"]), blobs)[:, box.x0:box.x1]
            out["flags"] = box.partial_flags(rows, flag_span)
        return out


def _merge_spans(pieces: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Byte ranges (first, last) covering (start, length) pieces; touching pieces share a range."""
    spans: list[list[int]] = []
    for start, length in sorted(pieces):
        end = start + length - 1
        if spans and start <= spans[-1][1] + 1:
            spans[-1][1] = max(spans[-1][1], end)
        else:
            spans.append([start, end])
    return [(a, b) for a, b in spans]


class _Box:
    """A pixel box on a detector of width nx, and the byte ranges of its rows in an HDU."""

    def __init__(self, x0, y0, x1, y1, nx):
        self.x0, self.y0, self.x1, self.y1, self.nx = x0, y0, x1, y1, nx
        self.w, self.h = x1 - x0, y1 - y0

    def rows(self, data_off: int, span: tuple[int, int] | None = None, bytepix: int = 4):
        ya, yb = span or (self.y0, self.y1)
        return [(data_off + bytepix * (y * self.nx + self.x0), data_off + bytepix * (y * self.nx + self.x1) - 1)
                for y in range(ya, yb)]

    def image(self, parts: list[bytes], dtype: str) -> np.ndarray:
        return np.frombuffer(b"".join(parts), dtype).reshape(self.h, self.w).astype(dtype[1:])

    def partial_flags(self, rows: np.ndarray, span: tuple[int, int]) -> np.ndarray:
        full = np.zeros((self.h, self.w), "i4")
        full[span[0] - self.y0:span[1] - self.y0] = rows
        return full
