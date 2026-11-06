import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgents, pickDuel } from "./pick-duel.ts";

// duel id -> sides; pair 1 = P1a/P1b, pair 2 = P2a/P2b, both loops interleaving on one arena
const DUELS: Record<string, { a: string; b: string }> = {
  "40": { a: "P1a", b: "P1b" },
  "41": { a: "P2a", b: "P2b" },
  "42": { a: "P1a", b: "P1b" },
  "43": { a: "P2a", b: "P2b" },
};
const seen: string[] = [];
const get = async (id: string) => {
  seen.push(id);
  return DUELS[id] ?? null;
};

test("no filter: the newest duel, whoever plays it (unchanged default)", async () => {
  assert.deepEqual(await pickDuel(44, parseAgents(undefined), get), ["43", DUELS["43"]]);
  assert.deepEqual(await pickDuel(44, parseAgents(""), get), ["43", DUELS["43"]]);
});

test("filter: the newest duel with a listed agent on either side", async () => {
  assert.deepEqual(await pickDuel(44, parseAgents("P1a,P1b"), get), ["42", DUELS["42"]]);
  assert.deepEqual(await pickDuel(44, parseAgents(" P2b "), get), ["43", DUELS["43"]]);
  assert.deepEqual(await pickDuel(43, parseAgents("P2a"), get), ["41", DUELS["41"]]);
});

test("filter with no match inside the scan window: nothing to attack", async () => {
  seen.length = 0;
  assert.deepEqual(await pickDuel(44, parseAgents("P3a"), get, 3), ["", null]);
  assert.deepEqual(seen, ["43", "42", "41"]);
  assert.deepEqual(await pickDuel(1, parseAgents("P3a"), get), ["", null]); // never below duel 0
});
