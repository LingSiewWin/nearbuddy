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
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    assert_one_yocto, env, near, require,
};

const MPC_GAS: Gas = Gas::from_tgas(250);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Longest life of a signed authorization. A signature that is not used soon should not stay spendable.
pub const MAX_WINDOW_S: u64 = 3600;
/// Least deposit `open_account` takes. It becomes the owner's storage balance.
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
    /// yoctoNEAR the owner has deposited and not yet spent on storage. Every byte this account adds (the account,
    /// its policy, one used-decision entry per payment) is paid from it; bytes freed are credited back.
    pub storage_balance: U128,
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
    /// `proof_hash` of every decision that paid. It grows by one entry (about 77 bytes) per payment; the paying
    /// owner's `storage_balance` covers it.
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
    /// as path, and `payer` is the address of that key. The whole deposit (at least 0.01 NEAR) becomes the
    /// owner's storage balance, and the account's own storage is paid from it.
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
        let before = env::storage_usage();
        self.accounts.insert(
            owner.clone(),
            Account {
                payer,
                policy: None,
                storage_balance: U128(env::attached_deposit().as_yoctonear()),
            },
        );
        self.charge_storage(&owner, before);
    }

    /// Owner only: add the attached deposit to the caller's storage balance.
    #[payable]
    pub fn top_up(&mut self) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "attach a deposit");
        let account = self.account_mut(&env::predecessor_account_id());
        account.storage_balance = U128(account.storage_balance.0 + deposit);
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
        let before = env::storage_usage();
        self.account_mut(&owner).policy = Some(policy);
        self.charge_storage(&owner, before);
    }

    /// Owner only: stop all signing for the caller's account.
    pub fn revoke(&mut self) {
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        self.account_mut(&owner).policy = None;
        self.charge_storage(&owner, before);
    }

    /// Admin only, with exactly 1 yoctoNEAR (so a function-call key cannot do it): accept decisions signed by
    /// this enclave key (32-byte ed25519). The admin takes it from the NEAR AI Cloud attestation report after
    /// verifying the report off chain.
    #[payable]
    pub fn add_tee_signer(&mut self, signer: Base64VecU8) {
        assert_one_yocto();
        self.require_admin();
        require!(signer.0.len() == 32, "the signer must be 32 bytes");
        self.tee_signers.insert(signer.0);
    }

    /// Admin only, with exactly 1 yoctoNEAR: stop accepting decisions signed by this enclave key.
    #[payable]
    pub fn remove_tee_signer(&mut self, signer: Base64VecU8) {
        assert_one_yocto();
        self.require_admin();
        require!(signer.0.len() == 32, "the signer must be 32 bytes");
        self.tee_signers.remove(&signer.0);
    }

    /// Sign one EIP-3009 `transferWithAuthorization` from `owner`'s payer to `to`, if `decision` is a fresh
    /// decision of a policy model signed by a listed enclave and the payment fits the policy.
    /// Returns the MPC signature (`big_r`, `s`, `recovery_id`), or null when the MPC network did not sign.
    /// Once the checks pass the decision and the allowance are spent, even if signing then fails: a signature
    /// can be published on chain after the MPC call timed out, so nothing is ever given back. The owner can set
    /// a new policy to reset the allowance. A request outside the policy fails the transaction.
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

        // The contract proves that a listed enclave produced this completion and that it is consumed once. It
        // does not read what the completion says, so the policy (cap, allowance, payees, expiry) is what bounds
        // a stolen agent key. Binding the amount and payee to the decision is future work.
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
        require!(
            valid_after.0 < valid_before.0,
            "the authorization window is empty"
        );
        require!(
            valid_before.0 <= policy.expires_at.0,
            "the authorization would outlive the policy"
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

        // Spend the decision and the allowance before the external call, for good.
        let before = env::storage_usage();
        self.used_decisions.insert(proof);
        let policy = self.account_mut(&owner).policy.as_mut().unwrap();
        policy.allowance = U128(policy.allowance.0 - value.0);
        self.charge_storage(&owner, before);

        self.request_signature(&owner, &digest, Some(event))
    }

    /// Sign a sign-in message (EIP-191 `personal_sign`) as `owner`'s payer, so a shop can show the buyer its
    /// orders. Only a message that opens with the sign-in line of a domain in the policy, followed by the payer
    /// address on its own line, is signed. Such a digest starts from the "\x19Ethereum Signed Message" prefix, so
    /// it can never be a payment authorization (0x1901).
    pub fn sign_login(&mut self, owner: AccountId, message: String) -> Promise {
        let now = env::block_timestamp() / 1_000_000_000;
        let account = self
            .accounts
            .get(&owner)
            .unwrap_or_else(|| env::panic_str("no account is open for this owner"));
        let policy = account
            .policy
            .as_ref()
            .unwrap_or_else(|| env::panic_str("no policy is set"));
        require!(
            env::predecessor_account_id() == policy.agent,
            "only the agent in the policy may ask for a signature"
        );
        require!(now < policy.expires_at.0, "the policy has expired");
        require!(message.len() <= 2048, "the sign-in message is too long");
        let rest = policy
            .login_domains
            .iter()
            .find_map(|d| {
                message.strip_prefix(&format!(
                    "{d} wants you to sign in with your Ethereum account:\n"
                ))
            })
            .unwrap_or_else(|| {
                env::panic_str("the sign-in message is not for a domain in the policy")
            });
        require!(
            rest.split_once('\n')
                .is_some_and(|(line, _)| line.eq_ignore_ascii_case(&account.payer)),
            "the sign-in message is not for the payer address"
        );
        self.request_signature(&owner, &login_digest(&message), None)
    }

    /// The MPC answer. On success logs `event` (the `payment_signed` event of a payment) and returns the
    /// signature. On failure logs one line and returns null. It changes no state: what `sign_payment` spent
    /// stays spent.
    #[private]
    pub fn on_signed(
        &mut self,
        #[callback_result] result: Result<Value, PromiseError>,
        event: Option<String>,
    ) -> Option<Value> {
        match result {
            Ok(signature) => {
                if let Some(e) = event {
                    env::log_str(&e);
                }
                Some(signature)
            }
            Err(_) => {
                env::log_str(
                    "the MPC network did not sign; the decision and the allowance stay spent",
                );
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
                    .on_signed(event),
            )
    }

    fn account_mut(&mut self, owner: &AccountId) -> &mut Account {
        self.accounts
            .get_mut(owner)
            .unwrap_or_else(|| env::panic_str("no account is open for this owner"))
    }

    /// Charge `owner`'s storage balance for the bytes written since `before`, or credit the bytes freed.
    fn charge_storage(&mut self, owner: &AccountId, before: u64) {
        // `LookupMap` caches writes until it is flushed; flush so `storage_usage` counts them.
        self.accounts.flush();
        let after = env::storage_usage();
        let byte = env::storage_byte_cost().as_yoctonear();
        let account = self.account_mut(owner);
        let balance = account.storage_balance.0;
        account.storage_balance = U128(if after >= before {
            balance
                .checked_sub((after - before) as u128 * byte)
                .unwrap_or_else(|| env::panic_str("storage balance exhausted: top up"))
        } else {
            balance + (before - after) as u128 * byte
        });
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
    /// Owner whose payer is the address in the shared sign-in vector.
    const SHOPPER: &str = "shopper.testnet";
    const YOCTO: NearToken = NearToken::from_yoctonear(1);

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
        at_with(ADMIN, YOCTO);
        c.add_tee_signer(signer());
        open(&mut c, OWNER, AGENT);
        c
    }

    fn signer() -> Base64VecU8 {
        Base64VecU8(enclave().verifying_key().to_bytes().to_vec())
    }

    fn open(c: &mut Contract, owner: &str, agent: &str) {
        open_as(c, owner, agent, &s(&vector()["message"]["from"]));
    }

    fn open_as(c: &mut Contract, owner: &str, agent: &str, payer: &str) {
        at_with(owner, OPEN_DEPOSIT);
        c.open_account(payer.to_string());
        at(owner);
        c.set_policy(policy(agent));
    }

    /// The payer address on line 2 of the shared sign-in message.
    fn login_payer() -> String {
        s(&wire("login")["message"])
            .lines()
            .nth(1)
            .unwrap()
            .to_string()
    }

    fn login_gate() -> Contract {
        let mut c = gate();
        open_as(&mut c, SHOPPER, AGENT, &login_payer());
        c
    }

    fn allowance(c: &Contract) -> u128 {
        allowance_of(c, OWNER)
    }

    fn allowance_of(c: &Contract, owner: &str) -> u128 {
        c.get_account(id(owner))
            .unwrap()
            .policy
            .unwrap()
            .allowance
            .0
    }

    fn storage_balance(c: &Contract, owner: &str) -> u128 {
        c.get_account(id(owner)).unwrap().storage_balance.0
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
        pay_window(c, 0, valid_before);
    }

    fn pay_window(c: &mut Contract, valid_after: u64, valid_before: u64) {
        let _ = c.sign_payment(
            id(OWNER),
            PAYEE.to_string(),
            U128(1),
            U64(valid_after),
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
        let mut c = login_gate();
        at(AGENT);
        let _ = c.sign_login(id(SHOPPER), s(&v["message"]));
        assert_eq!(allowance_of(&c, SHOPPER), 3_000_000);
    }

    #[test]
    fn the_payer_on_the_sign_in_line_is_compared_without_case() {
        let v = wire("login");
        let mut c = login_gate();
        let m = s(&v["message"]).replacen(&login_payer(), &login_payer().to_lowercase(), 1);
        assert_ne!(m, s(&v["message"]));
        at(AGENT);
        let _ = c.sign_login(id(SHOPPER), m);
    }

    #[test]
    #[should_panic(expected = "not for the payer address")]
    fn a_login_for_another_address_is_refused() {
        let v = wire("login");
        let mut c = login_gate();
        let m = s(&v["message"]).replacen(
            &login_payer(),
            "0x000000000000000000000000000000000000dEaD",
            1,
        );
        at(AGENT);
        let _ = c.sign_login(id(SHOPPER), m);
    }

    #[test]
    #[should_panic(expected = "not for the payer address")]
    fn a_login_whose_address_line_runs_on_is_refused() {
        let mut c = login_gate();
        at(AGENT);
        let _ = c.sign_login(
            id(SHOPPER),
            format!(
                "api.bitrefill.com wants you to sign in with your Ethereum account:\n{}",
                login_payer()
            ),
        );
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
        let mut c = login_gate();
        at("thief.testnet");
        let _ = c.sign_login(id(SHOPPER), s(&v["message"]));
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
    #[should_panic(expected = "the authorization window is empty")]
    fn an_empty_window_is_refused() {
        let mut c = gate();
        at(AGENT);
        pay_window(&mut c, NOW_S + 600, NOW_S + 600);
    }

    #[test]
    #[should_panic(expected = "would outlive the policy")]
    fn an_authorization_cannot_outlive_the_policy() {
        let mut c = gate();
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(id(AGENT))
                .block_timestamp((NOW_S + 86_400 - 100) * 1_000_000_000)
                .build()
        );
        pay_until(&mut c, NOW_S + 86_400 + 100);
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
        at_with(ADMIN, YOCTO);
        c.remove_tee_signer(signer());
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1);
    }

    #[test]
    #[should_panic(expected = "only the admin")]
    fn only_the_admin_lists_enclave_keys() {
        let mut c = gate();
        at_with(OWNER, YOCTO);
        c.add_tee_signer(Base64VecU8(vec![1u8; 32]));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn adding_a_signer_needs_one_yocto() {
        let mut c = gate();
        at(ADMIN);
        c.add_tee_signer(Base64VecU8(vec![1u8; 32]));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn removing_a_signer_needs_one_yocto() {
        let mut c = gate();
        at(ADMIN);
        c.remove_tee_signer(signer());
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
    fn a_failed_mpc_call_keeps_the_decision_used_and_the_allowance_spent() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1_000_000);
        in_callback(PromiseResult::Failed);
        assert!(
            c.on_signed(Err(PromiseError::Failed), Some("EVENT_JSON:{}".to_string()))
                .is_none()
        );
        assert_eq!(allowance(&c), 2_000_000);
        assert!(c.is_decision_used(proof_of(&decision(1))));
        assert!(!get_logs().iter().any(|l| l.starts_with("EVENT_JSON")));
    }

    #[test]
    #[should_panic(expected = "this decision was already used")]
    fn a_decision_whose_signing_failed_cannot_pay_again() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1_000_000);
        in_callback(PromiseResult::Failed);
        let _ = c.on_signed(Err(PromiseError::Failed), None);
        at(AGENT);
        pay(&mut c, 1, PAYEE, 1_000_000);
    }

    #[test]
    fn sign_payment_asks_the_mpc_network_for_the_digest_under_the_owner_path() {
        let mut c = gate();
        at(AGENT);
        pay(&mut c, 0, PAYEE, 1_310_000);
        let digest = c.payment_digest_hex(
            id(OWNER),
            PAYEE.to_string(),
            U128(1_310_000),
            U64(0),
            U64(NOW_S + 600),
            NONCE.to_string(),
        );
        let receipts = near_sdk::test_utils::get_created_receipts();
        assert_eq!(receipts.len(), 2);
        let call = |i: usize| match &receipts[i].actions[..] {
            [
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                },
            ] => (
                String::from_utf8(method_name.clone()).unwrap(),
                near_sdk::serde_json::from_slice::<Value>(args).unwrap(),
                *attached_deposit,
            ),
            other => panic!("unexpected actions {other:?}"),
        };

        assert_eq!(receipts[0].receiver_id, id("v1.signer-prod.testnet"));
        let (method, args, deposit) = call(0);
        assert_eq!(method, "sign");
        assert_eq!(deposit, YOCTO);
        assert_eq!(
            args,
            near_sdk::serde_json::json!({
                "request": { "path": OWNER, "payload_v2": { "Ecdsa": digest }, "domain_id": 0 }
            })
        );

        let d = decision(0);
        let event = payment_event(
            &id(OWNER),
            &address(PAYEE),
            1_310_000,
            &bytes::<32>(NONCE),
            &model(),
            &d,
        );
        assert_eq!(receipts[1].receiver_id, near_sdk::env::current_account_id());
        let (method, args, deposit) = call(1);
        assert_eq!(method, "on_signed");
        assert_eq!(deposit, NearToken::from_yoctonear(0));
        assert_eq!(args, near_sdk::serde_json::json!({ "event": event }));
    }

    #[test]
    fn a_login_callback_carries_no_event() {
        let mut c = login_gate();
        at(AGENT);
        let _ = c.sign_login(id(SHOPPER), s(&wire("login")["message"]));
        let receipts = near_sdk::test_utils::get_created_receipts();
        let near_sdk::mock::MockAction::FunctionCallWeight { args, .. } = &receipts[1].actions[0]
        else {
            panic!("not a function call")
        };
        assert_eq!(
            near_sdk::serde_json::from_slice::<Value>(args).unwrap(),
            near_sdk::serde_json::json!({ "event": null })
        );
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
        assert_eq!(c.on_signed(Ok(sig.clone()), Some(event.clone())), Some(sig));
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
    #[should_panic(expected = "storage balance exhausted: top up")]
    fn a_policy_beyond_the_storage_balance_is_refused() {
        let mut c = gate();
        at(OWNER);
        let mut p = policy(AGENT);
        p.models = vec!["m".repeat(2_000)];
        c.set_policy(p);
    }

    #[test]
    fn open_account_credits_the_deposit_less_the_account_storage() {
        let mut c = gate();
        at_with("bob.testnet", NearToken::from_millinear(50));
        c.open_account(PAYEE.to_string());
        let b = storage_balance(&c, "bob.testnet");
        assert!(b < NearToken::from_millinear(50).as_yoctonear() && b > 0);
    }

    /// Pay with fresh decisions until the owner's balance cannot cover one more used-decision entry.
    fn drain(c: &mut Contract) -> u8 {
        let entry = 200 * env::storage_byte_cost().as_yoctonear();
        let mut n = 1;
        while storage_balance(c, OWNER) >= entry {
            at(AGENT);
            pay(c, n, PAYEE, 1);
            n += 1;
        }
        assert!(n > 2, "the deposit paid for at least one payment");
        n
    }

    #[test]
    #[should_panic(expected = "storage balance exhausted: top up")]
    fn a_payment_is_refused_when_the_storage_balance_cannot_cover_it() {
        let mut c = gate();
        let n = drain(&mut c);
        let mut more = n;
        loop {
            at(AGENT);
            pay(&mut c, more, PAYEE, 1);
            more += 1;
        }
    }

    #[test]
    fn top_up_lets_payments_continue() {
        let mut c = gate();
        let mut n = drain(&mut c);
        at_with(OWNER, OPEN_DEPOSIT);
        c.top_up();
        for _ in 0..5 {
            at(AGENT);
            pay(&mut c, n, PAYEE, 1);
            n += 1;
        }
    }

    #[test]
    fn a_payment_is_charged_to_its_own_owner_only() {
        let mut c = gate();
        open(&mut c, "bob.testnet", "bob-agent.testnet");
        let (mine, bobs) = (
            storage_balance(&c, OWNER),
            storage_balance(&c, "bob.testnet"),
        );
        at("bob-agent.testnet");
        pay_with(&mut c, "bob.testnet", &model(), decision(1), PAYEE, 1);
        assert_eq!(storage_balance(&c, OWNER), mine);
        assert!(storage_balance(&c, "bob.testnet") < bobs);
    }

    #[test]
    #[should_panic(expected = "no account is open")]
    fn top_up_needs_an_account() {
        let mut c = gate();
        at_with("bob.testnet", OPEN_DEPOSIT);
        c.top_up();
    }
}
