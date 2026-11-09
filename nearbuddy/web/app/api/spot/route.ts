// NEAR/USD spot for the status bar: Coinbase's public spot price, the source the runner briefs from when it has no
// Pyth key (packages/demo/src/against.ts spot8). Cached 5 s for every tab; a stale price beats none, labelled by `at`.
import { json } from "../near";

const TTL = 5_000;
let cache: { at: number; body: string } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return json(cache.body);
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/NEAR-USD/spot", {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`coinbase ${r.status}`);
    const amount = ((await r.json()) as { data?: { amount?: string } }).data?.amount;
    if (!amount || !/^\d+(\.\d+)?$/.test(amount)) throw new Error("coinbase answered no price");
    cache = {
      at: Date.now(),
      body: JSON.stringify({ symbol: "NEAR/USD", price: amount, source: "coinbase", at: Date.now() }),
    };
    return json(cache.body);
  } catch (e) {
    if (cache) return json(cache.body);
    return json(JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 120) }), 502);
  }
}
