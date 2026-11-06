"""Run agents/runner.py as `__main__` with its dataset redirected to $E2E_DATA, so a sandbox run (e2e/run.ts) never
appends to the real agents/data/decisions.jsonl. Arguments pass straight through to the runner."""

import os
import runpy
import sys
from pathlib import Path

AGENTS = Path(__file__).resolve().parents[1] / "agents"
sys.path.insert(0, str(AGENTS))

import config  # noqa: E402  (runner.py imports DATA from here; patch it before the runner loads)

config.DATA = Path(os.environ["E2E_DATA"])
config.ATTEST_DIR = config.DATA.parent / "attestations"
sys.argv[0] = str(AGENTS / "runner.py")
runpy.run_path(str(AGENTS / "runner.py"), run_name="__main__")
