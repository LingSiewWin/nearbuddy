"""Export the decision log as a research dataset anyone can verify against the chain.

    .venv/bin/python export_dataset.py            # writes data/export/{decisions.jsonl,README.md,attestations/}

Each exported row keeps the exact request and response bytes of the model call, so a third party can recompute
`sha256(request_body)`, `sha256(response_body)`, the enclave text `"{model}:{req}:{res}"`, check the ed25519
`signature_record` against the attestation's `signing_address`, and compare `sha256(req || res)` with the
`proof_hash` inside the on-chain intent (`tx`). Rows from the stub model carry no bytes and a zero proof.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from intent_client import TeeProofError, proof_hash, tee_proof  # noqa: E402

HERE = Path(__file__).resolve().parent
SRC = HERE / "data" / "decisions.jsonl"
OUT = HERE / "data" / "export"


def check_row(r: dict) -> tuple[bool, str]:
    """Recompute every hash the row claims with the same code the runner used. Returns (verifiable, note)."""
    if not r.get("request_body") or not r.get("response_body"):
        return False, "no tee bytes"
    req = hashlib.sha256(r["request_body"].encode()).digest()
    res = hashlib.sha256(r["response_body"].encode()).digest()
    if req.hex() != r.get("request_hash") or res.hex() != r.get("response_hash"):
        return False, "stored hash differs from bytes"
    rec = r.get("signature_record")
    if not rec:
        return False, "no signature record"
    try:
        tee_proof(rec, r["model"], req, res)  # text, kind, ed25519 signature under signing_address
    except (TeeProofError, KeyError, ValueError, TypeError) as exc:
        return False, f"enclave record: {type(exc).__name__}: {str(exc)[:80]}"
    if r.get("intent", {}).get("proof_hash") != proof_hash(req, res):
        return False, "proof_hash differs"
    return True, "ok"


def main() -> int:
    rows = [json.loads(l) for l in SRC.read_text().splitlines() if l.strip()]
    OUT.mkdir(parents=True, exist_ok=True)
    notes = Counter()
    with (OUT / "decisions.jsonl").open("w") as f:
        for r in rows:
            ok, note = check_row(r)
            notes[note] += 1
            r = {**r, "verifiable": ok, "verify_note": note}
            f.write(json.dumps(r) + "\n")
    att_src = HERE / "data" / "attestations"
    if att_src.exists():
        shutil.copytree(att_src, OUT / "attestations", dirs_exist_ok=True)
    models = Counter(r.get("model") for r in rows)
    duels = {r.get("duel_id") for r in rows}
    injected = sum(1 for r in rows if r.get("injection"))
    card = f"""---
license: cc-by-4.0
task_categories: [text-classification]
tags: [near, trading-agents, tee, prompt-injection, nearbuddy]
pretty_name: NearBuddy arena decisions
---

# NearBuddy arena decisions

{len(rows)} model decisions across {len(duels)} duels on NEAR testnet (contract `arena.nearbuddy-solver.testnet`),
{injected} of them made under a spectator's prompt injection. Models: {dict(models)}.

Each row: `brief` (what the model saw), `injection` (adversarial telemetry, if any), `text` (raw model output),
`intent` (the agent-signed decision posted on chain, `tx`), and for TEE-backed rows the exact `request_body` and
`response_body` bytes with `request_hash`, `response_hash`, the NEAR AI Cloud `signature_record` and the `tee`
proof the contract verified. `verifiable` is true when this exporter recomputed every hash and the enclave
signature from the bytes: {dict(notes)}.

`attestations/` holds the Intel TDX quote and NVIDIA payload for each model's enclave with the nonce used, so the
`signing_address` trusted on chain (`is_tee_signer`) can be checked against NVIDIA NRAS and dcap-qvl.

Source: https://github.com/LingSiewWin/nearbuddy
"""
    (OUT / "README.md").write_text(card)
    print(json.dumps({"rows": len(rows), "duels": len(duels), "injected": injected, "models": dict(models), "verify": dict(notes)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
