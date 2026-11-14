import assert from "node:assert/strict";
import { test } from "node:test";
import { Assigner, checkCorpus, type Headline, parseRunnerLog, type Sealed, wilson } from "./battle.ts";

const corpus: Headline[] = ["a", "b"].flatMap((f) => [
  { id: `${f}1`, family: f, side: "Long" as const, text: `${f} long one` },
  { id: `${f}2`, family: f, side: "Long" as const, text: `${f} long two` },
  { id: `${f}3`, family: f, side: "Short" as const, text: `${f} short` },
]);

test("assigner: every family once per round per cell, same order for the same seed", () => {
  const run = () => {
    const a = new Assigner(corpus, 7);
    return [a.next("m|naive", "Long"), a.next("m|naive", "Short"), a.next("m|naive", "Long")].map((h) => h.id);
  };
  const ids = run();
  assert.deepEqual(ids, run());
  assert.equal(new Set(ids.slice(0, 2).map((i) => i[0])).size, 2);
  assert.equal(ids[1]?.endsWith("3"), true);
});

test("assigner: headlines of one family and side alternate", () => {
  const a = new Assigner(corpus, 1);
  const longs = Array.from({ length: 4 }, () => a.next("x", "Long").id);
  assert.deepEqual(
    longs.filter((i) => i.startsWith("a")),
    ["a1", "a2"],
  );
});

test("checkCorpus refuses what inject_chaos would refuse", () => {
  assert.throws(() => checkCorpus([{ id: "x", family: "a", side: "Long", text: "y".repeat(281) }]), /281 bytes/);
  assert.throws(() => checkCorpus([{ id: "x", family: "a", side: "Long", text: "tab\there" }]), /ASCII/);
  assert.throws(() => checkCorpus([{ id: "x", family: "a", side: "Long", text: "   " }]));
});

test("parseRunnerLog maps commits to the duel and the agent's key prefix", () => {
  const sealed: Sealed = new Map();
  const log = [
    "pair main: A AAAAAAAA m/a, B BBBBBBBB m/b",
    "[round 0] duel 5 NEAR/USD oracle open 3.6 tx x A prompt hardened-v3",
    "  A committed Long nonce 1 tx t1",
    "  B committed Short nonce 2 tx t2",
    "[round 1] duel 6 NEAR/USD oracle open 3.6 tx x A prompt hardened-v3",
    "  B committed Long nonce 3 tx t3",
    "  B committed Short nonce 4 tx t4",
  ].join("\n");
  const labels = parseRunnerLog(log, { A: "hardened-v3", B: "naive" }, sealed);
  assert.deepEqual(labels.B, { pk8: "BBBBBBBB", model: "m/b", prompt: "naive" });
  assert.equal(sealed.get("5|AAAAAAAA"), "Long");
  assert.equal(sealed.get("6|BBBBBBBB"), "Short");
  assert.equal(sealed.has("6|AAAAAAAA"), false);
});

test("wilson interval", () => {
  const [lo, hi] = wilson(5, 10);
  assert.ok(Math.abs(lo - 0.2366) < 1e-3);
  assert.ok(Math.abs(hi - 0.7634) < 1e-3);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});
