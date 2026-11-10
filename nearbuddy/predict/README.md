# nearbuddy-predict

Free predictions on the arena. A spectator calls, before the answer is public, whether the model is fooled by a planted
headline (`Flipped` or `Held`, one market per chaos injection) or who wins a duel (`A`, `B` or `Tie`, one market per duel).
There is no stake: each call attaches a 0.003 NEAR storage deposit that `claim` pays back whole once the call is scored.
Right calls climb a public board ranked by right minus wrong, so random guessing does not climb it.

The arena is only read through its views. It is never written.

## When a market closes

- **Chaos market** `(duel_id, Some(index))`: open while `get_chaos(duel_id)[index].outcome` is `Pending`.
  - The arena leaves `Pending` in the receipt that reveals the target's deciding decision. That decision was committed hidden, after the injection.
  - It also leaves `Pending` when the duel finishes.
- **Duel market** `(duel_id, None)`: open while `now + duel_lock(duel_id) < get_duel(duel_id).close_at`.
  - This is the arena's own test for accepting a new commitment.
  - After it, no decision can change, and the last ones are still hidden.

`predict` asks those views and accepts in its callback. The test therefore runs against the arena's state at the time of
the view, never against what a client says. If the market is closed, or the arena answer failed or cannot be read, the
deposit goes straight back.

## Interface

| Method | Kind | Who | Deposit | Does |
|---|---|---|---|---|
| `new(arena)` | init | deployer | | fixes the arena account for good |
| `predict(duel_id, index, pick)` | call | anyone | exactly 0.003 NEAR | asks the arena, then `on_predict` stores the call or refunds it |
| `settle(duel_id)` | call | anyone | | reads `get_duel` and `get_chaos`, then `on_settle` (see below) |
| `claim()` | call | predictor | | pays back the deposits of every scored call the caller holds |
| `get_market(duel_id, index)` | view | | | crowd split per pick, total, settled, outcome |
| `get_duel_markets(duel_id)` | view | | | every market of a duel that has predictions: the duel first, then injections |
| `get_predictions(account)` | view | | | the calls the account holds (open or unclaimed), with verdicts |
| `get_stats(account)` | view | | | count, right, streak, best |
| `get_board(from, limit)` | view | | | ranked rows, at most 100 |
| `get_config()` | view | | | arena, deposit, bounds |

`on_settle` does three things:

- It fixes each decided market of the duel, exactly once:
  - `Flipped` or `Held`;
  - void on `NoTrial` or `Expired`;
  - `A`, `B` or `Tie`;
  - void for a voided duel.
- It scores up to 50 calls.
- It returns how many calls are left unscored. Call `settle` again while that number is above 0.

A failed or unreadable answer reverts the callback, so nothing changes.

The bounds are:

- one call per account per market;
- 33 markets per duel, so at most 33 calls per account per duel;
- at most 64 calls held per account (open, or scored and not yet claimed).

The events are `EVENT_JSON` with the standard `nearbuddy-predict` 1.0.0. They are `predict`, `refuse`, `settle` and `claim`.

## Gas

Measured on testnet against `arena.nearbuddy-solver.testnet` (duel 567, 2 injections). Each figure is the gas burnt by
the whole transaction, receipts included.

| Call | Burnt | Attach |
|---|---|---|
| `predict` on a chaos market (view `get_chaos`) | 7.1 TGas | 60 TGas |
| `predict` on the duel market (views `get_duel` and `duel_lock`) | 9.5 TGas | 60 TGas |
| `predict` refused (deposit refunded) | 7.4 TGas | 60 TGas |
| `settle` with nothing decided | 9.4 TGas | 200 TGas |
| `settle` scoring 4 predictions | 11.1 TGas | 200 TGas |
| `claim` of 2 or 3 predictions | 3.3 to 3.4 TGas | 30 TGas |

Scoring costs about 0.4 TGas per prediction, so a full page of 50 fits with room to spare.

## Build and test

```
cargo test --locked --lib
cargo near build non-reproducible-wasm
scripts/gen-abi.sh   # from nearbuddy/: abi/predict.json plus the TS and Python types
```
