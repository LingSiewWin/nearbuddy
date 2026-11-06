//! Follower vaults, mandates, solver settlement verified against `intents.near`, and the
//! follower holdings that settlement credits.
//!
//! A fill's output is delivered to this contract's own balance on `intents_account` (the solver
//! quotes with this contract as recipient). `settle_follow` reads that balance with
//! `mt_batch_balance_of` and `on_settle_follow` accepts a fill only if the balance not yet credited
//! to anyone (`balance - accounted`) covers its `amount_out`. Accepted output becomes the
//! follower's holding, withdrawn through `mt_transfer` by `withdraw_token`.
use std::collections::BTreeMap;

use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::{
    AccountId, Gas, NearToken, Promise, assert_one_yocto, env, ext_contract, near, require,
};

use crate::{
    Contract, ContractExt, Fill, Mandate, SettleReport, VersionedMandate, nonce_key,
    storage_cost_since,
};

/// Most fills one `settle_follow` carries, so the callback's gas is bounded.
pub const MAX_FILLS: usize = 10;
/// `mt_batch_balance_of` on `intents_account`. The stub burns 1.2 TGas; the real contract is
/// bigger, so the budget is generous. Unused gas is refunded.
const VIEW_GAS: Gas = Gas::from_tgas(20);
const TRANSFER_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// `on_sweep_check` schedules `mt_transfer` (10) and `on_sweep_done` (10) on top of its own work.
const SWEEP_CHECK_GAS: Gas = Gas::from_tgas(30);
const PER_FILL_GAS: u64 = 2;
/// Longest JSON one `U128` takes in a `Vec<U128>` answer (`"<39 digits>",`), with margin.
const BYTES_PER_BALANCE: usize = 64;
const YOCTO_PER_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

#[ext_contract(ext_mt)]
#[allow(dead_code)]
trait MultiToken {
    fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128>;
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

/// `agent_pk || follower || nonce_le`: one fill per intent per follower, scoped to the agent that
/// posted the intent so two agents using the same nonce never collide.
pub(crate) fn fill_key(agent_pk: &[u8], follower: &AccountId, nonce: u64) -> Vec<u8> {
    let mut k = follow_key(agent_pk, follower);
    k.extend_from_slice(&nonce.to_le_bytes());
    k
}

/// `follows` key: `agent_pk || follower`. Agent keys are 32 bytes, so the split is unambiguous.
pub(crate) fn follow_key(agent_pk: &[u8], follower: &AccountId) -> Vec<u8> {
    let mut k = agent_pk.to_vec();
    k.extend_from_slice(follower.as_bytes());
    k
}

/// `holdings` key: `"{follower}:{token_id}"`. Account ids never contain `:`.
pub(crate) fn holding_key(follower: &AccountId, token_id: &str) -> String {
    format!("{follower}:{token_id}")
}

/// `follow` / `unfollow` event; `list_followers` is rebuilt from these off chain.
pub(crate) fn follow_event(event: &str, agent_pk: &[u8], follower: &AccountId) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"{event}","data":{{"agent_pk":"{}","follower":"{follower}"}}}}"#,
        near_sdk::base64::Engine::encode(&near_sdk::base64::prelude::BASE64_STANDARD, agent_pk)
    ));
}

/// Token ids of a batch, first-seen order, no repeats.
fn distinct_tokens(fills: &[Fill]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for f in fills {
        if !out.contains(&f.token) {
            out.push(f.token.clone());
        }
    }
    out
}

