"""`runner.play_duel` in commit-reveal mode, offline: the stub model decides, a fake clock (local and chain) drives the
cycles and a scripted solver takes /commit and /reveal. The contract keeps one commitment per agent per duel, so the
runner commits a changed call (replacing the held one), keeps an unchanged one, reveals nothing during the duel and
opens the one held commitment per agent only inside the intent lock (duel #395: a refused late commit must not leave
an earlier call public before the lock). Also: commits whose answer was lost, Ctrl-C and SIGTERM, and the consent
signatures on POST /duel."""

import base64
import hashlib
import json
import os
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
from nearai import Completion, StubClient  # noqa: E402

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

    def post(self, path, body, deadline_ns=None):
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
    monkeypatch.setattr(runner, "chain_now_ns", lambda **_: clock.ns)
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


class Scripted(StubClient):
    """A stub whose sides follow a script, one per call; the last side repeats."""

    def __init__(self, sides):
        super().__init__()
        self.sides = list(sides)

    def complete(self, system, user):
        side = self.sides.pop(0) if len(self.sides) > 1 else self.sides[0]
        return Completion(json.dumps({"direction": side.lower(), "reasoning": "scripted"}), None, self.model_id)


def scripted(*scripts):
    """Players Y, Z, ... with scripted sides (same keys as the env fixture's players)."""
    out = []
    for name, sides in zip(("Y", "Z"), scripts, strict=False):
        model = Scripted(sides)
        d, sk, comp = runner.make_duelist(name, model, hardened=False)
        out.append((name, d, sk, comp, model))
    return out


def opened(solver, i):
    """The commitment digest a /reveal body opens: sha256(intent bytes || salt)."""
    r = [b for p, b, _ in solver.posts if p == "/reveal"][i]
    return base64.b64encode(
        hashlib.sha256(intent_message(r["signed"]["intent"]) + base64.b64decode(r["salt"])).digest()
    ).decode()


def commits(solver):
    return [b["commitment"] for p, b, _ in solver.posts if p == "/commit"]


def reveal_times(solver):
    return [t for p, _, t in solver.posts if p == "/reveal"]


def test_nothing_is_revealed_during_the_duel_and_only_the_last_commitment_opens_inside_the_lock(env):
    clock, _ = env
    players = scripted(["Long", "Short", "Long"])
    sk = players[0][2]
    solver = FakeSolver(clock)
    assert play(solver, players) == 13  # cycles at t=0, 20, 40; commits stop at STOP_NS=60, the lock opens at 90
    assert solver.paths() == ["/commit", "/commit", "/commit", "/reveal"]
    assert [t for p, _, t in solver.posts if p == "/commit"] == [0, 20 * S, 40 * S]
    for c in [b for p, b, _ in solver.posts if p == "/commit"]:
        sk.verify_key.verify(commit_message(ARENA, "5", base64.b64decode(c["commitment"])), base64.b64decode(c["sig"]))
        assert c["duel_id"] == "5" and c["agent_pk"] == pk_b64(sk)
    assert all(LOCK_AT <= t < CLOSE_NS for t in reveal_times(solver)), "every reveal inside the lock"
    assert opened(solver, 0) == commits(solver)[-1], "the commitment the contract holds: the last one"
    rs = rows()
    assert [(r["intent"]["nonce"], r.get("replaced_by"), r["revealed_tx"]) for r in rs] == [
        ("11", "C2", None),
        ("12", "C3", None),
        ("13", None, "R1"),
    ]
    assert len(set(commits(solver))) == 3, "a fresh salt per commitment"
    assert rs[-1]["quotes"] == [{"follower": "f.testnet", "amount": "5", "amountOut": None}]


def test_an_unchanged_call_keeps_the_held_commitment(env):
    clock, _ = env
    solver = FakeSolver(clock)
    play(solver, scripted(["Long"]))
    assert solver.paths() == ["/commit", "/reveal"], "one commitment, one reveal"
    rs = rows()
    assert [r["kept_commitment"] for r in rs if "kept_commitment" in r] == [commits(solver)[0]] * 2
    assert [r["revealed_tx"] for r in rs] == [None, None, "R1"]  # the kept rows are written first
    assert next(r for r in rs if r["revealed_tx"])["intent"]["nonce"] == "11", "the committed call is the scored one"


