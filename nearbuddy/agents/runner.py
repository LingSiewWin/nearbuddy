"""Arena runner: pairs two model-backed duelists, drives one duel per round through the solver, hands
each decision's enclave signature to the contract as a `TeeProof`, asks the Outlayer oracle to resolve,
and appends one dataset row per decision (with the exact request and response bytes) to
agents/data/decisions.jsonl.

    .venv/bin/python -m runner --rounds 2 --duel-seconds 90 --cycle-seconds 20

Agents are ed25519 keys derived from AGENT_SEED_A / AGENT_SEED_B (hex, 32 bytes) in the env file,
or fresh random keys when unset (then they are registered on every run). With NEAR_AI_API_KEY set the
agents are registered as TEE-backed and the contract refuses any intent without a verified proof.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from any cwd: `python agents/runner.py`
from typing import Any

import requests
from dotenv import dotenv_values
from nacl.signing import SigningKey

from duelist import Duelist, DuelistError
from intent_client import Solver, TeeProofError, pk_b64, proof_hash, sign_intent, tee_proof
from nearai import Completion, client_from_env
from prices import brief, price

ENV = {**dotenv_values(Path(__file__).resolve().parents[1] / ".env"), **os.environ}
DATA = Path(__file__).resolve().parent / "data" / "decisions.jsonl"
ATTEST_DIR = Path(__file__).resolve().parent / "data" / "attestations"
RPC = ENV.get("NEAR_RPC", "https://near-testnet.drpc.org")
ARENA = ENV.get("ARENA_CONTRACT", "arena.nearbuddy-solver.testnet")
# display symbol -> Outlayer asset id priced by price-oracle.testnet (only wrap.near is served on testnet)
ASSETS = {"NEAR/USD": "wrap.near"}


def agent_key(name: str, tee: bool) -> SigningKey:
    """Demo keys come straight from AGENT_SEED_*; TEE-backed duelists use a key derived from the same seed, so
    the plain demo agents and the enclave-proved agents are distinct registrations on chain."""
    seed = ENV.get(f"AGENT_SEED_{name}", "")
    if not seed:
        return SigningKey.generate()
    raw = bytes.fromhex(seed)
    return SigningKey(hashlib.sha256(raw + b"tee").digest() if tee else raw)


def make_duelist(name: str, model_client, hardened: bool) -> tuple[Duelist, SigningKey, Any]:
    sk = agent_key(name, model_client.tee)

    def complete(system: str, user: str) -> str:
        c: Completion = model_client.complete(system, user)
        complete.last = c  # type: ignore[attr-defined]
        return c.text

    complete.last = Completion("", None, model_client.model_id)  # type: ignore[attr-defined]
    d = Duelist(address=pk_b64(sk), hardened=hardened, model=model_client.model_id, complete_fn=complete)
    return d, sk, complete


def record(row: dict[str, Any]) -> None:
    DATA.parent.mkdir(parents=True, exist_ok=True)
    with DATA.open("a") as f:
        f.write(json.dumps(row) + "\n")


def view(method: str, args: dict) -> Any:
    body = {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"request_type": "call_function", "finality": "final", "account_id": ARENA, "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode()}}
    r = requests.post(RPC, json=body, headers={"User-Agent": "nearbuddy/1"}, timeout=30).json()
    if "error" in r:
        raise RuntimeError(f"{RPC} {method}: {r['error'].get('message', r['error'])}")
    return json.loads(bytes(r["result"]["result"]).decode())


def save_attestation(model_client) -> str | None:
    """Fetch and keep the enclave attestation once per model per run; the file is the raw material a third
    party feeds to NVIDIA NRAS and dcap-qvl to check the signer we trust on chain."""
    att = model_client.attestation()
    if not att:
        return None
    ATTEST_DIR.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9._-]", "_", model_client.model_id) + f"-{int(time.time())}.json"
    (ATTEST_DIR / name).write_text(json.dumps(att))
    report = att.get("report") or {}
    signers = [m.get("signing_address") for m in report.get("model_attestations", [])]
    print(f"attestation {model_client.model_id}: status {att.get('status')} signers {signers} -> {name}")
    return name


def wait_outcome(duel_id: str, timeout_s: int = 90) -> dict[str, Any] | None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        d = view("get_duel", {"duel_id": duel_id})
        if d and d.get("outcome"):
            return d["outcome"]
        time.sleep(4)
    return None


def resolve_duel(solver: Solver, duel_id: str) -> dict[str, Any]:
    r = solver.post("/resolve", {"duel_id": duel_id})
    outcome = wait_outcome(duel_id)
    return {"tx": r["tx"], "outcome": outcome}


def run(rounds: int, duel_seconds: int, cycle_seconds: int, symbol: str, solver_url: str, bond: str) -> list[dict[str, Any]]:
    if not ENV.get("ARENA_SECRET"):
        raise SystemExit("ARENA_SECRET missing in the env file: the solver refuses every POST without it")
    asset = ASSETS.get(symbol)
    if not asset:
        raise SystemExit(f"no oracle asset for {symbol}; known: {sorted(ASSETS)}")
    solver = Solver(solver_url, ENV["ARENA_SECRET"])
    model_a, model_b = client_from_env(ENV, "A"), client_from_env(ENV, "B")
    a, ska, ca = make_duelist("A", model_a, hardened=True)
    b, skb, cb = make_duelist("B", model_b, hardened=False)
    for sk, m in ((ska, model_a), (skb, model_b)):
        try:
            solver.post("/register", {"agent_pk": pk_b64(sk), "model_id": m.model_id, "bond": bond, "tee": m.tee})
            print(f"registered {pk_b64(sk)[:8]} as {m.model_id} tee={m.tee}")
        except RuntimeError as e:
            if "agent exists" not in str(e):
                raise
    attestations = {m.model_id: save_attestation(m) for m in (model_a, model_b)}
    results = []
    nonce = int(time.time() * 1000)
    for rnd in range(rounds):
        close_at_ns = (time.time_ns() // 1_000_000_000 + duel_seconds) * 1_000_000_000
        opened = solver.post("/duel", {"a": pk_b64(ska), "b": pk_b64(skb), "symbol": asset, "close_at": str(close_at_ns)})
        duel_id = str(opened["duel_id"])
        open_px = price(symbol, ENV.get("PYTH_API_KEY"))
        print(f"[round {rnd}] duel {duel_id} {symbol} spot {open_px / 1e8:,.4f} tx {opened['tx']}")
        closed = False
        while not closed and time.time_ns() < close_at_ns - 25_000_000_000:  # leave 25 s for model + signature + chain round trip
            px = price(symbol, ENV.get("PYTH_API_KEY"))
            pending = solver.get("/arena")["pending"]
            for d, sk, comp, model in ((a, ska, ca, model_a), (b, skb, cb, model_b)):
                pk = pk_b64(sk)
                inj = [i for i in pending.get(pk, []) if i["duel_id"] == duel_id]
                injection_text = "\n".join(i["payload"] for i in inj) or None
                try:
                    decision = d.decide(symbol, brief(symbol, px, open_px), injection_text)
                except DuelistError as e:
                    c = comp.last
                    record({"duel_id": duel_id, "agent_pk": pk, "model": model.model_id, "error": str(e), "chat_id": c.chat_id, "response_body": c.response_bytes.decode(errors="replace")})
                    continue
                c: Completion = comp.last
                sig_record = model.signature(c.chat_id) if c.chat_id else None
                tee = None
                if sig_record:
                    try:
                        tee = tee_proof(sig_record, model.model_id, c.request_hash, c.response_hash)
                    except TeeProofError as e:
                        print(f"  {pk[:8]} enclave record rejected locally: {e}")
                if model.tee and not tee:
                    record({"duel_id": duel_id, "agent_pk": pk, "model": model.model_id, "error": "no tee proof", "chat_id": c.chat_id, "signature_record": sig_record})
                    print(f"  {pk[:8]} no verifiable enclave signature for {c.chat_id}; decision not posted")
                    continue
                nonce += 1
                intent = {
                    "agent_pk": pk, "duel_id": duel_id, "side": "Long" if decision.direction > 0 else "Short",
                    "size_bps": 5000, "nonce": str(nonce), "expires_at": str(close_at_ns + 60_000_000_000),
                    "proof_hash": proof_hash(c.request_hash, c.response_hash) if tee else proof_hash(None),
                }
                row = {
                    "duel_id": duel_id, "agent_pk": pk, "model": model.model_id, "hardened": d.hardened,
                    "brief": brief(symbol, px, open_px), "injection": injection_text, "text": c.text, "chat_id": c.chat_id,
                    "request_body": c.request_bytes.decode(errors="replace"), "response_body": c.response_bytes.decode(errors="replace"),
                    "request_hash": c.request_hash.hex() if c.request_bytes else None, "response_hash": c.response_hash.hex() if c.response_bytes else None,
                    "signature_record": sig_record, "tee": tee, "attestation_file": attestations.get(model.model_id), "intent": intent,
                }
                try:
                    posted = solver.post("/intent", {"signed": sign_intent(sk, intent), "tee": tee})
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
                print(f"  {'A' if sk is ska else 'B'} {intent['side']} nonce {nonce} tee={'kind ' + str(tee['kind']) if tee else 'none'} tx {posted['tx']} quotes {len(posted.get('quotes', []))}")
            if not closed:
                time.sleep(cycle_seconds)
        while time.time_ns() < close_at_ns + 2_000_000_000:
            time.sleep(1)
        resolved = resolve_duel(solver, duel_id)
        o = resolved["outcome"]
        if o:
            print(f"[round {rnd}] resolve tx {resolved['tx']}  oracle {int(o['open_price']) / 1e8:,.4f} -> {int(o['close_price']) / 1e8:,.4f}  A {o['pnl_a']} bps  B {o['pnl_b']} bps  winner {str(o.get('winner'))[:8]}")
        else:
            print(f"[round {rnd}] resolve tx {resolved['tx']}  oracle callback not yet landed; rerun: python runner.py --resolve {duel_id}")
        results.append({"duel_id": duel_id, "open_tx": opened["tx"], "resolve_tx": resolved["tx"], "outcome": o})
    return results


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--rounds", type=int, default=1)
    p.add_argument("--duel-seconds", type=int, default=90)
    p.add_argument("--cycle-seconds", type=int, default=20)
    p.add_argument("--symbol", default="NEAR/USD")
    p.add_argument("--bond", default="100000000000000000000000")  # 0.1 NEAR
    p.add_argument("--resolve", help="ask the oracle to resolve a closed duel id")
    args = p.parse_args()
    if args.resolve:
        print(json.dumps(resolve_duel(Solver(ENV.get("SOLVER_URL", "http://127.0.0.1:4020"), ENV.get("ARENA_SECRET", "")), args.resolve)))
        raise SystemExit(0)
    out = run(args.rounds, args.duel_seconds, args.cycle_seconds, args.symbol, ENV.get("SOLVER_URL", "http://127.0.0.1:4020"), args.bond)
    print(json.dumps(out, indent=2))
