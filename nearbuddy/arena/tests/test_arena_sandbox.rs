//! Sandbox run of the real wasm: agents register with a key-possession signature (a squatter is
//! refused), a TEE-backed agent posts enclave-proved intents (and one tampered proof is refused),
//! a bystander relays one intent, the plain agent commits a hidden intent and a bystander reveals it,
//! the duel takes the maximum 32 injections (31 planted headlines at a rising price and one placebo),
//! A's next enclave-proved reveal decides all 32 (the headlines flipped it, the placebo is no trial)
//! and the spectator claims its payouts after the finish, a follower follows the TEE agent (the plain one is
//! refused) and settles 10 fills against the intents stub (refused before the outputs land and for a
//! fill with no output; then 4 units go back out through `withdraw_token`; `withdraw` inside the
//! delay is refused), the duel is resolved through the oracle callback with the oracle
//! account playing Outlayer, and a second duel is opened by a bystander with both agents' consent
//! signatures (one with a mismatched signature is refused). A second run fills one duel with 32
//! headlines of 280 bytes from one injector, which deletes its account right after its claim: the
//! payout bounces and `on_claim_chaos` makes all 32 claimable again.
//! Prints gas burnt per call so the README can quote it.
//!   cargo test --test test_arena_sandbox -- --ignored --nocapture
//! Ignored by default: it needs the cargo-near binary and downloads near-sandbox on first run.
use ed25519_dalek::{Signer, SigningKey};
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::base64::{Engine, prelude::BASE64_STANDARD};
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::serde_json::{Value, json};
use nearbuddy_arena::{
    Intent, Side, commit_bytes, commit_bytes_v2, consent_bytes, intent_message, register_bytes,
    tee_text,
};
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

