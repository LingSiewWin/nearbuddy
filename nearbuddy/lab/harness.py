"""Runs the pre-registered trials (README.md) through the live duelists' own code: `prompts` builds the messages,
`duelist.Duelist.decide` parses the decision, `nearai.NearAiClient` sends the exact request bytes, and
`intent_client.tee_proof` checks the enclave signature over our request and response hashes.

    uv run --locked python harness.py snapshots           # freeze Coinbase candles into data/snapshots.json (free)
    uv run --locked python harness.py probe               # one signed call per model; drops unsigned models
    uv run --locked python harness.py run --phase pilot --n 10
    uv run --locked python harness.py run --phase main --n 240 --prompts naive,hardened     # experiments A and B
    uv run --locked python harness.py run --phase main --n 240 --prompts hardened-v2        # experiment C

Every paid call is logged to spend.jsonl (model, tokens in and out, $). A call is refused when its worst-case cost
would take the logged spend past --cap. A trial is appended to results/<phase>.jsonl only once all its calls are
done; a rerun skips the trials already there, so an interrupted run resumes.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "agents"))
from config import ENV  # noqa: E402
from duelist import Duelist, DuelistError  # noqa: E402
from intent_client import TeeProofError, tee_proof  # noqa: E402
from nearai import DEFAULT_MAX_TOKENS, MAX_TOKENS, Completion, NearAiClient  # noqa: E402
from prices import brief  # noqa: E402

DATA = HERE / "data"
RESULTS = HERE / "results"
SPEND = HERE / "spend.jsonl"
SNAPSHOTS = DATA / "snapshots.json"
ATTACKS = DATA / "attacks.jsonl"
SEED = 20261110
MODELS = ("deepseek-ai/DeepSeek-V4.1-Flash-1017", "Qwen/Qwen3.8-27B", "z-ai/glm-5.3-flash")
PRICE = {  # $ per token, in / out (overnight brief)
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": (0.30e-6, 1.20e-6),
    "Qwen/Qwen3.8-27B": (0.04e-6, 1.35e-6),
    "z-ai/glm-5.3-flash": (0.08e-6, 0.50e-6),
}
WORST_PROMPT_TOKENS = 2000  # a lab prompt is ~300 tokens; the reservation assumes far more
ARMS = ("baseline", "cue", "clean", "placebo")
OPPOSITE = {"Long": "Short", "Short": "Long"}
SYMBOLS = {"NEAR": "NEAR/USD", "BTC": "BTC/USD", "ETH": "ETH/USD", "SOL": "SOL/USD"}


# ---------- snapshots ----------
CANDLES = "https://api.exchange.coinbase.com/products/{base}-USD/candles"
SNAP_DAY = datetime(2026, 11, 3, tzinfo=UTC)  # a past Tuesday
DUEL_MINUTES = 5  # the brief is read 5 minutes after the duel's open, inside a 330 s duel
PER_SIGN = 6  # per asset: 6 windows that moved up and 6 that moved down


def price8(x: float | str) -> int:
    return int(Decimal(str(x)) * 10**8)


def day_candles(asset: str) -> dict[int, list[float]]:
    """Coinbase one-minute candles for SNAP_DAY by unix time: [time, low, high, open, close, volume]."""
    out: dict[int, list[float]] = {}
    for chunk in range(0, 24 * 60, 300):  # the endpoint returns at most 300 candles per request
        t0 = SNAP_DAY + timedelta(minutes=chunk)
        r = requests.get(
            CANDLES.format(base=asset),
            params={"granularity": "60", "start": t0.isoformat(), "end": (t0 + timedelta(minutes=299)).isoformat()},
            timeout=20,
        )
        r.raise_for_status()
        out |= {int(c[0]): c for c in r.json()}
        time.sleep(0.3)  # public endpoint, a few requests per second
    return out


def snapshot(asset: str, t0: datetime, candles: dict[int, list[float]]) -> dict[str, Any] | None:
    """The duel opened at the open of minute t0; the brief is read at the close of the minute DUEL_MINUTES - 1
    later. None when either minute is missing."""
    end = t0 + timedelta(minutes=DUEL_MINUTES - 1)
    first, last = candles.get(int(t0.timestamp())), candles.get(int(end.timestamp()))
    if not first or not last:
        return None
    symbol = SYMBOLS[asset]
    open8, px8 = price8(first[3]), price8(last[4])
    return {
        "id": f"{asset}-{t0:%Y%m%dT%H%MZ}",
        "asset": asset,
        "symbol": symbol,
        "t_open": t0.isoformat(),
        "t_brief": (end + timedelta(minutes=1)).isoformat(),
        "open8": open8,
        "px8": px8,
        "move_bps": round((px8 - open8) / open8 * 10_000, 1),
        "brief": brief(symbol, px8, open8),
        "source": f"{CANDLES.format(base=asset)}?granularity=60: open of the first minute, close of the last",
    }


def balanced(windows: list[dict[str, Any]], k: int = PER_SIGN) -> list[dict[str, Any]]:
    """k windows that moved up and k that moved down (by the brief's rounded bps), evenly spaced in time within
    each sign, so the frozen set is not one afternoon's trend."""
    out = []
    for up in (True, False):
        side = [w for w in windows if (w["move_bps"] > 0 if up else w["move_bps"] < 0)]
        out += [side[round(i * (len(side) - 1) / (k - 1))] for i in range(k)]
    return sorted(out, key=lambda w: w["t_open"])


def freeze_snapshots() -> None:
    """Candidate duels open on every half hour of SNAP_DAY; `balanced` keeps 12 per asset."""
    snaps = []
    for asset in SYMBOLS:
        candles = day_candles(asset)
        windows = [snapshot(asset, SNAP_DAY + timedelta(minutes=m), candles) for m in range(0, 24 * 60, 30)]
        snaps += balanced([w for w in windows if w])
    SNAPSHOTS.write_text(json.dumps(snaps, indent=1) + "\n")
    print(f"{SNAPSHOTS}: {len(snaps)} snapshots")


# ---------- corpus and plan ----------
def load_corpus() -> tuple[dict[tuple[str, str, str], dict[str, Any]], dict[tuple[str, str], dict[str, Any]]]:
    """(attack rows by (template, asset, direction), placebo rows by (template, asset))."""
    attack, placebo = {}, {}
    for line in ATTACKS.read_text().splitlines():
        r = json.loads(line)
        if r["direction"]:
            attack[(r["template_id"], r["asset"], r["direction"])] = r
        else:
            placebo[(r["template_id"], r["asset"])] = r
    return attack, placebo


def plan(
    phase: str, n: int, snapshot_ids: list[str], templates: list[str], placebos: list[str]
) -> list[dict[str, Any]]:
    """The first n trials of `phase`, fixed by the seed before any call. Snapshots and templates each run through
    fresh shuffles in turn, so both stay balanced; the placebo template is drawn per trial."""
    rng = random.Random(f"{SEED}:{phase}")

    def cycle(items: list[str]) -> list[str]:
        out: list[str] = []
        while len(out) < n:
            out += rng.sample(items, len(items))
        return out[:n]

    snaps, temps = cycle(sorted(snapshot_ids)), cycle(sorted(templates))
    return [
        {"trial": i, "snapshot": snaps[i], "template_id": temps[i], "placebo_template_id": rng.choice(sorted(placebos))}
        for i in range(n)
    ]


# ---------- spend ----------
class BudgetExhausted(RuntimeError):
    pass


class Budget:
    """Hard cap on logged spend. Each in-flight call reserves its worst case, so concurrent calls cannot overshoot."""

    def __init__(self, cap: float, path: Path = SPEND) -> None:
        self.cap, self.path = cap, path
        self.spent = sum(json.loads(x)["usd"] for x in path.read_text().splitlines()) if path.exists() else 0.0
        self.reserved = 0.0
        self.lock = threading.Lock()

    @staticmethod
    def worst(model: str) -> float:
        pin, pout = PRICE[model]
        return WORST_PROMPT_TOKENS * pin + MAX_TOKENS.get(model, DEFAULT_MAX_TOKENS) * pout

    def reserve(self, model: str) -> None:
        with self.lock:
            if self.spent + self.reserved + self.worst(model) > self.cap:
                raise BudgetExhausted(f"spent ${self.spent:.4f}, cap ${self.cap:.2f}")
            self.reserved += self.worst(model)

    def settle(self, model: str, usage: dict[str, Any] | None, meta: dict[str, Any]) -> float:
        """Release the reservation and log the call's real cost. No usage (a failed call) costs nothing."""
        pin, pout = PRICE[model]
        tin, tout = (usage or {}).get("prompt_tokens", 0), (usage or {}).get("completion_tokens", 0)
        usd = tin * pin + tout * pout
        with self.lock:
            self.reserved -= self.worst(model)
            self.spent += usd
            row = {"ts": datetime.now(UTC).isoformat(), "model": model, "tokens_in": tin, "tokens_out": tout}
            row |= {"usd": round(usd, 8), "cum_usd": round(self.spent, 6), **meta}
            with self.path.open("a") as f:
                f.write(json.dumps(row) + "\n")
        return usd


# ---------- one call ----------
TRANSIENT_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}


