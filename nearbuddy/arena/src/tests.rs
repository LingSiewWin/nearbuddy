use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

pub const CONTRACT: &str = "arena.testnet";
pub const OWNER: &str = "solver.testnet"; // contract owner = solver account in the hackathon deploy
pub const SOLVER: &str = "solver.testnet";
pub const ORACLE: &str = "price-oracle.testnet";
pub const OPERATOR: &str = "operator.testnet";
pub const FOLLOWER: &str = "follower.testnet";
pub const NOW: u64 = 1_700_000_000_000_000_000;
pub const CLOSE: u64 = NOW + 60_000_000_000; // +60 s
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const BOND: u128 = NEAR;
pub const MIN_CHAOS: u128 = NEAR / 10;
pub const ORACLE_DEPOSIT: u128 = NEAR / 50;
pub const MODEL_A: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
pub const MODEL_B: &str = "Qwen/Qwen3.8-27B";
const OPEN: u64 = 366_000_000; // 3.66 USD, 8 dp
const UP: u64 = 367_830_000; // +0.5 %

pub fn ctx_at(pred: &str, deposit: u128, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(pred.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .block_timestamp(ts);
    testing_env!(b.build());
}
pub fn ctx(pred: &str, deposit: u128) {
    ctx_at(pred, deposit, NOW)
}

pub fn key(seed: u8) -> (SigningKey, Vec<u8>) {
    let sk = SigningKey::from_bytes(&[seed; 32]);
    let pk = sk.verifying_key().to_bytes().to_vec();
    (sk, pk)
}

pub fn intent(pk: &[u8], duel: u64, side: Side, size: u16, nonce: u64) -> Intent {
    Intent {
        agent_pk: Base64VecU8(pk.to_vec()),
        duel_id: U64(duel),
        side,
        size_bps: size,
        nonce: U64(nonce),
        expires_at: U64(CLOSE),
        proof_hash: Base64VecU8(vec![0u8; 32]),
    }
}

pub fn sign(sk: &SigningKey, i: &Intent) -> SignedIntent {
    SignedIntent { intent: i.clone(), signature: Base64VecU8(sk.sign(&intent_message(i)).to_bytes().to_vec()) }
}

/// Contract with solver registered and agents A (seed 1, TEE-backed) and B (seed 2, plain) bonded.
pub fn setup() -> (Contract, SigningKey, SigningKey) {
    let (ska, pka) = key(1);
    let (skb, pkb) = key(2);
    ctx(OWNER, 0);
    let mut c = Contract::init(OWNER.parse().unwrap(), ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), 1_000, 0, U128(MIN_CHAOS));
    c.add_solver(SOLVER.parse().unwrap());
    ctx(OPERATOR, BOND);
    c.register_agent(Base64VecU8(pka), MODEL_A.into(), true);
    ctx(OPERATOR, BOND);
    c.register_agent(Base64VecU8(pkb), MODEL_B.into(), false);
    ctx(OWNER, 0);
    (c, ska, skb)
}

fn price_data(asset: &str, price8: u64, ts: u64) -> PriceData {
    PriceData { timestamp: U64(ts), recency_duration_sec: 300, prices: vec![AssetOptionalPrice { asset_id: asset.into(), price: Some(OraclePrice { multiplier: U128(price8 as u128), decimals: 8 }) }] }
}

/// Outlayer answers `oracle_call`: the oracle account calls back with our contract as sender.
fn oracle_answers(c: &mut Contract, d: u64, phase: &str, price8: u64, ts: u64) {
    ctx_at(ORACLE, 0, ts);
    c.oracle_on_call(CONTRACT.parse().unwrap(), price_data("wrap.near", price8, ts), format!("{phase}:{d}"));
}

/// Open a duel and let the oracle deliver the open price.
pub fn open(c: &mut Contract) -> u64 {
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c.open_duel(Base64VecU8(key(1).1), Base64VecU8(key(2).1), "wrap.near".into(), U64(CLOSE)).0;
    oracle_answers(c, d, "open", OPEN, NOW);
    d
}

fn bond(c: &Contract, seed: u8) -> u128 {
    c.get_agent(Base64VecU8(key(seed).1)).unwrap().bond.0
}

// ---------------------------------------------------------------- TEE proofs

/// Signer seed 7 plays a NEAR AI Cloud enclave; registered by the owner.
fn tee_signer(c: &mut Contract) -> SigningKey {
    let (sk, pk) = key(7);
    ctx(OWNER, 0);
    c.add_tee_signer(Base64VecU8(pk), "unit".into());
    sk
}

