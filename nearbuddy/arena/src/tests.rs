use super::*;
use crate::duels::{pnl_bps, price8};
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
pub const SPECTATOR: &str = "spectator.testnet";
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
    // Layout: domain + (4+32) + 8 + 1 + 2 + 8 + 8 + (4+32). Exact bytes: wire_vectors_match_shared_file.
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
}

/// Shared with packages/protocol/src/wire-vectors.test.ts and agents/tests/test_wire_vectors.py;
/// all three compare bytes, so a format drift in any language fails its own suite.
const WIRE: &str = include_str!("../../fixtures/wire-vectors.json");

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn wire_vectors_match_shared_file() {
    use near_sdk::serde_json::{Value, from_str, from_value};
    let v: Value = from_str(WIRE).unwrap();
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap().to_string();
    let contract: AccountId = s("/contract").parse().unwrap();
    ctx(OWNER, 0); // env::sha256 and ed25519_verify need a VM context

    let i: Intent = from_value(v["intent"].clone()).unwrap();
    let m = intent_message(&i);
    assert_eq!(hex(&m), s("/intent_hex"));

    // `commitment` is the helper the reveal_intent tests feed to the contract
    let c = commitment(&i, &unhex(&s("/commit/salt_hex")));
    assert_eq!(hex(&c), s("/commit/commitment_hex"));
    let duel: u64 = s("/commit/duel_id").parse().unwrap();
    assert_eq!(
        hex(&commit_bytes(&contract, duel, &c)),
        s("/commit/message_hex")
    );

    let a: Base64VecU8 = from_value(v["consent"]["a"].clone()).unwrap();
    let b: Base64VecU8 = from_value(v["consent"]["b"].clone()).unwrap();
    let close: u64 = s("/consent/close_at").parse().unwrap();
    let consent = consent_bytes(&contract, &a.0, &b.0, &s("/consent/symbol"), close);
    assert_eq!(hex(&consent), s("/consent/message_hex"));

    let (req, res) = (
        unhex(&s("/tee/request_hash_hex")),
        unhex(&s("/tee/response_hash_hex")),
    );
    let model = s("/tee/model");
    assert_eq!(
        tee_text(1, &model, &req, &res),
        s("/tee/text_kind1").into_bytes()
    );
    assert_eq!(
        tee_text(2, &model, &req, &res),
        s("/tee/text_kind2").into_bytes()
    );
    assert_eq!(hex(&proof_hash(&req, &res)), s("/tee/proof_hash_hex"));

    let seed: [u8; 32] = unhex(&s("/signed/seed_hex")).try_into().unwrap();
    let sk = SigningKey::from_bytes(&seed);
    let si: Intent = from_value(v["signed"]["intent"].clone()).unwrap();
    assert_eq!(si.agent_pk.0, sk.verifying_key().to_bytes().to_vec());
    assert_eq!(hex(&intent_message(&si)), s("/signed/message_hex"));
    let signed = sign(&sk, &si);
    assert_eq!(hex(&signed.signature.0), s("/signed/signature_hex"));
    assert!(verify(
        &si.agent_pk.0,
        &intent_message(&si),
        &signed.signature.0
    ));
}

/// The edge list the TS and Python encoders must agree with: the contract's JSON ingress is the reference.
#[test]
fn wire_vector_edges_match_contract_ingress() {
    use near_sdk::serde_json::{Value, from_str, from_value};
    let v: Value = from_str(WIRE).unwrap();
    let patched = |e: &Value| {
        let mut i = v["intent"].clone();
        for (k, x) in e["patch"].as_object().unwrap() {
            i[k] = x.clone();
        }
        i
    };
    for e in v["edges"]["reject"].as_array().unwrap() {
        let r = from_value::<Intent>(patched(e));
        assert!(r.is_err(), "contract accepted edge {}", e["name"]);
    }
    for e in v["edges"]["same"].as_array().unwrap() {
        let i: Intent = from_value(patched(e)).unwrap();
        assert_eq!(
            hex(&intent_message(&i)),
            v["intent_hex"].as_str().unwrap(),
            "{}",
            e["name"]
        );
    }
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
const GRACE: u64 = 900 * SEC;
const SEC: u64 = 1_000_000_000;

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
    ctx_at(FOLLOWER, 0, NOW + 1);
    c.unfollow(Base64VecU8(key(1).1));
    let m = c
        .get_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap())
        .unwrap();
    assert_eq!((m.revoked, m.revoked_at.0), (true, NOW + 1));
    // a second unfollow does not restart the grace
    ctx_at(FOLLOWER, 0, NOW + 10);
    c.unfollow(Base64VecU8(key(1).1));
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + GRACE - 1);
    assert_eq!(r.unwrap().settled, 1);
}

/// A posts nonce `nonce` through its TEE proof at `ts`.
fn post_a_at(c: &mut Contract, ska: &SigningKey, tee: &SigningKey, d: u64, nonce: u64, ts: u64) {
    let pk = ska.verifying_key().to_bytes();
    let (req, res) = (pk, [nonce as u8; 32]);
    let mut i = intent(&pk, d, Side::Long, 5_000, nonce);
    i.proof_hash = Base64VecU8(proof_hash(&req, &res));
    ctx_at(SOLVER, 0, ts);
    c.post_intent(sign(ska, &i), Some(tee_proof(tee, 2, MODEL_A, req, res)));
}

#[test]
fn intent_accepted_after_unfollow_never_settles_inside_the_grace() {
    // red team V3: the grace let the solver settle intents posted after the revoke
    let (mut c, d, _) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let tee = key(7).0;
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.unfollow(Base64VecU8(key(1).1));
    post_a_at(&mut c, &key(1).0, &tee, d, 2, NOW + 2 * SEC);
    let fills = vec![fill(2, "usdc", 50), fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 3 * SEC).unwrap();
    assert_eq!(
        r.settled, 1,
        "nonce 1 (before the revoke) is inside the grace"
    );
    assert_eq!(r.rejected, vec![(0, "mandate revoked".to_string())]);
}

#[test]
fn intent_accepted_at_the_revoke_instant_is_refused() {
    // same block as the unfollow: the order inside the block is unknown, so the follower wins
    let (mut c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 0);
    c.unfollow(Base64VecU8(key(1).1));
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + SEC);
    assert_eq!(r.unwrap_err(), "mandate revoked");
}

#[test]
fn intent_accepted_after_expiry_never_settles_inside_the_grace() {
    let mut m = mandate(NEAR, VAULT, vec![]);
    m.expires_at = U64(NOW + 2 * SEC);
    let (mut c, d, _) = setup_follow(m);
    post_a_at(&mut c, &key(1).0, &key(7).0, d, 2, NOW + 2 * SEC);
    let fills = vec![fill(2, "usdc", 50), fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 3 * SEC).unwrap();
    assert_eq!(r.settled, 1);
    assert_eq!(r.rejected, vec![(0, "mandate expired".to_string())]);
}

/// `mandate(NEAR, VAULT, [])` open for an hour (the default one expires 1 ms after `NOW`).
fn hour_mandate() -> Mandate {
    let mut m = mandate(NEAR, VAULT, vec![]);
    m.expires_at = U64(NOW + 3_600 * SEC);
    m
}

#[test]
fn intent_posted_before_the_follow_never_settles() {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    post_a_at(&mut c, &ska, &tee, d, 1, NOW);
    ctx_at(FOLLOWER, VAULT, NOW + SEC);
    c.deposit();
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(Base64VecU8(key(1).1), hour_mandate());
    post_a_at(&mut c, &ska, &tee, d, 2, NOW + 2 * SEC);
    let fills = vec![fill(1, "usdc", 50), fill(2, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 3 * SEC).unwrap();
    assert_eq!(r.settled, 1);
    assert_eq!(r.rejected, vec![(0, "intent before follow".to_string())]);
}

/// The follower's stored record for agent `seed`.
fn record(c: &Contract, seed: u8) -> VersionedMandate {
    let k = crate::follow::follow_key(&key(seed).1, &FOLLOWER.parse().unwrap());
    c.follows.get(&k).unwrap().clone()
}

fn refollow_at(c: &mut Contract, ts: u64) {
    ctx_at(FOLLOWER, 0, ts);
    c.follow(Base64VecU8(key(1).1), hour_mandate());
}

#[test]
fn mandate_update_while_following_keeps_fronted_fills() {
    // red team round 3: a re-follow moved the follow time and voided every fronted fill for free
    let (mut c, d, _) = setup_follow(hour_mandate());
    post_a_at(&mut c, &key(1).0, &key(7).0, d, 2, NOW + SEC);
    let mut m = hour_mandate();
    m.per_tx_cap = U128(2 * NEAR);
    ctx_at(FOLLOWER, 0, NOW + 2 * SEC);
    c.follow(Base64VecU8(key(1).1), m);
    assert!(
        matches!(record(&c, 1), VersionedMandate::V3(ref m, NOW) if m.per_tx_cap.0 == 2 * NEAR),
        "the mandate changed, the window did not"
    );
    let fills = vec![fill(1, "usdc", 50), fill(2, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 3 * SEC).unwrap();
    assert_eq!((r.settled, r.rejected.len()), (2, 0));
}

#[test]
fn unfollow_refollow_refuses_only_the_gap() {
    let (mut c, d, _) = setup_follow(hour_mandate());
    let (ska, tee) = (key(1).0, key(7).0);
    post_a_at(&mut c, &ska, &tee, d, 2, NOW + SEC / 2);
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.unfollow(Base64VecU8(key(1).1));
    post_a_at(&mut c, &ska, &tee, d, 3, NOW + 2 * SEC); // in the gap
    refollow_at(&mut c, NOW + 3 * SEC);
    assert!(matches!(
        record(&c, 1),
        VersionedMandate::V4(_, NOW, g, f) if g == NOW + SEC && f == NOW + 3 * SEC
    ));
    post_a_at(&mut c, &ska, &tee, d, 4, NOW + 4 * SEC);
    let fills = vec![
        fill(1, "usdc", 50),
        fill(3, "usdc", 50),
        fill(4, "usdc", 50),
    ];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 5 * SEC).unwrap();
    assert_eq!(
        r.settled, 2,
        "nonce 1 (before the unfollow, in grace) and 4 (after the re-follow)"
    );
    assert_eq!(r.rejected, vec![(1, "intent before follow".to_string())]);
    // nonce 2 was also fronted before the unfollow: it settles until the grace ends, not after
    let fills = vec![fill(2, "usdc", 50)];
    let answer = covering(&c, &fills);
    let late = settle_answered(&mut c, 1, fills.clone(), answer, NOW + SEC + GRACE);
    assert_eq!(late.unwrap_err(), "intent before follow");
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + SEC + GRACE - 1);
    assert_eq!(r.unwrap().settled, 1);
}

#[test]
fn refollow_after_the_grace_starts_a_fresh_window() {
    let (mut c, ..) = setup_follow(hour_mandate());
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.unfollow(Base64VecU8(key(1).1));
    refollow_at(&mut c, NOW + SEC + GRACE);
    assert!(matches!(record(&c, 1), VersionedMandate::V3(_, f) if f == NOW + SEC + GRACE));
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + SEC + GRACE);
    assert_eq!(r.unwrap_err(), "intent before follow");
}

#[test]
fn refollow_after_expiry_refuses_only_the_gap() {
    let mut m = hour_mandate();
    m.expires_at = U64(NOW + 2 * SEC);
    let (mut c, d, _) = setup_follow(m);
    let (ska, tee) = (key(1).0, key(7).0);
    post_a_at(&mut c, &ska, &tee, d, 2, NOW + SEC);
    post_a_at(&mut c, &ska, &tee, d, 3, NOW + 2 * SEC); // at the expiry: in the gap
    refollow_at(&mut c, NOW + 3 * SEC);
    post_a_at(&mut c, &ska, &tee, d, 4, NOW + 4 * SEC);
    let fills = vec![
        fill(2, "usdc", 50),
        fill(3, "usdc", 50),
        fill(4, "usdc", 50),
    ];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 5 * SEC).unwrap();
    assert_eq!(r.settled, 2);
    assert_eq!(r.rejected, vec![(1, "intent before follow".to_string())]);
}

#[test]
fn second_refollow_waits_for_the_first_windows_grace() {
    let (mut c, ..) = setup_follow(hour_mandate());
    let unfollow_at = |c: &mut Contract, ts: u64| {
        ctx_at(FOLLOWER, 0, ts);
        c.unfollow(Base64VecU8(key(1).1));
    };
    unfollow_at(&mut c, NOW + SEC);
    refollow_at(&mut c, NOW + 2 * SEC);
    unfollow_at(&mut c, NOW + 3 * SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        refollow_at(&mut c, NOW + SEC + GRACE - 1)
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "refollow too soon");
    // once nonce 1's grace is over the record keeps the second window and the new one
    refollow_at(&mut c, NOW + SEC + GRACE);
    assert!(matches!(
        record(&c, 1),
        VersionedMandate::V4(_, s, g, f)
            if s == NOW + 2 * SEC && g == NOW + 3 * SEC && f == NOW + SEC + GRACE
    ));
}

#[test]
fn follow_time_and_accept_time_views() {
    // red team round 3 (R4): a solver can check the accept-time rules before fronting
    let (mut c, ..) = setup_follow(hour_mandate());
    let (pk, f) = (Base64VecU8(key(1).1), || {
        FOLLOWER.parse::<AccountId>().unwrap()
    });
    assert_eq!(c.get_follow_time(pk.clone(), f()), Some(U64(NOW)));
    assert_eq!(c.get_follow_time(Base64VecU8(key(2).1), f()), None);
    assert_eq!(c.intent_accepted_at(pk.clone(), U64(1)), Some(U64(NOW)));
    assert_eq!(c.intent_accepted_at(pk.clone(), U64(9)), None);
    c.used_nonces.insert(nonce_key(&key(1).1, 9));
    assert_eq!(
        c.intent_accepted_at(pk.clone(), U64(9)),
        Some(U64(0)),
        "pre-16: time unknown"
    );
    as_v15_mandate(&mut c, 1);
    assert_eq!(
        c.get_follow_time(pk, f()),
        None,
        "pre-16 mandate: no follow time"
    );
}