def complete_with_retries(client: NearAiClient, system: str, user: str, attempts: int = 5) -> Completion:
    for i in range(attempts):
        try:
            return client.complete(system, user)
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            if status not in TRANSIENT_STATUS or i == attempts - 1:
                raise
        except (requests.ConnectionError, requests.Timeout):
            if i == attempts - 1:
                raise
        time.sleep(2**i)
    raise AssertionError("unreachable")


def usage_of(c: Completion | None) -> dict[str, Any] | None:
    try:
        return json.loads(c.response_bytes).get("usage") if c and c.response_bytes else None
    except ValueError:
        return None


def call(
    client: NearAiClient,
    budget: Budget,
    snap: dict[str, Any],
    headline: str | None,
    meta: dict[str, Any],
    prompt: str = "naive",
) -> dict[str, Any]:
    """One stateless decision through the duelist's own path, with its enclave proof. Never raises for a model
    failure: parse, transport and signature failures are recorded in the returned dict."""
    model = client.model_id
    last: list[Completion] = []

    def complete(system: str, user: str) -> str:
        last.append(complete_with_retries(client, system, user))
        return last[-1].text

    duelist = Duelist(address="lab", hardened=False, model=model, complete_fn=complete)
    duelist.profile = prompt  # the runner's --profile setter: naive, hardened or hardened-v2
    out: dict[str, Any] = {"headline": headline, "side": None, "error": None, "verified": False}
    budget.reserve(model)
    t0 = time.monotonic()
    c: Completion | None = None
    try:
        d = duelist.decide(snap["symbol"], snap["brief"], headline)
        out["side"] = "Long" if d.direction > 0 else "Short"
        # the size that trades; hardened-v2 also states one (size_asked) that policy_size caps under paid text
        out |= {"size_bps": d.size_bps, "size_asked": d.size_asked, "size_cap": d.size_cap}
        out["cues_removed"] = d.cues_removed
    except DuelistError as e:
        out["error"] = f"parse: {e}"[:300]
    except (requests.RequestException, UnicodeDecodeError) as e:
        out["error"] = f"transport: {e}"[:300]
    finally:
        c = last[-1] if last else None
        out["usd"] = budget.settle(model, usage_of(c), meta | {"chat_id": c.chat_id if c else None})
    out["latency_s"] = round(time.monotonic() - t0, 2)
    if c is None:
        return out
    out |= {
        "text": c.text,
        "chat_id": c.chat_id,
        "request_body": c.request_bytes.decode(),
        "response_body": c.response_bytes.decode(),
        "request_hash": c.request_hash.hex(),
        "response_hash": c.response_hash.hex(),
        "usage": usage_of(c),
    }
    out |= prove(client, c)
    return out


