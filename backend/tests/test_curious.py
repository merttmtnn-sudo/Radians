"""For-the-curious tools: speed, H-R points, period search, cross-match. No network."""
import numpy as np
from fastapi.testclient import TestClient

from app import config, curious, net, pulse
from app.main import app


class Reply:
    def __init__(self, text, ok=True):
        self.text, self.ok = text, ok


BARNARD = {"source_id": "4472832130942575872", "parallax": "546.9759", "parallax_over_error": "13000",
           "phot_g_mean_mag": "8.195", "bp_rp": "2.834", "pmra": "-801.551", "pmdec": "10362.394"}


def test_compass_and_speed():
    assert curious.compass(354) == "north" and curious.compass(135) == "south_east" and curious.compass(-90) == "west"
    assert abs(curious.tangential_speed(10.39, 546.98) - 90.0) < 0.5        # Barnard's Star: about 90 km/s
    assert curious.tangential_speed(1.0, None) is None and curious.tangential_speed(1.0, -2) is None


def test_star_summary():
    s = curious.star_summary(BARNARD)
    assert abs(s["rate"] - 10.393) < 0.01 and s["direction"] == "north"
    assert abs(s["abs_g"] - 11.88) < 0.02 and abs(s["speed_kms"] - 90.1) < 0.5
    far = curious.star_summary({**BARNARD, "parallax": "0.2", "parallax_over_error": "1.1"})
    assert far["abs_g"] is None and far["speed_kms"] is None and not far["parallax_ok"]


def lightcurve(period=None, n=400, amp=0.3, seed=2, span=420):
    """Exposures at random wavelengths of a star whose spectrum falls steeply with wavelength."""
    rng = np.random.default_rng(seed)
    t = 60900 + np.sort(rng.uniform(0, span, n))
    w = np.exp(rng.uniform(np.log(0.76), np.log(4.98), n))
    wave = 1 + (amp * np.sin(2 * np.pi * t / period) if period else 0)
    v = 1e5 * w ** -2 * wave * (1 + 0.02 * rng.standard_normal(n))
    return [{"mjd": float(a), "wavelength": float(b), "value": float(c)} for a, b, c in zip(t, w, v)]


def test_relative_brightness_removes_the_spectrum():
    t, y = curious.relative_brightness(lightcurve())
    assert t.size > 300 and abs(np.median(y) - 1) < 0.01 and np.std(y) < 0.2   # raw fluxes span a factor of 40


def test_period_is_found_and_noise_is_not_convincing(monkeypatch):
    monkeypatch.setattr(pulse, "N_SCRAMBLES", 120)
    r = curious.period_search(lightcurve(period=120))
    assert r["ok"] and abs(r["period_d"] - 120) < 3 * max(r["err_d"], 2) and r["convincing"]
    assert len(r["folded"]) == r["n"] and len(r["periodogram"]) <= 400
    flat = curious.period_search(lightcurve())
    assert flat["ok"] and not flat["convincing"]
    for too_little in (lightcurve(n=20), lightcurve(span=30), []):
        got = curious.period_search(too_little)
        assert got["ok"] is False and got["reason"] == "too_few"


VSX = ("#\n#   VizieR\n\nName\tRAJ2000\tDEJ2000\tType\tPeriod\tmax\tmin\n \tdeg\tdeg\t \td\tmag\tmag\n"
       "-----\t-----\t-----\t---\t---\t---\t---\n"
       "R Dra                         \t248.16762\t 66.75497\tM                             \t   246.120000000000\t  6.700\t 13.200\n")
NO_ROWS = "#\n#   VizieR\n\n"


