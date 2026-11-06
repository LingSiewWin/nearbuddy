"""`runner.play_duel` in commit-reveal mode, offline: the stub model decides, a fake clock (local and chain) drives the
cycles and a scripted solver takes /commit and /reveal. Covers the commit->reveal cycle, the final reveal held until
the chain clock is inside the contract's intent lock, no dangling commitment on Ctrl-C or a late commit, and the
consent signatures on POST /duel."""

import base64
import hashlib
import json
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402
from chain import ARENA  # noqa: E402
from config import ENV  # noqa: E402
from intent_client import commit_message, consent_message, intent_message  # noqa: E402
from keys import pk_b64  # noqa: E402
from nearai import StubClient  # noqa: E402

S = 1_000_000_000
CLOSE_NS = 100 * S
LOCK_S = 10
LOCK_AT = CLOSE_NS - LOCK_S * S  # the contract refuses commits from here on; reveals stay open until CLOSE_NS
STOP_NS = 60 * S  # the runner's last commit cycle: close_at - (intent lock + margin), well before LOCK_AT


class Clock:
    def __init__(self) -> None:
        self.ns = 0

    def sleep(self, s: float) -> None:
        self.ns += int(s * S)


class FakeSolver:
    """Records (path, body, clock) for every POST; `fail` maps a path to the error its n-th call raises."""

    def __init__(self, clock: Clock, fail: dict[tuple[str, int], str | Exception] | None = None) -> None:
        self.clock = clock
        self.posts: list[tuple[str, dict, int]] = []
        self.fail = fail or {}

    def get(self, path):
        assert path == "/arena"
        return {"pending": {}}

    def post(self, path, body):
        self.posts.append((path, body, self.clock.ns))
        n = sum(1 for p, _, _ in self.posts if p == path)
        if (path, n) in self.fail:
            err = self.fail[(path, n)]
            raise err if isinstance(err, Exception) else RuntimeError(f"solver {path} 500: {err}")
        if path == "/commit":
            return {"tx": f"C{n}"}
        if path == "/reveal":
            return {"tx": f"R{n}", "quotes": [{"follower": "f.testnet", "amount": "5"}]}
        if path == "/intent":
            return {"tx": "TX", "quotes": []}
        return {"ok": True}

    def paths(self):
        return [p for p, _, _ in self.posts]


DATA_FILE: list[Path] = []  # this test's dataset file, set by the fixture


@pytest.fixture
def env(tmp_path, monkeypatch):
    DATA_FILE[:] = [tmp_path / "decisions.jsonl"]
    monkeypatch.setattr(runner, "DATA", DATA_FILE[0])
    monkeypatch.setattr(runner, "price", lambda *_a: 366_000_000)
    clock = Clock()
    monkeypatch.setattr(time, "time_ns", lambda: clock.ns)
    monkeypatch.setattr(time, "sleep", clock.sleep)
    monkeypatch.setattr(runner, "chain_now_ns", lambda: clock.ns)
    players = []
    for name in ("Y", "Z"):
        monkeypatch.delitem(ENV, f"AGENT_KEY_{name}", raising=False)
        monkeypatch.delitem(ENV, f"AGENT_SEED_{name}", raising=False)
        model = StubClient()
        d, sk, comp = runner.make_duelist(name, model, hardened=False)
        players.append((name, d, sk, comp, model))
    return clock, players


def play(solver, players, commit_reveal=True, lock_s=LOCK_S):
    return runner.play_duel(
        solver, "5", "NEAR/USD", 365_000_000, CLOSE_NS, STOP_NS, players, 10, 20, {}, commit_reveal, lock_s
    )


def rows():
    return [json.loads(line) for line in DATA_FILE[0].read_text().splitlines()]


def test_each_cycle_reveals_the_previous_commitment_then_commits_and_the_last_is_revealed_inside_the_lock(env):
    clock, players = env
    (_, _, sk, _, _) = players[0]
    solver = FakeSolver(clock)
    assert play(solver, players[:1]) == 13  # cycles at t=0, 20, 40; t=60 is STOP_NS, the lock opens at t=90
    assert solver.paths() == ["/commit", "/reveal", "/commit", "/reveal", "/commit", "/reveal"]
    commits = [(b, t) for p, b, t in solver.posts if p == "/commit"]
    reveals = [(b, t) for p, b, t in solver.posts if p == "/reveal"]
    for (c, ct), (r, rt) in zip(commits, reveals, strict=True):
        digest = base64.b64decode(c["commitment"])
        # the reveal opens exactly this commitment: sha256(intent bytes || salt)
        salt = base64.b64decode(r["salt"])
        assert len(salt) == 32
        assert hashlib.sha256(intent_message(r["signed"]["intent"]) + salt).digest() == digest
        # and the commitment is the agent's, for this contract and duel
        sk.verify_key.verify(commit_message(ARENA, "5", digest), base64.b64decode(c["sig"]))
        assert c["duel_id"] == "5" and c["agent_pk"] == pk_b64(sk) and r["tee"] is None
        assert rt > ct, "never revealed in the cycle it was committed"
    assert [t for _, t in commits] == [0, 20 * S, 40 * S]
    assert all(t < STOP_NS for _, t in reveals[:-1]), "earlier calls open in the next cycle"
    assert LOCK_AT <= reveals[-1][1] < CLOSE_NS, "the scored call opens inside the intent lock, before close_at"
    assert len({b["salt"] for b, _ in reveals}) == 3, "a fresh salt per commitment"
    rs = rows()
    assert [r["intent"]["nonce"] for r in rs] == ["11", "12", "13"]
    assert [(r["committed_tx"], r["revealed_tx"], r["tx"]) for r in rs] == [
        ("C1", "R1", "R1"),
        ("C2", "R2", "R2"),
        ("C3", "R3", "R3"),
    ]
    assert [r["commitment"] for r in rs] == [b["commitment"] for b, _ in commits]
    assert rs[0]["quotes"] == [{"follower": "f.testnet", "amount": "5", "amountOut": None}]


