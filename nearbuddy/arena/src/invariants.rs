//! Property tests over random operation sequences: money conservation, bond and vault bounds,
//! mandate limits, duel finality and slash arithmetic; from deploy 15 also verified settlement
//! (fills credited only against delivered, unaccounted output; sum(holdings) == accounted per token),
//! `withdraw_token` (debit first, exact re-credit on a failed transfer), the vault delay (never paid
//! before `withdraw_delay`) and `sweep_surplus` (bounded to the surplus, never touches accounted);
//! from deploy 16 `vault_total == sum(vaults)`, no deposit past `max_vault_per_account`, and no fill
//! settled for an intent accepted at or after its mandate's revoke or expiry, or while the follower
//! was not following (a mandate update keeps the window; a closed window keeps its grace); from
//! deploy 17 every settled fill meets the terms in force when its intent was accepted (a tightening
//! update binds later intents, the replaced terms bind earlier ones for the grace and no longer).
//!
//! Every operation runs like a transaction on chain: the contract is read from the mocked trie,
//! the method runs, and on success the struct is written back and the collections flushed. A
//! panic discards every write (the trie snapshot is kept), as the runtime reverts a failed receipt.
//! The contract balance is the mocked `env::account_balance()`: the VM credits the attached deposit
//! before the call and the VM debits every outgoing transfer and function-call deposit.
//!
//! Each case draws the owner settings (slash, fee and no-reveal bps, commit-reveal, consent), runs
//! a setup prefix (agents, vaults, mandates, two duels, a few intents or commitments) and then up
//! to 40 random operations. Default 64 cases, about 20 s. More cases (1000 take about 5 min):
//! `PROPTEST_CASES=1000 cargo test --lib invariants`.
#![cfg(test)]

use std::any::{Any, TypeId};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Once;

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::mock::{MockAction, with_mocked_blockchain};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
use near_sdk::{AccountId, MockedBlockchain, NearToken, PromiseResult, env, test_vm_config};
use proptest::collection::vec;
use proptest::prelude::*;
use proptest::test_runner::Config as PropConfig;

use crate::tests::{
    CONTRACT, INTENTS, MIN_CHAOS, MODEL_A, NEAR, NOW, ORACLE, ORACLE_DEPOSIT, OWNER, SOLVER,
    VAULT_CAP, key, register_sig, sign,
};
use crate::*;

const AGENTS: usize = 4;
/// Vault holders; the last one is the solver, credited by `settle_follow`.
const ACCOUNTS: [&str; 4] = ["f0.testnet", "f1.testnet", "f2.testnet", SOLVER];
const SOLVER_IX: usize = 3;
const TEE_SEED: u8 = 7;
const START_BALANCE: u128 = 100 * NEAR;
const SEC: u64 = 1_000_000_000;
const MILLI: u128 = NEAR / 1_000;
const OPEN_PRICE: u64 = 366_000_000;
/// Token ids the fills, deliveries and withdrawals use; index 0 is the `wrap` side.
const TOKENS: [&str; 2] = ["wrap.near", "usdc.near"];
/// `withdraw_delay_ns` default: the vault delay and the grace a fronted fill keeps.
const DELAY: u64 = 900 * SEC;

fn agent_owner(i: usize) -> String {
    format!("op{i}.testnet")
}
/// Even agents are TEE-backed (followable, need a proof per intent); odd ones are plain.
fn is_tee(i: usize) -> bool {
    i.is_multiple_of(2)
}

/// `FillSpec.nonce` for the agent's newest posted nonce.
const LATEST: usize = usize::MAX;

#[derive(Clone, Debug)]
struct FillSpec {
    /// Index into the agent's posted nonces; past the end means a nonce never posted.
    nonce: usize,
    milli: u64,
    wrap: bool,
    /// Output units claimed; checked against the floor and the delivered, unaccounted balance.
    out: u64,
}

#[derive(Clone, Debug)]
enum Op {
    Register {
        agent: usize,
        milli: u64,
    },
    Deposit {
        who: usize,
        milli: u64,
    },
    /// `request_withdraw`: queue a vault withdrawal.
    Withdraw {
        who: usize,
        milli: u64,
    },
    /// `withdraw`: pay the queued withdrawal once its delay passed; `fail` = the transfer bounces.
    Claim {
        who: usize,
        fail: bool,
        /// Claim before the delay instead of moving the clock to it.
        early: bool,
    },
    /// A swap output landing in the arena's intents balance (the stub's `stub_credit`).
    Deliver {
        wrap: bool,
        units: u64,
    },
    /// `withdraw_token`, then its callback with the transfer succeeding or failing.
    WithdrawToken {
        who: usize,
        wrap: bool,
        /// Percent of the holding (over 100 = more than held, refused).
        pct: u16,
        fail: bool,
    },
    /// Owner `sweep_surplus`, its balance check, then the transfer's callback.
    Sweep {
        wrap: bool,
        /// Percent of the unaccounted surplus (over 100 = more than free, refused).
        pct: u16,
        fail: bool,
    },
    Follow {
        who: usize,
        agent: usize,
        allowance: u64,
        cap: u64,
        spent_pct: u8,
        only_wrap: bool,
        /// `expires_at - now` in seconds; 0 or below is an expiry at or before now (a backdated
        /// update closes the mandate at once).
        ttl_s: i64,
        revoked: bool,
        /// `min_out_per_near`; 0 is refused by `follow`.
        floor: u64,
    },
    Unfollow {
        who: usize,
        agent: usize,
    },
    Open {
        a: usize,
        b: usize,
        len_s: u64,
        milli: u64,
        open_price: bool,
        /// Through `open_duel_consented`; always when `require_consent` is on.
        consented: bool,
    },
    /// `post_intent`, or `commit_intent` when commit-reveal is on.
    Post {
        duel: usize,
        b_side: bool,
        long: bool,
        size_bps: u16,
        reuse_nonce: bool,
    },
    /// `reveal_intent` of a pending commitment; `late` moves the clock inside the intent lock.
    Reveal {
        pick: usize,
        late: bool,
    },
    /// `inject_chaos` paying the model's price plus `milli`, or one yocto under it with `under`.
    Chaos {
        duel: usize,
        b_side: bool,
        milli: u64,
        /// Paid by the owner of side a (shield farming): a fee, never shield.
        own: bool,
        /// 0 Long, 1 Short, 2 Placebo (paid by the contract owner).
        kind: u8,
        under: bool,
    },
    /// `claim_chaos` by an injector owed something (or anyone, when nobody is), then its callback
    /// with the transfer landing or, with `fail`, bouncing.
    ClaimChaos {
        pick: usize,
        fail: bool,
    },
    Resolve {
        duel: usize,
        move_bps: i64,
    },
    Settle {
        who: usize,
        agent: usize,
        fills: Vec<FillSpec>,
    },
    Void {
        duel: usize,
    },
    WithdrawBond {
        agent: usize,
        milli: u64,
    },
    WithdrawFees,
    /// Owner `begin_reconcile`.
    ReconcileBegin,
    /// Owner `reconcile_page` of the next `n` vault holders in account order; `repeat` re-lists the
    /// last one counted (refused: a holder is never counted twice).
    ReconcilePage {
        n: usize,
        repeat: bool,
    },
    /// Owner pages the holders left, then `finish_reconcile`: `vault_total` must equal the sum of
    /// vaults whatever moved between the pages.
    ReconcileFinish,
    Advance {
        secs: u64,
    },
}

/// Mostly the TEE agents (0, 2), the only ones that can be followed; sometimes any agent.
fn followable() -> impl Strategy<Value = usize> + Clone {
    prop_oneof![3 => prop_oneof![Just(0usize), Just(2)], 1 => 0..AGENTS]
}

fn follow(
    who: impl Strategy<Value = usize>,
    agent: impl Strategy<Value = usize>,
) -> impl Strategy<Value = Op> {
    let spent_pct = prop_oneof![Just(0u8), 0u8..=100];
    let ttl_s = prop_oneof![
        1 => -3_000i64..0,
        1 => Just(0i64),
        2 => 1i64..300,
        8 => 300i64..7_200,
    ];
    (
        who,
        agent,
        1u64..3_000,
        1u64..1_500,
        spent_pct,
        any::<bool>(),
        ttl_s,
        prop::bool::weighted(0.1),
        prop_oneof![1 => Just(0u64), 9 => 1u64..2_000_000],
    )
        .prop_map(
            |(who, agent, allowance, cap, spent_pct, only_wrap, ttl_s, revoked, floor)| {
                Op::Follow {
                    who,
                    agent,
                    allowance,
                    cap,
                    spent_pct,
                    only_wrap,
                    ttl_s,
                    revoked,
                    floor,
                }
            },
        )
}

