"""Catalogue cross-match (SIMBAD + CatWISE2020): parsing and "one catalogue down" behaviour, no network."""
from fastapi.testclient import TestClient

from app import config, crossmatch, net
from app.main import app


class Reply:
    def __init__(self, text, ok=True):
        self.text, self.ok = text, ok


SIMBAD_CSV = ('main_id,otype,ra,dec,pmra,pmdec\n'
              '"OGLE BLG-LPV-256626","LP*",270.1,-28.2,,\n'
              '"NAME Barnard\'s star","PM*",269.452,4.693,-801.551,10362.394\n'
              '"Some planet b","Pl",269.452,4.693,,\n')
CATWISE_CSV = ('source_name,ra,dec,pmra,pmdec,w1mpro,meanobsmjd\n'
               'J180000.00-281200.0,270.1,-28.2,0.01,-0.02,9.5,57170\n')


def fake_get(simbad=SIMBAD_CSV, catwise=CATWISE_CSV):
    def get(url, params=None, **kw):
        text = simbad if "simbad" in url else catwise
        if text is None:
            raise net.Upstream("down")
        return Reply(text)
    return get


def test_parses_both_catalogues(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(net, "get", fake_get())
    out = crossmatch.crossmatch(270.1, -28.2, 0.06)
    assert out["simbad"]["ok"] and out["catwise"]["ok"]
    ids = [r["id"] for r in out["simbad"]["rows"]]
    assert ids == ["OGLE BLG-LPV-256626", "NAME Barnard's star"]          # the planet is dropped
    barnard = out["simbad"]["rows"][1]
    assert barnard["pmdec"] > 10000 and barnard["epoch"] == 2000.0
    cw = out["catwise"]["rows"][0]
    assert cw["id"] == "CatWISE2020 J180000.00-281200.0"
    assert cw["pmra"] == 10 and cw["pmdec"] == -20                         # arcsec/yr -> mas/yr
    assert abs(cw["epoch"] - 2015.4) < 0.01


def test_one_catalogue_down_is_reported_not_raised(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(net, "get", fake_get(catwise=None))
    r = TestClient(app).get("/api/crossmatch", params={"ra": 270.1, "dec": -28.2})
    assert r.status_code == 200
    out = r.json()
    assert out["simbad"]["ok"] and len(out["simbad"]["rows"]) == 2
    assert out["catwise"] == {"ok": False, "rows": [], "error": "down"}
    # asked for one catalogue only: the other is not queried
    only = TestClient(app).get("/api/crossmatch", params={"ra": 270.1, "dec": -28.2, "cat": "simbad"}).json()
    assert list(only) == ["simbad"] and only["simbad"]["ok"]
    assert TestClient(app).get("/api/crossmatch", params={"ra": 1, "dec": 1, "cat": "nope"}).status_code == 422


def test_error_page_is_not_taken_for_an_empty_catalogue(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(net, "get", fake_get(simbad="<html>busy</html>", catwise="<VOTABLE>error</VOTABLE>"))
    out = crossmatch.crossmatch(10.0, 10.0, 0.06)
    assert not out["simbad"]["ok"] and not out["catwise"]["ok"]


def test_failures_are_not_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(net, "get", fake_get(simbad=None))
    assert not crossmatch.crossmatch(270.1, -28.2, 0.06)["simbad"]["ok"]
    monkeypatch.setattr(net, "get", fake_get())
    assert crossmatch.crossmatch(270.1, -28.2, 0.06)["simbad"]["ok"]
