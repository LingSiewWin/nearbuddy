//! Spend gate: a NEAR contract that owns payment keys on another chain and signs with them only inside a policy.
//!
//! Each owner opens an account here. The owner's key is derived by NEAR Chain Signatures from (this account, the
//! owner's account id); nobody holds it. The EVM address it controls (`payer`) holds the owner's stablecoin. To
//! pay, the owner's agent calls `sign_payment` with the fields of an EIP-3009 `transferWithAuthorization` (the
//! message an x402 "exact" payment carries) and the enclave-signed model decision that chose the purchase. The
//! contract checks the decision and the fields against the owner's policy, builds the EIP-712 digest itself and
//! asks the MPC network to sign it. The agent never supplies a hash, so it cannot get a signature for anything
//! but a payment the policy allows, and each decision pays at most once.
//!
//! The agent needs no funds and no full-access key: a function-call access key limited to `sign_payment` on
//! this contract is enough, because the contract pays the 1 yoctoNEAR the MPC contract requires. Stealing that
//! key yields at most the remaining allowance, to the allowed payees, in payments under the cap, and only with
//! fresh decisions signed by a listed enclave.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near,
    require,
};

const MPC_GAS: Gas = Gas::from_tgas(250);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Longest life of a signed authorization. A signature that is not used soon should not stay spendable.
pub const MAX_WINDOW_S: u64 = 3600;
/// Deposit `open_account` takes. It pays for the account's storage, so a policy may not outgrow it.
pub const OPEN_DEPOSIT: NearToken = NearToken::from_millinear(10);

/// The EIP-712 domain of the token contract.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Token {
    /// `name()` of the token as its EIP-712 domain uses it, e.g. "USD Coin".
    pub name: String,
    /// EIP-712 domain version, e.g. "2".
    pub version: String,
    pub chain_id: U64,
    /// Token contract, 20 bytes hex with 0x.
    pub address: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Policy {
    /// The only account that may ask for a signature.
    pub agent: AccountId,
    /// Most token base units one payment may move.
    pub per_payment_cap: U128,
    /// Token base units still spendable in total. Each signature reduces it.
    pub allowance: U128,
    /// Addresses that may be paid, 20 bytes hex with 0x.
    pub allowed_payees: Vec<String>,
    /// Unix seconds after which nothing is signed.
    pub expires_at: U64,
    /// Sites the payer address may sign in to (`sign_login`), e.g. "api.bitrefill.com".
    pub login_domains: Vec<String>,
    /// NEAR AI Cloud model ids whose enclave decisions may pay, e.g. "deepseek-ai/DeepSeek-V4.1-Flash-1017".
    pub models: Vec<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Account {
    /// The address the owner's derived key controls (`from` of every payment), 20 bytes hex with 0x. The owner
    /// supplies it; a wrong address only makes the owner's own signatures invalid on chain.
    pub payer: String,
    pub policy: Option<Policy>,
}

/// The NEAR AI Cloud signature record for one completion (same shape as the arena's `TeeProof`). The model's
/// enclave signs the raw text `"{model_id}:{request_hash_hex}:{response_hash_hex}"` with ed25519. Only kind 2
/// (`provider_tee`, the model's own enclave) is accepted here.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct TeeProof {
    /// 1 = gateway TEE, 2 = provider (model) TEE.
    pub kind: u8,
    /// sha256 of the exact request body bytes.
    pub request_hash: Base64VecU8,
    /// sha256 of the exact response body bytes.
    pub response_hash: Base64VecU8,
    /// 32-byte ed25519 `signing_address` of the TEE.
    pub signer: Base64VecU8,
    /// 64-byte ed25519 signature over the text.
    pub signature: Base64VecU8,
}

#[near(serializers = [json])]
pub struct Config {
    pub admin: AccountId,
    pub mpc_contract: AccountId,
    pub token: Token,
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Accounts,
    TeeSigners,
    UsedDecisions,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    admin: AccountId,
    mpc_contract: AccountId,
    token: Token,
    accounts: LookupMap<AccountId, Account>,
    tee_signers: LookupSet<Vec<u8>>,
    /// `proof_hash` of every decision that paid. It grows by one entry (about 77 bytes) per payment and that
    /// storage is paid from this contract's balance, not by the owner.
    used_decisions: LookupSet<Vec<u8>>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(admin: AccountId, mpc_contract: AccountId, token: Token) -> Self {
        address(&token.address);
        Self {
            admin,
            mpc_contract,
            token,
            accounts: LookupMap::new(StorageKey::Accounts),
            tee_signers: LookupSet::new(StorageKey::TeeSigners),
            used_decisions: LookupSet::new(StorageKey::UsedDecisions),
        }
    }

