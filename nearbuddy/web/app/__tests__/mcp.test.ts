// The MCP server end to end through mcp-handler, as an MCP client sees it over HTTP: tools/list, and tools/call
// inject on a deploy-17 duel (an unsigned inject_chaos at the current chaos_fee), on a closed duel, with a headline the
// contract would refuse, and on deploy 16.1. The reader is a fixture: no RPC, no solver, no key.
import { expect, test } from "bun:test";
import { createMcpHandler } from "mcp-handler";
import { type Duel, type Reader, register } from "../api/mcp/tools";
import type { Chaos } from "../lib/abi/arena";

const NS = (ms: number) => String(BigInt(ms) * 1_000_000n);
const PK_A = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
const PK_B = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=";
const CONTRACT = "arena.nearbuddy-solver.testnet";
const TERMS = {
  base: "100000000000000000000000",
  cap: "1000000000000000000000000",
  fee_bps: 500,
  r_bps: 12_500,
  share_bps: 5000,
};
const v17 = { min_chaos_deposit: "100000000000000000000000", next_duel: "482", chaos: TERMS };
const v16 = { min_chaos_deposit: "100000000000000000000000", next_duel: "482" };

const duel = (id: string, open: boolean, chaos: Chaos[] | null = null): Duel => ({
  id,
  a: PK_A,
  b: PK_B,
  symbol: "wrap.near",
  open_at: NS(Date.now() - 60_000),
  close_at: NS(Date.now() + (open ? 240_000 : -60_000)),
  pool: "0",
  injections: [],
  resolved: !open,
  last_intent_a: null,
  last_intent_b: null,
  open_price: "370000000",
  outcome: null,
  chaos,
  chaos_fee: "125000000000000000000000", // the cached price; inject must read fee() instead
});

const reads: string[] = [];
const reader = (config: typeof v17 | typeof v16): Reader => ({
  network: "testnet",
  explorer: "https://testnet.nearblocks.io",
  repo: "https://github.com/LingSiewWin/nearbuddy",
  arena: async () => ({ contract: CONTRACT, config, leaderboard: [], duels: [duel("481", true)] }),
  duel: async (id) => ({ contract: CONTRACT, config, duel: id === "999" ? null : duel(id, id !== "470") }),
  agent: async () => ({}),
  board: () => ({ source: "d", rows: 0, models: [] }),
  fee: async (id) => {
    reads.push(id);
    return "156250000000000000000000"; // chaos_fee now: one more paid attack landed since the cache
  },
  fetcher: (async () => Response.json({ payload_hash: "solver-hash" })) as unknown as typeof fetch,
});

/** One JSON-RPC request to a fresh stateless server, the way a Streamable HTTP client posts it. */
async function rpc(config: typeof v17 | typeof v16, method: string, params: Record<string, unknown>) {
  const handler = createMcpHandler((server) => register(server, reader(config)), {
    serverInfo: { name: "nearbuddy", version: "1.0.0" },
  });
  const r = await handler(
    new Request("http://127.0.0.1:3102/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await r.text();
  // a Streamable HTTP answer may come as one SSE event
  const json = text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? text);
  return JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown };
}
const call = async (config: typeof v17 | typeof v16, args: Record<string, unknown>) => {
  const r = await rpc(config, "tools/call", { name: "inject", arguments: args });
  return r.result as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
};

test("tools/list: arena, duel, agent, inject, claim, verify", async () => {
  const r = await rpc(v17, "tools/list", {});
  const tools = (r.result?.tools ?? []) as { name: string; inputSchema: { required?: string[] } }[];
  expect(tools.map((t) => t.name).sort()).toEqual(["agent", "arena", "claim", "duel", "inject", "verify"]);
  expect(tools.find((t) => t.name === "inject")?.inputSchema.required?.sort()).toEqual([
    "duel_id",
    "headline",
    "kind",
    "target",
  ]);
});

