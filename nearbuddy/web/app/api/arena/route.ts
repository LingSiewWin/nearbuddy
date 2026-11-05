// Read-only arena snapshot from the public RPC: config, leaderboard, last duels, followers per
// agent. The solver's /arena route is optional enrichment (injection payloads, quotes, fills);
// the page renders without it.
import { JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_RPC ?? "https://near-testnet.drpc.org"; // rpc.testnet.near.org is deprecated (429); fastnear rate-limits bursts
const ARENA = process.env.ARENA_CONTRACT ?? "arena.nearbuddy-solver.testnet";
const SOLVER_URL = process.env.SOLVER_URL ?? "http://127.0.0.1:4020";
const provider = new JsonRpcProvider({ url: RPC });
const view = (method: string, args: Record<string, unknown>) => provider.callFunction({ contractId: ARENA, method, args });

export async function GET() {
  const config = (await view("get_config", {})) as { next_duel: string };
  const n = Number(config.next_duel);
  const ids = Array.from({ length: Math.min(5, n) }, (_, i) => n - 1 - i);
  const [leaderboard, duels, solver] = await Promise.all([
    view("leaderboard", {}) as Promise<{ pk: string }[]>,
    Promise.all(ids.map((id) => view("get_duel", { duel_id: String(id) }))),
    fetch(`${SOLVER_URL}/arena`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
  ]);
  const followers = Object.fromEntries(
    await Promise.all(leaderboard.map(async (a) => [a.pk, await view("list_followers", { agent_pk: a.pk })])),
  );
  const body = JSON.stringify(
    { at: Date.now(), rpc: RPC, contract: ARENA, config, leaderboard, duels, followers, solver },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
  );
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
