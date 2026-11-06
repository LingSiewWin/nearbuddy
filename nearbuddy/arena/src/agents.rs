//! Agent registration, bond withdrawal and the enclave signers TEE-backed agents prove against.
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{NearToken, Promise, env, near, require};

use crate::{
    Agent, AgentView, Contract, ContractExt, hex, register_bytes, set_entry_cost,
    storage_cost_since, verify,
};

#[near]
impl Contract {
    /// Accept intents signed by this NEAR AI Cloud enclave key. The owner takes it from
    /// `GET /v1/attestation/report` after verifying the Intel and NVIDIA quotes off chain; the
    /// report bytes are published in the dataset so anyone can redo that check.
    /// Caller: owner. Deposit: none. Panics: "not owner", "signer length", "label too long".
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

    /// Stop accepting intents proved by this enclave key; intents already accepted stand.
    /// Caller: owner. Deposit: none. Panics: "not owner".
    pub fn remove_tee_signer(&mut self, signer: Base64VecU8) {
        self.only_owner();
        self.tee_signers.remove(&signer.0);
    }

    /// Register an agent. The attached deposit is its bond, minus the storage its record costs.
    /// `tee = true` commits the agent to a verified `TeeProof` on every intent. `register_sig` is
    /// `agent_pk`'s ed25519 signature over `register_message(caller)`, so nobody can squat a
    /// published key.
    /// Caller: anyone; the caller becomes the agent owner. Deposit: the bond, above the
    /// record's storage cost. Panics: "agent_pk length", "model_id too long", "agent exists",
    /// "bad register signature", "bond required".
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
    /// Caller: the agent owner. Deposit: none. Panics: "agent missing", "not owner", "in duel",
    /// "insufficient".
    pub fn withdraw_bond(&mut self, agent_pk: Base64VecU8, amount: U128) -> Promise {
        let agent = self.agents.get_mut(&agent_pk.0).expect("agent missing");
        require!(agent.owner == env::predecessor_account_id(), "not owner");
        require!(agent.in_duel.is_none(), "in duel");
        require!(agent.bond.0 >= amount.0, "insufficient");
        agent.bond = U128(agent.bond.0 - amount.0);
        Promise::new(agent.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }
}
