"""Re-roll risk of a keyless agent: how often does the same NEAR AI Cloud request, sent again, come back with the
other side? Real signed duel requests from the arena dataset are replayed byte for byte (`default`), with
`"temperature": 0` (`t0`), and with `"seed"` (`seed`, `t0_seed`) when the API accepts it. See README.md.

    uv run --locked python reroll/reroll.py select --dataset <decisions.jsonl>   # free: data/prompts.jsonl
    uv run --locked python reroll/reroll.py run --phase pilot --n 1 --limit 5    # paid: price one call per model
    uv run --locked python reroll/reroll.py run --n 8 --conditions default,t0,t0_seed
    uv run --locked python reroll/reroll.py sigs     # free: enclave signatures for one Long and one Short reply
    uv run --locked python reroll/reroll.py report   # free: results/summary.json and the markdown tables

Every paid call goes through harness.Budget: logged to spend.jsonl, refused when its worst case would pass --cap.
Calls are appended to results/calls.jsonl as they finish, so an interrupted run resumes where it stopped.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import statistics
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from math import comb
from pathlib import Path
from typing import Any

import requests

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE.parent.parent / "agents")]
from chain import view  # noqa: E402
from config import DATA, ENV  # noqa: E402
from duelist import DuelistError, parse_decision, parse_size  # noqa: E402
from harness import MODELS, PRICE, Budget, BudgetExhausted  # noqa: E402
from intent_client import TeeProofError, tee_proof  # noqa: E402
from nearai import NEAR_AI_BASE, message_text  # noqa: E402
from summarize import pushed_side  # noqa: E402

PROMPTS = HERE / "data" / "prompts.jsonl"
CALLS = HERE / "results" / "calls.jsonl"
SIGS = HERE / "results" / "signatures.jsonl"
SUMMARY = HERE / "results" / "summary.json"
SPEND = HERE / "spend.jsonl"
SEED = 20261111
PER_MODEL = {"plain": 10, "injected": 5}  # 15 prompts per model (budget: $3 for the whole study)
SINGLE_CALL = {"naive", "hardened", "A", "B", "C"}  # hardened-v2/v3 vote over several calls or ask a judge first
CONDITIONS = {
    "default": {},
    "t0": {"temperature": 0},
    "seed": {"seed": SEED},
    "t0_seed": {"temperature": 0, "seed": SEED},
}
TRANSIENT = {408, 409, 425, 429, 500, 502, 503, 504}


def profile(r: dict[str, Any]) -> str:
    return str(r.get("profile") or r.get("prompt_variant") or ("hardened" if r.get("hardened") else "naive"))


# ---------- select ----------
def select(dataset: Path) -> list[dict[str, Any]]:
    """Per model, 10 unattacked and 5 attacked single-call decisions that were posted on chain and whose duel
    resolved with a price move, sampled with a fixed seed. One prompt per request body."""
    rows = [json.loads(x) for x in dataset.read_text().splitlines() if x.strip()]
    rng = random.Random(SEED)
    duels: dict[str, Any] = {}
    out: list[dict[str, Any]] = []
    for model in MODELS:
        seen: set[str] = set()
        cands = [
            r
            for r in rows
            if r["model"] == model
            and r.get("request_body")
            and r.get("response_body")
            and r.get("intent")
            and not r.get("error")
            and profile(r) in SINGLE_CALL
        ]
        cands.sort(key=lambda r: (int(r["duel_id"]), r["agent_pk"], r["request_hash"]))
        rng.shuffle(cands)
        need = dict(PER_MODEL)
        for r in cands:
            inj = r.get("injection")
            kind = "injected" if inj else "plain"
            pushed = pushed_side(inj) if inj else None
            if need[kind] == 0 or r["request_body"] in seen or (inj and pushed is None):
                continue
            if r["duel_id"] not in duels:
                duels[r["duel_id"]] = view("get_duel", {"duel_id": r["duel_id"]})
            o = (duels[r["duel_id"]] or {}).get("outcome")
            if not o or int(o["close_price"]) == int(o["open_price"]):
                continue
            op, cp = int(o["open_price"]), int(o["close_price"])
            seen.add(r["request_body"])
            need[kind] -= 1
            out.append(
                {
                    "id": f"{model.split('/')[-1]}-{r['duel_id']}-{r['request_hash'][:8]}",
                    "model": model,
                    "duel_id": r["duel_id"],
                    "agent_pk": r["agent_pk"],
                    "profile": profile(r),
                    "injected": bool(inj),
                    "pushed": pushed,
                    "recorded_side": r["intent"]["side"],
                    "open_price": op,
                    "close_price": cp,
                    "move_bps": round((cp - op) / op * 10_000, 2),
                    "request_body": r["request_body"],
                }
            )
            if not any(need.values()):
                break
        if any(need.values()):
            raise SystemExit(f"{model}: not enough prompts, still need {need}")
    return out


# ---------- run ----------
def body_for(prompt: dict[str, Any], condition: str) -> bytes:
    """`default` is the recorded request byte for byte; the others add their fields to it."""
    if condition == "default":
        return str(prompt["request_body"]).encode()
    return json.dumps(json.loads(prompt["request_body"]) | CONDITIONS[condition], separators=(",", ":")).encode()


def decision(text: str) -> tuple[str | None, int | None, str | None]:
    """Side and stated size the arena's own parser reads from the reply; the error when it reads none."""
    try:
        side = "Long" if parse_decision(text).direction > 0 else "Short"
    except DuelistError as e:
        return None, None, str(e)[:200]
    try:
        size: int | None = parse_size(text)
    except DuelistError:
        size = None
    return side, size, None