/// Registers every agent, funds the three followers, attaches six mandates on the TEE agents,
/// opens two duels and posts (or commits and reveals) a few intents, so the random tail reaches
/// fills and decided duels instead of reverting on missing state.
fn setup() -> impl Strategy<Value = Vec<Op>> {
    let regs = vec(10u64..3_000, AGENTS).prop_map(|m| {
        m.into_iter()
            .enumerate()
            .map(|(agent, milli)| Op::Register { agent, milli })
            .collect::<Vec<_>>()
    });
    let deps = vec(500u64..3_000, 3).prop_map(|m| {
        m.into_iter()
            .enumerate()
            .map(|(who, milli)| Op::Deposit { who, milli })
            .collect::<Vec<_>>()
    });
    let follows = vec(
        (0..3usize, prop_oneof![Just(0usize), Just(2)])
            .prop_flat_map(|(w, a)| follow(Just(w), Just(a))),
        6,
    );
    let opens = (60u64..600, 60u64..600).prop_map(|(x, y)| {
        vec![
            Op::Open {
                a: 0,
                b: 1,
                len_s: x,
                milli: 10,
                open_price: true,
                consented: false,
            },
            Op::Open {
                a: 2,
                b: 3,
                len_s: y,
                milli: 10,
                open_price: true,
                consented: true,
            },
        ]
    });
    // agent 0 (TEE) in duel 0 makes a call (mostly against the first lie), then two headlines are
    // planted at it (a spectator's mostly; an agent owner's or a placebo sometimes); with
    // commit-reveal on, that call is revealed (the decision before) and a second later it commits
    // again and reveals (the decision that decides both: flipped, held or no trial); sometimes the
    // first call is replaced unrevealed instead, which voids both headlines (no trial)
    let plant = (
        prop_oneof![8 => 0u8..2, 1 => Just(2u8)],
        prop::bool::weighted(0.15),
        0u64..300,
    )
        .prop_map(|(kind, own, milli)| Op::Chaos {
            duel: 0,
            b_side: false,
            milli,
            own,
            kind,
            under: false,
        });
    let fool = (
        plant.clone(),
        plant,
        prop::bool::weighted(0.8),
        any::<bool>(),
        prop::bool::weighted(0.75),
    )
        .prop_map(|(first, second, against, long, reveal_first)| {
            let lie_long = matches!(first, Op::Chaos { kind: 0, .. });
            let mut ops = vec![
                Op::Post {
                    duel: 0,
                    b_side: false,
                    long: lie_long != against,
                    size_bps: 5_000,
                    reuse_nonce: false,
                },
                first,
                second,
                Op::Reveal {
                    pick: 0,
                    late: false,
                },
                Op::Advance { secs: 1 },
                Op::Post {
                    duel: 0,
                    b_side: false,
                    long,
                    size_bps: 5_000,
                    reuse_nonce: false,
                },
                Op::Reveal {
                    pick: 0,
                    late: false,
                },
            ];
            if !reveal_first {
                ops.remove(3);
            }
            ops
        });
    (
        regs,
        deps,
        follows,
        opens,
        vec(post(), 4..8),
        vec(reveal(), 2..4),
        fool,
        -500i64..500,
    )
        .prop_map(|(r, d, f, o, p, v, fool, move_bps)| {
            // outputs already delivered to the arena, so early settles find a receipt
            let deliver = vec![
                Op::Deliver {
                    wrap: true,
                    units: 5_000_000,
                },
                Op::Deliver {
                    wrap: false,
                    units: 5_000_000,
                },
            ];
            // follower 0 settles agent 0's intents once inside the closed window's grace and once past
            // it (round 3: the window before the unfollow is honoured for the grace, then refused)
            let spec = |nonce| FillSpec {
                nonce,
                milli: 10,
                wrap: true,
                out: 1_000,
            };
            let late_fills = vec![
                Op::Settle {
                    who: 0,
                    agent: 0,
                    fills: vec![spec(0)],
                },
                // follower 1 tightened its cap below these fills mid-way (`tighten1`): intents
                // before the update settle on the old terms inside its grace, later ones are over
                // the cap, and the rest are refused past the grace ("mandate updated")
                Op::Settle {
                    who: 1,
                    agent: 0,
                    fills: (0..6).step_by(2).map(spec).collect(),
                },
                Op::Settle {
                    who: 2,
                    agent: 0,
                    fills: (0..6).map(spec).collect(),
                },
                Op::Advance { secs: DELAY / SEC },
                Op::Settle {
                    who: 0,
                    agent: 0,
                    fills: (1..6).map(spec).collect(),
                },
                Op::Settle {
                    who: 1,
                    agent: 0,
                    fills: (1..6).step_by(2).map(spec).collect(),
                },
            ];
            // follower 0 drops agent 0 a second in and follows it again a second later, between the
            // posts: agent 0's intents fall before, inside and after the unfollowed window, so the
            // deploy-16 accept-time rules (revoke, re-follow) are reached in every case
            let third = p.len() / 3;
            let (p0, rest) = p.split_at(third);
            let (p1, p2) = rest.split_at(third);
            let revoke = vec![Op::Advance { secs: 1 }, Op::Unfollow { who: 0, agent: 0 }];
            let refollow_op = Op::Follow {
                who: 0,
                agent: 0,
                allowance: 2_000,
                cap: 1_000,
                spent_pct: 0,
                only_wrap: false,
                ttl_s: 7_200,
                revoked: false,
                floor: 1,
            };
            // follower 1 follows agent 0 from the start and updates its mandate mid-way: a live update
            // keeps the window, so its earlier intents still settle (round 3)
            let follow1 = |op: &Op| match op.clone() {
                Op::Follow {
                    allowance,
                    cap,
                    spent_pct,
                    only_wrap,
                    ttl_s,
                    revoked,
                    floor,
                    ..
                } => Op::Follow {
                    who: 1,
                    agent: 0,
                    allowance,
                    cap,
                    spent_pct,
                    only_wrap,
                    ttl_s,
                    revoked,
                    floor,
                },
                other => other,
            };
            let first1 = vec![follow1(&refollow_op)];
            let update1 = vec![follow1(&refollow_op)];
            // then it tightens the cap below the late fills (deploy 17): earlier intents keep the
            // old terms for the grace; a second tightening inside it is "update too soon"; a
            // loosening (same cap, later expiry) never waits
            let terms = |who, cap, ttl_s| Op::Follow {
                who,
                agent: 0,
                allowance: 2_000,
                cap,
                spent_pct: 0,
                only_wrap: false,
                ttl_s,
                revoked: false,
                floor: 1,
            };
            let tighten1 = vec![
                Op::Advance { secs: 1 },
                terms(1, 5, 7_200),
                Op::Advance { secs: 1 },
                terms(1, 4, 7_200),
                terms(1, 5, 7_300),
            ];
            // follower 2 follows agent 0 from the start, then (red team, deploy 17) moves the
            // expiry before its fronted intents and restores it in the same block: the window
            // still closes no earlier than that update, so the late fills settle in its grace
            let first2 = vec![terms(2, 1_000, 7_200)];
            let backdate2 = vec![
                Op::Advance { secs: 1 },
                terms(2, 1_000, -3_000),
                terms(2, 1_000, 7_200),
            ];
            // a second unfollow and re-follow inside the first gap's grace is refused (two windows fit)
            let cycle = vec![
                Op::Advance { secs: 1 },
                Op::Unfollow { who: 0, agent: 0 },
                Op::Advance { secs: 1 },
                refollow_op.clone(),
            ];
            // the same follow again a second later is a mandate update while following (round 3)
            let refollow = vec![
                Op::Advance { secs: 1 },
                refollow_op.clone(),
                Op::Advance { secs: 1 },
                refollow_op,
            ];
            [
                r,
                d,
                f,
                o,
                first1,
                first2,
                p0.to_vec(),
                fool,
                revoke,
                p1.to_vec(),
                refollow,
                update1,
                tighten1,
                backdate2,
                p2.to_vec(),
                cycle,
                v,
                deliver,
                // a paged reconcile spans the late fills: f0 is counted, then its vault moves
                vec![
                    Op::ReconcileBegin,
                    Op::ReconcilePage {
                        n: 1,
                        repeat: false,
                    },
                    Op::Deposit { who: 0, milli: 1 },
                    Op::ReconcilePage { n: 1, repeat: true },
                ],
                late_fills,
                // past `tighten1`'s grace, follower 1 tightens again: intents from before the
                // first update stay refused instead of meeting the second one's old terms
                vec![
                    terms(1, 4, 7_200),
                    Op::Settle {
                        who: 1,
                        agent: 0,
                        fills: (0..6).map(spec).collect(),
                    },
                ],
                vec![Op::ReconcileFinish],
                // duel 0 (closed by now) finishes: its headlines settle and their injectors claim
                vec![
                    Op::Resolve { duel: 0, move_bps },
                    // the first transfer bounces (a deleted account), the retry lands
                    Op::ClaimChaos {
                        pick: 0,
                        fail: true,
                    },
                    Op::ClaimChaos {
                        pick: 0,
                        fail: false,
                    },
                    Op::ClaimChaos {
                        pick: 1,
                        fail: false,
                    },
                ],
            ]
            .concat()
        })
}

fn chaos() -> impl Strategy<Value = Op> {
    (
        0..8usize,
        any::<bool>(),
        0u64..300,
        prop::bool::weighted(0.25),
        prop_oneof![4 => 0u8..2, 1 => Just(2u8)],
        prop::bool::weighted(0.1),
    )
        .prop_map(|(duel, b_side, milli, own, kind, under)| Op::Chaos {
            duel,
            b_side,
            milli,
            own,
            kind,
            under,
        })
}

fn reveal() -> impl Strategy<Value = Op> {
    (0..8usize, prop::bool::weighted(0.3)).prop_map(|(pick, late)| Op::Reveal { pick, late })
}

fn post() -> impl Strategy<Value = Op> {
    (
        0..8usize,
        any::<bool>(),
        any::<bool>(),
        0u16..=10_001,
        prop::bool::weighted(0.1),
    )
        .prop_map(|(duel, b_side, long, size_bps, reuse_nonce)| Op::Post {
            duel,
            b_side,
            long,
            size_bps,
            reuse_nonce,
        })
}

fn op() -> impl Strategy<Value = Op> {
    let ag = 0..AGENTS;
    let fol = 0..3usize;
    let fill = (
        prop_oneof![3 => 0..6usize, 1 => Just(LATEST)],
        prop_oneof![3 => 0u64..300, 1 => 0u64..1_500],
        any::<bool>(),
        prop_oneof![1 => Just(0u64), 9 => 0u64..3_000_000],
    )
        .prop_map(|(nonce, milli, wrap, out)| FillSpec {
            nonce,
            milli,
            wrap,
            out,
        });
    prop_oneof![
        1 => (ag.clone(), 0u64..3_000).prop_map(|(agent, milli)| Op::Register { agent, milli }),
        2 => (0..4usize, 0u64..3_000).prop_map(|(who, milli)| Op::Deposit { who, milli }),
        1 => (0..4usize, 0u64..2_000).prop_map(|(who, milli)| Op::Withdraw { who, milli }),
        3 => (0..4usize, prop::bool::weighted(0.3), prop::bool::weighted(0.2)).prop_map(|(who, fail, early)| Op::Claim { who, fail, early }),
        4 => (any::<bool>(), 1u64..3_000_000).prop_map(|(wrap, units)| Op::Deliver { wrap, units }),
        4 => (0..3usize, any::<bool>(), 1u16..=120, prop::bool::weighted(0.3)).prop_map(|(who, wrap, pct, fail)| Op::WithdrawToken { who, wrap, pct, fail }),
        1 => (any::<bool>(), 1u16..=120, prop::bool::weighted(0.3)).prop_map(|(wrap, pct, fail)| Op::Sweep { wrap, pct, fail }),
        2 => follow(fol.clone(), followable()),
        3 => (fol.clone(), followable()).prop_map(|(who, agent)| Op::Unfollow { who, agent }),
        // b = a + 1..=3 (mod 4): the same-agent refusal is covered by the unit tests
        4 => (ag.clone(), 1..AGENTS, 30u64..600, 0u64..20, prop::bool::weighted(0.85), any::<bool>())
            .prop_map(|(a, off, len_s, milli, open_price, consented)| Op::Open { a, b: (a + off) % AGENTS, len_s, milli, open_price, consented }),
        10 => post(),
        6 => reveal(),
        4 => chaos(),
        2 => (0..8usize, prop::bool::weighted(0.25)).prop_map(|(pick, fail)| Op::ClaimChaos { pick, fail }),
        3 => (0..8usize, prop_oneof![Just(0i64), -500i64..500]).prop_map(|(duel, move_bps)| Op::Resolve { duel, move_bps }),
        5 => (fol, followable(), vec(fill, 0..5)).prop_map(|(who, agent, fills)| Op::Settle { who, agent, fills }),
        1 => (0..8usize).prop_map(|duel| Op::Void { duel }),
        1 => (ag, 0u64..3_000).prop_map(|(agent, milli)| Op::WithdrawBond { agent, milli }),
        1 => Just(Op::WithdrawFees),
        1 => Just(Op::ReconcileBegin),
        2 => (1usize..3, prop::bool::weighted(0.2)).prop_map(|(n, repeat)| Op::ReconcilePage { n, repeat }),
        1 => Just(Op::ReconcileFinish),
        2 => (1u64..400).prop_map(|secs| Op::Advance { secs }),
        // past a closed window's grace in one step, so its fronted intents are seen to expire
        1 => Just(Op::Advance { secs: DELAY / SEC }),
    ]
}

/// One `make()` per thread and type: `test_vm_config` builds the config of every protocol version,
/// which dominated the run time when called per transaction.
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

thread_local!(static QUIET: Cell<bool> = const { Cell::new(false) });

/// Runs `f` with the panic message of expected contract reverts suppressed on this thread only.
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

/// Arithmetic and unwrap panics are contract bugs, not reverts.
fn is_bug(msg: &str) -> bool {
    msg.starts_with("attempt to") || msg.contains("called `Option::unwrap()`")
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    /// Moves value between liabilities and in/out transfers only: `balance - liabilities` is fixed.
    Neutral,
    /// Keeps the storage it adds (new records plus growth, freed bytes not refunded), paid out of
    /// the value the caller brings or the agent's bond.
    PaysStorage,
    /// Keeps exactly this much (the 1 yocto an owner or exit call attaches and does not forward;
    /// minus 1 when a callback forwards the yocto it holds).
    Exact(i128),
}

struct DuelM {
    a: usize,
    b: usize,
    close_at: u64,
    /// Per accepted injection: (aimed at side b, paid by an agent owner or a placebo).
    chaos: Vec<(bool, bool)>,
    /// Per accepted injection, the model's record (deploy 17).
    recs: Vec<ChaosM>,
    /// Borsh bytes at the first check that saw it finished; must never change afterwards.
    final_bytes: Option<Vec<u8>>,
}

/// The model of one `Chaos` record, written apart from the contract's rules: `prev` is the last
/// decision made at or before the injection, the first counting decision after it (revealed, TEE)
/// decides once, and finishing settles each stake once.
#[derive(Clone, Debug)]
struct ChaosM {
    side_b: bool,
    /// The lie's side, `Some(true)` = Long; `None` for a placebo.
    dir: Option<bool>,
    at: u64,
    prev: Option<bool>,
    next: Option<bool>,
    outcome: ChaosOutcome,
    stake: u128,
    injector: String,
    payout: u128,
    claimed: bool,
}

/// The model's price of the `n`-th paid injection.
fn model_fee(cfg: &ChaosConfig, n: usize) -> u128 {
    let mut v = cfg.base.0;
    for _ in 0..n {
        if v >= cfg.cap.0 {
            break;
        }
        v = v * cfg.r_bps as u128 / 10_000;
    }
    v.max(MIN_CHAOS).min(cfg.cap.0)
}

