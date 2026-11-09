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

/// One injection as `Duel.injections` lists it. From deploy 17 `kind` is the `ChaosKind` name and
/// `payload_hash` is `sha256(headline)`, computed on chain; the full record is in `get_chaos`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Injection {
    pub kind: String,
    pub payload_hash: Base64VecU8,
    pub target: Base64VecU8,
    pub block: U64,
}

/// The side a planted headline's lie pushes the target toward, or `Placebo`: a neutral headline,
/// injected only by the contract owner as the control arm.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChaosKind {
    Long,
    Short,
    Placebo,
}

impl ChaosKind {
    pub fn direction(self) -> Option<Side> {
        match self {
            ChaosKind::Long => Some(Side::Long),
            ChaosKind::Short => Some(Side::Short),
            ChaosKind::Placebo => None,
        }
    }
}

/// How the runner must deliver the headline: `Cue` as written, `Clean` after the cue guard strips
/// its credibility cues, `Placebo` as written (a placebo carries no cues). The contract draws `Cue`
/// or `Clean` from the block's random seed; the injector does not choose.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Arm {
    Cue,
    Clean,
    Placebo,
}

/// What the target's first counting decision after the injection showed (see `Chaos`).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChaosOutcome {
    /// No counting decision after the injection yet.
    Pending,
    /// The decision before the injection was not on the lie's side and the next one is.
    Flipped,
    /// The decision before the injection was not on the lie's side and the next one is not either.
    Held,
    /// No trial: no known decision before the injection, the target already held the lie's side,
    /// or a placebo. Still records `prev` and `next`.
    NoTrial,
    /// The duel finished (or was voided) before a counting decision.
    Expired,
}

/// One planted headline (deploy 17). `Duel.injections[i]` and `get_chaos(duel)[i]` are the same
/// injection.
///
/// `prev` is the side of the target's last decision made at or before `at` (a decision's time is
/// its commit time when revealed, else its accept time), updated while the injection is pending.
/// The first decision made after `at` that is revealed from a commitment and carries a verified
/// provider-TEE proof (kind 2) decides the outcome, once; direct posts never decide, since their
/// side is readable before they land.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Chaos {
    pub injector: AccountId,
    pub target: Base64VecU8,
    /// UTF-8, 1..=280 bytes, no control or invisible format characters.
    pub headline: String,
    pub kind: ChaosKind,
    pub arm: Arm,
    /// Escrowed in the duel pool until it finishes. 0 when the contract owner (placebo) or the
    /// owner of either agent paid: that deposit went to `owner_fees` at injection.
    pub stake: U128,
    /// Block time of the injection (ns).
    pub at: U64,
    pub prev: Option<Side>,
    pub next: Option<Side>,
    /// Nonce of the revealed intent that decided the outcome.
    pub decided_by: Option<U64>,
    pub outcome: ChaosOutcome,
    /// Owed to `injector` once the duel finished: the stake back less the fee (no trial, expired or
    /// flipped) plus, for a flip at the duel's loser, a share the loser pays from its bond on
    /// top of its slash.
    pub payout: U128,
    pub claimed: bool,
}

/// Price and payout terms of `inject_chaos` (deploy 17). The `n`-th paid injection of a duel
/// (placebos not counted) needs a deposit of at least
/// `min(cap, max(min_chaos_deposit, base * (r_bps / 10_000)^n))`, rounded down at each step.
/// At finish `fee_bps` of every stake, whatever its outcome, goes to `owner_fees`. The loser pays
/// `share_bps` of its slash again, from its bond on top of the slash (bounded by the bond), split pro
/// rata by stake among the injections that flipped it; the winner keeps the whole slash.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChaosConfig {
    pub base: U128,
    pub r_bps: u16,
    pub cap: U128,
    pub fee_bps: u16,
    pub share_bps: u16,
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
    /// Chaos stakes, escrowed until the duel finishes and then settled per injection (see `Chaos`),
    /// plus the loser's slashed bond, paid whole to the winner.
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
    /// From deploy 16: the mandate plus the block time of the follow that opened the current
    /// following window. Fills for intents accepted before it are refused ("intent before follow").
    V3(Mandate, u64),
    /// From deploy 16.1, written by a re-follow inside the grace of the closed mandate:
    /// `(mandate, prev_start, gap_start, followed_at)`. The follower followed over
    /// `[prev_start, gap_start)` and again from `followed_at`. Intents in the first window stay
    /// settleable until `gap_start + grace`, like any closed mandate's; intents outside both windows
    /// are refused ("intent before follow").
    V4(Mandate, u64, u64, u64),
    /// From deploy 17, written by a follow that tightens a term while earlier intents can still
    /// settle: the `V4` windows plus the previous terms (see `MandateRecord`). A record without
    /// previous terms is still written as `V2` / `V3` / `V4`, so a loosening update adds no bytes.
    V5(MandateRecord),
}

