// NEAR/USD for the status bar and the live P&L of an open duel: the last trade on Coinbase Exchange's public ticker
// (no key). Display only: duels settle on the Outlayer TEE oracle's prices. Cached 2 s for every tab, so the browser
// can poll it every 2 s without each tab reaching Coinbase; a stale price beats none, labelled by `at`.
import { json } from "../near";

const TTL = 2_000;
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
  if (cache && Date.now() - cache.at < TTL) return json(cache.body);
  inflight ??= read().finally(() => {
    inflight = null;
  });
  try {
    return json(await inflight);
  } catch (e) {
    if (cache) return json(cache.body);
    return json(JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 120) }), 502);
  }
}
