# nearbuddy-paygate

NEAR contract (`src/lib.rs`, account `nearbuddy-paygate-v2.testnet`) that signs a USDC payment on Base through NEAR Chain Signatures, only inside the owner's policy (cap per payment, allowance, payees, expiry) and only when the call carries a fresh completion signed by a listed NEAR AI Cloud enclave. Each completion is used once. The contract runs on NEAR testnet; the USDC it controls is on Base mainnet.

In the project this is the second part: the arena measures how an AI agent gets fooled, and this gate bounds what a fooled agent can spend.

```sh
cargo test --locked --lib      # 47 pass (2026-11-14)
```

## One sentence, one real order (2026-11-13)

_Moved here from the project README on 2026-11-14. File paths in backticks are relative to `nearbuddy/`. Dated statements describe the day they were written; "above" and "below" refer to this file._

You type one sentence, for example `buy me a RM5 KFC voucher`. A model running in a NEAR AI Cloud enclave reads it and
picks one product from the live Bitrefill catalogue; the exact request and response bytes are kept with the enclave's
signature. NEAR Intents (1Click) turns NEAR into the USDC that is missing on Base. The `paygate` contract, through NEAR
Chain Signatures, signs the Base payment from an address that has no private key on any server (the MPC network signs for it), and only inside the owner's policy
(cap, allowance, payees, expiry). It signs only when the call carries a fresh completion signed by the listed model's
enclave, and each completion is used once; the contract does not read what the completion says. The agent holds a
function-call access key that can call `sign_payment` and `sign_login` on that contract and nothing else. A real voucher comes back, and a receipt
file lets anyone re-check the order from public data.

**Do X, see Y.** The commands run from `nearbuddy/` with the same environment. The first command moves real money:
about 0.37 NEAR (mainnet) buys a 1.31 USDC voucher.

Environment (in `.env`, see `.env.example`): `NEAR_AI_API_KEY`; `ONECLICK_ACCOUNT`, a funded NEAR mainnet account whose
key is in `~/.near-credentials/mainnet/`; `ORDER_MODEL` (default `deepseek-ai/DeepSeek-V4.1-Flash-1017`);
`ORDER_MAX_NEAR` (default `1`, the most wNEAR one run may deposit). The first lines of the block below export
`NEAR_NETWORK`, `PAYGATE`, `PAYGATE_OWNER` and `PAYGATE_AGENT`. The agent's key is read from
`.secrets/paygate-agent.key`. The voucher code goes to `.secrets/order-<invoice>.json` and is never printed. Receipts
go to `.orders/`.

```sh
export NEAR_NETWORK=testnet PAYGATE=nearbuddy-paygate-v2.testnet PAYGATE_OWNER=nearbuddy-solver.testnet
export PAYGATE_AGENT=nearbuddy-paygate-agent.testnet

# 1. Buy (real money). Exit 0.
bun run buy "buy me a RM5 KFC voucher"
# observed 2026-11-13: "status": "delivered", receipt .orders/2026-11-13T13-57-00-308Z-51f05036.json, 103 s in total

# 2. Re-check the receipt from public data only. Sends nothing, spends nothing.
bun run verify-order .orders/<id>.json --gate nearbuddy-paygate-v2.testnet
# observed: no FAIL, 15 PASS, 0 SKIP, exit 0
# The receipt of that delivered order is committed, so this runs from a clone with no key:
bun run verify-order fixtures/orders/delivered-2026-11-13.json --gate nearbuddy-paygate-v2.testnet
# observed 2026-11-14 from a clean clone: no FAIL, 15 PASS, 0 SKIP, 3 s

# 3a. Ask for something the policy forbids: the contract refuses and nothing is swapped. Exit 3.
bun run buy "buy me a RM50 KFC voucher"
# observed: "the payment is above the per-payment cap" from the contract's sign_payment, no swap, exit 3
#   verify-order on that receipt: no FAIL, 11 PASS, 2 SKIP

# 3b. Send the first order's recorded decision again. The contract refuses it. Exit 3.
ORDER_REPLAY=.orders/<id of the first receipt>.json ORDER_REPLAY_COUNTRY=MY bun run buy
# observed: "this decision was already used" from the contract's sign_payment, no swap, exit 3
#   verify-order on that receipt: no FAIL, 10 PASS, 3 SKIP
```

