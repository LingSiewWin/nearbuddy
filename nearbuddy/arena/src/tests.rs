use super::*;
use crate::duels::price8;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use near_sdk::{NearToken, PromiseResult};

pub const CONTRACT: &str = "arena.testnet";
pub const OWNER: &str = "solver.testnet"; // contract owner = solver account in the hackathon deploy
pub const SOLVER: &str = "solver.testnet";
pub const ORACLE: &str = "price-oracle.testnet";
pub const OPERATOR: &str = "operator.testnet";
pub const FOLLOWER: &str = "follower.testnet";
pub const INTENTS: &str = "intents.testnet";
pub const VAULT_CAP: u128 = 1_000 * NEAR;
pub const NOW: u64 = 1_700_000_000_000_000_000;
pub const CLOSE: u64 = NOW + 60_000_000_000; // +60 s
pub const LOCK: u64 = 10_000_000_000; // intent lock set by `fresh`, 10 s
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
    SignedIntent {
        intent: i.clone(),
        signature: Base64VecU8(sk.sign(&intent_message(i)).to_bytes().to_vec()),
    }
}

/// Contract with the solver registered, a 60 s duel floor and a 10 s intent lock (`LOCK`).
pub fn fresh(fee_bps: u16) -> Contract {
    ctx(OWNER, 0);
    let mut c = Contract::init(
        OWNER.parse().unwrap(),
        ORACLE.parse().unwrap(),
        U128(ORACLE_DEPOSIT),
        1_000,
        fee_bps,
        U128(MIN_CHAOS),
        INTENTS.parse().unwrap(),
        U128(VAULT_CAP),
    );
    ctx(OWNER, 1);
    c.add_solver(SOLVER.parse().unwrap());
    c.set_oracle(
        ORACLE.parse().unwrap(),
        U128(ORACLE_DEPOSIT),
        60,
        LOCK / 1_000_000_000,
    );
    c
}

/// `sk`'s proof of possession for `register_agent` called by `owner`.
pub fn register_sig(sk: &SigningKey, owner: &str) -> Base64VecU8 {
    Base64VecU8(
        sk.sign(&register_bytes(
            &CONTRACT.parse().unwrap(),
            &owner.parse().unwrap(),
        ))
        .to_bytes()
        .to_vec(),
    )
}

/// OPERATOR registers key `seed` with BOND, signing the register message with that key.
pub fn register(c: &mut Contract, seed: u8, model: &str, tee: bool) -> AgentView {
    let (sk, pk) = key(seed);
    ctx(OPERATOR, BOND);
    c.register_agent(
        Base64VecU8(pk),
        model.into(),
        tee,
        register_sig(&sk, OPERATOR),
    )
}

/// Contract with solver registered and agents A (seed 1, TEE-backed) and B (seed 2, plain) bonded.
pub fn setup() -> (Contract, SigningKey, SigningKey) {
    let mut c = fresh(0);
    register(&mut c, 1, MODEL_A, true);
    register(&mut c, 2, MODEL_B, false);
    ctx(OWNER, 0);
    (c, key(1).0, key(2).0)
}

fn price_data(asset: &str, price8: u64, ts: u64) -> PriceData {
    PriceData {
        timestamp: U64(ts),
        recency_duration_sec: 300,
        prices: vec![AssetOptionalPrice {
            asset_id: asset.into(),
            price: Some(OraclePrice {
                multiplier: U128(price8 as u128),
                decimals: 8,
            }),
        }],
    }
}

/// Outlayer answers `oracle_call`: the oracle account calls back with our contract as sender.
fn oracle_answers(c: &mut Contract, d: u64, phase: &str, price8: u64, ts: u64) {
    ctx_at(ORACLE, 0, ts);
    c.oracle_on_call(
        CONTRACT.parse().unwrap(),
        price_data("wrap.near", price8, ts),
        format!("{phase}:{d}"),
    );
}

/// Open a duel and let the oracle deliver the open price.
pub fn open(c: &mut Contract) -> u64 {
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c
        .open_duel(
            Base64VecU8(key(1).1),
            Base64VecU8(key(2).1),
            "wrap.near".into(),
            U64(CLOSE),
        )
        .0;
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
    ctx(OWNER, 1);
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
    let t = tee_text(
        2,
        "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        &[0xed; 32],
        &[0xc4; 32],
    );
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
    c.post_intent(
        tee_intent(&ska, d, 1, req, res),
        Some(tee_proof(&tee, 2, MODEL_A, req, res)),
    );
    assert_eq!(
        c.get_duel(U64(d))
            .unwrap()
            .last_intent_a
            .unwrap()
            .proof_hash
            .0,
        proof_hash(&req, &res)
    );
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
    c.post_intent(
        tee_intent(&ska, d, 1, req, res),
        Some(tee_proof(&tee, 2, MODEL_A, req, res)),
    );
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
    c.post_intent(
        tee_intent(&ska, d, 1, req, [0xcc; 32]),
        Some(tee_proof(&tee, 2, MODEL_A, req, res)),
    );
}

#[test]
#[should_panic(expected = "unknown tee signer")]
fn tee_unregistered_signer_rejected() {
    let (mut c, ska, _) = setup();
    let d = open(&mut c);
    let (req, res) = ([0xaa; 32], [0xbb; 32]);
    ctx(SOLVER, 0);
    c.post_intent(
        tee_intent(&ska, d, 1, req, res),
        Some(tee_proof(&key(7).0, 2, MODEL_A, req, res)),
    );
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
    c.post_intent(
        tee_intent(&ska, d, 1, req, res),
        Some(tee_proof(&tee, 2, MODEL_B, req, res)),
    );
}

#[test]
#[should_panic(expected = "tee proof required")]
fn tee_agent_cannot_post_without_proof() {
    let (mut c, ska, _) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    c.post_intent(
        sign(&ska, &intent(&key(1).1, d, Side::Long, 5_000, 1)),
        None,
    );
}

#[test]
#[should_panic(expected = "provider proof required")]
fn tee_agent_gateway_proof_refused() {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    let (req, res) = ([0x18; 32], [0xd5; 32]);
    ctx(SOLVER, 0);
    c.post_intent(
        tee_intent(&ska, d, 1, req, res),
        Some(tee_proof(&tee, 1, "anything", req, res)),
    );
}

#[test]
fn plain_agent_may_attach_a_gateway_proof() {
    let (mut c, _, skb) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    let (req, res) = ([0x18; 32], [0xd5; 32]);
    let mut i = intent(&key(2).1, d, Side::Short, 5_000, 1);
    i.proof_hash = Base64VecU8(proof_hash(&req, &res));
    ctx(SOLVER, 0);
    c.post_intent(
        sign(&skb, &i),
        Some(tee_proof(&tee, 1, "anything", req, res)),
    );
    assert!(c.get_duel(U64(d)).unwrap().last_intent_b.is_some());
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
    ctx(OPERATOR, 1);
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
    assert!(
        b < BOND && b > BOND - NEAR / 10,
        "bond {b} should be BOND minus a few KB of storage"
    );
}

#[test]
#[should_panic(expected = "agent exists")]
fn register_twice_panics() {
    let (mut c, ..) = setup();
    register(&mut c, 1, "again", false);
}

#[test]
#[should_panic(expected = "bond required")]
fn register_without_bond_panics() {
    let (mut c, ..) = setup();
    ctx(OPERATOR, 1);
    c.register_agent(
        Base64VecU8(key(3).1),
        "m".into(),
        false,
        register_sig(&key(3).0, OPERATOR),
    );
}

#[test]
#[should_panic(expected = "bad register signature")]
fn register_without_key_possession_panics() {
    // squatter knows B's public key but not its secret: signs with another key
    let mut c = fresh(0);
    ctx(FOLLOWER, BOND);
    c.register_agent(
        Base64VecU8(key(2).1),
        MODEL_B.into(),
        false,
        register_sig(&key(3).0, FOLLOWER),
    );
}

#[test]
#[should_panic(expected = "bad register signature")]
fn register_sig_is_bound_to_the_caller() {
    // a valid proof made for OPERATOR cannot be replayed by FOLLOWER
    let mut c = fresh(0);
    ctx(FOLLOWER, BOND);
    c.register_agent(
        Base64VecU8(key(2).1),
        MODEL_B.into(),
        false,
        register_sig(&key(2).0, OPERATOR),
    );
}

#[test]
fn register_message_view_matches_signed_bytes() {
    let c = fresh(0);
    let m = c.register_message(OPERATOR.parse().unwrap()).0;
    assert_eq!(
        m,
        [
            REGISTER_DOMAIN,
            CONTRACT.as_bytes(),
            &[0],
            OPERATOR.as_bytes()
        ]
        .concat()
    );
    assert!(verify(&key(1).1, &m, &register_sig(&key(1).0, OPERATOR).0));
}

#[test]
#[should_panic(expected = "bad register signature")]
fn register_sig_for_another_arena_panics() {
    // the same owner, the same key, but signed for a staging arena: not valid here
    let mut c = fresh(0);
    let (sk, pk) = key(1);
    let other = sk.sign(&register_bytes(
        &"staging-arena.testnet".parse().unwrap(),
        &OPERATOR.parse().unwrap(),
    ));
    ctx(OPERATOR, BOND);
    c.register_agent(
        Base64VecU8(pk),
        MODEL_A.into(),
        false,
        Base64VecU8(other.to_bytes().to_vec()),
    );
}

#[test]
#[should_panic(expected = "model_id too long")]
fn register_model_id_too_long_panics() {
    let mut c = fresh(0);
    register(&mut c, 1, &"m".repeat(65), false);
}

#[test]
#[should_panic(expected = "symbol too long")]
fn open_duel_symbol_too_long_panics() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    c.open_duel(
        Base64VecU8(key(1).1),
        Base64VecU8(key(2).1),
        "s".repeat(65),
        U64(CLOSE),
    );
}

#[test]
#[should_panic(expected = "label too long")]
fn tee_signer_label_too_long_panics() {
    let (mut c, ..) = setup();
    ctx(OWNER, 1);
    c.add_tee_signer(Base64VecU8(key(7).1), "l".repeat(65));
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
    c.open_duel(
        Base64VecU8(key(1).1),
        Base64VecU8(key(2).1),
        "wrap.near".into(),
        U64(CLOSE),
    );
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
    let d = c
        .open_duel(
            Base64VecU8(key(1).1),
            Base64VecU8(key(2).1),
            "wrap.near".into(),
            U64(CLOSE),
        )
        .0;
    ctx(OPERATOR, 0);
    c.oracle_on_call(
        CONTRACT.parse().unwrap(),
        price_data("wrap.near", OPEN, NOW),
        format!("open:{d}"),
    );
}

