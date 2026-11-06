"""Read-only view calls against the arena contract over NEAR JSON-RPC."""

from __future__ import annotations

import base64
import json
import time
from typing import Any

import requests

from config import ENV

RPC = ENV.get("NEAR_RPC", "https://near-testnet.drpc.org")
ARENA = ENV.get("ARENA_CONTRACT", "arena.nearbuddy-solver.testnet")
# display symbol -> Outlayer asset id priced by price-oracle.testnet (only wrap.near is served on testnet)
ASSETS = {"NEAR/USD": "wrap.near"}


def view(method: str, args: dict[str, Any]) -> Any:
    body: dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "query",
        "params": {
            "request_type": "call_function",
            "finality": "final",
            "account_id": ARENA,
            "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
        },
    }
    r = requests.post(RPC, json=body, headers={"User-Agent": "nearbuddy/1"}, timeout=30).json()
    if "error" in r:
        raise RuntimeError(f"{RPC} {method}: {r['error'].get('message', r['error'])}")
    return json.loads(bytes(r["result"]["result"]).decode())


def agent_tier_on_chain(pk: str) -> bool | None:
    """`get_agent(pk).tee`, or None when the agent is not registered yet."""
    a = view("get_agent", {"agent_pk": pk})
    return None if a is None else bool(a.get("tee"))


def wait_outcome(duel_id: str, timeout_s: int = 90) -> dict[str, Any] | None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        d = view("get_duel", {"duel_id": duel_id})
        if d and d.get("outcome"):
            return d["outcome"]
        time.sleep(4)
    return None
