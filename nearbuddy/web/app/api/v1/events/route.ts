// GET /api/v1/events?limit=50&since=<block>  newest-first arena events (intent, commit, reveal, attack, open, resolve,
// register, other) decoded from the contract's transactions. `since` keeps only events after that block.
import { cachedJson, json, jsonBody } from "../../near";
import { tape } from "../../tape";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50) || 50));
  const since = Number(q.get("since") ?? 0) || 0;
  try {
    const t = await tape();
    return cachedJson(jsonBody({ at: t.at, events: t.events.filter((e) => e.block > since).slice(0, limit) }), 2);
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
