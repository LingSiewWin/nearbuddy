// One agent's public record, read from the arena contract on the public RPC: the agent view, its
// followers, and every duel it fought among the last SCAN duels (the contract keeps no per-agent index;
// ponytail: scan the tail, add an index in the contract when agents outgrow it). Cached 60 s per agent;
// pollers share one in-flight scan, and a stale record beats an error while the RPC is throttled.
// The solver's GET /execution (optional) adds the priced fills of this agent's followers.
// `agentSummary()` is the v1 shape: human units, the record over those duels, followers' mandates, how the
// agent met attacks and its latest decisions with reasoning from the published dataset.
import type { Fill } from "../cells";
import { calls } from "../lib/rows";
import { tally } from "../lib/verdict";
import { type Agent, type Duel, type Mandate, ms, nearOf, snapshot } from "./arena";
import { getDecisions } from "./dataset";
import { ARENA, RPC, SOLVER_URL, viewOn } from "./near";

const SCAN = Number(process.env.AGENT_SCAN ?? 40);
const TTL = 60_000;
const view = viewOn(ARENA);
export const PK_RE = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, standard base64

/** A key from a URL path segment (percent-encoded or not), or null when it is not a 32-byte base64 key. */
export function parsePk(raw: string): string | null {
  try {
    const pk = decodeURIComponent(raw);
    return PK_RE.test(pk) ? pk : null;
  } catch {
    return null;
  }
}

const cache = new Map<string, { at: number; rec: AgentRecord }>();
const inflight = new Map<string, Promise<AgentRecord>>();

/** Views in small chunks so a rate-limited RPC sees a trickle, not a 40-call burst. */
async function chunked<T>(items: string[], size: number, f: (id: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(f))));
  return out;
}

