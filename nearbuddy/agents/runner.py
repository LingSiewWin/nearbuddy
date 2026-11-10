"""Arena runner: pairs two model-backed duelists, drives one duel per round through the solver, hands
each decision's enclave signature to the contract as a `TeeProof`, asks the Outlayer oracle to resolve,
and appends one dataset row per decision (with the exact request and response bytes) to
agents/data/decisions.jsonl.

    .venv/bin/python -m runner --rounds 2 --duel-seconds 330 --cycle-seconds 30

Prompt-defense experiment (docs/research/prompt-defense.md, section 4): `--variants A,B,C` puts agent A on
`pick_variant(duel_id)` (sha256 of the id) among the listed arms each duel while agent B stays naive as the
within-duel control; every row carries `prompt_variant`. A variant-C decision whose `evidence_used` lacks
"oracle" is recorded as `error: "evidence not oracle"` and not posted. Arm D makes two enclave calls: the side
call never sees the telemetry, and when there is telemetry a sizer call may only lower `size_bps`. The intent
carries the proof of the last call (the sizer when it ran; its signed request quotes the side and sha256 of the
side call's output); both calls are kept in the row's `arm_d`, and an unproven side call means no post.

Profiles (`--profile naive|hardened|hardened-v2|hardened-v3`, agent A's or the `--only` agent's; rows carry `profile`):
hardened-v2 runs the injection through cue_guard, puts it in a block labelled "paid third-party injection, unverified"
next to the trusted price-feed and mandate blocks, and caps the size in code while that block is present. Rows gain
`guard` (cue_guard version, cues removed, stated size, cap, votes). `--judgments K` asks K times and takes the
majority side.
hardened-v3 is hardened-v2 plus a fact-check: before the duelist's call, prompts.JUDGE_MODEL (on the same NEAR AI key,
so its call is enclave-signed too) reads the cleaned headline alone, and its verdict joins the duelist's request and
sets the cap. `guard.judge` keeps that call's bytes, enclave record and parsed verdict; an unproven judge call means
no post, like arm D's side call.

Self-hosted (one side only; the solver's PAIR_EVERY_S loop opens the duel, this process finds it via GET /agent_duel):

    AGENT_KEY_B=<seed> NEAR_AI_MODEL_B=<model> SOLVER_URL=https://... ARENA_SECRET=<shared> \\
        .venv/bin/python runner.py --only B --wait-pairing [--hardened]

Commit-reveal (`--commit-reveal`, or on by itself when get_config says `commit_reveal: true`): each cycle an agent
commits its call (POST /commit: sha256(intent bytes || salt) signed over commit_message) when the side or size
changed; the contract keeps one commitment per agent per duel, so a new commit replaces the held one. The one
commitment left is revealed (POST /reveal: intent, salt, tee; followers are quoted then) once the chain clock is
inside the intent lock, where nobody can commit a counter-call, and before close_at. Ctrl-C and SIGTERM reveal at
once, since an unrevealed commitment is slashed. Rows gain `commitment`, `committed_tx`, `revealed_tx`. `--consent`
(two-sided runs only) has both agents sign the duel terms so the solver opens it with open_duel_consented; a
self-hosted `--only` runner holds one key, so it gets commit-reveal but never consent.

Injections come from GET /arena `pending`. Deploy 16.1: the text the solver holds for each on-chain hash, delivered
once as written and then consumed (POST /consume). Deploy 17 (chaos v2; the solver switches on get_config.chaos and
each entry then carries the contract's `arm`): the headlines still `Pending` on chain (get_chaos); every decision of
their target delivers each by its arm (`prompts.deliver`: `Cue` as written, `Clean` after cue_guard), until a revealed
TEE decision committed after the headline decides it. Rows carry `chaos` (index, arm, kind, headline of every headline
delivered). A headline planted after the held commitment is that call's "before": the contract accepts a commit that
replaces it unrevealed but charges the hidden call against the target (the headline is then Flipped on the lie's side,
NoTrial off it, never Held), so the held commitment is revealed first, then the agent decides with the headline and
always commits, so the call that saw it is the one revealed next; if that reveal fails, nothing replaces the held
call this cycle. Right before every commit the pending headlines are read again from chain (get_chaos); a call that
missed one decides again if the time left allows, and a held call is never replaced on a failed read
(`commit_decision`).

Second pair (`--pair-tag p2`, scripts/second-loop.sh): the same seeds derive a distinct key set per tag
(keys.key_tag), so two loops with other NEAR_AI_MODEL_A/B never share an agent; every row carries `pair_tag`
(null for the main pair) and `--resolve-stuck` / `--check-agents` act on that pair only.

Health (`--health`, scripts/night-loop.sh runs it before each batch): GET /v1/models must answer 200 and list every
model this run calls (free); `--chat` adds a 1-output-token chat call per model. Exit 0, or 1 with one line on stderr.

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
import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from any cwd: `python agents/runner.py`
from typing import Any

import requests
from nacl.signing import SigningKey

from chain import (
    ARENA,
    ASSETS,
    _view,
    agent_tier_on_chain,
    chain_now_ns,
    view,
    wait_outcome,
    warn_if_arena_missing,
)
from config import ATTEST_DIR, DATA, ENV, NET
from cue_guard import CUE_GUARD_VERSION
from duelist import GUARDED, Duelist, DuelistError
from export_dataset import _check_attested
from intent_client import (
    DeadlineError,
    Solver,
    TeeProofError,
    commit_message,
    commit_message_v2,
    commitment,
    consent_message,
    proof_hash,
    sign_b64,
    sign_intent,
    tee_proof,
)
from keys import agent_key, key_tag, pk_b64, register_sig
from nearai import NEAR_AI_BASE, Completion, ModelClient, client_from_env, request_body
from prices import brief, price
from prompts import HARDENED_V3, JUDGE_MODEL, JUDGE_PROMPT_VERSION, PROFILES, VARIANTS, deliver, pick_variant


class Tracked:
    """`complete_fn` for a Duelist that keeps the last Completion (exact bytes, chat id) for the TEE proof, and every
    completion since `calls` was last cleared (variant D makes two per decision)."""

    def __init__(self, client: ModelClient) -> None:
        self.client = client
        self.last = Completion("", None, client.model_id)
        self.calls: list[Completion] = []
        # a decision `_prepare_by` stopped waiting for, maybe still running: it owns `last` and `calls` until it ends
        self.busy: threading.Thread | None = None

    def __call__(self, system: str, user: str) -> str:
        self.last = self.client.complete(system, user)
        self.calls.append(self.last)
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


def attach_judge(d: Duelist, attestations: dict[str, str | None] | None = None) -> None:
    """hardened-v3: give the duelist its fact-check model, JUDGE_MODEL on the same NEAR AI key (a stub without one,
    whose replies are unverifiable), and keep that enclave's attestation next to the duelists'."""
    if d.variant != HARDENED_V3:
        return
    judge = Tracked(client_from_env({**ENV, "NEAR_AI_MODEL_J": JUDGE_MODEL}, "J"))
    d.judge = judge
    if attestations is not None:
        attestations[judge.client.model_id] = save_attestation(judge.client)


PAIR_TAG = ""  # `--pair-tag`: which agent pair this process drives; "" = the main pair


_record_lock = threading.Lock()  # reveal_held records from several threads; a row must never interleave


# The open each duel's brief measures its move from, as (price with 8 decimals, "oracle" | "spot"), set once per duel
# by run() / run_single() from oracle_open_px(). record() copies it onto every row of that duel, so analysis can tell a
# brief built on the oracle open (the one the spectator reads) from one built on the runner's own spot.
OPENS: dict[str, tuple[int, str]] = {}


def record(row: dict[str, Any]) -> None:
    """Append one dataset row, tagged with the pair (`pair_tag` null = the main pair) so two loops sharing the file
    can be split, and with the duel's `open_px` / `open_source` when this process set them."""
    opened = OPENS.get(str(row.get("duel_id")))
    open_fields = {"open_px": opened[0], "open_source": opened[1]} if opened else {}
    line = json.dumps({**row, **open_fields, "pair_tag": PAIR_TAG or None}) + "\n"
    with _record_lock:
        DATA.parent.mkdir(parents=True, exist_ok=True)
        with DATA.open("a") as f:
            f.write(line)