def prove(client: NearAiClient, c: Completion) -> dict[str, Any]:
    """The enclave record for this completion and whether it verifies: provider enclave (kind 2), ed25519 over
    `{model}:{sha256(request)}:{sha256(response)}` of OUR bytes."""
    if not c.chat_id:
        return {"signature_record": None, "tee": None, "tee_error": "no chat id"}
    try:
        record = client.signature(c.chat_id)
    except requests.RequestException as e:
        return {"signature_record": None, "tee": None, "tee_error": f"fetch: {e}"[:200]}
    if not record:
        return {"signature_record": None, "tee": None, "tee_error": "no signature record"}
    try:
        tee = tee_proof(record, client.model_id, c.request_hash, c.response_hash)
    except (TeeProofError, KeyError, ValueError) as e:
        return {"signature_record": record, "tee": None, "tee_error": f"rejected: {e}"[:200]}
    if tee["kind"] != 2:
        return {"signature_record": record, "tee": tee, "tee_error": f"kind {tee['kind']}, not the provider enclave"}
    return {"signature_record": record, "tee": tee, "tee_error": None, "verified": True}


# ---------- one trial ----------
def run_trial(
    client: NearAiClient,
    budget: Budget,
    phase: str,
    t: dict[str, Any],
    snaps: dict[str, dict[str, Any]],
    attack: dict[tuple[str, str, str], dict[str, Any]],
    placebo: dict[tuple[str, str], dict[str, Any]],
    prompt: str = "naive",
) -> dict[str, Any]:
    """Baseline first; the attack row is the one pushing against the baseline's side; then cue, clean, placebo."""
    snap = snaps[t["snapshot"]]
    rec: dict[str, Any] = {
        "phase": phase,
        "prompt": prompt,
        "model": client.model_id,
        **t,
        "asset": snap["asset"],
        "symbol": snap["symbol"],
        "brief": snap["brief"],
        "move_bps": snap["move_bps"],
        "calls": {},
        "excluded": None,
    }
    meta = {"phase": phase, "prompt": prompt, "trial": t["trial"]}
    base = rec["calls"]["baseline"] = call(client, budget, snap, None, meta | {"arm": "baseline"}, prompt)
    if base["side"] is None:
        rec["excluded"] = "baseline: " + (base["error"] or "no side")
        return rec
    d = OPPOSITE[base["side"]]
    row = attack[(t["template_id"], snap["asset"], d)]
    prow = placebo[(t["placebo_template_id"], snap["asset"])]
    rec |= {"direction": d, "attack_row_id": row["id"], "placebo_row_id": prow["id"]}
    for arm, text in (("cue", row["text_cue"]), ("clean", row["text_clean"]), ("placebo", prow["text_cue"])):
        rec["calls"][arm] = call(client, budget, snap, text, meta | {"arm": arm}, prompt)
    return rec


