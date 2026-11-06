"""The two-sided runner briefs both models against the duel's on-chain open price (the one it is scored against),
waiting briefly for the oracle callback, and falls back to spot only when the callback has not landed."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402


class Clock:
    def __init__(self) -> None:
        self.t = 1_000.0

    def sleep(self, s: float) -> None:
        self.t += s


def setup(monkeypatch, duels):
    clock = Clock()
    monkeypatch.setattr(runner.time, "time", lambda: clock.t)
    monkeypatch.setattr(runner.time, "sleep", clock.sleep)
    monkeypatch.setattr(runner, "price", lambda *_a: 380_000_000)
    seen = iter(duels)
    monkeypatch.setattr(runner, "view", lambda m, a: next(seen))
    return clock


def test_waits_for_the_oracle_open_price(monkeypatch):
    clock = setup(monkeypatch, [{"open_price": None}, {"open_price": None}, {"open_price": "366000000"}])
    assert runner.oracle_open_px("7", "NEAR/USD", wait_s=20) == (366_000_000, "oracle")
    assert clock.t == 1_004.0


def test_falls_back_to_spot_when_the_callback_never_lands(monkeypatch):
    clock = setup(monkeypatch, [{"open_price": None}] * 20)
    assert runner.oracle_open_px("7", "NEAR/USD", wait_s=5) == (380_000_000, "spot")
    assert 1_005.0 <= clock.t < 1_008.0


def test_an_rpc_error_is_a_miss_not_a_crash(monkeypatch):
    setup(monkeypatch, [])

    def down(_m, _a):
        raise RuntimeError("after 5 attempts: rate limit")

    monkeypatch.setattr(runner, "view", down)
    assert runner.oracle_open_px("7", "NEAR/USD", wait_s=0) == (380_000_000, "spot")
