// POST {payload}: relay a headline to the solver (see ../chaos.ts), deploy 16.1 only. Deploy 17 stores the headline
// on chain, so the relay is off there: 410, and the solver is never called.
import { isChaosV2 } from "../../lib/inject";
import { relayChaos } from "../chaos";
import { arenaConfigAnyDeploy, json, SOLVER_URL } from "../near";

let deploy: { at: number; v2: boolean } | null = null;
/** Whether the arena is deploy 17, read at most once a minute; an unreadable config keeps the last answer. */
async function chaosV2(): Promise<boolean> {
  if (deploy && Date.now() - deploy.at < 60_000) return deploy.v2;
  const v2 = await arenaConfigAnyDeploy()
    .then((c) => isChaosV2(c))
    .catch(() => deploy?.v2 ?? false);
  deploy = { at: Date.now(), v2 };
  return v2;
}

export async function POST(req: Request) {
  if (await chaosV2())
    return json(
      JSON.stringify({ error: "this arena stores the headline on chain: sign inject_chaos with it, no relay needed" }),
      410,
    );
  return relayChaos(req, SOLVER_URL);
}
