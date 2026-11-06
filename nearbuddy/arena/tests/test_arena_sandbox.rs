//! Sandbox run of the real wasm: agents register with a key-possession signature (a squatter is
//! refused), a TEE-backed agent posts enclave-proved intents (and one tampered proof is refused),
//! a bystander relays one intent, the duel takes the maximum 32 injections, a follower follows the
//! TEE agent (the plain one is refused) and settles 10 fills, and the duel is resolved through the
//! oracle callback with the oracle account playing Outlayer.
//! Prints gas burnt per call so the README can quote it.
//!   cargo test --test test_arena_sandbox -- --ignored --nocapture
//! Ignored by default: it needs the cargo-near binary and downloads near-sandbox on first run.
use ed25519_dalek::{Signer, SigningKey};
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::base64::{Engine, prelude::BASE64_STANDARD};
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::serde_json::{Value, json};
use nearbuddy_arena::{Intent, Side, intent_message, register_bytes, tee_text};
use sha2::{Digest, Sha256};

const MODEL_A: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

fn b64(b: &[u8]) -> String {
    BASE64_STANDARD.encode(b)
}

fn gas_of(r: &near_api::types::transaction::result::ExecutionSuccess) -> u64 {
    r.outcomes()
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .sum::<u64>()
}

fn sha(a: &[u8], b: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.finalize().to_vec()
}

async fn create_subaccount(
    sandbox: &near_sandbox::Sandbox,
    name: &str,
) -> testresult::TestResult<near_api::Account> {
    let account_id: AccountId = name.parse().unwrap();
    sandbox
        .create_account(account_id.clone())
        .initial_balance(NearToken::from_near(50))
        .send()
        .await?;
    Ok(near_api::Account(account_id))
}

fn price_data(price8: u64, ts_ns: u64) -> Value {
    json!({"timestamp": ts_ns.to_string(), "recency_duration_sec": 300, "prices": [{"asset_id": "wrap.near", "price": {"multiplier": price8.to_string(), "decimals": 8}}]})
}

