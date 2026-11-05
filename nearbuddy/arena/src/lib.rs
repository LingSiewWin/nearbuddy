//! NearBuddy arena.
//!
//! Model-backed agents (an ed25519 key plus a NEAR AI Cloud model id) post a bond and duel on live
//! prices. Spectators pay to inject chaos at one agent. At `close_at` an oracle-signed resolution
//! scores both agents, slashes the loser's bond into the pool and pays the pool to the winner.
//! Followers never hand an agent funds: they deposit here and attach a mandate (per-trade cap,
//! token allowlist, expiry, revoke); a registered solver fronts the swap through NEAR Intents and
//! is repaid from the follower's vault only inside that mandate.
//!
//! Everything here is testnet NEAR. The only real-money leg is the solver's mainnet swap.
mod types;
pub use types::*;

#[cfg(test)]
mod tests;

use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

pub const INTENT_DOMAIN: &[u8] = b"nearbuddy-intent-v1";
pub const RESOLVE_DOMAIN: &[u8] = b"nearbuddy-resolve-v1";
/// Cap on `Duel.injections` so a duel record cannot grow without bound.
pub const MAX_INJECTIONS: usize = 32;

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
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    oracle_pk: Vec<u8>,
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
    /// `follower || nonce_le` of every settled fill.
    settled_fills: LookupSet<Vec<u8>>,
    owner_fees: u128,
}

pub fn intent_message(i: &Intent) -> Vec<u8> {
    let mut out = INTENT_DOMAIN.to_vec();
    out.extend(near_sdk::borsh::to_vec(i).expect("borsh"));
    out
}

pub fn resolution_message(r: &Resolution) -> Vec<u8> {
    let mut out = RESOLVE_DOMAIN.to_vec();
    out.extend(near_sdk::borsh::to_vec(r).expect("borsh"));
    out
}

fn nonce_key(pk: &[u8], nonce: u64) -> Vec<u8> {
    let mut k = pk.to_vec();
    k.extend_from_slice(&nonce.to_le_bytes());
    k
}

fn fill_key(follower: &AccountId, nonce: u64) -> Vec<u8> {
    let mut k = follower.as_bytes().to_vec();
    k.extend_from_slice(&nonce.to_le_bytes());
    k
}

fn verify(pk: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk), <[u8; 64]>::try_from(sig)) else {
        return false;
    };
    env::ed25519_verify(&sig, msg, &pk)
}

#[near]
impl Contract {
    /// `owner` runs duels (the solver account in the hackathon deploy). `oracle_pk` signs
    /// resolutions. `slash_bps` of the loser's bond moves to the pool. `fee_bps` is charged on top
    /// of every settled fill and accrues to the owner.
    #[init]
    pub fn init(
        owner: AccountId,
        oracle_pk: Base64VecU8,
        slash_bps: u16,
        fee_bps: u16,
        min_chaos_deposit: U128,
    ) -> Self {
        require!(oracle_pk.0.len() == 32, "oracle_pk length");
        require!(slash_bps <= 10_000 && fee_bps <= 1_000, "bps out of range");
        Self {
            owner,
            oracle_pk: oracle_pk.0,
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
        }
    }

