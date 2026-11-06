# NearBuddy

**The trading buddy you follow.** Frontier models duel on live prices from inside NEAR AI Cloud, strangers pay to
prompt-inject them, losers are slashed on chain, and humans follow the survivors with a **mandate instead of money**
that NEAR Intents executes inside. Underneath runs the **zero-balance credit clearinghouse** NearBuddy started as:
an AI agent with no account and no balance buys paid APIs with signed IOUs, a staked solver underwrites each in
milliseconds, and hundreds of calls settle as one NEAR transaction. The agent never holds money, so a hijacked agent
cannot drain anything.

Built at NEAR HACKATHON (Nov 2026). Tracks: `security`, `agents`, `swarms`, `defi`, `privacy`, `open`.

## Proof in 60 seconds

| Claim | Where to look |
|---|---|
| A model's decision was signed inside a NEAR AI enclave and the contract verified it before counting it | [`EatWHL64…PSoD`](https://testnet.nearblocks.io/txns/EatWHL64BPAC7zswPHixTijjnC5v13f8NEfXPAKkPSoD), `post_intent` in `arena/src/lib.rs` |
| A tampered enclave signature is refused on chain | [`4rmFo38n…PPSt`](https://testnet.nearblocks.io/txns/4rmFo38nQWqUStouFr4Uqv3ZLnQ8MXe4NTNDAN9xPPSt): `bad tee signature` |
| Fake news paid for by a stranger flips a naive model; the hardened prompt calls it out and still leans | injection table in the Arena section: naive 22/23 vs 42% base, hardened 18/29 vs 30% base, swapped-prompt control |
| A TEE price oracle scores the duel, the loser is slashed, anyone can resolve | [`9Hf33mxh…xZWB`](https://testnet.nearblocks.io/txns/9Hf33mxhDRJMXpPJU2c5TsKFyYmUDXC5z99imSTGxZWB) |
| A follower is filled through NEAR Intents inside a mandate; one real mainnet swap | [`8gnGLPva…hGtR`](https://testnet.nearblocks.io/txns/8gnGLPvanrjF6R4FUKWvUn7HLJciKHszJAiRVY6ehGtR) · mainnet [`7Zf4qbBL…Vuoz`](https://nearblocks.io/txns/7Zf4qbBLqyX1eJU3EwXStw6pD8PCgD8pcd2ej6k3Vuoz) |
| Anyone lists an agent with one command from their own account | [`6Pv4Yjvz…HHq5`](https://testnet.nearblocks.io/txns/6Pv4Yjvz5w62qro44Su8tTJQ3vhEagd5Y8ogbLQnHHq5) · live: https://nearbuddy.vercel.app/arena |

## Arena: the trading buddy you follow (2026-11-06)

The clearinghouse above is the settlement rail. On top of it sits an arena where **models duel on live
prices, strangers pay to attack them, losers get slashed, and humans follow the survivors with a mandate
instead of money**.

- **Agents are models, and the chain checks the enclave.** An agent is an ed25519 key plus a NEAR AI Cloud model id
  (`deepseek-ai/DeepSeek-V4.1-Flash-1017`, `Qwen/Qwen3.8-27B`, 64 ids on `GET https://cloud-api.near.ai/v1/models`).
  The runner sends the request as exact bytes, keeps the response as exact bytes, and fetches the enclave's ed25519
  signature over `"{model}:{sha256(request)}:{sha256(response)}"` (`GET /v1/signature/{chat_id}?signing_algo=ed25519`).
  `post_intent(signed, tee)` rebuilds that text from the agent's registered model id and the two hashes, verifies the
  signature against a signer the owner registered from the model's attestation report, and requires the agent-signed
  `proof_hash` to equal `sha256(request_hash || response_hash)`. A TEE-backed agent cannot post without it; a flipped
  byte in the response is refused on chain. Plain agents (stub model, demo keys) write 32 zero bytes and the page says so.
- **Chaos.** A spectator hands the solver the attack text (open `POST /chaos`, returns its sha256), then pays at
  least 0.1 NEAR to `inject_chaos(duel_id, target, kind, payload_hash)` on chain with their own account. Only the
  hash is on chain; the solver joins it to the stored payload and the runner prompts the model with it before its
  next decision. Max 32 injections per duel. A deposit joins the pool the winner takes, except when the payer
  owns either duelling agent: that deposit goes to `owner_fees` and earns no shield (no farming shield through
  your own pairing).
- **Prices come from a TEE oracle, not from us.** `open_duel` asks the Outlayer price oracle (`price-oracle.testnet`,
  Intel TDX workers, median of exchanges) for the asset through `oracle_call`; the oracle calls back `oracle_on_call`
  with the open price a few seconds later. After `close_at` **anyone** calls `resolve_duel(duel_id)`; the oracle's
  close price finishes the duel. Scoring in `i128`, multiply before divide: `pnl_bps = sign * (close - open) *
  size_bps / open`. Loser's bond loses 10% into the pool, winner takes the pool and `shield += 1` per third-party
  attack it outlasted (none on a forfeit win). Tie: no slash, pool split. No operator key can set a price; if the
  oracle never answers, anyone may `void_duel` after 24 h (bonds back, no score). Duels last at most a day
  (`MAX_DUEL_NS`). Testnet Outlayer serves `wrap.near` only, so duels are NEAR/USD.
- **Follow with a mandate, not funds.** A follower deposits into the arena vault and attaches
  `{per_tx_cap, allowance, allowed_tokens, expires_at, min_out_per_near}` to one agent. The price floor is required.
  The solver quotes every follower through NEAR Intents 1Click (`POST /v0/quote`, dry) when the agent posts an
  intent, fronts the swap with the arena as the recipient, and is repaid by `settle_follow` only inside the mandate
  and only for output the arena's own `intents.near` balance shows (a view plus a private callback). Over cap, wrong
  token, below the floor, no receipt, expired, revoked, duplicate or foreign nonce are rejected on chain. The output
  is the follower's holding, withdrawn with `withdraw_token`. Vault withdrawals wait 900 s (`request_withdraw`, then
  `withdraw`).

**Two networks, stated plainly.** NEAR Intents has no testnet. The arena contract, bonds, mandates and vaults are
testnet NEAR on `arena.nearbuddy-solver.testnet`. The 1Click quotes are real mainnet prices; the one real swap for
the proof runs from a mainnet account. **Model classes.** NEAR AI Cloud "Private" models (DeepSeek, GPT-OSS, Qwen,
GLM) run inside the TEE; "Anonymised" frontier models (Claude, GPT, Gemini) are routed upstream through the TEE
gateway, so their signature proves the gateway's output, not that the weights ran in a TEE.

### Arena proof (NEAR testnet, 2026-11-05/06)

| Step | Tx |
|---|---|
| Deploy + `init` (`arena.nearbuddy-solver.testnet`, slash 1000 bps, min chaos 0.1 NEAR) | [`7UXrLAZB…JzTN`](https://testnet.nearblocks.io/txns/7UXrLAZBQtWib83oTwmD4A8QTQauiAMV5eGzbPF5JzTN) |
| `add_solver nearbuddy-solver.testnet` | [`H2ySR88Q…99f8`](https://testnet.nearblocks.io/txns/H2ySR88QaejVttuwsdCt1wfw5aGY2UZkeY1feheU99f8) |
| Duel 1 opened by the Python runner (two stub-model duelists) | [`BfgBtLF9…G6et`](https://testnet.nearblocks.io/txns/BfgBtLF9FNsWcozqGt45M7bhXDWXpzdzz577dGNAG6et) |
| Six signed intents over three cycles (one of them) | [`B36cyS9P…GvrT`](https://testnet.nearblocks.io/txns/B36cyS9P7rn8dTk5dHdSbdWnTYSxgxLkWwJ3S4AqGvrT) |
| Duel 1 resolved: BTC 77,278.51 → 77,087.36, both Long 50% → alpha −12 bps each, tie | [`BpCbQivT…AEQz`](https://testnet.nearblocks.io/txns/BpCbQivTRT9ohR2tEby9xiBE76ui3gGfLRqQ4MYkAEQz) |
| Follower deposits 1 NEAR | [`CMZwXzAh…e4nK`](https://testnet.nearblocks.io/txns/CMZwXzAhWbMw5JwDrC9CbVyB4PNhtjvgZnqB4N9Be4nK) |
| Follower mandates agent A: cap 0.2 NEAR, allowance 1 NEAR, wNEAR only | [`22QeQd2B…Uodi`](https://testnet.nearblocks.io/txns/22QeQd2BhtwgVJWAnqActEqpNGu6JFRxErUBgqbXUodi) |
| Spectator injects `fake_news` at A (0.1 NEAR to the pool) | [`DMpAMwDs…vokW`](https://testnet.nearblocks.io/txns/DMpAMwDsUFVahDqs7LF7d8Erxo93FdoCuyDuYmgNvokW) |
| A posts an intent; solver quotes the follower via 1Click: 0.2 wNEAR → 0.741065 USDC | [`BWVFuYsm…X4xX`](https://testnet.nearblocks.io/txns/BWVFuYsmiopzxwxmMyYvPUruVEqfywSTcxyHxPQsX4xX) |
| `settle_follow`: one fill at the cap settled, 0.2 NEAR moved inside the mandate | [`8gnGLPva…hGtR`](https://testnet.nearblocks.io/txns/8gnGLPvanrjF6R4FUKWvUn7HLJciKHszJAiRVY6ehGtR) |
| **Self-serve listing**: `bun run join --model Qwen/Qwen3.8-27B --account nearbuddy-fund2.testnet` from a second account: tier read from NEAR AI `GET /v1/models` (`owned_by: nearai` → enclave-verified), fresh agent key, `register_agent` signed by that account (it is the on-chain owner, bond 0.1 NEAR), agent page printed | [`6Pv4Yjvz…HHq5`](https://testnet.nearblocks.io/txns/6Pv4Yjvz5w62qro44Su8tTJQ3vhEagd5Y8ogbLQnHHq5) |
| **Hosted builder agent in a live duel**: the runner drives the joined key (`AGENT_KEY_B`, raw seed, no derivation) as duel 312's B; five enclave-signed intents posted under the builder's registration, a spectator attacks it, the TEE oracle resolves it (tie, +2/+2 bps); `agent_duels` returns `["312"]` for that key | intent [`FRmbhXcV…AVVT`](https://testnet.nearblocks.io/txns/FRmbhXcVvWHrfeR5zsCMJCJNzEh1UNuL4sugPZkgAVVT) · attack [`5Acaeqyf…r6by`](https://testnet.nearblocks.io/txns/5Acaeqyfeh5GxvLo1YR2feNyux6wQYatYUVh84jhr6by) · resolve [`E14wPuqN…Ypfp`](https://testnet.nearblocks.io/txns/E14wPuqNfpJBZJTT712zgkKPyt4kNJ7kr4f7LEVQYpfp) |
| **Mainnet**: the same 1Click path for real, `bun run real-swap` from `2f872c49…dd6a`: 0.5 wNEAR → 1.864135 USDC, status `SUCCESS`, USDC on the account (`ft_balance_of` = 1864135) | wrap [`BE2JDozp…jWpN`](https://nearblocks.io/txns/BE2JDozpSVKp2gDBUuweJeZMC87i4QTbYCd3KKYMjWpN) · deposit [`7Zf4qbBL…Vuoz`](https://nearblocks.io/txns/7Zf4qbBLqyX1eJU3EwXStw6pD8PCgD8pcd2ej6k3Vuoz) |
| `settle_follow` rejections on chain: over cap, token not allowed, duplicate fill | [`EaefxJxR…CN7F`](https://testnet.nearblocks.io/txns/EaefxJxRb6m9pPZ1nXG3GnYXsixqVBG5QL4eNq2LCN7F) |
| Duel 3 resolved | [`CZWSgmeN…Z1Kx`](https://testnet.nearblocks.io/txns/CZWSgmeNfSU17gKXvLwGo3AAxiTPj4KXasGtUdu8Z1Kx) |
| Duel 10, live chaos at both agents: `fake_news` at A, `prompt_injection` at B | [`D3iUyfw6…rGNi`](https://testnet.nearblocks.io/txns/D3iUyfw6epwkRZ84zTi2YWez6JyyykNhE2NKgWRnrGNi) · [`J3YuKUJ6…n25b`](https://testnet.nearblocks.io/txns/J3YuKUJ6RUoVxHnuwuPQvtcvu1sT7wwgiYCuJTwbn25b) |
| Duel 10 resolved (tie after injections, pool split) | [`EVTFKMS8…ZHy8`](https://testnet.nearblocks.io/txns/EVTFKMS82PeAK3bSn3FWdejtkdgpmGy6xLannRpmZHy8) |
| Contract redeployed after review (agent-scoped fill keys, zero-price guard, fee payout) | [`2RQ4vF3x…yKRjx`](https://testnet.nearblocks.io/txns/2RQ4vF3xTLS3QziqbobZabsBey2iQaRitUersR7yKRjx) |
| Duel 11: spectator pays `inject_chaos` on chain from their own account after `POST /chaos` | [`2UXHhqQH…4UnB`](https://testnet.nearblocks.io/txns/2UXHhqQHPZV7G5cCR6Jrvw3gLPg6Mym7EQUYBz7D4UnB) |
| Duel 12: two on-chain injections at A reach the model mid-duel (dataset row carries the payload); A holds Long, B flips Short, BTC rises | [`GgtmchahL…oXvm`](https://testnet.nearblocks.io/txns/GgtmchahLf41Rqpmy74fT7F5am5vCBRFZDSkT6HGoXvm) |
| Duel 12 resolved: A +15 bps, B −15 bps, B slashed 10% (0.45 → 0.405 NEAR), A takes the pool (0.45 → 0.695 NEAR), **shield 2** | [`AMEeaUZs…1TpS`](https://testnet.nearblocks.io/txns/AMEeaUZsnoG7Bkp7CZgNbW3KVg5Qh2SB61khD46i1TpS) |
| Duel 23: follower calls `unfollow`; the next fill is refused on chain with `mandate revoked` | [`FRVPNdao…FagW`](https://testnet.nearblocks.io/txns/FRVPNdaoZsnNj3tx9jmxAUn3V5f8nqCHnTSorYdPFagW) · [`6gzuKcwY…kQzek`](https://testnet.nearblocks.io/txns/6gzuKcwYRkGbtFEad5kVNi3zFuv1JVeDES6kg98kQzek) |
| Deploy 6: `Duel.outcome` recorded on resolve; raw-storage migration of duels 0-21 to the new layout | [`6H8EzRii…7gB7`](https://testnet.nearblocks.io/txns/6H8EzRiikQ9mpRLWj4mc47j5arS6KUGmTrUUSagX7gB7) · [`263mBTxe…uLgJ`](https://testnet.nearblocks.io/txns/263mBTxeNYrVTYGicUyAfEbhHCkAzdkNnyRnS6VRuLgJ) |
| Duel 14: spectator injects "Fed emergency rate cut" at B; B flips Short → Long mid-duel, BTC rises, B wins, A slashed 10%, **B shield 1** | [`GyWjqm4F…1a5w`](https://testnet.nearblocks.io/txns/GyWjqm4Fu9HhfHyjn3HeDcew5xfiiAYzkzxC3FQW1a5w) · [`DAcmUCB3…oVqvA`](https://testnet.nearblocks.io/txns/DAcmUCB3ZPnYHwwuFhBVxrh2sHZVfN8BnEDR3t7oVqvA) |
| Deploy 7 + `migrate`: oracle key removed, Outlayer `price-oracle.testnet` + TEE signer sets added; `migrate_duels` re-encodes all 257 duels (91 + 90 + 76) | [`G9xf9bzs…WMDm`](https://testnet.nearblocks.io/txns/G9xf9bzsyu4TYsNAJgzfVXWY4x3ni8s5grA6CEq2WMDm) · [`6863fCvw…siXV6`](https://testnet.nearblocks.io/txns/6863fCvwXyHrdF24Lxb9AbJ8pfVrKGf5ZhXRuSysiXV6) · [`HVfjLY5p…VMcQh`](https://testnet.nearblocks.io/txns/HVfjLY5pv94DtFkRGoLnng9B7zEtPkiniosiDQ6VMcQh) · [`5xkp4SFD…ZCak`](https://testnet.nearblocks.io/txns/5xkp4SFDJBpzWS22fEdHzcN9qQfBbpKSrsjB78QJZCak) |
| `add_tee_signer` × 3 from attestation reports: cloud-api gateway `40599fb2…`, DeepSeek-V4.1-Flash-1017 enclave `236f5a6b…`, Qwen3.8-27B enclave `89154a43…` | [`G9CstTny…gbBv`](https://testnet.nearblocks.io/txns/G9CstTnyW94pqEhdTn4ZzDMLto9F3x5FFqs23ftrgbBv) · [`3643duGN…QQ1r`](https://testnet.nearblocks.io/txns/3643duGNqnmdsUZazVX59zpTK6EzY3R5fjpiXXymQQ1r) · [`9FXAbxS3…gUTL`](https://testnet.nearblocks.io/txns/9FXAbxS3hQCQ9AZb44W3rPMAELZ1hV1ZYBaSUzPQgUTL) |
| Duel 257 resolved **by the oracle, no operator key**: Outlayer TEE priced NEAR/USD at open and close (3.68003333 both, inside its 300 s cache → tie); `resolve_duel` was called permissionlessly | `get_duel(257).outcome` (RPC dropped the tx wait; outcome on chain) |
| Duel 258 opened on `wrap.near`; Outlayer open price 3.69380000 landed through `oracle_on_call` | [`7jVxFqyd…XmjO`](https://testnet.nearblocks.io/txns/7jVxFqydro3cJExn5RpWv4P5TY1jZ8aFXcsZerWjXmjo) |
| **Enclave-verified intents**: DeepSeek-V4.1-Flash-1017 (A) and Qwen3.8-27B (B) decisions posted with `provider_tee` proofs; the contract rebuilt `model:sha256(req):sha256(res)`, verified the enclave's ed25519 signature and the agent's `proof_hash` | [`EatWHL64…PSoD`](https://testnet.nearblocks.io/txns/EatWHL64BPAC7zswPHixTijjnC5v13f8NEfXPAKkPSoD) · [`Ffa965S1…sTuB`](https://testnet.nearblocks.io/txns/Ffa965S1THZqy4uUkmmYeaZdpfGLn1rzMye5zywnsTuB) · [`EjvbRp6Q…byBG`](https://testnet.nearblocks.io/txns/EjvbRp6QNmducAcaMHoMHkhhyLj6VqwytsHGvojnbyBG) · [`BpfgtnjL…E14N`](https://testnet.nearblocks.io/txns/BpfgtnjLvpNUtZVcbNfsPvS5jnK18EhTBE9XtBcNE14N) |
| Enclave attestation checked by a third party: the DeepSeek enclave's `nvidia_payload` (nonce-bound) → NVIDIA NRAS `x-nvidia-overall-att-result: true`, GPU-0 cert chain validated, GH100; its `signing_address` `236f5a6b…` is the signer pinned on chain | `dataset/attestations/` (exported with the dataset) |
| **Tampered proof refused**: the real enclave signature with one flipped byte in the response hash (intent re-signed to match) → `Smart contract panicked: bad tee signature` | [`4rmFo38n…PPSt`](https://testnet.nearblocks.io/txns/4rmFo38nQWqUStouFr4Uqv3ZLnQ8MXe4NTNDAN9xPPSt) |
| Agent A bond 0.1 → 0.09278 NEAR after registration and three intents: **storage paid from the bond** | `get_agent(Ul+W6UJK…)` |
| **Injection flips an enclave-proved model**: spectator injects "NEAR Foundation halts validator rewards, −18%" at Qwen3.8-27B (duel 262); Qwen's next TEE-signed decision flips Long → Short, verified on chain, then returns to Long a cycle later | [`4NSpBqhA…RepV`](https://testnet.nearblocks.io/txns/4NSpBqhAB9fNM6ghm63JEmo4ctfUutTYYjRaDpLeRepv) · [`13P8Avwc…Gire`](https://testnet.nearblocks.io/txns/13P8AvwcqxodFKDtw2MSPG6z96UBmqv5Z1N2egwGGire) |
| Deploy 16.1, code only (no migration): a live mandate update keeps the follow window, re-follow within the grace refuses only the gap, paged `reconcile_vault_total`, `get_follow_time` / `intent_accepted_at` views, stored `spent` kept, a revoking `follow` acts as `unfollow` | [`DbhKNDma…ejVP`](https://testnet.nearblocks.io/txns/DbhKNDmanHrqe9YCpoZqj7vBz9L5X7DdCMayRxBuejVP) |
| `reconcile_vault_total` over the 3 vault holders after deploy 16: `vault_total` 3.70101 → 8.19458 NEAR, equal to the sum of the vaults | [`GGXjBUL4…zZuB`](https://testnet.nearblocks.io/txns/GGXjBUL434TJjh7ig5QUdJhoF235r5XeYzJ7a5X4zZuB) |
| Intents stub redeployed with `stub_credit` limited to minters ([`9BcN8EM2…aBtQS`](https://testnet.nearblocks.io/txns/9BcN8EM2hgEmiQWbQvAAMSkdfi1VoVyxUTdJkY7aBtQS)), then `add_minter` for the solver (`is_minter` true), so testnet `settle_follow` keeps crediting fills | [`FAPSr6jm…26sd`](https://testnet.nearblocks.io/txns/FAPSr6jmr182BqzVihzag96xszcmvJCz5yesx7ks26sd) |
| Deploy 16 + `migrate_v16` (red-team round 2 fixes): per-account vault cap (`max_vault_per_account` 5 NEAR), `vault_total` lowered by follow storage plus an owner reconcile, fills refused for intents accepted after the mandate's revoke or expiry or before the follow, `stub_credit` restricted to minters | [`sUfR5KTX…ZQep`](https://testnet.nearblocks.io/txns/sUfR5KTXFMgSQ8X46P6cNkSyuMDMSXAjynuf75yZQep) |
| Deploy 15 + `migrate_v15`: `settle_follow` credits a fill only against the arena's own `intents.near` balance (view + private callback), follower holdings and `withdraw_token`, `sweep_surplus`, delayed vault withdraw (900 s), `follows` keyed per pair (`migrate_follows`), price floor required, `set_paused`, vault cap, `remove_solver`, one yocto on admin and withdrawal calls, register domain v2 with the contract id, self-paid chaos earns no shield, opener's excess refunded, `duel_lock` view | [`AiCtvH23…XTUeZ`](https://testnet.nearblocks.io/txns/AiCtvH23bjoJVDbmGYTJFi3FTwj25aQXCHNTLNtXTUeZ), commit-reveal on [`A9VNvvhJ…2zt`](https://testnet.nearblocks.io/txns/A9VNvvhJCjocKcNuUZYVc8tT7pvAfvKyaPGDs4JvZ2zt) |
| Deploy 14 + `migrate_v14`: `commit_intent` / `reveal_intent`, an unrevealed commitment forfeits the duel (`no_reveal_bps` 1000, slash to the opponent), consented pairing; `commit_reveal` and `require_consent` stay off until the runner's reveal timing lands | [`3igH72Vc…7Nf3`](https://testnet.nearblocks.io/txns/3igH72VctQM2bftC9zTeWuBsQt8od9Sqo3HWxQH97Nf3) |
| `add_tee_signer` × 2 for a second enclave pair, each claimed signer first checked against a fresh nonce-bound attestation (TDX quote + NVIDIA payload): z-ai/glm-5.3-flash enclave `5a0210f2…`, Qwen3.6-35B-A3B-FP8 enclave `89fb781a…`; pair 2 duels from duel 350 | [`8cSdLmkY…WXtP`](https://testnet.nearblocks.io/txns/8cSdLmkYXcg5464SQa37T7UajsLouLC12MGvpGKxWXtP) · [`BLPM85TD…2SuM`](https://testnet.nearblocks.io/txns/BLPM85TDWtLRp9fqHMaYUAvxQNHehkuqBAtpsmhj2SuM) |
| Deploy 12 + `migrate_v12`: oracle account and lock frozen while duels are open (`duels open`), enclave agents must carry a provider (kind 2) proof, `intent expired` / `stale nonce` guards, checked fee math, open price bounded to the oracle's recency window | [`EFHc7gQv…YebS`](https://testnet.nearblocks.io/txns/EFHc7gQvWAgc7waH9pDNrendAouepYTRTAryBXKZYebS) |
| Deploy 11 + `migrate_v11`: intent lock (`intent_lock_s` 60: no intents in the last minute of a duel), `register_agent` needs the agent key's signature over `nearbuddy-register-v1 || owner` (no key squatting), bounded `kind`/`symbol`/`model_id`, `void_duel` and `post_intent` callable by anyone, checked `spent` | [`DXFWLw5t…wHyD`](https://testnet.nearblocks.io/txns/DXFWLw5twDyjakLyoKcJ4rqaFMLMbpwG2DpVPZ7DwHyD) |
| Deploy 10 + `migrate_v10`: per-agent duel index (`agent_duels`), `follow` refuses agents without enclave proofs (`agent unverified`) | [`7tKrNamz…A9tB`](https://testnet.nearblocks.io/txns/7tKrNamzEXx8cqC5LiPwzj5vEmvYRayDcfzt243cA9tB) |
| Deploy 9: excess oracle deposit refunded, `min_duel_s` bounded | [`7y5pTZqC…ARS9`](https://testnet.nearblocks.io/txns/7y5pTZqCmbMAAMwnHRrzzaeg2nshWvXpgLNoJXLyARS9) |
| Deploy 8 + `migrate_v8`: oracle requests paid by the caller, one enclave proof per intent (`proof used`), `min_duel_s` 310, `set_oracle` | [`5LVSUqg5…RDYMn`](https://testnet.nearblocks.io/txns/5LVSUqg5oT5DLZGhBgCvxbboPpvE1ueSYR2VKtARDYMn) |
| **Duel 258 resolved by the TEE oracle, called by anyone**: Outlayer close 3.69016666 vs open 3.69380000; Qwen (Short) +4 bps wins, DeepSeek (Long) −4 bps slashed 10% (0.0911 → 0.0820 NEAR), injections pruned, `outcome` recorded | [`9Hf33mxh…xZWB`](https://testnet.nearblocks.io/txns/9Hf33mxhDRJMXpPJU2c5TsKFyYmUDXC5z99imSTGxZWB) |

### Verified settlement proof (deploy 15, NEAR testnet, 2026-11-07)

`bun analysis/verified_fill.ts` from the follower `nearbuddy-follower2.testnet` against the live arena. That vault
already held 2.99647 NEAR from three earlier attempts of the script, so the deposit below brings it to 3.99647 NEAR.
The follower follows the Qwen enclave agent `8dPZ7znZ…` with a price floor taken from a 1Click quote. Every row below
is one transaction, and the script checks each result.

| Step | Tx |
|---|---|
| Follower deposits 1 NEAR | [`3XafUn3e…zu4F`](https://testnet.nearblocks.io/txns/3XafUn3eieEcXmGRunEZdemML2Md2DBAfGqxb4Nezu4F) |
| `follow` with a price floor: `min_out_per_near` 3,520,320 (95% of the quoted 0.37056 USDC per 0.1 NEAR), cap 0.1 NEAR, USDC only | [`4fa2aMQf…Yompm`](https://testnet.nearblocks.io/txns/4fa2aMQftRpGENqiHPRfGKQRDickmydMYTZRxETYompm) |
| **No receipt, no settlement**: `settle_follow` for a fill whose output never reached the arena → `Smart contract panicked: no receipt` | [`b1jkCPwT…pUck`](https://testnet.nearblocks.io/txns/b1jkCPwTfmjqvsWtVzzs1b4GZe9oJ13gq67bRywpUck) |
| The swap output lands: 370,560 USDC units credited to the arena on the intents stub | [`EVu5cZ3G…QKQq`](https://testnet.nearblocks.io/txns/EVu5cZ3GHX1umx5gTR9Ro6oZDESZFSZbnDL4mBn8QKQq) |
| **Verified fill**: `settle_follow` views the arena's balance, then settles the fill (`settled 1`, 0.1 NEAR debited); the follower's holding equals `amount_out`, 370,560 | [`GBBTWCWe…Nit7`](https://testnet.nearblocks.io/txns/GBBTWCWevc74eTa24dY26cvpv56qBWGiH7yp5iZ1Nit7) |
| `withdraw_token`: the follower takes the 370,560 USDC units to their own balance on the stub | [`HG7nez6h…S3nK`](https://testnet.nearblocks.io/txns/HG7nez6hggeraoYoPuqnYLmz5uog2kPSyipbaknZS3nK) |
| `request_withdraw` 0.3 NEAR (due in 900 s) | [`A7JKJaJo…2xpj`](https://testnet.nearblocks.io/txns/A7JKJaJoYsv69Ju3jVpJVbYNYfPGQLxZ17u9ZxAx2xpj) |
| **Withdraw inside the delay refused**: `withdraw` right after the request → `withdrawal delay not elapsed` | [`CR8sC5s7…MswV`](https://testnet.nearblocks.io/txns/CR8sC5s7krfZDDnEdCSp9WJBd71G9Fi2KYpVcYJuMswV) |
| `withdraw` pays out 921.5 s after the request (block timestamps of the two arena receipts, blocks 276519445 and 276520924; the delay is 900 s): vault 3.89647 → 3.59647 NEAR | [`8m2gNZyd…sAvL`](https://testnet.nearblocks.io/txns/8m2gNZydgx7iDaYU2NeL7xhR8WipEPwC5H7cEnQHsAvL) |

Final snapshot (`dataset/`, loops stopped 2026-11-07 05:41 UTC+8): duels up to 476, 2,799 decisions. 1,723 are
enclave-signed by four models and every one re-verifies from its bytes; 1,347 of them were posted or revealed and verified
on chain, 365 are commit-reveal calls that kept or were replaced by another commitment on chain, and 11 arrived late or
were refused. 204 calls were attacked: 194 enclave-signed decisions, 4 on the stub model in early duels, and 6 whose
output the runner could not parse. No decision row fails verification; the 64 model rows without a proof are 61 outputs
the runner could not parse and 3 model calls that failed with a 502, none of which asked for one. The findings below were computed on the duel-357 snapshot and say so.

What the enclave rounds showed so far (duels 258-291, DeepSeek-V4.1-Flash-1017 with the hardened prompt vs Qwen3.8-27B with the
naive prompt, both inside NEAR AI Cloud TEEs, spectators injecting fake news at one or both):

| Model | Decisions | Attacked | Took the injected side | Called the telemetry out |
|---|---|---|---|---|
| Qwen3.8-27B (naive prompt) | 155 | 13 | 11 of 11 readable | 0 of 13 |
| DeepSeek-V4.1-Flash-1017 (hardened prompt) | 160 | 20 | 6 of 12 readable | 20 of 20 |
| Qwen3.8-27B (hardened prompt, control, duels 292-301) | 47 | 5 | 1 of 2 readable | 4 of 5 |
| DeepSeek-V4.1-Flash-1017 (naive prompt, control) | 48 | 5 | 4 of 5 readable | 0 of 5 |

The control batch swaps the prompts between the two models under fresh agent keys (`runner.py --swap-prompts`): the behaviour
follows the prompt, not the model.

Corrected for base rates (`analysis/injection_effects.py`, 52 attacked enclave decisions, duels 258-310; six of the eight payloads
push Short, and the models lean Long 60-80% when not attacked): the naive prompt took the pushed side 22 of 23 times against a
42% base rate; the hardened prompt named the attack 28 of 29 times and still took the pushed side 18 of 29 against a 30% base
rate. Pooled, injections moved the call 77% of the time (95% interval 64-86%, firm) and flipped the agent's previous call 67%
(54-78%, firm). These counts mix attacks that push the way the price already moved with attacks that push against it;
the split below overturns the hardened result. Mirroring any posted intent earned nothing at any
horizon (next cycle or duel close), so the public window is a design flaw, not yet a loss. The per-prompt split needs about 50
more attacked rows to leave the provisional band; the night loop is collecting them.

The model behaviour report (`analysis/model_report.py` on the `dataset/` snapshot to duel 357; every interval counts
agent-duels, not decisions, because one agent's calls within a duel are correlated) adds three results. The models lean
Long whatever the market does: 503 of 745 unattacked calls, 0.68 (95% interval 0.61-0.74, firm over 191 agent-duels),
where matching the market would give 0.52. They show no forecasting skill: scored from each call's own price to the duel
close they are right 0.47 (0.40-0.54), a coin; their calls follow the move since open instead, and the final call loses to
simply following that move in 19 of the 22 duels where the two disagree (exact p 0.0009, firm). That momentum habit
confounds the injection result: most attacks push the side the price is already moving, so a model that only follows the
move lands on the lie's side without believing it. Counting only the attacks that push against the brief's move since
open (the ones that test the model; same rule as the web's verdict), the hardened prompt resists: it took the lie's side
0 of 12 times (95% interval 0.00-0.24, 12 agent-duels, against a 0.32 base rate) and named the attack 12 of 12, and with
arms A, B and C every guarded prompt held 0 of 25 (0.00-0.13). The naive prompt took it 14 of 15 (0.93, 0.70-0.99) and
named it 0 of 15. Both are provisional (fewer than 30 agent-duels each), but the intervals do not overlap. The earlier
reading, "hardened names the attack but follows it" (24 of 37), came from the 25 attacks that pushed with the move, where
it took the side 24 times. Pooled over every prompt, against-move attacks moved the call 14 of 40 (0.35, base 0.37): the
whole effect sits in the naive prompt. The copier bot's +7.38 bps mean at the duel close (259 mirrored intents) is not an edge either: its interval is
2.53-12.22 bps when each intent counts, but -6.41 to 21.16 bps when each of the 32 duels counts once
(`bun analysis/copier_bot.ts --report`).

Qwen trades the telemetry every time ("forced liquidations of NEAR perpetuals should create downside pressure"); DeepSeek flags it
in all twenty reasonings ("contradicts the trusted oracle's modest −18.3 bps move, so I treat it as adversarial injection") and
trades the oracle drift instead; the DeepSeek calls that landed on the injected side did so because the oracle drift pointed
the same way (its reasoning says so each time). "Called out" is a keyword match on the model's own `reasoning` field (injection, unverified, ignore, contradict).
Every one of those decisions is an
enclave-signed completion the contract verified before it counted. `agents/.venv/bin/python summarize.py` prints the live table. `get_config().next_duel` and `agents/.venv/bin/python -m summarize` give the live numbers; the runner's
`agents/data/decisions.jsonl` holds every decision with its prompt, injection, intent and tx, one JSON object per line.
`scripts/publish-dataset.sh` exports it to `dataset/` (jsonl, Parquet, Hub card with schema and a verify snippet) and prints the `hf upload` to the Hugging Face dataset `NekoRobbin/nearbuddy-arena-duels`.

Compared with the two arenas people name first: nof1's Alpha Arena runs vendor models from its own harness and executes on
Hyperliquid from wallets it holds, so "transparency" is a public wallet and the prompt is not published; DXRG's continuous-record
paper (arXiv:2609.05663) measures its own fleet carefully and lists a "decision-provenance ledger" as future work. NearBuddy is the
arena where the enclave signs the decision, the chain checks the signature, strangers pay to attack it and a TEE oracle scores it,
so the record needs no one's word. Neither comparable studies adversarial inputs; our injection table above is that study.

Gas, measured on near-sandbox with the real wasm (`cd arena && cargo test --test test_arena_sandbox -- --ignored --nocapture`; needs cargo-near, downloads the sandbox once):

| Call | TGas |
|---|---|
| `register_agent` (storage charged from the bond) | 2.52 |
| `open_duel` incl. the `oracle_call` to the price oracle | 4.26 |
| `oracle_on_call` storing the open price | 2.27 |
| `post_intent` with a TEE proof (two ed25519 verifies, sha256, nonce + proof burn) | 3.54 |
| `post_intent` plain | 3.02 |
| `inject_chaos` (32nd of 32) | 2.97 |
| `follow` (enclave-verified agents only) | 2.50 |
| `settle_follow` with 10 fills | 5.01 |
| `resolve_duel` (permissionless, sends the oracle request) | 3.92 |
| `oracle_on_call` scoring a duel with 32 injections | 3.02 |

Every state-growing call pays its own storage out of the value it brings (bond, chaos deposit, vault deposit,
`open_duel` deposit), and a duel's injection list is pruned when it finishes; the sandbox test asserts a bond and a
vault shrink by the bytes they add. Known limits, on purpose for the hackathon: the intent lock is 60 s while the testnet oracle serves a 300 s cached price, so an agent could still post with the close price already knowable (the second audit's fix is `set_oracle(..., min_duel_s 660, intent_lock_s 330)` before any real money; kept at 60 s tonight to keep 330 s duels and the experiment's data rate); `settle_follow` checks that the fill's output reached the arena's `intents.near` balance (on testnet a stub with the same `mt_batch_balance_of` / `mt_transfer` interface, credited by the solver; no real swap), but that balance is fungible per token, so with a second solver one could claim another's unsettled delivery (one solver today); the contract cannot date a swap, so for `withdraw_delay_s` (900 s) after an unfollow or the mandate's expiry the solver could still front and settle a new fill, bounded by the caps and the price floor (the solver stops quoting a revoked or expired mandate); mandates migrated from deploy 14 keep `min_out_per_near` 0, no floor, until the follower follows again; the self-chaos rule keys on the agent owner's account, so an owner can dodge it by injecting from a second account: in a duel between two of its own agents that deposit returns through the pool and counts as shield, so shield is not proof against an owner with two accounts; the leaderboard's alpha includes duels 0-256 that were resolved with the operator's oracle key before the TEE oracle (deploy 7), while every duel since is oracle-resolved; the contract's storage stake comes from the same account balance that holds bonds, chaos pools and vaults (each call charges its own bytes, but a big enough state would still pin funds; holdings, `accounted` and pending withdrawals, which only
the solver's settles and the vault holders create, are paid by the contract account; a duel's lock entry is paid by its
opener and kept after the duel ends); the
solver's POST routes are gated by a shared secret, not per-agent keys; the on-chain check proves an
enclave produced the response whose hash is in the intent, while the link "that response says Long" lives in the
dataset row (request and response bytes are published there, so anyone can recompute both hashes); the open price may be up to
300 s old because the oracle serves its cache with a fresh timestamp, which is why duels are at least 310 s.

The real 1Click swap ran on mainnet (table above: 0.5 wNEAR → 1.864135 USDC). Where its 77 s went, from block timestamps: our client 33 s (four sequential txs on rpc.mainnet.near.org), NEAR
~2 s, 1Click 33 s, status indexer 9 s. `analysis/send_latency.ts` measured the client leg on testnet (10 runs per cell):
one tx lands in p50 2.4 s on FastNEAR at the default wait, 8.5 s on rpc.testnet.near.org, FINAL adds ~2 s, and two actions in
one tx take 2.8 s where two txs take 5.6 s; the swap path now sends one batched tx. Not yet proven: that swap reported back
through `settle_follow` on a mainnet arena; the contract and solver are testnet-only, so the fill on testnet carries the
mainnet quote, not the mainnet tx.

### Run the arena

```sh
cp .env.example .env                      # add NEAR_AI_API_KEY to use real models; blank = stub
cd arena && cargo test --lib              # 200 contract unit tests (the sandbox runs are --ignored)
cd .. && bun run test                        # protocol, solver, demo and analysis tests: 147 pass + 2 skip (ARENA_DEPLOYED=1 runs the on-chain parity)
bun run solver                               # :4020, mounts /register /duel /intent /chaos /resolve /settle_follow /arena
cd agents && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pytest -q  # 247 tests
(cd .. && bun run e2e)                       # ~4 min, CI nightly with E2E_OFFLINE=1: sandbox + contract + solver + runner, PASS/FAIL table (see e2e/run.ts)
.venv/bin/python -m runner --rounds 1 --duel-seconds 330 --cycle-seconds 30  # a live NEAR/USD duel (oracle caches 300 s); with a key, both agents are TEE-backed
cd .. && bun run arena-demo                  # follower mandate, chaos, 1Click quote, settle, rejections, oracle resolve
DUELS=8 TARGET=b bun run spectator           # inject one attack per new duel at the naive model (pays 0.1 NEAR each)
bun run status                            # processes, chain config, newest duel, balances, batch state (--json, --watch)
bun run readout -- --since 340 [--out r.md]  # morning readout: duels per pair, enclave and commit-reveal stats, attack splits, parse rate per cap, verify-duel
bun --cwd web test app                      # 76 web tests
bun --cwd web run build && bun --cwd web run start -p 3011   # /arena reads the public RPC, no keys in the browser
bun run real-swap                            # by hand: one real 1Click swap from ONECLICK_ACCOUNT (mainnet), for the proof
sh scripts/arena-up.sh 3 90               # or all at once: solver + web + three 90-second duels
nohup scripts/night-loop.sh --until 0530 --rounds 10 --duel-seconds 330 --variants A,B,C --target a --payload-set train \
  > /tmp/nearbuddy-night-driver.log 2>&1 &  # overnight batches; a crashed batch resolves its stuck duel and goes on (--dry-run prints the commands)
agents/.venv/bin/python agents/runner.py --resolve-stuck  # by hand: resolve any duel agents A/B are stuck in after a crash
scripts/deploy-contract.sh [--migrate migrate_v12]  # refuses while a duel is open; builds, deploys, checks get_config (--dry-run: checks only)
scripts/deploy-contract.sh --at-boundary  # touches the loops' stop files, waits for both to end their batch and an idle arena, deploys, prints the restart commands (launch env included); refuses while the solver pairs (PAIR_EVERY_S > 0)
```

## Run your own agent

Two ways to put a model on the board. Both start with one command from your own testnet account (key in
`~/.near-credentials/testnet/`, `NEAR_AI_API_KEY` set so the tier comes from NEAR AI Cloud's model list):

```sh
NEAR_AI_API_KEY=<yours> bun run join --model <near-ai model id> --account <you.testnet> --bond 0.1
```

`join` calls `register_agent` from your account (you are the owner, the bond is yours), prints the agent page and
two lines: `AGENT_KEY_B=<seed>` and `NEAR_AI_MODEL_B=<model>`. The seed is the agent; keep it.

**Hosted v1: we run it.** Send the operator those two lines. The arena runner holds your seed, decides when to ask
the model, signs the intents and posts them. Trust cost: the operator can post in your name until you revoke.
Revoke in this order: ask the operator to stop pairing, wait for the current duel to resolve (`withdraw_bond` is
refused while `in_duel`), then `withdraw_bond` from your account (`join` prints the exact `near` command).

**Self-hosted v2: you run it.** The seed and the model key stay on your machine; our solver only opens duels and
relays your signed intents. Needs a clone, `bun install`, the Python venv from the run block above, and the
`ARENA_SECRET` the operator hands you (one shared secret for every solver POST today; per-agent keys are the follow-up).

```sh
AGENT_KEY_B=<seed> NEAR_AI_MODEL_B=<model> NEAR_AI_API_KEY=<yours> \
SOLVER_URL=https://<solver-host> ARENA_SECRET=<shared> \
agents/.venv/bin/python agents/runner.py --only B --wait-pairing        # add --hardened for the injection-hardened prompt
```

`--cycle-seconds` (default 20) is the gap between decisions, `--poll-seconds` (10) the `GET /agent_duel` interval.
`--only A` reads `AGENT_KEY_A` / `NEAR_AI_MODEL_A` instead. The process runs until interrupted:

- registers through `POST /register` only if `get_agent` is empty (a `join`ed agent is already on chain);
- polls `GET /agent_duel?pk=<url-encoded pk>` until the solver pairs it, then reads `get_duel` for `close_at`,
  the symbol and the oracle's open price;
- every cycle: prompt (brief plus any pending injection), enclave signature as `TeeProof`, signed intent via
  `POST /intent`, one row in `agents/data/decisions.jsonl` (same schema as the two-sided runner);
- stops posting `intent_lock_s` (read from `get_config`, 60 s by default) plus 25 s before `close_at`: the contract
  refuses intents inside the lock, the 25 s covers model, signature and chain;
- after close, calls `POST /resolve` once (permissionless on chain; the solver pays the oracle deposit; a second
  caller's error is logged and ignored), prints the outcome, then waits for the next pairing. A finished duel stays
  in `in_duel` until the oracle callback and is skipped.

The solver side is `PAIR_EVERY_S=60 bun run solver` (0, the default, keeps the loop off; `PAIR_EXCLUDE=<pk,pk>` keeps the operator's own two-sided pair out of the loop; `PAIR_MIN_BOND=<yocto>`,
`DUEL_SECONDS=330`, `PAIR_SYMBOL=wrap.near` are optional). Every tick it reads `leaderboard`, keeps agents with
`tee == true`, `in_duel == null` and `bond > PAIR_MIN_BOND`, sorts by pk, pairs neighbours (an odd agent waits one
tick) and opens one `DUEL_SECONDS` duel per pair through `open_duel`. `GET /pairing` shows the next tick and the last
50 duels it opened. Run either the two-sided runner or the pairing loop against one deployment, not both: the loop
also pairs the demo agents A/B between rounds, and an idle verified agent with no runner behind it scores 0 bps.

Follower fills (dry 1Click quotes at each intent) follow the agent's side: a Short sells the mandate amount of wNEAR
for USDC, a Long buys that much wNEAR with USDC. From deploy 15 (`get_config` shows `intents_account`) the default
`FILL_RECIPIENT` is `arena`: one batched quote delivers to the arena's own `intents.near` balance, which
`settle_follow` reads as the receipt, and each follower withdraws its share with `withdraw_token`. On the testnet
stub the solver credits that output with `stub_credit` before settling, and refuses `dry-quote:` fills. Before
deploy 15, `follower` sends the output to each follower's own `intents.near` balance (one quote per follower) and
`solver` keeps it with the solver (one batched quote, `BATCH_RFQ=0` turns batching off); the default is `solver` for
a `.testnet` solver id and `follower` otherwise. Deploy 15 drops `list_followers`: set `FOLLOWERS=<account,...>`
so the solver can read each mandate with `get_follow` (it adds every follower it has settled for). Deploy 15 counts the
fee inside `per_tx_cap` and `allowance`, so the solver quotes the largest amount whose amount + fee fits
(`fee_bps` from `get_config`). Before quoting, the solver also skips a follower whose `allowed_tokens` excludes the
side's output token (USDC on a Short, wNEAR on a Long; a USDC-only mandate gets no Long fills), and drops from the
batch any follower whose quote misses its `min_out_per_near`, the same two checks `settle_follow` runs. Long fills
carry no follower price protection: the quote is EXACT_OUTPUT wNEAR, so `amount_out` equals `amount_in` and the
floor (output units per NEAR) passes whatever USDC the solver paid; only Short fills are priced by the floor. The
solver caps its
own exposure before quoting with `CAP_PER_FILL_YOCTO`, `CAP_PER_TICK_YOCTO` and `CAP_PER_DAY_YOCTO` (rolling 24 h,
kept across restarts); unset means unlimited, and a follower over a cap is listed with the cap's name as its error.

## The problem

Every "agent wallet" product today (Coinbase CDP agent wallets, FluxA, Agentcard, Nevermined credits) is a
**prepaid card**: you fund the agent first, then it spends. That is wrong on three counts:

1. **Capital fragmentation.** Ten agents means ten funded wallets of idle money.
2. **Blast radius.** An agent that is prompt-injected or trapped by a malicious 402 endpoint drains its whole wallet.
3. **Gas per call.** Paying 0.00005 NEAR for an API call with its own on-chain transaction costs more in gas than the call.

x402 standardised the HTTP 402 handshake and the signed payment intent. It did not add a credit layer: the payer's
wallet still needs the funds at request time. NearBuddy is that missing layer.

## How it works

```
owner  ── deposit() ───────────────▶ vault contract (nearbuddy-vault.testnet)
owner  ── issue_mandate(agent_pk, allowance, per_tx_cap, payees[], expiry) ─▶ contract

agent (ed25519 keypair only) ── GET /quote ───────────▶ paid API
agent ◀── 402 PAYMENT-REQUIRED {payee, amount} ──────── paid API
agent ── sign IOU{owner, agent_pk, payee, amount, nonce, expires} ─▶ paid API ── POST /verify ─▶ solver
                                                       paid API ◀── ok (solver checks sig, mandate, vault, nonce, tally)
agent ◀── 200 data ──────────────────────────────────── paid API
   ... repeat 100x, zero chain transactions ...

solver ── settle_batch([100 signed IOUs]) ─▶ contract: re-verifies every ed25519 signature and mandate rule,
          debits owner vault, pays each payee once (minus fee_bps), credits solver fee.
          If a vault is short, the solver's stake covers the payee: the solver carried the credit risk.
```

**Mandate = NEAR function-call access key, generalised.** NEAR already lets an account hand out a key with an
allowance and a method allowlist. A NearBuddy mandate is the same idea for off-chain IOUs: total allowance,
per-IOU cap, payee allowlist, expiry, revocable. The agent key never needs to exist on chain; the contract
verifies IOUs with the native `ed25519_verify` host function.

## Proof (NEAR testnet, 2026-11-05)

| What | Value |
| --- | --- |
| Contract | `nearbuddy-vault.testnet` |
| Deploy + init (fee 50 bps, withdraw delay 60 s) | [8a14jPxJ9GwUHZ5AKz7qoXAAYYa15tA9zQdiqD2vNmiG](https://testnet.nearblocks.io/txns/8a14jPxJ9GwUHZ5AKz7qoXAAYYa15tA9zQdiqD2vNmiG) |
| Owner deposit 1 NEAR | [49unNKWZuR5J2d5KjRZS1BC5XVzMJYBT7pT1er4hkV9G](https://testnet.nearblocks.io/txns/49unNKWZuR5J2d5KjRZS1BC5XVzMJYBT7pT1er4hkV9G) |
| Solver stake 0.5 NEAR | [5FL8qBixHRxVN1h1hCbWY3JvpcKZrcq6h6sJ81Cyn474](https://testnet.nearblocks.io/txns/5FL8qBixHRxVN1h1hCbWY3JvpcKZrcq6h6sJ81Cyn474) |
| Mandate to a fresh agent key | [CJM5CztsD1EqvMhKKM3iy9uJSMd64uYXoMzUkWE3my1p](https://testnet.nearblocks.io/txns/CJM5CztsD1EqvMhKKM3iy9uJSMd64uYXoMzUkWE3my1p) |
| 100 paid API calls over x402 v2 | ~10 ms/call, 0 chain transactions, agent balance 0 |
| **Settlement of 100 IOUs in 1 tx** | [G2hppREJMxhKvmpSUH5AkMZBE4f4LqJerPP9CJfJmDXS](https://testnet.nearblocks.io/txns/G2hppREJMxhKvmpSUH5AkMZBE4f4LqJerPP9CJfJmDXS) |
| Gas for that settlement | 50.27 TGas total, 0.503 TGas per IOU |
| Result | settled 100, rejected 0, paid 0.005 NEAR, solver fee 0.5% |
| Attack batch (replayed IOU + forged IOU) sent straight to the contract | [i2TsLzBmYPNGPR1rnD9FZsixCdmw1S4sEAQ2w2ZueaY](https://testnet.nearblocks.io/txns/i2TsLzBmYPNGPR1rnD9FZsixCdmw1S4sEAQ2w2ZueaY): settled 0, rejected `nonce already settled`, `bad signature` |
| Off-chain attacks (over cap, replay, forgery, unknown key) | all declined by the solver with HTTP 402 before touching the chain |

## Try it: do X, see Y

Prerequisites: bun 1.3+, near-cli-rs (only to create testnet accounts). Rust is only needed to rebuild the contract.

```sh
cd nearbuddy
bun install
bun run test          # protocol tests: borsh encoding is byte-identical to the Rust contract; sign/verify/tamper
```

Run the full flow against the deployed testnet contract. The demo spawns the paid API and the solver locally,
then plays owner, solver and agent:

```sh
# needs keys for the three testnet accounts in ~/.near-credentials/testnet/*.json
# (create your own with: near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
#  and set OWNER_ID / SOLVER_ID / API_ID)
CALLS=100 bun run demo
```

You see, in order:

1. `[1]` owner vault balance (deposits 1 NEAR if empty) and a tx link.
2. `[2]` solver stake and a tx link.
3. `[3]` a brand-new agent public key and the mandate tx. The agent key has no NEAR account.
4. `[4]` a progress bar: 100 × (GET → 402 → signed IOU → 200), timing, and `0 chain transactions`.
5. `[5]` a SETTLEMENT box with one tx hash, `settled 100 rejected 0`, gas, vault before/after, payee delta.
6. `[6]` four attacks declined by the solver with HTTP 402 and a reason (over cap, replay, forged signature,
   unknown key), then the replay + forgery submitted directly to the contract by a "dishonest solver":
   `settled 0`, both rejected on-chain, with the tx link.

Open the settlement tx on nearblocks: one `settle_batch` call, one transfer receipt to the payee, an
`EVENT_JSON` log with `"event":"settle"`.

Live terminal-style dashboard (Next.js, read-only, polls the contract every 2 s and the local solver's ledger):

```sh
cd web && bun install && cd ..
bun run web            # http://localhost:3000
```

Run `bun run demo` in another shell and watch the SOLVER box climb to 100 carried IOUs, then drop to 0 as the vault
balance and the solver's lifetime counter move in the EVENTS box. Paste the base64 agent key printed at step 3 into
the MANDATE box to watch `spent / allowance` update.

Run the pieces separately if you prefer:

```sh
bun run solver   # :4020  x402 facilitator: POST /verify, POST /settle, GET /supported, GET /ledger
bun run api      # :4010  GET /quote?pair=NEAR/USD  (402 + PAYMENT-REQUIRED until PAYMENT-SIGNATURE is present)
```

The solver persists carried IOUs to `.solver-ledger.json` and auto-settles at 200 IOUs, when the oldest IOU is
60 s old (`SOLVER_AUTO_AGE_MS`), or the moment it sees the owner queue a withdrawal.
`CALLS=5 SKIP_SETTLE=1 bun run demo` leaves IOUs carried so you can kill and restart the solver and watch it restore
and settle them.

## x402 compatibility

The 402 flow is x402 v2 on the wire (spec: x402-foundation/x402, `specs/x402-specification-v2.md`,
`transports-v2/http.md`), with NearBuddy as a custom scheme and the solver playing the facilitator:

| x402 v2 | NearBuddy |
| --- | --- |
| 402 + `PAYMENT-REQUIRED: base64(PaymentRequired)` | `accepts[0] = { scheme: "nearbuddy-iou", network: "near:testnet", amount, asset: "NEAR", payTo, maxTimeoutSeconds, extra: { contract, paymentFlow: "authorization" } }` |
| retry + `PAYMENT-SIGNATURE: base64(PaymentPayload)` | `{ x402Version: 2, accepted, payload: SignedIou }` |
| facilitator `POST /verify` | `{ isValid, payer: owner, invalidReason?, extra: { solver } }`, answered in milliseconds from the mandate + vault state |
| 200 + `PAYMENT-RESPONSE: base64(SettlementResponse)` | `{ success: true, transaction: "", network: "near:testnet", amount, extra: { status: "underwritten", solver, nonce } }` |
| facilitator `POST /settle` | one `settle_batch` for every carried IOU; returns `{ success, transaction: <tx hash>, network, amount }` |

The difference from a standard x402 facilitator: `transaction` is empty at request time because nothing hits the
chain per call. The solver has underwritten the IOU; settlement is batched. Types live in `packages/protocol/src/x402.ts`.

Rebuild and test the contract:

```sh
cd contract
cargo test --lib                        # 12 unit tests: IOU rules + guarantor reserve, failed-pull payout, replay/forgery/short-reserve, cert encoding
cargo near build non-reproducible-wasm
```

## Guarantor layer: one wallet, many cards (2026-11-05)

Self-custody stablecoin cards (Bridge, Baanx, Rain) forbid one wallet backing several cards: the issuer
must answer the card network in seconds, the on-chain pull lands later, and if two cards race for the
same balance the issuer eats the loss. NearBuddy is the neutral staked guarantor in between.

```
card swiped --> issuer --POST /guarantee (wallet, amount)--> solver: reservation ledger
                                                                Σ reserved(wallet) <= min(allowance, balance)
                        <-- solver-signed GuaranteeCert (ms) --   backed by reserve_for_issuer on NEAR
issuer approves authorization
solver --POST /pull--> NEAR contract --request_pull_signature--> Chain Signatures MPC (v1.signer-prod.testnet)
       <-- r,s,v --  Sepolia USDC transferFrom(wallet -> issuer) signed by the *contract's* derived address
solver --settle_pull([outcomes])--> contract: pull ok -> fee accrues; pull failed -> issuer paid from reserve
```

Proof (`bun run guarantor`, NEAR testnet + Ethereum Sepolia, 2026-11-05):

| Step | Hash |
| --- | --- |
| `set_guarantee_key` (solver's cert key) | `E9L6AAz4FhJZe7aWAz9n65gXDTTqFy5UeJca4NdtjBQ1` |
| `reserve_for_issuer(nearbuddy-api.testnet, 0.1 NEAR)` | `EUSYits39SVCepMnYqHdSh9LZMSuFUKLrDKkV5nYesax` |
| user approves the puller once | [`0x49f2088e…8e00`](https://sepolia.etherscan.io/tx/0x49f2088e87ca272f30bca05422e2377c7d8d9bf87e501800670945a7d10d8e00) |
| run A: MPC signature requested by the contract | `3hvEfQsz9YaoAJBDtLehkeu2hG4JznVXAULgmXEh8EmP` |
| run A: Sepolia `transferFrom`, signed by puller `0x1a10a02f13144a60a775b6969c01dfDdD3BB4595` | [`0x59d61bbf…401b`](https://sepolia.etherscan.io/tx/0x59d61bbf8e52ea7261566ed3f8bcca1f70212d47d5bc7a0a0ecccf6ee2fd401b) |
| run A: `settle_pull`, fee accrued | `C3zgrqJvaim9v4fU7Pynu3DiU4zhYqgx3SyQbvdepGtE` |
| run B: wallet drained after the cert | [`0x0b62b47a…e8ad`](https://sepolia.etherscan.io/tx/0x0b62b47ae7ff726daccf2e690b7d4498072ed0c2b564e03d69ac058d5c0fe8ad) |
| run B: pull refused, `settle_pull` pays issuer 0.01 NEAR from reserve | `JDrsRJvxqC9cQKcjzBUZ82RvVNnBaFUmbp2bDcNWFtKp` |

Measured: cert 498–874 ms (two NEAR views + one Sepolia RPC, cacheable to <300 ms), MPC sign 6–38 s on testnet.
The puller address is derived from `(nearbuddy-vault.testnet, "sepolia-1")`: no server holds an EVM key.
Research behind it: no issuer exposes a third-party pre-auth hook, so this needs a partnership; 0 reverts in 4,814
on-chain pulls, so the risk shows up as auth-time declines, not reverts; the loss model (`analysis/loss_model.py`, output
in `analysis/loss_model_output.txt`) puts the Base fee floor at 0.26 bps with the ledger, 2.2 without; ETH L1/BTC are gas-bound.

## Layout

```
nearbuddy/
  arena/                    Rust, near-sdk 5.29: the arena contract (arena/src/lib.rs, types.rs, tests.rs; tests/ sandbox run)
  contract/                 Rust, near-sdk 5.29: the vault / clearinghouse contract (contract/src/lib.rs)
  packages/protocol/        IOU, cert and intent types, borsh encoding byte-identical to the contracts, sign/verify, chain helpers
  packages/resource-server/ a paid API speaking HTTP 402
  packages/solver/          underwriter + arena solver: /verify, /settle, /guarantee, /pull, /duel, /intent, /chaos, /resolve, /settle_follow
  packages/demo/            terminal demos: bun run demo (IOUs), bun run guarantor (cards), bun run arena-demo (follow + chaos + settle), bun run real-swap
  agents/                   Python runner: model duelists (NEAR AI Cloud or stub), intent signing, prices, dataset, summary
  analysis/                 loss model (loss_model.py, output committed), injection effects, send latency, copier bot
  web/                      Next.js 16: / dashboard (vault + solver), /arena (standings, duels, chaos, followers), /agent/[pk]; API routes under web/app/api/
```

## Contract API (`nearbuddy-vault.testnet`)

| Method | Who | What |
| --- | --- | --- |
| `deposit()` payable | owner | lock NEAR in the owner's vault |
| `issue_mandate(agent_pk, allowance, per_tx_cap, allowed_payees, expires_at)` | owner | authorise an ed25519 key to spend from the vault within limits |
| `revoke_mandate(agent_pk)` | owner | kill switch |
| `request_withdraw(amount)` / `withdraw()` | owner | queued withdrawal; solvers refuse new IOUs while one is pending and have the delay to settle |
| `register_solver()` payable | solver | stake that backs underwritten IOUs |
| `settle_batch(ious)` | solver | verify + settle up to 200 IOUs; bad ones are reported in `rejected`, never panic the batch |
| `get_vault`, `get_mandate`, `get_solver`, `is_nonce_used`, `get_config`, `iou_message_hex` | anyone | views |

IOU signing bytes: `"nearbuddy-iou-v1" || borsh(Iou{owner, agent_pk, payee, amount, nonce, expires_at})`.
`iou_message_hex` lets any client confirm its encoding against the contract.

## Security model

- **Agent compromise is bounded** by the mandate: per-IOU cap, total allowance, payee allowlist, expiry, revoke.
  The vault and the owner's keys are never exposed to the agent.
- **Solver cannot forge spend**: the contract re-verifies every signature and every mandate rule at settlement.
  A solver that accepts bad IOUs off-chain simply does not get paid for them.
- **Owner cannot stiff the solver**: withdrawals are queued for `withdraw_delay_ns`; the solver's `/verify` declines
  new IOUs the moment a withdrawal is pending and settles what it already carries.
- **Replay**: `(agent_pk, nonce)` is burned on settlement; the solver also rejects duplicates off-chain.
- **Shortfall**: if a vault is still short at settlement, the payee is paid from the solver's stake. The solver's
  off-chain policy in this repo only underwrites what the vault already covers, so stake is never at risk by default.

## Arena contract API (`arena.nearbuddy-solver.testnet`)

| Method | Who | What |
| --- | --- | --- |
| `register_agent(agent_pk, model_id, tee, register_sig)` payable | agent operator (becomes owner; `register_sig` proves the key over `register_message(owner)`) | bond = deposit minus storage; `tee` commits the agent to a verified enclave proof on every intent; `withdraw_bond(agent_pk, amount)` (1 yocto) when not in a duel |
| `add_tee_signer(signer, label)` / `remove_tee_signer` | contract owner, 1 yocto | ed25519 `signing_address` from a NEAR AI Cloud attestation report (`GET /v1/attestation/report?model=…`) |
| `open_duel(a, b, symbol, close_at)` payable | contract owner (solver) | pair two idle agents on an oracle asset (`wrap.near`) for at most a day (`MAX_DUEL_NS`); sends `oracle_call` for the open price; refunds whatever is attached above storage plus `oracle_deposit`; refused before `set_oracle`; returns `duel_id` |
| `open_duel_consented(a, b, symbol, close_at, sig_a, sig_b)` payable | anyone holding both agents' consent signatures | as `open_duel`; each agent key signs `consent_message(a, b, symbol, close_at)` |
| `request_open_price(duel_id)` payable | anyone, attaches `oracle_deposit` | ask the oracle again if the open price never landed |
| `post_intent(signed, tee)` | anyone (the agent's signature binds it) | agent-signed `Intent{agent_pk, duel_id, side, size_bps, nonce, expires_at, proof_hash}` plus `TeeProof{kind, request_hash, response_hash, signer, signature}`; enclave signature verified on chain, `proof_hash == sha256(req \|\| res)`; nonce and proof burned (one completion backs one intent); storage from the bond |
| `commit_intent` / `reveal_intent` | anyone (agent-signed) | commit-reveal (deploy 14); an unrevealed commitment forfeits the duel |
| `inject_chaos(duel_id, target, kind, payload_hash)` payable | anyone (≥ `min_chaos_deposit`) | attack one agent, 32 per duel. The deposit minus storage joins the pool. Paid by either agent's owner: it goes to `owner_fees` and earns no shield |
| `resolve_duel(duel_id)` payable | anyone, after `close_at`, attaches `oracle_deposit` | asks the oracle for the close price |
| `set_oracle(oracle_account, oracle_deposit, min_duel_s, intent_lock_s)` | contract owner, 1 yocto | refused as `duels open` when it would move the oracle or lower the lock while a duel runs; each duel keeps the lock it opened under; oracle account, its deposit, the intent lock (no intent in the last `intent_lock_s`) and the duel length floor (at most a day; 310 s on testnet: Outlayer serves a cached price for 300 s with a fresh timestamp, so shorter duels would close on their own open price) |
| `oracle_on_call(sender_id, data, msg)` | `price-oracle.*` only | stores the open price (`open:<id>`, refused as `open price stale` outside the oracle's recency window or after close) or scores, slashes, pays the pool, counts shield (third-party chaos only, none on a forfeit), prunes injections, records `outcome` (`close:<id>`) |
| `void_duel(duel_id)` | anyone, 24 h after `close_at` | oracle never answered: free both agents, split the pool, no slash |
| `deposit()` payable | follower | arena vault; refused above `max_vault_total` |
| `request_withdraw(amount)` / `withdraw()` | follower, 1 yocto each | queued vault withdrawal paid `withdraw_delay_s` (900 s) later, `min(requested, vault)`; a bounced transfer is re-credited by `on_withdraw` |
| `follow(agent_pk, mandate)` / `unfollow(agent_pk)` | follower | `Mandate{allowance, spent, per_tx_cap, allowed_tokens, expires_at, revoked, min_out_per_near, revoked_at}`, one record per (agent, follower); `min_out_per_near` (output units per NEAR) must be above 0; `unfollow` stamps `revoked_at`, and a fill fronted before it stays settleable for `withdraw_delay_s` |
| `settle_follow(agent_pk, follower, fills)` | registered solver | at most 10 fills, no `dry-quote:` swap; reads `mt_batch_balance_of(arena)` on `intents_account`, and the private `on_settle_follow` credits each fill only against balance not yet credited (`no receipt` otherwise), with the fee inside `per_tx_cap` and `allowance` and the price floor checked; the output becomes the follower's holding; a batch with nothing settled is a failed transaction |
| `withdraw_token(token_id, amount)` | follower, 1 yocto | sends a holding to the follower's `intents.near` account through `mt_transfer`; debited first, re-credited if the transfer fails |
| `sweep_surplus(token_id, receiver_id, amount)` | contract owner, 1 yocto | sends output nobody can claim, at most balance minus credited minus in-flight sweeps; never touches holdings |
| `add_solver` / `remove_solver`, `set_paused`, `set_vault_cap`, `set_withdraw_delay`, `set_commit_reveal`, `set_require_consent`, `withdraw_fees` | contract owner, 1 yocto | pause blocks new duels, intents, chaos, registrations, deposits, follows and settles; every exit stays open; a removed solver's in-flight settles are rejected |
| `migrate_follows(limit)` | contract owner, 1 yocto | deploy-15 migration: re-keys up to `limit` agents' follower lists; until it returns null, follow, unfollow, settle and `get_follow` are refused (`migrating`) |
| `get_config`, `get_agent`, `get_duel`, `agent_duels`, `get_vault`, `get_follow(agent_pk, follower)`, `get_holding`, `get_accounted`, `get_pending_withdraw`, `leaderboard(from, limit)` (at most 100), `duel_lock(duel_id)` (ns), `is_tee_signer`, `register_message`, `commit_message`, `consent_message`, `get_no_reveal`, `intent_message_hex`, `tee_text_utf8` | anyone | views; `list_followers` is gone (followers come from `follow`/`unfollow` events, or the solver's `GET /followers`) |

Signing bytes: `"nearbuddy-intent-v1" || borsh(Intent)` for the agent, and the enclave's text
`"{model_id}:{request_hash_hex}:{response_hash_hex}"` (`provider_tee`) or `"{request_hash_hex}:{response_hash_hex}"`
(`gateway`); the Rust, TypeScript and Python tests pin the same hex and verify the same real NEAR AI Cloud record.
Registration signs `"nearbuddy-register-v2" || contract || 0x00 || owner` from deploy 15 (v1 had no contract id);
agents registered under v1 stay registered, and clients sign whatever the `register_message` view returns.

## What is deliberately not here (yet)

- **USDC settlement for the clearinghouse.** The vault holds NEAR. The arena already quotes and (by hand) swaps
  through NEAR Intents 1Click; moving IOU settlement to USDC through the same rail is the next step.
- **Attestation checks on chain.** The contract verifies the enclave's signature against signers the owner registered
  after checking their attestation reports off chain (Intel TDX quote, NVIDIA NRAS payload; saved under
  `agents/data/attestations/`). Verifying the quote itself on chain is the next step.
- **Solver market.** One solver here. Both contracts already support many; routing and auction are open.
- **Per-agent solver keys**: see "Known limits" above.

## Architecture

Six parties touch a duel. Two of them (the runner and the solver) are ours and hold keys; the rest are the enclave,
the chain, the oracle and the people watching. The diagrams show who talks to whom; the table below them is the
on-chain surface by caller; the last paragraph says what each party is trusted for.

```mermaid
flowchart LR
  subgraph cloud["NEAR AI Cloud"]
    model["Model in TEE<br/>POST /v1/chat/completions"]
    sig["GET /v1/signature/{chat_id}<br/>ed25519 over model:sha256(req):sha256(res)"]
  end
  runner["Runner (agents/runner.py)<br/>prompt + injection, sign Intent,<br/>build TeeProof, dataset row"]
  solver["Solver (packages/solver, :4020)<br/>/register /duel /intent /chaos<br/>/resolve /settle_follow /arena"]
  arena[("arena.nearbuddy-solver.testnet<br/>post_intent verify, inject_chaos,<br/>oracle_call, settle_follow")]
  oracle["Outlayer price-oracle.testnet<br/>Intel TDX workers, exchange median"]
  intents["NEAR Intents<br/>1Click POST /v0/quote, intents.near"]
  spectator(("Spectator"))
  follower(("Follower"))
  web["Web (web/app)<br/>/arena, /agent/[pk], /api/* read RPC"]
  model -->|"exact request and response bytes"| runner
  sig -->|"signature record"| runner
  runner -->|"POST /intent {signed, tee}"| solver
  solver -->|"open_duel, post_intent,<br/>resolve_duel, settle_follow"| arena
  arena -->|"oracle_call open:id / close:id"| oracle
  oracle -->|"oracle_on_call price"| arena
  solver -->|"dry quote per follower mandate"| intents
  spectator -->|"POST /chaos payload"| solver
  spectator -->|"inject_chaos hash + 0.1 NEAR"| arena
  follower -->|"deposit, follow, unfollow"| arena
  web -->|"get_config, leaderboard, get_duel, agent_duels"| arena
  web -.->|"GET /arena, optional"| solver
```

The runner holds the agent keys and the model API key; it never holds NEAR. The solver account is the contract
owner and its one registered solver; it pays gas, oracle deposits and bonds for hosted agents. Spectators and
followers sign their own NEAR transactions. The web app has no keys: its three API routes (`/api/state`,
`/api/arena`, `/api/agent`) call contract views over the public RPC (the pages poll every 2-20 s); the solver's `GET /arena`
only adds injection payloads, quotes and fills when it is reachable.

One duel, in order:

```mermaid
sequenceDiagram
  participant R as Runner
  participant E as Enclave
  participant S as Solver
  participant C as Arena contract
  participant O as Outlayer oracle
  participant X as Spectator
  R->>S: POST /duel {a, b, wrap.near, close_at}
  S->>C: open_duel (deposit covers storage + oracle_deposit)
  C->>O: oracle_call "open:id"
  O-->>C: oracle_on_call open price
  loop every cycle until close_at minus intent lock (60 s)
    R->>S: GET /arena, pending injections for this agent
    R->>E: chat completion, exact bytes
    E-->>R: response bytes, chat_id
    R->>E: GET /v1/signature/{chat_id}
    E-->>R: ed25519 signature over model:sha256(req):sha256(res)
    R->>S: POST /intent {signed Intent with proof_hash, TeeProof}
    S->>C: post_intent (agent sig, enclave sig, proof_hash, nonce, lock, bond pays storage)
  end
  X->>S: POST /chaos {payload}, returns sha256
  X->>C: inject_chaos(duel, target, kind, hash) with 0.1 NEAR into the pool
  Note over R,C: the target's next prompt carries the payload, its next intent is verified like any other
  R->>S: POST /resolve after close_at
  S->>C: resolve_duel (anyone may call, attaches oracle_deposit)
  C->>O: oracle_call "close:id"
  O-->>C: oracle_on_call close price (timestamp >= close_at)
  Note over C: finish: pnl_bps per side, loser slashed 10% into the pool, pool to the winner,<br/>shield += attacks the winner survived, injections pruned, outcome recorded
```

### On-chain surface by caller

Every row is a `require!` or `panic_str` string in `arena/src/*.rs`; a caller sees it as `Smart contract
panicked: <string>`. Deposits are attached NEAR; "storage" means the bytes the call adds, charged at
`storage_byte_cost`.

| Caller | Method | Deposit | Refused with |
|---|---|---|---|
| anyone | `post_intent(signed, tee)` | none; storage from the agent's bond | `paused`, `agent missing`, `tee proof required`, `bad tee kind`, `unknown tee signer`, `bad tee signature`, `proof_hash mismatch`, `proof used`, `duel missing`, `duel closed`, `intent lock`, `intent expired`, `provider proof required`, `bad target`, `nonce used`, `stale nonce`, `bad signature`, `bad size`, `bond exhausted` |
| anyone | `inject_chaos(duel_id, target, kind, payload_hash)` | at least `min_chaos_deposit` (0.1 NEAR); the rest after storage joins the pool, or `owner_fees` when the payer owns either agent (then no shield) | `paused`, `chaos deposit too small`, `duel closed`, `bad target`, `chaos full` (32 per duel) |
| anyone, after `close_at` | `resolve_duel(duel_id)` | `oracle_deposit`, excess refunded | `attach oracle_deposit`, `resolved`, `duel open`, `no open price` |
| anyone | `request_open_price(duel_id)` | `oracle_deposit` | `has open price`, `duel closed` |
| anyone, 24 h after `close_at` | `void_duel(duel_id)`: frees both agents, splits the pool, no score | none | `resolved`, `too early` |
| anyone, becomes the agent's owner | `register_agent(agent_pk, model_id, tee, register_sig)`; `register_sig` is the key's signature over `register_message(caller)` = `"nearbuddy-register-v2" \|\| contract \|\| 0x00 \|\| caller` | bond, must exceed storage | `paused`, `agent exists`, `bad register signature`, `bond required` |
| anyone holding both consents | `open_duel_consented(a, b, symbol, close_at, sig_a, sig_b)` | storage + `oracle_deposit`; the excess is refunded | `bad consent signature`, then as `open_duel` minus `not owner` / `consent required` |
| anyone | views: `get_config`, `get_agent`, `get_duel`, `duel_lock(duel_id)` (the lock the duel opened under, ns, kept after it ends; the global lock for duels before deploy 15), `agent_duels`, `leaderboard(from, limit)`, `get_vault`, `get_follow(agent_pk, follower)`, `get_holding(follower, token_id)`, `get_accounted(token_id)`, `get_pending_withdraw(account)`, `is_tee_signer`, `register_message`, `commit_message`, `consent_message`, `get_no_reveal`, `intent_message_hex`, `tee_text_utf8` | none | `migrating` (`get_follow`, during `migrate_follows`) |
| agent owner | `withdraw_bond(agent_pk, amount)` | 1 yocto | `not owner`, `in duel`, `insufficient` |
| follower | `deposit()` | any, must exceed storage on first deposit | `paused`, `deposit required`, `vault cap` |
| follower | `request_withdraw(amount)`, then `withdraw()` once `withdraw_delay_s` (900 s) has passed; pays `min(requested, vault)`, re-credited if the transfer bounces | 1 yocto each | `withdrawal already pending`, `insufficient`, `no pending withdrawal`, `withdrawal delay not elapsed` |
| follower | `follow(agent_pk, mandate)`; enclave-verified agents only; one record per (agent, follower) | storage from the vault | `paused`, `migrating`, `agent missing`, `agent unverified`, `empty mandate`, `price floor required` (`min_out_per_near` 0), `insufficient` |
| follower | `unfollow(agent_pk)`: sets `revoked` and `revoked_at`; a fill fronted before it stays settleable for `withdraw_delay_s` | none | `migrating` |
| follower | `withdraw_token(token_id, amount)`: a holding to the follower's `intents.near` account | 1 yocto, forwarded to `mt_transfer` | `insufficient` |
| registered solver | `settle_follow(agent_pk, follower, fills)`: view of the arena's `intents.near` balance, then the private `on_settle_follow`; a partly settled batch reports its rejections, a batch with nothing settled fails with the first one | none | `not solver`, `paused`, `migrating`, `empty fills`, `too many fills` (> 10), `dry quote unsettleable`, `swap_tx length`, `token length`; batch: `no receipt`, `outflow during view`, `solver removed`; per fill: `nonce unknown`, `duplicate fill`, `no mandate`, `mandate revoked`, `mandate expired`, `token not allowed`, `fee overflow`, `over cap`, `allowance exhausted` (both include the fee), `amount overflow`, `below min price`, `no receipt`, `insufficient` |
| contract owner | `open_duel(a, b, symbol, close_at)` | storage + `oracle_deposit`; the excess is refunded | `not owner`, `consent required`, `paused`, `set_oracle first`, `same agent`, `symbol too long`, `close_at in the past`, `duel too short` (`min_duel_s`, 310), `duel too long` (`MAX_DUEL_NS`, a day), `agent missing`, `in duel`, `deposit too small` |
| contract owner | `add_solver`, `remove_solver`, `set_oracle(oracle_account, oracle_deposit, min_duel_s, intent_lock_s)`, `add_tee_signer(signer, label)`, `remove_tee_signer`, `set_commit_reveal`, `set_require_consent`, `set_paused`, `set_vault_cap`, `set_withdraw_delay`, `withdraw_fees`, `sweep_surplus(token_id, receiver_id, amount)`, `migrate_follows(limit)` | 1 yocto | `Requires attached deposit of exactly 1 yoctoNEAR`, `not owner`, `not a solver`, `min_duel_s too large` (above a day), `intent_lock_s too large` (at most half the floor), `duels open`, `signer length`, `label too long`, `delay out of range`, `zero amount`, `migration done`, `insufficient` |
| oracle account only | `oracle_on_call(sender_id, data, msg)`; `sender_id` must be this contract | none | `not oracle`, `not our request`, `bad msg`, `no price`, `bad price`, `bad open price`, `resolved`, `duel open`, `price before close`, `no open price` |
| contract account | `migrate_v15(intents_account, max_vault_total)` and the callbacks `on_settle_follow`, `on_withdraw_token`, `on_withdraw`, `on_sweep_check`, `on_sweep_done` (`#[private]`) | none | |

No method sets a price, and no method lets the owner move a bond, a pool or a vault except through the rules above.

### Trust boundaries

**The enclave proves** that the model named in the agent's registration produced this exact response to this
exact request: its ed25519 signature covers `"{model_id}:{sha256(request)}:{sha256(response)}"`, and its signing
key comes from the model's attestation report, which the owner checked off chain (Intel TDX quote, NVIDIA NRAS)
before `add_tee_signer`. For "Private" models the weights ran in the TEE; for "Anonymised" models the gateway
signs `"{sha256(request)}:{sha256(response)}"` and proves only what the gateway returned. Proof table rows:
"Enclave-verified intents", "Enclave attestation checked by a third party".

**The chain checks** the agent's signature over the intent, the enclave's signature against a pinned signer,
`proof_hash == sha256(request_hash || response_hash)` (one completion backs one intent, `proof used`), the
per-agent nonce, the duel window and the intent lock, the mandate on every fill, that the arena's own
`intents.near` balance holds the output behind every fill, and that a price callback came
from the oracle account for a request this contract sent. It does not check what the response said: the link
"this response says Long" lives in the dataset row next to the published request and response bytes, so anyone
can recompute both hashes and read the text. Rows: "Tampered proof refused", "`settle_follow` rejections on
chain", "Duel 23: follower calls `unfollow`".

**The operator can still** choose the prompt (hardened or naive; the control batch shows the behaviour follows
the prompt), decide who is paired and when (`open_duel` is owner-only; the solver's pairing loop pairs idle
verified agents by key order), hold the agent keys of hosted runners (so it can post an intent that gets an agent
slashed, but cannot forge an enclave proof for it or post without one), pin and unpin enclave signers, and front
follower swaps behind one shared `x-arena-key` secret. It cannot set a price, post for an enclave agent without
a fresh enclave signature, or move follower funds outside a mandate. A self-hosted runner (`bun run join`,
`runner.py --only B --wait-pairing`) removes the hosted-key item: the key never leaves the builder's machine.

**The oracle is trusted** for the open and close price and their timestamps. Outlayer runs the fetch in Intel TDX
workers and serves a median of exchanges, but it caches a price for 300 s with a fresh timestamp, so duels are at
least 310 s and the open price may be up to 300 s old. The contract refuses a close price stamped before
`close_at` and never scores a duel twice; if the oracle never answers, anyone may `void_duel` after 24 h with no
slash and no score. Rows: "Duel 257 resolved by the oracle, no operator key", "Duel 258 resolved by the TEE
oracle, called by anyone".

## Status

Working on NEAR testnet, see the two proof tables above. Not audited. Testnet only; the one mainnet leg is the 1Click swap.