def test_a_commit_refused_inside_the_lock_reveals_nothing_before_the_lock(env):
    # duel #395: Z's second commit is refused by the intent lock; its first commitment is still held and must stay
    # hidden until the lock opens, as must Y's
    clock, _ = env
    solver = FakeSolver(clock, fail={("/commit", 4): "Smart contract panicked: intent lock"})
    play(solver, scripted(["Long", "Short"], ["Short", "Long"]))
    assert solver.paths()[:4] == ["/commit", "/commit", "/commit", "/commit"]
    assert sorted(solver.paths()[4:]) == ["/reveal", "/reveal"]
    assert all(LOCK_AT <= t < CLOSE_NS for t in reveal_times(solver)), reveal_times(solver)
    opened_now = {opened(solver, 0), opened(solver, 1)}
    assert opened_now == {commits(solver)[2], commits(solver)[1]}, "Y's second commitment, Z's first"
    late = [r for r in rows() if r.get("error")]
    assert len(late) == 1 and late[0]["error"] == "intent lock" and late[0]["committed_tx"] is None


def test_ctrl_c_mid_duel_reveals_every_held_commitment_at_once(env, monkeypatch):
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


class FailFor(FakeSolver):
    """/reveal for one agent raises `err`; everything else as FakeSolver."""

    def __init__(self, clock, pk, err):
        super().__init__(clock)
        self.pk, self.err = pk, err

    def post(self, path, body, deadline_ns=None):
        if path == "/reveal" and body["signed"]["intent"]["agent_pk"] == self.pk:
            self.posts.append((path, body, self.clock.ns))
            raise self.err
        return super().post(path, body, deadline_ns)


def test_one_failed_final_reveal_does_not_strand_the_other_agent(env):
    clock, players = env
    for err, text in (
        (RuntimeError("solver /reveal 500: rpc timeout"), "rpc timeout"),
        (requests.ConnectionError("connection reset"), "connection reset"),
    ):
        clock.ns = 0
        solver = FailFor(clock, pk_b64(players[0][2]), err)
        DATA_FILE[0].unlink(missing_ok=True)
        play(solver, players)
        final = sorted(b["signed"]["intent"]["agent_pk"] for p, b, _ in solver.posts if p == "/reveal")
        assert final == sorted(pk_b64(p[2]) for p in players), "both final reveals were attempted"
        failed = [r for r in rows() if r.get("error")]
        assert len(failed) == 1 and text in failed[0]["error"] and failed[0]["revealed_tx"] is None


def test_a_commit_that_times_out_is_revealed_first_since_it_may_have_landed(env):
    clock, _ = env
    solver = FakeSolver(clock, fail={("/commit", 2): requests.Timeout("read timed out")})
    with pytest.raises(requests.Timeout):
        play(solver, scripted(["Long", "Short"]))
    assert solver.paths() == ["/commit", "/commit", "/reveal"]
    assert opened(solver, 0) == commits(solver)[1], "the salt of the commit whose answer was lost"
    rs = {r["commitment"]: r for r in rows()}
    new, older = rs[commits(solver)[1]], rs[commits(solver)[0]]
    assert new["committed_tx"] is None and new["revealed_tx"] == "R1"
    assert older["replaced_by"] is None and older["revealed_tx"] is None, "the older one, replaced since that landed"


def test_a_transport_failure_on_the_newest_candidate_still_tries_the_older_one(env):
    # the second commit's answer was lost, and its reveal fails in transport too: the first commitment may be the one
    # on chain, so it is revealed as well (the contract refuses whichever it does not hold)
    clock, _ = env
    solver = FakeSolver(
        clock,
        fail={("/commit", 2): requests.Timeout("read timed out"), ("/reveal", 1): requests.ConnectionError("reset")},
    )
    with pytest.raises(requests.Timeout):
        play(solver, scripted(["Long", "Short"]))
    assert solver.paths() == ["/commit", "/commit", "/reveal", "/reveal"]
    assert opened(solver, 0) == commits(solver)[1] and opened(solver, 1) == commits(solver)[0]
    rs = {r["commitment"]: r for r in rows()}
    assert rs[commits(solver)[1]]["error"].startswith("reveal failed") and "reset" in rs[commits(solver)[1]]["error"]
    assert rs[commits(solver)[0]]["revealed_tx"] == "R2"