#[test]
#[should_panic(expected = "not our request")]
fn oracle_answer_to_foreign_request_rejected() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c
        .open_duel(
            Base64VecU8(key(1).1),
            Base64VecU8(key(2).1),
            "wrap.near".into(),
            U64(CLOSE),
        )
        .0;
    ctx(ORACLE, 0);
    c.oracle_on_call(
        OPERATOR.parse().unwrap(),
        price_data("wrap.near", OPEN, NOW),
        format!("open:{d}"),
    );
}

#[test]
#[should_panic(expected = "no price")]
fn oracle_answer_for_wrong_asset_rejected() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c
        .open_duel(
            Base64VecU8(key(1).1),
            Base64VecU8(key(2).1),
            "wrap.near".into(),
            U64(CLOSE),
        )
        .0;
    ctx(ORACLE, 0);
    c.oracle_on_call(
        CONTRACT.parse().unwrap(),
        price_data("eth.bridge.near", OPEN, NOW),
        format!("open:{d}"),
    );
}

#[test]
fn request_open_price_retries_until_answered() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c
        .open_duel(
            Base64VecU8(key(1).1),
            Base64VecU8(key(2).1),
            "wrap.near".into(),
            U64(CLOSE),
        )
        .0;
    ctx(OPERATOR, ORACLE_DEPOSIT);
    c.request_open_price(U64(d));
    oracle_answers(&mut c, d, "open", OPEN, NOW);
    ctx(OPERATOR, ORACLE_DEPOSIT);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.request_open_price(U64(d))
    }));
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
    assert!(
        bond(&c, 2) < before,
        "intent storage is paid from the agent bond"
    );
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
    c.post_intent(
        sign(&skb, &intent(&key(2).1, d, Side::Long, 5_000, 1)),
        None,
    );
}

#[test]
#[should_panic(expected = "bad size")]
fn post_intent_bad_size_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    c.post_intent(
        sign(&skb, &intent(&key(2).1, d, Side::Long, 10_001, 1)),
        None,
    );
}

#[test]
#[should_panic(expected = "bad signature")]
fn post_intent_bad_sig_panics() {
    let (mut c, ska, _) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    // signed by A's key but claims B's pk
    c.post_intent(
        sign(&ska, &intent(&key(2).1, d, Side::Long, 5_000, 1)),
        None,
    );
}

#[test]
fn anyone_may_relay_a_signed_intent() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    ctx(OPERATOR, 0);
    c.post_intent(
        sign(&skb, &intent(&key(2).1, d, Side::Long, 5_000, 1)),
        None,
    );
    assert_eq!(
        c.get_duel(U64(d)).unwrap().last_intent_b.unwrap().nonce.0,
        1
    );
}

#[test]
#[should_panic(expected = "intent lock")]
fn post_intent_inside_lock_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    ctx_at(SOLVER, 0, CLOSE - LOCK);
    c.post_intent(
        sign(&skb, &intent(&key(2).1, d, Side::Long, 5_000, 1)),
        None,
    );
}

#[test]
fn post_intent_just_before_lock_ok() {
    let (mut c, _, skb) = setup();
    assert_eq!(c.get_config().intent_lock_s, 10);
    let d = open(&mut c);
    ctx_at(SOLVER, 0, CLOSE - LOCK - 1);
    c.post_intent(
        sign(&skb, &intent(&key(2).1, d, Side::Long, 5_000, 1)),
        None,
    );
    assert!(c.get_duel(U64(d)).unwrap().last_intent_b.is_some());
}

#[test]
#[should_panic(expected = "intent_lock_s too large")]
fn set_oracle_bounds_lock_to_half_the_floor() {
    let (mut c, ..) = setup();
    ctx(OWNER, 1);
    c.set_oracle(ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), 60, 31);
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
        min_out_per_near: U128(1), // `follow` refuses 0; 1 unit per NEAR keeps the old cases unaffected
        revoked_at: U64(0),
    }
}

pub fn fill(nonce: u64, token: &str, amount: u128) -> Fill {
    Fill {
        intent_nonce: U64(nonce),
        token: token.into(),
        amount_in: U128(amount),
        amount_out: U128(1_000_000),
        swap_tx: "0xabc".into(),
    }
}

const VAULT: u128 = 10 * NEAR;
/// `withdraw_delay_ns` default: the grace a fronted fill keeps after unfollow or expiry.
const GRACE: u64 = 900 * 1_000_000_000;

/// setup + TEE signer + duel + A posts nonce 1 through its proof + follower deposits 10 NEAR and
/// follows A (TEE-backed; plain B cannot be followed) with the given mandate.
/// Returns the vault balance after deposit and follow (storage was charged from it).
pub fn setup_follow(m: Mandate) -> (Contract, u64, u128) {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &ska, &tee, d, Side::Long, 1);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), m);
    ctx(SOLVER, 0);
    let v = c.get_vault(FOLLOWER.parse().unwrap()).0;
    (c, d, v)
}

/// This contract running its own callback at `ts`, with `results` as the promise answers.
fn callback_ctx(ts: u64, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(CONTRACT.parse().unwrap())
        .account_balance(NearToken::from_near(100))
        .block_timestamp(ts);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

/// `mt_batch_balance_of` answer.
fn balances(b: &[u128]) -> PromiseResult {
    PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&b.iter().map(|x| U128(*x)).collect::<Vec<_>>()).unwrap(),
    )
}

/// The balance that exactly covers a batch: per token, what is accounted plus the batch's outputs.
fn covering(c: &Contract, fills: &[Fill]) -> PromiseResult {
    let mut tokens: Vec<&str> = vec![];
    for f in fills {
        if !tokens.contains(&f.token.as_str()) {
            tokens.push(&f.token);
        }
    }
    let b: Vec<u128> = tokens
        .iter()
        .map(|t| {
            c.get_accounted(t.to_string()).0
                + fills
                    .iter()
                    .filter(|f| f.token == *t)
                    .map(|f| f.amount_out.0)
                    .sum::<u128>()
        })
        .collect();
    balances(&b)
}

/// The contract's panic text out of a caught unit-test panic (the mock wraps it in
/// `HostError(GuestPanic { panic_msg: "..." })`).
fn panic_msg(p: Box<dyn std::any::Any + Send>) -> String {
    let s = p
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    match s.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.split('"').next().unwrap_or_default().to_string(),
        None => s,
    }
}

/// The solver's `settle_follow` for agent `seed` at `ts`, then the callback with `answer` as the
/// balance view. `Err` is the callback's panic (every fill rejected); state is untouched then.
fn settle_answered(
    c: &mut Contract,
    seed: u8,
    fills: Vec<Fill>,
    answer: PromiseResult,
    ts: u64,
) -> Result<SettleReport, String> {
    ctx_at(SOLVER, 0, ts);
    let _ = c.settle_follow(
        Base64VecU8(key(seed).1),
        FOLLOWER.parse().unwrap(),
        fills.clone(),
    );
    let seq = c.outflow_seq;
    callback_ctx(ts, vec![answer]);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.on_settle_follow(
            Base64VecU8(key(seed).1),
            FOLLOWER.parse().unwrap(),
            SOLVER.parse().unwrap(),
            fills,
            seq,
        )
    }))
    .map_err(panic_msg);
    ctx_at(SOLVER, 0, ts);
    r
}

/// Settle agent A's fills with their outputs delivered; panics with the reason if none settles.
fn settle(c: &mut Contract, fills: Vec<Fill>) -> SettleReport {
    let answer = covering(c, &fills);
    settle_answered(c, 1, fills, answer, NOW).unwrap_or_else(|e| panic!("{e}"))
}

/// Settle agent A's fills with their outputs delivered and return the rejection that refused the
/// whole batch.
fn settle_rejects(c: &mut Contract, fills: Vec<Fill>) -> String {
    let answer = covering(c, &fills);
    settle_answered(c, 1, fills, answer, NOW).expect_err("batch should be refused")
}

#[test]
#[should_panic(expected = "agent unverified")]
fn follow_plain_agent_refused() {
    let (mut c, ..) = setup();
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(2).1), mandate(NEAR, VAULT, vec![]));
}

#[test]
fn follow_tee_agent_ok() {
    let (mut c, ..) = setup();
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), mandate(NEAR, VAULT, vec![]));
    assert!(
        c.get_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap())
            .is_some()
    );
    assert!(
        c.get_follow(Base64VecU8(key(2).1), FOLLOWER.parse().unwrap())
            .is_none()
    );
    let logs = near_sdk::test_utils::get_logs();
    assert!(
        logs.last().unwrap().contains(r#""event":"follow""#),
        "{logs:?}"
    );
}

#[test]
fn deposit_and_follow_pay_their_storage() {
    let (_, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    assert!(v < VAULT && v > VAULT - NEAR / 10, "vault {v}");
}

#[test]
fn fill_at_cap_ok_and_credits_the_output() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let mut f = fill(1, "usdc", NEAR);
    f.amount_out = U128(3_000_000);
    let r = settle(&mut c, vec![f]);
    assert_eq!(r.settled, 1);
    assert_eq!(r.debited.0, NEAR);
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - NEAR);
    assert_eq!(c.get_vault(SOLVER.parse().unwrap()).0, NEAR);
    assert_eq!(
        c.get_holding(FOLLOWER.parse().unwrap(), "usdc".into()).0,
        3_000_000
    );
    assert_eq!(c.get_accounted("usdc".into()).0, 3_000_000);
}

// Separate test: unit-test storage is global per test, so a second Contract in the same test
// would see the first one's used_nonces.
#[test]
fn fill_over_cap_rejected() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    assert_eq!(
        settle_rejects(&mut c, vec![fill(1, "usdc", NEAR + 1)]),
        "over cap"
    );
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v);
}

#[test]
fn fill_wrong_token_rejected() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec!["usdc"]));
    assert_eq!(
        settle_rejects(&mut c, vec![fill(1, "wbtc", 50)]),
        "token not allowed"
    );
}

#[test]
fn fill_after_expiry_and_its_grace_rejected() {
    // expires at NOW + 1 ms; a fill landing within withdraw_delay (900 s) after that still settles
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 1_000_000 + GRACE);
    assert_eq!(r.unwrap_err(), "mandate expired");
}