#[tokio::test]
#[ignore = "needs cargo-near and a near-sandbox download; run with -- --ignored"]
async fn full_duel_with_tee_proofs_max_chaos_and_oracle_callback() -> testresult::TestResult<()> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse()
            .unwrap(),
    )?;

    let solver = create_subaccount(&sandbox, "solver.sandbox").await?;
    let follower = create_subaccount(&sandbox, "follower.sandbox").await?;
    let spectator = create_subaccount(&sandbox, "spectator.sandbox").await?;
    let oracle = create_subaccount(&sandbox, "price-oracle.sandbox").await?;
    let contract = create_subaccount(&sandbox, "arena.sandbox")
        .await?
        .as_contract();

    let tee = SigningKey::from_bytes(&[7u8; 32]);
    let ska = SigningKey::from_bytes(&[1u8; 32]);
    let skb = SigningKey::from_bytes(&[2u8; 32]);
    let (pka, pkb) = (
        ska.verifying_key().to_bytes().to_vec(),
        skb.verifying_key().to_bytes().to_vec(),
    );

    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call("init", json!({
            "owner": solver.account_id(), "oracle_account": oracle.account_id(), "oracle_deposit": NearToken::from_millinear(20).as_yoctonear().to_string(),
            "slash_bps": 1000, "fee_bps": 0, "min_chaos_deposit": "100000000000000000000000",
        }))?
        .with_signer(signer.clone())
        .send_to(&net).await?.assert_success();

    let call = |method: &'static str, args: Value, who: &near_api::Account, deposit: NearToken| {
        contract
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(300))
            .deposit(deposit)
            .with_signer(who.account_id().clone(), signer.clone())
            .send_to(&net)
    };
    let zero = NearToken::from_yoctonear(0);

    call(
        "add_solver",
        json!({"account_id": solver.account_id()}),
        &solver,
        zero,
    )
    .await?
    .assert_success();
    // 60 s duel floor, 30 s intent lock: the duel below is 120 s, intents must land in its first 90 s
    call("set_oracle", json!({"oracle_account": oracle.account_id(), "oracle_deposit": NearToken::from_millinear(20).as_yoctonear().to_string(), "min_duel_s": 60, "intent_lock_s": 30}), &solver, zero).await?.assert_success();
    call(
        "add_tee_signer",
        json!({"signer": b64(&tee.verifying_key().to_bytes()), "label": "sandbox enclave"}),
        &solver,
        zero,
    )
    .await?
    .assert_success();
    // a squatter who knows A's public key but not its secret cannot register it
    let squat_sig = skb
        .sign(&register_bytes(spectator.account_id()))
        .to_bytes()
        .to_vec();
    call("register_agent", json!({"agent_pk": b64(&pka), "model_id": MODEL_A, "tee": false, "register_sig": b64(&squat_sig)}), &spectator, NearToken::from_near(1)).await?.assert_failure();
    println!("register_agent without the agent key's signature: refused");
    for (sk, pk, model, is_tee) in [
        (&ska, &pka, MODEL_A, true),
        (&skb, &pkb, "Qwen/Qwen3.8-27B", false),
    ] {
        let sig = sk
            .sign(&register_bytes(solver.account_id()))
            .to_bytes()
            .to_vec();
        let r = call("register_agent", json!({"agent_pk": b64(pk), "model_id": model, "tee": is_tee, "register_sig": b64(&sig)}), &solver, NearToken::from_near(1)).await?.assert_success();
        println!(
            "GAS register_agent (signed) {:.2} TGas",
            gas_of(&r) as f64 / 1e12
        );
    }
    let bond_a0: u128 = contract
        .call_function("get_agent", json!({"agent_pk": b64(&pka)}))
        .read_only::<Value>()
        .fetch_from(&net)
        .await?
        .data["bond"]
        .as_str()
        .unwrap()
        .parse()?;
    assert!(
        bond_a0 < NearToken::from_near(1).as_yoctonear(),
        "registration storage is paid from the bond"
    );

    // close in 120 s; the fast_forward loop below jumps past it
    let block = near_api::Chain::block()
        .at(near_api::types::Reference::Final)
        .fetch_from(&net)
        .await?;
    let now: u64 = block.header.timestamp;
    let close_at = now + 120_000_000_000;
    let r = call("open_duel", json!({"a": b64(&pka), "b": b64(&pkb), "symbol": "wrap.near", "close_at": close_at.to_string()}), &solver, NearToken::from_millinear(50)).await?.assert_success();
    println!(
        "GAS open_duel (incl. oracle_call to a missing contract) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    let duel_id: u64 = r.json::<U64>()?.0;
    // the oracle account plays Outlayer: deliver the open price
    let r = call("oracle_on_call", json!({"sender_id": contract.account_id(), "data": price_data(366_000_000, now), "msg": format!("open:{duel_id}")}), &oracle, zero).await?.assert_success();
    println!(
        "GAS oracle_on_call (open) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );

    // A: TEE-proved intents. req/res hashes stand in for sha256 of the real request/response bytes.
    let mk_a = |nonce: u64, side: Side, req: [u8; 32], res: [u8; 32], tamper: bool| {
        let i = Intent {
            agent_pk: Base64VecU8(pka.clone()),
            duel_id: U64(duel_id),
            side,
            size_bps: 5_000,
            nonce: U64(nonce),
            expires_at: U64(close_at),
            proof_hash: Base64VecU8(sha(&req, &res)),
        };
        let sig = ska.sign(&intent_message(&i)).to_bytes().to_vec();
        let mut text = tee_text(2, MODEL_A, &req, &res);
        if tamper {
            let last = text.len() - 1;
            text[last] ^= 1; // enclave signed a different response
        }
        let tee_sig = tee.sign(&text).to_bytes().to_vec();
        json!({"signed": {"intent": i, "signature": b64(&sig)}, "tee": {"kind": 2, "request_hash": b64(&req), "response_hash": b64(&res), "signer": b64(&tee.verifying_key().to_bytes()), "signature": b64(&tee_sig)}})
    };
    let mk_b = |nonce: u64, side: Side| {
        let i = Intent {
            agent_pk: Base64VecU8(pkb.clone()),
            duel_id: U64(duel_id),
            side,
            size_bps: 5_000,
            nonce: U64(nonce),
            expires_at: U64(close_at),
            proof_hash: Base64VecU8(vec![0u8; 32]),
        };
        let sig = skb.sign(&intent_message(&i)).to_bytes().to_vec();
        json!({"signed": {"intent": i, "signature": b64(&sig)}, "tee": null})
    };
    let r = call(
        "post_intent",
        mk_a(1, Side::Long, [0xaa; 32], [0xbb; 32], false),
        &solver,
        zero,
    )
    .await?
    .assert_success();
    println!(
        "GAS post_intent (TEE verified) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    call(
        "post_intent",
        mk_a(2, Side::Long, [0xaa; 32], [0xcc; 32], true),
        &solver,
        zero,
    )
    .await?
    .assert_failure();
    println!("post_intent with a tampered enclave signature: refused");
    call(
        "post_intent",
        mk_a(2, Side::Short, [0xaa; 32], [0xbb; 32], false),
        &solver,
        zero,
    )
    .await?
    .assert_failure();
    println!("post_intent reusing an already-used enclave proof: refused");
    let r = call("post_intent", mk_b(1, Side::Short), &solver, zero)
        .await?
        .assert_success();
    println!(
        "GAS post_intent (plain) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    let bond_a1: u128 = contract
        .call_function("get_agent", json!({"agent_pk": b64(&pka)}))
        .read_only::<Value>()
        .fetch_from(&net)
        .await?
        .data["bond"]
        .as_str()
        .unwrap()
        .parse()?;
    assert!(bond_a1 < bond_a0, "intent storage is paid from the bond");

    // 32 injections at A (the cap), then the 33rd must fail
    let mut last_gas = 0;
    for k in 0..32u8 {
        let r = call("inject_chaos", json!({"duel_id": duel_id.to_string(), "target": b64(&pka), "kind": "fake_news", "payload_hash": b64(&[k; 32])}), &spectator, NearToken::from_millinear(100)).await?.assert_success();
        last_gas = gas_of(&r);
    }
    println!("GAS inject_chaos (32nd) {:.2} TGas", last_gas as f64 / 1e12);
    call("inject_chaos", json!({"duel_id": duel_id.to_string(), "target": b64(&pka), "kind": "fake_news", "payload_hash": b64(&[99u8; 32])}), &spectator, NearToken::from_millinear(100)).await?.assert_failure();

    // follower deposits and follows A; settle 10 fills against 10 distinct intents
    call("deposit", json!({}), &follower, NearToken::from_near(5))
        .await?
        .assert_success();
    let mandate = json!({"allowance": NearToken::from_near(5).as_yoctonear().to_string(), "spent": "0", "per_tx_cap": NearToken::from_millinear(200).as_yoctonear().to_string(), "allowed_tokens": [], "expires_at": (close_at + 10_000_000_000_000).to_string(), "revoked": false});
    call(
        "follow",
        json!({"agent_pk": b64(&pkb), "mandate": mandate}),
        &follower,
        zero,
    )
    .await?
    .assert_failure();
    println!("follow on an agent without TEE proofs: refused");
    let r = call(
        "follow",
        json!({"agent_pk": b64(&pka), "mandate": mandate}),
        &follower,
        zero,
    )
    .await?
    .assert_success();
    println!(
        "GAS follow (TEE agent) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    let duels: Vec<U64> = contract
        .call_function(
            "agent_duels",
            json!({"agent_pk": b64(&pka), "from": 0, "limit": 10}),
        )
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(duels, vec![U64(duel_id)], "per-agent duel index");
    for n in 3..=10u64 {
        call(
            "post_intent",
            mk_a(n, Side::Long, [n as u8; 32], [0xbb; 32], false),
            &solver,
            zero,
        )
        .await?
        .assert_success();
    }
    let r = call(
        "post_intent",
        mk_a(11, Side::Long, [11u8; 32], [0xbb; 32], false),
        &spectator,
        zero,
    )
    .await?
    .assert_success();
    println!(
        "GAS post_intent (relayed by a non-solver) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    let fills: Vec<Value> = [1u64].iter().chain((3..=11u64).collect::<Vec<_>>().iter()).map(|n| json!({"intent_nonce": n.to_string(), "token": "nep141:wrap.near", "amount_in": NearToken::from_millinear(100).as_yoctonear().to_string(), "amount_out": "1", "swap_tx": format!("sim-{n}")})).collect();
    let r = call(
        "settle_follow",
        json!({"agent_pk": b64(&pka), "follower": follower.account_id(), "fills": fills}),
        &solver,
        zero,
    )
    .await?
    .assert_success();
    println!("GAS settle_follow x10 {:.2} TGas", gas_of(&r) as f64 / 1e12);
    let vault: U128 = contract
        .call_function("get_vault", json!({"account": follower.account_id()}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    let settled = NearToken::from_near(5).as_yoctonear() - vault.0;
    assert!(
        settled >= NearToken::from_near(1).as_yoctonear()
            && settled
                < NearToken::from_near(1).as_yoctonear()
                    + NearToken::from_millinear(10).as_yoctonear(),
        "1 NEAR settled plus storage, got {settled}"
    );

    // past close_at: resolve_duel asks the oracle; the oracle delivers the close price and the duel
    // finishes. A (Long) wins on a 0.5% rise and survives 32 injections.
    // fast-forwarded blocks carry short timestamps: skip ahead until the chain clock passes close_at
    for _ in 0..40 {
        let ts = near_api::Chain::block()
            .at(near_api::types::Reference::Final)
            .fetch_from(&net)
            .await?
            .header
            .timestamp;
        if ts >= close_at {
            break;
        }
        sandbox.fast_forward(200).await?;
    }
    let r = call(
        "resolve_duel",
        json!({"duel_id": duel_id.to_string()}),
        &spectator,
        NearToken::from_millinear(20),
    )
    .await?
    .assert_success();
    println!(
        "GAS resolve_duel (permissionless, oracle_call) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    let block = near_api::Chain::block()
        .at(near_api::types::Reference::Final)
        .fetch_from(&net)
        .await?;
    let r = call("oracle_on_call", json!({"sender_id": contract.account_id(), "data": price_data(367_830_000, block.header.timestamp), "msg": format!("close:{duel_id}")}), &oracle, zero).await?.assert_success();
    println!(
        "GAS oracle_on_call (close, 32 injections scored) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    let a: Value = contract
        .call_function("get_agent", json!({"agent_pk": b64(&pka)}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(a["alpha_bps"], 25);
    assert_eq!(a["shield"], 32);
    assert_eq!(a["tee"], true);
    let duel: Value = contract
        .call_function("get_duel", json!({"duel_id": duel_id.to_string()}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(duel["outcome"]["pnl_b"], -25);
    assert_eq!(duel["outcome"]["injections"], 32);
    assert_eq!(
        duel["injections"].as_array().unwrap().len(),
        0,
        "injections pruned"
    );
    assert_eq!(duel["outcome"]["winner"], Value::String(b64(&pka)));
    Ok(())
}
