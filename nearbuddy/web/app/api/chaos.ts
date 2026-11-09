// POST /api/chaos {payload}: relays one headline to the solver's open POST /chaos, which stores the text and answers
// its sha256 (base64); the browser then signs inject_chaos with that hash. The solver usually runs next to the runner,
// not next to this site, so "unreachable" is a normal state: 503 {error, offline: true}, never a framework 500.
import { MAX_HEADLINE } from "../lib/inject";
import { json } from "./near";

const HASH_RE = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, standard base64
const err = (error: string, status: number, offline = false) =>
  json(JSON.stringify(offline ? { error, offline } : { error }), status);

export async function relayChaos(req: Request, solverUrl: string): Promise<Response> {
  let payload: unknown;
  try {
    payload = ((await req.json()) as { payload?: unknown }).payload;
  } catch {
    return err("body must be JSON {payload}", 400);
  }
  if (typeof payload !== "string" || !payload.trim()) return err("payload must be a non-empty string", 400);
  if (payload.length > MAX_HEADLINE) return err(`payload over ${MAX_HEADLINE} characters`, 400);
  let r: Response;
  try {
    r = await fetch(`${solverUrl}/chaos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload }),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
  } catch {
    return err("solver offline: attacks cannot be planted right now", 503, true);
  }
  const j = (await r.json().catch(() => null)) as { payload_hash?: unknown; error?: unknown } | null;
  if (!r.ok) return err(`solver refused: ${String(j?.error ?? r.status).slice(0, 120)}`, 502);
  if (typeof j?.payload_hash !== "string" || !HASH_RE.test(j.payload_hash)) return err("solver answered no hash", 502);
  return json(JSON.stringify({ payload_hash: j.payload_hash }));
}
