// GET /api/arena  the raw snapshot the pages render: config, leaderboard, the last 3 duels in full,
// followers, counts over the scanned duels, and the optional solver enrichment.
import { proven as hasProof } from "../../cells";
import { snapshot, ZERO } from "../arena";
import { json, jsonBody } from "../near";

export async function GET() {
  try {
    const s = await snapshot();
    const proven = (i: { proof_hash?: string } | null) => hasProof(i, ZERO);
    const stats = {
      scanned: s.duels.length,
      verified_decisions: s.duels.reduce(
        (n, d) => n + Number(proven(d.last_intent_a)) + Number(proven(d.last_intent_b)),
        0,
      ),
      attacks: s.duels.reduce((n, d) => n + (d.resolved ? (d.outcome?.injections ?? 0) : d.injections.length), 0),
    };
    return json(jsonBody({ ...s, duels: s.duels.slice(0, 3), stats }));
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
