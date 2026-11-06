import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import chain  # noqa: E402


class _Resp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def json(self):
        return self._payload


def test_view_alternates_endpoints_on_rate_limit(monkeypatch):
    calls: list[str] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(url)
        if len(calls) < 3:
            return _Resp({"error": {"message": "You reached Public endpoint rate limit"}}, 429)
        return _Resp({"result": {"result": list(b'{"ok": 1}')}})

    monkeypatch.setattr(chain.requests, "post", fake_post)
    monkeypatch.setattr(chain.time, "sleep", lambda s: None)
    assert chain.view("get_config", {}) == {"ok": 1}
    assert calls == [chain.RPC, chain.RPC_FALLBACK, chain.RPC]


def test_view_raises_contract_errors_immediately(monkeypatch):
    calls: list[str] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(url)
        return _Resp({"error": {"message": "wasm execution failed: agent missing"}}, 200)

    monkeypatch.setattr(chain.requests, "post", fake_post)
    with pytest.raises(RuntimeError, match="agent missing"):
        chain.view("get_agent", {"agent_pk": "x"})
    assert len(calls) == 1


def test_chain_now_reads_the_final_block_time_as_an_exact_int(monkeypatch):
    bodies: list[dict] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        bodies.append(json)
        return _Resp({"result": {"header": {"timestamp": 1.7e18, "timestamp_nanosec": "1793976786174123457"}}})

    monkeypatch.setattr(chain.requests, "post", fake_post)
    assert chain.chain_now_ns() == 1793976786174123457  # the float field would lose the low digits
    assert bodies[0]["method"] == "block" and bodies[0]["params"] == {"finality": "final"}


def test_chain_now_is_one_short_attempt_and_alternates_endpoints(monkeypatch):
    calls: list[tuple[str, float]] = []
    sleeps: list[float] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append((url, timeout))
        return _Resp({"error": {"message": "You reached Public endpoint rate limit"}}, 429)

    monkeypatch.setattr(chain.requests, "post", fake_post)
    monkeypatch.setattr(chain.time, "sleep", sleeps.append)
    for _ in range(2):
        with pytest.raises(RuntimeError, match="after 1 attempts"):
            chain.chain_now_ns(timeout=1.5)
    assert [t for _, t in calls] == [1.5, 1.5] and sleeps == [], "one attempt per call, no backoff"
    assert {u for u, _ in calls} == {chain.RPC, chain.RPC_FALLBACK}, "successive reads alternate endpoints"
