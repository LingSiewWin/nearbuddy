//! Unit tests and property tests. Every call runs like a receipt on chain: the contract is read from
//! the mocked trie, the method runs, and on success the struct is written back; a panic discards
//! every write, as the runtime reverts a failed receipt. The contract balance is the mocked
//! `env::account_balance()`: the VM credits the attached deposit and debits every transfer.
//! A callback runs with the arena's answers as its promise results (`None` = failed promise).
//! `#[private]` lives in the wasm entry point, not in the method, so it is proven on testnet.
use std::any::{Any, TypeId};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Once;

use near_sdk::base64::Engine;
use near_sdk::base64::prelude::BASE64_STANDARD;
use near_sdk::json_types::U64;
use near_sdk::mock::{MockAction, with_mocked_blockchain};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
use near_sdk::{MockedBlockchain, PromiseResult, RuntimeFeesConfig, test_vm_config};
use proptest::collection::vec;
use proptest::prelude::*;

use crate::*;

const CONTRACT: &str = "predict.testnet";
const ARENA: &str = "arena.testnet";
const START: u128 = 10 * 10u128.pow(24);
const SEC: u64 = 1_000_000_000;
const LOCK: u64 = 60 * SEC;
const T0: u64 = 1_000 * SEC;
const PEOPLE: [&str; 3] = ["ann.testnet", "bob.testnet", "cy.testnet"];

/// The arena's answer to one view: `Some(json)`, or `None` for a failed promise.
type Answer = Option<String>;

struct World {
    trie: HashMap<Vec<u8>, Vec<u8>>,
    balance: u128,
    usage: u64,
    now: u64,
}

thread_local!(static QUIET: Cell<bool> = const { Cell::new(false) });

/// One `make()` per thread and type: `test_vm_config` builds every protocol version's config,
/// which dominates a property case when called per receipt.
fn cached<T: Clone + 'static>(make: fn() -> T) -> T {
    thread_local!(static CACHE: RefCell<HashMap<TypeId, Box<dyn Any>>> = RefCell::new(HashMap::new()));
    CACHE.with(|c| {
        c.borrow_mut()
            .entry(TypeId::of::<T>())
            .or_insert_with(|| Box::new(make()))
            .downcast_ref::<T>()
            .expect("cache type")
            .clone()
    })
}

/// Runs `f` without the default hook printing every expected contract panic.
fn quiet<R>(f: impl FnOnce() -> R) -> R {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !QUIET.with(Cell::get) {
                prev(info)
            }
        }));
    });
    QUIET.with(|q| q.set(true));
    let r = f();
    QUIET.with(|q| q.set(false));
    r
}

/// What one successful receipt sent: `(receiver, yoctoNEAR)` per transfer.
type Sent = Vec<(String, u128)>;

impl World {
    fn new() -> Self {
        let mut w = World {
            trie: HashMap::new(),
            balance: START,
            usage: 0,
            now: T0,
        };
        w.env(CONTRACT, 0, &[]);
        let c = Contract::new(ARENA.parse().unwrap());
        env::state_write(&c);
        drop(c);
        w.usage = env::storage_usage();
        w.trie = with_mocked_blockchain(|b| b.take_storage());
        w
    }

    fn env(&self, pred: &str, deposit: u128, answers: &[Answer]) {
        let ctx = VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(pred.parse().unwrap())
            .signer_account_id(pred.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_yoctonear(self.balance))
            .storage_usage(self.usage)
            .block_timestamp(self.now)
            .prepaid_gas(Gas::from_tgas(300))
            .build();
        let results = answers
            .iter()
            .map(|a| match a {
                Some(s) => PromiseResult::Successful(s.clone().into_bytes()),
                None => PromiseResult::Failed,
            })
            .collect();
        env::set_blockchain_interface(MockedBlockchain::new(
            ctx,
            cached(test_vm_config),
            cached(RuntimeFeesConfig::test),
            results,
            self.trie.clone(),
            Default::default(),
            None,
        ));
    }

