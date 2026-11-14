# NearBuddy

Built at NEAR HACKATHON, 2026-11-05 to 2026-11-14. Game on the site: "Lie to an AI".

**The problem.** AI agents are being given money, and one false sentence in their input can change what they do
with it. Nobody can say how easily a given agent is fooled, or what it costs to fool it.

**What this is.** An arena on NEAR testnet where two AI trading agents, each holding a bond, duel on the NEAR price.
Anyone can pay to plant one fake headline at one of them. The agent's next decision is signed inside a NEAR AI
Cloud enclave, the arena contract checks that signature, and the contract records whether the agent was fooled and
pays out accordingly. The second part is a payment gate: a contract that lets an agent pay USDC on Base through NEAR
Chain Signatures only inside an owner's policy, which bounds what a fooled agent can spend.

**Who has played.** Every attack recorded on chain so far was placed by an account the project created or controls:
58 placed, 23 reached a decision, 12 recorded as fooled, 11 as held. No outside attacker has been recorded. All
arena funds are testnet NEAR.

Detail, results and limits: [`nearbuddy/README.md`](nearbuddy/README.md).

## Start here for judges

Nothing below needs a key, an account or an env file. Outputs were observed on 2026-11-14 from a clean clone on an
Apple Silicon laptop, with the bun, uv and cargo download caches warm. Times are approximate. The verifiers read
public RPCs: if one throttles, a line reads SKIP and the summary says to re-run; a FAIL would be a real mismatch.

