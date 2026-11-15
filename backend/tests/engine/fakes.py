"""A fake IRSA for offline tests: synthetic SPHEREx-like FITS files and a session that answers
byte-range requests the way IRSA does (multipart answers, suffix ranges, the whole file when more
than 100 ranges are asked for, and optional 429s)."""
from __future__ import annotations

import io

import numpy as np
from astropy.io import fits

NX = NY = 256
PIX_DEG = 6.15 / 3600
FLAG_BITS = {"TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "NONFUNC": 6, "HOT": 10, "NONLINEAR": 15, "SOURCE": 21}


def make_file(ra0=150.0, dec0=10.0, mjd=60900.0, wave0=3.9, compressed=True, stars=(), rot_deg=0.0,
              seed=0, sky=5.0, noise=0.05, saturate_above=None, flag_above=None, wing=0.0) -> bytes:
    """A level-2-like MEF. stars: [(ra, dec, peak MJy/sr)], drawn as Gaussians (FWHM 1.5 px).
    The wavelength rises linearly along x from wave0 to wave0 + 0.5 um.
    saturate_above: brighter pixels become NaN with OVERFLOW+SUR_ERROR (a blank core);
    flag_above: brighter pixels keep their value but get OVERFLOW+NONLINEAR (saturated but finite,
    as for bright stars in D5-D6)."""
    rng = np.random.default_rng(seed)
    h = fits.Header()
    h["EXTNAME"] = "IMAGE"
    h["CTYPE1"], h["CTYPE2"] = "RA---TAN", "DEC--TAN"
    h["CRVAL1"], h["CRVAL2"] = ra0, dec0
    h["CRPIX1"], h["CRPIX2"] = (NX + 1) / 2, (NY + 1) / 2
    c, s = np.cos(np.radians(rot_deg)), np.sin(np.radians(rot_deg))
    h["CD1_1"], h["CD1_2"] = -PIX_DEG * c, PIX_DEG * s
    h["CD2_1"], h["CD2_2"] = PIX_DEG * s, PIX_DEG * c
    h["MJD-AVG"] = mjd
    h["BUNIT"] = "MJy / sr"
    from astropy.wcs import WCS
    w = WCS(h)
    yy, xx = np.mgrid[0:NY, 0:NX]
    img = sky + noise * rng.standard_normal((NY, NX))
    sig = 1.5 / 2.355
    for ra, dec, peak in stars:
        x, y = w.all_world2pix(ra, dec, 0)
        img += peak * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sig ** 2))
        if wing:                                   # a faint, wide halo around the star, as real PSFs have
            img += peak * wing * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 4.0 ** 2))
    flags = np.zeros((NY, NX), "i4")
    flags[3, 5] |= 1 << FLAG_BITS["HOT"]
    if saturate_above is not None:
        over = img > saturate_above
        img[over] = np.nan
        flags[over] |= (1 << FLAG_BITS["OVERFLOW"]) | (1 << FLAG_BITS["SUR_ERROR"])
    if flag_above is not None:
        flags[img > flag_above] |= (1 << FLAG_BITS["OVERFLOW"]) | (1 << FLAG_BITS["NONLINEAR"])
    img = img.astype(">f4")
    var = np.full((NY, NX), noise ** 2, ">f4")
    fh = fits.Header()
    for name, bit in FLAG_BITS.items():
        fh[f"MSKN{bit:04d}"] = name
    hdus = [fits.PrimaryHDU(), fits.ImageHDU(img, header=h, name="IMAGE")]
    if compressed:
        hdus.append(fits.CompImageHDU(flags, header=fh, name="FLAGS", compression_type="RICE_1", tile_shape=(1, NX)))
    else:
        hdus.append(fits.ImageHDU(flags, header=fh, name="FLAGS"))
    hdus.append(fits.ImageHDU(var, name="VARIANCE"))
    hdus.append(fits.ImageHDU(np.zeros((8, 8), ">f4"), name="ZODI"))
    gx = np.linspace(1, NX, 9).astype(">i4")
    gy = np.linspace(1, NY, 9).astype(">i4")
    vals = np.zeros((9, 9, 2), ">f4")
    vals[:, :, 0] = wave0 + 0.5 * (gx - 1) / (NX - 1)          # wavelength varies along x
    vals[:, :, 1] = 0.03
    cols = [fits.Column("X", "9J", array=gx[None], dim="(9)"),
            fits.Column("Y", "9J", array=gy[None], dim="(9)"),
            fits.Column("VALUES", "162E", array=vals.reshape(1, -1), dim="(2,9,9)")]
    hdus.append(fits.BinTableHDU.from_columns(cols, name="WCS-WAVE"))
    buf = io.BytesIO()
    fits.HDUList(hdus).writeto(buf)
    return buf.getvalue()


