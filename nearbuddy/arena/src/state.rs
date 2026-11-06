//! Contract state, storage prefixes, `init`, the live migration and owner config.
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, assert_one_yocto, env, near,
    require,
};

use crate::{Agent, Duel, MandateV1, VersionedMandate, follow::follow_key};

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
pub(crate) enum StorageKey {
    Agents,
    Duels,
    UsedNonces,
    Solvers,
    Vaults,
    Follows,
    SettledFills,
    TeeSigners,
    TeeAgents,
    UsedProofs,
    AgentDuels,
    Commitments,
    NoReveal,
    UsedCommitments,
    FollowsByPair,
    Holdings,
    Accounted,
    PendingWithdrawals,
    DuelLocks,
    Sweeping,
}

/// Default `withdraw_delay_ns`: twice a generous settle lag. `set_withdraw_delay` changes it.
pub const DEFAULT_WITHDRAW_DELAY_NS: u64 = 900 * 1_000_000_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) owner: AccountId,
    pub(crate) oracle_account: AccountId,
    pub(crate) oracle_deposit: u128,
    pub(crate) slash_bps: u16,
    pub(crate) fee_bps: u16,
    pub(crate) min_chaos_deposit: u128,
    /// Keyed by the 32-byte agent public key.
    pub(crate) agents: IterableMap<Vec<u8>, Agent>,
    pub(crate) duels: LookupMap<u64, Duel>,
    pub(crate) next_duel: u64,
    /// `agent_pk || nonce_le` of every accepted intent.
    pub(crate) used_nonces: LookupSet<Vec<u8>>,
    pub(crate) solvers: LookupSet<AccountId>,
    /// Follower vault balances, yoctoNEAR.
    pub(crate) vaults: LookupMap<AccountId, u128>,
    /// Deploy-14 followers per agent, drained into `follows` by `migrate_follows` and empty after.
    pub(crate) follows_v1: LookupMap<Vec<u8>, Vec<(AccountId, MandateV1)>>,
    /// `agent_pk || follower || nonce_le` of every settled fill (see `fill_key`).
    pub(crate) settled_fills: LookupSet<Vec<u8>>,
    pub(crate) owner_fees: u128,
    /// ed25519 signing addresses of NEAR AI Cloud enclaves, from attestation reports.
    pub(crate) tee_signers: LookupSet<Vec<u8>>,
    /// Agents that committed to TEE-proved decisions at registration.
    pub(crate) tee_agents: LookupSet<Vec<u8>>,
    /// `proof_hash` of every accepted TEE-proved intent: one enclave completion backs one intent.
    pub(crate) used_proofs: LookupSet<Vec<u8>>,
    /// `close_at - now` floor for `open_duel`. Outlayer serves a cached price for `recency_duration_sec`
    /// (300 s on testnet) with a fresh timestamp, so a shorter duel would close on its own open price.
    pub(crate) min_duel_ns: u64,
    /// Duel ids per agent, oldest first, appended by `open_duel`. Only duels opened from deploy 10
    /// on are here (the deploy-10 migration did not back-fill). ponytail: one Vec per agent, read and
    /// rewritten whole on every open_duel; a `Vector` per agent when an agent has more duels than
    /// fit in one read.
    pub(crate) agent_duels: LookupMap<Vec<u8>, Vec<u64>>,
    /// No intent lands in the last `intent_lock_ns` before `close_at`, so the final decision is made
    /// before the close price is knowable. Bounded to `min_duel_ns / 2` by `set_oracle`. Each duel
    /// keeps the value it was opened under (`duel_locks`).
    pub(crate) intent_lock_ns: u64,
    /// Duels opened and not yet finished or voided. While it is non-zero `set_oracle` may not lower
    /// the lock or move the oracle, so a running duel keeps the rules it was opened under. Starts
    /// at 0 in `migrate_v12` (deploy 12): duels open across that deploy were not counted.
    pub(crate) open_duels: u64,
    /// When true `post_intent` is refused: every intent goes through `commit_intent` before the
    /// lock and `reveal_intent` after it. When false both paths work.
    pub(crate) commit_reveal: bool,
    /// Share of the bond an agent pays its opponent (or `owner_fees`) at scoring for leaving a
    /// commitment unrevealed, on top of forfeiting the duel. Starts equal to `slash_bps`.
    pub(crate) no_reveal_bps: u16,
    /// When true the owner's `open_duel` is refused and only `open_duel_consented` pairs agents.
    pub(crate) require_consent: bool,
    /// `duel_id_le || agent_pk` (see `commit_key`) to `(sha256(intent_message || salt),
    /// committed_at_ns)`. Deleted on reveal, on scoring (slashed) and on void.
    pub(crate) commitments: LookupMap<Vec<u8>, ([u8; 32], u64)>,
    /// Duel id to (a, b) unrevealed-commitment flags; written only when one of them is true.
    pub(crate) no_reveal: LookupMap<u64, (bool, bool)>,
    /// `commit_key || commitment` of every accepted commitment. The commit signature carries no
    /// nonce, so without this anyone could resubmit an old signed commitment after its reveal (or
    /// over a newer one) and get the agent slashed for not revealing it. ponytail: entries of
    /// finished duels are dead weight, paid from the bond like `used_nonces`.
    pub(crate) used_commitments: LookupSet<Vec<u8>>,
    /// `agent_pk || follower` (see `follow_key`) to the follower's mandate for that agent.
    pub(crate) follows: LookupMap<Vec<u8>, VersionedMandate>,
    /// Next `agents` index `migrate_follows` drains; `None` once `follows_v1` is empty.
    pub(crate) follows_cursor: Option<u32>,
    /// `intents.near` (mainnet) or the intents stub (testnet): fill outputs land in this
    /// contract's balance there, and `settle_follow` reads it. Fixed at deploy; moving it would
    /// orphan holdings.
    pub(crate) intents_account: AccountId,
    /// `"{follower}:{token_id}"` to the output credited to that follower and not yet withdrawn.
    pub(crate) holdings: LookupMap<String, u128>,
    /// Per token id, the part of this contract's `intents_account` balance already credited to a
    /// holding. A fill is accepted only against balance above it.
    pub(crate) accounted: LookupMap<String, u128>,
    /// Bumped each time a token withdrawal confirms; a settle whose balance view was taken before
    /// the bump is rejected, so a stale (higher) balance never counts as a receipt.
    pub(crate) outflow_seq: u64,
    /// Follower to `(amount, ready_at_ns)` of their one queued vault withdrawal.
    pub(crate) pending_withdrawals: LookupMap<AccountId, (u128, u64)>,
    pub(crate) withdraw_delay_ns: u64,
    /// Kill switch: new duels, intents, chaos, registrations, deposits, follows and settles are
    /// refused. Withdrawals, unfollow, reveal, resolve and void stay open.
    pub(crate) paused: bool,
    /// `deposit` is refused once `vault_total` would exceed this.
    pub(crate) max_vault_total: u128,
    /// NEAR deposited minus NEAR withdrawn through vaults, from deploy 15 on (vaults funded before
    /// it are not counted; withdrawals saturate at 0).
    pub(crate) vault_total: u128,
    /// Duel id to the intent lock it was opened under. Duels opened before deploy 15 have no entry
    /// and use `intent_lock_ns`.
    pub(crate) duel_locks: LookupMap<u64, u64>,
    /// Per token id, surplus `sweep_surplus` has approved and not yet seen confirmed: settles treat it
    /// as spent, so a fill can never be credited from balance that is on its way out.
    pub(crate) sweeping: LookupMap<String, u128>,
}

