"""Agent identity: an agent is an ed25519 key. Keys come from the env file (`AGENT_KEY_*` raw seed from a
builder, or `AGENT_SEED_*` for the demo agents) and prove possession at registration."""

from __future__ import annotations

import base64
import hashlib

from nacl.signing import SigningKey

from config import ENV

REGISTER_DOMAIN = b"nearbuddy-register-v1"


def pk_b64(sk: SigningKey) -> str:
    return base64.b64encode(bytes(sk.verify_key)).decode()


def agent_key(name: str, tee: bool, tag: str = "") -> SigningKey:
    """`AGENT_KEY_*` is a raw seed handed over by a builder; otherwise demo keys come straight from AGENT_SEED_*;
    TEE-backed duelists use a key derived from the same seed, so the plain demo agents and the enclave-proved
    agents are distinct registrations on chain. `tag` derives one more key per seed (the swapped-prompt control
    registers the other model under it)."""
    key = ENV.get(f"AGENT_KEY_{name}", "")
    if key:  # an outside builder's agent (from `bun run join`): the hex is the ed25519 seed itself, no derivation
        return SigningKey(bytes.fromhex(key))
    seed = ENV.get(f"AGENT_SEED_{name}", "")
    if not seed:
        return SigningKey.generate()
    raw = bytes.fromhex(seed)
    if not tee and not tag:
        return SigningKey(raw)
    return SigningKey(hashlib.sha256(raw + (b"tee" if tee else b"") + tag.encode()).digest())


def register_sig(sk: SigningKey, owner: str) -> str:
    """Proof of key possession for `register_agent`: ed25519 over `"nearbuddy-register-v1" || owner`."""
    return base64.b64encode(sk.sign(REGISTER_DOMAIN + owner.encode()).signature).decode()