fn tee_proof(sk: &SigningKey, kind: u8, model: &str, req: [u8; 32], res: [u8; 32]) -> TeeProof {
    let text = tee_text(kind, model, &req, &res);
    TeeProof {
        kind,
        request_hash: Base64VecU8(req.to_vec()),
        response_hash: Base64VecU8(res.to_vec()),
        signer: Base64VecU8(sk.verifying_key().to_bytes().to_vec()),
        signature: Base64VecU8(sk.sign(&text).to_bytes().to_vec()),
    }
}

/// A's intent with `proof_hash = sha256(req || res)`, signed by A.
fn tee_intent(ska: &SigningKey, d: u64, nonce: u64, req: [u8; 32], res: [u8; 32]) -> SignedIntent {
    let mut i = intent(&key(1).1, d, Side::Long, 5_000, nonce);
    i.proof_hash = Base64VecU8(proof_hash(&req, &res));
    sign(ska, &i)
}

#[test]
fn tee_text_matches_cloud_format() {
    let t = tee_text(2, "deepseek-ai/DeepSeek-V4.1-Flash-1017", &[0xed; 32], &[0xc4; 32]);
    let s = String::from_utf8(t).unwrap();
    assert!(s.starts_with("deepseek-ai/DeepSeek-V4.1-Flash-1017:eded"));
    assert_eq!(s.len(), 36 + 1 + 64 + 1 + 64);
    let g = String::from_utf8(tee_text(1, "ignored", &[0x18; 32], &[0xd5; 32])).unwrap();
    assert_eq!(g.len(), 64 + 1 + 64);
    assert!(g.starts_with("1818") && !g.contains("ignored"));
}

#[test]
fn tee_intent_verified_on_chain() {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    let (req, res) = ([0xaa; 32], [0xbb; 32]);
    ctx(SOLVER, 0);
    c.post_intent(tee_intent(&ska, d, 1, req, res), Some(tee_proof(&tee, 2, MODEL_A, req, res)));
    assert_eq!(c.get_duel(U64(d)).unwrap().last_intent_a.unwrap().proof_hash.0, proof_hash(&req, &res));
    assert!(c.get_agent(Base64VecU8(key(1).1)).unwrap().tee);
}

#[test]
#[should_panic(expected = "proof used")]
fn tee_proof_cannot_back_two_intents() {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    let (req, res) = ([0xaa; 32], [0xbb; 32]);
    ctx(SOLVER, 0);
    c.post_intent(tee_intent(&ska, d, 1, req, res), Some(tee_proof(&tee, 2, MODEL_A, req, res)));
    // same enclave completion, new nonce, opposite side
    let mut i = intent(&key(1).1, d, Side::Short, 5_000, 2);
    i.proof_hash = Base64VecU8(proof_hash(&req, &res));
    c.post_intent(sign(&ska, &i), Some(tee_proof(&tee, 2, MODEL_A, req, res)));
}

#[test]
#[should_panic(expected = "bad tee signature")]
fn tee_tampered_response_rejected() {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    let (req, res) = ([0xaa; 32], [0xbb; 32]);
    let mut p = tee_proof(&tee, 2, MODEL_A, req, res);
    p.response_hash.0[0] ^= 1; // one flipped byte in the response hash
    let mut tampered = res;
    tampered[0] ^= 1;
    ctx(SOLVER, 0);
    c.post_intent(tee_intent(&ska, d, 1, req, tampered), Some(p));
}

#[test]
#[should_panic(expected = "proof_hash mismatch")]
fn tee_proof_must_match_signed_intent() {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    let (req, res) = ([0xaa; 32], [0xbb; 32]);
    ctx(SOLVER, 0);
    // valid enclave proof for one completion, intent commits to another
    c.post_intent(tee_intent(&ska, d, 1, req, [0xcc; 32]), Some(tee_proof(&tee, 2, MODEL_A, req, res)));
}

#[test]
#[should_panic(expected = "unknown tee signer")]
fn tee_unregistered_signer_rejected() {
    let (mut c, ska, _) = setup();
    let d = open(&mut c);
    let (req, res) = ([0xaa; 32], [0xbb; 32]);
    ctx(SOLVER, 0);
    c.post_intent(tee_intent(&ska, d, 1, req, res), Some(tee_proof(&key(7).0, 2, MODEL_A, req, res)));
}

#[test]
#[should_panic(expected = "bad tee signature")]
fn tee_signature_for_other_model_rejected() {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    let (req, res) = ([0xaa; 32], [0xbb; 32]);
    ctx(SOLVER, 0);
    // enclave signed text names model B; agent A is registered as model A
    c.post_intent(tee_intent(&ska, d, 1, req, res), Some(tee_proof(&tee, 2, MODEL_B, req, res)));
}

#[test]
#[should_panic(expected = "tee proof required")]
fn tee_agent_cannot_post_without_proof() {
    let (mut c, ska, _) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    c.post_intent(sign(&ska, &intent(&key(1).1, d, Side::Long, 5_000, 1)), None);
}

