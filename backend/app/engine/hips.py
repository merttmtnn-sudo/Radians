"""Each slice of the SPHEREx DR1 HiPS cube, presented as its own plain (2-D) HiPS.

Aladin Lite 3.6.5 keeps one slice per cube, so it cannot blend several wavelengths of the same
cube at once. Here every slice gets its own URL and identity (/hips/spherex/<frame>/...): the
properties file is rewritten (no cube keywords, a per-slice creator_did) and every tile request is
redirected to IRSA's file for that frame. The tiles themselves never pass through this server.
"""
from __future__ import annotations

import re
import time

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse, RedirectResponse

CUBE_URL = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
DEPTH = 102
_TTL = 6 * 3600
_props: dict = {"text": None, "at": 0.0}

router = APIRouter()


def cube_properties() -> str:
    """The cube's properties file, fetched from IRSA and kept for a few hours."""
    if _props["text"] is None or time.time() - _props["at"] > _TTL:
        r = requests.get(f"{CUBE_URL}/properties", timeout=20)
        r.raise_for_status()
        _props.update(text=r.text, at=time.time())
    return _props["text"]


def wavelengths_um(props: str) -> list[float]:
    m = re.search(r"^data_cube_crval3_arr\s*=\s*(.+)$", props, re.M)
    return [float(v) for v in m.group(1).split()] if m else []


def slice_properties(props: str, frame: int) -> str:
    """Rewrite the cube's properties so that one frame reads as an ordinary HiPS."""
    waves = wavelengths_um(props)
    lam = f" {waves[frame]:.3f} um" if frame < len(waves) else ""
    out = []
    for line in props.splitlines():
        key = line.split("=", 1)[0].strip()
        if key.startswith(("hips_cube", "data_cube")) or key in ("dataproduct_type", "creator_did", "obs_title"):
            continue
        out.append(line)
    out += [f"creator_did          = ivo://IPAC/P/SPHEREx/DR1/cube/slice{frame}",
            f"obs_title            = SPHEREx DR1 slice {frame}{lam}",
            "dataproduct_type     = image"]
    return "\n".join(out) + "\n"


def _check(frame: int):
    if not 0 <= frame < DEPTH:
        raise HTTPException(404, f"the cube has frames 0-{DEPTH - 1}")


@router.get("/hips/spherex/{frame}/properties", response_class=PlainTextResponse)
def properties(frame: int):
    _check(frame)
    try:
        return PlainTextResponse(slice_properties(cube_properties(), frame),
                                 headers={"Cache-Control": "public, max-age=3600"})
    except requests.RequestException as e:
        raise HTTPException(502, f"could not reach IRSA: {e}") from None


@router.get("/hips/spherex/{frame}/{path:path}")
def tile(frame: int, path: str):
    _check(frame)
    if not re.fullmatch(r"(Norder\d+/(Dir\d+/Npix\d+|Allsky)|Moc)\.(png|fits)", path):
        raise HTTPException(404, "not a HiPS tile")
    if frame and not path.startswith("Moc"):
        path = re.sub(r"\.(png|fits)$", rf"_{frame}.\1", path)
    return RedirectResponse(f"{CUBE_URL}/{path}", status_code=302,
                            headers={"Cache-Control": "public, max-age=86400"})


@router.get("/api/channels")
def channels():
    """The 102 channels of the cube: frame index, detector band, channel and wavelength (µm).
    Frame = 17 x (band - 1) + (channel - 1); a few frames are blank in DR1."""
    try:
        waves = wavelengths_um(cube_properties())
    except requests.RequestException as e:
        raise HTTPException(502, f"could not reach IRSA: {e}") from None
    return [dict(frame=i, band=i // 17 + 1, channel=i % 17 + 1, wave_um=w) for i, w in enumerate(waves)]
