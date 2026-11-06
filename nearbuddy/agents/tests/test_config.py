"""NEARBUDDY_DATA moves the dataset the runner appends to and summarize reads; unset, it stays agents/data."""

import os
import subprocess
import sys
from pathlib import Path

AGENTS = Path(__file__).resolve().parents[1]


def data_path(env_value: str | None, module: str) -> str:
    env = {k: v for k, v in os.environ.items() if k != "NEARBUDDY_DATA"}
    if env_value is not None:
        env["NEARBUDDY_DATA"] = env_value
    code = f"import sys; sys.path.insert(0, {str(AGENTS)!r}); import {module}; print({module}.DATA)"
    return subprocess.run(
        [sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True
    ).stdout.strip()


def test_nearbuddy_data_moves_the_dataset(tmp_path):
    target = str(tmp_path / "sandbox.jsonl")
    assert data_path(target, "config") == target
    assert data_path(target, "summarize") == target


def test_unset_or_empty_keeps_agents_data():
    default = str(AGENTS / "data" / "decisions.jsonl")
    assert data_path(None, "config") == default
    assert data_path("", "config") == default
