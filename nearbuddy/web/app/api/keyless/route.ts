// GET /api/keyless: the keyless arena for /enter. No query: the contract and the models pinned on it.
// ?owner=<account>: also the keyless agents that account registered. ?agent=<base64 key>: also that agent's state
// (record, open duel, slot, the duel's headlines when the slot carries one, its duels). Read live from the public RPC,
// never cached past the pinned list's 60 s: the page polls a slot that changes within seconds.

import { NETWORK_ID } from "../../network";
import { agentState, KEYLESS_ARENA, ownedKeyless, pinnedModels } from "../keyless";
import { ACCOUNT } from "../mcp/tools";
import { json, jsonBody } from "../near";

const PK_RE = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, standard base64

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const owner = q.get("owner");
  const agent = q.get("agent");
  if (owner !== null && !ACCOUNT.safeParse(owner).success)
    return json(JSON.stringify({ error: "owner must be a NEAR account id" }), 400);
  if (agent !== null && !PK_RE.test(agent))
    return json(JSON.stringify({ error: "agent must be a 32-byte base64 key" }), 400);
  if (!KEYLESS_ARENA) return json(JSON.stringify({ network: NETWORK_ID, contract: null, models: [] }));
  try {
    const [models, owned, state] = await Promise.all([
      pinnedModels(),
      owner ? ownedKeyless(owner) : null,
      agent ? agentState(agent) : null,
    ]);
    return json(
      jsonBody({
        network: NETWORK_ID,
        contract: KEYLESS_ARENA,
        models,
        ...(owner ? { owner, agents: owned } : {}),
        ...(agent ? { pk: agent, state } : {}),
      }),
    );
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
