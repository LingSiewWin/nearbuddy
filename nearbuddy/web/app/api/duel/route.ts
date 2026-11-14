// One duel read from the arena contract on the public RPC: the duel record plus both agents' views, the
// config (commit-reveal fields when the contract has them) and get_no_reveal (null before commit-reveal). On deploy
// 17 the duel also carries `chaos` (get_chaos) and `chaos_fee`.
// `&arena=keyless` reads the same record from the keyless arena. Both add `open` (chaos_open per waiting headline:
// whether a decision made after it is already in; null where the arena has no such view) and `keyless` (each side's
// get_keyless record, null for a keyed agent).
// Cached 20 s per arena and id; a stale body beats a 500 while the RPC is throttled.
import { isChaosV2 } from "../../lib/inject";
import { NET } from "../../network";
import { KEYLESS_ARENA, keylessView } from "../keyless";
import { ARENA, type ArenaConfigAnyDeploy, arenaConfigAnyDeploy, arenaView, json, jsonBody, RPC } from "../near";

const ORACLE = process.env.ORACLE_ACCOUNT ?? NET.oracle;

const cache = new Map<string, { at: number; body: string }>();
const inflight = new Map<string, Promise<string>>();
const ID_RE = /^\d{1,12}$/;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const id = q.get("id");
  if (!id || !ID_RE.test(id)) return json(JSON.stringify({ error: "id must be a duel number" }), 400);
  const keyless = q.get("arena") === "keyless";
  if (keyless && !KEYLESS_ARENA) return json(JSON.stringify({ error: "no keyless arena on this network" }), 404);
  const key = keyless ? `k${id}` : id;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return json(hit.body);
  let p = inflight.get(key);
  if (!p) {
    p = build(id, keyless, key).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    return json(await p);
  } catch (e) {
    if (hit) return json(hit.body);
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}

async function build(id: string, keyless: boolean, key: string): Promise<string> {
  const view = keyless ? keylessView : arenaView;
  const [found, config, no_reveal] = await Promise.all([
    view("get_duel", { duel_id: id }),
    keyless ? (view("get_config", {}) as Promise<ArenaConfigAnyDeploy>) : arenaConfigAnyDeploy(),
    view("get_no_reveal", { duel_id: id }).catch(() => null), // view missing before commit-reveal
  ]);
  // deploy 17: the duel carries its chaos records and the next attack's price
  const v2 =
    found && isChaosV2(config)
      ? await Promise.all([view("get_chaos", { duel_id: id }), view("chaos_fee", { duel_id: id })])
      : null;
  const duel = found && v2 ? { ...found, chaos: v2[0], chaos_fee: v2[1] } : found;
  const [a, b] = duel
    ? await Promise.all([view("get_agent", { agent_pk: duel.a }), view("get_agent", { agent_pk: duel.b })])
    : [null, null];
  const waiting = (v2?.[0] ?? []).flatMap((c, i) => (c.outcome === "Pending" ? [i] : []));
  const [opens, kl] = await Promise.all([
    Promise.all(waiting.map((index) => view("chaos_open", { duel_id: id, index }).catch(() => null))),
    duel
      ? Promise.all([duel.a, duel.b].map((agent) => view("get_keyless", { agent }).catch(() => null)))
      : [null, null],
  ]);
  const body = jsonBody({
    at: Date.now(),
    rpc: RPC,
    contract: keyless ? KEYLESS_ARENA : ARENA,
    oracle: ORACLE,
    config,
    no_reveal,
    duel,
    a,
    b,
    open: Object.fromEntries(waiting.map((index, i) => [index, opens[i] ?? null])),
    keyless: kl,
  });
  cache.set(key, { at: Date.now(), body });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return body;
}
