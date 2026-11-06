// GET /api/v1/agents/<pk>  one agent in human units: identity, return, bond, record, attacks met, followers,
// its duels and its last 20 decisions with reasoning. URL-encode the key (+ / = appear in it).
import { agentSummary, parsePk } from "../../../agent";
import { cachedJson, json, jsonBody } from "../../../near";

export async function GET(_req: Request, ctx: { params: Promise<{ pk: string }> }) {
  const pk = parsePk((await ctx.params).pk);
  if (!pk) return json(JSON.stringify({ error: "pk must be a 32-byte base64 key" }), 400);
  try {
    const s = await agentSummary(pk);
    return s ? cachedJson(jsonBody(s), 10) : json(JSON.stringify({ error: "no agent with that key" }), 404);
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
