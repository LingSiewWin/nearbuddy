"""A model API that keeps failing stops the run from opening duels: after N calls of one model in a row got a 5xx or
no answer, the current duel makes no more model calls, still closes and is resolved, and `run` raises ModelDown (the
CLI exits 75) instead of opening the next duel, so night-loop.sh's --health gate takes over."""

import sys
import time
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402
from config import ENV  # noqa: E402
from nearai import StubClient  # noqa: E402

S = 1_000_000_000


def http_error(status: int) -> requests.HTTPError:
    resp = requests.Response()
    resp.status_code = status
    return requests.HTTPError(f"{status} Server Error: Internal Server Error for url: x", response=resp)


def test_a_streak_is_per_model_and_an_answer_resets_it():
    o = runner.ModelOutage(limit=3)
    o.failed("a", http_error(500))
    o.failed("a", http_error(500))
    o.answered("a")
    o.failed("a", http_error(500))
    o.failed("a", http_error(500))
    o.failed("b", http_error(500))
    assert o.down() is None  # a: 2 since its last answer, b: 1
    o.failed("a", http_error(502))
    why = o.down()
    assert why is not None and why.startswith("model a: 3 calls in a row failed") and "502 Server Error" in why


def test_limit_0_never_trips():
    o = runner.ModelOutage(limit=0)
    for _ in range(10):
        o.failed("a", http_error(500))
    assert o.down() is None


def test_only_a_5xx_or_no_answer_counts_not_a_429_or_a_4xx():
    assert runner._model_down(http_error(500)) and runner._model_down(http_error(503))
    assert runner._model_down(requests.ConnectionError("reset")) and runner._model_down(requests.Timeout())
    assert not runner._model_down(http_error(429)) and not runner._model_down(http_error(400))


class Clock:
    def __init__(self) -> None:
        self.ns = 1_000 * S

    def sleep(self, s: float) -> None:
        self.ns += int(s * S)


class FakeSolver:
    """Opens duels 1, 2, ...; takes intents; no headlines pending."""

    def __init__(self, *_a) -> None:
        self.paths: list[str] = []
        self.opened = 0

    def post(self, path, _body):
        self.paths.append(path)
        if path == "/duel":
            self.opened += 1
            return {"duel_id": self.opened, "tx": f"open{self.opened}"}
        return {"tx": "T", "quotes": []} if path == "/intent" else {}

    def get(self, path):
        assert path == "/arena"
        return {"pending": {}}


@pytest.fixture
def arena(tmp_path, monkeypatch):
    """`run` offline on a fake clock: model A (stub) answers, model B gets a 500 on every call."""
    clock = Clock()
    monkeypatch.setattr(time, "time_ns", lambda: clock.ns)
    monkeypatch.setattr(time, "sleep", clock.sleep)
    monkeypatch.setattr(runner, "DATA", tmp_path / "decisions.jsonl")
    monkeypatch.setitem(ENV, "ARENA_SECRET", "k")
    for n in "AB":  # random keys: no chain read for an AGENT_KEY_* tier
        monkeypatch.delitem(ENV, f"AGENT_KEY_{n}", raising=False)
        monkeypatch.delitem(ENV, f"AGENT_SEED_{n}", raising=False)
    monkeypatch.setattr(runner, "MODEL_OUTAGE", runner.ModelOutage(limit=3))
    calls: list[str] = []

    def client(_env, name):
        m = StubClient(name)
        m.model_id = f"m/{name}"
        answer = m.complete

        def complete(system, user):
            calls.append(name)
            if name == "B":
                raise http_error(500)
            return answer(system, user)

        m.complete = complete  # type: ignore[method-assign]
        return m

    monkeypatch.setattr(runner, "client_from_env", client)
    monkeypatch.setattr(runner, "save_attestation", lambda _m: None)
    monkeypatch.setattr(runner, "view", lambda _m, _a: {"intent_lock_s": 10})
    monkeypatch.setattr(runner, "free_agents", lambda *_a: None)
    monkeypatch.setattr(runner, "duel_request", lambda *_a: {})
    monkeypatch.setattr(runner, "oracle_open_px", lambda *_a, **_k: (366_000_000, "oracle"))
    monkeypatch.setattr(runner, "price", lambda *_a: 366_000_000)
    resolved: list[tuple[str, int]] = []

    def resolve_duel(_solver, duel_id):
        resolved.append((duel_id, clock.ns))
        return {"tx": "R", "outcome": None}

    monkeypatch.setattr(runner, "resolve_duel", resolve_duel)
    solvers: list[FakeSolver] = []

    def solver(*a):
        solvers.append(FakeSolver(*a))
        return solvers[-1]

    monkeypatch.setattr(runner, "Solver", solver)
    return clock, calls, resolved, solvers


def test_run_resolves_the_duel_then_opens_no_new_one_after_n_failures_in_a_row(arena):
    clock, calls, resolved, solvers = arena
    start = clock.ns
    with pytest.raises(runner.ModelDown, match=r"model m/B: 3 calls in a row failed .*; duel 1 resolved, no new duel"):
        runner.run(5, 330, 30, "NEAR/USD", "http://127.0.0.1:1", "1", profile="naive")
    (s,) = solvers
    assert s.opened == 1  # 5 rounds asked for, one opened
    # A's answers do not hide B's outage; after B's third 500 no model is called again in this duel
    assert calls == ["A", "B", "A", "B", "A", "B"]
    assert s.paths.count("/intent") == 3
    # the duel still closed and was resolved: 330 s after the open, plus the 2 s margin
    ((duel_id, at),) = resolved
    assert duel_id == "1" and at >= start + 332 * S


def test_run_goes_on_while_failures_stay_under_the_limit(arena, monkeypatch):
    _, calls, resolved, solvers = arena
    monkeypatch.setattr(runner, "MODEL_OUTAGE", runner.ModelOutage(limit=0))
    out = runner.run(2, 330, 30, "NEAR/USD", "http://127.0.0.1:1", "1", profile="naive")
    assert [r["duel_id"] for r in out] == ["1", "2"] and len(resolved) == 2 and solvers[0].opened == 2
    assert calls.count("B") > 3