    /// Open the caller's account. The caller becomes its owner; its key is derived with the caller's account id
    /// as path, and `payer` is the address of that key. The deposit (at least 0.01 NEAR, all of it kept) pays
    /// for the account's storage.
    #[payable]
    pub fn open_account(&mut self, payer: String) {
        require!(
            env::attached_deposit() >= OPEN_DEPOSIT,
            "attach at least 0.01 NEAR"
        );
        address(&payer);
        let owner = env::predecessor_account_id();
        require!(
            !self.accounts.contains_key(&owner),
            "the account is already open"
        );
        self.accounts.insert(
            owner,
            Account {
                payer,
                policy: None,
            },
        );
    }

    /// Owner only: replace the policy. The owner signs this with its own key, which the agent does not have.
    pub fn set_policy(&mut self, policy: Policy) {
        require!(
            !policy.allowed_payees.is_empty(),
            "the policy allows no payee"
        );
        for p in &policy.allowed_payees {
            address(p);
        }
        let owner = env::predecessor_account_id();
        let account = self.account_mut(&owner);
        account.policy = Some(policy);
        // The account's storage was paid by `OPEN_DEPOSIT`; a larger policy would be paid by this contract.
        let bytes = near_sdk::borsh::to_vec(&*account).unwrap().len() + owner.len() + 45;
        require!(
            env::storage_byte_cost().saturating_mul(bytes as u128) <= OPEN_DEPOSIT,
            "the policy is too large for the account deposit"
        );
    }

    /// Owner only: stop all signing for the caller's account.
    pub fn revoke(&mut self) {
        self.account_mut(&env::predecessor_account_id()).policy = None;
    }

    /// Admin only: accept decisions signed by this enclave key (32-byte ed25519). The admin takes it from the
    /// NEAR AI Cloud attestation report after verifying the report off chain.
    pub fn add_tee_signer(&mut self, signer: Base64VecU8) {
        self.require_admin();
        require!(signer.0.len() == 32, "the signer must be 32 bytes");
        self.tee_signers.insert(signer.0);
    }

    /// Admin only: stop accepting decisions signed by this enclave key.
    pub fn remove_tee_signer(&mut self, signer: Base64VecU8) {
        self.require_admin();
        require!(signer.0.len() == 32, "the signer must be 32 bytes");
        self.tee_signers.remove(&signer.0);
    }