def save_attestation(
    model_client: ModelClient, attempts: int = 4, timeout: float | tuple[float, float] = 90
) -> str | None:
    """Fetch and keep the enclave attestation (at the start of a run, and again by `attestation_file`); the file is
    the raw material a third party feeds to NVIDIA NRAS and dcap-qvl to check the signer we trust on chain. Only a
    report (status 200) is written: every row cites the file and check_row needs the row's signer listed in it. No
    answer, a 429 or a 5xx is retried after 2, 4, 8 s, up to `attempts` fetches; another status is not. `timeout` is
    each fetch's (see NearAiClient.attestation). Returns the file name, or None when no report came."""
    att: dict[str, Any] | None = None
    for i in range(attempts):
        att = model_client.attestation(timeout=timeout)
        if not att:
            return None  # no enclave behind this client (stub)
        if att.get("report"):
            break
        status = att.get("status")
        retry = i + 1 < attempts and (status is None or status == 429 or status >= 500)
        print(
            f"attestation {model_client.model_id}: status {status} ({str(att.get('error'))[:80]}); "
            + ("retrying" if retry else "not saved")
        )
        if not retry:
            return None
        time.sleep(2 ** (i + 1))
    if not att:
        return None
    ATTEST_DIR.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._-]", "_", model_client.model_id) + f"-{int(time.time())}"
    name, n = f"{stem}.json", 1
    while (ATTEST_DIR / name).exists():  # a second fetch in the same second must not overwrite a report rows cite
        name, n = f"{stem}-{n}.json", n + 1
    (ATTEST_DIR / name).write_text(json.dumps(att))
    signers = [m.get("signing_address") for m in att["report"].get("model_attestations", [])]
    print(f"attestation {model_client.model_id}: status {att.get('status')} signers {signers} -> {name}")
    return name


ATTEST_RETRY_S = 60  # `attestation_file` fetches a model's report again at most this often
# that fetch runs inside a decision, before its commit: (connect, read) of 5 s each bounds it to about 10 s, where the
# start-of-run fetch may take 90 s per phase
ATTEST_REFETCH_TIMEOUT = (5.0, 5.0)
_attest_refetched: dict[str, float] = {}  # model id -> time.monotonic() of its last fetch by attestation_file


def attestation_file(
    model: ModelClient, sig_record: dict[str, Any] | None, attestations: dict[str, str | None]
) -> str | None:
    """The saved report a row cites for a call `sig_record` signed. When it does not list the signer for this model
    (the fetch at start failed, or the model gained an enclave node since), the report is fetched again, one attempt,
    at most every ATTEST_RETRY_S per model with ATTEST_REFETCH_TIMEOUT, and kept in `attestations` for the rows
    after."""
    name = attestations.get(model.model_id)
    if not sig_record or _check_attested(sig_record, model.model_id, name, ATTEST_DIR) == "ok":
        return name
    last = _attest_refetched.get(model.model_id)
    if last is not None and time.monotonic() - last < ATTEST_RETRY_S:
        return name
    _attest_refetched[model.model_id] = time.monotonic()
    print(f"attestation {model.model_id}: signer {str(sig_record.get('signing_address'))[:12]} not listed; fetching")
    fresh = save_attestation(model, attempts=1, timeout=ATTEST_REFETCH_TIMEOUT)
    if fresh:
        attestations[model.model_id] = fresh
    return attestations.get(model.model_id)


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
    """Prompt the model with the brief and every headline still pending at this agent, each delivered by its arm, and
    re-encode the enclave signature as the `TeeProof`. Returns (intent with this `nonce`, tee, headlines delivered,
    dataset row), or None when there is no decision or no proof (that row is already recorded)."""
    pk = pk_b64(sk)
    inj = [i for i in pending.get(pk, []) if i["duel_id"] == duel_id]
    # deploy 17 entries carry the arm the contract drew; a 16.1 payload goes out as the solver stored it
    injection_text = "\n".join(deliver(i["payload"], i["arm"]) if "arm" in i else i["payload"] for i in inj) or None
    # what a verifier needs to recompute the delivered text from chain: get_chaos(duel)[index] has the same headline
    chaos = [
        {"index": i["index"], "arm": i["arm"], "kind": i["kind"], "headline": i["payload"]} for i in inj if "arm" in i
    ] or None
    comp.calls.clear()
    judge = d.judge if isinstance(d.judge, Tracked) else None
    if judge:
        judge.calls.clear()
    try:
        # hardened-v3: the judge's signed request names this duel and intent nonce, so it cannot serve another decision
        decision = d.decide(symbol, brief(symbol, px, open_px), injection_text, bind=(duel_id, str(nonce)))
    except DuelistError as e:
        failed = comp.last
        record(
            {
                "duel_id": duel_id,
                "agent_pk": pk,
                "model": model.model_id,
                "hardened": d.hardened,
                "prompt_variant": d.prompt_variant,
                "profile": d.profile,
                "error": str(e),
                "injection": injection_text,
                "chaos": chaos,
                "brief": brief(symbol, px, open_px),
                "text": failed.text,
                "chat_id": failed.chat_id,
                # the exact request too, so the prompt and the max_tokens cap of a failed call are reproducible
                "request_body": failed.request_bytes.decode(errors="replace"),
                "response_body": failed.response_bytes.decode(errors="replace"),
                "request_hash": failed.request_hash.hex() if failed.request_bytes else None,
                "response_hash": failed.response_hash.hex() if failed.response_bytes else None,
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
                "profile": d.profile,
                "error": f"transient: model {str(e)[:200]}",
                "injection": injection_text,
                "chaos": chaos,
                "brief": brief(symbol, px, open_px),
            }
        )
        print(f"  model call failed ({str(e)[:120]}); skipping this cycle")
        return None
    except UnicodeDecodeError as e:  # nearai refuses a body that is not UTF-8: no bytes a verifier could re-hash
        record(
            {
                "duel_id": duel_id,
                "agent_pk": pk,
                "model": model.model_id,
                "hardened": d.hardened,
                "prompt_variant": d.prompt_variant,
                "profile": d.profile,
                "error": f"model body not UTF-8: {str(e)[:200]}",
                "injection": injection_text,
                "chaos": chaos,
                "brief": brief(symbol, px, open_px),
            }
        )
        print("  model body not UTF-8; skipping this cycle")
        return None
    # the call the intent's proof binds: hardened-v2's first judgment on the majority side, variant D's sizer call when
    # it ran, else the only call
    c = comp.calls[decision.proof_index] if decision.proof_index is not None else comp.last
    sig_record, tee, sig_error = _prove(model, c, pk)
    arm_d = None
    if d.variant == "D":
        side_c = comp.calls[0]
        sized = side_c is not c
        side_sig, side_tee, side_error = _prove(model, side_c, pk) if sized else (sig_record, tee, sig_error)
        if model.tee and not side_tee:
            tee = None  # the sizer's signed request quotes the side call; an unproven side call breaks that chain
            sig_error = sig_error or side_error
        arm_d = {
            "side_call": _call_record(side_c, side_sig, side_tee),
            "size_call": _call_record(c, sig_record, tee) if sized else None,
            "proof_call": "size" if sized else "side",
            "size_bps": decision.size_bps,
            "size_asked": decision.size_asked,
            "size_note": decision.size_note,
        }
    guard: dict[str, Any] | None = None
    if d.variant in GUARDED:
        guard = {
            "cue_guard": CUE_GUARD_VERSION,  # the cue_guard that cleaned the injection; a verifier rebuilds with it
            "cues_removed": decision.cues_removed,
            "size_stated": decision.size_asked,
            "size_cap": decision.size_cap,
            # one per judgment, in call order; None for a judgment whose output did not parse
            "votes": ["Long" if v > 0 else "Short" if v < 0 else None for v in decision.votes],
            "proof_judgment": decision.proof_index,
            # k > 1: every judgment's bytes and enclave record, so the majority can be recounted from signed outputs
            "judgments": [
                _call_record(x, sig_record, tee) if x is c else _call_record(x, *_prove(model, x, pk)[:2])
                for x in comp.calls
            ]
            if len(comp.calls) > 1
            else None,
        }
    if d.variant == HARDENED_V3 and guard is not None:
        guard["judge"] = None  # no paid text, no judge call
        guard["judge_prompt_version"] = JUDGE_PROMPT_VERSION  # 2: the judge's request is bound to this duel and nonce
        if judge and judge.calls and decision.verdict is not None:
            jc = judge.calls[-1]
            j_sig, j_tee, j_error = _prove(judge.client, jc, pk)
            if model.tee and not j_tee:
                tee = None  # the duelist's signed request quotes the judge's reply; an unproven judge breaks that link
                sig_error = sig_error or j_error or f"judge: no tee proof for {jc.chat_id}"
            guard["judge"] = {
                **_call_record(jc, j_sig, j_tee),
                "verdict": decision.verdict,
                "attestation_file": attestation_file(judge.client, j_sig, attestations),
            }
    if model.tee and not tee:
        record(
            {
                "duel_id": duel_id,
                "agent_pk": pk,
                "model": model.model_id,
                "profile": d.profile,
                "error": sig_error or "no tee proof",
                "chat_id": c.chat_id,
                "signature_record": sig_record,
                **({"arm_d": arm_d} if arm_d else {}),
                **({"guard": guard} if guard else {}),
            }
        )
        print(f"  {pk[:8]} no verifiable enclave signature for {c.chat_id}; decision not posted")
        return None
    intent = {
        "agent_pk": pk,
        "duel_id": duel_id,
        "side": "Long" if decision.direction > 0 else "Short",
        "size_bps": decision.size_bps,
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
        "profile": d.profile,
        "brief": brief(symbol, px, open_px),
        "injection": injection_text,
        "chaos": chaos,
        **_call_record(c, sig_record, tee),
        "attestation_file": attestation_file(model, sig_record, attestations),
        "intent": intent,
        **({"arm_d": arm_d} if arm_d else {}),
        **({"guard": guard} if guard else {}),
    }
    return intent, tee, inj, row


