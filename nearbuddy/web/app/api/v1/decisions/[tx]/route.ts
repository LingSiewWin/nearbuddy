// GET /api/v1/decisions/<tx>  the exact request and response bytes behind one enclave-signed decision.
// sha256(req) and sha256(res) equal the request_hash and response_hash the contract checked in that
// post_intent transaction, so anyone can re-hash them and compare with the chain.
import { decisionBytes } from "../../../dataset";
import { json, jsonBody } from "../../../near";

export async function GET(_req: Request, ctx: { params: Promise<{ tx: string }> }) {
  const { tx } = await ctx.params;
  const b = decisionBytes(tx);
  if (!b) return json(JSON.stringify({ error: "no published bytes for that tx" }), 404);
  return json(jsonBody({ tx, request: b.req, response: b.res, request_sha256: b.reqHash, response_sha256: b.resHash }));
}