    /// Sign one EIP-3009 `transferWithAuthorization` from `owner`'s payer to `to`, if `decision` is a fresh
    /// decision of a policy model signed by a listed enclave and the payment fits the policy.
    /// Returns the MPC signature (`big_r`, `s`, `recovery_id`), or null when the MPC network did not sign,
    /// in which case the allowance and the decision are restored. A request outside the policy fails the
    /// transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn sign_payment(
        &mut self,
        owner: AccountId,
        to: String,
        value: U128,
        valid_after: U64,
        valid_before: U64,
        nonce: String,
        model_id: String,
        decision: TeeProof,
    ) -> Promise {
        let now = env::block_timestamp() / 1_000_000_000;
        let account = self
            .accounts
            .get(&owner)
            .unwrap_or_else(|| env::panic_str("no account is open for this owner"));
        let payer = address(&account.payer);
        let policy = account
            .policy
            .as_ref()
            .unwrap_or_else(|| env::panic_str("no policy is set"));
        require!(
            env::predecessor_account_id() == policy.agent,
            "only the agent in the policy may ask for a signature"
        );
        require!(now < policy.expires_at.0, "the policy has expired");
        require!(
            policy.models.contains(&model_id),
            "the model is not in the policy"
        );

        require!(
            decision.kind == 2,
            "only a decision from the model's enclave (kind 2) is accepted"
        );
        let (request_hash, response_hash) = (&decision.request_hash.0, &decision.response_hash.0);
        require!(
            request_hash.len() == 32 && response_hash.len() == 32,
            "the decision hashes must be 32 bytes"
        );
        require!(
            self.tee_signers.contains(&decision.signer.0),
            "unknown tee signer"
        );
        require!(
            verify(
                &decision.signer.0,
                &tee_text(&model_id, request_hash, response_hash),
                &decision.signature.0
            ),
            "bad tee signature"
        );
        let proof = proof_hash(request_hash, response_hash);
        require!(
            !self.used_decisions.contains(&proof),
            "this decision was already used"
        );

        require!(value.0 > 0, "the payment is zero");
        require!(
            value.0 <= policy.per_payment_cap.0,
            "the payment is above the per-payment cap"
        );
        require!(
            value.0 <= policy.allowance.0,
            "the payment is above the remaining allowance"
        );
        let payee = address(&to);
        require!(
            policy.allowed_payees.iter().any(|p| address(p) == payee),
            "the payee is not in the policy"
        );
        require!(
            valid_before.0 > now,
            "the authorization has already expired"
        );
        require!(
            valid_before.0 <= now + MAX_WINDOW_S,
            "the authorization would stay valid for more than an hour"
        );
        let nonce = bytes::<32>(&nonce);
        let digest = self.digest(
            &payer,
            &payee,
            value.0,
            valid_after.0,
            valid_before.0,
            &nonce,
        );
        let event = payment_event(&owner, &payee, value.0, &nonce, &model_id, &decision);

        // Spend the decision and the allowance before the external call; `on_signed` gives both back if the
        // MPC call fails.
        self.used_decisions.insert(proof.clone());
        let policy = self.account_mut(&owner).policy.as_mut().unwrap();
        policy.allowance = U128(policy.allowance.0 - value.0);

        self.request_signature(
            &owner,
            &digest,
            value,
            Some(Base64VecU8(proof)),
            Some(event),
        )
    }

    /// Sign a sign-in message (EIP-191 `personal_sign`) as `owner`'s payer, so a shop can show the buyer its
    /// orders. Only a message that opens with the sign-in line of a domain in the policy is signed. Such a digest
    /// starts from the "\x19Ethereum Signed Message" prefix, so it can never be a payment authorization (0x1901).
    pub fn sign_login(&mut self, owner: AccountId, message: String) -> Promise {
        let now = env::block_timestamp() / 1_000_000_000;
        let policy = self
            .accounts
            .get(&owner)
            .unwrap_or_else(|| env::panic_str("no account is open for this owner"))
            .policy
            .as_ref()
            .unwrap_or_else(|| env::panic_str("no policy is set"));
        require!(
            env::predecessor_account_id() == policy.agent,
            "only the agent in the policy may ask for a signature"
        );
        require!(now < policy.expires_at.0, "the policy has expired");
        require!(message.len() <= 2048, "the sign-in message is too long");
        require!(
            policy
                .login_domains
                .iter()
                .any(|d| message.starts_with(&format!(
                    "{d} wants you to sign in with your Ethereum account:\n"
                ))),
            "the sign-in message is not for a domain in the policy"
        );
        self.request_signature(&owner, &login_digest(&message), U128(0), None, None)
    }

    /// The MPC answer. On success logs `event` (the `payment_signed` event of a payment) and returns the
    /// signature; on failure gives `value` back to `owner`'s allowance, frees the decision and returns null.
    #[private]
    pub fn on_signed(
        &mut self,
        #[callback_result] result: Result<Value, PromiseError>,
        owner: AccountId,
        value: U128,
        proof_hash: Option<Base64VecU8>,
        event: Option<String>,
    ) -> Option<Value> {
        match result {
            Ok(signature) => {
                if let Some(e) = event {
                    env::log_str(&e);
                }
                Some(signature)
            }
            // No panic here: a panic would roll back the refund below.
            Err(_) => {
                if let Some(policy) = self
                    .accounts
                    .get_mut(&owner)
                    .and_then(|a| a.policy.as_mut())
                {
                    policy.allowance = U128(policy.allowance.0.saturating_add(value.0));
                }
                if let Some(p) = proof_hash {
                    self.used_decisions.remove(&p.0);
                }
                env::log_str("the MPC network did not sign; allowance and decision restored");
                None
            }
        }
    }

    pub fn get_account(&self, owner: AccountId) -> Option<Account> {
        self.accounts.get(&owner).cloned()
    }

    pub fn get_config(&self) -> Config {
        Config {
            admin: self.admin.clone(),
            mpc_contract: self.mpc_contract.clone(),
            token: self.token.clone(),
        }
    }

    /// Whether the decision with this `proof_hash` (sha256 of request hash ‖ response hash) has paid.
    pub fn is_decision_used(&self, proof_hash: Base64VecU8) -> bool {
        self.used_decisions.contains(&proof_hash.0)
    }

    /// The EIP-712 digest `sign_payment` would sign for these fields, so a client can check its own encoding.
    pub fn payment_digest_hex(
        &self,
        owner: AccountId,
        to: String,
        value: U128,
        valid_after: U64,
        valid_before: U64,
        nonce: String,
    ) -> String {
        let payer = address(
            &self
                .accounts
                .get(&owner)
                .unwrap_or_else(|| env::panic_str("no account is open for this owner"))
                .payer,
        );
        hex(&self.digest(
            &payer,
            &address(&to),
            value.0,
            valid_after.0,
            valid_before.0,
            &bytes::<32>(&nonce),
        ))
    }
}

