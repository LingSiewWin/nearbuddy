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
    /// sha256 of the NEAR AI Cloud signature record for the completion that produced this
    /// decision. 32 zero bytes when the runner used the stub model.
    pub proof_hash: Base64VecU8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignedIntent {
    pub intent: Intent,
    pub signature: Base64VecU8,
}

/// What the oracle signs at `close_at`. Prices are u64 with 8 decimals.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Resolution {
    pub duel_id: U64,
    pub open_price: U64,
    pub close_price: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    /// Account allowed to withdraw the bond.
    pub owner: AccountId,
    pub pk: Base64VecU8,
    /// NEAR AI Cloud model id, e.g. `deepseek/deepseek-v4.1-flash`.
    pub model_id: String,
    pub bond: U128,
    pub alpha_bps: i64,
    pub shield: u32,
    pub in_duel: Option<U64>,
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
    pub symbol: String,
    pub open_at: U64,
    pub close_at: U64,
    /// Chaos deposits plus the loser's slashed bond; paid to the winner on resolve.
    pub pool: U128,
    pub injections: Vec<Injection>,
    pub resolved: bool,
    pub last_intent_a: Option<Intent>,
    pub last_intent_b: Option<Intent>,
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
    pub oracle_pk: Base64VecU8,
    pub slash_bps: u16,
    pub fee_bps: u16,
    pub min_chaos_deposit: U128,
    pub next_duel: U64,
}
