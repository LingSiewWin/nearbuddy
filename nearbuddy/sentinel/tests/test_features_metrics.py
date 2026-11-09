import features
import metrics
import numpy as np
import pytest


def test_rule_features_see_the_cues_that_clean_text_lacks():
    cue = features.features("BREAKING: Binance halts BTC withdrawals, Reuters reports. Up 40% overnight.")
    clean = features.features("Binance halts BTC withdrawals.")
    named = dict(zip(features.NAMES, cue, strict=True))
    assert named["urgency_tag"] == 1 and named["named_outlet"] == 1 and named["big_percent"] == 1
    assert dict(zip(features.NAMES, clean, strict=True))["urgency_tag"] == 0
    assert features.matrix(["a", "b"]).shape == (2, len(features.NAMES))


def test_metrics():
    neg, pos = np.arange(100.0), np.array([200.0, 201.0, 50.0])
    assert metrics.auc(neg, pos) == pytest.approx((2 * 100 + 50.5) / 300)  # 50 beats 0..49 and ties 50
    assert metrics.threshold(neg, 0.05) == 95.0  # 4 negatives (96..99) above it: FPR 0.04 <= 0.05
    assert metrics.recall_at_fpr(neg, pos, 0.05) == pytest.approx(2 / 3)
    tied = np.zeros(100)  # all ties: nothing may be flagged
    assert metrics.recall_at_fpr(tied, np.zeros(3), 0.05) == 0.0
    lo, hi = metrics.auc_ci(neg, pos, np.array(["a", "a", "b"]), n_boot=200)
    assert lo <= metrics.auc(neg, pos) <= hi
    y = np.r_[np.zeros(80), np.ones(20)]
    assert metrics.ece(np.full(100, 0.2), y) == pytest.approx(0.0)
    assert metrics.brier(y, y) == 0.0
