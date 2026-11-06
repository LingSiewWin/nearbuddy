"""Arena runner: pairs two model-backed duelists, drives one duel per round through the solver, hands
each decision's enclave signature to the contract as a `TeeProof`, asks the Outlayer oracle to resolve,
and appends one dataset row per decision (with the exact request and response bytes) to
agents/data/decisions.jsonl.

    .venv/bin/python -m runner --rounds 2 --duel-seconds 330 --cycle-seconds 30

Prompt-defense experiment (docs/research/prompt-defense.md, section 4): `--variants A,B,C` puts agent A on
`pick_variant(duel_id)` among the listed arms each duel while agent B stays naive as the within-duel control;
every row carries `prompt_variant`. A variant-C decision whose `evidence_used` lacks "oracle" is recorded as
`error: "evidence not oracle"` and not posted.

Self-hosted (one side only; the solver's PAIR_EVERY_S loop opens the duel, this process finds it via GET /agent_duel):

    AGENT_KEY_B=<seed> NEAR_AI_MODEL_B=<model> SOLVER_URL=https://... ARENA_SECRET=<shared> \\
        .venv/bin/python runner.py --only B --wait-pairing [--hardened]

Commit-reveal (`--commit-reveal`, or on by itself when get_config says `commit_reveal: true`): each cycle an agent
reveals its previous call (POST /reveal: intent, salt, tee; followers are quoted then) and commits the new one
(POST /commit: sha256(intent bytes || salt) signed over commit_message). Commits stop at the intent lock; the last
commitment is revealed before close_at, and on Ctrl-C too, since an unrevealed commitment is slashed. Rows gain
`commitment`, `committed_tx`, `revealed_tx`. `--consent` (two-sided runs only) has both agents sign the duel terms
so the solver opens it with open_duel_consented; a self-hosted `--only` runner holds one key, so it gets
commit-reveal but never consent.

Second pair (`--pair-tag p2`, scripts/second-loop.sh): the same seeds derive a distinct key set per tag
(keys.key_tag), so two loops with other NEAR_AI_MODEL_A/B never share an agent; every row carries `pair_tag`
(null for the main pair) and `--resolve-stuck` / `--check-agents` act on that pair only.

Agents are ed25519 keys derived from AGENT_SEED_A / AGENT_SEED_B (hex, 32 bytes) in the env file,
or fresh random keys when unset (then they are registered on every run). With NEAR_AI_API_KEY set the
agents are registered as TEE-backed and the contract refuses any intent without a verified proof.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import secrets
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from any cwd: `python agents/runner.py`
from typing import Any

import requests
from nacl.signing import SigningKey

from chain import ARENA, ASSETS, agent_tier_on_chain, view, wait_outcome
from config import ATTEST_DIR, DATA, ENV, NET
from duelist import Duelist, DuelistError
from intent_client import (
    Solver,
    TeeProofError,
    commit_message,
    commitment,
    consent_message,
    proof_hash,
    sign_b64,
    sign_intent,
    tee_proof,
)
from keys import agent_key, key_tag, pk_b64, register_sig
from nearai import Completion, ModelClient, client_from_env
from prices import brief, price
from prompts import VARIANTS, pick_variant


class Tracked:
    """`complete_fn` for a Duelist that keeps the last Completion (exact bytes, chat id) for the TEE proof."""

    def __init__(self, client: ModelClient) -> None:
        self.client = client
        self.last = Completion("", None, client.model_id)

    def __call__(self, system: str, user: str) -> str:
        self.last = self.client.complete(system, user)
        return self.last.text


def make_duelist(
    name: str, model_client: ModelClient, hardened: bool, tag: str = ""
) -> tuple[Duelist, SigningKey, Tracked]:
    sk = agent_key(name, model_client.tee, tag)
    if ENV.get(f"AGENT_KEY_{name}"):
        # a builder's agent: the tier is whatever `register_agent` recorded, not what the client class assumes
        tier = agent_tier_on_chain(pk_b64(sk))
        if tier is not None and tier != model_client.tee:
            model_client.tee = tier

    complete = Tracked(model_client)
    d = Duelist(address=pk_b64(sk), hardened=hardened, model=model_client.model_id, complete_fn=complete)
    return d, sk, complete


PAIR_TAG = ""  # `--pair-tag`: which agent pair this process drives; "" = the main pair


def record(row: dict[str, Any]) -> None:
    """Append one dataset row, tagged with the pair (`pair_tag` null = the main pair) so two loops sharing the file
    can be split."""
    DATA.parent.mkdir(parents=True, exist_ok=True)
    with DATA.open("a") as f:
        f.write(json.dumps({**row, "pair_tag": PAIR_TAG or None}) + "\n")


def save_attestation(model_client: ModelClient) -> str | None:
    """Fetch and keep the enclave attestation once per model per run; the file is the raw material a third
    party feeds to NVIDIA NRAS and dcap-qvl to check the signer we trust on chain."""
    att = model_client.attestation()
    if not att:
        return None
    ATTEST_DIR.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9._-]", "_", model_client.model_id) + f"-{int(time.time())}.json"
    (ATTEST_DIR / name).write_text(json.dumps(att))
    report = att.get("report") or {}
    signers = [m.get("signing_address") for m in report.get("model_attestations", [])]
    print(f"attestation {model_client.model_id}: status {att.get('status')} signers {signers} -> {name}")
    return name


def resolve_duel(solver: Solver, duel_id: str, attempts: int = 4) -> dict[str, Any]:
    """Ask the oracle (the solver pays its deposit) and wait for the callback; re-ask when the RPC dropped the
    send or the oracle did not answer in time. The call is idempotent until the duel is resolved."""
    txs: list[str] = []
    outcome = None
    for _ in range(attempts):
        try:
            r = solver.post("/resolve", {"duel_id": duel_id})
        except RuntimeError as e:
            if "no open price" not in str(e):
                raise
            # the oracle never delivered the open price (TEE fetch failed): ask again, then retry the close
            print(f"  duel {duel_id} has no open price; re-asking the oracle")
            solver.post("/open_price", {"duel_id": duel_id})
            time.sleep(30)
            continue
        if r.get("tx"):
            txs.append(r["tx"])
        outcome = wait_outcome(duel_id, 120 if r.get("sent", True) else 30)
        if outcome:
            break
    return {"tx": txs[-1] if txs else "", "txs": txs, "outcome": outcome}


Prepared = tuple[dict[str, Any], dict[str, Any] | None, list[dict[str, Any]], dict[str, Any]]


def prepare_decision(
    duel_id: str,
    symbol: str,
    px: int,
    open_px: int,
    close_at_ns: int,
    pending: dict[str, list[dict[str, Any]]],
    nonce: int,
    d: Duelist,
    sk: SigningKey,
    comp: Tracked,
    model: ModelClient,
    attestations: dict[str, str | None],
) -> Prepared | None:
    """Prompt the model with the brief and any pending injection and re-encode the enclave signature as the
    `TeeProof`. Returns (intent with this `nonce`, tee, injections used, dataset row), or None when there is no
    decision or no proof (that row is already recorded)."""
    pk = pk_b64(sk)
    inj = [i for i in pending.get(pk, []) if i["duel_id"] == duel_id]
    injection_text = "\n".join(i["payload"] for i in inj) or None
    try:
        decision = d.decide(symbol, brief(symbol, px, open_px), injection_text)
    except DuelistError as e:
        failed = comp.last
        record(
            {
                "duel_id": duel_id,
                "agent_pk": pk,
                "model": model.model_id,
                "hardened": d.hardened,
                "prompt_variant": d.prompt_variant,
                "error": str(e),
                "injection": injection_text,
                "brief": brief(symbol, px, open_px),
                "text": failed.text,
                "chat_id": failed.chat_id,
                "response_body": failed.response_bytes.decode(errors="replace"),
            }
        )
        return None
    except requests.RequestException as e:
        if not _model_transient(e):
            raise
        record(
            {
                "duel_id": duel_id,
                "agent_pk": pk,
                "model": model.model_id,
                "hardened": d.hardened,
                "prompt_variant": d.prompt_variant,
                "error": f"transient: model {str(e)[:200]}",
                "injection": injection_text,
                "brief": brief(symbol, px, open_px),
            }
        )
        print(f"  model call failed ({str(e)[:120]}); skipping this cycle")
        return None
    c = comp.last
    sig_error = None
    try:
        sig_record = model.signature(c.chat_id) if c.chat_id else None
    except requests.RequestException as e:
        if not _model_transient(e):
            raise
        sig_record, sig_error = None, f"transient: signature {str(e)[:200]}"
    tee = None
    if sig_record:
        try:
            tee = tee_proof(sig_record, model.model_id, c.request_hash, c.response_hash)
            if tee is not None and tee.get("kind") != 2:
                print(f"  {pk[:8]}: gateway-signed completion, the contract wants the provider enclave; skipping")
                tee = None
        except TeeProofError as e:
            print(f"  {pk[:8]} enclave record rejected locally: {e}")
    if model.tee and not tee:
        record(
            {
                "duel_id": duel_id,
                "agent_pk": pk,
                "model": model.model_id,
                "error": sig_error or "no tee proof",
                "chat_id": c.chat_id,
                "signature_record": sig_record,
            }
        )
        print(f"  {pk[:8]} no verifiable enclave signature for {c.chat_id}; decision not posted")
        return None
    intent = {
        "agent_pk": pk,
        "duel_id": duel_id,
        "side": "Long" if decision.direction > 0 else "Short",
        "size_bps": 5000,
        "nonce": str(nonce),
        "expires_at": str(close_at_ns + 60_000_000_000),
        "proof_hash": proof_hash(c.request_hash, c.response_hash) if tee else proof_hash(None),
    }
    row = {
        "duel_id": duel_id,
        "agent_pk": pk,
        "model": model.model_id,
        "hardened": d.hardened,
        "prompt_variant": d.prompt_variant,
        "brief": brief(symbol, px, open_px),
        "injection": injection_text,
        "text": c.text,
        "chat_id": c.chat_id,
        "request_body": c.request_bytes.decode(errors="replace"),
        "response_body": c.response_bytes.decode(errors="replace"),
        "request_hash": c.request_hash.hex() if c.request_bytes else None,
        "response_hash": c.response_hash.hex() if c.response_bytes else None,
        "signature_record": sig_record,
        "tee": tee,
        "attestation_file": attestations.get(model.model_id),
        "intent": intent,
    }
    return intent, tee, inj, row


def _late(e: RuntimeError) -> str | None:
    """The contract refused because the chain clock passed close_at or entered the intent lock."""
    return next((w for w in ("duel closed", "intent lock") if w in str(e)), None)


TRANSIENT = ("rate limit", "Internal server error", "timed out", "Timeout", "ECONNRESET", "503", "502")


def _model_transient(e: requests.RequestException) -> bool:
    """The model API dropped the connection, timed out, throttled (429) or failed on its side (5xx): skip this
    cycle like an RPC throttle. A 4xx other than 429 is our bug and still ends the batch."""
    if isinstance(e, (requests.ConnectionError, requests.Timeout)):
        return True
    status = e.response.status_code if e.response is not None else None
    return status is not None and (status == 429 or status >= 500)


def _transient(e: Exception) -> bool:
    """RPC throttling or a dropped connection behind the solver: skip this cycle, the next one retries."""
    return any(w in str(e) for w in TRANSIENT)


def _quotes(posted: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "follower": q["follower"],
            "amount": q["amount"],
            # batched RFQ: each follower's share is `quote_out`; the shared quote's amountOut is the batch total
            "amountOut": q.get("quote_out") or (q.get("quote") or {}).get("quote", {}).get("amountOut"),
        }
        for q in posted.get("quotes", [])
    ]


def post_decision(
    solver: Solver,
    duel_id: str,
    symbol: str,
    px: int,
    open_px: int,
    close_at_ns: int,
    pending: dict[str, list[dict[str, Any]]],
    nonce: int,
    label: str,
    d: Duelist,
    sk: SigningKey,
    comp: Tracked,
    model: ModelClient,
    attestations: dict[str, str | None],
) -> tuple[int, str]:
    """One decision for one agent, posted in the clear: `prepare_decision`, then the signed intent through the
    solver and one dataset row. Returns (nonce, status): "posted", "skipped" (no decision or no proof) or "closed"
    (chain clock passed close_at or entered the intent lock)."""
    prep = prepare_decision(
        duel_id, symbol, px, open_px, close_at_ns, pending, nonce + 1, d, sk, comp, model, attestations
    )
    if prep is None:
        return nonce, "skipped"
    nonce += 1
    intent, tee, inj, row = prep
    pk = intent["agent_pk"]
    try:
        posted = solver.post("/intent", {"signed": sign_intent(sk, intent), "tee": tee})
    except RuntimeError as e:
        late = _late(e)
        if late is None:
            if not _transient(e):
                raise
            # the nonce was not used on chain; keep the paid decision and try again next cycle
            record({**row, "tx": None, "error": f"transient: {str(e)[:120]}"})
            print(f"  {label} intent not posted (transient: {str(e)[:80]}); next cycle retries")
            return nonce, "skipped"
        # chain clock passed close_at or entered the intent lock: keep the paid decision, stop prompting this duel
        record({**row, "tx": None, "error": late})
        print(f"  late intent for {pk[:8]} not posted ({late})")
        return nonce, "closed"
    if inj:
        solver.post("/consume", {"target": pk, "duel_id": duel_id, "blocks": [i["block"] for i in inj]})
    record({**row, "tx": posted["tx"], "quotes": _quotes(posted)})
    print(
        f"  {label} {intent['side']} nonce {nonce} tee={'kind ' + str(tee['kind']) if tee else 'none'} "
        f"tx {posted['tx']} quotes {len(posted.get('quotes', []))}"
    )
    return nonce, "posted"


@dataclass
class Commitment:
    """A committed call waiting for its reveal: what `POST /reveal` sends and the dataset row it completes."""

    label: str
    signed: dict[str, Any]
    salt: bytes
    tee: dict[str, Any] | None
    row: dict[str, Any]


def _refused(e: RuntimeError) -> bool:
    """The solver or the contract verifiably refused the call (nothing stored on chain), as opposed to a transport
    error or an RPC wait that dropped after the tx may have landed."""
    return _late(e) is not None or any(w in str(e) for w in ("panicked", "commit_intent failed", "bad commit"))


def commit_decision(
    solver: Solver,
    held: dict[str, Commitment],
    duel_id: str,
    symbol: str,
    px: int,
    open_px: int,
    close_at_ns: int,
    pending: dict[str, list[dict[str, Any]]],
    nonce: int,
    label: str,
    d: Duelist,
    sk: SigningKey,
    comp: Tracked,
    model: ModelClient,
    attestations: dict[str, str | None],
) -> tuple[int, str]:
    """Commit-reveal, step 1: decide as `post_decision` does, then post only sha256(intent bytes || salt), signed by
    the agent over `commit_message`. The call stays hidden (no quotes, nothing to copy) until `reveal`. The
    commitment goes into `held[label]` before the POST: a commit that lands behind a timeout or a dropped RPC wait
    must still be revealed, or the bond is slashed. Only a verifiable refusal takes it out again. Returns
    (nonce, status): "committed", "skipped" or "closed" (inside the intent lock)."""
    prep = prepare_decision(
        duel_id, symbol, px, open_px, close_at_ns, pending, nonce + 1, d, sk, comp, model, attestations
    )
    if prep is None:
        return nonce, "skipped"
    nonce += 1
    intent, tee, inj, row = prep
    pk = intent["agent_pk"]
    salt = secrets.token_bytes(32)
    c = commitment(intent, salt)
    p = Commitment(label, sign_intent(sk, intent), salt, tee, {**row, "commitment": base64.b64encode(c).decode()})
    p.row["committed_tx"] = None  # unknown until the solver answers
    held[label] = p
    try:
        committed = solver.post(
            "/commit",
            {
                "duel_id": duel_id,
                "agent_pk": pk,
                "commitment": p.row["commitment"],
                "sig": sign_b64(sk, commit_message(ARENA, duel_id, c)),
            },
        )
    except RuntimeError as e:
        if not _refused(e):
            raise  # may have landed: stays held, the final reveal settles it
        del held[label]
        late = _late(e)
        if late is None:
            raise
        record({**p.row, "revealed_tx": None, "tx": None, "error": late})
        print(f"  late commitment for {pk[:8]} not posted ({late})")
        return nonce, "closed"
    p.row["committed_tx"] = committed["tx"]
    if inj:  # the model has seen the injection; it is consumed at commit, like a posted intent
        solver.post("/consume", {"target": pk, "duel_id": duel_id, "blocks": [i["block"] for i in inj]})
    print(f"  {label} committed nonce {nonce} tx {committed['tx']}")
    return nonce, "committed"


def reveal(solver: Solver, p: Commitment) -> str:
    """Commit-reveal, step 2: open the commitment (intent, salt, tee). The solver quotes followers here. Records the
    decision's dataset row. Returns "revealed", or "closed" when the chain refused it as late."""
    try:
        posted = solver.post("/reveal", {"signed": p.signed, "salt": base64.b64encode(p.salt).decode(), "tee": p.tee})
    except RuntimeError as e:
        late = _late(e)
        if late is None:
            raise
        record({**p.row, "revealed_tx": None, "tx": None, "error": late})
        print(f"  late reveal for {p.label} ({late}): the commitment stays unrevealed")
        return "closed"
    record({**p.row, "revealed_tx": posted["tx"], "tx": posted["tx"], "quotes": _quotes(posted)})
    i = p.signed["intent"]
    n_quotes = len(posted.get("quotes", []))
    print(f"  {p.label} revealed {i['side']} nonce {i['nonce']} tx {posted['tx']} quotes {n_quotes}")
    return "revealed"