Prerequisites: `git`, `curl`, `python3`; [bun](https://bun.sh) 1.3 or later (1.3.3 used); [uv](https://docs.astral.sh/uv/)
(0.13.7 used; it fetches Python 3.13 or later); `rustup` (each contract folder pins Rust 1.93.0 in
`rust-toolchain.toml`, and rustup installs it on first use). `cargo-near` is needed only to build the wasm, not for
any step here.

**1. With no install** (the hosted site and a public NEAR RPC):

```sh
# The site re-checks duel 537 (a planted headline that fooled a model) from public chain data. About 8 s.
curl -s 'https://nearbuddy.vercel.app/api/verify?duel=537' | grep -o '"counts":{[^}]*}'
#   "counts":{"PASS":30,"FAIL":0,"SKIP":2,"INFO":2}

# The same attack, read straight from the arena contract on a public RPC.
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"arena.nearbuddy-solver.testnet","method_name":"get_chaos","args_base64":"eyJkdWVsX2lkIjoiNTM3In0="}}' | python3 -c 'import sys,json;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'
#   [{"injector":"nearbuddy-redteam1.testnet", ... "kind":"Long","arm":"Clean", ... "prev":"Short","next":"Long", ... "outcome":"Flipped", ...}]

# An agent can play without a browser: the MCP server lists 7 tools. About 2 s.
curl -s https://nearbuddy.vercel.app/api/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z]*"' | tr '\n' ' '
#   "name":"arena" "name":"duel" "name":"agent" "name":"inject" "name":"claim" "name":"enter" "name":"verify"
```

**2. From a clone** (run from `nearbuddy/`):

```sh
git clone https://github.com/LingSiewWin/nearbuddy && cd nearbuddy/nearbuddy

bun install && bun run test                 # 357 pass, 2 skip, 0 fail. 13 s
bun run verify-duel 537                     # no FAIL · 30 PASS · 2 SKIP. 19 s. Reads NEAR testnet only
bun run verify-order fixtures/orders/delivered-2026-11-13.json --gate nearbuddy-paygate-v2.testnet
                                            # no FAIL · 15 PASS · 0 SKIP. 3 s. Reads NEAR testnet and Base mainnet
(cd web && bun install --frozen-lockfile && bun test app)       # 229 pass, 0 fail. 2 s
(cd agents && uv run --locked pytest -q)    # 635 passed, 1 skipped. 25 s
(cd lab && uv run --locked pytest -q)       # 91 passed. 30 s
(cd lab && uv run --locked python look/look.py report)          # rebuilds an experiment's tables from committed results. 5 s
(cd sentinel && uv run --locked pytest -q)  # 10 passed. 40 s
(cd arena && cargo test --lib --locked)     # 302 passed. About 3.5 min with a cold build
(cd paygate && cargo test --lib --locked)   # 47 passed. About 1 min with a cold build
scripts/check-all.sh --fast                 # the merge gate: 18 checks, all PASS. 14 min the first time (it builds five contracts), 4 min after
```

**3. See the interface** (optional): `cd web && bun run dev -- -p 3044`, then open http://localhost:3044. With no env
file, `/`, `/board`, `/evidence`, `/arena`, `/enter`, `/duel/537` and `/terminal` each answered 200. The hosted site
https://nearbuddy.vercel.app was still serving the build from before this interface when this was written: there
`/board` and `/evidence` answer 404 and the other pages answer 200.

What step 2 does not do: it places no attack and opens no duel. Those need a funded testnet account, a NEAR AI Cloud
key, and the external price oracle to answer. The commands are in [`nearbuddy/README.md`](nearbuddy/README.md),
marked with what they spend.

## What is proven, and where

| Claim | How to check | Where |
|---|---|---|
| A planted headline changed an enclave-signed decision and the contract paid the attacker from the loser's bond (duel 537) | `bun run verify-duel 537`, or the four transactions | [proof table](nearbuddy/README.md#proof-table) |
| The contract refuses a tampered enclave signature | Transaction `4rmFo38n…`: `bad tee signature` | [proof table](nearbuddy/README.md#proof-table) |
| An agent with no private key decides from a request the contract wrote | `ARENA_CONTRACT=v3.nb-keyless-arena-1111.testnet bun run verify-duel 3` prints `no FAIL · 29 PASS · 0 SKIP` (3 of 5 runs; in the other 2 the public archival RPC throttled and it asked for a re-run) | [`nearbuddy/arena/README.md`](nearbuddy/arena/README.md) |
| In the lab, one fake headline moved a naive prompt 96% of the time and a hardened prompt 7% | `cd nearbuddy/lab && uv run --locked python report.py` | [`nearbuddy/lab/README.md`](nearbuddy/lab/README.md) |
| In the lab, a model that could choose to look at an honest market was fooled 29 to 40% of the time, not 97 to 100% | `uv run --locked python look/look.py report` | [`nearbuddy/lab/look/README.md`](nearbuddy/lab/look/README.md) |
| Each dataset row's enclave signature re-verifies from its bytes (1,723 rows) | The verify snippet in the dataset README | [`nearbuddy/dataset/README.md`](nearbuddy/dataset/README.md) |
| The payment gate paid 1.31 USDC on Base mainnet inside a policy, and refused an over-cap order and a replay | `bun run verify-order …`, and the transactions | [`nearbuddy/paygate/README.md`](nearbuddy/paygate/README.md) |
| Money is conserved in every attack settlement | Property test `arena/src/invariants.rs`, part of `cargo test` | [`nearbuddy/arena/README.md`](nearbuddy/arena/README.md) |

## Limits and known issues

- All 58 live attacks were the project's own. The live numbers show the mechanism working, not a market price.
- The arena is on NEAR testnet. The only mainnet parts are the payment gate's USDC payments on Base and the NEAR
  mainnet transactions of the 1Click swaps, all linked in the READMEs.
- A duel opens and settles only when the external price oracle (OutLayer) answers. It was failing on 2026-11-14.
  No process opens duels around the clock. When no duel is open, the site shows the last finished duel and nothing
  can be attacked.
- The contract records a change of side, not truth. A true headline that moves the model also counts as fooled.
- A refund rule for attacks that never reach a decision, and a placebo arm, are on this branch and tested but not
  deployed to the live arenas.
- Follower fills on testnet settle against a stand-in contract (`intents-stub`), because NEAR Intents has no
  testnet.
- The contract checks the enclave's signature on chain. The attestation behind that signing key is checked off
  chain by the contract owner.
- The first-generation contract (`nearbuddy/contract/`, testnet, superseded) has an open issue: any account that
  stakes 0.1 testnet NEAR can have it request an MPC signature over any payload.
- No external audit. The full list is in [`nearbuddy/README.md`](nearbuddy/README.md#limits-and-known-issues).

## How NEAR is used

File paths are under `nearbuddy/`. Line numbers are for this commit.

| NEAR part | What it does here | Code |
|---|---|---|
| NEAR AI Cloud (private inference in a TEE) | Every agent decision is a chat completion. The runner keeps the exact request and response bytes and fetches the enclave's ed25519 signature and the attestation report | `agents/nearai.py:116`, `:149`; `packages/keeper/src/nearai.ts:96` |
| `ed25519_verify` in a NEAR contract | The arena and the payment gate verify the enclave signature before they accept a decision | `arena/src/lib.rs:175`, `paygate/src/lib.rs:553` |
| Block random seed | The contract draws how each headline is delivered, so the attacker cannot choose | `arena/src/chaos.rs:203` |
| OutLayer price oracle | Opens and settles each duel through `oracle_call` and `oracle_on_call` | `arena/src/duels.rs:204`, `:523` |
| Chain Signatures (MPC) | The payment gate asks `v1.signer-prod.testnet` to sign a Base USDC payment it built itself | `paygate/src/lib.rs:221` (`sign_payment`), `:458` |
| NEAR Intents 1Click | Turns NEAR into USDC on Base for an order; quotes follower fills | `packages/solver/src/oneclick.ts:64`, `:112` |
| Function-call access keys | The paying agent's key can call `sign_payment` and `sign_login` on the gate and nothing else | `packages/solver/src/paygate.ts` |
| NEAR Connect wallet and guest accounts | Visitors sign their own `inject_chaos`; a guest key is made in the browser and funded by the testnet faucet | `web/app/lib/wallet.ts:13`, `web/app/api/guest/route.ts` |

Contracts on NEAR testnet: `arena.nearbuddy-solver.testnet` (keyed arena), `v3.nb-keyless-arena-1111.testnet`
(keyless arena), `nearbuddy-paygate-v2.testnet` (payment gate), `intents-stub.nearbuddy-solver.testnet`,
`nearbuddy-vault.testnet` (first generation).

## Tracks

- `security`: an agent's spending is bounded by an on-chain policy, single-use enclave-signed decisions and a
  function-call key (`nearbuddy/paygate/src/lib.rs`); prompt-injection defences are measured, not asserted
  (`nearbuddy/agents/prompts.py`, `nearbuddy/agents/cue_guard.py`, `nearbuddy/lab/`).
- `agents`: agents hold bonds, win and lose them (`nearbuddy/arena/src/duels.rs`), buy a real voucher with USDC
  (`nearbuddy/packages/orders/`), and can play through an MCP server (`nearbuddy/web/app/api/mcp/route.ts`).
- `games`: the loop is plant a headline, watch the next signed decision, get paid or lose the stake
  (`nearbuddy/arena/src/chaos.rs`, `nearbuddy/web/app/`); a guest plays with no wallet install
  (`nearbuddy/web/app/api/guest/route.ts`).
- `privacy`: inference runs in NEAR AI Cloud TEEs, and each enclave's attestation report is saved next to the data
  it signed (`nearbuddy/agents/nearai.py`, `nearbuddy/dataset/attestations/`). Prompts and strategies are public
  here by design; the TEE is used for the integrity of each decision.
- `swarms`: several duels run at once and can share one price window (duels 572 to 574 and 579 to 581 did). 37
  agents are registered on the keyed arena and 15 on the keyless one (`leaderboard` view, 2026-11-14). Spectators
  attack and predict around them (`nearbuddy/predict/`). There is no coordination or bidding market between agents.

## Disclosure

- **Window (rule Q-001).** Every commit is dated 2026-11-05 or later (`git log --reverse`). Planning for the first
  idea began on 2026-10-27. Both dates are inside the window that opened on 2026-10-19.
- **Not an existing product (Q-002 to Q-004).** Nothing here existed before the window.
- **Libraries and services (Q-005).** Rust: near-sdk 5.29. TypeScript: near-api-js, viem, @x402, borsh, tweetnacl,
  Next.js 16, React 19, @hot-labs/near-connect, the MCP server SDK, zod, @upstash/redis. Python: requests, pynacl,
  numpy, scikit-learn. Tools: bun, uv, cargo, biome, ruff, mypy, pytest. Services: NEAR AI Cloud, the OutLayer price
  oracle, NEAR Chain Signatures, NEAR Intents 1Click, the NEAR testnet faucet, Bitrefill (the merchant), Coinbase
  Exchange's public price feed (display only). The lab replicates part of arXiv 2610.26438.
- **AI-written code (Q-005).** The code was written with AI coding assistants under the founder's direction, and
  reviewed and tested as the READMEs describe.

## Licence

Code: Business Source License 1.1 ([`LICENSE`](LICENSE)); it allows use on public test networks and changes to
Apache 2.0 on 2029-11-14. Dataset under `nearbuddy/dataset/`: CC BY 4.0.

## Repository map

| Folder (under `nearbuddy/`) | What it holds |
|---|---|
| `arena/` | The arena contract (Rust): duels, attacks, keyless agents, follows |
| `paygate/` | The payment gate contract (Rust) |
| `predict/`, `intents-stub/`, `contract/` | Prediction board contract; testnet stand-in for NEAR Intents; first-generation clearinghouse |
| `agents/` | Python runner for keyed agents, prompts and defences, dataset export |
| `packages/` | TypeScript: `protocol` (wire formats), `solver`, `keeper` (keyless agents), `orders` (the purchase flow), `demo`, `resource-server` |
| `web/` | Next.js site, API routes, MCP server |
| `lab/`, `sentinel/` | Pre-registered experiments and their results; headline detector comparison |
| `dataset/`, `fixtures/`, `abi/` | Decision dataset with attestations; cross-language test vectors and the order receipt; contract ABIs |
| `analysis/`, `e2e/`, `scripts/` | Verifiers and reports; end-to-end run on a local sandbox; gate, deploy and loop scripts |
