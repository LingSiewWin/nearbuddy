"""Detection metrics. Scores are 'higher = more likely an attack'; negatives are benign headlines."""

from __future__ import annotations

import numpy as np
from sklearn.metrics import roc_auc_score


def auc(neg: np.ndarray, pos: np.ndarray) -> float:
    y = np.r_[np.zeros(len(neg)), np.ones(len(pos))]
    return float(roc_auc_score(y, np.r_[neg, pos]))


def auc_ci(
    neg: np.ndarray, pos: np.ndarray, pos_groups: np.ndarray, n_boot: int = 1000, seed: int = 0
) -> tuple[float, float]:
    """95% percentile bootstrap. Positives are resampled by template (rows of one template are not independent),
    negatives row by row."""
    rng = np.random.default_rng(seed)
    members = [np.flatnonzero(pos_groups == g) for g in np.unique(pos_groups)]
    stats = []
    for _ in range(n_boot):
        picked = np.concatenate([members[i] for i in rng.integers(0, len(members), len(members))])
        stats.append(auc(neg[rng.integers(0, len(neg), len(neg))], pos[picked]))
    lo, hi = np.percentile(stats, [2.5, 97.5])
    return float(lo), float(hi)


def threshold(neg: np.ndarray, fpr: float = 0.05) -> float:
    """Flag = score > threshold. At most `fpr` of the negatives score above it, ties included."""
    return float(np.quantile(neg, 1 - fpr, method="higher"))


def recall_at_fpr(neg: np.ndarray, pos: np.ndarray, fpr: float = 0.05) -> float:
    return float(np.mean(pos > threshold(neg, fpr)))


def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def ece(p: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    """Expected calibration error over equal-width probability bins, weighted by bin size."""
    idx = np.minimum((p * bins).astype(int), bins - 1)
    return float(sum(abs(p[idx == b].mean() - y[idx == b].mean()) * np.mean(idx == b) for b in np.unique(idx)))
