"""Replay: do the models disagree, and is a disagreement skill? (README.md, "Replay: what input makes models differ")

The frozen snapshots of the first experiment, no headline, the live duelist's naive prompt, each model asked several
times under each input variant:

    A  the snapshot's brief as the runner writes it: the last price and the move since the open
    B  A plus the one-minute closes of the hour before the brief

    uv run --locked python replay.py windows                 # Coinbase closes and later prices per snapshot (free)
    uv run --locked python replay.py run --cap 4.60          # paid, resumable; spend is logged to spend.jsonl
    uv run --locked python replay.py report                  # every table from results/replay.jsonl

Calls go through harness.call, so each one is the duelist's own request with its enclave proof. Only verified calls
with a parsed side are counted.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import threading
import time
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from itertools import combinations
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
WINDOWS = HERE / "data" / "replay_windows.json"
OUT = HERE / "results" / "replay.jsonl"
VARIANTS = ("A", "B")
REPEATS = 3
PROFILE = "naive"
# Reply allowance for every model and both variants. The runner's 600 is not enough once the brief carries 60 prices:
# in the pilot DeepSeek and Qwen spent all of it reasoning and gave no answer (README, "Replay deviations").
MAX_TOKENS = 2400

Row = dict[str, Any]
Frac = tuple[int, int]


# ---------- inputs ----------
def brief_for(variant: str, snap: Row, win: Row) -> str:
    """The market brief a variant shows. B adds the closes of the hour before it, oldest first, and nothing else."""
    if variant == "A":
        return str(snap["brief"])
    closes = ", ".join(f"{p:g}" for _, p in win["history"])
    return f"{snap['brief']}\nLast {len(win['history'])} one-minute closes, oldest first: {closes}"


def jobs(snaps: list[str], models: list[str], variants: list[str], repeats: int) -> list[tuple[str, str, str, int]]:
    return [(s, m, v, r) for s in snaps for m in models for v in variants for r in range(repeats)]


def fetch_windows() -> None:
    """For each frozen snapshot: the 60 one-minute closes before its brief and the closes 6 and 60 minutes after it,
    from Coinbase Exchange candles (GET /products/{id}/candles, rows `[time s, low, high, open, close, volume]`)."""
    snaps = json.loads((HERE / "data" / "snapshots.json").read_text())
    out = []
    for s in snaps:
        t = datetime.fromisoformat(s["t_brief"])
        a, b = t - timedelta(minutes=61), t + timedelta(minutes=61)
        url = (
            f"https://api.exchange.coinbase.com/products/{s['asset']}-USD/candles?granularity=60"
            f"&start={a:%Y-%m-%dT%H:%M:%SZ}&end={b:%Y-%m-%dT%H:%M:%SZ}"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "curl"})
        candles = json.load(urllib.request.urlopen(req, timeout=15))
        by = {row[0]: row[4] for row in candles}
        tb = int(t.timestamp())
        out.append(
            {
                "id": s["id"],
                "asset": s["asset"],
                "t_brief": s["t_brief"],
                # a minute with no trade has no candle, so a history can be shorter than 60
                "history": [[k, by[k]] for k in sorted(by) if tb - 3600 <= k < tb],
                "px_brief": by.get(tb - 60),
                "px_6m": by.get(tb + 300),
                "px_60m": by.get(tb + 3540),
                "source": url,
            }
        )
        time.sleep(0.25)
    WINDOWS.write_text(json.dumps(out, indent=1) + "\n")
    print(f"{len(out)} windows -> {WINDOWS}")


# ---------- tables ----------
def majority(sides: list[str]) -> str | None:
    """The side most repeats took; None with no call or an even split."""
    top = Counter(sides).most_common(2)
    if not top or (len(top) == 2 and top[0][1] == top[1][1]):
        return None
    return top[0][0]


def calls(rows: list[Row], variant: str) -> dict[tuple[str, str], list[str]]:
    """(snapshot, model) -> the sides of its verified calls under a variant."""
    out: dict[tuple[str, str], list[str]] = {}
    for r in rows:
        if r["variant"] == variant and r.get("verified") and r.get("side"):
            out.setdefault((r["snapshot"], r["model"]), []).append(r["side"])
    return out


def self_agreement(rows: list[Row], variant: str) -> dict[str, Frac]:
    """Per model: repeats that match the model's own majority on that snapshot, over all its repeats."""
    out: dict[str, list[int]] = {}
    for (_, model), sides in calls(rows, variant).items():
        m = majority(sides)
        k = out.setdefault(model, [0, 0])
        k[0] += sum(s == m for s in sides)
        k[1] += len(sides)
    return {m: (k[0], k[1]) for m, k in out.items()}


