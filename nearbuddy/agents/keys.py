"""Agent identity: an agent is an ed25519 key. Keys come from the env file (`AGENT_KEY_*` raw seed from a
builder, or `AGENT_SEED_*` for the demo agents) and prove possession at registration."""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Callable
from typing import Any

from nacl.signing import SigningKey

from config import ENV

REGISTER_DOMAIN = b"nearbuddy-register-v1"  # deploy 14 and before; deploy 15 signs v2 with the contract id


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


def key_tag(pair_tag: str, swap: bool) -> str:
    """The `agent_key` tag of a pair: "" or "swap" for the main pair (its keys never change), "pair:<tag>:" plus the
    same suffix for a tagged pair. The prefix keeps every tagged pair apart from the main pair and from each other."""
    return (f"pair:{pair_tag}:" if pair_tag else "") + ("swap" if swap else "")


def register_message(owner: str, view: Callable[[str, dict[str, Any]], Any] | None = None) -> bytes:
    """The exact bytes the deployed contract verifies for `register_agent` by `owner`, from its `register_message`
    view (v1 `domain || owner` up to deploy 14, v2 `domain || contract || 0x00 || owner` from deploy 15). When the
    view cannot be read, the v1 bytes: a deploy-15 contract then refuses the registration, it never misreads it."""
    if view is None:
        from chain import view as chain_view

        view = chain_view
    try:
        return base64.b64decode(view("register_message", {"owner": owner}))
    except Exception:  # noqa: BLE001 - any RPC failure falls back to the deploy-14 bytes
        return REGISTER_DOMAIN + owner.encode()


def register_sig(sk: SigningKey, owner: str, view: Callable[[str, dict[str, Any]], Any] | None = None) -> str:
    """Proof of key possession for `register_agent`: ed25519 over `register_message(owner)`."""
    return base64.b64encode(sk.sign(register_message(owner, view)).signature).decode()
