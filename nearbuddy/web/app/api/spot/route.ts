// NEAR/USD for the status bar and the live P&L of an open duel: the last trade on Coinbase Exchange's public ticker
// (no key). Display only: duels settle on the Outlayer TEE oracle's prices. Every tab polls it every 2 s, so the CDN
// keeps one copy 2 s (stale-while-revalidate 10 s) and this function keeps one too; a stale price beats none, labelled
// by `at`.
import { json } from "../near";

const TTL = 2_000;
/** One CDN copy for every tab: 2 s fresh, then served stale while one request refreshes it. */
const EDGE = "public, s-maxage=2, stale-while-revalidate=10";
const TICKER = "https://api.exchange.coinbase.com/products/NEAR-USD/ticker";
let cache: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;

async function read(): Promise<string> {
  const r = await fetch(TICKER, { signal: AbortSignal.timeout(4000), cache: "no-store" });
  if (!r.ok) throw new Error(`coinbase ${r.status}`);
  const t = (await r.json()) as { price?: string; time?: string };
  if (!t.price || !/^\d+(\.\d+)?$/.test(t.price)) throw new Error("coinbase answered no price");
  const body = JSON.stringify({
    symbol: "NEAR/USD",
    price: t.price,
    source: "coinbase-exchange",
    trade_at: t.time ?? null,
    at: Date.now(),
  });
  cache = { at: Date.now(), body };
  return body;
}

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return json(cache.body, 200, EDGE);
  inflight ??= read().finally(() => {
    inflight = null;
  });
  try {
    return json(await inflight, 200, EDGE);
  } catch (e) {
    if (cache) return json(cache.body, 200, EDGE);
    return json(JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 120) }), 502);
  }
}
