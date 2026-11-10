// /api/mcp: the NearBuddy MCP server (Streamable HTTP, stateless). Tools in ./tools.ts; they read this site's own
// API routes (same caches as the page) and the arena's views. No key lives here and nothing is signed: `inject`,
// `claim` and `enter` return unsigned calls for the agent's own wallet.
import { createMcpHandler } from "mcp-handler";
import board from "../../data/board.json";
import { NET, NETWORK_ID } from "../../network";
import { REPO } from "../../tui";
import { GET as agentRoute } from "../agent/route";
import { GET as arenaRoute } from "../arena/route";
import { relayChaos } from "../chaos";
import { GET as duelRoute } from "../duel/route";
import { KEYLESS_ARENA, pinnedModels } from "../keyless";
import { arenaView, SOLVER_URL } from "../near";
import { type Reader, register } from "./tools";

/** A route's JSON body, or its error as an exception (the tool call then fails with that message). */
const body = async <T>(r: Response): Promise<T> => {
  const j = await r.json();
  if (!r.ok) throw new Error(String((j as { error?: unknown }).error ?? `HTTP ${r.status}`));
  return j as T;
};
const local = (path: string) => new Request(`http://mcp.local${path}`);

const read: Reader = {
  network: NETWORK_ID,
  explorer: NET.explorer,
  repo: REPO,
  arena: async () => body(await arenaRoute()),
  duel: async (id) => body(await duelRoute(local(`/api/duel?id=${encodeURIComponent(id)}`))),
  agent: async (pk) => body(await agentRoute(local(`/api/agent?pk=${encodeURIComponent(pk)}`))),
  board: () => board,
  fee: (id) => arenaView("chaos_fee", { duel_id: id }),
  // deploy 16.1: the browser's POST /api/chaos, called in process; MCP callers share one rate-limit bucket
  fetcher: ((path: string, init?: RequestInit) =>
    relayChaos(new Request(`http://mcp.local${path}`, init), SOLVER_URL, "mcp")) as typeof fetch,
  keyless: async () => ({ contract: KEYLESS_ARENA, models: await pinnedModels() }),
};

const handler = createMcpHandler((server) => register(server, read), {
  serverInfo: { name: "nearbuddy", version: "1.0.0" },
  maxSubscriptions: 0, // the tool list never changes; refuse subscriptions/listen instead of holding a stream open
  instructions:
    "NearBuddy 'Fool the AI' on NEAR: read the arena, then plant a fake headline in one AI trader with inject (an unsigned transaction you sign with your own account). Start with the arena tool.",
});

export const maxDuration = 30; // seconds: no unauthenticated call can keep a function alive longer
export { handler as GET, handler as POST };