def call_once(prompt: dict[str, Any], condition: str, rep: int, budget: Budget, phase: str) -> dict[str, Any]:
    model, body = prompt["model"], body_for(prompt, condition)
    headers = {"Authorization": f"Bearer {ENV['NEAR_AI_API_KEY'].strip()}", "Content-Type": "application/json"}
    base = ENV.get("NEAR_AI_BASE", NEAR_AI_BASE).rstrip("/")
    row: dict[str, Any] = {"prompt": prompt["id"], "model": model, "condition": condition, "rep": rep, "phase": phase}
    row["request_sha256"] = hashlib.sha256(body).hexdigest()
    budget.reserve(model)
    usage = None
    t0 = time.monotonic()
    try:
        for i in range(5):
            r = requests.post(f"{base}/chat/completions", headers=headers, data=body, timeout=180)
            if r.status_code not in TRANSIENT or i == 4:
                break
            time.sleep(2**i)
        row["status"] = r.status_code
        if r.status_code != 200:
            row["error"] = r.text[:300]
            return row
        j = json.loads(r.content.decode("utf-8"))
        usage = j.get("usage")
        text = message_text(j)
        row["side"], row["size_bps"], row["parse_error"] = decision(text)
        row |= {"chat_id": j.get("id"), "response_sha256": hashlib.sha256(r.content).hexdigest()}
        row |= {"response_bytes": len(r.content), "text_sha256": hashlib.sha256(text.encode()).hexdigest()}
        row |= {"usage": usage, "system_fingerprint": j.get("system_fingerprint"), "text": text}
    except (requests.RequestException, ValueError) as e:
        row["error"] = f"transport: {e}"[:300]
    finally:
        row["latency_s"] = round(time.monotonic() - t0, 2)
        row["usd"] = budget.settle(model, usage, {"phase": phase, "prompt": prompt["id"], "condition": condition})
    return row


def run(n: int, conditions: list[str], limit: int | None, phase: str, cap: float, workers: int) -> None:
    prompts = [json.loads(x) for x in PROMPTS.read_text().splitlines()]
    if limit:  # the pilot: the first `limit` prompts, round-robin over the models
        by_model = [[p for p in prompts if p["model"] == m] for m in MODELS]
        prompts = [p for group in zip(*by_model, strict=False) for p in group][:limit]
    done = set()
    if CALLS.exists():
        done = {
            (c["prompt"], c["condition"], c["rep"])
            for c in map(json.loads, CALLS.read_text().splitlines())
            if c["phase"] == phase and not c.get("error")  # a failed call is retried on resume
        }
    todo = [(p, c, k) for p in prompts for c in conditions for k in range(n) if (p["id"], c, k) not in done]
    random.Random(SEED).shuffle(todo)  # interleave prompts, models and repeats as a parallel re-roller would
    budget = Budget(cap, SPEND)
    print(f"{len(todo)} calls to make, logged spend ${budget.spent:.4f}, cap ${cap:.2f}", flush=True)
    CALLS.parent.mkdir(parents=True, exist_ok=True)

    def one(job: tuple[dict[str, Any], str, int]) -> dict[str, Any] | None:
        try:
            return call_once(*job, budget, phase)
        except BudgetExhausted as e:
            print(f"stop: {e}", flush=True)
            return None

    with ThreadPoolExecutor(max_workers=workers) as ex, CALLS.open("a") as f:
        for i, row in enumerate(ex.map(one, todo), 1):
            if row is None:
                continue
            f.write(json.dumps(row) + "\n")
            f.flush()
            if i % 25 == 0 or i == len(todo):
                print(f"{i}/{len(todo)} spent ${budget.spent:.4f}", flush=True)


