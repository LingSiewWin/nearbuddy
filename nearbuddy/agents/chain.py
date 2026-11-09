"""Read-only view calls against the arena contract over NEAR JSON-RPC."""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Mapping
from typing import Any

import requests

from arena_types import ArenaView, Outcome
from config import ENV, NET, NETWORK

RPC = ENV.get("NEAR_RPC", NET["rpc"])
# public endpoints rate-limit bursts; views retry with backoff and alternate with a second endpoint
RPC_FALLBACK = ENV.get("NEAR_RPC_FALLBACK", NET["fallback"])
RETRIES = 5
ARENA = ENV.get("ARENA_CONTRACT", NET["arena"])
# display symbol -> Outlayer asset id priced by NET["oracle"] (only wrap.near is served on testnet)
ASSETS = {"NEAR/USD": "wrap.near"}


def rpc(
    method: str,
    params: dict[str, Any],
    what: str = "",
    retries: int = RETRIES,
    timeout: float | tuple[float, float] = 30,
    first: int = 0,
) -> Any:
    """One JSON-RPC call with retries; rate limits and internal errors back off and alternate endpoints. `retries`
    and `timeout` bound a caller that has its own deadline (with the defaults one call can take minutes). `timeout`
    goes to requests as is: a float applies to connect and to each socket read separately, a (connect, read) pair
    splits it."""
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    what = what or method
    endpoints = [RPC, RPC_FALLBACK] if RPC_FALLBACK and RPC_FALLBACK != RPC else [RPC]
    last = ""
    for attempt in range(retries):
        url = endpoints[(attempt + first) % len(endpoints)]
        try:
            resp = requests.post(url, json=body, headers={"User-Agent": "nearbuddy/1"}, timeout=timeout)
            r = resp.json()
        except (requests.RequestException, ValueError) as exc:
            last = f"{url} {what}: {exc}"
            if attempt + 1 < retries:
                time.sleep(2**attempt)
            continue
        if "error" in r:
            msg = str(r["error"].get("message", r["error"]))
            last = f"{url} {what}: {msg}"
            transient = resp.status_code == 429 or "rate limit" in msg.lower() or "internal" in msg.lower()
            if not transient:
                raise RuntimeError(last)
            if attempt + 1 < retries:
                time.sleep(2**attempt)
            continue
        return r["result"]
    raise RuntimeError(f"after {retries} attempts: {last}")


def _view(
    method: str, args: Mapping[str, object], retries: int = RETRIES, timeout: float | tuple[float, float] = 30
) -> Any:
    """`retries` and `timeout` as in `rpc`: a caller on a deadline passes one attempt with a short timeout."""
    result = rpc(
        "query",
        {
            "request_type": "call_function",
            "finality": "final",
            "account_id": ARENA,
            "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
        },
        method,
        retries,
        timeout,
    )
    return json.loads(bytes(result["result"]).decode())


# every call is checked against the contract ABI: method name, args and result type (arena_types.py)
view: ArenaView = _view


_now_reads = 0  # chain_now_ns alternates endpoints across calls, one attempt each


def chain_now_ns(timeout: float = 5) -> int:
    """Timestamp of the latest final block. The contract's `env::block_timestamp()` is at least this for any
    transaction sent now, so a check against it never runs ahead of the chain. One attempt of about `timeout`
    seconds, no backoff: the caller (runner.hold_until_lock) polls against a deadline and retries itself. The budget
    is split between connect and read, since requests applies a scalar to each phase and one call could take twice
    it. That is at most about `timeout` seconds per attempt in the common case; DNS and trickled reads are not
    bounded here, the runner bounds the wait on its own clock. Successive calls alternate RPC and fallback, so a dead
    endpoint costs every other read."""
    global _now_reads
    _now_reads += 1
    split = (timeout / 2, timeout / 2)
    return int(
        rpc("block", {"finality": "final"}, retries=1, timeout=split, first=_now_reads)["header"]["timestamp_nanosec"]
    )


def warn_if_arena_missing(network: str = NETWORK, arena: str = ARENA, rpc: str = RPC) -> bool:
    """Mainnet startup check, read-only (one view_account, no tx), as warnIfArenaMissing in chain.ts: the mainnet
    ids in config.NETWORKS are defaults for accounts not claimed yet. True when it warned; other RPC errors stay
    silent."""
    if network != "mainnet":
        return False
    body: dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "query",
        "params": {"request_type": "view_account", "finality": "final", "account_id": arena},
    }
    try:
        r = requests.post(rpc, json=body, headers={"User-Agent": "nearbuddy/1"}, timeout=15).json()
    except (requests.RequestException, ValueError):
        return False
    if (r.get("error") or {}).get("cause", {}).get("name") != "UNKNOWN_ACCOUNT":
        return False
    print(f"[network] mainnet arena {arena} does not exist (UNKNOWN_ACCOUNT on {rpc}); create it or set ARENA_CONTRACT")
    return True


def agent_tier_on_chain(pk: str) -> bool | None:
    """`get_agent(pk).tee`, or None when the agent is not registered yet."""
    a = view("get_agent", {"agent_pk": pk})
    return None if a is None else bool(a.get("tee"))


def wait_outcome(duel_id: str, timeout_s: int = 90) -> Outcome | None:
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