/// Gas per receipt (contract, view on the intents stub, callback, refunds).
fn gas_lines(label: &str, r: &near_api::types::transaction::result::ExecutionSuccess) {
    println!("GAS {label} {:.2} TGas", gas_of(r) as f64 / 1e12);
    for o in r.outcomes() {
        println!(
            "      {:<24} {:.2} TGas",
            o.executor_id.to_string(),
            o.gas_burnt.as_gas() as f64 / 1e12
        );
    }
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
    // the testnet stand-in for intents.near: mt_batch_balance_of, mt_transfer, stub_credit
    let stub_path = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
        manifest_path: Some(
            format!("{}/../intents-stub/Cargo.toml", env!("CARGO_MANIFEST_DIR")).into(),
        ),
        ..Default::default()
    })?;
    let stub_wasm = std::fs::read(stub_path)?;
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
    let intents = create_subaccount(&sandbox, "intents.sandbox").await?;
    near_api::Contract::deploy(intents.account_id().clone())
        .use_code(stub_wasm)
        .without_init_call()
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    // only minters the stub account adds may stub_credit: the solver, whose swaps land there
    near_api::Contract(intents.account_id().clone())
        .call_function("add_minter", json!({"account_id": solver.account_id()}))
        .transaction()
        .with_signer(intents.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
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
            "intents_account": intents.account_id(), "max_vault_total": NearToken::from_near(1000).as_yoctonear().to_string(),
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
    let one = NearToken::from_yoctonear(1);

    call(
        "add_solver",
        json!({"account_id": solver.account_id()}),
        &solver,
        one,
    )
    .await?
    .assert_success();
    // 60 s duel floor, 30 s intent lock: the duel below is 120 s, intents must land in its first 90 s
    call("set_oracle", json!({"oracle_account": oracle.account_id(), "oracle_deposit": NearToken::from_millinear(20).as_yoctonear().to_string(), "min_duel_s": 60, "intent_lock_s": 30}), &solver, one).await?.assert_success();
    // deploy-17 chaos terms: 0.1 NEAR rising 1.25x per injection up to 0.5 NEAR, 5 % fee, half the
    // loser's slash to the injections that flipped it
    call("set_chaos_config", json!({"chaos": {"base": NearToken::from_millinear(100).as_yoctonear().to_string(), "r_bps": 12_500, "cap": NearToken::from_millinear(500).as_yoctonear().to_string(), "fee_bps": 500, "share_bps": 5_000}}), &solver, one).await?.assert_success();
    call(
        "add_tee_signer",
        json!({"signer": b64(&tee.verifying_key().to_bytes()), "label": "sandbox enclave"}),
        &solver,
        one,
    )
    .await?
    .assert_success();
    // a squatter who knows A's public key but not its secret cannot register it
    let squat_sig = skb
        .sign(&register_bytes(
            contract.account_id(),
            spectator.account_id(),
        ))
        .to_bytes()
        .to_vec();
    call("register_agent", json!({"agent_pk": b64(&pka), "model_id": MODEL_A, "tee": false, "register_sig": b64(&squat_sig)}), &spectator, NearToken::from_near(1)).await?.assert_failure();
    println!("register_agent without the agent key's signature: refused");
    for (sk, pk, model, is_tee) in [
        (&ska, &pka, MODEL_A, true),
        (&skb, &pkb, "Qwen/Qwen3.8-27B", false),
    ] {
        let sig = sk
            .sign(&register_bytes(contract.account_id(), solver.account_id()))
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

    // commit-reveal: B hides nonce 2 behind sha256(intent_message || salt), signing the bytes the
    // commit_message view returns (message v2, `seen` = 0 chaos records); a bystander relays both
    // halves
    let i2 = Intent {
        agent_pk: Base64VecU8(pkb.clone()),
        duel_id: U64(duel_id),
        side: Side::Short,
        size_bps: 5_000,
        nonce: U64(2),
        expires_at: U64(close_at),
        proof_hash: Base64VecU8(vec![0u8; 32]),
    };
    let salt = [0x5au8; 32];
    let commitment = sha(&intent_message(&i2), &salt);
    let msg: Base64VecU8 = contract
        .call_function(
            "commit_message",
            json!({"duel_id": duel_id.to_string(), "commitment": b64(&commitment)}),
        )
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(
        msg.0,
        commit_bytes(contract.account_id(), duel_id, &commitment)
    );
    let version: u32 = contract
        .call_function("commit_message_version", json!({}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(version, 2, "deploy 17.1 takes `seen`");
    let msg: Base64VecU8 = contract
        .call_function(
            "commit_message",
            json!({"duel_id": duel_id.to_string(), "commitment": b64(&commitment), "seen": 0}),
        )
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(
        msg.0,
        commit_bytes_v2(contract.account_id(), duel_id, 0, &commitment)
    );
    let csig = skb.sign(&msg.0).to_bytes().to_vec();
    let r = call("commit_intent", json!({"duel_id": duel_id.to_string(), "agent_pk": b64(&pkb), "commitment": b64(&commitment), "sig": b64(&csig), "seen": 0}), &spectator, zero).await?.assert_success();
    println!("GAS commit_intent {:.2} TGas", gas_of(&r) as f64 / 1e12);
    let isig = skb.sign(&intent_message(&i2)).to_bytes().to_vec();
    let reveal = json!({"signed": {"intent": i2, "signature": b64(&isig)}, "salt": b64(&[0x5bu8; 32]), "tee": null});
    call("reveal_intent", reveal, &spectator, zero)
        .await?
        .assert_failure();
    println!("reveal_intent with the wrong salt: refused");
    let reveal =
        json!({"signed": {"intent": i2, "signature": b64(&isig)}, "salt": b64(&salt), "tee": null});
    let r = call("reveal_intent", reveal, &spectator, zero)
        .await?
        .assert_success();
    println!(
        "GAS reveal_intent (plain) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    let duel: Value = contract
        .call_function("get_duel", json!({"duel_id": duel_id.to_string()}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(
        duel["last_intent_b"]["nonce"], "2",
        "revealed intent is live"
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

    // 31 headlines at A at the rising price, one placebo by the owner (the cap is 32), then the 33rd
    // must fail
    let fee = |net: near_api::NetworkConfig| {
        let c = contract.clone();
        async move {
            c.call_function("chaos_fee", json!({"duel_id": duel_id.to_string()}))
                .read_only::<U128>()
                .fetch_from(&net)
                .await
                .map(|r| r.data.0)
        }
    };
    let (mut last_gas, mut paid) = (0, 0u128);
    for k in 0..31u8 {
        let f = fee(net.clone()).await?;
        if k == 0 {
            let under = NearToken::from_yoctonear(f - 1);
            call("inject_chaos", json!({"duel_id": duel_id.to_string(), "target": b64(&pka), "kind": "Short", "headline": "BREAKING: Reuters says NEAR halts withdrawals"}), &spectator, under).await?.assert_failure();
            println!("inject_chaos one yocto under chaos_fee: refused");
        }
        let headline = format!("BREAKING: Reuters says NEAR halts withdrawals ({k})");
        let r = call("inject_chaos", json!({"duel_id": duel_id.to_string(), "target": b64(&pka), "kind": "Short", "headline": headline}), &spectator, NearToken::from_yoctonear(f)).await?.assert_success();
        assert_eq!(r.json::<u32>()?, k as u32);
        (last_gas, paid) = (gas_of(&r), paid + f);
    }
    println!(
        "GAS inject_chaos (31st; next fee {:.3} NEAR) {:.2} TGas; 31 headlines cost {:.3} NEAR",
        fee(net.clone()).await? as f64 / 1e24,
        last_gas as f64 / 1e12,
        paid as f64 / 1e24
    );
    call("inject_chaos", json!({"duel_id": duel_id.to_string(), "target": b64(&pka), "kind": "Placebo", "headline": "Markets open as usual"}), &solver, NearToken::from_millinear(10)).await?.assert_success();
    call("inject_chaos", json!({"duel_id": duel_id.to_string(), "target": b64(&pka), "kind": "Short", "headline": "one more"}), &spectator, NearToken::from_near(1)).await?.assert_failure();
    println!("inject_chaos past 32: refused");

    // A's next decision, committed after every injection and revealed with its enclave proof: Short,
    // the side the headlines pushed. One reveal decides all 32.
    let i_a2 = Intent {
        agent_pk: Base64VecU8(pka.clone()),
        duel_id: U64(duel_id),
        side: Side::Short,
        size_bps: 5_000,
        nonce: U64(2),
        expires_at: U64(close_at),
        proof_hash: Base64VecU8(sha(&[0x22; 32], &[0x22; 32])),
    };
    let salt_a = [0x6au8; 32];
    let c_a = sha(&intent_message(&i_a2), &salt_a);
    let csig_a = ska
        .sign(&commit_bytes(contract.account_id(), duel_id, &c_a))
        .to_bytes()
        .to_vec();
    call("commit_intent", json!({"duel_id": duel_id.to_string(), "agent_pk": b64(&pka), "commitment": b64(&c_a), "sig": b64(&csig_a)}), &solver, zero).await?.assert_success();
    let isig_a = ska.sign(&intent_message(&i_a2)).to_bytes().to_vec();
    let tsig_a = tee
        .sign(&tee_text(2, MODEL_A, &[0x22; 32], &[0x22; 32]))
        .to_bytes()
        .to_vec();
    let r = call("reveal_intent", json!({"signed": {"intent": i_a2, "signature": b64(&isig_a)}, "salt": b64(&salt_a), "tee": {"kind": 2, "request_hash": b64(&[0x22; 32]), "response_hash": b64(&[0x22; 32]), "signer": b64(&tee.verifying_key().to_bytes()), "signature": b64(&tsig_a)}}), &solver, zero).await?.assert_success();
    println!(
        "GAS reveal_intent (TEE, decides 32 headlines) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    let chaos: Vec<Value> = contract
        .call_function("get_chaos", json!({"duel_id": duel_id.to_string()}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(chaos.len(), 32);
    for c in &chaos[..31] {
        assert_eq!(
            (&c["outcome"], &c["prev"], &c["next"], &c["decided_by"]),
            (
                &json!("Flipped"),
                &json!("Long"),
                &json!("Short"),
                &json!("2")
            )
        );
        assert!(c["arm"] == "Cue" || c["arm"] == "Clean");
    }
    assert_eq!(
        (
            &chaos[31]["outcome"],
            &chaos[31]["arm"],
            &chaos[31]["stake"]
        ),
        (&json!("NoTrial"), &json!("Placebo"), &json!("0"))
    );
    let stakes: u128 = chaos[..31]
        .iter()
        .map(|c| c["stake"].as_str().unwrap().parse::<u128>().unwrap())
        .sum();

    // follower deposits and follows A; settle 10 fills against 10 distinct intents
    call("deposit", json!({}), &follower, NearToken::from_near(5))
        .await?
        .assert_success();
    let mandate = json!({"allowance": NearToken::from_near(5).as_yoctonear().to_string(), "spent": "0", "per_tx_cap": NearToken::from_millinear(200).as_yoctonear().to_string(), "allowed_tokens": [], "expires_at": (close_at + 10_000_000_000_000).to_string(), "revoked": false, "min_out_per_near": "1"});
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
    // nonce 12 backs the receipt-less fill below; posted now, well before the intent lock
    call(
        "post_intent",
        mk_a(12, Side::Long, [12u8; 32], [0xbb; 32], false),
        &solver,
        zero,
    )
    .await?
    .assert_success();
    // nonce 1 predates the follow, so it never settles for this follower (deploy 16); 13 replaces it
    call(
        "post_intent",
        mk_a(13, Side::Long, [13u8; 32], [0xbb; 32], false),
        &solver,
        zero,
    )
    .await?
    .assert_success();
    const TOKEN: &str = "nep141:wrap.near";
    let stub_view = |who: &AccountId| {
        near_api::Contract(intents.account_id().clone())
            .call_function(
                "mt_balance_of",
                json!({"account_id": who, "token_id": TOKEN}),
            )
            .read_only::<U128>()
            .fetch_from(&net)
    };
    let fills: Vec<Value> = [13u64].iter().chain((3..=11u64).collect::<Vec<_>>().iter()).map(|n| json!({"intent_nonce": n.to_string(), "token": TOKEN, "amount_in": NearToken::from_millinear(100).as_yoctonear().to_string(), "amount_out": "1", "swap_tx": format!("sim-{n}")})).collect();
    // the solver settles before the outputs landed: refused, nothing moves
    call(
        "settle_follow",
        json!({"agent_pk": b64(&pka), "follower": follower.account_id(), "fills": fills}),
        &solver,
        zero,
    )
    .await?
    .assert_failure();
    println!("settle_follow x10 before the outputs landed: refused (no receipt)");
    // the ten swaps deliver one unit each to the arena's intents balance (the stub's stand-in)
    let r = near_api::Contract(intents.account_id().clone())
        .call_function(
            "stub_credit",
            json!({"receiver_id": contract.account_id(), "token_id": TOKEN, "amount": "10"}),
        )
        .transaction()
        .with_signer(solver.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    gas_lines("stub_credit (the swap landing)", &r);
    let r = call(
        "settle_follow",
        json!({"agent_pk": b64(&pka), "follower": follower.account_id(), "fills": fills}),
        &solver,
        zero,
    )
    .await?
    .assert_success();
    gas_lines("settle_follow x10 (view + on_settle_follow)", &r);
    let report: Value = r.json()?;
    assert_eq!(report["settled"], 10, "{report}");
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
    // a fill whose output never landed: the solver claims nonce 12 with nothing behind it
    let r = call(
        "settle_follow",
        json!({"agent_pk": b64(&pka), "follower": follower.account_id(), "fills": [{"intent_nonce": "12", "token": TOKEN, "amount_in": "1", "amount_out": "1", "swap_tx": "sim-12"}]}),
        &solver,
        zero,
    )
    .await?;
    let failure = format!("{:?}", r.assert_failure());
    assert!(failure.contains("no receipt"), "{failure}");
    println!("settle_follow without a receipt: refused (no receipt)");
    call(
        "settle_follow",
        json!({"agent_pk": b64(&pka), "follower": follower.account_id(), "fills": [{"intent_nonce": "12", "token": TOKEN, "amount_in": "1", "amount_out": "1", "swap_tx": "dry-quote:1"}]}),
        &solver,
        zero,
    )
    .await?
    .assert_failure();
    println!("settle_follow with a dry-quote swap_tx: refused");
    // the solver cannot call the callback itself with a made-up balance
    call(
        "on_settle_follow",
        json!({"agent_pk": b64(&pka), "follower": follower.account_id(), "solver": solver.account_id(), "fills": [{"intent_nonce": "12", "token": TOKEN, "amount_in": "1", "amount_out": "1", "swap_tx": "sim-12"}], "seq": 0}),
        &solver,
        zero,
    )
    .await?
    .assert_failure();
    println!("on_settle_follow called directly: refused (private)");
    // the follower takes 4 of the 10 credited units to their own intents account
    let r = call(
        "withdraw_token",
        json!({"token_id": TOKEN, "amount": "4"}),
        &follower,
        one,
    )
    .await?
    .assert_success();
    gas_lines(
        "withdraw_token (mt_transfer 1 yocto + on_withdraw_token)",
        &r,
    );
    assert_eq!(stub_view(follower.account_id()).await?.data.0, 4);
    assert_eq!(stub_view(contract.account_id()).await?.data.0, 6);
    let holding: U128 = contract
        .call_function(
            "get_holding",
            json!({"follower": follower.account_id(), "token_id": TOKEN}),
        )
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(holding.0, 6);
    // the vault waits withdraw_delay_s (900 s by default)
    call(
        "request_withdraw",
        json!({"amount": NearToken::from_near(1).as_yoctonear().to_string()}),
        &follower,
        one,
    )
    .await?
    .assert_success();
    let r = call("withdraw", json!({}), &follower, one).await?;
    let failure = format!("{:?}", r.assert_failure());
    assert!(
        failure.contains("withdrawal delay not elapsed"),
        "{failure}"
    );
    println!("withdraw inside the delay: refused (withdrawal delay not elapsed)");
    // an outsider cannot fake a delivery on the stub (red team S1)
    let r = near_api::Contract(intents.account_id().clone())
        .call_function(
            "stub_credit",
            json!({"receiver_id": contract.account_id(), "token_id": TOKEN, "amount": "5"}),
        )
        .transaction()
        .with_signer(spectator.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?;
    let failure = format!("{:?}", r.assert_failure());
    assert!(failure.contains("not minter"), "{failure}");
    println!("stub_credit by an outsider: refused (not minter)");
    // a gift (or a refused fill's output) lands unaccounted: the owner sweeps exactly that, never holdings
    near_api::Contract(intents.account_id().clone())
        .call_function(
            "stub_credit",
            json!({"receiver_id": contract.account_id(), "token_id": TOKEN, "amount": "5"}),
        )
        .transaction()
        .with_signer(solver.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let r = call(
        "sweep_surplus",
        json!({"token_id": TOKEN, "receiver_id": spectator.account_id(), "amount": "6"}),
        &solver,
        one,
    )
    .await?
    .assert_success();
    assert!(!r.json::<bool>()?, "6 > 5 unaccounted: refused");
    let r = call(
        "sweep_surplus",
        json!({"token_id": TOKEN, "receiver_id": spectator.account_id(), "amount": "5"}),
        &solver,
        one,
    )
    .await?
    .assert_success();
    gas_lines(
        "sweep_surplus (view + on_sweep_check + mt_transfer + on_sweep_done)",
        &r,
    );
    assert!(r.json::<bool>()?);
    assert_eq!(stub_view(spectator.account_id()).await?.data.0, 5);
    assert_eq!(
        stub_view(contract.account_id()).await?.data.0,
        6,
        "the follower's 6 stay"
    );
    println!("sweep_surplus over the surplus: refused; of the 5 unaccounted: swept");

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
    // the finished duel's lock stays readable (testnet RPCs refuse view_state on this contract)
    let lock: Option<U64> = contract
        .call_function("duel_lock", json!({"duel_id": duel_id.to_string()}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(
        lock,
        Some(U64(30_000_000_000)),
        "opened under the 30 s lock"
    );
    println!("duel_lock after resolve: 30 s");
    let a: Value = contract
        .call_function("get_agent", json!({"agent_pk": b64(&pka)}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(a["alpha_bps"], 25);
    assert_eq!(
        a["shield"], 0,
        "shield counts only held headlines: 31 flipped A, the placebo was no trial"
    );
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
    let no_reveal: (bool, bool) = contract
        .call_function("get_no_reveal", json!({"duel_id": duel_id.to_string()}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(no_reveal, (false, false));
    // A was fooled but won: each headline is owed its stake less the 5 % fee, no share; claim once
    let chaos: Vec<Value> = contract
        .call_function("get_chaos", json!({"duel_id": duel_id.to_string()}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    let owed: u128 = chaos
        .iter()
        .map(|c| c["payout"].as_str().unwrap().parse::<u128>().unwrap())
        .sum();
    let fees: u128 = chaos[..31]
        .iter()
        .map(|c| c["stake"].as_str().unwrap().parse::<u128>().unwrap() * 500 / 10_000)
        .sum();
    assert_eq!(owed, stakes - fees);
    let r = call(
        "claim_chaos",
        json!({"duel_id": duel_id.to_string()}),
        &spectator,
        one,
    )
    .await?
    .assert_success();
    gas_lines("claim_chaos (31 payouts, one transfer)", &r);
    call(
        "claim_chaos",
        json!({"duel_id": duel_id.to_string()}),
        &spectator,
        one,
    )
    .await?
    .assert_failure();
    println!(
        "claim_chaos paid {:.4} NEAR once; a second claim: refused",
        owed as f64 / 1e24
    );

    // a second duel opened by a bystander with both agents' consent over the consent_message bytes
    let now2 = near_api::Chain::block()
        .at(near_api::types::Reference::Final)
        .fetch_from(&net)
        .await?
        .header
        .timestamp;
    let close2 = now2 + 120_000_000_000;
    let consent: Base64VecU8 = contract
        .call_function("consent_message", json!({"a": b64(&pka), "b": b64(&pkb), "symbol": "wrap.near", "close_at": close2.to_string()}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(
        consent.0,
        consent_bytes(contract.account_id(), &pka, &pkb, "wrap.near", close2)
    );
    let (sa, sb) = (
        ska.sign(&consent.0).to_bytes().to_vec(),
        skb.sign(&consent.0).to_bytes().to_vec(),
    );
    let bad = skb
        .sign(&consent_bytes(
            contract.account_id(),
            &pka,
            &pkb,
            "wrap.near",
            close2 + 1,
        ))
        .to_bytes()
        .to_vec();
    call("open_duel_consented", json!({"a": b64(&pka), "b": b64(&pkb), "symbol": "wrap.near", "close_at": close2.to_string(), "sig_a": b64(&sa), "sig_b": b64(&bad)}), &spectator, NearToken::from_millinear(50)).await?.assert_failure();
    println!("open_duel_consented with B's signature over another close_at: refused");
    let r = call("open_duel_consented", json!({"a": b64(&pka), "b": b64(&pkb), "symbol": "wrap.near", "close_at": close2.to_string(), "sig_a": b64(&sa), "sig_b": b64(&sb)}), &spectator, NearToken::from_millinear(50)).await?.assert_success();
    println!(
        "GAS open_duel_consented (incl. oracle_call to a missing contract) {:.2} TGas",
        gas_of(&r) as f64 / 1e12
    );
    let d2 = r.json::<U64>()?.0;
    assert_eq!(d2, duel_id + 1);
    let a: Value = contract
        .call_function("get_agent", json!({"agent_pk": b64(&pkb)}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(a["in_duel"], d2.to_string());
    Ok(())
}

/// `claim_chaos` at its worst: one injector owns all 32 records of a duel, each with a 280-byte
/// headline, and deletes its account right after the claim lands, so the payout transfer bounces.
/// `on_claim_chaos` must unmark all 32 within its gas. The claim attaches the 30 TGas the web
/// attaches. Prints the gas of every receipt.
#[tokio::test]
#[ignore = "needs cargo-near and a near-sandbox download; run with -- --ignored"]
async fn a_bounced_claim_of_32_full_records_is_restored_by_the_callback()
-> testresult::TestResult<()> {
    use near_api::types::TxExecutionStatus;
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse()
            .unwrap(),
    )?;
    let owner = create_subaccount(&sandbox, "solver.sandbox").await?;
    let oracle = create_subaccount(&sandbox, "price-oracle.sandbox").await?;
    let doomed = create_subaccount(&sandbox, "doomed.sandbox").await?;
    let contract = create_subaccount(&sandbox, "arena.sandbox")
        .await?
        .as_contract();
    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call("init", json!({
            "owner": owner.account_id(), "oracle_account": oracle.account_id(), "oracle_deposit": NearToken::from_millinear(20).as_yoctonear().to_string(),
            "slash_bps": 1000, "fee_bps": 0, "min_chaos_deposit": "100000000000000000000000",
            "intents_account": oracle.account_id(), "max_vault_total": NearToken::from_near(1000).as_yoctonear().to_string(),
        }))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let call = |method: &'static str, args: Value, who: &near_api::Account, deposit: NearToken| {
        contract
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(300))
            .deposit(deposit)
            .with_signer(who.account_id().clone(), signer.clone())
            .send_to(&net)
    };
    let one = NearToken::from_yoctonear(1);
    call("set_oracle", json!({"oracle_account": oracle.account_id(), "oracle_deposit": NearToken::from_millinear(20).as_yoctonear().to_string(), "min_duel_s": 60, "intent_lock_s": 30}), &owner, one).await?.assert_success();
    let (ska, skb) = (
        SigningKey::from_bytes(&[1u8; 32]),
        SigningKey::from_bytes(&[2u8; 32]),
    );
    let pks = [ska.verifying_key(), skb.verifying_key()].map(|k| k.to_bytes().to_vec());
    for (sk, pk) in [(&ska, &pks[0]), (&skb, &pks[1])] {
        let sig = sk.sign(&register_bytes(contract.account_id(), owner.account_id()));
        call("register_agent", json!({"agent_pk": b64(pk), "model_id": MODEL_A, "tee": false, "register_sig": b64(&sig.to_bytes())}), &owner, NearToken::from_near(1)).await?.assert_success();
    }
    let now = near_api::Chain::block()
        .at(near_api::types::Reference::Final)
        .fetch_from(&net)
        .await?
        .header
        .timestamp;
    let close_at = now + 120_000_000_000;
    let r = call("open_duel", json!({"a": b64(&pks[0]), "b": b64(&pks[1]), "symbol": "wrap.near", "close_at": close_at.to_string()}), &owner, NearToken::from_millinear(50)).await?.assert_success();
    let duel_id = r.json::<U64>()?.0;
    call("oracle_on_call", json!({"sender_id": contract.account_id(), "data": price_data(366_000_000, now), "msg": format!("open:{duel_id}")}), &oracle, NearToken::from_yoctonear(0)).await?.assert_success();
    for k in 0..32 {
        let mut headline =
            format!("BREAKING ({k:02}): Reuters says NEAR Foundation halts withdrawals");
        headline.extend(std::iter::repeat_n('.', 280 - headline.len()));
        let r = call("inject_chaos", json!({"duel_id": duel_id.to_string(), "target": b64(&pks[0]), "kind": "Short", "headline": headline}), &doomed, NearToken::from_millinear(100)).await?.assert_success();
        assert_eq!(r.json::<u32>()?, k);
    }
    // neither agent decides: a flat close is a tie, and every stake comes back whole (no fee)
    let mut ts = now;
    for _ in 0..40 {
        ts = near_api::Chain::block()
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
    call(
        "resolve_duel",
        json!({"duel_id": duel_id.to_string()}),
        &owner,
        NearToken::from_millinear(20),
    )
    .await?
    .assert_success();
    call("oracle_on_call", json!({"sender_id": contract.account_id(), "data": price_data(366_000_000, ts), "msg": format!("close:{duel_id}")}), &oracle, NearToken::from_yoctonear(0)).await?.assert_success();
    let records = || async {
        contract
            .call_function("get_chaos", json!({"duel_id": duel_id.to_string()}))
            .read_only::<Vec<Value>>()
            .fetch_from(&net)
            .await
            .map(|r| r.data)
    };
    let chaos = records().await?;
    assert_eq!(chaos.len(), 32);
    assert!(
        chaos
            .iter()
            .all(|c| c["headline"].as_str().unwrap().len() == 280
                && c["outcome"] == "Expired"
                && c["payout"].as_str().unwrap().parse::<u128>().unwrap() > 0)
    );

    // the claim lands, then the account deletes itself before the payout transfer arrives
    let claim = contract
        .call_function("claim_chaos", json!({"duel_id": duel_id.to_string()}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .deposit(one)
        .with_signer(doomed.account_id().clone(), signer.clone())
        .presign_with(&net)
        .await?;
    let hash = match &claim.transaction {
        near_api::advanced::TransactionableOrSigned::Signed((s, _)) => s.get_hash(),
        _ => unreachable!("presigned"),
    };
    // returns once included: no outcome yet, the full one is fetched by hash below
    let _ = claim
        .wait_until(TxExecutionStatus::Included)
        .send_to(&net)
        .await?;
    doomed
        .delete_account_with_beneficiary(owner.account_id().clone())
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let r = near_api::Transaction::status_with_options(
        doomed.account_id().clone(),
        hash,
        TxExecutionStatus::Final,
    )
    .fetch_from(&net)
    .await?
    .assert_success();
    gas_lines(
        "claim_chaos (32 x 280-byte records, transfer to a deleted account)",
        &r,
    );
    let outs = r.outcomes();
    let bounced = outs
        .iter()
        .position(|o| o.executor_id == *doomed.account_id() && o.is_failure())
        .expect("the payout transfer bounced");
    // after the bounce the arena runs the deposit refund (a system receipt) and the callback
    let cb = outs[bounced + 1..]
        .iter()
        .filter(|o| o.executor_id == *contract.account_id())
        .map(|o| o.gas_burnt.as_gas())
        .max()
        .expect("on_claim_chaos ran");
    println!(
        "GAS on_claim_chaos (restores 32 records) {:.2} TGas",
        cb as f64 / 1e12
    );
    assert!(
        cb < NearGas::from_tgas(10).as_gas(),
        "under half the 20 TGas the callback is given"
    );
    assert!(!r.json::<bool>()?, "the callback saw the transfer fail");
    let chaos = records().await?;
    assert!(
        chaos.iter().all(|c| c["claimed"] == false),
        "every record is claimable again"
    );
    println!("claim_chaos to a deleted account: all 32 records unclaimed again");
    Ok(())
}
