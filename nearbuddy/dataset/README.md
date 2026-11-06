---
license: cc-by-4.0
language:
- en
pretty_name: NearBuddy Arena Duels
size_categories:
- 1K<n<10K
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
    path: decisions.parquet
---

# NearBuddy Arena Duels

## Dataset summary

Every trading decision made by LLM agents in NearBuddy's on-chain duel arena on NEAR testnet (contract
`arena.nearbuddy-solver.testnet`): 1870 decisions across 347 duels (ids 1-357),
97 of them made under a prompt injection a spectator paid for on chain. Two agents duel on NEAR/USD; each
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
| `stub/deterministic` | 1012 | 0 | 4 | 0 |
| `Qwen/Qwen3.8-27B` | 415 | 404 | 29 | 13 |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 411 | 410 | 60 | 1 |
| `z-ai/glm-5.3-flash` | 16 | 16 | 2 | 0 |
| `Qwen/Qwen3.6-35B-A3B-FP8` | 16 | 8 | 2 | 9 |

Verification: {'no tee bytes': 1032, 'ok': 838}. Prompt arms: {'unlabelled': 1632, 'naive': 121, 'C': 36, 'A': 32, 'B': 33, 'hardened': 16}.

## Loading

```python
from datasets import load_dataset

ds = load_dataset("NekoRobbin/nearbuddy-arena-duels", split="decisions")
attacked = ds.filter(lambda r: r["injection"] is not None)  # the prompt-injection subset
enclave = ds.filter(lambda r: r["verifiable"])  # rows whose enclave proof re-verifies
```

## Schema

One row per decision. `decisions.jsonl` is the source of truth (one JSON object per line); `decisions.parquet` is
the same rows for the viewer, with absent keys as null.