def _prove(
    model: ModelClient, c: Completion, pk: str
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None]:
    """(signature record, `TeeProof`, transient error) for one completion; the proof is None unless the provider
    enclave (kind 2) signed exactly our request and response bytes, which is the only proof the contract accepts.
    A transient failure fetching the record is returned as the error, not raised."""
    try:
        sig_record = model.signature(c.chat_id) if c.chat_id else None
    except requests.RequestException as e:
        if not _model_transient(e):
            raise
        return None, None, f"transient: signature {str(e)[:200]}"
    tee = None
    if sig_record:
        try:
            tee = tee_proof(sig_record, model.model_id, c.request_hash, c.response_hash)
            if tee is not None and tee.get("kind") != 2:
                print(f"  {pk[:8]}: gateway-signed completion, the contract wants the provider enclave; skipping")
                tee = None
        except TeeProofError as e:
            print(f"  {pk[:8]} enclave record rejected locally: {e}")
    return sig_record, tee, None


def _call_record(c: Completion, sig_record: dict[str, Any] | None, tee: dict[str, Any] | None) -> dict[str, Any]:
    """One completion as dataset fields: output, exact bytes, their sha256, the enclave record and the proof."""
    return {
        "text": c.text,
        "chat_id": c.chat_id,
        # strict: verifiers re-hash these strings; NearAIClient.complete already refused non-UTF-8 bytes
        "request_body": c.request_bytes.decode(),
        "response_body": c.response_bytes.decode(),
        "request_hash": c.request_hash.hex() if c.request_bytes else None,
        "response_hash": c.response_hash.hex() if c.response_bytes else None,
        "signature_record": sig_record,
        "tee": tee,
    }


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


def model_health(
    env: dict[str, str], models: list[str], chat: bool = False, timeout: float = 10.0
) -> tuple[str | None, str]:
    """NEAR AI Cloud health for these models: (None, what was checked) when healthy, else (one-line reason, ""). Free by
    default: GET /v1/models answers 200 and lists every model (the 06:16 +08 outage of 2026-11-10 returned 500 even
    there). A listed model can still fail its chat calls (Qwen3.8-27B answered 502 from 05:09 to 05:22 +08 while the
    list and the other models were fine), so `chat` also sends each model a chat completion capped at 1 output token:
    billed, a few dozen input tokens. No API key means stub models: nothing remote to check. The key never appears in
    the output, not even when the server echoes it back."""
    key = env.get("NEAR_AI_API_KEY", "").strip()
    if not key:
        return None, "no NEAR_AI_API_KEY: stub models, nothing to check"
    base = env.get("NEAR_AI_BASE", NEAR_AI_BASE).rstrip("/")
    headers = {"Authorization": f"Bearer {key}", "accept": "application/json"}

    def brief_text(text: str) -> str:
        return " ".join(text.replace(key, "***").split())[:120]

    try:
        r = requests.get(f"{base}/models", headers=headers, timeout=timeout)
    except requests.RequestException as e:
        return f"GET /v1/models: no answer ({type(e).__name__})", ""
    if r.status_code != 200:
        return f"GET /v1/models: HTTP {r.status_code} {brief_text(r.text)}".rstrip(), ""
    try:
        listed = {m["id"] for m in r.json()["data"]}
    except (ValueError, KeyError, TypeError):
        return f"GET /v1/models: 200 without a data[].id list: {brief_text(r.text)}", ""
    missing = [m for m in models if m not in listed]
    if missing:
        return f"GET /v1/models: not listed: {', '.join(missing)}", ""
    done = f"GET /v1/models 200, lists {', '.join(models)}"
    for m in models if chat else []:
        body = request_body(m, "Health check.", "Reply with OK.", max_tokens=1)
        try:
            r = requests.post(
                f"{base}/chat/completions",
                headers={**headers, "Content-Type": "application/json"},
                data=body,
                timeout=max(timeout, 30.0),  # a model's first token, not a list read
            )
        except requests.RequestException as e:
            return f"POST /v1/chat/completions {m}: no answer ({type(e).__name__})", ""
        if r.status_code != 200:
            return f"POST /v1/chat/completions {m}: HTTP {r.status_code} {brief_text(r.text)}".rstrip(), ""
        try:
            usage = r.json().get("usage") or {}
        except ValueError:
            usage = {}
        done += f"; chat {m} 200 ({usage.get('prompt_tokens', '?')} in / {usage.get('completion_tokens', '?')} out)"
    return None, done


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
    consume(solver, pk, duel_id, inj)
    record({**row, "tx": posted["tx"], "quotes": _quotes(posted)})
    print(
        f"  {label} {intent['side']} nonce {nonce} tee={'kind ' + str(tee['kind']) if tee else 'none'} "
        f"tx {posted['tx']} quotes {len(posted.get('quotes', []))}"
    )
    return nonce, "posted"


