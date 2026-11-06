//! Sandbox-only caller: makes the two cross-contract round trips the arena's verified settlement
//! makes against `intents.near` (here the stub), with the same guards, so their gas and failure
//! paths are measured before the arena carries them.
//! - `claim`: `mt_batch_balance_of(self, [token])`, then a `#[private]` callback accepts
//!   `amount_out` only if the balance covers everything already accounted plus this claim, and
//!   only if no outflow confirmed while the view was in flight (`outflow_seq`).
//! - `pay_out`: `mt_transfer` with 1 yoctoNEAR, reserved before the call, confirmed or released in
//!   a `#[private]` callback.
//!
//! Callbacks never panic: a failed or malformed view is a rejected claim, a failed transfer
//! releases the reservation.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, env, ext_contract, near, require,
};

/// Longest `mt_batch_balance_of` answer for one token: `["<u128>"]`.
const MAX_VIEW_BYTES: usize = 64;

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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Probe {
    intents: AccountId,
    /// Balance on `intents` already credited to someone; a claim must be backed by the excess.
    accounted: LookupMap<String, u128>,
    /// Reserved by `pay_out`, not yet confirmed.
    pending_out: LookupMap<String, u128>,
    /// Bumped when an outflow confirms; a claim whose view predates the bump is rejected.
    outflow_seq: u64,
}

#[near]
impl Probe {
    #[init]
    pub fn new(intents: AccountId) -> Self {
        Self {
            intents,
            accounted: LookupMap::new(b"a"),
            pending_out: LookupMap::new(b"p"),
            outflow_seq: 0,
        }
    }

    pub fn claim(&mut self, token_id: String, amount_out: U128) -> Promise {
        ext_mt::ext(self.intents.clone())
            .with_static_gas(Gas::from_tgas(5))
            .mt_batch_balance_of(env::current_account_id(), vec![token_id.clone()])
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_claim(token_id, amount_out, self.outflow_seq),
            )
    }

    /// Returns whether the claim was accepted. Never panics.
    #[private]
    pub fn on_claim(&mut self, token_id: String, amount_out: U128, seq: u64) -> bool {
        let bal = env::promise_result_checked(0, MAX_VIEW_BYTES)
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice::<Vec<U128>>(&b).ok())
            .and_then(|v| v.first().map(|x| x.0));
        let Some(bal) = bal else {
            env::log_str("claim rejected: no receipt");
            return false;
        };
        if seq != self.outflow_seq {
            env::log_str("claim rejected: outflow during view, retry");
            return false;
        }
        let acc = self.accounted.get(&token_id).copied().unwrap_or(0);
        match acc.checked_add(amount_out.0).filter(|need| *need <= bal) {
            Some(next) => {
                self.accounted.insert(token_id, next);
                true
            }
            None => {
                env::log_str("claim rejected: no receipt");
                false
            }
        }
    }

    pub fn pay_out(&mut self, receiver_id: AccountId, token_id: String, amount: U128) -> Promise {
        let acc = self.accounted.get(&token_id).copied().unwrap_or(0);
        let pending = self.pending_out.get(&token_id).copied().unwrap_or(0);
        require!(amount.0 > 0 && pending + amount.0 <= acc, "over accounted");
        self.pending_out
            .insert(token_id.clone(), pending + amount.0);
        ext_mt::ext(self.intents.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(10))
            .mt_transfer(receiver_id, token_id.clone(), amount, None, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_pay_out(token_id, amount),
            )
    }

    /// Returns whether the transfer landed. Never panics.
    #[private]
    pub fn on_pay_out(&mut self, token_id: String, amount: U128) -> bool {
        let pending = self.pending_out.get(&token_id).copied().unwrap_or(0);
        self.pending_out
            .insert(token_id.clone(), pending.saturating_sub(amount.0));
        // `mt_transfer` returns nothing, so success is the receipt; a long answer is not one.
        if env::promise_result_checked(0, MAX_VIEW_BYTES).is_err() {
            return false;
        }
        let acc = self.accounted.get(&token_id).copied().unwrap_or(0);
        self.accounted
            .insert(token_id, acc.saturating_sub(amount.0));
        self.outflow_seq += 1;
        true
    }

    pub fn accounted(&self, token_id: String) -> U128 {
        U128(self.accounted.get(&token_id).copied().unwrap_or(0))
    }

    pub fn outflow_seq(&self) -> u64 {
        self.outflow_seq
    }
}