#[test]
fn fill_landing_just_after_expiry_settles_inside_the_grace() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 1_000_000 + GRACE - 1);
    assert_eq!(r.unwrap().settled, 1);
}

#[test]
fn fill_after_revoke_and_its_grace_rejected() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 0);
    c.unfollow(Base64VecU8(key(1).1));
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + GRACE);
    assert_eq!(r.unwrap_err(), "mandate revoked");
}

#[test]
fn swap_fronted_before_unfollow_settles_inside_the_grace() {
    // the follower unfollows after the solver fronted the swap; the fill lands 899 s later and settles
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 0);
    c.unfollow(Base64VecU8(key(1).1));
    let m = c
        .get_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap())
        .unwrap();
    assert_eq!((m.revoked, m.revoked_at.0), (true, NOW));
    // a second unfollow does not restart the grace
    ctx_at(FOLLOWER, 0, NOW + 10);
    c.unfollow(Base64VecU8(key(1).1));
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + GRACE - 1);
    assert_eq!(r.unwrap().settled, 1);
}

#[test]
#[should_panic(expected = "price floor required")]
fn follow_without_a_price_floor_panics() {
    let (mut c, ..) = setup();
    ctx(FOLLOWER, VAULT);
    c.deposit();
    let mut m = mandate(NEAR, VAULT, vec![]);
    m.min_out_per_near = U128(0);
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), m);
}

#[test]
fn duplicate_fill_noop() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    settle(&mut c, vec![fill(1, "usdc", 50)]);
    assert_eq!(
        settle_rejects(&mut c, vec![fill(1, "usdc", 50)]),
        "duplicate fill"
    );
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - 50);
}

#[test]
fn foreign_nonce_rejected() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    assert_eq!(
        settle_rejects(&mut c, vec![fill(99, "usdc", 50)]),
        "nonce unknown"
    );
}

#[test]
#[should_panic(expected = "not solver")]
fn non_solver_cannot_settle() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(OPERATOR, 0);
    let _ = c.settle_follow(
        Base64VecU8(key(1).1),
        FOLLOWER.parse().unwrap(),
        vec![fill(1, "usdc", 50)],
    );
}

#[test]
fn insufficient_vault_rejected() {
    let (mut c, _, v) = setup_follow(mandate(VAULT, VAULT, vec![]));
    assert_eq!(
        settle_rejects(&mut c, vec![fill(1, "usdc", v + 1)]),
        "insufficient"
    );
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v);
}

#[test]
fn allowance_exhausted_rejected() {
    let (mut c, d, _) = setup_follow(mandate(NEAR, NEAR + NEAR / 2, vec![]));
    settle(&mut c, vec![fill(1, "usdc", NEAR)]);
    // A posts a second intent (nonce 2), then a fill against it exceeds the remaining allowance
    post_a(&mut c, &key(1).0, &key(7).0, d, Side::Short, 2);
    assert_eq!(
        settle_rejects(&mut c, vec![fill(2, "usdc", NEAR * 6 / 10)]),
        "allowance exhausted"
    );
    assert_eq!(
        c.get_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap())
            .unwrap()
            .spent
            .0,
        NEAR
    );
}

#[test]
fn absurd_follower_spent_is_rejected_not_panicked() {
    let mut m = mandate(NEAR, u128::MAX, vec![]);
    m.spent = U128(u128::MAX);
    let (mut c, _, v) = setup_follow(m);
    assert_eq!(
        settle_rejects(&mut c, vec![fill(1, "usdc", 50)]),
        "allowance exhausted"
    );
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v);
}

// ---------------------------------------------------------------- verified settlement (deploy 15)

#[test]
fn fill_without_its_output_delivered_is_refused() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let mut f = fill(1, "usdc", 50);
    f.amount_out = U128(100);
    let r = settle_answered(&mut c, 1, vec![f], balances(&[99]), NOW);
    assert_eq!(r.unwrap_err(), "no receipt");
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v);
    assert_eq!(c.get_accounted("usdc".into()).0, 0);
}

#[test]
fn failed_view_is_no_receipt() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let r = settle_answered(
        &mut c,
        1,
        vec![fill(1, "usdc", 50)],
        PromiseResult::Failed,
        NOW,
    );
    assert_eq!(r.unwrap_err(), "no receipt");
}

#[test]
fn malformed_or_short_view_is_no_receipt() {
    let (mut c, d, _) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let garbage = PromiseResult::Successful(b"{\"not\":\"a list\"}".to_vec());
    let r = settle_answered(&mut c, 1, vec![fill(1, "usdc", 50)], garbage, NOW);
    assert_eq!(r.unwrap_err(), "no receipt");
    // two tokens asked, one balance answered
    let (sk, tee) = (key(1).0, key(7).0);
    post_a(&mut c, &sk, &tee, d, Side::Short, 2);
    let fills = vec![fill(1, "usdc", 50), fill(2, "wbtc", 50)];
    let r = settle_answered(&mut c, 1, fills, balances(&[10]), NOW);
    assert_eq!(r.unwrap_err(), "no receipt");
}

#[test]
fn oversized_view_is_no_receipt() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let big = PromiseResult::Successful(vec![b' '; 65]);
    let r = settle_answered(&mut c, 1, vec![fill(1, "usdc", 50)], big, NOW);
    assert_eq!(r.unwrap_err(), "no receipt");
}

#[test]
fn one_balance_cannot_back_two_fills() {
    // both outputs claim the same 1 unit: the first settles, the second has nothing behind it
    let (mut c, d, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    post_a(&mut c, &key(1).0, &key(7).0, d, Side::Short, 2);
    let fills = vec![fill(1, "usdc", 50), fill(2, "usdc", 50)];
    let r = settle_answered(&mut c, 1, fills, balances(&[1_000_000]), NOW).unwrap();
    assert_eq!(r.settled, 1);
    assert_eq!(r.rejected, vec![(1, "no receipt".to_string())]);
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - 50);
    // a later batch sees the 1 unit as accounted
    let r = settle_answered(
        &mut c,
        1,
        vec![fill(2, "usdc", 50)],
        balances(&[1_000_000]),
        NOW,
    );
    assert_eq!(r.unwrap_err(), "no receipt");
}

#[test]
fn zero_output_never_settles() {
    // a follow always carries a floor, which refuses 0 out first; a migrated floor-0 mandate hits
    // the zero check in the receipt step
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let mut f = fill(1, "usdc", 50);
    f.amount_out = U128(0);
    let r = settle_answered(&mut c, 1, vec![f.clone()], balances(&[1_000]), NOW);
    assert_eq!(r.unwrap_err(), "below min price");
    c.follows
        .get_mut(&crate::follow::follow_key(
            &key(1).1,
            &FOLLOWER.parse().unwrap(),
        ))
        .unwrap()
        .current_mut()
        .min_out_per_near = U128(0);
    let r = settle_answered(&mut c, 1, vec![f], balances(&[1_000]), NOW);
    assert_eq!(r.unwrap_err(), "no receipt");
}

#[test]
fn outflow_during_the_view_rejects_the_batch() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let fills = vec![fill(1, "usdc", 50)];
    ctx(SOLVER, 0);
    let _ = c.settle_follow(
        Base64VecU8(key(1).1),
        FOLLOWER.parse().unwrap(),
        fills.clone(),
    );
    let seq = c.outflow_seq;
    c.outflow_seq += 1; // a token withdrawal confirmed while the view was in flight
    callback_ctx(NOW, vec![balances(&[1_000])]);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.on_settle_follow(
            Base64VecU8(key(1).1),
            FOLLOWER.parse().unwrap(),
            SOLVER.parse().unwrap(),
            fills,
            seq,
        )
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "outflow during view");
}

#[test]
fn removed_solver_is_not_paid_by_an_inflight_callback() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let fills = vec![fill(1, "usdc", 50)];
    ctx(SOLVER, 0);
    let _ = c.settle_follow(
        Base64VecU8(key(1).1),
        FOLLOWER.parse().unwrap(),
        fills.clone(),
    );
    ctx(OWNER, 1);
    c.remove_solver(SOLVER.parse().unwrap());
    callback_ctx(NOW, vec![balances(&[1_000])]);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.on_settle_follow(
            Base64VecU8(key(1).1),
            FOLLOWER.parse().unwrap(),
            SOLVER.parse().unwrap(),
            fills,
            0,
        )
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "solver removed");
}

#[test]
#[should_panic(expected = "not solver")]
fn removed_solver_cannot_settle() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(OWNER, 1);
    c.remove_solver(SOLVER.parse().unwrap());
    ctx(SOLVER, 0);
    let _ = c.settle_follow(
        Base64VecU8(key(1).1),
        FOLLOWER.parse().unwrap(),
        vec![fill(1, "usdc", 50)],
    );
}

#[test]
#[should_panic(expected = "not a solver")]
fn remove_unknown_solver_panics() {
    let mut c = fresh(0);
    ctx(OWNER, 1);
    c.remove_solver(FOLLOWER.parse().unwrap());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn admin_call_without_one_yocto_panics() {
    let mut c = fresh(0);
    ctx(OWNER, 0);
    c.add_solver(FOLLOWER.parse().unwrap());
}

#[test]
#[should_panic(expected = "dry quote unsettleable")]
fn dry_quote_fill_refused() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let mut f = fill(1, "usdc", 50);
    f.swap_tx = "dry-quote:2026-11-06T00:00:00Z".into();
    ctx(SOLVER, 0);
    let _ = c.settle_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap(), vec![f]);
}

#[test]
#[should_panic(expected = "too many fills")]
fn eleven_fills_refused() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(SOLVER, 0);
    let _ = c.settle_follow(
        Base64VecU8(key(1).1),
        FOLLOWER.parse().unwrap(),
        (0..11).map(|n| fill(n, "usdc", 1)).collect(),
    );
}

#[test]
#[should_panic(expected = "empty fills")]
fn empty_batch_refused() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(SOLVER, 0);
    let _ = c.settle_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap(), vec![]);
}

#[test]
fn price_floor_refuses_a_cheap_fill() {
    // floor: 3 USDC (6 dp) per NEAR; 1 NEAR in for 2.9 USDC out is refused, 3.0 settles
    let mut m = mandate(NEAR, VAULT, vec![]);
    m.min_out_per_near = U128(3_000_000);
    let (mut c, d, _) = setup_follow(m);
    let mut f = fill(1, "usdc", NEAR);
    f.amount_out = U128(2_900_000);
    assert_eq!(settle_rejects(&mut c, vec![f]), "below min price");
    post_a(&mut c, &key(1).0, &key(7).0, d, Side::Short, 2);
    let mut f = fill(2, "usdc", NEAR);
    f.amount_out = U128(3_000_000);
    assert_eq!(settle(&mut c, vec![f]).settled, 1);
}