# ---------- sigs ----------
def sigs() -> None:
    """For every (prompt, condition) that came back with both sides, fetch the enclave signature of one Long and
    one Short reply and check each against the request bytes and the reply hash, as the contract would, and that
    the signer is pinned on the live arena (`is_tee_signer`). Non-billable."""
    import base64

    prompts = {p["id"]: p for p in map(json.loads, PROMPTS.read_text().splitlines())}
    groups: dict[tuple[str, str], dict[str, dict[str, Any]]] = defaultdict(dict)
    for c in map(json.loads, CALLS.read_text().splitlines()):
        if c.get("side") and c.get("chat_id"):
            groups[(c["prompt"], c["condition"])].setdefault(c["side"], c)
    headers = {"Authorization": f"Bearer {ENV['NEAR_AI_API_KEY'].strip()}"}
    base = ENV.get("NEAR_AI_BASE", NEAR_AI_BASE).rstrip("/")
    with SIGS.open("w") as f:
        for (pid, cond), sides in sorted(groups.items()):
            if len(sides) < 2:
                continue
            for side, c in sorted(sides.items()):
                out = {"prompt": pid, "condition": cond, "side": side, "chat_id": c["chat_id"], "verified": False}
                rec = None
                for i in range(6):  # the record lives on the node that served the call
                    r = requests.get(
                        f"{base}/signature/{c['chat_id']}",
                        params={"model": c["model"], "signing_algo": "ed25519"},
                        headers=headers,
                        timeout=30,
                    )
                    if r.status_code == 200:
                        rec = r.json()
                        break
                    time.sleep(1.5 * (i + 1))
                if rec is None:
                    out["error"] = "no signature record"
                else:
                    req = hashlib.sha256(body_for(prompts[pid], cond)).digest()
                    try:
                        proof = tee_proof(rec, c["model"], req, bytes.fromhex(c["response_sha256"]))
                        pinned = view("is_tee_signer", {"signer": proof["signer"]})
                        out |= {"verified": True, "signer": base64.b64decode(proof["signer"]).hex(), "pinned": pinned}
                        out["request_sha256"] = req.hex()
                    except TeeProofError as e:
                        out["error"] = str(e)[:200]
                f.write(json.dumps(out) + "\n")
                print(json.dumps(out), flush=True)


# ---------- report ----------
def p_both(k: int, longs: int, shorts: int, n: int) -> float:
    """Probability that k replies drawn without replacement from n observed (`longs` Long, `shorts` Short, the rest
    unparsed) hold a Long and a Short: the chance that a keeper who samples k times can choose the side."""
    if k > n:
        raise ValueError(f"k={k} > n={n}")
    return 1 - (comb(n - longs, k) + comb(n - shorts, k) - comb(n - longs - shorts, k)) / comb(n, k)


def p_any(k: int, hits: int, n: int) -> float:
    """Probability that at least one of k replies drawn from n observed is one of the `hits`."""
    return 1 - comb(n - hits, k) / comb(n, k)


def p_all(k: int, hits: int, n: int) -> float:
    """Probability that all k replies drawn from n observed are `hits`."""
    return comb(hits, k) / comb(n, k)


