import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Quote } from "./oneclick.ts";
import { batchQuote, bpsVsOracle, duelMid, executionRecords, proRata } from "./rfq.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/oneclick-quote.json", import.meta.url), "utf8")) as Quote;
const withOut = (amountOut: string): Quote => ({ ...fixture, quote: { ...fixture.quote, amountOut } });

test("proRata: floors, remainder to the largest, sums to exactly out", () => {
  assert.deepEqual(proRata([1n, 1n, 1n], 10n), [4n, 3n, 3n]); // tie: first largest takes the remainder
  assert.deepEqual(proRata([1n, 5n, 2n], 7n), [0n, 6n, 1n]); // floors 0, 4, 1; remainder 2 to the largest
  assert.deepEqual(proRata([0n, 0n], 9n), [0n, 0n]);
});

test("proRata never over-allocates (randomised)", () => {
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let i = 0; i < 500; i++) {
    const amounts = Array.from({ length: 1 + rnd(8) }, () => BigInt(rnd(1_000_000)));
    const out = BigInt(rnd(10_000_000));
    const parts = proRata(amounts, out);
    const total = amounts.reduce((s, a) => s + a, 0n);
    if (total === 0n) continue;
    assert.equal(
      parts.reduce((s, p) => s + p, 0n),
      out,
    );
    for (let j = 0; j < parts.length; j++) {
      const exact = (out * amounts[j]!) / total;
      assert.ok(parts[j]! >= exact && parts[j]! - exact < BigInt(amounts.length), "share within rounding of exact");
    }
  }
});

test("batchQuote: one quote for the sum, pro rata shares, uniform price, quote timestamp and deadline", async () => {
  const asked: bigint[] = [];
  const b = await batchQuote(
    [
      { follower: "a", amount: 100n },
      { follower: "b", amount: 300n },
      { follower: "c", amount: 600n },
    ],
    async (amount) => {
      asked.push(amount);
      return withOut("1000003");
    },
  );
  assert.deepEqual(asked, [1000n]);
  assert.equal(b.amount_in_total, "1000");
  assert.equal(b.quote_out_total, "1000003");
  assert.deepEqual(
    b.fills.map((f) => f.quote_out),
    ["100000", "300000", "600003"],
  );
  assert.equal(b.price, 3.744739); // fixture: 3.744739 USDC for 1.0 wNEAR
  assert.equal(b.timestamp, fixture.timestamp);
  assert.equal(b.deadline, fixture.quoteRequest.deadline);
  // uniform price: every share is out/in of the batch within one base unit per follower
  for (const f of b.fills) {
    const exact = (1000003n * BigInt(f.amount)) / 1000n;
    assert.ok(BigInt(f.quote_out!) - exact < 3n);
  }
});

test("batchQuote: a single follower gets the whole quote", async () => {
  const b = await batchQuote([{ follower: "solo", amount: 42n }], async () => fixture);
  assert.deepEqual(b.fills, [{ follower: "solo", amount: "42", quote_out: fixture.quote.amountOut }]);
});

test("batchQuote: zero total asks nobody and fills nobody", async () => {
  let called = false;
  const b = await batchQuote([{ follower: "a", amount: 0n }], async () => {
    called = true;
    return fixture;
  });
  assert.equal(called, false);
  assert.equal(b.quote_out_total, "0");
  assert.ok(b.fills[0]?.error);
  assert.equal(b.fills[0]?.quote_out, undefined);
  assert.deepEqual((await batchQuote([], async () => fixture)).fills, []);
});

test("batchQuote: a quote failure errors every follower, nothing partial", async () => {
  const b = await batchQuote(
    [
      { follower: "a", amount: 1n },
      { follower: "b", amount: 2n },
    ],
    async () => {
      throw new Error("1click quote 503");
    },
  );
  assert.equal(b.quote, undefined);
  assert.deepEqual(
    b.fills.map((f) => [f.follower, f.quote_out, f.error]),
    [
      ["a", undefined, "Error: 1click quote 503"],
      ["b", undefined, "Error: 1click quote 503"],
    ],
  );
});

test("batchQuote refuses a negative amount", async () => {
  await assert.rejects(
    batchQuote([{ follower: "a", amount: -1n }], async () => fixture),
    /negative/,
  );
});

test("bpsVsOracle: positive when the follower gets more USDC than the mid gives", () => {
  const NEAR = 10n ** 24n;
  assert.equal(bpsVsOracle(NEAR, 3_800_000n, 380_000_000n), 0);
  assert.equal(bpsVsOracle(NEAR, 3_838_000n, 380_000_000n), 100);
  assert.equal(bpsVsOracle(NEAR, 3_744_739n, 380_000_000n), -145.42);
  assert.equal(bpsVsOracle(NEAR / 10n, 374_474n, 380_000_000n), -145.42); // size-independent
  assert.equal(bpsVsOracle(0n, 1n, 380_000_000n), null);
});

test("duelMid: close beats open, only a NEAR/USD duel counts", () => {
  assert.deepEqual(duelMid({ symbol: "wrap.near", open_price: "380000000", outcome: { close_price: "390000000" } }), {
    mid: "390000000",
    source: "outlayer_close",
  });
  assert.deepEqual(duelMid({ symbol: "wrap.near", open_price: "380000000", outcome: null }), {
    mid: "380000000",
    source: "outlayer_open",
  });
  assert.equal(duelMid({ symbol: "wrap.near", open_price: null, outcome: null }), null);
  assert.equal(duelMid({ symbol: "eth", open_price: "300000000000", outcome: null }), null);
  assert.equal(duelMid(null), null);
});

test("executionRecords: one row per quoted follower, errors skipped, no rows at all without a mid", () => {
  const intent = { agent_pk: "PK", duel_id: "3", nonce: "9" };
  const quotes = [
    { follower: "a", amount: "1000000000000000000000000", quote: fixture, quote_out: "3744739" },
    { follower: "b", amount: "5", error: "1click quote 503" },
    { follower: "c", amount: "0", quote: fixture, quote_out: "0" }, // no price: bps undefined, skipped
  ];
  assert.deepEqual(executionRecords(intent, quotes, null), []);
  const spot = executionRecords(intent, quotes, { mid: "369750000", source: "coinbase_spot" });
  assert.equal(spot.length, 1);
  assert.equal(spot[0]?.oracle_source, "coinbase_spot");
  assert.equal(spot[0]?.bps_vs_oracle, 127.76);
  assert.equal(spot[0]?.quoted_at, Date.parse(fixture.timestamp));
});
