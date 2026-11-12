// A finished match's replay line from Coinbase Exchange one-minute candles. The fixture is a real response of
// GET /products/NEAR-USD/candles?granularity=60 (rows: time in s, low, high, open, close, volume; newest first).
import { expect, test } from "bun:test";
import { samplesOf, settled } from "../lib/replay";
import candles from "./fixtures/coinbase_candles.json";

const from = 1794299280_000;
const to = 1794299639_000; // six whole candles: 280, 340, 400, 460, 520, 580

test("two samples per candle inside the window, oldest first: its open, then its close 59 s later", () => {
  const s = samplesOf(candles, from, to);
  expect(s.length).toBe(12);
  expect(s[0]).toEqual({ t: 1794299280_000, p: 3.6042 });
  expect(s[1]).toEqual({ t: 1794299339_000, p: 3.6051 });
  expect(s.every((x, i) => i === 0 || x.t > (s[i - 1]?.t ?? 0))).toBe(true);
  expect(s.every((x) => x.t >= from && x.t <= to && Number.isFinite(x.p) && x.p > 0)).toBe(true);
});

test("anything that is not a candle list gives no samples", () => {
  expect(samplesOf({ message: "rate limited" }, 0, 1)).toEqual([]);
  expect(samplesOf([[1, "x"]], 0, 1)).toEqual([]);
  expect(samplesOf([[1794299280, 3.6, 3.7, 0, 3.65, 1]], from, to)).toEqual([]); // a price of 0 is no price
});

test("a replay is final only two minutes after its window ends: the last candle may still be forming", () => {
  expect(settled(1_000_000, 1_000_000 + 120_000)).toBe(false);
  expect(settled(1_000_000, 1_000_000 + 120_001)).toBe(true);
});
