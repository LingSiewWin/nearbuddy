import socket
import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import intent_client  # noqa: E402
from intent_client import Solver  # noqa: E402


def closed_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_a_real_closed_port_reads_as_refused():
    with pytest.raises(requests.ConnectionError) as e:
        Solver(f"http://127.0.0.1:{closed_port()}", restart_wait_s=0).get("/arena")
    assert intent_client._refused(e.value)


class Ok:
    status_code = 200

    def json(self):
        return {"ok": True}


def test_refused_is_retried_until_the_solver_is_back(monkeypatch):
    calls = []

    def request(method, url, **kw):
        calls.append(method)
        if len(calls) < 3:
            raise requests.ConnectionError("[Errno 61] Connection refused")
        return Ok()

    monkeypatch.setattr(intent_client.requests, "request", request)
    monkeypatch.setattr(intent_client.time, "sleep", lambda _s: None)
    assert Solver("http://x", "s").post("/intent", {}) == {"ok": True}
    assert calls == ["POST"] * 3


def test_a_dropped_connection_is_not_resent(monkeypatch):
    calls = []

    def request(method, url, **kw):
        calls.append(method)
        raise requests.ConnectionError("('Connection aborted.', RemoteDisconnected('closed'))")

    monkeypatch.setattr(intent_client.requests, "request", request)
    with pytest.raises(requests.ConnectionError):
        Solver("http://x", "s").post("/intent", {})
    assert calls == ["POST"]  # the intent may have landed: never sent twice
