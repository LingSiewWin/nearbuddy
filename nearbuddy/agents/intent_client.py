"""Sign arena intents exactly as the contract and packages/protocol/src/intent.ts do, and re-encode the
NEAR AI Cloud signature record into the `TeeProof` the contract verifies.

Bytes = DOMAIN || borsh(struct). Borsh here is hand-rolled (u32-length-prefixed byte vectors,
little-endian ints, enum as u8) so the agent needs no NEAR SDK: an agent is an ed25519 key.
"""

from __future__ import annotations

import base64
import hashlib
import json
import struct
from dataclasses import dataclass
from typing import Any

import requests
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

INTENT_DOMAIN = b"nearbuddy-intent-v1"
ZERO_PROOF = bytes(32)
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
TEE_KIND = {"gateway": 1, "provider_tee": 2}


def b58decode(s: str) -> bytes:
    n = 0
    for ch in s:
        n = n * 58 + _B58.index(ch)
    out = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + out


def key_from_near_secret(secret: str) -> SigningKey:
    """`ed25519:<base58 64 bytes>` (near-cli / near-api-js format) -> SigningKey."""
    assert secret.startswith("ed25519:"), "expected ed25519:<base58>"
    raw = b58decode(secret.split(":", 1)[1])
    assert len(raw) == 64, f"expected 64-byte secret, got {len(raw)}"
    return SigningKey(raw[:32])


def _vec(b: bytes) -> bytes:
    return struct.pack("<I", len(b)) + b


def intent_message(i: dict[str, Any]) -> bytes:
    side = 0 if i["side"] == "Long" else 1
    body = (
        _vec(base64.b64decode(i["agent_pk"]))
        + struct.pack("<Q", int(i["duel_id"]))
        + struct.pack("<B", side)
        + struct.pack("<H", int(i["size_bps"]))
        + struct.pack("<Q", int(i["nonce"]))
        + struct.pack("<Q", int(i["expires_at"]))
        + _vec(base64.b64decode(i["proof_hash"]))
    )
    return INTENT_DOMAIN + body


def sign_intent(sk: SigningKey, intent: dict[str, Any]) -> dict[str, Any]:
    sig = sk.sign(intent_message(intent)).signature
    return {"intent": intent, "signature": base64.b64encode(sig).decode()}


def proof_hash(request_hash: bytes | None, response_hash: bytes | None = None) -> str:
    """`Intent.proof_hash`: sha256(request_hash || response_hash) of the enclave-signed completion;
    32 zero bytes when the decision had no TEE (stub model)."""
    if not request_hash or not response_hash:
        return base64.b64encode(ZERO_PROOF).decode()
    return base64.b64encode(hashlib.sha256(request_hash + response_hash).digest()).decode()


def tee_text(kind: int, model_id: str, request_hash: bytes, response_hash: bytes) -> bytes:
    """The exact bytes the enclave signs (`text` in the signature record)."""
    body = f"{request_hash.hex()}:{response_hash.hex()}"
    return (body if kind == 1 else f"{model_id}:{body}").encode()


class TeeProofError(RuntimeError):
    """The signature record does not verify against the bytes we sent and received."""


def tee_proof(record: dict[str, Any], model_id: str, request_hash: bytes, response_hash: bytes) -> dict[str, Any]:
    """Re-encode a `GET /v1/signature/{chat_id}?signing_algo=ed25519` record as the contract's `TeeProof`,
    after checking locally that the enclave really signed our request and response hashes."""
    kind = TEE_KIND.get(record.get("signature_kind", "provider_tee"))
    if kind is None:
        raise TeeProofError(f"unknown signature_kind {record.get('signature_kind')!r}")
    if record.get("signing_algo", "ed25519") != "ed25519":
        raise TeeProofError("need signing_algo=ed25519")
    text = tee_text(kind, model_id, request_hash, response_hash)
    if record.get("text") != text.decode():
        raise TeeProofError(f"record text {record.get('text')!r} does not match our bytes {text.decode()!r}")
    signer = bytes.fromhex(record["signing_address"].removeprefix("0x"))
    signature = bytes.fromhex(record["signature"].removeprefix("0x"))
    try:
        VerifyKey(signer).verify(text, signature)
    except BadSignatureError as exc:
        raise TeeProofError("enclave signature does not verify") from exc
    return {
        "kind": kind,
        "request_hash": base64.b64encode(request_hash).decode(),
        "response_hash": base64.b64encode(response_hash).decode(),
        "signer": base64.b64encode(signer).decode(),
        "signature": base64.b64encode(signature).decode(),
    }


@dataclass
class Solver:
    url: str
    secret: str = ""

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        r = requests.post(
            f"{self.url}{path}",
            data=json.dumps(body),
            headers={"content-type": "application/json", "x-arena-key": self.secret},
            timeout=300,
        )
        if r.status_code != 200:
            raise RuntimeError(f"solver {path} {r.status_code}: {r.text[:300]}")
        return r.json()

    def get(self, path: str) -> dict[str, Any]:
        r = requests.get(f"{self.url}{path}", timeout=30)
        r.raise_for_status()
        return r.json()
