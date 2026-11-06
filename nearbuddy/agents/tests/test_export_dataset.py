"""`export_dataset.check_row` recomputes every hash a dataset row claims; each failure mode has its own note."""

import base64
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
import yaml  # noqa: E402
from nacl.signing import SigningKey  # noqa: E402

from export_dataset import FIELDS, card, check_row, write_parquet  # noqa: E402
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


# Hub card, built from the tracked snapshot so the YAML, the schema table and the snippet are checked on real rows.
SNAPSHOT = Path(__file__).resolve().parents[2] / "dataset" / "decisions.jsonl"
ROWS = [json.loads(line) for line in SNAPSHOT.read_text().splitlines() if line.strip()]
CARD = card(ROWS, "decisions.parquet")


def test_card_front_matter_is_hub_yaml():
    head = yaml.safe_load(CARD.split("---\n")[1])
    assert head["license"] == "cc-by-4.0"
    assert head["size_categories"] == ["1K<n<10K"]
    assert {"pretty_name", "task_categories", "tags", "language"} <= head.keys()
    assert head["configs"] == [
        {"config_name": "default", "data_files": [{"split": "decisions", "path": "decisions.parquet"}]}
    ]


def test_every_row_key_is_in_the_schema_table():
    documented = set(re.findall(r"^\| `(\w+)` \|", CARD, re.M)) & {name for name, _, _ in FIELDS}
    seen = {k for r in ROWS for k in r}
    assert seen <= documented, f"undocumented: {sorted(seen - documented)}"


def card_verify():
    snippet = next(b for b in re.findall(r"```python\n(.*?)```", CARD, re.S) if "def verify" in b)
    scope: dict = {}
    exec(snippet, scope)  # the card's own snippet, run as a reader would
    return scope["verify"]


def test_card_snippet_verifies_a_real_row_and_agrees_with_check_row():
    verify = card_verify()
    assert verify(next(r for r in ROWS if r["verifiable"])) == "ok"
    for r in ROWS:
        assert (verify(r) == "ok") == check_row(r)[0], r["duel_id"]


def test_card_snippet_rejects_a_tampered_real_row():
    r = json.loads(json.dumps(next(r for r in ROWS if r["verifiable"])))
    r["response_body"] = r["response_body"].replace("long", "short").replace("Long", "Short")
    assert card_verify()(r) == "stored hash differs from bytes"


def test_parquet_columns_are_the_union_of_row_keys(tmp_path):
    pq = pytest.importorskip("pyarrow.parquet")
    rows = [{"duel_id": "1", "intent": {"side": "Long"}}, {"duel_id": "2", "error": "duel closed"}]
    assert write_parquet(rows, tmp_path / "d.parquet")
    assert pq.read_table(tmp_path / "d.parquet").to_pylist() == [
        {"duel_id": "1", "intent": {"side": "Long"}, "error": None},
        {"duel_id": "2", "intent": None, "error": "duel closed"},
    ]
