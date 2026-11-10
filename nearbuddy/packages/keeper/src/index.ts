// Keeper CLI: drives every keyless agent on the arena (ARENA_CONTRACT) through NEAR AI Cloud. Anyone can run it; it
// signs with its own NEAR account (gas and the keeper bond), never an agent key.
//
//   bun run keeper --account keeper.testnet                 run until stopped, polling every 5 s
//   bun run keeper --account keeper.testnet --until-idle    stop once no keyless agent is in an open duel
//   bun run keeper --health                                 GET /v1/models for the agents' models (free); exit 0 or 1
//
// Env: NEAR_AI_API_KEY (required), NEAR_AI_BASE, ARENA_CONTRACT, NEAR_NETWORK, KEEPER_ID (= --account), KEEPER_RPC
// (comma-separated; else NEAR_RPC, else https://rpc.testnet.fastnear.com on testnet), KEEPER_BUDGET_USD (default 1.5).
// The account key comes from NEAR_KEY_<ACCOUNT> or ~/.near-credentials (chain.ts loadKey) and is never printed.
// Exit: 0 done, 1 budget cap or a fatal error, 75 NEAR AI Cloud down (as runner.py --max-model-failures).
import "../../protocol/src/env.ts";
import { parseArgs } from "node:util";
import { Account, FailoverRpcProvider, JsonRpcProvider } from "near-api-js";
import { ARENA, loadKey, sendFailover } from "../../protocol/src/chain.ts";
import { NET, NETWORK_ID, networkFile } from "../../protocol/src/network.ts";
import { type Chain, Keeper, Stop } from "./keeper.ts";
import { Budget, ModelError, NEAR_AI_BASE, NearAi, Outage } from "./nearai.ts";

const { values: o } = parseArgs({
  options: {
    account: { type: "string", default: process.env.KEEPER_ID ?? "" },
    agents: { type: "string", default: "" },
    rounds: { type: "string", default: "0" },
    "poll-seconds": { type: "string", default: "5" },
    "until-idle": { type: "boolean", default: false },
    "budget-usd": { type: "string", default: process.env.KEEPER_BUDGET_USD ?? "1.5" },
    "max-model-failures": { type: "string", default: "3" },
    "margin-seconds": { type: "string", default: "10" },
    "spend-log": { type: "string", default: networkFile(new URL("../data/spend.jsonl", import.meta.url).pathname) },
    log: { type: "string", default: networkFile(new URL("../data/keeper.jsonl", import.meta.url).pathname) },
    health: { type: "boolean", default: false },
  },
});

// KEEPER_RPC (comma-separated) first, then NEAR_RPC and its fallback, else FastNEAR: the public drpc endpoint
// rate-limits ("Public endpoint rate limit") during a duel's bursts of views
const RPCS = process.env.KEEPER_RPC
  ? process.env.KEEPER_RPC.split(",").filter(Boolean)
  : process.env.NEAR_RPC
    ? [process.env.NEAR_RPC, process.env.NEAR_RPC_FALLBACK].filter((u): u is string => !!u)
    : [...new Set([NETWORK_ID === "testnet" ? "https://rpc.testnet.fastnear.com" : NET.rpc, NET.fallback, NET.rpc])];
const providers = RPCS.map((url) => new JsonRpcProvider({ url }));
const views = providers.length > 1 ? new FailoverRpcProvider(providers) : providers[0]!;

/** Reads go through `views`; calls are signed by the keeper account with arena.ts's retry rule: back off on a 429,
 *  never resend after a timeout (the transaction may have landed). */