/// Settles a finished duel's records in the model: `(fees, resistance credit per side, taken out of
/// the pool, shares taken from the loser's bond)`, and sets each payout. `loser_b`: `Some(true)` when
/// side b lost; `pot`: what the loser's bond pays the flips at it, at most.
fn settle_model(
    recs: &mut [ChaosM],
    loser_b: Option<bool>,
    pot: u128,
    cfg: &ChaosConfig,
) -> (u128, [u128; 2], u128, u128) {
    let at_loser = |r: &ChaosM| loser_b == Some(r.side_b) && r.outcome == ChaosOutcome::Flipped;
    let weight: u128 = recs.iter().filter(|r| at_loser(r)).map(|r| r.stake).sum();
    let (mut fees, mut credit, mut taken, mut shares) = (0, [0u128; 2], 0, 0);
    for r in recs.iter_mut() {
        if r.outcome == ChaosOutcome::Pending {
            r.outcome = ChaosOutcome::Expired;
        }
        // every stake pays the fee, whatever its outcome
        let fee = r.stake * cfg.fee_bps as u128 / 10_000;
        taken += r.stake;
        fees += fee;
        match r.outcome {
            ChaosOutcome::Held => {
                credit[r.side_b as usize] += r.stake - fee;
            }
            ChaosOutcome::Flipped => {
                // weight 0: every flip at the loser was unpaid (an owner's), nothing to split by
                let share = if at_loser(r) && weight > 0 {
                    pot * (r.stake * 10_000 / weight) / 10_000
                } else {
                    0
                };
                shares += share;
                r.payout = r.stake - fee + share;
            }
            _ => r.payout = r.stake - fee,
        }
    }
    let paid: u128 = recs.iter().map(|r| r.payout).sum();
    assert_eq!(
        taken + shares,
        paid + credit[0] + credit[1] + fees,
        "model conservation"
    );
    (fees, credit, taken, shares)
}

fn side_of(long: bool) -> Side {
    if long { Side::Long } else { Side::Short }
}

#[derive(Clone)]
struct Snap {
    bonds: [Option<u128>; AGENTS],
    shields: [Option<u32>; AGENTS],
    in_duel: [Option<u64>; AGENTS],
    vaults: [u128; 4],
    vault_total: u128,
    duels: Vec<Duel>,
    fees: u128,
    open_duels: u64,
    next_duel: u64,
    /// (agent, follower, mandate)
    mandates: Vec<(usize, usize, Mandate)>,
    /// Per duel: does side a / b hold an unrevealed commitment.
    commits: Vec<[bool; 2]>,
    /// Per account and token (0 wrap.near, 1 usdc.near): output credited and not withdrawn.
    holdings: [[u128; 2]; 4],
    accounted: [u128; 2],
    sweeping: [u128; 2],
    outflow_seq: u64,
    /// Per duel, its `get_chaos` records.
    chaos: Vec<Vec<Chaos>>,
}

impl Snap {
    fn liabilities(&self) -> u128 {
        self.bonds.iter().flatten().sum::<u128>()
            + self.vaults.iter().sum::<u128>()
            + self.duels.iter().map(|d| d.pool.0).sum::<u128>()
            + self.fees
            + self
                .chaos
                .iter()
                .flatten()
                .filter(|c| !c.claimed)
                .map(|c| c.payout.0)
                .sum::<u128>()
    }
    fn mandate(&self, agent: usize, who: usize) -> Option<&Mandate> {
        self.mandates
            .iter()
            .find(|(a, w, _)| *a == agent && *w == who)
            .map(|(_, _, m)| m)
    }
}

/// Owner settings fixed for one case.
#[derive(Clone, Copy, Debug)]
struct Cfg {
    slash_bps: u16,
    fee_bps: u16,
    no_reveal_bps: u16,
    commit_reveal: bool,
    require_consent: bool,
    /// `max_vault_per_account` (deploy 16); `VAULT_CAP` = no tighter than the global cap.
    account_cap: u128,
    /// `inject_chaos` terms (deploy 17).
    chaos: ChaosConfig,
}

/// A follow window `(start, end)`; `end` is `None` while it is the current one.
type Window = (u64, Option<u64>);

/// A mandate version `(terms, from)`; `terms` is `None` for the current one (see `World.versions`).
type Version = (Option<Mandate>, u64);

/// Intent, salt, TEE proof and commit time behind one unrevealed commitment.
type Pending = (Intent, Vec<u8>, Option<TeeProof>, u64);

struct World {
    trie: HashMap<Vec<u8>, Vec<u8>>,
    usage: u64,
    balance: u128,
    now: u64,
    cfg: Cfg,
    /// Unrevealed commitments by (duel, agent).
    pending: HashMap<(usize, usize), Pending>,
    sks: Vec<SigningKey>,
    pks: Vec<Vec<u8>>,
    tee: SigningKey,
    /// Per agent: value that ever entered the bond (deposit, pool shares) and left it
    /// (withdrawals, slashes). Storage taken from the bond only lowers it further.
    bond_in: [u128; AGENTS],
    bond_out: [u128; AGENTS],
    vault_in: [u128; 4],
    vault_out: [u128; 4],
    duels: Vec<DuelM>,
    next_nonce: [u64; AGENTS],
    posted: [Vec<u64>; AGENTS],
    /// Block time each (agent, nonce) was accepted at (deploy 16 `nonce_times`).
    accepted_at: HashMap<(usize, u64), u64>,
    /// Per (agent, follower): the windows the follower was following, `(start, end)`, end `None`
    /// for the current one (closed by the unfollow or expiry a re-follow found).
    windows: HashMap<(usize, usize), Vec<Window>>,
    /// Per (agent, follower): the mandate's versions `(terms, from)`, oldest first. Version `i`
    /// binds intents accepted in `[from_i, from_i+1)`, and only until `from_i+1 + DELAY` when a
    /// later one exists. The last is the current one; its terms are `None` (read from the
    /// contract: they carry the live `spent` and revoke stamp).
    versions: HashMap<(usize, usize), Vec<Version>>,
    settled: HashSet<(usize, usize, u64)>,
    proofs: u64,
    /// The arena's balance on the intents stub per token (0 wrap.near, 1 usdc.near).
    intents_bal: [u128; 2],
    /// Promise results the next call sees (a callback's view or transfer outcome): `None` = failed.
    results: Vec<Option<Vec<u8>>>,
    /// Queued vault withdrawals: (amount, ready_at).
    requests: [Option<(u128, u64)>; 4],
    /// Paged reconcile in progress: how many holders of `ACCOUNTS` (already in account order) it
    /// counted.
    reconcile: Option<usize>,
    /// Per token, holdings debited by `withdraw_token` whose transfer has not confirmed yet.
    in_flight: [u128; 2],
}

impl World {
    fn new(cfg: Cfg) -> Self {
        let mut w = World {
            trie: HashMap::new(),
            usage: 1_000,
            balance: START_BALANCE,
            now: NOW,
            cfg,
            pending: HashMap::new(),
            sks: (0..AGENTS).map(|i| key(20 + i as u8).0).collect(),
            pks: (0..AGENTS).map(|i| key(20 + i as u8).1).collect(),
            tee: key(TEE_SEED).0,
            bond_in: [0; AGENTS],
            bond_out: [0; AGENTS],
            vault_in: [0; 4],
            vault_out: [0; 4],
            duels: vec![],
            next_nonce: [1; AGENTS],
            posted: Default::default(),
            accepted_at: HashMap::new(),
            windows: HashMap::new(),
            versions: HashMap::new(),
            settled: HashSet::new(),
            proofs: 0,
            intents_bal: [0; 2],
            results: vec![],
            requests: [None; 4],
            reconcile: None,
            in_flight: [0; 2],
        };
        w.env(OWNER, 0);
        let c = Contract::init(
            OWNER.parse().unwrap(),
            ORACLE.parse().unwrap(),
            U128(ORACLE_DEPOSIT),
            cfg.slash_bps,
            cfg.fee_bps,
            U128(MIN_CHAOS),
            INTENTS.parse().unwrap(),
            U128(VAULT_CAP),
        );
        env::state_write(&c);
        drop(c);
        w.usage = env::storage_usage();
        w.trie = with_mocked_blockchain(|b| b.take_storage());
        // owner setters take exactly 1 yocto each (deploy 15); the context attaches it to every call
        w.env(OWNER, 1);
        let mut c: Contract = env::state_read().expect("state");
        c.add_solver(SOLVER.parse().unwrap());
        c.set_oracle(ORACLE.parse().unwrap(), U128(ORACLE_DEPOSIT), 60, 10);
        c.add_tee_signer(Base64VecU8(key(TEE_SEED).1), "prop".into());
        c.set_commit_reveal(cfg.commit_reveal, cfg.no_reveal_bps);
        c.set_require_consent(cfg.require_consent);
        c.set_vault_account_cap(U128(cfg.account_cap));
        c.set_chaos_config(cfg.chaos);
        env::state_write(&c);
        drop(c);
        w.balance = env::account_balance().as_yoctonear();
        w.usage = env::storage_usage();
        w.trie = with_mocked_blockchain(|b| b.take_storage());
        w
    }

    fn env(&self, pred: &str, deposit: u128) {
        let ctx = VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(pred.parse().unwrap())
            .signer_account_id(pred.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_yoctonear(self.balance)) // the VM adds the attached deposit
            .storage_usage(self.usage)
            .block_timestamp(self.now)
            .build();
        env::set_blockchain_interface(MockedBlockchain::new(
            ctx,
            cached(test_vm_config),
            cached(near_sdk::RuntimeFeesConfig::test),
            self.results
                .iter()
                .map(|r| match r {
                    Some(b) => PromiseResult::Successful(b.clone()),
                    None => PromiseResult::Failed,
                })
                .collect(),
            self.trie.clone(),
            Default::default(),
            None,
        ));
    }