/// A `V5` record: the mandate, its follow windows and the terms before its last tightening update.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct MandateRecord {
    pub current: Mandate,
    pub windows: FollowWindows,
    pub prev: PrevTerms,
}

/// `V4`'s follow windows: the follower followed over `[prev_start, gap_start)` and again from
/// `followed_at`. A `V3` record's are `(0, 0, followed_at)` and a `V2` one's `(0, 0, 0)`, so
/// `gap_start > 0` means there is a closed window.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FollowWindows {
    pub prev_start: u64,
    pub gap_start: u64,
    pub followed_at: u64,
}

/// The terms in force before the last tightening update. They bind fills for intents accepted
/// before `updated_at` at most until `binds_until` (`updated_at + withdraw_delay_s` as set at the
/// update), then those fills are refused. `binds_until` caps the old terms only: the follow
/// windows (`covers`, `refollowed`) still use the live withdraw delay, like the revoke and expiry
/// graces, so a later `set_withdraw_delay` can close a window, or let a re-follow drop `prev`,
/// before `binds_until`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PrevTerms {
    /// `spent` here is the snapshot at the update and is never read: the pair's one ledger is the
    /// current mandate's `spent`.
    pub terms: Mandate,
    pub updated_at: U64,
    pub binds_until: U64,
}

impl Mandate {
    /// Whether `self` binds a fill no tighter than `old` on every term: allowance, cap and expiry
    /// at least as high, price floor at most as high, and `allowed_tokens` empty (any token) or,
    /// with `old` restricted too, a superset of `old`'s. A restricted set replacing an empty one is
    /// tighter. `spent` and the revoke stamps are not terms.
    pub fn no_tighter_than(&self, old: &Mandate) -> bool {
        self.allowance.0 >= old.allowance.0
            && self.per_tx_cap.0 >= old.per_tx_cap.0
            && self.min_out_per_near.0 <= old.min_out_per_near.0
            && self.expires_at.0 >= old.expires_at.0
            && (self.allowed_tokens.is_empty()
                || (!old.allowed_tokens.is_empty()
                    && old
                        .allowed_tokens
                        .iter()
                        .all(|t| self.allowed_tokens.contains(t))))
    }
}

impl VersionedMandate {
    pub fn current(&self) -> &Mandate {
        match self {
            VersionedMandate::V2(m)
            | VersionedMandate::V3(m, _)
            | VersionedMandate::V4(m, _, _, _) => m,
            VersionedMandate::V5(r) => &r.current,
        }
    }
    pub fn current_mut(&mut self) -> &mut Mandate {
        match self {
            VersionedMandate::V2(m)
            | VersionedMandate::V3(m, _)
            | VersionedMandate::V4(m, _, _, _) => m,
            VersionedMandate::V5(r) => &mut r.current,
        }
    }
    /// The follow windows in `MandateRecord`'s encoding.
    fn windows(&self) -> FollowWindows {
        let w = |prev_start, gap_start, followed_at| FollowWindows {
            prev_start,
            gap_start,
            followed_at,
        };
        match self {
            VersionedMandate::V2(_) => w(0, 0, 0),
            VersionedMandate::V3(_, f) => w(0, 0, *f),
            VersionedMandate::V4(_, s, g, f) => w(*s, *g, *f),
            VersionedMandate::V5(r) => r.windows,
        }
    }
    /// Start of the current following window; `None` for a mandate stored before deploy 16.
    pub fn followed_at(&self) -> Option<u64> {
        match self {
            VersionedMandate::V2(_) => None,
            VersionedMandate::V5(r) if r.windows.followed_at == 0 => None,
            _ => Some(self.windows().followed_at),
        }
    }
    /// The terms before the last tightening update, if any.
    pub fn prev(&self) -> Option<&PrevTerms> {
        match self {
            VersionedMandate::V5(r) => Some(&r.prev),
            _ => None,
        }
    }

    /// The smallest variant that holds these fields: `V5` only with previous terms.
    fn pack(current: Mandate, w: FollowWindows, prev: Option<PrevTerms>) -> VersionedMandate {
        use VersionedMandate::*;
        match (prev, w.prev_start, w.gap_start, w.followed_at) {
            (Some(prev), ..) => V5(MandateRecord {
                current,
                windows: w,
                prev,
            }),
            (None, 0, 0, 0) => V2(current),
            (None, 0, 0, f) => V3(current, f),
            (None, s, g, f) => V4(current, s, g, f),
        }
    }

