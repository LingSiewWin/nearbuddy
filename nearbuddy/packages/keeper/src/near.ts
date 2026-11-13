// The keeper's chain access, shared by the CLI (index.ts) and the operator service (serve.ts): the RPC list, reads with
// failover, and calls signed by one account.
import { type Account, JsonRpcProvider } from "near-api-js";
import { ARENA, sendFailover } from "../../protocol/src/chain.ts";
import { NET, NETWORK_ID } from "../../protocol/src/network.ts";
import type { Chain } from "./keeper.ts";

// KEEPER_RPC (comma-separated) first, then NEAR_RPC and its fallback, else FastNEAR: the public drpc endpoint
// rate-limits ("Public endpoint rate limit") during a duel's bursts of views
export const RPCS = process.env.KEEPER_RPC
  ? process.env.KEEPER_RPC.split(",").filter(Boolean)
  : process.env.NEAR_RPC
    ? [process.env.NEAR_RPC, process.env.NEAR_RPC_FALLBACK].filter((u): u is string => !!u)
    : [...new Set([NETWORK_ID === "testnet" ? "https://rpc.testnet.fastnear.com" : NET.rpc, NET.fallback, NET.rpc])];
const providers = RPCS.map((url) => new JsonRpcProvider({ url }));
// chain.ts sendFailover for reads too: it moves on only after a transport error (a 429 included) and logs nothing,
// where near-api-js's FailoverRpcProvider prints every failed attempt's stack
export const views = sendFailover(providers);

/** Reads go through `views`; calls are signed by the keeper account with arena.ts's retry rule: back off on a 429,
 *  never resend after a timeout (the transaction may have landed). */
export function nearChain(account: Account | null): Chain {
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
export const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