#[test]
fn gateway_kind_verifies_without_model_prefix() {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    let (req, res) = ([0x18; 32], [0xd5; 32]);
    ctx(SOLVER, 0);
    c.post_intent(tee_intent(&ska, d, 1, req, res), Some(tee_proof(&tee, 1, "anything", req, res)));
}

#[test]
fn plain_agent_may_attach_a_valid_proof() {
    let (mut c, _, skb) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    let (req, res) = ([0x01; 32], [0x02; 32]);
    let mut i = intent(&key(2).1, d, Side::Short, 5_000, 1);
    i.proof_hash = Base64VecU8(proof_hash(&req, &res));
    ctx(SOLVER, 0);
    c.post_intent(sign(&skb, &i), Some(tee_proof(&tee, 2, MODEL_B, req, res)));
}

#[test]
#[should_panic(expected = "not owner")]
fn only_owner_adds_tee_signers() {
    let (mut c, ..) = setup();
    ctx(OPERATOR, 0);
    c.add_tee_signer(Base64VecU8(key(7).1), "x".into());
}

// ---------------------------------------------------------------- agents, duels, intents

fn post_b(c: &mut Contract, skb: &SigningKey, d: u64, side: Side, nonce: u64) {
    ctx(SOLVER, 0);
    c.post_intent(sign(skb, &intent(&key(2).1, d, side, 5_000, nonce)), None);
}

#[test]
fn register_charges_storage_from_bond() {
    let (c, ..) = setup();
    let b = bond(&c, 2);
    assert!(b < BOND && b > BOND - NEAR / 10, "bond {b} should be BOND minus a few KB of storage");
}

#[test]
#[should_panic(expected = "agent exists")]
fn register_twice_panics() {
    let (mut c, ..) = setup();
    ctx(OPERATOR, BOND);
    c.register_agent(Base64VecU8(key(1).1), "again".into(), false);
}

#[test]
#[should_panic(expected = "bond required")]
fn register_without_bond_panics() {
    let (mut c, ..) = setup();
    ctx(OPERATOR, 1);
    c.register_agent(Base64VecU8(key(3).1), "m".into(), false);
}

#[test]
#[should_panic(expected = "in duel")]
fn open_duel_requires_free_agents() {
    let (mut c, ..) = setup();
    open(&mut c);
    open(&mut c);
}

#[test]
#[should_panic(expected = "deposit too small")]
fn open_duel_requires_oracle_deposit() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT - 1);
    c.open_duel(Base64VecU8(key(1).1), Base64VecU8(key(2).1), "wrap.near".into(), U64(CLOSE));
}

#[test]
fn open_price_lands_once() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    assert_eq!(c.get_duel(U64(d)).unwrap().open_price.unwrap().0, OPEN);
    oracle_answers(&mut c, d, "open", UP, NOW + 1); // a second answer does not overwrite
    assert_eq!(c.get_duel(U64(d)).unwrap().open_price.unwrap().0, OPEN);
}

#[test]
#[should_panic(expected = "not oracle")]
fn only_oracle_delivers_prices() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c.open_duel(Base64VecU8(key(1).1), Base64VecU8(key(2).1), "wrap.near".into(), U64(CLOSE)).0;
    ctx(OPERATOR, 0);
    c.oracle_on_call(CONTRACT.parse().unwrap(), price_data("wrap.near", OPEN, NOW), format!("open:{d}"));
}

#[test]
#[should_panic(expected = "not our request")]
fn oracle_answer_to_foreign_request_rejected() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c.open_duel(Base64VecU8(key(1).1), Base64VecU8(key(2).1), "wrap.near".into(), U64(CLOSE)).0;
    ctx(ORACLE, 0);
    c.oracle_on_call(OPERATOR.parse().unwrap(), price_data("wrap.near", OPEN, NOW), format!("open:{d}"));
}

#[test]
#[should_panic(expected = "no price")]
fn oracle_answer_for_wrong_asset_rejected() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c.open_duel(Base64VecU8(key(1).1), Base64VecU8(key(2).1), "wrap.near".into(), U64(CLOSE)).0;
    ctx(ORACLE, 0);
    c.oracle_on_call(CONTRACT.parse().unwrap(), price_data("eth.bridge.near", OPEN, NOW), format!("open:{d}"));
}

#[test]
fn request_open_price_retries_until_answered() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c.open_duel(Base64VecU8(key(1).1), Base64VecU8(key(2).1), "wrap.near".into(), U64(CLOSE)).0;
    ctx(OPERATOR, ORACLE_DEPOSIT);
    c.request_open_price(U64(d));
    oracle_answers(&mut c, d, "open", OPEN, NOW);
    ctx(OPERATOR, ORACLE_DEPOSIT);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_open_price(U64(d))));
    assert!(r.is_err(), "retry after the price landed must be refused");
}