@pytest.mark.parametrize("where", ["price", "arena"])
def test_a_transient_error_mid_duel_holds_the_commitments_until_the_lock(env, monkeypatch, where):
    # duel #395's lesson, for errors: a price-feed or GET /arena glitch must not open the held calls early
    clock, players = env
    calls = {"n": 0}

    def flaky(*_a):
        calls["n"] += 1
        if calls["n"] == 2:  # the second cycle
            raise (
                RuntimeError("price fetch failed after 4 attempts")
                if where == "price"
                else requests.ConnectionError("x")
            )
        return 366_000_000

    solver = FakeSolver(clock)
    if where == "price":
        monkeypatch.setattr(runner, "price", flaky)
    else:
        real_get = solver.get
        solver.get = lambda path: flaky() and real_get(path)
    with pytest.raises((RuntimeError, requests.ConnectionError)):
        play(solver, players)
    assert solver.paths() == ["/commit", "/commit", "/reveal", "/reveal"]
    assert all(LOCK_AT <= t < CLOSE_NS for t in reveal_times(solver)), reveal_times(solver)
    assert all(r["revealed_tx"] for r in rows())


def test_a_commit_error_that_may_have_landed_holds_until_the_lock_too(env):
    clock, _ = env
    solver = FakeSolver(clock, fail={("/commit", 2): requests.Timeout("read timed out")})
    with pytest.raises(requests.Timeout):
        play(solver, scripted(["Long", "Short"]))
    assert reveal_times(solver) and all(LOCK_AT <= t < CLOSE_NS for t in reveal_times(solver))


def test_a_timed_out_commit_that_never_landed_falls_back_to_the_held_one(env):
    clock, _ = env
    solver = FakeSolver(
        clock,
        fail={
            ("/commit", 2): requests.Timeout("read timed out"),
            ("/reveal", 1): "reveal_intent failed: Smart contract panicked: commitment mismatch",
        },
    )
    with pytest.raises(requests.Timeout):
        play(solver, scripted(["Long", "Short"]))
    assert solver.paths() == ["/commit", "/commit", "/reveal", "/reveal"]
    assert opened(solver, 0) == commits(solver)[1] and opened(solver, 1) == commits(solver)[0]
    rs = {r["commitment"]: r for r in rows()}
    assert rs[commits(solver)[1]]["error"] == "commitment not on chain"
    assert rs[commits(solver)[0]]["revealed_tx"] == "R2"


def test_a_commit_the_contract_refused_leaves_the_held_one_to_reveal(env):
    clock, _ = env
    refused = "commit_intent failed: Smart contract panicked: agent not in duel"
    solver = FakeSolver(clock, fail={("/commit", 2): refused})
    with pytest.raises(RuntimeError, match="agent not in duel"):
        play(solver, scripted(["Long", "Short"]))
    assert solver.paths() == ["/commit", "/commit", "/reveal"]
    assert opened(solver, 0) == commits(solver)[0], "the refused one was never stored"


def test_the_final_reveal_waits_for_the_chain_clock_not_the_local_one(env, monkeypatch):
    clock, players = env
    lag = 2 * S  # the chain's final block trails the local clock
    monkeypatch.setattr(runner, "chain_now_ns", lambda **_: clock.ns - lag)
    solver = FakeSolver(clock)
    play(solver, players)
    assert all(LOCK_AT + lag <= t < CLOSE_NS for t in reveal_times(solver)), reveal_times(solver)


def test_a_chain_clock_lagging_past_the_backstop_is_overruled_by_the_local_clock(env, monkeypatch):
    clock, players = env
    monkeypatch.setattr(runner, "chain_now_ns", lambda **_: clock.ns - 20 * S)
    solver = FakeSolver(clock)
    play(solver, players)
    backstop = CLOSE_NS - runner.BACKSTOP_BEFORE_CLOSE_NS
    deadline = CLOSE_NS - runner.REVEAL_MARGIN_S * S
    assert all(backstop <= t < deadline for t in reveal_times(solver)), reveal_times(solver)
    assert all(r["revealed_tx"] for r in rows() if r.get("commitment"))