def consume(solver: Solver, pk: str, duel_id: str, inj: list[dict[str, Any]]) -> None:
    """Deploy 16.1: the model has seen these payloads, so the solver stops listing them. A deploy-17 headline is never
    consumed: it stays pending on chain until a revealed TEE decision decides it."""
    blocks = [i["block"] for i in inj if "arm" not in i]
    if blocks:
        solver.post("/consume", {"target": pk, "duel_id": duel_id, "blocks": blocks})


@dataclass
class Commitment:
    """A committed call waiting for its reveal: what `POST /reveal` sends and the dataset row it completes."""

    label: str
    signed: dict[str, Any]
    salt: bytes
    tee: dict[str, Any] | None
    row: dict[str, Any]
    deadline_ns: int | None = None  # close_at minus REVEAL_MARGIN_S: no solver wait for this reveal runs past it
    saw: frozenset[int] = frozenset()  # get_chaos indices of the headlines this call was decided with
    at: int | None = None  # chain time of the commit (ns), from the solver; None while unknown


S_NS = 1_000_000_000

# A reveal must land before close_at; every solver wait for it (restart retries, the follower quotes) ends this long
# before, leaving time for the transaction itself.
REVEAL_MARGIN_S = 5
# hold_until_lock reveals by the local clock at the latest this long before close_at, chain read or not
BACKSTOP_BEFORE_CLOSE_NS = (REVEAL_MARGIN_S + 2) * 1_000_000_000
# A /commit round trip (one transaction through the solver, a few seconds on testnet). commit_decision stops waiting
# for a decision this long before its commit cutoff, and keeps this long between the cutoff and the reveal deadline.
COMMIT_S = 10


def _prepare_by(deadline_ns: int, comp: Tracked, *args: Any) -> Prepared | None | str:
    """`prepare_decision(*args)` on its own thread, waited for until `deadline_ns` (wall clock, polled every 50 ms):
    one model, signature or attestation call can block for minutes, and neither the commit nor the held call's reveal
    may wait for it. Returns its result; "late" when the deadline passed before or during the call (the call is
    abandoned and keeps `comp.busy` until it ends); "busy" while an earlier abandoned call still runs, since it would
    write into the same `comp.calls`."""
    if comp.busy is not None and comp.busy.is_alive():
        return "busy"
    if time.time_ns() >= deadline_ns:
        return "late"
    box: list[Any] = []
    done = threading.Event()

    def run() -> None:
        try:
            box.append(prepare_decision(*args))
        except BaseException as e:  # handed to the waiting thread, which raises it
            box.append(e)
        done.set()

    t = threading.Thread(target=run, name="decide", daemon=True)
    t.start()
    while not done.wait(0.05):
        if time.time_ns() >= deadline_ns:
            # ponytail: the abandoned call runs on (a paid model call is not cancellable); comp.busy keeps the agent
            # out of new decisions until it ends, at worst a few minutes
            comp.busy = t
            return "late"
    if isinstance(box[0], BaseException):
        raise box[0]
    out: Prepared | None = box[0]
    return out


def _refused(e: RuntimeError) -> bool:
    """The solver or the contract verifiably refused the call (nothing stored on chain), as opposed to a transport
    error or an RPC wait that dropped after the tx may have landed."""
    return _late(e) is not None or any(w in str(e) for w in ("panicked", "commit_intent failed", "bad commit"))


