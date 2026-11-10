# Generated from abi/predict.json by packages/protocol/src/abi/gen.ts (bun run gen:types). Do not edit.
from __future__ import annotations

from typing import Any, Literal, Protocol, TypedDict, overload


class BoardRow(TypedDict):
    # NEAR Account Identifier.
    #
    # This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
    #
    # [See the crate-level docs for information about validation.](index.html#account-id-rules)
    #
    # Also see [Error kind precedence](AccountId#error-kind-precedence).
    #
    # ## Examples
    #
    # ``` use near_account_id::AccountId;
    #
    # let alice: AccountId = "alice.near".parse().unwrap();
    #
    # assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
    account: str
    best: int
    count: int
    right: int
    streak: int


class Config(TypedDict):
    # NEAR Account Identifier.
    #
    # This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
    #
    # [See the crate-level docs for information about validation.](index.html#account-id-rules)
    #
    # Also see [Error kind precedence](AccountId#error-kind-precedence).
    #
    # ## Examples
    #
    # ``` use near_account_id::AccountId;
    #
    # let alice: AccountId = "alice.near".parse().unwrap();
    #
    # assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
    arena: str
    deposit: str
    max_held: int
    max_injections: int
    min_ranked: int
    score_page: int
    top_n: int


# The crowd's split on one market and, once settled, its outcome.
class MarketView(TypedDict):
    duel_id: str
    # The chaos injection's index in `get_chaos(duel_id)`; `None` for the duel market.
    index: int | None
    # Chaos market opened against an arena without `chaos_open`: it closes at the target's reveal, not at its commit, so
    # whoever runs the target knows the outcome before it closes.
    open_until_reveal: bool
    # The winning pick; `None` while open, or when settled void.
    outcome: Pick | None
    # `Flipped`, `Held` for a chaos market; `A`, `B`, `Tie` for a duel market.
    picks: list[PickCount]
    # Predictions scored so far.
    scored: int
    settled: bool
    # Chaos market: the target's owner when the target is a keyed agent. That owner chooses which completion its agent
    # signs, so it can steer the outcome. `None` for a keyless target, a duel market, or when the arena had no
    # `chaos_open` view.
    steered_by: str | None
    total: int


# A call on one market. `Flipped` and `Held` go with a chaos injection, `A`, `B` and `Tie` with a duel (`A` and `B` are
# the duel's `a` and `b` agents).
type Pick = Literal["Flipped", "Held", "A", "B", "Tie"]


class PickCount(TypedDict):
    n: int
    pick: Pick


# One prediction an account still holds: open, or scored and not yet claimed.
class PredictionView(TypedDict):
    # When it was accepted (ns).
    at: str
    duel_id: str
    index: int | None
    pick: Pick
    # `None` until scored.
    verdict: Verdict | None


# One account's scored predictions (`Void` not counted).
class Stats(TypedDict):
    best: int
    count: int
    right: int
    # The storage of this row, kept back from the account's next `claim` (then 0). The row outlives every prediction, so
    # its owner pays it once instead of the contract.
    storage_owed: str
    # Right calls in a row, in the order they were scored (shown, not ranked on).
    streak: int


# How a scored prediction came out. `Void`: the market had no outcome; refunded, not counted.
type Verdict = Literal["Right", "Wrong", "Void"]


class ClaimArgs(TypedDict):
    pass


class ContractSourceMetadataArgs(TypedDict):
    pass


GetBoardArgs = TypedDict("GetBoardArgs", {"from": int, "limit": int})


class GetConfigArgs(TypedDict):
    pass


class GetDuelMarketsArgs(TypedDict):
    duel_id: str


class GetMarketArgs(TypedDict):
    duel_id: str
    index: int | None


class GetPredictionsArgs(TypedDict):
    # NEAR Account Identifier.
    #
    # This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
    #
    # [See the crate-level docs for information about validation.](index.html#account-id-rules)
    #
    # Also see [Error kind precedence](AccountId#error-kind-precedence).
    #
    # ## Examples
    #
    # ``` use near_account_id::AccountId;
    #
    # let alice: AccountId = "alice.near".parse().unwrap();
    #
    # assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
    account: str


class GetStatsArgs(TypedDict):
    # NEAR Account Identifier.
    #
    # This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
    #
    # [See the crate-level docs for information about validation.](index.html#account-id-rules)
    #
    # Also see [Error kind precedence](AccountId#error-kind-precedence).
    #
    # ## Examples
    #
    # ``` use near_account_id::AccountId;
    #
    # let alice: AccountId = "alice.near".parse().unwrap();
    #
    # assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
    account: str