def test_a_slow_rpc_cannot_hold_the_reveal_past_the_backstop(env, monkeypatch):
    # each chain read takes whatever time it is given and then fails, as a throttled RPC does
    clock, players = env
    budgets = []

    def throttled(timeout=5):
        budgets.append(timeout)
        clock.ns += int(timeout * S)
        raise RuntimeError("after 2 attempts: rate limit")

    monkeypatch.setattr(runner, "chain_now_ns", throttled)
    solver = FakeSolver(clock)
    play(solver, players)
    assert all(b <= 5 for b in budgets), budgets
    assert all(t < CLOSE_NS - runner.REVEAL_MARGIN_S * S for t in reveal_times(solver)), reveal_times(solver)
    assert not [r for r in rows() if r.get("error")], "no deadline miss"


def test_a_hanging_rpc_with_a_short_lock_still_reveals_before_the_deadline(env, monkeypatch):
    # the real chain_now_ns over a fake transport that hangs for the whole timeout of every attempt (requests.post)
    # and a fake clock for the backoff (time.sleep): with a 10 s lock the backstop leaves 2 s before the reveal
    # deadline, so a read may not cost more than the budget it was given
    import chain

    clock, players = env
    monkeypatch.setattr(runner, "chain_now_ns", chain.chain_now_ns)
    attempts = []

    hang_from = CLOSE_NS - runner.BACKSTOP_BEFORE_CLOSE_NS - int(5.2 * S)  # a full 5 s budget is left

    def hanging(url, json=None, headers=None, timeout=None):
        if clock.ns < hang_from:  # answers at once, but the chain's final block lags far behind
            lagging = {"result": {"header": {"timestamp_nanosec": str(clock.ns - 100 * S)}}}
            return type("R", (), {"status_code": 200, "json": lambda self: lagging})()
        # from here every attempt hangs for requests' worst case: connect + read, a scalar applying to each
        cost = sum(timeout) if isinstance(timeout, tuple) else 2 * timeout
        attempts.append(cost)
        clock.ns += int(cost * S)
        raise requests.Timeout("read timed out")

    monkeypatch.setattr(requests, "post", hanging)
    solver = FakeSolver(clock)
    play(solver, players)
    deadline = CLOSE_NS - runner.REVEAL_MARGIN_S * S
    assert attempts and all(a <= 5 for a in attempts), attempts
    assert reveal_times(solver) and all(t < deadline for t in reveal_times(solver)), reveal_times(solver)
    assert not [r for r in rows() if r.get("error")], "no deadline miss"


def test_a_chain_read_stuck_past_its_timeout_cannot_hold_the_reveal(monkeypatch):
    # real local clock, real chain_now_ns, a transport that ignores its timeout (DNS, a trickling server) and blocks
    # far past the backstop: hold_until_lock must stop waiting on that read and return by the backstop
    import threading

    release = threading.Event()

    def stuck(url, json=None, headers=None, timeout=None):
        release.wait(10)
        raise requests.Timeout("read timed out")

    monkeypatch.setattr(requests, "post", stuck)
    now = time.time_ns()
    close_at = now + runner.BACKSTOP_BEFORE_CLOSE_NS + int(0.6 * S)  # backstop 0.6 s from now
    try:
        runner.hold_until_lock(now + int(0.2 * S), close_at)
        returned = time.time_ns()
    finally:
        release.set()  # let the abandoned read thread finish
    assert returned < close_at - runner.REVEAL_MARGIN_S * S, (returned - now) / S
    assert returned - now < 1.5 * S, (returned - now) / S


def test_a_slow_last_cycle_never_sleeps_past_the_commit_window(env, monkeypatch):
    # duel 464: the last cycle started just before stop_ns, a slow model call ran past it, then the full
    # cycle_seconds sleep ran past close_at - REVEAL_MARGIN_S, and both reveals were refused as late
    clock, _ = env
    players = scripted(["Short"], ["Short"])
    slow = players[1][4]
    real = slow.complete

    def slow_complete(system, user):
        clock.ns += 12 * S  # every call by Z takes 12 s
        return real(system, user)

    slow.complete = slow_complete
    solver = FakeSolver(clock)
    runner.play_duel(solver, "5", "NEAR/USD", 365_000_000, CLOSE_NS, STOP_NS, players, 10, 45, {}, True, LOCK_S)
    # cycles at 0 and ~57 (< STOP_NS 60): Z's second call ends at ~69; the 45 s sleep must not follow
    assert solver.paths() == ["/commit", "/commit", "/reveal", "/reveal"]
    assert all(LOCK_AT <= t < CLOSE_NS - runner.REVEAL_MARGIN_S * S for t in reveal_times(solver)), reveal_times(solver)
    assert not [r for r in rows() if r.get("error")]


