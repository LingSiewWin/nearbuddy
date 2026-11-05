# NearBuddy

**Zero-balance credit clearinghouse for AI agents, on NEAR.**

Stripe built checkout for humans. NearBuddy lets an AI agent that has **no account and no balance** buy paid APIs
with signed IOUs. A solver underwrites each IOU in milliseconds. Hundreds of calls settle as **one** NEAR
transaction against the owner's locked vault. The agent never holds money, so a hijacked agent cannot drain anything.

Built at NEAR HACKATHON (Nov 2026). Tracks: `agents`, `security`, `swarms`, `open`.

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

Prerequisites: Node 22+, pnpm, near-cli-rs (only to create testnet accounts). Rust is only needed to rebuild the contract.

```sh
cd nearbuddy
pnpm install
pnpm test          # protocol tests: borsh encoding is byte-identical to the Rust contract; sign/verify/tamper
```

Run the full flow against the deployed testnet contract. The demo spawns the paid API and the solver locally,
then plays owner, solver and agent:

```sh
# needs keys for the three testnet accounts in ~/.near-credentials/testnet/*.json
# (create your own with: near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
#  and set OWNER_ID / SOLVER_ID / API_ID)
CALLS=100 pnpm demo
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
pnpm --dir web install
pnpm web            # http://localhost:3000
```

Run `pnpm demo` in another shell and watch the SOLVER box climb to 100 carried IOUs, then drop to 0 as the vault
balance and the solver's lifetime counter move in the EVENTS box. Paste the base64 agent key printed at step 3 into
the MANDATE box to watch `spent / allowance` update. Screenshot: `docs/dashboard.png`.

Run the pieces separately if you prefer:

```sh
pnpm solver   # :4020  x402 facilitator: POST /verify, POST /settle, GET /supported, GET /ledger
pnpm api      # :4010  GET /quote?pair=NEAR/USD  (402 + PAYMENT-REQUIRED until PAYMENT-SIGNATURE is present)
```

The solver persists carried IOUs to `.solver-ledger.json` and auto-settles at 200 IOUs, when the oldest IOU is
60 s old (`SOLVER_AUTO_AGE_MS`), or the moment it sees the owner queue a withdrawal.
`CALLS=5 SKIP_SETTLE=1 pnpm demo` leaves IOUs carried so you can kill and restart the solver and watch it restore
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

Proof (`pnpm guarantor`, NEAR testnet + Ethereum Sepolia, 2026-11-05):

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
  contract/                 Rust, near-sdk 5.29. One file: contract/src/lib.rs
  packages/protocol/        IOU type, borsh encoding, Agent (keypair) sign/verify, chain helpers
  packages/resource-server/ a paid API speaking HTTP 402
  packages/solver/          underwriter: /verify in ms, /settle in one tx
  packages/demo/            terminal demo (the proof above)
  web/                      Next.js 16 live dashboard, terminal styling, one API route (/api/state)
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

## What is deliberately not here (yet)

- **USDC settlement via NEAR Intents.** The vault holds NEAR for the MVP. The next step is a NEP-141 vault and
  settlement in USDC through NEAR Intents so payees on other chains can be paid from one NEAR batch.
- **TEE-attested agents on NEAR AI Cloud.** Run the agent's reasoning and IOU signing inside NEAR AI Cloud's TEE
  and let solvers require the attestation before underwriting. That turns "trust the agent key" into
  "trust the enclave".
- **Solver market.** One solver here. The contract already supports many; the open question is routing/auction.

## Status

Working MVP on NEAR testnet, see proof above. Not audited. Testnet only.
