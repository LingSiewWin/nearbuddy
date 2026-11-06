#!/usr/bin/env python3
"""Morning readout of a night's duels, in markdown: what ran since a duel id, per pair.

  bun run readout -- --since 340 [--out readout.md] [--verify 5] [--data path/to/decisions.jsonl]

Sections:
  1. duels per pair (main pair = no pair_tag, p2), decisions and their enclave-proof rate
  2. commit-reveal: commits, reveals, the scored reveal per agent-duel (the row of get_duel's last_intent_{a,b}
     nonce) landing inside the intent lock: the block time of its arena receipt (where the contract checks the lock)
     vs close_at minus the duel's lock (see `lock_at`), and no-reveal forfeits (get_no_reveal)
  3. attacks per prompt arm split against / with / flat (injection_effects.enrich and .clustered: took the injected
     side, interval over agent-duels, baseline = the arm's unattacked rate of the pushed side, as injection_effects)
  4. briefs measured from the runner's spot (open_source "spot") rather than the oracle open
  5. pair 2 parse rate per max_tokens cap (model_report's rule: decisions plus unparseable replies)
  6. `bun run verify-duel` PASS / FAIL over the last N resolved duels

Reads the dataset read-only and chain views; injection_effects.load_duels refreshes its duel cache under
analysis/data. Stdlib plus agents/ through injection_effects.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from statistics import mean
from typing import Any

import experiment_report as er
import injection_effects as ie  # puts agents/ on sys.path
import model_report as mr

import chain  # noqa: E402  (agents/, via injection_effects)
from config import ENV, NET  # noqa: E402
from nearai import is_stub_model  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
S = 1_000_000_000


def pair(r: dict) -> str:
    return r.get("pair_tag") or "main"


def arm(r: dict) -> str:
    return r.get("prompt_variant") or ("hardened" if r.get("hardened") else "naive")


def pct(k: int, n: int) -> str:
    return f"{k}/{n} ({k / n:.0%})" if n else "0/0"


def scored_reveals(rows: list[dict], duels: dict[str, dict]) -> dict[tuple[str, str], dict]:
    """(duel_id, agent_pk) -> the revealed row the duel scored: the one whose nonce is get_duel's last_intent_a/b
    nonce for that agent. A higher-nonce row is not it when the chain kept an earlier call."""
    out: dict[tuple[str, str], dict] = {}
    for r in rows:
        if not r.get("revealed_tx"):
            continue
        d = duels.get(str(r["duel_id"])) or {}
        for side in ("a", "b"):
            last = d.get(f"last_intent_{side}") or {}
            if d.get(side) == r["agent_pk"] and str(last.get("nonce")) == str(r["intent"]["nonce"]):
                out[(str(r["duel_id"]), r["agent_pk"])] = r
    return out


def render(
    rows: list[dict],
    since: int,
    duels: dict[str, dict],
    no_reveal: dict[str, tuple[bool, bool]],
    reveal_at: dict[str, tuple[int | None, int | None, str]],
    verified: list[tuple[str, str]],
) -> str:
    """The readout from already-fetched inputs. `rows`: dataset rows; `duels`: get_duel by id; `no_reveal`:
    get_no_reveal by duel id; `reveal_at`: revealed_tx -> (arena receipt block time ns, the duel's lock in s,
    where the lock came from), None = unknown; `verified`: (duel id, PASS | FAIL | ERROR ...)."""
    rows = [r for r in rows if int(r["duel_id"]) >= since]
    pairs = sorted({pair(r) for r in rows}, key=lambda p: (p != "main", p))
    out = [f"# Night readout: duels from #{since}", ""]
    if not rows:
        return "\n".join(out + [f"No dataset rows from duel {since} on.", ""])
    ids = sorted({int(r["duel_id"]) for r in rows})
    out += [f"Duels #{ids[0]}..#{ids[-1]} in the dataset, {len(rows)} rows.", ""]

    # 1. duels, decisions, enclave proofs
    body = []
    for p in pairs:
        sub = [r for r in rows if pair(r) == p]
        dids = {str(r["duel_id"]) for r in sub}
        dec = [r for r in sub if "intent" in r]
        body.append(
            [
                p,
                len(dids),
                sum(1 for d in dids if (duels.get(d) or {}).get("resolved")),
                ", ".join(sorted({r["model"].split("/")[-1] for r in sub})),
                len(dec),
                pct(sum(1 for r in dec if r.get("tee")), len(dec)),
            ]
        )
    out += ["## 1. Duels per pair", ""]
    out += er.md_table(["pair", "duels", "resolved", "models", "decisions", "enclave-proved"], body)

    # 2. commit-reveal
    body = []
    lock_sources: dict[str, int] = defaultdict(int)
    for p in pairs:
        sub = [r for r in rows if pair(r) == p]
        last = scored_reveals(sub, duels)
        inside = unknown = 0
        for (d, _), r in last.items():
            t, lock_s, src = reveal_at.get(r["revealed_tx"], (None, None, "unknown"))
            close = int((duels.get(d) or {}).get("close_at") or 0)
            lock_sources[src] += 1
            if t is None or lock_s is None or not close:
                unknown += 1
            elif close - lock_s * S <= t < close:
                inside += 1
        dids = sorted({str(r["duel_id"]) for r in sub})
        flags = [no_reveal.get(d, (False, False)) for d in dids]
        body.append(
            [
                p,
                sum(1 for r in sub if r.get("commitment")),
                sum(1 for r in sub if r.get("revealed_tx")),
                f"{pct(inside, len(last))}" + (f", {unknown} unknown" if unknown else ""),
                f"{sum(1 for f in flags if any(f))} duels, {sum(sum(f) for f in flags)} sides",
            ]
        )
    out += [
        "## 2. Commit-reveal",
        "",
        "Scored reveal = the revealed row of get_duel's last_intent nonce per agent-duel; inside the lock = the "
        "block time of its arena receipt is in [close_at - lock, close_at). Lock per duel from "
        + (", ".join(f"{k} {v}" for k, v in sorted(lock_sources.items())) or "nothing scored")
        + " (duel_locks = the deploy-15 per-duel record; config@block = get_config at the receipt's block; "
        "config now = get_config at the head). Forfeits from get_no_reveal.",
        "",
    ]
    out += er.md_table(["pair", "commits", "reveals", "scored reveal inside the lock", "no-reveal forfeits"], body)

    # 3. attacks per arm, against / with / flat
    out += ["## 3. Attacks per prompt arm (took the injected side)", ""]
    tee = [r for r in rows if r.get("tee") and "intent" in r and r.get("brief")]
    try:
        rs = ie.enrich(tee, duels)
    except SystemExit as e:  # enrich stops on a brief it cannot read; say so instead of dying
        rs = None
        out += [f"Not available: {e}", ""]
    if rs is not None:
        body = []
        for a in sorted({arm(r) for r in rs}):
            sub = [r for r in rs if arm(r) == a]
            un = [r for r in sub if not r["attacked"]]
            long_share = sum(r["side"] == "Long" for r in un) / len(un) if un else 0.5
            att = [r for r in sub if r["attacked"]]
            for t in (*ie.TESTS, "unreadable"):
                took = [r for r in att if (r["test"] or "unreadable") == t and r["pushed"]]
                if t == "unreadable":
                    body.append([a, t, sum(1 for r in att if r["test"] is None), "-"])
                    continue
                base = mean(long_share if r["pushed"] == "Long" else 1 - long_share for r in took) if took else 0.5
                hit = [r["side"] == r["pushed"] for r in took]
                body.append([a, t, len(took), f"{ie.clustered(took, hit, base)} (base {base:.2f})"])
        out += [
            "against = the payload pushes against the brief's move since open, with = the way it moved, flat = no "
            "move; unreadable = no pushed side or a spot-open brief. Interval over agent-duels (injection_effects).",
            "",
        ]
        out += er.md_table(["arm", "test", "attacked", "took injected side"], body)

    # 4. spot opens
    spot = [r for r in rows if r.get("open_source") == "spot"]
    srcs: dict[str, int] = defaultdict(int)
    for r in rows:
        if "intent" in r:
            srcs[r.get("open_source") or "unrecorded"] += 1
    out += [
        "## 4. Briefs measured from spot instead of the oracle open",
        "",
        f"{len(spot)} rows in {len({r['duel_id'] for r in spot})} duels have open_source spot. Decisions by open "
        f"source: {', '.join(f'{k} {v}' for k, v in sorted(srcs.items())) or 'none'}.",
        "",
    ]

    # 5. pair 2 parse rate per cap
    calls = [
        r
        for r in rows
        if pair(r) == "p2"
        and not is_stub_model(r["model"])
        and ("intent" in r or str(r.get("error", "")).startswith(mr.PARSE_FAIL))
    ]
    body = []
    for key in sorted({(r["model"], ie.max_tokens(r) or 0) for r in calls}):
        sub = [r for r in calls if (r["model"], ie.max_tokens(r) or 0) == key]
        fail = [str(r.get("error", "")).startswith(mr.PARSE_FAIL) for r in sub]
        rate = ie.clustered(sub, fail, 0.0).replace(" PROVISIONAL", "").replace(" FIRM", "")
        body.append([key[0], key[1] or "unknown", rate])
    out += ["## 5. Pair 2 parse rate per max_tokens cap", ""]
    out += er.md_table(["model", "max_tokens", "unparseable"], body) if body else ["No pair 2 calls.", ""]

    # 6. verify-duel
    out += ["## 6. verify-duel over the last resolved duels", ""]
    if verified:
        n_pass = sum(1 for _, v in verified if v == "PASS")
        out += [f"{n_pass}/{len(verified)} PASS.", ""]
        out += er.md_table(["duel", "verify-duel"], [[d, v] for d, v in verified])
    else:
        out += ["No resolved duel to verify.", ""]
    return "\n".join(out)


# ---------------------------------------------------------------- fetching


DUEL_LOCKS_PREFIX = 18  # StorageKey::DuelLocks (deploy 15): duel id (u64 LE) -> lock ns (u64 LE)


def arena_receipt(tx: str, sender: str) -> tuple[int, str] | None:
    """(block time ns, block hash) of the transaction's successful receipt executed by the arena: the block whose
    timestamp the contract compared with the lock, which can be later than the transaction's own block. None when
    the RPC no longer has the tx or no arena receipt succeeded."""
    try:
        r = chain.rpc("tx", {"tx_hash": tx, "sender_account_id": sender, "wait_until": "NONE"})
        for o in r.get("receipts_outcome") or []:
            status = o["outcome"]["status"]
            if o["outcome"]["executor_id"] == chain.ARENA and (
                "SuccessValue" in status or "SuccessReceiptId" in status
            ):
                block = chain.rpc("block", {"block_id": o["block_hash"]})
                return int(block["header"]["timestamp_nanosec"]), o["block_hash"]
    except (RuntimeError, KeyError, TypeError):
        pass
    return None


def lock_at(duel_id: str, block_hash: str | None) -> tuple[int | None, str]:
    """The intent lock (s) duel `duel_id` ran under, and where it came from: the deploy-15 `duel_locks` record at
    `block_hash` (the entry is deleted at resolution, so the reveal's block is where it still exists; view_state is
    refused for a contract state over the RPC's limit, as the testnet arena's is), else `get_config.intent_lock_s`
    at that block (the global lock then), else at the head."""
    key = base64.b64encode(bytes([DUEL_LOCKS_PREFIX]) + int(duel_id).to_bytes(8, "little")).decode()
    at = {"block_id": block_hash} if block_hash else {"finality": "final"}
    try:
        vals = chain.rpc("query", {"request_type": "view_state", "account_id": chain.ARENA, "prefix_base64": key, **at})
        for v in vals.get("values") or []:
            if base64.b64decode(v["key"]) == base64.b64decode(key):
                return int.from_bytes(base64.b64decode(v["value"]), "little") // S, "duel_locks"
    except (RuntimeError, KeyError, TypeError, ValueError):
        pass
    if block_hash:
        try:
            cfg = chain.rpc(
                "query",
                {
                    "request_type": "call_function",
                    "account_id": chain.ARENA,
                    "method_name": "get_config",
                    "args_base64": base64.b64encode(b"{}").decode(),
                    "block_id": block_hash,
                },
            )
            return int(json.loads(bytes(cfg["result"]))["intent_lock_s"]), "config@block"
        except (RuntimeError, KeyError, TypeError, ValueError):
            pass
    try:
        return int((chain.view("get_config", {}) or {})["intent_lock_s"]), "config now"
    except (RuntimeError, KeyError, TypeError, ValueError):
        return None, "unknown"


def reveal_timing(duel_id: str, tx: str, sender: str) -> tuple[int | None, int | None, str]:
    rec = arena_receipt(tx, sender)
    lock, src = lock_at(duel_id, rec[1] if rec else None)
    return (rec[0] if rec else None), lock, src


def verify(duel_id: str, data: Path) -> str:
    """`bun run verify-duel <id>`: exit 0 PASS, 1 FAIL, anything else ERROR."""
    try:
        p = subprocess.run(
            ["bun", "run", "verify-duel", duel_id],
            cwd=ROOT,
            env={**os.environ, "DECISIONS": str(data)},
            capture_output=True,
            text=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        return "ERROR (timeout)"
    return {0: "PASS", 1: "FAIL"}.get(p.returncode, f"ERROR (exit {p.returncode})")


def fetch(rows: list[dict], since: int, n_verify: int, data: Path) -> dict[str, Any]:
    rows = [r for r in rows if int(r["duel_id"]) >= since]
    ids = sorted({str(r["duel_id"]) for r in rows}, key=int)
    duels = ie.load_duels(ids)
    with ThreadPoolExecutor(max_workers=4) as ex:
        nr = dict(zip(ids, ex.map(lambda d: tuple(chain.view("get_no_reveal", {"duel_id": d})), ids), strict=True))
        sender = ENV.get("SOLVER_ID", NET["solver"])
        scored = [(d, r["revealed_tx"]) for (d, _), r in scored_reveals(rows, duels).items()]
        timing = dict(
            zip(
                [t for _, t in scored],
                ex.map(lambda dt: reveal_timing(dt[0], dt[1], sender), scored),
                strict=True,
            )
        )
    resolved = [d for d in ids if (duels.get(d) or {}).get("resolved")][-n_verify:] if n_verify else []
    return {
        "duels": duels,
        "no_reveal": nr,
        "reveal_at": timing,
        "verified": [(d, verify(d, data)) for d in resolved],
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--since", type=int, required=True, help="first duel id to include")
    p.add_argument("--out", type=Path, help="write the markdown here too")
    p.add_argument("--verify", type=int, default=5, help="verify-duel over this many of the last resolved duels")
    p.add_argument("--data", type=Path, default=ie.DATA, help="decisions.jsonl (read only)")
    a = p.parse_args()
    rows = [json.loads(line) for line in a.data.read_text().splitlines() if line.strip()]
    md = render(rows, a.since, **fetch(rows, a.since, a.verify, a.data))
    print(md)
    if a.out:
        a.out.write_text(md + "\n")


if __name__ == "__main__":
    main()
