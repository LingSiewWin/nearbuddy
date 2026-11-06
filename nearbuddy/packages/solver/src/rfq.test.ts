import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Quote } from "./oneclick.ts";
import {
  admit,
  batchQuote,
  bpsVsOracle,
  capsFromEnv,
  duelMid,
  executionRecords,
  proRata,
  quotePrice,
  variableLeg,
} from "./rfq.ts";

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
  const intent = { agent_pk: "PK", duel_id: "3", nonce: "9", side: "Short" as const };
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
  assert.equal(spot[0]?.side, "Short");
});

// A Long buys exactly 1 wNEAR (EXACT_OUTPUT); the USDC leg is amountIn. Live dry quote shape, 2026-11-06.
const longFixture: Quote = {
  ...fixture,
  quoteRequest: { ...fixture.quoteRequest, swapType: "EXACT_OUTPUT" },
  quote: {
    ...fixture.quote,
    amountIn: "3759616",
    amountInFormatted: "3.759616",
    amountOut: "1000000000000000000000000",
    amountOutFormatted: "1.0",
  },
};

test("Long: the batch splits the USDC paid (amountIn), price is USDC per NEAR, bps positive = paid less", async () => {
  assert.equal(variableLeg(longFixture), "amountIn");
  assert.equal(variableLeg(fixture), "amountOut");
  assert.equal(quotePrice(longFixture), 3.759616);
  const b = await batchQuote(
    [
      { follower: "a", amount: 3n },
      { follower: "b", amount: 1n },
    ],
    async () => longFixture,
  );
  assert.equal(b.quote_out_total, "3759616");
  assert.deepEqual(
    b.fills.map((f) => f.quote_out),
    ["2819712", "939904"],
  );
  const NEAR = "1000000000000000000000000";
  const rows = (mid: string) =>
    executionRecords(
      { agent_pk: "PK", duel_id: "3", nonce: "9", side: "Long" },
      [{ follower: "a", amount: NEAR, quote: longFixture, quote_out: "3759616" }],
      { mid, source: "outlayer_open" },
    );
  assert.equal(rows("370000000")[0]?.bps_vs_oracle, -161.12); // paid 3.759616 for a 3.70 mid: worse
  assert.equal(rows("380000000")[0]?.bps_vs_oracle, 106.27); // paid 3.759616 for a 3.80 mid: better
  assert.equal(rows("375961600")[0]?.bps_vs_oracle, 0); // exactly the mid: 0, not -0
  assert.ok(Object.is(rows("375961600")[0]?.bps_vs_oracle, 0));
});

test("capsFromEnv: unset or empty = unlimited, a non-integer throws", () => {
  assert.deepEqual(capsFromEnv({}), { fill: null, tick: null, day: null });
  assert.deepEqual(capsFromEnv({ CAP_PER_FILL_YOCTO: "5", CAP_PER_TICK_YOCTO: " ", CAP_PER_DAY_YOCTO: "0" }), {
    fill: 5n,
    tick: null,
    day: 0n,
  });
  assert.throws(() => capsFromEnv({ CAP_PER_DAY_YOCTO: "1e24" }), /CAP_PER_DAY_YOCTO must be a yocto integer/);
  assert.throws(() => capsFromEnv({ CAP_PER_TICK_YOCTO: "-1" }), /CAP_PER_TICK_YOCTO/);
});

test("admit: per-fill, per-tick and per-day caps in list order; a smaller later follower still fits", () => {
  const fs = [
    { follower: "a", amount: 40n },
    { follower: "big", amount: 70n },
    { follower: "b", amount: 30n },
    { follower: "c", amount: 20n },
  ];
  const none = { fill: null, tick: null, day: null };
  assert.equal(admit(fs, none, 10n ** 30n).rejected.length, 0);
  const fill = admit(fs, { ...none, fill: 50n }, 0n);
  assert.deepEqual(
    fill.admitted.map((f) => f.follower),
    ["a", "b", "c"],
  );
  assert.deepEqual(fill.rejected, [{ follower: "big", amount: "70", error: "over CAP_PER_FILL_YOCTO: 70 > 50" }]);
  const tick = admit(fs, { ...none, tick: 60n }, 0n); // a 40; big over; b 30 over (70); c 20 fits (60)
  assert.deepEqual(
    tick.admitted.map((f) => f.follower),
    ["a", "c"],
  );
  assert.match(tick.rejected[1]!.error, /^over CAP_PER_TICK_YOCTO: 40 quoted this tick \+ 30 > 60$/);
  const day = admit(fs, { ...none, day: 100n }, 50n); // 50 used: a 40 fits (90); the rest do not
  assert.deepEqual(
    day.admitted.map((f) => f.follower),
    ["a"],
  );
  assert.match(day.rejected[0]!.error, /^over CAP_PER_DAY_YOCTO: 90 quoted in 24 h \+ 70 > 100$/);
  assert.equal(admit(fs, { ...none, day: 0n }, 0n).admitted.length, 0); // 0 = stop quoting
});
