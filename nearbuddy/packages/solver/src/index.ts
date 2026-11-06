// Solver entry: load the account, build the facilitator (server.ts), guarantor and arena, listen.
import "../../protocol/src/env.ts";
import "./state.ts"; // before arena.ts: sets its per-network file paths
import { createServer as httpServer } from "node:http";
import { CONTRACT, loadAccount } from "../../protocol/src/chain.ts";
import { NET } from "../../protocol/src/network.ts";
import { Arena } from "./arena.ts";
import { Guarantor } from "./guarantor.ts";
import { createServer } from "./server.ts";
import { LEDGER_FILE } from "./state.ts";

const SOLVER_ID = process.env.SOLVER_ID ?? NET.solver;
const PORT = Number(process.env.SOLVER_PORT ?? 4020);
const AUTO_BATCH = Number(process.env.SOLVER_AUTO_BATCH ?? 200); // settle when carrying this many
const AUTO_AGE_MS = Number(process.env.SOLVER_AUTO_AGE_MS ?? 60_000); // or when the oldest IOU is this old
const account = loadAccount(SOLVER_ID);
// Guarantor layer: POST /guarantee, POST /pull, POST /settle_pulls, GET /guarantor (see guarantor.ts).
const guarantor = new Guarantor(account, SOLVER_ID);
// Arena: POST /duel, /intent, /chaos, /resolve, /settle_follow, GET /arena (see arena.ts).
const arena = new Arena(account, SOLVER_ID);
void arena.bootstrap();
// PAIR_EVERY_S > 0: pair idle enclave agents into duels every N seconds (self-hosted runners wait on GET /agent_duel).
arena.startPairing(Number(process.env.PAIR_EVERY_S ?? 0));

const server = createServer({
  solverId: SOLVER_ID,
  account,
  guarantor,
  arena,
  ledgerFile: LEDGER_FILE,
  autoBatch: AUTO_BATCH,
  autoAgeMs: AUTO_AGE_MS,
});
server.start();
httpServer(server.handler).listen(PORT, () =>
  console.log(
    `[solver] ${SOLVER_ID} facilitator on :${PORT}, contract ${CONTRACT}, auto-settle at ${AUTO_BATCH} IOUs or ${AUTO_AGE_MS / 1000}s`,
  ),
);
