// A finished match's price line for the replay: Coinbase Exchange one-minute candles
// (GET /products/{product_id}/candles, rows `[time s, low, high, open, close, volume]`), two samples per candle.
// Display only, like the live line: a match settles on the oracle's prices. No Node API.
import type { Sample } from "./stage";

/** Whether a window ending at `toMs` has its final candles: the exchange may still be forming the last minute's. */
export const settled = (toMs: number, nowMs: number): boolean => nowMs - toMs > 120_000;

const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The candles that lie wholly inside `fromMs`..`toMs` as samples, oldest first: each candle's open at its start and
 *  its close 59 s later. Anything that is not a list of well-formed candles gives `[]` (the API answers an error
 *  object when throttled, and may return candles outside the range asked for). */
export function samplesOf(candles: unknown, fromMs: number, toMs: number): Sample[] {
  if (!Array.isArray(candles)) return [];
  const out: Sample[] = [];
  for (const row of candles) {
    if (!Array.isArray(row)) return [];
    const [time, , , open, close] = row as unknown[];
    if (typeof time !== "number" || !Number.isInteger(time) || !price(open) || !price(close)) return [];
    const t = time * 1000;
    if (t < fromMs || t + 59_000 > toMs) continue;
    out.push({ t, p: open }, { t: t + 59_000, p: close });
  }
  return out.sort((a, b) => a.t - b.t);
}
