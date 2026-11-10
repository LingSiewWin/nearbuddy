//! Contract state, storage prefixes, `init`, the live migration and owner config.
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, assert_one_yocto, env, near,
    require,
};

use crate::{
    Agent, Chaos, ChaosConfig, Duel, MAX_DUEL_NS, MandateV1, VersionedMandate, follow::follow_key,
};

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
    SelfChaos,
    NonceTimes,
    Chaos,
    KeylessAgents,
    KeylessSlots,
    KeylessTicks,
    KeylessSigners,
}

/// Most accounts one `reconcile_vault_total` reads, so the call stays inside one transaction's gas.
pub const MAX_RECONCILE: usize = 100;

/// Raw storage key of a paged vault reconcile in progress: borsh `Reconcile`. Kept outside
/// `Contract`, so the paged reconcile changed no state layout (no migration).
const RECONCILE_KEY: &[u8] = b"reconcile";
/// `(sum of the vaults counted so far, last account counted)`; pages go in ascending account order.
type Reconcile = (u128, Option<AccountId>);

fn reconcile_state() -> Option<Reconcile> {
    env::storage_read(RECONCILE_KEY)
        .map(|b| near_sdk::borsh::from_slice(&b).expect("reconcile state"))
}

fn write_reconcile(r: &Reconcile) {
    env::storage_write(
        RECONCILE_KEY,
        &near_sdk::borsh::to_vec(r).expect("reconcile state"),
    );
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
    /// `agent_pk || nonce_le` of every intent accepted before deploy 16 (later ones: `nonce_times`).
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
    /// Sum of `vaults` for accounting from deploy 16 on: deposits minus withdrawals, fees and follow
    /// storage. Deploy 15 left drift (follow storage not subtracted, pre-15 vaults not counted,
    /// withdrawals saturating at 0); `reconcile_vault_total` resets it to the real sum.
    pub(crate) vault_total: u128,
    /// Duel id to the intent lock it was opened under (ns), kept after the duel finishes so its lock
    /// stays checkable through `duel_lock` (the opener paid for the entry). Duels opened before
    /// deploy 15 have no entry and use `intent_lock_ns`.
    pub(crate) duel_locks: LookupMap<u64, u64>,
    /// Per token id, surplus `sweep_surplus` has approved and not yet seen confirmed: settles treat it
    /// as spent, so a fill can never be credited from balance that is on its way out.
    pub(crate) sweeping: LookupMap<String, u128>,
    /// Duel id to a bitmask over `Duel.injections` (at most 32): bit i set when injection i was paid
    /// by the owner of either agent. Such chaos earns no shield and its deposit goes to `owner_fees`,
    /// not the pool, so an owner cannot buy shield or recycle chaos deposits through its own duel.
    /// Bit 32 + i (deploy 17.1): injection i's target replaced, unrevealed, the commitment it held
    /// at the injection, so its `prev` is hidden (see `hide_prev_since`). Removed when the duel
    /// finishes or is voided. Duels opened before deploy 15 have no entry.
    pub(crate) self_chaos: LookupMap<u64, u64>,
    /// `deposit` is refused once the caller's vault would exceed this (deploy 16), so one account
    /// cannot park the whole of `max_vault_total` and block every other follower. Vaults already
    /// above it stay as they are and withdraw normally; only new deposits are checked.
    pub(crate) max_vault_per_account: u128,
    /// `agent_pk || nonce_le` (see `nonce_key`) to the block time its intent was accepted, for every
    /// intent accepted from deploy 16 on; it replaces `used_nonces` for them. A fill for an intent
    /// accepted at or after its mandate's revoke or expiry is refused, whatever the grace (deploy 16).
    pub(crate) nonce_times: LookupMap<Vec<u8>, u64>,
    /// Duel id to its planted headlines, in `Duel.injections` order (deploy 17). Kept after the duel
    /// finishes: the outcomes are the record, and the payouts are claimed from it.
    pub(crate) chaos: LookupMap<u64, Vec<Chaos>>,
    pub(crate) chaos_config: ChaosConfig,
}

