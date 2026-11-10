//! NearBuddy arena.
//!
//! Model-backed agents (an ed25519 key plus a NEAR AI Cloud model id) post a bond and duel on live
//! prices. Spectators pay to inject chaos at one agent. Prices come from the Outlayer TEE price
//! oracle (`price-oracle.*`) through `oracle_call` / `oracle_on_call`: the open price is snapshotted
//! when the duel opens, and anyone may call `resolve_duel` after `close_at` to fetch the close price,
//! score both agents, slash the loser's bond into the pool and pay the pool to the winner. There is
//! no oracle key held by the operator.
//!
//! TEE-backed agents must attach a `TeeProof` to every intent: the NEAR AI Cloud enclave's ed25519
//! signature over `"{model_id}:{request_hash}:{response_hash}"`, verified here against a signer the
//! owner registered from an attestation report. The signed intent's `proof_hash` is
//! `sha256(request_hash || response_hash)`, which binds the agent's decision to that completion.
//!
//! Followers never hand an agent funds: they deposit here and attach a mandate (per-trade cap,
//! token allowlist, price floor, expiry, revoke); a registered solver fronts the swap through NEAR
//! Intents with this contract as recipient and is repaid from the follower's vault only inside that
//! mandate and only for output this contract's `intents.near` balance shows (see `follow.rs`).
//! Vault withdrawals wait `withdraw_delay_s`; credited output is withdrawn with `withdraw_token`.
//!
//! With `commit_reveal` on, an agent first commits `sha256(intent_message || salt)` before the
//! intent lock and reveals the intent and salt later (up to `close_at`), so nothing readable is on
//! chain until the reveal. An unrevealed commitment forfeits the duel and pays `no_reveal_bps` of
//! the bond to the opponent at scoring. `open_duel_consented` pairs two agents only with both agent keys' signatures.
//!
//! Keyless agents (`keyless.rs`, deploy 18) hold no key: the contract builds each request from
//! on-chain state (oracle prices, delivered headlines, a slot nonce), takes a completion only with a
//! pinned enclave's kind-2 signature over its own request hash, and parses the decision from the
//! revealed response bytes. Anyone may drive one (a keeper) with `open_slot`, `commit_completion`
//! and `reveal_completion`.
//!
//! Every state-growing call pays its own storage (`storage_byte_cost` x bytes added) out of the
//! value it brings: bond, chaos deposit, vault deposit, or the attached deposit.
mod agents;
mod chaos;
mod duels;
mod follow;
mod invariants;
mod keyless;
mod state;
mod types;
mod views;

pub use duels::Oracle;
pub use keyless::*;
pub use state::{Contract, ContractExt};
pub use types::*;

#[cfg(test)]
mod keyless_tests;
#[cfg(test)]
mod tests;

use near_sdk::{AccountId, env};

pub const INTENT_DOMAIN: &[u8] = b"nearbuddy-intent-v1";
/// Prefix of the bytes an agent key signs to prove possession at `register_agent`. v2 adds the
/// contract id (deploy 15); agents registered under v1 stay registered, only new registrations
/// sign v2.
pub const REGISTER_DOMAIN: &[u8] = b"nearbuddy-register-v2";
/// Prefix of the bytes an agent key signs to commit to a hidden intent (see `commit_bytes`).
pub const COMMIT_DOMAIN: &[u8] = b"nearbuddy-commit-v1";
/// Prefix of the v2 commit bytes, which also sign how many headlines the agent had seen (see
/// `commit_bytes_v2`, deploy 17.1). A distinct domain keeps a v1 signature from passing as v2.
pub const COMMIT_DOMAIN_V2: &[u8] = b"nearbuddy-commit-v2";
/// The newest commit message format `commit_intent` accepts (`commit_message_version` view).
pub const COMMIT_MESSAGE_VERSION: u32 = 2;
/// Prefix of the bytes an agent key signs to consent to one pairing (see `consent_bytes`).
pub const DUEL_DOMAIN: &[u8] = b"nearbuddy-duel-v1";
/// Cap on `Duel.injections` so a duel record cannot grow without bound.
pub const MAX_INJECTIONS: usize = 32;
/// After this long past `close_at` with no oracle answer anyone may void the duel.
pub const VOID_AFTER_NS: u64 = 24 * 3600 * 1_000_000_000;
/// Longest duel anyone can open. Without a cap, a consented duel with close_at near u64::MAX never
/// resolves or voids, keeps `open_duels` above zero forever and freezes every "duels open" admin setter.
pub const MAX_DUEL_NS: u64 = 24 * 3600 * 1_000_000_000;

pub fn intent_message(i: &Intent) -> Vec<u8> {
    let mut out = INTENT_DOMAIN.to_vec();
    out.extend(near_sdk::borsh::to_vec(i).expect("borsh"));
    out
}

