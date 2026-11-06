"""Both runner loops brief against oracle_open_px() (the duel's oracle open price, spot only when the callback never
lands), and every row of the duel records that open as `open_px` / `open_source`, so analysis can set aside briefs
built on the runner's own spot (the spectator labels its attacks from the oracle open)."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from nacl.signing import SigningKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402
from config import ENV  # noqa: E402


class Played(Exception):
    """play_duel was reached; carries the open it was handed."""


def stub_common(monkeypatch, opens: list[tuple[str, str]]):
    monkeypatch.setitem(ENV, "ARENA_SECRET", "k")
    monkeypatch.setattr(runner, "OPENS", {})
    model = SimpleNamespace(model_id="m", tee=True)
    monkeypatch.setattr(runner, "client_from_env", lambda _env, _name: model)
    monkeypatch.setattr(
        runner,
        "make_duelist",
        lambda *_a, **_k: (SimpleNamespace(variant="", prompt_variant="A"), SigningKey.generate(), None),
    )
    monkeypatch.setattr(runner, "save_attestation", lambda _m: None)

    def oracle_open_px(duel_id, symbol, wait_s):
        opens.append((duel_id, symbol))
        return 366_000_000, "spot"

    monkeypatch.setattr(runner, "oracle_open_px", oracle_open_px)

    def play_duel(_solver, duel_id, _symbol, open_px, *_a, **_k):
        raise Played(duel_id, open_px)

    monkeypatch.setattr(runner, "play_duel", play_duel)


def test_run_briefs_against_oracle_open_px(monkeypatch):
    opens: list[tuple[str, str]] = []
    stub_common(monkeypatch, opens)

    class FakeSolver:
        def __init__(self, *_a):
            pass

        def post(self, path, _body):
            return {"duel_id": 8, "tx": "t"} if path == "/duel" else {}

    monkeypatch.setattr(runner, "Solver", FakeSolver)
    monkeypatch.setattr(runner, "view", lambda _m, _a: {"intent_lock_s": 10})
    monkeypatch.setattr(runner, "free_agents", lambda *_a: None)
    monkeypatch.setattr(runner, "duel_request", lambda *_a: {})
    with pytest.raises(Played) as e:
        runner.run(1, 60, 6, "NEAR/USD", "http://127.0.0.1:1", "1")
    assert opens == [("8", "NEAR/USD")]
    assert e.value.args == ("8", 366_000_000)
    assert runner.OPENS == {"8": (366_000_000, "spot")}


def test_run_single_briefs_against_oracle_open_px(monkeypatch):
    opens: list[tuple[str, str]] = []
    stub_common(monkeypatch, opens)
    monkeypatch.setattr(runner, "Solver", lambda *_a: object())
    monkeypatch.setattr(runner, "agent_tier_on_chain", lambda _pk: True)
    monkeypatch.setattr(runner, "wait_for_duel", lambda *_a, **_k: "9")
    duel = {"close_at": str(10**19), "symbol": "wrap.near", "a": "x", "b": "y", "open_price": "999"}
    monkeypatch.setattr(runner, "view", lambda m, _a: duel if m == "get_duel" else {"intent_lock_s": 10})
    with pytest.raises(Played) as e:
        runner.run_single("A", True, 60, 6, "NEAR/USD", "http://127.0.0.1:1", "1")
    # the duel's stored open_price is not read directly: oracle_open_px decides (and says which source it used)
    assert opens == [("9", "NEAR/USD")]
    assert e.value.args == ("9", 366_000_000)
    assert runner.OPENS == {"9": (366_000_000, "spot")}


def test_every_row_of_the_duel_records_its_open(monkeypatch, tmp_path):
    data = tmp_path / "decisions.jsonl"
    monkeypatch.setattr(runner, "DATA", data)
    monkeypatch.setattr(runner, "OPENS", {"5": (366_000_000, "oracle")})
    runner.record({"duel_id": "5", "error": "transient: model"})
    runner.record({"duel_id": "5", "intent": {"side": "Long"}})
    runner.record({"duel_id": "6", "intent": {"side": "Short"}})  # a duel this process never opened
    rows = [json.loads(line) for line in data.read_text().splitlines()]
    assert [(r.get("open_px"), r.get("open_source")) for r in rows] == [
        (366_000_000, "oracle"),
        (366_000_000, "oracle"),
        (None, None),
    ]
