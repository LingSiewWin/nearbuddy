// GET /api/v1/decisions/<tx>  the exact request and response bytes behind one enclave-signed decision.
// sha256(req) and sha256(res) equal the request_hash and response_hash the contract checked in that
// post_intent transaction, so anyone can re-hash them and compare with the chain.
import { decisionBytes } from "../../../dataset";
import { cachedJson, json, jsonBody } from "../../../near";

export async function GET(_req: Request, ctx: { params: Promise<{ tx: string }> }) {
  const { tx } = await ctx.params;
  const b = await decisionBytes(tx);
  if (!b) return json(JSON.stringify({ error: "no published bytes for that tx" }), 404);
  return cachedJson(
    jsonBody({ tx, request: b.req, response: b.res, request_sha256: b.reqHash, response_sha256: b.resHash }),
    3600,
  );
}