#[near]
impl Contract {
    /// Follower locks NEAR here. Solvers are repaid from it only inside a mandate. A first deposit
    /// also pays for the vault record.
    /// Caller: anyone (follower). Deposit: the amount to lock, above a first vault record's
    /// storage. Panics: "paused", "deposit required", "vault cap".
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        self.not_paused();
        let before = env::storage_usage();
        let who = env::predecessor_account_id();
        let amt = env::attached_deposit().as_yoctonear();
        require!(amt > 0, "deposit required");
        require!(
            self.vault_total
                .checked_add(amt)
                .is_some_and(|t| t <= self.max_vault_total),
            "vault cap"
        );
        let bal = self.vaults.get(&who).copied().unwrap_or(0) + amt;
        self.vaults.insert(who.clone(), bal);
        self.vaults.flush();
        let cost = storage_cost_since(before);
        require!(amt > cost, "deposit required");
        let bal = bal - cost;
        self.vaults.insert(who, bal);
        self.vault_total += amt - cost;
        U128(bal)
    }

    /// Queue a vault withdrawal. `withdraw` pays it `withdraw_delay_s` later, so a solver that
    /// fronted a swap before this request can still settle it. One request at a time.
    /// Caller: the vault owner. Deposit: 1 yoctoNEAR. Panics: "Requires attached deposit of
    /// exactly 1 yoctoNEAR", "withdrawal already pending", "insufficient".
    #[payable]
    pub fn request_withdraw(&mut self, amount: U128) {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        require!(
            !self.pending_withdrawals.contains_key(&who),
            "withdrawal already pending"
        );
        let bal = self.vaults.get(&who).copied().unwrap_or(0);
        require!(amount.0 > 0 && amount.0 <= bal, "insufficient");
        let ready_at = env::block_timestamp() + self.withdraw_delay_ns;
        self.pending_withdrawals
            .insert(who.clone(), (amount.0, ready_at));
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"request_withdraw","data":{{"account":"{who}","amount":"{}","ready_at":{ready_at}}}}}"#,
            amount.0
        ));
    }

    /// Pay a queued withdrawal once its delay has passed: `min(requested, vault now)`, since
    /// fills settled during the delay may have lowered the vault. The vault is debited before the
    /// transfer; `on_withdraw` re-credits it and restores the request if the transfer fails (a
    /// deleted account), so the NEAR never sits in the contract unassigned.
    /// Caller: the vault owner. Deposit: 1 yoctoNEAR. Panics: "Requires attached deposit of
    /// exactly 1 yoctoNEAR", "no pending withdrawal", "withdrawal delay not elapsed".
    #[payable]
    pub fn withdraw(&mut self) -> Promise {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let (amount, ready_at) = self
            .pending_withdrawals
            .remove(&who)
            .unwrap_or_else(|| env::panic_str("no pending withdrawal"));
        require!(
            env::block_timestamp() >= ready_at,
            "withdrawal delay not elapsed"
        );
        let bal = self.vaults.get(&who).copied().unwrap_or(0);
        let pay = amount.min(bal);
        self.vaults.insert(who.clone(), bal - pay);
        self.vault_total = self.vault_total.saturating_sub(pay);
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(pay))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_withdraw(who, U128(pay), U128(amount), U64(ready_at)),
            )
    }

    /// Outcome of `withdraw`'s transfer. On failure the NEAR came back to this contract: the vault
    /// is re-credited with `pay` and the request (`amount`, `ready_at`) restored unless a new one was
    /// queued meanwhile. Returns whether the transfer landed. Never panics.
    /// Caller: this contract (private). Deposit: none.
    #[private]
    pub fn on_withdraw(&mut self, who: AccountId, pay: U128, amount: U128, ready_at: U64) -> bool {
        if env::promise_result_checked(0, BYTES_PER_BALANCE).is_ok() {
            return true;
        }
        let bal = self.vaults.get(&who).copied().unwrap_or(0);
        self.vaults.insert(who.clone(), bal.saturating_add(pay.0));
        self.vault_total = self.vault_total.saturating_add(pay.0);
        if !self.pending_withdrawals.contains_key(&who) {
            self.pending_withdrawals.insert(who, (amount.0, ready_at.0));
        }
        false
    }

    /// Attach (or replace) the caller's mandate for an agent. Only enclave-verified agents (TEE
    /// proof on every intent) can be followed. Storage is paid from the vault.
    /// Caller: a follower with a funded vault. Deposit: none; storage is debited from the
    /// vault. `min_out_per_near` must be set (clients derive it from the oracle mid less slippage), so
    /// a solver can never settle a fill for a token amount of output. `revoked_at` is reset to 0.
    /// Panics: "paused", "migrating", "agent missing", "agent unverified", "empty mandate",
    /// "price floor required", "insufficient".
    pub fn follow(&mut self, agent_pk: Base64VecU8, mandate: Mandate) {
        self.not_paused();
        self.not_migrating();
        require!(self.agents.contains_key(&agent_pk.0), "agent missing");
        require!(self.tee_agents.contains(&agent_pk.0), "agent unverified");
        require!(
            mandate.per_tx_cap.0 > 0 && mandate.allowance.0 > 0,
            "empty mandate"
        );
        require!(mandate.min_out_per_near.0 > 0, "price floor required");
        let mandate = Mandate {
            revoked_at: U64(0),
            ..mandate
        };
        let before = env::storage_usage();
        let who = env::predecessor_account_id();
        self.follows
            .insert(follow_key(&agent_pk.0, &who), VersionedMandate::V2(mandate));
        self.follows.flush();
        let cost = storage_cost_since(before);
        if cost > 0 {
            let bal = self.vaults.get(&who).copied().unwrap_or(0);
            require!(bal >= cost, "insufficient");
            self.vaults.insert(who.clone(), bal - cost);
            // the storage NEAR left the vault, so it leaves the counted total too (deploy 16)
            self.vault_total = self.vault_total.saturating_sub(cost);
        }
        follow_event("follow", &agent_pk.0, &who);
    }

    /// Revoke the caller's mandate for `agent_pk`; a no-op when there is none. Open while paused.
    /// Fills the solver fronted before now stay settleable for `withdraw_delay_s` (see `apply_fill`).
    /// Caller: the follower. Deposit: none. Panics: "migrating".
    pub fn unfollow(&mut self, agent_pk: Base64VecU8) {
        self.not_migrating();
        let who = env::predecessor_account_id();
        if let Some(v) = self.follows.get_mut(&follow_key(&agent_pk.0, &who)) {
            let m = v.current_mut();
            if !m.revoked {
                m.revoked = true;
                m.revoked_at = U64(env::block_timestamp());
            }
            follow_event("unfollow", &agent_pk.0, &who);
        }
    }

    /// Solver asks to be repaid for swaps it fronted for one follower of one agent. The swap
    /// outputs must already sit in this contract's balance on `intents_account`; this call reads
    /// that balance and `on_settle_follow` decides each fill. Nothing is written here.
    /// Caller: a registered solver. Deposit: none. Panics: "not solver", "paused", "migrating",
    /// "empty fills", "too many fills", "swap_tx length", "dry quote unsettleable",
    /// "token length". Per-fill outcomes: see `on_settle_follow`.
    pub fn settle_follow(
        &mut self,
        agent_pk: Base64VecU8,
        follower: AccountId,
        fills: Vec<Fill>,
    ) -> Promise {
        self.only_solver();
        self.not_paused();
        self.not_migrating();
        require!(!fills.is_empty(), "empty fills");
        require!(fills.len() <= MAX_FILLS, "too many fills");
        for f in &fills {
            require!(
                !f.swap_tx.is_empty() && f.swap_tx.len() <= 128,
                "swap_tx length"
            );
            require!(
                !f.swap_tx.starts_with("dry-quote:"),
                "dry quote unsettleable"
            );
            require!(!f.token.is_empty() && f.token.len() <= 128, "token length");
        }
        let gas = CALLBACK_GAS.saturating_add(Gas::from_tgas(PER_FILL_GAS * fills.len() as u64));
        ext_mt::ext(self.intents_account.clone())
            .with_static_gas(VIEW_GAS)
            .mt_batch_balance_of(env::current_account_id(), distinct_tokens(&fills))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(gas)
                    .on_settle_follow(
                        agent_pk,
                        follower,
                        env::predecessor_account_id(),
                        fills,
                        self.outflow_seq,
                    ),
            )
    }

    /// The balance answer for `settle_follow`. Each fill is checked against the follower's
    /// mandate and against the receipt: `amount_out` must be covered by this contract's balance of
    /// that token not yet credited to anyone. Accepted fills move `amount_in + fee` out of the
    /// follower's vault (`amount_in` to the solver's vault, the fee to the owner) and credit
    /// `amount_out` to the follower's holding.
    /// Batch-wide rejections: "no receipt" (view failed, too long, malformed), "outflow during
    /// view" (a token withdrawal confirmed meanwhile; retry), "solver removed". Per fill: "nonce
    /// unknown", "duplicate fill", "no mandate", "mandate revoked", "mandate expired",
    /// "token not allowed", "fee overflow", "over cap", "allowance exhausted", "amount overflow",
    /// "below min price", "no receipt", "insufficient".
    /// When no fill settles the call panics with the first reason, so a batch without a receipt is
    /// a failed transaction. That panic is safe: rejections write nothing and nothing was reserved
    /// before the view. A partly settled batch returns the report.
    /// Caller: this contract (private). Deposit: none.
    #[private]
    pub fn on_settle_follow(
        &mut self,
        agent_pk: Base64VecU8,
        follower: AccountId,
        solver: AccountId,
        fills: Vec<Fill>,
        seq: u64,
    ) -> SettleReport {
        let tokens = distinct_tokens(&fills);
        let balances = env::promise_result_checked(0, BYTES_PER_BALANCE * tokens.len())
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice::<Vec<U128>>(&b).ok())
            .filter(|v| v.len() == tokens.len());
        let batch_err = match &balances {
            None => Some("no receipt"),
            Some(_) if seq != self.outflow_seq => Some("outflow during view"),
            Some(_) if !self.solvers.contains(&solver) => Some("solver removed"),
            Some(_) => None,
        };
        let mut surplus: BTreeMap<String, u128> = tokens
            .iter()
            .zip(balances.unwrap_or_default())
            .map(|(t, b)| {
                let acc = self.accounted.get(t).copied().unwrap_or(0);
                let out = self.sweeping.get(t).copied().unwrap_or(0);
                (t.clone(), b.0.saturating_sub(acc).saturating_sub(out))
            })
            .collect();
        let now = env::block_timestamp();
        let mut report = SettleReport {
            settled: 0,
            debited: U128(0),
            rejected: vec![],
        };
        for (i, f) in fills.iter().enumerate() {
            let r = match batch_err {
                Some(e) => Err(e),
                None => self.apply_fill(&agent_pk.0, &follower, &solver, f, now, &mut surplus),
            };
            match r {
                Ok(debited) => {
                    report.settled += 1;
                    report.debited = U128(report.debited.0 + debited);
                }
                Err(reason) => report.rejected.push((i as u32, reason.into())),
            }
        }
        if report.settled == 0 {
            env::panic_str(&report.rejected[0].1);
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
        surplus: &mut BTreeMap<String, u128>,
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
        // a swap fronted while the mandate was live may land after an unfollow or the expiry: it stays
        // settleable for the same delay a vault withdrawal waits, then the mandate is closed
        let grace = self.withdraw_delay_ns;
        let m = self
            .follows
            .get_mut(&follow_key(agent_pk, follower))
            .ok_or("no mandate")?
            .current_mut();
        if m.revoked && now >= m.revoked_at.0.saturating_add(grace) {
            return Err("mandate revoked");
        }
        if now >= m.expires_at.0.saturating_add(grace) {
            return Err("mandate expired");
        }
        if !m.allowed_tokens.is_empty() && !m.allowed_tokens.contains(&f.token) {
            return Err("token not allowed");
        }
        // checked: `amount_in` is solver-supplied, so one absurd fill must not panic the batch
        let fee = f
            .amount_in
            .0
            .checked_mul(self.fee_bps as u128)
            .ok_or("fee overflow")?
            / 10_000;
        let debit = f.amount_in.0.checked_add(fee).ok_or("fee overflow")?;
        if debit > m.per_tx_cap.0 {
            return Err("over cap");
        }
        // checked: `spent` is follower-supplied, so one absurd mandate must not panic the batch
        let spent = m
            .spent
            .0
            .checked_add(debit)
            .filter(|s| *s <= m.allowance.0)
            .ok_or("allowance exhausted")?;
        if m.min_out_per_near.0 > 0 {
            let got = f.amount_out.0.checked_mul(YOCTO_PER_NEAR);
            let floor = f.amount_in.0.checked_mul(m.min_out_per_near.0);
            let (Some(got), Some(floor)) = (got, floor) else {
                return Err("amount overflow");
            };
            if got < floor {
                return Err("below min price");
            }
        }
        let avail = surplus.get(&f.token).copied().unwrap_or(0);
        if f.amount_out.0 == 0 || f.amount_out.0 > avail {
            return Err("no receipt");
        }
        let bal = self.vaults.get(follower).copied().unwrap_or(0);
        if bal < debit {
            return Err("insufficient");
        }
        m.spent = U128(spent);
        self.vaults.insert(follower.clone(), bal - debit);
        let sbal = self.vaults.get(solver).copied().unwrap_or(0);
        self.vaults.insert(solver.clone(), sbal + f.amount_in.0);
        self.owner_fees += fee;
        self.vault_total = self.vault_total.saturating_sub(fee);
        self.settled_fills.insert(fkey);
        surplus.insert(f.token.clone(), avail - f.amount_out.0);
        let acc = self.accounted.get(&f.token).copied().unwrap_or(0);
        self.accounted.insert(f.token.clone(), acc + f.amount_out.0);
        let hk = holding_key(follower, &f.token);
        let h = self.holdings.get(&hk).copied().unwrap_or(0);
        self.holdings.insert(hk, h + f.amount_out.0);
        Ok(debit)
    }

    /// Send the caller's credited output to their own account on `intents_account`. The holding
    /// is debited first; `on_withdraw_token` re-credits it if the transfer fails. Open while
    /// paused. Caller: a follower. Deposit: 1 yoctoNEAR (forwarded to `mt_transfer`). Panics:
    /// "Requires attached deposit of exactly 1 yoctoNEAR", "insufficient".
    #[payable]
    pub fn withdraw_token(&mut self, token_id: String, amount: U128) -> Promise {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let hk = holding_key(&who, &token_id);
        let bal = self.holdings.get(&hk).copied().unwrap_or(0);
        require!(amount.0 > 0 && amount.0 <= bal, "insufficient");
        self.holdings.insert(hk, bal - amount.0);
        ext_mt::ext(self.intents_account.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(TRANSFER_GAS)
            .mt_transfer(
                who.clone(),
                token_id.clone(),
                amount,
                None,
                Some("nearbuddy".into()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_withdraw_token(who, token_id, amount),
            )
    }

    /// Outcome of `withdraw_token`'s `mt_transfer`. Success: the tokens left this contract's
    /// balance, so `accounted` drops and `outflow_seq` moves (settles whose view predates this
    /// are rejected). Failure: the holding is re-credited. Returns whether the transfer landed.
    /// Never panics. Caller: this contract (private). Deposit: none.
    #[private]
    pub fn on_withdraw_token(
        &mut self,
        follower: AccountId,
        token_id: String,
        amount: U128,
    ) -> bool {
        // `mt_transfer` returns nothing, so success is the receipt; a long answer is not one.
        if env::promise_result_checked(0, BYTES_PER_BALANCE).is_err() {
            let hk = holding_key(&follower, &token_id);
            let h = self.holdings.get(&hk).copied().unwrap_or(0);
            self.holdings.insert(hk, h.saturating_add(amount.0));
            return false;
        }
        let acc = self.accounted.get(&token_id).copied().unwrap_or(0);
        self.accounted
            .insert(token_id.clone(), acc.saturating_sub(amount.0));
        self.outflow_seq += 1;
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"withdraw_token","data":{{"account":"{follower}","token_id":{},"amount":"{}"}}}}"#,
            near_sdk::serde_json::to_string(&token_id).unwrap_or_default(),
            amount.0
        ));
        true
    }

    /// Send output nobody can claim (a fill refused after its swap landed, a gift) out of this
    /// contract's `intents_account` balance. Bounded to `balance - accounted - sweeping`, read through
    /// the same view the settle reads, so credited holdings are never touched.
    /// Caller: owner. Deposit: 1 yoctoNEAR (forwarded to `mt_transfer`). Panics: "not owner",
    /// "Requires attached deposit of exactly 1 yoctoNEAR", "zero amount".
    #[payable]
    pub fn sweep_surplus(
        &mut self,
        token_id: String,
        receiver_id: AccountId,
        amount: U128,
    ) -> Promise {
        self.only_owner_yocto();
        require!(amount.0 > 0, "zero amount");
        ext_mt::ext(self.intents_account.clone())
            .with_static_gas(VIEW_GAS)
            .mt_batch_balance_of(env::current_account_id(), vec![token_id.clone()])
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SWEEP_CHECK_GAS)
                    .on_sweep_check(token_id, receiver_id, amount, self.outflow_seq),
            )
    }

    /// Balance answer for `sweep_surplus`. With the surplus confirmed (and no outflow since the view)
    /// the amount is reserved in `sweeping` before the transfer is scheduled, so a settle landing
    /// meanwhile cannot credit it. Returns false, and changes nothing, when the surplus is short or
    /// the view failed. Caller: this contract (private).
    #[private]
    pub fn on_sweep_check(
        &mut self,
        token_id: String,
        receiver_id: AccountId,
        amount: U128,
        seq: u64,
    ) -> near_sdk::PromiseOrValue<bool> {
        let bal = env::promise_result_checked(0, BYTES_PER_BALANCE)
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice::<Vec<U128>>(&b).ok())
            .and_then(|v| (v.len() == 1).then(|| v[0].0));
        let acc = self.accounted.get(&token_id).copied().unwrap_or(0);
        let out = self.sweeping.get(&token_id).copied().unwrap_or(0);
        let free = bal.map(|b| b.saturating_sub(acc).saturating_sub(out));
        if seq != self.outflow_seq || free.is_none_or(|f| amount.0 > f) {
            env::log_str("sweep refused: no such surplus");
            return near_sdk::PromiseOrValue::Value(false);
        }
        self.sweeping.insert(token_id.clone(), out + amount.0);
        ext_mt::ext(self.intents_account.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(TRANSFER_GAS)
            .mt_transfer(
                receiver_id.clone(),
                token_id.clone(),
                amount,
                None,
                Some("nearbuddy sweep".into()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_sweep_done(token_id, receiver_id, amount),
            )
            .into()
    }

    /// Outcome of the sweep's `mt_transfer`: the reservation is released either way; success moves
    /// `outflow_seq` like any outflow. Never panics. Caller: this contract (private).
    #[private]
    pub fn on_sweep_done(
        &mut self,
        token_id: String,
        receiver_id: AccountId,
        amount: U128,
    ) -> bool {
        let out = self.sweeping.get(&token_id).copied().unwrap_or(0);
        self.sweeping
            .insert(token_id.clone(), out.saturating_sub(amount.0));
        if env::promise_result_checked(0, BYTES_PER_BALANCE).is_err() {
            return false;
        }
        self.outflow_seq += 1;
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"sweep_surplus","data":{{"receiver":"{receiver_id}","token_id":{},"amount":"{}"}}}}"#,
            near_sdk::serde_json::to_string(&token_id).unwrap_or_default(),
            amount.0
        ));
        true
    }
}