    // ---------------------------------------------------------------- config

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "not owner");
    }

    fn only_solver(&self) {
        require!(self.solvers.contains(&env::predecessor_account_id()), "not solver");
    }

    pub fn set_oracle_key(&mut self, pk: Base64VecU8) {
        self.only_owner();
        require!(pk.0.len() == 32, "oracle_pk length");
        self.oracle_pk = pk.0;
    }

    pub fn add_solver(&mut self, account_id: AccountId) {
        self.only_owner();
        self.solvers.insert(account_id);
    }

    // ---------------------------------------------------------------- agents

    /// Register an agent. The attached deposit is its bond.
    #[payable]
    pub fn register_agent(&mut self, agent_pk: Base64VecU8, model_id: String) -> Agent {
        require!(agent_pk.0.len() == 32, "agent_pk length");
        require!(!self.agents.contains_key(&agent_pk.0), "agent exists");
        let bond = env::attached_deposit().as_yoctonear();
        require!(bond > 0, "bond required");
        let agent = Agent {
            owner: env::predecessor_account_id(),
            pk: agent_pk.clone(),
            model_id,
            bond: U128(bond),
            alpha_bps: 0,
            shield: 0,
            in_duel: None,
        };
        self.agents.insert(agent_pk.0, agent.clone());
        agent
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

    /// Pair two registered, idle agents. Returns the duel id.
    pub fn open_duel(&mut self, a: Base64VecU8, b: Base64VecU8, symbol: String, close_at: U64) -> U64 {
        self.only_owner();
        require!(a.0 != b.0, "same agent");
        require!(close_at.0 > env::block_timestamp(), "close_at in the past");
        let id = self.next_duel;
        for pk in [&a.0, &b.0] {
            let agent = self.agents.get_mut(pk).expect("agent missing");
            require!(agent.in_duel.is_none(), "in duel");
            agent.in_duel = Some(U64(id));
        }
        self.duels.insert(
            id,
            Duel {
                id: U64(id),
                a,
                b,
                symbol,
                open_at: U64(env::block_timestamp()),
                close_at,
                pool: U128(0),
                injections: vec![],
                resolved: false,
                last_intent_a: None,
                last_intent_b: None,
            },
        );
        self.next_duel += 1;
        U64(id)
    }

    /// Record an agent-signed intent for an open duel. Submitted by the solver on the agent's
    /// behalf; the signature is what binds the decision to the agent.
    pub fn post_intent(&mut self, signed: SignedIntent) {
        self.only_solver();
        let i = &signed.intent;
        require!(i.agent_pk.0.len() == 32, "agent_pk length");
        require!(i.proof_hash.0.len() == 32, "proof_hash length");
        require!(i.size_bps >= 1 && i.size_bps <= 10_000, "bad size");
        let duel = self.duels.get_mut(&i.duel_id.0).expect("duel missing");
        require!(!duel.resolved && env::block_timestamp() < duel.close_at.0, "duel closed");
        let slot = if i.agent_pk.0 == duel.a.0 {
            &mut duel.last_intent_a
        } else if i.agent_pk.0 == duel.b.0 {
            &mut duel.last_intent_b
        } else {
            env::panic_str("bad target")
        };
        let key = nonce_key(&i.agent_pk.0, i.nonce.0);
        require!(!self.used_nonces.contains(&key), "nonce used");
        require!(verify(&i.agent_pk.0, &intent_message(i), &signed.signature.0), "bad signature");
        *slot = Some(i.clone());
        self.used_nonces.insert(key);
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.0.0","event":"intent","data":{{"duel_id":{},"agent_pk":"{}","side":"{:?}","size_bps":{},"nonce":{}}}}}"#,
            i.duel_id.0,
            near_sdk::base64::Engine::encode(&near_sdk::base64::prelude::BASE64_STANDARD, &i.agent_pk.0),
            i.side,
            i.size_bps,
            i.nonce.0
        ));
    }

    // ---------------------------------------------------------------- chaos and resolve

    /// Spectator pays to attack one agent in an open duel. Only the hash goes on chain; the solver
    /// delivers the payload to the runner. Deposit joins the duel pool.
    #[payable]
    pub fn inject_chaos(&mut self, duel_id: U64, target: Base64VecU8, kind: String, payload_hash: Base64VecU8) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.min_chaos_deposit, "chaos deposit too small");
        require!(payload_hash.0.len() == 32, "payload_hash length");
        let duel = self.duels.get_mut(&duel_id.0).expect("duel missing");
        require!(!duel.resolved && env::block_timestamp() < duel.close_at.0, "duel closed");
        require!(target.0 == duel.a.0 || target.0 == duel.b.0, "bad target");
        require!(duel.injections.len() < MAX_INJECTIONS, "chaos full");
        duel.pool = U128(duel.pool.0 + deposit);
        duel.injections.push(Injection { kind, payload_hash, target, block: U64(env::block_height()) });
    }

    /// Oracle-signed close. Scores both agents, slashes the loser into the pool, pays the pool to
    /// the winner, counts the injections the winner survived, frees both agents.
    pub fn resolve(&mut self, resolution: Resolution, oracle_sig: Base64VecU8) {
        self.only_solver();
        require!(verify(&self.oracle_pk, &resolution_message(&resolution), &oracle_sig.0), "bad signature");
        let duel = self.duels.get_mut(&resolution.duel_id.0).expect("duel missing");
        require!(!duel.resolved, "resolved");
        require!(env::block_timestamp() >= duel.close_at.0, "duel open");
        let close_at = duel.close_at.0;
        let pnl_a = pnl_bps(duel.last_intent_a.as_ref(), close_at, resolution.open_price.0, resolution.close_price.0);
        let pnl_b = pnl_bps(duel.last_intent_b.as_ref(), close_at, resolution.open_price.0, resolution.close_price.0);
        let (pk_a, pk_b) = (duel.a.0.clone(), duel.b.0.clone());
        let mut pool = duel.pool.0;
        let injections = duel.injections.clone();
        duel.resolved = true;
        duel.pool = U128(0);

        let slash_bps = self.slash_bps as u128;
        {
            let a = self.agents.get_mut(&pk_a).expect("agent missing");
            a.alpha_bps += pnl_a;
            a.in_duel = None;
        }
        {
            let b = self.agents.get_mut(&pk_b).expect("agent missing");
            b.alpha_bps += pnl_b;
            b.in_duel = None;
        }
        if pnl_a == pnl_b {
            let half = pool / 2;
            self.agents.get_mut(&pk_a).unwrap().bond.0 += half + pool % 2;
            self.agents.get_mut(&pk_b).unwrap().bond.0 += half;
        } else {
            let (winner, loser) = if pnl_a > pnl_b { (&pk_a, &pk_b) } else { (&pk_b, &pk_a) };
            let l = self.agents.get_mut(loser).unwrap();
            let slashed = l.bond.0 * slash_bps / 10_000;
            l.bond.0 -= slashed;
            pool += slashed;
            let survived = injections.iter().filter(|i| i.target.0 == *winner).count() as u32;
            let w = self.agents.get_mut(winner).unwrap();
            w.bond.0 += pool;
            w.shield += survived;
        }
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.0.0","event":"resolve","data":{{"duel_id":{},"pnl_a":{pnl_a},"pnl_b":{pnl_b},"open":{},"close":{}}}}}"#,
            resolution.duel_id.0, resolution.open_price.0, resolution.close_price.0
        ));
    }

    // ---------------------------------------------------------------- followers

    /// Follower locks NEAR here. Solvers are repaid from it only inside a mandate.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        let amt = env::attached_deposit().as_yoctonear();
        require!(amt > 0, "deposit required");
        let bal = self.vaults.get(&who).copied().unwrap_or(0) + amt;
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

    /// Attach (or replace) the caller's mandate for an agent.
    pub fn follow(&mut self, agent_pk: Base64VecU8, mandate: Mandate) {
        require!(self.agents.contains_key(&agent_pk.0), "agent missing");
        require!(mandate.per_tx_cap.0 > 0 && mandate.allowance.0 > 0, "empty mandate");
        let who = env::predecessor_account_id();
        let list = self.follows.entry(agent_pk.0).or_default();
        match list.iter_mut().find(|(f, _)| *f == who) {
            Some(slot) => slot.1 = mandate,
            None => list.push((who, mandate)),
        }
    }

    pub fn unfollow(&mut self, agent_pk: Base64VecU8) {
        let who = env::predecessor_account_id();
        if let Some(slot) = self.follows.get_mut(&agent_pk.0).and_then(|l| l.iter_mut().find(|(f, _)| *f == who)) {
            slot.1.revoked = true;
        }
    }

    /// Solver reports swaps it fronted for one follower of one agent. Each fill is checked against
    /// the follower's mandate; accepted fills move `amount_in` from the follower's vault to the
    /// solver's and `amount_in * fee_bps / 10_000` to the owner. Rejections are reported, not
    /// panicked, so one bad fill never blocks the batch.
    pub fn settle_follow(&mut self, agent_pk: Base64VecU8, follower: AccountId, fills: Vec<Fill>) -> SettleReport {
        self.only_solver();
        let solver = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut report = SettleReport { settled: 0, debited: U128(0), rejected: vec![] };
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

    fn apply_fill(&mut self, agent_pk: &[u8], follower: &AccountId, solver: &AccountId, f: &Fill, now: u64) -> Result<u128, &'static str> {
        if !self.used_nonces.contains(&nonce_key(agent_pk, f.intent_nonce.0)) {
            return Err("nonce unknown");
        }
        let fkey = fill_key(follower, f.intent_nonce.0);
        if self.settled_fills.contains(&fkey) {
            return Err("duplicate fill");
        }
        let list = self.follows.get_mut(agent_pk).ok_or("no mandate")?;
        let (_, m) = list.iter_mut().find(|(who, _)| who == follower).ok_or("no mandate")?;
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
        if m.spent.0 + f.amount_in.0 > m.allowance.0 {
            return Err("allowance exhausted");
        }
        let fee = f.amount_in.0 * self.fee_bps as u128 / 10_000;
        let debit = f.amount_in.0 + fee;
        let bal = self.vaults.get(follower).copied().unwrap_or(0);
        if bal < debit {
            return Err("insufficient");
        }
        m.spent = U128(m.spent.0 + f.amount_in.0);
        self.vaults.insert(follower.clone(), bal - debit);
        let sbal = self.vaults.get(solver).copied().unwrap_or(0);
        self.vaults.insert(solver.clone(), sbal + f.amount_in.0);
        self.owner_fees += fee;
        self.settled_fills.insert(fkey);
        Ok(debit)
    }

    // ---------------------------------------------------------------- views

    pub fn get_vault(&self, account: AccountId) -> U128 {
        U128(self.vaults.get(&account).copied().unwrap_or(0))
    }

    pub fn get_follow(&self, agent_pk: Base64VecU8, follower: AccountId) -> Option<Mandate> {
        self.follows.get(&agent_pk.0)?.iter().find(|(f, _)| *f == follower).map(|(_, m)| m.clone())
    }

    pub fn list_followers(&self, agent_pk: Base64VecU8) -> Vec<(AccountId, Mandate)> {
        self.follows.get(&agent_pk.0).cloned().unwrap_or_default()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            oracle_pk: Base64VecU8(self.oracle_pk.clone()),
            slash_bps: self.slash_bps,
            fee_bps: self.fee_bps,
            min_chaos_deposit: U128(self.min_chaos_deposit),
            next_duel: U64(self.next_duel),
        }
    }

    pub fn get_agent(&self, agent_pk: Base64VecU8) -> Option<Agent> {
        self.agents.get(&agent_pk.0).cloned()
    }

    pub fn get_duel(&self, duel_id: U64) -> Option<Duel> {
        self.duels.get(&duel_id.0).cloned()
    }

    /// Agents sorted by alpha, then shield, descending.
    pub fn leaderboard(&self) -> Vec<Agent> {
        let mut v: Vec<Agent> = self.agents.values().cloned().collect();
        v.sort_by(|x, y| (y.alpha_bps, y.shield).cmp(&(x.alpha_bps, x.shield)));
        v
    }

    pub fn intent_message_hex(&self, intent: Intent) -> String {
        hex(&intent_message(&intent))
    }

    pub fn resolution_message_hex(&self, resolution: Resolution) -> String {
        hex(&resolution_message(&resolution))
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
