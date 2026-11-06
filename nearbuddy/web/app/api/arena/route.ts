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
import { eraSplit, ORACLE_ERA_FROM, oracleIds, type ScoredDuel, unread } from "../../eras";
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

type Board = { pk: string; alpha_bps: number }[];
const PAGE = 100; // deploy 15 pages `leaderboard` at <= 100; deploy 14 ignores {from, limit} and returns everyone
/** Every registered agent, in the contract's (lifetime) order: the era ranking needs the whole board, since an
 *  agent strong from duel 257 on can sit past the first page by lifetime alpha. */
async function fullBoard(): Promise<Board> {
  const all: Board = [];
  const seen = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const page = (await view("leaderboard", { from, limit: PAGE })) as Board;
    const fresh = page.filter((a) => !seen.has(a.pk));
    for (const a of fresh) {
      seen.add(a.pk);
      all.push(a);
    }
    if (page.length < PAGE || !fresh.length) return all; // a short page, or args ignored (same page again)
  }
}

async function build(): Promise<string> {
  const config = (await view("get_config", {})) as { next_duel: string; no_reveal_bps?: number };
  const n = Number(config.next_duel);
  const ids = Array.from({ length: Math.min(SCAN, n) }, (_, i) => String(n - 1 - i));
  const [leaderboard, solver] = await Promise.all([
    fullBoard(),
    fetch(`${SOLVER_URL}/arena`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null),
  ]);
  const want = [...new Set([...ids, ...oracleIds(n)])]; // the SCAN tail and the oracle era overlap: read once
  const read = await chunked(want, 8, (id) => readDuel<Duel>(id, config.no_reveal_bps != null));
  const byId = new Map(want.map((id, i) => [id, read[i] ?? null]));
  const scanned = ids.map((id) => byId.get(id) ?? null);
  const oracle = oracleIds(n).map((id) => byId.get(id) ?? null);
  const missing = unread(oracle, config.no_reveal_bps != null);
  const eras = {
    from: ORACLE_ERA_FROM,
    complete: missing === 0, // false: rank by lifetime until every oracle-era duel is read
    unread: missing,
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
