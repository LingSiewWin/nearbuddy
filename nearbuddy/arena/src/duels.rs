//! Duel lifecycle: open (owner or consented), intents (direct or commit-reveal), chaos,
//! oracle-priced resolution, void.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::{AccountId, Gas, NearToken, Promise, env, ext_contract, near, require};

use crate::{
    Contract, ContractExt, Duel, Injection, Intent, MAX_INJECTIONS, OraclePrice, Outcome,
    PriceData, Side, SignedIntent, TeeProof, VOID_AFTER_NS, commit_bytes, commit_key,
    consent_bytes, intent_message, nonce_key, proof_hash, set_entry_cost, storage_cost_since,
    tee_text, verify,
};

const ORACLE_GAS: Gas = Gas::from_tgas(150);
/// How long after `open_at` an open-phase oracle answer is still taken as the open price.
const OPEN_PRICE_WINDOW_NS: u64 = 10 * 60 * 1_000_000_000;

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

/// Caller must attach `oracle_deposit`; anything above it goes straight back.
pub(crate) fn take_oracle_deposit(oracle_deposit: u128) {
    let attached = env::attached_deposit().as_yoctonear();
    require!(attached >= oracle_deposit, "attach oracle_deposit");
    if attached > oracle_deposit {
        let _ = Promise::new(env::predecessor_account_id())
            .transfer(NearToken::from_yoctonear(attached - oracle_deposit));
    }
}

/// Oracle price (multiplier / 10^decimals USD) as u64 with 8 decimals.
pub(crate) fn price8(p: &OraclePrice) -> u64 {
    let v = if p.decimals <= 8 {
        p.multiplier.0 * 10u128.pow(8 - p.decimals as u32)
    } else {
        p.multiplier.0 / 10u128.pow(p.decimals as u32 - 8)
    };
    u64::try_from(v).unwrap_or_else(|_| env::panic_str("price overflow"))
}

/// Signed basis points earned by one intent over the duel. No intent, or one that expired before
/// `close_at`, scores 0. Integer order matters: multiply before divide, in i128.
pub(crate) fn pnl_bps(intent: Option<&Intent>, close_at: u64, open: u64, close: u64) -> i64 {
    let Some(i) = intent else { return 0 };
    if i.expires_at.0 < close_at {
        return 0;
    }
    let sign: i128 = if i.side == Side::Long { 1 } else { -1 };
    let v = sign * (close as i128 - open as i128) * i.size_bps as i128 / open as i128;
    v as i64
}

#[near]
impl Contract {
    /// Pair two registered, idle agents on an oracle asset. Attached deposit must cover the duel's
    /// storage plus `oracle_deposit`; the open price is requested from the oracle in the same call
    /// and lands through `oracle_on_call`. Returns the duel id.
    /// Caller: owner. Deposit: the duel record's storage plus `oracle_deposit`. Panics:
    /// "not owner", "consent required", "same agent", "symbol too long", "close_at in the past",
    /// "duel too short", "agent missing", "in duel", "deposit too small".
    #[payable]
    pub fn open_duel(
        &mut self,
        a: Base64VecU8,
        b: Base64VecU8,
        symbol: String,
        close_at: U64,
    ) -> U64 {
        self.only_owner();
        require!(!self.require_consent, "consent required");
        self.open_duel_inner(a, b, symbol, close_at)
    }

    /// `open_duel` with both agents' consent: `sig_a` and `sig_b` are each agent key's ed25519
    /// signature over `consent_message(a, b, symbol, close_at)`. Anyone holding both signatures
    /// may open it; a consent cannot be replayed because `close_at` has passed by the time either
    /// agent is free again. Works whether or not `require_consent` is on.
    /// Caller: anyone. Deposit: as `open_duel`. Panics: "bad consent signature", then as
    /// `open_duel` minus "not owner" / "consent required".
    #[payable]
    pub fn open_duel_consented(
        &mut self,
        a: Base64VecU8,
        b: Base64VecU8,
        symbol: String,
        close_at: U64,
        sig_a: Base64VecU8,
        sig_b: Base64VecU8,
    ) -> U64 {
        let msg = consent_bytes(&env::current_account_id(), &a.0, &b.0, &symbol, close_at.0);
        require!(
            verify(&a.0, &msg, &sig_a.0) && verify(&b.0, &msg, &sig_b.0),
            "bad consent signature"
        );
        self.open_duel_inner(a, b, symbol, close_at)
    }

