//! NearBuddy predict: a free call on the arena.
//!
//! A spectator calls, before the answer is public, whether the arena's model is fooled by a
//! planted headline (`Flipped` or `Held`, one market per chaos injection) or who wins a duel (`A`,
//! `B` or `Tie`, one market per duel). There is no stake. A call attaches `DEPOSIT`, which pays the
//! storage of the prediction's record and comes back whole with `claim` once it is scored. Right
//! calls climb a public board (`get_board`).
//!
//! The arena is only read, through its views, never written:
//! - a chaos market `(duel_id, Some(index))` takes predictions while
//!   `get_chaos(duel_id)[index].outcome` is `Pending`. The arena leaves `Pending` in the receipt
//!   that reveals the target's deciding decision (committed hidden, after the injection) or
//!   finishes the duel, so no public fact decides the market while it is open;
//! - a duel market `(duel_id, None)` takes predictions while
//!   `now + duel_lock(duel_id) < get_duel(duel_id).close_at`, the arena's own test for taking a new
//!   commitment. After that moment no decision can change and the last ones are still hidden.
//!
//! `predict` asks those views and accepts in its callback, so the test runs against the arena's
//! state when the view ran, never against what a client says. A refused prediction's deposit goes
//! straight back. `settle(duel_id)` (anyone) reads `get_duel` and `get_chaos`, fixes the outcome of
//! every market of that duel the arena has decided (once), and scores up to `SCORE_PAGE`
//! predictions; it returns how many are left, and anyone calls it again while that is above 0. A
//! failed or unreadable arena answer panics the callback, which changes nothing.
//!
//! Scoring: a prediction is `Right` when its pick is the market's outcome, `Wrong` otherwise, and
//! `Void` (refunded, not counted) when the market has no outcome: a chaos injection that met no
//! trial or expired, or a voided duel. The board ranks by right minus wrong, so guessing at random
//! does not climb it.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::serde::Deserialize;
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, env, near,
    require,
};

#[cfg(test)]
mod tests;

/// Attached to every `predict` (0.003 NEAR) and refunded whole by `claim` after scoring. It pays
/// the prediction's record and its entry in the account's held list: at most 264 bytes, a
/// 64-character implicit account's first prediction (`tests::deposit_covers_the_largest_prediction`).
pub const DEPOSIT: u128 = 3_000_000_000_000_000_000_000;
/// Most injections one arena duel takes (the arena's `MAX_INJECTIONS`): chaos markets per duel.
/// With the duel market, an account holds at most 33 predictions per duel (one per market).
pub const MAX_INJECTIONS: u32 = 32;
/// Most predictions an account holds at once (open, or scored and not yet claimed).
pub const MAX_HELD: u32 = 64;
/// Most predictions one `settle` scores.
pub const SCORE_PAGE: u32 = 50;
/// Market slot of a duel's winner market; a chaos market's slot is the injection index.
const DUEL_SLOT: u32 = u32::MAX;
/// Each arena view: `get_chaos` serializes up to 32 records with 280-byte headlines.
const VIEW_GAS: Gas = Gas::from_tgas(10);
/// Floor for `on_predict`; it also gets the unused gas.
const PREDICT_CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// Floor for `on_settle`; it also gets the unused gas.
const SETTLE_CALLBACK_GAS: Gas = Gas::from_tgas(40);
/// Largest arena answer read: 32 chaos records are about 25 KB.
const MAX_ANSWER: usize = 256 * 1024;

/// A call on one market. `Flipped` and `Held` go with a chaos injection, `A`, `B` and `Tie` with
/// a duel (`A` and `B` are the duel's `a` and `b` agents).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pick {
    Flipped,
    Held,
    A,
    B,
    Tie,
}

impl Pick {
    fn slot(self) -> usize {
        match self {
            Pick::Flipped | Pick::A => 0,
            Pick::Held | Pick::B => 1,
            Pick::Tie => 2,
        }
    }

