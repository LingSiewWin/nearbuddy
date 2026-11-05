"""Arena runner: pairs two model-backed duelists, drives one duel per round through the solver,
records open/close prices from Pyth, signs the resolution with the oracle key, and appends one
dataset row per decision to agents/data/decisions.jsonl.

    .venv/bin/python -m runner --rounds 2 --duel-seconds 60 --cycle-seconds 15

Agents are ed25519 keys derived from AGENT_SEED_A / AGENT_SEED_B (hex, 32 bytes) in the env file,
or fresh random keys when unset (then they are registered on every run).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from any cwd: `python agents/runner.py`
from typing import Any

from dotenv import dotenv_values
from nacl.signing import SigningKey

from duelist import Duelist, DuelistError
from intent_client import Solver, key_from_near_secret, pk_b64, proof_hash, sign_intent, sign_resolution
from nearai import StubClient, client_from_env
from prices import brief, price

ENV = {**dotenv_values(Path(__file__).resolve().parents[1] / ".env"), **os.environ}
DATA = Path(__file__).resolve().parent / "data" / "decisions.jsonl"


def agent_key(name: str) -> SigningKey:
    seed = ENV.get(f"AGENT_SEED_{name}", "")
    return SigningKey(bytes.fromhex(seed)) if seed else SigningKey.generate()


def make_duelist(name: str, model_client, hardened: bool) -> tuple[Duelist, SigningKey, Any]:
    sk = agent_key(name)

    def complete(system: str, user: str) -> str:
        text, chat_id = model_client.complete(system, user)
        complete.last = (text, chat_id)  # type: ignore[attr-defined]
        return text

    complete.last = ("", None)  # type: ignore[attr-defined]
    d = Duelist(address=pk_b64(sk), hardened=hardened, model=model_client.model_id, complete_fn=complete)
    return d, sk, complete


def record(row: dict[str, Any]) -> None:
    DATA.parent.mkdir(parents=True, exist_ok=True)
    with DATA.open("a") as f:
        f.write(json.dumps(row) + "\n")


def resolve_duel(solver: Solver, duel_id: str, open_px: int, close_px: int) -> dict[str, Any]:
    oracle = key_from_near_secret(ENV["ORACLE_KEY"])
    resolution = {"duel_id": duel_id, "open_price": str(open_px), "close_price": str(close_px)}
    return solver.post("/resolve", {"resolution": resolution, "oracle_sig": sign_resolution(oracle, resolution)})


def run(rounds: int, duel_seconds: int, cycle_seconds: int, symbol: str, solver_url: str, bond: str) -> list[dict[str, Any]]:
    if not ENV.get("ARENA_SECRET"):
        raise SystemExit("ARENA_SECRET missing in the env file: the solver refuses every POST without it")
    solver = Solver(solver_url, ENV["ARENA_SECRET"])
    oracle = key_from_near_secret(ENV["ORACLE_KEY"])
    model_a, model_b = client_from_env(ENV, "A"), client_from_env(ENV, "B")
    a, ska, ca = make_duelist("A", model_a, hardened=True)
    b, skb, cb = make_duelist("B", model_b, hardened=False)
    for sk, m in ((ska, model_a), (skb, model_b)):
        try:
            solver.post("/register", {"agent_pk": pk_b64(sk), "model_id": m.model_id, "bond": bond})
        except RuntimeError as e:
            if "agent exists" not in str(e):
                raise
    results = []
    nonce = int(time.time() * 1000)
    for rnd in range(rounds):
        close_at_ns = (time.time_ns() // 1_000_000_000 + duel_seconds) * 1_000_000_000
        opened = solver.post("/duel", {"a": pk_b64(ska), "b": pk_b64(skb), "symbol": symbol, "close_at": str(close_at_ns)})
        duel_id = str(opened["duel_id"])
        open_px = price(symbol, ENV.get('PYTH_API_KEY'))
        print(f"[round {rnd}] duel {duel_id} open {open_px / 1e8:,.2f} tx {opened['tx']}")
        closed = False
        while not closed and time.time_ns() < close_at_ns - 15_000_000_000:  # leave 15 s for model + chain round trip
            px = price(symbol, ENV.get('PYTH_API_KEY'))
            pending = solver.get("/arena")["pending"]
            for d, sk, comp, model in ((a, ska, ca, model_a), (b, skb, cb, model_b)):
                pk = pk_b64(sk)
                inj = [i for i in pending.get(pk, []) if i["duel_id"] == duel_id]
                injection_text = "\n".join(i["payload"] for i in inj) or None
                try:
                    decision = d.decide(symbol, brief(symbol, px, open_px), injection_text)
                except DuelistError as e:
                    record({"duel_id": duel_id, "agent_pk": pk, "model": model.model_id, "error": str(e)})
                    continue
                text, chat_id = comp.last
                sig_record = model.signature(chat_id) if chat_id else None
                nonce += 1
                intent = {
                    "agent_pk": pk, "duel_id": duel_id, "side": "Long" if decision.direction > 0 else "Short",
                    "size_bps": 5000, "nonce": str(nonce), "expires_at": str(close_at_ns + 60_000_000_000),
                    "proof_hash": proof_hash(sig_record),
                }
                row = {
                    "duel_id": duel_id, "agent_pk": pk, "model": model.model_id, "hardened": d.hardened,
                    "brief": brief(symbol, px, open_px), "injection": injection_text, "text": text, "chat_id": chat_id,
                    "signature_record": sig_record, "intent": intent,
                }
                try:
                    posted = solver.post("/intent", sign_intent(sk, intent))
                except RuntimeError as e:
                    if "duel closed" not in str(e):
                        raise
                    # chain clock passed close_at: keep the paid decision in the dataset, stop prompting this duel
                    record({**row, "tx": None, "error": "duel closed"})
                    print(f"  late intent for {pk[:8]} not posted (duel closed)")
                    closed = True
                    break
                if inj:
                    solver.post("/consume", {"target": pk, "duel_id": duel_id, "blocks": [i["block"] for i in inj]})
                record({**row, "tx": posted["tx"],
                        "quotes": [{"follower": q["follower"], "amount": q["amount"], "amountOut": (q.get("quote") or {}).get("quote", {}).get("amountOut")} for q in posted.get("quotes", [])]})
                print(f"  {'A' if sk is ska else 'B'} {intent['side']} nonce {nonce} tx {posted['tx']} quotes {len(posted.get('quotes', []))}")
            if not closed:
                time.sleep(cycle_seconds)
        while time.time_ns() < close_at_ns + 1_000_000_000:
            time.sleep(1)
        close_px = price(symbol, ENV.get('PYTH_API_KEY'))
        resolution = {"duel_id": duel_id, "open_price": str(open_px), "close_price": str(close_px)}
        resolved = solver.post("/resolve", {"resolution": resolution, "oracle_sig": sign_resolution(oracle, resolution)})
        print(f"[round {rnd}] close {close_px / 1e8:,.2f} resolve tx {resolved['tx']}")
        results.append({"duel_id": duel_id, "open": open_px, "close": close_px, "open_tx": opened["tx"], "resolve_tx": resolved["tx"]})
    return results


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--rounds", type=int, default=1)
    p.add_argument("--duel-seconds", type=int, default=60)
    p.add_argument("--cycle-seconds", type=int, default=15)
    p.add_argument("--symbol", default="BTC/USD")
    p.add_argument("--bond", default="100000000000000000000000")  # 0.1 NEAR
    p.add_argument("--resolve", help="resolve a closed duel id with the current price as open and close")
    args = p.parse_args()
    if args.resolve:
        px = price(args.symbol, ENV.get("PYTH_API_KEY"))
        print(json.dumps(resolve_duel(Solver(ENV.get("SOLVER_URL", "http://127.0.0.1:4020"), ENV.get("ARENA_SECRET", "")), args.resolve, px, px)))
        raise SystemExit(0)
    out = run(args.rounds, args.duel_seconds, args.cycle_seconds, args.symbol, ENV.get("SOLVER_URL", "http://127.0.0.1:4020"), args.bond)
    print(json.dumps(out, indent=2))
