// GET /api/duel?id=<n>  one duel and both agents' views (contract units); built in ../duel.ts.
import { duelRecord, ID_RE } from "../duel";
import { json, jsonBody } from "../near";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !ID_RE.test(id)) return json(JSON.stringify({ error: "id must be a duel number" }), 400);
  try {
    return json(jsonBody(await duelRecord(id)));
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
