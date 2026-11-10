//! Sandbox run of the real wasm for keyless agents: two are registered, a duel opens, an oracle tick
//! lands, 31 headlines of 280 bytes (each escaped to its longest) are planted at A, and A's slots run
//! open -> submit with responses from 1 KB to the 24 KB cap, signed by a stand-in enclave key pinned
//! to the agents' model. A submission signed over another request and a second submission to a
//! filled slot are refused; the duel then resolves through the oracle callback and the slots go.
//! Prints gas per call for the README.
//!   NEAR_SANDBOX_BIN_PATH=... cargo test --test test_keyless_sandbox -- --ignored --nocapture
use ed25519_dalek::{Signer, SigningKey};
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::base64::{Engine, prelude::BASE64_STANDARD};
use near_sdk::serde_json::{Value, json};
use nearbuddy_arena::tee_text;
use sha2::{Digest, Sha256};

const MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

fn b64(b: &[u8]) -> String {
    BASE64_STANDARD.encode(b)
}

fn gas_of(r: &near_api::types::transaction::result::ExecutionSuccess) -> f64 {
    r.outcomes()
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .sum::<u64>() as f64
        / 1e12
}

fn price_data(price8: u64, ts_ns: u64) -> Value {
    json!({"timestamp": ts_ns.to_string(), "recency_duration_sec": 300, "prices": [{"asset_id": "wrap.near", "price": {"multiplier": price8.to_string(), "decimals": 8}}]})
}

/// A chat-completion response of exactly `size` bytes: the decision in `content`, padding in
/// `reasoning_content` the way a reasoning model fills it.
fn response(size: usize, content: &str) -> Vec<u8> {
    let make = |pad: usize| {
        near_sdk::serde_json::to_vec(&json!({
            "id": "chatcmpl-sandbox", "object": "chat.completion", "created": 1_762_000_000,
            "model": MODEL,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content,
                "reasoning_content": "Thinking about the oracle move. ".repeat(pad / 32 + 1)[..pad].to_string()},
                "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 700, "completion_tokens": 300, "total_tokens": 1000}
        }))
        .unwrap()
    };
    let base = make(0).len();
    let r = make(size.saturating_sub(base));
    assert_eq!(r.len(), size.max(base));
    r
}

async fn account(
    sandbox: &near_sandbox::Sandbox,
    name: &str,
) -> testresult::TestResult<near_api::Account> {
    let id: AccountId = name.parse().unwrap();
    sandbox
        .create_account(id.clone())
        .initial_balance(NearToken::from_near(50))
        .send()
        .await?;
    Ok(near_api::Account(id))
}

