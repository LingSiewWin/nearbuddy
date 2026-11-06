// GET /api/verify?duel=N: the duel re-checked from public sources by the same checks as `bun run verify-duel N`
// (web/app/lib/verify.ts). An open duel is never verified: the body says "open". A resolved duel cannot change, so
// a complete result is kept in memory for good. An incomplete one (`degraded`: the close receipt not indexed yet, or
// its block's state not served) is kept 60 s, then checked again. A failed check (FastNEAR 429, timeout) is kept
// 45 s, so a visitor cannot start a cold scan per request. A cold check reads the duel's txs from FastNEAR, about
// 10-20 s for a recent duel.

import { checkDuel, collect, incomplete, type Line, state } from "../../lib/verify";
import { NET, NETWORK_ID } from "../../network";
import { ARENA, json } from "../near";

export const maxDuration = 60; // a cold check pages FastNEAR's history; the result is then cached

const ID_RE = /^\d{1,12}$/;
const INCOMPLETE_TTL = 60_000;
const ERROR_TTL = 45_000;
// ponytail: one process, ~10 KB a duel, oldest out past 500
const kept = new Map<string, { until: number; body: string; status: number }>();
const inflight = new Map<string, Promise<string>>();

/** The CLI line that reproduces this result, from nearbuddy/ in a checkout. */
const command = (id: string) =>
  [
    NETWORK_ID === "mainnet" ? "NEAR_NETWORK=mainnet" : "",
    ARENA !== NET.arena ? `ARENA_CONTRACT=${ARENA}` : "",
    `bun run verify-duel ${id}`,
  ]
    .filter(Boolean)
    .join(" ");

const counts = (lines: Line[]) =>
  Object.fromEntries(
    (["PASS", "FAIL", "SKIP", "INFO"] as const).map((r) => [r, lines.filter((l) => l.result === r).length]),
  );

const keep = (id: string, body: string, ttl: number, status = 200) => {
  kept.set(id, { until: Date.now() + ttl, body, status });
  if (kept.size > 500) kept.delete(kept.keys().next().value as string);
};

async function run(id: string): Promise<string> {
  const now = await state(ARENA, id);
  if (!now.duel) return JSON.stringify({ duel_id: id, status: "missing", command: command(id) });
  if (!now.duel.resolved) return JSON.stringify({ duel_id: id, status: "open", command: command(id) }); // not kept
  const evidence = await collect(ARENA, id, now);
  const lines = checkDuel(evidence);
  const degraded = incomplete(evidence);
  const body = JSON.stringify({
    duel_id: id,
    status: "checked",
    at: Date.now(),
    arena: ARENA,
    counts: counts(lines),
    lines,
    degraded,
    window: evidence.window,
    command: command(id),
  });
  keep(id, body, degraded ? INCOMPLETE_TTL : Number.POSITIVE_INFINITY);
  return body;
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("duel");
  if (!id || !ID_RE.test(id)) return json(JSON.stringify({ error: "duel must be a duel number" }), 400);
  const hit = kept.get(id);
  if (hit && Date.now() < hit.until) return json(hit.body, hit.status);
  let p = inflight.get(id);
  if (!p) {
    p = run(id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  try {
    return json(await p);
  } catch (e) {
    // serve the last result if there is one, else the error; either way, no new scan for ERROR_TTL
    if (hit?.status === 200) {
      keep(id, hit.body, ERROR_TTL);
      return json(hit.body);
    }
    const body = JSON.stringify({ error: String(e).slice(0, 200) });
    keep(id, body, ERROR_TTL, 502);
    return json(body, 502);
  }
}