    /// When this mandate stopped covering new intents, as of `now`: its revoke, else its expiry
    /// once passed. `None` while it is live.
    fn closed_at(&self, now: u64) -> Option<u64> {
        let m = self.current();
        if m.revoked {
            Some(m.revoked_at.0)
        } else {
            (now >= m.expires_at.0).then_some(m.expires_at.0)
        }
    }

    /// The record `follow` stores when the follower sends `m` over this one at `now`.
    /// - Still live: the window keeps its start, so fronted fills keep their window.
    /// - Closed (revoke or expiry) less than `grace` ago: a `V4` window, so intents of the closed
    ///   window keep their grace and only the gap `[closed, now)` is refused.
    /// - Closed longer ago: `V3(m, now)`; every earlier intent is past its grace anyway.
    ///
    /// The window closes no earlier than the last update: an expiry it moved into the past binds
    /// only intents accepted after it.
    ///
    /// Two windows fit in a record, so a re-follow while an older window is still in its grace
    /// panics "refollow too soon"; it succeeds once that grace (at most `grace`) has passed.
    ///
    /// Terms: an `m` no tighter than the stored mandate on every term only replaces it. A tighter
    /// `m` keeps the stored mandate as `prev` with `U = now` and `binds_until = U + grace`, so
    /// intents accepted before `U` are judged by the terms in force when they were accepted until
    /// then (see `terms_at`). One previous version fits, so a tightening before the last one's
    /// `binds_until` panics "update too soon". The version it replaces no longer binds, so the
    /// windows then start no earlier than that version's `U`: its intents stay refused instead of
    /// meeting newer terms.
    pub fn refollowed(&self, m: Mandate, now: u64, grace: u64) -> VersionedMandate {
        let w = self.windows();
        let mut windows = match self.closed_at(now) {
            None => w,
            Some(closed) => {
                // an update binds only intents accepted from its `updated_at` on, so an expiry it
                // backdated does not close the window before it: the previous terms covered every
                // earlier intent until then
                let closed = closed.max(self.prev().map_or(0, |p| p.updated_at.0));
                if w.gap_start > 0 {
                    near_sdk::require!(
                        now >= w.gap_start.saturating_add(grace),
                        "refollow too soon"
                    );
                }
                if now >= closed.saturating_add(grace) {
                    return VersionedMandate::V3(m, now);
                }
                FollowWindows {
                    prev_start: w.followed_at,
                    gap_start: closed,
                    followed_at: now,
                }
            }
        };
        let mut prev = self.prev().cloned();
        if !m.no_tighter_than(self.current()) {
            if let Some(p) = &prev {
                near_sdk::require!(now >= p.binds_until.0, "update too soon");
                // `prev_start` matters only with a closed window (`gap_start > 0`); a live record's
                // `[0, 0)` window is empty either way
                let u = p.updated_at.0;
                windows.prev_start = windows.prev_start.max(u);
                windows.followed_at = windows.followed_at.max(u);
            }
            prev = Some(PrevTerms {
                terms: self.current().clone(),
                updated_at: U64(now),
                binds_until: U64(now.saturating_add(grace)),
            });
        }
        Self::pack(m, windows, prev)
    }

    /// Whether a fill for an intent accepted at `at` may settle against this record's follow
    /// windows at `now` (the mandate's own revoke and expiry are checked separately).
    pub fn covers(&self, at: u64, now: u64, grace: u64) -> bool {
        let w = self.windows();
        at >= w.followed_at
            || (at >= w.prev_start && at < w.gap_start && now < w.gap_start.saturating_add(grace))
    }

    /// The terms that bind a fill for an intent accepted at `at`: the ones before the last
    /// tightening update when the intent predates it (a pre-16 intent, `at = 0`, always does),
    /// and only until their `binds_until` ("mandate updated"); else the current mandate.
    pub fn terms_at(&self, at: u64, now: u64) -> Result<&Mandate, &'static str> {
        match self.prev() {
            // like the revoke and expiry graces, a pause does not stop this clock. `binds_until`
            // caps the old terms; `covers` checks the window with the live withdraw delay first
            // (see `PrevTerms`)
            Some(p) if at < p.updated_at.0 => {
                if now < p.binds_until.0 {
                    Ok(&p.terms)
                } else {
                    Err("mandate updated")
                }
            }
            _ => Ok(self.current()),
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
    /// `inject_chaos` price and payout terms (deploy 17).
    pub chaos: ChaosConfig,
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