def reveal_all(solver: Solver, held: dict[str, Commitment]) -> None:
    """Reveal every held commitment (an unrevealed one is slashed). One failure, transport errors included, must
    not strand the others."""
    for label in list(held):
        p = held.pop(label)
        try:
            reveal(solver, p)
        except Exception as e:  # requests' ConnectionError/Timeout are not RuntimeError
            record({**p.row, "revealed_tx": None, "tx": None, "error": f"reveal failed: {str(e)[:200]}"})
            print(f"  reveal for {label} failed: {type(e).__name__}: {str(e)[:120]}")


Player = tuple[str, Duelist, SigningKey, Tracked, ModelClient]


def play_duel(
    solver: Solver,
    duel_id: str,
    symbol: str,
    open_px: int,
    close_at_ns: int,
    stop_ns: int,
    players: list[Player],
    nonce: int,
    cycle_seconds: int,
    attestations: dict[str, str | None],
    commit_reveal: bool = False,
) -> int:
    """Every `cycle_seconds` until `stop_ns` (the intent lock plus a margin) each player decides once. Plain mode
    posts the intent. Commit-reveal mode first reveals the player's previous commitment, then commits the new call;
    the last commitments are revealed after `stop_ns` (reveals are allowed up to close_at) and also on any exit,
    Ctrl-C included, so no commitment is left to be slashed. Returns the last nonce used."""
    held: dict[str, Commitment] = {}
    closed = False
    try:
        while not closed and time.time_ns() < stop_ns:
            px = price(symbol, ENV.get("PYTH_API_KEY"))
            pending = solver.get("/arena")["pending"]
            for label, d, sk, comp, model in players:
                args = (duel_id, symbol, px, open_px, close_at_ns, pending, nonce, label, d, sk, comp, model)
                if not commit_reveal:
                    nonce, status = post_decision(solver, *args, attestations)
                else:
                    status = "committed"
                    if label in held:
                        status = reveal(solver, held[label])
                        del held[label]  # only once the reveal returned: a raise leaves it for the final reveal
                    if status != "closed":
                        nonce, status = commit_decision(solver, held, *args, attestations)
                if status == "closed":
                    closed = True
                    break
            if not closed:
                time.sleep(cycle_seconds)
    finally:
        reveal_all(solver, held)
    return nonce