Exit codes of `buy`: 0 delivered, 3 refused or asked, 1 failed. When the verifier runs right after a transaction it can
say `NEAR tx not found` because the public index has not caught up; wait about 30 seconds and run it again (the RM50
receipt needed one retry).

### Proof (2026-11-13)

| Claim | Where to look |
|---|---|
| NEAR account deposits 0.37139 wNEAR to the 1Click address (mainnet) | https://nearblocks.io/txns/HsrUpvo9Xp4CZUoxJ1PDLrxSwhw522ArMubJBZaYReaA |
| The contract address signs in to Bitrefill (`sign_login`, allowed domain `api.bitrefill.com` only) | https://testnet.nearblocks.io/txns/Fqr1hrZwSWYZ2DFcoZU3KknoGBqGV9KRJ5iBp4S7qXHA |
| The contract checks the decision and the policy and signs the payment (`sign_payment`) | https://testnet.nearblocks.io/txns/8UWZoXh1qKqk49BUDkvjpHw8FxTkVaTB7Jebp4hEA1Au |
| 1.31 USDC leaves `0xd0FE267ADcCAab7C50Ea6a8869C9E7144b5772E8` for Bitrefill (Base mainnet) | https://basescan.org/tx/0xd442fad73dc96d0b43b3dda721eb06f177c2a26868bcc73a76eeb40751c1ec61 |
| RM50 voucher: refused on chain, "the payment is above the per-payment cap" | https://testnet.nearblocks.io/txns/FfNhzxiefbgD1WNg5GZoLecqr2qdRv396YEPT5iryJTu |
| Replay of the first decision: refused on chain, "this decision was already used" | https://testnet.nearblocks.io/txns/7j9fD4fT2rezRuSJmainRGrF2grSNSSGGEBNkHEa2Ntg |
| Contract `nearbuddy-paygate-v2.testnet` deployed (wasm sha256 `5157248bf9f0f5c994b8067bc5b2881c62256a7a24ab6e291b882ed32ec94dca`) | https://testnet.nearblocks.io/txns/XDKVUnsFHmaZY5s66MdPGVBztN8Gn4TWaEWa6JBNmpd |
| Owner account opened on the contract (derives the payer address) | https://testnet.nearblocks.io/txns/3MbtCv9LEyr3SXgRedHvsLKo8JdxTeHce1B8TXYxBsCG |
| Policy set: cap 1.5 USDC per payment, allowance 3 USDC, one payee, expiry, login domain, model | https://testnet.nearblocks.io/txns/D5TPDnb8vBnuL6qKnA2u6dCuJc6myejspDJ1Wp6gNX22 |
| Enclave signer registered (`add_tee_signer`) | https://testnet.nearblocks.io/txns/5pHZQqTNkugxnPtvKPVLqFZva7nEfwghUBe7zNfmM7Uv |

### Time and cost, next to the manual way

From the receipt of the delivered order, in milliseconds: search 20465, decide 2565, invoice 632, swap 52924, pay 9347,
wait for the voucher 15849; total 103206 (about 103 s; the legs add up to 101782, the rest is work between legs). The
cost was 0.37139 NEAR for a 1.31 USDC voucher. The founder's own observation of a manual purchase that morning: the
code arrived under 30 seconds after paying 1.31 USDC, with a person present (Base tx
`0x42c10cc9257ca191575a0f0259b84fe5d1668b4d203bcfbebf0fb0bb86736552`). The agent took 103 seconds with nobody present.
It is not faster; what it adds is that no person signs, and every step can be re-checked.

### What the verifier proves, and what it does not