    fn on_chaos(self) -> bool {
        matches!(self, Pick::Flipped | Pick::Held)
    }
}

/// How a scored prediction came out. `Void`: the market had no outcome; refunded, not counted.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verdict {
    Right,
    Wrong,
    Void,
}

#[near(serializers = [borsh])]
#[derive(Default)]
pub(crate) struct Market {
    /// Predictions per pick (`Pick::slot`).
    counts: [u32; 3],
    /// Predictions made; entry `seq` of this market is `(duel, slot, seq)` for `seq < n`.
    n: u32,
    /// The first `scored` entries have a verdict.
    scored: u32,
    /// Set once by `on_settle`: `Some(Some(pick))` won, `Some(None)` void.
    outcome: Option<Option<Pick>>,
}

#[near(serializers = [borsh])]
pub(crate) struct Entry {
    account: AccountId,
    pick: Pick,
    /// Block time of the callback that accepted it (ns).
    at: u64,
    verdict: Option<Verdict>,
}

/// One account's scored predictions (`Void` not counted).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Stats {
    pub count: u32,
    pub right: u32,
    /// Right calls in a row, in the order they were scored.
    pub streak: u32,
    pub best: u32,
}

#[near(serializers = [json])]
pub struct BoardRow {
    pub account: AccountId,
    pub count: u32,
    pub right: u32,
    pub streak: u32,
    pub best: u32,
}

#[near(serializers = [json])]
pub struct PickCount {
    pub pick: Pick,
    pub n: u32,
}

/// The crowd's split on one market and, once settled, its outcome.
#[near(serializers = [json])]
pub struct MarketView {
    pub duel_id: U64,
    /// The chaos injection's index in `get_chaos(duel_id)`; `None` for the duel market.
    pub index: Option<u32>,
    /// `Flipped`, `Held` for a chaos market; `A`, `B`, `Tie` for a duel market.
    pub picks: Vec<PickCount>,
    pub total: u32,
    pub settled: bool,
    /// The winning pick; `None` while open, or when settled void.
    pub outcome: Option<Pick>,
    /// Predictions scored so far.
    pub scored: u32,
}

/// One prediction an account still holds: open, or scored and not yet claimed.
#[near(serializers = [json])]
pub struct PredictionView {
    pub duel_id: U64,
    pub index: Option<u32>,
    pub pick: Pick,
    /// When it was accepted (ns).
    pub at: U64,
    /// `None` until scored.
    pub verdict: Option<Verdict>,
}

#[near(serializers = [json])]
pub struct Config {
    pub arena: AccountId,
    pub deposit: U128,
    pub max_held: u32,
    pub max_injections: u32,
    pub score_page: u32,
}

// The arena's view JSON, only the fields read here. An unknown chaos outcome fails the parse.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ArenaDuel {
    id: U64,
    a: Base64VecU8,
    b: Base64VecU8,
    close_at: U64,
    resolved: bool,
    outcome: Option<ArenaOutcome>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ArenaOutcome {
    open_price: U64,
    close_price: U64,
    winner: Option<Base64VecU8>,
}

#[derive(Deserialize, PartialEq)]
#[serde(crate = "near_sdk::serde")]
enum ChaosOutcome {
    Pending,
    Flipped,
    Held,
    NoTrial,
    Expired,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ArenaChaos {
    outcome: ChaosOutcome,
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Markets,
    Entries,
    Held,
    Board,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    arena: AccountId,
    /// `(duel_id, slot)`.
    markets: LookupMap<(u64, u32), Market>,
    /// `(duel_id, slot, seq)`; removed by `claim`.
    entries: LookupMap<(u64, u32, u32), Entry>,
    /// Keys of the entries an account holds, at most `MAX_HELD`; removed when empty.
    held: LookupMap<AccountId, Vec<(u64, u32, u32)>>,
    /// Every account with a scored prediction.
    /// ponytail: kept for good at the contract's cost (about 0.0015 NEAR per account); a pruned
    /// top-N board if strangers number in the thousands.
    board: IterableMap<AccountId, Stats>,
}

/// Promise result `i` of this callback as JSON.
fn answer<T: DeserializeOwned>(i: u64) -> Result<T, &'static str> {
    if env::promise_results_count() <= i {
        return Err("arena failed");
    }
    let bytes = env::promise_result_checked(i, MAX_ANSWER).map_err(|_| "arena failed")?;
    serde_json::from_slice(&bytes).map_err(|_| "arena answer unreadable")
}

