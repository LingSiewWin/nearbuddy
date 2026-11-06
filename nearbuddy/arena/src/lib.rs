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
//! token allowlist, expiry, revoke); a registered solver fronts the swap through NEAR Intents and
//! is repaid from the follower's vault only inside that mandate.
//!
//! Every state-growing call pays its own storage (`storage_byte_cost` x bytes added) out of the
//! value it brings: bond, chaos deposit, vault deposit, or the attached deposit.
mod agents;
mod duels;
mod follow;
mod state;
mod types;
mod views;

pub use duels::Oracle;
pub use state::{Contract, ContractExt};
pub use types::*;

#[cfg(test)]
mod tests;

use near_sdk::{AccountId, env};

pub const INTENT_DOMAIN: &[u8] = b"nearbuddy-intent-v1";
/// Prefix of the bytes an agent key signs to prove possession at `register_agent`.
pub const REGISTER_DOMAIN: &[u8] = b"nearbuddy-register-v1";
/// `intent_lock_ns` until the owner sets it through `set_oracle`.
pub const DEFAULT_INTENT_LOCK_NS: u64 = 60 * 1_000_000_000;
/// Cap on `Duel.injections` so a duel record cannot grow without bound.
pub const MAX_INJECTIONS: usize = 32;
/// After this long past `close_at` with no oracle answer anyone may void the duel.
pub const VOID_AFTER_NS: u64 = 24 * 3600 * 1_000_000_000;

pub fn intent_message(i: &Intent) -> Vec<u8> {
    let mut out = INTENT_DOMAIN.to_vec();
    out.extend(near_sdk::borsh::to_vec(i).expect("borsh"));
    out
}

/// The exact bytes `agent_pk` signs so `owner` may register it: `REGISTER_DOMAIN || owner`.
pub fn register_bytes(owner: &AccountId) -> Vec<u8> {
    let mut out = REGISTER_DOMAIN.to_vec();
    out.extend_from_slice(owner.as_bytes());
    out
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

/// Bytes a `store::LookupSet<Vec<u8>>` entry occupies once flushed at the end of the call: 1-byte
/// prefix, 4-byte borsh length, the key, and the protocol's 40-byte per-record overhead. `LookupSet`
/// writes lazily, so these bytes are not visible to `storage_usage()` inside the call and are charged
/// by size instead.
pub(crate) fn set_entry_cost(key_len: usize) -> u128 {
    (1 + 4 + key_len + 40) as u128 * env::storage_byte_cost().as_yoctonear()
}

pub(crate) fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
