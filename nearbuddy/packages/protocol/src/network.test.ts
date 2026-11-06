import assert from "node:assert/strict";
import { test } from "node:test";
import { NETWORKS, networkId } from "./network.ts";

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
