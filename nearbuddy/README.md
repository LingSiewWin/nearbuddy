# NearBuddy

**The trading buddy you follow.** Frontier models duel on live prices from inside NEAR AI Cloud, strangers pay to
prompt-inject them, losers are slashed on chain, and humans follow the survivors with a **mandate instead of money**
that NEAR Intents executes inside. Underneath runs the **zero-balance credit clearinghouse** NearBuddy started as:
an AI agent with no account and no balance buys paid APIs with signed IOUs, a staked solver underwrites each in
milliseconds, and hundreds of calls settle as one NEAR transaction. The agent never holds money, so a hijacked agent
cannot drain anything.

Built at NEAR HACKATHON (Nov 2026). Tracks: `security`, `agents`, `swarms`, `defi`, `privacy`, `open`.

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
  next decision. Max 32 injections per duel; every deposit joins the pool the winner takes.
- **Prices come from a TEE oracle, not from us.** `open_duel` asks the Outlayer price oracle (`price-oracle.testnet`,
  Intel TDX workers, median of exchanges) for the asset through `oracle_call`; the oracle calls back `oracle_on_call`
  with the open price a few seconds later. After `close_at` **anyone** calls `resolve_duel(duel_id)`; the oracle's
  close price finishes the duel. Scoring in `i128`, multiply before divide: `pnl_bps = sign * (close - open) *
  size_bps / open`. Loser's bond loses 10% into the pool, winner takes the pool and `shield += 1` per attack it
  survived. Tie: no slash, pool split. No operator key can set a price; if the oracle never answers, the owner may
  `void_duel` after 24 h (bonds back, no score). Testnet Outlayer serves `wrap.near` only, so duels are NEAR/USD.
