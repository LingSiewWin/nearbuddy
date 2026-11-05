"""Sign arena intents and resolutions exactly as the contract and packages/protocol/src/intent.ts do.

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
from nacl.signing import SigningKey

INTENT_DOMAIN = b"nearbuddy-intent-v1"
RESOLVE_DOMAIN = b"nearbuddy-resolve-v1"
ZERO_PROOF = bytes(32)
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


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


def pk_b64(sk: SigningKey) -> str:
    return base64.b64encode(bytes(sk.verify_key)).decode()


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


def resolution_message(r: dict[str, Any]) -> bytes:
    return RESOLVE_DOMAIN + struct.pack("<QQQ", int(r["duel_id"]), int(r["open_price"]), int(r["close_price"]))


def sign_intent(sk: SigningKey, intent: dict[str, Any]) -> dict[str, Any]:
    sig = sk.sign(intent_message(intent)).signature
    return {"intent": intent, "signature": base64.b64encode(sig).decode()}


def sign_resolution(sk: SigningKey, resolution: dict[str, Any]) -> str:
    return base64.b64encode(sk.sign(resolution_message(resolution)).signature).decode()


def proof_hash(record: dict[str, Any] | None) -> str:
    """sha256 over the NEAR AI Cloud signature record (text, signature, signing_address); zeros when stubbed."""
    if not record:
        return base64.b64encode(ZERO_PROOF).decode()
    h = hashlib.sha256()
    for k in ("text", "signature", "signing_address"):
        h.update(str(record.get(k, "")).encode())
    return base64.b64encode(h.digest()).decode()


@dataclass
class Solver:
    url: str

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        r = requests.post(f"{self.url}{path}", data=json.dumps(body), headers={"content-type": "application/json"}, timeout=180)
        if r.status_code != 200:
            raise RuntimeError(f"solver {path} {r.status_code}: {r.text[:300]}")
        return r.json()

    def get(self, path: str) -> dict[str, Any]:
        r = requests.get(f"{self.url}{path}", timeout=30)
        r.raise_for_status()
        return r.json()