def commit_decision(
    solver: Solver,
    held: dict[str, list[Commitment]],
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
    chaos_v2: bool = False,
    lock_at_ns: int | None = None,
) -> tuple[int, str]:
    """Commit-reveal, step 1: decide as `post_decision` does, then post only sha256(intent bytes || salt), signed by
    the agent over `commit_message`. The contract stores one commitment per agent per duel and a new commit replaces
    it, so only the last one is opened (`reveal_held`, inside the intent lock), unless a headline planted after it
    makes it the headline's `prev` (below).

    `held[label]` lists the commitments that may be the one on chain, oldest first. A call with the same side and
    size as a confirmed held commitment is not committed again (its row says `kept_commitment`): replacing it would
    only spend bond storage. A new commitment joins the list before the POST; a confirmed commit leaves it alone in
    the list (the older ones are replaced on chain, their rows say `replaced_by`), a verifiable refusal takes it out,
    and a commit that may have landed (timeout, dropped RPC wait) keeps both, so the final reveal can try each.

    Deploy 16.1 payloads are delivered once and consumed with the call, kept or committed. Planted headlines (deploy
    17: `chaos_v2`, or an entry with an `arm`): a pending headline the held call was not decided with is new. When one
    was planted at or after the held commit (or the commit time is unknown), the held call is that headline's `prev`:
    the contract accepts a commit that replaces it unrevealed but charges the hidden call against the target (the
    headline's next decision is Flipped on the lie's side, NoTrial off it, never Held), so the held call is revealed
    first, before the model is asked (`reveal_prev`). If that reveal fails, nothing replaces the held call this cycle
    ("skipped"; it stays for the next cycle or the final reveal). An enclave agent's reveal decides every headline the
    held call saw, so only the new ones are delivered then. With a new headline the call is always committed, never
    kept: the call that saw the headline must be the one revealed next.

    Deploy 17, right before every commit: the pending headlines are read again from chain (`chaos_read`, not the
    solver's GET /arena, memoised for 3 s). When the read fails and a held call would be replaced, nothing is
    committed. A headline that landed while the model decided was never seen by this call, which would decide that
    headline's trial blind once revealed. The call is then recorded as not committed, the held call is revealed if it
    is the headline's `prev` (a failed reveal ends the cycle as above), and the model decides again with every pending
    headline, once: the read before that commit must find nothing new either, or nothing is committed. A headline
    landing between the last read and the commit landing is the race the contract accepts (arena/README.md).

    Time: every wait in here ends by the commit cutoff, `lock_at_ns` (the intent lock's start, close_at when None; the
    contract refuses a commit from there on) or COMMIT_S before the reveal deadline (close_at - REVEAL_MARGIN_S),
    whichever is first, so the held call's reveal never waits on this call. A decision is waited for until COMMIT_S
    before the cutoff (`_prepare_by`), then abandoned: nothing is committed and the status is "closed". The decision
    again runs only if the first one's measured time still fits before that point; if not, the call that missed the
    headline is not committed and the held call stays the scored one. /commit is not sent after the cutoff and not
    waited for past it.
    Returns (nonce, status): "committed", "kept", "skipped" or "closed" (inside the intent lock or past the cutoff)."""
    pk = pk_b64(sk)
    reveal_by = close_at_ns - (REVEAL_MARGIN_S + COMMIT_S) * S_NS
    cutoff = reveal_by if lock_at_ns is None else min(lock_at_ns, reveal_by)
    decide_by = cutoff - COMMIT_S * S_NS
    mine = [i for i in pending.get(pk, []) if i["duel_id"] == duel_id]
    chaos_v2 = chaos_v2 or any("arm" in i for i in mine)
    held_top = held[label][-1] if held.get(label) else None
    new = [i for i in mine if "arm" in i and (held_top is None or i["index"] not in held_top.saw)]
    first = reveal_prev(solver, held, label, mine, model.tee, cutoff)
    if first is None:
        return nonce, "skipped"
    mine, decided = first

    def decide(headlines: list[dict[str, Any]]) -> Prepared | None | str:
        # `nonce` is read at call time: the redo gets the one after the call that missed the headline
        args = (duel_id, symbol, px, open_px, close_at_ns, {pk: headlines}, nonce + 1, d, sk, comp, model, attestations)
        out = _prepare_by(decide_by, comp, *args)
        if out == "late":
            record(
                {"duel_id": duel_id, "agent_pk": pk, "model": model.model_id, "error": "late: no decision by cutoff"}
            )
            print(f"  {label} decision not done {COMMIT_S} s before the commit cutoff; abandoned, nothing committed")
        elif out == "busy":
            print(f"  {label} an abandoned decision is still running; skipping this cycle")
        return out

    started = time.time_ns()
    prep = decide(mine)
    took = time.time_ns() - started
    if prep == "late":  # the abandoned decision signed nonce + 1 into its judge request: never reuse it
        return nonce + 1, "closed"
    if prep is None or isinstance(prep, str):
        return nonce, "skipped"
    nonce += 1
    intent, tee, inj, row = prep
    cands = held.setdefault(label, [])

    top = cands[-1] if cands else None
    if (
        not new
        and top is not None
        and top.row.get("committed_tx")
        and (top.signed["intent"]["side"], top.signed["intent"]["size_bps"]) == (intent["side"], intent["size_bps"])
    ):
        record(
            {
                **row,
                "commitment": None,
                "committed_tx": None,
                "revealed_tx": None,
                "tx": None,
                "kept_commitment": top.row["commitment"],
            }
        )
        consume(solver, pk, duel_id, inj)
        print(f"  {label} keeps its commitment (same {intent['side']} {intent['size_bps']} bps), nonce {nonce} unused")
        return nonce, "kept"
    seen_n: int | None = None  # len(get_chaos(duel)) at the last read: signed as `seen` (commit message v2)
    for again in (True, False) if chaos_v2 else ():
        # a read before every commit and one redo; a headline landing after the last read and before the commit lands
        # is decided blind. Under commit message v2 (deploy 17.1) the commit signs how many records that read saw, so
        # the contract refuses a replacement that would hide such a headline ("unseen headline") instead of charging
        # it as a dodge; the runner then reveals the held call and commits again. Under v1 it is charged.
        uncommitted = {**row, "commitment": None, "committed_tx": None, "revealed_tx": None, "tx": None}
        read = chaos_read(duel_id, pk)
        fresh, seen_n = (None, None) if read is None else read
        if fresh is None and held.get(label):
            record({**uncommitted, "error": "not committed: get_chaos unreadable, the held call stays"})
            print(f"  {label} get_chaos unreadable: not replacing the held call unread, nonce {nonce} unused")
            return nonce, "skipped"
        seen = {i["index"] for i in inj if "arm" in i} | decided
        missed = [i["index"] for i in fresh or [] if i["index"] not in seen]
        if not missed:
            break
        # the redo makes the same calls with one more headline: the first decision's time is its estimate
        redo = again and time.time_ns() + took <= decide_by
        why = "" if redo else "; no time to decide again" if again else "; it already decided again"
        record({**uncommitted, "error": f"not committed: headline {missed} landed while deciding{why}"})
        if not redo:
            print(f"  {label} headline {missed} landed while deciding{why}: nothing committed")
            return nonce, "skipped"
        print(f"  {label} headline {missed} landed while deciding: deciding again with it, nonce {nonce} unused")
        res = reveal_prev(solver, held, label, [i for i in fresh or [] if i["index"] not in decided], model.tee, cutoff)
        if res is None:
            return nonce, "skipped"
        mine, more = res
        decided |= more
        prep = decide(mine)
        if prep == "late":  # as above: the abandoned decision used nonce + 1
            return nonce + 1, "closed"
        if prep is None or isinstance(prep, str):
            return nonce, "skipped"
        nonce += 1
        intent, tee, inj, row = prep
        cands = held.setdefault(label, [])
    salt = secrets.token_bytes(32)
    c = commitment(intent, salt)
    p = Commitment(
        label,
        sign_intent(sk, intent),
        salt,
        tee,
        {**row, "commitment": base64.b64encode(c).decode()},
        close_at_ns - REVEAL_MARGIN_S * 1_000_000_000,
        frozenset(i["index"] for i in inj if "arm" in i),
    )
    p.row["committed_tx"] = None  # unknown until the solver answers
    cands.append(p)
    body: dict[str, Any] = {"duel_id": duel_id, "agent_pk": pk, "commitment": p.row["commitment"]}
    if seen_n is not None and commit_version() >= 2:
        body["sig"] = sign_b64(sk, commit_message_v2(ARENA, duel_id, seen_n, c))
        body["seen"] = seen_n
    else:
        body["sig"] = sign_b64(sk, commit_message(ARENA, duel_id, c))
    try:
        try:
            committed = solver.post("/commit", body, deadline_ns=cutoff)
        except RuntimeError as e:
            if "unseen headline" not in str(e):
                raise
            # a headline landed after the read and the commit would hide it: nothing changed on chain. The held call
            # is that headline's prev, so it is revealed now; with nothing held the same commit cannot be refused so
            cands.remove(p)
            print(f"  {label} commit refused (unseen headline): revealing the held call, then committing again")
            if not reveal_now(solver, held, label, cutoff):
                record({**p.row, "committed_tx": None, "revealed_tx": None, "tx": None, "error": "unseen headline"})
                print(f"  {label} held call not revealed: not replacing it this cycle, nonce {nonce} unused")
                return nonce, "skipped"
            cands = held.setdefault(label, [])
            cands.append(p)
            committed = solver.post("/commit", body, deadline_ns=cutoff)
    except RuntimeError as e:
        unsent = isinstance(e, DeadlineError)  # the cutoff passed before the POST: nothing reached the chain
        if not (unsent or _refused(e)):
            raise  # may have landed: stays a candidate next to the older one, the final reveal settles it
        cands.remove(p)
        late = "commit cutoff" if unsent else _late(e)
        if late is None:
            raise
        record({**p.row, "revealed_tx": None, "tx": None, "error": late})
        print(f"  late commitment for {pk[:8]} not posted ({late}); the held one is revealed inside the lock")
        return nonce, "closed"
    except requests.RequestException as e:  # the answer timed out at the cutoff: the commit may still land
        print(f"  {label} commit unanswered ({type(e).__name__}); kept as a candidate for the final reveal")
        return nonce, "closed"
    p.row["committed_tx"] = committed["tx"]
    p.at = int(committed["at"]) if committed.get("at") else None
    for old in cands[:-1]:  # replaced on chain by this commit: never revealed, recorded as replaced
        record({**old.row, "revealed_tx": None, "tx": None, "replaced_by": committed["tx"]})
    cands[:] = [p]
    consume(solver, pk, duel_id, inj)
    print(f"  {label} committed nonce {nonce} tx {committed['tx']}")
    return nonce, "committed"


