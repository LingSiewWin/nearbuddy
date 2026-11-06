"""The final reveals cannot be pushed past close_at: held commitments are revealed concurrently, every solver wait for
a reveal ends at close_at minus REVEAL_MARGIN_S (restart retries and the answer alike)."""

import json
import socket
import sys
import threading
import time
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402
from intent_client import DeadlineError, Solver  # noqa: E402

S = 1_000_000_000


@pytest.fixture
def data(tmp_path, monkeypatch):
    path = tmp_path / "decisions.jsonl"
    monkeypatch.setattr(runner, "DATA", path)
    return path


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def held(*labels, deadline_ns=None):
    def commitment(label, nonce):
        intent = {"agent_pk": f"pk{label}", "side": "Long", "nonce": str(nonce)}
        return runner.Commitment(
            label, {"intent": intent, "signature": "s"}, b"\0" * 32, None, {"agent_pk": f"pk{label}"}, deadline_ns
        )

    return {label: commitment(label, n) for n, label in enumerate(labels, 1)}


def test_reveal_all_sends_both_reveals_at_once(data):
    both_in_flight = threading.Barrier(2, timeout=5)

    class SlowQuotes:
        """Each /reveal blocks until the other one is in flight too: a sequential reveal_all breaks the barrier."""

        def post(self, path, body, deadline_ns=None):
            assert path == "/reveal"
            both_in_flight.wait()
            return {"tx": f"R{body['signed']['intent']['nonce']}", "quotes": []}

    h = held("A", "B")
    runner.reveal_all(SlowQuotes(), h)
    assert h == {}
    assert sorted(r["revealed_tx"] for r in rows(data)) == ["R1", "R2"]


def test_one_failed_reveal_does_not_stop_the_other_and_rows_never_interleave(data):
    class OneDown:
        def post(self, path, body, deadline_ns=None):
            if body["signed"]["intent"]["nonce"] == "1":
                raise requests.ConnectionError("connection reset")
            return {"tx": "R2", "quotes": []}

    runner.reveal_all(OneDown(), held("A", "B"))
    rs = rows(data)  # every line parses: no interleaved writes
    assert sorted((r["agent_pk"], r["revealed_tx"]) for r in rs) == [("pkA", None), ("pkB", "R2")]


def closed_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_a_solver_restart_cannot_push_the_reveal_past_its_deadline():
    solver = Solver(f"http://127.0.0.1:{closed_port()}", "k")  # refused, as while night-loop restarts the solver
    assert solver.restart_wait_s == 120
    t0 = time.monotonic()
    with pytest.raises(requests.ConnectionError):
        solver.post("/reveal", {}, deadline_ns=time.time_ns() + int(1.5 * S))
    assert time.monotonic() - t0 < 4, "the 120 s restart retry stopped at the deadline"


def test_a_solver_that_never_answers_is_not_waited_for_past_the_deadline():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)  # accepts, never answers: a reveal stuck behind slow follower quotes
    try:
        solver = Solver(f"http://127.0.0.1:{srv.getsockname()[1]}", "k")
        t0 = time.monotonic()
        with pytest.raises(requests.Timeout):
            solver.post("/reveal", {}, deadline_ns=time.time_ns() + 1 * S)
        assert time.monotonic() - t0 < 4
    finally:
        srv.close()


def test_a_reveal_past_its_deadline_is_not_sent_and_is_reported_loudly(data, capsys):
    solver = Solver(f"http://127.0.0.1:{closed_port()}", "k")
    with pytest.raises(DeadlineError):
        solver.post("/reveal", {}, deadline_ns=time.time_ns() - S)
    runner.reveal_all(solver, held("B", deadline_ns=time.time_ns() - S))
    out = capsys.readouterr().out
    assert "REVEAL DEADLINE PASSED for B" in out and "no_reveal_bps" in out
    assert rows(data)[0]["error"].startswith("reveal failed: solver /reveal: deadline passed")


def test_commitments_carry_close_at_minus_the_margin():
    clock_close = 100 * S
    p = runner.Commitment("A", {}, b"", None, {}, clock_close - runner.REVEAL_MARGIN_S * S)
    assert p.deadline_ns == 95 * S
