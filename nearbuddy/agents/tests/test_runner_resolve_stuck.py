import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402
from intent_client import Solver  # noqa: E402

SEED_A = "11" * 32
SEED_B = "22" * 32


def test_arena_pks_covers_every_registration_and_skips_unseeded(monkeypatch):
    for k in ("AGENT_KEY_A", "AGENT_KEY_B", "AGENT_SEED_B"):
        monkeypatch.delitem(runner.ENV, k, raising=False)
    monkeypatch.setitem(runner.ENV, "AGENT_SEED_A", SEED_A)
    pks = runner.arena_pks()
    assert len(pks) == 4 == len(set(pks))  # plain, tee, swap, tee+swap; B has no seed so no stable key
    assert runner.pk_b64(runner.agent_key("A", True, "")) in pks
    assert runner.pk_b64(runner.agent_key("A", False, "swap")) in pks
    monkeypatch.setitem(runner.ENV, "AGENT_KEY_B", SEED_B)
    assert len(runner.arena_pks()) == 5  # a builder key is the seed itself: one key whatever the tier or tag


def test_resolve_stuck_resolves_each_stuck_duel_and_reports_what_is_left(monkeypatch):
    for k in ("AGENT_KEY_A", "AGENT_KEY_B"):
        monkeypatch.delitem(runner.ENV, k, raising=False)
    monkeypatch.setitem(runner.ENV, "AGENT_SEED_A", SEED_A)
    monkeypatch.setitem(runner.ENV, "AGENT_SEED_B", SEED_B)
    stuck_a = runner.pk_b64(runner.agent_key("A", True, ""))
    stuck_b = runner.pk_b64(runner.agent_key("B", False, ""))
    in_duel = {stuck_a: "7", stuck_b: "8"}
    resolved: list[str] = []

    def view(method: str, args: dict[str, Any]) -> Any:
        if method == "get_agent":
            return {"in_duel": in_duel.get(args["agent_pk"])}
        assert method == "get_duel"
        return {"close_at": "0"}  # closed long ago: no wait

    def resolve(_solver: Solver, duel_id: str) -> dict[str, Any]:
        resolved.append(duel_id)
        if duel_id == "7":  # duel 8's oracle callback never lands, so B stays stuck
            del in_duel[stuck_a]
        return {"tx": "t", "txs": ["t"], "outcome": None}

    monkeypatch.setattr(runner, "view", view)
    monkeypatch.setattr(runner, "resolve_duel", resolve)
    assert runner.resolve_stuck(Solver("http://x", "s")) == [stuck_b]
    assert sorted(resolved) == ["7", "8"]