def exit_on_sigterm() -> None:
    """SIGTERM (night-loop.sh, systemd, docker stop) kills Python without running `finally`; turn it into SystemExit
    so play_duel still reveals its held commitments (an unrevealed one is slashed)."""
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))


def duel_request(ska: SigningKey, skb: SigningKey, symbol: str, close_at_ns: int, consent: bool) -> dict[str, Any]:
    """`POST /duel` body; with `consent` both agents sign `consent_message` and the solver calls open_duel_consented."""
    body: dict[str, Any] = {"a": pk_b64(ska), "b": pk_b64(skb), "symbol": symbol, "close_at": str(close_at_ns)}
    if consent:
        msg = consent_message(ARENA, body["a"], body["b"], symbol, close_at_ns)
        body |= {"sig_a": sign_b64(ska, msg), "sig_b": sign_b64(skb, msg)}
    return body


def wait_for_duel(solver: Solver, pk: str, poll_s: int, skip: str | None = None) -> str:
    """Poll `GET /agent_duel?pk=` until the solver's pairing loop has put `pk` in a duel other than `skip` (the
    duel just played stays in `in_duel` until the oracle callback lands)."""
    while True:
        duel_id = solver.get(f"/agent_duel?pk={quote(pk, safe='')}").get("duel_id")
        if duel_id is not None and str(duel_id) != skip:
            return str(duel_id)
        time.sleep(poll_s)


