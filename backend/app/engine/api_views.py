"""The engine's view manager (one per server) and the one view address the page asks for by name:
the light curve of a spot in the fast band. Everything else of a view reaches the page through
app/quick.py, in the viewer's own frame format."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from . import api_find
from .views import ViewManager

router = APIRouter(prefix="/api")
_manager: ViewManager | None = None


def manager() -> ViewManager:
    global _manager
    if _manager is None:
        _manager = ViewManager(http=api_find.HTTP, seed_layouts=Path(__file__).parent / "data" / "layouts.json")
    return _manager


def _guard(fn, *args):
    try:
        return fn(*args)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404, "That view does not exist (yet).") from None


@router.get("/views/{vid}/lightcurve")
def lightcurve(vid: str, x: float | None = None, y: float | None = None):
    return _guard(manager().lightcurve, vid, x, y)
