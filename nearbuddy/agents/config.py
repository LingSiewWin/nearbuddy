"""Shared settings for the arena agents: the merged `.env` + process environment and the data paths."""

from __future__ import annotations

import os
import re
from pathlib import Path

from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# a bare `KEY` line in .env reads as None; drop it so every value is a str
ENV: dict[str, str] = {
    **{k: v for k, v in dotenv_values(ROOT / ".env").items() if v is not None},
    **os.environ,
}
# Same table as packages/protocol/src/network.ts (tests/test_network.py fails when they drift).
# NEAR_NETWORK picks the row; NEAR_RPC, ARENA_CONTRACT, SOLVER_ID, ... still override single values.
NETWORKS: dict[str, dict[str, str]] = {
    "testnet": {
        "rpc": "https://near-testnet.drpc.org",
        "fallback": "https://test.rpc.fastnear.com",
        "explorer": "https://testnet.nearblocks.io",
        "arena": "arena.nearbuddy-solver.testnet",
        "solver": "nearbuddy-solver.testnet",
        "owner": "nearbuddy-owner.testnet",
        "oracle": "price-oracle.testnet",
    },
    "mainnet": {
        "rpc": "https://free.rpc.fastnear.com",
        "fallback": "https://near.drpc.org",
        "explorer": "https://nearblocks.io",
        "arena": "arena.nearbuddy.near",
        "solver": "solver.nearbuddy.near",
        "owner": "nearbuddy.near",
        "oracle": "price-oracle.near",
    },
}
NETWORK = ENV.get("NEAR_NETWORK", "testnet")
if NETWORK not in NETWORKS:
    raise ValueError(f"NEAR_NETWORK={NETWORK}: testnet or mainnet")
NET = NETWORKS[NETWORK]

# Same rule as assertNetworkConfig in network.ts: an override that names the other network stops the process.
OVERRIDES = (
    "NEAR_RPC",
    "NEAR_RPC_FALLBACK",
    "NEAR_SEND_RPC",
    "ARENA_CONTRACT",
    "SOLVER_ID",
    "ORACLE_ACCOUNT",
    "FOLLOWER_ID",
    "SPECTATOR_ID",
    "JOIN_ACCOUNT",
    "COPIER_RPC",
    "COPIER_TX_API",
)
FOREIGN = {
    "mainnet": re.compile(r"testnet|(^|[/.])test\."),
    "testnet": re.compile(r"\.near$|mainnet|//(free\.)?rpc\.fastnear\.com|//near\.drpc\.org"),
}


def assert_network_config(network: str, env: dict[str, str]) -> None:
    bad = [k for k in OVERRIDES if env.get(k) and FOREIGN[network].search(env[k])]
    if bad:
        pairs = ", ".join(f"{k}={env[k]}" for k in bad)
        raise ValueError(f"NEAR_NETWORK={network} but {pairs} belongs to the other network: fix or unset")


assert_network_config(NETWORK, ENV)


def network_file(path: Path, network: str = NETWORK) -> Path:
    """Persisted state per network, as networkFile in network.ts: testnet keeps `path` (nothing moves), any other
    network gets `-<network>` before the suffix (`decisions.jsonl` -> `decisions-mainnet.jsonl`)."""
    if network == "testnet":
        return path
    return path.with_name(f"{path.stem}-{network}{path.suffix}")


DATA = network_file(HERE / "data" / "decisions.jsonl")
ATTEST_DIR = network_file(HERE / "data" / "attestations")
