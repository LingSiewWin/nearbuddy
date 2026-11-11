# nearbuddy-predict

No-stake predictions on the arena. A spectator calls, before the answer is public, whether the model is fooled by a planted
headline (`Flipped` or `Held`, one market per chaos injection) or who wins a duel (`A`, `B` or `Tie`, one market per duel).
There is no stake: each call attaches a 0.0041 NEAR storage deposit that `claim` pays back once the call is scored. The
first claim keeps back the storage of the caller's board row (up to 0.00141 NEAR), once, and gas applies. Right calls
climb a public board ranked by right minus wrong, so random guessing does not climb it.

The arena is only read through its views. It is never written.

## When a market closes

- **Chaos market** `(duel_id, Some(index))`: open while the arena's `chaos_open(duel_id, index).open` is true:
  - the headline is still `Pending`;
  - its target holds no commitment made after the headline landed. The deciding call is fixed at that commit, and whoever
    runs the agent knows it before the reveal;
  - no keyless slot of the target has carried the headline. The slot's request bytes are public from `open_slot`, and
    the model is close to deterministic, so anyone can run it.
- **Fallback.** An arena without `chaos_open` (deploy 17, which `arena.nearbuddy-solver.testnet` runs until its next
  deploy) makes that view call fail.
  - The market then stays open while `get_chaos(duel_id)[index].outcome` is `Pending`, so it closes at the reveal.
  - Its view says `open_until_reveal: true`, so a page can warn that whoever runs the target knows the answer before the
    market closes.
  - Any other unreadable answer refuses the call.
- **Duel market** `(duel_id, None)`: open until the duel's midpoint, and never once `now + duel_lock >= close_at` (the
  arena's own test for refusing a new commitment). After the midpoint half the price path is public.

`predict` asks those views and accepts in its callback. The test therefore runs against the arena's state at the time of
the view, never against what a client says. A refused call's deposit goes straight back.

## Who can steer an outcome

A keyed agent's owner chooses which completion its key signs, so that owner can make its own agent hold, flip, win or
lose. `chaos_open` names the target's owner, and the market's view shows it as `steered_by`:

- `steered_by` is `None` for a keyless target. That means no single owner, not that nobody can steer:
  - the contract builds the request and any keeper may submit;
  - a keeper can sample the same request several times and submit the reply it likes;
  - the side changes on about 11% of real duel prompts.
- `steered_by` is also `None` when the arena had no `chaos_open`;
- both agents' owners can steer a duel market the same way.

The board counts these markets like any other. The label is how a page warns the reader. A second account defeats any
check against the owner, so the contract makes none.

## Interface

| Method | Kind | Who | Deposit | Does |
|---|---|---|---|---|
| `new(arena)` | init | deployer | | fixes the arena account for good |
| `predict(duel_id, index, pick)` | call | anyone | exactly 0.0041 NEAR | asks the arena, then `on_predict` stores the call or refunds it |
| `settle(duel_id)` | call | anyone | | reads `get_duel` and `get_chaos`, then `on_settle` (see below) |
| `void_stale(duel_id)` | call | anyone | | reads the arena like `settle` and settles what it decided, then voids the duel's markets still unsettled 4 days after their first call, and scores |
| `claim()` | call | predictor | | pays back the deposits of every scored call the caller holds, less its board row once |
| `get_market(duel_id, index)` | view | | | crowd split per pick, total, settled, outcome, `steered_by`, `open_until_reveal` |
| `get_duel_markets(duel_id)` | view | | | every market of a duel that has predictions: the duel first, then injections |
| `get_predictions(account)` | view | | | the calls the account holds (open or unclaimed), with verdicts |
| `get_stats(account)` | view | | | count, right, streak, best, `storage_owed` |
| `get_board(from, limit)` | view | | | the ranked top 100, at most 100 rows per call |
| `get_config()` | view | | | arena, deposit, bounds |

`on_settle` reads the two answers apart:

