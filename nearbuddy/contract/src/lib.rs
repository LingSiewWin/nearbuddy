//! NearBuddy vault: zero-balance credit clearinghouse for AI agents.
//!
//! Flow:
//! 1. An owner deposits NEAR into their vault and issues a *mandate* to an agent
//!    public key (a plain ed25519 key, no NEAR account needed): total allowance,
//!    per-IOU cap, optional payee allowlist, expiry.
//! 2. The agent signs IOUs off-chain to pay resource servers (HTTP 402 flow).
//! 3. A registered solver verifies IOUs off-chain in milliseconds and underwrites
//!    them, then settles hundreds of IOUs in ONE `settle_batch` call. The contract
//!    re-verifies every signature and every mandate rule, debits the owner's vault,
//!    pays each payee once, and pays the solver a fee. If a vault is short, the
//!    solver's stake covers the payee: the solver carried the credit risk.
//!
//! Guarantor layer (2026-11-05): a solver can also *reserve* part of its stake for a card
//! issuer and hand out signed `GuaranteeCert`s off-chain ("approve this swipe; if the on-chain
//! pull from the user's wallet fails, this reserve pays you"). `settle_pull` settles outcomes in
//! batch and pays the issuer from the reserve on failure. The pull transaction itself can be
//! signed by this contract through NEAR Chain Signatures (`request_pull_signature`), so one
//! NEAR stake can back wallets on Ethereum, Solana or Bitcoin.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use std::collections::BTreeMap;

/// Domain separator prepended to the borsh-encoded IOU before signing.
pub const IOU_DOMAIN: &[u8] = b"nearbuddy-iou-v1";
/// Domain separator for guarantee certificates.
pub const CERT_DOMAIN: &[u8] = b"nearbuddy-cert-v1";
/// NEAR Chain Signatures MPC contract (testnet).
pub const MPC_CONTRACT: &str = "v1.signer-prod.testnet";
const MPC_GAS: Gas = Gas::from_tgas(250);
const MPC_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Hard cap on IOUs per settlement call. ed25519 verify is ~ cheap, but keep the
/// batch bounded so a settlement always fits in 300 TGas.
pub const MAX_BATCH: usize = 200;
/// Minimum solver stake.
pub const MIN_SOLVER_STAKE: NearToken = NearToken::from_millinear(100);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Vaults,
    Mandates,
    Solvers,
    UsedNonces,
    Issuers,
    SolverKeys,
}

