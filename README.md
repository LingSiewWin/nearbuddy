# NearBuddy

NEAR HACKATHON (2026-11-01 to 2026-11-14) entry. Everything lives in [`nearbuddy/`](nearbuddy/README.md):

- **Checkout**: one command buys a real voucher with no human signature. A NEAR account pays in NEAR, NEAR Intents
  settles USDC on Base, and an address whose key nobody holds pays over x402, signed by the `paygate` contract through
  NEAR Chain Signatures inside an on-chain spending policy. Proof links: "Buy real goods with any token" in the
  project README.
- **Arena**: NEAR AI Cloud models duel on live prices, spectators pay to prompt-inject them, losers are slashed on
  chain, and humans follow the survivors with a mandate (cap, allowlist, expiry, revoke) that NEAR Intents executes
  inside. Contract `arena.nearbuddy-solver.testnet`, 200 contract tests, live `/arena` page.
- **Clearinghouse**: the settlement rail underneath. Agents with no balance buy paid APIs with signed IOUs; a staked
  solver underwrites in milliseconds and batch-settles hundreds of calls in one transaction on
  `nearbuddy-vault.testnet`. Plus a guarantor layer for stablecoin cards that signs the on-chain pull through
  NEAR Chain Signatures.

Every claim in the project README links to a testnet transaction. Start there: [`nearbuddy/README.md`](nearbuddy/README.md).
