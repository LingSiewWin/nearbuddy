import base64
import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nacl.exceptions import BadSignatureError  # noqa: E402
from nacl.signing import SigningKey  # noqa: E402

from intent_client import (  # noqa: E402
    INTENT_DOMAIN,
    ZERO_PROOF,
    TeeProofError,
    commit_message,
    commitment,
    consent_message,
    intent_message,
    proof_hash,
    sign_intent,
    tee_proof,
    tee_text,
)
from nearai import StubClient  # noqa: E402
from prices import normalise  # noqa: E402

# Same fixture as packages/protocol/src/intent.test.ts and arena/src/tests.rs intent_message_len_matches_ts.
FIXTURE = {
    "agent_pk": base64.b64encode(bytes([1] * 32)).decode(),
    "duel_id": "7",
    "side": "Short",
    "size_bps": 5000,
    "nonce": "3",
    "expires_at": "1700000000000000000",
    "proof_hash": base64.b64encode(ZERO_PROOF).decode(),
}
# Printed by `cargo test intent_message_len_matches_ts -- --nocapture` (INTENT_HEX).
RUST_HEX = "6e65617262756464792d696e74656e742d76312000000001010101010101010101010101010101010101010101010101010101010101010700000000000000018813030000000000000000002a36fe9c9717200000000000000000000000000000000000000000000000000000000000000000000000"  # noqa: E501

# Real record from NEAR AI Cloud, 2026-11-06 (deepseek-ai/DeepSeek-V4.1-Flash-1017, provider_tee, ed25519).
REAL_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017"
REAL_REQ = bytes.fromhex("eddd4548b2b35d65de9b8617c6632b09d487606c74c02fbab9bac1ee349901e3")
REAL_RES = bytes.fromhex("c4f9c6e53487a744f1687c06d00d09735e7f2a8c4215a019f97150ff6c2dc09f")
REAL_RECORD = {
    "text": f"{REAL_MODEL}:{REAL_REQ.hex()}:{REAL_RES.hex()}",
    "signature": "3b24456ee898ba8e684c10e7ad373d42e88d9c26ce4cf1a47187f2112dd66eac"
    "6aea43f8df942829c3836b3cedc1119ad7efc48c3d12b29056129a366fbe620b",
    "signing_address": "236f5a6b91dd47dc3b7b36e43d4eb531a042ffb8f8fbf3a1555b78cef4fdda4c",
    "signing_algo": "ed25519",
    "signature_kind": "provider_tee",
}


def test_intent_bytes_match_rust_and_ts():
    m = intent_message(FIXTURE)
    assert m[: len(INTENT_DOMAIN)] == INTENT_DOMAIN
    assert len(m) == 19 + 36 + 8 + 1 + 2 + 8 + 8 + 36
    assert m.hex() == RUST_HEX


# Same vectors as packages/protocol/src/intent.test.ts (COMMITMENT_HEX, COMMIT_MSG_HEX, CONSENT_MSG_HEX).
CONTRACT = "arena.nearbuddy-solver.testnet"
SALT = bytes([2] * 32)
COMMITMENT_HEX = "77b102ffbab3f871bf96bf1306405e68db6968a26d3814d27146cbd641cb25d8"
COMMIT_MSG_HEX = (
    "6e65617262756464792d636f6d6d69742d76316172656e612e6e65617262756464792d736f6c7665722e746573746e6574"
    "070000000000000077b102ffbab3f871bf96bf1306405e68db6968a26d3814d27146cbd641cb25d8"
)
CONSENT_MSG_HEX = (
    "6e65617262756464792d6475656c2d76316172656e612e6e65617262756464792d736f6c7665722e746573746e6574"
    "0101010101010101010101010101010101010101010101010101010101010101"
    "0303030303030303030303030303030303030303030303030303030303030303"
    "777261702e6e65617200002a36fe9c9717"
)


def test_commit_and_consent_bytes_match_ts():
    c = commitment(FIXTURE, SALT)
    assert c.hex() == COMMITMENT_HEX
    assert c == hashlib.sha256(bytes.fromhex(RUST_HEX) + SALT).digest()
    assert commit_message(CONTRACT, "7", c).hex() == COMMIT_MSG_HEX
    assert commit_message(CONTRACT, 7, c) == commit_message(CONTRACT, "7", c)
    pk_a, pk_b = base64.b64encode(bytes([1] * 32)).decode(), base64.b64encode(bytes([3] * 32)).decode()
    assert consent_message(CONTRACT, pk_a, pk_b, "wrap.near", "1700000000000000000").hex() == CONSENT_MSG_HEX
    assert consent_message(CONTRACT, pk_b, pk_a, "wrap.near", "1700000000000000000").hex() != CONSENT_MSG_HEX


def test_sign_verify_roundtrip():
    sk = SigningKey(bytes([7] * 32))
    i = dict(FIXTURE, agent_pk=base64.b64encode(bytes(sk.verify_key)).decode())
    s = sign_intent(sk, i)
    sk.verify_key.verify(intent_message(i), base64.b64decode(s["signature"]))


def test_proof_hash():
    assert proof_hash(None) == base64.b64encode(bytes(32)).decode()
    assert proof_hash(REAL_REQ, REAL_RES) == base64.b64encode(hashlib.sha256(REAL_REQ + REAL_RES).digest()).decode()
    assert proof_hash(REAL_REQ, REAL_RES) != proof_hash(REAL_RES, REAL_REQ)


