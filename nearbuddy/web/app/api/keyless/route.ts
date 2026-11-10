// GET /api/keyless: the keyless arena for /enter. No query: the contract and the models pinned on it.
// ?owner=<account>: also the keyless agents that account registered. ?agent=<base64 key>: also that agent's state
// (record, open duel, slot, the duel's headlines when the slot carries one, its duels). Read from the public RPC and
// kept 2 s per query, one read at a time, so every tab polling one agent costs the RPC one read; the pinned list 60 s.

import { NETWORK_ID } from "../../network";
import { agentState, KEYLESS_ARENA, ownedKeyless, pinnedModels } from "../keyless";
import { ACCOUNT } from "../mcp/tools";
import { json, jsonBody } from "../near";

const PK_RE = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, standard base64
// ponytail: one process, oldest out past 500 queries
const kept = new Map<string, { at: number; body: string }>();
const inflight = new Map<string, Promise<string>>();

async function build(owner: string | null, agent: string | null): Promise<string> {
  const [models, owned, state] = await Promise.all([
    pinnedModels(),
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
  if (agent !== null && !PK_RE.test(agent))
    return json(JSON.stringify({ error: "agent must be a 32-byte base64 key" }), 400);
  if (!KEYLESS_ARENA) return json(JSON.stringify({ network: NETWORK_ID, contract: null, models: [] }));
  const key = `${owner ?? ""}|${agent ?? ""}`;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < 2000) return json(hit.body);
  let p = inflight.get(key);
  if (!p) {
    p = build(owner, agent).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    const body = await p;
    kept.delete(key);
    kept.set(key, { at: Date.now(), body });
    if (kept.size > 500) kept.delete(kept.keys().next().value as string);
    return json(body);
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
