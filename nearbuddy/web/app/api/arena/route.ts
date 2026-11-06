// Read-only arena snapshot from the public RPC: config, leaderboard, the last 3 duels in full, followers
// per agent, and counts over the last SCAN duels (verified decisions, attacks). The solver's /arena route
// is optional enrichment (intent txs, injection payloads, quotes, fills); the page renders without it.
// Cached 20 s and built once at a time however many tabs poll; a stale body beats a 500 while the RPC
// is throttled. Resolved duels never change, so they are kept in memory and not re-read.
// `eras` splits each agent's alpha at ORACLE_ERA_FROM: every oracle-era duel is read (once, then memoised)
// and summed per agent; the operator-era alpha is the contract's lifetime alpha minus that sum.
// ponytail: reads every oracle-era duel on a cold start; a per-era tally in the contract or an indexer
// when that runs into thousands.
import { proven as hasProof } from "../../cells";
import { eraSplit, ORACLE_ERA_FROM, oracleIds, type ScoredDuel } from "../../eras";
import { chunked, readDuel } from "../duels";
import { ARENA, json, jsonBody, RPC, SOLVER_URL, viewOn } from "../near";

const SCAN = Number(process.env.ARENA_SCAN ?? 40);
const SHOW = 3;
const TTL = 20_000;
const view = viewOn(ARENA);

type Intent = { proof_hash?: string };
type Duel = ScoredDuel & {
  id: string;
  resolved: boolean;
  injections: unknown[];
  last_intent_a: Intent | null;
  last_intent_b: Intent | null;
  outcome?: { injections?: number } | null;
};
const ZERO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

let cache: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return json(cache.body);
  if (!inflight)
    inflight = build().finally(() => {
      inflight = null;
    });
  try {
    return json(await inflight);
  } catch (e) {
    if (cache) return json(cache.body);
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}

async function build(): Promise<string> {
  const config = (await view("get_config", {})) as { next_duel: string; no_reveal_bps?: number };
  const n = Number(config.next_duel);
  const ids = Array.from({ length: Math.min(SCAN, n) }, (_, i) => String(n - 1 - i));
  const [leaderboard, solver] = await Promise.all([
    view("leaderboard", {}) as Promise<{ pk: string; alpha_bps: number }[]>,
    fetch(`${SOLVER_URL}/arena`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null),
  ]);
  const want = [...new Set([...ids, ...oracleIds(n)])]; // the SCAN tail and the oracle era overlap: read once
  const read = await chunked(want, 8, (id) => readDuel<Duel>(id, config.no_reveal_bps != null));
  const byId = new Map(want.map((id, i) => [id, read[i] ?? null]));
  const scanned = ids.map((id) => byId.get(id) ?? null);
  const oracle = oracleIds(n).map((id) => byId.get(id) ?? null);
  const eras = {
    from: ORACLE_ERA_FROM,
    operator_duels: Math.min(ORACLE_ERA_FROM, n),
    oracle_duels: oracle.filter((d) => d?.resolved).length,
    by_agent: eraSplit(
      leaderboard,
      oracle.filter((d): d is Duel => !!d),
    ),
  };
  const followers = Object.fromEntries(
    await Promise.all(leaderboard.map(async (a) => [a.pk, await view("list_followers", { agent_pk: a.pk })])),
  );
  const seen = scanned.filter((d): d is Duel => !!d);
  const proven = (i: Intent | null) => hasProof(i, ZERO);
  const stats = {
    scanned: seen.length,
    verified_decisions: seen.reduce((s, d) => s + Number(proven(d.last_intent_a)) + Number(proven(d.last_intent_b)), 0),
    attacks: seen.reduce((s, d) => s + (d.resolved ? (d.outcome?.injections ?? 0) : d.injections.length), 0),
  };
  const body = jsonBody({
    at: Date.now(),
    rpc: RPC,
    contract: ARENA,
    config,
    leaderboard,
    duels: scanned.slice(0, SHOW),
    stats,
    eras,
    followers,
    solver,
  });
  cache = { at: Date.now(), body };
  return body;
}