def run_single(
    name: str,
    hardened: bool,
    cycle_seconds: int,
    poll_seconds: int,
    symbol: str,
    solver_url: str,
    bond: str,
    commit_reveal: bool = False,
) -> None:
    """Self-hosted mode: drive one agent (`AGENT_KEY_<name>` or the derived key) from this machine. The solver
    pairs it (PAIR_EVERY_S) and opens the duel; this process only decides, proves and posts for its own side,
    then asks the oracle to resolve once and waits for the next pairing. Runs until interrupted.
    Commit-reveal applies here (flag or get_config). Consent does not: open_duel_consented needs the opponent's
    signature too, which this process does not hold, so the solver's pairing loop opens the duel unconsented."""
    if not ENV.get("ARENA_SECRET"):
        raise SystemExit("ARENA_SECRET missing: the solver refuses every POST without it")
    solver = Solver(solver_url, ENV["ARENA_SECRET"])
    model = client_from_env(ENV, name)
    d, sk, comp = make_duelist(name, model, hardened=hardened)
    pk = pk_b64(sk)
    if agent_tier_on_chain(pk) is None:
        solver_id = ENV.get("SOLVER_ID", NET["solver"])
        solver.post(
            "/register",
            {
                "agent_pk": pk,
                "model_id": model.model_id,
                "bond": bond,
                "tee": model.tee,
                "register_sig": register_sig(sk, solver_id),
            },
        )
        print(f"registered {pk[:8]} as {model.model_id} tee={model.tee}")
    else:
        print(f"{pk[:8]} already registered (tee={model.tee}); not re-registering")
    attestations = {model.model_id: save_attestation(model)}
    nonce = int(time.time() * 1000)
    last: str | None = None
    while True:
        print(
            f"{name} {pk[:8]} {'hardened' if hardened else 'naive'} waiting for pairing "
            f"(GET /agent_duel every {poll_seconds} s)"
        )
        duel_id = wait_for_duel(solver, pk, poll_seconds, skip=last)
        duel = view("get_duel", {"duel_id": duel_id})
        close_at_ns = int(duel["close_at"])
        sym = next((s for s, a in ASSETS.items() if a == duel["symbol"]), symbol)
        # the oracle's open price once its callback landed, else our spot: the same brief either way
        open_px = int(duel["open_price"]) if duel.get("open_price") else price(sym, ENV.get("PYTH_API_KEY"))
        other = duel["b"] if duel["a"] == pk else duel["a"]
        print(
            f"[duel {duel_id}] {sym} vs {other[:8]} open {open_px / 1e8:,.4f} "
            f"closes in {(close_at_ns - time.time_ns()) // 1_000_000_000} s"
        )
        cfg = view("get_config", {}) or {}
        lock_s = int(cfg.get("intent_lock_s", 0) or 0)
        stop_ns = close_at_ns - (lock_s + 25) * 1_000_000_000  # intent lock + model/signature/chain round trip
        nonce = play_duel(
            solver,
            duel_id,
            sym,
            open_px,
            close_at_ns,
            stop_ns,
            [(name, d, sk, comp, model)],
            nonce,
            cycle_seconds,
            attestations,
            commit_reveal or bool(cfg.get("commit_reveal")),
        )
        while time.time_ns() < close_at_ns + 2_000_000_000:
            time.sleep(1)
        # permissionless on chain; the solver pays the oracle deposit. Once: the other side or the operator may
        # already have asked.
        try:
            res = resolve_duel(solver, duel_id)
            print(f"[duel {duel_id}] resolve tx {res.get('tx')}")
            o = res.get("outcome")
        except RuntimeError as e:
            print(f"[duel {duel_id}] resolve not sent ({str(e)[:100]}); waiting for someone else's")
            o = wait_outcome(duel_id)
        if o:
            print(
                f"[duel {duel_id}] oracle {int(o['open_price']) / 1e8:,.4f} -> {int(o['close_price']) / 1e8:,.4f}  "
                f"A {o['pnl_a']} bps  B {o['pnl_b']} bps  winner {str(o.get('winner'))[:8]}"
            )
        else:
            print(f"[duel {duel_id}] oracle callback not yet landed; the next pairing waits for it")
        last = duel_id


