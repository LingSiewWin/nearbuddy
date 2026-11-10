// GET /api/flips: the replay of answered attacks and the saboteurs board (api/flips.ts), from the chaos records of the
// newest FLIPS_SCAN finished duels (deploy 17 `get_chaos`) and the published dataset. Cached 60 s and built once at a
// time; a finished duel's records are read once per process. When the chain cannot be read the dataset part is still
// served, with `chain_error`, so the replay never comes back empty.
// ponytail: the board covers the newest FLIPS_SCAN duels; an indexer or an on-chain tally per injector when the
// chaos era outgrows that window.
import board from "../../data/board.json";
import type { Chaos } from "../../lib/abi/arena";
import type { Attack } from "../../lib/fool";
import { isChaosV2 } from "../../lib/inject";
import { chunked, readDuel } from "../duels";
import { type DuelChaos, replay, saboteurs } from "../flips";
import { arenaConfigAnyDeploy, arenaView, json, jsonBody } from "../near";

const SCAN = Number(process.env.FLIPS_SCAN ?? 200);
const TTL = 60_000;
let cache: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;
const done = new Map<string, Chaos[]>(); // finished duel -> its records; ponytail: one process, ~1 KB a duel

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return json(cache.body);
  inflight ??= build().finally(() => {
    inflight = null;
  });
  try {
    return json(await inflight);
  } catch (e) {
    if (cache) return json(cache.body);
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}

async function chain(): Promise<{ chain: DuelChaos[]; models: Record<string, string>; from: number; to: number }> {
  const config = await arenaConfigAnyDeploy();
  const n = Number(config.next_duel);
  const from = Math.max(0, n - SCAN);
  if (!isChaosV2(config)) return { chain: [], models: {}, from, to: n };
  const ids = Array.from({ length: n - from }, (_, i) => String(n - 1 - i));
  const [agents, records] = await Promise.all([
    arenaView("leaderboard", { from: 0, limit: 100 }),
    chunked(ids, 8, async (id) => {
      const hit = done.get(id);
      if (hit) return hit;
      const d = await readDuel(id);
      if (!d?.resolved) return null; // open duels show live; their records still change
      const r = await arenaView("get_chaos", { duel_id: id });
      done.set(id, r);
      return r;
    }),
  ]);
  return {
    chain: ids.flatMap((duel, i) => (records[i]?.length ? [{ duel, records: records[i] }] : [])),
    models: Object.fromEntries(agents.map((a) => [a.pk, a.model_id])),
    from,
    to: n,
  };
}

async function build(): Promise<string> {
  const recent = board.recent as Attack[];
  let c: Awaited<ReturnType<typeof chain>> | null = null;
  let chain_error: string | null = null;
  try {
    c = await chain();
  } catch (e) {
    chain_error = String(e instanceof Error ? e.message : e).slice(0, 160);
  }
  const body = jsonBody({
    at: Date.now(),
    scanned: c ? { from: c.from, to: c.to } : null,
    chain_error,
    flips: replay(c?.chain ?? [], recent, (pk) => c?.models[pk] ?? null),
    saboteurs: saboteurs(c?.chain ?? []),
  });
  if (c) cache = { at: Date.now(), body }; // a chain failure is retried on the next request, not kept 60 s
  return body;
}
