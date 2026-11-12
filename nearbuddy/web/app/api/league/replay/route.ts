// GET /api/league/replay?duel=<id>: the price line of a resolved keyless match (lib/replay.ts), from Coinbase
// Exchange one-minute candles over the minutes the match spans (`from`..`to`, minute-aligned around open_at and
// close_at). The chain keeps no price series. A resolved match's line never changes: kept for good here and a day at
// the CDN, once its last candle is final (lib/replay settled). No samples (the exchange throttled, or no trade in the
// window) answers 200 with an empty list, not kept.
import { canonicalDuelId } from "../../../lib/enter";
import { samplesOf, settled } from "../../../lib/replay";
import { NETWORK_ID } from "../../../network";
import { KEYLESS_ARENA, keylessView } from "../../keyless";
import { json } from "../../near";

const CANDLES = "https://api.exchange.coinbase.com/products/NEAR-USD/candles";
const kept = new Map<string, string>();
const bad = (error: string, status: number) => json(JSON.stringify({ error }), status);

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("duel");
  if (!id || !canonicalDuelId(id)) return bad("duel must be a duel number, no leading zero", 400);
  if (!KEYLESS_ARENA) return bad(`no keyless arena on ${NETWORK_ID}`, 404);
  const hit = kept.get(id);
  if (hit) return json(hit, 200, "public, s-maxage=86400, immutable");
  try {
    const duel = await keylessView("get_duel", { duel_id: id });
    if (!duel?.resolved) return bad(`duel #${id} is not resolved`, 404);
    const from = Math.floor(Number(BigInt(duel.open_at) / 1_000_000n) / 60_000) * 60_000;
    const to = Math.ceil(Number(BigInt(duel.close_at) / 1_000_000n) / 60_000) * 60_000;
    // at most 300 candles per request: a match is minutes long, a day at the contract's cap is 1440
    if ((to - from) / 60_000 > 300) return bad(`duel #${id} is too long to replay`, 404);
    const url = `${CANDLES}?granularity=60&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    const samples = samplesOf(await r.json().catch(() => null), from, to);
    const body = JSON.stringify({ duel: id, source: "coinbase-exchange", from, to, samples });
    if (!samples.length || !settled(to, Date.now())) return json(body);
    kept.set(id, body);
    if (kept.size > 500) kept.delete(kept.keys().next().value as string);
    return json(body, 200, "public, s-maxage=86400, immutable");
  } catch (e) {
    return bad(String(e instanceof Error ? e.message : e).slice(0, 200), 502);
  }
}
