"""The pre-registered tests, stdlib only: exact McNemar, Fisher's exact, Wilson intervals, Holm, and power by
simulation with those same exact tests. Exact tests use integer arithmetic, so large pooled tables cannot overflow.
tests/test_stats.py checks every value against scipy."""

from __future__ import annotations

import random
from collections.abc import Callable
from functools import cache
from math import comb, sqrt
from statistics import NormalDist

Z95 = NormalDist().inv_cdf(0.975)


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar: binomial test of b discordant pairs out of b + c at p = 0.5."""
    m = b + c
    if m == 0:
        return 1.0
    tail = sum(comb(m, i) for i in range(min(b, c) + 1))
    return min(1.0, 2 * tail / 2**m)


def fisher_exact(a: int, b: int, c: int, d: int) -> float:
    """Two-sided Fisher's exact test on [[a, b], [c, d]]: the probability of every table with the same margins that
    is no more likely than the observed one (scipy's rule, including its 1e-7 relative tolerance)."""
    row1, col1, n = a + b, a + c, a + b + c + d
    lo, hi = max(0, row1 + col1 - n), min(row1, col1)

    def weight(x: int) -> int:  # hypergeometric pmf times comb(n, col1)
        return comb(row1, x) * comb(n - row1, col1 - x)

    obs = weight(a)
    total = sum(weight(x) for x in range(lo, hi + 1))
    more_extreme = sum(w for x in range(lo, hi + 1) if (w := weight(x)) * 10**7 <= obs * (10**7 + 1))
    return min(1.0, more_extreme / total)


def wilson(k: int, n: int, z: float = Z95) -> tuple[float, float]:
    """Wilson score interval for k successes in n; (0, 1) when n is 0."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def holm(pvals: list[float]) -> list[float]:
    """Holm step-down adjusted p-values, in the input order."""
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    out = [0.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * pvals[i]))
        out[i] = running
    return out


def power_mcnemar(n: int, p10: float, p01: float, alpha: float, sims: int = 5000, seed: int = 0) -> float:
    """Share of `sims` simulated experiments of n paired trials, drawn with P(cue only) = p10 and P(clean only) = p01,
    in which the exact McNemar test rejects at `alpha`."""
    rng = random.Random(seed)
    hits = 0
    for _ in range(sims):
        b = c = 0
        for _ in range(n):
            u = rng.random()
            if u < p10:
                b += 1
            elif u < p10 + p01:
                c += 1
        hits += mcnemar_exact(b, c) < alpha
    return hits / sims


def power_fisher(n: int, p1: float, p2: float, alpha: float, sims: int = 5000, seed: int = 0) -> float:
    """Share of `sims` simulated experiments with n trials per arm, flip rates p1 and p2, in which Fisher's exact
    test rejects at `alpha`."""
    rng = random.Random(seed)
    hits = 0
    for _ in range(sims):
        x1 = sum(rng.random() < p1 for _ in range(n))
        x2 = sum(rng.random() < p2 for _ in range(n))
        hits += _fisher_cached(x1, n - x1, x2, n - x2) < alpha
    return hits / sims


_fisher_cached = cache(fisher_exact)  # simulated tables repeat a lot


def required_n(power_at: Callable[[int], float], target: float = 0.8, step: int = 10, n_max: int = 400) -> int | None:
    """Smallest multiple of `step` up to `n_max` whose power reaches `target`, or None."""
    for n in range(step, n_max + 1, step):
        if power_at(n) >= target:
            return n
    return None
