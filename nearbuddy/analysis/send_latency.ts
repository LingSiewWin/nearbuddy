// Where does a swap's client time go? Time the same wrap.testnet calls across RPC endpoints and wait modes,
// single tx vs two actions batched in one tx. Writes analysis/data/send_latency.jsonl and prints p50/p95.
//   RUNS=10 bun analysis/send_latency.ts            (spends ~0.001 NEAR per run from SENDER, default nearbuddy-solver.testnet)
import "../packages/protocol/src/env.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { Account, actions, JsonRpcProvider, teraToGas } from "near-api-js";
import { loadKey } from "../packages/protocol/src/chain.ts";

const SENDER = process.env.SENDER ?? "nearbuddy-solver.testnet";
const DEP = process.env.DEP ?? "nearbuddy-owner.testnet"; // stands in for the 1Click deposit address
const RUNS = Number(process.env.RUNS ?? 10);
const RPCS = (
  process.env.RPCS ?? "https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://rpc.testnet.near.org"
).split(",");
const WAITS = ["EXECUTED_OPTIMISTIC", "FINAL"] as const;
const key = loadKey(SENDER);
const out = new URL("./data/send_latency.jsonl", import.meta.url).pathname;
mkdirSync(new URL("./data/", import.meta.url).pathname, { recursive: true });

const wrapDeposit = actions.functionCall("near_deposit", {}, teraToGas("30"), 1_000_000_000_000_000_000_000n); // 0.001 NEAR
const storageDep = actions.functionCall(
  "storage_deposit",
  { account_id: DEP },
  teraToGas("30"),
  1_250_000_000_000_000_000_000n,
);
const xfer = actions.functionCall(
  "ft_transfer",
  { receiver_id: DEP, amount: "1000000000000000000000" },
  teraToGas("30"),
  1n,
);

async function blockTime(provider: JsonRpcProvider, hash: string): Promise<number> {
  const b = await provider.viewBlock({ blockId: hash } as never);
  return Number(BigInt(b.header.timestamp) / 1_000_000n);
}

const rows: Record<string, number[]> = {};
for (const rpc of RPCS) {
  const provider = new JsonRpcProvider({ url: rpc });
  const account = new Account(SENDER, provider, key);
  for (const waitUntil of WAITS) {
    for (const shape of ["single", "batch2", "seq2"] as const) {
      for (let i = 0; i < RUNS; i++) {
        const t0 = Date.now();
        let hashes: string[] = [];
        try {
          if (shape === "single") {
            const r = await account.signAndSendTransaction({
              receiverId: "wrap.testnet",
              actions: [wrapDeposit],
              waitUntil,
            });
            hashes = [r.transaction.hash];
          } else if (shape === "batch2") {
            const r = await account.signAndSendTransaction({
              receiverId: "wrap.testnet",
              actions: [storageDep, xfer],
              waitUntil,
            });
            hashes = [r.transaction.hash];
          } else {
            const a = await account.signAndSendTransaction({
              receiverId: "wrap.testnet",
              actions: [storageDep],
              waitUntil,
            });
            const b = await account.signAndSendTransaction({ receiverId: "wrap.testnet", actions: [xfer], waitUntil });
            hashes = [a.transaction.hash, b.transaction.hash];
          }
        } catch (e) {
          appendFileSync(out, `${JSON.stringify({ rpc, waitUntil, shape, error: String(e).slice(0, 160), at: t0 })}\n`);
          console.log(`${rpc} ${waitUntil} ${shape} ERR ${String(e).slice(0, 100)}`);
          continue;
        }
        const wall = Date.now() - t0;
        let includedMs: number | null = null;
        try {
          const st = await provider.viewTransactionStatus({ txHash: hashes[0]!, accountId: SENDER, waitUntil: "NONE" });
          includedMs = (await blockTime(provider, st.transaction_outcome.block_hash)) - t0;
        } catch {
          /* block lookup is best effort */
        }
        const k = `${rpc.replace("https://", "")} ${waitUntil} ${shape}`;
        const series = rows[k] ?? [];
        rows[k] = series;
        series.push(wall);
        appendFileSync(
          out,
          `${JSON.stringify({ rpc, waitUntil, shape, wall_ms: wall, included_after_ms: includedMs, txs: hashes, at: t0 })}\n`,
        );
        console.log(`${k} run ${i}: ${wall} ms (included after ${includedMs} ms) ${hashes.join(",")}`);
      }
    }
  }
}
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log("\nconfig | n | p50 ms | p95 ms");
for (const [k, v] of Object.entries(rows)) console.log(`${k} | ${v.length} | ${q(v, 0.5)} | ${q(v, 0.95)}`);
