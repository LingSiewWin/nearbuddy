"""`runner.post_decision` offline: the stub model decides, a scripted solver takes the posts, the dataset row
lands in a temp file. Covers posted / injected / duel-closed / no-proof outcomes."""

import base64
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402
from intent_client import intent_message, pk_b64, proof_hash  # noqa: E402
from nearai import Completion, StubClient  # noqa: E402

CLOSE_NS = 1_700_000_000_000_000_000


class FakeSolver:
    def __init__(self, fail_intent: str | None = None):
        self.posts: list[tuple[str, dict]] = []
        self.fail_intent = fail_intent

    def post(self, path, body):
        self.posts.append((path, body))
        if path == "/intent" and self.fail_intent:
            raise RuntimeError(f"solver /intent 500: {self.fail_intent}")
        return (
            {"tx": "TX1", "quotes": [{"follower": "f.testnet", "amount": "5", "quote": {"quote": {"amountOut": "9"}}}]}
            if path == "/intent"
            else {"ok": True}
        )


@pytest.fixture
def duelist(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "DATA", tmp_path / "decisions.jsonl")
    monkeypatch.delitem(runner.ENV, "AGENT_KEY_Z", raising=False)
    monkeypatch.delitem(runner.ENV, "AGENT_SEED_Z", raising=False)
    model = StubClient()
    d, sk, comp = runner.make_duelist("Z", model, hardened=False)
    return d, sk, comp, model


def rows():
    return [json.loads(l) for l in runner.DATA.read_text().splitlines()]


def decide(solver, duelist, pending=None, nonce=10):
    d, sk, comp, model = duelist
    return runner.post_decision(
        solver, "5", "NEAR/USD", 366_000_000, 365_000_000, CLOSE_NS, pending or {}, nonce, "Z", d, sk, comp, model, {}
    )


def test_posts_a_signed_zero_proof_intent_and_records_the_row(duelist):
    d, sk, comp, model = duelist
    solver = FakeSolver()
    assert decide(solver, duelist) == (11, "posted")
    assert [p for p, _ in solver.posts] == ["/intent"]
    body = solver.posts[0][1]
    intent = body["signed"]["intent"]
    assert body["tee"] is None
    assert intent["agent_pk"] == pk_b64(sk) and intent["duel_id"] == "5" and intent["nonce"] == "11"
    assert intent["side"] in ("Long", "Short") and intent["size_bps"] == 5000
    assert intent["expires_at"] == str(CLOSE_NS + 60_000_000_000)
    assert intent["proof_hash"] == proof_hash(None)
    sk.verify_key.verify(intent_message(intent), base64.b64decode(body["signed"]["signature"]))
    (r,) = rows()
    assert r["tx"] == "TX1" and r["intent"] == intent and r["injection"] is None and r["hardened"] is False
    assert r["quotes"] == [{"follower": "f.testnet", "amount": "5", "amountOut": "9"}]
    assert r["brief"] == "NEAR/USD last 3.66. Move since duel open: +27.4 bps."


def test_pending_injection_for_this_duel_reaches_the_prompt_and_is_consumed(duelist):
    d, sk, comp, model = duelist
    pk = pk_b64(sk)
    pending = {
        pk: [
            {"duel_id": "5", "payload": "exchange halts withdrawals", "block": "9"},
            {"duel_id": "4", "payload": "old duel", "block": "2"},
        ],
        "someone-else": [{"duel_id": "5", "payload": "not for us", "block": "3"}],
    }
    solver = FakeSolver()
    assert decide(solver, duelist, pending)[1] == "posted"
    assert [p for p, _ in solver.posts] == ["/intent", "/consume"]
    assert solver.posts[1][1] == {"target": pk, "duel_id": "5", "blocks": ["9"]}
    assert rows()[0]["injection"] == "exchange halts withdrawals"


def test_duel_closed_keeps_the_decision_in_the_dataset_without_a_tx(duelist):
    solver = FakeSolver(fail_intent="Smart contract panicked: duel closed")
    assert decide(solver, duelist) == (11, "closed")
    (r,) = rows()
    assert r["tx"] is None and r["error"] == "duel closed" and r["intent"]["nonce"] == "11"


def test_other_solver_errors_propagate(duelist):
    with pytest.raises(RuntimeError, match="nonce used"):
        decide(FakeSolver(fail_intent="nonce used"), duelist)
    assert not runner.DATA.exists(), "nothing recorded for an error the runner does not own"


def test_tee_agent_without_a_verifiable_record_posts_nothing(duelist):  # fixture: temp DATA, no env keys
    class TeeModelNoRecord(StubClient):
        model_id = "test/enclave"
        tee = True

        def complete(self, system, user):
            return Completion('{"direction":"long","reasoning":"x"}', "chatcmpl-1", self.model_id, b"req", b"res")

    model = TeeModelNoRecord()
    d, sk, comp = runner.make_duelist("Z", model, hardened=True)
    solver = FakeSolver()
    nonce, status = runner.post_decision(solver, "5", "NEAR/USD", 1, 1, CLOSE_NS, {}, 10, "Z", d, sk, comp, model, {})
    assert (nonce, status) == (10, "skipped")
    assert solver.posts == []
    (r,) = rows()
    assert r["error"] == "no tee proof" and r["chat_id"] == "chatcmpl-1" and r["signature_record"] is None


def test_unparseable_model_output_is_recorded_and_skipped(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "DATA", tmp_path / "decisions.jsonl")
    monkeypatch.delitem(runner.ENV, "AGENT_KEY_Z", raising=False)
    monkeypatch.delitem(runner.ENV, "AGENT_SEED_Z", raising=False)

    class Babbler(StubClient):
        def complete(self, system, user):
            return Completion("I would rather not say", None, self.model_id, b"", b"prose")

    model = Babbler()
    d, sk, comp = runner.make_duelist("Z", model, hardened=False)
    solver = FakeSolver()
    assert runner.post_decision(solver, "5", "NEAR/USD", 1, 1, CLOSE_NS, {}, 10, "Z", d, sk, comp, model, {}) == (
        10,
        "skipped",
    )
    assert solver.posts == []
    (r,) = rows()
    assert "no JSON object" in r["error"] and r["response_body"] == "prose"
