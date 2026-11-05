use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

pub const OWNER: &str = "solver.testnet"; // contract owner = solver account in the hackathon deploy
pub const SOLVER: &str = "solver.testnet";
pub const OPERATOR: &str = "operator.testnet";
pub const FOLLOWER: &str = "follower.testnet";
pub const NOW: u64 = 1_700_000_000_000_000_000;
pub const CLOSE: u64 = NOW + 60_000_000_000; // +60 s
pub const BOND: u128 = 1_000_000;
pub const MIN_CHAOS: u128 = 100;

pub fn ctx_at(pred: &str, deposit: u128, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(pred.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(deposit))
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

pub fn sign_res(sk: &SigningKey, r: &Resolution) -> Base64VecU8 {
    Base64VecU8(sk.sign(&resolution_message(r)).to_bytes().to_vec())
}

/// Contract with oracle key seed 9, solver registered, agents A (seed 1) and B (seed 2) bonded.
pub fn setup() -> (Contract, SigningKey, SigningKey, SigningKey) {
    let (oracle, oracle_pk) = key(9);
    let (ska, pka) = key(1);
    let (skb, pkb) = key(2);
    ctx(OWNER, 0);
    let mut c = Contract::init(OWNER.parse().unwrap(), Base64VecU8(oracle_pk), 1_000, 0, U128(MIN_CHAOS));
    c.add_solver(SOLVER.parse().unwrap());
    ctx(OPERATOR, BOND);
    c.register_agent(Base64VecU8(pka), "model-a".into());
    ctx(OPERATOR, BOND);
    c.register_agent(Base64VecU8(pkb), "model-b".into());
    ctx(OWNER, 0);
    (c, oracle, ska, skb)
}

pub fn open(c: &mut Contract) -> u64 {
    ctx(OWNER, 0);
    c.open_duel(Base64VecU8(key(1).1), Base64VecU8(key(2).1), "BTC/USD".into(), U64(CLOSE)).0
}

// ---------------------------------------------------------------- task 2: agents, duels, intents

#[test]
#[should_panic(expected = "agent exists")]
fn register_twice_panics() {
    let (mut c, ..) = setup();
    ctx(OPERATOR, BOND);
    c.register_agent(Base64VecU8(key(1).1), "again".into());
}

#[test]
#[should_panic(expected = "in duel")]
fn open_duel_requires_free_agents() {
    let (mut c, ..) = setup();
    open(&mut c);
    open(&mut c);
}

#[test]
fn post_intent_stores_last_intent() {
    let (mut c, _, ska, _) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    c.post_intent(sign(&ska, &intent(&key(1).1, d, Side::Long, 5_000, 1)));
    c.post_intent(sign(&ska, &intent(&key(1).1, d, Side::Short, 2_500, 2)));
    let duel = c.get_duel(U64(d)).unwrap();
    let last = duel.last_intent_a.unwrap();
    assert_eq!(last.side, Side::Short);
    assert_eq!(last.nonce.0, 2);
    assert!(duel.last_intent_b.is_none());
}

#[test]
#[should_panic(expected = "nonce used")]
fn post_intent_replay_panics() {
    let (mut c, _, ska, _) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    let s = sign(&ska, &intent(&key(1).1, d, Side::Long, 5_000, 1));
    c.post_intent(s.clone());
    c.post_intent(s);
}

#[test]
#[should_panic(expected = "duel closed")]
fn post_intent_at_close_panics() {
    let (mut c, _, ska, _) = setup();
    let d = open(&mut c);
    ctx_at(SOLVER, 0, CLOSE);
    c.post_intent(sign(&ska, &intent(&key(1).1, d, Side::Long, 5_000, 1)));
}

#[test]
#[should_panic(expected = "bad size")]
fn post_intent_bad_size_panics() {
    let (mut c, _, ska, _) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    c.post_intent(sign(&ska, &intent(&key(1).1, d, Side::Long, 10_001, 1)));
}

#[test]
#[should_panic(expected = "bad signature")]
fn post_intent_bad_sig_panics() {
    let (mut c, _, _, skb) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    // signed by B's key but claims A's pk
    c.post_intent(sign(&skb, &intent(&key(1).1, d, Side::Long, 5_000, 1)));
}

#[test]
#[should_panic(expected = "not solver")]
fn non_solver_cannot_post() {
    let (mut c, _, ska, _) = setup();
    let d = open(&mut c);
    ctx(OPERATOR, 0);
    c.post_intent(sign(&ska, &intent(&key(1).1, d, Side::Long, 5_000, 1)));
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
    let r = Resolution { duel_id: U64(7), open_price: U64(10_000_000_000_000), close_price: U64(10_050_000_000_000) };
    assert_eq!(resolution_message(&r).len(), 20 + 24);
}

// ---------------------------------------------------------------- task 3: vault, mandates, settle_follow

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

/// setup + duel + A posts nonce 1 + follower deposits 1000 and follows A with the given mandate.
pub fn setup_follow(m: Mandate) -> (Contract, SigningKey, u64) {
    let (mut c, oracle, ska, _) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    c.post_intent(sign(&ska, &intent(&key(1).1, d, Side::Long, 5_000, 1)));
    ctx(FOLLOWER, 1_000);
    c.deposit();
    ctx(FOLLOWER, 0);
    c.follow(Base64VecU8(key(1).1), m);
    ctx(SOLVER, 0);
    (c, oracle, d)
}

fn settle(c: &mut Contract, fills: Vec<Fill>) -> SettleReport {
    ctx(SOLVER, 0);
    c.settle_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap(), fills)
}