def reveal_prev(
    solver: Solver,
    held: dict[str, list[Commitment]],
    label: str,
    mine: list[dict[str, Any]],
    tee: bool,
    by_ns: int | None = None,
) -> tuple[list[dict[str, Any]], set[int]] | None:
    """Reveal `label`'s held call now when a headline in `mine` it did not see was planted at or after its commit (or
    the commit time is unknown): the held call is that headline's `prev`, and a commit replacing it unrevealed is
    charged against the target (Flipped on the lie's side, NoTrial off it, never Held). Returns (the headlines the
    next call gets, the indices the reveal decided): an enclave agent's reveal decides every headline the held call
    saw, so those are left out. None when that reveal failed: the held call is still in `held`, and the caller must
    not replace it."""
    top = held[label][-1] if held.get(label) else None
    new = [i for i in mine if "arm" in i and (top is None or i["index"] not in top.saw)]
    if top is None or not any(top.at is None or int(i["at"]) >= top.at for i in new):
        return mine, set()
    print(f"  {label} reveals its held call first: headline {[i['index'] for i in new]} planted after it")
    if not reveal_now(solver, held, label, by_ns):
        print(f"  {label} held call not revealed: not replacing it this cycle")
        return None
    if not tee:
        return mine, set()
    return new, set(top.saw)


_commit_version: tuple[float, int] | None = None  # (read at, commit_message_version), memoised for a minute


def commit_version() -> int:
    """The newest commit message the deployed arena accepts: `commit_message_version`, 2 from deploy 17.1 (it takes
    `seen`). A contract without the view (deploy 17 and older) or a failed read gives 1: v1 is accepted by every
    deploy, so a code-only upgrade at a batch boundary never breaks a running duel, and a runner started before it
    switches to v2 within a minute."""
    global _commit_version
    now = time.monotonic()
    if _commit_version is not None and now - _commit_version[0] < 60:
        return _commit_version[1]
    try:
        v = int(_view("commit_message_version", {}, retries=1, timeout=(3, 5)))
    except Exception:  # MethodNotFound on deploy 17, or the read failed: v1 is always accepted
        v = 1
    _commit_version = (now, v)
    return v


def chaos_pending(duel_id: str, pk: str) -> list[dict[str, Any]] | None:
    """`chaos_read` without the record count."""
    read = chaos_read(duel_id, pk)
    return None if read is None else read[0]


def chaos_read(duel_id: str, pk: str) -> tuple[list[dict[str, Any]], int] | None:
    """Deploy 17: the headlines get_chaos lists as Pending at `pk`, read from chain rather than through the solver's
    GET /arena (memoised for 3 s), in the shape GET /arena lists them, and how many records get_chaos listed in all
    (the `seen` a v2 commit signs). It runs right before a commit, so it is one attempt of at most (3 s connect, 5 s
    read), no backoff. None when the read fails in any way (transport, RPC error, a malformed answer): a first commit
    then goes out without the re-read, and a commit that would replace a held call is not sent."""
    try:
        chaos = _view("get_chaos", {"duel_id": duel_id}, retries=1, timeout=(3, 5))
        return [
            {
                "duel_id": duel_id,
                "index": n,
                "kind": c["kind"],
                "arm": c["arm"],
                "at": c["at"],
                "payload": c["headline"],
            }
            for n, c in enumerate(chaos)
            if c["outcome"] == "Pending" and c["target"] == pk
        ], len(chaos)
    except Exception as e:  # a KeyError or a TypeError must not end the duel loop with a commitment held
        print(f"  get_chaos {duel_id} unreadable ({type(e).__name__}: {str(e)[:80]}); committing without the re-read")
        return None


def reveal(solver: Solver, p: Commitment, by_ns: int | None = None) -> str:
    """Commit-reveal, step 2: open the commitment (intent, salt, tee). The solver quotes followers here. Records the
    decision's dataset row. Returns "revealed", or "closed" when the chain refused it as late."""
    try:
        posted = solver.post(
            "/reveal",
            {"signed": p.signed, "salt": base64.b64encode(p.salt).decode(), "tee": p.tee},
            deadline_ns=p.deadline_ns if by_ns is None or p.deadline_ns is None else min(p.deadline_ns, by_ns),
        )
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


NOT_ON_CHAIN = ("commitment mismatch", "no commitment")


def reveal_now(solver: Solver, held: dict[str, list[Commitment]], label: str, by_ns: int | None = None) -> bool:
    """Reveal `label`'s held commitment during the duel (a headline was planted after it). True when it was revealed;
    False puts the candidates back in `held`, so the next `reveal_prev` or the final reveal tries again; so does Ctrl-C
    during the reveal, or play_duel's final reveal would skip a commitment that may still be on chain (slashed)."""
    cands = held.pop(label, [])
    revealed = False
    try:
        revealed = not reveal_held(solver, {label: cands}, by_ns)
    finally:
        if not revealed:
            held[label] = cands
    return revealed


def reveal_held(solver: Solver, held: dict[str, list[Commitment]], by_ns: int | None = None) -> list[str]:
    """Reveal the commitment each agent has on chain (an unrevealed one is slashed), all agents at once: each /reveal
    waits for its follower quotes, so in a row the last agent could miss the window while the first one waits out a
    solver restart. Per agent the candidates go newest first; one the contract does not hold ("commitment mismatch",
    "no commitment": a commit that never landed, or one a later commit replaced) is recorded as not on chain and the
    next older one is tried, and so is one whose reveal failed in transport: trying an older candidate is always
    safe (the contract refuses it unless it is the stored one), while stopping could forfeit the duel when the newest
    commit never landed. One failure, transport errors included, must not strand another agent. A reveal whose
    deadline (close_at minus REVEAL_MARGIN_S) passes is reported loudly: that commitment forfeits the duel and pays
    no_reveal_bps. Returns the labels none of whose candidates was revealed (or refused as late)."""
    batch = [(label, held.pop(label)) for label in list(held)]

    def one(label: str, cands: list[Commitment]) -> bool:
        for i, p in enumerate(reversed(cands)):
            try:
                reveal(solver, p, by_ns)
            except Exception as e:  # requests' ConnectionError/Timeout are not RuntimeError
                if isinstance(e, RuntimeError) and any(w in str(e) for w in NOT_ON_CHAIN):
                    record({**p.row, "revealed_tx": None, "tx": None, "error": "commitment not on chain"})
                    continue
                record({**p.row, "revealed_tx": None, "tx": None, "error": f"reveal failed: {str(e)[:200]}"})
                print(f"  reveal for {label} failed: {type(e).__name__}: {str(e)[:120]}")
                # a mid-duel reveal stopped at `by_ns` (the commit cutoff) is retried by the final reveal: no alarm
                past = p.deadline_ns is not None and time.time_ns() >= p.deadline_ns
                if past or (isinstance(e, DeadlineError) and by_ns is None):
                    print(
                        f"!!! REVEAL DEADLINE PASSED for {label} (nonce {p.signed['intent']['nonce']}): the "
                        "commitment may stay unrevealed; the contract then forfeits the duel and slashes "
                        "no_reveal_bps of the bond"
                    )
                continue  # the older candidate may be the one on chain (this commit's answer may have been lost)
            # revealed, or refused as late: an older candidate was replaced by this one if it landed
            for older in list(reversed(cands))[i + 1 :]:
                record({**older.row, "revealed_tx": None, "tx": None, "replaced_by": p.row.get("committed_tx")})
            return True
        return False

    batch = [(label, cands) for label, cands in batch if cands]
    if len(batch) <= 1:
        return [label for label, cands in batch if not one(label, cands)]
    with ThreadPoolExecutor(max_workers=len(batch)) as pool:
        futures = [(label, pool.submit(one, label, cands)) for label, cands in batch]
        return [label for label, f in futures if not f.result()]


