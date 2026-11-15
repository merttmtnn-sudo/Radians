"""Time-lapse view endpoints (see docs/API.md)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import api_find, sky
from .views import ViewManager, demo_spec, make_spec

router = APIRouter(prefix="/api")
_manager: ViewManager | None = None
PICTURE_CACHE = {"Cache-Control": "public, max-age=300"}


def manager() -> ViewManager:
    global _manager
    if _manager is None:
        _manager = ViewManager(http=api_find.HTTP)
    return _manager


class ViewRequest(BaseModel):
    ra: float | None = Field(None, ge=0, lt=360)
    dec: float | None = Field(None, ge=-90, le=90)
    pin: str | None = Field(None, max_length=40)       # one of the curated objects
    name: str | None = Field(None, max_length=100)     # any object name (looked up)
    band: int | None = Field(None, ge=1, le=6)
    size_arcmin: float = Field(4.0, ge=1, le=10)


def _target(req: ViewRequest) -> dict | None:
    if req.pin:
        for p in api_find.pins():
            if p["id"] == req.pin:
                return dict(p, name=p["name_en"])
        raise HTTPException(404, f"No curated object with id “{req.pin}”.")
    if req.name:
        try:
            r = sky.resolve(req.name, api_find.HTTP)
        except LookupError:
            raise HTTPException(404, f"No object called “{req.name}” is known.") from None
        except sky.ResolverDown:
            raise HTTPException(503, "The name lookup service can't be reached right now.") from None
        return dict(r, name=r.get("main_id") or req.name)
    return None


def _guard(fn, *args, media: str | None = None):
    try:
        out = fn(*args)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404, "That view or picture does not exist (yet).") from None
    return Response(out, media_type=media, headers=PICTURE_CACHE) if media else out


@router.post("/views")
def create_view(req: ViewRequest):
    band = req.band or 5
    if req.pin and req.ra is None:
        spec = demo_spec(req.pin, band, req.size_arcmin)
        if spec:
            return manager().submit(spec)
    target = _target(req)
    if target:
        # a moving object is centred where it is today, unless the caller asked for a spot
        ra, dec = (req.ra, req.dec) if req.ra is not None and req.dec is not None else sky.position_now(target)
        moving = abs(target.get("pmra", 0)) + abs(target.get("pmdec", 0)) > 20
        target = target if moving else None
    elif req.ra is None or req.dec is None:
        raise HTTPException(422, "Give a position (ra, dec), a pin or a name.")
    else:
        ra, dec = req.ra, req.dec
    return manager().submit(make_spec(ra, dec, band, req.size_arcmin, target))


@router.get("/views/{vid}")
def get_view(vid: str, wait: float = Query(0.0, ge=0, le=25)):
    return _guard(manager().status, vid, wait)


@router.get("/views/{vid}/frame/{p}.png")
def frame(vid: str, p: int, stretch: str = "auto"):
    return _guard(manager().frame_png, vid, p, stretch, media="image/png")


@router.get("/views/{vid}/diff/{a}/{b}.png")
def diff_png(vid: str, a: int, b: int):
    return _guard(manager().diff_png, vid, a, b, media="image/png")


@router.get("/views/{vid}/diff/{a}/{b}")
def diff_info(vid: str, a: int, b: int):
    return _guard(lambda: manager().diff(vid, a, b)[1])


@router.get("/views/{vid}/timecolor.png")
def timecolor(vid: str, stretch: str = "auto"):
    return _guard(manager().timecolor_png, vid, stretch, media="image/png")


@router.get("/views/{vid}/blink.gif")
def blink(vid: str, stretch: str = "auto"):
    return _guard(manager().blink_gif, vid, stretch, media="image/gif")


@router.get("/views/{vid}/catalog")
def catalog(vid: str, p: int = Query(0, ge=0)):
    try:
        return _guard(manager().catalog, vid, p)
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001  (the catalogue service is optional)
        raise HTTPException(503, "The star catalogue can't be reached right now.") from None


@router.get("/views/{vid}/lightcurve")
def lightcurve(vid: str, x: float | None = None, y: float | None = None):
    return _guard(manager().lightcurve, vid, x, y)


@router.get("/views/{vid}/spectrum")
def spectrum(vid: str, x: float | None = None, y: float | None = None, wait: float = Query(0.0, ge=0, le=25)):
    return _guard(manager().spectrum, vid, x, y, wait)


@router.get("/views/{vid}/changes")
def what_changed(vid: str, a: int | None = Query(None, ge=0), b: int | None = Query(None, ge=0)):
    return _guard(manager().changes, vid, a, b)


@router.get("/views/{vid}/classify")
def classify(vid: str, x: float | None = None, y: float | None = None, wait: float = Query(0.0, ge=0, le=25)):
    return _guard(manager().classify, vid, x, y, wait)


@router.get("/views/{vid}/flags/{p}.png")
def flags(vid: str, p: int):
    return _guard(manager().flags_png, vid, p, media="image/png")


@router.get("/views/{vid}/stack/{p}.fits")
def stack(vid: str, p: int):
    return _guard(manager().stack_fits, vid, p, media="application/fits")


@router.get("/views/{vid}/period")
def period(vid: str, x: float | None = None, y: float | None = None):
    return _guard(manager().period, vid, x, y)


@router.get("/views/{vid}/motion")
def motion(vid: str, x: float | None = None, y: float | None = None):
    return _guard(manager().motion, vid, x, y)


@router.get("/views/{vid}/hr")
def hr(vid: str, x: float | None = None, y: float | None = None):
    return _guard(manager().hr, vid, x, y)


@router.get("/views/{vid}/star")
def star(vid: str, x: float | None = None, y: float | None = None):
    return _guard(manager().star, vid, x, y)