    /// One receipt. `Err(panic message)` when it reverted; nothing changed then.
    fn call<R>(
        &mut self,
        pred: &str,
        deposit: u128,
        answers: &[Answer],
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<(R, Sent), String> {
        self.env(pred, deposit, answers);
        let out = quiet(|| {
            catch_unwind(AssertUnwindSafe(|| {
                let mut c: Contract = env::state_read().expect("state");
                let r = f(&mut c);
                env::state_write(&c);
                drop(c); // flushes the collections
                r
            }))
        });
        match out {
            Ok(r) => {
                let mut sent = vec![];
                for rc in get_created_receipts() {
                    for a in &rc.actions {
                        if let MockAction::Transfer { deposit, .. } = a {
                            sent.push((rc.receiver_id.to_string(), deposit.as_yoctonear()));
                        }
                    }
                }
                let out: u128 = sent.iter().map(|s| s.1).sum();
                let bal = env::account_balance().as_yoctonear();
                assert_eq!(bal, self.balance + deposit - out, "balance moved off book");
                self.balance = bal;
                self.usage = env::storage_usage();
                self.trie = with_mocked_blockchain(|b| b.take_storage());
                Ok((r, sent))
            }
            Err(p) => {
                let msg = p
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_default();
                assert!(
                    !msg.starts_with("attempt to") && !msg.contains("`Option::unwrap()`"),
                    "contract bug: {msg}"
                );
                Err(match msg.split_once("panic_msg: \"") {
                    Some((_, rest)) => rest.split('"').next().unwrap_or_default().to_string(),
                    None => msg,
                })
            }
        }
    }

    fn view<R>(&self, f: impl FnOnce(&Contract) -> R) -> R {
        self.env(CONTRACT, 0, &[]);
        let c: Contract = env::state_read().expect("state");
        f(&c)
    }

    /// `predict` by `who`, then its callback with `answers`: `Ok(accepted)`, or `Err` when
    /// `predict` itself refused (deposit never left the caller).
    fn predict(
        &mut self,
        who: &str,
        duel: u64,
        index: Option<u32>,
        pick: Pick,
        answers: &[Answer],
    ) -> Result<bool, String> {
        self.call(who, DEPOSIT, &[], |c| {
            let _ = c.predict(U64(duel), index, pick);
        })?;
        let (ok, sent) = self
            .call(CONTRACT, 0, answers, |c| {
                c.on_predict(who.parse().unwrap(), U64(duel), index, pick)
            })
            .expect("on_predict never panics");
        assert_eq!(
            sent,
            if ok {
                vec![]
            } else {
                vec![(who.to_string(), DEPOSIT)]
            },
            "a refused prediction's deposit goes back, an accepted one stays"
        );
        Ok(ok)
    }

    fn settle(&mut self, duel: u64, answers: &[Answer]) -> Result<u32, String> {
        self.call(PEOPLE[0], 0, &[], |c| {
            let _ = c.settle(U64(duel));
        })?;
        self.call(CONTRACT, 0, answers, |c| c.on_settle(U64(duel)))
            .map(|r| r.0)
    }

    fn claim(&mut self, who: &str) -> Result<u128, String> {
        let (amount, sent) = self.call(who, 0, &[], |c| c.claim())?;
        assert_eq!(sent, vec![(who.to_string(), amount.0)]);
        Ok(amount.0)
    }
}

// ---------------------------------------------------------------- a stand-in arena

fn pk(n: u8) -> String {
    BASE64_STANDARD.encode([n; 32])
}

#[derive(Clone, Debug)]
struct ArenaSim {
    close_at: u64,
    resolved: bool,
    /// 0: a wins, 1: b wins, 2: tie, 3: voided.
    result: u8,
    chaos: Vec<&'static str>,
    open_at: u64,
    /// Bit i: injection i's target committed (or a keyless slot carried it) after it landed.
    fixed: u32,
    /// An arena without `chaos_open` (deploy 17): the view call fails.
    legacy: bool,
}

impl ArenaSim {
    fn open(now: u64) -> Self {
        ArenaSim {
            close_at: now + 310 * SEC,
            resolved: false,
            result: 0,
            chaos: vec![],
            open_at: now,
            fixed: 0,
            legacy: false,
        }
    }

    fn duel_json(&self, id: u64) -> String {
        let outcome = if !self.resolved {
            "null".to_string()
        } else {
            let (open, close) = if self.result == 3 { (0, 0) } else { (366, 365) };
            let winner = match self.result {
                0 => format!("\"{}\"", pk(1)),
                1 => format!("\"{}\"", pk(2)),
                _ => "null".into(),
            };
            format!(
                r#"{{"open_price":"{open}","close_price":"{close}","pnl_a":0,"pnl_b":0,"winner":{winner},"slashed":"0","injections":0}}"#
            )
        };
        format!(
            r#"{{"id":"{id}","a":"{}","b":"{}","symbol":"wrap.near","open_at":"{}","close_at":"{}","pool":"0","injections":[],"resolved":{},"last_intent_a":null,"last_intent_b":null,"outcome":{outcome},"open_price":"366"}}"#,
            pk(1),
            pk(2),
            self.open_at,
            self.close_at,
            self.resolved
        )
    }

    fn chaos_json(&self) -> String {
        let rows: Vec<String> = self
            .chaos
            .iter()
            .map(|o| {
                format!(
                    r#"{{"injector":"x.testnet","target":"{}","headline":"h","kind":"Long","arm":"Cue","stake":"1","at":"0","prev":"Short","next":null,"decided_by":null,"outcome":"{o}","payout":"0","claimed":false}}"#,
                    pk(1)
                )
            })
            .collect();
        format!("[{}]", rows.join(","))
    }

