// classify() on the account shapes seen on testnet: house names and sub-accounts, accounts a house key created, faucet
// guests (the project's own ones listed), strangers, and accounts whose creation the indexer does not show.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, type Origin } from "./attackers.ts";

const made = (signer: string, receiver: string): Origin => ({
  signer,
  receiver,
  actions: ["CreateAccount", "Transfer", "AddKey"],
});

test("house: project names, their sub-accounts, and accounts a project key created", () => {
  assert.equal(classify("nearbuddy-redteam1.testnet", null), "house");
  assert.equal(classify("wire.nb-pred-a-1111.testnet", null), "house");
  assert.equal(classify("v2.nb-keyless-arena-1111.testnet", null), "house");
  assert.equal(classify("helper-x.testnet", made("nearbuddy-solver.testnet", "helper-x.testnet")), "house");
});

test("guest: a faucet-made nb-guest account, unless the project listed it as its own", () => {
  assert.equal(classify("nb-guest-3vuvux3r6q.testnet", made("testnet", "nb-guest-3vuvux3r6q.testnet")), "guest");
  assert.equal(classify("nb-guest-ut778rx9rp.testnet", made("testnet", "nb-guest-ut778rx9rp.testnet")), "house");
});

test("outside: created by a stranger, or by the faucet under a non-guest name", () => {
  assert.equal(classify("alice.testnet", made("testnet", "alice.testnet")), "outside");
  assert.equal(classify("bob.alice.testnet", made("alice.testnet", "bob.alice.testnet")), "outside");
  // a project run's faucet account looks like a stranger's until it is listed
  assert.equal(classify("nb-battle-9d5b.testnet", made("testnet", "nb-battle-9d5b.testnet"), [], []), "outside");
  assert.equal(classify("nb-battle-9d5b.testnet", made("testnet", "nb-battle-9d5b.testnet")), "house");
});

test("unknown: no creating transaction, or one that did not create this account", () => {
  assert.equal(classify("old.testnet", null), "unknown");
  assert.equal(classify("x.testnet", made("alice.testnet", "y.testnet")), "unknown");
  assert.equal(
    classify("x.testnet", { signer: "alice.testnet", receiver: "x.testnet", actions: ["Transfer"] }),
    "unknown",
  );
});
