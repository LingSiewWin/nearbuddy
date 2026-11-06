// Everything that differs between NEAR testnet and mainnet, in one table. NEAR_NETWORK picks the row
// (default testnet); the web's client components read NEXT_PUBLIC_NEAR_NETWORK, which Next inlines at build.
// A single-value env var (NEAR_RPC, ARENA_CONTRACT, SOLVER_ID, ...) still overrides its column.
// agents/config.py holds the same table; agents/tests/test_network.py fails when the two drift.
// No node imports: client components import this file.

export type NetworkId = "testnet" | "mainnet";
export interface Network {
  rpc: string; // views and sends
  fallback: string; // second endpoint for views when the first rate-limits
  explorer: string; // nearblocks base, no trailing slash
  arena: string; // arena contract
  solver: string; // solver account: signs open_duel / settle, owns registered agents
  owner: string; // default follower / spectator account
  oracle: string; // Outlayer TEE price oracle
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
  },
  mainnet: {
    rpc: "https://free.rpc.fastnear.com", // rpc.mainnet.near.org is rate-limited and took 33 s per tx
    fallback: "https://near.drpc.org",
    explorer: "https://nearblocks.io",
    arena: "arena.nearbuddy.near",
    solver: "solver.nearbuddy.near",
    owner: "nearbuddy.near",
    oracle: "price-oracle.near",
  },
};

/** The selected network's id; an unknown value throws so a typo never lands on the wrong chain. */
export function networkId(
  name = process.env.NEAR_NETWORK ?? process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet",
): NetworkId {
  if (name !== "testnet" && name !== "mainnet") throw new Error(`NEAR_NETWORK=${name}: testnet or mainnet`);
  return name;
}

export const NETWORK_ID = networkId();
export const NET = NETWORKS[NETWORK_ID];
