"""The fast engine as a stand-alone FastAPI app (used by its own tests).

In the site itself the same routers are included by app.main; see `routers` below.
"""
from __future__ import annotations

from fastapi import FastAPI

from . import __version__, api_find, api_views, hips

# Order matters in app.main: it includes these after its own routes, so its /api/resolve and
# /api/coverage (which the pages depend on) win over the two of the same name in api_find.
routers = (hips.router, api_views.router, api_find.router)


def create_app() -> FastAPI:
    app = FastAPI(title="Radians engine", version=__version__)

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__, "releases": ["spherex_dr1", "spherex_qr3"]}

    for r in routers:
        app.include_router(r)
    return app


app = create_app()
