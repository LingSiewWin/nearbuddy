//! Testnet and sandbox stand-in for the slice of `intents.near` that verified settlement uses.
//! There is no `intents.near` on testnet, so the arena points its `intents_account` here.
//!
//! Mirrors the NEP-245 surface of `intents.near` exactly as the arena calls it:
//! - `mt_balance_of(account_id, token_id) -> U128` and
//!   `mt_batch_balance_of(account_id, token_ids) -> Vec<U128>`: views, no deposit.
//! - `mt_transfer(receiver_id, token_id, amount, approval, memo)`: 1 yoctoNEAR, the sender is
//!   the predecessor, `approval` must be `None`.
//!
//! The one method `intents.near` does not have is `stub_credit`: it stands in for a solver's
//! swap landing in an account (on mainnet a signed `token_diff` plus `transfer` intent executed by
//! `execute_intents`, or an `ft_transfer_call` deposit). Only minters may call it (the solver),
//! added by the stub account itself with `add_minter`: an open `stub_credit` let anyone fake the
//! receipt the arena checks. Minters live in raw storage under `m || account_id`, outside the
//! contract struct, so this deploys over the live stub's state without a migration.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, assert_one_yocto, env, near, require};

#[near(contract_state)]
pub struct Contract {
    /// `"{account_id}:{token_id}"` to amount. Account ids never contain `:`, so the split is
    /// unambiguous even though token ids (`nep141:wrap.near`) do.
    balances: LookupMap<String, u128>,
}

impl Default for Contract {
    fn default() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
        }
    }
}

fn minter_key(account_id: &AccountId) -> Vec<u8> {
    [b"m".as_slice(), account_id.as_bytes()].concat()
}

fn key(account_id: &AccountId, token_id: &str) -> String {
    format!("{account_id}:{token_id}")
}