def test_known_variable_stars(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(net, "get", lambda *a, **kw: Reply(VSX))
    v = curious.vsx_star(248.1675, 66.7550)
    assert v == {"found": True, "name": "R Dra", "type": "M", "period_d": 246.12, "max": 6.7, "min": 13.2, "sep_arcsec": v["sep_arcsec"]}
    assert v["sep_arcsec"] < 1
    monkeypatch.setattr(net, "get", lambda *a, **kw: Reply(NO_ROWS))
    assert curious.vsx_star(10.0, 5.0) == {"found": False}
    head = "#\n#   VizieR\n\n"

    def gaia(flag, cls):
        def get(url, params, **kw):
            if params["-source"] == curious.GAIA_MAIN:
                return Reply(head + f"Source\tVarFlag\n \t \n-----\t-----\n{params['Source']}\t{flag}\n")
            return Reply(head + (f"Source\tClass\tClassSc\n \t \t \n-----\t-----\t-----\n{params['Source']}\t{cls}\t 9.5734750e-01\n" if cls else ""))
        return get
    monkeypatch.setattr(net, "get", gaia("VARIABLE     ", "LPV                       "))
    assert curious.gaia_variable("Gaia DR3 1648328016354496384") == {"found": True, "variable": True, "class": "LPV", "score": 0.96}
    monkeypatch.setattr(net, "get", gaia("NOT_AVAILABLE", None))
    assert curious.gaia_variable("4472832130942575872") == {"found": True, "variable": False, "class": None, "score": None}
    monkeypatch.setattr(net, "get", lambda *a, **kw: Reply(head))
    assert curious.gaia_variable("123456789") == {"found": False}
    assert curious.gaia_variable("not a number") == {"found": False}


def test_star_facts_and_planets(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    head = "#\n#   VizieR\n\n"
    main = ("Source\tPlx\te_Plx\tpmRA\tpmDE\tRV\te_RV\tRUWE\tTeff\tlogg\tDist\tNSS\tDup\n \tmas\tmas\tmas/yr\tmas/yr\tkm/s\tkm/s\t \tK\t \tpc\t \t \n"
            "---\t---\t---\t---\t---\t---\t---\t---\t---\t---\t---\t-\t-\n"
            "4472832130942575872\t 546.9759\t 0.0401\t -801.551\t10362.394\t-110.47\t 0.13\t  1.085\t 3099.6\t 4.7640\t    1.8275\t0\t0\n")
    flame = ("Source\tRad-Flame\tLum-Flame\tMass-Flame\tAge-Flame\n \tRsun\tLsun\tMsun\tGyr\n---\t---\t---\t---\t---\n"
             "4472832130942575872\t  1.2179\t 1.374e+00\t 0.942\t12.131\n")

    def vizier(url, params, **kw):
        return Reply(head + (main if params["-source"] == curious.GAIA_MAIN else flame))
    monkeypatch.setattr(net, "get", vizier)
    s = curious.star_facts("Gaia DR3 4472832130942575872")
    assert s["found"] and abs(s["distance_ly"] - 5.96) < 0.02 and s["distance_from"] == "parallax"       # Barnard's Star
    assert s["rv_kms"] == -110.5 and abs(s["across_kms"] - 90.1) < 0.5 and abs(s["space_kms"] - 142.5) < 1
    assert s["direction"] == "north" and abs(s["in_1000yr_arcmin"] - 173.2) < 0.5                        # almost 3 degrees
    assert not s["double_hint"] and s["binary"] == [] and s["radius_sun"] == 1.2179 and s["age_gyr"] == 12.131
    # a poor single-star fit and Gaia's own binary flags are passed on; no FLAME row is not an error
    double = main.replace("  1.085", "  2.300").replace("\t0\t0\n", "\t3\t0\n")
    monkeypatch.setattr(net, "get", lambda url, params, **kw: Reply(head + (double if params["-source"] == curious.GAIA_MAIN else "")))
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "b")
    d = curious.star_facts("4472832130942575872")
    assert d["double_hint"] and d["binary"] == ["astrometric", "spectroscopic"] and d["mass_sun"] is None
    assert curious.star_facts("x") == {"found": False}
    csv = ("pl_name,hostname,pl_orbper,pl_bmasse,pl_rade,disc_year,discoverymethod\n"
           "Barnard's star b,Barnard's star,3.1533,0.37,0.75,2024,Radial Velocity\n")
    monkeypatch.setattr(net, "get", lambda *a, **kw: Reply(csv))
    p = curious.known_planets(269.4485, 4.7394)
    assert p["host"] == "Barnard's star" and p["planets"] == [{"name": "Barnard's star b", "period_d": 3.1533, "mass_earth": 0.37,
                                                               "radius_earth": 0.75, "year": 2024, "method": "Radial Velocity"}]
    monkeypatch.setattr(net, "get", lambda *a, **kw: Reply("pl_name,hostname,pl_orbper,pl_bmasse,pl_rade,disc_year,discoverymethod\n"))
    assert curious.known_planets(10.0, 5.0) == {"host": None, "planets": []}
    monkeypatch.setattr(net, "get", lambda *a, **kw: Reply("<!DOCTYPE html><html>busy</html>"))
    import pytest
    with pytest.raises(Exception):
        curious.known_planets(11.0, 5.0)                                     # an error page is "unreachable", not "no planets"


def test_catalogue_magnitudes_become_fluxes():
    f = {x["band"]: x for x in curious.band_fluxes({"J": 5.244, "H": 4.834, "K": 4.524, "W9": 1.0, "W1": None})}
    assert set(f) == {"J", "H", "K"} and abs(f["K"]["ujy"] / 1e6 - 10.33) < 0.05 and f["K"]["um"] == 2.159      # Barnard: about 10 Jy


TSV = ("#\n#   VizieR\n\n2MASS\tRAJ2000\tDEJ2000\tJmag\tHmag\tKmag\n \tdeg\tdeg\tmag\tmag\tmag\n"
       "-----\t-----\t-----\t---\t---\t---\n17574849+0441405 \t269.452066\t+04.694608\t5.244\t4.834\t4.524\n")


def test_parse_tsv_and_fast_star_is_looked_up_where_it_was(tmp_path, monkeypatch):
    assert curious.parse_tsv(TSV)[0]["2MASS"] == "17574849+0441405"
    assert curious.parse_tsv("#only comments\n") == []
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    asked = []

    def get(url, params=None, **kw):
        asked.append(params)
        if params["-source"].startswith("II/328"):
            raise net.Upstream("down")
        return Reply(TSV)
    monkeypatch.setattr(net, "get", get)
    mjd_2026 = 51544.5 + 26.5 * 365.25
    now = curious.position_at(269.452066, 4.694608, -801.551, 10362.394, 51544.5 - 0.5 * 365.25, 2026.5)   # from 1999.5 to 2026.5
    out = curious.cross_match(now[0], now[1], -801.551, 10362.394, mjd_2026)
    assert out[0]["state"] == "found" and out[0]["id"] == "17574849+0441405" and out[0]["sep_arcsec"] < 0.5
    assert out[0]["mags"] == {"J": 5.244, "H": 4.834, "K": 4.524}
    assert out[1] == {"survey": "AllWISE", "state": "unreachable"}
    # 27 years at 10.4"/yr: the 2MASS search was centred 4.7 arcmin from where the star is now
    c = [float(v) for v in asked[0]["-c"].split()]
    assert abs((now[1] - c[1]) * 3600 - 279.8) < 2


def test_routes_report_services_that_are_down(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)

    def down(*a, **kw):
        raise net.Upstream("down")
    monkeypatch.setattr(net, "get", down)
    c = TestClient(app)
    assert c.get("/api/curious/hr", params={"ra": 10, "dec": 5}).json()["reachable"] is False
    assert c.get("/api/curious/motion", params={"gaia_id": "123"}).json()["reachable"] is False
    assert [s["state"] for s in c.get("/api/curious/xmatch", params={"ra": 10, "dec": 5}).json()["surveys"]] == ["unreachable"] * 2
    facts = c.get("/api/curious/facts", params={"ra": 10, "dec": 5, "gaia_id": "123"}).json()
    assert facts["star"]["reachable"] is False and facts["planets"]["reachable"] is False
    known = c.get("/api/curious/variable", params={"ra": 10, "dec": 5, "gaia_id": "123"}).json()
    assert known["vsx"]["reachable"] is False and known["gaia"]["reachable"] is False
    assert c.get("/api/curious/variable", params={"ra": 10, "dec": 5}).json()["gaia"] == {"reachable": True, "found": False}
    monkeypatch.setattr(pulse, "N_SCRAMBLES", 120)
    assert c.post("/api/curious/period", json={"points": lightcurve(period=120)}).json()["convincing"]
    assert c.post("/api/curious/period", json={"points": [], "wings": True}).json() == {"ok": False, "reason": "too_few"}
    csv = "source_id,parallax,parallax_over_error,phot_g_mean_mag,bp_rp,pmra,pmdec\n" + ",".join(BARNARD[k] for k in
          ("source_id", "parallax", "parallax_over_error", "phot_g_mean_mag", "bp_rp", "pmra", "pmdec")) + "\n"
    monkeypatch.setattr(net, "get", lambda *a, **kw: Reply(csv))
    hr = c.get("/api/curious/hr", params={"ra": 269.45, "dec": 4.69, "gaia_id": BARNARD["source_id"]}).json()
    assert hr["reachable"] and hr["stars"] == [[2.834, 11.885]] and hr["star"]["speed_kms"] > 85
