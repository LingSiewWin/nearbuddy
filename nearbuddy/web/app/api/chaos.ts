// POST /api/chaos {payload}: relays one headline to the solver's open POST /chaos, which stores the text and answers
// its sha256 (base64); the browser then signs inject_chaos with that hash. The solver usually runs next to the runner,
// not next to this site, so "unreachable" is a normal state: 503 {error, offline: true}, never a framework 500.
// Deploy 16.1 only: deploy 17 stores the headline on chain, and the route answers 410 (chaos/route.ts).
import { createHash } from "node:crypto";
import { MAX_HEADLINE } from "../lib/inject";
import { json } from "./near";

const HASH_RE = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, standard base64
const err = (error: string, status: number, offline = false) =>
  json(JSON.stringify(offline ? { error, offline } : { error }), status);

/** Per-client token bucket: BURST relays at once, then one per REFILL_MS. The solver keeps the last 2000 payloads
 *  (FIFO), so one client flooding the open relay could evict paid ones; at these limits that takes over 8 hours.
 *  ponytail: one bucket map per server instance, a shared store (KV) if the relay outlives deploy 16. */
export const BURST = 20;
export const REFILL_MS = 15_000;
const buckets = new Map<string, { tokens: number; at: number }>();
export function allow(client: string, now = Date.now()): boolean {
  const b = buckets.get(client) ?? { tokens: BURST, at: now };
  const tokens = Math.min(BURST, b.tokens + (now - b.at) / REFILL_MS);
  if (tokens < 1) return false;
  buckets.delete(client); // re-insert: the map stays in last-use order, so the oldest goes first below
  buckets.set(client, { tokens: tokens - 1, at: now });
  if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value as string);
  return true;
}
/** The caller's address as the platform forwards it (first hop of x-forwarded-for). */
export const clientOf = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";

export async function relayChaos(req: Request, solverUrl: string, client = clientOf(req)): Promise<Response> {
  if (!allow(client)) return err(`too many headlines from this address: one per ${REFILL_MS / 1000} s`, 429);
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
  // the solver strips prompt delimiters (<< >> ^ and block tags) before hashing; when it did, the model would read a
  // different text than the one typed and the share card could not match it, so nothing gets signed
  if (createHash("sha256").update(payload).digest("base64") !== j.payload_hash)
    return err("the solver rewrote this headline (it strips << >> ^ and tags): remove them and try again", 422);
  return json(JSON.stringify({ payload_hash: j.payload_hash }));
}