/// Whether the market is still open, by the arena's answers to `predict`'s views.
fn still_open(id: u64, index: Option<u32>) -> Result<(), &'static str> {
    match index {
        None => {
            let duel: Option<ArenaDuel> = answer(0)?;
            let lock: Option<U64> = answer(1)?;
            let (Some(d), Some(lock)) = (duel, lock) else {
                return Err("duel missing");
            };
            if d.id.0 != id {
                return Err("arena answer unreadable");
            }
            if d.resolved || env::block_timestamp().saturating_add(lock.0) >= d.close_at.0 {
                return Err("predictions closed");
            }
            Ok(())
        }
        Some(i) => {
            let list: Vec<ArenaChaos> = answer(0)?;
            match list.get(i as usize) {
                None => Err("injection missing"),
                Some(c) if c.outcome == ChaosOutcome::Pending => Ok(()),
                Some(_) => Err("predictions closed"),
            }
        }
    }
}

/// The duel market's outcome once the arena resolved it; `None` (void) for a voided duel.
fn duel_outcome(d: &ArenaDuel) -> Option<Pick> {
    let o = d.outcome.as_ref()?;
    // `void_duel` records a tie with no prices; a scored duel always has an open price
    if o.open_price.0 == 0 && o.close_price.0 == 0 {
        return None;
    }
    match &o.winner {
        None => Some(Pick::Tie),
        Some(w) if w.0 == d.a.0 => Some(Pick::A),
        Some(w) if w.0 == d.b.0 => Some(Pick::B),
        Some(_) => None,
    }
}

fn picks_of(index: Option<u32>) -> &'static [Pick] {
    if index.is_some() {
        &[Pick::Flipped, Pick::Held]
    } else {
        &[Pick::A, Pick::B, Pick::Tie]
    }
}

fn index_of(slot: u32) -> Option<u32> {
    (slot != DUEL_SLOT).then_some(slot)
}

fn event(name: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "nearbuddy-predict", "version": "1.0.0", "event": name, "data": data})
    ));
}

#[near]
impl Contract {
    /// `arena`: the arena contract whose views decide every market. It cannot change.
    #[init]
    pub fn new(arena: AccountId) -> Self {
        Self {
            arena,
            markets: LookupMap::new(StorageKey::Markets),
            entries: LookupMap::new(StorageKey::Entries),
            held: LookupMap::new(StorageKey::Held),
            board: IterableMap::new(StorageKey::Board),
        }
    }

    /// Call `pick` on a market: a chaos injection (`index` = its index in `get_chaos(duel_id)`,
    /// pick `Flipped` or `Held`) or the duel (`index` = `None`, pick `A`, `B` or `Tie`). One call
    /// per account per market. Accepted in `on_predict` only if the arena's views show the market
    /// open (see the crate doc); otherwise the deposit goes back. Returns that promise.
    /// Caller: anyone. Deposit: exactly `DEPOSIT`. Panics: "attach exactly the deposit", "pick does
    /// not fit the market", "index out of range", "predictions closed", "already predicted", "too
    /// many open predictions: claim first".
    #[payable]
    pub fn predict(&mut self, duel_id: U64, index: Option<u32>, pick: Pick) -> Promise {
        require!(
            env::attached_deposit().as_yoctonear() == DEPOSIT,
            "attach exactly the deposit"
        );
        let who = env::predecessor_account_id();
        if let Some(why) = self.refusal(&who, duel_id.0, index, pick) {
            env::panic_str(why);
        }
        let ask = match index {
            None => self
                .view("get_duel", duel_id)
                .and(self.view("duel_lock", duel_id)),
            Some(_) => self.view("get_chaos", duel_id),
        };
        ask.then(
            Self::ext(env::current_account_id())
                .with_static_gas(PREDICT_CALLBACK_GAS)
                .on_predict(who, duel_id, index, pick),
        )
    }