#[test]
fn post_intent_stores_last_intent_and_charges_bond() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    let before = bond(&c, 2);
    post_b(&mut c, &skb, d, Side::Long, 1);
    post_b(&mut c, &skb, d, Side::Short, 2);
    let duel = c.get_duel(U64(d)).unwrap();
    let last = duel.last_intent_b.unwrap();
    assert_eq!(last.side, Side::Short);
    assert_eq!(last.nonce.0, 2);
    assert!(duel.last_intent_a.is_none());
    assert!(bond(&c, 2) < before, "intent storage is paid from the agent bond");
}

#[test]
#[should_panic(expected = "nonce used")]
fn post_intent_replay_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    post_b(&mut c, &skb, d, Side::Long, 1);
    post_b(&mut c, &skb, d, Side::Long, 1);
}

#[test]
#[should_panic(expected = "duel closed")]
fn post_intent_at_close_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    ctx_at(SOLVER, 0, CLOSE);
    c.post_intent(sign(&skb, &intent(&key(2).1, d, Side::Long, 5_000, 1)), None);
}

#[test]
#[should_panic(expected = "bad size")]
fn post_intent_bad_size_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    c.post_intent(sign(&skb, &intent(&key(2).1, d, Side::Long, 10_001, 1)), None);
}

#[test]
#[should_panic(expected = "bad signature")]
fn post_intent_bad_sig_panics() {
    let (mut c, ska, _) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    // signed by A's key but claims B's pk
    c.post_intent(sign(&ska, &intent(&key(2).1, d, Side::Long, 5_000, 1)), None);
}

#[test]
#[should_panic(expected = "not solver")]
fn non_solver_cannot_post() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    ctx(OPERATOR, 0);
    c.post_intent(sign(&skb, &intent(&key(2).1, d, Side::Long, 5_000, 1)), None);
}

#[test]
fn intent_message_len_matches_ts() {
    // Mirrors packages/protocol/src/intent.test.ts: domain + (4+32) + 8 + 1 + 2 + 8 + 8 + (4+32).
    let i = Intent {
        agent_pk: Base64VecU8(vec![1u8; 32]),
        duel_id: U64(7),
        side: Side::Short,
        size_bps: 5_000,
        nonce: U64(3),
        expires_at: U64(NOW),
        proof_hash: Base64VecU8(vec![0u8; 32]),
    };
    let m = intent_message(&i);
    assert_eq!(m.len(), 19 + 36 + 8 + 1 + 2 + 8 + 8 + 36);
    assert_eq!(m[19 + 36 + 8], 1);
    println!("INTENT_HEX {}", hex(&m));
}

// ---------------------------------------------------------------- vault, mandates, settle_follow

pub fn mandate(cap: u128, allowance: u128, tokens: Vec<&str>) -> Mandate {
    Mandate {
        allowance: U128(allowance),
        spent: U128(0),
        per_tx_cap: U128(cap),
        allowed_tokens: tokens.into_iter().map(String::from).collect(),
        expires_at: U64(NOW + 1_000_000),
        revoked: false,
    }
}

pub fn fill(nonce: u64, token: &str, amount: u128) -> Fill {
    Fill { intent_nonce: U64(nonce), token: token.into(), amount_in: U128(amount), amount_out: U128(1), swap_tx: "0xabc".into() }
}

const VAULT: u128 = 10 * NEAR;

/// setup + duel + B posts nonce 1 + follower deposits 10 NEAR and follows B with the given mandate.
/// Returns the vault balance after deposit and follow (storage was charged from it).
pub fn setup_follow(m: Mandate) -> (Contract, u64, u128) {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    post_b(&mut c, &skb, d, Side::Long, 1);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(2).1), m);
    ctx(SOLVER, 0);
    let v = c.get_vault(FOLLOWER.parse().unwrap()).0;
    (c, d, v)
}

fn settle(c: &mut Contract, fills: Vec<Fill>) -> SettleReport {
    ctx(SOLVER, 0);
    c.settle_follow(Base64VecU8(key(2).1), FOLLOWER.parse().unwrap(), fills)
}

#[test]
fn deposit_and_follow_pay_their_storage() {
    let (_, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    assert!(v < VAULT && v > VAULT - NEAR / 10, "vault {v}");
}

#[test]
fn fill_at_cap_ok() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let r = settle(&mut c, vec![fill(1, "usdc", NEAR)]);
    assert_eq!(r.settled, 1);
    assert_eq!(r.debited.0, NEAR);
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - NEAR);
    assert_eq!(c.get_vault(SOLVER.parse().unwrap()).0, NEAR);
}

