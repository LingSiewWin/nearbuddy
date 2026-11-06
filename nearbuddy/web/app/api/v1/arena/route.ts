// GET /api/v1/arena  the arena in human units: the live duel (both sides' current call, attacks so far),
// standings with each agent's prompt, record over the scanned duels and how it met attacks, recent results.
import { snapshot, summary } from "../../arena";
import { json, jsonBody } from "../../near";

export async function GET() {
  try {
    return json(jsonBody(summary(await snapshot())));
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