    /// `predict`'s callback: stores the prediction if the market is still open, else sends the
    /// deposit back. Returns whether it was accepted. Never panics, so a refused deposit is never
    /// kept. Caller: this contract (private).
    #[private]
    pub fn on_predict(
        &mut self,
        account: AccountId,
        duel_id: U64,
        index: Option<u32>,
        pick: Pick,
    ) -> bool {
        let id = duel_id.0;
        let why = match self.refusal(&account, id, index, pick) {
            Some(why) => Some(why),
            None => still_open(id, index).err(),
        };
        if let Some(why) = why {
            event(
                "refuse",
                json!({"account": account, "duel_id": duel_id, "index": index, "reason": why}),
            );
            let _ = Promise::new(account).transfer(NearToken::from_yoctonear(DEPOSIT));
            return false;
        }
        let slot = index.unwrap_or(DUEL_SLOT);
        let m = self.markets.entry((id, slot)).or_default();
        let seq = m.n;
        m.n += 1;
        m.counts[pick.slot()] += 1;
        self.entries.insert(
            (id, slot, seq),
            Entry {
                account: account.clone(),
                pick,
                at: env::block_timestamp(),
                verdict: None,
            },
        );
        self.held
            .entry(account.clone())
            .or_default()
            .push((id, slot, seq));
        event(
            "predict",
            json!({"account": account, "duel_id": duel_id, "index": index, "pick": pick}),
        );
        true
    }