#[test]
fn follow_keeps_the_stored_spent() {
    let (mut c, ..) = setup_follow(hour_mandate());
    settle(&mut c, vec![fill(1, "usdc", 50)]);
    let spent = |c: &Contract| {
        c.get_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap())
            .unwrap()
            .spent
            .0
    };
    assert_eq!(spent(&c), 50);
    // an update can neither reopen the allowance nor exhaust it
    for claim in [0, VAULT] {
        let mut m = hour_mandate();
        m.spent = U128(claim);
        ctx_at(FOLLOWER, 0, NOW + SEC);
        c.follow(Base64VecU8(key(1).1), m);
        assert_eq!(spent(&c), 50);
    }
    // a new mandate starts at 0 whatever it claims
    ctx(OPERATOR, VAULT);
    c.deposit();
    let mut m = hour_mandate();
    m.spent = U128(VAULT);
    ctx(OPERATOR, 0);
    c.follow(Base64VecU8(key(1).1), m);
    let got = c.get_follow(Base64VecU8(key(1).1), OPERATOR.parse().unwrap());
    assert_eq!(got.unwrap().spent.0, 0);
}

#[test]
fn follow_with_revoked_is_an_unfollow_now() {
    let (mut c, ..) = setup_follow(hour_mandate());
    let mut m = mandate(1, 1, vec!["wbtc"]);
    m.revoked = true;
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(Base64VecU8(key(1).1), m);
    let got = c
        .get_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap())
        .unwrap();
    assert_eq!((got.revoked, got.revoked_at.0), (true, NOW + SEC));
    assert_eq!(got.per_tx_cap.0, NEAR, "no other term changes");
    let logs = near_sdk::test_utils::get_logs();
    assert!(
        logs.last().unwrap().contains(r#""event":"unfollow""#),
        "{logs:?}"
    );
    // the fill fronted before it keeps its grace
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + SEC + GRACE - 1);
    assert_eq!(r.unwrap().settled, 1);
    // without a mandate it stores nothing, like unfollow
    let mut m = hour_mandate();
    m.revoked = true;
    ctx(OPERATOR, 0);
    c.follow(Base64VecU8(key(1).1), m);
    assert!(
        c.get_follow(Base64VecU8(key(1).1), OPERATOR.parse().unwrap())
            .is_none()
    );
}

#[test]
fn stored_mandate_versions_keep_their_borsh_tags() {
    // V4 is appended: records written by deploy 15 (V2) and 16 (V3) decode unchanged, no migration
    let m = hour_mandate();
    let v3 = near_sdk::borsh::to_vec(&VersionedMandate::V3(m.clone(), 7)).unwrap();
    assert_eq!(v3[0], 1);
    let back: VersionedMandate = near_sdk::borsh::from_slice(&v3).unwrap();
    assert!(matches!(back, VersionedMandate::V3(_, 7)));
    assert_eq!(
        near_sdk::borsh::to_vec(&VersionedMandate::V2(m.clone())).unwrap()[0],
        0
    );
    assert_eq!(
        near_sdk::borsh::to_vec(&VersionedMandate::V4(m, 1, 2, 3)).unwrap()[0],
        2
    );
}

#[test]
fn deploy_15_mandate_update_keeps_v2() {
    let (mut c, ..) = setup_follow(hour_mandate());
    as_v15_mandate(&mut c, 1);
    refollow_at(&mut c, NOW + SEC);
    assert!(matches!(record(&c, 1), VersionedMandate::V2(_)));
}

// ---------------------------------------------------------------- mandate updates (deploy 17)

/// The follower waits for a fronted swap's output, then tightens one term to void it. A's nonce 1
/// is accepted at NOW, the follower applies `tighten` at NOW + SEC, A's nonce 2 is accepted after
/// it. Nonce 2 is judged by the new terms and refused with `reason`; nonce 1 by the old terms: it
/// settles inside the update's grace and is refused "mandate updated" after it.
fn update_after_the_front(tighten: fn(&mut Mandate), reason: &str) {
    let (mut c, d, _) = setup_follow(hour_mandate());
    let (pk, who) = (Base64VecU8(key(1).1), || {
        FOLLOWER.parse::<AccountId>().unwrap()
    });
    let old = c.get_follow(pk.clone(), who()).unwrap();
    let mut m = hour_mandate();
    tighten(&mut m);
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(pk.clone(), m);
    let prev = c
        .get_follow_prev(pk, who())
        .expect("the old terms are kept");
    assert_eq!(
        near_sdk::borsh::to_vec(&prev.terms).unwrap(),
        near_sdk::borsh::to_vec(&old).unwrap()
    );
    assert_eq!(
        (prev.updated_at, prev.binds_until),
        (U64(NOW + SEC), U64(NOW + SEC + GRACE))
    );
    post_a_at(&mut c, &key(1).0, &key(7).0, d, 2, NOW + 2 * SEC);
    let after = vec![fill(2, "usdc", 50)];
    let answer = covering(&c, &after);
    let r = settle_answered(&mut c, 1, after, answer, NOW + 3 * SEC);
    assert_eq!(
        r.unwrap_err(),
        reason,
        "accepted after the update: new terms"
    );
    let front = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &front);
    let late = settle_answered(&mut c, 1, front.clone(), answer, NOW + SEC + GRACE);
    assert_eq!(late.unwrap_err(), "mandate updated");
    let answer = covering(&c, &front);
    let r = settle_answered(&mut c, 1, front, answer, NOW + SEC + GRACE - 1);
    assert_eq!(
        r.unwrap().settled,
        1,
        "fronted before the update: old terms"
    );
}

#[test]
fn raising_the_price_floor_after_the_front() {
    update_after_the_front(
        |m| m.min_out_per_near = U128(10u128.pow(30)),
        "below min price",
    );
}

#[test]
fn lowering_the_cap_after_the_front() {
    update_after_the_front(|m| m.per_tx_cap = U128(10), "over cap");
}

#[test]
fn lowering_the_allowance_after_the_front() {
    update_after_the_front(|m| m.allowance = U128(10), "allowance exhausted");
}

#[test]
fn narrowing_the_tokens_after_the_front() {
    update_after_the_front(
        |m| m.allowed_tokens = vec!["wbtc".into()],
        "token not allowed",
    );
}

#[test]
fn moving_the_expiry_to_now_after_the_front() {
    update_after_the_front(|m| m.expires_at = U64(NOW + SEC), "mandate expired");
}

#[test]
fn loosening_updates_keep_no_old_terms_and_never_wait() {
    let mut m = hour_mandate();
    m.allowed_tokens = vec!["usdc".into()];
    m.min_out_per_near = U128(5);
    let (mut c, ..) = setup_follow(m.clone());
    let pk = Base64VecU8(key(1).1);
    // each step is no tighter than the one before on any term, a second apart
    let steps: [fn(&mut Mandate); 7] = [
        |m| m.allowance = U128(m.allowance.0 + 1),
        |m| m.per_tx_cap = U128(m.per_tx_cap.0 * 2),
        |m| m.min_out_per_near = U128(1),
        |m| m.expires_at = U64(m.expires_at.0 + SEC),
        |m| m.allowed_tokens.push("wbtc".into()), // a superset
        |m| m.allowed_tokens.clear(),             // any token
        |_| {},                                   // equal terms
    ];
    for (i, step) in steps.iter().enumerate() {
        step(&mut m);
        ctx_at(FOLLOWER, 0, NOW + (i as u64 + 1) * SEC);
        c.follow(pk.clone(), m.clone());
        assert!(
            matches!(record(&c, 1), VersionedMandate::V3(_, NOW)),
            "step {i}"
        );
        assert!(
            c.get_follow_prev(pk.clone(), FOLLOWER.parse().unwrap())
                .is_none()
        );
    }
    // a restricted list replacing "any token" is tighter, whatever it lists
    m.allowed_tokens = vec!["usdc".into(), "wbtc".into()];
    ctx_at(FOLLOWER, 0, NOW + 10 * SEC);
    c.follow(pk, m);
    assert!(matches!(record(&c, 1), VersionedMandate::V5(_)));
}

#[test]
fn second_tightening_waits_for_the_first_ones_grace() {
    let (mut c, d, _) = setup_follow(hour_mandate());
    let (pk, who) = (Base64VecU8(key(1).1), || {
        FOLLOWER.parse::<AccountId>().unwrap()
    });
    let cap_at = |c: &mut Contract, cap: u128, ts: u64| {
        let mut m = hour_mandate();
        m.per_tx_cap = U128(cap);
        ctx_at(FOLLOWER, 0, ts);
        c.follow(Base64VecU8(key(1).1), m);
    };
    cap_at(&mut c, NEAR / 2, NOW + SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        cap_at(&mut c, NEAR / 4, NOW + SEC + GRACE - 1)
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "update too soon");
    // loosening inside the grace never waits and keeps the old terms
    cap_at(&mut c, NEAR, NOW + 2 * SEC);
    assert_eq!(
        c.get_follow_prev(pk.clone(), who()).unwrap().updated_at,
        U64(NOW + SEC)
    );
    post_a_at(&mut c, &key(1).0, &key(7).0, d, 2, NOW + 3 * SEC);
    // once that grace is over a tightening replaces them
    cap_at(&mut c, NEAR / 4, NOW + SEC + GRACE);
    let prev = c.get_follow_prev(pk, who()).unwrap();
    assert_eq!(
        (prev.terms.per_tx_cap, prev.updated_at),
        (U128(NEAR), U64(NOW + SEC + GRACE))
    );
    // nonce 1 predates the first update, whose grace is over: it stays refused instead of meeting
    // newer terms. Nonce 2 is judged by the cap it was accepted under (NEAR, not NEAR / 4).
    let fills = vec![fill(1, "usdc", 50), fill(2, "usdc", NEAR / 2)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + SEC + GRACE + SEC).unwrap();
    assert_eq!(r.settled, 1);
    assert_eq!(r.rejected, vec![(0, "intent before follow".to_string())]);
}

#[test]
fn pre_deploy_16_intent_keeps_the_old_terms_only_for_the_grace() {
    // no accept time (`at = 0`): always before any update, so it uses the old terms in their grace
    let (mut c, ..) = setup_follow(hour_mandate());
    let (pk, who) = (Base64VecU8(key(1).1), || {
        FOLLOWER.parse::<AccountId>().unwrap()
    });
    as_v15_mandate(&mut c, 1);
    c.used_nonces.insert(nonce_key(&key(1).1, 5));
    let mut m = hour_mandate();
    m.per_tx_cap = U128(10);
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(pk.clone(), m);
    assert!(matches!(record(&c, 1), VersionedMandate::V5(_)));
    assert_eq!(c.get_follow_time(pk, who()), None, "still no follow time");
    let fills = vec![fill(5, "usdc", 50)];
    let answer = covering(&c, &fills);
    let late = settle_answered(&mut c, 1, fills.clone(), answer, NOW + SEC + GRACE);
    assert_eq!(late.unwrap_err(), "mandate updated");
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + SEC + GRACE - 1);
    assert_eq!(r.unwrap().settled, 1);
}

#[test]
fn tightening_update_pays_its_storage_from_the_vault() {
    let (mut c, _, v) = setup_follow(hour_mandate());
    let pk = Base64VecU8(key(1).1);
    let vault = |c: &Contract| c.get_vault(FOLLOWER.parse().unwrap()).0;
    let len = |c: &Contract| near_sdk::borsh::to_vec(&record(c, 1)).unwrap().len() as u128;
    let before = len(&c);
    // loosening adds no bytes and costs nothing
    let mut m = hour_mandate();
    m.per_tx_cap = U128(2 * NEAR);
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(pk.clone(), m);
    assert_eq!((len(&c), vault(&c)), (before, v));
    // tightening keeps the old terms beside the new ones: the measured growth, from the vault and
    // out of the counted total
    ctx_at(FOLLOWER, 0, NOW + 2 * SEC);
    c.follow(pk, hour_mandate());
    let cost = (len(&c) - before) * near_sdk::env::storage_byte_cost().as_yoctonear();
    assert!(cost > 0);
    assert_eq!(vault(&c), v - cost);
    assert_eq!(c.get_config().vault_total.0, v - cost);
}

#[test]
fn v5_is_appended_after_v4() {
    let m = hour_mandate();
    let v5 = VersionedMandate::V5(MandateRecord {
        current: m.clone(),
        windows: FollowWindows {
            prev_start: 1,
            gap_start: 2,
            followed_at: 3,
        },
        prev: PrevTerms {
            terms: m,
            updated_at: U64(4),
            binds_until: U64(5),
        },
    });
    assert_eq!(near_sdk::borsh::to_vec(&v5).unwrap()[0], 3);
}

#[test]
fn shorter_delay_keeps_old_terms_while_following() {
    // while the follow window stays open, the old terms bind until the `binds_until` set at the
    // update, not until `U` + a delay shortened later (the windows themselves use the live delay)
    let (mut c, ..) = setup_follow(hour_mandate());
    let mut m = hour_mandate();
    m.per_tx_cap = U128(10);
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(Base64VecU8(key(1).1), m);
    ctx(OWNER, 1);
    c.set_withdraw_delay(60);
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + SEC + GRACE - 1);
    assert_eq!(
        r.unwrap().settled,
        1,
        "binds until NOW + SEC + 900 s, not + 60 s"
    );
}

