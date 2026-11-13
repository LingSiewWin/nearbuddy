//! Spend gate: a NEAR contract that owns a payment key on another chain and signs with it only inside a policy.
//!
//! The key is derived by NEAR Chain Signatures from (this account, `path`); nobody holds it. The EVM address it
//! controls (`payer`) holds the stablecoin. To pay, the agent calls `sign_payment` with the fields of an EIP-3009
//! `transferWithAuthorization` (the message an x402 "exact" payment carries). The contract checks the fields
//! against the owner's policy, builds the EIP-712 digest itself and asks the MPC network to sign it. The agent
//! never supplies a hash, so it cannot get a signature for anything but a payment the policy allows.
//!
//! The agent needs no funds and no full-access key: a function-call access key limited to `sign_payment` on
//! this contract is enough, because the contract pays the 1 yoctoNEAR the MPC contract requires. Stealing that
//! key yields at most the remaining allowance, to the allowed payees, in payments under the cap.
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near, require,
};

const MPC_GAS: Gas = Gas::from_tgas(250);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Longest life of a signed authorization. A signature that is not used soon should not stay spendable.
pub const MAX_WINDOW_S: u64 = 3600;

/// The EIP-712 domain of the token contract, and the address this contract's derived key controls.
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
    /// The derived address that holds the tokens (`from` of every payment), 20 bytes hex with 0x.
    pub payer: String,
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
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub mpc_contract: AccountId,
    pub path: String,
    pub token: Token,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    mpc_contract: AccountId,
    path: String,
    token: Token,
    policy: Option<Policy>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, mpc_contract: AccountId, path: String, token: Token) -> Self {
        address(&token.address);
        address(&token.payer);
        Self {
            owner,
            mpc_contract,
            path,
            token,
            policy: None,
        }
    }

    /// Owner only: replace the policy. The owner signs this with its own key, which the agent does not have.
    pub fn set_policy(&mut self, policy: Policy) {
        self.require_owner();
        require!(
            !policy.allowed_payees.is_empty(),
            "the policy allows no payee"
        );
        for p in &policy.allowed_payees {
            address(p);
        }
        self.policy = Some(policy);
    }

    /// Owner only: stop all signing.
    pub fn revoke(&mut self) {
        self.require_owner();
        self.policy = None;
    }

    /// Sign one EIP-3009 `transferWithAuthorization` from `payer` to `to`, if the policy allows it.
    /// Returns the MPC signature (`big_r`, `s`, `recovery_id`), or null when the MPC network did not sign,
    /// in which case the allowance is restored. A request outside the policy fails the transaction.
    pub fn sign_payment(
        &mut self,
        to: String,
        value: U128,
        valid_after: U64,
        valid_before: U64,
        nonce: String,
    ) -> Promise {
        let now = env::block_timestamp() / 1_000_000_000;
        let mut policy = self
            .policy
            .clone()
            .unwrap_or_else(|| env::panic_str("no policy is set"));
        require!(
            env::predecessor_account_id() == policy.agent,
            "only the agent in the policy may ask for a signature"
        );
        require!(now < policy.expires_at.0, "the policy has expired");
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
        let digest = self.digest(
            &payee,
            value.0,
            valid_after.0,
            valid_before.0,
            &bytes::<32>(&nonce),
        );

        // Spend the allowance before the external call; `on_signed` gives it back if the MPC call fails.
        policy.allowance = U128(policy.allowance.0 - value.0);
        self.policy = Some(policy);

        self.request_signature(&digest, value)
    }

    /// Sign a sign-in message (EIP-191 `personal_sign`) as `payer`, so a shop can show the buyer its orders.
    /// Only a message that opens with the sign-in line of a domain in the policy is signed. Such a digest starts
    /// from the "\x19Ethereum Signed Message" prefix, so it can never be a payment authorization (0x1901).
    pub fn sign_login(&mut self, message: String) -> Promise {
        let now = env::block_timestamp() / 1_000_000_000;
        let policy = self
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
        self.request_signature(&login_digest(&message), U128(0))
    }

    #[private]
    pub fn on_signed(
        &mut self,
        #[callback_result] result: Result<Value, PromiseError>,
        value: U128,
    ) -> Option<Value> {
        match result {
            Ok(signature) => Some(signature),
            // No panic here: a panic would roll back the refund below.
            Err(_) => {
                if let Some(policy) = self.policy.as_mut() {
                    policy.allowance = U128(policy.allowance.0 + value.0);
                }
                env::log_str("the MPC network did not sign; allowance restored");
                None
            }
        }
    }

    pub fn get_policy(&self) -> Option<Policy> {
        self.policy.clone()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            mpc_contract: self.mpc_contract.clone(),
            path: self.path.clone(),
            token: self.token.clone(),
        }
    }

    /// The EIP-712 digest `sign_payment` would sign for these fields, so a client can check its own encoding.
    pub fn payment_digest_hex(
        &self,
        to: String,
        value: U128,
        valid_after: U64,
        valid_before: U64,
        nonce: String,
    ) -> String {
        hex(&self.digest(
            &address(&to),
            value.0,
            valid_after.0,
            valid_before.0,
            &bytes::<32>(&nonce),
        ))
    }
}

