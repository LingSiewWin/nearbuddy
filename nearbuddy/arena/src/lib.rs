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
mod types;
pub use types::*;

#[cfg(test)]
mod tests;

use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, env, ext_contract, near,
    require,
};

pub const INTENT_DOMAIN: &[u8] = b"nearbuddy-intent-v1";
/// Prefix of the bytes an agent key signs to prove possession at `register_agent`.
pub const REGISTER_DOMAIN: &[u8] = b"nearbuddy-register-v1";
/// `intent_lock_ns` until the owner sets it through `set_oracle`.
pub const DEFAULT_INTENT_LOCK_NS: u64 = 60 * 1_000_000_000;
/// Cap on `Duel.injections` so a duel record cannot grow without bound.
pub const MAX_INJECTIONS: usize = 32;
/// After this long past `close_at` with no oracle answer anyone may void the duel.
pub const VOID_AFTER_NS: u64 = 24 * 3600 * 1_000_000_000;
const ORACLE_GAS: Gas = Gas::from_tgas(150);

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
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

#[ext_contract(ext_oracle)]
pub trait Oracle {
    fn oracle_call(
        &mut self,
        receiver_id: AccountId,
        asset_ids: Option<Vec<String>>,
        msg: String,
        resource_limits: Option<near_sdk::serde_json::Value>,
    ) -> Promise;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    oracle_account: AccountId,
    oracle_deposit: u128,
    slash_bps: u16,
    fee_bps: u16,
    min_chaos_deposit: u128,
    /// Keyed by the 32-byte agent public key.
    agents: IterableMap<Vec<u8>, Agent>,
    duels: LookupMap<u64, Duel>,
    next_duel: u64,
    /// `agent_pk || nonce_le` of every accepted intent.
    used_nonces: LookupSet<Vec<u8>>,
    solvers: LookupSet<AccountId>,
    /// Follower vault balances, yoctoNEAR.
    vaults: LookupMap<AccountId, u128>,
    /// Followers per agent. ponytail: linear scan per agent; nested IterableMap when an agent has
    /// more followers than fit in one read.
    follows: LookupMap<Vec<u8>, Vec<(AccountId, Mandate)>>,
    /// `agent_pk || follower || nonce_le` of every settled fill (see `fill_key`).
    settled_fills: LookupSet<Vec<u8>>,
    owner_fees: u128,
    /// ed25519 signing addresses of NEAR AI Cloud enclaves, from attestation reports.
    tee_signers: LookupSet<Vec<u8>>,
    /// Agents that committed to TEE-proved decisions at registration.
    tee_agents: LookupSet<Vec<u8>>,
    /// `proof_hash` of every accepted TEE-proved intent: one enclave completion backs one intent.
    used_proofs: LookupSet<Vec<u8>>,
    /// `close_at - now` floor for `open_duel`. Outlayer serves a cached price for `recency_duration_sec`
    /// (300 s on testnet) with a fresh timestamp, so a shorter duel would close on its own open price.
    min_duel_ns: u64,
    /// Duel ids per agent, oldest first, appended by `open_duel`. Only duels opened from deploy 10
    /// on are here (the deploy-10 migration did not back-fill). ponytail: one Vec per agent, read and
    /// rewritten whole on every open_duel; a `Vector` per agent when an agent has more duels than
    /// fit in one read.
    agent_duels: LookupMap<Vec<u8>, Vec<u64>>,
    /// No intent lands in the last `intent_lock_ns` before `close_at`, so the final decision is made
    /// before the close price is knowable. Bounded to `min_duel_ns / 2` by `set_oracle`.
    intent_lock_ns: u64,
}

/// State layout of deploy 10 (before `intent_lock_ns`). Read once by `migrate_v11`.
#[allow(dead_code)]
#[derive(near_sdk::borsh::BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct ContractV10 {
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
}

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

fn nonce_key(pk: &[u8], nonce: u64) -> Vec<u8> {
    let mut k = pk.to_vec();
    k.extend_from_slice(&nonce.to_le_bytes());
    k
}

/// `agent_pk || follower || nonce_le`: one fill per intent per follower, scoped to the agent that
/// posted the intent so two agents using the same nonce never collide.
fn fill_key(agent_pk: &[u8], follower: &AccountId, nonce: u64) -> Vec<u8> {
    let mut k = agent_pk.to_vec();
    k.extend_from_slice(follower.as_bytes());
    k.extend_from_slice(&nonce.to_le_bytes());
    k
}