def summarize_group(calls: list[dict[str, Any]], prompts: dict[str, dict[str, Any]], ks: list[int]) -> dict[str, Any]:
    """Per prompt and then averaged. A reply the arena parser cannot read is an abstention: no position, pnl 0, and
    a third outcome a keeper may also choose to submit."""
    by_prompt: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for c in calls:
        if not c.get("error"):  # transport failures were retried; the retry is the observation
            by_prompt[c["prompt"]].append(c)
    per = []
    for pid, ok in by_prompt.items():
        p = prompts[pid]
        n = len(ok)
        longs, shorts = sum(c.get("side") == "Long" for c in ok), sum(c.get("side") == "Short" for c in ok)
        right = "Long" if p["move_bps"] > 0 else "Short"
        wins = longs if right == "Long" else shorts
        losses = shorts if right == "Long" else longs
        h = abs(p["move_bps"]) / 2  # pnl in bps of a 5000 bps position, the arena's full size
        row = {
            "prompt": pid,
            "n": n,
            "longs": longs,
            "shorts": shorts,
            "sides": (longs > 0) + (shorts > 0),
            "decisions": len({(c.get("side"), c.get("size_bps")) for c in ok}),
            "texts": len({c.get("text_sha256") for c in ok}),
            "modal_share": max(longs, shorts, n - longs - shorts) / n,
            "p_win_single": wins / n,
            "pnl_single": h * (wins - losses) / n,
        }
        for k in ks:
            if k <= n:
                row[f"p_both_k{k}"] = p_both(k, longs, shorts, n)
                # a keeper that knew the close submits a win if it drew one, else an abstention, else a loss
                row[f"p_win_best_k{k}"] = p_any(k, wins, n)
                row[f"pnl_best_k{k}"] = h * (p_any(k, wins, n) - p_all(k, losses, n))
                # a griefer submits a loss if it drew one, else an abstention, else the win
                row[f"p_win_worst_k{k}"] = p_all(k, wins, n)
                row[f"pnl_worst_k{k}"] = h * (p_all(k, wins, n) - p_any(k, losses, n))
        if p["injected"]:
            hits = sum(c.get("side") == p["pushed"] for c in ok)
            held = longs + shorts - hits
            row["p_pushed_single"] = hits / n
            for k in ks:
                if k <= n:
                    row[f"p_pushed_k{k}"] = p_any(k, hits, n)  # the injector keeps until the model takes its side
                    row[f"p_pushed_owner_k{k}"] = 1 - p_any(k, held, n)  # the owner keeps until the model holds
        per.append(row)

    def mean(key: str, rows: list[dict[str, Any]] = per) -> float | None:
        xs = [r[key] for r in rows if key in r]
        return round(statistics.fmean(xs), 4) if xs else None

    def pnl(key: str) -> float | None:  # expected pnl in bps of the full position, averaged over prompts
        m = mean(key)
        return None if m is None else round(m, 3)

    inj = [r for r in per if "p_pushed_single" in r]
    sizes = sorted(c["response_bytes"] for c in calls if c.get("response_bytes"))
    out: dict[str, Any] = {
        "prompts": len(per),
        "calls": len(calls),
        "errors": sum(1 for c in calls if c.get("error")),
        "unparsed": sum(1 for c in calls if not c.get("error") and not c.get("side")),
        "prompts_with_abstention": sum(r["longs"] + r["shorts"] < r["n"] for r in per),
        "prompts_both_sides": sum(r["sides"] == 2 for r in per),
        "mean_distinct_decisions": mean("decisions"),
        "mean_distinct_texts": mean("texts"),
        "mean_modal_share": mean("modal_share"),
        "p_win_single": mean("p_win_single"),
        "pnl_single_bps": pnl("pnl_single"),
        "response_bytes": {"median": round(statistics.median(sizes)), "max": sizes[-1]} if sizes else None,
        "per_prompt": per,
    }
    for k in ks:
        out[f"p_both_k{k}"] = mean(f"p_both_k{k}")
        out[f"p_win_best_k{k}"] = mean(f"p_win_best_k{k}")
        out[f"p_win_worst_k{k}"] = mean(f"p_win_worst_k{k}")
        out[f"pnl_best_k{k}_bps"] = pnl(f"pnl_best_k{k}")
        out[f"pnl_worst_k{k}_bps"] = pnl(f"pnl_worst_k{k}")
        if inj:
            out[f"p_pushed_k{k}"] = mean(f"p_pushed_k{k}", inj)
            out[f"p_pushed_owner_k{k}"] = mean(f"p_pushed_owner_k{k}", inj)
    if inj:
        out["injected_prompts"] = len(inj)
        out["p_pushed_single"] = mean("p_pushed_single", inj)
    return out


