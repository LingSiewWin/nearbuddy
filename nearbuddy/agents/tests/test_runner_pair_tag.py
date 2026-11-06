import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402
from keys import key_tag  # noqa: E402

SEED_A = "11" * 32
SEED_B = "22" * 32
RUNNER = Path(__file__).resolve().parents[1] / "runner.py"


def seeded(monkeypatch):
    for k in ("AGENT_KEY_A", "AGENT_KEY_B"):
        monkeypatch.delitem(runner.ENV, k, raising=False)
    monkeypatch.setitem(runner.ENV, "AGENT_SEED_A", SEED_A)
    monkeypatch.setitem(runner.ENV, "AGENT_SEED_B", SEED_B)


def pk_of(seed: bytes) -> str:
    return runner.pk_b64(runner.SigningKey(seed))


def test_main_pair_keys_are_unchanged(monkeypatch):
    seeded(monkeypatch)
    raw = bytes.fromhex(SEED_A)
    assert key_tag("", False) == "" and key_tag("", True) == "swap"
    assert runner.pk_b64(runner.agent_key("A", True, key_tag("", False))) == pk_of(
        hashlib.sha256(raw + b"tee").digest()
    )
    assert runner.pk_b64(runner.agent_key("A", True, key_tag("", True))) == pk_of(
        hashlib.sha256(raw + b"teeswap").digest()
    )


def test_a_tagged_pair_shares_no_key_with_the_main_pair_or_another_tag(monkeypatch):
    seeded(monkeypatch)
    main, p2, p3 = runner.arena_pks(), runner.arena_pks("p2"), runner.arena_pks("p3")
    assert len(main) == len(p2) == len(p3) == 8  # A/B x plain/tee x plain/swap
    assert not set(main) & set(p2) and not set(p2) & set(p3) and not set(main) & set(p3)
    # deterministic: the same seed and tag give the same agent on every run
    tee_a = hashlib.sha256(bytes.fromhex(SEED_A) + b"tee" + b"pair:p2:").digest()
    assert pk_of(tee_a) in p2 and p2 == runner.arena_pks("p2")


def test_every_row_carries_the_pair_tag(monkeypatch, tmp_path):
    data = tmp_path / "decisions.jsonl"
    monkeypatch.setattr(runner, "DATA", data)
    monkeypatch.setattr(runner, "PAIR_TAG", "")
    runner.record({"duel_id": "1"})
    monkeypatch.setattr(runner, "PAIR_TAG", "p2")
    runner.record({"duel_id": "2", "pair_tag": "spoofed"})
    rows = [json.loads(line) for line in data.read_text().splitlines()]
    assert [r["pair_tag"] for r in rows] == [None, "p2"]


def cli(*args: str, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), *args],
        env={**os.environ, "NEAR_AI_API_KEY": "", "AGENT_KEY_A": "", "AGENT_KEY_B": "", **env},
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_cli_refuses_a_bad_tag_or_a_fixed_key():
    r = cli("--pair-tag", "P2")
    assert r.returncode == 2 and "lowercase" in r.stderr
    r = cli("--pair-tag", "p2", AGENT_KEY_A=SEED_A)
    assert r.returncode == 2 and "AGENT_KEY_" in r.stderr