def majorities(rows: list[Row], variant: str) -> dict[str, dict[str, str]]:
    """snapshot -> model -> its majority side (models with no majority are left out)."""
    out: dict[str, dict[str, str]] = {}
    for (snap, model), sides in calls(rows, variant).items():
        m = majority(sides)
        if m:
            out.setdefault(snap, {})[model] = m
    return out


def disagreement(rows: list[Row], variant: str) -> dict[tuple[str, str], Frac]:
    """Per pair of models: snapshots where their majorities differ, over snapshots where both have one."""
    out: dict[tuple[str, str], list[int]] = {}
    for by_model in majorities(rows, variant).values():
        for a, b in combinations(sorted(by_model), 2):
            k = out.setdefault((a, b), [0, 0])
            k[0] += by_model[a] != by_model[b]
            k[1] += 1
    return {p: (k[0], k[1]) for p, k in out.items()}


def _right(side: str, win: Row, horizon: str) -> bool | None:
    """Whether a side matches the price change from the brief to the horizon; None when the price did not change."""
    before, after = win.get("px_brief"), win.get(horizon)
    if before is None or after is None or after == before:
        return None
    return (side == "Long") == (after > before)


def hit_rate(rows: list[Row], variant: str, wins: dict[str, Row], horizon: str) -> dict[str, Frac]:
    out: dict[str, list[int]] = {}
    for snap, by_model in majorities(rows, variant).items():
        for model, side in by_model.items():
            ok = _right(side, wins.get(snap, {}), horizon)
            if ok is None:
                continue
            k = out.setdefault(model, [0, 0])
            k[0] += ok
            k[1] += 1
    return {m: (k[0], k[1]) for m, k in out.items()}


def baselines(snaps: dict[str, Row], wins: dict[str, Row], horizon: str) -> dict[str, Frac]:
    """What no model is needed for: always long, and the side of the move the brief shows (no call on no move)."""
    long_, follow = [0, 0], [0, 0]
    for sid, snap in snaps.items():
        win = wins.get(sid, {})
        ok = _right("Long", win, horizon)
        if ok is None:
            continue
        long_[0] += ok
        long_[1] += 1
        move = float(snap["move_bps"])
        if move:
            follow[0] += bool(_right("Long" if move > 0 else "Short", win, horizon))
            follow[1] += 1
    return {"always long": (long_[0], long_[1]), "follow the move": (follow[0], follow[1])}


# ---------- run ----------
def run(cap: float, workers: int, models: list[str], limit: int | None) -> None:
    import harness  # the paid path: imported here so the tables above need no API key
    from config import ENV
    from nearai import NearAiClient

    snaps = {s["id"]: s for s in json.loads(harness.SNAPSHOTS.read_text())}
    wins = {w["id"]: w for w in json.loads(WINDOWS.read_text())}
    ids = [i for i in snaps if i in wins][:limit]
    done = set()
    if OUT.exists():
        done = {
            (r["snapshot"], r["model"], r["variant"], r["repeat"])
            for r in map(json.loads, OUT.read_text().splitlines())
        }
    todo = [j for j in jobs(ids, models, list(VARIANTS), REPEATS) if j not in done]
    budget = harness.Budget(cap)
    clients = {m: NearAiClient(ENV["NEAR_AI_API_KEY"], m, max_tokens=MAX_TOKENS) for m in models}
    lock = threading.Lock()
    print(f"{len(todo)} calls to make ({len(done)} done), spent ${budget.spent:.4f}, cap ${cap:.2f}")

    def one(job: tuple[str, str, str, int]) -> None:
        sid, model, variant, rep = job
        snap = {**snaps[sid], "brief": brief_for(variant, snaps[sid], wins[sid])}
        meta = {"phase": "replay", "arm": "baseline", "trial": ids.index(sid), "variant": variant, "repeat": rep}
        try:
            out = harness.call(clients[model], budget, snap, None, meta, PROFILE)
        except harness.BudgetExhausted as e:
            print(f"stop: {e}")
            return
        row = {"snapshot": sid, "model": model.split("/")[-1], "variant": variant, "repeat": rep, "profile": PROFILE}
        row |= {"brief": snap["brief"], **out}
        with lock, OUT.open("a") as f:
            f.write(json.dumps(row) + "\n")

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(one, todo))
    print(f"spent ${budget.spent:.4f} in total")


