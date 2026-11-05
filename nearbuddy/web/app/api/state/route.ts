// Read-only snapshot: contract config, vault, solver, mandate (optional), and the local solver's ledger.
import { JsonRpcProvider } from "near-api-js";


const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const CONTRACT = process.env.NEARBUDDY_CONTRACT ?? "nearbuddy-vault.testnet";
const OWNER = process.env.OWNER_ID ?? "nearbuddy-owner.testnet";
const SOLVER = process.env.SOLVER_ID ?? "nearbuddy-solver.testnet";
const API = process.env.API_ID ?? "nearbuddy-api.testnet";
const SOLVER_URL = process.env.SOLVER_URL ?? "http://127.0.0.1:4020";
const provider = new JsonRpcProvider({ url: RPC });

const view = (method: string, args: Record<string, unknown>) =>
  provider.callFunction({ contractId: CONTRACT, method, args });

export async function GET(req: Request) {
  const agentPk = new URL(req.url).searchParams.get("agent_pk");
  const [config, vault, solver, mandate, apiAcc, ledger] = await Promise.all([
    view("get_config", {}),
    view("get_vault", { owner: OWNER }),
    view("get_solver", { solver: SOLVER }),
    agentPk ? view("get_mandate", { agent_pk: agentPk }) : Promise.resolve(null),
    provider.viewAccount({ accountId: API }).then((a) => String(a.amount)).catch(() => null),
    fetch(`${SOLVER_URL}/ledger`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
  ]);
  // near-api-js returns bigint in some view responses; stringify them.
  const body = JSON.stringify(
    { at: Date.now(), rpc: RPC, contract: CONTRACT, owner: OWNER, solverId: SOLVER, api: API,
      config, vault, solver, mandate, apiBalance: apiAcc, ledger },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
  );
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
