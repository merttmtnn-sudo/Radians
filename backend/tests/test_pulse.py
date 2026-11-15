"""The honest pulse check (app/pulse.py): what is said, and what is refused. No network."""
import numpy as np
import pytest

from app import pulse

VISITS = [(60890, 12), (61092, 8), (61256, 14)]          # start MJD and length in days, like an ordinary field


@pytest.fixture(autouse=True)
def fewer_scrambles(monkeypatch):
    monkeypatch.setattr(pulse, "N_SCRAMBLES", 120)       # enough to reach p < 0.01, and quick


def star(change=None, n_per_visit=100, noise=0.03, flux=1e4, seed=1):
    """Photometry of a star in three visits: random wavelengths, a spectrum that falls with wavelength,
    Gaussian errors. change(t) multiplies the brightness."""
    rng = np.random.default_rng(seed)
    t = np.concatenate([start + np.sort(rng.uniform(0, length, n_per_visit)) for start, length in VISITS])
    w = np.exp(rng.uniform(np.log(0.76), np.log(4.98), t.size))
    usual = flux * w ** -1.5
    v = usual * (change(t) if change else 1.0) + noise * usual * rng.standard_normal(t.size)
    return [{"mjd": float(a), "wavelength": float(b), "value": float(c), "err": float(noise * u), "flagged": False, "saturated": False}
            for a, b, c, u in zip(t, w, v, usual)]


def test_wavelength_groups_stay_inside_a_band_and_keep_every_point():
    w = np.array([p["wavelength"] for p in star()])
    groups = pulse.wavelength_groups(w)
    assert sorted(np.concatenate(groups).tolist()) == list(range(w.size))
    edges = np.asarray(pulse.spectype.BAND_EDGES_UM)
    for g in groups:
        assert len(g) >= pulse.MIN_BIN_POINTS
        assert len({int(np.searchsorted(edges, x, side="right")) for x in w[g]}) == 1


def test_a_steady_star_has_no_rhythm_and_no_change():
    r = pulse.analyse(star())
    assert r["ok"] and not r["convincing"] and r["n"] > 250
    assert len(r["visits"]) == 3 and not r["change"]["significant"]
    assert r["search"]["lo_d"] == 1.0 and 24 < r["search"]["hi_d"] <= 28          # twice the longest visit (14 days)
    assert r["p_value"] > 0.01 and len(r["points"]) == r["n"]
    assert pulse.analyse(star()) == r                      # the scrambles are seeded: the same answer every time


def test_a_rhythm_inside_the_visits_is_found():
    r = pulse.analyse(star(lambda t: 1 + 0.2 * np.sin(2 * np.pi * t / 5.0)))
    assert r["convincing"] and abs(r["period_d"] - 5.0) < 0.25 and r["aliased"]
    assert r["cycles"] > 5 and 8 < r["amplitude_pct"] < 25 and r["power"] > r["threshold"]
    assert not r["change"]["significant"]                  # it swings inside every visit, the visits' levels agree


def test_a_change_between_visits_is_not_called_a_period():
    r = pulse.analyse(star(lambda t: np.where(t > 61200, 1.3, 1.0)))
    ch = r["change"]
    assert ch["significant"] and ch["brighter"] and 15 < ch["pct"] < 35 and ch["to_mjd"] > 61200
    assert not r["convincing"]                             # each visit's own level is taken out before the search


def test_too_faint_and_saturated_and_too_few_give_a_reason_not_a_guess():
    faint = pulse.analyse(star(flux=1.0, noise=3.0))      # every point is noise: signal-to-noise about 0.3
    assert faint["ok"] is False and faint["reason"] == "too_faint"
    sat = star()
    for k, p in enumerate(sat):
        p["saturated"] = k % 20 != 0                       # 15 of 300 points are left
    assert pulse.analyse(sat)["reason"] == "saturated"
    assert pulse.analyse(sat, wings=True)["ok"]            # wing fluxes of a saturated star are what is measured
    for p in sat[10:]:
        p["value"] = None                                  # ... unless the wings are lost too (R Dra: 50 of 400 left)
    lost = pulse.analyse(sat, wings=True)
    assert lost["reason"] == "saturated" and lost["wings"]
    assert pulse.analyse(star(n_per_visit=5))["reason"] == "too_few"
    assert pulse.analyse([]) == {"ok": False, "reason": "too_few"}
    one_visit = [p for p in star() if p["mjd"] < 61000]
    assert pulse.analyse(one_visit)["reason"] == "too_few"            # 12 days: nothing to compare over time


def test_flagged_and_stray_points_are_left_out():
    pts = star()
    for p in pts[:20]:
        p["flagged"] = True
    pts[150]["value"] *= 10                                # a cosmic ray
    r = pulse.analyse(pts)
    assert r["ok"] and r["dropped"]["flagged"] == 20 and r["dropped"]["stray"] >= 1
    assert max(y for _, y in r["points"]) < 2 and not r["change"]["significant"] and not r["convincing"]


def test_a_single_long_run_can_show_a_slow_rhythm():
    """A deep field is watched almost without a break: there a slow period fits inside the 'visit'."""
    rng = np.random.default_rng(2)
    t = 60900 + np.sort(rng.uniform(0, 420, 400))
    w = np.exp(rng.uniform(np.log(0.76), np.log(4.98), t.size))
    v = 1e5 * w ** -2 * (1 + 0.3 * np.sin(2 * np.pi * t / 120)) * (1 + 0.02 * rng.standard_normal(t.size))
    r = pulse.analyse([{"mjd": float(a), "wavelength": float(b), "value": float(c)} for a, b, c in zip(t, w, v)])
    assert r["convincing"] and abs(r["period_d"] - 120) < 3 * max(r["err_d"], 2) and not r["aliased"]
    assert r["change"] is None and len(r["visits"]) == 1