#[test]
fn fill_at_cap_ok_over_cap_rejected() {
    let (mut c, _, _) = setup_follow(mandate(100, 1_000, vec![]));
    let r = settle(&mut c, vec![fill(1, "usdc", 100)]);
    assert_eq!(r.settled, 1);
    assert_eq!(r.debited.0, 100);
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, 900);
    assert_eq!(c.get_vault(SOLVER.parse().unwrap()).0, 100);
}

// Separate test: unit-test storage is global per test, so a second Contract in the same test
// would see the first one's used_nonces.
#[test]
fn fill_over_cap_rejected() {
    let (mut c, _, _) = setup_follow(mandate(100, 1_000, vec![]));
    let r = settle(&mut c, vec![fill(1, "usdc", 101)]);
    assert_eq!(r.settled, 0);
    assert_eq!(r.rejected[0].1, "over cap");
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, 1_000);
}

#[test]
fn fill_wrong_token_rejected() {
    let (mut c, _, _) = setup_follow(mandate(100, 1_000, vec!["usdc"]));
    let r = settle(&mut c, vec![fill(1, "wbtc", 50)]);
    assert_eq!(r.rejected[0].1, "token not allowed");
}

#[test]
fn fill_after_expiry_rejected() {
    let (mut c, _, _) = setup_follow(mandate(100, 1_000, vec![]));
    ctx_at(SOLVER, 0, NOW + 1_000_000);
    let r = c.settle_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap(), vec![fill(1, "usdc", 50)]);
    assert_eq!(r.rejected[0].1, "mandate expired");
}

#[test]
fn fill_after_revoke_rejected() {
    let (mut c, _, _) = setup_follow(mandate(100, 1_000, vec![]));
    ctx(FOLLOWER, 0);
    c.unfollow(Base64VecU8(key(1).1));
    let r = settle(&mut c, vec![fill(1, "usdc", 50)]);
    assert_eq!(r.rejected[0].1, "mandate revoked");
}

#[test]
fn duplicate_fill_noop() {
    let (mut c, _, _) = setup_follow(mandate(100, 1_000, vec![]));
    settle(&mut c, vec![fill(1, "usdc", 50)]);
    let r = settle(&mut c, vec![fill(1, "usdc", 50)]);
    assert_eq!(r.rejected[0].1, "duplicate fill");
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, 950);
}

