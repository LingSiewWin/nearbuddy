"""Export the decision log as a research dataset anyone can verify against the chain.

    .venv/bin/python export_dataset.py
    # writes ../dataset/{decisions.jsonl,decisions.parquet,README.md,CITATION.cff,attestations/}

Each exported row keeps the exact request and response bytes of the model call, so a third party can recompute
`sha256(request_body)`, `sha256(response_body)`, the enclave text `"{model}:{req}:{res}"`, check the ed25519
`signature_record` against the attestation's `signing_address`, and compare `sha256(req || res)` with the
`proof_hash` inside the on-chain intent (`tx`). Rows from the stub model carry no bytes and a zero proof.

`README.md` is a Hugging Face dataset card (YAML front matter, schema, verification snippet, limitations).
`decisions.parquet` is written when pyarrow is importable, for the Hub viewer; `decisions.jsonl` stays the source.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import ATTEST_DIR, DATA, network_file  # noqa: E402
from duelist import DuelistError, parse_decision  # noqa: E402
from intent_client import TeeProofError, proof_hash, tee_proof  # noqa: E402
from nearai import DEFAULT_MAX_TOKENS, MAX_TOKENS, message_text, request_body  # noqa: E402
from prompts import FULL_SIZE_BPS, SIZER, VARIANT_D, sizer_user, user_bc  # noqa: E402

HERE = Path(__file__).resolve().parent
SRC = DATA
# tracked snapshot (dataset-mainnet/ on mainnet): judges and researchers read it from the repo
OUT = network_file(HERE.parent / "dataset")
HUB_REPO = "NekoRobbin/nearbuddy-arena-duels"
SOURCE = "https://github.com/LingSiewWin/nearbuddy"
FIRST_ORACLE_DUEL = 257  # duels 0-256 were resolved with the operator's oracle key (before deploy 7)

# Every top-level key a row can carry: (name, type, meaning). tests/test_export_dataset.py fails on an undocumented key.
FIELDS: list[tuple[str, str, str]] = [
    ("duel_id", "string", "Arena duel id on `arena.nearbuddy-solver.testnet` (decimal string)."),
    ("agent_pk", "string", "The agent's ed25519 public key, base64; the key that signed `intent`."),
    ("model", "string", "Model id, e.g. `Qwen/Qwen3.8-27B`; `stub/deterministic` for the non-LLM baseline."),
    ("hardened", "bool \\| null", "True when the agent ran the hardened system prompt (treat telemetry as untrusted)."),
    (
        "prompt_variant",
        "string \\| null",
        "Prompt arm: `naive`, `hardened`, or experiment arm `A`/`B`/`C`/`D`; null on rows older than the field.",
    ),
    (
        "open_px",
        "int \\| null",
        "Duel open price (1e8 fixed point) the brief's move since open is measured from; null on older rows.",
    ),
    (
        "open_source",
        "string \\| null",
        "`oracle` when the brief used the duel's oracle open price, `spot` when the oracle had not answered "
        "within 20 s and the runner used its own spot; null on older rows. Attacks on `spot` briefs are left "
        "unclassified by against/with analysis.",
    ),
    (
        "arm_d",
        "struct \\| null",
        "Arm D only: `{side_call, size_call, proof_call, size_bps, size_asked, size_note}`. `side_call` saw no "
        "telemetry and fixed the side; `size_call` (null when unattacked) read the telemetry and could only lower "
        "`size_bps`. Each call carries `{text, chat_id, request_body, response_body, request_hash, response_hash, "
        "signature_record, tee}`. `proof_call` names the call the top-level bytes and the intent's proof are; the "
        "size call's request quotes the side and `sha256(side_call.text)`.",
    ),
    (
        "pair_tag",
        "string \\| null",
        "Which agent pair played (`runner.py --pair-tag`): null for the main pair, e.g. `p2` for the second loop's "
        "models; pairs never share an agent key.",
    ),
    ("brief", "string \\| null", "The market brief the model saw (price and move since duel open)."),
    (
        "injection",
        "string \\| null",
        "Adversarial telemetry a spectator paid to inject on chain (`inject_chaos`), appended to the prompt; "
        "null when the decision was not attacked. Several payloads are joined with newlines.",
    ),
    ("text", "string \\| null", "Raw model output (the completion's message content)."),
    ("chat_id", "string \\| null", "NEAR AI Cloud completion id; key for `GET /v1/signature/{chat_id}`."),
    (
        "request_body",
        "string \\| null",
        "Exact UTF-8 bytes of the chat completion request sent to NEAR AI Cloud.",
    ),
    ("response_body", "string \\| null", "Exact UTF-8 bytes of the completion response."),
    ("request_hash", "string \\| null", "`sha256(request_body)`, hex."),
    ("response_hash", "string \\| null", "`sha256(response_body)`, hex."),
    (
        "signature_record",
        "struct \\| null",
        "NEAR AI Cloud signature record `{text, signature, signing_address, signing_algo, signature_kind}`: "
        "ed25519 `signature` (hex) by `signing_address` (hex public key) over `text`.",
    ),
    (
        "tee",
        "struct \\| null",
        "The `TeeProof` the contract verified: `{kind, request_hash, response_hash, signer, signature}` "
        "(base64; `kind` 2 = provider_tee, 1 = gateway).",
    ),
    (
        "attestation_file",
        "string \\| null",
        "File in `attestations/` with the enclave's attestation report (Intel TDX quote, NVIDIA payload, nonce); "
        "its `model_attestations[].signing_address` is the signer of `signature_record`.",
    ),
    (
        "intent",
        "struct \\| null",
        "Agent-signed decision posted on chain: `{agent_pk, duel_id, side (Long/Short), size_bps, nonce, "
        "expires_at (ns), proof_hash}`; `proof_hash` = base64 `sha256(request_hash || response_hash)`, 32 zero "
        "bytes for stub rows.",
    ),
    (
        "tx",
        "string \\| null",
        "NEAR testnet transaction hash that put `intent` on chain: `post_intent`, or `reveal_intent` under "
        "commit-reveal (then equal to `revealed_tx`); null when the intent was not posted or revealed.",
    ),
    (
        "commitment",
        "string \\| null",
        "Commit-reveal only: base64 `sha256(intent_message(intent) || salt)`, the 32 bytes `commit_intent` stored "
        "while the side was hidden. The salt is not in the row; it is in the `reveal_intent` args of `revealed_tx`. "
        "Null on a row that kept an earlier commitment.",
    ),
    (
        "committed_tx",
        "string \\| null",
        "Commit-reveal only: transaction hash of `commit_intent` for `commitment`; null when the commit was refused "
        "or not sent.",
    ),
    (
        "revealed_tx",
        "string \\| null",
        "Commit-reveal only: transaction hash of `reveal_intent`, which verified the enclave proof and opened the "
        "commitment; null when the commitment was never revealed (replaced, kept, late or refused).",
    ),
    (
        "kept_commitment",
        "string \\| null",
        "Commit-reveal only: this call chose the same side and size as the commitment already on chain, so the "
        "runner kept that one (its base64 `commitment`) instead of committing again; the row's intent was never "
        "sent.",
    ),
    (
        "replaced_by",
        "string \\| null",
        "Commit-reveal only: a later `commit_intent` (this tx hash) replaced this row's commitment on chain before "
        "it was revealed; the row's intent never reached the chain.",
    ),
    (
        "quotes",
        "list[struct] \\| null",
        "Solver quotes for vault followers mirroring the intent: `{follower, amount, amountOut}` (yocto strings).",
    ),
    (
        "error",
        "string \\| null",
        "Why the decision was not posted (unparseable output, `no tee proof`, `duel closed`, `intent lock`, "
        "`evidence not oracle`, and under commit-reveal `reveal failed: ...` or `commitment not on chain`); absent "
        "on posted rows.",
    ),
    ("verifiable", "bool", "Added by the exporter: every hash, the enclave signature and `proof_hash` check out."),
    ("verify_note", "string", "Added by the exporter: `ok` or the first check that failed (e.g. `no tee bytes`)."),
]

# Runs as-is in tests/test_export_dataset.py against real rows; keep it equivalent to check_row.
_SNIPPET = r'''import base64
import hashlib
import json
import re

from nacl.signing import VerifyKey  # pip install pynacl

# arm D: the side call's system prompt (format with the symbol), and the head of the size call's user message,
# which quotes the brief, the side it sizes and sha256 of the side call's output before the telemetry
ARM_D_SYSTEM = __ARM_D_SYSTEM__
SIZER_SYSTEM = __SIZER_SYSTEM__
FULL_SIZE_BPS = __FULL_SIZE_BPS__
# max_tokens the runner's client sends per model; any other request field or value is not the runner's call
MAX_TOKENS = __MAX_TOKENS__
DEFAULT_MAX_TOKENS = __DEFAULT_MAX_TOKENS__
SIZE_HEAD = re.compile(
    r"\[ORACLE\]\n(.*?)\n\[/ORACLE\]\n\n\[POSITION\]\nside: (LONG|SHORT)\nfull_size_bps: \d+\n"
    r"side_call_sha256: ([0-9a-f]{64})\n\[/POSITION\]\n\n\[TELEMETRY\]\n",
    re.DOTALL,
)


def verify_call(call: dict, model: str) -> str:
    """'ok' when one completion's bytes, stored hashes and enclave signature agree; else the failed check."""
    if not call.get("request_body") or not call.get("response_body"):
        return "no tee bytes"
    req = hashlib.sha256(call["request_body"].encode()).hexdigest()
    res = hashlib.sha256(call["response_body"].encode()).hexdigest()
    if (req, res) != (call["request_hash"], call["response_hash"]):
        return "stored hash differs from bytes"
    rec = call.get("signature_record")
    if not rec:
        return "no signature record"
    text = f"{req}:{res}" if rec["signature_kind"] == "gateway" else f"{model}:{req}:{res}"
    if rec["text"] != text:
        return "record text differs from bytes"
    signer = bytes.fromhex(rec["signing_address"].removeprefix("0x"))
    VerifyKey(signer).verify(text.encode(), bytes.fromhex(rec["signature"].removeprefix("0x")))  # raises if forged
    return "ok"