#[test]
fn price_floor_overflow_is_rejected_not_panicked() {
    let mut m = mandate(u128::MAX, u128::MAX, vec![]);
    m.min_out_per_near = U128(u128::MAX);
    let (mut c, ..) = setup_follow(m);
    assert_eq!(
        settle_rejects(&mut c, vec![fill(1, "usdc", 2)]),
        "amount overflow"
    );
}

#[test]
fn fee_counts_inside_the_per_fill_cap() {
    // fee 1 %: 0.995 NEAR in costs 1.00495 NEAR, over a 1 NEAR cap
    let mut c = fresh(100);
    register(&mut c, 1, MODEL_A, true);
    register(&mut c, 2, "m", false);
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &key(1).0, &tee, d, Side::Long, 1);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), mandate(NEAR, VAULT, vec![]));
    assert_eq!(
        settle_rejects(&mut c, vec![fill(1, "usdc", NEAR * 995 / 1000)]),
        "over cap"
    );
}

#[test]
fn delayed_withdraw_pays_after_the_delay_only() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 1);
    c.request_withdraw(U128(4 * NEAR));
    let (amt, ready) = c.get_pending_withdraw(FOLLOWER.parse().unwrap()).unwrap();
    assert_eq!((amt.0, ready.0), (4 * NEAR, NOW + 900 * 1_000_000_000));
    assert_eq!(
        c.get_vault(FOLLOWER.parse().unwrap()).0,
        v,
        "nothing moves yet"
    );
    // a fill the solver fronted before the request still settles during the delay
    settle(&mut c, vec![fill(1, "usdc", NEAR)]);
    ctx_at(FOLLOWER, 1, NOW + 900 * 1_000_000_000);
    let _ = c.withdraw();
    assert_eq!(
        c.get_vault(FOLLOWER.parse().unwrap()).0,
        v - NEAR - 4 * NEAR
    );
    assert!(c.get_pending_withdraw(FOLLOWER.parse().unwrap()).is_none());
}

#[test]
#[should_panic(expected = "withdrawal delay not elapsed")]
fn withdraw_inside_the_delay_panics() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 1);
    c.request_withdraw(U128(NEAR));
    ctx_at(FOLLOWER, 1, NOW + 899 * 1_000_000_000);
    let _ = c.withdraw();
}

#[test]
fn withdraw_pays_what_is_left_when_settles_drained_the_vault() {
    let (mut c, _, v) = setup_follow(mandate(VAULT, VAULT, vec![]));
    ctx(FOLLOWER, 1);
    c.request_withdraw(U128(v));
    settle(&mut c, vec![fill(1, "usdc", NEAR)]);
    ctx_at(FOLLOWER, 1, NOW + 900 * 1_000_000_000);
    let _ = c.withdraw();
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, 0);
}

#[test]
#[should_panic(expected = "withdrawal already pending")]
fn second_withdraw_request_panics() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 1);
    c.request_withdraw(U128(NEAR));
    c.request_withdraw(U128(NEAR));
}

#[test]
#[should_panic(expected = "no pending withdrawal")]
fn withdraw_without_request_panics() {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 1);
    let _ = c.withdraw();
}

#[test]
#[should_panic(expected = "delay out of range")]
fn withdraw_delay_bounded() {
    let mut c = fresh(0);
    ctx(OWNER, 1);
    c.set_withdraw_delay(59);
}

/// Settle one fill of 3 USDC out for the follower and return the contract.
fn with_holding() -> Contract {
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let mut f = fill(1, "usdc", 50);
    f.amount_out = U128(3_000_000);
    settle(&mut c, vec![f]);
    c
}

#[test]
fn withdraw_token_debits_first_and_confirms_in_the_callback() {
    let mut c = with_holding();
    ctx(FOLLOWER, 1);
    let _ = c.withdraw_token("usdc".into(), U128(1_000_000));
    assert_eq!(
        c.get_holding(FOLLOWER.parse().unwrap(), "usdc".into()).0,
        2_000_000
    );
    assert_eq!(c.get_accounted("usdc".into()).0, 3_000_000, "still held");
    callback_ctx(NOW, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_withdraw_token(FOLLOWER.parse().unwrap(), "usdc".into(), U128(1_000_000)));
    assert_eq!(c.get_accounted("usdc".into()).0, 2_000_000);
    assert_eq!(c.outflow_seq, 1);
}

#[test]
fn failed_token_transfer_recredits_the_holding() {
    let mut c = with_holding();
    ctx(FOLLOWER, 1);
    let _ = c.withdraw_token("usdc".into(), U128(3_000_000));
    callback_ctx(NOW, vec![PromiseResult::Failed]);
    assert!(!c.on_withdraw_token(FOLLOWER.parse().unwrap(), "usdc".into(), U128(3_000_000)));
    assert_eq!(
        c.get_holding(FOLLOWER.parse().unwrap(), "usdc".into()).0,
        3_000_000
    );
    assert_eq!(
        (c.get_accounted("usdc".into()).0, c.outflow_seq),
        (3_000_000, 0)
    );
}

#[test]
#[should_panic(expected = "insufficient")]
fn withdraw_token_over_holding_panics() {
    let mut c = with_holding();
    ctx(FOLLOWER, 1);
    let _ = c.withdraw_token("usdc".into(), U128(3_000_001));
}

#[test]
fn pause_blocks_new_activity_and_leaves_exits_open() {
    let (mut c, d, _) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(OWNER, 1);
    c.set_paused(true);
    assert!(c.get_config().paused);
    let refused = |f: &mut dyn FnMut()| {
        panic_msg(std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_err())
    };
    ctx(FOLLOWER, NEAR);
    assert_eq!(
        refused(&mut || {
            c.deposit();
        }),
        "paused"
    );
    ctx(FOLLOWER, 0);
    assert_eq!(
        refused(&mut || c.follow(Base64VecU8(key(1).1), mandate(NEAR, VAULT, vec![]))),
        "paused"
    );
    ctx(SOLVER, 0);
    assert_eq!(
        refused(&mut || {
            let _ = c.settle_follow(
                Base64VecU8(key(1).1),
                FOLLOWER.parse().unwrap(),
                vec![fill(1, "usdc", 50)],
            );
        }),
        "paused"
    );
    let i = intent(&key(2).1, d, Side::Long, 5_000, 1);
    let s = sign(&key(2).0, &i);
    assert_eq!(refused(&mut || c.post_intent(s.clone(), None)), "paused");
    // exits
    ctx(FOLLOWER, 1);
    c.request_withdraw(U128(NEAR));
    ctx(FOLLOWER, 0);
    c.unfollow(Base64VecU8(key(1).1));
    ctx(OWNER, 1);
    c.set_paused(false);
    ctx(FOLLOWER, NEAR);
    c.deposit();
}

#[test]
#[should_panic(expected = "vault cap")]
fn deposits_stop_at_the_vault_cap() {
    let mut c = fresh(0);
    ctx(OWNER, 1);
    c.set_vault_cap(U128(5 * NEAR));
    ctx(FOLLOWER, 3 * NEAR);
    c.deposit();
    assert!(c.get_config().vault_total.0 <= 3 * NEAR);
    ctx(OPERATOR, 3 * NEAR);
    c.deposit();
}

#[test]
fn vault_total_follows_deposits_and_withdrawals() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let total = c.get_config().vault_total.0;
    assert!(total >= v && total < VAULT, "{total}");
    ctx(FOLLOWER, 1);
    c.request_withdraw(U128(NEAR));
    ctx_at(FOLLOWER, 1, NOW + 900 * 1_000_000_000);
    let _ = c.withdraw();
    assert_eq!(c.get_config().vault_total.0, total - NEAR);
}

// ---------------------------------------------------------------- chaos and resolve

/// A TEE-backed agent posts through its enclave proof. The proof is unique per (agent, nonce):
/// request hash = agent pk, response hash = nonce.
fn post_tee(
    c: &mut Contract,
    sk: &SigningKey,
    model: &str,
    tee: &SigningKey,
    d: u64,
    side: Side,
    nonce: u64,
) {
    let pk = sk.verifying_key().to_bytes();
    let (req, res) = (pk, [nonce as u8; 32]);
    let mut i = intent(&pk, d, side, 5_000, nonce);
    i.proof_hash = Base64VecU8(proof_hash(&req, &res));
    ctx(SOLVER, 0);
    c.post_intent(sign(sk, &i), Some(tee_proof(tee, 2, model, req, res)));
}

/// A posts through its TEE proof (A is TEE-backed in `setup`).
fn post_a(c: &mut Contract, ska: &SigningKey, tee: &SigningKey, d: u64, side: Side, nonce: u64) {
    post_tee(c, ska, MODEL_A, tee, d, side, nonce)
}

fn inject(c: &mut Contract, d: u64, target: &[u8], deposit: u128) {
    ctx(OPERATOR, deposit);
    c.inject_chaos(
        U64(d),
        Base64VecU8(target.to_vec()),
        "fake_news".into(),
        Base64VecU8(vec![3u8; 32]),
    );
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
#[should_panic(expected = "kind too long")]
fn inject_kind_too_long_panics() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    ctx(OPERATOR, MIN_CHAOS);
    c.inject_chaos(
        U64(d),
        Base64VecU8(key(1).1),
        "k".repeat(33),
        Base64VecU8(vec![3u8; 32]),
    );
}

#[test]
fn inject_pays_storage_then_pools_the_rest() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    let pool = c.get_duel(U64(d)).unwrap().pool.0;
    assert!(
        pool < MIN_CHAOS && pool > MIN_CHAOS - NEAR / 100,
        "pool {pool}"
    );
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
    assert_eq!(
        (o.pnl_a, o.pnl_b, o.slashed.0, o.injections),
        (25, -25, slashed, 1)
    );
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
    ctx(OWNER, 1);
    c.set_oracle(ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), 330, 60);
    assert_eq!(
        (c.get_config().min_duel_s, c.get_config().intent_lock_s),
        (330, 60)
    );
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    c.open_duel(
        Base64VecU8(key(1).1),
        Base64VecU8(key(2).1),
        "wrap.near".into(),
        U64(NOW + 329_000_000_000),
    );
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
    c.oracle_on_call(
        CONTRACT.parse().unwrap(),
        price_data("wrap.near", UP, CLOSE - 1),
        format!("close:{d}"),
    );
}

