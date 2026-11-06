"""`check_row` must accept a row whose bytes, hashes, enclave signature and proof_hash agree, and name the first
thing that disagrees when any one of them is tampered with."""

import base64
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nacl.signing import SigningKey  # noqa: E402

from export_dataset import check_row  # noqa: E402
from intent_client import proof_hash, tee_text  # noqa: E402

ENCLAVE = SigningKey(bytes([5] * 32))
MODEL = "test/model"


def good_row() -> dict[str, Any]:
    request = json.dumps({"model": MODEL, "messages": [{"role": "user", "content": "brief"}]}, separators=(",", ":"))
    response = json.dumps({"id": "chatcmpl-1", "choices": [{"message": {"content": '{"direction":"long"}'}}]})
    req, res = hashlib.sha256(request.encode()).digest(), hashlib.sha256(response.encode()).digest()
    text = tee_text(2, MODEL, req, res)
    return {
        "duel_id": "1",
        "model": MODEL,
        "request_body": request,
        "response_body": response,
        "request_hash": req.hex(),
        "response_hash": res.hex(),
        "signature_record": {
            "text": text.decode(),
            "signature": ENCLAVE.sign(text).signature.hex(),
            "signing_address": bytes(ENCLAVE.verify_key).hex(),
            "signing_algo": "ed25519",
            "signature_kind": "provider_tee",
        },
        "intent": {"side": "Long", "proof_hash": proof_hash(req, res)},
    }


def test_untampered_row_verifies():
    assert check_row(good_row()) == (True, "ok")


def test_stub_rows_carry_no_bytes():
    r = good_row()
    r["request_body"] = ""
    assert check_row(r) == (False, "no tee bytes")
    assert check_row({"model": MODEL}) == (False, "no tee bytes")


def test_edited_response_body_breaks_the_stored_hash():
    r = good_row()
    r["response_body"] = r["response_body"].replace("long", "short")
    assert check_row(r) == (False, "stored hash differs from bytes")


def test_rewritten_hashes_break_the_enclave_signature():
    # an attacker who edits the body and recomputes the hashes still cannot produce the enclave's signature
    r = good_row()
    r["response_body"] = r["response_body"].replace("long", "short")
    r["response_hash"] = hashlib.sha256(r["response_body"].encode()).hexdigest()
    ok, note = check_row(r)
    assert not ok and note.startswith("enclave record: TeeProofError")


def test_missing_or_foreign_signature_record():
    r = good_row()
    r["signature_record"] = None
    assert check_row(r) == (False, "no signature record")
    r = good_row()
    r["signature_record"]["signing_address"] = bytes(SigningKey(bytes([6] * 32)).verify_key).hex()
    ok, note = check_row(r)
    assert not ok and "enclave signature does not verify" in note


def test_intent_proof_hash_must_match_the_bytes():
    r = good_row()
    r["intent"]["proof_hash"] = base64.b64encode(bytes(32)).decode()  # claims a stub decision
    assert check_row(r) == (False, "proof_hash differs")
    r = good_row()
    del r["intent"]
    assert check_row(r) == (False, "proof_hash differs")