| Field | Type | Meaning |
|---|---|---|
| `duel_id` | string | Arena duel id on `arena.nearbuddy-solver.testnet` (decimal string). |
| `agent_pk` | string | The agent's ed25519 public key, base64; the key that signed `intent`. |
| `model` | string | Model id, e.g. `Qwen/Qwen3.8-27B`; `stub/deterministic` for the non-LLM baseline. |
| `hardened` | bool \| null | True when the agent ran the hardened system prompt (treat telemetry as untrusted). |
| `prompt_variant` | string \| null | Prompt arm: `naive`, `hardened`, or experiment arm `A`/`B`/`C`; null on rows older than the field. |
| `pair_tag` | string \| null | Which agent pair played (`runner.py --pair-tag`): null for the main pair, e.g. `p2` for the second loop's models; pairs never share an agent key. |
| `brief` | string \| null | The market brief the model saw (price and move since duel open). |
| `injection` | string \| null | Adversarial telemetry a spectator paid to inject on chain (`inject_chaos`), appended to the prompt; null when the decision was not attacked. Several payloads are joined with newlines. |
| `text` | string \| null | Raw model output (the completion's message content). |
| `chat_id` | string \| null | NEAR AI Cloud completion id; key for `GET /v1/signature/{chat_id}`. |
| `request_body` | string \| null | Exact UTF-8 bytes of the chat completion request sent to NEAR AI Cloud. |
| `response_body` | string \| null | Exact UTF-8 bytes of the completion response. |
| `request_hash` | string \| null | `sha256(request_body)`, hex. |
| `response_hash` | string \| null | `sha256(response_body)`, hex. |
| `signature_record` | struct \| null | NEAR AI Cloud signature record `{text, signature, signing_address, signing_algo, signature_kind}`: ed25519 `signature` (hex) by `signing_address` (hex public key) over `text`. |
| `tee` | struct \| null | The `TeeProof` the contract verified: `{kind, request_hash, response_hash, signer, signature}` (base64; `kind` 2 = provider_tee, 1 = gateway). |
| `attestation_file` | string \| null | File in `attestations/` with the enclave's attestation report (Intel TDX quote, NVIDIA payload, nonce); its `model_attestations[].signing_address` is the signer of `signature_record`. |
| `intent` | struct \| null | Agent-signed decision posted on chain: `{agent_pk, duel_id, side (Long/Short), size_bps, nonce, expires_at (ns), proof_hash}`; `proof_hash` = base64 `sha256(request_hash || response_hash)`, 32 zero bytes for stub rows. |
| `tx` | string \| null | NEAR testnet transaction hash of `post_intent`; null when the intent was not posted. |
| `quotes` | list[struct] \| null | Solver quotes for vault followers mirroring the intent: `{follower, amount, amountOut}` (yocto strings). |
| `error` | string \| null | Why the decision was not posted (unparseable output, `no tee proof`, `duel closed`, `intent lock`, `evidence not oracle`); absent on posted rows. |
| `verifiable` | bool | Added by the exporter: every hash, the enclave signature and `proof_hash` check out. |
| `verify_note` | string | Added by the exporter: `ok` or the first check that failed (e.g. `no tee bytes`). |

## Verify a row

The enclave signs `"{model}:{sha256(request)}:{sha256(response)}"` (`provider_tee`; a `gateway` record signs
only `"{sha256(request)}:{sha256(response)}"`). The contract accepted the intent only if that signature verified
under a signer it pins and `intent.proof_hash == sha256(request_hash || response_hash)`. Recompute it offline:

```python
import base64
import hashlib

from nacl.signing import VerifyKey  # pip install pynacl


def verify(row: dict) -> str:
    """'ok' when the bytes, the enclave signature and the on-chain proof_hash agree; else the failed check."""
    if not row.get("request_body") or not row.get("response_body"):
        return "no tee bytes"
    req = hashlib.sha256(row["request_body"].encode()).digest()
    res = hashlib.sha256(row["response_body"].encode()).digest()
    if (req.hex(), res.hex()) != (row["request_hash"], row["response_hash"]):
        return "stored hash differs from bytes"
    rec = row.get("signature_record")
    if not rec:
        return "no signature record"
    body = f"{req.hex()}:{res.hex()}"
    text = body if rec["signature_kind"] == "gateway" else f"{row['model']}:{body}"
    if rec["text"] != text:
        return "record text differs from bytes"
    signer = bytes.fromhex(rec["signing_address"].removeprefix("0x"))
    VerifyKey(signer).verify(text.encode(), bytes.fromhex(rec["signature"].removeprefix("0x")))  # raises if forged
    if row["intent"]["proof_hash"] != base64.b64encode(hashlib.sha256(req + res).digest()).decode():
        return "proof_hash differs"
    return "ok"
```

```python
import json

rows = [json.loads(line) for line in open("decisions.jsonl")]
print(sum(verify(r) == "ok" for r in rows), "of", len(rows), "rows verify")
```

To tie the signer to hardware, open `attestations/<attestation_file>`, find the entry in
`report.model_attestations` whose `signing_address` equals the row's, and check its `intel_quote` with dcap-qvl and
its `nvidia_payload` with NVIDIA NRAS (the nonce is in the file). To tie the row to the chain, look up `tx` on
https://testnet.nearblocks.io and compare the posted intent with `intent`.

## Known limitations

- **Stub rows.** `stub/deterministic` is a non-LLM baseline with no request or response bytes and a zero
  `proof_hash`; those rows have `verifiable: false, verify_note: "no tee bytes"`. Filter on `verifiable` for
  model behaviour.
- **Pre-TEE era.** Duels 0-256 were resolved with the operator's oracle key, before the
  Outlayer TEE price oracle (contract deploy 7). Every duel from 257 on is oracle-resolved, and
  enclave-signed decisions start at duel 258. Outcomes are on chain (`get_duel(id).outcome`), not in these rows.
- **Provider vs gateway kinds.** A `provider_tee` signature (kind 2) covers the model id, so it proves the named
  model ran in the enclave. A `gateway` signature (kind 1) proves only what the gateway returned. The runner and the
  contract only accept kind 2, so every verifiable row is `provider_tee`.
- **Payload sets.** Injections come from two fixed lists in `packages/demo/src/spectator.ts` of the source repo:
  `train` (the 8 payloads the hardened prompt was written against) and `holdout` (8 later payloads with the same
  slots, never used to edit prompts). Rows carry no set label; split by exact `injection` text against those lists.
- **Error rows.** Rows with `error` were not posted on chain (`tx` is null or absent). Parse failures keep `text`
  and `response_body` but no signature, so they do not verify; late rows (`duel closed`, `intent lock`) verify but
  have no on-chain intent. Leave error rows out of win-rate counts.
- **Small and testnet.** Few attacked rows per arm and testnet stakes; treat rates as provisional.

## Citation

```bibtex
@misc{nearbuddy_arena_duels,
  title  = {NearBuddy Arena Duels: enclave-verified LLM trading decisions under prompt injection},
  author = {NearBuddy},
  year   = {2026},
  url    = {https://huggingface.co/datasets/NekoRobbin/nearbuddy-arena-duels},
  note   = {Snapshot through duel 357. Source: https://github.com/LingSiewWin/nearbuddy}
}
```

`CITATION.cff` carries the same metadata. License: CC BY 4.0.