impl Contract {
    /// Ask the MPC network to sign `digest` with the key derived from (this account, `owner`).
    fn request_signature(
        &self,
        owner: &AccountId,
        digest: &[u8; 32],
        value: U128,
        proof_hash: Option<Base64VecU8>,
        event: Option<String>,
    ) -> Promise {
        let args = json!({
            "request": { "path": owner, "payload_v2": { "Ecdsa": hex(digest) }, "domain_id": 0 }
        })
        .to_string()
        .into_bytes();
        // The 1 yoctoNEAR comes from this contract's balance, so the agent's key can be a function-call key.
        Promise::new(self.mpc_contract.clone())
            .function_call(
                "sign".to_string(),
                args,
                NearToken::from_yoctonear(1),
                MPC_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_signed(owner.clone(), value, proof_hash, event),
            )
    }

    fn account_mut(&mut self, owner: &AccountId) -> &mut Account {
        self.accounts
            .get_mut(owner)
            .unwrap_or_else(|| env::panic_str("no account is open for this owner"))
    }

    fn require_admin(&self) {
        require!(
            env::predecessor_account_id() == self.admin,
            "only the admin may change the enclave signers"
        );
    }

    /// keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(TransferWithAuthorization)), per EIP-712 and EIP-3009.
    fn digest(
        &self,
        from: &[u8; 20],
        to: &[u8; 20],
        value: u128,
        valid_after: u64,
        valid_before: u64,
        nonce: &[u8; 32],
    ) -> [u8; 32] {
        let t = &self.token;
        let domain = env::keccak256_array(
            [
                env::keccak256_array(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                env::keccak256_array(t.name.as_bytes()),
                env::keccak256_array(t.version.as_bytes()),
                word(t.chain_id.0 as u128),
                left_pad(&address(&t.address)),
            ]
            .concat(),
        );
        let message = env::keccak256_array(
            [
                env::keccak256_array(
                    b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
                ),
                left_pad(from),
                left_pad(to),
                word(value),
                word(valid_after as u128),
                word(valid_before as u128),
                *nonce,
            ]
            .concat(),
        );
        env::keccak256_array([&[0x19, 0x01][..], &domain, &message].concat())
    }
}

/// The text a model's enclave signs for one completion (NEAR AI Cloud, kind 2).
fn tee_text(model_id: &str, request_hash: &[u8], response_hash: &[u8]) -> Vec<u8> {
    format!("{model_id}:{}:{}", hex(request_hash), hex(response_hash)).into_bytes()
}

/// The id of a decision: sha256(request_hash ‖ response_hash).
fn proof_hash(request_hash: &[u8], response_hash: &[u8]) -> Vec<u8> {
    env::sha256([request_hash, response_hash].concat())
}

fn verify(pk: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk), <[u8; 64]>::try_from(sig)) else {
        return false;
    };
    env::ed25519_verify(&sig, msg, &pk)
}

