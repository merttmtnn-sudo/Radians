"""Back end of the planetarium ("SPHEREx Sky Explorer" by Emre Bozkaya, ported from his Node.js server).

Endpoints under /api/sx/:
  images        every SPHEREx exposure that covers a position (IRSA SIA, all releases incl. deep fields)
  cutout        one exposure cut out around a position, as a compact binary frame ("SPX1"): a JSON header
                followed by float32 image, int32 flags, variance, zodiacal light, wavelength and bandwidth
                maps (the wavelength of every pixel from the WCS-WAVE lookup table of the file)
  catalog       Gaia DR3 / CatWISE / AllWISE / 2MASS sources in a cone (IRSA TAP)
  simbad        SIMBAD objects in a cone (CDS TAP, Harvard mirror as a fallback)
  resolve       a name through CDS Sesame, with proper motion, parallax and V magnitude
  hips-properties  the properties file of the SPHEREx all-sky spectral cube
HiPS tiles are read by the browser straight from IRSA (it allows cross-origin requests).
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse, Response

from . import config, irsa

IRSA = "https://irsa.ipac.caltech.edu"
TAP = IRSA + "/TAP/sync"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
HIPS_ROOT = IRSA + "/data/hips/SPHEREx/spherex_allsky_cube"
UA = {"User-Agent": "Radians/0.1 (NASA Space Apps 2026)"}
SIA_COLLECTIONS = ["spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep"]
URI_RE = re.compile(r"^ibe/data/spherex/[\w./-]+\.fits$")
WAVE_SEED = Path(__file__).resolve().parent / "wave_seed"

router = APIRouter(prefix="/api/sx")
_cutout_slots = irsa.SLOTS                       # one IRSA request cap shared with every other reader
_pool = ThreadPoolExecutor(8)


class Upstream(ConnectionError):
    pass


def _err(msg, code=502):
    return JSONResponse({"error": msg}, status_code=code, headers={"Cache-Control": "no-store"})


def _key(s):
    return hashlib.sha1(s.encode()).hexdigest()


def _cached_json(kind, key, ttl, fn):
    p = config.CACHE_DIR / kind / (_key(key)[:24] + ".json")
    try:
        if time.time() - p.stat().st_mtime < ttl:
            return json.loads(p.read_text())
    except OSError:
        pass
    out = fn()
    if out is not None:
        config.atomic_write(p, json.dumps(out))
    return out


def _get(url, params=None, timeout=60, tries=4, stream=False):
    """GET with retries: IRSA answers 429/502/503/504 ("server busy") now and then."""
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout, stream=stream)
            if r.status_code in (429, 502, 503, 504):
                last = Upstream(f"HTTP {r.status_code}")
                r.close()
            else:
                return r
        except requests.RequestException as e:
            last = e
        time.sleep(min(1.5 * 2 ** i, 12))
    raise Upstream(str(last))


def _csv(text):
    return list(csv.DictReader(io.StringIO(text)))


def _tap(adql, ttl):
    def run():
        r = _get(TAP, {"LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}, timeout=240, tries=3)
        if not r.ok or r.text.lstrip().startswith("<"):
            m = re.search(r'name="QUERY_STATUS"[^>]*>([\s\S]*?)</INFO>', r.text)
            raise Upstream("TAP error: " + (m.group(1).strip() if m else f"HTTP {r.status_code}"))
        return _csv(r.text)
    return _cached_json("sxtap", adql, ttl, run)


def _num(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- images
def _sia(coll, ra, dec):
    r = _get(IRSA + "/SIA", {"COLLECTION": coll, "POS": f"CIRCLE {ra} {dec} 0.0002", "RESPONSEFORMAT": "CSV"},
             timeout=60, tries=3)
    if not r.ok or r.text.lstrip().startswith("<"):
        raise Upstream("SIA error for " + coll)
    return _csv(r.text)


def find_images(ra, dec):
    p = config.CACHE_DIR / "sxsia" / (_key(f"{ra}:{dec}")[:24] + ".json")
    try:
        if time.time() - p.stat().st_mtime < 6 * 3600:
            return json.loads(p.read_text())
    except OSError:
        pass
    futs = [_pool.submit(_sia, c, ra, dec) for c in SIA_COLLECTIONS]
    lists, failed = [], []
    for c, f in zip(SIA_COLLECTIONS, futs):
        try:
            lists.append(f.result())
        except Exception:
            lists.append([])
            failed.append(c)
    if "spherex_dr1" in failed and "spherex_qr3" in failed:
        if p.exists():
            return json.loads(p.read_text())          # stale but better than nothing
        raise Upstream("IRSA SIA unavailable")
    rows = sorted((r for rows in lists for r in rows if r.get("access_url")), key=lambda r: _num(r.get("t_min")) or 0)
    out, seen = [], {}
    for r in rows:
        uri = re.sub(r"^https?://[^/]+/", "", r["access_url"])
        if not uri.lower().endswith(".fits"):
            continue
        did = r.get("obs_publisher_did") or ""
        m = re.search(r"ivo://irsa\.ipac/(\w+)\?([^/]+)/(D\d)", did)
        rel = m.group(1).replace("spherex_", "") if m else ((re.search(r"spherex/(\w+)/", uri) or [None, "?"])[1])
        obsid = m.group(2) if m else ""
        dm = re.search(r"D(\d)", str(r.get("energy_bandpassname")))
        item = {"uri": uri, "det": int(dm.group(1)) if dm else 0, "obsid": obsid, "rel": rel,
                "mjd": _num(r.get("t_min")), "mjdEnd": _num(r.get("t_max")),
                "wmin": (_num(r.get("em_min")) or 0) * 1e6, "wmax": (_num(r.get("em_max")) or 0) * 1e6,
                "exptime": _num(r.get("t_exptime"))}
        k = f"{obsid}/{item['det']}"
        if obsid and k in seen:                       # same exposure in two releases: prefer DR over QR
            if seen[k]["rel"].startswith("qr") and rel.startswith("dr"):
                seen[k].update(item)
            continue
        seen[k] = item
        out.append(item)
    res = {"items": out, "missing": [c.replace("spherex_", "").upper() for c in failed]}
    if not failed:
        config.atomic_write(p, json.dumps(res))
    return res


# ---------------------------------------------------------------- cut-outs
KEEP_KEYS = ["NAXIS1", "NAXIS2", "CRPIX1", "CRPIX2", "CRVAL1", "CRVAL2", "CDELT1", "CDELT2", "PC1_1", "PC1_2", "PC2_1",
             "PC2_2", "CD1_1", "CD1_2", "CD2_1", "CD2_2", "CTYPE1", "CTYPE2", "A_ORDER", "B_ORDER", "AP_ORDER", "BP_ORDER",
             "LONPOLE", "CRPIX1A", "CRPIX2A", "CRPIX1W", "CRPIX2W", "CRVAL1W", "CRVAL2W", "CDELT1W", "CDELT2W", "DETECTOR",
             "OBSID", "DATE-AVG", "MJD-AVG", "MJD-BEG", "MJD-END", "XPOSURE", "PSF_FWHM", "OMEGA_MEDIAN", "OMEGA_STDDEV",
             "L1DQAFLG", "L2DQAFLG", "PXSRCMSK", "FINAST", "HE_AIRGLOW_CONT", "SHUTTLE_GLOW_CONT", "AURORA_CONT",
             "NSNOWSRC", "SPS_ELON", "SPS_ELAT", "BUNIT", "SPS_FLAGS", "NON_SURVEY", "X_SC", "Y_SC", "Z_SC"]
SIP_RE = re.compile(r"^[ABP]{1,2}_\d_\d$")
_wave_mem: dict = {}


def _header(buf, off):
    """Parse one FITS header starting at off; None while it is not complete yet."""
    p = off
    while p + 80 <= len(buf):
        if buf[p:p + 8] == b"END     " or buf[p:p + 80].rstrip() == b"END":
            end = p + 80
            h = fits.Header.fromstring(bytes(buf[off:end]).decode("latin1"))
            start = -(-end // 2880) * 2880
            size = 0
            if h.get("NAXIS", 0) > 0:
                size = abs(h["BITPIX"]) // 8
                for i in range(1, h["NAXIS"] + 1):
                    size *= h[f"NAXIS{i}"]
                size = (size + h.get("PCOUNT", 0)) * h.get("GCOUNT", 1)
            return h, start, start + size, start + -(-size // 2880) * 2880
        p += 80
    return None


def _image(buf, h, start):
    n = h["NAXIS1"] * h["NAXIS2"]
    dt = {-32: ">f4", 32: ">i4", -64: ">f8", 16: ">i2"}.get(h["BITPIX"])
    if dt is None:
        raise ValueError(f"unsupported BITPIX {h['BITPIX']}")
    a = np.frombuffer(bytes(buf[start:start + n * abs(h['BITPIX']) // 8]), dtype=dt)
    bs, bz = h.get("BSCALE", 1), h.get("BZERO", 0)
    if h["BITPIX"] == 32 and bs == 1 and bz == 0:
        return a.astype("<i4")
    return (a.astype(np.float64) * bs + bz).astype("<f4") if (bs != 1 or bz != 0) else a.astype("<f4")


def _bintable_row0(buf, h, start):
    cols, off = {}, start
    sizes = {"J": (4, ">i4"), "E": (4, ">f4"), "D": (8, ">f8"), "I": (2, ">i2"), "K": (8, ">i8"), "B": (1, "u1"),
             "L": (1, "u1"), "A": (1, "u1")}
    for i in range(1, h["TFIELDS"] + 1):
        m = re.match(r"^(\d*)([A-Z])", str(h[f"TFORM{i}"]))
        rep, t = int(m.group(1) or 1), m.group(2)
        sz, dt = sizes[t]
        cols[str(h[f"TTYPE{i}"]).strip()] = np.frombuffer(bytes(buf[off:off + rep * sz]), dtype=dt).astype(float)
        off += rep * sz
    return cols


def _wave_key(h):
    hist = [str(s) for s in h.get("HISTORY", []) if str(s).startswith("[CALIB] spectral_wcs")]
    cid = hist[-1].split()[-1] if hist else "unknown"
    return f"D{h.get('DETECTOR')}_" + re.sub(r"[^\w-]", "", cid)


def _wave_table(key):
    if key in _wave_mem:
        return _wave_mem[key]
    for p in (config.CACHE_DIR / "sxwave" / f"{key}.json", WAVE_SEED / f"{key}.json"):
        if p.exists():
            t = json.loads(p.read_text())
            _wave_mem[key] = t
            return t
    return None


def _wave_maps(t, h, nx, ny):
    """Per-pixel wavelength and bandwidth from the WCS-WAVE lookup table (FITS paper III, -TAB)."""
    X, Y = np.asarray(t["X"], float), np.asarray(t["Y"], float)
    V = np.asarray(t["VALUES"], float).reshape(len(Y), len(X), 2)

    def frac(arr, v):
        n = len(arr)
        f = np.interp(v, arr, np.arange(n))
        lo, hi = v < arr[0], v > arr[-1]
        f[lo] = (v[lo] - arr[0]) / (arr[1] - arr[0])
        f[hi] = n - 1 + (v[hi] - arr[-1]) / (arr[-1] - arr[-2])
        return f

    i = np.arange(nx, dtype=float)
    j = np.arange(ny, dtype=float)
    px = h.get("CDELT1W", 1) * (i + 1 - h.get("CRPIX1W", 0)) + h.get("CRVAL1W", 1)
    py = h.get("CDELT2W", 1) * (j + 1 - h.get("CRPIX2W", 0)) + h.get("CRVAL2W", 1)
    fx, fy = frac(X, px), frac(Y, py)
    ix = np.clip(np.floor(fx).astype(int), 0, len(X) - 2)
    iy = np.clip(np.floor(fy).astype(int), 0, len(Y) - 2)
    tx, ty = (fx - ix)[None, :, None], (fy - iy)[:, None, None]
    a = V[iy[:, None], ix[None, :]]
    b = V[iy[:, None], ix[None, :] + 1]
    c = V[iy[:, None] + 1, ix[None, :]]
    d = V[iy[:, None] + 1, ix[None, :] + 1]
    out = (1 - tx) * (1 - ty) * a + tx * (1 - ty) * b + (1 - tx) * ty * c + tx * ty * d
    return out[..., 0].astype("<f4").ravel(), out[..., 1].astype("<f4").ravel()


def _jsonable(v):
    if isinstance(v, (bool, int, float, str)):
        return v
    return str(v)


def _blob(hdus, buf, wave):
    H, start = hdus["IMAGE"][0], hdus["IMAGE"][1]
    nx, ny = H["NAXIS1"], H["NAXIS2"]
    n = nx * ny
    hdr = {k: _jsonable(H[k]) for k in KEEP_KEYS if k in H}
    for k in H.keys():
        if SIP_RE.match(k) or k.startswith("L2 N_"):
            hdr[k] = _jsonable(H[k])
    flag_names = {}
    if "FLAGS" in hdus:
        fh = hdus["FLAGS"][0]
        for k in fh.keys():
            m = re.match(r"^MSKN(\d{4})$", k)
            if m:
                flag_names[str(int(m.group(1)))] = [str(fh[k]), str(fh.get("MSKD" + m.group(1), ""))]
    image = _image(buf, H, start).astype("<f4")
    flags = _image(buf, hdus["FLAGS"][0], hdus["FLAGS"][1]).astype("<i4") if "FLAGS" in hdus else np.zeros(n, "<i4")
    var = _image(buf, hdus["VARIANCE"][0], hdus["VARIANCE"][1]).astype("<f4") if "VARIANCE" in hdus \
        else np.full(n, np.nan, "<f4")
    zodi = _image(buf, hdus["ZODI"][0], hdus["ZODI"][1]).astype("<f4") if "ZODI" in hdus else np.zeros(n, "<f4")
    if wave:
        wl, bw = _wave_maps(wave, H, nx, ny)
    else:
        wl = bw = np.full(n, np.nan, "<f4")
    meta = json.dumps({"nx": nx, "ny": ny, "hdr": hdr, "flagNames": flag_names}).encode()
    pad = (4 - (8 + len(meta)) % 4) % 4
    head = b"SPX1" + len(meta).to_bytes(4, "little") + meta + b" " * pad
    return head + b"".join(a.tobytes() for a in (image, flags, var, zodi, wl, bw))


def _fetch_cutout(uri, ra, dec, size):
    url = f"{IRSA}/{uri}?center={ra},{dec}d&size={size}"
    last = None
    for attempt in range(3):
        try:
            with _cutout_slots:                       # one of the server-wide IRSA slots
                r = _get(url, timeout=180, tries=4, stream=True)
                try:
                    if not r.ok:
                        raise Upstream(f"cutout HTTP {r.status_code}")
                    buf, off, order, hdus, wave, need_wave = bytearray(), 0, 0, {}, None, True
                    done = False
                    for chunk in r.iter_content(256 * 1024):
                        buf += chunk
                        while off < len(buf):
                            hd = _header(buf, off)
                            if hd is None or hd[2] > len(buf):
                                break
                            h, start, end, nxt = hd
                            name = "PRIMARY" if order == 0 else str(h.get("EXTNAME", f"HDU{order}")).strip()
                            hdus[name] = (h, start)
                            order += 1
                            off = nxt
                            if name == "IMAGE":
                                wkey = _wave_key(h)
                                wave = _wave_table(wkey)
                                need_wave = wave is None
                            elif name == "WCS-WAVE":
                                t = _bintable_row0(buf, h, start)
                                wave = {"X": t["X"].tolist(), "Y": t["Y"].tolist(), "VALUES": t["VALUES"].tolist()}
                                if "IMAGE" in hdus:
                                    wkey = _wave_key(hdus["IMAGE"][0])
                                    _wave_mem[wkey] = wave
                                    if not wkey.endswith("_unknown"):
                                        config.atomic_write(config.CACHE_DIR / "sxwave" / f"{wkey}.json", json.dumps(wave))
                                need_wave = False
                            if all(k in hdus for k in ("IMAGE", "FLAGS", "VARIANCE", "ZODI")) and not need_wave:
                                done = True
                                break
                        if done:
                            break
                finally:
                    r.close()                         # the rest (PSF) is not needed
            if "IMAGE" not in hdus:
                raise Upstream("no IMAGE extension in cutout")
            return _blob(hdus, buf, wave)
        except Exception as e:  # noqa: BLE001 - retried, then reported
            last = e
            time.sleep(2 + attempt)
    raise Upstream(str(last))


_inflight: dict = {}
_inflight_lock = threading.Lock()


def get_cutout(uri, ra, dec, size):
    key = _key(f"{uri}|{ra:.5f}|{dec:.5f}|{size:.4f}")
    p = config.CACHE_DIR / "cut" / f"sx-{key[:28]}.bin"
    if p.exists():
        return p.read_bytes()
    with _inflight_lock:
        ev = _inflight.get(key)
        mine = ev is None
        if mine:
            ev = _inflight[key] = threading.Event()
    if not mine:
        ev.wait(240)
        if p.exists():
            return p.read_bytes()
    try:
        blob = _fetch_cutout(uri, f"{ra:.5f}", f"{dec:.5f}", f"{size:.4f}")
        config.atomic_write(p, blob)
        return blob
    finally:
        if mine:
            with _inflight_lock:
                _inflight.pop(key, None)
            ev.set()


# ---------------------------------------------------------------- catalogues, SIMBAD, names
def catalog(cat, ra, dec, radius):
    circle = f"1=CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',{ra},{dec},{radius}))"
    f = _num
    if cat == "gaia":
        adql = f"SELECT TOP 4000 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, bp_rp FROM gaia_dr3_source WHERE {circle}"
        mp = lambda r: {"id": "Gaia DR3 " + r["source_id"], "ra": f(r["ra"]), "dec": f(r["dec"]), "pmra": f(r["pmra"]) or 0,  # noqa: E731
                        "pmdec": f(r["pmdec"]) or 0, "plx": f(r["parallax"]) or 0, "mag": f(r["phot_g_mean_mag"]),
                        "color": f(r["bp_rp"]), "epoch": 2016.0, "band": "G"}
    elif cat == "catwise":
        adql = f"SELECT TOP 4000 source_name, ra, dec, pmra, pmdec, w1mpro, w2mpro, meanobsmjd FROM catwise_2020 WHERE {circle}"

        def mp(r):
            w1, w2, mjd = f(r["w1mpro"]), f(r["w2mpro"]), f(r["meanobsmjd"])
            return {"id": "CatWISE " + r["source_name"], "ra": f(r["ra"]), "dec": f(r["dec"]),
                    "pmra": (f(r["pmra"]) or 0) * 1000, "pmdec": (f(r["pmdec"]) or 0) * 1000, "mag": w1,
                    "color": (w1 - w2) if w1 is not None and w2 is not None else None,
                    "epoch": 2000 + ((mjd or 51544.5) - 51544.5) / 365.25, "band": "W1"}
    elif cat == "allwise":
        adql = f"SELECT TOP 4000 designation, ra, dec, w1mpro, w2mpro, w3mpro, w4mpro FROM allwise_p3as_psd WHERE {circle}"

        def mp(r):
            w1, w2 = f(r["w1mpro"]), f(r["w2mpro"])
            return {"id": "AllWISE " + r["designation"], "ra": f(r["ra"]), "dec": f(r["dec"]), "pmra": 0, "pmdec": 0,
                    "mag": w1, "color": (w1 - w2) if w1 is not None and w2 is not None else None, "epoch": 2010.5,
                    "band": "W1", "bands": {"W1": w1, "W2": w2}}
    elif cat == "2mass":
        adql = f"SELECT TOP 4000 designation, ra, dec, j_m, h_m, k_m FROM fp_psc WHERE {circle}"

        def mp(r):
            j, hh, k = f(r["j_m"]), f(r["h_m"]), f(r["k_m"])
            return {"id": "2MASS " + r["designation"], "ra": f(r["ra"]), "dec": f(r["dec"]), "pmra": 0, "pmdec": 0,
                    "mag": k, "color": (j - k) if j is not None and k is not None else None, "epoch": 1999.0,
                    "band": "Ks", "bands": {"J": j, "H": hh, "Ks": k}}
    else:
        raise ValueError("unknown catalog")
    try:
        rows = _tap(adql, 30 * 86400)
    except Exception:
        if cat != "gaia":
            raise
        # IRSA's TAP is down now and then: the same Gaia query at ESA
        esa = adql.replace("FROM gaia_dr3_source", "FROM gaiadr3.gaia_source")

        def run():
            r = _get(GAIA_TAP, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": esa}, timeout=90, tries=2)
            r.raise_for_status()
            return _csv(r.text)
        rows = _cached_json("sxtap", esa, 30 * 86400, run)
    return [mp(r) for r in rows]


def simbad(ra, dec, sr):
    adql = (f"SELECT TOP 2000 main_id, ra, dec, otype FROM basic WHERE CONTAINS(POINT('ICRS',ra,dec), "
            f"CIRCLE('ICRS',{ra},{dec},{sr}))=1 ORDER BY nbref DESC")

    def run():
        last = None
        for host in ("https://simbad.cds.unistra.fr", "https://simbad.cfa.harvard.edu"):
            try:
                r = _get(host + "/simbad/sim-tap/sync", {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
                                                         "QUERY": adql}, timeout=60, tries=2)
                if not r.ok or r.text.lstrip().startswith("<"):
                    raise Upstream(host + " unavailable")
                rows = [{"id": x["main_id"], "ra": _num(x["ra"]), "dec": _num(x["dec"]), "type": x["otype"]}
                        for x in _csv(r.text)]
                return {"count": len(rows), "rows": rows}
            except Exception as e:  # noqa: BLE001
                last = e
        raise Upstream(str(last or "SIMBAD unavailable"))
    return _cached_json("sxsimbad", adql, 30 * 86400, run)


def resolve_name(name):
    def run():
        for base in config.SESAME:
            try:
                r = requests.get(base + "?" + requests.utils.quote(name), headers=UA, timeout=15)
            except requests.RequestException:
                continue
            if not r.ok:
                continue
            xml = r.text

            def g(tag, s=xml):
                m = re.search(rf"<{tag}>([\s\S]*?)</{tag}>", s)
                return m.group(1).strip() if m else None
            ra, dec = g("jradeg"), g("jdedeg")
            if not ra or not dec:
                return None
            plx = g("plx")
            vb = re.search(r'<mag band="V">([\s\S]*?)</mag>', xml)
            return {"name": re.sub(r"^(NAME|\*|V\*)\s+", "", g("oname") or name), "query": name, "type": g("otype") or "",
                    "ra": float(ra), "dec": float(dec), "pmra": _num(g("pmRA")) or 0, "pmdec": _num(g("pmDE")) or 0,
                    "plx": (_num(g("v", plx)) or 0) if plx else 0,
                    "vmag": _num(g("v", vb.group(1))) if vb else None, "epoch": 2000.0}
        raise Upstream("Sesame unavailable")
    return _cached_json("sxname", name.lower(), 90 * 86400, run)


_props: dict = {}


def hips_properties():
    if not _props:
        r = _get(HIPS_ROOT + "/properties", timeout=30, tries=3)
        r.raise_for_status()
        for line in r.text.splitlines():
            m = re.match(r"^([\w.]+)\s*=\s*(.*)$", line)
            if m:
                _props[m.group(1)] = m.group(2).strip()
    return _props


# ---------------------------------------------------------------- routes
def _r6(v):
    return float(f"{v:.6f}")


@router.get("/status")
def status():
    return {"ok": True, "version": "radians"}


@router.get("/images")
def images(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)):
    try:
        res = find_images(_r6(ra), _r6(dec))
    except Exception as e:  # noqa: BLE001
        return _err(f"IRSA: {e}", 503)
    return {"ra": ra, "dec": dec, "count": len(res["items"]), **res}


@router.get("/cutout")
def cutout(uri: str = Query(..., max_length=300), ra: float = Query(..., ge=0, lt=360),
           dec: float = Query(..., ge=-90, le=90), size: float = Query(0.1)):
    if not URI_RE.match(uri) or ".." in uri:
        return _err("invalid SPHEREx uri", 400)
    size = min(max(size, 0.005), 1.5)
    try:
        blob = get_cutout(uri, ra, dec, size)
    except Exception as e:  # noqa: BLE001
        return _err(f"cutout: {e}")
    return Response(blob, media_type="application/octet-stream", headers={"Cache-Control": "max-age=31536000"})


@router.get("/catalog")
def catalog_route(cat: str, ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                  radius: float = Query(0.05)):
    rad = round(min(max(radius, 0.001), 0.5), 4)
    try:
        rows = catalog(cat, _r6(ra), _r6(dec), rad)
    except ValueError as e:
        return _err(str(e), 400)
    except Exception as e:  # noqa: BLE001
        return _err(f"{cat}: {e}")
    return {"cat": cat, "count": len(rows), "rows": rows}


@router.get("/simbad")
def simbad_route(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90), sr: float = Query(0.1)):
    try:
        return simbad(_r6(ra), _r6(dec), round(min(max(sr, 0.001), 1), 4))
    except Exception as e:  # noqa: BLE001
        return _err(f"SIMBAD: {e}")


@router.get("/resolve")
def resolve_route(name: str = Query(..., min_length=1, max_length=120)):
    try:
        r = resolve_name(name.strip())
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    return r if r else _err("not found: " + name, 404)


@router.get("/hips-properties")
def hips_props_route():
    try:
        return hips_properties()
    except Exception as e:  # noqa: BLE001
        return _err(str(e))


# ---------------------------------------------------------------- colour SPHEREx sky as a HiPS
# Each colour is the average of four wavelength frames of the DR1 cube (B = D1+D2, G = D3+D4, R = D5+D6,
# skipping the blank dichroic frames 50/51), which colours the sky and beats down the noise. Background,
# gain, saturation and gamma as tuned by Emre Bozkaya on DR1 tiles. Served as an ordinary colour HiPS so
# the all-sky map (Aladin Lite) can show it like any other survey.
COLOR_FRAMES = {"r": [72, 78, 89, 97], "g": [38, 46, 55, 63], "b": [4, 12, 21, 29]}
COLOR_BAL = {"r": (4, 1.35), "g": (4, 1.1), "b": (4, 1.0)}
COLOR_SAT, COLOR_GAMMA, COLOR_VERSION = 1.45, 1.6, "v3"
_tile_pool = ThreadPoolExecutor(16)
_color_slots = threading.BoundedSemaphore(6)
hips_router = APIRouter(prefix="/hips/spherex-color")


def _cube_tile(frame, order, npix):
    from PIL import Image
    d = npix // 10000 * 10000
    url = f"{HIPS_ROOT}/Norder{order}/Dir{d}/Npix{npix}{'_' + str(frame) if frame else ''}.png"
    try:
        with irsa.SLOTS:
            r = _get(url, timeout=40, tries=3)
    except Upstream:
        return None
    if r.status_code != 200:
        return None
    im = Image.open(io.BytesIO(r.content)).convert("L")
    return np.asarray(im, dtype=np.float32)


def color_tile(order, npix):
    p = config.CACHE_DIR / "sxcolor" / f"{COLOR_VERSION}_{order}_{npix}.png"
    if p.exists():
        return p.read_bytes()
    from PIL import Image
    with _color_slots:
        if p.exists():
            return p.read_bytes()
        jobs = {c: [_tile_pool.submit(_cube_tile, f, order, npix) for f in fr] for c, fr in COLOR_FRAMES.items()}
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
        rgb = np.clip((L + (lin - L) * COLOR_SAT) * k * 255, 0, 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=False, compress_level=6)
        out = buf.getvalue()
        config.atomic_write(p, out)
        return out


# "Mix your own": any three of the 102 planes as red, green and blue, each stretched on its own
mix_router = APIRouter(prefix="/hips/spherex-mix")


def mix_tile(order, npix, r, g, b):
    p = config.CACHE_DIR / "sxmix" / "rgb" / f"{r}-{g}-{b}_{order}_{npix}.png"
    if p.exists():
        return p.read_bytes()
    from PIL import Image
    with _color_slots:
        if p.exists():
            return p.read_bytes()
        tiles = list(_tile_pool.map(lambda f: _cube_tile(f, order, npix), (r, g, b)))
        any_t = next((t for t in tiles if t is not None), None)
        if any_t is None:
            return None
        rgb = np.zeros(any_t.shape + (3,), np.float32)
        for ci, t in enumerate(tiles):
            if t is not None:          # each plane's own sky level off (zodiacal light differs a lot per band)
                lit = t[t > 0]
                bk = float(np.percentile(lit, 25)) if lit.size > 100 else 4.0
                rgb[..., ci] = np.maximum(0, t - bk) / max(40.0, 255 - bk)
        rgb = np.clip(np.power(rgb, 1 / 1.15) * 255, 0, 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=False, compress_level=6)
        out = buf.getvalue()
        config.atomic_write(p, out)
        return out


def _mix_ok(mix):
    m = re.fullmatch(r"(\d{1,3})-(\d{1,3})-(\d{1,3})", mix)
    if not m:
        return None
    t = tuple(int(x) for x in m.groups())
    return t if all(0 <= x < 102 for x in t) else None


@mix_router.get("/{mix}/properties")
def mix_properties(mix: str):
    if not _mix_ok(mix):
        return Response(status_code=404)
    txt = "\n".join([
        f"creator_did = ivo://radians/P/SPHEREx/DR1/mix/{mix}", f"obs_title = SPHEREx DR1 planes {mix} as R-G-B",
        "dataproduct_type = image", "dataproduct_subtype = color", "hips_version = 1.4", "hips_frame = equatorial",
        "hips_order = 5", "hips_order_min = 0", "hips_tile_width = 512", "hips_tile_format = png", "hips_initial_fov = 60",
        "obs_copyright = NASA/JPL-Caltech/IPAC SPHEREx", ""])
    return Response(txt, media_type="text/plain", headers={"Cache-Control": "max-age=86400"})


@mix_router.get("/{mix}/Norder{order}/Dir{d}/Npix{npix}.png")
def mix_tile_route(mix: str, order: int, d: int, npix: int):
    t = _mix_ok(mix)
    if not t or not 0 <= order <= 5 or not 0 <= npix < 12 * 4 ** order:
        return Response(status_code=404)
    try:
        png = mix_tile(order, npix, *t)
    except Exception as e:  # noqa: BLE001
        return _err(f"tile: {e}")
    if png is None:
        return Response(status_code=404)
    return Response(png, media_type="image/png", headers={"Cache-Control": "max-age=604800"})


@hips_router.get("/properties")
def color_properties():
    txt = "\n".join([
        "creator_did = ivo://radians/P/SPHEREx/DR1/color", "obs_title = SPHEREx DR1 infrared colour (B 0.75-1.6, G 1.6-3.8, R 3.8-5 um)",
        "dataproduct_type = image", "dataproduct_subtype = color", "hips_version = 1.4", "hips_frame = equatorial",
        "hips_order = 5", "hips_order_min = 0", "hips_tile_width = 512", "hips_tile_format = png", "hips_initial_fov = 60",
        "obs_copyright = NASA/JPL-Caltech/IPAC SPHEREx; colour composite after Emre Bozkaya", ""])
    return Response(txt, media_type="text/plain", headers={"Cache-Control": "max-age=86400"})


@hips_router.get("/Norder{order}/Dir{d}/Npix{npix}.png")
def color_tile_route(order: int, d: int, npix: int):
    if not 0 <= order <= 5 or not 0 <= npix < 12 * 4 ** order:
        return Response(status_code=404)
    try:
        png = color_tile(order, npix)
    except Exception as e:  # noqa: BLE001
        return _err(f"tile: {e}")
    if png is None:
        return Response(status_code=404)
    return Response(png, media_type="image/png", headers={"Cache-Control": "max-age=604800"})
