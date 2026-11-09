// One duel read from the arena contract on the public RPC: the duel record plus both agents' views, the
// config (commit-reveal fields when the contract has them) and get_no_reveal (null before commit-reveal). On deploy
// 17 the duel also carries `chaos` (get_chaos) and `chaos_fee`.
// Cached 20 s per id; a stale body beats a 500 while the RPC is throttled.
import { isChaosV2 } from "../../lib/inject";
import { NET } from "../../network";
import { chaosOf } from "../duels";
import { ARENA, arenaConfigAnyDeploy, arenaView, json, jsonBody, RPC } from "../near";

const ORACLE = process.env.ORACLE_ACCOUNT ?? NET.oracle;

const cache = new Map<string, { at: number; body: string }>();
const inflight = new Map<string, Promise<string>>();
const ID_RE = /^\d{1,12}$/;

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !ID_RE.test(id)) return json(JSON.stringify({ error: "id must be a duel number" }), 400);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 20_000) return json(hit.body);
  let p = inflight.get(id);
  if (!p) {
    p = build(id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  try {
    return json(await p);
  } catch (e) {
    if (hit) return json(hit.body);
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}

async function build(id: string): Promise<string> {
  const [found, config, no_reveal] = await Promise.all([
    arenaView("get_duel", { duel_id: id }),
    arenaConfigAnyDeploy(),
    arenaView("get_no_reveal", { duel_id: id }).catch(() => null), // view missing before commit-reveal
  ]);
  // deploy 17: the duel carries its chaos records and the next attack's price
  const duel = found && isChaosV2(config) ? { ...found, ...(await chaosOf(id)) } : found;
  const [a, b] = duel
    ? await Promise.all([arenaView("get_agent", { agent_pk: duel.a }), arenaView("get_agent", { agent_pk: duel.b })])
    : [null, null];
  const body = jsonBody({ at: Date.now(), rpc: RPC, contract: ARENA, oracle: ORACLE, config, no_reveal, duel, a, b });
  cache.set(id, { at: Date.now(), body });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return body;
}
