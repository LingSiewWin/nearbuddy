// POST /api/practice {headline, target}: one practice round (lib/practice.ts). Two model calls on NEAR AI Cloud with
// the server's key: the defender's decision with the headline and a control without it, judged against its cached
// baseline bet. POST {target} alone answers that baseline. Nothing touches a chain and nothing is
// stored: no headline is kept or logged. Limited per address and site-wide (api/practice.ts), counted in the comment
// store's Redis when it is configured, else in this process. Every error is a short fixed string with a code.

import { checkPractice, PRACTICE_MODEL, type PracticeBaseline, SNAPSHOT } from "../../lib/practice";
import { store } from "../comments";
import { json } from "../near";
import { baselineOf, type Cache, limit, playRound } from "../practice";

export const maxDuration = 60;
const MAX_BODY = 4096;
const local = new Map<string, { n: number; until: number }>();
const answer = (body: unknown, status = 200) => json(JSON.stringify(body), status);
const refuse = (status: number, code: string, error: string, more: object = {}) =>
  answer({ error, code, ...more }, status);

async function bump(key: string, ttlS: number): Promise<number> {
  const redis = store();
  if (redis) {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttlS);
    return n;
  }
  const now = Date.now();
  // ponytail: keys carry their window, so old ones are dropped in one sweep once the map grows
  if (local.size > 5000) for (const [k, v] of local) if (v.until <= now) local.delete(k);
  const cur = local.get(key);
  const next = cur && cur.until > now ? { n: cur.n + 1, until: cur.until } : { n: 1, until: now + ttlS * 1000 };
  local.set(key, next);
  return next.n;
}

const kept = new Map<string, { v: string; until: number }>();
/** The baseline cache: Redis when the comment store is configured, else this process. */
const cache: Cache = {
  async get(key) {
    const redis = store();
    if (redis) {
      const v = await redis.get(key); // the client parses JSON it stored
      return v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
    }
    const hit = kept.get(key);
    return hit && hit.until > Date.now() ? hit.v : null;
  },
  async set(key, value, ttlS) {
    const redis = store();
    if (redis) await redis.set(key, value, { ex: ttlS });
    else kept.set(key, { v: value, until: Date.now() + ttlS * 1000 });
  },
};

export async function POST(req: Request) {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return refuse(415, "json_only", "send JSON");
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) return refuse(503, "no_model_key", "practice is off: this server has no model key");
  const text = await req.text().catch(() => "");
  let body: unknown = null;
  try {
    if (text.length <= MAX_BODY) body = JSON.parse(text);
  } catch {}
  const input = checkPractice(body);
  if ("error" in input) return refuse(400, "bad_input", input.error);
  // no headline: the defender's bet before anyone lies to it. Cached, so it spends a model call only when cold.
  // a visitor's own strategy has no shared cached baseline, so even its baseline spends a call and is counted
  if (input.headline === null && input.strategy === undefined) {
    try {
      const baseline = await baselineOf(key, input.target, cache);
      const body: PracticeBaseline = {
        practice: true,
        target: input.target,
        model: PRACTICE_MODEL,
        snapshot: SNAPSHOT,
        baseline,
      };
      return answer(body);
    } catch {
      return refuse(502, "model_failed", "the model did not answer with a decision: try again");
    }
  }
  const address = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  // a counter that cannot be read refuses the round: the limit is what protects the model credit
  const wait = await limit(address, bump, Math.floor(Date.now() / 1000)).catch(() => 60);
  if (wait > 0) return refuse(429, "limited", "too many practice rounds from here for now", { wait_s: wait });
  if (input.headline === null) return refuse(400, "bad_input", "headline empty");
  try {
    return answer(await playRound(key, input.target, input.headline, cache, undefined, input.strategy));
  } catch {
    return refuse(502, "model_failed", "the model did not answer with a decision: try again");
  }
}