    /// One transaction. `Err(panic message)` when the call reverted; nothing changed then.
    fn call<R>(
        &mut self,
        pred: &str,
        deposit: u128,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<R, String> {
        self.env(pred, deposit);
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
                let sent: u128 = get_created_receipts()
                    .iter()
                    .flat_map(|r| r.actions.iter())
                    .map(|a| match a {
                        MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
                        MockAction::FunctionCallWeight {
                            attached_deposit, ..
                        } => attached_deposit.as_yoctonear(),
                        _ => 0,
                    })
                    .sum();
                let bal = env::account_balance().as_yoctonear();
                assert_eq!(
                    bal,
                    self.balance + deposit - sent,
                    "balance != before + attached - sent"
                );
                self.balance = bal;
                self.usage = env::storage_usage();
                self.trie = with_mocked_blockchain(|b| b.take_storage());
                Ok(r)
            }
            Err(p) => {
                let msg = p
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_default();
                assert!(!is_bug(&msg), "contract panicked on arithmetic: {msg}");
                // `env::panic_str` reaches the mock as `HostError(GuestPanic { panic_msg: ".." })`
                Err(match msg.split_once("panic_msg: \"") {
                    Some((_, rest)) => rest.split('"').next().unwrap_or_default().to_string(),
                    None => msg,
                })
            }
        }
    }

    fn snap(&self) -> Snap {
        self.env(OWNER, 0);
        let c: Contract = env::state_read().expect("state");
        let agent = |i: usize| c.agents.get(&self.pks[i]);
        let mut mandates = vec![];
        for (ai, pk) in self.pks.iter().enumerate() {
            for (who, f) in ACCOUNTS.iter().enumerate() {
                let key = crate::follow::follow_key(pk, &f.parse().unwrap());
                if let Some(m) = c.follows.get(&key) {
                    mandates.push((ai, who, m.current().clone()));
                }
            }
        }
        let tok = |m: &near_sdk::store::LookupMap<String, u128>, t: usize| {
            m.get(TOKENS[t]).copied().unwrap_or(0)
        };
        let holdings = std::array::from_fn(|i| {
            std::array::from_fn(|t| {
                let k = crate::follow::holding_key(&ACCOUNTS[i].parse().unwrap(), TOKENS[t]);
                c.holdings.get(&k).copied().unwrap_or(0)
            })
        });
        let accounted = std::array::from_fn(|t| tok(&c.accounted, t));
        let sweeping = std::array::from_fn(|t| tok(&c.sweeping, t));
        Snap {
            bonds: std::array::from_fn(|i| agent(i).map(|a| a.bond.0)),
            shields: std::array::from_fn(|i| agent(i).map(|a| a.shield)),
            in_duel: std::array::from_fn(|i| agent(i).and_then(|a| a.in_duel.map(|d| d.0))),
            vaults: std::array::from_fn(|i| {
                let id: AccountId = ACCOUNTS[i].parse().unwrap();
                c.vaults.get(&id).copied().unwrap_or(0)
            }),
            vault_total: c.vault_total,
            duels: (0..c.next_duel)
                .map(|d| c.duels.get(&d).expect("duel").clone())
                .collect(),
            fees: c.owner_fees,
            open_duels: c.open_duels,
            next_duel: c.next_duel,
            mandates,
            commits: (0..c.next_duel)
                .map(|d| {
                    let x = c.duels.get(&d).expect("duel");
                    [&x.a, &x.b].map(|pk| c.commitments.get(&commit_key(d, &pk.0)).is_some())
                })
                .collect(),
            holdings,
            accounted,
            sweeping,
            outflow_seq: c.outflow_seq,
            chaos: (0..c.next_duel)
                .map(|d| c.chaos.get(&d).cloned().unwrap_or_default())
                .collect(),
        }
    }

    /// An accepted decision of agent `ag` in duel `d` on `long`, made at `td`; `counts` when it was
    /// revealed with a provider-TEE proof. Model of what it does to the duel's pending injections.
    fn decided(&mut self, d: usize, ag: usize, long: bool, td: u64, counts: bool) {
        let side_b = ag == self.duels[d].b;
        for r in self.duels[d]
            .recs
            .iter_mut()
            .filter(|r| r.side_b == side_b && r.outcome == ChaosOutcome::Pending)
        {
            if td <= r.at {
                r.prev = Some(long);
            } else if counts {
                r.next = Some(long);
                r.outcome = match (r.dir, r.prev) {
                    (Some(lie), Some(p)) if p != lie && long == lie => ChaosOutcome::Flipped,
                    (Some(lie), Some(p)) if p != lie => ChaosOutcome::Held,
                    _ => ChaosOutcome::NoTrial,
                };
            }
        }
    }

    /// An intent for agent `ag` in duel `d`, with a fresh TEE proof when the agent is TEE-backed.
    fn make_intent(
        &mut self,
        d: usize,
        ag: usize,
        long: bool,
        size_bps: u16,
        nonce: u64,
    ) -> (Intent, Option<TeeProof>) {
        let (req, res) = (self.proofs.to_le_bytes().repeat(4), [0xab; 32]);
        self.proofs += 1;
        let i = Intent {
            agent_pk: Base64VecU8(self.pks[ag].clone()),
            duel_id: U64(d as u64),
            side: if long { Side::Long } else { Side::Short },
            size_bps,
            nonce: U64(nonce),
            expires_at: U64(self.duels[d].close_at),
            proof_hash: Base64VecU8(if is_tee(ag) {
                proof_hash(&req, &res)
            } else {
                vec![0; 32]
            }),
        };
        let proof = is_tee(ag).then(|| TeeProof {
            kind: 2,
            request_hash: Base64VecU8(req.clone()),
            response_hash: Base64VecU8(res.to_vec()),
            signer: Base64VecU8(key(TEE_SEED).1),
            signature: Base64VecU8(
                self.tee
                    .sign(&tee_text(2, MODEL_A, &req, &res))
                    .to_bytes()
                    .to_vec(),
            ),
        });
        (i, proof)
    }

    /// A duel `keep` admits; picks 6 and 7 (or no admitted duel) take any duel, so the refusals
    /// on finished or closed duels still run.
    fn duel(&self, pick: usize, keep: impl Fn(usize) -> bool) -> Option<usize> {
        let ids: Vec<usize> = (0..self.duels.len())
            .filter(|&i| pick < 6 && keep(i))
            .collect();
        match ids.len() {
            0 => (!self.duels.is_empty()).then(|| pick % self.duels.len()),
            n => Some(ids[pick % n]),
        }
    }

    fn step(&mut self, op: &Op) {
        let pre = self.snap();
        let (bal0, trie0) = (self.balance, self.trie.clone());
        let mut kind = Kind::Neutral;
        match op.clone() {
            Op::Register { agent, milli } => {
                kind = Kind::PaysStorage;
                let amt = milli as u128 * MILLI;
                let owner = agent_owner(agent);
                let (pk, sig) = (
                    Base64VecU8(self.pks[agent].clone()),
                    register_sig(&self.sks[agent], &owner),
                );
                if self
                    .call(&owner, amt, |c| {
                        c.register_agent(pk, MODEL_A.into(), is_tee(agent), sig)
                    })
                    .is_ok()
                {
                    self.bond_in[agent] += amt;
                }
            }
            Op::Deposit { who, milli } => {
                kind = Kind::PaysStorage;
                let amt = milli as u128 * MILLI;
                match self.call(ACCOUNTS[who], amt, |c| c.deposit()) {
                    Ok(_) => {
                        self.vault_in[who] += amt;
                        let v = self.snap().vaults[who];
                        assert!(
                            v <= self.cfg.account_cap,
                            "a deposit left a vault above its cap"
                        );
                    }
                    Err(e) if e == "account cap" => assert!(
                        pre.vaults[who] + amt > self.cfg.account_cap,
                        "a deposit inside the account cap was refused"
                    ),
                    Err(_) => {}
                }
            }
            Op::Withdraw { who, milli } => {
                let amt = milli as u128 * MILLI;
                let ok = self
                    .call(ACCOUNTS[who], 1, |c| c.request_withdraw(U128(amt)))
                    .is_ok();
                if ok {
                    assert!(self.requests[who].is_none(), "a second request was queued");
                    self.requests[who] = Some((amt, self.now + DELAY));
                }
                kind = Kind::Exact(ok as i128);
            }
            Op::Claim { who, fail, early } => {
                // an empty pick goes to an account with a queued request, so most draws claim one
                let who = if self.requests[who].is_some() {
                    who
                } else {
                    (0..4).find(|w| self.requests[*w].is_some()).unwrap_or(who)
                };
                if let (Some((_, ready_at)), false) = (self.requests[who], early) {
                    self.now = self.now.max(ready_at);
                }
                let ok = self.call(ACCOUNTS[who], 1, |c| drop(c.withdraw())).is_ok();
                if ok {
                    let (amt, ready_at) =
                        self.requests[who].take().expect("paid without a request");
                    assert!(self.now >= ready_at, "withdraw paid before its delay");
                    let paid = pre.vaults[who] - self.snap().vaults[who];
                    assert_eq!(paid, amt.min(pre.vaults[who]), "pays min(requested, vault)");
                    self.vault_out[who] += paid;
                    self.check_money(&pre, bal0, &trie0, Kind::Exact(1));
                    return self.claim_outcome(who, paid, amt, ready_at, fail);
                } else if let Some((_, ready_at)) = self.requests[who] {
                    assert!(self.now < ready_at, "a due withdrawal was refused");
                }
                kind = Kind::Exact(ok as i128);
            }
            Op::Deliver { wrap, units } => {
                self.intents_bal[!wrap as usize] += units as u128;
            }
            Op::WithdrawToken {
                who,
                wrap,
                pct,
                fail,
            } => {
                // an empty pick goes to the largest holding, so most draws exercise a real withdrawal
                let (who, t) = if pre.holdings[who][!wrap as usize] > 0 {
                    (who, !wrap as usize)
                } else {
                    (0..4)
                        .flat_map(|w| [(w, 0), (w, 1)])
                        .max_by_key(|&(w, t)| pre.holdings[w][t])
                        .unwrap()
                };
                let amt = (pre.holdings[who][t] * pct as u128 / 100).max(1);
                return self.withdraw_token(&pre, who, t, amt, fail);
            }
            Op::Sweep { wrap, pct, fail } => {
                let t = !wrap as usize;
                let free = self.intents_bal[t]
                    .saturating_sub(pre.accounted[t])
                    .saturating_sub(pre.sweeping[t]);
                return self.sweep(&pre, t, (free * pct as u128 / 100).max(1), fail);
            }
            Op::Follow {
                who,
                agent,
                allowance,
                cap,
                spent_pct,
                only_wrap,
                ttl_s,
                revoked,
                floor,
            } => {
                kind = Kind::PaysStorage;
                let allowance = allowance as u128 * MILLI;
                let m = Mandate {
                    allowance: U128(allowance),
                    spent: U128(allowance * spent_pct as u128 / 100),
                    per_tx_cap: U128(cap as u128 * MILLI),
                    allowed_tokens: if only_wrap {
                        vec!["wrap.near".into()]
                    } else {
                        vec![]
                    },
                    expires_at: U64(self.now.saturating_add_signed(ttl_s * SEC as i64)),
                    revoked,
                    min_out_per_near: U128(floor as u128),
                    revoked_at: U64(12_345), // ignored on input: `follow` stores 0
                };
                let pk = Base64VecU8(self.pks[agent].clone());
                if revoked {
                    // exactly `unfollow`: stamped now (once), no other term changes, nothing stored
                    // without a mandate
                    kind = Kind::Neutral;
                    self.call(ACCOUNTS[who], 0, |c| c.follow(pk, m))
                        .expect("a revoking follow is an unfollow");
                    match (pre.mandate(agent, who), self.snap().mandate(agent, who)) {
                        (Some(a), Some(b)) => {
                            let stamp = if a.revoked { a.revoked_at.0 } else { self.now };
                            assert!(
                                b.revoked && b.revoked_at.0 == stamp,
                                "revoking follow stamps now"
                            );
                            let mut a = a.clone();
                            (a.revoked, a.revoked_at) = (true, U64(stamp));
                            assert_eq!(
                                near_sdk::borsh::to_vec(&a).unwrap(),
                                near_sdk::borsh::to_vec(&b).unwrap(),
                                "a revoking follow changed another term"
                            );
                        }
                        (a, b) => assert!(
                            a.is_none() && b.is_none(),
                            "a revoking follow created a mandate"
                        ),
                    }
                    return self.check_money(&pre, bal0, &trie0, kind);
                }
                let stored_spent = pre.mandate(agent, who).map_or(0, |m| m.spent.0);
                // model: a live mandate keeps its windows; a closed one ends its window at the revoke
                // (or expiry) and a new one opens now, unless an older window is still in its grace
                let now = self.now;
                let mut wins = self.windows.get(&(agent, who)).cloned().unwrap_or_default();
                // ... but never before the last update: a backdated expiry binds only later intents
                let last_update = self
                    .versions
                    .get(&(agent, who))
                    .filter(|v| v.len() >= 2)
                    .and_then(|v| v.last())
                    .map_or(0, |v| v.1);
                let closed = pre.mandate(agent, who).and_then(|m| {
                    if m.revoked {
                        Some(m.revoked_at.0)
                    } else {
                        (now >= m.expires_at.0).then_some(m.expires_at.0)
                    }
                    .map(|c| c.max(last_update))
                });
                let mut too_soon = false;
                if pre.mandate(agent, who).is_none() {
                    wins = vec![(now, None)];
                } else if let Some(c) = closed {
                    wins.last_mut().expect("a window per mandate").1 = Some(c);
                    too_soon = wins
                        .iter()
                        .rev()
                        .skip(1)
                        .any(|(_, e)| e.is_some_and(|e| now < e + DELAY));
                    wins.push((now, None));
                }
                // model of the terms: new terms bind intents accepted from now on. A tightening
                // opens a version at now and keeps the replaced terms for earlier intents; only
                // one earlier version may still be in its grace. Nothing earlier can settle after a
                // fresh window, so the versions restart with it.
                let mut vers = self
                    .versions
                    .get(&(agent, who))
                    .cloned()
                    .unwrap_or_default();
                let mut update_too_soon = false;
                match pre.mandate(agent, who) {
                    Some(cur) if closed.is_none_or(|c| now < c + DELAY) => {
                        if !looser_or_equal(&m, cur) {
                            if let Some(&(_, u)) = vers.last().filter(|_| vers.len() >= 2) {
                                update_too_soon = now < u + DELAY;
                                // the version before `u` is past its grace for good: its intents
                                // stay refused, so the windows start no earlier than `u`
                                for w in wins.iter_mut() {
                                    w.0 = w.0.max(u);
                                }
                            }
                            vers.last_mut().expect("a version per mandate").0 = Some(cur.clone());
                            vers.push((None, now));
                        }
                    }
                    _ => vers = vec![(None, now)],
                }
                let r = self.call(ACCOUNTS[who], 0, |c| c.follow(pk, m));
                if floor == 0 {
                    assert!(r.is_err(), "a follow without a price floor was accepted");
                }
                if let Err(e) = &r {
                    assert!(
                        e != "refollow too soon" || too_soon,
                        "refused a re-follow it could keep"
                    );
                    assert!(
                        e != "update too soon" || update_too_soon,
                        "refused an update it could keep"
                    );
                }
                if r.is_ok() {
                    assert!(!too_soon, "a re-follow dropped a window still in its grace");
                    assert!(
                        !update_too_soon,
                        "a tightening update dropped terms still in their grace"
                    );
                    self.versions.insert((agent, who), vers);
                    self.windows.insert((agent, who), wins);
                    let m = self.snap().mandate(agent, who).cloned().expect("stored");
                    assert_eq!(m.revoked_at.0, 0, "follow resets revoked_at");
                    assert_eq!(m.spent.0, stored_spent, "follow keeps the stored spent");
                }
            }
            Op::Unfollow { who, agent } => {
                let pk = Base64VecU8(self.pks[agent].clone());
                let _ = self.call(ACCOUNTS[who], 0, |c| c.unfollow(pk));
                if let (Some(a), Some(b)) =
                    (pre.mandate(agent, who), self.snap().mandate(agent, who))
                {
                    let stamp = if a.revoked { a.revoked_at.0 } else { self.now };
                    assert!(
                        b.revoked && b.revoked_at.0 == stamp,
                        "unfollow stamps revoked_at once"
                    );
                }
            }
            Op::Open {
                a,
                b,
                len_s,
                milli,
                open_price,
                consented,
            } => {
                kind = Kind::PaysStorage; // the excess over storage and the oracle deposit is refunded
                let dep = ORACLE_DEPOSIT + milli as u128 * MILLI;
                let close_at = self.now + len_s * SEC;
                let (pa, pb) = (
                    Base64VecU8(self.pks[a].clone()),
                    Base64VecU8(self.pks[b].clone()),
                );
                let opened = if consented || self.cfg.require_consent {
                    let msg = consent_bytes(
                        &CONTRACT.parse().unwrap(),
                        &pa.0,
                        &pb.0,
                        "wrap.near",
                        close_at,
                    );
                    let [sa, sb] =
                        [a, b].map(|i| Base64VecU8(self.sks[i].sign(&msg).to_bytes().to_vec()));
                    self.call("matchmaker.testnet", dep, |c| {
                        c.open_duel_consented(pa, pb, "wrap.near".into(), U64(close_at), sa, sb)
                            .0
                    })
                } else {
                    self.call(OWNER, dep, |c| {
                        c.open_duel(pa, pb, "wrap.near".into(), U64(close_at)).0
                    })
                };
                if let Ok(id) = opened {
                    assert_eq!(id as usize, self.duels.len(), "duel ids are sequential");
                    self.duels.push(DuelM {
                        a,
                        b,
                        close_at,
                        chaos: vec![],
                        recs: vec![],
                        final_bytes: None,
                    });
                    if open_price {
                        self.check_money(&pre, bal0, &trie0, kind);
                        return self.oracle(id, "open", OPEN_PRICE);
                    }
                }
            }
            Op::Post {
                duel,
                b_side,
                long,
                size_bps,
                reuse_nonce,
            } => {
                kind = Kind::PaysStorage;
                let Some(d) = self.duel(duel, |i| {
                    !pre.duels[i].resolved && self.now + 10 * SEC < self.duels[i].close_at
                }) else {
                    return;
                };
                let ag = if b_side {
                    self.duels[d].b
                } else {
                    self.duels[d].a
                };
                if self.cfg.commit_reveal {
                    // reserve the nonce at commit time: a later reveal must carry a higher one
                    let nonce = self.next_nonce[ag];
                    self.next_nonce[ag] += 1;
                    let (i, proof) = self.make_intent(d, ag, long, size_bps, nonce);
                    let salt = self.proofs.to_le_bytes().repeat(4);
                    let mut pre_image = intent_message(&i);
                    pre_image.extend_from_slice(&salt);
                    let hash = env::sha256(&pre_image);
                    let sig = self.sks[ag]
                        .sign(&commit_bytes(&CONTRACT.parse().unwrap(), d as u64, &hash))
                        .to_bytes()
                        .to_vec();
                    let pk = Base64VecU8(self.pks[ag].clone());
                    // the held commitment is the decision before a headline planted at or after it:
                    // replaced unrevealed, that headline can never be judged and is no trial
                    let side_b = ag == self.duels[d].b;
                    let held_at = self.pending.get(&(d, ag)).map(|p| p.3);
                    if self
                        .call("relayer.testnet", 0, |c| {
                            c.commit_intent(U64(d as u64), pk, Base64VecU8(hash), Base64VecU8(sig))
                        })
                        .is_ok()
                    {
                        if let Some(t) = held_at {
                            for r in self.duels[d].recs.iter_mut().filter(|r| {
                                r.side_b == side_b
                                    && r.outcome == ChaosOutcome::Pending
                                    && r.at >= t
                            }) {
                                r.outcome = ChaosOutcome::NoTrial;
                            }
                        }
                        self.pending.insert((d, ag), (i, salt, proof, self.now));
                    }
                } else {
                    let nonce = match self.posted[ag].last() {
                        Some(n) if reuse_nonce => *n,
                        _ => self.next_nonce[ag],
                    };
                    let (i, proof) = self.make_intent(d, ag, long, size_bps, nonce);
                    let signed = sign(&self.sks[ag], &i);
                    if self
                        .call("relayer.testnet", 0, |c| c.post_intent(signed, proof))
                        .is_ok()
                    {
                        self.accepted(ag, nonce);
                        // a direct post never decides a headline, whoever the agent
                        self.decided(d, ag, long, self.now, false);
                    }
                }
            }
            Op::Reveal { pick, late } => {
                kind = Kind::PaysStorage;
                let mut keys: Vec<(usize, usize)> = self.pending.keys().copied().collect();
                if keys.is_empty() {
                    return;
                }
                keys.sort();
                let (d, ag) = keys[pick % keys.len()];
                let (i, salt, proof, committed_at) = self.pending[&(d, ag)].clone();
                if late {
                    // inside the intent lock, still before close: only a reveal may land here
                    self.now = self.now.max(self.duels[d].close_at - SEC);
                }
                let signed = sign(&self.sks[ag], &i);
                if self
                    .call("relayer.testnet", 0, |c| {
                        c.reveal_intent(signed, Base64VecU8(salt), proof)
                    })
                    .is_ok()
                {
                    self.pending.remove(&(d, ag));
                    self.accepted(ag, i.nonce.0);
                    // only an enclave-proved reveal decides a headline
                    let long = i.side == Side::Long;
                    self.decided(d, ag, long, committed_at, is_tee(ag));
                }
            }
            Op::Chaos {
                duel,
                b_side,
                milli,
                own,
                kind: k,
                under,
            } => {
                kind = Kind::PaysStorage;
                let Some(d) = self.duel(duel, |i| {
                    !pre.duels[i].resolved && self.now + 10 * SEC < self.duels[i].close_at
                }) else {
                    return;
                };
                let (ck, dir) = match k {
                    0 => (ChaosKind::Long, Some(true)),
                    1 => (ChaosKind::Short, Some(false)),
                    _ => (ChaosKind::Placebo, None),
                };
                let paid_n = self.duels[d]
                    .recs
                    .iter()
                    .filter(|r| r.dir.is_some())
                    .count();
                let fee = model_fee(&self.cfg.chaos, paid_n);
                let amt = if under {
                    fee - 1
                } else {
                    fee + milli as u128 * MILLI
                };
                let target = Base64VecU8(
                    self.pks[if b_side {
                        self.duels[d].b
                    } else {
                        self.duels[d].a
                    }]
                    .clone(),
                );
                let payer: String = match (dir, own) {
                    (None, _) => OWNER.into(),
                    (_, true) => agent_owner(self.duels[d].a),
                    _ => "spectator.testnet".into(),
                };
                let ix = pre.duels[d].injections.len();
                let r = self.call(&payer, amt, |c| {
                    c.inject_chaos(U64(d as u64), target, ck, "BREAKING: rumour".into())
                });
                let open = !pre.duels[d].resolved && self.now < self.duels[d].close_at;
                match r {
                    Ok(index) => {
                        assert_eq!(index as usize, ix, "chaos index is the injection index");
                        assert!(
                            dir.is_none() || !under,
                            "an injection below the price was accepted"
                        );
                        // what the payer brought less the storage the record added
                        let cost = env::storage_byte_cost().as_yoctonear();
                        let stake = amt - bytes_added(&trie0, &self.trie) * cost;
                        // an agent owner's or a placebo's deposit is a fee, never stake
                        let unpaid = own || dir.is_none();
                        let c = self.snap().chaos[d][ix].clone();
                        assert_eq!(c.stake.0, if unpaid { 0 } else { stake }, "stake");
                        assert_eq!(c.arm == Arm::Placebo, dir.is_none(), "placebo arm");
                        let side_b = b_side as usize;
                        let last = [&pre.duels[d].last_intent_a, &pre.duels[d].last_intent_b]
                            [side_b]
                            .as_ref()
                            .map(|i| i.side == Side::Long);
                        self.duels[d].chaos.push((b_side, unpaid));
                        self.duels[d].recs.push(ChaosM {
                            side_b: b_side,
                            dir,
                            at: self.now,
                            prev: last,
                            next: None,
                            outcome: ChaosOutcome::Pending,
                            stake: if unpaid { 0 } else { stake },
                            injector: payer,
                            payout: 0,
                            claimed: false,
                        });
                    }
                    Err(e) if e == "chaos deposit too small" && under && dir.is_some() => {}
                    Err(e) => assert!(
                        !open || ix >= MAX_INJECTIONS,
                        "an injection at the price was refused: {e}"
                    ),
                }
            }
            Op::ClaimChaos { pick, fail } => {
                let mut owed: Vec<(usize, String)> = (0..self.duels.len())
                    .filter(|&d| pre.duels[d].resolved)
                    .flat_map(|d| {
                        self.duels[d]
                            .recs
                            .iter()
                            .filter(|r| !r.claimed && r.payout > 0)
                            .map(move |r| (d, r.injector.clone()))
                    })
                    .collect();
                owed.sort();
                owed.dedup();
                let (d, who) = match owed.len() {
                    0 if self.duels.is_empty() => return,
                    0 => (pick % self.duels.len(), "spectator.testnet".to_string()),
                    n => owed[pick % n].clone(),
                };
                let due: u128 = self.duels[d]
                    .recs
                    .iter()
                    .filter(|r| r.injector == who && !r.claimed)
                    .map(|r| r.payout)
                    .sum();
                let r = self.call(&who, 1, |c| drop(c.claim_chaos(U64(d as u64))));
                match r {
                    Ok(()) => {
                        assert!(pre.duels[d].resolved && due > 0, "claimed nothing owed");
                        for r in self.duels[d].recs.iter_mut().filter(|r| r.injector == who) {
                            r.claimed |= r.payout > 0;
                        }
                        self.check_money(&pre, bal0, &trie0, Kind::Exact(1));
                        // the transfer's outcome: a bounce refunds the NEAR to the contract, and the
                        // callback must unclaim exactly this injector's records in that duel
                        let (mid, bal1, trie1) = (self.snap(), self.balance, self.trie.clone());
                        if fail {
                            self.balance += due;
                        }
                        self.results = vec![if fail { None } else { Some(vec![]) }];
                        let landed = self
                            .call(CONTRACT, 0, |c| {
                                c.on_claim_chaos(U64(d as u64), who.parse().unwrap())
                            })
                            .expect("on_claim_chaos never panics");
                        self.results.clear();
                        assert_eq!(landed, !fail);
                        if fail {
                            for r in self.duels[d]
                                .recs
                                .iter_mut()
                                .filter(|r| r.injector == who && r.payout > 0)
                            {
                                r.claimed = false;
                            }
                        }
                        return self.check_money(&mid, bal1, &trie1, Kind::Neutral);
                    }
                    Err(e) => assert!(
                        !pre.duels[d].resolved || due == 0,
                        "an owed claim was refused: {e}"
                    ),
                }
            }
            Op::Resolve { duel, move_bps } => {
                let Some(d) = self.duel(duel, |i| !pre.duels[i].resolved) else {
                    return;
                };
                self.now = self.now.max(self.duels[d].close_at);
                if self
                    .call("keeper.testnet", ORACLE_DEPOSIT + MILLI, |c| {
                        c.resolve_duel(U64(d as u64))
                    })
                    .is_ok()
                {
                    self.check_money(&pre, bal0, &trie0, kind);
                    let open = pre.duels[d]
                        .open_price
                        .expect("resolve needs an open price")
                        .0;
                    let close = (open as i64 * (10_000 + move_bps) / 10_000) as u64;
                    return self.oracle(d as u64, "close", close);
                }
            }
            Op::Settle { who, agent, fills } => return self.settle(&pre, who, agent, &fills),
            Op::Void { duel } => {
                let Some(d) = self.duel(duel, |i| !pre.duels[i].resolved) else {
                    return;
                };
                self.now = self.now.max(self.duels[d].close_at + VOID_AFTER_NS);
                if self
                    .call("keeper.testnet", 0, |c| c.void_duel(U64(d as u64)))
                    .is_ok()
                {
                    let post = self.snap();
                    let (a, b, pool) = (self.duels[d].a, self.duels[d].b, pre.duels[d].pool.0);
                    // a void settles the injections as a tie, then splits what is left
                    let (fees, credit, taken, _) =
                        settle_model(&mut self.duels[d].recs, None, 0, &self.cfg.chaos);
                    let rest = pool - taken;
                    let (sa, sb) = (rest / 2 + rest % 2 + credit[0], rest / 2 + credit[1]);
                    assert_eq!(post.fees, pre.fees + fees, "void chaos fees");
                    assert_eq!(post.bonds[a], pre.bonds[a].map(|x| x + sa), "void share a");
                    assert_eq!(post.bonds[b], pre.bonds[b].map(|x| x + sb), "void share b");
                    self.bond_in[a] += sa;
                    self.bond_in[b] += sb;
                    self.pending.retain(|k, _| k.0 != d); // void drops commitments, no forfeit
                }
            }
            Op::WithdrawBond { agent, milli } => {
                let amt = milli as u128 * MILLI;
                let (owner, pk) = (agent_owner(agent), Base64VecU8(self.pks[agent].clone()));
                let ok = self
                    .call(&owner, 1, |c| drop(c.withdraw_bond(pk, U128(amt))))
                    .is_ok();
                kind = Kind::Exact(ok as i128);
                if ok {
                    assert!(
                        pre.in_duel[agent].is_none(),
                        "bond withdrawn while in a duel"
                    );
                    self.bond_out[agent] += amt;
                }
            }
            Op::WithdrawFees => {
                let ok = self.call(OWNER, 1, |c| drop(c.withdraw_fees())).is_ok();
                kind = Kind::Exact(ok as i128);
            }
            Op::ReconcileBegin => {
                self.call(OWNER, 1, |c| c.begin_reconcile()).expect("begin");
                self.reconcile = Some(0);
                kind = Kind::Exact(1);
            }
            Op::ReconcilePage { n, repeat } => {
                let r = self.reconcile_page(n, repeat);
                kind = Kind::Exact(r.is_ok() as i128);
            }
            Op::ReconcileFinish => {
                // the holders not counted yet first, a page per transaction
                if self.reconcile.is_some_and(|i| i < ACCOUNTS.len()) {
                    self.reconcile_page(2, false).expect("page");
                    self.check_money(&pre, bal0, &trie0, Kind::Exact(1));
                    return self.step(&Op::ReconcileFinish);
                }
                let r = self.call(OWNER, 1, |c| c.finish_reconcile().0);
                kind = Kind::Exact(r.is_ok() as i128);
                match self.reconcile.take() {
                    Some(_) => {
                        let total = r.expect("finish");
                        let post = self.snap();
                        assert_eq!(
                            total,
                            post.vaults.iter().sum::<u128>(),
                            "a paged reconcile missed a vault change between its pages"
                        );
                    }
                    None => assert_eq!(r.unwrap_err(), "no reconcile"),
                }
            }
            Op::Advance { secs } => self.now += secs * SEC,
        }
        self.check_money(&pre, bal0, &trie0, kind);
    }

    /// `reconcile_page` of the next `n` holders (or the last counted again with `repeat`).
    fn reconcile_page(&mut self, n: usize, repeat: bool) -> Result<u128, String> {
        let from = self.reconcile.unwrap_or(0);
        let from = if repeat { from.saturating_sub(1) } else { from };
        let to = (from + n).min(ACCOUNTS.len());
        let accounts: Vec<AccountId> = ACCOUNTS[from..to]
            .iter()
            .map(|a| a.parse().unwrap())
            .collect();
        let r = self.call(OWNER, 1, |c| c.reconcile_page(accounts).0);
        match self.reconcile {
            None => assert_eq!(r.as_ref().unwrap_err(), "no reconcile"),
            Some(i) if repeat && i > 0 => {
                assert_eq!(r.as_ref().unwrap_err(), "accounts not ascending")
            }
            Some(_) => {
                r.as_ref().expect("an ascending page is accepted");
                self.reconcile = Some(to);
            }
        }
        r
    }

    /// Was `who` following agent `ag` when an intent was accepted at `at`, with that window still
    /// in its grace now if it has closed.
    fn following(&self, ag: usize, who: usize, at: u64) -> bool {
        self.windows.get(&(ag, who)).is_some_and(|w| {
            w.iter()
                .any(|(s, e)| at >= *s && e.is_none_or(|e| at < e && self.now < e + DELAY))
        })
    }

    /// The version of `who`'s mandate for `ag` in force when an intent was accepted at `at`:
    /// `Ok(None)` for the current one, `Ok(Some(terms))` for an earlier one inside its grace (it
    /// ends `DELAY` after the next version opened), "mandate updated" past it.
    fn terms_at(&self, ag: usize, who: usize, at: u64) -> Result<Option<Mandate>, &'static str> {
        let v = &self.versions[&(ag, who)];
        let i = v.iter().rposition(|(_, from)| *from <= at).unwrap_or(0);
        match (&v[i].0, v.get(i + 1)) {
            (Some(t), Some((_, next))) if self.now < next + DELAY => Ok(Some(t.clone())),
            (Some(_), _) => Err("mandate updated"),
            (None, _) => Ok(None),
        }
    }

    /// Records an accepted intent (posted or revealed) of agent `ag`.
    fn accepted(&mut self, ag: usize, nonce: u64) {
        assert!(!self.posted[ag].contains(&nonce), "nonce accepted twice");
        self.posted[ag].push(nonce);
        self.accepted_at.insert((ag, nonce), self.now);
        self.next_nonce[ag] = self.next_nonce[ag].max(nonce + 1);
    }

    /// The oracle answers `phase:id` with `price` stamped now.
    fn oracle(&mut self, id: u64, phase: &str, price: u64) {
        let pre = self.snap();
        let (bal0, trie0) = (self.balance, self.trie.clone());
        let data = PriceData {
            timestamp: U64(self.now),
            recency_duration_sec: 300,
            prices: vec![AssetOptionalPrice {
                asset_id: "wrap.near".into(),
                price: Some(OraclePrice {
                    multiplier: U128(price as u128),
                    decimals: 8,
                }),
            }],
        };
        let msg = format!("{phase}:{id}");
        let done = self
            .call(ORACLE, 0, |c| {
                c.oracle_on_call(CONTRACT.parse().unwrap(), data, msg)
            })
            .is_ok();
        if done && phase == "close" {
            self.check_slash(&pre, id as usize);
            self.pending.retain(|k, _| k.0 != id as usize);
        }
        self.check_money(&pre, bal0, &trie0, Kind::Neutral);
    }

    /// Property 5, with bonds as they stood at resolution. A side holding an unrevealed commitment
    /// first pays `no_reveal_bps` of its bond to the other side (to owner fees when both withheld)
    /// and loses. The loser then pays `slash_bps` of its remaining bond into the pool and the
    /// winner takes the pool. A tie splits the pool, odd yocto to a.
    fn check_slash(&mut self, pre: &Snap, d: usize) {
        let post = self.snap();
        let (a, b, pool) = (self.duels[d].a, self.duels[d].b, pre.duels[d].pool.0);
        let o = post.duels[d].outcome.clone().expect("outcome");
        let nr = pre.commits[d];
        let (ba, bb) = (pre.bonds[a].unwrap(), pre.bonds[b].unwrap());
        let take = |bond: u128, on: bool| {
            if on {
                bond * self.cfg.no_reveal_bps as u128 / 10_000
            } else {
                0
            }
        };
        let (ta, tb) = (take(ba, nr[0]), take(bb, nr[1]));
        let (mut na, mut nb) = (ba - ta, bb - tb);
        let mut fees = pre.fees;
        match nr {
            [true, true] => fees += ta + tb,
            [true, false] => nb += ta,
            [false, true] => na += tb,
            [false, false] => {}
        }
        let a_wins = match nr {
            [true, true] => None,
            [true, false] => Some(false),
            [false, true] => Some(true),
            [false, false] if o.pnl_a == o.pnl_b => None,
            [false, false] => Some(o.pnl_a > o.pnl_b),
        };
        // the pool holds exactly the escrowed stakes until the finish
        let stakes: u128 = self.duels[d].recs.iter().map(|r| r.stake).sum();
        assert_eq!(pool, stakes, "pool != escrowed stakes");
        match a_wins {
            None => {
                assert!(o.winner.is_none() && o.slashed.0 == 0, "tie must not slash");
                let (f, credit, taken, _) =
                    settle_model(&mut self.duels[d].recs, None, 0, &self.cfg.chaos);
                let rest = pool - taken;
                na += rest / 2 + rest % 2 + credit[0];
                nb += rest / 2 + credit[1];
                fees += f;
            }
            Some(a_wins) => {
                let (w, wb, lb) = if a_wins {
                    (a, &mut na, &mut nb)
                } else {
                    (b, &mut nb, &mut na)
                };
                let slashed = *lb * self.cfg.slash_bps as u128 / 10_000;
                assert_eq!(o.slashed.0, slashed, "slash amount");
                assert_eq!(
                    o.winner.as_ref().map(|p| p.0.clone()),
                    Some(self.pks[w].clone()),
                    "winner"
                );
                // the slash, then the flips' shares (on top, bounded by what is left), come off the
                // loser's bond before any resistance reward reaches it
                *lb -= slashed;
                let pot = (slashed * self.cfg.chaos.share_bps as u128 / 10_000).min(*lb);
                let (f, credit, taken, shares) =
                    settle_model(&mut self.duels[d].recs, Some(a_wins), pot, &self.cfg.chaos);
                assert!(shares <= pot, "shares above the pot");
                *lb -= shares;
                // every stake leaves the pool; the winner keeps the whole slash
                assert_eq!(taken, pool, "pool - taken != 0");
                *wb += pool + slashed - taken;
                na += credit[0];
                nb += credit[1];
                fees += f;
            }
        }
        // a reward (resistance credit or share of the slash) only for an outcome a counting
        // decision made after the injection decided: the model sets Held / Flipped nowhere else
        for r in &self.duels[d].recs {
            assert!(
                r.next.is_some()
                    || !matches!(r.outcome, ChaosOutcome::Held | ChaosOutcome::Flipped),
                "a reward without a decision after the injection"
            );
        }
        assert_eq!(post.bonds[a], Some(na), "bond a after resolution");
        assert_eq!(post.bonds[b], Some(nb), "bond b after resolution");
        assert_eq!(post.fees, fees, "owner fees after resolution");
        // 5b. shield grows only by third-party chaos the winner held against: never from chaos an
        // agent owner paid, never for no trial, a flip or an expiry, never on a forfeit win, never
        // for the loser or on a tie
        let won = |side_b: bool| a_wins == Some(!side_b);
        for (side_b, ag) in [(false, a), (true, b)] {
            let earned = if won(side_b) && nr == [false; 2] {
                self.duels[d]
                    .chaos
                    .iter()
                    .zip(&self.duels[d].recs)
                    .filter(|((at_b, own), r)| {
                        *at_b == side_b && !own && r.outcome == ChaosOutcome::Held
                    })
                    .count() as u32
            } else {
                0
            };
            assert_eq!(
                post.shields[ag],
                pre.shields[ag].map(|s| s + earned),
                "shield after resolution"
            );
        }
        for (i, before, after) in [(a, ba, na), (b, bb, nb)] {
            if after >= before {
                self.bond_in[i] += after - before;
            } else {
                self.bond_out[i] += before - after;
            }
        }
    }

    /// Property 3: the contract accepts exactly the fills the mandate and receipt rules accept, and
    /// rejected fills move nothing. `settle_follow` writes nothing; its callback runs with the
    /// arena's intents balance as the view answer and panics (writing nothing) when none settles.
    fn settle(&mut self, pre: &Snap, who: usize, agent: usize, specs: &[FillSpec]) {
        let (bal0, trie0) = (self.balance, self.trie.clone());
        let fee_bps = self.cfg.fee_bps as u128;
        let fills: Vec<Fill> = specs
            .iter()
            .map(|s| Fill {
                // one in len+1 is a nonce the agent never posted; LATEST is the newest one (often
                // posted after an unfollow or the expiry: the deploy-16 accept-time rule)
                intent_nonce: U64(match s.nonce {
                    LATEST => self.posted[agent].last().copied().unwrap_or(1_000),
                    n => self.posted[agent]
                        .get(n % (self.posted[agent].len() + 1))
                        .copied()
                        .unwrap_or(1_000),
                }),
                token: TOKENS[!s.wrap as usize].into(),
                amount_in: U128(s.milli as u128 * MILLI),
                amount_out: U128(s.out as u128),
                swap_tx: "tx".into(),
            })
            .collect();
        let pk = Base64VecU8(self.pks[agent].clone());
        let follower: AccountId = ACCOUNTS[who].parse().unwrap();
        // the views a solver checks before fronting agree with the model (round 3, R4)
        self.env(OWNER, 0);
        let c: Contract = env::state_read().expect("state");
        for f in &fills {
            let n = f.intent_nonce.0;
            assert_eq!(
                c.intent_accepted_at(pk.clone(), U64(n)).map(|t| t.0),
                self.accepted_at.get(&(agent, n)).copied(),
                "intent_accepted_at"
            );
        }
        assert_eq!(
            c.get_follow_time(pk.clone(), follower.clone()).map(|t| t.0),
            self.windows
                .get(&(agent, who))
                .and_then(|w| w.last())
                .map(|(s, _)| *s),
            "get_follow_time"
        );
        drop(c);
        let sent = self.call(SOLVER, 0, |c| {
            drop(c.settle_follow(pk.clone(), follower.clone(), fills.clone()))
        });
        if fills.is_empty() {
            assert_eq!(sent.unwrap_err(), "empty fills");
            return;
        }
        sent.expect("settle_follow refuses only shape errors");
        assert!(
            self.trie == trie0,
            "settle_follow wrote state before the view"
        );
        // model of `apply_fill`, in the contract's check order
        let mut m = pre.mandate(agent, who).cloned();
        let mut vault = pre.vaults[who];
        let mut surplus: [u128; 2] = std::array::from_fn(|t| {
            self.intents_bal[t]
                .saturating_sub(pre.accounted[t])
                .saturating_sub(pre.sweeping[t])
        });
        let mut accepted = HashSet::new();
        let mut expect: Vec<Result<(u128, u128), &str>> = vec![];
        for f in &fills {
            let (n, amt, out) = (f.intent_nonce.0, f.amount_in.0, f.amount_out.0);
            let t = TOKENS.iter().position(|x| *x == f.token).unwrap();
            let fee = amt * fee_bps / 10_000;
            let debit = amt + fee;
            let r = if !self.posted[agent].contains(&n) {
                Err("nonce unknown")
            } else if self.settled.contains(&(agent, who, n)) || accepted.contains(&n) {
                Err("duplicate fill")
            } else if let Some(m) = m.as_mut() {
                // deploy 16: the grace never covers an intent accepted at or after the revoke / expiry
                let at = self.accepted_at[&(agent, n)];
                // the terms in force at `at` (`b`); `spent` stays one ledger in the current mandate
                let b = if !self.following(agent, who, at) {
                    Err("intent before follow")
                } else {
                    self.terms_at(agent, who, at)
                        .map(|t| t.unwrap_or_else(|| m.clone()))
                };
                match b {
                    Err(e) => Err(e),
                    Ok(b)
                        if b.revoked
                            && (self.now >= b.revoked_at.0 + DELAY || at >= b.revoked_at.0) =>
                    {
                        Err("mandate revoked")
                    }
                    Ok(b) if self.now >= b.expires_at.0 + DELAY || at >= b.expires_at.0 => {
                        Err("mandate expired")
                    }
                    Ok(b)
                        if !b.allowed_tokens.is_empty() && !b.allowed_tokens.contains(&f.token) =>
                    {
                        Err("token not allowed")
                    }
                    Ok(b) if debit > b.per_tx_cap.0 => Err("over cap"),
                    Ok(b) if m.spent.0 + debit > b.allowance.0 => Err("allowance exhausted"),
                    Ok(b)
                        if b.min_out_per_near.0 > 0 && out * NEAR < amt * b.min_out_per_near.0 =>
                    {
                        Err("below min price")
                    }
                    Ok(_) if out == 0 || out > surplus[t] => Err("no receipt"),
                    Ok(_) if vault < debit => Err("insufficient"),
                    Ok(_) => {
                        m.spent.0 += debit;
                        vault -= debit;
                        surplus[t] -= out;
                        accepted.insert(n);
                        Ok((amt, out))
                    }
                }
            } else {
                Err("no mandate")
            };
            expect.push(r);
        }
        // the view: this contract's balance on the intents stub, one entry per distinct token
        let mut asked: Vec<usize> = vec![];
        for f in &fills {
            let t = TOKENS.iter().position(|x| *x == f.token).unwrap();
            if !asked.contains(&t) {
                asked.push(t);
            }
        }
        let answer: Vec<U128> = asked.iter().map(|t| U128(self.intents_bal[*t])).collect();
        self.results = vec![Some(near_sdk::serde_json::to_vec(&answer).unwrap())];
        let seq = pre.outflow_seq;
        let out = self.call(CONTRACT, 0, |c| {
            c.on_settle_follow(pk, follower, SOLVER.parse().unwrap(), fills.clone(), seq)
        });
        self.results.clear();
        let got: Vec<(u32, String)> = expect
            .iter()
            .enumerate()
            .filter_map(|(i, r)| r.as_ref().err().map(|e| (i as u32, e.to_string())))
            .collect();
        let report = match out {
            Ok(r) => r,
            Err(msg) => {
                assert!(
                    expect.iter().all(|r| r.is_err()),
                    "refused a batch with a valid fill: {msg}"
                );
                assert_eq!(msg, got[0].1, "the refusal names the first rejection");
                assert!(self.trie == trie0, "an all-rejected batch wrote state");
                return self.check_money(pre, bal0, &trie0, Kind::Neutral);
            }
        };
        assert_eq!(
            report.rejected, got,
            "rejections differ from the mandate and receipt rules"
        );
        let amt_in: u128 = expect.iter().flatten().map(|(a, _)| a).sum();
        let fees: u128 = expect
            .iter()
            .flatten()
            .map(|(a, _)| a * fee_bps / 10_000)
            .sum();
        assert_eq!(report.debited.0, amt_in + fees, "debited");
        let post = self.snap();
        assert_eq!(
            post.vaults[who],
            pre.vaults[who] - amt_in - fees,
            "follower vault"
        );
        assert_eq!(
            post.vaults[SOLVER_IX],
            pre.vaults[SOLVER_IX] + amt_in,
            "solver vault"
        );
        assert_eq!(post.fees, pre.fees + fees, "owner fees");
        for (t, token) in TOKENS.iter().enumerate() {
            let credited: u128 = fills
                .iter()
                .zip(&expect)
                .filter(|(f, r)| r.is_ok() && f.token == *token)
                .map(|(f, _)| f.amount_out.0)
                .sum();
            assert_eq!(
                post.accounted[t],
                pre.accounted[t] + credited,
                "accounted grows by credited output"
            );
            assert_eq!(
                post.holdings[who][t],
                pre.holdings[who][t] + credited,
                "the follower's holding"
            );
            assert!(
                post.accounted[t] + post.sweeping[t] <= self.intents_bal[t],
                "credited beyond the balance"
            );
        }
        if let (Some(a), Some(b)) = (pre.mandate(agent, who), post.mandate(agent, who)) {
            assert_eq!(
                b.spent.0,
                a.spent.0 + amt_in + fees,
                "spent grows by accepted debits only"
            );
            assert!(
                a.allowance.0 == b.allowance.0
                    && a.per_tx_cap.0 == b.per_tx_cap.0
                    && a.revoked == b.revoked
            );
            // 3. after every accepted fill, in batch order, the ledger is within the allowance of
            // the terms that bound that fill
            let mut spent = a.spent.0;
            for (f, _) in fills.iter().zip(&expect).filter(|(_, r)| r.is_ok()) {
                spent += f.amount_in.0 + f.amount_in.0 * fee_bps / 10_000;
                let at = self.accepted_at[&(agent, f.intent_nonce.0)];
                let allowance = match self.terms_at(agent, who, at) {
                    Ok(Some(t)) => t.allowance.0,
                    Ok(None) => a.allowance.0,
                    Err(e) => panic!("settled a fill past its terms' grace: {e}"),
                };
                assert!(
                    spent <= allowance,
                    "mandate {agent}/{who} spent over the allowance that bound a fill"
                );
            }
            assert_eq!(spent, b.spent.0, "the ledger is the sum of accepted debits");
        }
        for f in fills.iter().zip(&expect).filter(|(_, r)| r.is_ok()) {
            let (f, n) = (f.0, f.0.intent_nonce.0);
            let at = self.accepted_at[&(agent, n)];
            // a settled fill meets the terms in force when its intent was accepted, within the
            // grace of a later update (deploy 17)
            let m = match self.terms_at(agent, who, at) {
                Ok(Some(t)) => t,
                Ok(None) => pre
                    .mandate(agent, who)
                    .expect("settled without a mandate")
                    .clone(),
                Err(e) => panic!("settled an intent past its terms' grace: {e}"),
            };
            let debit = f.amount_in.0 + f.amount_in.0 * fee_bps / 10_000;
            assert!(
                debit <= m.per_tx_cap.0
                    && (m.allowed_tokens.is_empty() || m.allowed_tokens.contains(&f.token))
                    && f.amount_out.0 * NEAR >= f.amount_in.0 * m.min_out_per_near.0,
                "settled a fill outside the terms in force when its intent was accepted"
            );
            // V3: a settled fill's intent predates its terms' revoke and expiry
            assert!(
                (!m.revoked || at < m.revoked_at.0) && at < m.expires_at.0,
                "settled an intent accepted after its mandate closed"
            );
            assert!(
                self.following(agent, who, at),
                "settled an intent accepted while not following, or past its window's grace"
            );
            self.settled.insert((agent, who, n));
        }
        self.vault_out[who] += amt_in + fees;
        self.vault_in[SOLVER_IX] += amt_in;
        self.check_money(pre, bal0, &trie0, Kind::Neutral);
    }

    /// `withdraw`'s transfer outcome. A bounced transfer returns the NEAR to the contract, and
    /// `on_withdraw` must put exactly `paid` back in the vault and restore the request; a landed
    /// one changes nothing.
    fn claim_outcome(&mut self, who: usize, paid: u128, amt: u128, ready_at: u64, fail: bool) {
        let (mid, bal1, trie1) = (self.snap(), self.balance, self.trie.clone());
        if fail {
            self.balance += paid; // the runtime refunds a failed transfer to its sender
        }
        self.results = vec![if fail { None } else { Some(vec![]) }];
        let landed = self
            .call(CONTRACT, 0, |c| {
                c.on_withdraw(
                    ACCOUNTS[who].parse().unwrap(),
                    U128(paid),
                    U128(amt),
                    U64(ready_at),
                )
            })
            .expect("on_withdraw never panics");
        self.results.clear();
        assert_eq!(landed, !fail);
        let post = self.snap();
        if fail {
            assert_eq!(
                post.vaults[who],
                mid.vaults[who] + paid,
                "a bounced withdraw re-credits exactly"
            );
            self.vault_out[who] -= paid;
            self.requests[who] = Some((amt, ready_at));
        } else {
            assert_eq!(
                post.vaults[who], mid.vaults[who],
                "a landed withdraw moves nothing more"
            );
        }
        // the refund arrived as balance and went back into the vault: balance - liabilities is fixed
        self.check_money(&mid, bal1, &trie1, Kind::Neutral);
    }

    /// `withdraw_token` debits the holding first and forwards the yocto to `mt_transfer`; its
    /// callback lowers `accounted` on success and re-credits the holding exactly on failure.
    fn withdraw_token(&mut self, pre: &Snap, who: usize, t: usize, amt: u128, fail: bool) {
        let (bal0, trie0) = (self.balance, self.trie.clone());
        let ok = self
            .call(ACCOUNTS[who], 1, |c| {
                drop(c.withdraw_token(TOKENS[t].into(), U128(amt)))
            })
            .is_ok();
        assert_eq!(
            ok,
            amt <= pre.holdings[who][t],
            "withdraw_token bounded by the holding"
        );
        if ok {
            self.in_flight[t] += amt;
        }
        self.check_money(pre, bal0, &trie0, Kind::Neutral);
        if !ok {
            return;
        }
        let mid = self.snap();
        assert_eq!(
            mid.holdings[who][t],
            pre.holdings[who][t] - amt,
            "debited first"
        );
        assert_eq!(
            mid.accounted[t], pre.accounted[t],
            "accounted waits for the transfer"
        );
        let (bal1, trie1) = (self.balance, self.trie.clone());
        self.results = vec![if fail { None } else { Some(vec![]) }];
        let landed = self
            .call(CONTRACT, 0, |c| {
                c.on_withdraw_token(ACCOUNTS[who].parse().unwrap(), TOKENS[t].into(), U128(amt))
            })
            .expect("on_withdraw_token never panics");
        self.results.clear();
        assert_eq!(landed, !fail);
        self.in_flight[t] -= amt;
        let post = self.snap();
        if fail {
            assert_eq!(
                post.holdings[who][t], pre.holdings[who][t],
                "a failed transfer re-credits exactly"
            );
            assert_eq!(
                (post.accounted[t], post.outflow_seq),
                (pre.accounted[t], pre.outflow_seq)
            );
        } else {
            assert_eq!(post.accounted[t], pre.accounted[t] - amt);
            assert_eq!(
                post.outflow_seq,
                pre.outflow_seq + 1,
                "an outflow moves outflow_seq"
            );
            self.intents_bal[t] -= amt;
        }
        self.check_money(&mid, bal1, &trie1, Kind::Neutral);
    }

    /// `sweep_surplus` keeps its yocto; the check forwards one with `mt_transfer` when the surplus
    /// covers the amount and reserves it in `sweeping`; the transfer's callback releases it. No step
    /// touches `accounted` or a holding.
    fn sweep(&mut self, pre: &Snap, t: usize, amt: u128, fail: bool) {
        let (bal0, trie0) = (self.balance, self.trie.clone());
        let ok = self
            .call(OWNER, 1, |c| {
                drop(c.sweep_surplus(TOKENS[t].into(), OWNER.parse().unwrap(), U128(amt)))
            })
            .is_ok();
        self.check_money(pre, bal0, &trie0, Kind::Exact(ok as i128));
        if !ok {
            return;
        }
        let free = self.intents_bal[t]
            .saturating_sub(pre.accounted[t])
            .saturating_sub(pre.sweeping[t]);
        let (bal1, trie1, mid) = (self.balance, self.trie.clone(), self.snap());
        self.results = vec![Some(
            near_sdk::serde_json::to_vec(&[U128(self.intents_bal[t])]).unwrap(),
        )];
        let sent = self
            .call(CONTRACT, 0, |c| {
                matches!(
                    c.on_sweep_check(
                        TOKENS[t].into(),
                        OWNER.parse().unwrap(),
                        U128(amt),
                        mid.outflow_seq
                    ),
                    near_sdk::PromiseOrValue::Promise(_)
                )
            })
            .expect("on_sweep_check never panics");
        self.results.clear();
        assert_eq!(
            sent,
            amt <= free,
            "sweep bounded to balance - accounted - sweeping"
        );
        self.check_money(&mid, bal1, &trie1, Kind::Exact(-(sent as i128)));
        let post = self.snap();
        assert_eq!(
            post.accounted, pre.accounted,
            "a sweep never touches accounted"
        );
        assert_eq!(
            post.holdings, pre.holdings,
            "a sweep never touches a holding"
        );
        if !sent {
            return;
        }
        assert_eq!(
            post.sweeping[t],
            pre.sweeping[t] + amt,
            "reserved before the transfer"
        );
        let (bal2, trie2) = (self.balance, self.trie.clone());
        self.results = vec![if fail { None } else { Some(vec![]) }];
        let done = self
            .call(CONTRACT, 0, |c| {
                c.on_sweep_done(TOKENS[t].into(), OWNER.parse().unwrap(), U128(amt))
            })
            .expect("on_sweep_done never panics");
        self.results.clear();
        assert_eq!(done, !fail);
        let fin = self.snap();
        assert_eq!(
            fin.sweeping[t], pre.sweeping[t],
            "the reservation is released"
        );
        assert_eq!(
            fin.accounted, pre.accounted,
            "a sweep never touches accounted"
        );
        if !fail {
            self.intents_bal[t] -= amt;
            assert_eq!(fin.outflow_seq, pre.outflow_seq + 1);
        }
        self.check_money(&post, bal2, &trie2, Kind::Neutral);
    }

    /// Property 1 (per operation) and the state-wide properties 2-4.
    fn check_money(
        &mut self,
        pre: &Snap,
        bal0: u128,
        trie0: &HashMap<Vec<u8>, Vec<u8>>,
        kind: Kind,
    ) {
        let post = self.snap();
        let cost = env::storage_byte_cost().as_yoctonear();
        let free0 = bal0 as i128 - pre.liabilities() as i128;
        let free1 = self.balance as i128 - post.liabilities() as i128;
        assert!(
            free1 >= 0,
            "insolvent: balance {} < liabilities {}",
            self.balance,
            post.liabilities()
        );
        let kept = free1 - free0;
        let added = bytes_added(trie0, &self.trie) as i128 * cost as i128;
        match kind {
            Kind::Neutral => assert_eq!(kept, 0, "neutral op changed balance - liabilities"),
            Kind::PaysStorage => assert_eq!(kept, added, "kept {kept} for {added} of new storage"),
            Kind::Exact(k) => assert_eq!(kept, k, "kept {kept}, expected {k}"),
        }

        // 2. bonds and vaults within what came in minus what went out
        for i in 0..AGENTS {
            assert!(
                self.bond_out[i] <= self.bond_in[i],
                "agent {i} paid out more than came in"
            );
            if let Some(b) = post.bonds[i] {
                assert!(
                    b <= self.bond_in[i] - self.bond_out[i],
                    "agent {i} bond {b} above its ledger"
                );
            }
        }
        for i in 0..4 {
            assert!(
                self.vault_out[i] <= self.vault_in[i],
                "vault {i} paid out more than came in"
            );
            assert!(
                post.vaults[i] <= self.vault_in[i] - self.vault_out[i],
                "vault {i} above its ledger"
            );
        }
        // 2b. every vault starts in this deploy's accounting, so the counted total is exact (deploy 16)
        assert_eq!(
            post.vault_total,
            post.vaults.iter().sum::<u128>(),
            "vault_total != sum(vaults)"
        );
        // 3. no settle takes a mandate over the allowance that bound it: checked in `settle`. A
        // follow may store an allowance below `spent` (the ledger is kept), and from deploy 17 a fill
        // under the previous terms counts against their allowance, so `spent <= allowance` of the
        // current terms is not a state-wide property.
        // 3b. every credited output is someone's holding, and never more than the arena holds
        for t in 0..2 {
            let held: u128 = post.holdings.iter().map(|h| h[t]).sum::<u128>() + self.in_flight[t];
            assert_eq!(
                held, post.accounted[t],
                "sum(holdings) + in-flight withdrawals != accounted for {}",
                TOKENS[t]
            );
            assert!(
                post.accounted[t] + post.sweeping[t] <= self.intents_bal[t],
                "accounted + sweeping above the intents balance for {}",
                TOKENS[t]
            );
        }
        // 4. finished duels are frozen; the open counter matches
        assert_eq!(post.next_duel as usize, self.duels.len());
        let mut open = 0;
        for (i, d) in post.duels.iter().enumerate() {
            let m = &mut self.duels[i];
            if d.resolved {
                assert_eq!(d.pool.0, 0, "finished duel {i} still holds a pool");
                let bytes = near_sdk::borsh::to_vec(d).unwrap();
                match &m.final_bytes {
                    Some(b) => assert!(*b == bytes, "finished duel {i} changed"),
                    None => m.final_bytes = Some(bytes),
                }
            } else {
                open += 1;
                let stakes: u128 = m.recs.iter().map(|r| r.stake).sum();
                assert_eq!(d.pool.0, stakes, "duel {i} pool != escrowed stakes");
                assert_eq!(post.in_duel[m.a], Some(i as u64));
                assert_eq!(post.in_duel[m.b], Some(i as u64));
            }
            // 4b. one record per injection, each with exactly the model's single outcome, and the
            // payouts of a finished duel settled once
            let recs = &post.chaos[i];
            assert_eq!(recs.len(), m.recs.len(), "duel {i} chaos records");
            let pk = |side_b: bool| &self.pks[if side_b { m.b } else { m.a }];
            for (j, (c, r)) in recs.iter().zip(&m.recs).enumerate() {
                let at = format!("duel {i} injection {j}");
                assert_eq!(c.target.0, *pk(r.side_b), "{at} target");
                assert_eq!(
                    c.kind.direction().map(|s| s == Side::Long),
                    r.dir,
                    "{at} kind"
                );
                assert_eq!(c.outcome, r.outcome, "{at} outcome");
                assert_eq!(c.prev, r.prev.map(side_of), "{at} prev");
                assert_eq!(c.next, r.next.map(side_of), "{at} next");
                assert_eq!(c.decided_by.is_some(), r.next.is_some(), "{at} decided_by");
                assert_eq!((c.stake.0, c.at.0), (r.stake, r.at), "{at} stake");
                assert_eq!(
                    (c.payout.0, c.claimed),
                    (r.payout, r.claimed),
                    "{at} payout"
                );
                assert_eq!(c.injector.as_str(), r.injector, "{at} injector");
            }
            // commitments live exactly as long as the duel and match what was committed
            let held = [m.a, m.b].map(|ag| !d.resolved && self.pending.contains_key(&(i, ag)));
            assert_eq!(post.commits[i], held, "duel {i} commitments");
        }
        assert_eq!(post.open_duels, open, "open_duels counter");
    }
}

