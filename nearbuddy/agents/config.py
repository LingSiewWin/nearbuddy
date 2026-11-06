"""Shared settings for the arena agents: the merged `.env` + process environment and the data paths."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# a bare `KEY` line in .env reads as None; drop it so every value is a str
ENV: dict[str, str] = {
    **{k: v for k, v in dotenv_values(ROOT / ".env").items() if v is not None},
    **os.environ,
}
DATA = HERE / "data" / "decisions.jsonl"
ATTEST_DIR = HERE / "data" / "attestations"