impl Contract {
    /// Ask the MPC network to sign `digest` with the key derived from (this account, `path`).
    fn request_signature(&self, digest: &[u8; 32], value: U128) -> Promise {
        let args = json!({
            "request": { "path": self.path, "payload_v2": { "Ecdsa": hex(digest) }, "domain_id": 0 }
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
                    .on_signed(value),
            )
    }

    fn require_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner may change the policy"
        );
    }

    /// keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(TransferWithAuthorization)), per EIP-712 and EIP-3009.
    fn digest(
        &self,
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
                left_pad(&address(&t.payer)),
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
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{PromiseResult, testing_env};

    /// Shared with packages/solver/src/paygate.test.ts, which computes the same digest with viem.
    const WIRE: &str = include_str!("../../fixtures/wire-vectors.json");
    const NOW_S: u64 = 1_794_560_000;
    const PAYEE: &str = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A";
    const NONCE: &str = "0x0303030303030303030303030303030303030303030303030303030303030303";

    fn vector() -> Value {
        near_sdk::serde_json::from_str::<Value>(WIRE).unwrap()["payment"].clone()
    }

    fn s(v: &Value) -> String {
        v.as_str().unwrap().to_string()
    }

    fn at(caller: &str) {
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(caller.parse().unwrap())
                .block_timestamp(NOW_S * 1_000_000_000)
                .build()
        );
    }

    fn gate() -> Contract {
        let v = vector();
        at("owner.testnet");
        let mut c = Contract::new(
            "owner.testnet".parse().unwrap(),
            "v1.signer-prod.testnet".parse().unwrap(),
            "base-1".to_string(),
            Token {
                name: s(&v["domain"]["name"]),
                version: s(&v["domain"]["version"]),
                chain_id: U64(v["domain"]["chainId"].as_u64().unwrap()),
                address: s(&v["domain"]["verifyingContract"]),
                payer: s(&v["message"]["from"]),
            },
        );
        c.set_policy(Policy {
            agent: "agent.testnet".parse().unwrap(),
            per_payment_cap: U128(1_500_000),
            allowance: U128(3_000_000),
            allowed_payees: vec![PAYEE.to_lowercase()],
            expires_at: U64(NOW_S + 86_400),
            login_domains: vec!["api.bitrefill.com".to_string()],
        });
        c
    }

    fn pay(c: &mut Contract, to: &str, value: u128, valid_before: u64) {
        let _ = c.sign_payment(
            to.to_string(),
            U128(value),
            U64(0),
            U64(valid_before),
            NONCE.to_string(),
        );
    }

    #[test]
    fn digest_matches_the_shared_vector() {
        let v = vector();
        let m = &v["message"];
        let c = gate();
        let got = c.payment_digest_hex(
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
        let v = near_sdk::serde_json::from_str::<Value>(WIRE).unwrap()["login"].clone();
        assert_eq!(
            format!("0x{}", hex(&login_digest(&s(&v["message"])))),
            s(&v["digest_hex"])
        );
    }

    #[test]
    fn a_login_for_an_allowed_domain_is_signed_and_spends_nothing() {
        let v = near_sdk::serde_json::from_str::<Value>(WIRE).unwrap()["login"].clone();
        let mut c = gate();
        at("agent.testnet");
        let _ = c.sign_login(s(&v["message"]));
        assert_eq!(c.get_policy().unwrap().allowance.0, 3_000_000);
    }

    #[test]
    #[should_panic(expected = "not for a domain in the policy")]
    fn a_login_for_another_domain_is_refused() {
        let mut c = gate();
        at("agent.testnet");
        let _ = c.sign_login(
            "evil.example wants you to sign in with your Ethereum account:\n0x00".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "not for a domain in the policy")]
    fn an_arbitrary_message_is_refused() {
        let mut c = gate();
        at("agent.testnet");
        let _ = c.sign_login("transfer everything".to_string());
    }

    #[test]
    #[should_panic(expected = "only the agent in the policy")]
    fn another_caller_cannot_log_in() {
        let v = near_sdk::serde_json::from_str::<Value>(WIRE).unwrap()["login"].clone();
        let mut c = gate();
        at("thief.testnet");
        let _ = c.sign_login(s(&v["message"]));
    }

    #[test]
    fn a_payment_inside_the_policy_spends_the_allowance() {
        let mut c = gate();
        at("agent.testnet");
        pay(&mut c, PAYEE, 1_310_000, NOW_S + 600);
        assert_eq!(c.get_policy().unwrap().allowance.0, 1_690_000);
    }

    #[test]
    #[should_panic(expected = "above the per-payment cap")]
    fn a_payment_above_the_cap_is_refused() {
        let mut c = gate();
        at("agent.testnet");
        pay(&mut c, PAYEE, 1_500_001, NOW_S + 600);
    }

    #[test]
    #[should_panic(expected = "above the remaining allowance")]
    fn the_allowance_runs_out() {
        let mut c = gate();
        at("agent.testnet");
        pay(&mut c, PAYEE, 1_500_000, NOW_S + 600);
        pay(&mut c, PAYEE, 1_500_000, NOW_S + 600);
        pay(&mut c, PAYEE, 1, NOW_S + 600);
    }

    #[test]
    #[should_panic(expected = "the payee is not in the policy")]
    fn another_payee_is_refused() {
        let mut c = gate();
        at("agent.testnet");
        pay(
            &mut c,
            "0x000000000000000000000000000000000000dEaD",
            1,
            NOW_S + 600,
        );
    }

    #[test]
    #[should_panic(expected = "only the agent in the policy")]
    fn another_caller_is_refused() {
        let mut c = gate();
        at("thief.testnet");
        pay(&mut c, PAYEE, 1, NOW_S + 600);
    }

    #[test]
    #[should_panic(expected = "the policy has expired")]
    fn an_expired_policy_signs_nothing() {
        let mut c = gate();
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id("agent.testnet".parse().unwrap())
                .block_timestamp((NOW_S + 86_400) * 1_000_000_000)
                .build()
        );
        pay(&mut c, PAYEE, 1, NOW_S + 86_400 + 600);
    }

    #[test]
    #[should_panic(expected = "more than an hour")]
    fn a_long_lived_authorization_is_refused() {
        let mut c = gate();
        at("agent.testnet");
        pay(&mut c, PAYEE, 1, NOW_S + MAX_WINDOW_S + 1);
    }

    #[test]
    #[should_panic(expected = "no policy is set")]
    fn revoke_stops_signing() {
        let mut c = gate();
        c.revoke();
        at("agent.testnet");
        pay(&mut c, PAYEE, 1, NOW_S + 600);
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn the_agent_cannot_change_the_policy() {
        let mut c = gate();
        at("agent.testnet");
        let mut p = c.get_policy().unwrap();
        p.per_payment_cap = U128(u128::MAX);
        c.set_policy(p);
    }

    #[test]
    #[should_panic(expected = "hex value")]
    fn a_malformed_address_is_refused() {
        let mut c = gate();
        at("agent.testnet");
        pay(
            &mut c,
            "480CD46E6faDe651a0437DeaddA53D5c8e7D846A",
            1,
            NOW_S + 600,
        );
    }

    #[test]
    fn a_failed_mpc_call_gives_the_allowance_back() {
        let mut c = gate();
        at("agent.testnet");
        pay(&mut c, PAYEE, 1_000_000, NOW_S + 600);
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(near_sdk::test_utils::accounts(0))
                .current_account_id(near_sdk::test_utils::accounts(0))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed]
        );
        assert!(
            c.on_signed(Err(PromiseError::Failed), U128(1_000_000))
                .is_none()
        );
        assert_eq!(c.get_policy().unwrap().allowance.0, 3_000_000);
    }
}
