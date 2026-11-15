from fastapi.testclient import TestClient

from app.engine import hips
from app.engine.main import create_app

PROPS = """creator_did          = ivo://IPAC/P/SPHEREx/DR1/cube
obs_title            = SPHEREx DR1 all-sky data cube
dataproduct_type     = cube
hips_order           = 5
hips_cube_depth      = 102
hips_cube_firstframe = 1
data_cube_crval3_arr = 0.753 0.771 0.790
hips_tile_format     = png
"""


def test_slice_properties_drop_cube_keywords():
    out = hips.slice_properties(PROPS, 2)
    assert "hips_cube" not in out and "data_cube" not in out
    assert "cube/slice2" in out and "0.790 um" in out
    assert "dataproduct_type     = image" in out
    assert "hips_order           = 5" in out


def test_tile_redirects_to_frame(monkeypatch):
    c = TestClient(create_app())
    r = c.get("/hips/spherex/40/Norder5/Dir0/Npix5700.png", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"].endswith("/Norder5/Dir0/Npix5700_40.png")
    r = c.get("/hips/spherex/0/Norder3/Allsky.png", follow_redirects=False)
    assert r.headers["location"].endswith("/Norder3/Allsky.png")
    assert c.get("/hips/spherex/102/Norder3/Allsky.png", follow_redirects=False).status_code == 404
    assert c.get("/hips/spherex/1/../../etc", follow_redirects=False).status_code == 404
