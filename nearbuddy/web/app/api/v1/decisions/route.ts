// GET /api/v1/decisions?agent=<pk>&duel=<id>&attacked=1&limit=50  enclave-verified decisions from the
// published dataset, newest first: the model's call, its own reasoning, and the attack it was shown.
import { datasetBuilt, getDecisions } from "../../dataset";
import { json, jsonBody } from "../../near";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const agent = q.get("agent");
  const duel = q.get("duel");
  const attacked = q.get("attacked") === "1";
  const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? 50) || 50));
  const rows = (await getDecisions())
    .filter((r) => (!agent || r.agent === agent) && (!duel || r.duel === duel) && (!attacked || r.attack))
    .slice(-limit)
    .reverse();
  return json(jsonBody({ dataset_built: datasetBuilt, count: rows.length, rows }));
}
