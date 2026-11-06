// One agent's public record, read from the arena contract on the public RPC: the agent view, its
// followers, and the duels it fought in one scoring era: from ORACLE_ERA_FROM on (TEE oracle, default) or,
// with ?era=operator, before it (operator key). `eras` always carries the oracle-era tally and the
// operator-era remainder of the lifetime alpha. Cached 60 s per agent and era. The solver's GET /execution
// (optional) adds the priced fills of this agent's followers.
// ponytail: scans every duel of the era (memoised once resolved); a per-agent era tally in the contract or
// an indexer when duel counts reach the thousands.
import type { Fill } from "../../cells";
import { isVoid, ORACLE_ERA_FROM, operatorIds, oracleIds, type ScoredDuel, tally, unread } from "../../eras";
import { chunked, readDuel } from "../duels";
import { ARENA, json, jsonBody, RPC, SOLVER_URL, viewOn } from "../near";

const view = viewOn(ARENA);

type Intent = { agent_pk: string; side: "Long" | "Short"; size_bps: number; nonce: string; proof_hash: string };
type Outcome = {
  open_price: string;
  close_price: string;
  pnl_a: number;
  pnl_b: number;
  winner: string | null;
  slashed: string;
  injections?: number;
};
type Duel = ScoredDuel & {
  id: string;
  a: string;
  b: string;
  symbol: string;
  open_at: string;
  close_at: string;
  pool: string;
  injections: { target: string; kind: string; payload_hash: string }[];
  resolved: boolean;
  last_intent_a: Intent | null;
  last_intent_b: Intent | null;
  outcome?: Outcome | null;
  open_price?: string | null;
};

const cache = new Map<string, { at: number; body: string }>();
const inflight = new Map<string, Promise<string>>();
const PK_RE = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, standard base64

export async function GET(req: Request) {
  const pk = new URL(req.url).searchParams.get("pk");
  if (!pk || !PK_RE.test(pk)) return json(JSON.stringify({ error: "pk must be a 32-byte base64 key" }), 400);
  const era = new URL(req.url).searchParams.get("era") === "operator" ? "operator" : "oracle";
  const key = `${pk}:${era}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return json(hit.body);
  let p = inflight.get(key); // one scan per agent and era at a time; pollers share it
  if (!p) {
    p = build(pk, era).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    return json(await p);
  } catch (e) {
    if (hit) return json(hit.body); // stale beats a 500 while the RPC is throttled
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}

async function build(pk: string, era: "oracle" | "operator"): Promise<string> {
  const [agent, config, followers, fills] = await Promise.all([
    view("get_agent", { agent_pk: pk }) as Promise<{ alpha_bps: number } | null>,
    view("get_config", {}) as Promise<{
      next_duel: string;
      slash_bps: number;
      min_chaos_deposit: string;
      no_reveal_bps?: number;
    }>,
    view("list_followers", { agent_pk: pk }) as Promise<[string, unknown][]>,
    fetch(`${SOLVER_URL}/execution`, { cache: "no-store", signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .then((j: { quality?: Fill[] }) => (Array.isArray(j?.quality) ? j.quality : null))
      .catch(() => null), // solver offline or before batched RFQ
  ]);
  const followed = new Set(followers.map(([w]) => w));
  const execution = fills?.filter((f) => followed.has(f.follower)) ?? null;
  const n = Number(config.next_duel);
  // Era ranges are scanned, not read from agent_duels: the live index holds only an agent's recent duels
  // (8dPZ: 20 ids from #324 against 63 oracle-era duels), so it cannot carry a per-era sum. Resolved duels
  // are memoised in ../duels, shared with /api/arena, so a warm process reads only the open ones.
  const nr = config.no_reveal_bps != null;
  const readAll = (list: string[]) => chunked(list, 8, (id) => readDuel<Duel>(id, nr));
  const ours = (ds: (Duel | null)[]) => ds.filter((d): d is Duel => !!d && (d.a === pk || d.b === pk));
  const ids = era === "oracle" ? oracleIds(n) : operatorIds(n);
  const oracleReads = await readAll(oracleIds(n));
  const oracleDuels = ours(oracleReads);
  const mine = era === "oracle" ? oracleDuels : ours(await readAll(ids));
  const oracle = tally(pk, oracleDuels);
  const missing = unread(oracleReads, nr); // a failed read may be one of this agent's: the split waits for it
  const eras = {
    from: ORACLE_ERA_FROM,
    complete: missing === 0,
    unread: missing,
    oracle,
    operator: {
      // lifetime alpha minus the oracle-era sum: what the operator-scored duels left in the contract's alpha
      alpha_bps: agent ? agent.alpha_bps - oracle.alpha_bps : null,
      duels: Math.min(n, ORACLE_ERA_FROM), // every operator-era duel, excluded from the headline
      mine: era === "operator" ? mine.length : null, // this agent's share, counted when that era is read
    },
  };
  const duels = mine.map((d) => {
    const isA = d.a === pk;
    const it = isA ? d.last_intent_a : d.last_intent_b;
    const pnl = d.outcome ? (isA ? d.outcome.pnl_a : d.outcome.pnl_b) : null;
    const result =
      !d.resolved || !d.outcome
        ? "open"
        : isVoid(d.outcome)
          ? "void"
          : d.outcome.winner === null
            ? "tie"
            : d.outcome.winner === pk
              ? "win"
              : "loss";
    return {
      id: d.id,
      opponent: isA ? d.b : d.a,
      symbol: d.symbol,
      open_at: d.open_at,
      close_at: d.close_at,
      resolved: d.resolved,
      result,
      pnl,
      side: it?.side ?? null,
      size_bps: it?.size_bps ?? null,
      proof_hash: it?.proof_hash ?? null,
      open_price: d.outcome?.open_price ?? d.open_price ?? null,
      close_price: d.outcome?.close_price ?? null,
      slashed: result === "loss" ? (d.outcome?.slashed ?? "0") : "0",
      attacks: d.resolved ? (d.outcome?.injections ?? 0) : d.injections.length,
      attacks_on_me: d.resolved ? null : d.injections.filter((j) => j.target === pk).length,
    };
  });
  const body = jsonBody({
    at: Date.now(),
    rpc: RPC,
    contract: ARENA,
    scanned: ids.length,
    era,
    eras,
    next_duel: n,
    slash_bps: config.slash_bps,
    min_chaos_deposit: config.min_chaos_deposit,
    agent,
    followers,
    duels,
    execution,
  });
  cache.set(`${pk}:${era}`, { at: Date.now(), body });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string); // oldest entry out
  return body;
}