/// The message an agent signs. Encoded with borsh, prefixed by `IOU_DOMAIN`.
/// The TypeScript side (`packages/protocol`) must produce byte-identical output.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Iou {
    /// Vault owner who will be debited.
    pub owner: AccountId,
    /// Agent public key (32 bytes, ed25519), base64 in JSON.
    pub agent_pk: Base64VecU8,
    /// Resource server that gets paid.
    pub payee: AccountId,
    /// Amount in yoctoNEAR.
    pub amount: U128,
    /// Unique per (agent_pk, nonce). Replay protection.
    pub nonce: U64,
    /// Unix time in nanoseconds; settlement must happen before this.
    pub expires_at: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignedIou {
    pub iou: Iou,
    /// 64-byte ed25519 signature over `IOU_DOMAIN || borsh(iou)`.
    pub signature: Base64VecU8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Vault {
    pub balance: U128,
    /// Amount queued for withdrawal and the timestamp (ns) it becomes claimable.
    pub pending_withdraw: Option<(U128, U64)>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Mandate {
    pub owner: AccountId,
    /// Total yoctoNEAR the agent may ever spend under this mandate.
    pub allowance: U128,
    /// Already settled under this mandate.
    pub spent: U128,
    /// Max yoctoNEAR per single IOU.
    pub per_tx_cap: U128,
    /// Empty = any payee.
    pub allowed_payees: Vec<AccountId>,
    /// Unix ns. IOUs cannot be settled after this.
    pub expires_at: U64,
    pub revoked: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Solver {
    pub stake: U128,
    pub fees_earned: U128,
    pub ious_settled: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Rejected {
    pub index: u32,
    pub reason: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SettlementReport {
    pub settled: u32,
    pub total_paid: U128,
    pub solver_fee: U128,
    /// Amount the solver's stake had to cover because a vault was short.
    pub covered_by_solver: U128,
    pub rejected: Vec<Rejected>,
}

/// What a solver signs off-chain when a card is swiped. The issuer approves the card network
/// authorization on the strength of this; the contract pays `payout` if the pull fails.
/// Byte layout must match `packages/protocol/src/cert.ts`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuaranteeCert {
    pub solver: AccountId,
    pub issuer: AccountId,
    /// EIP-155 chain id of the pull (Sepolia = 11155111).
    pub chain_id: u64,
    /// Payer wallet on the target chain, 0x-hex.
    pub wallet: String,
    /// Token contract on the target chain, 0x-hex.
    pub token: String,
    /// Token units to pull (USDC: 6 dp).
    pub amount: U128,
    /// yoctoNEAR the issuer receives from the reserve if the pull fails.
    pub payout: U128,
    pub nonce: U64,
    /// Unix ns. Settlement must happen before this.
    pub expires_at: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignedCert {
    pub cert: GuaranteeCert,
    /// 64-byte ed25519 signature over `CERT_DOMAIN || borsh(cert)` by the solver's guarantee key.
    pub signature: Base64VecU8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum PullOutcome {
    Pulled { tx_hash: String },
    Failed { reason: String },
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PullSettlement {
    pub signed: SignedCert,
    pub outcome: PullOutcome,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct IssuerReserve {
    pub solver: AccountId,
    /// yoctoNEAR of solver stake earmarked for this issuer.
    pub reserved: U128,
    pub paid_out: U128,
    /// Fees owed by the issuer for successful pulls. ponytail: accrued, invoiced off-chain.
    pub fees_accrued: U128,
    pub pulls_ok: u64,
    pub pulls_failed: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PullReport {
    pub settled: u32,
    pub paid_out: U128,
    pub fees_accrued: U128,
    pub rejected: Vec<Rejected>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub fee_bps: u16,
    pub withdraw_delay_ns: U64,
    pub min_solver_stake: U128,
    pub max_batch: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    vaults: LookupMap<AccountId, Vault>,
    /// Keyed by the 32-byte agent public key.
    mandates: IterableMap<Vec<u8>, Mandate>,
    solvers: LookupMap<AccountId, Solver>,
    /// (agent_pk || nonce_le) already settled.
    used_nonces: LookupSet<Vec<u8>>,
    fee_bps: u16,
    withdraw_delay_ns: u64,
    /// Guarantor layer: reserve per issuer, and the ed25519 key each solver signs certs with.
    issuers: LookupMap<AccountId, IssuerReserve>,
    solver_keys: LookupMap<AccountId, Vec<u8>>,
}

/// State layout before the guarantor layer. Read once by `migrate`.
#[near(serializers = [borsh])]
pub struct OldContract {
    vaults: LookupMap<AccountId, Vault>,
    mandates: IterableMap<Vec<u8>, Mandate>,
    solvers: LookupMap<AccountId, Solver>,
    used_nonces: LookupSet<Vec<u8>>,
    fee_bps: u16,
    withdraw_delay_ns: u64,
}

#[near]
impl Contract {
    /// One-shot state migration adding the guarantor collections. Call once after redeploy.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: OldContract = env::state_read().expect("no old state");
        Self {
            vaults: old.vaults,
            mandates: old.mandates,
            solvers: old.solvers,
            used_nonces: old.used_nonces,
            fee_bps: old.fee_bps,
            withdraw_delay_ns: old.withdraw_delay_ns,
            issuers: LookupMap::new(StorageKey::Issuers),
            solver_keys: LookupMap::new(StorageKey::SolverKeys),
        }
    }

    /// `fee_bps`: solver fee in basis points of settled volume (50 = 0.5%).
    /// `withdraw_delay_ns`: how long a withdrawal is queued so solvers can settle first.
    #[init]
    pub fn init(fee_bps: u16, withdraw_delay_ns: U64) -> Self {
        require!(fee_bps <= 1_000, "fee_bps must be <= 1000");
        Self {
            vaults: LookupMap::new(StorageKey::Vaults),
            mandates: IterableMap::new(StorageKey::Mandates),
            solvers: LookupMap::new(StorageKey::Solvers),
            used_nonces: LookupSet::new(StorageKey::UsedNonces),
            fee_bps,
            withdraw_delay_ns: withdraw_delay_ns.0,
            issuers: LookupMap::new(StorageKey::Issuers),
            solver_keys: LookupMap::new(StorageKey::SolverKeys),
        }
    }

    // ---------------------------------------------------------------- owner side

    /// Lock NEAR in the caller's vault. Agents spend against this, never from it directly.
    #[payable]
    pub fn deposit(&mut self) -> Vault {
        let owner = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach a deposit");
        let mut vault = self.vaults.get(&owner).cloned().unwrap_or(Vault {
            balance: U128(0),
            pending_withdraw: None,
        });
        vault.balance = U128(vault.balance.0 + amount);
        self.vaults.insert(owner.clone(), vault.clone());
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy","version":"1.0.0","event":"deposit","data":{{"owner":"{owner}","amount":"{amount}"}}}}"#
        ));
        vault
    }

    /// Queue a withdrawal. Solvers stop accepting IOUs from this vault while one is pending,
    /// and have `withdraw_delay_ns` to settle what they already underwrote.
    pub fn request_withdraw(&mut self, amount: U128) -> Vault {
        let owner = env::predecessor_account_id();
        let mut vault = self.vaults.get(&owner).cloned().expect("no vault");
        require!(vault.pending_withdraw.is_none(), "withdrawal already pending");
        require!(amount.0 > 0 && amount.0 <= vault.balance.0, "amount exceeds balance");
        let ready_at = env::block_timestamp() + self.withdraw_delay_ns;
        vault.pending_withdraw = Some((amount, U64(ready_at)));
        self.vaults.insert(owner, vault.clone());
        vault
    }

    /// Claim a queued withdrawal after the delay. Pays whatever is still in the vault
    /// (settlements during the delay may have reduced it).
    pub fn withdraw(&mut self) -> Promise {
        let owner = env::predecessor_account_id();
        let mut vault = self.vaults.get(&owner).cloned().expect("no vault");
        let (amount, ready_at) = vault.pending_withdraw.expect("no pending withdrawal");
        require!(env::block_timestamp() >= ready_at.0, "withdrawal delay not elapsed");
        let pay = amount.0.min(vault.balance.0);
        vault.balance = U128(vault.balance.0 - pay);
        vault.pending_withdraw = None;
        self.vaults.insert(owner.clone(), vault);
        Promise::new(owner).transfer(NearToken::from_yoctonear(pay))
    }

    /// Authorize an agent key to spend from the caller's vault within limits.
    /// Re-issuing for the same key replaces the mandate (spent resets to 0; nonces stay burned).
    pub fn issue_mandate(
        &mut self,
        agent_pk: Base64VecU8,
        allowance: U128,
        per_tx_cap: U128,
        allowed_payees: Vec<AccountId>,
        expires_at: U64,
    ) -> Mandate {
        let owner = env::predecessor_account_id();
        require!(agent_pk.0.len() == 32, "agent_pk must be 32 bytes");
        require!(per_tx_cap.0 > 0 && per_tx_cap.0 <= allowance.0, "bad caps");
        require!(expires_at.0 > env::block_timestamp(), "expires_at in the past");
        require!(self.vaults.contains_key(&owner), "deposit first");
        if let Some(existing) = self.mandates.get(&agent_pk.0) {
            require!(existing.owner == owner, "agent key already mandated by another owner");
        }
        let mandate = Mandate {
            owner: owner.clone(),
            allowance,
            spent: U128(0),
            per_tx_cap,
            allowed_payees,
            expires_at,
            revoked: false,
        };
        self.mandates.insert(agent_pk.0.clone(), mandate.clone());
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy","version":"1.0.0","event":"mandate","data":{{"owner":"{owner}","allowance":"{}","per_tx_cap":"{}"}}}}"#,
            allowance.0, per_tx_cap.0
        ));
        mandate
    }

    pub fn revoke_mandate(&mut self, agent_pk: Base64VecU8) {
        let owner = env::predecessor_account_id();
        let m = self.mandates.get_mut(&agent_pk.0).expect("no mandate");
        require!(m.owner == owner, "not your mandate");
        m.revoked = true;
    }

    // --------------------------------------------------------------- solver side

    /// Stake NEAR to become a solver. Stake backs the IOUs you underwrite.
    #[payable]
    pub fn register_solver(&mut self) -> Solver {
        let id = env::predecessor_account_id();
        let add = env::attached_deposit().as_yoctonear();
        let mut s = self.solvers.get(&id).cloned().unwrap_or(Solver {
            stake: U128(0),
            fees_earned: U128(0),
            ious_settled: 0,
        });
        s.stake = U128(s.stake.0 + add);
        require!(s.stake.0 >= MIN_SOLVER_STAKE.as_yoctonear(), "stake below minimum");
        self.solvers.insert(id, s.clone());
        s
    }

    /// Withdraw stake (fees are credited to stake at settlement).
    pub fn solver_withdraw(&mut self, amount: U128) -> Promise {
        let id = env::predecessor_account_id();
        let mut s = self.solvers.get(&id).cloned().expect("not a solver");
        require!(amount.0 <= s.stake.0, "exceeds stake");
        s.stake = U128(s.stake.0 - amount.0);
        self.solvers.insert(id.clone(), s);
        Promise::new(id).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Settle a batch of agent-signed IOUs in one transaction.
    /// Invalid IOUs are reported in `rejected`, never panic the whole batch.
    pub fn settle_batch(&mut self, ious: Vec<SignedIou>) -> SettlementReport {
        let solver_id = env::predecessor_account_id();
        let mut solver = self.solvers.get(&solver_id).cloned().expect("not a registered solver");
        require!(!ious.is_empty() && ious.len() <= MAX_BATCH, "batch size out of range");
        let now = env::block_timestamp();

        let mut payouts: BTreeMap<AccountId, u128> = BTreeMap::new();
        let mut report = SettlementReport {
            settled: 0,
            total_paid: U128(0),
            solver_fee: U128(0),
            covered_by_solver: U128(0),
            rejected: vec![],
        };

        for (i, signed) in ious.into_iter().enumerate() {
            match self.apply_iou(&signed, now, &mut solver) {
                Ok(covered) => {
                    let amt = signed.iou.amount.0;
                    *payouts.entry(signed.iou.payee.clone()).or_insert(0) += amt;
                    report.settled += 1;
                    report.total_paid = U128(report.total_paid.0 + amt);
                    report.covered_by_solver = U128(report.covered_by_solver.0 + covered);
                }
                Err(reason) => report.rejected.push(Rejected { index: i as u32, reason }),
            }
        }

        // Fee is carved out of settled volume: each payee receives amount * (1 - fee_bps).
        // Computed per payee as amt * fee_bps / 10_000 so it can never overflow u128.
        // ponytail: simplest fee model; switch to owner-paid fee if payees object.
        let mut fee: u128 = 0;
        for (payee, amt) in payouts {
            let payee_fee = amt * self.fee_bps as u128 / 10_000;
            fee += payee_fee;
            let net = amt - payee_fee;
            if net > 0 {
                Promise::new(payee).transfer(NearToken::from_yoctonear(net)).detach();
            }
        }
        report.solver_fee = U128(fee);
        solver.stake = U128(solver.stake.0 + fee);
        solver.fees_earned = U128(solver.fees_earned.0 + fee);
        solver.ious_settled += report.settled as u64;
        self.solvers.insert(solver_id.clone(), solver);

        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy","version":"1.0.0","event":"settle","data":{{"solver":"{solver_id}","settled":{},"rejected":{},"total_paid":"{}","fee":"{}"}}}}"#,
            report.settled,
            report.rejected.len(),
            report.total_paid.0,
            fee
        ));
        report
    }

    /// Validate one IOU and apply its state changes. Returns how much the solver's stake covered.
    fn apply_iou(&mut self, signed: &SignedIou, now: u64, solver: &mut Solver) -> Result<u128, String> {
        let iou = &signed.iou;
        if iou.agent_pk.0.len() != 32 {
            return Err("agent_pk length".into());
        }
        if signed.signature.0.len() != 64 {
            return Err("signature length".into());
        }
        if iou.expires_at.0 <= now {
            return Err("iou expired".into());
        }
        let nonce_key = nonce_key(&iou.agent_pk.0, iou.nonce.0);
        if self.used_nonces.contains(&nonce_key) {
            return Err("nonce already settled".into());
        }
        let msg = iou_message(iou);
        let sig: [u8; 64] = signed.signature.0.as_slice().try_into().unwrap();
        let pk: [u8; 32] = iou.agent_pk.0.as_slice().try_into().unwrap();
        if !env::ed25519_verify(&sig, &msg, &pk) {
            return Err("bad signature".into());
        }
        let mandate = self.mandates.get(&iou.agent_pk.0).ok_or("no mandate")?.clone();
        if mandate.revoked {
            return Err("mandate revoked".into());
        }
        if mandate.owner != iou.owner {
            return Err("owner mismatch".into());
        }
        if now >= mandate.expires_at.0 {
            return Err("mandate expired".into());
        }
        if iou.amount.0 == 0 || iou.amount.0 > mandate.per_tx_cap.0 {
            return Err("amount exceeds per_tx_cap".into());
        }
        if mandate.spent.0 + iou.amount.0 > mandate.allowance.0 {
            return Err("allowance exhausted".into());
        }
        if !mandate.allowed_payees.is_empty() && !mandate.allowed_payees.contains(&iou.payee) {
            return Err("payee not allowed".into());
        }

        // Debit vault; solver stake covers any shortfall (the solver underwrote this IOU).
        let mut vault = self.vaults.get(&iou.owner).cloned().ok_or("no vault")?;
        let from_vault = iou.amount.0.min(vault.balance.0);
        let shortfall = iou.amount.0 - from_vault;
        if shortfall > solver.stake.0 {
            return Err("vault short and solver stake insufficient".into());
        }
        vault.balance = U128(vault.balance.0 - from_vault);
        solver.stake = U128(solver.stake.0 - shortfall);
        self.vaults.insert(iou.owner.clone(), vault);

        let mut m = mandate;
        m.spent = U128(m.spent.0 + iou.amount.0);
        self.mandates.insert(iou.agent_pk.0.clone(), m);
        self.used_nonces.insert(nonce_key);
        Ok(shortfall)
    }

    // ------------------------------------------------------------ guarantor layer

    /// Register the ed25519 key this solver signs guarantee certs with (32 raw bytes).
    pub fn set_guarantee_key(&mut self, pk: Base64VecU8) {
        let id = env::predecessor_account_id();
        require!(self.solvers.contains_key(&id), "not a registered solver");
        require!(pk.0.len() == 32, "pk must be 32 bytes");
        self.solver_keys.insert(id, pk.0);
    }

    /// Earmark `amount` of the caller's stake for `issuer`. Certs for this issuer draw on it.
    pub fn reserve_for_issuer(&mut self, issuer: AccountId, amount: U128) -> IssuerReserve {
        let id = env::predecessor_account_id();
        let mut s = self.solvers.get(&id).cloned().expect("not a registered solver");
        require!(amount.0 > 0 && amount.0 <= s.stake.0, "amount exceeds free stake");
        let mut r = self.issuers.get(&issuer).cloned().unwrap_or(IssuerReserve {
            solver: id.clone(),
            reserved: U128(0),
            paid_out: U128(0),
            fees_accrued: U128(0),
            pulls_ok: 0,
            pulls_failed: 0,
        });
        // ponytail: one solver per issuer; a reserve market is a later upgrade.
        require!(r.solver == id, "issuer already backed by another solver");
        s.stake = U128(s.stake.0 - amount.0);
        r.reserved = U128(r.reserved.0 + amount.0);
        self.solvers.insert(id, s);
        self.issuers.insert(issuer, r.clone());
        r
    }

    /// Move unused reserve back to free stake.
    pub fn release_reserve(&mut self, issuer: AccountId, amount: U128) -> IssuerReserve {
        let id = env::predecessor_account_id();
        let mut s = self.solvers.get(&id).cloned().expect("not a registered solver");
        let mut r = self.issuers.get(&issuer).cloned().expect("no reserve for issuer");
        require!(r.solver == id, "not this issuer's solver");
        require!(amount.0 <= r.reserved.0, "exceeds reserve");
        r.reserved = U128(r.reserved.0 - amount.0);
        s.stake = U128(s.stake.0 + amount.0);
        self.solvers.insert(id, s);
        self.issuers.insert(issuer, r.clone());
        r
    }

    /// Settle pull outcomes for signed certs. Callable by the cert's solver or its issuer, so the
    /// issuer can always enforce a guarantee itself. Failed pulls pay `payout` from the reserve to
    /// the issuer; successful pulls accrue the fee. Bad entries are rejected, never panic the batch.
    pub fn settle_pull(&mut self, settlements: Vec<PullSettlement>) -> PullReport {
        let caller = env::predecessor_account_id();
        require!(!settlements.is_empty() && settlements.len() <= MAX_BATCH, "batch size out of range");
        let now = env::block_timestamp();
        let mut payouts: BTreeMap<AccountId, u128> = BTreeMap::new();
        let mut report = PullReport { settled: 0, paid_out: U128(0), fees_accrued: U128(0), rejected: vec![] };

        for (i, st) in settlements.into_iter().enumerate() {
            match self.apply_pull(&st, &caller, now) {
                Ok((paid, fee)) => {
                    if paid > 0 {
                        *payouts.entry(st.signed.cert.issuer.clone()).or_insert(0) += paid;
                    }
                    report.settled += 1;
                    report.paid_out = U128(report.paid_out.0 + paid);
                    report.fees_accrued = U128(report.fees_accrued.0 + fee);
                }
                Err(reason) => report.rejected.push(Rejected { index: i as u32, reason }),
            }
        }
        for (issuer, amt) in payouts {
            Promise::new(issuer).transfer(NearToken::from_yoctonear(amt)).detach();
        }
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nearbuddy","version":"1.0.0","event":"settle_pull","data":{{"caller":"{caller}","settled":{},"rejected":{},"paid_out":"{}","fees_accrued":"{}"}}}}"#,
            report.settled,
            report.rejected.len(),
            report.paid_out.0,
            report.fees_accrued.0
        ));
        report
    }

    /// Returns (paid_to_issuer, fee_accrued).
    fn apply_pull(&mut self, st: &PullSettlement, caller: &AccountId, now: u64) -> Result<(u128, u128), String> {
        let cert = &st.signed.cert;
        if *caller != cert.solver && *caller != cert.issuer {
            return Err("caller is neither solver nor issuer".into());
        }
        if cert.expires_at.0 <= now {
            return Err("cert expired".into());
        }
        if st.signed.signature.0.len() != 64 {
            return Err("signature length".into());
        }
        let pk = self.solver_keys.get(&cert.solver).ok_or("solver has no guarantee key")?;
        let pk: [u8; 32] = pk.as_slice().try_into().unwrap();
        let sig: [u8; 64] = st.signed.signature.0.as_slice().try_into().unwrap();
        if !env::ed25519_verify(&sig, &cert_message(cert), &pk) {
            return Err("bad cert signature".into());
        }
        let nk = cert_nonce_key(&cert.solver, cert.nonce.0);
        if self.used_nonces.contains(&nk) {
            return Err("cert nonce already settled".into());
        }
        let mut r = self.issuers.get(&cert.issuer).cloned().ok_or("no reserve for issuer")?;
        if r.solver != cert.solver {
            return Err("cert solver is not the issuer's solver".into());
        }
        let out = match &st.outcome {
            PullOutcome::Failed { .. } => {
                if cert.payout.0 > r.reserved.0 {
                    return Err("reserve short".into());
                }
                r.reserved = U128(r.reserved.0 - cert.payout.0);
                r.paid_out = U128(r.paid_out.0 + cert.payout.0);
                r.pulls_failed += 1;
                (cert.payout.0, 0)
            }
            PullOutcome::Pulled { .. } => {
                let fee = cert.payout.0 * self.fee_bps as u128 / 10_000;
                r.fees_accrued = U128(r.fees_accrued.0 + fee);
                r.pulls_ok += 1;
                (0, fee)
            }
        };
        self.issuers.insert(cert.issuer.clone(), r);
        self.used_nonces.insert(nk);
        Ok(out)
    }

    /// Ask the NEAR MPC network to sign a foreign-chain transaction hash on behalf of this
    /// contract. `payload_hex` = 32-byte tx hash, `path` = derivation path (e.g. "sepolia-1").
    /// The derived foreign address is deterministic per (this contract, path). Solver-only.
    #[payable]
    pub fn request_pull_signature(&mut self, payload_hex: String, path: String) -> Promise {
        let id = env::predecessor_account_id();
        require!(self.solvers.contains_key(&id), "not a registered solver");
        require!(payload_hex.len() == 64, "payload must be 32 bytes hex");
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach 1 yoctoNEAR");
        let args = json!({
            "request": { "path": path, "payload_v2": { "Ecdsa": payload_hex }, "domain_id": 0 }
        })
        .to_string()
        .into_bytes();
        Promise::new(MPC_CONTRACT.parse().unwrap())
            .function_call("sign".to_string(), args, NearToken::from_yoctonear(1), MPC_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(MPC_CALLBACK_GAS).on_pull_signature())
    }

    #[private]
    pub fn on_pull_signature(&self, #[callback_result] result: Result<Value, PromiseError>) -> PromiseOrValue<Value> {
        match result {
            Ok(sig) => PromiseOrValue::Value(sig),
            Err(_) => env::panic_str("MPC signature request failed"),
        }
    }

    pub fn get_issuer(&self, issuer: AccountId) -> Option<IssuerReserve> {
        self.issuers.get(&issuer).cloned()
    }

    pub fn get_guarantee_key(&self, solver: AccountId) -> Option<Base64VecU8> {
        self.solver_keys.get(&solver).map(|k| Base64VecU8(k.clone()))
    }

    pub fn is_cert_nonce_used(&self, solver: AccountId, nonce: U64) -> bool {
        self.used_nonces.contains(&cert_nonce_key(&solver, nonce.0))
    }

    /// Exposed so clients can check their cert encoding matches the contract's.
    pub fn cert_message_hex(&self, cert: GuaranteeCert) -> String {
        hex(&cert_message(&cert))
    }

    // --------------------------------------------------------------------- views

    pub fn get_vault(&self, owner: AccountId) -> Option<Vault> {
        self.vaults.get(&owner).cloned()
    }

    pub fn get_mandate(&self, agent_pk: Base64VecU8) -> Option<Mandate> {
        self.mandates.get(&agent_pk.0).cloned()
    }

    pub fn get_solver(&self, solver: AccountId) -> Option<Solver> {
        self.solvers.get(&solver).cloned()
    }

    pub fn is_nonce_used(&self, agent_pk: Base64VecU8, nonce: U64) -> bool {
        self.used_nonces.contains(&nonce_key(&agent_pk.0, nonce.0))
    }

    pub fn get_config(&self) -> Config {
        Config {
            fee_bps: self.fee_bps,
            withdraw_delay_ns: U64(self.withdraw_delay_ns),
            min_solver_stake: U128(MIN_SOLVER_STAKE.as_yoctonear()),
            max_batch: MAX_BATCH as u32,
        }
    }

    /// Exposed so clients can check their encoding matches the contract's.
    pub fn iou_message_hex(&self, iou: Iou) -> String {
        hex(&iou_message(&iou))
    }
}

/// Bytes the agent signs.
pub fn iou_message(iou: &Iou) -> Vec<u8> {
    let mut out = IOU_DOMAIN.to_vec();
    out.extend(near_sdk::borsh::to_vec(iou).expect("borsh"));
    out
}

fn nonce_key(pk: &[u8], nonce: u64) -> Vec<u8> {
    let mut k = pk.to_vec();
    k.extend_from_slice(&nonce.to_le_bytes());
    k
}

/// Bytes the solver signs for a guarantee cert.
pub fn cert_message(cert: &GuaranteeCert) -> Vec<u8> {
    let mut out = CERT_DOMAIN.to_vec();
    out.extend(near_sdk::borsh::to_vec(cert).expect("borsh"));
    out
}

/// Cert nonces live in `used_nonces` under a distinct prefix so they never collide with IOU keys
/// (IOU keys are 32-byte pk || 8-byte nonce; this is "cert:" || account || nonce).
fn cert_nonce_key(solver: &AccountId, nonce: u64) -> Vec<u8> {
    let mut k = b"cert:".to_vec();
    k.extend_from_slice(solver.as_bytes());
    k.extend_from_slice(&nonce.to_le_bytes());
    k
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const OWNER: &str = "owner.testnet";
    const SOLVER: &str = "solver.testnet";
    const API: &str = "api.testnet";
    const NOW: u64 = 1_700_000_000_000_000_000;

    fn ctx(pred: &str, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(pred.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(NOW);
        testing_env!(b.build());
    }

    /// Minimal ed25519 signer for tests (the contract only verifies).
    fn keypair() -> (ed25519_dalek::SigningKey, Vec<u8>) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key().to_bytes().to_vec();
        (sk, pk)
    }

    fn sign(sk: &ed25519_dalek::SigningKey, iou: &Iou) -> SignedIou {
        use ed25519_dalek::Signer;
        let sig = sk.sign(&iou_message(iou)).to_bytes().to_vec();
        SignedIou { iou: iou.clone(), signature: Base64VecU8(sig) }
    }

    fn iou(pk: &[u8], nonce: u64, amount: u128) -> Iou {
        Iou {
            owner: OWNER.parse().unwrap(),
            agent_pk: Base64VecU8(pk.to_vec()),
            payee: API.parse().unwrap(),
            amount: U128(amount),
            nonce: U64(nonce),
            expires_at: U64(NOW + 1_000),
        }
    }

    fn setup() -> (Contract, ed25519_dalek::SigningKey, Vec<u8>) {
        let (sk, pk) = keypair();
        ctx(OWNER, 0);
        let mut c = Contract::init(50, U64(60_000_000_000));
        ctx(OWNER, 1_000);
        c.deposit();
        ctx(OWNER, 0);
        c.issue_mandate(Base64VecU8(pk.clone()), U128(500), U128(10), vec![], U64(NOW + 10_000));
        ctx(SOLVER, MIN_SOLVER_STAKE.as_yoctonear());
        c.register_solver();
        (c, sk, pk)
    }

    #[test]
    fn settles_batch_and_debits_vault() {
        let (mut c, sk, pk) = setup();
        let batch: Vec<SignedIou> = (0..100).map(|n| sign(&sk, &iou(&pk, n, 5))).collect();
        ctx(SOLVER, 0);
        let r = c.settle_batch(batch);
        assert_eq!(r.settled, 100, "{:?}", r.rejected);
        assert_eq!(r.total_paid.0, 500);
        assert_eq!(r.solver_fee.0, 2); // 500 * 50 / 10000 = 2.5 -> 2
        assert_eq!(c.get_vault(OWNER.parse().unwrap()).unwrap().balance.0, 500);
        let m = c.get_mandate(Base64VecU8(pk.clone())).unwrap();
        assert_eq!(m.spent.0, 500);
        assert!(c.is_nonce_used(Base64VecU8(pk), U64(99)));
    }

    #[test]
    fn rejects_replay_bad_sig_and_over_cap() {
        let (mut c, sk, pk) = setup();
        let good = sign(&sk, &iou(&pk, 1, 5));
        let mut tampered = sign(&sk, &iou(&pk, 2, 5));
        tampered.iou.amount = U128(6); // signature no longer matches
        let over_cap = sign(&sk, &iou(&pk, 3, 11));
        ctx(SOLVER, 0);
        let r = c.settle_batch(vec![good.clone(), tampered, over_cap, good]);
        assert_eq!(r.settled, 1);
        let reasons: Vec<&str> = r.rejected.iter().map(|x| x.reason.as_str()).collect();
        assert_eq!(reasons, vec!["bad signature", "amount exceeds per_tx_cap", "nonce already settled"]);
    }

    #[test]
    fn allowance_exhaustion_is_enforced() {
        let (mut c, sk, pk) = setup();
        let batch: Vec<SignedIou> = (0..101).map(|n| sign(&sk, &iou(&pk, n, 5))).collect();
        ctx(SOLVER, 0);
        let r = c.settle_batch(batch);
        assert_eq!(r.settled, 100);
        assert_eq!(r.rejected[0].reason, "allowance exhausted");
    }

    #[test]
    fn solver_stake_covers_short_vault() {
        let (mut c, sk, pk) = setup();
        // Drain vault to 3 via withdraw request + withdraw after delay.
        ctx(OWNER, 0);
        c.request_withdraw(U128(997));
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(OWNER.parse().unwrap())
            .block_timestamp(NOW + 60_000_000_000);
        testing_env!(b.build());
        let _ = c.withdraw();
        assert_eq!(c.get_vault(OWNER.parse().unwrap()).unwrap().balance.0, 3);
        ctx(SOLVER, 0);
        let r = c.settle_batch(vec![sign(&sk, &iou(&pk, 0, 5))]);
        assert_eq!(r.settled, 1);
        assert_eq!(r.covered_by_solver.0, 2);
        let s = c.get_solver(SOLVER.parse().unwrap()).unwrap();
        assert_eq!(s.stake.0, MIN_SOLVER_STAKE.as_yoctonear() - 2 + 0); // fee 5*50/10000 = 0
    }

    #[test]
    fn realistic_yocto_amounts_do_not_overflow() {
        let (sk, pk) = keypair();
        ctx(OWNER, 0);
        let mut c = Contract::init(50, U64(60_000_000_000));
        ctx(OWNER, NearToken::from_near(1).as_yoctonear());
        c.deposit();
        ctx(OWNER, 0);
        let cap = 100_000_000_000_000_000_000u128; // 0.0001 NEAR
        c.issue_mandate(Base64VecU8(pk.clone()), U128(cap * 200), U128(cap), vec![], U64(NOW + 10_000));
        ctx(SOLVER, NearToken::from_near(1).as_yoctonear());
        c.register_solver();
        let batch: Vec<SignedIou> = (0..100).map(|n| sign(&sk, &iou(&pk, n, cap / 2))).collect();
        ctx(SOLVER, 0);
        let r = c.settle_batch(batch);
        assert_eq!(r.settled, 100, "{:?}", r.rejected);
        assert_eq!(r.total_paid.0, cap / 2 * 100);
        assert_eq!(r.solver_fee.0, cap / 2 * 100 * 50 / 10_000);
    }

    #[test]
    fn payee_allowlist_expiry_and_revoke_are_enforced() {
        let (sk, pk) = keypair();
        ctx(OWNER, 0);
        let mut c = Contract::init(50, U64(60_000_000_000));
        ctx(OWNER, 1_000);
        c.deposit();
        ctx(OWNER, 0);
        c.issue_mandate(Base64VecU8(pk.clone()), U128(500), U128(10), vec![API.parse().unwrap()], U64(NOW + 10_000));
        ctx(SOLVER, MIN_SOLVER_STAKE.as_yoctonear());
        c.register_solver();

        let mut wrong_payee = iou(&pk, 1, 5);
        wrong_payee.payee = "evil.testnet".parse().unwrap();
        let mut expired = iou(&pk, 2, 5);
        expired.expires_at = U64(NOW);
        ctx(SOLVER, 0);
        let r = c.settle_batch(vec![sign(&sk, &wrong_payee), sign(&sk, &expired), sign(&sk, &iou(&pk, 3, 5))]);
        assert_eq!(r.settled, 1);
        let reasons: Vec<&str> = r.rejected.iter().map(|x| x.reason.as_str()).collect();
        assert_eq!(reasons, vec!["payee not allowed", "iou expired"]);

        ctx(OWNER, 0);
        c.revoke_mandate(Base64VecU8(pk.clone()));
        ctx(SOLVER, 0);
        let r = c.settle_batch(vec![sign(&sk, &iou(&pk, 4, 5))]);
        assert_eq!(r.rejected[0].reason, "mandate revoked");

        // mandate expiry
        ctx(OWNER, 0);
        c.issue_mandate(Base64VecU8(pk.clone()), U128(500), U128(10), vec![], U64(NOW + 10));
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(SOLVER.parse().unwrap()).block_timestamp(NOW + 10);
        testing_env!(b.build());
        let mut late = iou(&pk, 5, 5);
        late.expires_at = U64(NOW + 100);
        let r = c.settle_batch(vec![sign(&sk, &late)]);
        assert_eq!(r.rejected[0].reason, "mandate expired");
    }

    #[test]
    fn withdraw_is_delayed_and_blocked_while_pending() {
        let (_, _) = keypair();
        ctx(OWNER, 0);
        let mut c = Contract::init(50, U64(60_000_000_000));
        ctx(OWNER, 1_000);
        c.deposit();
        ctx(OWNER, 0);
        c.request_withdraw(U128(400));
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw()));
        assert!(early.is_err(), "withdraw before delay must fail");
        let twice = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_withdraw(U128(1))));
        assert!(twice.is_err(), "second pending withdrawal must fail");
        let v = c.get_vault(OWNER.parse().unwrap()).unwrap();
        assert_eq!(v.pending_withdraw.unwrap().0 .0, 400);
    }

    #[test]
    fn unregistered_solver_cannot_settle() {
        let (mut c, sk, pk) = setup();
        ctx("rando.testnet", 0);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.settle_batch(vec![sign(&sk, &iou(&pk, 0, 5))])
        }));
        assert!(res.is_err());
    }

    #[test]
    fn message_encoding_is_stable() {
        // Pin the encoding so the TS protocol package can assert byte parity.
        let i = Iou {
            owner: "alice.testnet".parse().unwrap(),
            agent_pk: Base64VecU8(vec![1u8; 32]),
            payee: "api.testnet".parse().unwrap(),
            amount: U128(50_000_000_000_000_000_000), // 0.00005 NEAR
            nonce: U64(7),
            expires_at: U64(1_700_000_000_000_000_000),
        };
        let h = hex(&iou_message(&i));
        println!("IOU_HEX={h}");
        assert!(h.starts_with(&hex(IOU_DOMAIN)));
        // domain(16) + len(4)+13 + 4+32 + 4+11 + 16 + 8 + 8
        assert_eq!(iou_message(&i).len(), 16 + 4 + 13 + 4 + 32 + 4 + 11 + 16 + 8 + 8);
    }

    // ------------------------------------------------------------ guarantor layer

    const ISSUER: &str = "issuer.testnet";

    fn cert(nonce: u64, payout: u128) -> GuaranteeCert {
        GuaranteeCert {
            solver: SOLVER.parse().unwrap(),
            issuer: ISSUER.parse().unwrap(),
            chain_id: 11_155_111,
            wallet: "0x199870e7585835cf0475918177bf6a42b0c52c7d".into(),
            token: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238".into(),
            amount: U128(5_000_000),
            payout: U128(payout),
            nonce: U64(nonce),
            expires_at: U64(NOW + 1_000),
        }
    }

    fn sign_cert(sk: &ed25519_dalek::SigningKey, c: &GuaranteeCert) -> SignedCert {
        use ed25519_dalek::Signer;
        let sig = sk.sign(&cert_message(c)).to_bytes().to_vec();
        SignedCert { cert: c.clone(), signature: Base64VecU8(sig) }
    }

    fn setup_guarantor() -> (Contract, ed25519_dalek::SigningKey) {
        let (mut c, sk, pk) = setup();
        ctx(SOLVER, 0);
        c.set_guarantee_key(Base64VecU8(pk));
        c.reserve_for_issuer(ISSUER.parse().unwrap(), U128(50));
        (c, sk)
    }

    #[test]
    fn reserve_moves_stake_and_failed_pull_pays_issuer() {
        let (mut c, sk) = setup_guarantor();
        let stake0 = MIN_SOLVER_STAKE.as_yoctonear();
        assert_eq!(c.get_solver(SOLVER.parse().unwrap()).unwrap().stake.0, stake0 - 50);
        let ok = PullSettlement { signed: sign_cert(&sk, &cert(1, 10)), outcome: PullOutcome::Pulled { tx_hash: "0xabc".into() } };
        let bad = PullSettlement { signed: sign_cert(&sk, &cert(2, 30)), outcome: PullOutcome::Failed { reason: "revert".into() } };
        ctx(SOLVER, 0);
        let r = c.settle_pull(vec![ok, bad]);
        assert_eq!(r.settled, 2, "{:?}", r.rejected);
        assert_eq!(r.paid_out.0, 30);
        assert_eq!(r.fees_accrued.0, 0); // 10 * 50 / 10000 rounds to 0 at this scale
        let ir = c.get_issuer(ISSUER.parse().unwrap()).unwrap();
        assert_eq!(ir.reserved.0, 20);
        assert_eq!(ir.paid_out.0, 30);
        assert_eq!((ir.pulls_ok, ir.pulls_failed), (1, 1));
        assert!(c.is_cert_nonce_used(SOLVER.parse().unwrap(), U64(2)));
    }

    #[test]
    fn issuer_can_enforce_and_replay_forgery_short_reserve_rejected() {
        let (mut c, sk) = setup_guarantor();
        let fail = |n, p| PullSettlement { signed: sign_cert(&sk, &cert(n, p)), outcome: PullOutcome::Failed { reason: "revert".into() } };
        // Issuer settles its own claim.
        ctx(ISSUER, 0);
        let r = c.settle_pull(vec![fail(1, 20)]);
        assert_eq!(r.settled, 1, "{:?}", r.rejected);
        // Replay, forged signature, reserve short, stranger caller.
        let mut forged = fail(3, 5);
        forged.signed.signature.0[0] ^= 1;
        let r = c.settle_pull(vec![fail(1, 20), forged, fail(4, 31)]);
        assert_eq!(r.settled, 0);
        let reasons: Vec<&str> = r.rejected.iter().map(|x| x.reason.as_str()).collect();
        assert_eq!(reasons, ["cert nonce already settled", "bad cert signature", "reserve short"]);
        ctx("rando.testnet", 0);
        let r = c.settle_pull(vec![fail(5, 1)]);
        assert_eq!(r.rejected[0].reason, "caller is neither solver nor issuer");
        // Release what is left.
        ctx(SOLVER, 0);
        let ir = c.release_reserve(ISSUER.parse().unwrap(), U128(30));
        assert_eq!(ir.reserved.0, 0);
        assert_eq!(c.get_solver(SOLVER.parse().unwrap()).unwrap().stake.0, MIN_SOLVER_STAKE.as_yoctonear() - 20);
    }

    #[test]
    fn cert_encoding_is_stable() {
        let m = cert_message(&cert(7, 1_000));
        println!("CERT_HEX={}", hex(&m));
        assert!(hex(&m).starts_with(&hex(CERT_DOMAIN)));
        // domain(17) + solver(4+14) + issuer(4+14) + chain_id 8 + wallet(4+42) + token(4+42) + amount 16 + payout 16 + nonce 8 + expires 8
        assert_eq!(m.len(), 17 + 4 + 14 + 4 + 14 + 8 + 4 + 42 + 4 + 42 + 16 + 16 + 8 + 8);
    }
}
