"""Shared settings for the arena agents: the merged `.env` + process environment and the data paths."""

from __future__ import annotations

import os
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

DATA = HERE / "data" / "decisions.jsonl"
ATTEST_DIR = HERE / "data" / "attestations"
