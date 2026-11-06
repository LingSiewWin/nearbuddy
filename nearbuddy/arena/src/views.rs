//! Read-only views and the signing-helper views off-chain code uses for parity checks.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::{AccountId, env, near};

use crate::{
    Agent, AgentView, Config, Contract, ContractExt, Duel, Intent, Mandate, commit_bytes,
    consent_bytes, hex, intent_message, register_bytes, tee_text,
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

    /// The follower's mandate for an agent, if any. View: anyone, no deposit, no panics.
    pub fn get_follow(&self, agent_pk: Base64VecU8, follower: AccountId) -> Option<Mandate> {
        self.follows
            .get(&agent_pk.0)?
            .iter()
            .find(|(f, _)| *f == follower)
            .map(|(_, m)| m.clone())
    }

    /// Every follower and mandate attached to an agent. View: anyone, no deposit, no panics.
    pub fn list_followers(&self, agent_pk: Base64VecU8) -> Vec<(AccountId, Mandate)> {
        self.follows.get(&agent_pk.0).cloned().unwrap_or_default()
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

    /// Agents sorted by alpha, then shield, descending.
    /// View: anyone, no deposit, no panics.
    pub fn leaderboard(&self) -> Vec<AgentView> {
        let mut v: Vec<AgentView> = self.agents.values().map(|a| self.view_of(a)).collect();
        v.sort_by(|x, y| (y.alpha_bps, y.shield).cmp(&(x.alpha_bps, x.shield)));
        v
    }

    /// The exact bytes an agent key signs to be registered by `owner`.
    /// View: anyone, no deposit, no panics.
    pub fn register_message(&self, owner: AccountId) -> Base64VecU8 {
        Base64VecU8(register_bytes(&owner))
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

    /// The exact bytes an agent key signs for `commit_intent(duel_id, _, commitment, sig)`.
    /// View: anyone, no deposit, no panics.
    pub fn commit_message(&self, duel_id: U64, commitment: Base64VecU8) -> Base64VecU8 {
        Base64VecU8(commit_bytes(
            &env::current_account_id(),
            duel_id.0,
            &commitment.0,
        ))
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