def free_agents(solver: Solver, pks: list[str]) -> None:
    """After a crash an agent can still be `in_duel`; wait for that duel to close and resolve it before opening."""
    for pk in pks:
        a = view("get_agent", {"agent_pk": pk})
        stuck = a and a.get("in_duel") is not None
        if not stuck:
            continue
        duel_id = str(a["in_duel"])
        d = view("get_duel", {"duel_id": duel_id}) or {}
        wait_ns = int(d.get("close_at", "0")) + 2_000_000_000 - time.time_ns()
        print(f"{pk[:8]} still in duel {duel_id}; resolving it first ({max(0, wait_ns) // 1_000_000_000} s to close)")
        if wait_ns > 0:
            time.sleep(wait_ns / 1e9)
        resolve_duel(solver, duel_id)


def arena_pks(pair_tag: str = "") -> list[str]:
    """Every key `run` can register for this pair: A and B, plain or TEE, with or without the `--swap-prompts` tag. A
    name with no AGENT_KEY_*/AGENT_SEED_* gets a random key per run, so there is nothing on chain to free for it."""
    names = [n for n in ("A", "B") if ENV.get(f"AGENT_KEY_{n}") or ENV.get(f"AGENT_SEED_{n}")]
    tags = [key_tag(pair_tag, swap) for swap in (False, True)]
    keys = (pk_b64(agent_key(n, tee, tag)) for n in names for tee in (True, False) for tag in tags)
    return list(dict.fromkeys(keys))  # AGENT_KEY_* ignores tee/tag: one key, not four


