// One agent's public record, read from the arena contract on the public RPC: the agent view, its
// followers, and every duel it fought among the last SCAN duels (the contract keeps no per-agent index;
// ponytail: scan the tail, add an index in the contract when agents outgrow it). Cached 60 s per agent.
import { JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_RPC ?? "https://near-testnet.drpc.org";
const ARENA = process.env.ARENA_CONTRACT ?? "arena.nearbuddy-solver.testnet";
const SCAN = Number(process.env.AGENT_SCAN ?? 40);
const provider = new JsonRpcProvider({ url: RPC });
const view = (method: string, args: Record<string, unknown>) => provider.callFunction({ contractId: ARENA, method, args });

type Intent = { agent_pk: string; side: "Long" | "Short"; size_bps: number; nonce: string; proof_hash: string };
type Outcome = { open_price: string; close_price: string; pnl_a: number; pnl_b: number; winner: string | null; slashed: string; injections?: number };
type Duel = { id: string; a: string; b: string; symbol: string; open_at: string; close_at: string; pool: string; injections: { target: string; kind: string; payload_hash: string }[]; resolved: boolean; last_intent_a: Intent | null; last_intent_b: Intent | null; outcome?: Outcome | null; open_price?: string | null };

const cache = new Map<string, { at: number; body: string }>();

export async function GET(req: Request) {
  const pk = new URL(req.url).searchParams.get("pk");
  if (!pk) return new Response(JSON.stringify({ error: "pk required" }), { status: 400 });
  const hit = cache.get(pk);
  if (hit && Date.now() - hit.at < 60_000) return new Response(hit.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });

  const [agent, config, followers] = await Promise.all([
    view("get_agent", { agent_pk: pk }),
    view("get_config", {}) as Promise<{ next_duel: string }>,
    view("list_followers", { agent_pk: pk }),
  ]);
  const n = Number(config.next_duel);
  const ids = Array.from({ length: Math.min(SCAN, n) }, (_, i) => n - 1 - i);
  const all = (await Promise.all(ids.map((id) => view("get_duel", { duel_id: String(id) })))) as (Duel | null)[];
  const duels = all.filter((d): d is Duel => !!d && (d.a === pk || d.b === pk)).map((d) => {
    const isA = d.a === pk;
    const mine = isA ? d.last_intent_a : d.last_intent_b;
    const pnl = d.outcome ? (isA ? d.outcome.pnl_a : d.outcome.pnl_b) : null;
    const result = !d.resolved || !d.outcome ? "open" : d.outcome.winner === null ? "tie" : d.outcome.winner === pk ? "win" : "loss";
    return {
      id: d.id, opponent: isA ? d.b : d.a, symbol: d.symbol, open_at: d.open_at, close_at: d.close_at, resolved: d.resolved, result, pnl,
      side: mine?.side ?? null, size_bps: mine?.size_bps ?? null, proof_hash: mine?.proof_hash ?? null,
      open_price: d.outcome?.open_price ?? d.open_price ?? null, close_price: d.outcome?.close_price ?? null,
      slashed: result === "loss" ? d.outcome?.slashed ?? "0" : "0",
      attacks: d.resolved ? d.outcome?.injections ?? 0 : d.injections.length,
      attacks_on_me: d.resolved ? null : d.injections.filter((j) => j.target === pk).length,
    };
  });
  const body = JSON.stringify(
    { at: Date.now(), rpc: RPC, contract: ARENA, scanned: ids.length, next_duel: n, agent, followers, duels },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
  );
  cache.set(pk, { at: Date.now(), body });
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
