"""Coinbase spot: the default host, the NEARBUDDY_COINBASE_URL stand-in of the offline sandbox run, parsing."""

import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prices  # noqa: E402


class _Resp:
    def raise_for_status(self):
        pass

    def json(self):
        return {"data": {"amount": "3.6612"}}


def spot_url(monkeypatch, env_value):
    if env_value is None:
        monkeypatch.delenv("NEARBUDDY_COINBASE_URL", raising=False)
    else:
        monkeypatch.setenv("NEARBUDDY_COINBASE_URL", env_value)
    mod = importlib.reload(prices)
    seen = []
    monkeypatch.setattr(mod.requests, "get", lambda url, timeout: seen.append(url) or _Resp())
    assert mod.coinbase_price("NEAR/USD") == 366_120_000
    return seen[0]


def test_default_is_coinbase(monkeypatch):
    assert spot_url(monkeypatch, None) == "https://api.coinbase.com/v2/prices/NEAR-USD/spot"


def test_stand_in_host(monkeypatch):
    assert spot_url(monkeypatch, "http://127.0.0.1:9") == "http://127.0.0.1:9/v2/prices/NEAR-USD/spot"
    monkeypatch.delenv("NEARBUDDY_COINBASE_URL")
    importlib.reload(prices)
