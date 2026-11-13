// GET /api/league: the league home's body (api/league.ts) from the keyless arena. Every tab polls it, so the CDN keeps
// one copy 3 s and this process builds one at a time; the last good body beats a 502 while the RPC is throttled.
// A resolved duel and a registered agent never change, so both are read once and kept.
import type { Duel } from "../../lib/abi/arena";
import type { AgentInfo } from "../../lib/league";
import { NETWORK_ID } from "../../network";
import { chunked } from "../duels";
import { KEYLESS_ARENA, keylessView } from "../keyless";
import { build, SCAN } from "../league";
import { json, jsonBody } from "../near";

const EDGE = "public, s-maxage=3, stale-while-revalidate=10";
const TTL = 3_000;
const resolved = new Map<string, Duel>();
const agents = new Map<string, AgentInfo>();
let cache: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;

async function read(): Promise<string> {
  const contract = KEYLESS_ARENA as string;
  const next = Number((await keylessView("get_config", {})).next_duel);
  const ids = Array.from({ length: Math.min(SCAN, next) }, (_, i) => String(next - 1 - i));
  const fetched = await chunked(
    ids.filter((id) => !resolved.has(id)),
    10,
    (id) => keylessView("get_duel", { duel_id: id }),
  );
  const open: Duel[] = [];
  for (const d of fetched) {
    if (!d) continue;
    if (d.resolved && d.outcome) resolved.set(d.id, d);
    else open.push(d);
  }
  const duels = [...ids.flatMap((id) => resolved.get(id) ?? []), ...open];
  const unknown = [...new Set(duels.flatMap((d) => [d.a, d.b]))].filter((pk) => !agents.has(pk));
  const views = await chunked(unknown, 10, (pk) => keylessView("get_agent", { agent_pk: pk }));
  views.forEach((v, i) => {
    const pk = unknown[i];
    if (v && pk) agents.set(pk, { pk, owner: v.owner, model_id: v.model_id });
  });
  const league = build(duels, agents, BigInt(Date.now()) * 1_000_000n, NETWORK_ID, contract);
  if (league.live) league.shout_fee = await keylessView("chaos_fee", { duel_id: league.live.id }).catch(() => null);
  const body = jsonBody(league);
  cache = { at: Date.now(), body };
  return body;
}

export async function GET() {
  if (!KEYLESS_ARENA)
    return json(
      JSON.stringify({
        at: Date.now(),
        network: NETWORK_ID,
        contract: null,
        live: null,
        closing: null,
        last: null,
        models: [],
        coaches: [],
        shout_fee: null,
      }),
    );
  if (cache && Date.now() - cache.at < TTL) return json(cache.body, 200, EDGE);
  inflight ??= read().finally(() => {
    inflight = null;
  });
  try {
    return json(await inflight, 200, EDGE);
  } catch (e) {
    if (cache) return json(cache.body, 200, EDGE);
    return json(JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 200) }), 502);
  }
}
