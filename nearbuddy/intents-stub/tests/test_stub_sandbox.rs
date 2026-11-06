//! Sandbox run of the stub with the calls the week-3 arena makes: the stub plays `intents.near`,
//! the probe (`tests/probe`) plays the arena. A solver's swap lands as `stub_credit`; the probe
//! claims fills against the balance through a view + `#[private]` callback (one over-claim is
//! rejected without a panic), then pays a follower out through `mt_transfer` + callback.
//! Prints gas per receipt so the design doc can quote it.
//!   cargo test --test test_stub_sandbox -- --ignored --nocapture
//! Ignored by default: it needs the cargo-near binary and downloads near-sandbox on first run.
use near_api::types::transaction::result::ExecutionSuccess;
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};

const T: &str = "nep141:usdc.near";

fn gas_lines(label: &str, r: &ExecutionSuccess) {
    let total: u64 = r.outcomes().iter().map(|o| o.gas_burnt.as_gas()).sum();
    println!("GAS {label} total {:.2} TGas", total as f64 / 1e12);
    for o in r.outcomes() {
        println!(
            "      {:<22} {:.2} TGas",
            o.executor_id.to_string(),
            o.gas_burnt.as_gas() as f64 / 1e12
        );
    }
}

fn build(manifest: Option<&str>) -> testresult::TestResult<Vec<u8>> {
    let opts = cargo_near_build::BuildOpts {
        manifest_path: manifest.map(|m| format!("{}/{m}", env!("CARGO_MANIFEST_DIR")).into()),
        ..Default::default()
    };
    Ok(std::fs::read(cargo_near_build::build_with_cli(opts)?)?)
}

#[tokio::test]
#[ignore = "needs cargo-near and a near-sandbox download; run with -- --ignored"]
async fn arena_calls_against_the_stub() -> testresult::TestResult<()> {
    let stub_wasm = build(None)?;
    let probe_wasm = build(Some("tests/probe/Cargo.toml"))?;
    println!(
        "wasm stub {} B, probe {} B",
        stub_wasm.len(),
        probe_wasm.len()
    );

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse()
            .unwrap(),
    )?;
    let mut ids: Vec<AccountId> = vec![];
    for name in [
        "intents.sandbox",
        "arena.sandbox",
        "solver.sandbox",
        "follower.sandbox",
    ] {
        let id: AccountId = name.parse()?;
        sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(20))
            .send()
            .await?;
        ids.push(id);
    }
    let [intents, arena, solver, follower] = [&ids[0], &ids[1], &ids[2], &ids[3]];

    near_api::Contract::deploy(intents.clone())
        .use_code(stub_wasm)
        .without_init_call()
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    near_api::Contract::deploy(arena.clone())
        .use_code(probe_wasm)
        .with_init_call("new", json!({"intents": intents}))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let call = |to: &AccountId, method: &'static str, args: Value, who: &AccountId, yocto: u128| {
        near_api::Contract(to.clone())
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(100))
            .deposit(NearToken::from_yoctonear(yocto))
            .with_signer(who.clone(), signer.clone())
            .send_to(&net)
    };
    let balance = |who: &AccountId| {
        near_api::Contract(intents.clone())
            .call_function("mt_balance_of", json!({"account_id": who, "token_id": T}))
            .read_only::<U128>()
            .fetch_from(&net)
    };

    // only a minter the stub account added may credit (red team S1)
    let r = call(
        intents,
        "stub_credit",
        json!({"receiver_id": arena, "token_id": T, "amount": "100"}),
        solver,
        0,
    )
    .await?;
    let failure = format!("{:?}", r.assert_failure());
    assert!(failure.contains("not minter"), "{failure}");
    // `#[private]`: the solver cannot add itself, only the stub account can
    let r = call(
        intents,
        "add_minter",
        json!({"account_id": solver}),
        solver,
        0,
    )
    .await?;
    let failure = format!("{:?}", r.assert_failure());
    assert!(failure.contains("is private"), "{failure}");
    call(
        intents,
        "add_minter",
        json!({"account_id": solver}),
        intents,
        0,
    )
    .await?
    .assert_success();
    // the solver's swap delivers 100 to the arena's intents account
    let r = call(
        intents,
        "stub_credit",
        json!({"receiver_id": arena, "token_id": T, "amount": "100"}),
        solver,
        0,
    )
    .await?
    .assert_success();
    gas_lines("stub_credit", &r);
    assert_eq!(balance(arena).await?.data.0, 100);

    // fill 1 claims 60: backed
    let r = call(
        arena,
        "claim",
        json!({"token_id": T, "amount_out": "60"}),
        solver,
        0,
    )
    .await?
    .assert_success();
    gas_lines("claim (view mt_batch_balance_of + on_claim)", &r);
    assert!(r.json::<bool>()?);
    // fill 2 claims 50 with only 40 unaccounted: rejected in the callback, tx still succeeds
    let r = call(
        arena,
        "claim",
        json!({"token_id": T, "amount_out": "50"}),
        solver,
        0,
    )
    .await?
    .assert_success();
    gas_lines("claim rejected (no receipt)", &r);
    assert!(!r.json::<bool>()?);
    println!("claim of 50 against 40 unaccounted: rejected, no panic");
    let r = call(
        arena,
        "claim",
        json!({"token_id": T, "amount_out": "40"}),
        solver,
        0,
    )
    .await?
    .assert_success();
    assert!(r.json::<bool>()?);

    // the arena pays a follower out through intents.near
    let r = call(
        arena,
        "pay_out",
        json!({"receiver_id": follower, "token_id": T, "amount": "30"}),
        follower,
        0,
    )
    .await?
    .assert_success();
    gas_lines("pay_out (mt_transfer 1 yocto + on_pay_out)", &r);
    assert!(r.json::<bool>()?);
    assert_eq!(balance(follower).await?.data.0, 30);
    assert_eq!(balance(arena).await?.data.0, 70);
    let acc: U128 = near_api::Contract(arena.clone())
        .call_function("accounted", json!({"token_id": T}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(acc.0, 70);

    // 70 accounted, 70 held: a further claim has nothing behind it
    let r = call(
        arena,
        "claim",
        json!({"token_id": T, "amount_out": "1"}),
        solver,
        0,
    )
    .await?
    .assert_success();
    assert!(!r.json::<bool>()?);
    // nobody but the arena moves the arena's balance, and never without 1 yocto
    call(
        intents,
        "mt_transfer",
        json!({"receiver_id": solver, "token_id": T, "amount": "1"}),
        solver,
        1,
    )
    .await?
    .assert_failure();
    call(
        intents,
        "mt_transfer",
        json!({"receiver_id": arena, "token_id": T, "amount": "1"}),
        follower,
        0,
    )
    .await?
    .assert_failure();
    println!("mt_transfer by a non-owner and without 1 yocto: refused");
    Ok(())
}