// Separate test: unit-test storage is global per test, so a second Contract in the same test
// would see the first one's used_nonces.
#[test]
fn fill_over_cap_rejected() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let r = settle(&mut c, vec![fill(1, "usdc", NEAR + 1)]);
    assert_eq!(r.settled, 0);
    assert_eq!(r.rejected[0].1, "over cap");
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v);
}

#[test]
fn fill_wrong_token_rejected() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec!["usdc"]));
    let r = settle(&mut c, vec![fill(1, "wbtc", 50)]);
    assert_eq!(r.rejected[0].1, "token not allowed");
}

#[test]
fn fill_after_expiry_rejected() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx_at(SOLVER, 0, NOW + 1_000_000);
    let r = c.settle_follow(Base64VecU8(key(2).1), FOLLOWER.parse().unwrap(), vec![fill(1, "usdc", 50)]);
    assert_eq!(r.rejected[0].1, "mandate expired");
}

#[test]
fn fill_after_revoke_rejected() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 0);
    c.unfollow(Base64VecU8(key(2).1));
    let r = settle(&mut c, vec![fill(1, "usdc", 50)]);
    assert_eq!(r.rejected[0].1, "mandate revoked");
}

#[test]
fn duplicate_fill_noop() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    settle(&mut c, vec![fill(1, "usdc", 50)]);
    let r = settle(&mut c, vec![fill(1, "usdc", 50)]);
    assert_eq!(r.rejected[0].1, "duplicate fill");
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - 50);
}

#[test]
fn foreign_nonce_rejected() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let r = settle(&mut c, vec![fill(99, "usdc", 50)]);
    assert_eq!(r.rejected[0].1, "nonce unknown");
}

#[test]
#[should_panic(expected = "not solver")]
fn non_solver_cannot_settle() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(OPERATOR, 0);
    c.settle_follow(Base64VecU8(key(2).1), FOLLOWER.parse().unwrap(), vec![fill(1, "usdc", 50)]);
}

#[test]
fn insufficient_vault_rejected() {
    let (mut c, _, v) = setup_follow(mandate(VAULT, VAULT, vec![]));
    let r = settle(&mut c, vec![fill(1, "usdc", v + 1)]);
    assert_eq!(r.rejected[0].1, "insufficient");
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v);
}

#[test]
fn allowance_exhausted_rejected() {
    let (mut c, d, _) = setup_follow(mandate(NEAR, NEAR + NEAR / 2, vec![]));
    settle(&mut c, vec![fill(1, "usdc", NEAR)]);
    // B posts a second intent (nonce 2), then a fill against it exceeds the remaining allowance
    post_b(&mut c, &key(2).0, d, Side::Short, 2);
    let r = settle(&mut c, vec![fill(2, "usdc", NEAR * 6 / 10)]);
    assert_eq!(r.rejected[0].1, "allowance exhausted");
    assert_eq!(c.get_follow(Base64VecU8(key(2).1), FOLLOWER.parse().unwrap()).unwrap().spent.0, NEAR);
}

#[test]
fn list_followers_and_withdraw() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    assert_eq!(c.list_followers(Base64VecU8(key(2).1)).len(), 1);
    ctx(FOLLOWER, 0);
    let _ = c.withdraw(U128(4 * NEAR));
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - 4 * NEAR);
}

// ---------------------------------------------------------------- chaos and resolve

/// A posts through its TEE proof (A is TEE-backed in `setup`).
fn post_a(c: &mut Contract, ska: &SigningKey, tee: &SigningKey, d: u64, side: Side, nonce: u64) {
    let (req, res) = ([nonce as u8; 32], [0xbb; 32]);
    let mut i = intent(&key(1).1, d, side, 5_000, nonce);
    i.proof_hash = Base64VecU8(proof_hash(&req, &res));
    ctx(SOLVER, 0);
    c.post_intent(sign(ska, &i), Some(tee_proof(tee, 2, MODEL_A, req, res)));
}

fn inject(c: &mut Contract, d: u64, target: &[u8], deposit: u128) {
    ctx(OPERATOR, deposit);
    c.inject_chaos(U64(d), Base64VecU8(target.to_vec()), "fake_news".into(), Base64VecU8(vec![3u8; 32]));
}

fn resolve_at_close(c: &mut Contract, d: u64, close: u64) {
    ctx_at(OPERATOR, ORACLE_DEPOSIT, CLOSE);
    c.resolve_duel(U64(d));
    oracle_answers(c, d, "close", close, CLOSE);
}

#[test]
#[should_panic(expected = "chaos deposit too small")]
fn inject_requires_min_deposit() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    inject(&mut c, d, &key(1).1, MIN_CHAOS - 1);
}

