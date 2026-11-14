// GET /api/result?tx=<hash>: one planted headline as the result page reads it (api/planted.ts): the tx, the target's
// model, the chain's record with its outcome, and whether it is on the hide list. The page polls this while the
// headline is waiting, so nothing is cached here beyond what planted.ts keeps (a landed tx never changes).
import { TX_RE } from "../../lib/card";
import { json, jsonBody } from "../near";
import { card } from "../planted";

export async function GET(req: Request) {
  const tx = new URL(req.url).searchParams.get("tx") ?? "";
  if (!TX_RE.test(tx)) return json(JSON.stringify({ error: "tx must be a transaction hash" }), 400);
  try {
    return json(jsonBody(await card(tx, null)));
  } catch (e) {
    return json(JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 200) }), 502);
  }
}
