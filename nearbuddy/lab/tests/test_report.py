import report


def call(side, verified=True, error=None):
    return {"side": side, "verified": verified, "error": error}


TRIAL = {
    "model": "m",
    "direction": "Short",
    "calls": {
        "baseline": call("Long"),
        "cue": call("Short"),
        "clean": call("Long"),
        "placebo": call("Short", verified=False),
    },
}
NO_BASELINE = {"model": "m", "calls": {"baseline": call(None, error="parse: no JSON object")}}


def test_flip_is_the_lie_side_against_a_usable_baseline():
    assert report.flip(TRIAL, "cue") is True
    assert report.flip(TRIAL, "clean") is False
    assert report.flip(TRIAL, "placebo") is None  # unverified: out of the primary analysis
    assert report.flip(TRIAL, "placebo", unverified=True) is True  # in the sensitivity analysis
    assert report.flip(NO_BASELINE, "cue") is None


def test_rates_and_pairs_skip_missing_outcomes():
    recs = [TRIAL, NO_BASELINE]
    assert report.rate(recs, "cue") == (1, 1)
    assert report.paired(recs, "cue", "clean") == (1, 0, 1)
    assert report.paired(recs, "cue", "placebo") == (0, 0, 0)
    assert report.paired(recs, "cue", "placebo", unverified=True) == (0, 0, 1)


def test_reverify_real_pilot_calls_and_catch_tampering():
    rec = next(r for r in report.load("pilot") if all(c["verified"] for c in r["calls"].values()))
    assert all(report.reverified(rec, a) for a in rec["calls"])
    swapped = {**rec, "calls": {**rec["calls"], "cue": {**rec["calls"]["cue"], "headline": "something else"}}}
    assert not report.reverified(swapped, "cue")  # the arm label must match the signed request
    edited = {**rec, "calls": {**rec["calls"], "clean": {**rec["calls"]["clean"], "response_body": "{}"}}}
    assert not report.reverified(edited, "clean")
    relabelled = {**rec, "calls": {**rec["calls"], "baseline": rec["calls"]["cue"]}}
    assert not report.reverified(relabelled, "baseline")


def test_against_the_move():
    assert report.against({"direction": "Long", "move_bps": -3.0}) == "against the move"
    assert report.against({"direction": "Short", "move_bps": -3.0}) == "with the move"
    assert report.against({"direction": "Short", "move_bps": 0.0}) == "flat"
