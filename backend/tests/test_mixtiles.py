"""Colour mixes of the all-sky cube (/hips/spherex-mix): the layer spec, the blend, the routes. No network."""
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config, explorer, mixtiles
from app.main import app

BLUE, GREEN, RED = "f21c0000ffg100", "f46c00ff00g100", "f72cff0000g100"


def test_spec_is_parsed_and_checked():
    layers = mixtiles.parse_spec(f"{BLUE}_{GREEN}_{RED}")
    assert [layer["frame"] for layer in layers] == [21, 46, 72]
    assert layers[0]["rgb"] == (0.0, 0.0, 1.0) and layers[2]["rgb"] == (1.0, 0.0, 0.0)
    assert mixtiles.parse_spec("f0cffffffg250")[0]["gain"] == 2.5
    for bad in ("", "f50cff0000g100",                       # a blank plane of the cube
                "f102cff0000g100", "f21cff00g100", "f21cff0000g1", "f21cff0000g999",
                f"{BLUE}_{GREEN}_{RED}_{BLUE}", "../../etc/passwd", "f21cFF0000g100"):
        with pytest.raises(ValueError):
            mixtiles.parse_spec(bad)


def test_blend_is_screen_of_tinted_layers():
    layers = mixtiles.parse_spec(f"{BLUE}_{GREEN}_{RED}")
    full = np.full((2, 2), 254.0, np.float32)
    none = np.zeros((2, 2), np.float32)
    assert (mixtiles.mix([full, full, full], layers) == 255).all()            # equal light in every layer: white
    assert (mixtiles.mix([none, none, none], layers) == 0).all()
    only_red = mixtiles.mix([none, none, full], layers)
    assert (only_red[..., 0] == 255).all() and (only_red[..., 1:] == 0).all()
    assert mixtiles.mix([None, None, None], layers) is None
    missing = mixtiles.mix([None, full, None], layers)                         # a plane IRSA has no tile for is skipped
    assert (missing[..., 1] == 255).all() and (missing[..., 0] == 0).all()
    # faint levels are toned down (gamma), bright ones saturate towards the tint and keep its hue
    orange = mixtiles.parse_spec("f60cff9f43g300")
    faint, bright = mixtiles.mix([np.full((1, 1), 25.4, np.float32)], [dict(orange[0], gain=1.0)]), \
        mixtiles.mix([np.full((1, 1), 200.0, np.float32)], orange)
    assert faint[0, 0, 0] < 0.1 * 255                                          # 10% in -> about 5% out
    assert tuple(bright[0, 0]) == (255, 159, 67)
    # two layers never overflow
    both = mixtiles.mix([full, full], mixtiles.parse_spec("f21c0080ffg100_f72cff8000g100"))
    assert both.max() == 255 and both.dtype == np.uint8


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    calls = []

    def fake_tile(frame, order, npix):
        calls.append((frame, order, npix))
        if frame == 46:
            return None                                                         # IRSA has no tile here
        return np.full((4, 4), 254.0 if frame == 72 else 0.0, np.float32)

    monkeypatch.setattr(explorer, "_cube_tile", fake_tile)
    c = TestClient(app)
    c.calls = calls
    return c


def test_routes_serve_a_colour_hips(client):
    spec = f"{BLUE}_{GREEN}_{RED}"
    props = client.get(f"/hips/spherex-mix/{spec}/properties")
    assert props.status_code == 200 and "hips_tile_format = png" in props.text and "planes 21, 46, 72" in props.text
    r = client.get(f"/hips/spherex-mix/{spec}/Norder0/Dir0/Npix3.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    img = np.asarray(Image.open(io.BytesIO(r.content)))
    assert img.shape == (4, 4, 3) and (img[..., 0] == 255).all() and (img[..., 1:] == 0).all()
    assert sorted(client.calls) == [(21, 0, 3), (46, 0, 3), (72, 0, 3)]
    client.get(f"/hips/spherex-mix/{spec}/Norder0/Dir0/Npix3.png")              # second time: from the disk cache
    assert len(client.calls) == 3
    assert client.get(f"/hips/spherex-mix/{spec}/Norder9/Dir0/Npix3.png").status_code == 404
    assert client.get("/hips/spherex-mix/f50cff0000g100/Norder0/Dir0/Npix3.png").status_code == 404
    assert client.get("/hips/spherex-mix/nonsense/properties").status_code == 404


def test_three_planes_as_red_green_blue_at_the_same_address(client):
    """The team's "R-G-B" spec (three plane numbers) is answered by explorer.py's recipe, the tinted
    layers by this module: one address, two spec forms."""
    props = client.get("/hips/spherex-mix/72-46-21/properties")
    assert props.status_code == 200 and "planes 72-46-21 as R-G-B" in props.text
    r = client.get("/hips/spherex-mix/72-46-21/Norder0/Dir0/Npix3.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    img = np.asarray(Image.open(io.BytesIO(r.content)))
    assert img.shape == (4, 4, 3)
    assert sorted(client.calls) == [(21, 0, 3), (46, 0, 3), (72, 0, 3)]
    assert client.get("/hips/spherex-mix/72-46-200/properties").status_code == 404      # no such plane
    assert client.get("/hips/spherex-mix/72-46/properties").status_code == 404