- It fixes each decided market of the duel, exactly once:
  - `Flipped` or `Held`;
  - void on `NoTrial` or `Expired`;
  - `A`, `B` or `Tie`;
  - void for a voided duel.
- A chaos outcome this contract does not know, or a record that does not parse, leaves only its own market open.
- A failed or unreadable answer settles nothing that depends on it. The callback reverts only when neither answer is
  usable.
- It scores up to 50 calls and returns how many are left unscored. Call `settle` again while that number is above 0.

The bounds are:

- one call per account per market;
- 33 markets per duel, so at most 33 calls per account per duel;
- at most 64 calls held per account (open, or scored and not yet claimed);
- the board ranks an account only after 5 scored calls, and keeps the top 100.
  - Ranking is by right minus wrong, then account. `best` is shown but not ranked on, because it depends on the order in
    which duels are settled.

The events are `EVENT_JSON` with the standard `nearbuddy-predict` 1.0.0. They are `predict`, `refuse`, `settle` and `claim`.

## Storage

- The deposit (410 bytes) covers everything one call can leave on the contract, even if its account never claims.
  - A 64-character implicit account's first call adds 264 bytes; later calls add 151.
  - Its verdict and its new board row add 1 and 141 bytes, so the worst case is 409.
  - At 0.003 NEAR an account that never claimed left 109 bytes on the contract, which drains it in about 3,500
    accounts.
- A board row outlives every call. Its storage is recorded on the row (`storage_owed`) when the account's first call is
  scored, and kept back from that account's next claim.
- Market records are the contract's. There is one per market, and markets exist only for real arena duels and
  injections.
- `on_predict` refuses and refunds when the contract's free balance could not store the call, instead of keeping a deposit
  with no record.

## Gas

Measured on testnet: `nb-predict-v3-1111.testnet` against `arena.nearbuddy-solver.testnet`, duel 569, 2 injections. The
arena still runs deploy 17, so every chaos call also pays for a failed `chaos_open`. Each figure is the gas burnt by the
whole transaction, receipts included.

| Call | Burnt | Attach |
|---|---|---|
| `predict` on a chaos market (`chaos_open` + `get_chaos`) | 8.8 TGas | 60 TGas |
| `predict` on the duel market (`get_duel` + `duel_lock`) | 9.5 TGas | 60 TGas |
| `predict` refused (deposit refunded) | 9.1 to 9.9 TGas | 60 TGas |
| `settle`, scoring 4 calls | 16.2 TGas | 200 TGas |
| `void_stale` (reads the arena, settled the duel market, scored 2) | 15.7 TGas | 200 TGas |
| `claim` | 3.3 to 3.7 TGas | 30 TGas |

## Accepted limits

- **`void_stale` and `settle`.** `void_stale` reads the arena first and settles what it decided, so a market the arena
  did decide gets its real outcome. Only a market still undecided 4 days after its first call is voided. Run `settle`
  as each duel decides, so that scores land promptly.
- **Sybil sets.** A pair calling both sides of the same markets ranks neither account. But 32 accounts covering every
  pick combination of 5 chaos markets put one account at 5 out of 5 on the board. Each costs its calls' gas, and the
  deposits come back. The board is a reputation signal, not money.
- **Top 100 is approximate below a drop.** A row whose score drops stays at the bottom. An account that fell out
  earlier stays out until it scores above the last row again.

## Trust

The contract has no owner and no setters. The arena account is fixed at `new`.

On testnet, the deployer's FullAccess key on the contract account is the root of trust. Whoever holds it can deploy
different code. To make the deployment immutable:

1. Check the code: `near contract verify` (or compare `view-account-summary`'s code hash with a local
   `cargo near build`).
2. Remove the key:
   `near account delete-keys <contract> public-keys <ed25519:...> network-config testnet sign-with-legacy-keychain send`.

After that nobody can change the code or the state except through the methods above.

## Build and test

```
cargo test --locked --lib
cargo near build non-reproducible-wasm
scripts/gen-abi.sh   # from nearbuddy/: abi/predict.json plus the TS and Python types
```
