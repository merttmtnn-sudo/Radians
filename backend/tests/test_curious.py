"""For-the-curious tools: speed, H-R points, period search, cross-match. No network."""
import numpy as np
from fastapi.testclient import TestClient

from app import config, curious, explorer
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


def test_period_is_found_and_noise_is_not_convincing():
    r = curious.period_search(lightcurve(period=120))
    assert r["ok"] and abs(r["period_d"] - 120) < 3 * max(r["err_d"], 2) and r["convincing"]
    assert len(r["folded"]) == r["n"] and len(r["periodogram"]) <= 400
    flat = curious.period_search(lightcurve())
    assert flat["ok"] and not flat["convincing"]
    assert curious.period_search(lightcurve(n=20)) == {"ok": False, "reason": "too_few"}
    assert curious.period_search(lightcurve(span=30)) == {"ok": False, "reason": "too_few"}
    assert curious.period_search([]) == {"ok": False, "reason": "too_few"}


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
            raise explorer.Upstream("down")
        return Reply(TSV)
    monkeypatch.setattr(explorer, "_get", get)
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
        raise explorer.Upstream("down")
    monkeypatch.setattr(explorer, "_get", down)
    c = TestClient(app)
    assert c.get("/api/curious/hr", params={"ra": 10, "dec": 5}).json()["reachable"] is False
    assert c.get("/api/curious/motion", params={"gaia_id": "123"}).json()["reachable"] is False
    assert [s["state"] for s in c.get("/api/curious/xmatch", params={"ra": 10, "dec": 5}).json()["surveys"]] == ["unreachable"] * 2
    assert c.post("/api/curious/period", json={"points": lightcurve(period=120)}).json()["convincing"]
    csv = "source_id,parallax,parallax_over_error,phot_g_mean_mag,bp_rp,pmra,pmdec\n" + ",".join(BARNARD[k] for k in
          ("source_id", "parallax", "parallax_over_error", "phot_g_mean_mag", "bp_rp", "pmra", "pmdec")) + "\n"
    monkeypatch.setattr(explorer, "_get", lambda *a, **kw: Reply(csv))
    hr = c.get("/api/curious/hr", params={"ra": 269.45, "dec": 4.69, "gaia_id": BARNARD["source_id"]}).json()
    assert hr["reachable"] and hr["stars"] == [[2.834, 11.885]] and hr["star"]["speed_kms"] > 85