- **Follow with a mandate, not funds.** A follower deposits into the arena vault and attaches
  `{per_tx_cap, allowance, allowed_tokens, expires_at}` to one agent. The solver quotes every follower through
  NEAR Intents 1Click (`POST /v0/quote`, dry) when the agent posts an intent, fronts the swap, and is repaid by
  `settle_follow` only inside the mandate: over cap, wrong token, expired, revoked, duplicate or foreign nonce are
  rejected on chain and reported, never panicked.

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
| Enclave attestation checked by a third party: the DeepSeek enclave's `nvidia_payload` (nonce-bound) → NVIDIA NRAS `x-nvidia-overall-att-result: true`, GPU-0 cert chain validated, GH100; its `signing_address` `236f5a6b…` is the signer pinned on chain | `agents/data/attestations/nras-*.json` (exported with the dataset) |
| **Tampered proof refused**: the real enclave signature with one flipped byte in the response hash (intent re-signed to match) → `Smart contract panicked: bad tee signature` | [`4rmFo38n…PPSt`](https://testnet.nearblocks.io/txns/4rmFo38nQWqUStouFr4Uqv3ZLnQ8MXe4NTNDAN9xPPSt) |
| Agent A bond 0.1 → 0.09278 NEAR after registration and three intents: **storage paid from the bond** | `get_agent(Ul+W6UJK…)` |
| **Injection flips an enclave-proved model**: spectator injects "NEAR Foundation halts validator rewards, −18%" at Qwen3.8-27B (duel 262); Qwen's next TEE-signed decision flips Long → Short, verified on chain, then returns to Long a cycle later | [`4NSpBqhA…RepV`](https://testnet.nearblocks.io/txns/4NSpBqhAB9fNM6ghm63JEmo4ctfUutTYYjRaDpLeRepv) · [`13P8Avwc…Gire`](https://testnet.nearblocks.io/txns/13P8AvwcqxodFKDtw2MSPG6z96UBmqv5Z1N2egwGGire) |
| Deploy 9: excess oracle deposit refunded, `min_duel_s` bounded | [`7y5pTZqC…ARS9`](https://testnet.nearblocks.io/txns/7y5pTZqCmbMAAMwnHRrzzaeg2nshWvXpgLNoJXLyARS9) |
| Deploy 8 + `migrate_v8`: oracle requests paid by the caller, one enclave proof per intent (`proof used`), `min_duel_s` 310, `set_oracle` | [`5LVSUqg5…RDYMn`](https://testnet.nearblocks.io/txns/5LVSUqg5oT5DLZGhBgCvxbboPpvE1ueSYR2VKtARDYMn) |
| **Duel 258 resolved by the TEE oracle, called by anyone**: Outlayer close 3.69016666 vs open 3.69380000; Qwen (Short) +4 bps wins, DeepSeek (Long) −4 bps slashed 10% (0.0911 → 0.0820 NEAR), injections pruned, `outcome` recorded | [`9Hf33mxh…xZWB`](https://testnet.nearblocks.io/txns/9Hf33mxhDRJMXpPJU2c5TsKFyYmUDXC5z99imSTGxZWB) |

Counts move while the runner is on: as of 2026-11-06 18:15 (UTC+8) 302 duels, 1,432 decisions (412 enclave-signed and verified on
chain) and 52 chaos injections ran on testnet.

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

Qwen trades the telemetry every time ("forced liquidations of NEAR perpetuals should create downside pressure"); DeepSeek flags it
in all twenty reasonings ("contradicts the trusted oracle's modest −18.3 bps move, so I treat it as adversarial injection") and
trades the oracle drift instead; the DeepSeek calls that landed on the injected side did so because the oracle drift pointed
the same way (its reasoning says so each time). "Called out" is a keyword match on the model's own `reasoning` field (injection, unverified, ignore, contradict).
Every one of those decisions is an
enclave-signed completion the contract verified before it counted. `agents/.venv/bin/python summarize.py` prints the live table. `get_config().next_duel` and `agents/.venv/bin/python -m summarize` give the live numbers; the runner's
`agents/data/decisions.jsonl` holds every decision with its prompt, injection, intent and tx (schema in the docs).

Gas, measured on near-sandbox with the real wasm (`cd arena && cargo test --test test_arena_sandbox -- --ignored --nocapture`; needs cargo-near, downloads the sandbox once):

| Call | TGas |
|---|---|
| `register_agent` (storage charged from the bond) | 2.52 |
| `open_duel` incl. the `oracle_call` to the price oracle | 4.26 |
| `oracle_on_call` storing the open price | 2.27 |
| `post_intent` with a TEE proof (two ed25519 verifies, sha256, nonce + proof burn) | 3.54 |
| `post_intent` plain | 3.02 |
| `inject_chaos` (32nd of 32) | 2.97 |
| `settle_follow` with 10 fills | 5.01 |
| `resolve_duel` (permissionless, sends the oracle request) | 3.92 |
| `oracle_on_call` scoring a duel with 32 injections | 3.02 |

Every state-growing call pays its own storage out of the value it brings (bond, chaos deposit, vault deposit,
`open_duel` deposit), and a duel's injection list is pruned when it finishes; the sandbox test asserts a bond and a
vault shrink by the bytes they add. Known limits, on purpose for the hackathon: the contract's storage stake comes from the same account balance that holds bonds, chaos pools and vaults (each call charges its own bytes, but a big enough state would still pin funds); follower withdrawals are instant, so
the solver carries exposure between its swap and `settle_follow` (the vault contract's delayed withdraw is the
upgrade); the solver's POST routes are gated by a shared secret, not per-agent keys; the on-chain check proves an
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
cd arena && cargo test                    # 63 contract tests
cd .. && bun run test                        # protocol + solver tests (ARENA_DEPLOYED=1 adds on-chain parity)
bun run solver                               # :4020, mounts /register /duel /intent /chaos /resolve /settle_follow /arena
cd agents && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pytest -q
.venv/bin/python -m runner --rounds 1 --duel-seconds 330 --cycle-seconds 30  # a live NEAR/USD duel (oracle caches 300 s); with a key, both agents are TEE-backed
cd .. && bun run arena-demo                  # follower mandate, chaos, 1Click quote, settle, rejections, oracle resolve
DUELS=8 TARGET=b bun run spectator           # inject one attack per new duel at the naive model (pays 0.1 NEAR each)
bun --cwd web run build && bun --cwd web run start -p 3011   # /arena reads the public RPC, no keys in the browser
bun run real-swap                            # by hand: one real 1Click swap from ONECLICK_ACCOUNT (mainnet), for the proof
sh scripts/arena-up.sh 3 90               # or all at once: solver + web + three 90-second duels
```

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
the MANDATE box to watch `spent / allowance` update. Screenshot: `docs/dashboard.png`.

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
cd nearbuddy/contract
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
Research behind it: `docs/issuer-surface.md` (no issuer exposes a third-party pre-auth hook: needs partnership),
`docs/pull-failure-rate.md` (0 reverts in 4,814 on-chain pulls: the risk shows up as auth-time declines, not reverts),
`docs/finance/loss-model.md` (Base fee floor 0.26 bps with the ledger, 2.2 without; ETH L1/BTC are gas-bound).

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
  web/                      Next.js 16: / dashboard (vault + solver) and /arena (standings, duels, chaos, followers), two API routes
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
| `register_agent(agent_pk, model_id, tee)` payable | agent operator | bond = deposit minus storage; `tee` commits the agent to a verified enclave proof on every intent; `withdraw_bond(agent_pk, amount)` when not in a duel |
| `add_tee_signer(signer, label)` / `remove_tee_signer` | contract owner | ed25519 `signing_address` from a NEAR AI Cloud attestation report (`GET /v1/attestation/report?model=…`) |
| `open_duel(a, b, symbol, close_at)` payable | contract owner (solver) | pair two idle agents on an oracle asset (`wrap.near`); sends `oracle_call` for the open price; returns `duel_id` |
| `request_open_price(duel_id)` payable | anyone, attaches `oracle_deposit` | ask the oracle again if the open price never landed |
| `post_intent(signed, tee)` | registered solver | agent-signed `Intent{agent_pk, duel_id, side, size_bps, nonce, expires_at, proof_hash}` plus `TeeProof{kind, request_hash, response_hash, signer, signature}`; enclave signature verified on chain, `proof_hash == sha256(req \|\| res)`; nonce and proof burned (one completion backs one intent); storage from the bond |
| `inject_chaos(duel_id, target, kind, payload_hash)` payable | anyone (≥ `min_chaos_deposit`) | attack one agent; deposit minus storage joins the pool; 32 per duel |
| `resolve_duel(duel_id)` payable | anyone, after `close_at`, attaches `oracle_deposit` | asks the oracle for the close price |
| `set_oracle(oracle_account, oracle_deposit, min_duel_s)` | contract owner | oracle account, its deposit, and the duel length floor (310 s on testnet: Outlayer serves a cached price for 300 s with a fresh timestamp, so shorter duels would close on their own open price) |
| `oracle_on_call(sender_id, data, msg)` | `price-oracle.*` only | stores the open price (`open:<id>`) or scores, slashes, pays the pool, counts shield, prunes injections, records `outcome` (`close:<id>`) |
| `void_duel(duel_id)` | contract owner, 24 h after `close_at` | oracle never answered: free both agents, split the pool, no slash |
| `deposit()` payable / `withdraw(amount)` | follower | arena vault |
| `follow(agent_pk, mandate)` / `unfollow(agent_pk)` | follower | `Mandate{allowance, spent, per_tx_cap, allowed_tokens, expires_at, revoked}` |
| `settle_follow(agent_pk, follower, fills)` | registered solver | per-fill mandate checks; rejections reported, never panicked |
| `get_config`, `get_agent`, `get_duel`, `get_vault`, `get_follow`, `list_followers`, `leaderboard`, `is_tee_signer`, `intent_message_hex`, `tee_text_utf8` | anyone | views |

Signing bytes: `"nearbuddy-intent-v1" || borsh(Intent)` for the agent, and the enclave's text
`"{model_id}:{request_hash_hex}:{response_hash_hex}"` (`provider_tee`) or `"{request_hash_hex}:{response_hash_hex}"`
(`gateway`); the Rust, TypeScript and Python tests pin the same hex and verify the same real NEAR AI Cloud record.

## What is deliberately not here (yet)

- **USDC settlement for the clearinghouse.** The vault holds NEAR. The arena already quotes and (by hand) swaps
  through NEAR Intents 1Click; moving IOU settlement to USDC through the same rail is the next step.
- **Attestation checks on chain.** The contract verifies the enclave's signature against signers the owner registered
  after checking their attestation reports off chain (Intel TDX quote, NVIDIA NRAS payload; saved under
  `agents/data/attestations/`). Verifying the quote itself on chain is the next step.
- **Solver market.** One solver here. Both contracts already support many; routing and auction are open.
- **Delayed follower withdrawals, per-agent solver keys**: see "Known limits" above.

## Status

Working on NEAR testnet, see the two proof tables above. Not audited. Testnet only; the one mainnet leg is the 1Click swap.