    fn predict_answers(&self, id: u64, index: Option<u32>) -> Vec<Answer> {
        match index {
            None => vec![Some(self.duel_json(id)), Some(format!("\"{LOCK}\""))],
            Some(i) => vec![self.chaos_open_json(i), Some(self.chaos_json())],
        }
    }

    /// The arena's `chaos_open(id, i)`; a failed call on a legacy arena.
    fn chaos_open_json(&self, i: u32) -> Answer {
        if self.legacy {
            return None;
        }
        Some(match self.chaos.get(i as usize) {
            None => "null".into(),
            Some(o) => format!(
                r#"{{"open":{},"owner":"op.testnet","keyless":false}}"#,
                *o == "Pending" && self.fixed & (1 << i) == 0
            ),
        })
    }

    fn settle_answers(&self, id: u64) -> Vec<Answer> {
        vec![Some(self.duel_json(id)), Some(self.chaos_json())]
    }

    /// The arena's own rule: is this market still undecided and hidden at `now`?
    fn open_at(&self, index: Option<u32>, now: u64) -> bool {
        match index {
            None => {
                !self.resolved
                    && now < self.open_at + (self.close_at - self.open_at) / 2
                    && now + LOCK < self.close_at
            }
            Some(i) => {
                self.chaos.get(i as usize) == Some(&"Pending")
                    && (self.legacy || self.fixed & (1 << i) == 0)
            }
        }
    }

    fn resolve(&mut self, result: u8) {
        self.resolved = true;
        self.result = result;
        for c in self.chaos.iter_mut() {
            if *c == "Pending" {
                *c = "Expired";
            }
        }
    }

