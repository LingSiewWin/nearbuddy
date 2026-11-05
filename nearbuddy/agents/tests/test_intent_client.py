import base64
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nacl.signing import SigningKey  # noqa: E402

from intent_client import INTENT_DOMAIN, ZERO_PROOF, intent_message, proof_hash, resolution_message, sign_intent  # noqa: E402
from nearai import StubClient  # noqa: E402
from prices import normalise  # noqa: E402

# Same fixture as packages/protocol/src/intent.test.ts and arena/src/tests.rs intent_message_len_matches_ts.
FIXTURE = {
    "agent_pk": base64.b64encode(bytes([1] * 32)).decode(), "duel_id": "7", "side": "Short", "size_bps": 5000,
    "nonce": "3", "expires_at": "1700000000000000000", "proof_hash": base64.b64encode(ZERO_PROOF).decode(),
}
# Printed by `cargo test intent_message_len_matches_ts -- --nocapture` (INTENT_HEX).
RUST_HEX = "6e65617262756464792d696e74656e742d76312000000001010101010101010101010101010101010101010101010101010101010101010700000000000000018813030000000000000000002a36fe9c9717200000000000000000000000000000000000000000000000000000000000000000000000"


def test_intent_bytes_match_rust_and_ts():
    m = intent_message(FIXTURE)
    assert m[: len(INTENT_DOMAIN)] == INTENT_DOMAIN
    assert len(m) == 19 + 36 + 8 + 1 + 2 + 8 + 8 + 36
    assert m.hex() == RUST_HEX


def test_resolution_bytes_len():
    assert len(resolution_message({"duel_id": "7", "open_price": "10000000000000", "close_price": "10050000000000"})) == 20 + 24


def test_sign_verify_roundtrip():
    sk = SigningKey(bytes([7] * 32))
    i = dict(FIXTURE, agent_pk=base64.b64encode(bytes(sk.verify_key)).decode())
    s = sign_intent(sk, i)
    sk.verify_key.verify(intent_message(i), base64.b64decode(s["signature"]))


def test_proof_hash():
    assert proof_hash(None) == base64.b64encode(bytes(32)).decode()
    rec = {"text": "t", "signature": "s", "signing_address": "a"}
    framed = b"\x01\x00\x00\x00t" + b"\x01\x00\x00\x00s" + b"\x01\x00\x00\x00a"
    assert proof_hash(rec) == base64.b64encode(hashlib.sha256(framed).digest()).decode()
    assert proof_hash({"text": "ab", "signature": "c", "signing_address": ""}) != proof_hash({"text": "a", "signature": "bc", "signing_address": ""})


def test_stub_is_deterministic():
    c = StubClient()
    assert c.complete("sys", "BTC last 100") == c.complete("sys", "BTC last 100")
    assert '"direction"' in c.complete("sys", "x")[0]


def test_normalise_pyth():
    assert normalise(10_050_000_000_000, -8) == 10_050_000_000_000
    assert normalise(1_005, -1) == 1_005 * 10**7
    assert normalise(123_456_789_012, -9) == 12_345_678_901


def test_price_retries_transient_errors(monkeypatch):
    import prices
    import requests as rq

    calls = {"n": 0}

    def flaky(symbol):
        calls["n"] += 1
        if calls["n"] < 3:
            raise rq.ConnectionError("dns")
        return 123

    monkeypatch.setattr(prices, "coinbase_price", flaky)
    monkeypatch.setattr(prices.time if hasattr(prices, "time") else __import__("time"), "sleep", lambda s: None)
    assert prices.price("BTC/USD") == 123
    assert calls["n"] == 3