def test_ctrl_c_mid_duel_still_reveals_every_held_commitment(env, monkeypatch):
    clock, players = env
    solver = FakeSolver(clock)

    def interrupted(_s):
        raise KeyboardInterrupt

    monkeypatch.setattr(time, "sleep", interrupted)
    with pytest.raises(KeyboardInterrupt):
        play(solver, players)
    assert solver.paths() == ["/commit", "/commit", "/reveal", "/reveal"]
    assert {r["agent_pk"] for r in rows()} == {pk_b64(p[2]) for p in players}
    assert all(r["revealed_tx"] for r in rows())


def test_a_commit_refused_by_the_intent_lock_stops_the_duel_and_the_other_commitment_is_revealed(env):
    clock, players = env
    solver = FakeSolver(clock, fail={("/commit", 4): "Smart contract panicked: intent lock"})
    play(solver, players)
    # cycle 1: Y commits, Z commits. cycle 2: Y reveals + commits, Z reveals, Z's commit refused. Then Y's reveal.
    assert solver.paths() == ["/commit", "/commit", "/reveal", "/commit", "/reveal", "/commit", "/reveal"]
    rs = rows()
    late = [r for r in rs if r.get("error")]
    assert len(late) == 1 and late[0]["error"] == "intent lock" and late[0]["committed_tx"] is None
    assert sum(1 for r in rs if r.get("revealed_tx")) == 3


def test_one_failed_final_reveal_does_not_strand_the_other_agent(env):
    clock, players = env
    solver = FakeSolver(clock, fail={("/reveal", 5): "rpc timeout"})
    play(solver, players)
    final = [b["signed"]["intent"]["agent_pk"] for p, b, t in solver.posts if p == "/reveal" and t >= STOP_NS]
    assert len(final) == 2, "both final reveals were attempted"
    failed = [r for r in rows() if r.get("error")]
    assert len(failed) == 1 and failed[0]["error"].startswith("reveal failed") and failed[0]["revealed_tx"] is None


def test_a_commit_that_times_out_is_still_revealed_since_it_may_have_landed(env):
    clock, players = env
    solver = FakeSolver(clock, fail={("/commit", 2): requests.Timeout("read timed out")})
    with pytest.raises(requests.Timeout):
        play(solver, players[:1])
    assert solver.paths() == ["/commit", "/reveal", "/commit", "/reveal"]
    timed_out, final = solver.posts[2][1], solver.posts[3][1]
    salt = base64.b64decode(final["salt"])
    assert hashlib.sha256(intent_message(final["signed"]["intent"]) + salt).digest() == base64.b64decode(
        timed_out["commitment"]
    ), "the salt of the commit whose answer was lost"
    last = rows()[-1]
    assert last["committed_tx"] is None and last["revealed_tx"] == "R2"


def test_a_commit_the_contract_refused_is_not_revealed(env):
    clock, players = env
    refused = "commit_intent failed: Smart contract panicked: agent not in duel"
    solver = FakeSolver(clock, fail={("/commit", 2): refused})
    with pytest.raises(RuntimeError, match="agent not in duel"):
        play(solver, players[:1])
    assert solver.paths() == ["/commit", "/reveal", "/commit"], "nothing stored on chain, nothing to reveal"


def test_a_transport_error_on_one_final_reveal_does_not_skip_the_next(env):
    clock, players = env
    solver = FakeSolver(clock, fail={("/reveal", 5): requests.ConnectionError("connection reset")})
    play(solver, players)
    final = [b["signed"]["intent"]["agent_pk"] for p, b, t in solver.posts if p == "/reveal" and t >= STOP_NS]
    assert final == [pk_b64(players[0][2]), pk_b64(players[1][2])]
    failed = [r for r in rows() if r.get("error")]
    assert len(failed) == 1 and "connection reset" in failed[0]["error"]
    assert failed[0]["agent_pk"] == pk_b64(players[0][2])


