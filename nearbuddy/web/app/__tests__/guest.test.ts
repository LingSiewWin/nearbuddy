// Guest accounts: a throwaway testnet account whose key is made and kept in the browser. These tests cover the name
// rule both sides share, what the route accepts, the per-address limit, and the browser-side record.
import { expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { allow, checkGuest } from "../api/guest";
import { forget, GUEST_NAME, newGuestName, recall, remember } from "../lib/guest";

test("a new guest name is a testnet account in the guest pattern, and two are different", () => {
  const a = newGuestName();
  expect(a).toMatch(GUEST_NAME);
  expect(a).toMatch(/^nb-guest-[a-z0-9]{10}\.testnet$/);
  expect(newGuestName()).not.toBe(a);
});

test("the route accepts a guest name with an ed25519 public key and nothing else", () => {
  const publicKey = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const accountId = newGuestName();
  expect(checkGuest({ accountId, publicKey })).toEqual({ accountId, publicKey });
  expect(checkGuest({ accountId: "illia.testnet", publicKey })).toBeNull(); // not a name it may claim for a stranger
  expect(checkGuest({ accountId: "nb-guest-abcdefghij.near", publicKey })).toBeNull();
  expect(checkGuest({ accountId, publicKey: "secp256k1:abc" })).toBeNull();
  expect(checkGuest({ accountId, publicKey: `${publicKey}!` })).toBeNull();
  expect(checkGuest({ accountId })).toBeNull();
  expect(checkGuest(null)).toBeNull();
});

test("an address gets 3 accounts an hour and the site 60, counted through the injected counter", async () => {
  const counts = new Map<string, number>();
  const bump = async (key: string) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts.get(key) as number;
  };
  expect([await allow("1.1.1.1", bump), await allow("1.1.1.1", bump), await allow("1.1.1.1", bump)]).toEqual([
    true,
    true,
    true,
  ]);
  expect(await allow("1.1.1.1", bump)).toBe(false);
  expect(await allow("2.2.2.2", bump)).toBe(true); // another address is not held back by the first
  counts.set("nb:guest:all", 60);
  expect(await allow("3.3.3.3", bump)).toBe(false);
});

test("the browser remembers one guest, returns it, and forgets it", () => {
  const box = new Map<string, string>();
  const storage = {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => void box.set(k, v),
    removeItem: (k: string) => void box.delete(k),
  };
  expect(recall(storage)).toBeNull();
  remember({ accountId: "nb-guest-abcdefghij.testnet", privateKey: "ed25519:secret" }, storage);
  expect(recall(storage)).toEqual({ accountId: "nb-guest-abcdefghij.testnet", privateKey: "ed25519:secret" });
  forget(storage);
  expect(recall(storage)).toBeNull();
});

test("a damaged record, or one that is not a guest account, is no guest", () => {
  const storage = { getItem: () => "{not json", setItem: () => {}, removeItem: () => {} };
  expect(recall(storage)).toBeNull();
  const other = { ...storage, getItem: () => JSON.stringify({ accountId: "illia.testnet", privateKey: "ed25519:x" }) };
  expect(recall(other)).toBeNull();
});