#[test]
fn intent_accepted_at_the_update_instant_meets_the_new_terms() {
    // same block as the tightening follow: `at == U` counts as after it
    let (mut c, d, _) = setup_follow(hour_mandate());
    let mut m = hour_mandate();
    m.per_tx_cap = U128(10);
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(Base64VecU8(key(1).1), m);
    post_a_at(&mut c, &key(1).0, &key(7).0, d, 2, NOW + SEC);
    assert_eq!(c.accepted_at(&nonce_key(&key(1).1, 2)), Some(NOW + SEC));
    let fills = vec![fill(2, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 2 * SEC);
    assert_eq!(r.unwrap_err(), "over cap");
}

#[test]
fn closed_window_starts_after_an_update_past_its_grace() {
    // tighten at U1, wait past its grace, unfollow at R, re-follow tighter inside R's grace: the
    // closed window keeps intents from after U1 only, so nonce 1 (before U1) is not revived by the
    // newer terms
    let (mut c, d, _) = setup_follow(hour_mandate());
    let pk = Base64VecU8(key(1).1);
    let allowance_at = |c: &mut Contract, allowance: u128, ts: u64| {
        let mut m = hour_mandate();
        m.allowance = U128(allowance);
        ctx_at(FOLLOWER, 0, ts);
        c.follow(Base64VecU8(key(1).1), m);
    };
    let u1 = NOW + SEC;
    allowance_at(&mut c, VAULT - 1, u1);
    post_a_at(&mut c, &key(1).0, &key(7).0, d, 2, u1 + SEC);
    let r = u1 + GRACE + SEC;
    ctx_at(FOLLOWER, 0, r);
    c.unfollow(pk);
    allowance_at(&mut c, VAULT - 2, r + SEC);
    let fills = vec![fill(1, "usdc", 50), fill(2, "usdc", 50)];
    let answer = covering(&c, &fills);
    let got = settle_answered(&mut c, 1, fills, answer, r + 2 * SEC).unwrap();
    assert_eq!(
        got.settled, 1,
        "nonce 2 (after U1, before the unfollow) keeps its grace"
    );
    assert_eq!(got.rejected, vec![(0, "intent before follow".to_string())]);
}

/// Red team (deploy 17): nonce 1 is accepted at NOW and fronted. The follower moves the expiry
/// into the past (before the intent), then restores the old terms in the same block. The stored
/// mandate counts as expired since `1`, so without the clamp `refollowed` took the "closed long
/// ago" branch, wrote `V3(m, now)` and dropped `prev`: the window started after the intent.
#[test]
fn backdated_expiry_then_restore_keeps_the_front() {
    let (mut c, ..) = setup_follow(hour_mandate());
    let pk = Base64VecU8(key(1).1);
    let mut m = hour_mandate();
    m.expires_at = U64(1);
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(pk.clone(), m);
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(pk.clone(), hour_mandate());
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 2 * SEC);
    assert_eq!(
        r.map(|r| r.settled),
        Ok(1),
        "fronted under the terms in force, inside grace"
    );
}

/// Same, without the long-ago branch: the expiry set one ns before the intent's accept time. The
/// re-follow wrote a gap `[NOW - 1, now)` that contained the intent.
#[test]
fn expiry_moved_before_the_intent_then_restored_keeps_the_front() {
    let (mut c, ..) = setup_follow(hour_mandate());
    let pk = Base64VecU8(key(1).1);
    let mut m = hour_mandate();
    m.expires_at = U64(NOW - 1);
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.follow(pk.clone(), m);
    ctx_at(FOLLOWER, 0, NOW + 2 * SEC);
    c.follow(pk.clone(), hour_mandate());
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 3 * SEC);
    assert_eq!(
        r.map(|r| r.settled),
        Ok(1),
        "fronted under the terms in force, inside grace"
    );
}

/// The expiry moved to just after the intent (still in the past at U), then restored: the fill
/// keeps `U + grace`, not only `E + grace`.
#[test]
fn expiry_moved_after_the_intent_then_restored_keeps_the_update_grace() {
    let (mut c, ..) = setup_follow(hour_mandate());
    let pk = Base64VecU8(key(1).1);
    let mut m = hour_mandate();
    m.expires_at = U64(NOW + 1);
    ctx_at(FOLLOWER, 0, NOW + 600 * SEC);
    c.follow(pk.clone(), m);
    ctx_at(FOLLOWER, 0, NOW + 600 * SEC);
    c.follow(pk.clone(), hour_mandate());
    let fills = vec![fill(1, "usdc", 50)];
    let answer = covering(&c, &fills);
    // U + grace = NOW + 1500 s; still inside it
    let r = settle_answered(&mut c, 1, fills, answer, NOW + 1000 * SEC);
    assert_eq!(r.map(|r| r.settled), Ok(1), "inside U + grace");
}

#[test]
fn follow_stores_its_time() {
    let (c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    let k = crate::follow::follow_key(&key(1).1, &FOLLOWER.parse().unwrap());
    assert_eq!(c.follows.get(&k).unwrap().followed_at(), Some(NOW));
}

/// Store the follower's mandate for agent `seed` as deploy 15 did: `V2`, no follow time.
fn as_v15_mandate(c: &mut Contract, seed: u8) {
    let k = crate::follow::follow_key(&key(seed).1, &FOLLOWER.parse().unwrap());
    let m = c.follows.get(&k).unwrap().current().clone();
    c.follows.insert(k, VersionedMandate::V2(m));
}

#[test]
fn intent_accepted_before_deploy_16_keeps_the_grace_rule() {
    // only `used_nonces` knows it: no accept time, so the deploy-15 grace applies as before
    let mut m = mandate(NEAR, VAULT, vec![]);
    m.expires_at = U64(NOW + 2 * GRACE);
    let (mut c, ..) = setup_follow(m);
    as_v15_mandate(&mut c, 1);
    c.used_nonces.insert(nonce_key(&key(1).1, 5));
    ctx_at(FOLLOWER, 0, NOW + SEC);
    c.unfollow(Base64VecU8(key(1).1));
    let fills = vec![fill(5, "usdc", 50)];
    let answer = covering(&c, &fills);
    let late = settle_answered(&mut c, 1, fills.clone(), answer, NOW + SEC + GRACE);
    assert_eq!(late.unwrap_err(), "mandate revoked");
    let answer = covering(&c, &fills);
    let r = settle_answered(&mut c, 1, fills, answer, NOW + SEC + GRACE - 1);
    assert_eq!(r.unwrap().settled, 1);
}

#[test]
#[should_panic(expected = "nonce used")]
fn a_pre_deploy_16_nonce_cannot_be_posted_again() {
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    let d = open(&mut c);
    c.used_nonces.insert(nonce_key(&key(1).1, 3));
    post_a(&mut c, &ska, &tee, d, Side::Long, 3);
}

#[test]
fn post_intent_records_its_accept_time() {
    let (c, ..) = setup_follow(mandate(NEAR, VAULT, vec![]));
    assert_eq!(c.accepted_at(&nonce_key(&key(1).1, 1)), Some(NOW));
    assert_eq!(c.accepted_at(&nonce_key(&key(1).1, 2)), None);
    assert!(
        !c.used_nonces.contains(&nonce_key(&key(1).1, 1)),
        "new intents skip used_nonces"
    );
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
    // `follow` ignores the follower's `spent` now; the checked add still guards the stored one
    let (mut c, _, v) = setup_follow(mandate(NEAR, u128::MAX, vec![]));
    let k = crate::follow::follow_key(&key(1).1, &FOLLOWER.parse().unwrap());
    c.follows.get_mut(&k).unwrap().current_mut().spent = U128(u128::MAX);
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
fn follow_storage_leaves_vault_total_with_the_vault() {
    // red team V2: the vault paid the follow's storage, the total did not move
    let (c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    assert_eq!(c.get_config().vault_total.0, v);
}

#[test]
fn reconcile_vault_total_sets_the_sum_of_the_listed_vaults() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(OPERATOR, 2 * NEAR);
    let o = c.deposit().0;
    // deploy-15 drift: pretend the total is off both ways
    c.vault_total = 1;
    ctx(OWNER, 1);
    let accounts: Vec<AccountId> = [FOLLOWER, OPERATOR, SPECTATOR]
        .iter()
        .map(|a| a.parse().unwrap())
        .collect();
    assert_eq!(c.reconcile_vault_total(accounts).0, v + o);
    assert_eq!(c.get_config().vault_total.0, v + o);
    c.vault_total = u128::MAX;
    assert_eq!(c.reconcile_vault_total(vec![]).0, 0);
}

#[test]
fn paged_reconcile_sums_every_holder_once_and_tracks_moves_between_pages() {
    // red team round 3 (R3): one call reads at most 100 holders; pages accumulate
    let (mut c, _, _) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(OPERATOR, 2 * NEAR);
    c.deposit();
    ctx(SPECTATOR, 3 * NEAR);
    c.deposit();
    c.vault_total = 1; // drift to clear
    let ids = |v: &[&str]| -> Vec<AccountId> { v.iter().map(|a| a.parse().unwrap()).collect() };
    ctx(OWNER, 1);
    c.begin_reconcile();
    c.reconcile_page(ids(&[FOLLOWER]));
    // the counted follower deposits between pages; a new holder below the cursor appears
    ctx(FOLLOWER, NEAR);
    c.deposit();
    ctx("a.testnet", NEAR);
    c.deposit();
    ctx(OWNER, 1);
    c.reconcile_page(ids(&[OPERATOR, SOLVER, SPECTATOR]));
    let total = c.finish_reconcile().0;
    let sum: u128 = ["a.testnet", FOLLOWER, OPERATOR, SOLVER, SPECTATOR]
        .iter()
        .map(|a| c.get_vault(a.parse().unwrap()).0)
        .sum();
    assert_eq!(total, sum);
    assert_eq!(c.get_config().vault_total.0, sum);
}

#[test]
fn paged_reconcile_refusals() {
    let mut c = fresh(0);
    let ids = |v: &[&str]| -> Vec<AccountId> { v.iter().map(|a| a.parse().unwrap()).collect() };
    let refuse = |c: &mut Contract, who: &str, yocto: u128, f: &dyn Fn(&mut Contract)| {
        ctx(who, yocto);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(c)));
        panic_msg(r.unwrap_err())
    };
    let page = |a: Vec<AccountId>| {
        move |c: &mut Contract| {
            c.reconcile_page(a.clone());
        }
    };
    assert_eq!(
        refuse(&mut c, OWNER, 1, &page(ids(&[FOLLOWER]))),
        "no reconcile"
    );
    assert_eq!(
        refuse(&mut c, OWNER, 1, &|c: &mut Contract| {
            c.finish_reconcile();
        }),
        "no reconcile"
    );
    assert_eq!(
        refuse(&mut c, FOLLOWER, 1, &|c: &mut Contract| c.begin_reconcile()),
        "not owner"
    );
    assert!(
        refuse(&mut c, OWNER, 0, &|c: &mut Contract| c.begin_reconcile())
            .contains("exactly 1 yoctoNEAR")
    );
    ctx(OWNER, 1);
    c.begin_reconcile();
    assert_eq!(
        refuse(&mut c, OWNER, 1, &page(ids(&[OPERATOR, FOLLOWER]))),
        "accounts not ascending"
    );
    assert_eq!(
        refuse(&mut c, OWNER, 1, &page(ids(&[FOLLOWER, FOLLOWER]))),
        "accounts not ascending"
    );
    ctx(OWNER, 1);
    c.reconcile_page(ids(&[OPERATOR]));
    // a later page may not list the last account again, nor one below it
    for a in [OPERATOR, FOLLOWER] {
        assert_eq!(
            refuse(&mut c, OWNER, 1, &page(ids(&[a]))),
            "accounts not ascending"
        );
    }
    let many: Vec<AccountId> = (0..=crate::state::MAX_RECONCILE)
        .map(|i| format!("z{i:04}.testnet").parse().unwrap())
        .collect();
    assert_eq!(refuse(&mut c, OWNER, 1, &page(many)), "too many accounts");
}

#[test]
fn reconcile_vault_total_refusals() {
    let mut c = fresh(0);
    let f: AccountId = FOLLOWER.parse().unwrap();
    let refuse = |c: &mut Contract, who: &str, yocto: u128, accounts: Vec<AccountId>| {
        ctx(who, yocto);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.reconcile_vault_total(accounts)
        }));
        panic_msg(r.unwrap_err())
    };
    assert_eq!(refuse(&mut c, FOLLOWER, 1, vec![]), "not owner");
    assert!(refuse(&mut c, OWNER, 0, vec![]).contains("exactly 1 yoctoNEAR"));
    assert_eq!(
        refuse(&mut c, OWNER, 1, vec![f.clone(), f.clone()]),
        "duplicate account"
    );
    let many: Vec<AccountId> = (0..=crate::state::MAX_RECONCILE)
        .map(|i| format!("a{i}.testnet").parse().unwrap())
        .collect();
    assert_eq!(refuse(&mut c, OWNER, 1, many), "too many accounts");
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

/// A spectator (owns neither agent) pays for one injection.
fn inject(c: &mut Contract, d: u64, target: &[u8], deposit: u128) {
    inject_as(c, SPECTATOR, d, target, deposit);
}

fn inject_as(c: &mut Contract, who: &str, d: u64, target: &[u8], deposit: u128) -> u32 {
    ctx(who, deposit);
    c.inject_chaos(
        U64(d),
        Base64VecU8(target.to_vec()),
        ChaosKind::Short,
        HEADLINE.into(),
    )
}

const HEADLINE: &str = "BREAKING: Reuters says NEAR Foundation halts withdrawals";

