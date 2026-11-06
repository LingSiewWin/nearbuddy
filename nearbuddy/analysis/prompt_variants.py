#!/usr/bin/env python3
"""Candidate v2 system prompts for the arena duelist (docs/research/prompt-defense.md, section 3) and the
per-duel arm assignment for the A/B/C night run (section 4). The text lives in agents/prompts.py, which the
runner uses; this module re-exports it for the analysis scripts and runs its doctests.

    agents/.venv/bin/python analysis/prompt_variants.py   # doctests, then each variant's token estimate (4 chars/token)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agents"))

import prompts
from prompts import (  # noqa: F401
    MARK,
    VARIANT_A,
    VARIANT_B,
    VARIANT_C,
    VARIANTS,
    datamark,
    pick_variant,
    user_a,
    user_bc,
)


def tokens(text: str) -> int:
    """4 chars per token, the rule the brief uses."""
    return -(-len(text) // 4)


if __name__ == "__main__":
    import doctest

    failed, _ = doctest.testmod(prompts)
    if failed:
        raise SystemExit(1)
    for name, text in VARIANTS.items():
        t = tokens(text.format(symbol="NEAR/USD"))
        print(
            f"variant {name}: {len(text)} chars ~ {t} tokens {'OK' if t < 350 else 'OVER 350'}"
        )
