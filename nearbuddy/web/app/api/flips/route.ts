// GET /api/flips: the replay of answered attacks and the saboteurs board (api/flips.ts), from the chaos records of the
// newest FLIPS_SCAN finished duels (deploy 17 `get_chaos`) and the published dataset. Cached 60 s and built once at a
// time (flipsCache); a finished duel's records are read once per process. When the chain cannot be read the last good
// body is served, and without one the dataset part with `chain_error`, so the replay never comes back empty; the dead
// RPC is asked again after 10 s, not on every request. A duel whose `get_chaos` fails is left out and counted in
// `unread`, then read again on the next build.
// ponytail: the board covers the newest FLIPS_SCAN duels; an indexer or an on-chain tally per injector when the
// chaos era outgrows that window.
import board from "../../data/board.json";
import type { Chaos } from "../../lib/abi/arena";
import type { Attack } from "../../lib/fool";
import { isChaosV2 } from "../../lib/inject";
import { chunked, readDuel } from "../duels";
import { type DuelChaos, flipsCache, replay, saboteurs } from "../flips";
import { arenaConfigAnyDeploy, arenaView, json, jsonBody } from "../near";

const SCAN = Number(process.env.FLIPS_SCAN ?? 200);
const KEEP = 2000; // finished duels' records kept in memory, ~1 KB each; the oldest goes first
const done = new Map<string, Chaos[]>();

const serve = flipsCache(build);

export async function GET() {
  try {
    return json(await serve());
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}

type ChainPart = { chain: DuelChaos[]; models: Record<string, string>; from: number; to: number; unread: number };

async function chain(): Promise<ChainPart> {
  const config = await arenaConfigAnyDeploy();
  const n = Number(config.next_duel);
  const from = Math.max(0, n - SCAN);
  if (!isChaosV2(config)) return { chain: [], models: {}, from, to: n, unread: 0 };
  const ids = Array.from({ length: n - from }, (_, i) => String(n - 1 - i));
  let unread = 0;
  const [agents, records] = await Promise.all([
    arenaView("leaderboard", { from: 0, limit: 100 }),
    chunked(ids, 8, async (id) => {
      const hit = done.get(id);
      if (hit) return hit;
      const d = await readDuel(id);
      if (!d?.resolved) return null; // open duels show live; their records still change
      const r = await arenaView("get_chaos", { duel_id: id }).catch(() => null);
      if (!r) {
        unread++; // one failed read leaves this duel out of this build, not the whole board
        return null;
      }
      done.set(id, r);
      if (done.size > KEEP) done.delete(done.keys().next().value as string);
      return r;
    }),
  ]);
  return {
    chain: ids.flatMap((duel, i) => (records[i]?.length ? [{ duel, records: records[i] }] : [])),
    models: Object.fromEntries(agents.map((a) => [a.pk, a.model_id])),
    from,
    to: n,
    unread,
  };
}

async function build(): Promise<{ body: string; ok: boolean }> {
  const recent = board.recent as Attack[];
  let c: ChainPart | null = null;
  let chain_error: string | null = null;
  try {
    c = await chain();
  } catch (e) {
    chain_error = String(e instanceof Error ? e.message : e).slice(0, 160);
  }
  const body = jsonBody({
    at: Date.now(),
    scanned: c ? { from: c.from, to: c.to } : null,
    unread: c?.unread ?? null,
    chain_error,
    flips: replay(c?.chain ?? [], recent, (pk) => c?.models[pk] ?? null),
    saboteurs: saboteurs(c?.chain ?? []),
  });
  return { body, ok: !!c };
}