`bun run verify-order` reads only public data: the receipt file, the NEAR transaction (FastNEAR tx API), the contract's
own view calls (`get_account`, `is_decision_used`), and the Base chain (transaction receipt and USDC
`authorizationState`). It checks that the enclave's signature covers the recorded request and response bytes, that the
decision has the allowed shape and the sentence is in the request, that the `sign_payment` on the contract you pass in
`--gate` succeeded with those fields, that the contract consumed the decision, and that the stated USDC amount moved on
Base from the owner's payer address. The gate is an input, never read from the receipt, because anyone can deploy a
contract that logs the same event.

It does not prove that the goods were delivered or that the invoice was what the receipt says; neither is read. For a
receipt that is not delivered, only the recorded transactions and two on-chain reads were checked, and each SKIP line
names what was not verified. It cannot show whether a reused decision's original payment settled: the contract refused
the reuse and the first call is not in that receipt. It does not check that no other receipt reuses the same Base
transaction, because there is no receipt store to compare with.

### Code map

| File | What it does |
|---|---|
| `paygate/src/lib.rs` | The contract: owner accounts, policy, enclave signer list, single-use decisions, builds the EIP-3009 digest and asks MPC to sign |
| `packages/solver/src/paygate.ts` | x402 signer that calls `sign_payment` and `sign_login` on the contract with the agent's function-call key |
| `packages/orders/src/intake.ts` | Sends the sentence to the enclave model, keeps the signed request and response bytes, refuses any output that is not the schema |
| `packages/orders/src/rail.ts` | The `Rail` interface (search, invoice, pay, wait) and the output sanitiser |
| `packages/orders/src/bitrefill-rail.ts` | The one rail: Bitrefill vouchers over x402 |
| `packages/orders/src/order.ts` | The flow: decide, check the price limit, read the contract's policy, swap only the shortfall, sign through the contract, store the voucher; every exit writes a receipt |
| `packages/orders/src/buy.ts` | The `bun run buy` entry point: reads the env, wires the real services, replay hook `ORDER_REPLAY` |
| `packages/orders/src/receipt.ts` | The `Receipt` type and the writer for `.orders/` |
| `analysis/verify_order.ts` | The verifier above |
| `fixtures/wire-vectors.json` | Shared test vectors (`payment`, `login`): the Rust and TypeScript tests compare the same digest bytes |

### Limits, stated plainly

- The contract runs on NEAR testnet and controls real USDC on Base; testnet MPC is weaker than mainnet.
- What is bought is a merchant voucher, not a delivered order, and the voucher codes were not redeemed by us.
- There is one payment route (Bitrefill) and in practice one user.
- The contract checks that a listed enclave signed the completion and that it is used once, but it does not read what
  the completion says. Anyone with a NEAR AI Cloud key can produce such completions, so the decision is an audit link
  and the policy (cap, allowance, payees, expiry) is the spending bound; it also bounds a stolen agent key.
- `ORDER_REPLAY` on a receipt whose decision was never used attempts a real purchase. It is bounded by the price
  recorded in that receipt's own request (limit at most the recorded listed price plus 3 percent), not by today's
  catalogue.
- A stolen agent key can use up the owner's storage balance in the contract (each signature adds a used-decision entry)
  and stop payments until the owner tops up.
- No view lists the contract's enclave signers, so the signer set can be audited only from transaction history
  (`add_tee_signer` calls).
- The sentence is not signed by the user: whoever runs `buy` is trusted to pass the user's words.
- Nothing pays the user back if the merchant does not deliver.
- A failed signing still consumes the decision and the allowance.
- Storage deposits held in the contract cannot be withdrawn.
- The enclave key was checked against NEAR AI's attestation report for its signing address only, not the hardware
  quote chain.
- The verifier cannot show whether a reused decision's original payment settled, and needs about 30 seconds after a
  transaction before the public index has it.
- The agent account still has its original full-access key next to the function-call key.
- The contract has had review inside this project only, no outside audit.

The first, script-only version of this ran earlier the same day against `nearbuddy-paygate.testnet` (a fixed product,
no model). Its proofs: NEAR https://testnet.nearblocks.io/txns/4a9pn1CRxt4N6cxh6qsJA9FWevebDJJ58YCKNKfi9wPB and Base
https://basescan.org/tx/0x85ac979eb91a4643e6b52c88346c6ad25252532e570fddf10e182af7816aa3dc