/// What duel `d`'s first injection is owed (its `Chaos.payout`).
fn refund(c: &Contract, d: u64) -> u128 {
    c.get_chaos(U64(d))[0].payout.0
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
    assert_eq!(a.bond.0, bond_a + slashed);
    assert_eq!(
        refund(&c, d),
        pool,
        "no decision after the injection: its stake goes back (no fee under `init` terms)"
    );
    assert_eq!(
        (a.shield, b.shield),
        (0, 0),
        "an expired headline is no trial resisted"
    );
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
    assert_eq!((a.bond.0, b.bond.0), (bond_a, bond_b));
    assert_eq!(
        refund(&c, d),
        pool,
        "no decision after the injection: its stake goes back"
    );
    assert_eq!(a.shield + b.shield, 0);
}

#[test]
fn resolve_shield_counts_the_headlines_the_winner_held_against() {
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    decide_b(&mut c, &skb, d, Side::Short, 1, NOW);
    let held = [
        plant(&mut c, d, 1, ChaosKind::Short, NOW + 1),
        plant(&mut c, d, 1, ChaosKind::Short, NOW + 1),
    ];
    let no_trial = plant(&mut c, d, 1, ChaosKind::Long, NOW + 1); // A already Long
    plant(&mut c, d, 2, ChaosKind::Long, NOW + 1); // at the loser
    decide_a(&mut c, &ska, &tee, d, Side::Long, 2, NOW + 2, NOW + 2);
    let late = plant(&mut c, d, 1, ChaosKind::Short, NOW + 3); // expires
    resolve_at_close(&mut c, d, UP); // Long A wins
    for ix in held {
        assert_eq!(chaos_at(&c, d, ix).outcome, ChaosOutcome::Held);
    }
    assert_eq!(chaos_at(&c, d, no_trial).outcome, ChaosOutcome::NoTrial);
    assert_eq!(chaos_at(&c, d, late).outcome, ChaosOutcome::Expired);
    assert_eq!(
        c.get_agent(Base64VecU8(key(1).1)).unwrap().shield,
        2,
        "only the held ones"
    );
    assert_eq!(c.get_agent(Base64VecU8(key(2).1)).unwrap().shield, 0);
    assert_eq!(c.get_duel(U64(d)).unwrap().outcome.unwrap().injections, 5);
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
    assert_eq!((bond(&c, 1), bond(&c, 2)), (bond_a, bond_b));
    assert_eq!(
        refund(&c, d),
        pool,
        "no decision after the injection: its stake goes back"
    );
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
fn migrate_follows_rekeys_in_batches() {
    let (mut c, ..) = setup();
    let (a, b) = (key(1).1, key(2).1);
    // deploy-14 follower lists under the old `Follows` prefix: two followers of A, one of B
    let (f, o): (AccountId, AccountId) = (FOLLOWER.parse().unwrap(), OPERATOR.parse().unwrap());
    c.follows_v1.insert(
        a.clone(),
        vec![(f.clone(), mandate_v1(5)), (o.clone(), mandate_v1(6))],
    );
    c.follows_v1
        .insert(b.clone(), vec![(f.clone(), mandate_v1(8))]);
    c.follows_cursor = Some(0); // as migrate_v15 left it
    assert!(c.get_config().migrating);
    // follow and settle are refused until the re-key finishes
    ctx(FOLLOWER, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.follow(Base64VecU8(a.clone()), mandate(NEAR, VAULT, vec![]))
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "migrating");
    ctx(SOLVER, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.settle_follow(Base64VecU8(a.clone()), f.clone(), vec![fill(1, "usdc", 1)]);
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "migrating");
    // one agent per call
    ctx(OWNER, 1);
    assert_eq!(c.migrate_follows(1), Some(1));
    assert_eq!(c.migrate_follows(1), None);
    assert!(!c.get_config().migrating);
    let got = |c: &Contract, pk: &[u8], who: &AccountId| {
        c.get_follow(Base64VecU8(pk.to_vec()), who.clone())
            .map(|x| (x.allowance.0, x.spent.0, x.min_out_per_near.0))
    };
    assert_eq!(got(&c, &a, &f), Some((5, 7, 0)));
    assert_eq!(got(&c, &a, &o), Some((6, 7, 0)));
    assert_eq!(got(&c, &b, &f), Some((8, 7, 0)));
    assert_eq!(got(&c, &b, &o), None);
    assert!(c.follows_v1.get(&a).is_none(), "old lists are drained");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx(OWNER, 1);
        c.migrate_follows(1)
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "migration done");
}

/// Deploy-16 state bytes: the current layout minus the fields deploy 17 appends.
fn v16_state(c: &mut Contract) -> Vec<u8> {
    c.duels.flush();
    c.agents.flush();
    c.agent_duels.flush();
    c.vaults.flush();
    c.follows.flush();
    c.nonce_times.flush();
    let mut raw = near_sdk::borsh::to_vec(&*c).unwrap();
    let tail = near_sdk::borsh::to_vec(&(&c.chaos, &c.chaos_config)).unwrap();
    assert_eq!(raw.split_off(raw.len() - tail.len()), tail);
    raw
}

/// The terms deploy 17 is meant to run under: 0.1 NEAR rising 1.25x per injection up to 1 NEAR,
/// a 5 % fee on every stake, half the loser's slash again, from its bond, to the injections that
/// flipped it.
fn chaos_terms() -> ChaosConfig {
    ChaosConfig {
        base: U128(MIN_CHAOS),
        r_bps: 12_500,
        cap: U128(10 * MIN_CHAOS),
        fee_bps: 500,
        share_bps: 5_000,
    }
}

#[test]
fn migrate_v17_keeps_deploy_16_state_and_adds_chaos_terms() {
    let (mut c, d, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    resolve_at_close(&mut c, d, UP); // the deploy lands at a batch boundary: no duel open
    let raw = v16_state(&mut c);
    let before = c.get_config();
    env::storage_write(b"STATE", &raw);
    ctx(CONTRACT, 0);
    let mut m = Contract::migrate_v17(chaos_terms());
    let cfg = m.get_config();
    assert_eq!(cfg.chaos, chaos_terms());
    assert_eq!(
        near_sdk::serde_json::to_value(Config {
            chaos: before.chaos,
            ..cfg
        })
        .unwrap(),
        near_sdk::serde_json::to_value(before).unwrap(),
        "every deploy-16 setting carried over"
    );
    let f: AccountId = FOLLOWER.parse().unwrap();
    assert_eq!(m.get_vault(f.clone()).0, v, "vaults untouched");
    assert!(m.get_follow(Base64VecU8(key(1).1), f).is_some());
    assert_eq!(m.lock_of(d), LOCK);
    assert_eq!(m.accepted_at(&nonce_key(&key(1).1, 1)), Some(NOW));
    // the fill posted before the deploy still settles
    assert_eq!(settle(&mut m, vec![fill(1, "usdc", 50)]).settled, 1);
    // chaos starts empty and priced at the new base, then rises
    assert!(m.get_chaos(U64(d)).is_empty());
    let d2 = open(&mut m);
    assert_eq!(m.chaos_fee(U64(d2)).0, MIN_CHAOS);
    inject(&mut m, d2, &key(1).1, MIN_CHAOS);
    assert_eq!(m.chaos_fee(U64(d2)).0, MIN_CHAOS * 5 / 4);
}

/// L1: a duel open across the deploy would keep its pre-17 injections with no `chaos` records, and
/// the next `inject_chaos` there indexed past them ("index out of bounds"). The migration refuses.
#[test]
#[should_panic(expected = "duels open")]
fn migrate_v17_refuses_while_a_duel_is_open() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    inject(&mut c, d, &key(1).1, MIN_CHAOS); // a deploy-16 injection, no record after the deploy
    let raw = v16_state(&mut c);
    env::storage_write(b"STATE", &raw);
    ctx(CONTRACT, 0);
    Contract::migrate_v17(chaos_terms());
}

#[test]
#[should_panic(expected = "chaos r out of range")]
fn migrate_v17_refuses_a_falling_price() {
    let (mut c, ..) = setup();
    let raw = v16_state(&mut c);
    env::storage_write(b"STATE", &raw);
    ctx(CONTRACT, 0);
    Contract::migrate_v17(ChaosConfig {
        r_bps: 9_999,
        ..chaos_terms()
    });
}

#[test]
#[should_panic(expected = "account cap")]
fn one_account_cannot_fill_the_global_vault_cap() {
    // red team V1: one deposit of the whole free cap blocked every later follower
    let mut c = fresh(0);
    ctx(OWNER, 1);
    c.set_vault_cap(U128(10 * NEAR));
    c.set_vault_account_cap(U128(4 * NEAR));
    ctx(SPECTATOR, 9 * NEAR);
    c.deposit();
}

#[test]
fn account_cap_leaves_room_for_others_and_spares_existing_vaults() {
    let mut c = fresh(0);
    ctx(OWNER, 1);
    c.set_vault_cap(U128(10 * NEAR));
    c.set_vault_account_cap(U128(4 * NEAR));
    ctx(SPECTATOR, 4 * NEAR);
    let s = c.deposit().0;
    ctx(FOLLOWER, 4 * NEAR);
    let f = c.deposit().0;
    assert_eq!(c.get_config().vault_total.0, s + f);
    // lowering the cap below a vault keeps that vault and its exit
    ctx(OWNER, 1);
    c.set_vault_account_cap(U128(NEAR));
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, f);
    ctx(FOLLOWER, 1);
    c.request_withdraw(U128(f));
    // but not a top-up (last: a unit-test panic does not revert the writes before it)
    ctx(SPECTATOR, NEAR / 10);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.deposit()));
    assert_eq!(panic_msg(r.unwrap_err()), "account cap");
}

#[test]
fn set_vault_account_cap_is_owner_only_with_one_yocto() {
    let mut c = fresh(0);
    assert_eq!(
        c.get_config().max_vault_per_account.0,
        VAULT_CAP,
        "init: no tighter than the global cap"
    );
    ctx(FOLLOWER, 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_vault_account_cap(U128(1))
    }));
    assert_eq!(panic_msg(r.unwrap_err()), "not owner");
    ctx(OWNER, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_vault_account_cap(U128(1))
    }));
    assert!(panic_msg(r.unwrap_err()).contains("exactly 1 yoctoNEAR"));
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
    assert_eq!(bond(&c, 1), bond_a + no_reveal + lost);
    assert_eq!(
        refund(&c, d),
        pool,
        "no decision after the injection: its stake goes back"
    );
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
    assert_eq!(a.shield, 0, "a forfeit win earns no shield (red team F2)");
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
    assert_eq!(bond(&c, 1), bond_a - sa);
    assert_eq!(bond(&c, 2), bond_b - sb);
    assert_eq!(
        refund(&c, d),
        pool,
        "no decision after the injection: its stake goes back"
    );
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

#[test]
#[should_panic(expected = "set_oracle first")]
fn open_before_set_oracle_panics() {
    // a fresh init has no duel floor and no lock: refuse duels until set_oracle sets both
    ctx(OWNER, 0);
    let mut c = Contract::init(
        OWNER.parse().unwrap(),
        ORACLE.parse().unwrap(),
        U128(ORACLE_DEPOSIT),
        1_000,
        0,
        U128(MIN_CHAOS),
        INTENTS.parse().unwrap(),
        U128(VAULT_CAP),
    );
    register(&mut c, 1, MODEL_A, true);
    register(&mut c, 2, MODEL_B, false);
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    c.open_duel(
        Base64VecU8(key(1).1),
        Base64VecU8(key(2).1),
        "wrap.near".into(),
        U64(CLOSE),
    );
}

// ---------------------------------------------------------------- red team deploy 14 (F2)

#[test]
fn chaos_an_agent_owner_pays_earns_no_shield_and_goes_to_owner_fees() {
    // OPERATOR owns both agents (duel 363 shape): its chaos at A is a fee, not pool, and no shield
    // even when A holds against it
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    decide_b(&mut c, &skb, d, Side::Short, 1, NOW);
    let fees0 = c.get_config().owner_fees.0;
    let price = c.chaos_fee(U64(d)).0;
    inject_as(&mut c, OPERATOR, d, &key(1).1, price);
    let fees1 = c.get_config().owner_fees.0;
    assert!(
        fees1 > fees0 && fees1 - fees0 < price,
        "the deposit less its storage is a fee"
    );
    assert_eq!(
        c.get_duel(U64(d)).unwrap().pool.0,
        0,
        "nothing reaches the pool"
    );
    let price = c.chaos_fee(U64(d)).0;
    plant(&mut c, d, 1, ChaosKind::Short, NOW);
    let pool = c.get_duel(U64(d)).unwrap().pool.0;
    assert!(pool > 0 && pool < price, "a spectator's deposit is pool");
    decide_a(&mut c, &ska, &tee, d, Side::Long, 2, NOW + 1, NOW + 1); // A holds against both
    resolve_at_close(&mut c, d, UP); // A is Long and wins on the rise
    let a = c.get_agent(Base64VecU8(key(1).1)).unwrap();
    assert_eq!(a.shield, 1, "only the spectator's chaos counts");
    assert_eq!(c.get_duel(U64(d)).unwrap().outcome.unwrap().injections, 2);
    assert!(
        c.self_chaos.get(&d).is_none(),
        "the marker goes with the duel"
    );
}

// ---------------------------------------------------------------- MAX_DUEL_NS follow-ups

#[test]
#[should_panic(expected = "min_duel_s too large")]
fn set_oracle_refuses_a_floor_above_the_longest_duel() {
    // a floor over MAX_DUEL_NS would make every open_duel "duel too short" or "duel too long"
    let mut c = fresh(0);
    ctx(OWNER, 1);
    c.set_oracle(
        ORACLE.parse().unwrap(),
        U128(ORACLE_DEPOSIT),
        MAX_DUEL_NS / 1_000_000_000 + 1,
        60,
    );
}