fn verify(pk: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk), <[u8; 64]>::try_from(sig)) else {
        return false;
    };
    env::ed25519_verify(&sig, msg, &pk)
}

/// yoctoNEAR owed for the bytes added since `before`. Zero when storage shrank.
fn storage_cost_since(before: u64) -> u128 {
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
fn set_entry_cost(key_len: usize) -> u128 {
    (1 + 4 + key_len + 40) as u128 * env::storage_byte_cost().as_yoctonear()
}

/// Seconds to ns with a sanity bound (a week), so a unit mix-up cannot set an absurd floor.
fn duel_floor_ns(min_duel_s: u64) -> u64 {
    require!(min_duel_s <= 7 * 24 * 3600, "min_duel_s too large");
    min_duel_s * 1_000_000_000
}

/// Caller must attach `oracle_deposit`; anything above it goes straight back.
fn take_oracle_deposit(oracle_deposit: u128) {
    let attached = env::attached_deposit().as_yoctonear();
    require!(attached >= oracle_deposit, "attach oracle_deposit");
    if attached > oracle_deposit {
        let _ = Promise::new(env::predecessor_account_id())
            .transfer(NearToken::from_yoctonear(attached - oracle_deposit));
    }
}

/// Oracle price (multiplier / 10^decimals USD) as u64 with 8 decimals.
fn price8(p: &OraclePrice) -> u64 {
    let v = if p.decimals <= 8 {
        p.multiplier.0 * 10u128.pow(8 - p.decimals as u32)
    } else {
        p.multiplier.0 / 10u128.pow(p.decimals as u32 - 8)
    };
    u64::try_from(v).unwrap_or_else(|_| env::panic_str("price overflow"))
}

#[near]
impl Contract {
    /// `owner` runs duels (the solver account in the hackathon deploy). `oracle_account` is the
    /// Outlayer price oracle; `oracle_deposit` is attached to each price request. `slash_bps` of the
    /// loser's bond moves to the pool. `fee_bps` is charged on top of every settled fill and accrues
    /// to the owner.
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
        }
    }

    // ---------------------------------------------------------------- migration

    /// Deploy 10 → 11: add `intent_lock_ns` (60 s; `set_oracle` changes it). Collections keep
    /// their prefixes.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v11() -> Self {
        let old: ContractV10 = env::state_read().expect("no state");
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
            intent_lock_ns: DEFAULT_INTENT_LOCK_NS,
        }
    }

    // ---------------------------------------------------------------- config

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "not owner");
    }

    fn only_solver(&self) {
        require!(
            self.solvers.contains(&env::predecessor_account_id()),
            "not solver"
        );
    }

    pub fn add_solver(&mut self, account_id: AccountId) {
        self.only_owner();
        self.solvers.insert(account_id);
    }

    /// Point at another price oracle account, change the deposit it needs, the duel length floor, or
    /// the intent lock (no intent in the last `intent_lock_s` of a duel; at most half the floor).
    pub fn set_oracle(
        &mut self,
        oracle_account: AccountId,
        oracle_deposit: U128,
        min_duel_s: u64,
        intent_lock_s: u64,
    ) {
        self.only_owner();
        require!(intent_lock_s <= min_duel_s / 2, "intent_lock_s too large");
        self.oracle_account = oracle_account;
        self.oracle_deposit = oracle_deposit.0;
        self.min_duel_ns = duel_floor_ns(min_duel_s);
        self.intent_lock_ns = intent_lock_s * 1_000_000_000;
    }

    /// Accept intents signed by this NEAR AI Cloud enclave key. The owner takes it from
    /// `GET /v1/attestation/report` after verifying the Intel and NVIDIA quotes off chain; the
    /// report bytes are published in the dataset so anyone can redo that check.
    pub fn add_tee_signer(&mut self, signer: Base64VecU8, label: String) {
        self.only_owner();
        require!(signer.0.len() == 32, "signer length");
        require!(label.len() <= 64, "label too long");
        self.tee_signers.insert(signer.0.clone());
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"tee_signer","data":{{"signer":"{}","label":"{}"}}}}"#,
            hex(&signer.0),
            label.replace('"', "")
        ));
    }

    pub fn remove_tee_signer(&mut self, signer: Base64VecU8) {
        self.only_owner();
        self.tee_signers.remove(&signer.0);
    }

    /// Contract owner collects accrued settlement fees.
    pub fn withdraw_fees(&mut self) -> Promise {
        self.only_owner();
        let amt = self.owner_fees;
        require!(amt > 0, "insufficient");
        self.owner_fees = 0;
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amt))
    }

    // ---------------------------------------------------------------- agents

    /// Register an agent. The attached deposit is its bond, minus the storage its record costs.
    /// `tee = true` commits the agent to a verified `TeeProof` on every intent. `register_sig` is
    /// `agent_pk`'s ed25519 signature over `register_message(caller)`, so nobody can squat a
    /// published key.
    #[payable]
    pub fn register_agent(
        &mut self,
        agent_pk: Base64VecU8,
        model_id: String,
        tee: bool,
        register_sig: Base64VecU8,
    ) -> AgentView {
        require!(agent_pk.0.len() == 32, "agent_pk length");
        require!(model_id.len() <= 64, "model_id too long");
        require!(!self.agents.contains_key(&agent_pk.0), "agent exists");
        require!(
            verify(
                &agent_pk.0,
                &register_bytes(&env::predecessor_account_id()),
                &register_sig.0
            ),
            "bad register signature"
        );
        let before = env::storage_usage();
        let deposit = env::attached_deposit().as_yoctonear();
        let agent = Agent {
            owner: env::predecessor_account_id(),
            pk: agent_pk.clone(),
            model_id,
            bond: U128(0),
            alpha_bps: 0,
            shield: 0,
            in_duel: None,
        };
        self.agents.insert(agent_pk.0.clone(), agent);
        if tee {
            self.tee_agents.insert(agent_pk.0.clone());
        }
        self.agents.flush();
        let cost = storage_cost_since(before) + if tee { set_entry_cost(32) } else { 0 };
        require!(deposit > cost, "bond required");
        self.agents
            .get_mut(&agent_pk.0)
            .expect("agent missing")
            .bond = U128(deposit - cost);
        let a = self
            .agents
            .get(&agent_pk.0)
            .cloned()
            .expect("agent missing");
        self.view_of(&a)
    }

    /// Agent owner takes bond back. Refused while the agent is in an open duel.
    pub fn withdraw_bond(&mut self, agent_pk: Base64VecU8, amount: U128) -> Promise {
        let agent = self.agents.get_mut(&agent_pk.0).expect("agent missing");
        require!(agent.owner == env::predecessor_account_id(), "not owner");
        require!(agent.in_duel.is_none(), "in duel");
        require!(agent.bond.0 >= amount.0, "insufficient");
        agent.bond = U128(agent.bond.0 - amount.0);
        Promise::new(agent.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---------------------------------------------------------------- duels

    /// Pair two registered, idle agents on an oracle asset. Attached deposit must cover the duel's
    /// storage plus `oracle_deposit`; the open price is requested from the oracle in the same call
    /// and lands through `oracle_on_call`. Returns the duel id.
    #[payable]
    pub fn open_duel(
        &mut self,
        a: Base64VecU8,
        b: Base64VecU8,
        symbol: String,
        close_at: U64,
    ) -> U64 {
        self.only_owner();
        require!(a.0 != b.0, "same agent");
        require!(symbol.len() <= 64, "symbol too long");
        require!(close_at.0 > env::block_timestamp(), "close_at in the past");
        require!(
            close_at.0 - env::block_timestamp() >= self.min_duel_ns,
            "duel too short"
        );
        let before = env::storage_usage();
        let id = self.next_duel;
        for pk in [&a.0, &b.0] {
            let agent = self.agents.get_mut(pk).expect("agent missing");
            require!(agent.in_duel.is_none(), "in duel");
            agent.in_duel = Some(U64(id));
            self.agent_duels.entry(pk.clone()).or_default().push(id);
        }
        self.duels.insert(
            id,
            Duel {
                id: U64(id),
                a,
                b,
                symbol: symbol.clone(),
                open_at: U64(env::block_timestamp()),
                close_at,
                pool: U128(0),
                injections: vec![],
                resolved: false,
                last_intent_a: None,
                last_intent_b: None,
                outcome: None,
                open_price: None,
            },
        );
        self.next_duel += 1;
        self.duels.flush();
        self.agents.flush();
        self.agent_duels.flush();
        let cost = storage_cost_since(before) + self.oracle_deposit;
        require!(
            env::attached_deposit().as_yoctonear() >= cost,
            "deposit too small"
        );
        let _ = self.ask_oracle(&symbol, format!("open:{id}"));
        U64(id)
    }

    /// Ask the oracle again for a duel whose open price never arrived (TEE fetch failed or timed
    /// out). Anyone may call and attaches the oracle deposit (so nobody can spend the contract's
    /// balance on oracle fees); the oracle's refund stays with the contract.
    #[payable]
    pub fn request_open_price(&mut self, duel_id: U64) {
        take_oracle_deposit(self.oracle_deposit);
        let d = self.duels.get(&duel_id.0).expect("duel missing");
        require!(!d.resolved && d.open_price.is_none(), "has open price");
        require!(env::block_timestamp() < d.close_at.0, "duel closed");
        let _ = self.ask_oracle(&d.symbol.clone(), format!("open:{}", duel_id.0));
    }

    fn ask_oracle(&self, asset: &str, msg: String) -> Promise {
        ext_oracle::ext(self.oracle_account.clone())
            .with_attached_deposit(NearToken::from_yoctonear(self.oracle_deposit))
            .with_static_gas(ORACLE_GAS)
            .oracle_call(
                env::current_account_id(),
                Some(vec![asset.to_string()]),
                msg,
                None,
            )
    }

    /// Record an agent-signed intent for an open duel. Anyone may relay it: the signature is what
    /// binds the decision to the agent and the agent's bond pays its storage. Refused inside the
    /// last `intent_lock_ns` of the duel. A TEE-backed agent must also present the enclave signature
    /// over the completion that produced the decision.
    pub fn post_intent(&mut self, signed: SignedIntent, tee: Option<TeeProof>) {
        let before = env::storage_usage();
        let i = &signed.intent;
        require!(i.agent_pk.0.len() == 32, "agent_pk length");
        require!(i.proof_hash.0.len() == 32, "proof_hash length");
        require!(i.size_bps >= 1 && i.size_bps <= 10_000, "bad size");
        let model_id = self
            .agents
            .get(&i.agent_pk.0)
            .expect("agent missing")
            .model_id
            .clone();
        let tee_kind = match &tee {
            Some(p) => {
                self.verify_tee(p, &model_id, &i.proof_hash.0);
                require!(!self.used_proofs.contains(&i.proof_hash.0), "proof used");
                p.kind
            }
            None => {
                require!(
                    !self.tee_agents.contains(&i.agent_pk.0),
                    "tee proof required"
                );
                0
            }
        };
        let duel = self.duels.get_mut(&i.duel_id.0).expect("duel missing");
        require!(
            !duel.resolved && env::block_timestamp() < duel.close_at.0,
            "duel closed"
        );
        require!(
            env::block_timestamp() + self.intent_lock_ns < duel.close_at.0,
            "intent lock"
        );
        let slot = if i.agent_pk.0 == duel.a.0 {
            &mut duel.last_intent_a
        } else if i.agent_pk.0 == duel.b.0 {
            &mut duel.last_intent_b
        } else {
            env::panic_str("bad target")
        };
        let key = nonce_key(&i.agent_pk.0, i.nonce.0);
        require!(!self.used_nonces.contains(&key), "nonce used");
        require!(
            verify(&i.agent_pk.0, &intent_message(i), &signed.signature.0),
            "bad signature"
        );
        *slot = Some(i.clone());
        self.used_nonces.insert(key);
        let mut cost = set_entry_cost(32 + 8);
        if tee_kind != 0 {
            self.used_proofs.insert(i.proof_hash.0.clone());
            cost += set_entry_cost(32);
        }
        self.duels.flush();
        cost += storage_cost_since(before);
        let agent = self.agents.get_mut(&i.agent_pk.0).expect("agent missing");
        require!(agent.bond.0 > cost, "bond exhausted");
        agent.bond = U128(agent.bond.0 - cost);
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"intent","data":{{"duel_id":{},"agent_pk":"{}","side":"{:?}","size_bps":{},"nonce":{},"tee":{tee_kind}}}}}"#,
            i.duel_id.0,
            near_sdk::base64::Engine::encode(
                &near_sdk::base64::prelude::BASE64_STANDARD,
                &i.agent_pk.0
            ),
            i.side,
            i.size_bps,
            i.nonce.0
        ));
    }

    fn verify_tee(&self, p: &TeeProof, model_id: &str, proof: &[u8]) {
        require!(p.kind == 1 || p.kind == 2, "bad tee kind");
        require!(
            p.request_hash.0.len() == 32 && p.response_hash.0.len() == 32,
            "tee hash length"
        );
        require!(self.tee_signers.contains(&p.signer.0), "unknown tee signer");
        let text = tee_text(p.kind, model_id, &p.request_hash.0, &p.response_hash.0);
        require!(
            verify(&p.signer.0, &text, &p.signature.0),
            "bad tee signature"
        );
        require!(
            proof_hash(&p.request_hash.0, &p.response_hash.0) == proof,
            "proof_hash mismatch"
        );
    }

    // ---------------------------------------------------------------- chaos and resolve

    /// Spectator pays to attack one agent in an open duel. Only the hash goes on chain; the solver
    /// delivers the payload to the runner. Deposit, minus the record's storage, joins the duel pool.
    #[payable]
    pub fn inject_chaos(
        &mut self,
        duel_id: U64,
        target: Base64VecU8,
        kind: String,
        payload_hash: Base64VecU8,
    ) {
        let before = env::storage_usage();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.min_chaos_deposit, "chaos deposit too small");
        require!(payload_hash.0.len() == 32, "payload_hash length");
        require!(kind.len() <= 32, "kind too long");
        let duel = self.duels.get_mut(&duel_id.0).expect("duel missing");
        require!(
            !duel.resolved && env::block_timestamp() < duel.close_at.0,
            "duel closed"
        );
        require!(target.0 == duel.a.0 || target.0 == duel.b.0, "bad target");
        require!(duel.injections.len() < MAX_INJECTIONS, "chaos full");
        duel.injections.push(Injection {
            kind,
            payload_hash,
            target,
            block: U64(env::block_height()),
        });
        // flush so the storage delta is measurable before charging
        self.duels.flush();
        let cost = storage_cost_since(before);
        require!(deposit > cost, "chaos deposit too small");
        self.duels.get_mut(&duel_id.0).expect("duel missing").pool.0 += deposit - cost;
    }

    /// After `close_at`, anyone asks the oracle for the close price; the answer arrives in
    /// `oracle_on_call` and finishes the duel. The caller attaches the oracle deposit. The oracle
    /// request is detached: this call succeeds once the request is sent, and may be repeated if the
    /// oracle never answers.
    #[payable]
    pub fn resolve_duel(&mut self, duel_id: U64) {
        take_oracle_deposit(self.oracle_deposit);
        let d = self.duels.get(&duel_id.0).expect("duel missing");
        require!(!d.resolved, "resolved");
        require!(env::block_timestamp() >= d.close_at.0, "duel open");
        require!(d.open_price.is_some(), "no open price");
        let _ = self.ask_oracle(&d.symbol.clone(), format!("close:{}", duel_id.0));
    }

    /// Outlayer delivers the price here. `msg` is `open:<id>` or `close:<id>` as sent by
    /// `ask_oracle`; `sender_id` is who called `oracle_call` and must be this contract.
    pub fn oracle_on_call(&mut self, sender_id: AccountId, data: PriceData, msg: String) {
        require!(
            env::predecessor_account_id() == self.oracle_account,
            "not oracle"
        );
        require!(sender_id == env::current_account_id(), "not our request");
        let (phase, id) = msg
            .split_once(':')
            .unwrap_or_else(|| env::panic_str("bad msg"));
        let id: u64 = id.parse().unwrap_or_else(|_| env::panic_str("bad msg"));
        let d = self.duels.get(&id).expect("duel missing");
        let (symbol, resolved, close_at, open_price) =
            (d.symbol.clone(), d.resolved, d.close_at.0, d.open_price);
        let price = data
            .prices
            .iter()
            .find(|p| p.asset_id == symbol)
            .and_then(|p| p.price.as_ref())
            .map(price8)
            .unwrap_or_else(|| env::panic_str("no price"));
        require!(price > 0, "bad price");
        require!(!resolved, "resolved");
        match phase {
            "open" => {
                let d = self.duels.get_mut(&id).expect("duel missing");
                if d.open_price.is_none() {
                    d.open_price = Some(U64(price));
                    env::log_str(&format!(
                        r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"open_price","data":{{"duel_id":{id},"price":{price},"at":{}}}}}"#,
                        data.timestamp.0
                    ));
                }
            }
            "close" => {
                require!(env::block_timestamp() >= close_at, "duel open");
                require!(data.timestamp.0 >= close_at, "price before close");
                let open = open_price
                    .unwrap_or_else(|| env::panic_str("no open price"))
                    .0;
                self.finish(id, open, price);
            }
            _ => env::panic_str("bad msg"),
        }
    }

    /// Escape hatch when the oracle never answers: a day after `close_at`, anyone may free both
    /// agents, split the pool between them, no slashing, no score. Recorded as a tie with no prices.
    pub fn void_duel(&mut self, duel_id: U64) {
        let d = self.duels.get_mut(&duel_id.0).expect("duel missing");
        require!(!d.resolved, "resolved");
        require!(
            env::block_timestamp() >= d.close_at.0 + VOID_AFTER_NS,
            "too early"
        );
        let (pk_a, pk_b, pool, n) = (
            d.a.0.clone(),
            d.b.0.clone(),
            d.pool.0,
            d.injections.len() as u32,
        );
        d.resolved = true;
        d.pool = U128(0);
        d.injections = vec![];
        d.outcome = Some(Outcome {
            open_price: U64(0),
            close_price: U64(0),
            pnl_a: 0,
            pnl_b: 0,
            winner: None,
            slashed: U128(0),
            injections: n,
        });
        let half = pool / 2;
        for (pk, share) in [(&pk_a, half + pool % 2), (&pk_b, half)] {
            let a = self.agents.get_mut(pk).expect("agent missing");
            a.bond.0 += share;
            a.in_duel = None;
        }
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"void","data":{{"duel_id":{}}}}}"#,
            duel_id.0
        ));
    }

    /// Scores both agents, slashes the loser into the pool, pays the pool to the winner, counts the
    /// injections the winner survived, frees both agents, prunes the injection list.
    fn finish(&mut self, id: u64, open: u64, close: u64) {
        let duel = self.duels.get_mut(&id).expect("duel missing");
        let close_at = duel.close_at.0;
        let pnl_a = pnl_bps(duel.last_intent_a.as_ref(), close_at, open, close);
        let pnl_b = pnl_bps(duel.last_intent_b.as_ref(), close_at, open, close);
        let (pk_a, pk_b) = (duel.a.0.clone(), duel.b.0.clone());
        let mut pool = duel.pool.0;
        let injections = std::mem::take(&mut duel.injections);
        duel.resolved = true;
        duel.pool = U128(0);

        let slash_bps = self.slash_bps as u128;
        let mut outcome = Outcome {
            open_price: U64(open),
            close_price: U64(close),
            pnl_a,
            pnl_b,
            winner: None,
            slashed: U128(0),
            injections: injections.len() as u32,
        };
        for (pk, pnl) in [(&pk_a, pnl_a), (&pk_b, pnl_b)] {
            let a = self.agents.get_mut(pk).expect("agent missing");
            a.alpha_bps += pnl;
            a.in_duel = None;
        }
        if pnl_a == pnl_b {
            let half = pool / 2;
            self.agents.get_mut(&pk_a).unwrap().bond.0 += half + pool % 2;
            self.agents.get_mut(&pk_b).unwrap().bond.0 += half;
        } else {
            let (winner, loser) = if pnl_a > pnl_b {
                (&pk_a, &pk_b)
            } else {
                (&pk_b, &pk_a)
            };
            let l = self.agents.get_mut(loser).unwrap();
            let slashed = l.bond.0 * slash_bps / 10_000;
            l.bond.0 -= slashed;
            pool += slashed;
            outcome.winner = Some(Base64VecU8(winner.clone()));
            outcome.slashed = U128(slashed);
            let survived = injections.iter().filter(|i| i.target.0 == *winner).count() as u32;
            let w = self.agents.get_mut(winner).unwrap();
            w.bond.0 += pool;
            w.shield += survived;
        }
        self.duels.get_mut(&id).expect("duel missing").outcome = Some(outcome);
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"resolve","data":{{"duel_id":{id},"pnl_a":{pnl_a},"pnl_b":{pnl_b},"open":{open},"close":{close}}}}}"#
        ));
    }

    // ---------------------------------------------------------------- followers

    /// Follower locks NEAR here. Solvers are repaid from it only inside a mandate. A first deposit
    /// also pays for the vault record.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let before = env::storage_usage();
        let who = env::predecessor_account_id();
        let amt = env::attached_deposit().as_yoctonear();
        require!(amt > 0, "deposit required");
        let bal = self.vaults.get(&who).copied().unwrap_or(0) + amt;
        self.vaults.insert(who.clone(), bal);
        self.vaults.flush();
        let cost = storage_cost_since(before);
        require!(amt > cost, "deposit required");
        let bal = bal - cost;
        self.vaults.insert(who, bal);
        U128(bal)
    }

    /// Instant withdrawal. ponytail: the solver carries exposure between its swap and
    /// `settle_follow`; add `request_withdraw` + delay (vault contract pattern) before mainnet.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        let bal = self.vaults.get(&who).copied().unwrap_or(0);
        require!(bal >= amount.0, "insufficient");
        self.vaults.insert(who.clone(), bal - amount.0);
        Promise::new(who).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Attach (or replace) the caller's mandate for an agent. Only enclave-verified agents (TEE
    /// proof on every intent) can be followed. Storage is paid from the vault.
    pub fn follow(&mut self, agent_pk: Base64VecU8, mandate: Mandate) {
        require!(self.agents.contains_key(&agent_pk.0), "agent missing");
        require!(self.tee_agents.contains(&agent_pk.0), "agent unverified");
        require!(
            mandate.per_tx_cap.0 > 0 && mandate.allowance.0 > 0,
            "empty mandate"
        );
        let before = env::storage_usage();
        let who = env::predecessor_account_id();
        let list = self.follows.entry(agent_pk.0).or_default();
        match list.iter_mut().find(|(f, _)| *f == who) {
            Some(slot) => slot.1 = mandate,
            None => list.push((who.clone(), mandate)),
        }
        self.follows.flush();
        let cost = storage_cost_since(before);
        if cost > 0 {
            let bal = self.vaults.get(&who).copied().unwrap_or(0);
            require!(bal >= cost, "insufficient");
            self.vaults.insert(who, bal - cost);
        }
    }

    pub fn unfollow(&mut self, agent_pk: Base64VecU8) {
        let who = env::predecessor_account_id();
        if let Some(slot) = self
            .follows
            .get_mut(&agent_pk.0)
            .and_then(|l| l.iter_mut().find(|(f, _)| *f == who))
        {
            slot.1.revoked = true;
        }
    }

    /// Solver reports swaps it fronted for one follower of one agent. Each fill is checked against
    /// the follower's mandate; accepted fills move `amount_in` from the follower's vault to the
    /// solver's and `amount_in * fee_bps / 10_000` to the owner. Rejections are reported, not
    /// panicked, so one bad fill never blocks the batch.
    pub fn settle_follow(
        &mut self,
        agent_pk: Base64VecU8,
        follower: AccountId,
        fills: Vec<Fill>,
    ) -> SettleReport {
        self.only_solver();
        let solver = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut report = SettleReport {
            settled: 0,
            debited: U128(0),
            rejected: vec![],
        };
        for (i, f) in fills.into_iter().enumerate() {
            match self.apply_fill(&agent_pk.0, &follower, &solver, &f, now) {
                Ok(debited) => {
                    report.settled += 1;
                    report.debited = U128(report.debited.0 + debited);
                }
                Err(reason) => report.rejected.push((i as u32, reason.into())),
            }
        }
        report
    }

    fn apply_fill(
        &mut self,
        agent_pk: &[u8],
        follower: &AccountId,
        solver: &AccountId,
        f: &Fill,
        now: u64,
    ) -> Result<u128, &'static str> {
        if !self
            .used_nonces
            .contains(&nonce_key(agent_pk, f.intent_nonce.0))
        {
            return Err("nonce unknown");
        }
        let fkey = fill_key(agent_pk, follower, f.intent_nonce.0);
        if self.settled_fills.contains(&fkey) {
            return Err("duplicate fill");
        }
        let list = self.follows.get_mut(agent_pk).ok_or("no mandate")?;
        let (_, m) = list
            .iter_mut()
            .find(|(who, _)| who == follower)
            .ok_or("no mandate")?;
        if m.revoked {
            return Err("mandate revoked");
        }
        if now >= m.expires_at.0 {
            return Err("mandate expired");
        }
        if !m.allowed_tokens.is_empty() && !m.allowed_tokens.contains(&f.token) {
            return Err("token not allowed");
        }
        if f.amount_in.0 > m.per_tx_cap.0 {
            return Err("over cap");
        }
        // checked: `spent` is follower-supplied, so one absurd mandate must not panic the batch
        let spent = m
            .spent
            .0
            .checked_add(f.amount_in.0)
            .filter(|s| *s <= m.allowance.0)
            .ok_or("allowance exhausted")?;
        let fee = f.amount_in.0 * self.fee_bps as u128 / 10_000;
        let debit = f.amount_in.0 + fee;
        let bal = self.vaults.get(follower).copied().unwrap_or(0);
        if bal < debit {
            return Err("insufficient");
        }
        m.spent = U128(spent);
        self.vaults.insert(follower.clone(), bal - debit);
        let sbal = self.vaults.get(solver).copied().unwrap_or(0);
        self.vaults.insert(solver.clone(), sbal + f.amount_in.0);
        self.owner_fees += fee;
        self.settled_fills.insert(fkey);
        Ok(debit)
    }

    // ---------------------------------------------------------------- views

    fn view_of(&self, a: &Agent) -> AgentView {
        AgentView {
            owner: a.owner.clone(),
            pk: a.pk.clone(),
            model_id: a.model_id.clone(),
            bond: a.bond,
            alpha_bps: a.alpha_bps,
            shield: a.shield,
            in_duel: a.in_duel,
            tee: self.tee_agents.contains(&a.pk.0),
        }
    }

    pub fn get_vault(&self, account: AccountId) -> U128 {
        U128(self.vaults.get(&account).copied().unwrap_or(0))
    }

    pub fn get_follow(&self, agent_pk: Base64VecU8, follower: AccountId) -> Option<Mandate> {
        self.follows
            .get(&agent_pk.0)?
            .iter()
            .find(|(f, _)| *f == follower)
            .map(|(_, m)| m.clone())
    }

    pub fn list_followers(&self, agent_pk: Base64VecU8) -> Vec<(AccountId, Mandate)> {
        self.follows.get(&agent_pk.0).cloned().unwrap_or_default()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            oracle_account: self.oracle_account.clone(),
            oracle_deposit: U128(self.oracle_deposit),
            min_duel_s: self.min_duel_ns / 1_000_000_000,
            intent_lock_s: self.intent_lock_ns / 1_000_000_000,
            slash_bps: self.slash_bps,
            fee_bps: self.fee_bps,
            min_chaos_deposit: U128(self.min_chaos_deposit),
            next_duel: U64(self.next_duel),
            owner_fees: U128(self.owner_fees),
        }
    }

    pub fn get_agent(&self, agent_pk: Base64VecU8) -> Option<AgentView> {
        self.agents.get(&agent_pk.0).map(|a| self.view_of(a))
    }

    pub fn is_tee_signer(&self, signer: Base64VecU8) -> bool {
        self.tee_signers.contains(&signer.0)
    }

    pub fn get_duel(&self, duel_id: U64) -> Option<Duel> {
        self.duels.get(&duel_id.0).cloned()
    }

    /// Duel ids an agent took part in, newest first, `limit` entries from offset `from`. Only duels
    /// opened from deploy 10 on are indexed; unknown agents return an empty list.
    pub fn agent_duels(&self, agent_pk: Base64VecU8, from: u64, limit: u64) -> Vec<U64> {
        let Some(list) = self.agent_duels.get(&agent_pk.0) else {
            return vec![];
        };
        list.iter()
            .rev()
            .skip(from as usize)
            .take(limit as usize)
            .map(|d| U64(*d))
            .collect()
    }

    /// Agents sorted by alpha, then shield, descending.
    pub fn leaderboard(&self) -> Vec<AgentView> {
        let mut v: Vec<AgentView> = self.agents.values().map(|a| self.view_of(a)).collect();
        v.sort_by(|x, y| (y.alpha_bps, y.shield).cmp(&(x.alpha_bps, x.shield)));
        v
    }

    /// The exact bytes an agent key signs to be registered by `owner`.
    pub fn register_message(&self, owner: AccountId) -> Base64VecU8 {
        Base64VecU8(register_bytes(&owner))
    }

    pub fn intent_message_hex(&self, intent: Intent) -> String {
        hex(&intent_message(&intent))
    }

    /// The exact text a TEE signs for an agent's completion, for off-chain parity checks.
    pub fn tee_text_utf8(
        &self,
        kind: u8,
        model_id: String,
        request_hash: Base64VecU8,
        response_hash: Base64VecU8,
    ) -> String {
        String::from_utf8(tee_text(kind, &model_id, &request_hash.0, &response_hash.0))
            .expect("utf8")
    }
}

/// Signed basis points earned by one intent over the duel. No intent, or one that expired before
/// `close_at`, scores 0. Integer order matters: multiply before divide, in i128.
fn pnl_bps(intent: Option<&Intent>, close_at: u64, open: u64, close: u64) -> i64 {
    let Some(i) = intent else { return 0 };
    if i.expires_at.0 < close_at {
        return 0;
    }
    let sign: i128 = if i.side == Side::Long { 1 } else { -1 };
    let v = sign * (close as i128 - open as i128) * i.size_bps as i128 / open as i128;
    v as i64
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
