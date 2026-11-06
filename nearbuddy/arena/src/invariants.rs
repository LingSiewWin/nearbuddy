//! Property tests over random operation sequences: money conservation, bond and vault bounds,
//! mandate limits, duel finality and slash arithmetic; from deploy 15 also verified settlement
//! (fills credited only against delivered, unaccounted output; sum(holdings) == accounted per token),
//! `withdraw_token` (debit first, exact re-credit on a failed transfer), the vault delay (never paid
//! before `withdraw_delay`) and `sweep_surplus` (bounded to the surplus, never touches accounted).
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
    /// `withdraw`: pay the queued withdrawal once its delay passed.
    Claim {
        who: usize,
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
        ttl_s: u64,
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
    Chaos {
        duel: usize,
        b_side: bool,
        milli: u64,
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
    let ttl_s = prop_oneof![1 => 0u64..300, 4 => 300u64..7_200];
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
    (
        regs,
        deps,
        follows,
        opens,
        vec(post(), 4..8),
        vec(reveal(), 2..4),
    )
        .prop_map(|(r, d, f, o, p, v)| {
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
            [r, d, f, o, p, v, deliver].concat()
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
        0..6usize,
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
        1 => (0..4usize).prop_map(|who| Op::Claim { who }),
        4 => (any::<bool>(), 1u64..3_000_000).prop_map(|(wrap, units)| Op::Deliver { wrap, units }),
        4 => (0..3usize, any::<bool>(), 1u16..=120, prop::bool::weighted(0.3)).prop_map(|(who, wrap, pct, fail)| Op::WithdrawToken { who, wrap, pct, fail }),
        1 => (any::<bool>(), 1u16..=120, prop::bool::weighted(0.3)).prop_map(|(wrap, pct, fail)| Op::Sweep { wrap, pct, fail }),
        2 => follow(fol.clone(), followable()),
        1 => (fol.clone(), followable()).prop_map(|(who, agent)| Op::Unfollow { who, agent }),
        // b = a + 1..=3 (mod 4): the same-agent refusal is covered by the unit tests
        4 => (ag.clone(), 1..AGENTS, 30u64..600, 0u64..20, prop::bool::weighted(0.85), any::<bool>())
            .prop_map(|(a, off, len_s, milli, open_price, consented)| Op::Open { a, b: (a + off) % AGENTS, len_s, milli, open_price, consented }),
        10 => post(),
        6 => reveal(),
        3 => (0..8usize, any::<bool>(), 0u64..500).prop_map(|(duel, b_side, milli)| Op::Chaos { duel, b_side, milli }),
        3 => (0..8usize, prop_oneof![Just(0i64), -500i64..500]).prop_map(|(duel, move_bps)| Op::Resolve { duel, move_bps }),
        5 => (fol, followable(), vec(fill, 0..5)).prop_map(|(who, agent, fills)| Op::Settle { who, agent, fills }),
        1 => (0..8usize).prop_map(|duel| Op::Void { duel }),
        1 => (ag, 0u64..3_000).prop_map(|(agent, milli)| Op::WithdrawBond { agent, milli }),
        1 => Just(Op::WithdrawFees),
        2 => (1u64..400).prop_map(|secs| Op::Advance { secs }),
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
    /// `open_duel`: keeps the whole deposit above `oracle_deposit` (storage plus any overpay).
    Open,
    /// Keeps exactly this much (the 1 yocto an owner or exit call attaches and does not forward;
    /// minus 1 when a callback forwards the yocto it holds).
    Exact(i128),
}

struct DuelM {
    a: usize,
    b: usize,
    close_at: u64,
    chaos_in: u128,
    /// Borsh bytes at the first check that saw it finished; must never change afterwards.
    final_bytes: Option<Vec<u8>>,
}

#[derive(Clone)]
struct Snap {
    bonds: [Option<u128>; AGENTS],
    in_duel: [Option<u64>; AGENTS],
    vaults: [u128; 4],
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
}

impl Snap {
    fn liabilities(&self) -> u128 {
        self.bonds.iter().flatten().sum::<u128>()
            + self.vaults.iter().sum::<u128>()
            + self.duels.iter().map(|d| d.pool.0).sum::<u128>()
            + self.fees
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
}

/// Intent, salt and TEE proof behind one unrevealed commitment.
type Pending = (Intent, Vec<u8>, Option<TeeProof>);

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
    settled: HashSet<(usize, usize, u64)>,
    proofs: u64,
    /// The arena's balance on the intents stub per token (0 wrap.near, 1 usdc.near).
    intents_bal: [u128; 2],
    /// Promise results the next call sees (a callback's view or transfer outcome): `None` = failed.
    results: Vec<Option<Vec<u8>>>,
    /// Queued vault withdrawals: (amount, ready_at).
    requests: [Option<(u128, u64)>; 4],
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
            settled: HashSet::new(),
            proofs: 0,
            intents_bal: [0; 2],
            results: vec![],
            requests: [None; 4],
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
            in_duel: std::array::from_fn(|i| agent(i).and_then(|a| a.in_duel.map(|d| d.0))),
            vaults: std::array::from_fn(|i| {
                let id: AccountId = ACCOUNTS[i].parse().unwrap();
                c.vaults.get(&id).copied().unwrap_or(0)
            }),
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
        let mut open_keep = 0u128;
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
                if self.call(ACCOUNTS[who], amt, |c| c.deposit()).is_ok() {
                    self.vault_in[who] += amt;
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
            Op::Claim { who } => {
                let ok = self.call(ACCOUNTS[who], 1, |c| drop(c.withdraw())).is_ok();
                if ok {
                    let (amt, ready_at) =
                        self.requests[who].take().expect("paid without a request");
                    assert!(self.now >= ready_at, "withdraw paid before its delay");
                    let paid = pre.vaults[who] - self.snap().vaults[who];
                    assert_eq!(paid, amt.min(pre.vaults[who]), "pays min(requested, vault)");
                    self.vault_out[who] += paid;
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
                    expires_at: U64(self.now + ttl_s * SEC),
                    revoked,
                    min_out_per_near: U128(floor as u128),
                    revoked_at: U64(12_345), // ignored on input: `follow` stores 0
                };
                let pk = Base64VecU8(self.pks[agent].clone());
                let r = self.call(ACCOUNTS[who], 0, |c| c.follow(pk, m));
                if floor == 0 {
                    assert!(r.is_err(), "a follow without a price floor was accepted");
                }
                if r.is_ok() {
                    let m = self.snap().mandate(agent, who).cloned().expect("stored");
                    assert_eq!(m.revoked_at.0, 0, "follow resets revoked_at");
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
                kind = Kind::Open;
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
                        chaos_in: 0,
                        final_bytes: None,
                    });
                    open_keep = dep - ORACLE_DEPOSIT;
                    if open_price {
                        self.check_money(&pre, bal0, &trie0, kind, open_keep);
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
                    if self
                        .call("relayer.testnet", 0, |c| {
                            c.commit_intent(U64(d as u64), pk, Base64VecU8(hash), Base64VecU8(sig))
                        })
                        .is_ok()
                    {
                        self.pending.insert((d, ag), (i, salt, proof));
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
                let (i, salt, proof) = self.pending[&(d, ag)].clone();
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
                }
            }
            Op::Chaos {
                duel,
                b_side,
                milli,
            } => {
                kind = Kind::PaysStorage;
                let Some(d) = self.duel(duel, |i| {
                    !pre.duels[i].resolved && self.now + 10 * SEC < self.duels[i].close_at
                }) else {
                    return;
                };
                let amt = milli as u128 * MILLI;
                let target = Base64VecU8(
                    self.pks[if b_side {
                        self.duels[d].b
                    } else {
                        self.duels[d].a
                    }]
                    .clone(),
                );
                if self
                    .call("spectator.testnet", amt, |c| {
                        c.inject_chaos(
                            U64(d as u64),
                            target,
                            "prompt".into(),
                            Base64VecU8(vec![9; 32]),
                        )
                    })
                    .is_ok()
                {
                    self.duels[d].chaos_in += amt;
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
                    self.check_money(&pre, bal0, &trie0, kind, 0);
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
                    let (sa, sb) = (pool / 2 + pool % 2, pool / 2);
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
            Op::Advance { secs } => self.now += secs * SEC,
        }
        self.check_money(&pre, bal0, &trie0, kind, open_keep);
    }

    /// Records an accepted intent (posted or revealed) of agent `ag`.
    fn accepted(&mut self, ag: usize, nonce: u64) {
        assert!(!self.posted[ag].contains(&nonce), "nonce accepted twice");
        self.posted[ag].push(nonce);
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
        self.check_money(&pre, bal0, &trie0, Kind::Neutral, 0);
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
        match a_wins {
            None => {
                assert!(o.winner.is_none() && o.slashed.0 == 0, "tie must not slash");
                na += pool / 2 + pool % 2;
                nb += pool / 2;
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
                *lb -= slashed;
                *wb += pool + slashed;
            }
        }
        assert_eq!(post.bonds[a], Some(na), "bond a after resolution");
        assert_eq!(post.bonds[b], Some(nb), "bond b after resolution");
        assert_eq!(post.fees, fees, "owner fees after resolution");
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
                // one in len+1 is a nonce the agent never posted
                intent_nonce: U64(self.posted[agent]
                    .get(s.nonce % (self.posted[agent].len() + 1))
                    .copied()
                    .unwrap_or(1_000)),
                token: TOKENS[!s.wrap as usize].into(),
                amount_in: U128(s.milli as u128 * MILLI),
                amount_out: U128(s.out as u128),
                swap_tx: "tx".into(),
            })
            .collect();
        let pk = Base64VecU8(self.pks[agent].clone());
        let follower: AccountId = ACCOUNTS[who].parse().unwrap();
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
                if m.revoked && self.now >= m.revoked_at.0 + DELAY {
                    Err("mandate revoked")
                } else if self.now >= m.expires_at.0 + DELAY {
                    Err("mandate expired")
                } else if !m.allowed_tokens.is_empty() && !m.allowed_tokens.contains(&f.token) {
                    Err("token not allowed")
                } else if debit > m.per_tx_cap.0 {
                    Err("over cap")
                } else if m.spent.0 + debit > m.allowance.0 {
                    Err("allowance exhausted")
                } else if m.min_out_per_near.0 > 0 && out * NEAR < amt * m.min_out_per_near.0 {
                    Err("below min price")
                } else if out == 0 || out > surplus[t] {
                    Err("no receipt")
                } else if vault < debit {
                    Err("insufficient")
                } else {
                    m.spent.0 += debit;
                    vault -= debit;
                    surplus[t] -= out;
                    accepted.insert(n);
                    Ok((amt, out))
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
                return self.check_money(pre, bal0, &trie0, Kind::Neutral, 0);
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
        }
        for f in fills.iter().zip(&expect).filter(|(_, r)| r.is_ok()) {
            self.settled.insert((agent, who, f.0.intent_nonce.0));
        }
        self.vault_out[who] += amt_in + fees;
        self.vault_in[SOLVER_IX] += amt_in;
        self.check_money(pre, bal0, &trie0, Kind::Neutral, 0);
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
        self.check_money(pre, bal0, &trie0, Kind::Neutral, 0);
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
        self.check_money(&mid, bal1, &trie1, Kind::Neutral, 0);
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
        self.check_money(pre, bal0, &trie0, Kind::Exact(ok as i128), 0);
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
        self.check_money(&mid, bal1, &trie1, Kind::Exact(-(sent as i128)), 0);
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
        self.check_money(&post, bal2, &trie2, Kind::Neutral, 0);
    }

    /// Property 1 (per operation) and the state-wide properties 2-4.
    fn check_money(
        &mut self,
        pre: &Snap,
        bal0: u128,
        trie0: &HashMap<Vec<u8>, Vec<u8>>,
        kind: Kind,
        open_keep: u128,
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
            Kind::Open => {
                assert!(
                    kept == open_keep as i128 && kept >= added,
                    "open_duel kept {kept}, storage {added}"
                )
            }
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
        // 3. no mandate over its allowance (generated mandates start within it)
        for (a, w, m) in &post.mandates {
            assert!(
                m.spent.0 <= m.allowance.0,
                "mandate {a}/{w} spent over allowance"
            );
        }
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
                assert!(d.pool.0 <= m.chaos_in, "duel {i} pool above chaos paid in");
                assert_eq!(post.in_duel[m.a], Some(i as u64));
                assert_eq!(post.in_duel[m.b], Some(i as u64));
            }
            // commitments live exactly as long as the duel and match what was committed
            let held = [m.a, m.b].map(|ag| !d.resolved && self.pending.contains_key(&(i, ag)));
            assert_eq!(post.commits[i], held, "duel {i} commitments");
        }
        assert_eq!(post.open_duels, open, "open_duels counter");
    }
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
        cfg in (0u16..=10_000, 0u16..=1_000, 0u16..=10_000, any::<bool>(), any::<bool>())
            .prop_map(|(slash_bps, fee_bps, no_reveal_bps, commit_reveal, require_consent)| Cfg {
                slash_bps, fee_bps, no_reveal_bps, commit_reveal, require_consent,
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