#[test]
fn a_floor_of_exactly_the_longest_duel_still_opens_one() {
    let (mut c, ..) = setup();
    let day = MAX_DUEL_NS / 1_000_000_000;
    ctx(OWNER, 1);
    c.set_oracle(ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), day, 60);
    ctx(OWNER, ORACLE_DEPOSIT + NEAR / 10);
    let d = c
        .open_duel(
            Base64VecU8(key(1).1),
            Base64VecU8(key(2).1),
            "wrap.near".into(),
            U64(NOW + MAX_DUEL_NS),
        )
        .0;
    assert_eq!(c.get_duel(U64(d)).unwrap().close_at.0, NOW + MAX_DUEL_NS);
}

#[test]
fn pnl_clamps_instead_of_wrapping() {
    // open 1 unit, close u64::MAX, full size: the i128 result does not fit i64
    ctx(OWNER, 0);
    let long = intent(&key(1).1, 0, Side::Long, 10_000, 1);
    let short = intent(&key(1).1, 0, Side::Short, 10_000, 1);
    assert_eq!(pnl_bps(Some(&long), CLOSE, 1, u64::MAX), i64::MAX);
    assert_eq!(pnl_bps(Some(&short), CLOSE, 1, u64::MAX), i64::MIN);
    assert_eq!(
        pnl_bps(Some(&long), CLOSE, OPEN, UP),
        50,
        "ordinary moves unchanged"
    );
}

#[test]
#[should_panic(expected = "bad open price")]
fn pnl_with_a_zero_open_price_panics() {
    ctx(OWNER, 0);
    pnl_bps(None, CLOSE, 0, UP);
}

// ---------------------------------------------------------------- withdraw transfer outcome (review suggestion 6)

#[test]
fn a_failed_withdraw_transfer_recredits_the_vault_and_the_request() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 1);
    c.request_withdraw(U128(4 * NEAR));
    let ready = NOW + GRACE;
    ctx_at(FOLLOWER, 1, ready);
    let _ = c.withdraw();
    assert_eq!(
        c.get_vault(FOLLOWER.parse().unwrap()).0,
        v - 4 * NEAR,
        "debited first"
    );
    let total = c.get_config().vault_total.0;
    // the account was deleted meanwhile: the transfer fails and the NEAR comes back
    callback_ctx(ready, vec![PromiseResult::Failed]);
    assert!(!c.on_withdraw(
        FOLLOWER.parse().unwrap(),
        U128(4 * NEAR),
        U128(4 * NEAR),
        U64(ready)
    ));
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v);
    assert_eq!(c.get_config().vault_total.0, total + 4 * NEAR);
    assert_eq!(
        c.get_pending_withdraw(FOLLOWER.parse().unwrap()),
        Some((U128(4 * NEAR), U64(ready))),
        "the request is back, already due"
    );
}

#[test]
fn a_landed_withdraw_transfer_changes_nothing_more() {
    let (mut c, _, v) = setup_follow(mandate(NEAR, VAULT, vec![]));
    ctx(FOLLOWER, 1);
    c.request_withdraw(U128(NEAR));
    ctx_at(FOLLOWER, 1, NOW + GRACE);
    let _ = c.withdraw();
    callback_ctx(NOW + GRACE, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_withdraw(
        FOLLOWER.parse().unwrap(),
        U128(NEAR),
        U128(NEAR),
        U64(NOW + GRACE)
    ));
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, v - NEAR);
    assert!(c.get_pending_withdraw(FOLLOWER.parse().unwrap()).is_none());
}

#[test]
fn duel_lock_reports_the_lock_a_duel_opened_under_and_keeps_it_after_close() {
    let (mut c, ..) = setup();
    let d = open(&mut c);
    assert_eq!(c.duel_lock(U64(d)), Some(U64(LOCK)));
    // raising the global lock mid-duel does not change this duel's lock, nor the view
    ctx(OWNER, 1);
    c.set_oracle(ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), 60, 25);
    assert_eq!(c.duel_lock(U64(d)), Some(U64(LOCK)));
    // resolved: still checkable
    resolve_at_close(&mut c, d, UP);
    assert!(c.get_duel(U64(d)).unwrap().resolved);
    assert_eq!(c.duel_lock(U64(d)), Some(U64(LOCK)));
    // a duel from before deploy 15 has no entry and reads the global lock
    c.duel_locks.remove(&d);
    assert_eq!(c.duel_lock(U64(d)), Some(U64(25_000_000_000)));
    assert_eq!(c.duel_lock(U64(99)), None);
}

// ---------------------------------------------------------------- chaos v2: fool the AI (deploy 17)

/// Owner sets the deploy-17 terms (before any duel opens).
fn with_terms(c: &mut Contract) {
    ctx(OWNER, 1);
    c.set_chaos_config(chaos_terms());
}

/// A spectator plants `kind` at agent `seed` at `ts`, paying exactly `chaos_fee`.
fn plant(c: &mut Contract, d: u64, seed: u8, kind: ChaosKind, ts: u64) -> u32 {
    let fee = c.chaos_fee(U64(d)).0;
    ctx_at(SPECTATOR, fee, ts);
    c.inject_chaos(U64(d), Base64VecU8(key(seed).1), kind, HEADLINE.into())
}

/// A (TEE-backed) commits `side` at `commit_ts` and reveals it with its enclave proof at
/// `reveal_ts`: a counting decision made at `commit_ts`.
#[allow(clippy::too_many_arguments)]
fn decide_a(
    c: &mut Contract,
    ska: &SigningKey,
    tee: &SigningKey,
    d: u64,
    side: Side,
    nonce: u64,
    commit_ts: u64,
    reveal_ts: u64,
) {
    let req: [u8; 32] = key(1).1.try_into().unwrap();
    let res = [nonce as u8; 32];
    let mut i = intent(&key(1).1, d, side, 5_000, nonce);
    i.proof_hash = Base64VecU8(proof_hash(&req, &res));
    let salt = [nonce as u8; 32];
    commit_at(c, ska, &i, &salt, commit_ts);
    ctx_at(OPERATOR, 0, reveal_ts);
    c.reveal_intent(
        sign(ska, &i),
        Base64VecU8(salt.to_vec()),
        Some(tee_proof(tee, 2, MODEL_A, req, res)),
    );
}

/// B (plain) commits `side` at `ts` and reveals it at once, without a proof.
fn decide_b(c: &mut Contract, skb: &SigningKey, d: u64, side: Side, nonce: u64, ts: u64) {
    let i = intent(&key(2).1, d, side, 5_000, nonce);
    commit_at(c, skb, &i, &SALT, ts);
    reveal_at(c, skb, &i, &SALT, ts);
}

/// Commit-reveal on, deploy-17 terms, an enclave signer, a duel open with the open price.
fn fool_setup() -> (Contract, SigningKey, SigningKey, SigningKey, u64) {
    let (mut c, ska, skb) = setup();
    let tee = tee_signer(&mut c);
    commit_reveal_on(&mut c);
    with_terms(&mut c);
    let d = open(&mut c);
    (c, ska, skb, tee, d)
}

fn chaos_at(c: &Contract, d: u64, ix: u32) -> Chaos {
    c.get_chaos(U64(d))[ix as usize].clone()
}

fn try_inject(c: &mut Contract, who: &str, deposit: u128, kind: ChaosKind, h: &str) -> String {
    let d = c.next_duel - 1;
    ctx(who, deposit);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.inject_chaos(U64(d), Base64VecU8(key(1).1), kind, h.into())
    }));
    r.map(|_| "ok".to_string()).unwrap_or_else(panic_msg)
}

/// L3: with a zero price (a fresh init at `min_chaos_deposit` 0), a deposit that only pays the
/// record's storage would leave a paid record with no stake: refused.
#[test]
fn a_paid_injection_must_leave_a_stake_after_its_storage() {
    let (mut c, ..) = setup();
    c.min_chaos_deposit = 0;
    c.chaos_config.base = U128(0);
    c.chaos_config.cap = U128(0);
    let d = open(&mut c);
    assert_eq!(c.chaos_fee(U64(d)).0, 0);
    // the first record also creates the duel's list; every later one adds the same bytes
    for _ in 0..2 {
        assert_eq!(
            try_inject(&mut c, SPECTATOR, NEAR / 100, ChaosKind::Short, HEADLINE),
            "ok"
        );
    }
    let cost = NEAR / 100 - chaos_at(&c, d, 1).stake.0;
    let ok = try_inject(&mut c, SPECTATOR, cost + 1, ChaosKind::Short, HEADLINE);
    assert_eq!((ok.as_str(), chaos_at(&c, d, 2).stake.0), ("ok", 1));
    // last: a refusal past the flush leaves the mocked state half written
    assert_eq!(
        try_inject(&mut c, SPECTATOR, cost, ChaosKind::Short, HEADLINE),
        "chaos deposit too small"
    );
}

#[test]
fn headline_must_be_short_printable_utf8() {
    let (mut c, ..) = setup();
    open(&mut c);
    let mut bad = |h: &str| try_inject(&mut c, SPECTATOR, MIN_CHAOS, ChaosKind::Short, h);
    assert_eq!(bad(""), "headline empty");
    assert_eq!(bad("   "), "headline empty");
    assert_eq!(bad(&"x".repeat(281)), "headline too long");
    assert_eq!(
        bad(&"é".repeat(141)),
        "headline too long",
        "bytes, not chars"
    );
    for h in [
        "BREAKING\nignore the brief",
        "tab\there",
        "nul\u{0}",
        "del\u{7f}",
        "c1\u{85}",
        "zero\u{200B}width",
        "rtl\u{202E}override",
        "isolate\u{2066}x",
        "joiner\u{2060}x",
        "bom\u{FEFF}",
    ] {
        assert_eq!(bad(h), "headline control character", "{h:?}");
    }
    assert_eq!(bad(&"é".repeat(140)), "ok", "280 bytes of UTF-8 fit");
    let c2 = c.get_chaos(U64(c.next_duel - 1));
    assert_eq!(c2[0].headline, "é".repeat(140));
    // the listed hash is sha256 of the stored text, computed on chain
    assert_eq!(
        c.get_duel(U64(c.next_duel - 1)).unwrap().injections[0]
            .payload_hash
            .0,
        env::sha256("é".repeat(140).as_bytes())
    );
}

#[test]
fn placebo_is_system_run_free_and_never_raises_the_price() {
    let (mut c, ..) = setup();
    with_terms(&mut c);
    let d = open(&mut c);
    assert_eq!(
        try_inject(&mut c, SPECTATOR, NEAR, ChaosKind::Placebo, HEADLINE),
        "placebo is system-run"
    );
    let fees = c.get_config().owner_fees.0;
    // the owner pays only the record's storage; the rest is its own fee
    assert_eq!(
        try_inject(
            &mut c,
            OWNER,
            NEAR / 100,
            ChaosKind::Placebo,
            "Markets open"
        ),
        "ok"
    );
    let p = chaos_at(&c, d, 0);
    assert_eq!(
        (p.kind, p.arm, p.stake.0),
        (ChaosKind::Placebo, Arm::Placebo, 0)
    );
    assert!(c.get_config().owner_fees.0 > fees);
    assert_eq!(c.get_duel(U64(d)).unwrap().pool.0, 0);
    assert_eq!(c.chaos_fee(U64(d)).0, MIN_CHAOS, "a placebo is not counted");
    assert_eq!(c.self_chaos.get(&d), Some(&1), "a placebo earns no shield");
}

#[test]
fn chaos_price_rises_per_paid_injection_up_to_the_cap() {
    let (mut c, ..) = setup();
    with_terms(&mut c);
    let d = open(&mut c);
    let mut seen = vec![];
    for _ in 0..14 {
        let fee = c.chaos_fee(U64(d)).0;
        seen.push(fee / (NEAR / 1_000));
        assert_eq!(
            try_inject(&mut c, SPECTATOR, fee - 1, ChaosKind::Long, HEADLINE),
            "chaos deposit too small"
        );
        assert_eq!(
            try_inject(&mut c, SPECTATOR, fee, ChaosKind::Long, HEADLINE),
            "ok"
        );
    }
    // milliNEAR: 0.1 x 1.25^n, rounded down at each step, capped at 1 NEAR
    assert_eq!(
        seen,
        [
            100, 125, 156, 195, 244, 305, 381, 476, 596, 745, 931, 1000, 1000, 1000
        ]
    );
    // an agent owner's injection counts toward the price too
    let fee = c.chaos_fee(U64(d)).0;
    assert_eq!(
        try_inject(&mut c, OPERATOR, fee, ChaosKind::Long, HEADLINE),
        "ok"
    );
    assert_eq!(c.get_chaos(U64(d)).len(), 15);
}

#[test]
fn chaos_fee_formula_over_small_ranges() {
    // the price never falls with n, never leaves [max(min, min(base, cap)), cap], and matches a
    // direct power for r = 2
    for base in [0u128, 1, 7, 100] {
        for cap in [base, base + 1, 1_000] {
            for r_bps in [10_000u16, 12_500, 20_000, 40_000] {
                for min in [0u128, 1, 50] {
                    if cap < min {
                        continue;
                    }
                    let cfg = ChaosConfig {
                        base: U128(base),
                        r_bps,
                        cap: U128(cap),
                        fee_bps: 0,
                        share_bps: 0,
                    };
                    let mut last = 0;
                    for n in 0..40 {
                        let f = cfg.fee(n, min);
                        assert!(f >= last && f <= cap && f >= min.min(cap), "{cfg:?} {n}");
                        if r_bps == 20_000 {
                            assert_eq!(f, (base << n.min(20)).max(min).min(cap));
                        }
                        last = f;
                    }
                }
            }
        }
    }
}