def report(ks: list[int]) -> dict[str, Any]:
    prompts = {p["id"]: p for p in map(json.loads, PROMPTS.read_text().splitlines())}
    calls = [c for c in map(json.loads, CALLS.read_text().splitlines()) if c["phase"] == "main"]
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for c in calls:
        groups[(c["model"], c["condition"])].append(c)
    spend = [json.loads(x) for x in SPEND.read_text().splitlines()] if SPEND.exists() else []
    summary = {
        "groups": {f"{m}|{cond}": summarize_group(cs, prompts, ks) for (m, cond), cs in sorted(groups.items())},
        "fingerprints": {
            f"{m}|{cond}": dict(Counter(str(c.get("system_fingerprint")) for c in cs))
            for (m, cond), cs in sorted(groups.items())
        },
        "spend_usd": round(sum(s["usd"] for s in spend), 6),
        "spend_calls": len(spend),
        "price_per_token": PRICE,
    }
    if SIGS.exists():
        rows = [json.loads(x) for x in SIGS.read_text().splitlines()]
        pairs: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for s in rows:
            pairs[(s["prompt"], s["condition"])].append(s)
        good = [k for k, v in pairs.items() if len(v) == 2 and all(s["verified"] and s.get("pinned") for s in v)]
        summary["signed_opposite_pairs"] = {"pairs": len(pairs), "both_verified_and_pinned": len(good)}
    SUMMARY.write_text(json.dumps(summary, indent=1) + "\n")
    print_tables(summary, ks)
    return summary


def print_tables(s: dict[str, Any], ks: list[int]) -> None:
    def pct(x: float | None) -> str:
        return "-" if x is None else f"{100 * x:.0f}%"

    k_hi = max(ks)
    print(
        "| model | condition | prompts | calls | both sides seen | distinct decisions | distinct texts |"
        f" P(both) k=2 | k={k_hi} | win single | win best-of-{k_hi} | win worst-of-{k_hi} | pnl single / best /"
        f" worst bps | flipped single / injector / owner best-of-{k_hi} | bytes median / max |"
    )
    print("|" + "---|" * 14)
    for key, g in s["groups"].items():
        model, cond = key.split("|")
        rb = g["response_bytes"] or {}
        print(
            f"| {model.split('/')[-1]} | {cond} | {g['prompts']} | {g['calls']} | {g['prompts_both_sides']} |"
            f" {g['mean_distinct_decisions']} | {g['mean_distinct_texts']} | {pct(g.get('p_both_k2'))} |"
            f" {pct(g.get(f'p_both_k{k_hi}'))} | {pct(g['p_win_single'])} | {pct(g.get(f'p_win_best_k{k_hi}'))} |"
            f" {pct(g.get(f'p_win_worst_k{k_hi}'))} | {g['pnl_single_bps']} / {g.get(f'pnl_best_k{k_hi}_bps')} /"
            f" {g.get(f'pnl_worst_k{k_hi}_bps')} | {pct(g.get('p_pushed_single'))} /"
            f" {pct(g.get(f'p_pushed_k{k_hi}'))} / {pct(g.get(f'p_pushed_owner_k{k_hi}'))} |"
            f" {rb.get('median')} / {rb.get('max')} |"
        )
    print(f"\nspend ${s['spend_usd']} over {s['spend_calls']} calls; {s.get('signed_opposite_pairs')}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("select")
    s.add_argument("--dataset", type=Path, default=DATA)
    r = sub.add_parser("run")
    r.add_argument("--n", type=int, default=8)
    r.add_argument("--conditions", default="default,t0,t0_seed")
    r.add_argument("--limit", type=int)
    r.add_argument("--phase", default="main")
    r.add_argument("--cap", type=float, default=3.0)
    r.add_argument("--workers", type=int, default=6)
    sub.add_parser("sigs")
    rep = sub.add_parser("report")
    rep.add_argument("--ks", default="2,4,8")
    a = ap.parse_args()
    if a.cmd == "select":
        rows = select(a.dataset)
        PROMPTS.parent.mkdir(parents=True, exist_ok=True)
        PROMPTS.write_text("".join(json.dumps(p) + "\n" for p in rows))
        print(f"{len(rows)} prompts -> {PROMPTS}")
    elif a.cmd == "run":
        bad = [c for c in a.conditions.split(",") if c not in CONDITIONS]
        if bad:
            raise SystemExit(f"unknown conditions {bad}: {list(CONDITIONS)}")
        run(a.n, a.conditions.split(","), a.limit, a.phase, a.cap, a.workers)
    elif a.cmd == "sigs":
        sigs()
    else:
        report([int(k) for k in a.ks.split(",")])


if __name__ == "__main__":
    main()