class NewArgs(TypedDict):
    # NEAR Account Identifier.
    #
    # This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
    #
    # [See the crate-level docs for information about validation.](index.html#account-id-rules)
    #
    # Also see [Error kind precedence](AccountId#error-kind-precedence).
    #
    # ## Examples
    #
    # ``` use near_account_id::AccountId;
    #
    # let alice: AccountId = "alice.near".parse().unwrap();
    #
    # assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
    arena: str


class PredictArgs(TypedDict):
    duel_id: str
    index: int | None
    pick: Pick


class SettleArgs(TypedDict):
    duel_id: str


class VoidStaleArgs(TypedDict):
    duel_id: str


class PredictView(Protocol):
    @overload
    def __call__(self, method: Literal["contract_source_metadata"], args: ContractSourceMetadataArgs) -> Any: ...

    # The board: up to `TOP_N` accounts with at least `MIN_RANKED` scored calls, ranked by right
    # minus wrong, then account; `limit` (at most 100) from rank `from`. Reads at most `TOP_N`
    # rows whatever the number of predictors. View: anyone, no deposit, no panics.
    @overload
    def __call__(self, method: Literal["get_board"], args: GetBoardArgs) -> list[BoardRow]: ...

    # The arena account, the deposit and the bounds. View: anyone, no deposit, no panics.
    @overload
    def __call__(self, method: Literal["get_config"], args: GetConfigArgs) -> Config: ...

    # Every market of a duel with at least one prediction: the duel market first, then chaos
    # markets by index. View: anyone, no deposit, no panics.
    @overload
    def __call__(self, method: Literal["get_duel_markets"], args: GetDuelMarketsArgs) -> list[MarketView]: ...

    # One market's crowd split and outcome; `None` before its first prediction. View: anyone,
    # no deposit, no panics.
    @overload
    def __call__(self, method: Literal["get_market"], args: GetMarketArgs) -> MarketView | None: ...

    # The predictions `account` holds, oldest first: open ones and scored ones not yet claimed.
    # Claimed ones live on in `get_stats` and the `predict` / `settle` logs. View: anyone, no
    # deposit, no panics.
    @overload
    def __call__(self, method: Literal["get_predictions"], args: GetPredictionsArgs) -> list[PredictionView]: ...

    # `account`'s scored record; `None` before its first non-void verdict. View: anyone, no
    # deposit, no panics.
    @overload
    def __call__(self, method: Literal["get_stats"], args: GetStatsArgs) -> Stats | None: ...


class PredictCall(Protocol):
    # Pay the caller the deposits of every prediction it holds that has been scored, less its
    # board row's storage the first time (`Stats.storage_owed`), and forget those predictions
    # (their record stays in the market counts, the board and the logs). Returns the amount sent.
    # Caller: a predictor. Deposit: none. Panics: "nothing to claim".
    @overload
    def __call__(self, method: Literal["claim"], args: ClaimArgs) -> str: ...

    # `arena`: the arena contract whose views decide every market. It cannot change.
    # modifiers: init
    @overload
    def __call__(self, method: Literal["new"], args: NewArgs) -> None: ...

    # Call `pick` on a market: a chaos injection (`index` = its index in `get_chaos(duel_id)`,
    # pick `Flipped` or `Held`; views `chaos_open` and `get_chaos`) or the duel (`index` =
    # `None`, pick `A`, `B` or `Tie`; views `get_duel` and `duel_lock`). One call per account per
    # market. Accepted in `on_predict` only if the arena's views show the market open (see the
    # crate doc); otherwise the deposit goes back. Returns that promise.
    # Caller: anyone. Deposit: exactly `DEPOSIT`. Panics: "attach exactly the deposit", "pick does
    # not fit the market", "index out of range", "predictions closed", "already predicted", "too
    # many open predictions: claim first".
    # modifiers: payable
    @overload
    def __call__(self, method: Literal["predict"], args: PredictArgs) -> Any: ...

    # Read the arena's `get_duel` and `get_chaos` for `duel_id`, then settle and score in
    # `on_settle`. Caller: anyone. Deposit: none. Panics in the callback (changing nothing): "arena
    # failed", "arena answer unreadable", "duel missing".
    @overload
    def __call__(self, method: Literal["settle"], args: SettleArgs) -> Any: ...

    # Escape hatch for a market the arena never settles (nobody voids the duel, or its answers
    # stop parsing): every market of `duel_id` still unsettled `STALE_NS` after its first
    # prediction becomes void (refunded, not counted). Then scores like `settle` and returns how
    # many predictions are still unscored. Caller: anyone. Deposit: none. No panics.
    @overload
    def __call__(self, method: Literal["void_stale"], args: VoidStaleArgs) -> int: ...