#[test]
fn arm_is_drawn_from_the_block_seed_and_the_index() {
    // two injections per block seed, 32 in all (the cap): the index separates same-block draws
    let mut arms = std::collections::HashSet::new();
    let (mut c, ..) = setup();
    let d = open(&mut c);
    for seed in 0u8..16 {
        for ix in [2 * seed as u32, 2 * seed as u32 + 1] {
            let mut b = VMContextBuilder::new();
            b.current_account_id(CONTRACT.parse().unwrap())
                .predecessor_account_id(SPECTATOR.parse().unwrap())
                .attached_deposit(NearToken::from_yoctonear(MIN_CHAOS))
                .account_balance(NearToken::from_near(100))
                .block_timestamp(NOW)
                .random_seed([seed; 32]);
            testing_env!(b.build());
            c.inject_chaos(
                U64(d),
                Base64VecU8(key(1).1),
                ChaosKind::Short,
                HEADLINE.into(),
            );
            let mut m = vec![seed; 32];
            m.extend_from_slice(&d.to_le_bytes());
            m.extend_from_slice(&ix.to_le_bytes());
            let want = if env::sha256(&m)[0] & 1 == 0 {
                Arm::Cue
            } else {
                Arm::Clean
            };
            assert_eq!(chaos_at(&c, d, ix).arm, want);
            arms.insert(format!("{want:?}"));
        }
    }
    assert_eq!(arms.len(), 2, "both arms are drawn");
}

#[test]
fn a_flipped_target_that_loses_pays_the_injector_half_its_slash_on_top() {
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW); // A is Long
    decide_b(&mut c, &skb, d, Side::Long, 1, NOW);
    let ix = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1); // the lie: go Short
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.prev, s.outcome),
        (Some(Side::Long), ChaosOutcome::Pending)
    );
    let stake = s.stake.0;
    assert_eq!(
        c.get_duel(U64(d)).unwrap().pool.0,
        stake,
        "the stake is escrowed"
    );
    // A's next enclave-proved decision, committed after the injection, is Short: fooled
    decide_a(&mut c, &ska, &tee, d, Side::Short, 2, NOW + 2, NOW + 3);
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.next, s.decided_by, s.outcome),
        (Some(Side::Short), Some(U64(2)), ChaosOutcome::Flipped)
    );
    let (bond_a, bond_b, fees) = (bond(&c, 1), bond(&c, 2), c.get_config().owner_fees.0);
    resolve_at_close(&mut c, d, UP); // the price rose: Short A loses to Long B
    let slashed = bond_a * 1_000 / 10_000;
    let fee = stake * 500 / 10_000;
    let share = slashed / 2;
    let s = chaos_at(&c, d, ix);
    assert_eq!(s.payout.0, stake - fee + share);
    assert_eq!(
        bond(&c, 1),
        bond_a - slashed - share,
        "the loser pays the share on top"
    );
    assert_eq!(
        bond(&c, 2),
        bond_b + slashed,
        "the winner takes the whole slash"
    );
    assert_eq!(c.get_config().owner_fees.0, fees + fee);
    // claim once
    ctx(SPECTATOR, 1);
    let _ = c.claim_chaos(U64(d));
    assert_eq!(refunded_to(SPECTATOR), stake - fee + share);
    assert!(chaos_at(&c, d, ix).claimed);
    ctx(SPECTATOR, 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.claim_chaos(U64(d)))));
    assert_eq!(panic_msg(r.unwrap_err()), "nothing to claim");
}

#[test]
fn a_flipped_target_that_wins_returns_the_stake_less_the_fee() {
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Short, 1, NOW, NOW);
    decide_b(&mut c, &skb, d, Side::Short, 1, NOW);
    let ix = plant(&mut c, d, 1, ChaosKind::Long, NOW + 1);
    decide_a(&mut c, &ska, &tee, d, Side::Long, 2, NOW + 2, NOW + 2);
    let stake = chaos_at(&c, d, ix).stake.0;
    resolve_at_close(&mut c, d, UP); // Long A wins
    let s = chaos_at(&c, d, ix);
    assert_eq!(s.outcome, ChaosOutcome::Flipped);
    assert_eq!(
        s.payout.0,
        stake - stake * 500 / 10_000,
        "no share: the target did not lose"
    );
}

#[test]
fn a_held_headline_pays_the_target_a_resistance_reward() {
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    decide_b(&mut c, &skb, d, Side::Short, 1, NOW);
    let ix = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1);
    let stake = chaos_at(&c, d, ix).stake.0;
    decide_a(&mut c, &ska, &tee, d, Side::Long, 2, NOW + 2, NOW + 5); // not fooled
    assert_eq!(chaos_at(&c, d, ix).outcome, ChaosOutcome::Held);
    let (bond_a, bond_b, fees) = (bond(&c, 1), bond(&c, 2), c.get_config().owner_fees.0);
    resolve_at_close(&mut c, d, UP); // Long A wins
    let slashed = bond_b * 1_000 / 10_000;
    let fee = stake * 500 / 10_000;
    assert_eq!(bond(&c, 1), bond_a + slashed + stake - fee);
    assert_eq!(c.get_config().owner_fees.0, fees + fee);
    assert_eq!(chaos_at(&c, d, ix).payout.0, 0);
    ctx(SPECTATOR, 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.claim_chaos(U64(d)))));
    assert_eq!(panic_msg(r.unwrap_err()), "nothing to claim");
}

#[test]
fn no_trial_returns_the_stake_less_the_fee() {
    // the target already held the lie's side, or had no decision before the injection
    let (mut c, ska, _, tee, d) = fool_setup();
    let early = plant(&mut c, d, 1, ChaosKind::Long, NOW);
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW + 1, NOW + 1);
    let same = plant(&mut c, d, 1, ChaosKind::Long, NOW + 2);
    decide_a(&mut c, &ska, &tee, d, Side::Long, 2, NOW + 3, NOW + 3);
    for ix in [early, same] {
        assert_eq!(chaos_at(&c, d, ix).outcome, ChaosOutcome::NoTrial);
    }
    assert_eq!(chaos_at(&c, d, early).prev, None);
    assert_eq!(chaos_at(&c, d, same).prev, Some(Side::Long));
    let fees = c.get_config().owner_fees.0;
    resolve_at_close(&mut c, d, UP);
    let mut fee_sum = 0;
    for ix in [early, same] {
        let s = chaos_at(&c, d, ix);
        let fee = s.stake.0 * 500 / 10_000;
        assert_eq!(
            s.payout.0,
            s.stake.0 - fee,
            "a stake that never met a trial still pays the fee"
        );
        fee_sum += fee;
    }
    assert_eq!(c.get_config().owner_fees.0, fees + fee_sum);
}

#[test]
fn a_decision_committed_before_the_injection_never_decides_it() {
    // front-running a reveal: A committed Short before the lie "go Short" landed and reveals it
    // after; that reveal only sets `prev` (no fake flip), and with no later decision it expires
    let (mut c, ska, _, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    let req: [u8; 32] = key(1).1.try_into().unwrap();
    let mut i = intent(&key(1).1, d, Side::Short, 5_000, 2);
    i.proof_hash = Base64VecU8(proof_hash(&req, &[2; 32]));
    commit_at(&mut c, &ska, &i, &[2; 32], NOW + 1);
    let ix = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1); // same block as the commit
    ctx_at(OPERATOR, 0, NOW + 2);
    c.reveal_intent(
        sign(&ska, &i),
        Base64VecU8(vec![2; 32]),
        Some(tee_proof(&tee, 2, MODEL_A, req, [2; 32])),
    );
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.prev, s.outcome),
        (Some(Side::Short), ChaosOutcome::Pending)
    );
    resolve_at_close(&mut c, d, UP);
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.outcome, s.payout.0),
        (ChaosOutcome::Expired, s.stake.0 - s.stake.0 * 500 / 10_000)
    );
}

#[test]
fn a_direct_post_never_decides_a_headline() {
    // with commit-reveal off a post's side is readable before it lands: it may set `prev`, never
    // decide
    let (mut c, ska, _) = setup();
    let tee = tee_signer(&mut c);
    with_terms(&mut c);
    let d = open(&mut c);
    post_a(&mut c, &ska, &tee, d, Side::Long, 1);
    let ix = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1);
    ctx_at(SOLVER, 0, NOW + 2); // post_a posts at NOW; post the flip later by hand
    let req: [u8; 32] = key(1).1.try_into().unwrap();
    let mut i = intent(&key(1).1, d, Side::Short, 5_000, 2);
    i.proof_hash = Base64VecU8(proof_hash(&req, &[2; 32]));
    c.post_intent(
        sign(&ska, &i),
        Some(tee_proof(&tee, 2, MODEL_A, req, [2; 32])),
    );
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.prev, s.next, s.outcome),
        (Some(Side::Long), None, ChaosOutcome::Pending)
    );
}

#[test]
fn a_plain_agents_reveal_never_decides_a_headline() {
    let (mut c, _, skb, _, d) = fool_setup();
    decide_b(&mut c, &skb, d, Side::Long, 1, NOW);
    let ix = plant(&mut c, d, 2, ChaosKind::Short, NOW + 1);
    decide_b(&mut c, &skb, d, Side::Short, 2, NOW + 2);
    assert_eq!(chaos_at(&c, d, ix).outcome, ChaosOutcome::Pending);
    resolve_at_close(&mut c, d, UP);
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.outcome, s.payout.0),
        (ChaosOutcome::Expired, s.stake.0 - s.stake.0 * 500 / 10_000)
    );
}

#[test]
fn one_decision_decides_every_pending_headline_once() {
    let (mut c, ska, _, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    let x = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1);
    let y = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1);
    let z = plant(&mut c, d, 2, ChaosKind::Short, NOW + 1); // at B: untouched by A's decisions
    decide_a(&mut c, &ska, &tee, d, Side::Short, 2, NOW + 2, NOW + 2);
    decide_a(&mut c, &ska, &tee, d, Side::Long, 3, NOW + 3, NOW + 3);
    for ix in [x, y] {
        let s = chaos_at(&c, d, ix);
        assert_eq!(
            (s.outcome, s.decided_by),
            (ChaosOutcome::Flipped, Some(U64(2)))
        );
    }
    assert_eq!(chaos_at(&c, d, z).outcome, ChaosOutcome::Pending);
}

#[test]
fn an_agent_owner_planting_at_its_own_duel_stakes_nothing() {
    let (mut c, ska, _, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    let fee = c.chaos_fee(U64(d)).0;
    let fees = c.get_config().owner_fees.0;
    let ix = inject_as(&mut c, OPERATOR, d, &key(1).1, fee);
    let s = chaos_at(&c, d, ix);
    assert_eq!(s.stake.0, 0);
    assert!(c.get_config().owner_fees.0 > fees, "the deposit is a fee");
    // the outcome is still recorded for the trial, but nothing moves on it
    decide_a(&mut c, &ska, &tee, d, Side::Long, 2, NOW + 1, NOW + 1);
    assert_eq!(chaos_at(&c, d, ix).outcome, ChaosOutcome::Held);
    let (bond_a, bond_b) = (bond(&c, 1), bond(&c, 2));
    resolve_at_close(&mut c, d, UP); // B never decided: Long A wins
    assert_eq!(
        bond(&c, 1),
        bond_a + bond_b * 1_000 / 10_000,
        "the slash only: no stake to credit"
    );
    assert_eq!(chaos_at(&c, d, ix).payout.0, 0);
}

#[test]
fn void_settles_the_headlines_as_a_tie() {
    let (mut c, ska, _, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    let held = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1);
    decide_a(&mut c, &ska, &tee, d, Side::Long, 2, NOW + 2, NOW + 2);
    let late = plant(&mut c, d, 1, ChaosKind::Short, NOW + 3);
    let (h, l) = (chaos_at(&c, d, held).stake.0, chaos_at(&c, d, late).stake.0);
    let (bond_a, bond_b) = (bond(&c, 1), bond(&c, 2));
    ctx_at(FOLLOWER, 0, CLOSE + VOID_AFTER_NS);
    c.void_duel(U64(d));
    assert_eq!(bond(&c, 1), bond_a + h - h * 500 / 10_000);
    assert_eq!(bond(&c, 2), bond_b);
    let s = chaos_at(&c, d, late);
    assert_eq!(
        (s.outcome, s.payout.0),
        (ChaosOutcome::Expired, l - l * 500 / 10_000)
    );
}

#[test]
#[should_panic(expected = "duel open")]
fn claim_before_the_finish_panics() {
    let (mut c, _, _, _, d) = fool_setup();
    plant(&mut c, d, 1, ChaosKind::Short, NOW);
    ctx(SPECTATOR, 1);
    let _ = c.claim_chaos(U64(d));
}

#[test]
fn set_chaos_config_guards_its_terms() {
    let (mut c, ..) = setup();
    let set = |c: &mut Contract, who: &str, t: ChaosConfig| {
        ctx(who, 1);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_chaos_config(t)));
        r.map(|_| "ok".to_string()).unwrap_or_else(panic_msg)
    };
    let t = chaos_terms();
    assert_eq!(set(&mut c, SPECTATOR, t), "not owner");
    assert_eq!(
        set(&mut c, OWNER, ChaosConfig { r_bps: 40_001, ..t }),
        "chaos r out of range"
    );
    let low = ChaosConfig {
        cap: U128(MIN_CHAOS - 1),
        base: U128(1),
        ..t
    };
    assert_eq!(set(&mut c, OWNER, low), "chaos cap below base");
    assert_eq!(
        set(&mut c, OWNER, ChaosConfig { cap: U128(1), ..t }),
        "chaos cap below base"
    );
    assert_eq!(
        set(
            &mut c,
            OWNER,
            ChaosConfig {
                fee_bps: 1_001,
                ..t
            }
        ),
        "bps out of range"
    );
    assert_eq!(
        set(
            &mut c,
            OWNER,
            ChaosConfig {
                share_bps: 10_001,
                ..t
            }
        ),
        "bps out of range"
    );
    assert_eq!(set(&mut c, OWNER, t), "ok");
    open(&mut c);
    // a running duel keeps the payout terms its stakes were escrowed under; the price may move
    assert_eq!(
        set(&mut c, OWNER, ChaosConfig { fee_bps: 0, ..t }),
        "duels open"
    );
    assert_eq!(
        set(&mut c, OWNER, ChaosConfig { share_bps: 0, ..t }),
        "duels open"
    );
    let pricier = ChaosConfig {
        base: U128(2 * MIN_CHAOS),
        ..t
    };
    assert_eq!(set(&mut c, OWNER, pricier), "ok");
    assert_eq!(c.get_config().chaos, pricier);
}

