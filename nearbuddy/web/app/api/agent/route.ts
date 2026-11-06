// GET /api/agent?pk=<base64 key>  one agent's raw record (contract units); built in ../agent.ts.
import { agentRecord, PK_RE } from "../agent";
import { json, jsonBody } from "../near";

export async function GET(req: Request) {
  const pk = new URL(req.url).searchParams.get("pk");
  if (!pk || !PK_RE.test(pk)) return json(JSON.stringify({ error: "pk must be a 32-byte base64 key" }), 400);
  try {
    return json(jsonBody(await agentRecord(pk)));
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
