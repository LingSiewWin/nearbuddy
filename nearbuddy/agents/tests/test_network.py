"""NEAR_NETWORK picks config.NET, and chain.py / summarize.py take their defaults from it. The env file is
stubbed out so a developer's .env cannot leak in; the modules are reloaded under each network."""

import importlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import dotenv
import pytest

AGENTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTS))

OVERRIDES = importlib.import_module("config").OVERRIDES


@pytest.fixture
def load(monkeypatch):
    def _load(network: str | None, **env: str):
        monkeypatch.setattr(dotenv, "dotenv_values", lambda *_a, **_k: {})
        for k in OVERRIDES:
            monkeypatch.delenv(k, raising=False)
        if network is None:
            monkeypatch.delenv("NEAR_NETWORK", raising=False)
        else:
            monkeypatch.setenv("NEAR_NETWORK", network)
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        config = importlib.reload(importlib.import_module("config"))
        return (
            config,
            importlib.reload(importlib.import_module("chain")),
            importlib.reload(importlib.import_module("summarize")),
        )

    yield _load
    monkeypatch.undo()  # restore the real env, then the modules other tests imported
    for m in ("config", "chain", "summarize"):
        importlib.reload(importlib.import_module(m))


def test_default_is_testnet(load):
    config, chain, summarize = load(None)
    assert config.NETWORK == "testnet"
    assert (chain.RPC, chain.RPC_FALLBACK) == ("https://near-testnet.drpc.org", "https://test.rpc.fastnear.com")
    assert chain.ARENA == summarize.ARENA == "arena.nearbuddy-solver.testnet"
    assert config.NET["solver"] == "nearbuddy-solver.testnet"
    assert config.NET["oracle"] == "price-oracle.testnet"


def test_mainnet_row(load):
    config, chain, summarize = load("mainnet")
    assert (chain.RPC, chain.RPC_FALLBACK) == ("https://free.rpc.fastnear.com", "https://near.drpc.org")
    assert summarize.RPC == "https://free.rpc.fastnear.com"
    assert chain.ARENA == summarize.ARENA == "arena.nearbuddy.near"
    assert config.NET["solver"] == "solver.nearbuddy.near"
    assert config.NET["oracle"] == "price-oracle.near"
    assert config.NET["explorer"] == "https://nearblocks.io"


def test_env_override_still_wins(load):
    _, chain, _ = load("mainnet", ARENA_CONTRACT="arena.other.near")
    assert chain.ARENA == "arena.other.near"


def test_unknown_network_refused(load):
    with pytest.raises(ValueError, match="NEAR_NETWORK=Mainnet: testnet or mainnet"):
        load("Mainnet")


@pytest.mark.skipif(shutil.which("bun") is None, reason="bun not on PATH")
def test_same_table_as_typescript():
    script = 'import { NETWORKS } from "./packages/protocol/src/network.ts"; console.log(JSON.stringify(NETWORKS))'
    out = subprocess.run(["bun", "-e", script], cwd=AGENTS.parent, capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == importlib.import_module("config").NETWORKS


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("NEAR_RPC", "https://near-testnet.drpc.org"),
        ("NEAR_RPC_FALLBACK", "https://test.rpc.fastnear.com"),
        ("NEAR_SEND_RPC", "https://rpc.testnet.near.org"),
        ("ARENA_CONTRACT", "arena.nearbuddy-solver.testnet"),
        ("SOLVER_ID", "nearbuddy-solver.testnet"),
    ],
)
def test_mainnet_refuses_testnet_override(load, key, value):
    with pytest.raises(ValueError, match=f"NEAR_NETWORK=mainnet but {key}="):
        load("mainnet", **{key: value})


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("ARENA_CONTRACT", "arena.nearbuddy.near"),
        ("SOLVER_ID", "solver.nearbuddy.near"),
        ("NEAR_RPC", "https://free.rpc.fastnear.com"),
        ("NEAR_RPC_FALLBACK", "https://near.drpc.org"),
        ("NEAR_SEND_RPC", "https://rpc.mainnet.near.org"),
    ],
)
def test_testnet_refuses_mainnet_override(load, key, value):
    with pytest.raises(ValueError, match=f"NEAR_NETWORK=testnet but {key}="):
        load("testnet", **{key: value})


def test_matching_overrides_and_the_1click_account_pass():
    config = importlib.import_module("config")
    config.assert_network_config(
        "testnet", {"ARENA_CONTRACT": "arena.nearbuddy-solver.testnet", "ONECLICK_ACCOUNT": "x.near"}
    )
    config.assert_network_config("mainnet", {"NEAR_RPC": "https://rpc.mainnet.near.org", "SOLVER_ID": "contest.near"})


def test_data_files_per_network(load):
    config, _, _ = load(None)
    assert config.DATA == config.HERE / "data" / "decisions.jsonl"  # testnet: nothing moves
    assert config.ATTEST_DIR == config.HERE / "data" / "attestations"
    config, _, _ = load("mainnet")
    assert config.DATA.name == "decisions-mainnet.jsonl"
    assert config.ATTEST_DIR.name == "attestations-mainnet"
    assert config.network_file(Path("/r/data/duels.json"), "mainnet") == Path("/r/data/duels-mainnet.json")
    assert config.network_file(Path("/r/dataset"), "mainnet") == Path("/r/dataset-mainnet")


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def test_warn_if_arena_missing(monkeypatch, capsys):
    chain = importlib.import_module("chain")
    calls: list[dict] = []
    reply: list[object] = [{"error": {"name": "HANDLER_ERROR", "cause": {"name": "UNKNOWN_ACCOUNT"}}}]

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(json)
        if isinstance(reply[0], Exception):
            raise reply[0]
        return _Resp(reply[0])

    monkeypatch.setattr(chain.requests, "post", fake_post)
    assert chain.warn_if_arena_missing("testnet", "a.testnet", "http://x") is False
    assert calls == []  # testnet never asks
    assert chain.warn_if_arena_missing("mainnet", "arena.nearbuddy.near", "http://x") is True
    assert calls[0]["params"]["request_type"] == "view_account"
    assert "mainnet arena arena.nearbuddy.near does not exist" in capsys.readouterr().out
    reply[0] = {"result": {"amount": "1"}}
    assert chain.warn_if_arena_missing("mainnet", "a.near", "http://x") is False
    reply[0] = chain.requests.ConnectionError("reset")
    assert chain.warn_if_arena_missing("mainnet", "a.near", "http://x") is False
    assert capsys.readouterr().out == ""