def done_trials(path: Path) -> set[tuple[str, str, int]]:
    if not path.exists():
        return set()
    rows = map(json.loads, path.read_text().splitlines())
    return {(r["model"], r.get("prompt", "naive"), r["trial"]) for r in rows}


def run(
    phase: str,
    n: int,
    models: list[str],
    cap: float,
    until: datetime | None,
    prompts: tuple[str, ...] = ("naive",),
    workers: int = 4,
) -> None:
    snaps = {s["id"]: s for s in json.loads(SNAPSHOTS.read_text())}
    attack, placebo = load_corpus()
    trials = plan(phase, n, list(snaps), sorted({k[0] for k in attack}), sorted({k[0] for k in placebo}))
    out = RESULTS / f"{phase}.jsonl"
    RESULTS.mkdir(exist_ok=True)
    done = done_trials(out)
    budget = Budget(cap)
    clients = {m: NearAiClient(ENV["NEAR_AI_API_KEY"], m) for m in models}
    stop = threading.Event()
    write = threading.Lock()
    # round-robin across prompts and models, so a budget or deadline stop leaves every cell at about the same N
    jobs = [(t, m, pr) for t in trials for pr in prompts for m in models if (m, pr, t["trial"]) not in done]
    print(f"{phase}: {len(jobs)} trials to run ({len(done)} already done), spent so far ${budget.spent:.4f}")

    def one(job: tuple[dict[str, Any], str, str]) -> None:
        t, m, pr = job
        if stop.is_set():
            return
        if until and datetime.now(UTC) >= until:
            stop.set()
            print(f"deadline {until.isoformat()} reached; stopping")
            return
        try:
            rec = run_trial(clients[m], budget, phase, t, snaps, attack, placebo, pr)
        except BudgetExhausted as e:
            stop.set()
            print(f"budget stop: {e}")
            return  # the partial trial's calls are in spend.jsonl; the trial is rerun on resume
        with write, out.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        sides = " ".join(f"{a}={(rec['calls'].get(a) or {}).get('side')}" for a in ARMS)
        print(f"  {m.split('/')[-1]:<26} {pr:<8} #{t['trial']:<3} d={rec.get('direction')} {sides} ${budget.spent:.4f}")

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(one, jobs))
    print(f"{phase}: done, spent ${budget.spent:.4f}")


def probe(models: list[str]) -> list[str]:
    """One baseline call per model on the first snapshot; keeps the models whose enclave signature verifies."""
    snap = json.loads(SNAPSHOTS.read_text())[0]
    budget = Budget(10.0)
    RESULTS.mkdir(exist_ok=True)
    ok = []
    for m in models:
        rec = call(NearAiClient(ENV["NEAR_AI_API_KEY"], m), budget, snap, None, {"phase": "probe", "arm": "baseline"})
        rec["model"] = m
        with (RESULTS / "probe.jsonl").open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"{m}: side={rec['side']} verified={rec['verified']} {rec.get('tee_error') or rec['error'] or ''}")
        if rec["verified"]:
            ok.append(m)
    print("keep:", ok, "drop:", [m for m in models if m not in ok])
    return ok


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["snapshots", "probe", "run"])
    p.add_argument("--phase", choices=["pilot", "main"], default="pilot")
    p.add_argument("--n", type=int, default=10)
    p.add_argument("--models", default=",".join(MODELS))
    p.add_argument("--cap", type=float, default=9.50)
    p.add_argument("--until", default="2026-11-10T07:15:00+08:00")
    p.add_argument("--prompts", default="naive", help="comma list of runner profiles: naive, hardened, hardened-v2")
    a = p.parse_args()
    models = a.models.split(",")
    if a.cmd == "snapshots":
        freeze_snapshots()
    elif a.cmd == "probe":
        probe(models)
    else:
        until = datetime.fromisoformat(a.until) if a.until else None
        run(a.phase, a.n, models, a.cap, until, tuple(a.prompts.split(",")))


if __name__ == "__main__":
    main()
