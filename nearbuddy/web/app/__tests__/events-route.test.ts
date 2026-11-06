// GET /api/events against a stubbed FastNEAR: a cold scan whose third /v0/transactions batch is 429ed
// serves what it parsed (`partial: true`), backs off instead of rescanning per poll, and the next scan
// fetches only the hashes it is missing. Run: `cd web && bun test app`.
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { fastnearTxApi } from "../api/events/chain";

// the route's own ARENA: another test file may mock ../api/near for the whole bun process
const { ARENA } = await import("../api/near");
const T0 = new Date("2026-11-06T12:00:00Z");
const HASHES = Array.from({ length: 200 }, (_, i) => `H${String(i).padStart(3, "0")}`); // newest first
const tx = (hash: string) => ({
  transaction: { hash },
  receipts: [
    {
      receipt: {
        receiver_id: ARENA,
        receipt: { Action: { actions: [{ FunctionCall: { method_name: "post_intent" } }] } },
      },
      execution_outcome: {
        block_timestamp: String(BigInt(T0.getTime() - Number(hash.slice(1)) * 1000) * 1_000_000n),
        outcome: {
          logs: [
            `EVENT_JSON:${JSON.stringify({ standard: "nearbuddy-arena", event: "intent", data: { duel_id: 7, agent_pk: hash } })}`,
          ],
          status: { SuccessValue: "" },
        },
      },
    },
  ],
});

let mode: "429-on-3" | "ok" | "down" = "429-on-3";
const batches: string[][] = [];
let accountCalls = 0;
let calls = 0; // every FastNEAR request, failed ones included
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.includes("fastnear")) return realFetch(input, init);
  calls += 1;
  if (mode === "down") return new Response("rate limited", { status: 429 });
  if (url.endsWith("/account")) {
    accountCalls += 1;
    return Response.json({
      account_txs: HASHES.map((h, i) => ({
        transaction_hash: h,
        tx_block_timestamp: String(BigInt(T0.getTime() - i * 1000) * 1_000_000n),
      })),
    });
  }
  const { tx_hashes } = JSON.parse(String(init?.body)) as { tx_hashes: string[] };
  batches.push(tx_hashes);
  if (mode === "429-on-3" && batches.length === 3) return new Response("rate limited", { status: 429 });
  return Response.json({ transactions: tx_hashes.map(tx) });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const { GET } = await import("../api/events/route");
const get = async () => {
  const r = await GET(new Request("http://x/api/events?duel=7"));
  return { status: r.status, body: await r.json() };
};

describe("/api/events under FastNEAR rate limits", () => {
  test("a 429 on batch 3 of a cold scan serves the 40 parsed txs, marked partial", async () => {
    setSystemTime(T0);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.partial).toBe(true);
    expect(body.source).toBe(process.env.FASTNEAR_TX_API ?? fastnearTxApi(process.env.NEAR_NETWORK));
    expect(body.window).toBe(40);
    expect(body.events).toHaveLength(40);
    expect(body.events[0].at_ms).toBeLessThan(body.events[39].at_ms); // chain order
    expect(batches).toHaveLength(3); // stopped at the failed batch, did not hammer the rest
  });
  test("inside the back-off a poll reuses the partial scan; after it only the missing 160 are fetched", async () => {
    setSystemTime(new Date(T0.getTime() + 5_000));
    expect((await get()).body.partial).toBe(true);
    expect(accountCalls).toBe(1);
    mode = "ok";
    setSystemTime(new Date(T0.getTime() + 10_001));
    const { body } = await get();
    expect(body).toMatchObject({ partial: false, window: 200 });
    expect(body.events).toHaveLength(200);
    const refetched = batches.slice(3).flat();
    expect(refetched).toHaveLength(160);
    expect(refetched).toEqual(HASHES.slice(40)); // the 429ed batch and the rest, nothing parsed twice
  });
  test("an outage with a scan in hand serves it and retries once per back-off, not per poll", async () => {
    mode = "down";
    setSystemTime(new Date(T0.getTime() + 40_000)); // past the TTL
    const before = calls;
    const a = await get();
    expect(a.status).toBe(200);
    expect(a.body.window).toBe(200);
    setSystemTime(new Date(T0.getTime() + 45_000));
    await get();
    await get();
    expect(calls).toBe(before + 1); // one failed /account, then the stale scan until TTL/2 has passed
    setSystemTime(new Date(T0.getTime() + 50_001));
    await get();
    expect(calls).toBe(before + 2);
  });
});
