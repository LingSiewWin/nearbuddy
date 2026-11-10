"""Sign arena intents exactly as the contract and packages/protocol/src/intent.ts do, and re-encode the
NEAR AI Cloud signature record into the `TeeProof` the contract verifies.

Bytes = DOMAIN || borsh(struct). Borsh here is hand-rolled (u32-length-prefixed byte vectors,
little-endian ints, enum as u8) so the agent needs no NEAR SDK: an agent is an ed25519 key.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import struct
import time
from dataclasses import dataclass
from typing import Any

import requests
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from keys import pk_b64  # noqa: F401  (moved to keys.py; re-exported for older imports)

INTENT_DOMAIN = b"nearbuddy-intent-v1"
COMMIT_DOMAIN = b"nearbuddy-commit-v1"
COMMIT_DOMAIN_V2 = b"nearbuddy-commit-v2"
CONSENT_DOMAIN = b"nearbuddy-duel-v1"
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


# The contract's JSON ingress is the reference (fixtures/wire-vectors.json "edges"): anything it refuses, the
# encoder refuses too, so an agent never signs bytes for a call the contract would read differently or reject.
_SIDE = {"Long": 0, "Short": 1}
_U64 = re.compile(r"\+?[0-9]+")


def _u64(v: Any) -> int:
    """near-sdk `U64`: a decimal string, optional '+', leading zeros allowed, at most 2^64 - 1."""
    if not isinstance(v, str) or not _U64.fullmatch(v) or int(v) >= 1 << 64:
        raise ValueError(f"bad u64: {v!r}")
    return int(v)


def _u16(v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 0xFFFF:
        raise ValueError(f"bad u16: {v!r}")
    return v


def b64decode_strict(s: Any) -> bytes:
    """near-sdk `Base64VecU8`: standard alphabet, padded, canonical (`AR==` is refused, `AQ==` is not)."""
    if not isinstance(s, str):
        raise ValueError(f"bad base64: {s!r}")
    b = base64.b64decode(s, validate=True)
    if base64.b64encode(b).decode() != s:
        raise ValueError(f"non-canonical base64: {s!r}")
    return b


def intent_message(i: dict[str, Any]) -> bytes:
    if i["side"] not in _SIDE:
        raise ValueError(f"bad side: {i['side']!r}")
    body = (
        _vec(b64decode_strict(i["agent_pk"]))
        + struct.pack("<Q", _u64(i["duel_id"]))
        + struct.pack("<B", _SIDE[i["side"]])
        + struct.pack("<H", _u16(i["size_bps"]))
        + struct.pack("<Q", _u64(i["nonce"]))
        + struct.pack("<Q", _u64(i["expires_at"]))
        + _vec(b64decode_strict(i["proof_hash"]))
    )
    return INTENT_DOMAIN + body


def sign_intent(sk: SigningKey, intent: dict[str, Any]) -> dict[str, Any]:
    sig = sk.sign(intent_message(intent)).signature
    return {"intent": intent, "signature": base64.b64encode(sig).decode()}


def commitment(intent: dict[str, Any], salt: bytes) -> bytes:
    """Commit-reveal: sha256(intent_message(intent) || salt), the 32 bytes `commit_intent` stores."""
    return hashlib.sha256(intent_message(intent) + salt).digest()


def commit_message(contract_id: str, duel_id: str | int, commitment: bytes) -> bytes:
    """Bytes the agent signs for `commit_intent`: domain || contract id || duel_id u64 LE || commitment."""
    return COMMIT_DOMAIN + contract_id.encode() + struct.pack("<Q", int(duel_id)) + commitment


def commit_message_v2(contract_id: str, duel_id: str | int, seen: int, commitment: bytes) -> bytes:
    """Bytes the agent signs for `commit_intent(.., seen)` (message v2, deploy 17.1):
    domain v2 || contract id || duel_id u64 LE || seen u32 LE || commitment. `seen` is how many
    `get_chaos(duel)` records the agent had read; a replacement that would hide a newer headline
    at it is refused with "unseen headline"."""
    return (
        COMMIT_DOMAIN_V2
        + contract_id.encode()
        + struct.pack("<Q", int(duel_id))
        + struct.pack("<I", int(seen))
        + commitment
    )


def consent_message(contract_id: str, a: str, b: str, symbol: str, close_at: str | int) -> bytes:
    """Bytes each agent signs for `open_duel_consented`: domain || contract id || a || b || symbol || close_at LE."""
    return (
        CONSENT_DOMAIN
        + contract_id.encode()
        + base64.b64decode(a)
        + base64.b64decode(b)
        + symbol.encode()
        + struct.pack("<Q", int(close_at))
    )


def sign_b64(sk: SigningKey, msg: bytes) -> str:
    return base64.b64encode(sk.sign(msg).signature).decode()


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


def _refused(e: requests.ConnectionError) -> bool:
    return "Connection refused" in str(e)


class DeadlineError(RuntimeError):
    """A solver call was not sent, or not waited for, because its deadline (close_at minus a margin) passed."""


@dataclass
class Solver:
    """`restart_wait_s`: night-loop.sh restarts the solver between its batches, and a second pair's duel can straddle
    that restart. A refused connection never reached the solver, so it is retried until the solver is back; any
    other transport error may have landed (an intent, an open_duel) and is raised as before."""

    url: str
    secret: str = ""
    restart_wait_s: float = 120

    def _send(self, method: str, url: str, cap: float | None = None, **kw: Any) -> requests.Response:
        """Retry a refused connection for `restart_wait_s`. `cap` (monotonic) bounds the retries and each attempt's
        timeout, so nothing waits past it."""
        retry_until = time.monotonic() + self.restart_wait_s
        if cap is not None:
            retry_until = min(retry_until, cap)
        while True:
            if cap is not None:
                kw["timeout"] = max(0.5, min(kw.get("timeout", 300.0), cap - time.monotonic()))
            try:
                return requests.request(method, url, **kw)
            except requests.ConnectionError as e:
                if not _refused(e) or time.monotonic() >= retry_until:
                    raise
                time.sleep(max(0.0, min(3.0, retry_until - time.monotonic())))

    def post(self, path: str, body: dict[str, Any], deadline_ns: int | None = None) -> dict[str, Any]:
        """`deadline_ns` (wall clock): neither the restart retry nor the wait for the answer runs past it, and a call
        whose deadline already passed is not sent (`DeadlineError`). A reveal passes close_at minus a margin."""
        cap = None
        if deadline_ns is not None:
            left = (deadline_ns - time.time_ns()) / 1e9
            if left <= 0:
                raise DeadlineError(f"solver {path}: deadline passed {-left:.1f} s ago, not sent")
            cap = time.monotonic() + left
        r = self._send(
            "POST",
            f"{self.url}{path}",
            cap,
            data=json.dumps(body),
            headers={"content-type": "application/json", "x-arena-key": self.secret},
            timeout=300,
        )
        if r.status_code != 200:
            raise RuntimeError(f"solver {path} {r.status_code}: {r.text[:300]}")
        return r.json()

    def get(self, path: str) -> dict[str, Any]:
        r = self._send("GET", f"{self.url}{path}", timeout=30)
        r.raise_for_status()
        return r.json()
