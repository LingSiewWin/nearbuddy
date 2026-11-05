//! Sandbox run of the real wasm: a full duel with the maximum 32 injections, an oracle-signed
//! resolve, and a 10-fill settle_follow. Prints gas burnt per call so the README can quote it.
//!   cargo test --test test_arena_sandbox -- --nocapture
use ed25519_dalek::{Signer, SigningKey};
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::base64::{prelude::BASE64_STANDARD, Engine};
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::serde_json::{json, Value};
use nearbuddy_arena::{intent_message, resolution_message, Intent, Resolution, Side};

fn b64(b: &[u8]) -> String {
    BASE64_STANDARD.encode(b)
}

fn gas_of(r: &near_api::types::transaction::result::ExecutionSuccess) -> u64 {
    r.outcomes().iter().map(|o| o.gas_burnt.as_gas()).sum::<u64>()
}

async fn create_subaccount(sandbox: &near_sandbox::Sandbox, name: &str) -> testresult::TestResult<near_api::Account> {
    let account_id: AccountId = name.parse().unwrap();
    sandbox.create_account(account_id.clone()).initial_balance(NearToken::from_near(50)).send().await?;
    Ok(near_api::Account(account_id))
}

#[tokio::test]
async fn full_duel_with_max_chaos_and_settlement() -> testresult::TestResult<()> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap())?;

    let solver = create_subaccount(&sandbox, "solver.sandbox").await?;
    let follower = create_subaccount(&sandbox, "follower.sandbox").await?;
    let spectator = create_subaccount(&sandbox, "spectator.sandbox").await?;
    let contract = create_subaccount(&sandbox, "arena.sandbox").await?.as_contract();

    let oracle = SigningKey::from_bytes(&[9u8; 32]);
    let ska = SigningKey::from_bytes(&[1u8; 32]);
    let skb = SigningKey::from_bytes(&[2u8; 32]);
    let (pka, pkb) = (ska.verifying_key().to_bytes().to_vec(), skb.verifying_key().to_bytes().to_vec());

    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call("init", json!({
            "owner": solver.account_id(), "oracle_pk": b64(&oracle.verifying_key().to_bytes()),
            "slash_bps": 1000, "fee_bps": 0, "min_chaos_deposit": "100000000000000000000000",
        }))?
        .with_signer(signer.clone())
        .send_to(&net).await?.assert_success();

    let call = |method: &'static str, args: Value, who: &near_api::Account, deposit: NearToken| {
        contract.call_function(method, args).transaction().gas(NearGas::from_tgas(300)).deposit(deposit)
            .with_signer(who.account_id().clone(), signer.clone()).send_to(&net)
    };

    call("add_solver", json!({"account_id": solver.account_id()}), &solver, NearToken::from_yoctonear(0)).await?.assert_success();
    for (pk, model) in [(&pka, "model-a"), (&pkb, "model-b")] {
        call("register_agent", json!({"agent_pk": b64(pk), "model_id": model}), &solver, NearToken::from_near(1)).await?.assert_success();
    }

    // close in ~40 blocks (sandbox blocks are ~1 s; fast_forward below jumps past it)
    let head: Value = reqwest_block(&sandbox).await?;
    let now = head["result"]["header"]["timestamp"].as_u64().unwrap();
    let close_at = now + 40_000_000_000;
    let r = call("open_duel", json!({"a": b64(&pka), "b": b64(&pkb), "symbol": "BTC/USD", "close_at": close_at.to_string()}), &solver, NearToken::from_yoctonear(0)).await?.assert_success();
    println!("GAS open_duel {:.2} TGas", gas_of(&r) as f64 / 1e12);
    let duel_id: u64 = 0;

    let mk = |sk: &SigningKey, pk: &[u8], side: Side, nonce: u64| {
        let i = Intent { agent_pk: Base64VecU8(pk.to_vec()), duel_id: U64(duel_id), side, size_bps: 5_000, nonce: U64(nonce), expires_at: U64(close_at), proof_hash: Base64VecU8(vec![0u8; 32]) };
        let sig = sk.sign(&intent_message(&i)).to_bytes().to_vec();
        json!({"signed": {"intent": i, "signature": b64(&sig)}})
    };
    let r = call("post_intent", mk(&ska, &pka, Side::Long, 1), &solver, NearToken::from_yoctonear(0)).await?.assert_success();
    println!("GAS post_intent {:.2} TGas", gas_of(&r) as f64 / 1e12);
    call("post_intent", mk(&skb, &pkb, Side::Short, 1), &solver, NearToken::from_yoctonear(0)).await?.assert_success();

    // 32 injections at A (the cap), then the 33rd must fail
    let mut last_gas = 0;
    for k in 0..32u8 {
        let r = call("inject_chaos", json!({"duel_id": duel_id.to_string(), "target": b64(&pka), "kind": "fake_news", "payload_hash": b64(&[k; 32])}), &spectator, NearToken::from_millinear(100)).await?.assert_success();
        last_gas = gas_of(&r);
    }
    println!("GAS inject_chaos (32nd) {:.2} TGas", last_gas as f64 / 1e12);
    call("inject_chaos", json!({"duel_id": duel_id.to_string(), "target": b64(&pka), "kind": "fake_news", "payload_hash": b64(&[99u8; 32])}), &spectator, NearToken::from_millinear(100)).await?.assert_failure();

    // follower deposits and follows A; settle 10 fills against nonce 1... needs 10 distinct intents
    call("deposit", json!({}), &follower, NearToken::from_near(5)).await?.assert_success();
    call("follow", json!({"agent_pk": b64(&pka), "mandate": {"allowance": NearToken::from_near(5).as_yoctonear().to_string(), "spent": "0", "per_tx_cap": NearToken::from_millinear(200).as_yoctonear().to_string(), "allowed_tokens": [], "expires_at": (close_at + 10_000_000_000_000).to_string(), "revoked": false}}), &follower, NearToken::from_yoctonear(0)).await?.assert_success();
    for n in 2..=10u64 {
        call("post_intent", mk(&ska, &pka, Side::Long, n), &solver, NearToken::from_yoctonear(0)).await?.assert_success();
    }
    let fills: Vec<Value> = (1..=10u64).map(|n| json!({"intent_nonce": n.to_string(), "token": "nep141:wrap.near", "amount_in": NearToken::from_millinear(100).as_yoctonear().to_string(), "amount_out": "1", "swap_tx": format!("sim-{n}")})).collect();
    let r = call("settle_follow", json!({"agent_pk": b64(&pka), "follower": follower.account_id(), "fills": fills}), &solver, NearToken::from_yoctonear(0)).await?.assert_success();
    println!("GAS settle_follow x10 {:.2} TGas", gas_of(&r) as f64 / 1e12);
    let vault: U128 = contract.call_function("get_vault", json!({"account": follower.account_id()})).read_only().fetch_from(&net).await?.data;
    assert_eq!(vault.0, NearToken::from_near(4).as_yoctonear());

    // past close_at: resolve with the oracle key; A (Long) wins on a 0.5% rise, survives 32 injections
    sandbox.fast_forward(60).await?;
    let res = Resolution { duel_id: U64(duel_id), open_price: U64(10_000_000_000_000), close_price: U64(10_050_000_000_000) };
    let sig = oracle.sign(&resolution_message(&res)).to_bytes().to_vec();
    let r = call("resolve", json!({"resolution": res, "oracle_sig": b64(&sig)}), &solver, NearToken::from_yoctonear(0)).await?.assert_success();
    println!("GAS resolve (32 injections) {:.2} TGas", gas_of(&r) as f64 / 1e12);
    let a: Value = contract.call_function("get_agent", json!({"agent_pk": b64(&pka)})).read_only().fetch_from(&net).await?.data;
    assert_eq!(a["alpha_bps"], 25);
    assert_eq!(a["shield"], 32);
    let duel: Value = contract.call_function("get_duel", json!({"duel_id": duel_id.to_string()})).read_only().fetch_from(&net).await?.data;
    assert_eq!(duel["outcome"]["pnl_b"], -25);
    assert_eq!(duel["outcome"]["winner"], Value::String(b64(&pka)));
    Ok(())
}

/// Latest block header through the sandbox RPC (near-api has no block view in this version's public API).
async fn reqwest_block(sandbox: &near_sandbox::Sandbox) -> testresult::TestResult<Value> {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "block", "params": {"finality": "final"}});
    let out = std::process::Command::new("curl")
        .args(["-s", "-H", "content-type: application/json", "-d", &body.to_string(), &sandbox.rpc_addr])
        .output()?;
    Ok(near_sdk::serde_json::from_slice(&out.stdout)?)
}