#[tokio::test]
#[ignore = "needs cargo-near and a near-sandbox binary; run with -- --ignored"]
async fn keyless_slots_gas_by_response_size() -> testresult::TestResult<()> {
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse()
            .unwrap(),
    )?;
    let owner = account(&sandbox, "owner.sandbox").await?;
    let alice = account(&sandbox, "alice.sandbox").await?;
    let bob = account(&sandbox, "bob.sandbox").await?;
    let keeper = account(&sandbox, "keeper.sandbox").await?;
    let keeper = &keeper;
    let spectator = account(&sandbox, "spectator.sandbox").await?;
    let oracle = account(&sandbox, "price-oracle.sandbox").await?;
    let contract = account(&sandbox, "arena.sandbox").await?.as_contract();
    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call("init", json!({
            "owner": owner.account_id(), "oracle_account": oracle.account_id(),
            "oracle_deposit": NearToken::from_millinear(20).as_yoctonear().to_string(),
            "slash_bps": 1000, "fee_bps": 0, "min_chaos_deposit": NearToken::from_millinear(100).as_yoctonear().to_string(),
            "intents_account": "intents.sandbox", "max_vault_total": NearToken::from_near(1000).as_yoctonear().to_string(),
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
    let view = |method: &'static str, args: Value| {
        contract
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&net)
    };
    let (zero, one) = (NearToken::from_yoctonear(0), NearToken::from_yoctonear(1));
    let tee = SigningKey::from_bytes(&[7u8; 32]);
    call("set_oracle", json!({"oracle_account": oracle.account_id(), "oracle_deposit": NearToken::from_millinear(20).as_yoctonear().to_string(), "min_duel_s": 60, "intent_lock_s": 30}), &owner, one).await?.assert_success();
    call(
        "pin_model_signer",
        json!({"signer": b64(&tee.verifying_key().to_bytes()), "model_id": MODEL}),
        &owner,
        one,
    )
    .await?
    .assert_success();

    let mut ids = vec![];
    for (who, strategy) in [(&alice, "S".repeat(512)), (&bob, "Contrarian.".to_string())] {
        let r = call(
            "register_keyless",
            json!({"model_id": MODEL, "strategy": strategy, "template_version": 1}),
            who,
            NearToken::from_near(1),
        )
        .await?
        .assert_success();
        println!("GAS register_keyless {:.2} TGas", gas_of(&r));
        ids.push(r.json::<Value>()?["pk"].as_str().unwrap().to_string());
    }
    let (a, b) = (ids[0].clone(), ids[1].clone());
    let block = near_api::Chain::block()
        .at(near_api::types::Reference::Final)
        .fetch_from(&net)
        .await?;
    let now = block.header.timestamp;
    let close_at = now + 900_000_000_000;
    let r = call(
        "open_duel",
        json!({"a": a, "b": b, "symbol": "wrap.near", "close_at": close_at.to_string()}),
        &owner,
        NearToken::from_millinear(50),
    )
    .await?
    .assert_success();
    let duel: u64 = r.json::<near_sdk::json_types::U64>()?.0;
    call("oracle_on_call", json!({"sender_id": contract.account_id(), "data": price_data(366_000_000, now), "msg": format!("open:{duel}")}), &oracle, zero).await?.assert_success();
    let r = call(
        "request_tick",
        json!({"duel_id": duel.to_string()}),
        keeper,
        NearToken::from_millinear(21),
    )
    .await?
    .assert_success();
    println!(
        "GAS request_tick (incl. oracle_call to a missing contract) {:.2} TGas",
        gas_of(&r)
    );
    let r = call("oracle_on_call", json!({"sender_id": contract.account_id(), "data": price_data(367_830_000, now + 1), "msg": format!("tick:{duel}")}), &oracle, zero).await?.assert_success();
    println!("GAS oracle_on_call (tick) {:.2} TGas", gas_of(&r));

    let tee = &tee;
    let slot = |agent: String| async move {
        let r = call(
            "open_slot",
            json!({"duel_id": duel.to_string(), "agent": agent}),
            keeper,
            zero,
        )
        .await?
        .assert_success();
        let s = r.json::<Value>()?;
        testresult::TestResult::Ok((s, gas_of(&r)))
    };
    let cycle = |agent: String, res: Vec<u8>, label: String| async move {
        let (s, g_open) = slot(agent.clone()).await?;
        let req = BASE64_STANDARD.decode(
            view(
                "keyless_request",
                json!({"duel_id": duel.to_string(), "agent": agent}),
            )
            .await?
            .data
            .as_str()
            .unwrap(),
        )?;
        let req_hash = Sha256::digest(&req).to_vec();
        assert_eq!(b64(&req_hash), s["request_hash"].as_str().unwrap());
        let res_hash = Sha256::digest(&res).to_vec();
        let sig = tee
            .sign(&tee_text(2, MODEL, &req_hash, &res_hash))
            .to_bytes();
        let r = call("submit_completion", json!({"duel_id": duel.to_string(), "agent": agent, "seq": s["seq"], "response": b64(&res), "signer": b64(&tee.verifying_key().to_bytes()), "signature": b64(&sig)}), keeper, zero).await?.assert_success();
        println!(
            "GAS {label}: request {} B, open_slot {g_open:.2}, submit_completion {:.2} TGas",
            req.len(),
            gas_of(&r)
        );
        testresult::TestResult::Ok(())
    };
    // B decides first with no headlines; then A with every response size
    cycle(
        b.clone(),
        response(1_066, r#"{"direction": "short", "reasoning": "fade it"}"#),
        "B, 0 headlines, 1 KB response".into(),
    )
    .await?;
    let content =
        r#"{"direction": "long", "size_bps": 2500, "reasoning": "the oracle is up 50 bps"}"#;
    for size in [1_066usize, 2_903, 7_702, 16_384, 24_576] {
        cycle(
            a.clone(),
            response(size, content),
            format!("A, 0 headlines, {size} B response"),
        )
        .await?;
    }

    // 31 headlines of 280 bytes, all '&', '<' and '>': the request carries each one 4-5x escaped
    let head = "&".repeat(140) + &"<>".repeat(70);
    for i in 0..31 {
        let fee: String = view("chaos_fee", json!({"duel_id": duel.to_string()}))
            .await?
            .data
            .as_str()
            .unwrap()
            .into();
        let fee: u128 = fee.parse()?;
        call("inject_chaos", json!({"duel_id": duel.to_string(), "target": a, "kind": if i % 2 == 0 { "Short" } else { "Long" }, "headline": head}), &spectator, NearToken::from_yoctonear(fee + NearToken::from_millinear(50).as_yoctonear())).await?.assert_success();
    }
    cycle(
        a.clone(),
        response(7_702, content),
        "A, 31 x 280 B headlines, 7.7 KB response".into(),
    )
    .await?;
    let chaos = view("get_chaos", json!({"duel_id": duel.to_string()}))
        .await?
        .data;
    let decided = chaos
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["outcome"] != "Pending")
        .count();
    assert_eq!(
        decided, 31,
        "the decision after all 31 headlines judged every one"
    );

    // refusals: a submission signed over another request; a second one to the filled slot
    let (s, _) = slot(a.clone()).await?;
    let res = response(1_066, content);
    let res_hash = Sha256::digest(&res).to_vec();
    let forged = tee
        .sign(&tee_text(2, MODEL, &[9u8; 32], &res_hash))
        .to_bytes();
    let submit = |sig: Vec<u8>, res: Vec<u8>| {
        call(
            "submit_completion",
            json!({"duel_id": duel.to_string(), "agent": a, "seq": s["seq"], "response": b64(&res), "signer": b64(&tee.verifying_key().to_bytes()), "signature": b64(&sig)}),
            keeper,
            zero,
        )
    };
    submit(forged.to_vec(), res.clone()).await?.assert_failure();
    let req_hash = BASE64_STANDARD.decode(s["request_hash"].as_str().unwrap())?;
    let sig = tee
        .sign(&tee_text(2, MODEL, &req_hash, &res_hash))
        .to_bytes();
    submit(sig.to_vec(), res.clone()).await?.assert_success();
    submit(sig.to_vec(), res.clone()).await?.assert_failure();
    println!("forged submission and a second submission to a filled slot: refused");

    // resolve: A long 2500 bps on a +0.5 % close wins
    loop {
        let block = near_api::Chain::block()
            .at(near_api::types::Reference::Final)
            .fetch_from(&net)
            .await?;
        if block.header.timestamp >= close_at {
            break;
        }
        sandbox.fast_forward(200).await?;
    }
    let ts = near_api::Chain::block()
        .at(near_api::types::Reference::Final)
        .fetch_from(&net)
        .await?
        .header
        .timestamp;
    let r = call("oracle_on_call", json!({"sender_id": contract.account_id(), "data": price_data(367_830_000, ts), "msg": format!("close:{duel}")}), &oracle, zero).await?.assert_success();
    println!(
        "GAS oracle_on_call (close, keyless duel, 31 injections) {:.2} TGas",
        gas_of(&r)
    );
    let d = view("get_duel", json!({"duel_id": duel.to_string()}))
        .await?
        .data;
    assert_eq!(d["outcome"]["winner"].as_str().unwrap(), a);
    assert!(
        view("get_slot", json!({"duel_id": duel.to_string(), "agent": a}))
            .await?
            .data
            .is_null()
    );
    println!(
        "keyless duel {duel} resolved: winner A, pnl_a {}",
        d["outcome"]["pnl_a"]
    );
    Ok(())
}
