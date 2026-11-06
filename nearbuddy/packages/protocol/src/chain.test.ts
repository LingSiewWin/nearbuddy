import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KeyPair } from "near-api-js";
import { fmtNear, loadAccount } from "./chain.ts";

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

test("fmtNear renders yocto with fixed digits", () => {
  assert.equal(fmtNear(10n ** 24n), "1.00000");
  assert.equal(fmtNear("1500000000000000000000000", 2), "1.50");
  assert.equal(fmtNear(1n), "0.00000");
});
