"""The engine's routers, included by app.main after its own routes."""
from __future__ import annotations

from . import api_find, api_views

routers = (api_views.router, api_find.router)