/// The `payment_signed` event line. Built with serde so a model id cannot break the JSON.
fn payment_event(
    owner: &AccountId,
    to: &[u8; 20],
    value: u128,
    nonce: &[u8; 32],
    model_id: &str,
    decision: &TeeProof,
) -> String {
    let e = json!({
        "standard": "nearbuddy-paygate",
        "version": "1.0.0",
        "event": "payment_signed",
        "data": {
            "owner": owner,
            "to": format!("0x{}", hex(to)),
            "value": value.to_string(),
            "nonce": format!("0x{}", hex(nonce)),
            "model": model_id,
            "request_hash": hex(&decision.request_hash.0),
            "response_hash": hex(&decision.response_hash.0),
        }
    });
    format!("EVENT_JSON:{e}")
}

/// keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖ message), per EIP-191.
fn login_digest(message: &str) -> [u8; 32] {
    env::keccak256_array(
        format!("\x19Ethereum Signed Message:\n{}{message}", message.len()).as_bytes(),
    )
}

/// A uint256 ABI word holding `v`.
fn word(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// An address ABI word.
fn left_pad(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn address(s: &str) -> [u8; 20] {
    bytes::<20>(s)
}

/// Exactly `N` bytes of hex with a 0x prefix, either case. Anything else fails the call.
fn bytes<const N: usize>(s: &str) -> [u8; N] {
    let h = s
        .strip_prefix("0x")
        .unwrap_or_else(|| env::panic_str("hex value without 0x"));
    require!(
        h.len() == N * 2 && h.is_ascii(),
        "hex value of the wrong length"
    );
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16)
            .unwrap_or_else(|_| env::panic_str("not a hex value"));
    }
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::{PromiseResult, testing_env};

    /// Shared with packages/solver/src/paygate.test.ts, which computes the same digest with viem.
    const WIRE: &str = include_str!("../../fixtures/wire-vectors.json");
    const NOW_S: u64 = 1_794_560_000;
    const PAYEE: &str = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A";
    const NONCE: &str = "0x0303030303030303030303030303030303030303030303030303030303030303";
    const ADMIN: &str = "admin.testnet";
    const OWNER: &str = "owner.testnet";
    const AGENT: &str = "agent.testnet";

    fn wire(key: &str) -> Value {
        near_sdk::serde_json::from_str::<Value>(WIRE).unwrap()[key].clone()
    }

    fn vector() -> Value {
        wire("payment")
    }

    fn s(v: &Value) -> String {
        v.as_str().unwrap().to_string()
    }

    fn unhex(h: &str) -> Vec<u8> {
        (0..h.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
            .collect()
    }

    fn id(a: &str) -> AccountId {
        a.parse().unwrap()
    }

    fn at(caller: &str) {
        at_with(caller, NearToken::from_yoctonear(0));
    }

    fn at_with(caller: &str, deposit: NearToken) {
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(id(caller))
                .attached_deposit(deposit)
                .block_timestamp(NOW_S * 1_000_000_000)
                .build()
        );
    }

    /// The enclave key the admin lists in `gate()`.
    fn enclave() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn model() -> String {
        s(&wire("tee")["model"])
    }

    /// A kind-2 decision for `model` signed by `key`. `n == 0` uses the shared vector's hashes; any other `n`
    /// gives a different response hash, so each `n` is a distinct decision.
    fn decision_by(key: &SigningKey, model: &str, n: u8) -> TeeProof {
        let t = wire("tee");
        let req = unhex(&s(&t["request_hash_hex"]));
        let resp = if n == 0 {
            unhex(&s(&t["response_hash_hex"]))
        } else {
            vec![n; 32]
        };
        let sig = key.sign(&tee_text(model, &req, &resp)).to_bytes().to_vec();
        TeeProof {
            kind: 2,
            request_hash: Base64VecU8(req),
            response_hash: Base64VecU8(resp),
            signer: Base64VecU8(key.verifying_key().to_bytes().to_vec()),
            signature: Base64VecU8(sig),
        }
    }

    fn decision(n: u8) -> TeeProof {
        decision_by(&enclave(), &model(), n)
    }

    fn policy(agent: &str) -> Policy {
        Policy {
            agent: id(agent),
            per_payment_cap: U128(1_500_000),
            allowance: U128(3_000_000),
            allowed_payees: vec![PAYEE.to_lowercase()],
            expires_at: U64(NOW_S + 86_400),
            login_domains: vec!["api.bitrefill.com".to_string()],
            models: vec![model()],
        }
    }

    fn gate() -> Contract {
        let v = vector();
        at(ADMIN);
        let mut c = Contract::new(
            id(ADMIN),
            id("v1.signer-prod.testnet"),
            Token {
                name: s(&v["domain"]["name"]),
                version: s(&v["domain"]["version"]),
                chain_id: U64(v["domain"]["chainId"].as_u64().unwrap()),
                address: s(&v["domain"]["verifyingContract"]),
            },
        );
        c.add_tee_signer(Base64VecU8(enclave().verifying_key().to_bytes().to_vec()));
        open(&mut c, OWNER, AGENT);
        c
    }

    fn open(c: &mut Contract, owner: &str, agent: &str) {
        at_with(owner, OPEN_DEPOSIT);
        c.open_account(s(&vector()["message"]["from"]));
        at(owner);
        c.set_policy(policy(agent));
    }

    fn allowance(c: &Contract) -> u128 {
        c.get_account(id(OWNER))
            .unwrap()
            .policy
            .unwrap()
            .allowance
            .0
    }

    fn pay_with(c: &mut Contract, owner: &str, model: &str, d: TeeProof, to: &str, value: u128) {
        let _ = c.sign_payment(
            id(owner),
            to.to_string(),
            U128(value),
            U64(0),
            U64(NOW_S + 600),
            NONCE.to_string(),
            model.to_string(),
            d,
        );
    }

    /// Pay with the n-th decision, inside the window.
    fn pay(c: &mut Contract, n: u8, to: &str, value: u128) {
        pay_with(c, OWNER, &model(), decision(n), to, value);
    }

    fn pay_until(c: &mut Contract, valid_before: u64) {
        let _ = c.sign_payment(
            id(OWNER),
            PAYEE.to_string(),
            U128(1),
            U64(0),
            U64(valid_before),
            NONCE.to_string(),
            model(),
            decision(1),
        );
    }

    /// Run as the contract itself, after the MPC call returned `result`.
    fn in_callback(result: PromiseResult) {
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(near_sdk::test_utils::accounts(0))
                .current_account_id(near_sdk::test_utils::accounts(0))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn proof_of(d: &TeeProof) -> Base64VecU8 {
        Base64VecU8(proof_hash(&d.request_hash.0, &d.response_hash.0))
    }

    #[test]
    fn digest_matches_the_shared_vector() {
        let v = vector();
        let m = &v["message"];
        let c = gate();
        let got = c.payment_digest_hex(
            id(OWNER),
            s(&m["to"]),
            U128(s(&m["value"]).parse().unwrap()),
            U64(s(&m["validAfter"]).parse().unwrap()),
            U64(s(&m["validBefore"]).parse().unwrap()),
            s(&m["nonce"]),
        );
        assert_eq!(format!("0x{got}"), s(&v["digest_hex"]));
    }

    #[test]
    fn login_digest_matches_the_shared_vector() {
        let v = wire("login");
        assert_eq!(
            format!("0x{}", hex(&login_digest(&s(&v["message"])))),
            s(&v["digest_hex"])
        );
    }

    #[test]
    fn tee_text_and_proof_hash_match_the_shared_vector() {
        let t = wire("tee");
        let req = unhex(&s(&t["request_hash_hex"]));
        let resp = unhex(&s(&t["response_hash_hex"]));
        assert_eq!(
            String::from_utf8(tee_text(&s(&t["model"]), &req, &resp)).unwrap(),
            s(&t["text_kind2"])
        );
        assert_eq!(hex(&proof_hash(&req, &resp)), s(&t["proof_hash_hex"]));
    }

    #[test]
    fn a_login_for_an_allowed_domain_is_signed_and_spends_nothing() {
        let v = wire("login");
        let mut c = gate();
        at(AGENT);
        let _ = c.sign_login(id(OWNER), s(&v["message"]));
        assert_eq!(allowance(&c), 3_000_000);
    }

    #[test]
    #[should_panic(expected = "not for a domain in the policy")]
    fn a_login_for_another_domain_is_refused() {
        let mut c = gate();
        at(AGENT);
        let _ = c.sign_login(
            id(OWNER),
            "evil.example wants you to sign in with your Ethereum account:\n0x00".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "not for a domain in the policy")]
    fn an_arbitrary_message_is_refused() {
        let mut c = gate();
        at(AGENT);
        let _ = c.sign_login(id(OWNER), "transfer everything".to_string());
    }

    #[test]
    #[should_panic(expected = "only the agent in the policy")]
    fn another_caller_cannot_log_in() {
        let v = wire("login");
        let mut c = gate();
        at("thief.testnet");
        let _ = c.sign_login(id(OWNER), s(&v["message"]));
    }

    #[test]
    fn a_payment_inside_the_policy_spends_the_allowance_and_the_decision() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 0, PAYEE, 1_310_000);
        assert_eq!(allowance(&c), 1_690_000);
        assert!(c.is_decision_used(proof_of(&decision(0))));
        assert!(!c.is_decision_used(proof_of(&decision(1))));
    }

    #[test]
    #[should_panic(expected = "above the per-payment cap")]
    fn a_payment_above_the_cap_is_refused() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1_500_001);
    }

    #[test]
    #[should_panic(expected = "above the remaining allowance")]
    fn the_allowance_runs_out() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1_500_000);
        pay(&mut c, 2, PAYEE, 1_500_000);
        pay(&mut c, 3, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "the payee is not in the policy")]
    fn another_payee_is_refused() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 1, "0x000000000000000000000000000000000000dEaD", 1);
    }

    #[test]
    #[should_panic(expected = "only the agent in the policy")]
    fn another_caller_is_refused() {
        let mut c = gate();
        at("thief.testnet");
        pay(&mut c, 1, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "the policy has expired")]
    fn an_expired_policy_signs_nothing() {
        let mut c = gate();
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(id(AGENT))
                .block_timestamp((NOW_S + 86_400) * 1_000_000_000)
                .build()
        );
        pay_until(&mut c, NOW_S + 86_400 + 600);
    }

    #[test]
    #[should_panic(expected = "more than an hour")]
    fn a_long_lived_authorization_is_refused() {
        let mut c = gate();
        at(AGENT);
        pay_until(&mut c, NOW_S + MAX_WINDOW_S + 1);
    }

    #[test]
    #[should_panic(expected = "no policy is set")]
    fn revoke_stops_signing() {
        let mut c = gate();
        at(OWNER);
        c.revoke();
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "no account is open")]
    fn the_agent_cannot_change_the_policy() {
        // `set_policy` writes the caller's own account, so the agent can only reach an account it does not have.
        let mut c = gate();
        at(AGENT);
        let mut p = policy(AGENT);
        p.per_payment_cap = U128(u128::MAX);
        c.set_policy(p);
    }

    #[test]
    #[should_panic(expected = "hex value")]
    fn a_malformed_address_is_refused() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 1, "480CD46E6faDe651a0437DeaddA53D5c8e7D846A", 1);
    }

    #[test]
    #[should_panic(expected = "unknown tee signer")]
    fn a_payment_needs_a_decision_from_a_listed_signer() {
        let mut c = gate();
        at(AGENT);
        let d = decision_by(&SigningKey::from_bytes(&[9u8; 32]), &model(), 1);
        pay_with(&mut c, OWNER, &model(), d, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "unknown tee signer")]
    fn a_removed_signer_proves_nothing() {
        let mut c = gate();
        at(ADMIN);
        c.remove_tee_signer(Base64VecU8(enclave().verifying_key().to_bytes().to_vec()));
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "only the admin")]
    fn only_the_admin_lists_enclave_keys() {
        let mut c = gate();
        at(OWNER);
        c.add_tee_signer(Base64VecU8(vec![1u8; 32]));
    }

    #[test]
    #[should_panic(expected = "bad tee signature")]
    fn a_forged_decision_is_refused() {
        let mut c = gate();
        at(AGENT);
        let mut d = decision(1);
        d.signature = Base64VecU8(enclave().sign(b"other bytes").to_bytes().to_vec());
        pay_with(&mut c, OWNER, &model(), d, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "bad tee signature")]
    fn a_decision_by_another_model_is_refused() {
        // The enclave signed for another model; the agent claims a model the policy allows.
        let mut c = gate();
        at(AGENT);
        let d = decision_by(&enclave(), "other/model", 1);
        pay_with(&mut c, OWNER, &model(), d, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "kind 2")]
    fn a_gateway_decision_is_refused() {
        let mut c = gate();
        at(AGENT);
        let mut d = decision(1);
        d.kind = 1;
        pay_with(&mut c, OWNER, &model(), d, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "the model is not in the policy")]
    fn a_model_outside_the_policy_is_refused() {
        let mut c = gate();
        at(AGENT);
        let d = decision_by(&enclave(), "other/model", 1);
        pay_with(&mut c, OWNER, "other/model", d, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "this decision was already used")]
    fn a_decision_pays_once() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1);
        pay(&mut c, 1, PAYEE, 1);
    }

    #[test]
    fn a_failed_mpc_call_restores_allowance_and_decision() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1_000_000);
        assert!(c.is_decision_used(proof_of(&decision(1))));
        in_callback(PromiseResult::Failed);
        assert!(
            c.on_signed(
                Err(PromiseError::Failed),
                id(OWNER),
                U128(1_000_000),
                Some(proof_of(&decision(1))),
                Some("EVENT_JSON:{}".to_string()),
            )
            .is_none()
        );
        assert_eq!(allowance(&c), 3_000_000);
        assert!(!c.is_decision_used(proof_of(&decision(1))));
        assert!(!get_logs().iter().any(|l| l.starts_with("EVENT_JSON")));
    }

    #[test]
    fn a_signed_payment_logs_one_event() {
        let mut c = gate();
        let d = decision(0);
        let event = payment_event(
            &id(OWNER),
            &address(PAYEE),
            1_310_000,
            &bytes::<32>(NONCE),
            &model(),
            &d,
        );
        in_callback(PromiseResult::Successful(vec![]));
        let sig = near_sdk::serde_json::json!({ "big_r": "x", "s": "y", "recovery_id": 0 });
        assert_eq!(
            c.on_signed(
                Ok(sig.clone()),
                id(OWNER),
                U128(1_310_000),
                Some(proof_of(&d)),
                Some(event.clone())
            ),
            Some(sig)
        );
        assert_eq!(get_logs(), vec![event.clone()]);
        let e: Value =
            near_sdk::serde_json::from_str(event.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        let t = wire("tee");
        assert_eq!(e["standard"], "nearbuddy-paygate");
        assert_eq!(e["version"], "1.0.0");
        assert_eq!(e["event"], "payment_signed");
        assert_eq!(e["data"]["owner"], OWNER);
        assert_eq!(e["data"]["to"], PAYEE.to_lowercase());
        assert_eq!(e["data"]["value"], "1310000");
        assert_eq!(e["data"]["nonce"], NONCE);
        assert_eq!(e["data"]["model"], model());
        assert_eq!(e["data"]["request_hash"], t["request_hash_hex"]);
        assert_eq!(e["data"]["response_hash"], t["response_hash_hex"]);
    }

    #[test]
    #[should_panic(expected = "only the agent in the policy")]
    fn one_owner_cannot_spend_another_owners_account() {
        let mut c = gate();
        open(&mut c, "bob.testnet", "bob-agent.testnet");
        at(AGENT);
        pay_with(&mut c, "bob.testnet", &model(), decision(1), PAYEE, 1);
    }

    #[test]
    fn each_owner_spends_only_its_own_allowance() {
        let mut c = gate();
        open(&mut c, "bob.testnet", "bob-agent.testnet");
        at("bob-agent.testnet");
        pay_with(
            &mut c,
            "bob.testnet",
            &model(),
            decision(1),
            PAYEE,
            1_000_000,
        );
        assert_eq!(allowance(&c), 3_000_000);
        let bob = c.get_account(id("bob.testnet")).unwrap();
        assert_eq!(bob.policy.unwrap().allowance.0, 2_000_000);
    }

    #[test]
    #[should_panic(expected = "attach at least 0.01 NEAR")]
    fn open_account_needs_a_deposit() {
        let mut c = gate();
        at_with("bob.testnet", NearToken::from_millinear(9));
        c.open_account(s(&vector()["message"]["from"]));
    }

    #[test]
    #[should_panic(expected = "already open")]
    fn an_account_opens_once() {
        let mut c = gate();
        at_with(OWNER, OPEN_DEPOSIT);
        c.open_account(PAYEE.to_string());
    }

    #[test]
    #[should_panic(expected = "too large for the account deposit")]
    fn a_policy_larger_than_the_deposit_is_refused() {
        let mut c = gate();
        at(OWNER);
        let mut p = policy(AGENT);
        p.models = vec!["m".repeat(1_000)];
        c.set_policy(p);
    }
}
