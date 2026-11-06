import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402
from intent_client import Solver  # noqa: E402


class FakeSolver(Solver):
    """Scripted `GET /agent_duel` answers, in order; records every path asked."""

    def __init__(self, duel_ids: list[str | None]) -> None:
        self.answers = list(duel_ids)
        self.paths: list[str] = []

    def get(self, path: str) -> dict[str, Any]:
        self.paths.append(path)
        return {"agent_pk": "x", "registered": True, "duel_id": self.answers.pop(0)}


def test_wait_for_duel_polls_until_paired_and_encodes_the_pk(monkeypatch):
    naps: list[int] = []
    monkeypatch.setattr(time, "sleep", naps.append)
    solver = FakeSolver([None, None, "12"])
    assert runner.wait_for_duel(solver, "a+b/c=", 7) == "12"
    assert naps == [7, 7]
    assert solver.paths == ["/agent_duel?pk=a%2Bb%2Fc%3D"] * 3  # '+' '/' '=' never reach the solver raw


def test_wait_for_duel_skips_the_duel_just_played(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda _s: None)
    solver = FakeSolver(["12", "12", None, "13"])
    assert runner.wait_for_duel(solver, "pk", 1, skip="12") == "13"
    assert len(solver.paths) == 4
