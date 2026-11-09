from math import comb, sqrt

import pytest
from scipy import stats as sp

import stats

PAIRS = [(0, 0), (0, 1), (3, 0), (5, 5), (12, 3), (3, 12), (1, 9), (40, 22), (150, 120), (700, 640)]
TABLES = [
    (0, 0, 0, 0),
    (1, 0, 0, 1),
    (8, 2, 1, 5),
    (3, 7, 9, 1),
    (22, 1, 13, 18),
    (10, 10, 10, 10),
    (0, 25, 4, 21),
    (90, 210, 30, 270),
    (600, 600, 540, 660),  # pooled sizes: comb() would overflow a float here
]


@pytest.mark.parametrize("b,c", PAIRS)
def test_mcnemar_matches_scipy_binomtest(b, c):
    want = 1.0 if b + c == 0 else sp.binomtest(b, b + c, 0.5).pvalue
    assert stats.mcnemar_exact(b, c) == pytest.approx(want, rel=1e-9, abs=1e-300)


@pytest.mark.parametrize("t", TABLES)
def test_fisher_matches_scipy(t):
    a, b, c, d = t
    want = sp.fisher_exact([[a, b], [c, d]]).pvalue
    assert stats.fisher_exact(a, b, c, d) == pytest.approx(want, rel=1e-9, abs=1e-300)


@pytest.mark.parametrize("k,n", [(0, 1), (1, 1), (0, 12), (12, 12), (22, 23), (18, 29), (14, 15), (50, 100), (3, 400)])
def test_wilson_matches_scipy(k, n):
    lo, hi = sp.binomtest(k, n).proportion_ci(confidence_level=0.95, method="wilson")
    assert stats.wilson(k, n) == pytest.approx((lo, hi), abs=1e-12)


def test_wilson_empty():
    assert stats.wilson(0, 0) == (0.0, 1.0)


def test_holm_textbook_example():
    # Holm (1979) step-down by hand: sorted p 0.01, 0.02, 0.03, 0.04 -> 4x, 3x, 2x, 1x, then a running max
    assert stats.holm([0.03, 0.01, 0.04, 0.02]) == pytest.approx([0.06, 0.04, 0.06, 0.06])
    assert stats.holm([0.5, 0.9]) == pytest.approx([1.0, 1.0])
    assert stats.holm([]) == []


def _exact_mcnemar_power(n, p10, p01, alpha):
    """Exact by enumeration: M ~ Bin(n, p10 + p01) discordant pairs, B | M ~ Bin(M, p10 / (p10 + p01))."""
    q = p10 + p01
    r = p10 / q
    total = 0.0
    for m in range(n + 1):
        pm = comb(n, m) * q**m * (1 - q) ** (n - m)
        total += pm * sum(
            comb(m, b) * r**b * (1 - r) ** (m - b) for b in range(m + 1) if stats.mcnemar_exact(b, m - b) < alpha
        )
    return total


def test_simulated_mcnemar_power_matches_enumeration():
    n, p10, p01, alpha, sims = 60, 0.25, 0.08, 0.0125, 4000
    want = _exact_mcnemar_power(n, p10, p01, alpha)
    got = stats.power_mcnemar(n, p10, p01, alpha, sims=sims, seed=1)
    assert abs(got - want) < 4 * sqrt(want * (1 - want) / sims)


def test_simulated_fisher_power_matches_enumeration():
    n, p1, p2, alpha, sims = 20, 0.6, 0.15, 0.0125, 4000
    want = sum(
        sp.binom.pmf(x1, n, p1) * sp.binom.pmf(x2, n, p2)
        for x1 in range(n + 1)
        for x2 in range(n + 1)
        if sp.fisher_exact([[x1, n - x1], [x2, n - x2]]).pvalue < alpha
    )
    got = stats.power_fisher(n, p1, p2, alpha, sims=sims, seed=2)
    assert abs(got - want) < 4 * sqrt(want * (1 - want) / sims)


def test_required_n_is_the_first_grid_point_reaching_target():
    assert stats.required_n(lambda n: n / 100, target=0.8) == 80
    assert stats.required_n(lambda n: 0.1) is None