/// The model's reading of "no tighter on every term", written apart from the contract's
/// `Mandate::no_tighter_than`: an empty token list allows any token, so a restricted list is looser
/// or equal only over a restricted list it contains.
fn looser_or_equal(new: &Mandate, old: &Mandate) -> bool {
    let tokens = match (new.allowed_tokens.is_empty(), old.allowed_tokens.is_empty()) {
        (true, _) => true,
        (false, true) => false,
        (false, false) => old
            .allowed_tokens
            .iter()
            .collect::<HashSet<_>>()
            .is_subset(&new.allowed_tokens.iter().collect()),
    };
    tokens
        && new.allowance.0 >= old.allowance.0
        && new.per_tx_cap.0 >= old.per_tx_cap.0
        && new.min_out_per_near.0 <= old.min_out_per_near.0
        && new.expires_at.0 >= old.expires_at.0
}

/// Bytes of new records plus growth of existing ones between two tries, as the runtime counts
/// them: key + value + 40 per record. Freed bytes do not offset it.
fn bytes_added(before: &HashMap<Vec<u8>, Vec<u8>>, after: &HashMap<Vec<u8>, Vec<u8>>) -> u128 {
    after
        .iter()
        .map(|(k, v)| match before.get(k) {
            None => k.len() + v.len() + 40,
            Some(old) => v.len().saturating_sub(old.len()),
        })
        .sum::<usize>() as u128
}

