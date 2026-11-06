// What does the pre-funded INTENTS deposit path promise versus a deposit from the origin chain? Dry 1Click quotes
// only (free, keyless, nothing moves): the same wNEAR -> USDC request with `depositType: "INTENTS"` and
// `"ORIGIN_CHAIN"` for 0.1 / 1 / 10 NEAR, RUNS each, interleaved so both types see the same market. Prints the
// quoted `timeEstimate` (seconds after the deposit confirms), the quote round trip p50/p95 and the price.
//   ONECLICK_ACCOUNT=<existing mainnet account> RUNS=10 bun analysis/oneclick_intents_probe.ts
// ORIGIN_CHAIN quotes need an account that exists on mainnet (refunds go there); a missing one is a 400.
import "../packages/protocol/src/env.ts";
import { quote, sellNearForUsdc, sellNearForUsdcOnChain } from "../packages/solver/src/oneclick.ts";

const ACCOUNT = process.env.ONECLICK_ACCOUNT;
if (!ACCOUNT) throw new Error("set ONECLICK_ACCOUNT to an existing mainnet account (ORIGIN_CHAIN refunds go there)");
const RUNS = Number(process.env.RUNS ?? 10);
const SIZES = ["0.1", "1", "10"];
const TYPES = ["INTENTS", "ORIGIN_CHAIN"] as const;
const yocto = (near: string) => BigInt(Math.round(Number(near) * 1000)) * 10n ** 21n;

type Row = { ms: number[]; est: number[]; price: number[]; errors: string[] };
const rows = new Map<string, Row>();
for (let run = 0; run < RUNS; run++)
  for (const size of SIZES)
    for (const type of TYPES) {
      const key = `${type} ${size}`;
      const row = rows.get(key) ?? { ms: [], est: [], price: [], errors: [] };
      rows.set(key, row);
      const req =
        type === "INTENTS"
          ? sellNearForUsdc(yocto(size), ACCOUNT, true)
          : { ...sellNearForUsdcOnChain(yocto(size), ACCOUNT), dry: true };
      const t = performance.now();
      try {
        const q = await quote(req);
        row.ms.push(performance.now() - t);
        row.est.push(q.quote.timeEstimate);
        row.price.push(Number(q.quote.amountOutFormatted) / Number(q.quote.amountInFormatted));
      } catch (e) {
        row.errors.push(String(e).slice(0, 80));
      }
    }

/** Nearest-rank percentile; with 10 samples p95 is the slowest one. */
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? Number.NaN;
};
console.log(`1Click dry quotes, wNEAR -> USDC, ${RUNS} runs each, ${new Date().toISOString()}`);
console.log("| depositType | NEAR | ok | timeEstimate s (min-max) | quote p50 ms | quote p95 ms | USDC/NEAR p50 |");
console.log("|---|---|---|---|---|---|---|");
for (const [key, r] of rows) {
  const [type, size] = key.split(" ");
  const est = r.est.length ? `${Math.min(...r.est)}-${Math.max(...r.est)}` : "-";
  console.log(
    `| ${type} | ${size} | ${r.ms.length}/${RUNS} | ${est} | ${pct(r.ms, 50).toFixed(0)} | ${pct(r.ms, 95).toFixed(0)} | ${pct(r.price, 50).toFixed(6)} |`,
  );
  if (r.errors.length) console.log(`  errors: ${[...new Set(r.errors)].join("; ")}`);
}