#[test]
fn foreign_nonce_rejected() {
    let (mut c, _, _) = setup_follow(mandate(100, 1_000, vec![]));
    let r = settle(&mut c, vec![fill(99, "usdc", 50)]);
    assert_eq!(r.rejected[0].1, "nonce unknown");
}

#[test]
#[should_panic(expected = "not solver")]
fn non_solver_cannot_settle() {
    let (mut c, _, _) = setup_follow(mandate(100, 1_000, vec![]));
    ctx(OPERATOR, 0);
    c.settle_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap(), vec![fill(1, "usdc", 50)]);
}

#[test]
fn insufficient_vault_rejected() {
    let (mut c, _, _) = setup_follow(mandate(5_000, 10_000, vec![]));
    let r = settle(&mut c, vec![fill(1, "usdc", 1_001)]);
    assert_eq!(r.rejected[0].1, "insufficient");
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, 1_000);
}

#[test]
fn allowance_exhausted_rejected() {
    let (mut c, _, d) = setup_follow(mandate(100, 150, vec![]));
    settle(&mut c, vec![fill(1, "usdc", 100)]);
    // A posts a second intent (nonce 2), then a fill against it exceeds the remaining allowance
    let (_, ska, _, _) = (0, key(1).0, 0, 0);
    ctx(SOLVER, 0);
    c.post_intent(sign(&ska, &intent(&key(1).1, d, Side::Short, 5_000, 2)));
    let r = settle(&mut c, vec![fill(2, "usdc", 60)]);
    assert_eq!(r.rejected[0].1, "allowance exhausted");
    assert_eq!(c.get_follow(Base64VecU8(key(1).1), FOLLOWER.parse().unwrap()).unwrap().spent.0, 100);
}

#[test]
fn list_followers_and_withdraw() {
    let (mut c, _, _) = setup_follow(mandate(100, 1_000, vec![]));
    assert_eq!(c.list_followers(Base64VecU8(key(1).1)).len(), 1);
    ctx(FOLLOWER, 0);
    let _ = c.withdraw(U128(400));
    assert_eq!(c.get_vault(FOLLOWER.parse().unwrap()).0, 600);
}

// ---------------------------------------------------------------- task 4: chaos and resolve

const OPEN: u64 = 10_000_000_000_000; // 8 decimals
const UP: u64 = 10_050_000_000_000;

fn res(d: u64, open: u64, close: u64) -> Resolution {
    Resolution { duel_id: U64(d), open_price: U64(open), close_price: U64(close) }
}

fn post(c: &mut Contract, sk: &SigningKey, pk: &[u8], d: u64, side: Side, nonce: u64) {
    ctx(SOLVER, 0);
    c.post_intent(sign(sk, &intent(pk, d, side, 5_000, nonce)));
}

fn inject(c: &mut Contract, d: u64, target: &[u8], deposit: u128) {
    ctx(OPERATOR, deposit);
    c.inject_chaos(U64(d), Base64VecU8(target.to_vec()), "fake_news".into(), Base64VecU8(vec![3u8; 32]));
}

