"""Shared wire vectors: arena/src/tests.rs and packages/protocol/src/wire-vectors.test.ts read the same file."""

import base64
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from nacl.signing import SigningKey, VerifyKey  # noqa: E402

from intent_client import (  # noqa: E402
    commit_message,
    commitment,
    consent_message,
    intent_message,
    proof_hash,
    sign_intent,
    tee_text,
)
from prices import brief  # noqa: E402

W = json.loads((Path(__file__).resolve().parents[2] / "fixtures" / "wire-vectors.json").read_text())
EDGES = W["edges"]


@pytest.mark.parametrize("edge", EDGES["reject"], ids=[e["name"] for e in EDGES["reject"]])
def test_edge_rejected_like_the_contract(edge):
    with pytest.raises(ValueError):
        intent_message({**W["intent"], **edge["patch"]})


@pytest.mark.parametrize("edge", EDGES["same"], ids=[e["name"] for e in EDGES["same"]])
def test_edge_encodes_like_the_contract(edge):
    assert intent_message({**W["intent"], **edge["patch"]}).hex() == W["intent_hex"]


def test_brief_move_format():
    for move, text in W["move_format"]["cases"]:
        assert f"{move:+.1f}" == text
    for open8, spot8, text in W["move_format"]["briefs"]:
        assert f"Move since duel open: {text} bps." in brief("NEAR/USD", spot8, open8)


def test_intent_bytes():
    assert intent_message(W["intent"]).hex() == W["intent_hex"]


def test_commitment_and_commit_message():
    salt = bytes.fromhex(W["commit"]["salt_hex"])
    c = commitment(W["intent"], salt)
    assert c.hex() == W["commit"]["commitment_hex"]
    assert c == hashlib.sha256(bytes.fromhex(W["intent_hex"]) + salt).digest()
    assert commit_message(W["contract"], W["commit"]["duel_id"], c).hex() == W["commit"]["message_hex"]


def test_consent_message():
    k = W["consent"]
    assert consent_message(W["contract"], k["a"], k["b"], k["symbol"], k["close_at"]).hex() == k["message_hex"]


def test_tee_text_and_proof_hash():
    t = W["tee"]
    req, res = bytes.fromhex(t["request_hash_hex"]), bytes.fromhex(t["response_hash_hex"])
    assert tee_text(1, t["model"], req, res).decode() == t["text_kind1"]
    assert tee_text(2, t["model"], req, res).decode() == t["text_kind2"]
    assert base64.b64decode(proof_hash(req, res)).hex() == t["proof_hash_hex"]


def test_signature():
    s = W["signed"]
    sk = SigningKey(bytes.fromhex(s["seed_hex"]))
    assert base64.b64encode(bytes(sk.verify_key)).decode() == s["intent"]["agent_pk"]
    m = intent_message(s["intent"])
    assert m.hex() == s["message_hex"]
    sig = base64.b64decode(sign_intent(sk, s["intent"])["signature"])
    assert sig.hex() == s["signature_hex"]
    VerifyKey(bytes(sk.verify_key)).verify(m, sig)
