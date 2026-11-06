//! Wire types. Every struct here is byte-identical (borsh) to `packages/protocol/src/intent.ts`.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::{AccountId, near};

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
/// `per_tx_cap` and `allowance` bound the whole debit of a fill, fee included.
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
    /// Price floor: a fill needs `amount_out * 10^24 >= amount_in * min_out_per_near`, i.e. at
    /// least this many output units per NEAR in. `follow` refuses 0; mandates migrated from deploy 14
    /// carry 0 (no floor) until the follower follows again.
    #[serde(default)]
    pub min_out_per_near: U128,
    /// When `unfollow` revoked the mandate (unix ns), 0 while active. Fills the solver fronted before
    /// the revocation stay settleable for `withdraw_delay_s` after it. Set by the contract; ignored
    /// on input.
    #[serde(default)]
    pub revoked_at: U64,
}

/// What `follows` stores: a versioned `Mandate`, so a later layout can be read and upgraded record by
/// record (the per-pair map cannot be iterated for a bulk migration). Add `V3`, read old versions
/// through `current` / `current_mut`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub enum VersionedMandate {
    V2(Mandate),
}

impl VersionedMandate {
    pub fn current(&self) -> &Mandate {
        match self {
            VersionedMandate::V2(m) => m,
        }
    }
    pub fn current_mut(&mut self) -> &mut Mandate {
        match self {
            VersionedMandate::V2(m) => m,
        }
    }
}

/// `Mandate` as stored up to deploy 14 (no price floor). Read once by `migrate_follows`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct MandateV1 {
    pub allowance: U128,
    pub spent: U128,
    pub per_tx_cap: U128,
    pub allowed_tokens: Vec<String>,
    pub expires_at: U64,
    pub revoked: bool,
}

impl From<MandateV1> for Mandate {
    fn from(m: MandateV1) -> Self {
        Mandate {
            allowance: m.allowance,
            spent: m.spent,
            per_tx_cap: m.per_tx_cap,
            allowed_tokens: m.allowed_tokens,
            expires_at: m.expires_at,
            revoked: m.revoked,
            min_out_per_near: U128(0),
            revoked_at: U64(0),
        }
    }
}

/// One swap the solver fronted for a follower. The output must already sit in the arena's own
/// `intents.near` balance: `settle_follow` credits it only against that balance.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Fill {
    pub intent_nonce: U64,
    /// The `intents.near` token id the output landed in, e.g. `nep141:usdc.near`.
    pub token: String,
    /// Amount debited from the follower's vault (mandate units, yoctoNEAR here), before the fee.
    pub amount_in: U128,
    /// Output credited to the follower's holding; must be covered by unaccounted balance.
    pub amount_out: U128,
    /// Audit string only (tx hash). Empty, over 128 bytes, or `dry-quote:*` is refused.
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
    /// Floor on `close_at - now`; 310 on testnet (the oracle serves a cached price for 300 s).
    pub min_duel_s: u64,
    /// No intent lands in the last `intent_lock_s` of a duel (see `set_oracle`).
    pub intent_lock_s: u64,
    pub slash_bps: u16,
    pub fee_bps: u16,
    pub min_chaos_deposit: U128,
    pub next_duel: U64,
    /// Duels opened and not yet finished or voided (counted from deploy 12 on); while non-zero,
    /// `set_oracle` may not lower the lock or move the oracle.
    pub open_duels: u64,
    pub owner_fees: U128,
    /// `post_intent` refused; intents go through `commit_intent` / `reveal_intent`.
    pub commit_reveal: bool,
    /// Bond share an unrevealed commitment pays the opponent at scoring, on top of forfeiting.
    pub no_reveal_bps: u16,
    /// `open_duel` refused; pairing only through `open_duel_consented`.
    pub require_consent: bool,
    /// Where fill outputs land and `settle_follow` reads balances (`intents.near` on mainnet).
    pub intents_account: AccountId,
    /// `withdraw` pays a `request_withdraw` only this long after it.
    pub withdraw_delay_s: u64,
    /// New activity refused; every exit path stays open (see `set_paused`).
    pub paused: bool,
    /// `deposit` refused once `vault_total` would pass this.
    pub max_vault_total: U128,
    /// `deposit` refused once the caller's own vault would pass this (deploy 16).
    pub max_vault_per_account: U128,
    /// Sum of all vaults (exact for accounting from deploy 16 on; see `reconcile_vault_total`).
    pub vault_total: U128,
    /// `follows` is being re-keyed by `migrate_follows`; follow and settle are refused meanwhile.
    pub migrating: bool,
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
