// GET /api/keyless/verify?duel=N: /api/verify's checks (lib/verify.ts, the same as `bun run verify-duel N`) on a duel
// of the keyless arena, which /api/verify does not read (it is fixed to ARENA_CONTRACT). Ids are canonical. Kept: a
// complete clean result for good, one with a FAIL or incomplete 60 s, an error 45 s, a missing duel 30 s, an open one
// 5 s; one scan per duel at a time.
// ponytail: a copy of /api/verify's cache over another contract; one route with an arena allow-list once that file
// is free to change.
import { canonicalDuelId } from "../../../lib/enter";
import { checkDuel, collect, incomplete, state } from "../../../lib/verify";
import { NETWORK_ID } from "../../../network";
import { KEYLESS_ARENA } from "../../keyless";
import { json } from "../../near";

export const maxDuration = 60;

const kept = new Map<string, { until: number; body: string; status: number }>();
const inflight = new Map<string, Promise<string>>();
const keep = (id: string, body: string, ttl: number, status = 200) => {
  kept.set(id, { until: Date.now() + ttl, body, status });
  if (kept.size > 500) kept.delete(kept.keys().next().value as string);
};

async function run(arena: string, id: string): Promise<string> {
  const command = `${NETWORK_ID === "mainnet" ? "NEAR_NETWORK=mainnet " : ""}ARENA_CONTRACT=${arena} bun run verify-duel ${id}`;
  const now = await state(arena, id);
  if (!now.duel) {
    const body = JSON.stringify({ duel_id: id, status: "missing", arena, command });
    keep(id, body, 30_000); // it may be opened later
    return body;
  }
  if (!now.duel.resolved) {
    const body = JSON.stringify({ duel_id: id, status: "open", arena, command });
    keep(id, body, 5000); // it resolves within minutes
    return body;
  }
  const evidence = await collect(arena, id, now);
  const lines = checkDuel(evidence);
  const degraded = incomplete(evidence);
  const counts = Object.fromEntries(
    (["PASS", "FAIL", "SKIP", "INFO"] as const).map((r) => [r, lines.filter((l) => l.result === r).length]),
  );
  const body = JSON.stringify({
    duel_id: id,
    status: "checked",
    at: Date.now(),
    arena,
    counts,
    lines,
    degraded,
    command,
  });
  // a FAIL is re-checked after 60 s too: collect() reads a view that failed (an RPC 429) as null, which fails a check
  keep(id, body, degraded || counts.FAIL ? 60_000 : Number.POSITIVE_INFINITY);
  return body;
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("duel");
  // one spelling per duel: "03" would be a second cache entry, and lib/verify compares ids as strings
  if (!id || !canonicalDuelId(id))
    return json(JSON.stringify({ error: "duel must be a duel number, no leading zero" }), 400);
  if (!KEYLESS_ARENA) return json(JSON.stringify({ error: `no keyless arena on ${NETWORK_ID}` }), 404);
  const hit = kept.get(id);
  if (hit && Date.now() < hit.until) return json(hit.body, hit.status);
  let p = inflight.get(id);
  if (!p) {
    p = run(KEYLESS_ARENA, id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  try {
    return json(await p);
  } catch (e) {
    if (hit?.status === 200) {
      keep(id, hit.body, 45_000);
      return json(hit.body);
    }
    const body = JSON.stringify({ error: String(e).slice(0, 200) });
    keep(id, body, 45_000, 502);
    return json(body, 502);
  }
}
