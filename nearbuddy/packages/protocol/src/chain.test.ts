import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KeyPair } from "near-api-js";
import { ARENA, explorerTx, fmtNear, loadAccount, loadKey } from "./chain.ts";
import { NETWORK_ID, NETWORKS } from "./network.ts";

// No keychain here: a successful load proves the env key was used and the file never read.
const emptyHome = mkdtempSync(join(tmpdir(), "chain-test-home-"));

test("loadAccount takes the key from NEAR_KEY_<ACCOUNT> with '.' and '-' mapped to '_'", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const realHome = process.env.HOME;
  process.env.HOME = emptyHome;
  process.env.NEAR_KEY_SOME_SOLVER_TESTNET = kp.toString();
  try {
    const acct = loadAccount("some-solver.testnet");
    assert.equal(acct.accountId, "some-solver.testnet");
    assert.equal((await acct.getSigner()!.getPublicKey()).toString(), kp.getPublicKey().toString());
  } finally {
    process.env.HOME = realHome;
    delete process.env.NEAR_KEY_SOME_SOLVER_TESTNET;
  }
});

test("loadAccount without an env key falls back to the legacy keychain file and fails when it is missing", () => {
  const realHome = process.env.HOME;
  process.env.HOME = emptyHome;
  try {
    assert.throws(() => loadAccount("nobody.testnet"), /ENOENT.*nobody\.testnet\.json/);
  } finally {
    process.env.HOME = realHome;
  }
});

test("loadKey reads ~/.near-credentials/<network>/, so a mainnet id never picks up a testnet key", () => {
  const home = mkdtempSync(join(tmpdir(), "chain-test-keys-"));
  const kp = { testnet: KeyPair.fromRandom("ed25519"), mainnet: KeyPair.fromRandom("ed25519") };
  for (const net of ["testnet", "mainnet"] as const) {
    mkdirSync(join(home, ".near-credentials", net), { recursive: true });
    writeFileSync(
      join(home, ".near-credentials", net, "who.json"),
      JSON.stringify({ private_key: kp[net].toString() }),
    );
  }
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(loadKey("who", "testnet"), kp.testnet.toString());
    assert.equal(loadKey("who", "mainnet"), kp.mainnet.toString());
    assert.equal(loadKey("who"), kp[NETWORK_ID].toString()); // default follows NEAR_NETWORK
    assert.throws(() => loadKey("only.near", "mainnet"), /ENOENT.*mainnet\/only\.near\.json/);
  } finally {
    process.env.HOME = realHome;
  }
});

test("explorerTx and the arena default come from the selected network row", () => {
  assert.equal(explorerTx("H"), `${NETWORKS[NETWORK_ID].explorer}/txns/H`);
  if (!process.env.ARENA_CONTRACT) assert.equal(ARENA, NETWORKS[NETWORK_ID].arena);
});

test("fmtNear renders yocto with fixed digits", () => {
  assert.equal(fmtNear(10n ** 24n), "1.00000");
  assert.equal(fmtNear("1500000000000000000000000", 2), "1.50");
  assert.equal(fmtNear(1n), "0.00000");
});
