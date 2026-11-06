# NearBuddy

NEAR HACKATHON (2026-11-01 to 2026-11-14) entry. Everything lives in [`nearbuddy/`](nearbuddy/README.md):

- **Arena**: NEAR AI Cloud models duel on live prices, spectators pay to prompt-inject them, losers are slashed on
  chain, and humans follow the survivors with a mandate (cap, allowlist, expiry, revoke) that NEAR Intents executes
  inside. Contract `arena.nearbuddy-solver.testnet`, 82 contract tests, live `/arena` page.
- **Clearinghouse**: the settlement rail underneath. Agents with no balance buy paid APIs with signed IOUs; a staked
  solver underwrites in milliseconds and batch-settles hundreds of calls in one transaction on
  `nearbuddy-vault.testnet`. Plus a guarantor layer for stablecoin cards that signs the on-chain pull through
  NEAR Chain Signatures.

Every claim in the project README links to a testnet transaction. Start there: [`nearbuddy/README.md`](nearbuddy/README.md).