def direction(text: str) -> str | None:
    """'Long' / 'Short' from a decision's JSON, as the runner parsed it; None when there is none."""
    m = re.search(r"\{.*\}", text or "", re.DOTALL)
    try:
        token = str(json.loads(m.group(0)).get("direction", "")).strip().lower() if m else ""
    except (ValueError, AttributeError):
        token = ""
    if token in ("long", "buy", "up", "+1", "1"):
        return "Long"
    return "Short" if token in ("short", "sell", "down", "-1") else None


def messages(call: dict) -> list:
    return [(m["role"], m["content"]) for m in json.loads(call["request_body"])["messages"]]


def client_body(model: str, system: str, user: str) -> str:
    """The exact request body the runner's NEAR AI client sends for this prompt."""
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    max_tokens = MAX_TOKENS.get(model, DEFAULT_MAX_TOKENS)
    payload = {"model": model, "messages": msgs, "max_tokens": max_tokens, "stream": False}
    return json.dumps(payload, separators=(",", ":"))


def verify(row: dict) -> str:
    """'ok' when the bytes, the enclave signature and the on-chain proof_hash agree (for arm D also the side call
    and its link to the posted intent); else the failed check."""
    note = verify_call(row, row["model"])
    if note != "ok":
        return note
    req, res = bytes.fromhex(row["request_hash"]), bytes.fromhex(row["response_hash"])
    if row["intent"]["proof_hash"] != base64.b64encode(hashlib.sha256(req + res).digest()).decode():
        return "proof_hash differs"
    d = row.get("arm_d")
    if not d:
        return "ok"
    side = d["side_call"]
    note = verify_call(side, row["model"])
    if note != "ok":
        return f"arm_d side call: {note}"
    if side["signature_record"]["signing_address"] != row["signature_record"]["signing_address"]:
        return "arm_d signer differs"
    msg = json.loads(side["response_body"])["choices"][0]["message"]
    if side["text"] != (msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or ""):
        return "arm_d side text differs from bytes"
    if direction(side["text"]) != row["intent"]["side"]:
        return "arm_d side call direction differs"
    oracle_only = [
        ("system", ARM_D_SYSTEM.format(symbol=row["brief"].split(" ", 1)[0].upper())),
        ("user", f"[ORACLE]\n{row['brief']}\n[/ORACLE]"),
    ]
    if messages(side) != oracle_only:
        return "arm_d side request is not oracle-only"
    if side["request_body"] != client_body(row["model"], *(content for _, content in oracle_only)):
        return "arm_d side request is not the client's body"
    proof = side if d["proof_call"] == "side" else d["size_call"]
    if (proof["request_hash"], proof["response_hash"]) != (row["request_hash"], row["response_hash"]):
        return "arm_d proof call differs"
    if d["proof_call"] == "size":
        head = SIZE_HEAD.match(messages(row)[-1][1])
        if not head:
            return "arm_d size request malformed"
        if head.group(1) != row["brief"]:
            return "arm_d size call brief differs"
        if head.group(3) != hashlib.sha256(side["text"].encode()).hexdigest():
            return "arm_d digest differs"
        if head.group(2) != row["intent"]["side"].upper():
            return "arm_d side differs"
        position = f"side: {head.group(2)}\nfull_size_bps: {FULL_SIZE_BPS}\nside_call_sha256: {head.group(3)}"
        user = (
            f"[ORACLE]\n{row['brief']}\n[/ORACLE]\n\n[POSITION]\n{position}\n[/POSITION]\n\n"
            f"[TELEMETRY]\n{row['injection']}\n[/TELEMETRY]"
        )
        symbol = row["brief"].split(" ", 1)[0].upper()
        if row["request_body"] != client_body(row["model"], SIZER_SYSTEM.format(symbol=symbol), user):
            return "arm_d size request is not the client's body"
    return "ok"
