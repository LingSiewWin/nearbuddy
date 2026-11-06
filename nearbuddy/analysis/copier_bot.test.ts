import assert from "node:assert/strict";
import { test } from "node:test";
import { stats } from "./copier_bot.ts";

test("per-duel interval counts duels, not intents", () => {
  // xs 1 2 3 4: mean 2.5, sd sqrt(5/3) = 1.29099. Per intent: 1.96 * sd / 2 = 1.26517 -> [1.23483, 3.76517].
  // Two duels: 1.96 * sd / sqrt(2) = 1.78923 -> [0.71077, 4.28923].
  const s = stats([1, 2, 3, 4], ["7", "7", "8", "8"]);
  assert.equal(s.n, 4);
  assert.equal(s.m, 2);
  assert.equal(s.mean, 2.5);
  assert.equal(s.hit, 1);
  assert.equal(s.lo.toFixed(4), "1.2348");
  assert.equal(s.hiDuel.toFixed(4), "4.2892");
  assert.equal(s.loDuel.toFixed(4), "0.7108");
  // one intent per duel: the two intervals agree
  const t = stats([1, 2, 3, 4], ["1", "2", "3", "4"]);
  assert.equal(t.loDuel, t.lo);
});

test("empty input", () => {
  const s = stats([], []);
  assert.equal(s.n, 0);
  assert.ok(Number.isNaN(s.loDuel));
});
