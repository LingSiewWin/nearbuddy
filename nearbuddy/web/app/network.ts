// Everything that differs between NEAR testnet and mainnet, in one table. NEAR_NETWORK picks the row
// (default testnet); the web's client components read NEXT_PUBLIC_NEAR_NETWORK, which web/next.config.ts derives
// from NEAR_NETWORK and Next inlines at build. A single-value env var (NEAR_RPC, ARENA_CONTRACT, SOLVER_ID, ...)
// still overrides its column. Copies: web/app/network.ts is this file byte for byte (Vercel builds web/ alone),
// agents/config.py holds the same table; web/app/__tests__/network.test.ts and agents/tests/test_network.py fail
// when either drifts. No imports: client components load the web copy.

export type NetworkId = "testnet" | "mainnet";
export interface Network {
  rpc: string; // views and sends
  fallback: string; // second endpoint for views when the first rate-limits
  explorer: string; // nearblocks base, no trailing slash
  arena: string; // arena contract
  solver: string; // solver account: signs open_duel / settle, owns registered agents
  owner: string; // default follower / spectator account
  oracle: string; // Outlayer TEE price oracle
  txApi: string; // FastNEAR tx API (POST /account, POST /transactions)
}

export const NETWORKS: Record<NetworkId, Network> = {
  testnet: {
    rpc: "https://near-testnet.drpc.org", // rpc.testnet.near.org is deprecated (429)
    fallback: "https://test.rpc.fastnear.com",
    explorer: "https://testnet.nearblocks.io",
    arena: "arena.nearbuddy-solver.testnet",
    solver: "nearbuddy-solver.testnet",
    owner: "nearbuddy-owner.testnet",
    oracle: "price-oracle.testnet",
    txApi: "https://tx.test.fastnear.com/v0",
  },
  mainnet: {
    rpc: "https://free.rpc.fastnear.com", // rpc.mainnet.near.org is rate-limited and took 33 s per tx
    fallback: "https://near.drpc.org",
    explorer: "https://nearblocks.io",
    arena: "arena.nearbuddy.near",
    solver: "solver.nearbuddy.near",
    owner: "nearbuddy.near",
    oracle: "price-oracle.near",
    txApi: "https://tx.main.fastnear.com/v0",
  },
};

/** The selected network's id; an unknown value throws so a typo never lands on the wrong chain. */
export function networkId(
  name = process.env.NEAR_NETWORK ?? process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet",
): NetworkId {
  if (name !== "testnet" && name !== "mainnet") throw new Error(`NEAR_NETWORK=${name}: testnet or mainnet`);
  return name;
}

/** Single-value overrides that must belong to the selected network. ONECLICK_ACCOUNT and NEAR_MAINNET_RPC are
 *  absent on purpose: 1Click is mainnet-only on every network. */
export const OVERRIDES = [
  "NEAR_RPC",
  "NEAR_RPC_FALLBACK",
  "NEAR_SEND_RPC",
  "ARENA_CONTRACT",
  "SOLVER_ID",
  "ORACLE_ACCOUNT",
  "FOLLOWER_ID",
  "SPECTATOR_ID",
  "JOIN_ACCOUNT",
  "COPIER_RPC",
  "COPIER_TX_API",
  "FASTNEAR_TX_API",
] as const;
// What the other network's values look like: on mainnet any testnet name or test.* host; on testnet a .near
// account or a mainnet RPC host.
const FOREIGN: Record<NetworkId, RegExp> = {
  mainnet: /testnet|(^|[/.])test\./,
  testnet: /\.near$|mainnet|\/\/(free\.)?rpc\.fastnear\.com|\/\/near\.drpc\.org|\/\/tx\.main\./,
};

/** Throws when an override names the other network: a mainnet run with a leftover testnet RPC or account (or the
 *  reverse) stops at startup instead of signing or reading on the wrong chain. */
export function assertNetworkConfig(id: NetworkId, env: Record<string, string | undefined> = process.env): void {
  const bad = OVERRIDES.filter((k) => env[k] && FOREIGN[id].test(env[k]));
  if (bad.length)
    throw new Error(
      `NEAR_NETWORK=${id} but ${bad.map((k) => `${k}=${env[k]}`).join(", ")} belongs to the other network: fix or unset`,
    );
}

/** Persisted state per network: testnet keeps `path` as is (nothing moves), any other network gets `-<network>`
 *  before the extension (`.solver-ledger.json` -> `.solver-ledger-mainnet.json`, `attestations` -> `attestations-mainnet`). */
export function networkFile(path: string, id: NetworkId = NETWORK_ID): string {
  if (id === "testnet") return path;
  const base = path.lastIndexOf("/") + 1;
  const dot = path.lastIndexOf(".");
  const cut = dot > base ? dot : path.length; // a leading dot (".env") is part of the name, not an extension
  return `${path.slice(0, cut)}-${id}${path.slice(cut)}`;
}

export const NETWORK_ID = networkId();
export const NET = NETWORKS[NETWORK_ID];
assertNetworkConfig(NETWORK_ID);
