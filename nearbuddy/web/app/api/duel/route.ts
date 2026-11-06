// One duel read from the arena contract on the public RPC: the duel record plus both agents' views.
// Cached 20 s per id; a stale body beats a 500 while the RPC is throttled.
import { ARENA, json, jsonBody, RPC, viewOn } from "../near";

const ORACLE = process.env.ORACLE_ACCOUNT ?? "price-oracle.testnet";
const view = viewOn(ARENA);

type Duel = { id: string; a: string; b: string; resolved: boolean };

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
  const duel = (await view("get_duel", { duel_id: id })) as Duel | null;
  const [a, b] = duel
    ? await Promise.all([view("get_agent", { agent_pk: duel.a }), view("get_agent", { agent_pk: duel.b })])
    : [null, null];
  const body = jsonBody({ at: Date.now(), rpc: RPC, contract: ARENA, oracle: ORACLE, duel, a, b });
  cache.set(id, { at: Date.now(), body });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return body;
}
