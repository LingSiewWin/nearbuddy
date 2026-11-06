// GET /api/v1/duels/<id>  one duel in human units: both sides, prices, pot, winner, attacks, the decisions
// with reasoning, and its on-chain events while they are on the live tape.
import { duelSummary, ID_RE } from "../../../duel";
import { cachedJson, json, jsonBody } from "../../../near";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return json(JSON.stringify({ error: "id must be a duel number" }), 400);
  try {
    const s = await duelSummary(id);
    return s ? cachedJson(jsonBody(s), 5) : json(JSON.stringify({ error: "no duel with that id" }), 404);
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