class FakeResponse:
    def __init__(self, status, content=b"", headers=None):
        self.status_code = status
        self.content = content
        self.headers = headers or {}
        self.closed = False

    @property
    def text(self):
        return self.content.decode()

    def close(self):
        self.closed = True

    def raise_for_status(self):
        if self.status_code >= 400:
            raise IOError(f"HTTP {self.status_code}")


class FakeIrsa:
    """session.get(url, headers=, params=, ...) over in-memory files; counts requests."""

    def __init__(self, files: dict[str, bytes] | None = None, sia_csv: str = "", fail_429: int = 0):
        self.files = files or {}
        self.sia_csv = sia_csv
        self.fail_429 = fail_429
        self.calls = []

    def get(self, url, headers=None, params=None, timeout=None, stream=False):
        self.calls.append((url, dict(headers or {})))
        if self.fail_429 > 0:
            self.fail_429 -= 1
            return FakeResponse(429, b"busy", {"Retry-After": "0"})
        if url.endswith("/SIA"):
            return FakeResponse(200, self.sia_csv.encode(), {"Content-Type": "text/csv"})
        data = self.files.get(url)
        if data is None:
            return FakeResponse(404, b"not found")
        rng = (headers or {}).get("Range")
        if not rng:
            return FakeResponse(200, data)
        specs = rng.split("=", 1)[1].split(",")
        if len(specs) > 100:                      # IRSA's behaviour: the whole file, status 200
            return FakeResponse(200, data)
        total = len(data)
        parts = []
        for sp in specs:
            a, b = sp.split("-")
            if a == "":
                a, b = total - int(b), total - 1
            else:
                a, b = int(a), (int(b) if b else total - 1)
            b = min(b, total - 1)
            parts.append((a, b))
        if len(parts) == 1:
            a, b = parts[0]
            return FakeResponse(206, data[a:b + 1], {"Content-Range": f"bytes {a}-{b}/{total}",
                                                     "Content-Type": "application/fits"})
        bnd = "FAKEBOUNDARY123"
        body = b""
        for a, b in parts:
            body += (f"\r\n--{bnd}\r\nContent-Type: application/fits\r\n"
                     f"Content-Range: bytes {a}-{b}/{total}\r\n\r\n").encode() + data[a:b + 1]
        body += f"\r\n--{bnd}--\r\n".encode()
        return FakeResponse(206, body, {"Content-Type": f"multipart/byteranges; boundary={bnd}"})


def region_of(data: bytes) -> list[float]:
    """The sky footprint of a file as the image search lists it: the corners of pixel (0,0), (nx,0),
    (nx,ny), (0,ny)."""
    from astropy.wcs import WCS
    with fits.open(io.BytesIO(data)) as hl:
        hdr = hl["IMAGE"].header
    nx, ny = hdr["NAXIS1"], hdr["NAXIS2"]
    sky = WCS(hdr).all_pix2world([[-0.5, -0.5], [nx - 0.5, -0.5], [nx - 0.5, ny - 0.5], [-0.5, ny - 0.5]], 0)
    return [float(v) for v in sky.ravel()]


def sia_csv(rows: list[dict]) -> str:
    """The image search's CSV. A row with "region" (see region_of) also gets an s_region column."""
    head = "obs_id,energy_bandpassname,access_url,obs_collection,dataproduct_subtype,calib_level,t_min,access_estsize,s_region"

    def region(r):
        pts = r.get("region")
        return "POLYGON ICRS " + " ".join(f"{v!r}" for v in list(pts) + list(pts[:2])) if pts else ""
    lines = [head] + [f"{r['obs_id']},SPHEREx-D{r['det']},{r['url']},{r.get('coll', 'spherex_dr1')},science,2,{r['mjd']},64000,{region(r)}"
                      for r in rows]
    return "\n".join(lines) + "\n"