#[test]
#[should_panic(expected = "no open price")]
fn resolve_without_open_price_panics() {
    let (mut c, ..) = setup();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c
        .open_duel(
            Base64VecU8(key(1).1),
            Base64VecU8(key(2).1),
            "wrap.near".into(),
            U64(CLOSE),
        )
        .0;
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
    assert_eq!(
        price8(&OraclePrice {
            multiplier: U128(366_117_500),
            decimals: 8
        }),
        366_117_500
    );
    assert_eq!(
        price8(&OraclePrice {
            multiplier: U128(366_117),
            decimals: 5
        }),
        366_117_000
    );
    assert_eq!(
        price8(&OraclePrice {
            multiplier: U128(36_611_750_000),
            decimals: 10
        }),
        366_117_500
    );
}

#[test]
fn void_duel_after_a_day_frees_agents_without_slashing() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    inject(&mut c, d, &key(1).1, MIN_CHAOS + 1);
    let (bond_a, bond_b) = (bond(&c, 1), bond(&c, 2));
    let pool = c.get_duel(U64(d)).unwrap().pool.0;
    ctx_at(FOLLOWER, 0, CLOSE + VOID_AFTER_NS); // permissionless: a bystander voids it
    assert_eq!(c.get_config().open_duels, 1);
    c.void_duel(U64(d));
    assert_eq!(c.get_config().open_duels, 0);
    assert_eq!(bond(&c, 1), bond_a + pool / 2 + pool % 2);
    assert_eq!(bond(&c, 2), bond_b + pool / 2);
    let duel = c.get_duel(U64(d)).unwrap();
    assert!(duel.resolved && duel.injections.is_empty());
    assert!(
        c.get_agent(Base64VecU8(key(1).1))
            .unwrap()
            .in_duel
            .is_none()
    );
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
    ctx(OPERATOR, 1);
    let _ = c.withdraw_bond(Base64VecU8(key(1).1), U128(1));
}

#[test]
fn withdraw_bond_after_resolve_ok() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    resolve_at_close(&mut c, d, UP);
    let before = bond(&c, 1);
    ctx(OPERATOR, 1);
    let _ = c.withdraw_bond(Base64VecU8(key(1).1), U128(before / 2));
    assert_eq!(bond(&c, 1), before - before / 2);
    let board = c.leaderboard(0, 100);
    assert_eq!(board.len(), 2);
    assert!(board.iter().any(|a| a.tee) && board.iter().any(|a| !a.tee));
}

#[test]
fn leaderboard_pages_in_rank_order() {
    let (mut c, ska, skb) = setup();
    register(&mut c, 3, "m3", false);
    let d = open(&mut c);
    let tee = tee_signer(&mut c);
    post_a(&mut c, &ska, &tee, d, Side::Long, 1);
    post_b(&mut c, &skb, d, Side::Short, 1);
    resolve_at_close(&mut c, d, UP); // A gains, B loses
    let all = c.leaderboard(0, 100);
    assert_eq!(all[0].pk.0, key(1).1);
    assert_eq!(all[2].pk.0, key(2).1);
    let page: Vec<_> = c.leaderboard(1, 1).into_iter().map(|a| a.pk.0).collect();
    assert_eq!(page, vec![all[1].pk.0.clone()]);
    assert!(c.leaderboard(3, 10).is_empty());
}

// ---------------------------------------------------------------- review fixes and migrations

#[test]
fn same_nonce_on_two_agents_settles_both() {
    // follower follows A and B (both TEE-backed here); both post nonce 1; both fills settle
    // (fill key is agent-scoped)
    let (ska, skb) = (key(1).0, key(2).0);
    let mut c = fresh(0);
    register(&mut c, 1, MODEL_A, true);
    register(&mut c, 2, MODEL_B, true);
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &ska, &tee, d, Side::Long, 1);
    post_tee(&mut c, &skb, MODEL_B, &tee, d, Side::Short, 1);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), mandate(NEAR, VAULT, vec![]));
    c.follow(Base64VecU8(key(2).1), mandate(NEAR, VAULT, vec![]));
    let v = c.get_vault(FOLLOWER.parse().unwrap()).0;
    let ra = settle(&mut c, vec![fill(1, "usdc", 50)]);
    let rb = settle_answered(
        &mut c,
        2,
        vec![fill(1, "usdc", 50)],
        balances(&[2_000_000]),
        NOW,
    )
    .unwrap();
    assert_eq!((ra.settled, rb.settled), (1, 1));
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - 100);
}

#[test]
fn owner_withdraws_fees() {
    let mut c = fresh(100); // fee 1%
    register(&mut c, 1, MODEL_A, true);
    register(&mut c, 2, "m", false);
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &key(1).0, &tee, d, Side::Long, 1);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), mandate(2 * NEAR, VAULT, vec![]));
    let v = c.get_vault(FOLLOWER.parse().unwrap()).0;
    settle(&mut c, vec![fill(1, "usdc", NEAR)]);
    assert_eq!(c.get_config().owner_fees.0, NEAR / 100);
    assert_eq!(
        c.get_vault(FOLLOWER.parse().unwrap()).0,
        v - NEAR - NEAR / 100
    );
    ctx(OWNER, 1);
    let _ = c.withdraw_fees();
    assert_eq!(c.get_config().owner_fees.0, 0);
}

/// fee 1 %: the follower pays amount + fee, the solver is repaid the amount only, the fee accrues to the
/// owner, and the mandate's `spent` counts the whole debit, fee included.
#[test]
fn fee_is_debited_from_follower_and_accrues_to_owner_not_solver() {
    let mut c = fresh(100);
    register(&mut c, 1, MODEL_A, true);
    register(&mut c, 2, "m", false);
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &key(1).0, &tee, d, Side::Long, 1);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(
        Base64VecU8(key(1).1),
        mandate(NEAR + NEAR / 100, NEAR + NEAR / 100, vec![]),
    );
    let v = c.get_vault(FOLLOWER.parse().unwrap()).0;
    let r = settle(&mut c, vec![fill(1, "usdc", NEAR)]);
    let fee = NEAR / 100;
    assert_eq!((r.settled, r.debited.0), (1, NEAR + fee));
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - NEAR - fee);
    assert_eq!(c.get_vault(SOLVER.parse().unwrap()).0, NEAR);
    assert_eq!(c.get_config().owner_fees.0, fee);
    let m = c
        .get_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap())
        .unwrap();
    assert_eq!(
        m.spent.0,
        NEAR + fee,
        "the allowance is spent by the whole debit"
    );
}

#[test]
#[should_panic(expected = "not owner")]
fn withdraw_fees_by_stranger_panics() {
    let mut c = fresh(100);
    ctx(OPERATOR, 1);
    let _ = c.withdraw_fees();
}

#[test]
#[should_panic(expected = "insufficient")]
fn withdraw_fees_with_nothing_accrued_panics() {
    let mut c = fresh(100);
    ctx(OWNER, 1);
    let _ = c.withdraw_fees();
}

#[test]
#[should_panic(expected = "resolved")]
fn void_duel_twice_panics() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    ctx_at(FOLLOWER, 0, CLOSE + VOID_AFTER_NS);
    c.void_duel(U64(d));
    c.void_duel(U64(d));
}

#[test]
fn register_model_id_of_exactly_64_bytes_ok() {
    let mut c = fresh(0);
    let model = "m".repeat(64);
    let a = register(&mut c, 1, &model, false);
    assert_eq!(a.model_id, model);
    assert_eq!(
        c.get_agent(Base64VecU8(key(1).1)).unwrap().model_id.len(),
        64
    );
}

/// A relayer (anyone may relay) cannot forge an intent for B with another key's signature.
#[test]
#[should_panic(expected = "bad signature")]
fn relayed_intent_signed_by_another_key_panics() {
    let (mut c, ska, _) = setup();
    let d = open(&mut c);
    ctx(OPERATOR, 0);
    c.post_intent(
        sign(&ska, &intent(&key(2).1, d, Side::Long, 5_000, 1)),
        None,
    );
}

/// A registered agent that is not in the duel cannot post into it, even with a valid signature.
#[test]
#[should_panic(expected = "bad target")]
fn relayed_intent_from_agent_outside_the_duel_panics() {
    let (mut c, ..) = setup();
    register(&mut c, 3, "m", false);
    let d = open(&mut c);
    ctx(OPERATOR, 0);
    c.post_intent(
        sign(&key(3).0, &intent(&key(3).1, d, Side::Long, 5_000, 1)),
        None,
    );
}

// ---------------------------------------------------------------- per-agent duel index

fn ids(v: Vec<U64>) -> Vec<u64> {
    v.into_iter().map(|x| x.0).collect()
}

#[test]
fn agent_duels_index_grows_and_pages_newest_first() {
    let (mut c, ..) = setup();
    let a = Base64VecU8(key(1).1);
    assert!(c.agent_duels(a.clone(), 0, 10).is_empty(), "no duels yet");
    let d0 = open(&mut c);
    assert_eq!(ids(c.agent_duels(a.clone(), 0, 10)), vec![d0]);
    resolve_at_close(&mut c, d0, UP);
    let d1 = open(&mut c);
    resolve_at_close(&mut c, d1, UP);
    let d2 = open(&mut c);
    assert_eq!(ids(c.agent_duels(a.clone(), 0, 10)), vec![d2, d1, d0]);
    assert_eq!(
        ids(c.agent_duels(Base64VecU8(key(2).1), 0, 2)),
        vec![d2, d1],
        "both sides indexed, limit honoured"
    );
    assert_eq!(ids(c.agent_duels(a.clone(), 1, 1)), vec![d1]);
    assert_eq!(ids(c.agent_duels(a.clone(), 2, 5)), vec![d0]);
    assert!(c.agent_duels(a, 3, 5).is_empty(), "offset past the end");
    assert!(
        c.agent_duels(Base64VecU8(key(9).1), 0, 10).is_empty(),
        "unknown agent"
    );
}

fn mandate_v1(allowance: u128) -> MandateV1 {
    MandateV1 {
        allowance: U128(allowance),
        spent: U128(7),
        per_tx_cap: U128(NEAR),
        allowed_tokens: vec![],
        expires_at: U64(NOW + 1_000_000),
        revoked: false,
    }
}