function nearChain(account: Account | null): Chain {
  return {
    view: async (method, args) =>
      // the generated type of `method`'s result: a view answers JSON in exactly that shape
      (await views.callFunction({ contractId: ARENA, method, args: args as Record<string, unknown> })) as never,
    async call(method, args, deposit, tgas) {
      if (!account) throw new Error("no keeper account");
      let r!: Awaited<ReturnType<Account["callFunctionRaw"]>>;
      for (let attempt = 0; ; attempt++) {
        try {
          r = await account.callFunctionRaw({
            contractId: ARENA,
            methodName: method,
            args: args as Record<string, unknown>,
            gas: BigInt(tgas) * 10n ** 12n,
            deposit,
          });
          break;
        } catch (e) {
          if (attempt >= 4 || !/429|Rate limit/i.test(String(e))) throw e;
          await sleep(1500 * 2 ** attempt);
        }
      }
      const st = r.status as { SuccessValue?: string; Failure?: unknown };
      if (st.SuccessValue === undefined)
        throw new Error(`${method} failed: ${JSON.stringify(st.Failure ?? r.status).slice(0, 300)}`);
      const raw = Buffer.from(st.SuccessValue, "base64").toString();
      return { tx: r.transaction.hash, value: raw ? JSON.parse(raw) : null };
    },
    now: async () => BigInt((await views.viewBlock({ finality: "final" })).header.timestamp_nanosec),
  };
}
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

const key = process.env.NEAR_AI_API_KEY?.trim();
if (!key) {
  console.error("NEAR_AI_API_KEY missing: a keyless agent's decision is a NEAR AI Cloud enclave completion");
  process.exit(1);
}
const ai = new NearAi(key, process.env.NEAR_AI_BASE ?? NEAR_AI_BASE);
const outage = new Outage(Number(o["max-model-failures"]));
const budget = new Budget(Number(o["budget-usd"]), o["spend-log"]!);
const account = o.account ? new Account(o.account, sendFailover(providers), loadKey(o.account)) : null;
const keeper = new Keeper(nearChain(account), ai, budget, outage, {
  marginS: Number(o["margin-seconds"]),
  logFile: o.log!,
});
const listed = o.agents!.split(",").filter(Boolean);
const agents = async () => (listed.length ? listed : await keeper.discover());

if (o.health) {
  const pks = await agents();
  const models = new Set<string>();
  for (const pk of pks) {
    const a = await nearChain(null).view("get_agent", { agent_pk: pk });
    if (a) models.add(a.model_id);
  }
  try {
    const p = await ai.models([...models]);
    console.log(
      `healthy: GET /v1/models 200, ${pks.length} keyless agent(s) on ${ARENA}` +
        [...p]
          .map(([m, x]) => `; ${m} $${(x.prompt * 1e6).toFixed(2)}/$${(x.completion * 1e6).toFixed(2)} per M`)
          .join(""),
    );
    process.exit(0);
  } catch (e) {
    console.error(`unhealthy: ${e instanceof ModelError ? e.message : String(e)}`);
    process.exit(1);
  }
}
if (!account) {
  console.error("--account (or KEEPER_ID): the NEAR account that pays gas and the keeper bond");
  process.exit(1);
}

console.log(
  `[keeper] ${o.account} on ${ARENA} (${NETWORK_ID}, ${RPCS[0]}); budget $${budget.capUsd}, spent $${budget.spent().toFixed(4)}; ` +
    `${keeper.held.size} held response(s) from ${o.log}`,
);
const rounds = Number(o.rounds);
let pks: string[] = [];
let code = 0;
for (let round = 0; rounds === 0 || round < rounds; round++) {
  try {
    if (round % 12 === 0) {
      pks = await agents();
      if (round === 0) console.log(`[keeper] keyless agents: ${pks.map((p) => p.slice(0, 8)).join(", ") || "none"}`);
    }
    const live = await keeper.round(pks);
    if (o["until-idle"] && round > 0 && live === 0 && keeper.held.size === 0) break;
  } catch (e) {
    if (e instanceof Stop) {
      console.error(`[keeper] stopping: ${e.message}`);
      code = e.code;
      break;
    }
    console.error(`[keeper] round ${round}: ${String(e).slice(0, 300)}`); // RPC trouble: the next round retries
  }
  await sleep(Number(o["poll-seconds"]) * 1000);
}
try {
  await keeper.settle();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.error(`[keeper] stopping: ${e.message}`);
  code ||= e.code;
}
console.log(`[keeper] done; spent $${budget.spent().toFixed(5)} of $${budget.capUsd}`);
process.exit(code);
