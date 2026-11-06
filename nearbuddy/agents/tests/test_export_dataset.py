"""`export_dataset.check_row` recomputes every hash a dataset row claims; each failure mode has its own note."""

import base64
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nacl.signing import SigningKey  # noqa: E402

from export_dataset import check_row  # noqa: E402
from intent_client import proof_hash  # noqa: E402

ENCLAVE = SigningKey(bytes([11] * 32))
MODEL = "test/model-z"
REQ_BODY = '{"model":"test/model-z","messages":[{"role":"user","content":"NEAR/USD last 3.66"}]}'
RES_BODY = '{"id":"chatcmpl-9","choices":[{"message":{"content":"{\\"direction\\":\\"long\\"}"}}]}'


def good_row() -> dict:
    req = hashlib.sha256(REQ_BODY.encode()).digest()
    res = hashlib.sha256(RES_BODY.encode()).digest()
    text = f"{MODEL}:{req.hex()}:{res.hex()}"
    return {
        "model": MODEL,
        "request_body": REQ_BODY,
        "response_body": RES_BODY,
        "request_hash": req.hex(),
        "response_hash": res.hex(),
        "signature_record": {
            "text": text,
            "signature": ENCLAVE.sign(text.encode()).signature.hex(),
            "signing_address": bytes(ENCLAVE.verify_key).hex(),
            "signing_algo": "ed25519",
            "signature_kind": "provider_tee",
        },
        "intent": {"proof_hash": proof_hash(req, res)},
    }


def test_row_with_matching_bytes_signature_and_proof_is_verifiable():
    assert check_row(good_row()) == (True, "ok")


def test_tampered_response_bytes_no_longer_match_the_stored_hash():
    r = good_row()
    r["response_body"] = r["response_body"].replace("long", "short")
    assert check_row(r) == (False, "stored hash differs from bytes")


def test_missing_signature_record_is_reported_not_verified():
    r = good_row()
    del r["signature_record"]
    assert check_row(r) == (False, "no signature record")
    r["signature_record"] = None
    assert check_row(r) == (False, "no signature record")


def test_stub_rows_without_bytes_are_not_verifiable():
    assert check_row({"model": "stub/deterministic", "intent": {"proof_hash": proof_hash(None)}}) == (
        False,
        "no tee bytes",
    )


def test_forged_enclave_signature_is_named_in_the_note():
    r = good_row()
    r["signature_record"]["signing_address"] = bytes(SigningKey(bytes([12] * 32)).verify_key).hex()
    ok, note = check_row(r)
    assert not ok and note.startswith("enclave record: TeeProofError")


def test_intent_committing_to_another_completion_is_rejected():
    r = good_row()
    r["intent"]["proof_hash"] = base64.b64encode(bytes(32)).decode()
    assert check_row(r) == (False, "proof_hash differs")
