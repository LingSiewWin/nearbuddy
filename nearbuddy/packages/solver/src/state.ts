// Per-network state files of the solver process. Imported by index.ts before arena.ts, which reads ARENA_HISTORY and
// ARENA_PAYLOADS when it loads; testnet keeps today's names, mainnet gets `-mainnet` (networkFile).
import { networkFile } from "../../protocol/src/network.ts";

const root = (name: string) => networkFile(new URL(`../../../${name}`, import.meta.url).pathname);
export const LEDGER_FILE = process.env.SOLVER_LEDGER ?? root(".solver-ledger.json");
process.env.ARENA_HISTORY ??= root(".arena-history.json");
process.env.ARENA_PAYLOADS ??= root(".arena-payloads.json");
