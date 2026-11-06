#!/usr/bin/env python3
"""Copier leak before and after commit-reveal.

Reads the copier bot's rows (analysis/data/copier.jsonl, then copier-v2.jsonl from `--mode reveal-aware`, which wins
on the same duel/agent/nonce) and agents/data/decisions.jsonl, and prints one row per regime:
  - public post_intent: the side is readable on chain the moment the intent tx lands
  - commit-reveal: only a hash is on chain until reveal_intent
Regime: a v2 row's `phase.commit_reveal`; for older rows, the matching decision row carries `commitment`.
Per regime: intents, duels, the mean signed return of mirroring each intent at detection (bps, +15/+60/+90 s and the
oracle close, normal 95% CI), the share of intents the copier detected BEFORE the follower quote, the median
information window (detected_at - quote time, seconds; negative = copier ahead of the quote) and, for v2 rows, the
median commit-to-reveal time.

Quote time: a v2 row's `quote_at` (solver /arena snapshot, else chain). Older rows have none, so it comes from the
decision's intent tx (`revealed_tx` or `tx`): the last receipt's block time, after which the solver requests
follower quotes. Those block times are cached in analysis/data/tx_times.json; `--fetch` fills the cache from
FastNEAR's tx API. Without it, rows missing from the cache count toward returns but not toward the window.

Run:  agents/.venv/bin/python analysis/leak_report.py [--fetch]
Writes docs/research/leak-before-after.md. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import urllib.request
from datetime import datetime
from pathlib import Path
from statistics import mean, median, stdev

ROOT = Path(__file__).resolve().parents[1]
TX_API = os.environ.get("COPIER_TX_API", "https://tx.test.fastnear.com/v0")
HORIZONS = ("+15s", "+60s", "+90s", "close")
PUBLIC, COMMIT_REVEAL = "public post_intent", "commit-reveal"


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def key(duel_id, agent_pk, nonce) -> tuple[str, str, str]:
    return (str(duel_id), str(agent_pk), str(nonce))


def load(copier_paths: list[Path], decisions_path: Path) -> tuple[list[dict], dict]:
    rows: dict[tuple, dict] = {}
    for path in copier_paths:  # later files win: v2 rows replace v1 rows of the same intent
        for r in read_jsonl(path):
            rows[key(r["duel_id"], r["agent_pk"], r["nonce"])] = r
    decisions = {
        key(d["duel_id"], d["intent"]["agent_pk"], d["intent"]["nonce"]): d
        for d in read_jsonl(decisions_path)
        if d.get("intent")
    }
    return list(rows.values()), decisions


def regime(row: dict, decision: dict | None) -> str:
    if "phase" in row:
        return COMMIT_REVEAL if row["phase"].get("commit_reveal") else PUBLIC
    return COMMIT_REVEAL if decision and decision.get("commitment") else PUBLIC


def signed_bps(row: dict, horizon: str) -> float | None:
    """Return of mirroring the intent at detection: Long buys, Short sells, in bps of the detection price."""
    p0 = row.get("p0")
    if horizon == "close":
        p1 = float(row["close_price"]) / 1e8 if row.get("close_price") else None
    else:
        p1 = row.get(f"p{horizon[1:-1]}")
    if not p0 or not p1:
        return None
    return (1 if row["side"] == "Long" else -1) * (p1 - p0) / p0 * 10_000


def ci95(xs: list[float]) -> tuple[int, float, float, float]:
    n = len(xs)
    if n == 0:
        return 0, math.nan, math.nan, math.nan
    m = mean(xs)
    half = 1.96 * stdev(xs) / math.sqrt(n) if n > 1 else 0.0
    return n, m, m - half, m + half


def ms(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp() * 1000


def decision_tx(d: dict | None) -> str | None:
    return (d.get("revealed_tx") or d.get("tx")) if d else None


def window_s(row: dict, decision: dict | None, tx_times: dict[str, float]) -> float | None:
    if row.get("info_window_s") is not None:
        return row["info_window_s"]
    tx = decision_tx(decision)
    if tx is None or tx not in tx_times:
        return None
    return (ms(row["detected_at"]) - tx_times[tx]) / 1000


def fetch_tx_times(txs: set[str], cache: dict[str, float]) -> dict[str, float]:
    """Last receipt block time (ms) of each tx, 20 per FastNEAR call (its limit)."""
    todo = sorted(txs - cache.keys())
    for i in range(0, len(todo), 20):
        req = urllib.request.Request(
            f"{TX_API}/transactions",
            data=json.dumps({"tx_hashes": todo[i : i + 20]}).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            for t in json.load(r)["transactions"]:
                ts = max(int(x["execution_outcome"]["block_timestamp"]) for x in t["receipts"])
                cache[t["transaction"]["hash"]] = ts / 1e6
    return cache


def summarize(rows: list[dict], decisions: dict, tx_times: dict[str, float]) -> list[dict]:
    out = []
    for reg in (PUBLIC, COMMIT_REVEAL):
        group = [
            (r, decisions.get(key(r["duel_id"], r["agent_pk"], r["nonce"])))
            for r in rows
            if regime(r, decisions.get(key(r["duel_id"], r["agent_pk"], r["nonce"]))) == reg
        ]
        windows = [w for r, d in group if (w := window_s(r, d, tx_times)) is not None]
        c2r = [r["phase"]["commit_to_reveal_s"] for r, _ in group if (r.get("phase") or {}).get("commit_to_reveal_s")]
        out.append(
            {
                "regime": reg,
                "n": len(group),
                "duels": len({r["duel_id"] for r, _ in group}),
                "returns": {h: ci95([x for r, _ in group if (x := signed_bps(r, h)) is not None]) for h in HORIZONS},
                "windows": len(windows),
                "before_quote": sum(w < 0 for w in windows),
                "median_window_s": median(windows) if windows else None,
                "median_commit_to_reveal_s": median(c2r) if c2r else None,
            }
        )
    return out


def render(stats: list[dict]) -> str:
    def ret(c: tuple[int, float, float, float]) -> str:
        n, m, lo, hi = c
        return "-" if n == 0 else f"{m:+.2f} [{lo:+.2f}, {hi:+.2f}] n={n}"

    def num(x: float | None) -> str:
        return "-" if x is None else f"{x:.1f}"

    head = ["regime", "intents", "duels", *(f"mirror {h} bps" for h in HORIZONS)]
    head += ["before quote", "median window s", "median commit->reveal s"]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for s in stats:
        share = f"{s['before_quote'] / s['windows']:.0%} ({s['before_quote']}/{s['windows']})" if s["windows"] else "-"
        cells = [s["regime"], str(s["n"]), str(s["duels"]), *(ret(s["returns"][h]) for h in HORIZONS)]
        cells += [share, num(s["median_window_s"]), num(s["median_commit_to_reveal_s"])]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    data = ROOT / "analysis" / "data"
    ap.add_argument("--copier", type=Path, nargs="+", default=[data / "copier.jsonl", data / "copier-v2.jsonl"])
    ap.add_argument("--decisions", type=Path, default=ROOT / "agents" / "data" / "decisions.jsonl")
    ap.add_argument("--tx-times", type=Path, default=data / "tx_times.json")
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "research" / "leak-before-after.md")
    ap.add_argument("--fetch", action="store_true", help="fill --tx-times from FastNEAR for rows without quote_at")
    a = ap.parse_args()

    rows, decisions = load(a.copier, a.decisions)
    tx_times = json.loads(a.tx_times.read_text()) if a.tx_times.exists() else {}
    if a.fetch:
        need = {
            tx
            for r in rows
            if r.get("info_window_s") is None
            and (tx := decision_tx(decisions.get(key(r["duel_id"], r["agent_pk"], r["nonce"]))))
        }
        tx_times = fetch_tx_times(need, tx_times)
        a.tx_times.parent.mkdir(parents=True, exist_ok=True)
        a.tx_times.write_text(json.dumps(tx_times))

    table = render(summarize(rows, decisions, tx_times))
    print(table)
    sources = ", ".join(str(p) for p in a.copier if p.exists())
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(
        "# Copier leak: before and after commit-reveal\n\n"
        f"Generated {datetime.now().astimezone().isoformat(timespec='seconds')} by analysis/leak_report.py from "
        f"{sources} and {a.decisions}.\n\n"
        "Mirror return: signed bps of copying the intent at the copier's detection (Long buys, Short sells), "
        "Coinbase spot at +15/+60/+90 s, oracle close at close; mean [95% CI]. Before quote: share of intents "
        "the copier detected before the follower quote was requested. Window: detected_at minus quote time "
        "(negative = copier ahead). Quote time is the solver snapshot for reveal-aware rows, else the intent "
        "tx's last receipt block time.\n\n"
        f"{table}\n"
    )
    print(f"\nwrote {a.out}")


if __name__ == "__main__":
    main()