def test_the_final_reveal_waits_for_the_chain_clock_not_the_local_one(env, monkeypatch):
    clock, players = env
    lag = 4 * S  # the chain's final block trails the local clock
    monkeypatch.setattr(runner, "chain_now_ns", lambda: clock.ns - lag)
    solver = FakeSolver(clock)
    play(solver, players)
    final = [t for p, _, t in solver.posts if p == "/reveal"][-2:]
    assert all(LOCK_AT + lag <= t < CLOSE_NS for t in final), final


def test_an_unreadable_chain_clock_still_reveals_halfway_through_the_lock(env, monkeypatch):
    clock, players = env

    def down():
        raise RuntimeError("after 5 attempts: rpc down")

    monkeypatch.setattr(runner, "chain_now_ns", down)
    solver = FakeSolver(clock)
    play(solver, players[:1])
    last = [t for p, _, t in solver.posts if p == "/reveal"][-1]
    assert LOCK_AT + LOCK_S * S // 2 <= last < CLOSE_NS


def test_ctrl_c_while_holding_for_the_lock_reveals_at_once(env, monkeypatch):
    clock, players = env
    solver = FakeSolver(clock)

    def chain_now():
        if clock.ns >= 70 * S:  # past STOP_NS, waiting for the lock
            raise KeyboardInterrupt
        return clock.ns

    monkeypatch.setattr(runner, "chain_now_ns", chain_now)
    with pytest.raises(KeyboardInterrupt):
        play(solver, players)
    final = [t for p, _, t in solver.posts if p == "/reveal"][-2:]
    assert len(final) == 2 and all(STOP_NS <= t < LOCK_AT for t in final)
    assert all(r["revealed_tx"] for r in rows())


def test_without_a_lock_the_last_call_is_revealed_when_commits_stop(env):
    clock, players = env
    solver = FakeSolver(clock)
    play(solver, players[:1], lock_s=0)
    assert STOP_NS <= [t for p, _, t in solver.posts if p == "/reveal"][-1] < LOCK_AT


SIGTERM_CHILD = """
import sys, time
from pathlib import Path
agents, out = sys.argv[1], Path(sys.argv[2])
sys.path.insert(0, agents)
import runner
from config import ENV
from nearai import StubClient
for k in ("AGENT_KEY_Z", "AGENT_SEED_Z"):
    ENV.pop(k, None)
runner.DATA = out / "decisions.jsonl"
runner.price = lambda *_a: 366_000_000
class Solver:
    def get(self, path):
        return {"pending": {}}
    def post(self, path, body):
        with (out / "posts.log").open("a") as f:
            f.write(path + "\\n")
        return {"tx": "T", "quotes": []}
runner.exit_on_sigterm()
model = StubClient()
d, sk, comp = runner.make_duelist("Z", model, hardened=False)
now = time.time_ns()
runner.play_duel(Solver(), "5", "NEAR/USD", 365_000_000, now + 600 * 10**9, now + 500 * 10**9,
                 [("Z", d, sk, comp, model)], 10, 300, {}, True)
"""


def test_sigterm_mid_duel_still_reveals_the_held_commitment(tmp_path):
    agents = str(Path(__file__).resolve().parents[1])
    child = subprocess.Popen([sys.executable, "-c", SIGTERM_CHILD, agents, str(tmp_path)])
    log = tmp_path / "posts.log"
    deadline = time.time() + 20
    while not (log.exists() and "/commit" in log.read_text()):
        assert time.time() < deadline and child.poll() is None, "child never committed"
        time.sleep(0.05)
    child.send_signal(signal.SIGTERM)  # the child is in its 300 s cycle sleep holding the commitment
    assert child.wait(timeout=10) == 143
    assert log.read_text().split() == ["/commit", "/reveal"]


def test_plain_mode_still_posts_intents(env):
    clock, players = env
    solver = FakeSolver(clock)
    assert play(solver, players[:1], commit_reveal=False) == 13
    assert solver.paths() == ["/intent"] * 3
    assert all("commitment" not in r and r["tx"] == "TX" for r in rows())


def test_duel_request_carries_both_consent_signatures_only_when_asked(env):
    _, players = env
    ska, skb = players[0][2], players[1][2]
    plain = runner.duel_request(ska, skb, "wrap.near", 1_700_000_000_000_000_000, consent=False)
    assert plain == {"a": pk_b64(ska), "b": pk_b64(skb), "symbol": "wrap.near", "close_at": "1700000000000000000"}
    body = runner.duel_request(ska, skb, "wrap.near", 1_700_000_000_000_000_000, consent=True)
    msg = consent_message(ARENA, pk_b64(ska), pk_b64(skb), "wrap.near", "1700000000000000000")
    ska.verify_key.verify(msg, base64.b64decode(body["sig_a"]))
    skb.verify_key.verify(msg, base64.b64decode(body["sig_b"]))
    assert {k: body[k] for k in plain} == plain