fn config() -> PropConfig {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(64);
    PropConfig {
        cases,
        failure_persistence: None,
        ..PropConfig::default()
    }
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn arena_money_and_mandate_invariants(
        cfg in (
            (0u16..=10_000, 0u16..=1_000, 0u16..=10_000, any::<bool>(), any::<bool>()),
            prop_oneof![Just(VAULT_CAP), (500u128..6_000).prop_map(|m| m * MILLI)],
            (10u128..300, 10_000u16..=40_000, 1u128..20, 0u16..=1_000, 0u16..=10_000),
        )
            .prop_map(|((slash_bps, fee_bps, no_reveal_bps, commit_reveal, require_consent), account_cap, (base, r_bps, cap_x, chaos_fee, share_bps))| Cfg {
                slash_bps, fee_bps, no_reveal_bps, commit_reveal, require_consent, account_cap,
                chaos: ChaosConfig {
                    base: U128(base * MILLI),
                    r_bps,
                    cap: U128((base * MILLI).max(MIN_CHAOS) * cap_x),
                    fee_bps: chaos_fee,
                    share_bps,
                },
            }),
        ops in (setup(), vec(op(), 1..=40)).prop_map(|(s, t)| [s, t].concat()),
    ) {
        let mut w = World::new(cfg);
        for op in &ops {
            w.step(op);
        }
    }
}