def resolve_stuck(solver: Solver, pair_tag: str = "") -> list[str]:
    """Free this runner's agents after a crash (wait for each stuck duel to close, resolve it); returns the keys
    still `in_duel` afterwards, e.g. when the oracle callback has not landed yet."""
    pks = arena_pks(pair_tag)
    free_agents(solver, pks)
    return [pk for pk in pks if (view("get_agent", {"agent_pk": pk}) or {}).get("in_duel") is not None]


def run(
    rounds: int,
    duel_seconds: int,
    cycle_seconds: int,
    symbol: str,
    solver_url: str,
    bond: str,
    swap: bool = False,
    variants: str = "",
    commit_reveal: bool = False,
    consent: bool = False,
    pair_tag: str = "",
) -> list[dict[str, Any]]:
    if not ENV.get("ARENA_SECRET"):
        raise SystemExit("ARENA_SECRET missing in the env file: the solver refuses every POST without it")
    asset = ASSETS.get(symbol)
    if not asset:
        raise SystemExit(f"no oracle asset for {symbol}; known: {sorted(ASSETS)}")
    solver = Solver(solver_url, ENV["ARENA_SECRET"])
    cfg = view("get_config", {}) or {}
    lock_s = int(cfg.get("intent_lock_s", 0) or 0)
    # the contract can require either; the flags turn them on against a contract that only allows them
    commit_reveal = commit_reveal or bool(cfg.get("commit_reveal"))
    consent = consent or bool(cfg.get("require_consent"))
    print(f"commit-reveal {'on' if commit_reveal else 'off'}, consent {'on' if consent else 'off'}")
    model_a, model_b = client_from_env(ENV, "A"), client_from_env(ENV, "B")
    if swap:  # control: the hardened prompt goes to model B and the naive prompt to model A, under separate keys
        model_a, model_b = model_b, model_a
    tag = key_tag(pair_tag, swap)
    a, ska, ca = make_duelist("A", model_a, hardened=True, tag=tag)
    b, skb, cb = make_duelist("B", model_b, hardened=False, tag=tag)
    print(f"pair {pair_tag or 'main'}: A {pk_b64(ska)[:8]} {model_a.model_id}, B {pk_b64(skb)[:8]} {model_b.model_id}")
    solver_id = ENV.get("SOLVER_ID", NET["solver"])  # the account that signs register_agent = on-chain owner
    for sk, m in ((ska, model_a), (skb, model_b)):
        try:
            solver.post(
                "/register",
                {
                    "agent_pk": pk_b64(sk),
                    "model_id": m.model_id,
                    "bond": bond,
                    "tee": m.tee,
                    "register_sig": register_sig(sk, solver_id),
                },
            )
            print(f"registered {pk_b64(sk)[:8]} as {m.model_id} tee={m.tee}")
        except RuntimeError as e:
            if "agent exists" not in str(e):
                raise
    attestations = {m.model_id: save_attestation(m) for m in (model_a, model_b)}
    results = []
    nonce = int(time.time() * 1000)
    for rnd in range(rounds):
        free_agents(solver, [pk_b64(ska), pk_b64(skb)])
        close_at_ns = (time.time_ns() // 1_000_000_000 + duel_seconds) * 1_000_000_000
        opened = solver.post("/duel", duel_request(ska, skb, asset, close_at_ns, consent))
        duel_id = str(opened["duel_id"])
        if variants:  # treatment slot: agent A's arm is a function of the duel id, agent B stays the naive control
            a.variant = pick_variant(duel_id, variants)
        open_px = price(symbol, ENV.get("PYTH_API_KEY"))
        print(
            f"[round {rnd}] duel {duel_id} {symbol} spot {open_px / 1e8:,.4f} tx {opened['tx']} "
            f"A prompt {a.prompt_variant}"
        )
        # stop before the contract's intent lock (deploy 11: no intents in the last `intent_lock_s`), plus 25 s for
        # model + signature + chain round trip
        stop_ns = close_at_ns - (lock_s + 25) * 1_000_000_000
        players: list[Player] = [("A", a, ska, ca, model_a), ("B", b, skb, cb, model_b)]
        nonce = play_duel(
            solver,
            duel_id,
            symbol,
            open_px,
            close_at_ns,
            stop_ns,
            players,
            nonce,
            cycle_seconds,
            attestations,
            commit_reveal,
        )
        while time.time_ns() < close_at_ns + 2_000_000_000:
            time.sleep(1)
        resolved = resolve_duel(solver, duel_id)
        o = resolved["outcome"]
        if o:
            print(
                f"[round {rnd}] resolve tx {resolved['tx']}  "
                f"oracle {int(o['open_price']) / 1e8:,.4f} -> {int(o['close_price']) / 1e8:,.4f}  "
                f"A {o['pnl_a']} bps  B {o['pnl_b']} bps  winner {str(o.get('winner'))[:8]}"
            )
        else:
            print(
                f"[round {rnd}] resolve tx {resolved['tx']}  oracle callback not yet landed; "
                f"rerun: python runner.py --resolve {duel_id}"
            )
        results.append({"duel_id": duel_id, "open_tx": opened["tx"], "resolve_tx": resolved["tx"], "outcome": o})
    return results


if __name__ == "__main__":
    exit_on_sigterm()
    p = argparse.ArgumentParser()
    p.add_argument("--rounds", type=int, default=1)
    p.add_argument(
        "--duel-seconds", type=int, default=330
    )  # Outlayer caches a price for 300 s; shorter duels close on the open price
    p.add_argument("--cycle-seconds", type=int, default=20)
    p.add_argument("--symbol", default="NEAR/USD")
    p.add_argument("--bond", default="100000000000000000000000")  # 0.1 NEAR
    p.add_argument("--resolve", help="ask the oracle to resolve a closed duel id")
    p.add_argument(
        "--resolve-stuck",
        action="store_true",
        help="resolve any duel this runner's agents are still in (after a crash), then exit; exit 1 if still stuck",
    )
    p.add_argument(
        "--swap-prompts", action="store_true", help="control run: hardened prompt on model B, naive on model A"
    )
    p.add_argument(
        "--variants",
        default="",
        metavar="A,B,C",
        help="prompt-defense arms for agent A, picked per duel by pick_variant(duel_id); agent B stays naive",
    )
    p.add_argument(
        "--only",
        choices=["A", "B"],
        help="self-hosted: drive this one agent and let the solver pair it (needs --wait-pairing)",
    )
    p.add_argument(
        "--wait-pairing",
        action="store_true",
        help="with --only: poll GET /agent_duel until the solver's pairing loop opens a duel",
    )
    p.add_argument("--hardened", action="store_true", help="with --only: use the hardened prompt (default naive)")
    p.add_argument("--poll-seconds", type=int, default=10)
    p.add_argument(
        "--pair-tag",
        default="",
        metavar="TAG",
        help="drive a second pair: keys derived from the same seeds under TAG, every row carries pair_tag",
    )
    p.add_argument(
        "--check-agents",
        action="store_true",
        help="print this pair's agent keys comma-separated and exit; exit 1 if any is still in a duel",
    )
    p.add_argument(
        "--commit-reveal",
        action="store_true",
        help="commit each call as sha256(intent || salt), reveal it next cycle (on anyway when get_config says so)",
    )
    p.add_argument(
        "--consent",
        action="store_true",
        help="both agents sign the duel terms; the solver opens it with open_duel_consented (not with --only)",
    )
    args = p.parse_args()
    arms = "".join(args.variants.upper().split(","))
    if arms and (len(set(arms)) != len(arms) or not set(arms) <= set(VARIANTS)):
        p.error(f"--variants takes distinct arms from {','.join(VARIANTS)}; got {args.variants!r}")
    if args.pair_tag and not re.fullmatch(r"[a-z0-9]{1,16}", args.pair_tag):
        p.error(f"--pair-tag takes 1-16 lowercase letters or digits; got {args.pair_tag!r}")
    if args.pair_tag and (args.only or any(ENV.get(f"AGENT_KEY_{n}") for n in "AB")):
        p.error("--pair-tag derives keys from AGENT_SEED_A/B; an AGENT_KEY_* or --only agent is one fixed key")
    PAIR_TAG = args.pair_tag
    if args.check_agents:
        pks = arena_pks(PAIR_TAG)
        busy = {pk: a["in_duel"] for pk in pks if (a := view("get_agent", {"agent_pk": pk})) and a.get("in_duel")}
        for pk, duel in busy.items():
            print(f"{pk} in duel {duel}", file=sys.stderr)
        print(",".join(pks))
        raise SystemExit(1 if busy else 0)
    if args.resolve:
        print(
            json.dumps(
                resolve_duel(
                    Solver(ENV.get("SOLVER_URL", "http://127.0.0.1:4020"), ENV.get("ARENA_SECRET", "")), args.resolve
                )
            )
        )
        raise SystemExit(0)
    if args.resolve_stuck:
        stuck = resolve_stuck(
            Solver(ENV.get("SOLVER_URL", "http://127.0.0.1:4020"), ENV.get("ARENA_SECRET", "")), PAIR_TAG
        )
        print(json.dumps({"still_in_duel": stuck}))
        raise SystemExit(1 if stuck else 0)
    if args.only:
        if not args.wait_pairing:
            p.error("--only needs --wait-pairing: the solver opens the duel, this process only plays one side")
        if args.consent:
            p.error("--consent needs both agents' signatures; with --only this process holds one key")
        run_single(
            args.only,
            args.hardened,
            args.cycle_seconds,
            args.poll_seconds,
            args.symbol,
            ENV.get("SOLVER_URL", "http://127.0.0.1:4020"),
            args.bond,
            args.commit_reveal,
        )
        raise SystemExit(0)
    out = run(
        args.rounds,
        args.duel_seconds,
        args.cycle_seconds,
        args.symbol,
        ENV.get("SOLVER_URL", "http://127.0.0.1:4020"),
        args.bond,
        args.swap_prompts,
        arms,
        args.commit_reveal,
        args.consent,
        PAIR_TAG,
    )
    print(json.dumps(out, indent=2))
