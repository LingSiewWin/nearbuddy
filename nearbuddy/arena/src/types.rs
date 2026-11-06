//! Wire types. Every struct here is byte-identical (borsh) to `packages/protocol/src/intent.ts`.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::{near, AccountId};

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Long,
    Short,
}

/// What an agent signs: one directional call inside one duel.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Intent {
    /// 32-byte ed25519 public key of the agent.
    pub agent_pk: Base64VecU8,
    pub duel_id: U64,
    pub side: Side,
    /// Position size in basis points of the agent's notional, 1..=10_000.
    pub size_bps: u16,
    pub nonce: U64,
    /// Unix ns. Only intents with `expires_at >= duel.close_at` are scored.
    pub expires_at: U64,
    /// `sha256(request_hash || response_hash)` of the NEAR AI Cloud completion that produced this
    /// decision (see `TeeProof`). 32 zero bytes when the agent is not TEE-backed.
    pub proof_hash: Base64VecU8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignedIntent {
    pub intent: Intent,
    pub signature: Base64VecU8,
}

/// The NEAR AI Cloud signature record for one completion, as returned by
/// `GET /v1/signature/{chat_id}?signing_algo=ed25519`. The TEE signs the raw text
/// `"{model_id}:{request_hash_hex}:{response_hash_hex}"` (kind 2, `provider_tee`, the model's own
/// enclave) or `"{request_hash_hex}:{response_hash_hex}"` (kind 1, `gateway`, the cloud-api enclave).
/// The contract rebuilds that text from the agent's `model_id` and the two hashes and verifies the
/// ed25519 signature against a signer the owner registered from an attestation report.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct TeeProof {
    /// 1 = gateway TEE, 2 = provider (model) TEE.
    pub kind: u8,
    /// sha256 of the exact request body bytes.
    pub request_hash: Base64VecU8,
    /// sha256 of the exact response body bytes.
    pub response_hash: Base64VecU8,
    /// 32-byte ed25519 `signing_address` of the TEE.
    pub signer: Base64VecU8,
    /// 64-byte ed25519 signature over the text.
    pub signature: Base64VecU8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    /// Account allowed to withdraw the bond.
    pub owner: AccountId,
    pub pk: Base64VecU8,
    /// NEAR AI Cloud model id, e.g. `deepseek-ai/DeepSeek-V4.1-Flash-1017`. Must equal the model id
    /// the TEE puts in its signed text.
    pub model_id: String,
    pub bond: U128,
    pub alpha_bps: i64,
    pub shield: u32,
    pub in_duel: Option<U64>,
}

/// `Agent` plus whether every intent must carry a verified TEE proof.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AgentView {
    pub owner: AccountId,
    pub pk: Base64VecU8,
    pub model_id: String,
    pub bond: U128,
    pub alpha_bps: i64,
    pub shield: u32,
    pub in_duel: Option<U64>,
    pub tee: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Injection {
    pub kind: String,
    pub payload_hash: Base64VecU8,
    pub target: Base64VecU8,
    pub block: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Duel {
    pub id: U64,
    pub a: Base64VecU8,
    pub b: Base64VecU8,
    /// Oracle asset id, e.g. `wrap.near` (NEAR/USD).
    pub symbol: String,
    pub open_at: U64,
    pub close_at: U64,
    /// Chaos deposits plus the loser's slashed bond; paid to the winner on resolve.
    pub pool: U128,
    /// Cleared when the duel finishes; the count survives in `Outcome.injections`.
    pub injections: Vec<Injection>,
    pub resolved: bool,
    pub last_intent_a: Option<Intent>,
    pub last_intent_b: Option<Intent>,
    /// Filled by the oracle callback: scored pnl per side and the slashed amount, so a page can
    /// show the outcome without parsing logs.
    pub outcome: Option<Outcome>,
    /// Oracle price (u64, 8 dp) snapshotted by the oracle callback right after `open_duel`.
    pub open_price: Option<U64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Outcome {
    pub open_price: U64,
    pub close_price: U64,
    pub pnl_a: i64,
    pub pnl_b: i64,
    /// `Some(a)` / `Some(b)` pk of the winner, `None` on a tie.
    pub winner: Option<Base64VecU8>,
    pub slashed: U128,
    /// Injections the duel carried (pruned from `Duel.injections` to free storage).
    pub injections: u32,
}

/// A follower's bound on what the solver may settle against their vault for one agent.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Mandate {
    pub allowance: U128,
    pub spent: U128,
    pub per_tx_cap: U128,
    /// Empty = any token.
    pub allowed_tokens: Vec<String>,
    pub expires_at: U64,
    pub revoked: bool,
}

/// One executed swap the solver fronted for a follower.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Fill {
    pub intent_nonce: U64,
    pub token: String,
    /// Amount debited from the follower's vault (mandate units, yoctoNEAR here).
    pub amount_in: U128,
    pub amount_out: U128,
    pub swap_tx: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SettleReport {
    pub settled: u32,
    pub debited: U128,
    pub rejected: Vec<(u32, String)>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner: AccountId,
    /// Outlayer price oracle (`price-oracle.testnet` / `price-oracle.near`).
    pub oracle_account: AccountId,
    /// Attached to every `oracle_call`; the oracle refunds what the TEE fetch did not cost.
    pub oracle_deposit: U128,
    /// Floor on `close_at - now`; 330 on testnet (oracle cache 300 s).
    pub min_duel_s: u64,
    pub slash_bps: u16,
    pub fee_bps: u16,
    pub min_chaos_deposit: U128,
    pub next_duel: U64,
    pub owner_fees: U128,
}

// ---------------------------------------------------------------- Outlayer price oracle wire types

/// `oracle_on_call` payload from `price-oracle.*` (https://price-oracle.outlayer.ai/docs/).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PriceData {
    /// Unix ns.
    pub timestamp: U64,
    pub recency_duration_sec: u32,
    pub prices: Vec<AssetOptionalPrice>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AssetOptionalPrice {
    pub asset_id: String,
    pub price: Option<OraclePrice>,
}

/// USD = multiplier / 10^decimals.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OraclePrice {
    pub multiplier: U128,
    pub decimals: u8,
}

// ---------------------------------------------------------------- old layouts, read only by migrations

/// `Duel` before `outcome` (deploys 1-4).
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct DuelV1 {
    pub id: U64,
    pub a: Base64VecU8,
    pub b: Base64VecU8,
    pub symbol: String,
    pub open_at: U64,
    pub close_at: U64,
    pub pool: U128,
    pub injections: Vec<Injection>,
    pub resolved: bool,
    pub last_intent_a: Option<Intent>,
    pub last_intent_b: Option<Intent>,
}

/// `Duel` with `outcome` but before `open_price` and `Outcome.injections` (deploys 5-6).
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct DuelV2 {
    pub id: U64,
    pub a: Base64VecU8,
    pub b: Base64VecU8,
    pub symbol: String,
    pub open_at: U64,
    pub close_at: U64,
    pub pool: U128,
    pub injections: Vec<Injection>,
    pub resolved: bool,
    pub last_intent_a: Option<Intent>,
    pub last_intent_b: Option<Intent>,
    pub outcome: Option<OutcomeV2>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct OutcomeV2 {
    pub open_price: U64,
    pub close_price: U64,
    pub pnl_a: i64,
    pub pnl_b: i64,
    pub winner: Option<Base64VecU8>,
    pub slashed: U128,
}