/// State layout of deploy 14 (commit-reveal, before verified settlement). Read once by
/// `migrate_v15`.
#[allow(dead_code)]
#[derive(near_sdk::borsh::BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct ContractV14 {
    owner: AccountId,
    oracle_account: AccountId,
    oracle_deposit: u128,
    slash_bps: u16,
    fee_bps: u16,
    min_chaos_deposit: u128,
    agents: IterableMap<Vec<u8>, Agent>,
    duels: LookupMap<u64, Duel>,
    next_duel: u64,
    used_nonces: LookupSet<Vec<u8>>,
    solvers: LookupSet<AccountId>,
    vaults: LookupMap<AccountId, u128>,
    follows: LookupMap<Vec<u8>, Vec<(AccountId, MandateV1)>>,
    settled_fills: LookupSet<Vec<u8>>,
    owner_fees: u128,
    tee_signers: LookupSet<Vec<u8>>,
    tee_agents: LookupSet<Vec<u8>>,
    used_proofs: LookupSet<Vec<u8>>,
    min_duel_ns: u64,
    agent_duels: LookupMap<Vec<u8>, Vec<u64>>,
    intent_lock_ns: u64,
    open_duels: u64,
    commit_reveal: bool,
    no_reveal_bps: u16,
    require_consent: bool,
    commitments: LookupMap<Vec<u8>, ([u8; 32], u64)>,
    no_reveal: LookupMap<u64, (bool, bool)>,
    used_commitments: LookupSet<Vec<u8>>,
}