/// State layout of deploys 16 and 16.1. Read once by `migrate_v17`.
#[allow(dead_code)]
#[derive(near_sdk::borsh::BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct ContractV16 {
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
    follows_v1: LookupMap<Vec<u8>, Vec<(AccountId, MandateV1)>>,
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
    follows: LookupMap<Vec<u8>, VersionedMandate>,
    follows_cursor: Option<u32>,
    intents_account: AccountId,
    holdings: LookupMap<String, u128>,
    accounted: LookupMap<String, u128>,
    outflow_seq: u64,
    pending_withdrawals: LookupMap<AccountId, (u128, u64)>,
    withdraw_delay_ns: u64,
    paused: bool,
    max_vault_total: u128,
    vault_total: u128,
    duel_locks: LookupMap<u64, u64>,
    sweeping: LookupMap<String, u128>,
    self_chaos: LookupMap<u64, u64>,
    max_vault_per_account: u128,
    nonce_times: LookupMap<Vec<u8>, u64>,
}

/// Seconds to ns, at most `MAX_DUEL_NS`: a floor above the longest duel `open_duel` accepts would
/// refuse every duel.
pub(crate) fn duel_floor_ns(min_duel_s: u64) -> u64 {
    require!(
        min_duel_s <= MAX_DUEL_NS / 1_000_000_000,
        "min_duel_s too large"
    );
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

    /// When the intent behind `key` (see `nonce_key`) was accepted: its block time from deploy 16
    /// on, 0 for one accepted before (time not recorded), `None` for a nonce never accepted.
    pub(crate) fn accepted_at(&self, key: &[u8]) -> Option<u64> {
        self.nonce_times
            .get(key)
            .copied()
            .or_else(|| self.used_nonces.contains(key).then_some(0))
    }

    /// Every vault write goes through here. While a paged reconcile runs, an account it already
    /// counted (at or below its cursor) moves the pending sum with it, so the total it finishes
    /// with is the sum at finish time however many transactions the pages span.
    pub(crate) fn set_vault(&mut self, who: &AccountId, bal: u128) {
        let old = self.vaults.insert(who.clone(), bal).unwrap_or(0);
        if let Some((sum, Some(last))) = reconcile_state()
            && who <= &last
        {
            // `sum` includes `old`: it counted `who` (or a later write kept it current)
            write_reconcile(&((sum + bal).saturating_sub(old), Some(last)));
        }
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
    /// (`intents.near`, or the stub on testnet). `max_vault_total` caps all vault deposits, and is
    /// also the starting per-account cap (`set_vault_account_cap` lowers it). The
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
            self_chaos: LookupMap::new(StorageKey::SelfChaos),
            max_vault_per_account: max_vault_total.0,
            nonce_times: LookupMap::new(StorageKey::NonceTimes),
            chaos: LookupMap::new(StorageKey::Chaos),
            // flat price at `min_chaos_deposit`, no fee, no share: `set_chaos_config` sets real terms
            chaos_config: ChaosConfig {
                base: min_chaos_deposit,
                r_bps: 10_000,
                cap: min_chaos_deposit,
                fee_bps: 0,
                share_bps: 0,
            },
        }
    }

    // ---------------------------------------------------------------- migration

    /// Deploy 16.1 → 17 ("Fool the AI"): planted headlines with a rising price, a random arm, the
    /// outcome read from the target's next revealed TEE decision and a payout per injection at
    /// finish (`chaos`, `chaos_config`). Every deploy-16 field is carried over unchanged. Refused
    /// unless no duel is open (a batch boundary): `Duel.injections` keeps its layout, but the stakes
    /// of a duel open across the deploy would have no `chaos` records to settle them.
    /// Caller: the contract itself (private), once after the deploy-17 code lands. Deposit: none.
    /// Panics: "no state", "duels open", as `set_chaos_config` on bad terms, or the SDK
    /// private-method panic for any other caller.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v17(chaos: ChaosConfig) -> Self {
        let old: ContractV16 = env::state_read().expect("no state");
        // a duel open across the deploy has injections with no `chaos` record: the next
        // `inject_chaos` there would index past the records and its stakes could not settle
        require!(old.open_duels == 0, "duels open");
        chaos.check(old.min_chaos_deposit);
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
            follows_v1: old.follows_v1,
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
            follows: old.follows,
            follows_cursor: old.follows_cursor,
            intents_account: old.intents_account,
            holdings: old.holdings,
            accounted: old.accounted,
            outflow_seq: old.outflow_seq,
            pending_withdrawals: old.pending_withdrawals,
            withdraw_delay_ns: old.withdraw_delay_ns,
            paused: old.paused,
            max_vault_total: old.max_vault_total,
            vault_total: old.vault_total,
            duel_locks: old.duel_locks,
            sweeping: old.sweeping,
            self_chaos: old.self_chaos,
            max_vault_per_account: old.max_vault_per_account,
            nonce_times: old.nonce_times,
            chaos: LookupMap::new(StorageKey::Chaos),
            chaos_config: chaos,
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

    /// `inject_chaos` terms (see `ChaosConfig`). The price applies to later injections; `fee_bps`
    /// and `share_bps` decide the payouts of stakes already escrowed, so they may not change while
    /// a duel is open. Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "chaos r out of
    /// range" (outside 10_000..=40_000), "chaos cap below base" (cap under base or
    /// `min_chaos_deposit`), "bps out of range" (fee over 1_000 or share over 10_000), "duels open".
    #[payable]
    pub fn set_chaos_config(&mut self, chaos: ChaosConfig) {
        self.only_owner_yocto();
        chaos.check(self.min_chaos_deposit);
        let old = &self.chaos_config;
        require!(
            self.open_duels == 0
                || (chaos.fee_bps, chaos.share_bps) == (old.fee_bps, old.share_bps),
            "duels open"
        );
        self.chaos_config = chaos;
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

    /// Cap on one account's vault, checked by `deposit`. Lowering it below a vault only stops that
    /// account's new deposits. Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
    #[payable]
    pub fn set_vault_account_cap(&mut self, max_vault_per_account: U128) {
        self.only_owner_yocto();
        self.max_vault_per_account = max_vault_per_account.0;
    }

    /// Recompute `vault_total` as the sum of `accounts`' vaults. `vaults` is not iterable, so the
    /// owner supplies every vault holder (from deposit events); this clears the drift deploys 15 and
    /// earlier left (follow storage not subtracted, pre-15 vaults not counted). Omitting a holder
    /// only undercounts, which loosens the cap the owner can set anyway; no NEAR moves. Returns the
    /// new total. For more than `MAX_RECONCILE` holders use `begin_reconcile`. Caller: owner.
    /// Deposit: 1 yoctoNEAR. Panics: "not owner", "too many accounts" (over `MAX_RECONCILE`),
    /// "duplicate account".
    #[payable]
    pub fn reconcile_vault_total(&mut self, accounts: Vec<AccountId>) -> U128 {
        self.only_owner_yocto();
        require!(accounts.len() <= MAX_RECONCILE, "too many accounts");
        let mut seen = accounts.clone();
        seen.sort();
        seen.dedup();
        require!(seen.len() == accounts.len(), "duplicate account");
        self.vault_total = accounts
            .iter()
            .map(|a| self.vaults.get(a).copied().unwrap_or(0))
            .sum();
        U128(self.vault_total)
    }

    /// Start a paged reconcile of `vault_total` for more holders than one call can read: then
    /// `reconcile_page` (any number of times) and `finish_reconcile`. Restarts one in progress.
    /// Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
    #[payable]
    pub fn begin_reconcile(&mut self) {
        self.only_owner_yocto();
        write_reconcile(&(0, None));
    }

    /// Add `accounts`' vaults to the pending sum. Accounts must be strictly ascending, within the
    /// page and across pages (each above the last account counted), so none is counted twice; list
    /// every holder in sorted order. Returns the pending sum. Caller: owner. Deposit: 1 yoctoNEAR.
    /// Panics: "not owner", "no reconcile", "too many accounts", "accounts not ascending".
    #[payable]
    pub fn reconcile_page(&mut self, accounts: Vec<AccountId>) -> U128 {
        self.only_owner_yocto();
        let (mut sum, mut last) =
            reconcile_state().unwrap_or_else(|| env::panic_str("no reconcile"));
        require!(accounts.len() <= MAX_RECONCILE, "too many accounts");
        for a in accounts {
            require!(
                last.as_ref().is_none_or(|l| &a > l),
                "accounts not ascending"
            );
            sum += self.vaults.get(&a).copied().unwrap_or(0);
            last = Some(a);
        }
        write_reconcile(&(sum, last));
        U128(sum)
    }

    /// Set `vault_total` to the pending sum and end the reconcile. Returns the new total.
    /// Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "no reconcile".
    #[payable]
    pub fn finish_reconcile(&mut self) -> U128 {
        self.only_owner_yocto();
        let (sum, _) = reconcile_state().unwrap_or_else(|| env::panic_str("no reconcile"));
        env::storage_remove(RECONCILE_KEY);
        self.vault_total = sum;
        U128(sum)
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