    /// Read the arena's `get_duel` and `get_chaos` for `duel_id`, then settle and score in
    /// `on_settle`. Caller: anyone. Deposit: none. Panics in the callback (changing nothing): "arena
    /// failed", "arena answer unreadable", "duel missing".
    pub fn settle(&mut self, duel_id: U64) -> Promise {
        self.view("get_duel", duel_id)
            .and(self.view("get_chaos", duel_id))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SETTLE_CALLBACK_GAS)
                    .on_settle(duel_id),
            )
    }

    /// `settle`'s callback. Fixes, once, the outcome of each market of the duel the arena has
    /// decided: a chaos market when its injection left `Pending` (`Flipped`, `Held`; void on
    /// `NoTrial` or `Expired`), the duel market when the duel resolved (`A`, `B`, `Tie`; void when
    /// voided). Then scores up to `SCORE_PAGE` predictions of settled markets, in order, and returns
    /// how many are still unscored. Caller: this contract (private).
    #[private]
    pub fn on_settle(&mut self, duel_id: U64) -> u32 {
        let id = duel_id.0;
        let duel: Option<ArenaDuel> = answer(0).unwrap_or_else(|e| env::panic_str(e));
        let chaos: Vec<ArenaChaos> = answer(1).unwrap_or_else(|e| env::panic_str(e));
        let duel = duel.unwrap_or_else(|| env::panic_str("duel missing"));
        require!(duel.id.0 == id, "arena answer unreadable");
        let n = chaos.len().min(MAX_INJECTIONS as usize) as u32;
        for (i, c) in chaos.iter().take(n as usize).enumerate() {
            let won = match c.outcome {
                ChaosOutcome::Pending => continue,
                ChaosOutcome::Flipped => Some(Pick::Flipped),
                ChaosOutcome::Held => Some(Pick::Held),
                ChaosOutcome::NoTrial | ChaosOutcome::Expired => None,
            };
            self.decide(id, i as u32, won);
        }
        if duel.resolved {
            self.decide(id, DUEL_SLOT, duel_outcome(&duel));
        }
        let mut budget = SCORE_PAGE;
        (0..n)
            .chain([DUEL_SLOT])
            .map(|slot| self.score(id, slot, &mut budget))
            .sum()
    }

    /// Pay the caller the deposits of every prediction it holds that has been scored, and forget
    /// those predictions (their record stays in the market counts, the board and the logs).
    /// Returns the amount sent. Caller: a predictor. Deposit: none. Panics: "nothing to claim".
    pub fn claim(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        let mut list = self.held.remove(&who).unwrap_or_default();
        let before = list.len();
        let entries = &mut self.entries;
        list.retain(|k| {
            let done = entries.get(k).is_some_and(|e| e.verdict.is_some());
            if done {
                entries.remove(k);
            }
            !done
        });
        let n = (before - list.len()) as u128;
        require!(n > 0, "nothing to claim");
        if !list.is_empty() {
            self.held.insert(who.clone(), list);
        }
        let amount = n * DEPOSIT;
        event(
            "claim",
            json!({"account": who, "n": n as u32, "amount": U128(amount)}),
        );
        let _ = Promise::new(who).transfer(NearToken::from_yoctonear(amount));
        U128(amount)
    }

    /// The arena account, the deposit and the bounds. View: anyone, no deposit, no panics.
    pub fn get_config(&self) -> Config {
        Config {
            arena: self.arena.clone(),
            deposit: U128(DEPOSIT),
            max_held: MAX_HELD,
            max_injections: MAX_INJECTIONS,
            score_page: SCORE_PAGE,
        }
    }

    /// One market's crowd split and outcome; `None` before its first prediction. View: anyone,
    /// no deposit, no panics.
    pub fn get_market(&self, duel_id: U64, index: Option<u32>) -> Option<MarketView> {
        let slot = index.unwrap_or(DUEL_SLOT);
        self.market_view(duel_id.0, slot)
    }

    /// Every market of a duel with at least one prediction: the duel market first, then chaos
    /// markets by index. View: anyone, no deposit, no panics.
    pub fn get_duel_markets(&self, duel_id: U64) -> Vec<MarketView> {
        [DUEL_SLOT]
            .into_iter()
            .chain(0..MAX_INJECTIONS)
            .filter_map(|slot| self.market_view(duel_id.0, slot))
            .collect()
    }

    /// The predictions `account` holds, oldest first: open ones and scored ones not yet claimed.
    /// Claimed ones live on in `get_stats` and the `predict` / `settle` logs. View: anyone, no
    /// deposit, no panics.
    pub fn get_predictions(&self, account: AccountId) -> Vec<PredictionView> {
        let Some(list) = self.held.get(&account) else {
            return vec![];
        };
        list.iter()
            .filter_map(|k| {
                let e = self.entries.get(k)?;
                Some(PredictionView {
                    duel_id: U64(k.0),
                    index: index_of(k.1),
                    pick: e.pick,
                    at: U64(e.at),
                    verdict: e.verdict,
                })
            })
            .collect()
    }

    /// `account`'s scored record; `None` before its first non-void verdict. View: anyone, no
    /// deposit, no panics.
    pub fn get_stats(&self, account: AccountId) -> Option<Stats> {
        self.board.get(&account).copied()
    }

    /// Predictors ranked by right minus wrong, then best streak, then account; `limit` (at most
    /// 100) from rank `from`. ponytail: sorts every row per call, like the arena's leaderboard; a
    /// sorted index once predictors number in the thousands. View: anyone, no deposit, no panics.
    pub fn get_board(&self, from: u32, limit: u32) -> Vec<BoardRow> {
        let net = |s: &Stats| 2 * s.right as i64 - s.count as i64;
        let mut rows: Vec<(&AccountId, &Stats)> = self.board.iter().collect();
        rows.sort_by(|(xa, x), (ya, y)| {
            net(y)
                .cmp(&net(x))
                .then(y.best.cmp(&x.best))
                .then(xa.cmp(ya))
        });
        rows.into_iter()
            .skip(from as usize)
            .take(limit.min(100) as usize)
            .map(|(a, s)| BoardRow {
                account: a.clone(),
                count: s.count,
                right: s.right,
                streak: s.streak,
                best: s.best,
            })
            .collect()
    }
}

