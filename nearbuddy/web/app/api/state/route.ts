// Read-only snapshot: contract config, vault, solver, mandate (optional), and the local solver's ledger.
import { CONTRACT, json, jsonBody, provider, RPC, SOLVER_URL, vaultView } from "../near";

const OWNER = process.env.OWNER_ID ?? "nearbuddy-owner.testnet";
const SOLVER = process.env.SOLVER_ID ?? "nearbuddy-solver.testnet";
const API = process.env.API_ID ?? "nearbuddy-api.testnet";

export async function GET(req: Request) {
  const agentPk = new URL(req.url).searchParams.get("agent_pk");
  const [config, vault, solver, mandate, apiAcc, ledger] = await Promise.all([
    vaultView("get_config", {}),
    vaultView("get_vault", { owner: OWNER }),
    vaultView("get_solver", { solver: SOLVER }),
    agentPk ? vaultView("get_mandate", { agent_pk: agentPk }) : Promise.resolve(null),
    provider
      .viewAccount({ accountId: API })
      .then((a) => String(a.amount))
      .catch(() => null),
    fetch(`${SOLVER_URL}/ledger`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null),
  ]);
  return json(
    jsonBody({
      at: Date.now(),
      rpc: RPC,
      contract: CONTRACT,
      owner: OWNER,
      solverId: SOLVER,
      api: API,
      config,
      vault,
      solver,
      mandate,
      apiBalance: apiAcc,
      ledger,
    }),
  );
}