def test_proof_hash_is_zero_unless_both_hashes_are_present():
    zero = base64.b64encode(ZERO_PROOF).decode()
    assert proof_hash(REAL_REQ) == zero  # response missing
    assert proof_hash(REAL_REQ, None) == zero
    assert proof_hash(None, REAL_RES) == zero  # request missing
    assert proof_hash(b"", REAL_RES) == zero and proof_hash(REAL_REQ, b"") == zero  # empty bytes count as missing
    assert len(base64.b64decode(proof_hash(REAL_REQ, REAL_RES))) == 32


def test_tee_text_formats():
    assert tee_text(2, REAL_MODEL, REAL_REQ, REAL_RES) == REAL_RECORD["text"].encode()
    assert tee_text(1, "ignored", REAL_REQ, REAL_RES) == f"{REAL_REQ.hex()}:{REAL_RES.hex()}".encode()


def test_tee_text_only_the_gateway_kind_drops_the_model():
    body = f"{REAL_REQ.hex()}:{REAL_RES.hex()}"
    assert tee_text(1, REAL_MODEL, REAL_REQ, REAL_RES) == body.encode()
    for kind in (0, 2, 3):  # anything but kind 1 is bound to the model id
        assert tee_text(kind, REAL_MODEL, REAL_REQ, REAL_RES) == f"{REAL_MODEL}:{body}".encode(), kind
    assert tee_text(2, "a/b", REAL_REQ, REAL_RES) != tee_text(2, "a/c", REAL_REQ, REAL_RES)
    assert tee_text(2, REAL_MODEL, REAL_REQ, REAL_RES) != tee_text(2, REAL_MODEL, REAL_RES, REAL_REQ)
    assert len(tee_text(1, "", bytes(32), bytes(32))) == 64 + 1 + 64  # hex is lowercase, no 0x prefix
    assert tee_text(1, "", bytes(32), bytes(32)).decode().islower() is False  # all zeros: no letters at all
    assert tee_text(2, "M", bytes([255]) * 32, bytes(32)).decode().startswith("M:" + "ff" * 32 + ":")


def test_real_enclave_record_verifies_and_reencodes():
    p = tee_proof(REAL_RECORD, REAL_MODEL, REAL_REQ, REAL_RES)
    assert p["kind"] == 2
    assert base64.b64decode(p["signer"]) == bytes.fromhex(REAL_RECORD["signing_address"])
    assert len(base64.b64decode(p["signature"])) == 64
    assert base64.b64decode(p["request_hash"]) == REAL_REQ


def test_tee_proof_rejects_tamper_and_wrong_model():
    bad = REAL_RES[:-1] + bytes([REAL_RES[-1] ^ 1])
    with pytest.raises(TeeProofError):
        tee_proof(REAL_RECORD, REAL_MODEL, REAL_REQ, bad)  # our bytes differ from what the enclave signed
    with pytest.raises(TeeProofError):
        tee_proof(REAL_RECORD, "Qwen/Qwen3.8-27B", REAL_REQ, REAL_RES)
    forged = dict(REAL_RECORD, text=f"{REAL_MODEL}:{REAL_REQ.hex()}:{bad.hex()}")
    with pytest.raises(TeeProofError):
        tee_proof(forged, REAL_MODEL, REAL_REQ, bad)  # text matches our bytes but the signature does not
    with pytest.raises(TeeProofError):
        tee_proof(dict(REAL_RECORD, signing_algo="ecdsa"), REAL_MODEL, REAL_REQ, REAL_RES)


def test_stub_is_deterministic():
    c = StubClient()
    assert c.complete("sys", "BTC last 100").text == c.complete("sys", "BTC last 100").text
    assert '"direction"' in c.complete("sys", "x").text
    assert c.complete("sys", "x").chat_id is None and not c.tee


def test_normalise_pyth():
    assert normalise(10_050_000_000_000, -8) == 10_050_000_000_000
    assert normalise(1_005, -1) == 1_005 * 10**7
    assert normalise(123_456_789_012, -9) == 12_345_678_901


def test_price_retries_transient_errors(monkeypatch):
    import requests as rq

    import prices

    calls = {"n": 0}

    def flaky(symbol):
        calls["n"] += 1
        if calls["n"] < 3:
            raise rq.ConnectionError("dns")
        return 123

    monkeypatch.setattr(prices, "coinbase_price", flaky)
    import time

    monkeypatch.setattr(time, "sleep", lambda s: None)
    assert prices.price("NEAR/USD") == 123
    assert calls["n"] == 3


def test_agent_key_uses_a_raw_builder_key(monkeypatch):
    from config import ENV
    from keys import agent_key

    seed = bytes([9] * 32)
    monkeypatch.setitem(ENV, "AGENT_KEY_B", seed.hex())
    monkeypatch.setitem(ENV, "AGENT_SEED_B", bytes([1] * 32).hex())
    assert bytes(agent_key("B", True)) == seed  # raw seed wins, no sha256(seed||"tee") derivation
    monkeypatch.delitem(ENV, "AGENT_KEY_B")
    assert bytes(agent_key("B", True)) != seed


def test_register_sig_covers_domain_and_owner():
    from keys import register_sig

    sk = SigningKey(bytes([3] * 32))
    sig = base64.b64decode(register_sig(sk, "someone.testnet"))
    sk.verify_key.verify(b"nearbuddy-register-v1" + b"someone.testnet", sig)
    with pytest.raises(BadSignatureError):
        sk.verify_key.verify(b"nearbuddy-register-v1" + b"other.testnet", sig)
