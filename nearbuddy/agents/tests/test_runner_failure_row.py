"""A model that babbles instead of answering: the failure row keeps the exact request bytes the client sent (and
their sha256), so the prompt and the max_tokens cap of a failed call are reproducible."""

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import nearai  # noqa: E402
import runner  # noqa: E402

BABBLE = "Here's a thinking process:\n\n1.  **Analyze User Input:**\n   - Asset: NEAR/USD"


class Reply:
    def __init__(self, body: dict):
        self.content = json.dumps(body).encode()
        self._body = body

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._body


def test_unparseable_reply_records_the_request_bytes_sent(tmp_path, monkeypatch):
    sent: list[bytes] = []
    reply = {
        "id": "chat-1",
        "model": "Qwen/Qwen3.6-35B-A3B-FP8",
        "choices": [{"message": {"role": "assistant", "content": BABBLE}, "finish_reason": "length"}],
        "usage": {"completion_tokens": 1800},
    }

    def fake_post(url, headers, data, timeout):
        sent.append(data)
        return Reply(reply)

    monkeypatch.setattr(nearai.requests, "post", fake_post)
    monkeypatch.setattr(runner, "DATA", tmp_path / "decisions.jsonl")
    monkeypatch.delitem(runner.ENV, "AGENT_KEY_Z", raising=False)
    monkeypatch.delitem(runner.ENV, "AGENT_SEED_Z", raising=False)
    model = nearai.NearAiClient("key", "Qwen/Qwen3.6-35B-A3B-FP8", base_url="http://model.invalid/v1")
    d, sk, comp = runner.make_duelist("Z", model, hardened=False)

    out = runner.prepare_decision("5", "NEAR/USD", 366_000_000, 365_000_000, 0, {}, 11, d, sk, comp, model, {})

    assert out is None  # no decision, nothing posted
    (row,) = [json.loads(line) for line in runner.DATA.read_text().splitlines()]
    assert row["error"].startswith("no JSON object in model output")
    (body,) = sent
    assert row["request_body"].encode() == body  # byte for byte what went over the wire
    assert row["request_hash"] == hashlib.sha256(body).hexdigest()
    assert row["response_body"].encode() == comp.last.response_bytes
    assert row["response_hash"] == hashlib.sha256(comp.last.response_bytes).hexdigest()
    sent_json = json.loads(row["request_body"])
    assert sent_json["max_tokens"] == 1800  # the pair 2 cap is now readable on a failure
    assert sent_json["messages"][1]["content"] == row["brief"]


class NotUtf8Reply(Reply):
    def __init__(self):
        self.content = b'{"id":"chat-2","choices":[{"message":{"content":"\xff"}}]}'


def test_a_body_that_is_not_utf8_skips_the_cycle_with_a_row(tmp_path, monkeypatch):
    """The client refuses a body it could not store losslessly; the runner records it and skips, like a 5xx."""
    monkeypatch.setattr(nearai.requests, "post", lambda url, headers, data, timeout: NotUtf8Reply())
    monkeypatch.setattr(runner, "DATA", tmp_path / "decisions.jsonl")
    monkeypatch.delitem(runner.ENV, "AGENT_KEY_Z", raising=False)
    monkeypatch.delitem(runner.ENV, "AGENT_SEED_Z", raising=False)
    model = nearai.NearAiClient("key", "Qwen/Qwen3.6-35B-A3B-FP8", base_url="http://model.invalid/v1")
    d, sk, comp = runner.make_duelist("Z", model, hardened=False)

    out = runner.prepare_decision("5", "NEAR/USD", 366_000_000, 365_000_000, 0, {}, 11, d, sk, comp, model, {})

    assert out is None
    (row,) = [json.loads(line) for line in runner.DATA.read_text().splitlines()]
    assert row["error"].startswith("model body not UTF-8")
    assert "response_body" not in row