impl Contract {
    /// Why `account` cannot call `pick` on this market, from this contract's own state.
    fn refusal(
        &self,
        account: &AccountId,
        id: u64,
        index: Option<u32>,
        pick: Pick,
    ) -> Option<&'static str> {
        if pick.on_chaos() != index.is_some() {
            return Some("pick does not fit the market");
        }
        if index.is_some_and(|i| i >= MAX_INJECTIONS) {
            return Some("index out of range");
        }
        let slot = index.unwrap_or(DUEL_SLOT);
        if self
            .markets
            .get(&(id, slot))
            .is_some_and(|m| m.outcome.is_some())
        {
            return Some("predictions closed");
        }
        // an entry leaves `held` only by `claim`, after its market settled (refused above)
        let held = self.held.get(account).map_or(&[][..], |h| h.as_slice());
        if held.iter().any(|&(d, s, _)| (d, s) == (id, slot)) {
            return Some("already predicted");
        }
        if held.len() >= MAX_HELD as usize {
            return Some("too many open predictions: claim first");
        }
        None
    }

    fn view(&self, method: &str, duel_id: U64) -> Promise {
        Promise::new(self.arena.clone()).function_call_weight(
            method.to_string(),
            json!({ "duel_id": duel_id }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            VIEW_GAS,
            GasWeight(0),
        )
    }

    /// Sets an existing, unsettled market's outcome.
    fn decide(&mut self, id: u64, slot: u32, won: Option<Pick>) {
        let Some(m) = self.markets.get_mut(&(id, slot)) else {
            return;
        };
        if m.outcome.is_some() {
            return;
        }
        m.outcome = Some(won);
        event(
            "settle",
            json!({"duel_id": U64(id), "index": index_of(slot), "outcome": won, "total": m.n}),
        );
    }

    /// Scores a settled market's next unscored entries within `budget`; returns how many are left.
    fn score(&mut self, id: u64, slot: u32, budget: &mut u32) -> u32 {
        let Some(m) = self.markets.get_mut(&(id, slot)) else {
            return 0;
        };
        let Some(won) = m.outcome else {
            return 0;
        };
        while m.scored < m.n && *budget > 0 {
            // entries at or above `scored` have no verdict, so `claim` has not removed them
            let e = self
                .entries
                .get_mut(&(id, slot, m.scored))
                .expect("entry missing");
            let v = match won {
                None => Verdict::Void,
                Some(p) if p == e.pick => Verdict::Right,
                Some(_) => Verdict::Wrong,
            };
            e.verdict = Some(v);
            if v != Verdict::Void {
                let s = self.board.entry(e.account.clone()).or_default();
                s.count += 1;
                if v == Verdict::Right {
                    s.right += 1;
                    s.streak += 1;
                    s.best = s.best.max(s.streak);
                } else {
                    s.streak = 0;
                }
            }
            m.scored += 1;
            *budget -= 1;
        }
        m.n - m.scored
    }

    fn market_view(&self, id: u64, slot: u32) -> Option<MarketView> {
        let m = self.markets.get(&(id, slot))?;
        let index = index_of(slot);
        Some(MarketView {
            duel_id: U64(id),
            index,
            picks: picks_of(index)
                .iter()
                .map(|&p| PickCount {
                    pick: p,
                    n: m.counts[p.slot()],
                })
                .collect(),
            total: m.n,
            settled: m.outcome.is_some(),
            outcome: m.outcome.flatten(),
            scored: m.scored,
        })
    }
}