fn resolve_at_close(c: &mut Contract, oracle: &SigningKey, r: Resolution) {
    ctx_at(SOLVER, 0, CLOSE);
    let sig = sign_res(oracle, &r);
    c.resolve(r, sig);
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
fn resolve_scores_25_bps_and_slashes() {
    let (mut c, oracle, ska, skb) = setup();
    let d = open(&mut c);
    post(&mut c, &ska, &key(1).1, d, Side::Long, 1);
    post(&mut c, &skb, &key(2).1, d, Side::Short, 1);
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    resolve_at_close(&mut c, &oracle, res(d, OPEN, UP));
    let a = c.get_agent(Base64VecU8(key(1).1)).unwrap();
    let b = c.get_agent(Base64VecU8(key(2).1)).unwrap();
    assert_eq!(a.alpha_bps, 25);
    assert_eq!(b.alpha_bps, -25);
    let slashed = BOND * 1_000 / 10_000;
    assert_eq!(b.bond.0, BOND - slashed);
    assert_eq!(a.bond.0, BOND + slashed + MIN_CHAOS);
    assert_eq!(a.shield, 1);
    assert_eq!(b.shield, 0);
    assert!(a.in_duel.is_none() && b.in_duel.is_none());
    let duel = c.get_duel(U64(d)).unwrap();
    assert!(duel.resolved);
    assert_eq!(duel.pool.0, 0);
}

#[test]
fn resolve_no_intent_scores_zero_and_loses() {
    let (mut c, oracle, ska, _) = setup();
    let d = open(&mut c);
    post(&mut c, &ska, &key(1).1, d, Side::Long, 1);
    resolve_at_close(&mut c, &oracle, res(d, OPEN, UP));
    let b = c.get_agent(Base64VecU8(key(2).1)).unwrap();
    assert_eq!(b.alpha_bps, 0);
    assert_eq!(b.bond.0, BOND - BOND * 1_000 / 10_000);
}

#[test]
fn resolve_tie_splits_pool_remainder_to_a() {
    let (mut c, oracle, ska, skb) = setup();
    let d = open(&mut c);
    post(&mut c, &ska, &key(1).1, d, Side::Long, 1);
    post(&mut c, &skb, &key(2).1, d, Side::Long, 1);
    inject(&mut c, d, &key(2).1, MIN_CHAOS + 1); // odd pool: 101
    resolve_at_close(&mut c, &oracle, res(d, OPEN, UP));
    let a = c.get_agent(Base64VecU8(key(1).1)).unwrap();
    let b = c.get_agent(Base64VecU8(key(2).1)).unwrap();
    assert_eq!(a.alpha_bps, 25);
    assert_eq!(b.alpha_bps, 25);
    assert_eq!(a.bond.0, BOND + 51);
    assert_eq!(b.bond.0, BOND + 50);
    assert_eq!(a.shield + b.shield, 0);
}

#[test]
fn resolve_shield_counts_injections_at_winner() {
    let (mut c, oracle, ska, skb) = setup();
    let d = open(&mut c);
    post(&mut c, &ska, &key(1).1, d, Side::Long, 1);
    post(&mut c, &skb, &key(2).1, d, Side::Short, 1);
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    inject(&mut c, d, &key(1).1, MIN_CHAOS);
    inject(&mut c, d, &key(2).1, MIN_CHAOS);
    resolve_at_close(&mut c, &oracle, res(d, OPEN, UP));
    assert_eq!(c.get_agent(Base64VecU8(key(1).1)).unwrap().shield, 2);
}

#[test]
#[should_panic(expected = "resolved")]
fn resolve_twice_panics() {
    let (mut c, oracle, ..) = setup();
    let d = open(&mut c);
    resolve_at_close(&mut c, &oracle, res(d, OPEN, UP));
    resolve_at_close(&mut c, &oracle, res(d, OPEN, UP));
}

#[test]
#[should_panic(expected = "bad signature")]
fn resolve_bad_oracle_sig() {
    let (mut c, _, ska, _) = setup();
    let d = open(&mut c);
    resolve_at_close(&mut c, &ska, res(d, OPEN, UP));
}

#[test]
#[should_panic(expected = "duel open")]
fn resolve_before_close_panics() {
    let (mut c, oracle, ..) = setup();
    let d = open(&mut c);
    ctx(SOLVER, 0);
    let r = res(d, OPEN, UP);
    let sig = sign_res(&oracle, &r);
    c.resolve(r, sig);
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
    let (mut c, oracle, ..) = setup();
    let d = open(&mut c);
    resolve_at_close(&mut c, &oracle, res(d, OPEN, UP));
    ctx(OPERATOR, 0);
    let _ = c.withdraw_bond(Base64VecU8(key(1).1), U128(BOND / 2));
    let a = c.get_agent(Base64VecU8(key(1).1)).unwrap();
    assert!(a.bond.0 < BOND); // whatever the tie rule left, half is gone
    let board = c.leaderboard();
    assert_eq!(board.len(), 2);
}