#[test]
#[should_panic(expected = "bad target")]
fn inject_bad_target() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    inject(&mut c, d, &key(5).1, MIN_CHAOS);
}

#[test]
#[should_panic(expected = "chaos full")]
fn inject_33rd_panics() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    for _ in 0..33 {
        inject(&mut c, d, &key(1).1, MIN_CHAOS);
    }
}

#[test]
fn inject_pays_storage_then_pools_the_rest() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    let pool = c.get_duel(U64(d)).unwrap().pool.0;
    assert!(pool < MIN_CHAOS && pool > MIN_CHAOS - NEAR / 100, "pool {pool}");
}

#[test]
fn resolve_scores_50_bps_slashes_and_prunes() {
    let (mut c, ska, skb) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &ska, &tee, d, Side::Long, 1);
    post_b(&mut c, &skb, d, Side::Short, 1);
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    let (bond_a, bond_b) = (bond(&c, 1), bond(&c, 2));
    let pool = c.get_duel(U64(d)).unwrap().pool.0;
    resolve_at_close(&mut c, d, UP);
    let a = c.get_agent(Base64VecU8(key(1).1)).unwrap();
    let b = c.get_agent(Base64VecU8(key(2).1)).unwrap();
    // (UP - OPEN) / OPEN = 0.5 % = 50 bps, half size -> 25 bps
    assert_eq!(a.alpha_bps, 25);
    assert_eq!(b.alpha_bps, -25);
    let slashed = bond_b * 1_000 / 10_000;
    assert_eq!(b.bond.0, bond_b - slashed);
    assert_eq!(a.bond.0, bond_a + slashed + pool);
    assert_eq!(a.shield, 1);
    assert_eq!(b.shield, 0);
    assert!(a.in_duel.is_none() && b.in_duel.is_none());
    let duel = c.get_duel(U64(d)).unwrap();
    assert!(duel.resolved);
    assert_eq!(duel.pool.0, 0);
    assert!(duel.injections.is_empty(), "injections pruned after finish");
    let o = duel.outcome.unwrap();
    assert_eq!((o.pnl_a, o.pnl_b, o.slashed.0, o.injections), (25, -25, slashed, 1));
    assert_eq!((o.open_price.0, o.close_price.0), (OPEN, UP));
    assert_eq!(o.winner.unwrap().0, key(1).1);
}

#[test]
fn resolve_no_intent_scores_zero_and_loses() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    post_b(&mut c, &skb, d, Side::Long, 1);
    let bond_a = bond(&c, 1);
    resolve_at_close(&mut c, d, UP);
    let a = c.get_agent(Base64VecU8(key(1).1)).unwrap();
    assert_eq!(a.alpha_bps, 0);
    assert_eq!(a.bond.0, bond_a - bond_a * 1_000 / 10_000);
}

#[test]
fn resolve_tie_splits_pool_remainder_to_a() {
    let (mut c, ska, skb) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &ska, &tee, d, Side::Long, 1);
    post_b(&mut c, &skb, d, Side::Long, 1);
    inject(&mut c, d, &key(2).1, MIN_CHAOS + 1);
    let (bond_a, bond_b) = (bond(&c, 1), bond(&c, 2));
    let pool = c.get_duel(U64(d)).unwrap().pool.0;
    resolve_at_close(&mut c, d, UP);
    let a = c.get_agent(Base64VecU8(key(1).1)).unwrap();
    let b = c.get_agent(Base64VecU8(key(2).1)).unwrap();
    assert_eq!(a.alpha_bps, 25);
    assert_eq!(b.alpha_bps, 25);
    assert_eq!(a.bond.0, bond_a + pool / 2 + pool % 2);
    assert_eq!(b.bond.0, bond_b + pool / 2);
    assert_eq!(a.shield + b.shield, 0);
}

#[test]
fn resolve_shield_counts_injections_at_winner() {
    let (mut c, ska, skb) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &ska, &tee, d, Side::Long, 1);
    post_b(&mut c, &skb, d, Side::Short, 1);
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    inject(&mut c, d, &key(2).1, MIN_CHAOS);
    resolve_at_close(&mut c, d, UP);
    assert_eq!(c.get_agent(Base64VecU8(key(1).1)).unwrap().shield, 2);
    assert_eq!(c.get_duel(U64(d)).unwrap().outcome.unwrap().injections, 3);
}

#[test]
#[should_panic(expected = "resolved")]
fn resolve_twice_panics() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    resolve_at_close(&mut c, d, UP);
    ctx_at(OPERATOR, ORACLE_DEPOSIT, CLOSE);
    c.resolve_duel(U64(d));
}

#[test]
#[should_panic(expected = "resolved")]
fn late_oracle_answer_after_finish_rejected() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    resolve_at_close(&mut c, d, UP);
    oracle_answers(&mut c, d, "close", UP, CLOSE + 1);
}

