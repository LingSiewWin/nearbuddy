// GET /api/candles?from=<ms>&to=<ms>: the NEAR/USD price over a finished duel, for its price line: Coinbase Exchange
// one-minute candles as samples (lib/replay.ts). Display only: a duel settles on the oracle's prices. A window that
// has ended never changes, so its answer is kept per process; a failed read is not kept.
import { samplesOf, settled } from "../../lib/replay";
import { json } from "../near";

const MAX_MS = 5 * 3_600_000; // the exchange answers at most 300 candles a call
const kept = new Map<string, string>(); // ponytail: one process, ~1 KB a window; oldest out past 500

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const [from, to] = [Number(q.get("from")), Number(q.get("to"))];
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= from || to - from > MAX_MS)
    return json(JSON.stringify({ error: "from and to must be ms, at most 5 hours apart" }), 400);
  const key = `${from}:${to}`;
  const hit = kept.get(key);
  if (hit) return json(hit);
  const iso = (ms: number) => new Date(ms).toISOString();
  const start = iso(Math.floor(from / 60_000) * 60_000 - 60_000);
  const end = iso(Math.ceil(to / 60_000) * 60_000 + 60_000);
  let candles: unknown;
  try {
    const r = await fetch(
      `https://api.exchange.coinbase.com/products/NEAR-USD/candles?granularity=60&start=${start}&end=${end}`,
      { headers: { "user-agent": "nearbuddy-web" }, signal: AbortSignal.timeout(8000), cache: "no-store" },
    );
    candles = await r.json();
  } catch {
    return json(JSON.stringify({ error: "the exchange did not answer" }), 502);
  }
  const body = JSON.stringify({
    source: "Coinbase Exchange NEAR-USD one-minute candles",
    samples: samplesOf(candles, from - 60_000, to + 60_000),
  });
  if (settled(to, Date.now())) {
    kept.set(key, body);
    if (kept.size > 500) kept.delete(kept.keys().next().value as string);
  }
  return json(body);
}