Player = tuple[str, Duelist, SigningKey, Tracked, ModelClient]


def require_lock_for_commit_reveal(commit_reveal: bool, lock_s: int) -> None:
    """Commit-reveal only hides the scored call if it can be held until nobody can commit again, which is the
    contract's intent lock. With `intent_lock_s` 0 there is no such moment: refuse rather than reveal into the open."""
    if commit_reveal and lock_s <= 0:
        raise SystemExit(
            "commit-reveal needs the contract's intent lock, but get_config.intent_lock_s is 0: the scored call "
            "would be revealed while the opponent can still commit. Set it with set_oracle first."
        )


def _chain_now_within(wait_s: float) -> int | None:
    """chain_now_ns on a fresh daemon thread, waited for at most `wait_s` seconds of local time. None when the read
    is still running then (DNS, a trickling server): it is abandoned, and since every read gets its own thread a
    stuck one never holds up the next. The read's own errors are raised here."""
    box: list[Any] = []
    done = threading.Event()

    def read() -> None:
        try:
            box.append(chain_now_ns(timeout=max(0.5, wait_s)))
        except BaseException as e:  # handed to the waiting thread, which raises it
            box.append(e)
        done.set()

    threading.Thread(target=read, name="chain-now", daemon=True).start()
    if not done.wait(wait_s):
        return None
    if isinstance(box[0], BaseException):
        raise box[0]
    return box[0]