/// Seconds to ns with a sanity bound (a week), so a unit mix-up cannot set an absurd floor.
pub(crate) fn duel_floor_ns(min_duel_s: u64) -> u64 {
    require!(min_duel_s <= 7 * 24 * 3600, "min_duel_s too large");
    min_duel_s * 1_000_000_000
}

impl Contract {
    pub(crate) fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "not owner");
    }

    /// Owner, with exactly one yoctoNEAR attached (a function-call access key cannot attach it).
    pub(crate) fn only_owner_yocto(&self) {
        assert_one_yocto();
        self.only_owner();
    }

    pub(crate) fn only_solver(&self) {
        require!(
            self.solvers.contains(&env::predecessor_account_id()),
            "not solver"
        );
    }

    pub(crate) fn not_paused(&self) {
        require!(!self.paused, "paused");
    }

    pub(crate) fn not_migrating(&self) {
        require!(self.follows_cursor.is_none(), "migrating");
    }
}

#[near]
impl Contract {
    /// `owner` runs duels (the solver account in the hackathon deploy). `oracle_account` is the
    /// Outlayer price oracle; `oracle_deposit` is attached to each price request. `slash_bps` of the
    /// loser's bond moves to the pool. `fee_bps` is charged on every settled fill, inside the
    /// follower's caps, and accrues to the owner. `intents_account` is where fill outputs land
    /// (`intents.near`, or the stub on testnet). `max_vault_total` caps all vault deposits. The
    /// intent lock starts at 0 and the duel floor at 0, so `lock <= floor / 2` holds until
    /// `set_oracle` sets both.
    /// Caller: deployer, once. Deposit: none. Panics: "bps out of range".
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn init(
        owner: AccountId,
        oracle_account: AccountId,
        oracle_deposit: U128,
        slash_bps: u16,
        fee_bps: u16,
        min_chaos_deposit: U128,
        intents_account: AccountId,
        max_vault_total: U128,
    ) -> Self {
        require!(slash_bps <= 10_000 && fee_bps <= 1_000, "bps out of range");
        Self {
            owner,
            oracle_account,
            oracle_deposit: oracle_deposit.0,
            slash_bps,
            fee_bps,
            min_chaos_deposit: min_chaos_deposit.0,
            agents: IterableMap::new(StorageKey::Agents),
            duels: LookupMap::new(StorageKey::Duels),
            next_duel: 0,
            used_nonces: LookupSet::new(StorageKey::UsedNonces),
            solvers: LookupSet::new(StorageKey::Solvers),
            vaults: LookupMap::new(StorageKey::Vaults),
            follows_v1: LookupMap::new(StorageKey::Follows),
            settled_fills: LookupSet::new(StorageKey::SettledFills),
            owner_fees: 0,
            tee_signers: LookupSet::new(StorageKey::TeeSigners),
            tee_agents: LookupSet::new(StorageKey::TeeAgents),
            used_proofs: LookupSet::new(StorageKey::UsedProofs),
            min_duel_ns: 0,
            agent_duels: LookupMap::new(StorageKey::AgentDuels),
            intent_lock_ns: 0,
            open_duels: 0,
            commit_reveal: false,
            no_reveal_bps: slash_bps,
            require_consent: false,
            commitments: LookupMap::new(StorageKey::Commitments),
            no_reveal: LookupMap::new(StorageKey::NoReveal),
            used_commitments: LookupSet::new(StorageKey::UsedCommitments),
            follows: LookupMap::new(StorageKey::FollowsByPair),
            follows_cursor: None,
            intents_account,
            holdings: LookupMap::new(StorageKey::Holdings),
            accounted: LookupMap::new(StorageKey::Accounted),
            outflow_seq: 0,
            pending_withdrawals: LookupMap::new(StorageKey::PendingWithdrawals),
            withdraw_delay_ns: DEFAULT_WITHDRAW_DELAY_NS,
            paused: false,
            max_vault_total: max_vault_total.0,
            vault_total: 0,
            duel_locks: LookupMap::new(StorageKey::DuelLocks),
            sweeping: LookupMap::new(StorageKey::Sweeping),
        }
    }

