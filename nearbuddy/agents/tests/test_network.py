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

OVERRIDES = ("NEAR_RPC", "NEAR_RPC_FALLBACK", "ARENA_CONTRACT", "SOLVER_ID")


@pytest.fixture
def load(monkeypatch):
    def _load(network: str | None):
        monkeypatch.setattr(dotenv, "dotenv_values", lambda *_a, **_k: {})
        for k in OVERRIDES:
            monkeypatch.delenv(k, raising=False)
        if network is None:
            monkeypatch.delenv("NEAR_NETWORK", raising=False)
        else:
            monkeypatch.setenv("NEAR_NETWORK", network)
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


def test_env_override_still_wins(load, monkeypatch):
    monkeypatch.setenv("ARENA_CONTRACT", "arena.other.near")
    monkeypatch.setattr(dotenv, "dotenv_values", lambda *_a, **_k: {})
    monkeypatch.setenv("NEAR_NETWORK", "mainnet")
    importlib.reload(importlib.import_module("config"))
    assert importlib.reload(importlib.import_module("chain")).ARENA == "arena.other.near"


def test_unknown_network_refused(load):
    with pytest.raises(ValueError, match="NEAR_NETWORK=Mainnet: testnet or mainnet"):
        load("Mainnet")


@pytest.mark.skipif(shutil.which("bun") is None, reason="bun not on PATH")
def test_same_table_as_typescript():
    script = 'import { NETWORKS } from "./packages/protocol/src/network.ts"; console.log(JSON.stringify(NETWORKS))'
    out = subprocess.run(["bun", "-e", script], cwd=AGENTS.parent, capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == importlib.import_module("config").NETWORKS