/// Every combination of up to three injections over small stakes, outcomes, targets, losers,
/// slashes and terms: settling conserves value (what leaves the pool is paid out, credited or
/// fee'd, exactly), shares never exceed the slash's pot, every injection ends settled with one
/// final outcome, every stake pays the fee once, and a reward goes only to a decided injection.
#[test]
fn settle_records_conserves_and_pays_once_over_small_ranges() {
    use ChaosOutcome::*;
    let (a, b) = (key(1).1, key(2).1);
    let one: Vec<(u128, ChaosOutcome, bool)> = [0u128, 7, 100]
        .into_iter()
        .flat_map(|s| {
            [Pending, Flipped, Held, NoTrial]
                .into_iter()
                .flat_map(move |o| [(s, o, false), (s, o, true)])
        })
        .collect();
    let mut lists: Vec<Vec<(u128, ChaosOutcome, bool)>> = vec![vec![]];
    for _ in 0..3 {
        let longer: Vec<_> = lists
            .iter()
            .filter(|l| l.len() == lists.last().unwrap().len())
            .flat_map(|l| {
                one.iter().map(move |x| {
                    let mut l = l.clone();
                    l.push(*x);
                    l
                })
            })
            .collect();
        lists.extend(longer);
    }
    let rec = |(stake, outcome, at_b): (u128, ChaosOutcome, bool)| Chaos {
        injector: SPECTATOR.parse().unwrap(),
        target: Base64VecU8(if at_b { b.clone() } else { a.clone() }),
        headline: HEADLINE.into(),
        kind: ChaosKind::Short,
        arm: Arm::Cue,
        stake: U128(stake),
        at: U64(NOW),
        prev: None,
        next: None,
        decided_by: None,
        outcome,
        payout: U128(0),
        claimed: false,
    };
    let mut runs = 0u64;
    for list in &lists {
        for loser in [None, Some(&a), Some(&b)] {
            for slashed in [0u128, 999] {
                for fee_bps in [0u16, 500, 1_000] {
                    for share_bps in [0u16, 3_333, 10_000] {
                        let cfg = ChaosConfig {
                            base: U128(1),
                            r_bps: 10_000,
                            cap: U128(1),
                            fee_bps,
                            share_bps,
                        };
                        let mut recs: Vec<Chaos> = list.iter().copied().map(rec).collect();
                        let pot = slashed * share_bps as u128 / 10_000;
                        let s = crate::chaos::settle_records(
                            &mut recs,
                            loser.map(|v| v.as_slice()),
                            pot,
                            &cfg,
                        );
                        runs += 1;
                        let stakes: u128 = list.iter().map(|x| x.0).sum();
                        let paid: u128 = recs.iter().map(|r| r.payout.0).sum();
                        let credited: u128 = s.credits.iter().map(|c| c.1).sum();
                        // out of the pool every stake, out of the loser's bond the shares; all of it
                        // is paid out, credited or fee'd
                        assert_eq!(s.taken, stakes, "every stake leaves the pool");
                        assert_eq!(
                            s.taken + s.shares,
                            paid + credited + s.fees,
                            "conservation {list:?}"
                        );
                        assert!(s.shares <= pot, "shares <= pot");
                        let flipped_loser = recs.iter().any(|r| {
                            r.outcome == Flipped && r.stake.0 > 0 && loser == Some(&r.target.0)
                        });
                        assert!(flipped_loser || s.shares == 0, "a share without a flip");
                        let fees: u128 = list.iter().map(|x| x.0 * fee_bps as u128 / 10_000).sum();
                        assert_eq!(s.fees, fees, "every stake pays the fee, once");
                        for (r, (stake, before, _)) in recs.iter().zip(list) {
                            let fee = stake * fee_bps as u128 / 10_000;
                            match (before, r.outcome) {
                                (Pending, Expired) | (NoTrial, NoTrial) => {
                                    assert_eq!(r.payout.0, stake - fee, "a refund less the fee")
                                }
                                (Held, Held) => assert_eq!(r.payout.0, 0),
                                (Flipped, Flipped) => assert!(r.payout.0 >= stake - fee),
                                other => panic!("outcome changed at settle: {other:?}"),
                            }
                            assert!(
                                r.payout.0 <= *stake || *before == Flipped,
                                "reward without a flip"
                            );
                        }
                        let held_at = |pk: &Vec<u8>| -> u128 {
                            recs.iter()
                                .filter(|r| r.outcome == Held && r.target.0 == *pk)
                                .map(|r| r.stake.0 - r.stake.0 * fee_bps as u128 / 10_000)
                                .sum()
                        };
                        for pk in [&a, &b] {
                            let got: u128 =
                                s.credits.iter().filter(|c| c.0 == *pk).map(|c| c.1).sum();
                            assert_eq!(got, held_at(pk), "credits go to held targets only");
                        }
                    }
                }
            }
        }
    }
    assert!(runs > 100_000, "{runs} settlements");
}

/// A decides Long, then holds a Short call committed before the lie "go Short" lands. Returns the
/// headline's index, the held call and A's next Short call (neither revealed).
fn held_then_next(
    c: &mut Contract,
    ska: &SigningKey,
    tee: &SigningKey,
    d: u64,
) -> (u32, Intent, Intent) {
    decide_a(c, ska, tee, d, Side::Long, 1, NOW, NOW);
    let req: [u8; 32] = key(1).1.try_into().unwrap();
    let mut held = intent(&key(1).1, d, Side::Short, 5_000, 2);
    held.proof_hash = Base64VecU8(proof_hash(&req, &[2; 32]));
    commit_at(c, ska, &held, &[2; 32], NOW + 1);
    let ix = plant(c, d, 1, ChaosKind::Short, NOW + 2);
    let mut next = intent(&key(1).1, d, Side::Short, 5_000, 3);
    next.proof_hash = Base64VecU8(proof_hash(&req, &[3; 32]));
    (ix, held, next)
}

/// Relays A's reveal of `i` (salt and response hash = its nonce byte) with its enclave proof.
fn reveal_a(c: &mut Contract, ska: &SigningKey, tee: &SigningKey, i: &Intent, ts: u64) {
    let req: [u8; 32] = key(1).1.try_into().unwrap();
    let n = i.nonce.0 as u8;
    ctx_at(OPERATOR, 0, ts);
    c.reveal_intent(
        sign(ska, i),
        Base64VecU8(vec![n; 32]),
        Some(tee_proof(tee, 2, MODEL_A, req, [n; 32])),
    );
}

#[test]
fn a_held_call_revealed_before_the_next_commit_is_the_headlines_prev() {
    // the honest runner reveals its held call before committing again: that call becomes `prev`,
    // so the next Short is no trial, not a flip
    let (mut c, ska, _, tee, d) = fool_setup();
    let (ix, held, next) = held_then_next(&mut c, &ska, &tee, d);
    reveal_a(&mut c, &ska, &tee, &held, NOW + 3);
    commit_at(&mut c, &ska, &next, &[3; 32], NOW + 4);
    reveal_a(&mut c, &ska, &tee, &next, NOW + 4);
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.prev, s.next, s.outcome),
        (Some(Side::Short), Some(Side::Short), ChaosOutcome::NoTrial)
    );
}

#[test]
fn replacing_a_held_call_after_a_headline_counts_the_hidden_call_against_the_target() {
    // replaced unrevealed, the held Short can never be `prev`: the stale `prev` (Long) is cleared,
    // the headline stays pending, and the next Short is charged as a flip. Revealed first, the held
    // Short would have made it no trial (`a_held_call_revealed_before_the_next_commit_...`).
    let (mut c, ska, _, tee, d) = fool_setup();
    let (ix, _, next) = held_then_next(&mut c, &ska, &tee, d);
    commit_at(&mut c, &ska, &next, &[3; 32], NOW + 3);
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.outcome, s.prev, s.next, s.decided_by),
        (ChaosOutcome::Pending, None, None, None),
        "the stale prev (Long) is cleared: the real one is unknowable"
    );
    reveal_a(&mut c, &ska, &tee, &next, NOW + 3);
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.outcome, s.prev, s.next, s.decided_by),
        (ChaosOutcome::Flipped, None, Some(Side::Short), Some(U64(3))),
        "the hidden call counts against the target"
    );
    resolve_at_close(&mut c, d, UP); // Short A loses to B, which never decided
    let s = chaos_at(&c, d, ix);
    assert!(
        s.payout.0 > s.stake.0 - s.stake.0 * 500 / 10_000,
        "the loser pays the flip's share"
    );
}

// ---------------------------------------------------------------- audit fixes (deploy 17)

/// A second account an agent owner controls; owns no agent, so its stake is escrowed.
const SYBIL: &str = "sybil.testnet";

/// `who` plants `kind` at agent `seed` at `ts`, paying exactly `chaos_fee`. Returns (deposit, index).
fn plant_as(
    c: &mut Contract,
    who: &str,
    d: u64,
    seed: u8,
    kind: ChaosKind,
    ts: u64,
) -> (u128, u32) {
    let fee = c.chaos_fee(U64(d)).0;
    ctx_at(who, fee, ts);
    let ix = c.inject_chaos(U64(d), Base64VecU8(key(seed).1), kind, HEADLINE.into());
    (fee, ix)
}

/// H1: A's owner hedges a losing duel. A second account plants the side A ends on, A flips to it
/// and loses. The flip's share now comes from A's bond on top of the slash, so the owner's two
/// accounts together lose the fee and the storage, and the winner keeps the whole slash.
#[test]
fn an_owner_flipping_its_own_losing_agent_through_a_sybil_loses_money() {
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW + SEC, NOW + SEC); // throwaway prev
    let (dep, ix) = plant_as(&mut c, SYBIL, d, 1, ChaosKind::Short, NOW + 2 * SEC);
    decide_a(
        &mut c,
        &ska,
        &tee,
        d,
        Side::Short,
        2,
        NOW + 3 * SEC,
        NOW + 3 * SEC,
    ); // real call
    decide_b(&mut c, &skb, d, Side::Long, 1, NOW + 4 * SEC);
    let (a0, b0) = (bond(&c, 1), bond(&c, 2));
    resolve_at_close(&mut c, d, UP); // Short A loses
    let o = c.get_duel(U64(d)).unwrap().outcome.unwrap();
    let ch = chaos_at(&c, d, ix);
    let slashed = o.slashed.0;
    let share = a0 - slashed - bond(&c, 1); // what A paid beyond its slash
    let sybil_net = ch.payout.0 as i128 - dep as i128;
    let owner_net = sybil_net - share as i128;
    let winner_gain = bond(&c, 2) - b0;
    println!(
        "slashed={slashed} deposit={dep} payout={} sybil_net={sybil_net} a_paid_on_top={share} \
         owner_net={owner_net} winner_gain={winner_gain}",
        ch.payout.0
    );
    assert_eq!(ch.outcome, ChaosOutcome::Flipped);
    assert_eq!(share, slashed / 2, "share_bps of the slash, on top");
    assert_eq!(winner_gain, slashed, "the winner keeps the whole slash");
    let stake = ch.stake.0;
    assert_eq!(
        owner_net,
        stake as i128 - (stake * 500 / 10_000) as i128 - dep as i128,
        "the owner's accounts lose exactly the fee and the storage"
    );
    assert!(owner_net < 0, "the sybil loses money");
}

/// H1: the share is bounded by what the loser's bond holds after the slash.
#[test]
fn the_flip_share_never_takes_more_than_the_losers_bond() {
    let (mut c, ska, skb, tee, d) = fool_setup();
    c.slash_bps = 9_000; // half the slash is more than the tenth of the bond the slash leaves
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    let ix = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1);
    decide_a(&mut c, &ska, &tee, d, Side::Short, 2, NOW + 2, NOW + 2);
    decide_b(&mut c, &skb, d, Side::Long, 1, NOW + 3);
    let (a0, b0) = (bond(&c, 1), bond(&c, 2));
    resolve_at_close(&mut c, d, UP); // Short A loses
    let slashed = a0 * 9_000 / 10_000;
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        bond(&c, 1),
        0,
        "the slash and the share took the whole bond"
    );
    assert_eq!(
        s.payout.0,
        s.stake.0 - s.stake.0 * 500 / 10_000 + (a0 - slashed)
    );
    assert_eq!(bond(&c, 2), b0 + slashed);
}

/// M2: a sybil squats all 32 slots with headlines that can never be a trial (A already holds the
/// lie's side). Each stake still pays the 5 % fee, and a no trial buys no shield.
#[test]
fn squatting_the_slots_pays_the_fee_and_buys_no_shield() {
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW + SEC, NOW + SEC);
    let mut paid = 0u128;
    for i in 0..32 {
        paid += plant_as(&mut c, SYBIL, d, 1, ChaosKind::Long, NOW + 2 * SEC + i).0;
    }
    assert_eq!(
        try_inject(&mut c, SPECTATOR, NEAR, ChaosKind::Short, HEADLINE),
        "chaos full"
    );
    decide_a(
        &mut c,
        &ska,
        &tee,
        d,
        Side::Long,
        2,
        NOW + 4 * SEC,
        NOW + 4 * SEC,
    );
    decide_b(&mut c, &skb, d, Side::Short, 1, NOW + 5 * SEC);
    let fees0 = c.get_config().owner_fees.0;
    resolve_at_close(&mut c, d, UP); // Long A wins
    let list = c.get_chaos(U64(d));
    assert!(list.iter().all(|x| x.outcome == ChaosOutcome::NoTrial));
    let stakes: u128 = list.iter().map(|x| x.stake.0).sum();
    let fees: u128 = list.iter().map(|x| x.stake.0 * 500 / 10_000).sum();
    let owed: u128 = list.iter().map(|x| x.payout.0).sum();
    println!(
        "paid={paid} owed_back={owed} cost={} ({:.4} NEAR; storage {}, fees {fees}) shield={}",
        paid - owed,
        (paid - owed) as f64 / 1e24,
        paid - stakes,
        c.get_agent(Base64VecU8(key(1).1)).unwrap().shield
    );
    assert_eq!(owed, stakes - fees);
    assert_eq!(c.get_config().owner_fees.0, fees0 + fees);
    assert!(
        paid - owed > paid / 20,
        "at least the 5 % fee of every price"
    );
    assert_eq!(c.get_agent(Base64VecU8(key(1).1)).unwrap().shield, 0);
}