/// NEP-297 line in the NEP-245 shape, so an indexer pointed at the stub reads the same events.
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({"standard": "nep245", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

#[near]
impl Contract {
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.get(&account_id, &token_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .iter()
            .map(|t| U128(self.get(&account_id, t)))
            .collect()
    }

    /// Move the caller's balance. Same guards as `intents.near`: 1 yoctoNEAR, no approvals.
    /// Panics: "Requires attached deposit of exactly 1 yoctoNEAR", "approvals are not supported",
    /// "zero amount", "insufficient balance".
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approval.is_none(), "approvals are not supported");
        require!(amount.0 > 0, "zero amount");
        let sender = env::predecessor_account_id();
        let bal = self.get(&sender, &token_id);
        require!(bal >= amount.0, "insufficient balance");
        self.balances
            .insert(key(&sender, &token_id), bal - amount.0);
        let to = self.get(&receiver_id, &token_id);
        self.balances.insert(
            key(&receiver_id, &token_id),
            to.checked_add(amount.0).expect("balance overflow"),
        );
        emit(
            "mt_transfer",
            near_sdk::serde_json::json!({"old_owner_id": sender, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount], "memo": memo}),
        );
    }

    /// Stub only: credit `amount` of `token_id` to `receiver_id`, as a solver's swap landing would.
    /// Caller: a minter. Deposit: none. Panics: "not minter", "zero amount", "balance overflow".
    pub fn stub_credit(&mut self, receiver_id: AccountId, token_id: String, amount: U128) {
        require!(self.is_minter(env::predecessor_account_id()), "not minter");
        require!(amount.0 > 0, "zero amount");
        let to = self.get(&receiver_id, &token_id);
        self.balances.insert(
            key(&receiver_id, &token_id),
            to.checked_add(amount.0).expect("balance overflow"),
        );
        emit(
            "mt_mint",
            near_sdk::serde_json::json!({"owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount], "memo": "stub_credit"}),
        );
    }

    /// Allow `account_id` to `stub_credit`. Caller: the stub account itself (private). Deposit: none.
    #[private]
    pub fn add_minter(&mut self, account_id: AccountId) {
        env::storage_write(&minter_key(&account_id), &[]);
    }

    /// Stop `account_id` from crediting. Caller: the stub account itself (private). Deposit: none.
    #[private]
    pub fn remove_minter(&mut self, account_id: AccountId) {
        env::storage_remove(&minter_key(&account_id));
    }

    pub fn is_minter(&self, account_id: AccountId) -> bool {
        env::storage_has_key(&minter_key(&account_id))
    }

    fn get(&self, account_id: &AccountId, token_id: &str) -> u128 {
        self.balances
            .get(&key(account_id, token_id))
            .copied()
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::NearToken;
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::testing_env;

    const T: &str = "nep141:usdc.near";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    const STUB: &str = "stub.testnet";

    fn ctx(who: &str, yocto: u128) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc(STUB))
                .predecessor_account_id(acc(who))
                .attached_deposit(NearToken::from_yoctonear(yocto))
                .build()
        );
    }

    /// Stub with `solver.testnet` allowed to mint; the context is left on the solver.
    fn stub() -> Contract {
        ctx(STUB, 0);
        let mut c = Contract::default();
        c.add_minter(acc("solver.testnet"));
        ctx("solver.testnet", 0);
        c
    }

    #[test]
    #[should_panic(expected = "not minter")]
    fn outsider_cannot_credit() {
        // red team S1: anyone could fake the receipt the arena's settle checks
        let mut c = stub();
        ctx("redteam.testnet", 0);
        c.stub_credit(acc("arena.testnet"), T.into(), U128(1000));
    }

    #[test]
    #[should_panic(expected = "not minter")]
    fn removed_minter_cannot_credit() {
        let mut c = stub();
        assert!(c.is_minter(acc("solver.testnet")));
        ctx(STUB, 0);
        c.remove_minter(acc("solver.testnet"));
        assert!(!c.is_minter(acc("solver.testnet")));
        ctx("solver.testnet", 0);
        c.stub_credit(acc("arena.testnet"), T.into(), U128(1));
    }

    #[test]
    fn unknown_balance_is_zero() {
        ctx("anyone.testnet", 0);
        let c = Contract::default();
        assert_eq!(c.mt_balance_of(acc("arena.testnet"), T.into()).0, 0);
    }

    #[test]
    fn credit_then_views_agree() {
        let mut c = stub();
        c.stub_credit(acc("arena.testnet"), T.into(), U128(70));
        c.stub_credit(acc("arena.testnet"), T.into(), U128(30));
        assert_eq!(c.mt_balance_of(acc("arena.testnet"), T.into()).0, 100);
        let b = c.mt_batch_balance_of(
            acc("arena.testnet"),
            vec![T.into(), "nep141:wrap.near".into()],
        );
        assert_eq!(b.iter().map(|x| x.0).collect::<Vec<_>>(), vec![100, 0]);
        assert_eq!(
            get_logs()[0],
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{"owner_id":"arena.testnet","token_ids":["nep141:usdc.near"],"amounts":["70"],"memo":"stub_credit"}]}"#
        );
    }

    #[test]
    fn token_ids_with_colons_do_not_collide_across_accounts() {
        let mut c = stub();
        c.stub_credit(acc("a.testnet"), "nep141:x".into(), U128(1));
        assert_eq!(c.mt_balance_of(acc("a.testnet"), "nep141:x".into()).0, 1);
        assert_eq!(c.mt_balance_of(acc("a.testnet"), "nep141".into()).0, 0);
    }

    #[test]
    fn transfer_moves_the_predecessors_balance() {
        let mut c = stub();
        c.stub_credit(acc("arena.testnet"), T.into(), U128(100));
        ctx("arena.testnet", 1);
        c.mt_transfer(acc("follower.testnet"), T.into(), U128(40), None, None);
        assert_eq!(c.mt_balance_of(acc("arena.testnet"), T.into()).0, 60);
        assert_eq!(c.mt_balance_of(acc("follower.testnet"), T.into()).0, 40);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_without_one_yocto_panics() {
        ctx("arena.testnet", 0);
        let mut c = Contract::default();
        c.mt_transfer(acc("follower.testnet"), T.into(), U128(1), None, None);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn transfer_over_balance_panics() {
        let mut c = stub();
        c.stub_credit(acc("arena.testnet"), T.into(), U128(5));
        ctx("arena.testnet", 1);
        c.mt_transfer(acc("follower.testnet"), T.into(), U128(6), None, None);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn only_the_owner_can_move_a_balance() {
        let mut c = stub();
        c.stub_credit(acc("arena.testnet"), T.into(), U128(5));
        ctx("solver.testnet", 1);
        c.mt_transfer(acc("solver.testnet"), T.into(), U128(5), None, None);
    }

    #[test]
    #[should_panic(expected = "approvals are not supported")]
    fn transfer_with_approval_panics() {
        ctx("arena.testnet", 1);
        let mut c = Contract::default();
        c.mt_transfer(
            acc("follower.testnet"),
            T.into(),
            U128(1),
            Some((acc("x.testnet"), 0)),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "zero amount")]
    fn zero_credit_panics() {
        let mut c = stub();
        c.stub_credit(acc("arena.testnet"), T.into(), U128(0));
    }
}