#[test]
#[should_panic(expected = "duel open")]
fn resolve_before_close_panics() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    ctx(OPERATOR, ORACLE_DEPOSIT);
    c.resolve_duel(U64(d));
}

#[test]
#[should_panic(expected = "attach oracle_deposit")]
fn resolve_without_deposit_panics() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    ctx_at(OPERATOR, ORACLE_DEPOSIT - 1, CLOSE);
    c.resolve_duel(U64(d));
}

#[test]
#[should_panic(expected = "duel too short")]
fn open_duel_respects_min_length() {
    let (mut c, ..) = setup();
    ctx(OWNER, 0);
    c.set_oracle(ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), 330);
    assert_eq!(c.get_config().min_duel_s, 330);
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    c.open_duel(Base64VecU8(key(1).1), Base64VecU8(key(2).1), "wrap.near".into(), U64(NOW + 329_000_000_000));
}

#[test]
#[should_panic(expected = "duel open")]
fn early_close_price_rejected() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    oracle_answers(&mut c, d, "close", UP, NOW + 1);
}

#[test]
#[should_panic(expected = "price before close")]
fn stale_close_price_rejected() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    ctx_at(ORACLE, 0, CLOSE);
    c.oracle_on_call(CONTRACT.parse().unwrap(), price_data("wrap.near", UP, CLOSE - 1), format!("close:{d}"));
}

#[test]
#[should_panic(expected = "no open price")]
fn resolve_without_open_price_panics() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c.open_duel(Base64VecU8(key(1).1), Base64VecU8(key(2).1), "wrap.near".into(), U64(CLOSE)).0;
    ctx_at(OPERATOR, ORACLE_DEPOSIT, CLOSE);
    c.resolve_duel(U64(d));
}

#[test]
#[should_panic(expected = "bad price")]
fn zero_price_rejected() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    oracle_answers(&mut c, d, "close", 0, CLOSE);
}

#[test]
fn price8_normalises_decimals() {
    assert_eq!(price8(&OraclePrice { multiplier: U128(366_117_500), decimals: 8 }), 366_117_500);
    assert_eq!(price8(&OraclePrice { multiplier: U128(366_117), decimals: 5 }), 366_117_000);
    assert_eq!(price8(&OraclePrice { multiplier: U128(36_611_750_000), decimals: 10 }), 366_117_500);
}

#[test]
fn void_duel_after_a_day_frees_agents_without_slashing() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    inject(&mut c, d, &key(1).1, MIN_CHAOS + 1);
    let (bond_a, bond_b) = (bond(&c, 1), bond(&c, 2));
    let pool = c.get_duel(U64(d)).unwrap().pool.0;
    ctx_at(OWNER, 0, CLOSE + VOID_AFTER_NS);
    c.void_duel(U64(d));
    assert_eq!(bond(&c, 1), bond_a + pool / 2 + pool % 2);
    assert_eq!(bond(&c, 2), bond_b + pool / 2);
    let duel = c.get_duel(U64(d)).unwrap();
    assert!(duel.resolved && duel.injections.is_empty());
    assert!(c.get_agent(Base64VecU8(key(1).1)).unwrap().in_duel.is_none());
    assert_eq!(c.get_agent(Base64VecU8(key(1).1)).unwrap().alpha_bps, 0);
}

#[test]
#[should_panic(expected = "too early")]
fn void_duel_before_a_day_panics() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    ctx_at(OWNER, 0, CLOSE + VOID_AFTER_NS - 1);
    c.void_duel(U64(d));
}

#[test]
#[should_panic(expected = "in duel")]
fn withdraw_bond_in_duel_panics() {
    let (mut c, ..) = setup();
    open(&mut c);
    ctx(OPERATOR, 0);
    let _ = c.withdraw_bond(Base64VecU8(key(1).1), U128(1));
}

#[test]
fn withdraw_bond_after_resolve_ok() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    resolve_at_close(&mut c, d, UP);
    let before = bond(&c, 1);
    ctx(OPERATOR, 0);
    let _ = c.withdraw_bond(Base64VecU8(key(1).1), U128(before / 2));
    assert_eq!(bond(&c, 1), before - before / 2);
    let board = c.leaderboard();
    assert_eq!(board.len(), 2);
    assert!(board.iter().any(|a| a.tee) && board.iter().any(|a| !a.tee));
}

// ---------------------------------------------------------------- review fixes and migrations