    // ---------------------------------------------------------------- migration

    /// Deploy 14 → 15: verified settlement against `intents_account`, follower holdings, delayed
    /// withdraw (900 s), pause (off), vault cap, per-duel lock, and `follows` re-keyed per pair.
    /// The old per-agent follower lists stay under their prefix as `follows_v1` and are moved by
    /// `migrate_follows`; follow and settle are refused until that finishes.
    /// Caller: the contract itself (private), once after the deploy-15 code lands. Deposit:
    /// none. Panics: "no state", or the SDK private-method panic for any other caller.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v15(intents_account: AccountId, max_vault_total: U128) -> Self {
        let old: ContractV14 = env::state_read().expect("no state");
        Self {
            owner: old.owner,
            oracle_account: old.oracle_account,
            oracle_deposit: old.oracle_deposit,
            slash_bps: old.slash_bps,
            fee_bps: old.fee_bps,
            min_chaos_deposit: old.min_chaos_deposit,
            agents: old.agents,
            duels: old.duels,
            next_duel: old.next_duel,
            used_nonces: old.used_nonces,
            solvers: old.solvers,
            vaults: old.vaults,
            follows_v1: old.follows,
            settled_fills: old.settled_fills,
            owner_fees: old.owner_fees,
            tee_signers: old.tee_signers,
            tee_agents: old.tee_agents,
            used_proofs: old.used_proofs,
            min_duel_ns: old.min_duel_ns,
            agent_duels: old.agent_duels,
            intent_lock_ns: old.intent_lock_ns,
            open_duels: old.open_duels,
            commit_reveal: old.commit_reveal,
            no_reveal_bps: old.no_reveal_bps,
            require_consent: old.require_consent,
            commitments: old.commitments,
            no_reveal: old.no_reveal,
            used_commitments: old.used_commitments,
            follows: LookupMap::new(StorageKey::FollowsByPair),
            follows_cursor: Some(0),
            intents_account,
            holdings: LookupMap::new(StorageKey::Holdings),
            accounted: LookupMap::new(StorageKey::Accounted),
            outflow_seq: 0,
            pending_withdrawals: LookupMap::new(StorageKey::PendingWithdrawals),
            withdraw_delay_ns: DEFAULT_WITHDRAW_DELAY_NS,
            paused: false,
            max_vault_total: max_vault_total.0,
            vault_total: 0,
            duel_locks: LookupMap::new(StorageKey::DuelLocks),
            sweeping: LookupMap::new(StorageKey::Sweeping),
        }
    }

    /// Move the deploy-14 follower lists of agents `[cursor, cursor + limit)` (in `agents` order)
    /// into per-pair records, emitting a `follow` event for each so an indexer can backfill.
    /// Returns the next cursor, or `None` when every agent is done (follow and settle reopen).
    /// Each agent costs one read of its old list, which is what every settle used to do.
    /// Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "migration done".
    #[payable]
    pub fn migrate_follows(&mut self, limit: u32) -> Option<u32> {
        self.only_owner_yocto();
        let cursor = self
            .follows_cursor
            .unwrap_or_else(|| env::panic_str("migration done"));
        let keys: Vec<Vec<u8>> = self
            .agents
            .keys()
            .skip(cursor as usize)
            .take(limit as usize)
            .cloned()
            .collect();
        for pk in &keys {
            for (follower, m) in self.follows_v1.remove(pk).unwrap_or_default() {
                self.follows
                    .insert(follow_key(pk, &follower), VersionedMandate::V2(m.into()));
                crate::follow::follow_event("follow", pk, &follower);
            }
        }
        let next = cursor + keys.len() as u32;
        self.follows_cursor = (next < self.agents.len()).then_some(next);
        self.follows_cursor
    }

    /// Allow `account_id` to call `settle_follow`. Caller: owner. Deposit: 1 yoctoNEAR. Panics:
    /// "not owner".
    #[payable]
    pub fn add_solver(&mut self, account_id: AccountId) {
        self.only_owner_yocto();
        self.solvers.insert(account_id);
    }

    /// Stop `account_id` from settling. Its settles already in flight are rejected in the
    /// callback ("solver removed"). Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner",
    /// "not a solver".
    #[payable]
    pub fn remove_solver(&mut self, account_id: AccountId) {
        self.only_owner_yocto();
        require!(self.solvers.remove(&account_id), "not a solver");
    }

    /// Point at another price oracle account, change the deposit it needs, the duel length floor, or
    /// the intent lock (no intent in the last `intent_lock_s` of a duel; at most half the floor).
    /// While any duel is open the lock may only grow and the oracle account may not change; a duel
    /// keeps the lock it was opened under either way.
    /// Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "intent_lock_s too large",
    /// "min_duel_s too large", "duels open".
    #[payable]
    pub fn set_oracle(
        &mut self,
        oracle_account: AccountId,
        oracle_deposit: U128,
        min_duel_s: u64,
        intent_lock_s: u64,
    ) {
        self.only_owner_yocto();
        require!(intent_lock_s <= min_duel_s / 2, "intent_lock_s too large");
        let min_duel_ns = duel_floor_ns(min_duel_s);
        let intent_lock_ns = intent_lock_s * 1_000_000_000;
        require!(
            self.open_duels == 0
                || (oracle_account == self.oracle_account && intent_lock_ns >= self.intent_lock_ns),
            "duels open"
        );
        self.oracle_account = oracle_account;
        self.oracle_deposit = oracle_deposit.0;
        self.min_duel_ns = min_duel_ns;
        self.intent_lock_ns = intent_lock_ns;
    }

    /// Turn commit-reveal on or off and set the no-reveal slash. With it on, `post_intent` is
    /// refused and intents go through `commit_intent` / `reveal_intent`. `enabled` may not change
    /// while a duel is open, so a running duel keeps the rules it was opened under; the bps may.
    /// Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "bps out of range", "duels open".
    #[payable]
    pub fn set_commit_reveal(&mut self, enabled: bool, no_reveal_bps: u16) {
        self.only_owner_yocto();
        require!(no_reveal_bps <= 10_000, "bps out of range");
        require!(
            self.open_duels == 0 || enabled == self.commit_reveal,
            "duels open"
        );
        self.commit_reveal = enabled;
        self.no_reveal_bps = no_reveal_bps;
    }

    /// With `required` on, `open_duel` is refused and pairing needs both agents' signatures
    /// through `open_duel_consented`.
    /// Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
    #[payable]
    pub fn set_require_consent(&mut self, required: bool) {
        self.only_owner_yocto();
        self.require_consent = required;
    }

    /// Kill switch. While paused: `register_agent`, `open_duel*`, `post_intent`, `commit_intent`,
    /// `inject_chaos`, `deposit`, `follow` and `settle_follow` panic "paused". Every exit stays
    /// open: `request_withdraw`, `withdraw`, `withdraw_token`, `withdraw_bond`, `unfollow`,
    /// `reveal_intent`, `resolve_duel`, `request_open_price`, `void_duel`, `withdraw_fees`.
    /// Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner_yocto();
        self.paused = paused;
    }

    /// Cap on `vault_total`, checked by `deposit`. Lowering it below the current total only stops
    /// new deposits. Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
    #[payable]
    pub fn set_vault_cap(&mut self, max_vault_total: U128) {
        self.only_owner_yocto();
        self.max_vault_total = max_vault_total.0;
    }

    /// How long `withdraw` waits after `request_withdraw`; at least twice the solver's settle lag.
    /// Applies to requests made after the change. Caller: owner. Deposit: 1 yoctoNEAR. Panics:
    /// "not owner", "delay out of range" (outside 60..=604800 s).
    #[payable]
    pub fn set_withdraw_delay(&mut self, withdraw_delay_s: u64) {
        self.only_owner_yocto();
        require!(
            (60..=7 * 24 * 3600).contains(&withdraw_delay_s),
            "delay out of range"
        );
        self.withdraw_delay_ns = withdraw_delay_s * 1_000_000_000;
    }

    /// Contract owner collects accrued settlement fees.
    /// Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "insufficient" (nothing accrued).
    #[payable]
    pub fn withdraw_fees(&mut self) -> Promise {
        self.only_owner_yocto();
        let amt = self.owner_fees;
        require!(amt > 0, "insufficient");
        self.owner_fees = 0;
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amt))
    }
}
