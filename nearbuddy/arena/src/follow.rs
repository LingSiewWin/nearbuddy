//! Follower vaults, mandates and solver settlement.
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{AccountId, NearToken, Promise, env, near, require};

use crate::{Contract, ContractExt, Fill, Mandate, SettleReport, nonce_key, storage_cost_since};

/// `agent_pk || follower || nonce_le`: one fill per intent per follower, scoped to the agent that
/// posted the intent so two agents using the same nonce never collide.
pub(crate) fn fill_key(agent_pk: &[u8], follower: &AccountId, nonce: u64) -> Vec<u8> {
    let mut k = agent_pk.to_vec();
    k.extend_from_slice(follower.as_bytes());
    k.extend_from_slice(&nonce.to_le_bytes());
    k
}

#[near]
impl Contract {
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
}
