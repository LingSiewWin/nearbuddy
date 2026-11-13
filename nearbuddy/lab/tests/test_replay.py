"""The replay's arithmetic: what variant B adds to the brief, and the tables the report prints."""

from __future__ import annotations

import replay

SNAP = {
    "id": "NEAR-1",
    "symbol": "NEAR/USD",
    "brief": "NEAR/USD last 3.86. Move since duel open: -3.1 bps.",
    "move_bps": -3.1,
}
WIN = {"id": "NEAR-1", "history": [[60, 3.85], [120, 3.86], [180, 3.87]], "px_brief": 3.86, "px_6m": 3.9, "px_60m": 3.8}


def row(snap: str, model: str, variant: str, rep: int, side: str | None, verified: bool = True) -> dict:
    return {"snapshot": snap, "model": model, "variant": variant, "repeat": rep, "side": side, "verified": verified}


def test_variant_a_is_the_snapshot_brief_unchanged() -> None:
    assert replay.brief_for("A", SNAP, WIN) == SNAP["brief"]


def test_variant_b_appends_the_closes_oldest_first_and_nothing_else() -> None:
    b = replay.brief_for("B", SNAP, WIN)
    assert b.startswith(SNAP["brief"] + "\n")
    assert b.endswith("Last 3 one-minute closes, oldest first: 3.85, 3.86, 3.87")


def test_majority_is_the_side_most_repeats_took_and_none_on_a_split_or_no_call() -> None:
    assert replay.majority(["Long", "Long", "Short"]) == "Long"
    assert replay.majority(["Long", "Short"]) is None
    assert replay.majority([]) is None


def test_unverified_and_failed_calls_are_left_out() -> None:
    rows = [
        row("s1", "m1", "A", 0, "Long"),
        row("s1", "m1", "A", 1, "Short", verified=False),
        row("s1", "m1", "A", 2, None),
    ]
    assert replay.calls(rows, "A") == {("s1", "m1"): ["Long"]}


def test_self_agreement_counts_repeats_that_match_the_models_own_majority() -> None:
    rows = [row("s1", "m1", "A", r, s) for r, s in enumerate(["Long", "Long", "Short"])]
    rows += [row("s2", "m1", "A", r, "Short") for r in range(3)]
    assert replay.self_agreement(rows, "A") == {"m1": (5, 6)}


def test_disagreement_compares_two_models_majorities_on_the_same_snapshot() -> None:
    rows = []
    for snap, a, b in [
        ("s1", "Long", "Long"),
        ("s2", "Long", "Short"),
        ("s3", "Short", "Short"),
        ("s4", "Short", "Long"),
    ]:
        rows += [row(snap, "m1", "B", r, a) for r in range(3)] + [row(snap, "m2", "B", r, b) for r in range(3)]
    assert replay.disagreement(rows, "B") == {("m1", "m2"): (2, 4)}


def test_hit_rate_scores_majorities_against_the_later_price_and_skips_an_unchanged_one() -> None:
    wins = {
        "s1": {"px_brief": 10.0, "px_6m": 11.0},  # up
        "s2": {"px_brief": 10.0, "px_6m": 9.0},  # down
        "s3": {"px_brief": 10.0, "px_6m": 10.0},  # unchanged: no right answer
    }
    rows = [row(s, "m1", "A", r, "Long") for s in wins for r in range(3)]
    assert replay.hit_rate(rows, "A", wins, "px_6m") == {"m1": (1, 2)}


def test_baselines_always_long_and_follow_the_move() -> None:
    snaps = {"s1": {"move_bps": 5.0}, "s2": {"move_bps": -5.0}, "s3": {"move_bps": 0.0}}
    wins = {
        "s1": {"px_brief": 10.0, "px_6m": 11.0},
        "s2": {"px_brief": 10.0, "px_6m": 11.0},
        "s3": {"px_brief": 10.0, "px_6m": 9.0},
    }
    # always long: right on s1 and s2, wrong on s3. follow the move: right on s1, wrong on s2, no call on s3 (no move).
    assert replay.baselines(snaps, wins, "px_6m") == {"always long": (2, 3), "follow the move": (1, 2)}


def test_the_plan_is_every_snapshot_model_variant_and_repeat_once() -> None:
    jobs = replay.jobs(["s1", "s2"], ["m1", "m2", "m3"], ["A", "B"], 3)
    assert len(jobs) == 36
    assert len(set(jobs)) == 36
    assert jobs[0] == ("s1", "m1", "A", 0)
