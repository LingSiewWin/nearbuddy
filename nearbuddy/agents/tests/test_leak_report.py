"""`leak_report` splits copier rows into public vs commit-reveal, prices the mirror return per horizon and measures the
information window against the follower quote. Synthetic rows only: no network."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "analysis"))

import leak_report  # noqa: E402

T0 = "2026-11-06T12:00:00+00:00"
T0_MS = leak_report.ms(T0)


def row(duel, pk, nonce, side, p0, p15, close=None, **extra):
    base = {"duel_id": duel, "agent_pk": pk, "nonce": nonce, "side": side, "detected_at": T0, "p0": p0, "p15": p15}
    return {**base, "p60": None, "p90": None, "close_price": close, **extra}


def write(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


def fixture(tmp_path: Path):
    v1 = [
        row("1", "X", "1", "Long", 100.0, 101.0, close="10100000000"),  # +100 bps at +15 s and close
        row("1", "Y", "2", "Short", 100.0, 99.0),  # short into a fall: +100 bps
        row("2", "X", "3", "Long", 100.0, 99.5),  # legacy row whose decision committed first
    ]
    v2 = [
        # replaces v1 #1
        row("1", "X", "1", "Long", 100.0, 101.0, close="10100000000", phase={"commit_reveal": False}),
        row(
            "3",
            "Y",
            "4",
            "Short",
            100.0,
            100.5,
            phase={"commit_reveal": True, "commit_to_reveal_s": 40.0},
            info_window_s=1.5,
        ),
    ]
    decisions = [
        {"duel_id": "1", "intent": {"agent_pk": "X", "nonce": "1"}, "tx": "T1"},
        {"duel_id": "1", "intent": {"agent_pk": "Y", "nonce": "2"}, "tx": "T2"},
        {"duel_id": "2", "intent": {"agent_pk": "X", "nonce": "3"}, "commitment": "c=", "revealed_tx": "T3"},
        {"duel_id": "9", "error": "no intent"},
    ]
    tx_times = {"T1": T0_MS - 2_000, "T2": T0_MS + 3_000}  # T3 missing: no window for that row
    paths = [write(tmp_path / "copier.jsonl", v1), write(tmp_path / "copier-v2.jsonl", v2)]
    return paths, write(tmp_path / "decisions.jsonl", decisions), tx_times


def test_regimes_returns_and_windows(tmp_path):
    paths, dec, tx_times = fixture(tmp_path)
    rows, decisions = leak_report.load(paths, dec)
    assert len(rows) == 4  # the v2 row replaced its v1 twin
    public, cr = leak_report.summarize(rows, decisions, tx_times)

    assert (public["regime"], public["n"], public["duels"]) == (leak_report.PUBLIC, 2, 1)
    n, m, lo, hi = public["returns"]["+15s"]
    assert n == 2 and abs(m - 100) < 1e-9 and abs(lo - 100) < 1e-9 and abs(hi - 100) < 1e-9
    assert public["returns"]["close"][:2] == (1, 100.0)
    assert public["returns"]["+60s"][0] == 0
    assert (public["windows"], public["before_quote"], public["median_window_s"]) == (2, 1, -0.5)  # +2 s and -3 s

    assert (cr["n"], cr["duels"]) == (2, 2)  # legacy commitment row + v2 commit-reveal row
    assert cr["returns"]["+15s"][:2] == (2, -50.0)  # long into -50 bps, short into +50 bps
    assert (cr["windows"], cr["before_quote"], cr["median_window_s"]) == (1, 0, 1.5)
    assert cr["median_commit_to_reveal_s"] == 40.0

    table = leak_report.render([public, cr])
    assert "| public post_intent | 2 | 1 | +100.00 [+100.00, +100.00] n=2 |" in table
    assert "50% (1/2)" in table


def test_main_writes_markdown(tmp_path, monkeypatch, capsys):
    paths, dec, tx_times = fixture(tmp_path)
    cache = tmp_path / "tx_times.json"
    cache.write_text(json.dumps(tx_times))
    out = tmp_path / "docs" / "leak.md"
    argv = ["leak_report.py", "--copier", *map(str, paths), "--decisions", str(dec)]
    monkeypatch.setattr(sys, "argv", [*argv, "--tx-times", str(cache), "--out", str(out)])
    leak_report.main()
    text = out.read_text()
    assert text.startswith("# Copier leak: before and after commit-reveal")
    assert "| commit-reveal | 2 | 2 |" in text
    assert "| commit-reveal | 2 | 2 |" in capsys.readouterr().out