#[test]
fn migrate_v15_rekeys_follows_in_batches_and_keeps_the_rest() {
    let (mut c, ..) = setup();
    let (a, b) = (key(1).1, key(2).1);
    let d0 = open(&mut c);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    let vault = c.get_vault(FOLLOWER.parse().unwrap()).0;
    // deploy-14 follower lists under the old `Follows` prefix: two followers of A, one of B
    let (f, o): (AccountId, AccountId) = (FOLLOWER.parse().unwrap(), OPERATOR.parse().unwrap());
    c.follows_v1.insert(
        a.clone(),
        vec![(f.clone(), mandate_v1(5)), (o.clone(), mandate_v1(6))],
    );
    c.follows_v1
        .insert(b.clone(), vec![(f.clone(), mandate_v1(8))]);
    c.follows_v1.flush();
    c.duels.flush();
    c.agents.flush();
    c.agent_duels.flush();
    c.vaults.flush();
    // deploy-14 state: the current layout minus the fields deploy 15 appends
    let mut raw = near_sdk::borsh::to_vec(&c).unwrap();
    let tail = near_sdk::borsh::to_vec(&(
        &c.follows,
        &c.follows_cursor,
        &c.intents_account,
        &c.holdings,
        &c.accounted,
        &c.outflow_seq,
        &c.pending_withdrawals,
        &c.withdraw_delay_ns,
        &c.paused,
        &c.max_vault_total,
        &c.vault_total,
        &c.duel_locks,
        &c.sweeping,
    ))
    .unwrap();
    assert_eq!(raw.split_off(raw.len() - tail.len()), tail);
    env::storage_write(b"STATE", &raw);
    ctx(CONTRACT, 0);
    let mut m = Contract::migrate_v15(INTENTS.parse().unwrap(), U128(VAULT_CAP));
    let cfg = m.get_config();
    assert!(cfg.migrating);
    assert_eq!(
        (
            cfg.withdraw_delay_s,
            cfg.paused,
            cfg.intents_account.as_str()
        ),
        (900, false, INTENTS)
    );
    assert_eq!(
        (cfg.next_duel.0, cfg.open_duels, cfg.intent_lock_s),
        (1, 1, 10)
    );
    assert_eq!(m.get_vault(f.clone()).0, vault, "vaults untouched");
    // follow and settle are refused until the re-key finishes
    ctx(FOLLOWER, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        m.follow(Base64VecU8(a.clone()), mandate(NEAR, VAULT, vec![]))
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "migrating");
    ctx(SOLVER, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = m.settle_follow(Base64VecU8(a.clone()), f.clone(), vec![fill(1, "usdc", 1)]);
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "migrating");
    // one agent per call
    ctx(OWNER, 1);
    assert_eq!(m.migrate_follows(1), Some(1));
    assert_eq!(m.migrate_follows(1), None);
    assert!(!m.get_config().migrating);
    let got = |m: &Contract, pk: &[u8], who: &AccountId| {
        m.get_follow(Base64VecU8(pk.to_vec()), who.clone())
            .map(|x| (x.allowance.0, x.spent.0, x.min_out_per_near.0))
    };
    assert_eq!(got(&m, &a, &f), Some((5, 7, 0)));
    assert_eq!(got(&m, &a, &o), Some((6, 7, 0)));
    assert_eq!(got(&m, &b, &f), Some((8, 7, 0)));
    assert_eq!(got(&m, &b, &o), None);
    assert!(m.follows_v1.get(&a).is_none(), "old lists are drained");
    // the duel open across the deploy keeps the global lock; it still takes intents
    assert_eq!(m.lock_of(d0), 10_000_000_000);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx(OWNER, 1);
        m.migrate_follows(1)
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "migration done");
}

#[test]
fn init_starts_with_a_zero_lock() {
    ctx(OWNER, 0);
    let c = Contract::init(
        OWNER.parse().unwrap(),
        ORACLE.parse().unwrap(),
        U128(ORACLE_DEPOSIT),
        1_000,
        0,
        U128(MIN_CHAOS),
        INTENTS.parse().unwrap(),
        U128(VAULT_CAP),
    );
    let cfg = c.get_config();
    assert_eq!((cfg.min_duel_s, cfg.intent_lock_s), (0, 0));
}

#[test]
fn a_duel_keeps_the_lock_it_was_opened_under() {
    // opened under a 10 s lock; the owner raises the lock to 25 s mid-duel (allowed); an intent
    // 15 s before close still lands in this duel
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    ctx(OWNER, 1);
    c.set_oracle(ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), 60, 25);
    let i = intent(&key(2).1, d, Side::Long, 5_000, 1);
    ctx_at(OPERATOR, 0, CLOSE - 15_000_000_000);
    c.post_intent(sign(&skb, &i), None);
    assert!(c.get_duel(U64(d)).unwrap().last_intent_b.is_some());
    assert_eq!(c.lock_of(d), LOCK);
}

// ---------------------------------------------------------------- second-audit follow-ups

#[test]
#[should_panic(expected = "duels open")]
fn set_oracle_cannot_lower_lock_while_a_duel_is_open() {
    let (mut c, ..) = setup();
    open(&mut c);
    ctx(OWNER, 1);
    c.set_oracle(ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), 60, 9);
}

#[test]
#[should_panic(expected = "duels open")]
fn set_oracle_cannot_move_oracle_while_a_duel_is_open() {
    let (mut c, ..) = setup();
    open(&mut c);
    ctx(OWNER, 1);
    c.set_oracle("other-oracle.testnet".parse().unwrap(), U128(1), 60, 10);
}

#[test]
fn set_oracle_may_raise_lock_while_open_and_anything_once_resolved() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    assert_eq!(c.get_config().open_duels, 1);
    ctx(OWNER, 1);
    c.set_oracle(ORACLE.parse().unwrap(), U128(1), 120, 20);
    assert_eq!(c.get_config().intent_lock_s, 20);
    resolve_at_close(&mut c, d, UP);
    assert_eq!(c.get_config().open_duels, 0);
    ctx(OWNER, 1);
    c.set_oracle("other-oracle.testnet".parse().unwrap(), U128(1), 60, 5);
    let cfg = c.get_config();
    assert_eq!(
        (cfg.oracle_account.as_str(), cfg.intent_lock_s),
        ("other-oracle.testnet", 5)
    );
}

#[test]
#[should_panic(expected = "intent expired")]
fn post_intent_expiring_before_close_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    let mut i = intent(&key(2).1, d, Side::Long, 5_000, 1);
    i.expires_at = U64(CLOSE - 1);
    ctx(SOLVER, 0);
    c.post_intent(sign(&skb, &i), None);
}

#[test]
#[should_panic(expected = "stale nonce")]
fn post_intent_below_last_nonce_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    post_b(&mut c, &skb, d, Side::Long, 2);
    post_b(&mut c, &skb, d, Side::Short, 1);
}

#[test]
fn absurd_fill_amount_is_rejected_not_panicked() {
    let mut c = fresh(100);
    register(&mut c, 1, MODEL_A, true);
    register(&mut c, 2, "m", false);
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &key(1).0, &tee, d, Side::Long, 1);
    ctx(FOLLOWER, VAULT);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), mandate(u128::MAX, u128::MAX, vec![]));
    let v = c.get_vault(FOLLOWER.parse().unwrap()).0;
    assert_eq!(
        settle_rejects(&mut c, vec![fill(1, "usdc", u128::MAX / 50)]),
        "fee overflow"
    );
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v);
}

/// Open a duel and leave the open price unanswered.
fn open_unpriced(c: &mut Contract, close_at: u64) -> u64 {
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    c.open_duel(
        Base64VecU8(key(1).1),
        Base64VecU8(key(2).1),
        "wrap.near".into(),
        U64(close_at),
    )
    .0
}

#[test]
fn open_price_from_inside_the_recency_window_ok() {
    let (mut c, ..) = setup();
    let d = open_unpriced(&mut c, CLOSE);
    oracle_answers(&mut c, d, "open", OPEN, NOW - 300_000_000_000); // cached 300 s ago
    assert_eq!(c.get_duel(U64(d)).unwrap().open_price.unwrap().0, OPEN);
}

#[test]
#[should_panic(expected = "open price stale")]
fn open_price_older_than_recency_rejected() {
    let (mut c, ..) = setup();
    let d = open_unpriced(&mut c, CLOSE);
    oracle_answers(&mut c, d, "open", OPEN, NOW - 300_000_000_001);
}

#[test]
#[should_panic(expected = "open price stale")]
fn open_price_after_ten_minutes_rejected() {
    let (mut c, ..) = setup();
    let d = open_unpriced(&mut c, NOW + 3_600_000_000_000);
    oracle_answers(&mut c, d, "open", OPEN, NOW + 600_000_000_001);
}

#[test]
#[should_panic(expected = "open price stale")]
fn open_price_at_close_rejected() {
    let (mut c, ..) = setup();
    let d = open_unpriced(&mut c, CLOSE);
    oracle_answers(&mut c, d, "open", OPEN, CLOSE);
}

#[test]
fn finish_with_an_uncounted_open_duel_does_not_underflow() {
    // a duel opened before migrate_v12 is not in `open_duels`; resolving it must not panic
    let (mut c, ..) = setup();
    let d = open(&mut c);
    c.open_duels = 0;
    resolve_at_close(&mut c, d, UP);
    assert!(c.get_duel(U64(d)).unwrap().resolved);
    assert_eq!(c.get_config().open_duels, 0);
}

// ---------------------------------------------------------------- commit-reveal and consent

const SALT: [u8; 32] = [9u8; 32];

fn commitment(i: &Intent, salt: &[u8]) -> Vec<u8> {
    let mut m = intent_message(i);
    m.extend_from_slice(salt);
    env::sha256(&m)
}

fn commit_sig(sk: &SigningKey, duel: u64, h: &[u8]) -> Base64VecU8 {
    let msg = commit_bytes(&CONTRACT.parse().unwrap(), duel, h);
    Base64VecU8(sk.sign(&msg).to_bytes().to_vec())
}

/// A relayer commits `sk`'s hidden intent `i` at `ts`.
fn commit_at(c: &mut Contract, sk: &SigningKey, i: &Intent, salt: &[u8], ts: u64) {
    let h = commitment(i, salt);
    ctx_at(OPERATOR, 0, ts);
    c.commit_intent(
        i.duel_id,
        i.agent_pk.clone(),
        Base64VecU8(h.clone()),
        commit_sig(sk, i.duel_id.0, &h),
    );
}

