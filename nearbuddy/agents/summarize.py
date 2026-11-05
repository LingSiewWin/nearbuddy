"""Summarise agents/data/decisions.jsonl joined with on-chain duel state.

    .venv/bin/python -m summarize            # table: duel, open->close, A call, B call, injections, outcome
"""

from __future__ import annotations

import base64
import json
import sys
from collections import defaultdict
from pathlib import Path

import requests

RPC = "https://rpc.testnet.near.org"
ARENA = "arena.nearbuddy-solver.testnet"
DATA = Path(__file__).resolve().parent / "data" / "decisions.jsonl"


def view(method: str, args: dict) -> dict | list | None:
    body = {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
        "request_type": "call_function", "finality": "final", "account_id": ARENA, "method_name": method,
        "args_base64": base64.b64encode(json.dumps(args).encode()).decode()}}
    r = requests.post(RPC, json=body, timeout=30).json()
    if "error" in r or "error" in r.get("result", {}):
        return None
    return json.loads(bytes(r["result"]["result"]))


def main() -> None:
    rows = [json.loads(l) for l in DATA.read_text().splitlines() if l.strip()]
    by_duel: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_duel[r["duel_id"]].append(r)
    print(f"{'duel':>4}  {'open':>10} -> {'close':>10}  {'A last':6} {'B last':6}  inj  outcome")
    for duel_id in sorted(by_duel, key=int):
        d = view("get_duel", {"duel_id": duel_id})
        if not d:
            print(f"{duel_id:>4}  (not on chain)")
            continue
        last = {"A": "-", "B": "-"}
        for r in by_duel[duel_id]:
            if "intent" in r:
                side = r["intent"]["side"]
                last["A" if r.get("hardened") else "B"] = side
        inj = len(d["injections"])
        a_pnl = b_pnl = None
        price = ""
        # outcome from the dataset is not stored; infer from the resolve event is not available via view,
        # so show resolved flag and the two last calls; alpha deltas are in `leaderboard`.
        status = "resolved" if d["resolved"] else "OPEN"
        print(f"{duel_id:>4}  {'':>10}    {'':>10}  {last['A']:6} {last['B']:6}  {inj:3}  {status}")
    board = view("leaderboard", {}) or []
    print("\nleaderboard")
    for a in board:
        print(f"  {a['model_id']:28} alpha {a['alpha_bps']:>5} bps  shield {a['shield']}  bond {int(a['bond'])/1e24:.3f} NEAR")
    print(f"\n{len(rows)} decision rows, {len(by_duel)} duels in the dataset, {sum(1 for r in rows if r.get('signature_record'))} with a TEE signature record")


if __name__ == "__main__":
    main()