async function build(pk: string) {
  const [agent, config, followers, fills] = await Promise.all([
    view("get_agent", { agent_pk: pk }) as Promise<Agent | null>,
    view("get_config", {}) as Promise<{ next_duel: string; slash_bps: number; min_chaos_deposit: string }>,
    view("list_followers", { agent_pk: pk }) as Promise<[string, Mandate][]>,
    fetch(`${SOLVER_URL}/execution`, { cache: "no-store", signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .then((j: { quality?: Fill[] }) => (Array.isArray(j?.quality) ? j.quality : null))
      .catch(() => null), // solver offline or before batched RFQ
  ]);
  const mine = new Set(followers.map(([w]) => w));
  const execution = fills?.filter((f) => mine.has(f.follower)) ?? null;
  const n = Number(config.next_duel);
  // deploy 10 keeps a per-agent duel index (newest first); agents whose index is empty (duels before the
  // index existed) fall back to scanning the tail of all duels. An unregistered key scans nothing.
  let ids: string[] = [];
  try {
    if (agent) ids = ((await view("agent_duels", { agent_pk: pk, from: 0, limit: SCAN })) as string[]).map(String);
  } catch {
    /* view missing before deploy 10 */
  }
  const indexed = ids.length > 0;
  if (agent && !indexed) ids = Array.from({ length: Math.min(SCAN, n) }, (_, i) => String(n - 1 - i));
  const all = (await chunked(ids, 8, (id) => view("get_duel", { duel_id: id }))) as (Duel | null)[];
  const duels = all
    .filter((d): d is Duel => !!d && (d.a === pk || d.b === pk))
    .map((d) => {
      const isA = d.a === pk;
      const mine = isA ? d.last_intent_a : d.last_intent_b;
      const pnl = d.outcome ? (isA ? d.outcome.pnl_a : d.outcome.pnl_b) : null;
      const result =
        !d.resolved || !d.outcome
          ? "open"
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
        result: result as "open" | "tie" | "win" | "loss",
        pnl,
        side: mine?.side ?? null,
        size_bps: mine?.size_bps ?? null,
        proof_hash: mine?.proof_hash ?? null,
        open_price: d.outcome?.open_price ?? d.open_price ?? null,
        close_price: d.outcome?.close_price ?? null,
        slashed: result === "loss" ? (d.outcome?.slashed ?? "0") : "0",
        attacks: d.resolved ? (d.outcome?.injections ?? 0) : d.injections.length,
        attacks_on_me: d.resolved ? null : d.injections.filter((j) => j.target === pk).length,
      };
    });
  return {
    at: Date.now(),
    rpc: RPC,
    contract: ARENA,
    scanned: ids.length,
    indexed,
    next_duel: n,
    slash_bps: config.slash_bps,
    min_chaos_deposit: config.min_chaos_deposit,
    agent,
    followers,
    duels,
    execution,
  };
}
export type AgentRecord = Awaited<ReturnType<typeof build>>;
const EMPTY: AgentRecord = {
  at: 0,
  rpc: RPC,
  contract: ARENA,
  scanned: 0,
  indexed: false,
  next_duel: 0,
  slash_bps: 0,
  min_chaos_deposit: "0",
  agent: null,
  followers: [],
  duels: [],
  execution: null,
};

/** The raw record (contract units) for a key already checked against PK_RE. */
export async function agentRecord(pk: string): Promise<AgentRecord> {
  const hit = cache.get(pk);
  if (hit && Date.now() - hit.at < TTL) return hit.rec;
  // the leaderboard lists every registered agent: an unknown key costs no RPC call and evicts nothing
  if (!hit && !(await snapshot()).leaderboard.some((a) => a.pk === pk))
    return { ...EMPTY, at: Date.now(), rpc: RPC, contract: ARENA };
  let p = inflight.get(pk); // one scan per agent at a time; pollers share it
  if (!p) {
    p = build(pk)
      .then((rec) => {
        cache.set(pk, { at: rec.at, rec });
        if (cache.size > 200) cache.delete(cache.keys().next().value as string); // oldest entry out
        return rec;
      })
      .finally(() => inflight.delete(pk));
    inflight.set(pk, p);
  }
  if (hit) {
    p.catch(() => {}); // stale beats waiting while the RPC is throttled; the refresh lands for the next poll
    return hit.rec;
  }
  return p;
}

// ---------- v1: human units ----------
export async function agentSummary(pk: string) {
  const [r, rows] = await Promise.all([agentRecord(pk), getDecisions()]);
  const a = r.agent;
  if (!a) return null;
  const mine = rows.filter((d) => d.agent === pk);
  const attacked = mine.filter((d) => d.attack);
  const done = r.duels.filter((d) => d.result !== "open");
  const count = (x: string) => done.filter((d) => d.result === x).length;
  return {
    at: r.at,
    network: "testnet",
    contract: r.contract,
    agent: a.pk,
    model: a.model_id,
    owner: a.owner,
    prompt: mine.at(-1)?.arm ?? null,
    verified: a.tee,
    return_pct: a.alpha_bps / 100,
    bond_near: nearOf(a.bond),
    in_duel: a.in_duel == null ? null : Number(a.in_duel),
    record: { won: count("win"), lost: count("loss"), tied: count("tie"), window: done.length },
    attacks: tally(attacked),
    calls: calls(mine),
    followers: r.followers.map(([account, m]) => ({
      account,
      cap_near: nearOf(m.per_tx_cap),
      spent_near: nearOf(m.spent),
      allowance_near: nearOf(m.allowance),
      revoked: m.revoked,
      expires_at: ms(m.expires_at),
    })),
    duels: r.duels.map((d) => ({
      duel: Number(d.id),
      closed_at: ms(d.close_at), // scheduled close while the result is still open
      opponent: d.opponent,
      side: d.side,
      size_pct: d.size_bps == null ? null : d.size_bps / 100,
      return_pct: d.pnl == null ? null : d.pnl / 100,
      result: d.result,
      attacks: d.attacks,
    })),
    decisions: mine.slice(-20).reverse(),
  };
}
export type AgentSummary = NonNullable<Awaited<ReturnType<typeof agentSummary>>>;
