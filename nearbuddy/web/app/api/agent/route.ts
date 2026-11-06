// One agent's public record, read from the arena contract on the public RPC: the agent view, its
// followers, and every duel it fought among the last SCAN duels (the contract keeps no per-agent index;
// ponytail: scan the tail, add an index in the contract when agents outgrow it). Cached 60 s per agent.
import { ARENA, json, jsonBody, RPC, viewOn } from "../near";

const SCAN = Number(process.env.AGENT_SCAN ?? 40);
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
type Duel = {
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

/** Views in small chunks so a rate-limited RPC sees a trickle, not a 40-call burst. */
async function chunked<T>(items: string[], size: number, f: (id: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(f))));
  return out;
}

export async function GET(req: Request) {
  const pk = new URL(req.url).searchParams.get("pk");
  if (!pk || !PK_RE.test(pk)) return json(JSON.stringify({ error: "pk must be a 32-byte base64 key" }), 400);
  const hit = cache.get(pk);
  if (hit && Date.now() - hit.at < 60_000) return json(hit.body);
  let p = inflight.get(pk); // one scan per agent at a time; pollers share it
  if (!p) {
    p = build(pk).finally(() => inflight.delete(pk));
    inflight.set(pk, p);
  }
  try {
    return json(await p);
  } catch (e) {
    if (hit) return json(hit.body); // stale beats a 500 while the RPC is throttled
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}

async function build(pk: string): Promise<string> {
  const [agent, config, followers] = await Promise.all([
    view("get_agent", { agent_pk: pk }),
    view("get_config", {}) as Promise<{ next_duel: string; slash_bps: number; min_chaos_deposit: string }>,
    view("list_followers", { agent_pk: pk }),
  ]);
  const n = Number(config.next_duel);
  // deploy 10 keeps a per-agent duel index (newest first); agents whose index is empty (duels before the
  // index existed) fall back to scanning the tail of all duels.
  let ids: string[] = [];
  try {
    ids = ((await view("agent_duels", { agent_pk: pk, from: 0, limit: SCAN })) as string[]).map(String);
  } catch {
    /* view missing before deploy 10 */
  }
  const indexed = ids.length > 0;
  if (!indexed) ids = Array.from({ length: Math.min(SCAN, n) }, (_, i) => String(n - 1 - i));
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
        result,
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
  const body = jsonBody({
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
  });
  cache.set(pk, { at: Date.now(), body });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string); // oldest entry out
  return body;
}