def hold_until_lock(lock_at_ns: int, close_at_ns: int) -> None:
    """Wait until the chain clock reaches `lock_at_ns` (close_at minus the intent lock). From there no agent can
    commit again, so revealing the scored call cannot be answered by a counter-call; reveals stay open up to
    close_at. Reads the latest final block's time, which trails the head by a block or two, so the reveal always
    lands inside the lock. Hard backstop by the local clock, whatever the chain reads do: reveal once it reaches
    halfway through the lock, and never later than REVEAL_MARGIN_S + 2 s before close_at (the reveal's own deadline
    is close_at - REVEAL_MARGIN_S, so the POST still gets 2 s). Each chain read is waited for only the time left to the
    backstop on the local clock, on its own thread, so a slow, throttled or hung RPC cannot hold the reveal past it:
    an unrevealed commitment is slashed, an early reveal only leaks the call."""
    give_up = max(lock_at_ns, min(lock_at_ns + (close_at_ns - lock_at_ns) // 2, close_at_ns - BACKSTOP_BEFORE_CLOSE_NS))
    while True:
        left = (give_up - time.time_ns()) / S_NS
        if left < 0.05:  # at most 50 ms early, and no read is started only to be abandoned
            print("  chain clock not past the intent lock by the local backstop; revealing now")
            return
        try:
            now = _chain_now_within(min(5.0, left))
            if now is not None and now >= lock_at_ns:
                return
        except RuntimeError as e:
            print(f"  chain clock unreadable ({str(e)[:80]}); retrying")
        time.sleep(max(0.0, min(0.5, (give_up - time.time_ns()) / S_NS)))


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
    lock_s: int = 0,
    chaos_v2: bool = False,
) -> int:
    """Every `cycle_seconds` until `stop_ns` (the intent lock plus a margin for model, signature and chain) each
    player decides once. Plain mode posts the intent. Commit-reveal mode commits the call when it changed
    (`commit_decision`; a new commit replaces the held one on chain) and reveals nothing during the duel except a held
    call a newer planted headline needs as its `prev`: the one
    commitment per player left at the end is the scored call, revealed only once the chain clock is inside the
    contract's intent lock (`close_at - lock_s`, see `hold_until_lock`), where nobody can commit a counter-call, and
    before close_at. A commit refused inside the lock ends the duel for that player with its held commitment still
    hidden. If the loop fails (price feed, GET /arena, a commit error that may have landed) the commitments are still
    held until the lock, then revealed and the error re-raised: a transient glitch must not open a call early. Only
    Ctrl-C and SIGTERM reveal at once, lock or not: a shutdown must not leave a commitment to be slashed. `chaos_v2`
    (get_config has `chaos`, deploy 17) re-reads the pending headlines from chain before each commit. Returns the last
    nonce used."""
    held: dict[str, list[Commitment]] = {}
    closed = False
    try:
        while not closed and time.time_ns() < stop_ns:
            px = price(symbol, ENV.get("PYTH_API_KEY"))
            pending = solver.get("/arena")["pending"]
            for label, d, sk, comp, model in players:
                if time.time_ns() >= stop_ns:  # a slow call before this one ate the margin: no call past stop_ns
                    print(f"  {label} skipped: commits stopped (intent lock + margin) during this cycle")
                    break
                args = (duel_id, symbol, px, open_px, close_at_ns, pending, nonce, label, d, sk, comp, model)
                if not commit_reveal:
                    nonce, status = post_decision(solver, *args, attestations)
                else:
                    # SIGTERM waits until `held` matches the chain: a kill between a landed commit and the update
                    # of `held` would leave the final reveal opening a replaced commitment first
                    with sigterm_deferred():
                        nonce, status = commit_decision(
                            solver, held, *args, attestations, chaos_v2, close_at_ns - lock_s * S_NS
                        )
                if status == "closed":
                    closed = True
                    break
            if not closed:
                # never sleep past stop_ns: a cycle that started just before it would otherwise sleep into the
                # lock and past the reveal deadline (duel 464: both agents forfeited)
                time.sleep(max(0.0, min(cycle_seconds, (stop_ns - time.time_ns()) / S_NS)))
        if held and lock_s > 0:
            hold_until_lock(close_at_ns - lock_s * 1_000_000_000, close_at_ns)
    except Exception as e:  # not KeyboardInterrupt / SystemExit (SIGTERM): those reveal at once, below
        if held and lock_s > 0:
            print(f"  duel loop failed ({type(e).__name__}: {str(e)[:100]}); holding commitments until the lock")
            hold_until_lock(close_at_ns - lock_s * 1_000_000_000, close_at_ns)
        raise
    finally:
        reveal_held(solver, held)
    return nonce


_sigterm = {"defer": 0, "pending": False}


def _on_sigterm(*_: object) -> None:
    if _sigterm["defer"]:
        _sigterm["pending"] = True  # raised when the deferred block ends
        return
    sys.exit(143)


@contextmanager
def sigterm_deferred() -> Iterator[None]:
    """A SIGTERM that arrives inside the block raises SystemExit (exit 143) only when the block ends, so the block
    runs to completion. A flag, not a signal mask: Python runs handlers on the main thread whichever thread the
    kernel picked, so masking the main thread alone does not defer anything."""
    _sigterm["defer"] += 1
    try:
        yield
    finally:
        _sigterm["defer"] -= 1
        if not _sigterm["defer"] and _sigterm["pending"]:
            _sigterm["pending"] = False
            sys.exit(143)


def exit_on_sigterm() -> None:
    """SIGTERM (night-loop.sh, systemd, docker stop) kills Python without running `finally`; turn it into SystemExit
    so play_duel still reveals its held commitments (an unrevealed one is slashed). Inside `sigterm_deferred` the
    exit waits for the block to finish."""
    signal.signal(signal.SIGTERM, _on_sigterm)


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


def oracle_open_px(duel_id: str, symbol: str, wait_s: float) -> tuple[int, str]:
    """The duel's on-chain open price, the one it is scored against, polled up to `wait_s` for the oracle callback;
    spot when it has not landed by then. Returns (price with 8 decimals, "oracle" | "spot")."""
    deadline = time.time() + wait_s
    while True:
        try:
            d = view("get_duel", {"duel_id": duel_id})
        except RuntimeError as e:
            print(f"  get_duel {duel_id}: {str(e)[:80]}")
            d = None
        open_px = d.get("open_price") if d else None
        if open_px:
            return int(open_px), "oracle"
        if time.time() >= deadline:
            return price(symbol, ENV.get("PYTH_API_KEY")), "spot"
        time.sleep(2)


def run_single(
    name: str,
    hardened: bool,
    cycle_seconds: int,
    poll_seconds: int,
    symbol: str,
    solver_url: str,
    bond: str,
    commit_reveal: bool = False,
    profile: str | None = None,
    judgments: int = 1,
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
    if profile:
        d.profile = profile
    d.judgments = judgments
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
    attach_judge(d, attestations)
    nonce = int(time.time() * 1000)
    last: str | None = None
    while True:
        print(
            f"{name} {pk[:8]} {profile or ('hardened' if hardened else 'naive')} waiting for pairing "
            f"(GET /agent_duel every {poll_seconds} s)"
        )
        duel_id = wait_for_duel(solver, pk, poll_seconds, skip=last)
        duel = view("get_duel", {"duel_id": duel_id})
        if duel is None:  # the solver read `in_duel` from chain, so the duel exists unless an RPC lags behind
            raise RuntimeError(f"duel {duel_id} from the solver is not on chain")
        close_at_ns = int(duel["close_at"])
        sym = next((s for s, a in ASSETS.items() if a == duel["symbol"]), symbol)
        # the oracle's open price, waiting briefly for its callback; our own spot only when it never lands
        open_px, source = oracle_open_px(duel_id, sym, wait_s=20)
        OPENS[duel_id] = (open_px, source)
        other = duel["b"] if duel["a"] == pk else duel["a"]
        print(
            f"[duel {duel_id}] {sym} vs {other[:8]} {source} open {open_px / 1e8:,.4f} "
            f"closes in {(close_at_ns - time.time_ns()) // 1_000_000_000} s"
        )
        cfg = view("get_config", {}) or {}
        lock_s = int(cfg.get("intent_lock_s", 0) or 0)
        duel_cr = commit_reveal or bool(cfg.get("commit_reveal"))
        require_lock_for_commit_reveal(duel_cr, lock_s)
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
            duel_cr,
            lock_s,
            cfg.get("chaos") is not None,
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
        if a is None or a["in_duel"] is None:
            continue
        duel_id = a["in_duel"]
        d = view("get_duel", {"duel_id": duel_id})
        wait_ns = (int(d["close_at"]) if d else 0) + 2_000_000_000 - time.time_ns()
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
    return [pk for pk in pks if (a := view("get_agent", {"agent_pk": pk})) and a["in_duel"] is not None]


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
    profile: str = "hardened",
    judgments: int = 1,
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
    require_lock_for_commit_reveal(commit_reveal, lock_s)
    consent = consent or bool(cfg.get("require_consent"))
    print(f"commit-reveal {'on' if commit_reveal else 'off'}, consent {'on' if consent else 'off'}")
    model_a, model_b = client_from_env(ENV, "A"), client_from_env(ENV, "B")
    if swap:  # control: the hardened prompt goes to model B and the naive prompt to model A, under separate keys
        model_a, model_b = model_b, model_a
    tag = key_tag(pair_tag, swap)
    a, ska, ca = make_duelist("A", model_a, hardened=True, tag=tag)
    a.profile, a.judgments = profile, judgments  # the treatment slot; B stays the naive control
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
    attach_judge(a, attestations)
    results = []
    nonce = int(time.time() * 1000)
    for rnd in range(rounds):
        free_agents(solver, [pk_b64(ska), pk_b64(skb)])
        close_at_ns = (time.time_ns() // 1_000_000_000 + duel_seconds) * 1_000_000_000
        opened = solver.post("/duel", duel_request(ska, skb, asset, close_at_ns, consent))
        duel_id = str(opened["duel_id"])
        if variants:  # treatment slot: agent A's arm is a function of the duel id, agent B stays the naive control
            a.variant = pick_variant(duel_id, variants)
        open_px, source = oracle_open_px(duel_id, symbol, wait_s=20)
        OPENS[duel_id] = (open_px, source)
        print(
            f"[round {rnd}] duel {duel_id} {symbol} {source} open {open_px / 1e8:,.4f} tx {opened['tx']} "
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
            lock_s,
            cfg.get("chaos") is not None,
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
    warn_if_arena_missing()
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
        metavar="A,B,C,D",
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
    p.add_argument(
        "--profile",
        choices=PROFILES,
        help="agent A's prompt profile (B stays naive), or the --only agent's; default hardened (--only: naive)",
    )
    p.add_argument(
        "--judgments",
        type=int,
        default=1,
        metavar="K",
        help="hardened-v2/v3: K independent calls per decision, majority side; each decision costs K calls",
    )
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
    p.add_argument(
        "--health",
        action="store_true",
        help="check NEAR AI Cloud for this run's models (GET /v1/models, free), print one line, exit 0 or 1",
    )
    p.add_argument(
        "--chat",
        action="store_true",
        help="with --health: also a 1-output-token chat call per model (billed), since a listed model can still 5xx",
    )
    args = p.parse_args()
    if args.chat and not args.health:
        p.error("--chat goes with --health")
    if args.health:
        # the models this run would call: A and B (or the --only agent's), plus the fact-check judge under hardened-v3
        names = [args.only] if args.only else ["A", "B"]
        models = list(dict.fromkeys(client_from_env(ENV, n).model_id for n in names))
        if args.profile == HARDENED_V3:
            models = list(dict.fromkeys([*models, JUDGE_MODEL]))
        why, done = model_health(ENV, models, chat=args.chat)
        if why is not None:
            print(f"unhealthy: {why}", file=sys.stderr)
            raise SystemExit(1)
        print(f"healthy: {done}")
        raise SystemExit(0)
    arms = "".join(args.variants.upper().split(","))
    if arms and (len(set(arms)) != len(arms) or not set(arms) <= set(VARIANTS)):
        p.error(f"--variants takes distinct arms from {','.join(VARIANTS)}; got {args.variants!r}")
    if args.judgments < 1 or (args.judgments > 1 and args.profile not in GUARDED):
        p.error("--judgments takes K >= 1, and K > 1 only with --profile hardened-v2 or hardened-v3")
    if arms and args.profile not in (None, "hardened"):
        p.error("--variants sets agent A's prompt per duel; it runs on the hardened profile")
    if args.only and args.hardened and args.profile not in (None, "hardened"):
        p.error(f"--hardened and --profile {args.profile} disagree")
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
            args.profile,
            args.judgments,
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
        args.profile or "hardened",
        args.judgments,
    )
    print(json.dumps(out, indent=2))
