"""The spectator (packages/demo/src/against.ts) aims each injection against the move the runner's brief shows. This
side of the shared fixture runs the runner's own path: oracle_open_px() reads the duel's oracle open price, brief()
prints the move, and the analysis' BRIEF_RE reads it back. against.test.ts checks the same rows with moveBps/fmtMove,
so a change on either side breaks one of the two tests."""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents"))
sys.path.insert(0, str(ROOT / "analysis"))

import experiment_report as er  # noqa: E402
import injection_effects as ie  # noqa: E402

import runner  # noqa: E402
from prices import brief  # noqa: E402

FIXTURE = json.loads((ROOT / "packages" / "demo" / "src" / "against.fixture.json").read_text())
SPOT_AT_OPEN = 380_000_000  # what price() returns when the runner falls back to spot


@pytest.fixture
def chain(monkeypatch):
    def use(open_price):
        duel = {"open_price": None if open_price is None else str(open_price)}
        monkeypatch.setattr(runner, "view", lambda _m, _a: duel)
        monkeypatch.setattr(runner, "price", lambda *_a: SPOT_AT_OPEN)
        monkeypatch.setattr(runner.time, "sleep", lambda _s: None)

    return use


@pytest.mark.parametrize("case", FIXTURE["moves"], ids=lambda c: f"{c['open']}->{c['spot']}")
def test_brief_move_matches_the_spectator_fixture(chain, case):
    chain(case["open"])
    open_px, source = runner.oracle_open_px("7", "NEAR/USD", wait_s=0)
    if case["open"] is None:
        # no oracle open: the runner briefs on its own spot, which the spectator cannot see; it logs no_open (flat)
        assert (open_px, source, case["brief"]) == (SPOT_AT_OPEN, "spot", None)
        return
    assert (open_px, source) == (case["open"], "oracle")
    m = ie.BRIEF_RE.search(brief("NEAR/USD", case["spot"], open_px))
    assert m and m.group(2) == case["brief"]


def test_payload_sides_match_the_spectator_fixture():
    sets = er.payload_sets(er.SPECTATOR.read_text())
    for name in ("train", "holdout"):
        assert [ie.pushed_side(p, None) for p in sets[name]] == FIXTURE["sides"][name], name