def test_no_model_call_starts_after_the_commit_window(env):
    clock, _ = env
    players = scripted(["Short"], ["Short"])
    slow = players[0][4]
    real = slow.complete

    def slow_complete(system, user):
        clock.ns += 25 * S  # Y's call takes 25 s: cycle 1 ends at 25, sleeps to 45; Y's second call ends at 70
        return real(system, user)

    slow.complete = slow_complete
    solver = FakeSolver(clock)
    play(solver, players)
    per_agent = {pk_b64(p[2]): sum(1 for r in rows() if r["agent_pk"] == pk_b64(p[2])) for p in players}
    assert list(per_agent.values()) == [2, 1], "Z's second call would start at 70, past STOP_NS 60: skipped"
    assert all(LOCK_AT <= t < CLOSE_NS - runner.REVEAL_MARGIN_S * S for t in reveal_times(solver))


def test_an_unreadable_chain_clock_still_reveals_at_the_local_backstop(env, monkeypatch):
    # backstop: halfway through the lock, but no later than REVEAL_MARGIN_S + 2 s before close (here: close - 7 s)
    clock, players = env

    def down(**_):
        raise RuntimeError("after 5 attempts: rpc down")

    monkeypatch.setattr(runner, "chain_now_ns", down)
    solver = FakeSolver(clock)
    play(solver, players[:1])
    backstop = min(LOCK_AT + LOCK_S * S // 2, CLOSE_NS - runner.BACKSTOP_BEFORE_CLOSE_NS)
    assert backstop <= reveal_times(solver)[-1] < CLOSE_NS - runner.REVEAL_MARGIN_S * S
    assert all(r["revealed_tx"] for r in rows() if r.get("commitment"))


def test_ctrl_c_while_holding_for_the_lock_reveals_at_once(env, monkeypatch):
    clock, players = env
    solver = FakeSolver(clock)

    def chain_now(**_):
        if clock.ns >= 70 * S:  # past STOP_NS, waiting for the lock
            raise KeyboardInterrupt
        return clock.ns

    monkeypatch.setattr(runner, "chain_now_ns", chain_now)
    with pytest.raises(KeyboardInterrupt):
        play(solver, players)
    final = reveal_times(solver)
    assert len(final) == 2 and all(STOP_NS <= t < LOCK_AT for t in final)
    assert all(r["revealed_tx"] for r in rows() if "kept_commitment" not in r)


def test_without_a_lock_the_last_call_is_revealed_when_commits_stop(env):
    clock, players = env
    solver = FakeSolver(clock)
    play(solver, players[:1], lock_s=0)
    assert STOP_NS <= reveal_times(solver)[-1] < LOCK_AT


def test_sigterm_while_a_commit_lands_reveals_only_the_new_commitment_once(env):
    clock, _ = env

    class KilledOnSecondCommit(FakeSolver):
        def post(self, path, body, deadline_ns=None):
            out = super().post(path, body)
            if path == "/commit" and self.paths().count("/commit") == 2:
                os.kill(os.getpid(), signal.SIGTERM)  # the kill arrives after the commit landed, before it returns
            return out

    solver = KilledOnSecondCommit(clock)
    old = signal.getsignal(signal.SIGTERM)
    runner.exit_on_sigterm()
    try:
        with pytest.raises(SystemExit):
            play(solver, scripted(["Long", "Short"]))
    finally:
        signal.signal(signal.SIGTERM, old)
    assert solver.paths() == ["/commit", "/commit", "/reveal"]
    assert opened(solver, 0) == commits(solver)[1]
    assert rows()[0]["replaced_by"] == "C2", "held was updated before the exit: the old row knows its replacement"


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
    def post(self, path, body, deadline_ns=None):
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
