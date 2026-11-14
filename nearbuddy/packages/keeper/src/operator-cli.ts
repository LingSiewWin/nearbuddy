// Operator service: opens, plays and resolves one keyless match at a time on request (operator.ts), for the arena
// home's "start match" panel. It holds two keys, so it binds 127.0.0.1 only and POST /match needs OPERATOR_SECRET.
//
//   OPERATOR_SECRET=<random> bun run operator --account keeper.testnet
//
// Env: OPERATOR_SECRET (required), OPERATOR_PORT (4030), ARENA_CONTRACT (the arena; its own account must be its owner
// and its key in ~/.near-credentials or NEAR_KEY_<ACCOUNT>), KEEPER_ID (= --account), NEAR_AI_API_KEY,
// KEEPER_BUDGET_USD (default 1.5), KEEPER_RPC. Keys are never printed.
import "../../protocol/src/env.ts";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { Account } from "near-api-js";
import { ARENA, loadKey } from "../../protocol/src/chain.ts";
import { NETWORK_ID, networkFile } from "../../protocol/src/network.ts";
import { Keeper } from "./keeper.ts";
import { nearChain, sleep, views } from "./near.ts";
import { Budget, NEAR_AI_BASE, NearAi, Outage } from "./nearai.ts";
import { Operator } from "./operator.ts";
import { handle } from "./serve.ts";

const { values: o } = parseArgs({
  options: {
    account: { type: "string", default: process.env.KEEPER_ID ?? "" },
    port: { type: "string", default: process.env.OPERATOR_PORT ?? "4030" },
    "budget-usd": { type: "string", default: process.env.KEEPER_BUDGET_USD ?? "1.5" },
  },
});
const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};
const secret =
  process.env.OPERATOR_SECRET?.trim() || fail("OPERATOR_SECRET missing: POST /match is refused without it");
const key =
  process.env.NEAR_AI_API_KEY?.trim() || fail("NEAR_AI_API_KEY missing: a decision is a NEAR AI Cloud completion");
if (!o.account) fail("--account (or KEEPER_ID): the NEAR account that pays the keeper's gas");

const chain = nearChain(new Account(o.account as string, views, loadKey(o.account as string)));
const owner = nearChain(new Account(ARENA, views, loadKey(ARENA)));
if ((await chain.view("get_config", {})).owner !== ARENA)
  fail(`${ARENA} is not owned by its own account: open_duel would be refused`);
const say = (line: string) => console.log(`[operator ${new Date().toISOString().slice(11, 19)}] ${line}`);
const keeper = new Keeper(
  chain,
  new NearAi(key, process.env.NEAR_AI_BASE ?? NEAR_AI_BASE),
  new Budget(Number(o["budget-usd"]), networkFile(new URL("../data/spend.jsonl", import.meta.url).pathname)),
  new Outage(3),
  { marginS: 10, logFile: networkFile(new URL("../data/keeper.jsonl", import.meta.url).pathname) },
);
const op = new Operator({
  owner,
  chain,
  keeper,
  sleep,
  nowMs: () => Date.now(),
  onPhase: (phase, s) => say(`${phase}${s.duel ? ` duel ${s.duel}` : ""}${s.error ? `: ${s.error}` : ""}`),
});

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2000) break;
  }
  const header = req.headers["x-operator-secret"];
  const out = await handle(op, secret, {
    method: req.method ?? "GET",
    path: (req.url ?? "/").split("?")[0] ?? "/",
    secret: typeof header === "string" ? header : undefined,
    body,
  }).catch((e) => ({ status: 502, body: { error: String(e instanceof Error ? e.message : e).slice(0, 200) } }));
  res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
}).listen(Number(o.port), "127.0.0.1", () =>
  say(`on 127.0.0.1:${o.port} for ${ARENA} (${NETWORK_ID}), keeper ${o.account}`),
);
