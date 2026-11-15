"""Is a star there? (stack.spot_check) Photometry returns a number on empty sky too. No network."""
import numpy as np

from app import stack

N = 39


def frames(stars, k=40, noise=1.0, seed=0, drift=(0.0, 0.0)):
    """k exposures of a field. stars: [(x, y, peak)]; drift: how far the first star moves per exposure."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:N, 0:N]
    out = []
    for i in range(k):
        img = noise * rng.standard_normal((N, N))
        for j, (x, y, peak) in enumerate(stars):
            dx, dy = (drift[0] * i, drift[1] * i) if j == 0 else (0.0, 0.0)
            img += peak * np.exp(-((xx - x - dx) ** 2 + (yy - y - dy) ** 2) / (2 * 0.8 ** 2))
        out.append(stack.Frame(None, img.astype("f4"), np.ones((N, N), "f4"), np.zeros((N, N), np.uint32)))
    return out


def check(frs, x, y):
    return stack.spot_check(frs, [(x, y)] * len(frs))


def test_a_star_at_the_spot():
    got = check(frames([(19, 19, 30)]), 19, 19)
    assert got["state"] == "star" and got["snr"] > 50 and got["n"] == 40
    assert check(frames([(19, 19, 30)]), 20, 19)["state"] == "star"       # a click one pixel off still finds its peak


def test_empty_sky_is_called_empty():
    got = check(frames([(8, 8, 30)]), 25, 25)
    assert got["state"] == "empty" and got["snr"] < 5


def test_the_slope_of_a_brighter_neighbour_is_a_wing():
    frs = frames([(19, 19, 4000)])
    got = check(frs, 22, 19)                                # three pixels from a very bright star
    assert got["state"] == "wing" and got["neighbour"] > 2 and got["offset"] == [-3, 0]      # the star is 3 px to the left
    assert check(frs, 19, 19)["state"] == "star"


def test_a_moving_target_is_followed():
    frs = frames([(10, 19, 30)], drift=(0.4, 0.0))          # crosses 16 pixels during the exposures
    where = [(10 + 0.4 * i, 19) for i in range(len(frs))]
    assert stack.spot_check(frs, where)["state"] == "star"
    assert stack.spot_check(frs, [(30, 30)] * len(frs))["state"] == "empty"


def test_too_little_to_judge_does_not_block():
    assert check(frames([(19, 19, 30)], k=2), 30, 30)["state"] == "star"            # two exposures: no verdict
    blank = frames([(19, 19, 30)])
    for f in blank:
        f.image[17:22, 17:22] = np.nan                      # a saturated core the pipeline blanked
    assert check(blank, 19, 19)["state"] == "star"
    assert check(frames([(19, 19, 30)]), 0, 0)["state"] in ("empty", "star")        # at the corner: no crash