test("inject on deploy 17: the unsigned inject_chaos with the headline, at chaos_fee read now", async () => {
  const n = reads.length;
  const r = await call(v17, {
    duel_id: "481",
    target: "B",
    kind: "Short",
    headline: "BREAKING: Reuters says NEAR halts withdrawals",
    signer_id: "alice.testnet",
  });
  expect(r.isError).toBeFalsy();
  expect(reads.slice(n)).toEqual(["481"]);
  const s = r.structuredContent as Record<string, unknown>;
  expect(s.deploy).toBe(17);
  expect(s.deposit_near).toBe("0.156");
  expect(s.transaction).toEqual({
    signerId: "alice.testnet",
    receiverId: CONTRACT,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "inject_chaos",
          args: {
            duel_id: "481",
            target: PK_B,
            kind: "Short",
            headline: "BREAKING: Reuters says NEAR halts withdrawals",
          },
          gas: "100000000000000",
          deposit: "156250000000000000000000",
        },
      },
    ],
  });
  expect(s.near_cli).toBe(
    `near contract call-function as-transaction ${CONTRACT} inject_chaos json-args '{"duel_id":"481","target":"${PK_B}","kind":"Short","headline":"BREAKING: Reuters says NEAR halts withdrawals"}' prepaid-gas '100 Tgas' attached-deposit '156250000000000000000000 yoctoNEAR' sign-as alice.testnet network-config testnet sign-with-keychain send`,
  );
  expect(JSON.parse(r.content[0]?.text ?? "{}")).toEqual(s); // the same object as text for clients without structured output
  // a client that sends the duel number as a number gets the same call, with the id as the contract's string
  const num = await call(v17, { duel_id: 481, target: "B", kind: "Short", headline: "x" });
  const tx = num.structuredContent?.transaction as { actions: { params: { args: unknown } }[] } | undefined;
  expect(tx?.actions[0]?.params.args).toEqual({ duel_id: "481", target: PK_B, kind: "Short", headline: "x" });
});

test("inject refuses before anything is built: contract's headline rules, closed or unknown duel, bad target", async () => {
  const n = reads.length;
  const base = { duel_id: "481", target: "A", kind: "Long", headline: "ok" };
  const refusal = async (args: Record<string, unknown>) => {
    const r = await call(v17, { ...base, ...args });
    return r.isError ? r.content[0]?.text : "built";
  };
  expect(await refusal({ headline: "NEAR‮halts" })).toBe(
    "the contract would refuse this headline: headline control character",
  );
  expect(await refusal({ headline: "x".repeat(281) })).toBe(
    "the contract would refuse this headline: headline too long",
  );
  expect(await refusal({ headline: "  " })).toBe("the contract would refuse this headline: headline empty");
  expect(await refusal({ duel_id: "470" })).toContain("duel #470 is closed");
  expect(await refusal({ duel_id: "999" })).toContain("no duel #999");
  expect(await refusal({ target: "Q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=" })).toContain("not in duel #481");
  expect(reads.length).toBe(n); // no price read for a refused input
  // the schema itself: no direction, or a placebo (owner only), is not an input
  for (const kind of [undefined, "Placebo"]) expect((await call(v17, { ...base, kind })).isError).toBe(true);
});

test("inject on deploy 16.1: the solver's hash, min_chaos_deposit, and the kind the web uses", async () => {
  const r = await call(v16, { duel_id: "481", target: "A", kind: "Long", headline: "ETF approved at dawn" });
  const s = r.structuredContent as { deploy: number; transaction: { actions: { params: unknown }[] } };
  expect(s.deploy).toBe(16);
  expect(s.transaction.actions[0]?.params).toEqual({
    methodName: "inject_chaos",
    args: { duel_id: "481", target: PK_A, kind: "fake_news/web", payload_hash: "solver-hash" },
    gas: "60000000000000",
    deposit: "100000000000000000000000",
  });
});
