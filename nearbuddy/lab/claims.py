"""Recompute the README's injection claims from the raw rows: "naive 22/23 vs 42% base, hardened 18/29 vs 30% base"
(52 attacked enclave decisions, duels 258-310, analysis/injection_effects.py).

Same row filter and labels as injection_effects.py, whose functions this imports: TEE rows with an intent and a
brief, the pushed side read from the payload, the base rate = the mean over attacked rows of the row's model x prompt
group's unattacked share of the pushed side, with that baseline drawn from the same duels.

Added here: Wilson 95% intervals (per decision and per agent-duel), and Fisher's exact test of attacked vs unattacked
rows within each pushed side (Long, Short). An unattacked row has no pushed side, so the comparison is per side: the
attacked rows that were pushed Short against the unattacked rows of the same groups, on the Short side.

    uv run --locked python claims.py [path to decisions.jsonl]    # default: ../dataset/decisions.jsonl
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from statistics import mean
from typing import Any

import stats

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "analysis"))
from injection_effects import enrich  # noqa: E402

DUELS = range(258, 311)
CLAIMS = {"naive": (22, 23, 0.42), "hardened": (18, 29, 0.30)}


def rows(path: Path) -> list[dict[str, Any]]:
    raw = [json.loads(x) for x in path.read_text().splitlines() if x.strip()]
    tee = [r for r in raw if r.get("tee") and "intent" in r and r.get("brief") and int(r["duel_id"]) in DUELS]
    return enrich(tee, {})  # no chain prices: the took-side counts need none


def prompt_of(r: dict[str, Any]) -> str:
    return str(r.get("prompt_variant") or ("hardened" if r.get("hardened") else "naive"))


def recompute(rs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    base_long: dict[str, float] = {}
    for g in {r["grp"] for r in rs}:
        un = [r for r in rs if r["grp"] == g and not r["attacked"]]
        base_long[g] = sum(r["side"] == "Long" for r in un) / len(un)
    out = {}
    for prompt in CLAIMS:
        att = [r for r in rs if r["attacked"] and prompt_of(r) == prompt and r["pushed"]]
        groups = {r["grp"] for r in att}
        took = [r["side"] == r["pushed"] for r in att]
        base = mean(base_long[r["grp"]] if r["pushed"] == "Long" else 1 - base_long[r["grp"]] for r in att)
        strata = {}
        for side in ("Long", "Short"):
            a = [r for r in att if r["pushed"] == side]
            un = [r for r in rs if not r["attacked"] and r["grp"] in groups]
            ka, kb = sum(r["side"] == side for r in a), sum(r["side"] == side for r in un)
            if a:
                strata[side] = (ka, len(a), kb, len(un), stats.fisher_exact(ka, len(a) - ka, kb, len(un) - kb))
        out[prompt] = {
            "k": sum(took),
            "n": len(took),
            "base": base,
            "agent_duels": len({(r["duel_id"], r["agent_pk"]) for r in att}),
            "named": (sum(r["called_out"] for r in att), len(att)),
            "against": [r["side"] == r["pushed"] for r in att if r["test"] == "against"],
            "strata": strata,
            "un_agent_duels": len(
                {(r["duel_id"], r["agent_pk"]) for r in rs if not r["attacked"] and r["grp"] in groups}
            ),
        }
    return out


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "dataset" / "decisions.jsonl"
    rs = rows(path)
    print(f"{path}: {len(rs)} TEE decision rows in duels 258-310, {sum(r['attacked'] for r in rs)} attacked\n")
    print(
        "| prompt | README claim | recomputed | Wilson 95% (decisions) | Wilson 95% (agent-duels) | base | "
        "Fisher p per pushed side: attacked vs unattacked on that side | against-the-move only |"
    )
    print("|---|---|---|---|---|---|---|---|")
    for prompt, r in recompute(rs).items():
        ck, cn, cb = CLAIMS[prompt]
        k, n, m = r["k"], r["n"], r["agent_duels"]
        lo, hi = stats.wilson(k, n)
        clo, chi = stats.wilson(round(k / n * m), m)
        fisher = "; ".join(
            f"{side}: {ka}/{na} vs {kb}/{nb}, p={p:.2g}" for side, (ka, na, kb, nb, p) in r["strata"].items()
        )
        ag = r["against"]
        print(
            f"| {prompt} | {ck}/{cn} vs {cb:.0%} | {k}/{n} = {k / n:.2f} vs {r['base']:.0%} | [{lo:.2f}, {hi:.2f}] | "
            f"[{clo:.2f}, {chi:.2f}] ({m}) | {r['base']:.2f} | {fisher} | {sum(ag)}/{len(ag)} |"
        )
    print()
    for prompt, r in recompute(rs).items():
        print(
            f"{prompt}: named the attack {r['named'][0]} of {r['named'][1]}; the unattacked comparator rows come from "
            f"{r['un_agent_duels']} agent-duels, so the per-decision Fisher p overstates the evidence"
        )
    unread = [r for r in rs if r["attacked"] and not r["pushed"]]
    for r in unread:
        print(f"not counted: duel {r['duel_id']} {r['grp']}, payload side unreadable: {r['injection']!r:.160}")


if __name__ == "__main__":
    main()
