import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assertNetworkConfig, NETWORKS, networkFile, networkId, OVERRIDES } from "./network.ts";

test("networkFile keeps testnet paths and suffixes every other network before the extension", () => {
  assert.equal(networkFile("/r/.solver-ledger.json", "testnet"), "/r/.solver-ledger.json");
  assert.equal(networkFile("/r/.solver-ledger.json", "mainnet"), "/r/.solver-ledger-mainnet.json");
  assert.equal(networkFile("/r/.arena-history.json", "mainnet"), "/r/.arena-history-mainnet.json");
  assert.equal(networkFile("/r/data/copier-v2.jsonl", "mainnet"), "/r/data/copier-v2-mainnet.jsonl");
  assert.equal(networkFile("/home/u/.nearbuddy/agents", "mainnet"), "/home/u/.nearbuddy/agents-mainnet");
  assert.equal(networkFile("/r.d/.env", "mainnet"), "/r.d/.env-mainnet");
});

test("the solver entry's state files follow NEAR_NETWORK; testnet keeps today's names", () => {
  const paths = (network: string) => {
    const env: Record<string, string | undefined> = { ...process.env, NEAR_NETWORK: network };
    for (const k of ["SOLVER_LEDGER", "ARENA_HISTORY", "ARENA_PAYLOADS", ...OVERRIDES]) delete env[k];
    const script = `import { LEDGER_FILE } from "./packages/solver/src/state.ts";
      console.log(JSON.stringify([LEDGER_FILE, process.env.ARENA_HISTORY, process.env.ARENA_PAYLOADS]))`;
    const cwd = new URL("../../..", import.meta.url).pathname;
    const p = spawnSync("bun", ["--no-env-file", "-e", script], { cwd, env });
    assert.equal(p.status, 0, p.stderr.toString());
    return (JSON.parse(p.stdout.toString()) as string[]).map((f) => f.split("/").pop());
  };
  assert.deepEqual(paths("testnet"), [".solver-ledger.json", ".arena-history.json", ".arena-payloads.json"]);
  assert.deepEqual(paths("mainnet"), [
    ".solver-ledger-mainnet.json",
    ".arena-history-mainnet.json",
    ".arena-payloads-mainnet.json",
  ]);
});

test("mainnet refuses any override that names testnet", () => {
  for (const [k, v] of [
    ["NEAR_RPC", "https://near-testnet.drpc.org"],
    ["NEAR_RPC_FALLBACK", "https://test.rpc.fastnear.com"],
    ["NEAR_SEND_RPC", "https://rpc.testnet.near.org"],
    ["ARENA_CONTRACT", "arena.nearbuddy-solver.testnet"],
    ["SOLVER_ID", "nearbuddy-solver.testnet"],
    ["ORACLE_ACCOUNT", "price-oracle.testnet"],
    ["COPIER_TX_API", "https://tx.test.fastnear.com/v0"],
  ] as const)
    assert.throws(() => assertNetworkConfig("mainnet", { [k]: v }), new RegExp(`NEAR_NETWORK=mainnet but ${k}=`));
  assertNetworkConfig("mainnet", { NEAR_RPC: "https://rpc.mainnet.near.org", SOLVER_ID: "contest.near" });
});

test("testnet refuses a .near account or a mainnet RPC override", () => {
  for (const [k, v] of [
    ["ARENA_CONTRACT", "arena.nearbuddy.near"],
    ["SOLVER_ID", "solver.nearbuddy.near"],
    ["FOLLOWER_ID", "nearbuddy.near"],
    ["NEAR_RPC", "https://free.rpc.fastnear.com"],
    ["NEAR_RPC_FALLBACK", "https://near.drpc.org"],
    ["NEAR_SEND_RPC", "https://rpc.mainnet.near.org"],
  ] as const)
    assert.throws(() => assertNetworkConfig("testnet", { [k]: v }), new RegExp(`NEAR_NETWORK=testnet but ${k}=`));
  // the testnet row itself and the mainnet-only 1Click account pass
  assertNetworkConfig("testnet", {
    NEAR_RPC: NETWORKS.testnet.rpc,
    NEAR_SEND_RPC: NETWORKS.testnet.fallback,
    ARENA_CONTRACT: NETWORKS.testnet.arena,
    ONECLICK_ACCOUNT: "siewwin.near",
  });
});

test("mainnet row: fastnear first, drpc fallback, nearblocks.io, .near accounts", () => {
  assert.deepEqual(NETWORKS.mainnet, {
    rpc: "https://free.rpc.fastnear.com",
    fallback: "https://near.drpc.org",
    explorer: "https://nearblocks.io",
    arena: "arena.nearbuddy.near",
    solver: "solver.nearbuddy.near",
    owner: "nearbuddy.near",
    oracle: "price-oracle.near",
  });
});

test("every testnet value names testnet, no mainnet value does", () => {
  for (const v of Object.values(NETWORKS.testnet)) assert.match(v, /test/);
  for (const v of Object.values(NETWORKS.mainnet)) assert.doesNotMatch(v, /test/);
});

test("networkId defaults to testnet and refuses anything but testnet or mainnet", () => {
  const saved = {
    NEAR_NETWORK: process.env.NEAR_NETWORK,
    NEXT_PUBLIC_NEAR_NETWORK: process.env.NEXT_PUBLIC_NEAR_NETWORK,
  };
  delete process.env.NEAR_NETWORK;
  delete process.env.NEXT_PUBLIC_NEAR_NETWORK;
  try {
    assert.equal(networkId(), "testnet");
    process.env.NEXT_PUBLIC_NEAR_NETWORK = "mainnet";
    assert.equal(networkId(), "mainnet");
    process.env.NEAR_NETWORK = "testnet"; // the server-side name wins over the client one
    assert.equal(networkId(), "testnet");
    assert.throws(() => networkId("Mainnet"), /NEAR_NETWORK=Mainnet: testnet or mainnet/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