// ---------------------------------------------------------------- regressions found by the property

/// yoctoNEAR for the bytes added to storage since `u0`.
fn bytes_added_since(u0: u64) -> u128 {
    (env::storage_usage() - u0) as u128 * env::storage_byte_cost().as_yoctonear()
}

/// Shrunk case `[Register { agent: 0, milli: 5 }]`: a TEE agent's `tee_agents` entry (77 bytes)
/// was charged twice, once by `storage_cost_since` and again by `set_entry_cost(32)`.
#[test]
fn tee_register_charges_its_storage_once() {
    use crate::tests::{BOND, OPERATOR, ctx, fresh};
    let mut c = fresh(0);
    let (sk, pk) = key(1);
    ctx(OPERATOR, BOND);
    let u0 = env::storage_usage();
    let v = c.register_agent(
        Base64VecU8(pk),
        MODEL_A.into(),
        true,
        register_sig(&sk, OPERATOR),
    );
    assert_eq!(BOND - v.bond.0, bytes_added_since(u0));
}

/// Same double charge in `accept_intent` (`post_intent` and `reveal_intent`): the `used_nonces`
/// entry (85 bytes), plus the `used_proofs` entry (77 bytes) for a TEE agent.
#[test]
fn post_intent_charges_its_storage_once() {
    use crate::tests::{ctx, intent, open, setup};
    let (mut c, _, skb) = setup();
    let d = open(&mut c);
    let pk = key(2).1;
    let bond = |c: &Contract| c.get_agent(Base64VecU8(pk.clone())).unwrap().bond.0;
    let before = bond(&c);
    ctx(SOLVER, 0);
    let u0 = env::storage_usage();
    c.post_intent(sign(&skb, &intent(&pk, d, Side::Long, 5_000, 1)), None);
    assert_eq!(before - bond(&c), bytes_added_since(u0));
}
