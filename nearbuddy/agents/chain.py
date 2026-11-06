"""Read-only view calls against the arena contract over NEAR JSON-RPC."""

from __future__ import annotations

import base64
import json
import time
from typing import Any

import requests

from config import ENV, NET

RPC = ENV.get("NEAR_RPC", NET["rpc"])
# public endpoints rate-limit bursts; views retry with backoff and alternate with a second endpoint
RPC_FALLBACK = ENV.get("NEAR_RPC_FALLBACK", NET["fallback"])
RETRIES = 5
ARENA = ENV.get("ARENA_CONTRACT", NET["arena"])
# display symbol -> Outlayer asset id priced by NET["oracle"] (only wrap.near is served on testnet)
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
    endpoints = [RPC, RPC_FALLBACK] if RPC_FALLBACK and RPC_FALLBACK != RPC else [RPC]
    last = ""
    for attempt in range(RETRIES):
        url = endpoints[attempt % len(endpoints)]
        try:
            resp = requests.post(url, json=body, headers={"User-Agent": "nearbuddy/1"}, timeout=30)
            r = resp.json()
        except (requests.RequestException, ValueError) as exc:
            last = f"{url} {method}: {exc}"
            time.sleep(2**attempt)
            continue
        if "error" in r:
            msg = str(r["error"].get("message", r["error"]))
            last = f"{url} {method}: {msg}"
            transient = resp.status_code == 429 or "rate limit" in msg.lower() or "internal" in msg.lower()
            if not transient:
                raise RuntimeError(last)
            time.sleep(2**attempt)
            continue
        return json.loads(bytes(r["result"]["result"]).decode())
    raise RuntimeError(f"after {RETRIES} attempts: {last}")


def agent_tier_on_chain(pk: str) -> bool | None:
    """`get_agent(pk).tee`, or None when the agent is not registered yet."""
    a = view("get_agent", {"agent_pk": pk})
    return None if a is None else bool(a.get("tee"))


def wait_outcome(duel_id: str, timeout_s: int = 90) -> dict[str, Any] | None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            d = view("get_duel", {"duel_id": duel_id})
        except RuntimeError as exc:  # a throttled RPC must not kill a batch; the deadline bounds the wait
            print(f"  wait_outcome {duel_id}: {str(exc)[:80]}")
            d = None
        if d and d.get("outcome"):
            return d["outcome"]
        time.sleep(4)
    return None