fn reveal_at(c: &mut Contract, sk: &SigningKey, i: &Intent, salt: &[u8], ts: u64) {
    ctx_at(OPERATOR, 0, ts);
    c.reveal_intent(sign(sk, i), Base64VecU8(salt.to_vec()), None);
}

fn commit_reveal_on(c: &mut Contract) {
    ctx(OWNER, 1);
    let bps = c.get_config().no_reveal_bps;
    c.set_commit_reveal(true, bps);
}

#[test]
fn commit_then_reveal_inside_the_lock_scores_the_revealed_intent() {
    let (mut c, _, skb) = setup();
    commit_reveal_on(&mut c);
    let d = open(&mut c);
    let first = intent(&key(2).1, d, Side::Short, 5_000, 1);
    let call = intent(&key(2).1, d, Side::Long, 5_000, 2);
    let before = bond(&c, 2);
    commit_at(&mut c, &skb, &first, &SALT, NOW);
    let after_first = bond(&c, 2);
    assert!(
        after_first < before,
        "commitment storage is paid from the bond"
    );
    commit_at(&mut c, &skb, &call, &SALT, CLOSE - LOCK - 1);
    assert_eq!(
        bond(&c, 2),
        after_first - set_entry_cost(8 + 32 + 32),
        "a replacement pays only its replay guard"
    );
    assert!(
        c.get_duel(U64(d)).unwrap().last_intent_b.is_none(),
        "nothing readable before the reveal"
    );
    reveal_at(&mut c, &skb, &call, &SALT, CLOSE - 1);
    assert!(c.commitments.get(&commit_key(d, &key(2).1)).is_none());
    resolve_at_close(&mut c, d, UP);
    let o = c.get_duel(U64(d)).unwrap().outcome.unwrap();
    assert_eq!((o.pnl_a, o.pnl_b), (0, 25));
    assert_eq!(o.winner.unwrap().0, key(2).1);
    assert_eq!(c.get_no_reveal(U64(d)), (false, false));
}

#[test]
#[should_panic(expected = "commitment mismatch")]
fn reveal_with_another_salt_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    let i = intent(&key(2).1, d, Side::Long, 5_000, 1);
    commit_at(&mut c, &skb, &i, &SALT, NOW);
    reveal_at(&mut c, &skb, &i, &[8u8; 32], NOW);
}

#[test]
#[should_panic(expected = "commitment mismatch")]
fn replaced_commitment_cannot_be_revealed() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    let first = intent(&key(2).1, d, Side::Short, 5_000, 1);
    commit_at(&mut c, &skb, &first, &SALT, NOW);
    commit_at(
        &mut c,
        &skb,
        &intent(&key(2).1, d, Side::Long, 5_000, 2),
        &SALT,
        NOW,
    );
    reveal_at(&mut c, &skb, &first, &SALT, NOW);
}

#[test]
#[should_panic(expected = "commitment used")]
fn replayed_commit_after_reveal_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    let i = intent(&key(2).1, d, Side::Long, 5_000, 1);
    commit_at(&mut c, &skb, &i, &SALT, NOW);
    reveal_at(&mut c, &skb, &i, &SALT, NOW);
    // anyone resubmits the public commit tx so the agent cannot reveal and gets slashed
    commit_at(&mut c, &skb, &i, &SALT, NOW);
}

#[test]
// a host panic (`env::panic_str`), so the receipt error is the bare text, not "panicked at src/duels.rs:.."
#[should_panic(expected = "GuestPanic { panic_msg: \"no commitment\" }")]
fn reveal_without_commitment_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    reveal_at(
        &mut c,
        &skb,
        &intent(&key(2).1, d, Side::Long, 5_000, 1),
        &SALT,
        NOW,
    );
}

#[test]
#[should_panic(expected = "bad commit signature")]
fn commit_signed_by_another_key_panics() {
    let (mut c, ska, _) = setup();
    let d = open(&mut c);
    let h = commitment(&intent(&key(2).1, d, Side::Long, 5_000, 1), &SALT);
    ctx(OPERATOR, 0);
    c.commit_intent(
        U64(d),
        Base64VecU8(key(2).1),
        Base64VecU8(h.clone()),
        commit_sig(&ska, d, &h),
    );
}

#[test]
#[should_panic(expected = "intent lock")]
fn commit_inside_lock_panics() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    let i = intent(&key(2).1, d, Side::Long, 5_000, 1);
    commit_at(&mut c, &skb, &i, &SALT, CLOSE - LOCK);
}

#[test]
#[should_panic(expected = "commit first")]
fn post_intent_refused_when_commit_reveal_on() {
    let (mut c, _, skb) = setup();
    commit_reveal_on(&mut c);
    let d = open(&mut c);
    post_b(&mut c, &skb, d, Side::Long, 1);
}

#[test]
fn unrevealed_commitment_pays_the_opponent_and_is_flagged() {
    // commit_reveal is off: commit still works, and leaving it unrevealed still costs
    let (mut c, ska, skb) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &ska, &tee, d, Side::Long, 1);
    let i = intent(&key(2).1, d, Side::Short, 5_000, 1);
    commit_at(&mut c, &skb, &i, &SALT, NOW);
    let (bond_a, bond_b) = (bond(&c, 1), bond(&c, 2));
    resolve_at_close(&mut c, d, UP);
    let no_reveal = bond_b * 1_000 / 10_000;
    let lost = (bond_b - no_reveal) * 1_000 / 10_000;
    assert_eq!(bond(&c, 2), bond_b - no_reveal - lost);
    assert_eq!(bond(&c, 1), bond_a + no_reveal + lost);
    let o = c.get_duel(U64(d)).unwrap().outcome.unwrap();
    assert_eq!((o.pnl_a, o.pnl_b, o.slashed.0), (25, 0, lost));
    assert_eq!(c.get_no_reveal(U64(d)), (false, true));
    assert!(c.commitments.get(&commit_key(d, &key(2).1)).is_none());
}

#[test]
fn withholding_a_losing_reveal_forfeits_a_winning_duel() {
    // B reveals a winning call 1, commits call 2 before the lock and withholds it: B must lose,
    // pay the no-reveal slash to A and the loss slash through the pool, and gain no alpha
    let (mut c, _, skb) = setup();
    commit_reveal_on(&mut c);
    let d = open(&mut c);
    let call1 = intent(&key(2).1, d, Side::Long, 5_000, 1);
    commit_at(&mut c, &skb, &call1, &SALT, NOW);
    reveal_at(&mut c, &skb, &call1, &SALT, NOW);
    let call2 = intent(&key(2).1, d, Side::Short, 5_000, 2);
    commit_at(&mut c, &skb, &call2, &[7u8; 32], CLOSE - LOCK - 1);
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    let pool = c.get_duel(U64(d)).unwrap().pool.0;
    let (bond_a, bond_b) = (bond(&c, 1), bond(&c, 2));
    resolve_at_close(&mut c, d, UP);
    let no_reveal = bond_b * 1_000 / 10_000;
    let lost = (bond_b - no_reveal) * 1_000 / 10_000;
    assert_eq!(bond(&c, 2), bond_b - no_reveal - lost);
    assert_eq!(bond(&c, 1), bond_a + no_reveal + lost + pool);
    let o = c.get_duel(U64(d)).unwrap().outcome.unwrap();
    assert_eq!(
        (o.pnl_a, o.pnl_b),
        (0, 25),
        "the revealed call still scored"
    );
    assert_eq!(o.winner.unwrap().0, key(1).1, "but the withholder forfeits");
    assert_eq!(o.slashed.0, lost);
    let (a, b) = (
        c.get_agent(Base64VecU8(key(1).1)).unwrap(),
        c.get_agent(Base64VecU8(key(2).1)).unwrap(),
    );
    assert_eq!(
        (a.alpha_bps, b.alpha_bps),
        (0, 0),
        "no alpha from a forfeit"
    );
    assert_eq!(a.shield, 1);
    assert_eq!(c.get_no_reveal(U64(d)), (false, true));
}

#[test]
fn double_no_reveal_is_a_tie_and_both_slashes_go_to_owner_fees() {
    let (mut c, ska, skb) = setup();
    let d = open(&mut c);
    commit_at(
        &mut c,
        &ska,
        &intent(&key(1).1, d, Side::Long, 5_000, 1),
        &SALT,
        NOW,
    );
    commit_at(
        &mut c,
        &skb,
        &intent(&key(2).1, d, Side::Short, 5_000, 1),
        &SALT,
        NOW,
    );
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    let pool = c.get_duel(U64(d)).unwrap().pool.0;
    let (bond_a, bond_b) = (bond(&c, 1), bond(&c, 2));
    let fees = c.get_config().owner_fees.0;
    resolve_at_close(&mut c, d, UP);
    let (sa, sb) = (bond_a * 1_000 / 10_000, bond_b * 1_000 / 10_000);
    assert_eq!(c.get_config().owner_fees.0, fees + sa + sb);
    assert_eq!(bond(&c, 1), bond_a - sa + pool / 2 + pool % 2);
    assert_eq!(bond(&c, 2), bond_b - sb + pool / 2);
    let o = c.get_duel(U64(d)).unwrap().outcome.unwrap();
    assert!(o.winner.is_none());
    assert_eq!(o.slashed.0, 0);
    assert_eq!(c.get_no_reveal(U64(d)), (true, true));
}

#[test]
fn void_drops_unrevealed_commitments_without_slashing() {
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    commit_at(
        &mut c,
        &skb,
        &intent(&key(2).1, d, Side::Long, 5_000, 1),
        &SALT,
        NOW,
    );
    let bond_b = bond(&c, 2);
    ctx_at(OPERATOR, 0, CLOSE + VOID_AFTER_NS);
    c.void_duel(U64(d));
    assert_eq!(bond(&c, 2), bond_b);
    assert!(c.commitments.get(&commit_key(d, &key(2).1)).is_none());
    assert_eq!(c.get_no_reveal(U64(d)), (false, false));
}

#[test]
#[should_panic(expected = "duels open")]
fn commit_reveal_cannot_flip_while_a_duel_is_open() {
    let (mut c, ..) = setup();
    open(&mut c);
    commit_reveal_on(&mut c);
}

#[test]
#[should_panic(expected = "bps out of range")]
fn no_reveal_bps_bounded() {
    let (mut c, ..) = setup();
    ctx(OWNER, 1);
    c.set_commit_reveal(true, 10_001);
}

fn consent_sig(sk: &SigningKey, close_at: u64) -> Base64VecU8 {
    let msg = consent_bytes(
        &CONTRACT.parse().unwrap(),
        &key(1).1,
        &key(2).1,
        "wrap.near",
        close_at,
    );
    Base64VecU8(sk.sign(&msg).to_bytes().to_vec())
}