#[test]
fn same_nonce_on_two_agents_settles_both() {
    // follower follows A and B; both post nonce 1; both fills settle (fill key is agent-scoped)
    let (mut c, ska, skb) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &ska, &tee, d, Side::Long, 1);
    post_b(&mut c, &skb, d, Side::Short, 1);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), mandate(NEAR, VAULT, vec![]));
    c.follow(Base64VecU8(key(2).1), mandate(NEAR, VAULT, vec![]));
    let v = c.get_vault(FOLLOWER.parse().unwrap()).0;
    ctx(SOLVER, 0);
    let ra = c.settle_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap(), vec![fill(1, "usdc", 50)]);
    let rb = c.settle_follow(Base64VecU8(key(2).1), FOLLOWER.parse().unwrap(), vec![fill(1, "usdc", 50)]);
    assert_eq!((ra.settled, rb.settled), (1, 1));
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - 100);
}

#[test]
fn owner_withdraws_fees() {
    ctx(OWNER, 0);
    let mut c = Contract::init(OWNER.parse().unwrap(), ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), 1_000, 100, U128(MIN_CHAOS)); // fee 1%
    c.add_solver(SOLVER.parse().unwrap());
    ctx(OPERATOR, BOND);
    c.register_agent(Base64VecU8(key(1).1), "m".into(), false);
    ctx(OPERATOR, BOND);
    c.register_agent(Base64VecU8(key(2).1), "m".into(), false);
    let d = open(&mut c);
    ctx(SOLVER, 0);
    c.post_intent(sign(&key(1).0, &intent(&key(1).1, d, Side::Long, 5_000, 1)), None);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), mandate(NEAR, VAULT, vec![]));
    let v = c.get_vault(FOLLOWER.parse().unwrap()).0;
    ctx(SOLVER, 0);
    c.settle_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap(), vec![fill(1, "usdc", NEAR)]);
    assert_eq!(c.get_config().owner_fees.0, NEAR / 100);
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - NEAR - NEAR / 100);
    ctx(OWNER, 0);
    let _ = c.withdraw_fees();
    assert_eq!(c.get_config().owner_fees.0, 0);
}

fn duel_key(d: u64) -> Vec<u8> {
    let mut key = near_sdk::borsh::to_vec(&StorageKey::Duels).unwrap();
    key.extend_from_slice(&d.to_le_bytes());
    key
}

#[test]
fn migrate_duels_rewrites_v1_layout() {
    use near_sdk::borsh::BorshDeserialize;
    let (mut c, ..) = setup();
    let d = open(&mut c);
    let cur = c.get_duel(U64(d)).unwrap();
    let old = DuelV1 { id: cur.id, a: cur.a, b: cur.b, symbol: cur.symbol, open_at: cur.open_at, close_at: cur.close_at, pool: cur.pool, injections: cur.injections, resolved: cur.resolved, last_intent_a: None, last_intent_b: None };
    env::storage_write(&duel_key(d), &near_sdk::borsh::to_vec(&old).unwrap());
    assert!(Duel::try_from_slice(&env::storage_read(&duel_key(d)).unwrap()).is_err());
    ctx(OWNER, 0);
    assert_eq!(c.migrate_duels(U64(0), U64(5)), 1);
    assert_eq!(c.migrate_duels(U64(0), U64(5)), 0); // idempotent
    let migrated = Duel::try_from_slice(&env::storage_read(&duel_key(d)).unwrap()).unwrap();
    assert!(migrated.outcome.is_none() && migrated.open_price.is_none() && !migrated.resolved);
}

#[test]
fn migrate_duels_rewrites_v2_layout_keeping_outcome() {
    use near_sdk::borsh::BorshDeserialize;
    let (mut c, ..) = setup();
    let d = open(&mut c);
    let cur = c.get_duel(U64(d)).unwrap();
    let v2 = DuelV2 {
        id: cur.id, a: cur.a.clone(), b: cur.b, symbol: cur.symbol, open_at: cur.open_at, close_at: cur.close_at, pool: U128(0),
        injections: vec![Injection { kind: "x".into(), payload_hash: Base64VecU8(vec![3; 32]), target: cur.a.clone(), block: U64(1) }],
        resolved: true, last_intent_a: None, last_intent_b: None,
        outcome: Some(OutcomeV2 { open_price: U64(OPEN), close_price: U64(UP), pnl_a: 25, pnl_b: -25, winner: Some(cur.a), slashed: U128(7) }),
    };
    env::storage_write(&duel_key(d), &near_sdk::borsh::to_vec(&v2).unwrap());
    ctx(OWNER, 0);
    assert_eq!(c.migrate_duels(U64(d), U64(d)), 1);
    let m = Duel::try_from_slice(&env::storage_read(&duel_key(d)).unwrap()).unwrap();
    let o = m.outcome.unwrap();
    assert_eq!((o.pnl_a, o.pnl_b, o.slashed.0, o.injections), (25, -25, 7, 1));
    assert_eq!(m.open_price.unwrap().0, OPEN);
    assert!(m.resolved);
}
