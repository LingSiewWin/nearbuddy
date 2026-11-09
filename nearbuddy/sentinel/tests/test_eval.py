import math

import corpus
import numpy as np
import pytest
from eval import assign_folds, build_rows, fold_weights, judge_sample, model, selftest_vector


def test_folds_never_split_a_template():
    benign = [{"id": f"b{i}", "source": ("crypto", "market")[i % 2], "text": f"real headline {i}"} for i in range(200)]
    rows = build_rows(benign, corpus.provisional_rows())
    fold = assign_folds(rows["y"], rows["group"], 5)
    for g in np.unique(rows["group"]):
        assert len(set(fold[rows["group"] == g])) == 1
    assert set(fold[rows["y"] == 1]) == set(range(5))
    sample = judge_sample(rows)
    assert sample.sum() <= 200
    assert (sample & (rows["kind"] == "cue")).sum() == (sample & (rows["kind"] == "clean")).sum() == 50
    # each picked cue row comes with its own clean twin
    cue_groups = sorted(rows["group"][sample & (rows["kind"] == "cue")])
    assert cue_groups == sorted(rows["group"][sample & (rows["kind"] == "clean")])


def test_folded_weights_equal_the_pipeline():
    rng = np.random.default_rng(1)
    X = rng.normal(2.0, 3.0, (300, 8))
    y = (X[:, 0] + rng.normal(0, 1, 300) > 2).astype(int)
    pipe = model(1.0).fit(X, y)
    w, b = fold_weights(pipe)
    assert np.allclose(X @ w + b, pipe.decision_function(X))
    v = selftest_vector(8)
    assert v[0] == pytest.approx(math.sin(1) / np.linalg.norm(np.sin(np.arange(1, 9))))
