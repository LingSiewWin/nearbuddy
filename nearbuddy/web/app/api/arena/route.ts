// Read-only arena snapshot from the public RPC: config, leaderboard, the last 3 duels and every older open one in full (on deploy 17 with
// their `get_chaos` records and `chaos_fee`), followers
// per agent, and counts over the last SCAN duels (verified decisions, attacks). The solver's /arena route
// is optional enrichment (intent txs, injection payloads, quotes, fills); the page renders without it.
// Cached 20 s and built once at a time however many tabs poll; a stale body beats a 500 while the RPC
// is throttled. Resolved duels never change, so they are kept in memory and not re-read.
// `eras` splits each agent's alpha at ORACLE_ERA_FROM: every oracle-era duel is read (once, then memoised)
// and summed per agent; the operator-era alpha is the contract's lifetime alpha minus that sum.
// ponytail: reads every oracle-era duel on a cold start; a per-era tally in the contract or an indexer
// when that runs into thousands.
import { proven as hasProof, pairsOf } from "../../cells";
import { eraSplit, ORACLE_ERA_FROM, oracleIds, unread } from "../../eras";
import type { AgentView, Intent } from "../../lib/abi/arena";
import { isChaosV2 } from "../../lib/inject";
import { chaosOf, chunked, type ReadDuel, readDuel, shownDuels } from "../duels";
import { followersOf } from "../followers";
import { ARENA, arenaConfigAnyDeploy, arenaView, json, jsonBody, legacyArenaView, RPC, SOLVER_URL } from "../near";

const SCAN = Number(process.env.ARENA_SCAN ?? 40);
const SHOW = 3;
const TTL = 20_000;
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

const PAGE = 100; // deploy 15 pages `leaderboard` at <= 100; deploy 14 ignores {from, limit} and returns everyone
/** Every registered agent, in the contract's (lifetime) order: the era ranking needs the whole board, since an
 *  agent strong from duel 257 on can sit past the first page by lifetime alpha. */
async function fullBoard(): Promise<AgentView[]> {
  const all: AgentView[] = [];
  const seen = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const page = await arenaView("leaderboard", { from, limit: PAGE });
    const fresh = page.filter((a) => !seen.has(a.pk));
    for (const a of fresh) {
      seen.add(a.pk);
      all.push(a);
    }
    if (page.length < PAGE || !fresh.length) return all; // a short page, or args ignored (same page again)
  }
}

async function build(): Promise<string> {
  const config = await arenaConfigAnyDeploy();
  const n = Number(config.next_duel);
  const ids = Array.from({ length: Math.min(SCAN, n) }, (_, i) => String(n - 1 - i));
  const [leaderboard, solver] = await Promise.all([
    fullBoard(),
    fetch(`${SOLVER_URL}/arena`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null),
  ]);
  const want = [...new Set([...ids, ...oracleIds(n)])]; // the SCAN tail and the oracle era overlap: read once
  // no_reveal_bps is absent before commit-reveal (deploy 14): no get_no_reveal to read
  const read = await chunked(want, 8, (id) => readDuel(id, config.no_reveal_bps != null));
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
      oracle.filter((d): d is ReadDuel => !!d),
    ),
  };
  const followers = Object.fromEntries(
    await Promise.all(leaderboard.map(async (a) => [a.pk, await followersOf(legacyArenaView, a.pk)])),
  );
  const seen = scanned.filter((d): d is ReadDuel => !!d);
  const proven = (i: Intent | null) => hasProof(i, ZERO);
  const stats = {
    scanned: seen.length,
    verified_decisions: seen.reduce((s, d) => s + Number(proven(d.last_intent_a)) + Number(proven(d.last_intent_b)), 0),
    attacks: seen.reduce((s, d) => s + (d.resolved ? (d.outcome?.injections ?? 0) : d.injections.length), 0),
    pairs: pairsOf(seen), // who has been dueling whom in the last SCAN duels
  };
  // the newest SHOW plus every open one (the next to close may be older). Deploy 17: the shown duels carry their chaos
  // records and next price; a failed read leaves them null (no price, so nothing can be signed against a stale one)
  const v2 = isChaosV2(config);
  const duels = await Promise.all(
    shownDuels(scanned, SHOW).map(async (d) =>
      d && v2 ? { ...d, ...(await chaosOf(d.id).catch(() => ({ chaos: null, chaos_fee: null }))) } : d,
    ),
  );
  const body = jsonBody({
    at: Date.now(),
    rpc: RPC,
    contract: ARENA,
    config,
    leaderboard,
    duels,
    stats,
    eras,
    followers,
    solver,
  });
  cache = { at: Date.now(), body };
  return body;
}
