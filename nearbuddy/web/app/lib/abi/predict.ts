// Generated from abi/predict.json by packages/protocol/src/abi/gen.ts (bun run gen:types). Do not edit.

export interface BoardRow {
  /**
   * NEAR Account Identifier.
   *
   * This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
   *
   * [See the crate-level docs for information about validation.](index.html#account-id-rules)
   *
   * Also see [Error kind precedence](AccountId#error-kind-precedence).
   *
   * ## Examples
   *
   * ``` use near_account_id::AccountId;
   *
   * let alice: AccountId = "alice.near".parse().unwrap();
   *
   * assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
   */
  account: string;
  best: number;
  count: number;
  right: number;
  streak: number;
}

export interface Config {
  /**
   * NEAR Account Identifier.
   *
   * This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
   *
   * [See the crate-level docs for information about validation.](index.html#account-id-rules)
   *
   * Also see [Error kind precedence](AccountId#error-kind-precedence).
   *
   * ## Examples
   *
   * ``` use near_account_id::AccountId;
   *
   * let alice: AccountId = "alice.near".parse().unwrap();
   *
   * assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
   */
  arena: string;
  deposit: string;
  max_held: number;
  max_injections: number;
  min_ranked: number;
  score_page: number;
  top_n: number;
}

/** The crowd's split on one market and, once settled, its outcome. */
export interface MarketView {
  duel_id: string;
  /** The chaos injection's index in `get_chaos(duel_id)`; `None` for the duel market. */
  index: number | null;
  /** Chaos market opened against an arena without `chaos_open`: it closes at the target's reveal, not at its commit, so whoever runs the target knows the outcome before it closes. */
  open_until_reveal: boolean;
  /** The winning pick; `None` while open, or when settled void. */
  outcome: Pick | null;
  /** `Flipped`, `Held` for a chaos market; `A`, `B`, `Tie` for a duel market. */
  picks: PickCount[];
  /** Predictions scored so far. */
  scored: number;
  settled: boolean;
  /** Chaos market: the target's owner when the target is a keyed agent. That owner chooses which completion its agent signs, so it can steer the outcome. `None` for a duel market, when the arena had no `chaos_open` view, or for a keyless target. For a keyless target `None` means no single owner, not that nobody can steer: any keeper may resample the public request and submit the reply it likes (the side changes on about 11% of real duel prompts). */
  steered_by: string | null;
  total: number;
}

/** A call on one market. `Flipped` and `Held` go with a chaos injection, `A`, `B` and `Tie` with a duel (`A` and `B` are the duel's `a` and `b` agents). */
export type Pick = "Flipped" | "Held" | "A" | "B" | "Tie";

export interface PickCount {
  n: number;
  pick: Pick;
}

/** One prediction an account still holds: open, or scored and not yet claimed. */
export interface PredictionView {
  /** When it was accepted (ns). */
  at: string;
  duel_id: string;
  index: number | null;
  pick: Pick;
  /** `None` until scored. */
  verdict: Verdict | null;
}

/** One account's scored predictions (`Void` not counted). */
export interface Stats {
  best: number;
  count: number;
  right: number;
  /** The storage of this row, kept back from the account's next `claim` (then 0). The row outlives every prediction, so its owner pays it once instead of the contract. */
  storage_owed: string;
  /** Right calls in a row, in the order they were scored (shown, not ranked on). */
  streak: number;
}

/** How a scored prediction came out. `Void`: the market had no outcome; refunded, not counted. */
export type Verdict = "Right" | "Wrong" | "Void";

export interface PredictViews {
  contract_source_metadata: { args: Record<string, never>; result: unknown };
  /**
   * The board: up to `TOP_N` accounts with at least `MIN_RANKED` scored calls, ranked by right
   *  minus wrong, then account; `limit` (at most 100) from rank `from`. Reads at most `TOP_N`
   *  rows whatever the number of predictors. View: anyone, no deposit, no panics.
   */
  get_board: { args: { from: number; limit: number }; result: BoardRow[] };
  /** The arena account, the deposit and the bounds. View: anyone, no deposit, no panics. */
  get_config: { args: Record<string, never>; result: Config };
  /**
   * Every market of a duel with at least one prediction: the duel market first, then chaos
   *  markets by index. View: anyone, no deposit, no panics.
   */
  get_duel_markets: { args: { duel_id: string }; result: MarketView[] };
  /**
   * One market's crowd split and outcome; `None` before its first prediction. View: anyone,
   *  no deposit, no panics.
   */
  get_market: { args: { duel_id: string; index: number | null }; result: MarketView | null };
  /**
   * The predictions `account` holds, oldest first: open ones and scored ones not yet claimed.
   *  Claimed ones live on in `get_stats` and the `predict` / `settle` logs. View: anyone, no
   *  deposit, no panics.
   */
  get_predictions: { args: { account: string }; result: PredictionView[] };
  /**
   * `account`'s scored record; `None` before its first non-void verdict. View: anyone, no
   *  deposit, no panics.
   */
  get_stats: { args: { account: string }; result: Stats | null };
}

export interface PredictCalls {
  /**
   * Pay the caller the deposits of every prediction it holds that has been scored, less its
   *  board row's storage the first time (`Stats.storage_owed`), and forget those predictions
   *  (their record stays in the market counts, the board and the logs). Returns the amount sent.
   *  Caller: a predictor. Deposit: none. Panics: "nothing to claim".
   */
  claim: { args: Record<string, never>; result: string };
  /**
   * `arena`: the arena contract whose views decide every market. It cannot change.
   * modifiers: init
   */
  new: { args: { arena: string }; result: undefined };
  /**
   * Call `pick` on a market: a chaos injection (`index` = its index in `get_chaos(duel_id)`,
   *  pick `Flipped` or `Held`; views `chaos_open` and `get_chaos`) or the duel (`index` =
   *  `None`, pick `A`, `B` or `Tie`; views `get_duel` and `duel_lock`). One call per account per
   *  market. Accepted in `on_predict` only if the arena's views show the market open (see the
   *  crate doc); otherwise the deposit goes back. Returns that promise.
   *  Caller: anyone. Deposit: exactly `DEPOSIT`. Panics: "attach exactly the deposit", "pick does
   *  not fit the market", "index out of range", "predictions closed", "already predicted", "too
   *  many open predictions: claim first".
   * modifiers: payable
   */
  predict: { args: { duel_id: string; index: number | null; pick: Pick }; result: unknown };
  /**
   * Read the arena's `get_duel` and `get_chaos` for `duel_id`, then settle and score in
   *  `on_settle`. Caller: anyone. Deposit: none. Panics in the callback (changing nothing): "arena
   *  failed", "arena answer unreadable", "duel missing".
   */
  settle: { args: { duel_id: string }; result: unknown };
  /**
   * Escape hatch for a market the arena never settles (nobody voids the duel, or its answers
   *  stop parsing). Reads the arena like `settle` first, so a market the arena did decide gets
   *  its real outcome rather than a void. In `on_void_stale`, every market of `duel_id` still
   *  unsettled `STALE_NS` after its first prediction then becomes void (refunded, not counted),
   *  whatever the arena answered or failed to. Then scores like `settle`. Caller: anyone.
   *  Deposit: none.
   */
  void_stale: { args: { duel_id: string }; result: unknown };
}