    fn outcome(&self, index: Option<u32>) -> Option<Option<Pick>> {
        match index {
            None if !self.resolved => None,
            None => Some(match self.result {
                0 => Some(Pick::A),
                1 => Some(Pick::B),
                2 => Some(Pick::Tie),
                _ => None,
            }),
            Some(i) => match self.chaos[i as usize] {
                "Pending" => None,
                "Flipped" => Some(Some(Pick::Flipped)),
                "Held" => Some(Some(Pick::Held)),
                _ => Some(None),
            },
        }
    }
}

fn held(w: &World, who: &str) -> Vec<PredictionView> {
    w.view(|c| c.get_predictions(who.parse().unwrap()))
}

fn stats(w: &World, who: &str) -> Stats {
    w.view(|c| c.get_stats(who.parse().unwrap()))
        .unwrap_or_default()
}

fn market(w: &World, duel: u64, index: Option<u32>) -> MarketView {
    w.view(|c| c.get_market(U64(duel), index)).expect("market")
}

// ---------------------------------------------------------------- unit tests

#[test]
fn duel_predictions_close_at_the_midpoint_or_the_intent_lock() {
    let mut w = World::new();
    let mut a = ArenaSim::open(T0);
    let half = T0 + 155 * SEC; // 310 s duel
    w.now = half - 1;
    let ans = a.predict_answers(7, None);
    assert_eq!(w.predict(PEOPLE[0], 7, None, Pick::A, &ans), Ok(true));
    w.now = half; // half the price path is public: closed, though the arena takes commits for 95 s
    assert_eq!(w.predict(PEOPLE[1], 7, None, Pick::B, &ans), Ok(false));
    // a duel shorter than twice the lock closes at the lock instead
    let short = ArenaSim {
        close_at: T0 + 100 * SEC,
        ..ArenaSim::open(T0)
    };
    let ans = short.predict_answers(8, None);
    w.now = T0 + 40 * SEC - 1;
    assert_eq!(w.predict(PEOPLE[1], 8, None, Pick::A, &ans), Ok(true));
    w.now = T0 + 40 * SEC; // now + lock == close_at: the arena takes no new commitment
    assert_eq!(w.predict(PEOPLE[2], 8, None, Pick::A, &ans), Ok(false));
    a.resolve(0);
    w.now = a.close_at + SEC;
    let ans = a.predict_answers(7, None);
    assert_eq!(w.predict(PEOPLE[2], 7, None, Pick::B, &ans), Ok(false));
    let m = market(&w, 7, None);
    assert_eq!((m.total, m.picks[0].n, m.picks[1].n), (1, 1, 0));
    // an unknown duel, and the arena answering for another duel, are refused too
    let missing = vec![Some("null".into()), Some("null".into())];
    assert_eq!(w.predict(PEOPLE[1], 9, None, Pick::A, &missing), Ok(false));
    w.now = T0;
    let other = ArenaSim::open(T0).predict_answers(10, None);
    assert_eq!(w.predict(PEOPLE[1], 9, None, Pick::A, &other), Ok(false));
}

#[test]
fn chaos_predictions_close_at_the_targets_deciding_commit() {
    let mut w = World::new();
    let mut a = ArenaSim::open(T0);
    a.chaos = vec!["Pending", "Pending"];
    assert_eq!(
        w.predict(
            PEOPLE[0],
            3,
            Some(0),
            Pick::Held,
            &a.predict_answers(3, Some(0))
        ),
        Ok(true)
    );
    let m = market(&w, 3, Some(0));
    assert_eq!(
        (m.steered_by.map(|o| o.to_string()), m.open_until_reveal),
        (Some("op.testnet".into()), false)
    );
    // the target committed its next call: still Pending on chain, but no longer blind
    a.fixed = 1;
    assert_eq!(
        w.predict(
            PEOPLE[1],
            3,
            Some(0),
            Pick::Flipped,
            &a.predict_answers(3, Some(0))
        ),
        Ok(false)
    );
    // an arena without `chaos_open` (the view call fails): open until the reveal, and labelled so
    let legacy = ArenaSim {
        legacy: true,
        ..a.clone()
    };
    let ans = legacy.predict_answers(3, Some(1));
    assert_eq!(ans[0], None);
    assert_eq!(w.predict(PEOPLE[1], 3, Some(1), Pick::Held, &ans), Ok(true));
    assert!(market(&w, 3, Some(1)).open_until_reveal);
    // an unreadable `chaos_open` answer refuses rather than falling back
    let bad = vec![Some("{\"open\":".into()), Some(a.chaos_json())];
    assert_eq!(
        w.predict(PEOPLE[2], 3, Some(1), Pick::Held, &bad),
        Ok(false)
    );
    assert_eq!(
        w.predict(
            PEOPLE[2],
            3,
            Some(7),
            Pick::Held,
            &a.predict_answers(3, Some(7))
        ),
        Ok(false)
    );
}

#[test]
fn chaos_predictions_close_when_the_outcome_leaves_pending() {
    let mut w = World::new();
    let mut a = ArenaSim::open(T0);
    a.chaos = vec!["Pending", "Held", "Pending"];
    let ans = a.predict_answers(3, Some(0));
    assert_eq!(w.predict(PEOPLE[0], 3, Some(0), Pick::Held, &ans), Ok(true));
    assert_eq!(
        w.predict(
            PEOPLE[1],
            3,
            Some(1),
            Pick::Held,
            &a.predict_answers(3, Some(1))
        ),
        Ok(false)
    );
    assert_eq!(
        w.predict(
            PEOPLE[1],
            3,
            Some(5),
            Pick::Held,
            &a.predict_answers(3, Some(5))
        ),
        Ok(false)
    );
    for o in ["Flipped", "NoTrial", "Expired"] {
        a.chaos[2] = o;
        let ans = a.predict_answers(3, Some(2));
        assert_eq!(
            w.predict(PEOPLE[1], 3, Some(2), Pick::Flipped, &ans),
            Ok(false)
        );
    }
    // no prediction lands on a chaos market after `settle` fixed it, whatever the views say
    a.chaos[0] = "Flipped";
    w.settle(3, &a.settle_answers(3)).unwrap();
    let stale = ArenaSim {
        chaos: vec!["Pending"],
        ..a.clone()
    };
    assert_eq!(
        w.predict(
            PEOPLE[1],
            3,
            Some(0),
            Pick::Held,
            &stale.predict_answers(3, Some(0))
        ),
        Err("predictions closed".into())
    );
}

#[test]
fn predict_refuses_bad_calls_before_asking_the_arena() {
    let mut w = World::new();
    let a = ArenaSim::open(T0);
    let ans = a.predict_answers(1, None);
    let attach = |w: &mut World, d: u128| {
        w.call(PEOPLE[0], d, &[], |c| {
            let _ = c.predict(U64(1), None, Pick::A);
        })
        .map(|_| ())
    };
    assert_eq!(
        attach(&mut w, DEPOSIT - 1),
        Err("attach exactly the deposit".into())
    );
    assert_eq!(
        attach(&mut w, DEPOSIT + 1),
        Err("attach exactly the deposit".into())
    );
    let err = |r: Result<bool, String>| r.unwrap_err();
    assert_eq!(
        err(w.predict(PEOPLE[0], 1, None, Pick::Held, &ans)),
        "pick does not fit the market"
    );
    assert_eq!(
        err(w.predict(PEOPLE[0], 1, Some(0), Pick::Tie, &ans)),
        "pick does not fit the market"
    );
    assert_eq!(
        err(w.predict(PEOPLE[0], 1, Some(MAX_INJECTIONS), Pick::Held, &ans)),
        "index out of range"
    );
    assert_eq!(w.predict(PEOPLE[0], 1, None, Pick::A, &ans), Ok(true));
    assert_eq!(
        err(w.predict(PEOPLE[0], 1, None, Pick::B, &ans)),
        "already predicted"
    );
    // two predictions in flight for one market: the second callback refuses and refunds
    w.call(PEOPLE[1], DEPOSIT, &[], |c| {
        let _ = c.predict(U64(1), None, Pick::A);
    })
    .unwrap();
    w.call(PEOPLE[1], DEPOSIT, &[], |c| {
        let _ = c.predict(U64(1), None, Pick::B);
    })
    .unwrap();
    for (pick, ok) in [(Pick::A, true), (Pick::B, false)] {
        let (r, _) = w
            .call(CONTRACT, 0, &ans, |c| {
                c.on_predict(PEOPLE[1].parse().unwrap(), U64(1), None, pick)
            })
            .unwrap();
        assert_eq!(r, ok);
    }
    // the per-account bound: MAX_HELD predictions held, then claim first
    for d in 0..MAX_HELD as u64 - 1 {
        let ans = a.predict_answers(100 + d, None);
        assert_eq!(w.predict(PEOPLE[0], 100 + d, None, Pick::A, &ans), Ok(true));
    }
    assert_eq!(
        err(w.predict(PEOPLE[0], 999, None, Pick::A, &a.predict_answers(999, None))),
        "too many open predictions: claim first"
    );
}

#[test]
fn on_predict_refunds_on_a_failed_or_unreadable_arena_answer() {
    let mut w = World::new();
    let a = ArenaSim::open(T0);
    let good = a.predict_answers(1, None);
    for bad in [
        vec![None, good[1].clone()],
        vec![good[0].clone(), None],
        vec![Some("{\"id\":".into()), good[1].clone()],
        vec![good[0].clone()],
        vec![],
    ] {
        let trie = w.trie.clone();
        assert_eq!(w.predict(PEOPLE[0], 1, None, Pick::A, &bad), Ok(false));
        assert_eq!(w.trie, trie, "a refused prediction stores nothing");
    }
    let mut a = a;
    a.chaos = vec!["Pending"];
    let mut odd = a.chaos_json();
    odd = odd.replace("\"Pending\"", "\"Maybe\"");
    assert_eq!(
        w.predict(PEOPLE[0], 1, Some(0), Pick::Held, &[Some(odd)]),
        Ok(false)
    );
}

#[test]
fn settle_scores_each_market_once_and_ranks_the_board() {
    let mut w = World::new();
    let mut a = ArenaSim::open(T0);
    a.chaos = vec!["Pending", "Pending"];
    let c0 = a.predict_answers(5, Some(0));
    let d = a.predict_answers(5, None);
    w.predict(PEOPLE[0], 5, Some(0), Pick::Held, &c0).unwrap();
    w.predict(PEOPLE[1], 5, Some(0), Pick::Flipped, &c0)
        .unwrap();
    w.predict(PEOPLE[2], 5, Some(0), Pick::Held, &c0).unwrap();
    w.predict(PEOPLE[0], 5, Some(1), Pick::Held, &c0).unwrap();
    w.predict(PEOPLE[0], 5, None, Pick::A, &d).unwrap();
    w.predict(PEOPLE[1], 5, None, Pick::Tie, &d).unwrap();
    let m = market(&w, 5, Some(0));
    assert_eq!(
        (m.picks[0].pick, m.picks[0].n, m.picks[1].n, m.total),
        (Pick::Flipped, 1, 2, 3)
    );

    // injection 0 is decided, 1 still pending, the duel still open: only market 0 scores
    a.chaos[0] = "Held";
    assert_eq!(w.settle(5, &a.settle_answers(5)), Ok(0));
    assert_eq!(market(&w, 5, Some(0)).outcome, Some(Pick::Held));
    assert!(!market(&w, 5, Some(1)).settled && !market(&w, 5, None).settled);
    assert_eq!(
        held(&w, PEOPLE[0])
            .iter()
            .map(|p| p.verdict)
            .collect::<Vec<_>>(),
        vec![Some(Verdict::Right), None, None]
    );
    // settling again scores nothing twice
    assert_eq!(w.settle(5, &a.settle_answers(5)), Ok(0));
    assert_eq!(stats(&w, PEOPLE[0]).count, 1);

    // the duel resolves (a wins): injection 1 expires (void), the duel market scores
    a.resolve(0);
    w.now = a.close_at + SEC;
    assert_eq!(w.settle(5, &a.settle_answers(5)), Ok(0));
    assert_eq!(market(&w, 5, Some(1)).outcome, None);
    assert!(market(&w, 5, Some(1)).settled);
    assert_eq!(
        stats(&w, PEOPLE[0]),
        Stats {
            count: 2,
            right: 2,
            streak: 2,
            best: 2
        }
    );
    assert_eq!(
        stats(&w, PEOPLE[1]),
        Stats {
            count: 2,
            right: 0,
            streak: 0,
            best: 0
        }
    );
    let board = w.view(|c| c.get_board(0, 10));
    let names: Vec<String> = board.iter().map(|r| r.account.to_string()).collect();
    assert_eq!(names, vec![PEOPLE[0], PEOPLE[2], PEOPLE[1]]);

    // claims pay every scored deposit, void ones included, once
    assert_eq!(w.claim(PEOPLE[0]), Ok(3 * DEPOSIT));
    assert_eq!(w.claim(PEOPLE[0]), Err("nothing to claim".into()));
    assert_eq!(w.claim(PEOPLE[1]), Ok(2 * DEPOSIT));
    assert_eq!(w.claim(PEOPLE[2]), Ok(DEPOSIT));
    assert_eq!(w.balance, START, "every deposit went back");
    assert!(held(&w, PEOPLE[0]).is_empty());
}

#[test]
fn void_duel_and_no_trial_refund_without_scoring() {
    let mut w = World::new();
    let mut a = ArenaSim::open(T0);
    a.chaos = vec!["Pending"];
    w.predict(PEOPLE[0], 2, None, Pick::Tie, &a.predict_answers(2, None))
        .unwrap();
    w.predict(
        PEOPLE[0],
        2,
        Some(0),
        Pick::Held,
        &a.predict_answers(2, Some(0)),
    )
    .unwrap();
    a.chaos[0] = "NoTrial";
    a.resolve(3); // voided: the arena records a tie with no prices
    w.settle(2, &a.settle_answers(2)).unwrap();
    assert_eq!(
        held(&w, PEOPLE[0])
            .iter()
            .map(|p| p.verdict)
            .collect::<Vec<_>>(),
        vec![Some(Verdict::Void), Some(Verdict::Void)]
    );
    assert_eq!(w.view(|c| c.get_stats(PEOPLE[0].parse().unwrap())), None);
    assert_eq!(w.claim(PEOPLE[0]), Ok(2 * DEPOSIT));
}

#[test]
fn settle_with_a_failed_or_wrong_answer_changes_nothing() {
    let mut w = World::new();
    let mut a = ArenaSim::open(T0);
    a.chaos = vec!["Pending"];
    w.predict(
        PEOPLE[0],
        4,
        Some(0),
        Pick::Held,
        &a.predict_answers(4, Some(0)),
    )
    .unwrap();
    a.chaos[0] = "Held";
    a.resolve(1);
    let good = a.settle_answers(4);
    let trie = w.trie.clone();
    for (bad, why) in [
        (vec![None, good[1].clone()], "arena failed"),
        (vec![good[0].clone(), None], "arena failed"),
        (vec![good[0].clone()], "arena failed"),
        (
            vec![Some("[1]".into()), good[1].clone()],
            "arena answer unreadable",
        ),
        (
            vec![
                good[0].clone(),
                Some(good[1].clone().unwrap().replace("Held", "Won")),
            ],
            "arena answer unreadable",
        ),
        (vec![Some("null".into()), good[1].clone()], "duel missing"),
        (
            vec![Some(a.duel_json(5)), good[1].clone()],
            "arena answer unreadable",
        ),
    ] {
        assert_eq!(w.settle(4, &bad), Err(why.into()));
        assert_eq!(w.trie, trie);
    }
    assert_eq!(w.settle(4, &good), Ok(0));
    assert_ne!(w.trie, trie);
}

#[test]
fn settle_scores_in_pages() {
    let mut w = World::new();
    let mut a = ArenaSim::open(T0);
    let people: Vec<String> = (0..120).map(|i| format!("p{i}.testnet")).collect();
    let ans = a.predict_answers(6, None);
    for p in &people {
        w.predict(p, 6, None, Pick::B, &ans).unwrap();
    }
    a.resolve(1);
    let ans = a.settle_answers(6);
    assert_eq!(w.settle(6, &ans), Ok(120 - SCORE_PAGE));
    assert_eq!(w.settle(6, &ans), Ok(120 - 2 * SCORE_PAGE));
    assert_eq!(w.settle(6, &ans), Ok(0));
    for p in &people {
        assert_eq!(stats(&w, p).right, 1);
    }
}

#[test]
fn deposit_covers_the_largest_prediction() {
    // the deposit pays what `claim` frees: the entry, and the held list created with the first one
    let mut w = World::new();
    let a = ArenaSim::open(T0);
    for d in [1, 2] {
        w.predict(PEOPLE[0], d, None, Pick::A, &a.predict_answers(d, None))
            .unwrap(); // the market records are the contract's
    }
    let implicit = "a".repeat(64);
    let mut grew = vec![];
    for d in [1, 2] {
        let before = w.usage;
        w.predict(&implicit, d, None, Pick::B, &a.predict_answers(d, None))
            .unwrap();
        grew.push(w.usage - before);
    }
    assert_eq!(
        grew,
        vec![264, 151],
        "bytes a 64-character account's predictions add"
    );
    let cost = grew[0] as u128 * env::storage_byte_cost().as_yoctonear();
    assert!(cost <= DEPOSIT, "{cost} > DEPOSIT");
    // claim frees exactly those bytes
    let mut a = a;
    a.resolve(1);
    w.settle(1, &a.settle_answers(1)).unwrap();
    w.settle(2, &a.settle_answers(2)).unwrap();
    let before = w.usage;
    assert_eq!(w.claim(&implicit), Ok(2 * DEPOSIT));
    assert!(
        before - w.usage >= 264 + 151 - 2 * 8,
        "claim frees the entries and the list"
    );
}

// ---------------------------------------------------------------- property tests

#[derive(Clone, Debug)]
enum Op {
    /// `who`, duel 0 or 1, market (None or an injection index), pick, the answer's fate.
    Predict(usize, u64, Option<u32>, Pick, Fate),
    /// Plant a pending injection.
    Inject(u64),
    /// The target of injection `i` commits its next call (or a keyless slot carries it).
    Fix(u64, u32),
    /// Decide an injection: Flipped, Held, NoTrial.
    Decide(u64, u32, u8),
    /// Time passes by this many seconds.
    Wait(u64),
    /// Close and resolve the duel: 0 a, 1 b, 2 tie, 3 void.
    Resolve(u64, u8),
    Settle(u64, Fate),
    Claim(usize),
}

#[derive(Clone, Copy, Debug)]
enum Fate {
    Honest,
    Failed,
    Garbage,
    OtherDuel,
}

fn fate() -> impl Strategy<Value = Fate> {
    prop_oneof![
        6 => Just(Fate::Honest),
        1 => Just(Fate::Failed),
        1 => Just(Fate::Garbage),
        1 => Just(Fate::OtherDuel),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    let pick = prop_oneof![
        Just(Pick::Flipped),
        Just(Pick::Held),
        Just(Pick::A),
        Just(Pick::B),
        Just(Pick::Tie)
    ];
    prop_oneof![
        8 => (0..3usize, 0..2u64, prop::option::of(0..3u32), pick, fate())
            .prop_map(|(w, d, i, p, f)| Op::Predict(w, d, i, p, f)),
        3 => (0..2u64).prop_map(Op::Inject),
        2 => (0..2u64, 0..3u32).prop_map(|(d, i)| Op::Fix(d, i)),
        4 => (0..2u64, 0..3u32, 0..3u8).prop_map(|(d, i, o)| Op::Decide(d, i, o)),
        2 => (0..120u64).prop_map(Op::Wait),
        2 => (0..2u64, 0..4u8).prop_map(|(d, r)| Op::Resolve(d, r)),
        5 => (0..2u64, fate()).prop_map(|(d, f)| Op::Settle(d, f)),
        3 => (0..3usize).prop_map(Op::Claim),
    ]
}

fn spoil(answers: Vec<Answer>, f: Fate, other: Vec<Answer>) -> Vec<Answer> {
    match f {
        Fate::Honest => answers,
        Fate::Failed => answers.into_iter().map(|_| None).collect(),
        Fate::Garbage => answers
            .into_iter()
            .map(|a| a.map(|s| s[..s.len() / 2].to_string()))
            .collect(),
        Fate::OtherDuel => other,
    }
}

/// What the model expects of one accepted prediction.
#[derive(Clone, Debug)]
struct Made {
    who: usize,
    duel: u64,
    index: Option<u32>,
    pick: Pick,
    /// Set once, at the settle that fixed its market.
    verdict: Option<Verdict>,
    claimed: bool,
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: std::env::var("PROPTEST_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(256),
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn deposits_conserved_scored_once_never_after_close(
        ops in vec(op(), 1..80),
        legacy in any::<bool>(),
    ) {
        let mut w = World::new();
        let mut arena = [ArenaSim::open(T0), ArenaSim::open(T0 + 100 * SEC)];
        for a in arena.iter_mut() {
            a.legacy = legacy;
        }
        let mut made: Vec<Made> = vec![];
        for op in ops {
            match op {
                Op::Predict(who, d, index, pick, f) => {
                    let other = arena[d as usize].predict_answers(d + 1, index);
                    let ans = spoil(arena[d as usize].predict_answers(d, index), f, other);
                    let open = arena[d as usize].open_at(index, w.now);
                    if let Ok(true) = w.predict(PEOPLE[who], d, index, pick, &ans) {
                        // accepted only on an honest answer showing the market open; get_chaos
                        // carries no duel id, so another duel's list reads like this one's
                        let honest = matches!(f, Fate::Honest)
                            || (matches!(f, Fate::OtherDuel) && index.is_some());
                        prop_assert!(honest && open, "accepted after close or on a bad answer");
                        made.push(Made { who, duel: d, index, pick, verdict: None, claimed: false });
                    }
                }
                Op::Fix(d, i) => arena[d as usize].fixed |= 1 << i,
                Op::Inject(d) => {
                    let a = &mut arena[d as usize];
                    if !a.resolved && a.chaos.len() < 4 {
                        a.chaos.push("Pending");
                    }
                }
                Op::Decide(d, i, o) => {
                    let a = &mut arena[d as usize];
                    if a.chaos.get(i as usize) == Some(&"Pending") {
                        a.chaos[i as usize] = ["Flipped", "Held", "NoTrial"][o as usize];
                    }
                }
                Op::Wait(s) => w.now += s * SEC,
                Op::Resolve(d, r) => {
                    let a = &mut arena[d as usize];
                    if !a.resolved {
                        w.now = w.now.max(a.close_at);
                        a.resolve(r);
                    }
                }
                Op::Settle(d, f) => {
                    let a = &arena[d as usize];
                    let ans = spoil(a.settle_answers(d), f, a.settle_answers(d + 1));
                    let trie = w.trie.clone();
                    let r = w.settle(d, &ans);
                    if matches!(f, Fate::Honest) {
                        prop_assert_eq!(r, Ok(0), "one page settles this world");
                        for m in made.iter_mut().filter(|m| m.duel == d && m.verdict.is_none()) {
                            if let Some(won) = a.outcome(m.index) {
                                m.verdict = Some(match won {
                                    None => Verdict::Void,
                                    Some(p) if p == m.pick => Verdict::Right,
                                    Some(_) => Verdict::Wrong,
                                });
                            }
                        }
                    } else {
                        prop_assert!(r.is_err(), "a bad answer must revert: {:?}", f);
                        prop_assert!(w.trie == trie, "a bad answer changed state");
                    }
                }
                Op::Claim(who) => {
                    let due = made.iter().filter(|m| m.who == who && !m.claimed && m.verdict.is_some()).count();
                    let r = w.claim(PEOPLE[who]);
                    if due == 0 {
                        prop_assert_eq!(r, Err("nothing to claim".to_string()));
                    } else {
                        prop_assert_eq!(r, Ok(due as u128 * DEPOSIT));
                        for m in made.iter_mut().filter(|m| m.who == who && m.verdict.is_some()) {
                            m.claimed = true;
                        }
                    }
                }
            }
            // deposits conserved: the contract holds exactly one deposit per unclaimed prediction
            let unclaimed = made.iter().filter(|m| !m.claimed).count() as u128;
            prop_assert_eq!(w.balance, START + unclaimed * DEPOSIT);
            for (who, p) in PEOPLE.iter().enumerate() {
                // each held prediction carries the verdict the model gave it, set once
                let mine: Vec<&Made> = made.iter().filter(|m| m.who == who && !m.claimed).collect();
                let got = held(&w, p);
                prop_assert_eq!(got.len(), mine.len());
                for (g, m) in got.iter().zip(&mine) {
                    prop_assert_eq!((g.duel_id.0, g.index, g.pick, g.verdict), (m.duel, m.index, m.pick, m.verdict));
                }
                // scored exactly once: the board counts each non-void verdict once
                let all: Vec<&Made> = made.iter().filter(|m| m.who == who).collect();
                let s = stats(&w, p);
                let count = all.iter().filter(|m| matches!(m.verdict, Some(Verdict::Right | Verdict::Wrong))).count();
                let right = all.iter().filter(|m| m.verdict == Some(Verdict::Right)).count();
                prop_assert_eq!((s.count as usize, s.right as usize), (count, right));
                prop_assert!(s.streak <= s.best && s.best <= s.right);
            }
            // the crowd split counts every accepted prediction once
            for d in 0..2u64 {
                for m in w.view(|c| c.get_duel_markets(U64(d))) {
                    let n = made.iter().filter(|x| x.duel == d && x.index == m.index).count() as u32;
                    prop_assert_eq!(m.total, n);
                    prop_assert_eq!(m.picks.iter().map(|p| p.n).sum::<u32>(), n);
                    prop_assert!(m.scored <= m.total && (m.scored == 0 || m.settled));
                }
            }
        }
    }
}
