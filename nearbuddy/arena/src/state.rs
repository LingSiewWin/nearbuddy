//! Contract state, storage prefixes, `init`, the live migration and owner config.
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, env, near, require,
};

use crate::{Agent, DEFAULT_INTENT_LOCK_NS, Duel, Mandate};

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
}

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
    /// Followers per agent. ponytail: linear scan per agent; nested IterableMap when an agent has
    /// more followers than fit in one read.
    pub(crate) follows: LookupMap<Vec<u8>, Vec<(AccountId, Mandate)>>,
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
    /// before the close price is knowable. Bounded to `min_duel_ns / 2` by `set_oracle`.
    pub(crate) intent_lock_ns: u64,
    /// Duels opened and not yet finished or voided. While it is non-zero `set_oracle` may not lower
    /// the lock or move the oracle, so a running duel keeps the rules it was opened under. Starts
    /// at 0 in `migrate_v12`: duels open across that deploy are not counted and never gate.
    pub(crate) open_duels: u64,
}

/// State layout of deploy 11 (before `open_duels`). Read once by `migrate_v12`.
#[allow(dead_code)]
#[derive(near_sdk::borsh::BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct ContractV11 {
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
    follows: LookupMap<Vec<u8>, Vec<(AccountId, Mandate)>>,
    settled_fills: LookupSet<Vec<u8>>,
    owner_fees: u128,
    tee_signers: LookupSet<Vec<u8>>,
    tee_agents: LookupSet<Vec<u8>>,
    used_proofs: LookupSet<Vec<u8>>,
    min_duel_ns: u64,
    agent_duels: LookupMap<Vec<u8>, Vec<u64>>,
    intent_lock_ns: u64,
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

    pub(crate) fn only_solver(&self) {
        require!(
            self.solvers.contains(&env::predecessor_account_id()),
            "not solver"
        );
    }
}

#[near]
impl Contract {
    /// `owner` runs duels (the solver account in the hackathon deploy). `oracle_account` is the
    /// Outlayer price oracle; `oracle_deposit` is attached to each price request. `slash_bps` of the
    /// loser's bond moves to the pool. `fee_bps` is charged on top of every settled fill and accrues
    /// to the owner.
    /// Caller: deployer, once. Deposit: none. Panics: "bps out of range".
    #[init]
    pub fn init(
        owner: AccountId,
        oracle_account: AccountId,
        oracle_deposit: U128,
        slash_bps: u16,
        fee_bps: u16,
        min_chaos_deposit: U128,
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
            follows: LookupMap::new(StorageKey::Follows),
            settled_fills: LookupSet::new(StorageKey::SettledFills),
            owner_fees: 0,
            tee_signers: LookupSet::new(StorageKey::TeeSigners),
            tee_agents: LookupSet::new(StorageKey::TeeAgents),
            used_proofs: LookupSet::new(StorageKey::UsedProofs),
            min_duel_ns: 0,
            agent_duels: LookupMap::new(StorageKey::AgentDuels),
            intent_lock_ns: DEFAULT_INTENT_LOCK_NS,
            open_duels: 0,
        }
    }

    // ---------------------------------------------------------------- migration

    /// Deploy 11 → 12: add `open_duels`, starting at 0 (duels open across the deploy are not
    /// counted; the counter only gates `set_oracle`). Collections keep their prefixes.
    /// Caller: the contract itself (private), once after the deploy-12 code lands. Deposit:
    /// none. Panics: "no state", or the SDK private-method panic for any other caller.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v12() -> Self {
        let old: ContractV11 = env::state_read().expect("no state");
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
            follows: old.follows,
            settled_fills: old.settled_fills,
            owner_fees: old.owner_fees,
            tee_signers: old.tee_signers,
            tee_agents: old.tee_agents,
            used_proofs: old.used_proofs,
            min_duel_ns: old.min_duel_ns,
            agent_duels: old.agent_duels,
            intent_lock_ns: old.intent_lock_ns,
            open_duels: 0,
        }
    }

    /// Allow `account_id` to call `settle_follow`. Caller: owner. Deposit: none. Panics:
    /// "not owner".
    pub fn add_solver(&mut self, account_id: AccountId) {
        self.only_owner();
        self.solvers.insert(account_id);
    }

    /// Point at another price oracle account, change the deposit it needs, the duel length floor, or
    /// the intent lock (no intent in the last `intent_lock_s` of a duel; at most half the floor).
    /// While any duel is open the lock may only grow and the oracle account may not change.
    /// Caller: owner. Deposit: none. Panics: "not owner", "intent_lock_s too large",
    /// "min_duel_s too large", "duels open".
    pub fn set_oracle(
        &mut self,
        oracle_account: AccountId,
        oracle_deposit: U128,
        min_duel_s: u64,
        intent_lock_s: u64,
    ) {
        self.only_owner();
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

    /// Contract owner collects accrued settlement fees.
    /// Caller: owner. Deposit: none. Panics: "not owner", "insufficient" (nothing accrued).
    pub fn withdraw_fees(&mut self) -> Promise {
        self.only_owner();
        let amt = self.owner_fees;
        require!(amt > 0, "insufficient");
        self.owner_fees = 0;
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amt))
    }
}