def report() -> None:
    from stats import wilson

    # the published copy is gzipped (results/replay.jsonl.gz); a run in progress writes the plain file
    gz = OUT.with_suffix(".jsonl.gz")
    text = OUT.read_text() if OUT.exists() else gzip.decompress(gz.read_bytes()).decode()
    rows = [json.loads(x) for x in text.splitlines()]
    snaps = {s["id"]: s for s in json.loads((HERE / "data" / "snapshots.json").read_text())}
    wins = {w["id"]: w for w in json.loads(WINDOWS.read_text())}

    def f(k: int, n: int) -> str:
        if not n:
            return "0/0"
        lo, hi = wilson(k, n)
        return f"{k}/{n} {k / n:.2f} [{lo:.2f}, {hi:.2f}]"

    ok = sum(1 for r in rows if r.get("verified") and r.get("side"))
    print(f"{len(rows)} calls, {ok} verified with a side, ${sum(r.get('usd') or 0 for r in rows):.4f}\n")
    for v in VARIANTS:
        print(f"## Variant {v}")
        maj = majorities(rows, v)
        follow: dict[str, list[int]] = {}
        for sid, by_model in maj.items():
            move = float(snaps[sid]["move_bps"])
            for model, side in by_model.items():
                if move:
                    k = follow.setdefault(model, [0, 0])
                    k[0] += (side == "Long") == (move > 0)
                    k[1] += 1
        for m in sorted(follow):
            print(f"follows the move      {m:28} {f(*follow[m])}")
        for m, frac in sorted(self_agreement(rows, v).items()):
            print(f"agrees with itself    {m:28} {f(*frac)}")
        pairs = disagreement(rows, v)
        for pair, frac in sorted(pairs.items()):
            print(f"disagree              {' vs '.join(pair):58} {f(*frac)}")
        tot = (sum(x[0] for x in pairs.values()), sum(x[1] for x in pairs.values()))
        print(f"disagree, all pairs   {'':28} {f(*tot)}")
        for horizon in ("px_6m", "px_60m"):
            for m, frac in sorted(hit_rate(rows, v, wins, horizon).items()):
                print(f"right at {horizon[3:]:4}         {m:28} {f(*frac)}")
        print()
    print("## Baselines (no model)")
    for horizon in ("px_6m", "px_60m"):
        for name, frac in baselines(snaps, wins, horizon).items():
            print(f"right at {horizon[3:]:4}         {name:28} {f(*frac)}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["windows", "run", "report"])
    p.add_argument("--cap", type=float, default=0.0, help="hard cap on the lab's total logged spend, in $")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--limit", type=int, default=None, help="only the first N snapshots (a pilot)")
    p.add_argument("--models", default="")
    a = p.parse_args()
    if a.cmd == "windows":
        fetch_windows()
    elif a.cmd == "report":
        report()
    else:
        import harness

        if a.cap <= 0:
            sys.exit("--cap is required: the total the lab may have spent when this run ends")
        run(a.cap, a.workers, a.models.split(",") if a.models else list(harness.MODELS), a.limit)


if __name__ == "__main__":
    main()