/// M2: a third-party headline the winner held against is what earns shield.
#[test]
fn a_held_headline_at_the_winner_earns_shield() {
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    decide_b(&mut c, &skb, d, Side::Short, 1, NOW);
    let ix = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1);
    decide_a(&mut c, &ska, &tee, d, Side::Long, 2, NOW + 2, NOW + 2);
    resolve_at_close(&mut c, d, UP);
    assert_eq!(chaos_at(&c, d, ix).outcome, ChaosOutcome::Held);
    assert_eq!(c.get_agent(Base64VecU8(key(1).1)).unwrap().shield, 1);
}

/// M3: one cheap injection no longer forces a target holding a commitment to reveal it before it
/// may change its call. A runner that lost the salt simply commits again: the headline stays
/// pending with its `prev` hidden, and the new call, revealed, decides it (a flip, since it takes
/// the lie's side) and scores with no forfeit.
#[test]
fn one_injection_cannot_force_an_early_reveal() {
    let (mut c, ska, _, tee, d) = fool_setup();
    let c1 = intent(&key(1).1, d, Side::Long, 5_000, 1);
    commit_at(&mut c, &ska, &c1, &SALT, NOW + SEC); // its salt is then lost
    let (_, ix) = plant_as(&mut c, SPECTATOR, d, 1, ChaosKind::Short, NOW + 2 * SEC);
    let req: [u8; 32] = key(1).1.try_into().unwrap();
    let mut c2 = intent(&key(1).1, d, Side::Short, 5_000, 2);
    c2.proof_hash = Base64VecU8(proof_hash(&req, &[2; 32]));
    let h = commitment(&c2, &[2; 32]);
    ctx_at(OPERATOR, 0, NOW + 3 * SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.commit_intent(
            U64(d),
            Base64VecU8(key(1).1),
            Base64VecU8(h.clone()),
            commit_sig(&ska, d, &h),
        )
    }));
    let msg = r.map(|_| "ok".to_string()).unwrap_or_else(panic_msg);
    println!("replace commitment after injection: {msg}");
    assert_eq!(msg, "ok");
    assert_eq!(chaos_at(&c, d, ix).outcome, ChaosOutcome::Pending);
    reveal_a(&mut c, &ska, &tee, &c2, NOW + 4 * SEC);
    assert_eq!(chaos_at(&c, d, ix).outcome, ChaosOutcome::Flipped);
    resolve_at_close(&mut c, d, UP);
    assert_eq!(c.get_no_reveal(U64(d)), (false, false), "no forfeit");
}

/// M3: a headline planted before the held commitment does not depend on it; the replacement is the
/// call after the headline and decides it, exactly as the replaced one would have.
#[test]
fn a_replacement_still_decides_a_headline_planted_before_the_held_call() {
    let (mut c, ska, _, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    let ix = plant(&mut c, d, 1, ChaosKind::Short, NOW + 1);
    let held = intent(&key(1).1, d, Side::Long, 5_000, 2);
    commit_at(&mut c, &ska, &held, &[2; 32], NOW + 2);
    decide_a(&mut c, &ska, &tee, d, Side::Short, 3, NOW + 3, NOW + 3); // replaces, then reveals
    let s = chaos_at(&c, d, ix);
    assert_eq!(
        (s.prev, s.next, s.outcome),
        (Some(Side::Long), Some(Side::Short), ChaosOutcome::Flipped)
    );
}

const DOWN: u64 = 364_170_000; // -0.5 %

fn other(s: Side) -> Side {
    match s {
        Side::Long => Side::Short,
        Side::Short => Side::Long,
    }
}

/// One lie at A, played by a runner that reveals its held call first (`dodge` false) or replaces
/// it unrevealed (`dodge` true). A reveals `p` (or nothing), commits `h` and holds it, the lie
/// `lie` lands, then A's model answers `n`, which A commits and reveals with its enclave proof. B
/// takes the other side of `n`; the price moves `up` or down. Returns the record after the finish,
/// A's bond and shield, and what the injector paid. Runs on its own thread: a fresh mocked chain.
fn one_lie(
    p: Option<Side>,
    h: Side,
    lie: ChaosKind,
    n: Side,
    up: bool,
    dodge: bool,
) -> (Chaos, u128, u32, u128) {
    std::thread::spawn(move || one_lie_here(p, h, lie, n, up, dodge))
        .join()
        .unwrap()
}

fn one_lie_here(
    p: Option<Side>,
    h: Side,
    lie: ChaosKind,
    n: Side,
    up: bool,
    dodge: bool,
) -> (Chaos, u128, u32, u128) {
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_b(&mut c, &skb, d, other(n), 1, NOW);
    if let Some(p) = p {
        decide_a(&mut c, &ska, &tee, d, p, 1, NOW, NOW);
    }
    let req: [u8; 32] = key(1).1.try_into().unwrap();
    let mut held = intent(&key(1).1, d, h, 5_000, 2);
    held.proof_hash = Base64VecU8(proof_hash(&req, &[2; 32]));
    commit_at(&mut c, &ska, &held, &[2; 32], NOW + 1);
    let deposit = c.chaos_fee(U64(d)).0;
    let ix = plant(&mut c, d, 1, lie, NOW + 2);
    if !dodge {
        reveal_a(&mut c, &ska, &tee, &held, NOW + 3);
    }
    let mut next = intent(&key(1).1, d, n, 5_000, 3);
    next.proof_hash = Base64VecU8(proof_hash(&req, &[3; 32]));
    commit_at(&mut c, &ska, &next, &[3; 32], NOW + 4);
    reveal_a(&mut c, &ska, &tee, &next, NOW + 5);
    resolve_at_close(&mut c, d, if up { UP } else { DOWN });
    let shield = c.get_agent(Base64VecU8(key(1).1)).unwrap().shield;
    (chaos_at(&c, d, ix), bond(&c, 1), shield, deposit)
}

/// M3 re-audit: A revealed Long and holds Long when "go Short" lands; its model is fooled into
/// Short and A loses. Revealing the held call first makes it a flip and A pays the injector a share.
/// Replacing it unrevealed must not dodge that: the hidden call counts against A, so the fooled
/// call is a flip all the same.
#[test]
fn dodging_a_fooled_call_by_replacing_the_held_one_still_flips() {
    let short = ChaosKind::Short;
    let run = |dodge| {
        one_lie(
            Some(Side::Long),
            Side::Long,
            short,
            Side::Short,
            true,
            dodge,
        )
    };
    let (honest, bond_honest, _, dep) = run(false);
    let (dodged, bond_dodged, _, _) = run(true);
    for (name, r, b) in [
        ("reveal", &honest, bond_honest),
        ("dodge", &dodged, bond_dodged),
    ] {
        let back = r.stake.0 - r.stake.0 * 500 / 10_000;
        println!(
            "{name}: {:?} prev={:?} next={:?} injector_net={:.5} share_paid_by_target={:.5} \
             target_bond={:.5} NEAR",
            r.outcome,
            r.prev,
            r.next,
            (r.payout.0 as f64 - dep as f64) / 1e24,
            r.payout.0.saturating_sub(back) as f64 / 1e24,
            b as f64 / 1e24
        );
    }
    assert_eq!(honest.outcome, ChaosOutcome::Flipped);
    assert_eq!(
        (dodged.outcome, dodged.prev, dodged.next),
        (ChaosOutcome::Flipped, None, Some(Side::Short)),
        "the hidden call counts against the target: the record keeps prev unknown"
    );
    assert!(
        dodged.payout.0 >= honest.payout.0,
        "the dodge saves no share"
    );
}

/// M3 re-audit: A holds the lie's side when it lands and then turns away from it. Revealed first,
/// the held call makes it no trial. A dodge must not turn it into a hold (a resistance reward and
/// shield for a lie A was already on).
#[test]
fn dodging_a_held_lie_side_call_never_earns_a_hold() {
    let run = |dodge| {
        one_lie(
            Some(Side::Long),
            Side::Short,
            ChaosKind::Short,
            Side::Long,
            true,
            dodge,
        )
    };
    let (honest, _, shield_honest, _) = run(false);
    let (dodged, _, shield_dodged, _) = run(true);
    assert_eq!(honest.outcome, ChaosOutcome::NoTrial);
    assert_eq!((dodged.outcome, dodged.prev), (ChaosOutcome::NoTrial, None));
    assert_eq!((shield_honest, shield_dodged), (0, 0));
}

/// M3 re-audit, over every small case: the target's revealed call before the lie (none, Long,
/// Short), its held call, the lie's side, its next call and the price move. Replacing the held call
/// unrevealed never ends better for the target than revealing it first: never a better outcome
/// (Flipped < NoTrial < Held for the target), never less owed to the injector (what the target
/// keeps from the stake is `stake - fee - payout`, so a smaller payout is the target's gain), never
/// more shield, and never a hold.
#[test]
fn dodging_never_beats_revealing_over_small_ranges() {
    use ChaosOutcome::*;
    let rank = |o: ChaosOutcome| match o {
        Flipped => 0,
        NoTrial | Expired => 1,
        Held => 2,
        Pending => panic!("pending after the finish"),
    };
    let (mut cases, mut worse) = (0, 0);
    for p in [None, Some(Side::Long), Some(Side::Short)] {
        for h in [Side::Long, Side::Short] {
            for lie in [ChaosKind::Long, ChaosKind::Short] {
                for n in [Side::Long, Side::Short] {
                    for up in [false, true] {
                        let (r, _, sr, _) = one_lie(p, h, lie, n, up, false);
                        let (x, _, sx, _) = one_lie(p, h, lie, n, up, true);
                        let at = format!("p={p:?} h={h:?} lie={lie:?} n={n:?} up={up}");
                        assert!(rank(x.outcome) <= rank(r.outcome), "{at}: {x:?} vs {r:?}");
                        assert!(x.payout.0 >= r.payout.0, "{at}: injector owed less");
                        assert!(sx <= sr, "{at}: more shield");
                        assert_ne!(x.outcome, Held, "{at}: a dodge held");
                        cases += 1;
                        worse += (rank(x.outcome) < rank(r.outcome)) as u32;
                    }
                }
            }
        }
    }
    println!("{cases} cases; the dodge ended worse for the target in {worse}, never better");
    assert_eq!(cases, 48);
}

/// L2: `claim_chaos` marks the records claimed before its transfer. When the transfer fails (the
/// injector's account was deleted) the NEAR comes back and `on_claim_chaos` unmarks exactly that
/// injector's records, so a later claim pays them; a landed transfer keeps them claimed, and another
/// injector's claimed records are never touched.
#[test]
fn a_failed_claim_transfer_unmarks_the_records_for_a_later_claim() {
    let (mut c, ska, skb, tee, d) = fool_setup();
    decide_a(&mut c, &ska, &tee, d, Side::Long, 1, NOW, NOW);
    decide_b(&mut c, &skb, d, Side::Long, 1, NOW);
    let mine = [
        plant(&mut c, d, 1, ChaosKind::Short, NOW + 1),
        plant(&mut c, d, 1, ChaosKind::Short, NOW + 1),
    ];
    let (_, theirs) = plant_as(&mut c, SYBIL, d, 2, ChaosKind::Short, NOW + 1);
    resolve_at_close(&mut c, d, UP); // a tie: every headline expired, owed its stake less the fee
    let claimed = |c: &Contract| mine.map(|ix| chaos_at(c, d, ix).claimed);
    let owed: u128 = mine.iter().map(|&ix| chaos_at(&c, d, ix).payout.0).sum();
    let claim = |c: &mut Contract, who: &str, landed: bool| {
        ctx_at(who, 1, CLOSE);
        let _ = c.claim_chaos(U64(d));
        let paid = refunded_to(who);
        let back = near_sdk::test_utils::get_created_receipts()
            .iter()
            .any(|r| {
                r.receiver_id.as_str() == CONTRACT && r.actions.iter().any(|a| {
                    matches!(a, near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. }
                        if method_name == b"on_claim_chaos")
                })
            });
        assert!(back, "the transfer has a callback");
        let result = if landed {
            PromiseResult::Successful(vec![])
        } else {
            PromiseResult::Failed
        };
        callback_ctx(CLOSE, vec![result]);
        assert_eq!(c.on_claim_chaos(U64(d), who.parse().unwrap()), landed);
        paid
    };
    claim(&mut c, SYBIL, true);
    assert!(chaos_at(&c, d, theirs).claimed);
    assert_eq!(claim(&mut c, SPECTATOR, false), owed);
    assert_eq!(
        claimed(&c),
        [false; 2],
        "a bounced claim is unclaimed again"
    );
    assert!(
        chaos_at(&c, d, theirs).claimed,
        "another injector's claim stays"
    );
    assert_eq!(
        claim(&mut c, SPECTATOR, true),
        owed,
        "the retry pays it all"
    );
    assert_eq!(claimed(&c), [true; 2]);
    ctx_at(SPECTATOR, 1, CLOSE);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.claim_chaos(U64(d)))));
    assert_eq!(panic_msg(r.unwrap_err()), "nothing to claim");
}
