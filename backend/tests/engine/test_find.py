from fastapi.testclient import TestClient

from app.engine import api_find, sky
from app.engine.main import create_app

client = TestClient(create_app())


def test_pins_have_both_languages_and_today_positions():
    pins = client.get("/api/pins").json()
    assert len(pins) >= 25
    barnard = next(p for p in pins if p["id"] == "barnard")
    assert barnard["blurb_tr"] and barnard["name_tr"] == "Barnard Yıldızı"
    # Barnard's Star has moved ~4.6' north since 2000
    assert 4.0 < (barnard["dec_now"] - barnard["dec"]) * 60 < 5.5


def test_search_matches_names_aliases_and_turkish():
    def ids(q):
        return [p["id"] for p in client.get("/api/search", params={"q": q}).json()]
    assert ids("barn")[0] == "barnard"
    assert ids("Barnard's")[0] == "barnard"
    assert "m42" in ids("orion")
    assert ids("ulker")[0] == "m45"                  # Turkish name typed without the dots
    assert ids("Ülker")[0] == "m45"
    assert ids("zzzz") == []


def test_resolve_prefers_pins():
    r = client.get("/api/resolve", params={"name": "wise 0855"}).json()
    assert r["source"] == "pins" and r["id"] == "wise-0855"


def test_fold():
    assert api_find.fold("Kutup Yıldızı") == "kutup yildizi"
    assert api_find.fold("  Barnard's   Star ") == "barnard s star"


def test_parse_sesame_and_motion():
    xml = ("<Sesame><Target><Resolver><oname>NAME Barnard's star</oname><otype>BY*</otype>"
           "<jradeg>269.452</jradeg><jdedeg>4.693</jdedeg><pmRA>-801.6</pmRA><pmDE>10362.4</pmDE>"
           "<plx><v>546.97</v></plx></Resolver></Target></Sesame>")
    r = sky.parse_sesame(xml)
    assert r["pmdec"] == 10362.4 and r["plx"] == 546.97
    ra, dec = sky.position_at(r, 51544.5 + 365.25 * 26, parallax=False)     # 26 years later
    assert abs((dec - r["dec"]) * 3600 - 10.3624 * 26) < 0.01
    assert sky.parse_sesame("<Sesame><INFO>nothing</INFO></Sesame>") is None
