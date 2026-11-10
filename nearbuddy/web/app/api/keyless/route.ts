// GET /api/keyless: the keyless arena for /enter. No query: the contract and the models pinned on it.
// ?owner=<account>: also the keyless agents that account registered. ?agent=<base64 key>: also that agent's state
// (record, open duel, slot, the duel's headlines when the slot carries one, its newest duels). Read from the public
// RPC, one read per query at a time; an answer is kept 2 s and a failure 8 s, so polling tabs and a retrying client
// cost the RPC at most one read per query per window. The pinned list is kept 60 s, and its last copy serves while
// a fresh read fails.

import { canonicalPk } from "../../lib/enter";
import { NETWORK_ID } from "../../network";
import { agentState, KEYLESS_ARENA, lastPinned, ownedKeyless, pinnedModels } from "../keyless";
import { ACCOUNT } from "../mcp/tools";
import { json, jsonBody } from "../near";

const OK_TTL = 2000;
const ERROR_TTL = 8000;
// ponytail: one process, oldest out past 500 queries
const kept = new Map<string, { until: number; body: string; status: number }>();
const inflight = new Map<string, Promise<string>>();
const keep = (key: string, body: string, status: number, ttl: number) => {
  kept.delete(key);
  kept.set(key, { until: Date.now() + ttl, body, status });
  if (kept.size > 500) kept.delete(kept.keys().next().value as string);
};

async function build(owner: string | null, agent: string | null): Promise<string> {
  const [models, owned, state] = await Promise.all([
    pinnedModels().catch(lastPinned),
    owner ? ownedKeyless(owner) : null,
    agent ? agentState(agent) : null,
  ]);
  return jsonBody({
    network: NETWORK_ID,
    contract: KEYLESS_ARENA,
    models,
    ...(owner ? { owner, agents: owned } : {}),
    ...(agent ? { pk: agent, state } : {}),
  });
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const owner = q.get("owner");
  const agent = q.get("agent");
  if (owner !== null && !ACCOUNT.safeParse(owner).success)
    return json(JSON.stringify({ error: "owner must be a NEAR account id" }), 400);
  // one spelling per key: a non-canonical one would be a new cache key and a new read for the same agent
  if (agent !== null && !canonicalPk(agent))
    return json(JSON.stringify({ error: "agent must be a 32-byte key in canonical base64" }), 400);
  if (!KEYLESS_ARENA) return json(JSON.stringify({ network: NETWORK_ID, contract: null, models: [] }));
  const key = `${owner ?? ""}|${agent ?? ""}`;
  const hit = kept.get(key);
  if (hit && Date.now() < hit.until) return json(hit.body, hit.status);
  let p = inflight.get(key);
  if (!p) {
    p = build(owner, agent).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    const body = await p;
    keep(key, body, 200, OK_TTL);
    return json(body);
  } catch (e) {
    const body = JSON.stringify({ error: String(e).slice(0, 200) });
    keep(key, body, 502, ERROR_TTL);
    return json(body, 502);
  }
}
