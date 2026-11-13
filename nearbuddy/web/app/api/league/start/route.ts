// GET|POST /api/league/start: the league home's "start match" panel talks to the operator service through this route
// (packages/keeper/src/operator-cli.ts, which holds the keys and binds 127.0.0.1). The operator's address and secret
// stay on the server (OPERATOR_URL, OPERATOR_SECRET). Without OPERATOR_URL, or with the operator unreachable, GET
// answers {available: false} and the page shows no panel.
import { json } from "../../near";

const URL_ = process.env.OPERATOR_URL?.trim().replace(/\/$/, "") ?? "";
const SECRET = process.env.OPERATOR_SECRET?.trim() ?? "";
const off = () => json(JSON.stringify({ available: false }));
/** A model id as NEAR AI Cloud writes one: `owner/name`, printable, short. */
const MODEL = /^[\w.-]{1,60}\/[\w.:-]{1,80}$/;

export async function GET() {
  if (!URL_) return off();
  try {
    const r = await fetch(`${URL_}/status`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) return off();
    return json(JSON.stringify({ available: true, ...((await r.json()) as object) }));
  } catch {
    return off();
  }
}

export async function POST(req: Request) {
  if (!URL_ || !SECRET) return json(JSON.stringify({ error: "no operator on this site" }), 404);
  const body = (await req.json().catch(() => null)) as { a?: unknown; b?: unknown } | null;
  const { a, b } = body ?? {};
  if (typeof a !== "string" || typeof b !== "string" || !MODEL.test(a) || !MODEL.test(b))
    return json(JSON.stringify({ error: "body must be {a, b}: two model ids" }), 400);
  try {
    const r = await fetch(`${URL_}/match`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operator-secret": SECRET },
      body: JSON.stringify({ a, b }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const out = (await r.json().catch(() => ({ error: `operator answered ${r.status}` }))) as object;
    return json(JSON.stringify(r.ok ? { available: true, ...out } : out), r.status);
  } catch {
    return json(JSON.stringify({ error: "the operator did not answer" }), 502);
  }
}
