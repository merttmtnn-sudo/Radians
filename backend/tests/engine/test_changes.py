import numpy as np

from app.engine.changes import find_changes

N, SCALE = 120, 2.0
SIGMA = 9.0 / 2.355 / SCALE


def sky(stars, seed, noise=0.02, blank_above=None):
    """A stack with Gaussian stars [(x, y, peak)] and noise; pixels above blank_above go blank."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[:N, :N]
    img = noise * rng.standard_normal((N, N))
    for x, y, peak in stars:
        img += peak * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * SIGMA ** 2))
        if blank_above is not None:                # saturated stars also have wide wings
            img += 0.02 * peak * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * (4 * SIGMA) ** 2))
    if blank_above is not None:
        img[img > blank_above] = np.nan
    return img


def run(a_stars, b_stars, years=1.0, n_frames=(20, 20), **kw):
    a, b = sky(a_stars, 1, **kw), sky(b_stars, 2, **kw)
    return find_changes(a, b, b - a, SCALE, years, n_frames)


FIELD = [(30, 30, 1.0), (90, 40, 2.0), (25, 95, 0.6)]


def test_mover_is_found_with_speed_and_direction():
    items, _ = run(FIELD + [(60, 60, 1.0)], FIELD + [(55, 60, 1.0)])          # 5 px = 10" to the east
    assert [it["kind"] for it in items] == ["mover"]
    m = items[0]
    assert abs(m["shift_arcsec"] - 10) < 1.5 and m["direction"] == "east"
    assert abs(m["rate_arcsec_yr"] - 10) < 1.5 and m["shift_err_arcsec"] < 2 and not m["implausible"]
    assert abs(m["x1"] - 60) < 1 and abs(m["x2"] - 55) < 1


def test_slightly_misaligned_bright_star_is_not_a_mover():
    items, _ = run(FIELD + [(60, 60, 20.0)], FIELD + [(60.15, 60.1, 20.0)])    # 0.35" alignment error
    assert not [it for it in items if it["kind"] == "mover"]


def test_new_vanished_brighter_fainter():
    items, _ = run(FIELD + [(80, 80, 1.0), (50, 20, 1.0)], FIELD + [(60, 60, 1.0), (50, 20, 2.0), (80, 80, 0.5)])
    kinds = {it["kind"]: it for it in items}
    assert set(kinds) == {"appeared", "brightened", "faded"}
    assert abs(kinds["appeared"]["x"] - 60) < 1.5 and abs(kinds["brightened"]["x"] - 50) < 1.5
    assert 0.6 < kinds["brightened"]["change"] < 1.6 and -0.65 < kinds["faded"]["change"] < -0.35
    gone, _ = run(FIELD + [(60, 60, 1.0)], FIELD)
    assert [it["kind"] for it in gone] == ["vanished"]


def test_noise_alone_gives_nothing():
    assert run(FIELD, FIELD)[0] == []


def test_wing_residual_of_a_bright_star_is_ignored():
    items, _ = run(FIELD + [(60, 60, 50.0)], FIELD + [(60, 60, 50.0), (66, 60, 0.4)])
    assert items == []


def test_few_pictures_list_nothing_fragile():
    items, notes = run(FIELD + [(60, 60, 1.0)], FIELD + [(55, 60, 1.0), (90, 90, 1.0)], n_frames=(3, 20))
    assert items == [] and len(notes) == 2


def test_too_fast_for_a_star_is_marked():
    items, _ = run(FIELD + [(60, 60, 1.0)], FIELD + [(52, 60, 1.0)], years=0.5)   # 16" in half a year
    assert items[0]["kind"] == "mover" and items[0]["implausible"]


def test_saturated_star_moving_and_fading():
    moved, _ = run(FIELD + [(60, 60, 60.0)], FIELD + [(60, 56.5, 60.0)], blank_above=8.0)   # 7" south
    assert moved and moved[0]["kind"] == "mover" and moved[0]["saturated"] and moved[0]["direction"] == "south"
    faded, _ = run(FIELD + [(60, 60, 60.0)], FIELD + [(60, 60, 30.0)], blank_above=8.0)
    assert [it["kind"] for it in faded] == ["faded"] and -0.65 < faded[0]["change"] < -0.35
