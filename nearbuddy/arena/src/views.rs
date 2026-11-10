//! Read-only views and the signing-helper views off-chain code uses for parity checks.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::{AccountId, env, near};

use crate::{
    Agent, AgentView, COMMIT_MESSAGE_VERSION, Config, Contract, ContractExt, Duel, Intent, Mandate,
    PrevTerms, commit_bytes, commit_bytes_v2, consent_bytes,
    follow::{follow_key, holding_key},
    hex, intent_message, register_bytes, tee_text,
};

#[near]
impl Contract {
    pub(crate) fn view_of(&self, a: &Agent) -> AgentView {
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

    /// Vault balance in yoctoNEAR, 0 for an unknown account. View: anyone, no deposit, no panics.
    pub fn get_vault(&self, account: AccountId) -> U128 {
        U128(self.vaults.get(&account).copied().unwrap_or(0))
    }

    /// The follower's mandate for an agent, if any. Followers per agent are not enumerable on
    /// chain: index the `follow` / `unfollow` events.
    /// View: anyone, no deposit. Panics: "migrating".
    pub fn get_follow(&self, agent_pk: Base64VecU8, follower: AccountId) -> Option<Mandate> {
        self.not_migrating();
        self.follows
            .get(&follow_key(&agent_pk.0, &follower))
            .map(|v| v.current().clone())
    }

    /// The terms before the follower's last tightening update for `agent_pk`: `{terms, updated_at,
    /// binds_until}` (unix ns); `None` if no update tightened a term since the follow (or since a
    /// re-follow that opened a fresh window). Fills for intents accepted before `updated_at` are
    /// judged by `terms` until `binds_until`, then refused ("mandate updated"); later intents by
    /// `get_follow`. The view keeps returning them after `binds_until`. `terms.spent` is the
    /// snapshot at the update and is not used: the ledger is `get_follow`'s `spent`.
    /// View: anyone, no deposit. Panics: "migrating".
    pub fn get_follow_prev(&self, agent_pk: Base64VecU8, follower: AccountId) -> Option<PrevTerms> {
        self.not_migrating();
        self.follows
            .get(&follow_key(&agent_pk.0, &follower))
            .and_then(|v| v.prev().cloned())
    }

    /// Start of `follower`'s current follow window for `agent_pk` (unix ns): fills for intents
    /// accepted from then on pass the follow-time rule. `None` with no mandate or one stored before
    /// deploy 16 (no follow time). A re-follow inside a closed window's grace also keeps that
    /// window's intents settleable until the grace ends (see `VersionedMandate::refollowed`).
    /// View: anyone, no deposit, no panics.
    pub fn get_follow_time(&self, agent_pk: Base64VecU8, follower: AccountId) -> Option<U64> {
        self.follows
            .get(&follow_key(&agent_pk.0, &follower))
            .and_then(|v| v.followed_at())
            .map(U64)
    }

    /// When the agent's intent `nonce` was accepted (unix ns); 0 for one accepted before deploy 16
    /// (time not recorded); `None` if it never was. `settle_follow` compares it with the mandate's
    /// follow time, revoke and expiry. View: anyone, no deposit, no panics.
    pub fn intent_accepted_at(&self, agent_pk: Base64VecU8, nonce: U64) -> Option<U64> {
        self.accepted_at(&crate::nonce_key(&agent_pk.0, nonce.0))
            .map(U64)
    }

    /// Fill output credited to `follower` in `token_id` and not yet withdrawn.
    /// View: anyone, no deposit, no panics.
    pub fn get_holding(&self, follower: AccountId, token_id: String) -> U128 {
        U128(
            self.holdings
                .get(&holding_key(&follower, &token_id))
                .copied()
                .unwrap_or(0),
        )
    }

    /// This contract's `intents_account` balance of `token_id` already credited to holdings.
    /// View: anyone, no deposit, no panics.
    pub fn get_accounted(&self, token_id: String) -> U128 {
        U128(self.accounted.get(&token_id).copied().unwrap_or(0))
    }

    /// `(amount, ready_at_ns)` of the account's queued vault withdrawal, if any.
    /// View: anyone, no deposit, no panics.
    pub fn get_pending_withdraw(&self, account: AccountId) -> Option<(U128, U64)> {
        self.pending_withdrawals
            .get(&account)
            .map(|(a, t)| (U128(*a), U64(*t)))
    }

    /// Owner, oracle and fee settings plus the next duel id. View: anyone, no deposit, no panics.
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
            open_duels: self.open_duels,
            owner_fees: U128(self.owner_fees),
            commit_reveal: self.commit_reveal,
            no_reveal_bps: self.no_reveal_bps,
            require_consent: self.require_consent,
            intents_account: self.intents_account.clone(),
            withdraw_delay_s: self.withdraw_delay_ns / 1_000_000_000,
            paused: self.paused,
            max_vault_total: U128(self.max_vault_total),
            max_vault_per_account: U128(self.max_vault_per_account),
            vault_total: U128(self.vault_total),
            migrating: self.follows_cursor.is_some(),
            chaos: self.chaos_config,
        }
    }

    /// Agent record plus whether it is TEE-bound; `None` for an unknown key. View: anyone, no
    /// deposit, no panics.
    pub fn get_agent(&self, agent_pk: Base64VecU8) -> Option<AgentView> {
        self.agents.get(&agent_pk.0).map(|a| self.view_of(a))
    }

    /// Whether an enclave key is accepted as `TeeProof.signer`. View: anyone, no deposit, no
    /// panics.
    pub fn is_tee_signer(&self, signer: Base64VecU8) -> bool {
        self.tee_signers.contains(&signer.0)
    }

    /// Full duel record; `None` for an unknown id. View: anyone, no deposit, no panics.
    pub fn get_duel(&self, duel_id: U64) -> Option<Duel> {
        self.duels.get(&duel_id.0).cloned()
    }

    /// The intent lock duel `duel_id` runs (or ran) under, in nanoseconds: no intent lands in its
    /// last `duel_lock` before `close_at`. From deploy 15 this is the value stored when the duel
    /// opened, kept after it finishes; for a duel opened earlier it is today's global lock, since
    /// those duels read the global value. `None` for an unknown duel.
    /// View: anyone, no deposit, no panics.
    pub fn duel_lock(&self, duel_id: U64) -> Option<U64> {
        self.duels
            .contains_key(&duel_id.0)
            .then(|| U64(self.lock_of(duel_id.0)))
    }

    /// Duel ids an agent took part in, newest first, `limit` entries from offset `from`. Only duels
    /// opened from deploy 10 on are indexed; unknown agents return an empty list.
    /// View: anyone, no deposit, no panics.
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

    /// Agents sorted by alpha, then shield, descending; `limit` (at most 100) from rank `from`.
    /// ponytail: sorts every agent per call; a sorted index once agents number in the thousands.
    /// View: anyone, no deposit, no panics.
    pub fn leaderboard(&self, from: u32, limit: u32) -> Vec<AgentView> {
        let mut v: Vec<&Agent> = self.agents.values().collect();
        v.sort_by(|x, y| (y.alpha_bps, y.shield).cmp(&(x.alpha_bps, x.shield)));
        v.into_iter()
            .skip(from as usize)
            .take(limit.min(100) as usize)
            .map(|a| self.view_of(a))
            .collect()
    }

    /// The exact bytes an agent key signs to be registered by `owner` on this contract.
    /// View: anyone, no deposit, no panics.
    pub fn register_message(&self, owner: AccountId) -> Base64VecU8 {
        Base64VecU8(register_bytes(&env::current_account_id(), &owner))
    }

    /// Whether side a / side b of a scored duel left a commitment unrevealed and was slashed
    /// `no_reveal_bps`. `(false, false)` for unknown, open or clean duels.
    /// View: anyone, no deposit, no panics.
    pub fn get_no_reveal(&self, duel_id: U64) -> (bool, bool) {
        self.no_reveal
            .get(&duel_id.0)
            .copied()
            .unwrap_or((false, false))
    }

    /// The exact bytes an agent key signs for `commit_intent(duel_id, _, commitment, sig, seen)`:
    /// message v2 with `seen`, v1 without. View: anyone, no deposit, no panics.
    pub fn commit_message(
        &self,
        duel_id: U64,
        commitment: Base64VecU8,
        seen: Option<u32>,
    ) -> Base64VecU8 {
        let contract = env::current_account_id();
        Base64VecU8(match seen {
            Some(n) => commit_bytes_v2(&contract, duel_id.0, n, &commitment.0),
            None => commit_bytes(&contract, duel_id.0, &commitment.0),
        })
    }

    /// The newest commit message format `commit_intent` accepts: 2 means it takes `seen` (deploy
    /// 17.1 on). A deployment without this view (deploy 17 and older) accepts only v1. View:
    /// anyone, no deposit, no panics.
    pub fn commit_message_version(&self) -> u32 {
        COMMIT_MESSAGE_VERSION
    }

    /// The exact bytes each agent key signs for `open_duel_consented(a, b, symbol, close_at, ..)`.
    /// View: anyone, no deposit, no panics.
    pub fn consent_message(
        &self,
        a: Base64VecU8,
        b: Base64VecU8,
        symbol: String,
        close_at: U64,
    ) -> Base64VecU8 {
        Base64VecU8(consent_bytes(
            &env::current_account_id(),
            &a.0,
            &b.0,
            &symbol,
            close_at.0,
        ))
    }

    /// Hex of the exact bytes an agent signs for `intent`, for off-chain parity checks. View:
    /// anyone, no deposit, no panics.
    pub fn intent_message_hex(&self, intent: Intent) -> String {
        hex(&intent_message(&intent))
    }

    /// The exact text a TEE signs for an agent's completion, for off-chain parity checks.
    /// View: anyone, no deposit, no panics.
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