fn open_consented(c: &mut Contract, sig_a: Base64VecU8, sig_b: Base64VecU8) -> u64 {
    ctx(OPERATOR, ORACLE_DEPOSIT + NEAR / 10);
    c.open_duel_consented(
        Base64VecU8(key(1).1),
        Base64VecU8(key(2).1),
        "wrap.near".into(),
        U64(CLOSE),
        sig_a,
        sig_b,
    )
    .0
}

#[test]
fn consented_open_by_anyone_pairs_the_agents() {
    let (mut c, ska, skb) = setup();
    ctx(OWNER, 1);
    c.set_require_consent(true);
    assert!(c.get_config().require_consent);
    let d = open_consented(&mut c, consent_sig(&ska, CLOSE), consent_sig(&skb, CLOSE));
    for seed in [1, 2] {
        let a = c.get_agent(Base64VecU8(key(seed).1)).unwrap();
        assert_eq!(a.in_duel, Some(U64(d)));
    }
    assert_eq!(c.get_config().open_duels, 1);
}

#[test]
#[should_panic(expected = "bad consent signature")]
fn consent_signed_for_another_close_panics() {
    let (mut c, ska, skb) = setup();
    open_consented(
        &mut c,
        consent_sig(&ska, CLOSE),
        consent_sig(&skb, CLOSE + 1),
    );
}

#[test]
#[should_panic(expected = "consent required")]
fn owner_open_refused_when_consent_required() {
    let (mut c, ..) = setup();
    ctx(OWNER, 1);
    c.set_require_consent(true);
    open(&mut c);
}

#[test]
fn commit_and_consent_views_return_the_signed_bytes() {
    let (c, ..) = setup();
    let contract: AccountId = CONTRACT.parse().unwrap();
    let h = vec![5u8; 32];
    let m = c.commit_message(U64(3), Base64VecU8(h.clone())).0;
    assert_eq!(m, commit_bytes(&contract, 3, &h));
    assert!(m.starts_with(b"nearbuddy-commit-v1arena.testnet"));
    assert_eq!(m.len(), 19 + 13 + 8 + 32);
    let (a, b) = (key(1).1, key(2).1);
    let m = c
        .consent_message(
            Base64VecU8(a.clone()),
            Base64VecU8(b.clone()),
            "wrap.near".into(),
            U64(CLOSE),
        )
        .0;
    assert_eq!(m, consent_bytes(&contract, &a, &b, "wrap.near", CLOSE));
    assert!(m.starts_with(b"nearbuddy-duel-v1arena.testnet"));
    assert!(m.ends_with(&CLOSE.to_le_bytes()));
    assert_eq!(m.len(), 17 + 13 + 32 + 32 + 9 + 8);
}

fn open_consented_until(
    c: &mut Contract,
    ska: &SigningKey,
    skb: &SigningKey,
    close_at: u64,
) -> u64 {
    let msg = |close| {
        consent_bytes(
            &CONTRACT.parse().unwrap(),
            &key(1).1,
            &key(2).1,
            "wrap.near",
            close,
        )
    };
    let (sa, sb) = (ska.sign(&msg(close_at)), skb.sign(&msg(close_at)));
    ctx(OPERATOR, ORACLE_DEPOSIT + NEAR / 10);
    c.open_duel_consented(
        Base64VecU8(key(1).1),
        Base64VecU8(key(2).1),
        "wrap.near".into(),
        U64(close_at),
        Base64VecU8(sa.to_bytes().to_vec()),
        Base64VecU8(sb.to_bytes().to_vec()),
    )
    .0
}

#[test]
#[should_panic(expected = "duel too long")]
fn consented_duel_that_never_closes_is_refused() {
    // A duel closing near u64::MAX would never resolve or void and would freeze every admin
    // setter guarded by "duels open".
    let (mut c, ska, skb) = setup();
    open_consented_until(&mut c, &ska, &skb, u64::MAX - 1);
}

#[test]
fn consented_duel_of_exactly_the_cap_opens() {
    let (mut c, ska, skb) = setup();
    ctx(OPERATOR, 0);
    let now = env::block_timestamp();
    let d = open_consented_until(&mut c, &ska, &skb, now + MAX_DUEL_NS);
    assert_eq!(c.get_duel(U64(d)).unwrap().close_at.0, now + MAX_DUEL_NS);
}

#[test]
#[should_panic(expected = "duel too long")]
fn consented_duel_one_ns_past_the_cap_is_refused() {
    let (mut c, ska, skb) = setup();
    ctx(OPERATOR, 0);
    let now = env::block_timestamp();
    open_consented_until(&mut c, &ska, &skb, now + MAX_DUEL_NS + 1);
}

// ---------------------------------------------------------------- sweep_surplus

/// Owner sweep of `amount` with `balance` as the view answer; true when the transfer was scheduled.
fn sweep_check(c: &mut Contract, amount: u128, balance: u128) -> bool {
    ctx(OWNER, 1);
    let _ = c.sweep_surplus("usdc".into(), OWNER.parse().unwrap(), U128(amount));
    let seq = c.outflow_seq;
    callback_ctx(NOW, vec![balances(&[balance])]);
    matches!(
        c.on_sweep_check("usdc".into(), OWNER.parse().unwrap(), U128(amount), seq),
        near_sdk::PromiseOrValue::Promise(_)
    )
}

#[test]
fn sweep_takes_only_unaccounted_balance_and_never_touches_accounted() {
    let mut c = with_holding(); // 3_000_000 usdc credited to the follower
    assert!(
        !sweep_check(&mut c, 1_001, 3_001_000),
        "one unit over the surplus"
    );
    assert_eq!(c.sweeping.get("usdc").copied().unwrap_or(0), 0);
    assert!(sweep_check(&mut c, 1_000, 3_001_000));
    assert_eq!(c.sweeping.get("usdc").copied(), Some(1_000), "reserved");
    assert_eq!(c.get_accounted("usdc".into()).0, 3_000_000);
    callback_ctx(NOW, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_sweep_done("usdc".into(), OWNER.parse().unwrap(), U128(1_000)));
    assert_eq!(c.sweeping.get("usdc").copied(), Some(0));
    assert_eq!(
        (c.get_accounted("usdc".into()).0, c.outflow_seq),
        (3_000_000, 1)
    );
    assert_eq!(
        c.get_holding(FOLLOWER.parse().unwrap(), "usdc".into()).0,
        3_000_000
    );
}

#[test]
fn a_failed_sweep_releases_its_reservation_and_moves_nothing() {
    let mut c = with_holding();
    assert!(sweep_check(&mut c, 1_000, 3_001_000));
    callback_ctx(NOW, vec![PromiseResult::Failed]);
    assert!(!c.on_sweep_done("usdc".into(), OWNER.parse().unwrap(), U128(1_000)));
    assert_eq!(c.sweeping.get("usdc").copied(), Some(0));
    assert_eq!(c.outflow_seq, 0);
}

#[test]
fn surplus_reserved_by_a_sweep_cannot_back_a_fill() {
    // 1_000_000 unaccounted; the sweep reserves all of it before its transfer lands
    let (mut c, d, _) = setup_follow(mandate(NEAR, VAULT, vec![]));
    assert!(sweep_check(&mut c, 1_000_000, 1_000_000));
    post_a(&mut c, &key(1).0, &key(7).0, d, Side::Short, 2);
    let r = settle_answered(
        &mut c,
        1,
        vec![fill(1, "usdc", 50)],
        balances(&[1_000_000]),
        NOW,
    );
    assert_eq!(r.unwrap_err(), "no receipt");
}

#[test]
fn sweep_after_an_outflow_during_its_view_is_refused() {
    let mut c = with_holding();
    ctx(OWNER, 1);
    let _ = c.sweep_surplus("usdc".into(), OWNER.parse().unwrap(), U128(1));
    let seq = c.outflow_seq;
    c.outflow_seq += 1;
    callback_ctx(NOW, vec![balances(&[10_000_000])]);
    assert!(matches!(
        c.on_sweep_check("usdc".into(), OWNER.parse().unwrap(), U128(1), seq),
        near_sdk::PromiseOrValue::Value(false)
    ));
}

#[test]
#[should_panic(expected = "not owner")]
fn sweep_is_owner_only() {
    let mut c = with_holding();
    ctx(FOLLOWER, 1);
    let _ = c.sweep_surplus("usdc".into(), FOLLOWER.parse().unwrap(), U128(1));
}

// ---------------------------------------------------------------- red team deploy 14 (F3, suggestion 7)

/// yoctoNEAR the contract sent back to `to` with a plain transfer in the last call.
fn refunded_to(to: &str) -> u128 {
    near_sdk::test_utils::get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id.as_str() == to)
        .flat_map(|r| r.actions.iter())
        .map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

#[test]
fn a_consented_open_refunds_the_excess_to_its_opener() {
    // a third party opens with 1 NEAR more than needed: it pays the duel's storage and the oracle
    // deposit, and gets the rest back
    let (mut c, ska, skb) = setup();
    let msg = consent_bytes(
        &CONTRACT.parse().unwrap(),
        &key(1).1,
        &key(2).1,
        "wrap.near",
        CLOSE,
    );
    let sig = |sk: &SigningKey| Base64VecU8(sk.sign(&msg).to_bytes().to_vec());
    let u0 = env::storage_usage();
    ctx("matchmaker.testnet", ORACLE_DEPOSIT + NEAR);
    c.open_duel_consented(
        Base64VecU8(key(1).1),
        Base64VecU8(key(2).1),
        "wrap.near".into(),
        U64(CLOSE),
        sig(&ska),
        sig(&skb),
    );
    let storage = (env::storage_usage() - u0) as u128 * env::storage_byte_cost().as_yoctonear();
    assert_eq!(refunded_to("matchmaker.testnet"), NEAR - storage);
}

#[test]
fn the_owner_open_refunds_its_margin_too() {
    let (mut c, ..) = setup();
    let u0 = env::storage_usage();
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    c.open_duel(
        Base64VecU8(key(1).1),
        Base64VecU8(key(2).1),
        "wrap.near".into(),
        U64(CLOSE),
    );
    let storage = (env::storage_usage() - u0) as u128 * env::storage_byte_cost().as_yoctonear();
    assert_eq!(
        refunded_to(OWNER),
        NEAR / 10 - storage,
        "only the margin comes back"
    );
}