    fn open_duel_inner(
        &mut self,
        a: Base64VecU8,
        b: Base64VecU8,
        symbol: String,
        close_at: U64,
    ) -> U64 {
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
        self.open_duels += 1;
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
    /// Caller: anyone. Deposit: `oracle_deposit`, excess refunded. Panics:
    /// "attach oracle_deposit", "duel missing", "has open price", "duel closed".
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
    /// last `intent_lock_ns` of the duel. A TEE-backed agent must also present the model enclave's
    /// (kind 2) signature over the completion that produced the decision. The intent must outlive
    /// `close_at` and carry a nonce above the agent's last posted one in this duel, so a relayer
    /// cannot resurface an older decision.
    /// Caller: anyone (relayer). Deposit: none; storage is taken from the agent's bond. Panics:
    /// "agent_pk length", "proof_hash length", "bad size", "agent missing", "bad tee kind",
    /// "tee hash length", "unknown tee signer", "bad tee signature", "proof_hash mismatch",
    /// "proof used", "provider proof required", "tee proof required", "duel missing",
    /// "duel closed", "intent lock", "intent expired", "bad target", "nonce used", "stale nonce",
    /// "bad signature", "bond exhausted"; "commit first" while `commit_reveal` is on.
    pub fn post_intent(&mut self, signed: SignedIntent, tee: Option<TeeProof>) {
        require!(!self.commit_reveal, "commit first");
        self.accept_intent(&signed, tee, true);
    }

    /// Hide the next decision: store `commitment = sha256(intent_message(intent) || salt)` for
    /// this agent in this duel, replacing an earlier unrevealed one. `sig` is the agent key's
    /// signature over `commit_message(duel_id, commitment)`. Only before the intent lock. The salt
    /// should be 32 random bytes: the intent space is small enough to brute-force without it.
    /// Caller: anyone (relayer). Deposit: none; storage is taken from the agent's bond. Panics:
    /// "agent_pk length", "commitment length", "bad commit signature", "duel missing",
    /// "duel closed", "intent lock", "bad target", "commitment used", "agent missing",
    /// "bond exhausted".
    pub fn commit_intent(
        &mut self,
        duel_id: U64,
        agent_pk: Base64VecU8,
        commitment: Base64VecU8,
        sig: Base64VecU8,
    ) {
        require!(agent_pk.0.len() == 32, "agent_pk length");
        let hash: [u8; 32] = commitment
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("commitment length"));
        require!(
            verify(
                &agent_pk.0,
                &commit_bytes(&env::current_account_id(), duel_id.0, &hash),
                &sig.0
            ),
            "bad commit signature"
        );
        let duel = self.duels.get(&duel_id.0).expect("duel missing");
        let now = env::block_timestamp();
        require!(!duel.resolved && now < duel.close_at.0, "duel closed");
        require!(now + self.intent_lock_ns < duel.close_at.0, "intent lock");
        require!(
            agent_pk.0 == duel.a.0 || agent_pk.0 == duel.b.0,
            "bad target"
        );
        let key = commit_key(duel_id.0, &agent_pk.0);
        let mut used = key.clone();
        used.extend_from_slice(&hash);
        require!(!self.used_commitments.contains(&used), "commitment used");
        let before = env::storage_usage();
        self.commitments.insert(key, (hash, now));
        self.commitments.flush();
        let cost = storage_cost_since(before) + set_entry_cost(used.len());
        self.used_commitments.insert(used);
        let agent = self.agents.get_mut(&agent_pk.0).expect("agent missing");
        require!(agent.bond.0 > cost, "bond exhausted");
        agent.bond = U128(agent.bond.0 - cost);
        let b64 = |b: &[u8]| {
            near_sdk::base64::Engine::encode(&near_sdk::base64::prelude::BASE64_STANDARD, b)
        };
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"commit","data":{{"duel_id":{},"agent_pk":"{}","commitment":"{}"}}}}"#,
            duel_id.0,
            b64(&agent_pk.0),
            b64(&hash)
        ));
    }

    /// Open a commitment: the intent and salt must hash to the stored commitment for
    /// `(intent.duel_id, intent.agent_pk)`; then every `post_intent` check and effect applies,
    /// except that the reveal may land inside the intent lock (the decision was fixed when it was
    /// committed, before the lock) up to `close_at`. The commitment is deleted.
    /// Caller: anyone (relayer). Deposit: none; storage is taken from the agent's bond. Panics:
    /// "no commitment", "commitment mismatch", then as `post_intent` minus "intent lock" and
    /// "commit first".
    pub fn reveal_intent(
        &mut self,
        signed: SignedIntent,
        salt: Base64VecU8,
        tee: Option<TeeProof>,
    ) {
        let i = &signed.intent;
        let key = commit_key(i.duel_id.0, &i.agent_pk.0);
        let (hash, _) = *self.commitments.get(&key).expect("no commitment");
        let mut preimage = intent_message(i);
        preimage.extend_from_slice(&salt.0);
        require!(env::sha256_array(&preimage) == hash, "commitment mismatch");
        self.commitments.remove(&key);
        self.accept_intent(&signed, tee, false);
    }

    /// The checks and effects of `post_intent`; `lock` = refuse inside the intent lock.
    fn accept_intent(&mut self, signed: &SignedIntent, tee: Option<TeeProof>, lock: bool) {
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
                require!(
                    p.kind == 2 || !self.tee_agents.contains(&i.agent_pk.0),
                    "provider proof required"
                );
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
            !lock || env::block_timestamp() + self.intent_lock_ns < duel.close_at.0,
            "intent lock"
        );
        require!(i.expires_at.0 >= duel.close_at.0, "intent expired");
        let slot = if i.agent_pk.0 == duel.a.0 {
            &mut duel.last_intent_a
        } else if i.agent_pk.0 == duel.b.0 {
            &mut duel.last_intent_b
        } else {
            env::panic_str("bad target")
        };
        let key = nonce_key(&i.agent_pk.0, i.nonce.0);
        require!(!self.used_nonces.contains(&key), "nonce used");
        if let Some(prev) = slot.as_ref() {
            require!(i.nonce.0 > prev.nonce.0, "stale nonce");
        }
        require!(
            verify(&i.agent_pk.0, &intent_message(i), &signed.signature.0),
            "bad signature"
        );
        *slot = Some(i.clone());
        self.used_nonces.insert(key);
        if tee_kind != 0 {
            self.used_proofs.insert(i.proof_hash.0.clone());
        }
        self.duels.flush();
        // includes the used_nonces / used_proofs entries: LookupSet writes at insert
        let cost = storage_cost_since(before);
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

    /// Spectator pays to attack one agent in an open duel. Only the hash goes on chain; the solver
    /// delivers the payload to the runner. Deposit, minus the record's storage, joins the duel pool.
    /// Caller: anyone (spectator). Deposit: at least `min_chaos_deposit` and above the record's
    /// storage. Panics: "chaos deposit too small", "payload_hash length", "kind too long",
    /// "duel missing", "duel closed", "bad target", "chaos full".
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
    /// Caller: anyone. Deposit: `oracle_deposit`, excess refunded. Panics:
    /// "attach oracle_deposit", "duel missing", "resolved", "duel open", "no open price".
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
    /// `ask_oracle`; `sender_id` is who called `oracle_call` and must be this contract. An open price
    /// is taken only when stamped within the oracle's recency window before `open_at` and at most
    /// ten minutes after it (and before `close_at`), so a late answer cannot set a wrong open price.
    /// Caller: `oracle_account` only. Deposit: none. Panics: "not oracle", "not our request",
    /// "bad msg", "duel missing", "no price", "price overflow", "bad price", "resolved",
    /// "open price stale", "duel open", "price before close", "no open price".
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
        let (symbol, resolved, open_at, close_at, open_price) = (
            d.symbol.clone(),
            d.resolved,
            d.open_at.0,
            d.close_at.0,
            d.open_price,
        );
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
                let ts = data.timestamp.0;
                let recency_ns = data.recency_duration_sec as u64 * 1_000_000_000;
                require!(
                    ts.saturating_add(recency_ns) >= open_at
                        && ts <= open_at + OPEN_PRICE_WINDOW_NS
                        && ts < close_at,
                    "open price stale"
                );
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
    /// Caller: anyone. Deposit: none. Panics: "duel missing", "resolved", "too early",
    /// "agent missing".
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
        self.open_duels = self.open_duels.saturating_sub(1); // duels opened before migrate_v12 were never counted
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
            self.commitments.remove(&commit_key(duel_id.0, pk));
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
    ///
    /// A side that left a commitment unrevealed forfeits: it loses whatever its pnl, its alpha takes
    /// no gain, and on top of the loss slash it pays `no_reveal_bps` of its bond straight to the
    /// opponent's bond (to `owner_fees` when both withheld, which is a tie). The no-reveal slash never
    /// enters the pool, so withholding a losing reveal is never cheaper than losing.
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
        self.open_duels = self.open_duels.saturating_sub(1); // duels opened before migrate_v12 were never counted

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
        // the freed commitment records outweigh the flag record written below
        let nr = [&pk_a, &pk_b].map(|pk| self.commitments.remove(&commit_key(id, pk)).is_some());
        let mut taken = [0u128; 2];
        for (side, (pk, pnl)) in [(&pk_a, pnl_a), (&pk_b, pnl_b)].into_iter().enumerate() {
            let a = self.agents.get_mut(pk).expect("agent missing");
            a.alpha_bps += if nr[side] { pnl.min(0) } else { pnl };
            a.in_duel = None;
            if nr[side] {
                let s = a.bond.0 * self.no_reveal_bps as u128 / 10_000;
                a.bond.0 -= s;
                taken[side] = s;
                env::log_str(&format!(
                    r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"no_reveal","data":{{"duel_id":{id},"agent_pk":"{}","slashed":"{s}"}}}}"#,
                    near_sdk::base64::Engine::encode(
                        &near_sdk::base64::prelude::BASE64_STANDARD,
                        pk
                    )
                ));
            }
        }
        match nr {
            [true, true] => self.owner_fees += taken[0] + taken[1],
            [true, false] => self.agents.get_mut(&pk_b).unwrap().bond.0 += taken[0],
            [false, true] => self.agents.get_mut(&pk_a).unwrap().bond.0 += taken[1],
            [false, false] => {}
        }
        if nr != [false; 2] {
            self.no_reveal.insert(id, (nr[0], nr[1]));
        }
        // Some(true) = a wins
        let a_wins = match nr {
            [true, true] => None,
            [true, false] => Some(false),
            [false, true] => Some(true),
            [false, false] if pnl_a == pnl_b => None,
            [false, false] => Some(pnl_a > pnl_b),
        };
        if let Some(a_wins) = a_wins {
            let (winner, loser) = if a_wins {
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
        } else {
            let half = pool / 2;
            self.agents.get_mut(&pk_a).unwrap().bond.0 += half + pool % 2;
            self.agents.get_mut(&pk_b).unwrap().bond.0 += half;
        }
        self.duels.get_mut(&id).expect("duel missing").outcome = Some(outcome);
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy-arena","version":"1.1.0","event":"resolve","data":{{"duel_id":{id},"pnl_a":{pnl_a},"pnl_b":{pnl_b},"open":{open},"close":{close}}}}}"#
        ));
    }
}