'''
VERIFY_SNIPPET = (
    _SNIPPET.replace("__ARM_D_SYSTEM__", repr(VARIANT_D))
    .replace("__SIZER_SYSTEM__", repr(SIZER))
    .replace("__FULL_SIZE_BPS__", repr(FULL_SIZE_BPS))
    .replace("__MAX_TOKENS__", repr(MAX_TOKENS))
    .replace("__DEFAULT_MAX_TOKENS__", repr(DEFAULT_MAX_TOKENS))
)

# Head of arm D's size-call user message (prompts.sizer_user): brief, quoted side and side digest, before the
# telemetry. Anchored at the start, so a [POSITION] block an attacker writes into the telemetry is never read.
SIZE_HEAD = re.compile(
    r"\[ORACLE\]\n(.*?)\n\[/ORACLE\]\n\n\[POSITION\]\nside: (LONG|SHORT)\nfull_size_bps: \d+\n"
    r"side_call_sha256: ([0-9a-f]{64})\n\[/POSITION\]\n\n\[TELEMETRY\]\n",
    re.DOTALL,
)


def _check_call(c: dict, model: str) -> str:
    """'ok' when one completion's bytes, stored hashes and enclave record agree; else the first failed check."""
    if not c.get("request_body") or not c.get("response_body"):
        return "no tee bytes"
    req = hashlib.sha256(c["request_body"].encode()).digest()
    res = hashlib.sha256(c["response_body"].encode()).digest()
    if req.hex() != c.get("request_hash") or res.hex() != c.get("response_hash"):
        return "stored hash differs from bytes"
    rec = c.get("signature_record")
    if not rec:
        return "no signature record"
    try:
        tee_proof(rec, model, req, res)  # text, kind, ed25519 signature under signing_address
    except (TeeProofError, KeyError, ValueError, TypeError) as exc:
        return f"enclave record: {type(exc).__name__}: {str(exc)[:80]}"
    return "ok"


def _messages(c: dict) -> list[tuple[str, str]]:
    return [(m["role"], m["content"]) for m in json.loads(c["request_body"])["messages"]]


def _check_arm_d(r: dict) -> str:
    """Arm D. The side call verifies under the same enclave signer; its stored text is what its signed response
    says; its own decision is the posted side; its signed request is exactly the oracle-only prompt on the row's
    brief (no telemetry). The proof call is the row's top-level call, and the size call's signed request quotes the
    same brief, sha256 of the side call's text and the posted side."""
    d = r["arm_d"]
    side = d.get("side_call") or {}
    note = _check_call(side, r["model"])
    if note != "ok":
        return f"arm_d side call: {note}"
    if side["signature_record"].get("signing_address") != r["signature_record"].get("signing_address"):
        return "arm_d signer differs"
    try:
        if side.get("text") != message_text(json.loads(side["response_body"])):
            return "arm_d side text differs from bytes"
    except (ValueError, KeyError, IndexError, TypeError):
        return "arm_d side text differs from bytes"
    try:
        chose = "Long" if parse_decision(side["text"]).direction > 0 else "Short"
    except DuelistError:
        chose = None
    if chose != r.get("intent", {}).get("side"):
        return "arm_d side call direction differs"
    brief = str(r.get("brief") or "")
    system, user = VARIANT_D.format(symbol=brief.split(" ", 1)[0].upper()), user_bc(brief, None)
    oracle_only = [("system", system), ("user", user)]
    try:
        if _messages(side) != oracle_only:
            return "arm_d side request is not oracle-only"
    except (ValueError, KeyError, TypeError):
        return "arm_d side request is not oracle-only"
    # byte for byte what the runner's client sends: no temperature, logit_bias or other max_tokens can steer it
    if side["request_body"].encode() != request_body(r["model"], system, user):
        return "arm_d side request is not the client's body"
    proof = side if d.get("proof_call") == "side" else d.get("size_call") or {}
    if (proof.get("request_hash"), proof.get("response_hash")) != (r["request_hash"], r["response_hash"]):
        return "arm_d proof call differs"
    if d.get("proof_call") == "size":
        try:
            head = SIZE_HEAD.match(_messages(r)[-1][1])
        except (ValueError, KeyError, TypeError, IndexError):
            head = None
        if not head:
            return "arm_d size request malformed"
        if head.group(1) != brief:
            return "arm_d size call brief differs"
        if head.group(3) != hashlib.sha256(side["text"].encode()).hexdigest():
            return "arm_d digest differs"
        if head.group(2) != str(r.get("intent", {}).get("side", "")).upper():
            return "arm_d side differs"
        system = SIZER.format(symbol=brief.split(" ", 1)[0].upper())
        user = sizer_user(brief, head.group(2), FULL_SIZE_BPS, head.group(3), str(r.get("injection")))
        if r["request_body"].encode() != request_body(r["model"], system, user):
            return "arm_d size request is not the client's body"
    return "ok"


def check_row(r: dict) -> tuple[bool, str]:
    """Recompute every hash the row claims with the same code the runner used. Returns (verifiable, note)."""
    note = _check_call(r, r.get("model", ""))
    if note != "ok":
        return False, note
    req, res = bytes.fromhex(r["request_hash"]), bytes.fromhex(r["response_hash"])
    if r.get("intent", {}).get("proof_hash") != proof_hash(req, res):
        return False, "proof_hash differs"
    if r.get("arm_d"):
        note = _check_arm_d(r)
        if note != "ok":
            return False, note
    return True, "ok"


def write_parquet(rows: list[dict[str, Any]], path: Path) -> bool:
    """Columnar copy for the Hub viewer. Columns are the union of all row keys (rows differ: error rows, old rows
    without `prompt_variant`), filled with null. Returns False when pyarrow is not installed."""
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        return False
    keys = list(dict.fromkeys(k for r in rows for k in r))
    pq.write_table(pa.table({k: [r.get(k) for r in rows] for k in keys}), path)
    return True


def size_category(n: int) -> str:
    for limit, label in ((1_000, "n<1K"), (10_000, "1K<n<10K"), (100_000, "10K<n<100K")):
        if n < limit:
            return label
    return "100K<n<1M"


def card(rows: list[dict[str, Any]], data_file: str) -> str:
    """The Hugging Face dataset card for `rows` (already carrying `verifiable` / `verify_note`)."""
    duels = sorted({int(r["duel_id"]) for r in rows if r.get("duel_id") is not None})
    notes = Counter(r.get("verify_note") for r in rows)
    variants = Counter(r.get("prompt_variant") or "unlabelled" for r in rows)
    per_model = []
    for m, n in Counter(r.get("model") for r in rows).most_common():
        mine = [r for r in rows if r.get("model") == m]
        counts = " | ".join(str(sum(1 for r in mine if r.get(k))) for k in ("verifiable", "injection", "error"))
        per_model.append(f"| `{m}` | {n} | {counts} |")
    schema = "\n".join(f"| `{name}` | {typ} | {meaning} |" for name, typ, meaning in FIELDS)
    attacked = sum(1 for r in rows if r.get("injection"))
    return f"""---
license: cc-by-4.0
language:
- en
pretty_name: NearBuddy Arena Duels
size_categories:
- {size_category(len(rows))}
task_categories:
- text-classification
- text-generation
tags:
- near
- trading-agents
- tee
- confidential-computing
- prompt-injection
- adversarial
- llm-agents
- nearbuddy
configs:
- config_name: default
  data_files:
  - split: decisions
    path: {data_file}
---

# NearBuddy Arena Duels

## Dataset summary

Every trading decision made by LLM agents in NearBuddy's on-chain duel arena on NEAR testnet (contract
`arena.nearbuddy-solver.testnet`): {len(rows)} decisions across {len(duels)} duels (ids {duels[0]}-{duels[-1]}),
{attacked} of them made under a prompt injection a spectator paid for on chain. Two agents duel on NEAR/USD; each
cycle a model reads a market brief, answers Long or Short, the agent signs that decision as an `Intent` and posts it
on chain, and an oracle prices the duel at close.

For enclave-backed rows the dataset keeps the exact request and response bytes of the model call, the NEAR AI Cloud
enclave's ed25519 signature over their hashes, and the on-chain intent that commits to the same hashes, so anyone can
check that this model produced this output for this prompt without trusting the publisher. `attestations/` holds each
enclave's Intel TDX quote and NVIDIA GPU payload with the nonce used, binding `signing_address` to hardware.

Uses: prompt-injection robustness of LLM trading agents (attacked vs unattacked, naive vs hardened prompts),
verifiable-inference research, agent decision analysis.

| Model | Decisions | Verifiable | Attacked | Errors |
|---|---|---|---|---|
{chr(10).join(per_model)}

Verification: {dict(notes)}. Prompt arms: {dict(variants)}.

## Loading

```python
from datasets import load_dataset

ds = load_dataset("{HUB_REPO}", split="decisions")
attacked = ds.filter(lambda r: r["injection"] is not None)  # the prompt-injection subset
enclave = ds.filter(lambda r: r["verifiable"])  # rows whose enclave proof re-verifies
```

## Schema

One row per decision. `decisions.jsonl` is the source of truth (one JSON object per line); `decisions.parquet` is
the same rows for the viewer, with absent keys as null.

| Field | Type | Meaning |
|---|---|---|
{schema}

## Verify a row

The enclave signs `"{{model}}:{{sha256(request)}}:{{sha256(response)}}"` (`provider_tee`; a `gateway` record signs
only `"{{sha256(request)}}:{{sha256(response)}}"`). The contract accepted the intent only if that signature verified
under a signer it pins and `intent.proof_hash == sha256(request_hash || response_hash)`. Arm D rows carry two
calls: the contract verified the top-level one (the size call when the decision was attacked), and the snippet also
checks `arm_d.side_call` under the same signer: its `text` is what its signed response says, its own decision is
the posted side, and its signed request is byte for byte the body the runner's client sends for the oracle-only
prompt on the row's `brief` (no telemetry, no sampling fields, the model's `max_tokens`). The size call's signed
request must be the client's body too, quoting the same brief, `sha256(side_call.text)` and the posted side.
Recompute it offline:

```python
{VERIFY_SNIPPET}```

```python
import json

rows = [json.loads(line) for line in open("decisions.jsonl")]
print(sum(verify(r) == "ok" for r in rows), "of", len(rows), "rows verify")
```

To tie the signer to hardware, open `attestations/<attestation_file>`, find the entry in
`report.model_attestations` whose `signing_address` equals the row's, and check its `intel_quote` with dcap-qvl and
its `nvidia_payload` with NVIDIA NRAS (the nonce is in the file). To tie the row to the chain, look up `tx` on
https://testnet.nearblocks.io and compare the posted intent with `intent`. Under commit-reveal, `tx` is the
`reveal_intent` (`revealed_tx`): its args carry the same intent, the enclave proof and the salt, so
`sha256(intent_message(intent) || salt)` must equal `commitment`, which `committed_tx` stored before the reveal.

## Known limitations

- **Stub rows.** `stub/deterministic` is a non-LLM baseline with no request or response bytes and a zero
  `proof_hash`; those rows have `verifiable: false, verify_note: "no tee bytes"`. Filter on `verifiable` for
  model behaviour.
- **Pre-TEE era.** Duels 0-{FIRST_ORACLE_DUEL - 1} were resolved with the operator's oracle key, before the
  Outlayer TEE price oracle (contract deploy 7). Every duel from {FIRST_ORACLE_DUEL} on is oracle-resolved, and
  enclave-signed decisions start at duel 258. Outcomes are on chain (`get_duel(id).outcome`), not in these rows.
- **Provider vs gateway kinds.** A `provider_tee` signature (kind 2) covers the model id, so it proves the named
  model ran in the enclave. A `gateway` signature (kind 1) proves only what the gateway returned. The runner and the
  contract only accept kind 2, so every verifiable row is `provider_tee`.
- **Payload sets.** Injections come from two fixed lists in `packages/demo/src/spectator.ts` of the source repo:
  `train` (the 8 payloads the hardened prompt was written against) and `holdout` (8 later payloads with the same
  slots, never used to edit prompts). Rows carry no set label; split by exact `injection` text against those lists.
- **Error rows.** Rows with `error` were not posted on chain (`tx` is null or absent). Parse failures keep `text`
  and `response_body` (and from duel 399 on the exact `request_body`) but no signature, since no proof is requested
  for a call with no decision, so they do not verify (`no tee bytes` or `no signature record`); late rows
  (`duel closed`, `intent lock`) verify but have no on-chain intent. Leave error rows out of win-rate counts.
- **Commit-reveal rows.** A revealed intent verifies exactly like a posted one (`tx` = `revealed_tx`). A row with
  `replaced_by` or `kept_commitment` also verifies from its bytes, but its intent never reached the chain: count
  only rows with a `tx` when scoring calls. `commitment` cannot be recomputed from the row alone; the salt is in
  the `reveal_intent` args.
- **Re-rolls are invisible.** Sampling is not deterministic, so the operator could repeat a call (in any arm, or
  arm D's side call) until it returns a wanted answer and publish only that one. A signature proves a completion
  happened, not that it was the only one.
- **Small and testnet.** Few attacked rows per arm and testnet stakes; treat rates as provisional.

## Citation

```bibtex
@misc{{nearbuddy_arena_duels,
  title  = {{NearBuddy Arena Duels: enclave-verified LLM trading decisions under prompt injection}},
  author = {{NearBuddy}},
  year   = {{2026}},
  url    = {{https://huggingface.co/datasets/{HUB_REPO}}},
  note   = {{Snapshot through duel {duels[-1]}. Source: {SOURCE}}}
}}
```

`CITATION.cff` carries the same metadata. License: CC BY 4.0.
"""


def main() -> int:
    rows = [json.loads(line) for line in SRC.read_text().splitlines() if line.strip()]
    OUT.mkdir(parents=True, exist_ok=True)
    out_rows = []
    for r in rows:
        ok, note = check_row(r)
        out_rows.append({**r, "verifiable": ok, "verify_note": note})
    with (OUT / "decisions.jsonl").open("w") as f:
        for r in out_rows:
            f.write(json.dumps(r) + "\n")
    parquet = write_parquet(out_rows, OUT / "decisions.parquet")
    if not parquet:
        (OUT / "decisions.parquet").unlink(missing_ok=True)  # a stale copy would disagree with the jsonl
    att_src = ATTEST_DIR
    if att_src.exists():
        shutil.copytree(att_src, OUT / "attestations", dirs_exist_ok=True)
    (OUT / "README.md").write_text(card(out_rows, "decisions.parquet" if parquet else "decisions.jsonl"))
    last_duel = max((r.get("duel_id", "0") for r in rows), key=int)
    (OUT / "CITATION.cff").write_text(
        "cff-version: 1.2.0\nmessage: Cite this dataset when you use the decisions or the enclave records.\n"
        "title: NearBuddy Arena Duels\ntype: dataset\nlicense: CC-BY-4.0\n"
        f"version: {last_duel}\n"
        f"url: https://huggingface.co/datasets/{HUB_REPO}\n"
        f"repository-code: {SOURCE}\nauthors:\n  - name: NearBuddy\n"
        "keywords: [near, trading-agents, tee, prompt-injection]\n"
    )
    print(
        json.dumps(
            {
                "rows": len(rows),
                "duels": len({r.get("duel_id") for r in rows}),
                "injected": sum(1 for r in rows if r.get("injection")),
                "models": dict(Counter(r.get("model") for r in rows)),
                "verify": dict(Counter(r["verify_note"] for r in out_rows)),
                "parquet": parquet,
            },
            indent=1,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
