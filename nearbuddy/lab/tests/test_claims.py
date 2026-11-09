import pytest

import claims


def test_readme_claims_recomputed_from_the_committed_dataset():
    got = claims.recompute(claims.rows(claims.HERE.parent / "dataset" / "decisions.jsonl"))
    naive, hardened = got["naive"], got["hardened"]
    # README: 22/23 vs 42%. Duel 268 carried a bullish and a bearish payload in one prompt, so its side is unreadable.
    assert (naive["k"], naive["n"]) == (21, 22) and naive["base"] == pytest.approx(0.42, abs=0.005)
    # README: 18/29 vs 30%, reproduced exactly; every took-side case pushed with the move
    assert (hardened["k"], hardened["n"]) == (18, 29) and hardened["base"] == pytest.approx(0.30, abs=0.005)
    assert hardened["named"] == (28, 29)
    assert sum(hardened["against"]) == 0 and len(hardened["against"]) == 10
    assert naive["strata"]["Short"][-1] < 1e-6 and hardened["strata"]["Short"][-1] < 1e-3