/// The exact bytes `agent_pk` signs so `owner` may register it on `contract`:
/// `REGISTER_DOMAIN || contract || 0x00 || owner`. The separator keeps `(a.b, c)` and `(a, b.c)`
/// apart; account ids never contain a zero byte.
pub fn register_bytes(contract: &AccountId, owner: &AccountId) -> Vec<u8> {
    let mut out = REGISTER_DOMAIN.to_vec();
    out.extend_from_slice(contract.as_bytes());
    out.push(0);
    out.extend_from_slice(owner.as_bytes());
    out
}

/// The exact bytes `agent_pk` signs to commit in duel `duel_id`:
/// `COMMIT_DOMAIN || contract || duel_id_le || commitment`.
pub fn commit_bytes(contract: &AccountId, duel_id: u64, commitment: &[u8]) -> Vec<u8> {
    let mut out = COMMIT_DOMAIN.to_vec();
    out.extend_from_slice(contract.as_bytes());
    out.extend_from_slice(&duel_id.to_le_bytes());
    out.extend_from_slice(commitment);
    out
}

/// The exact bytes `agent_pk` signs to commit in duel `duel_id` having seen the first `seen`
/// records of `get_chaos(duel_id)`:
/// `COMMIT_DOMAIN_V2 || contract || duel_id_le || seen_le (u32) || commitment`.
pub fn commit_bytes_v2(
    contract: &AccountId,
    duel_id: u64,
    seen: u32,
    commitment: &[u8],
) -> Vec<u8> {
    let mut out = COMMIT_DOMAIN_V2.to_vec();
    out.extend_from_slice(contract.as_bytes());
    out.extend_from_slice(&duel_id.to_le_bytes());
    out.extend_from_slice(&seen.to_le_bytes());
    out.extend_from_slice(commitment);
    out
}

/// The exact bytes each agent signs to consent to one pairing:
/// `DUEL_DOMAIN || contract || a || b || symbol || close_at_le`. `close_at` makes the consent
/// single-use: once that duel opens it is in the past before either agent is free again.
pub fn consent_bytes(
    contract: &AccountId,
    a: &[u8],
    b: &[u8],
    symbol: &str,
    close_at: u64,
) -> Vec<u8> {
    let mut out = DUEL_DOMAIN.to_vec();
    out.extend_from_slice(contract.as_bytes());
    out.extend_from_slice(a);
    out.extend_from_slice(b);
    out.extend_from_slice(symbol.as_bytes());
    out.extend_from_slice(&close_at.to_le_bytes());
    out
}

/// `commitments` key: `duel_id_le || agent_pk`.
pub(crate) fn commit_key(duel_id: u64, pk: &[u8]) -> Vec<u8> {
    let mut k = duel_id.to_le_bytes().to_vec();
    k.extend_from_slice(pk);
    k
}

/// The exact bytes a NEAR AI Cloud enclave signs for one completion.
pub fn tee_text(kind: u8, model_id: &str, request_hash: &[u8], response_hash: &[u8]) -> Vec<u8> {
    let body = format!("{}:{}", hex(request_hash), hex(response_hash));
    match kind {
        1 => body.into_bytes(),
        _ => format!("{model_id}:{body}").into_bytes(),
    }
}

/// `Intent.proof_hash` for a TEE-proved decision.
pub fn proof_hash(request_hash: &[u8], response_hash: &[u8]) -> Vec<u8> {
    let mut m = request_hash.to_vec();
    m.extend_from_slice(response_hash);
    env::sha256(&m)
}

pub(crate) fn nonce_key(pk: &[u8], nonce: u64) -> Vec<u8> {
    let mut k = pk.to_vec();
    k.extend_from_slice(&nonce.to_le_bytes());
    k
}

pub(crate) fn verify(pk: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk), <[u8; 64]>::try_from(sig)) else {
        return false;
    };
    env::ed25519_verify(&sig, msg, &pk)
}

/// yoctoNEAR owed for the bytes added since `before`. Zero when storage shrank.
pub(crate) fn storage_cost_since(before: u64) -> u128 {
    let after = env::storage_usage();
    if after <= before {
        return 0;
    }
    (after - before) as u128 * env::storage_byte_cost().as_yoctonear()
}

/// yoctoNEAR for one `store::LookupSet<Vec<u8>>` entry: 1-byte prefix, 4-byte borsh length, the key
/// and the protocol's 40-byte per-record overhead. `LookupSet::insert` writes to storage at once, so
/// once the entry is inserted `storage_cost_since` already counts it; use this only to price an
/// entry before inserting it (`commit_intent`), never on top of a measurement taken after.
pub(crate) fn set_entry_cost(key_len: usize) -> u128 {
    (1 + 4 + key_len + 40) as u128 * env::storage_byte_cost().as_yoctonear()
}

pub(crate) fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
