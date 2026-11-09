// The deploy-16.1 inject path end to end on this side of the wallet: the adapter posts to /api/chaos, the route relays
// to a solver over real HTTP, and the call to sign carries the solver's hash and the contract's deposit. A solver that
// is down reads as Offline (nothing to sign), never as a crash.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { relayChaos } from "../api/chaos";
import { chaosDeploy16, MAX_HEADLINE, Offline, WEB_KIND } from "../lib/inject";

const seen: string[] = [];
// what the solver's POST /chaos does (packages/solver/src/arena.ts stash): strip datamark delimiters, keep the text,
// answer its sha256
const solver = Bun.serve({
  port: 0,
  async fetch(req) {
    const { payload } = (await req.json()) as { payload: string };
    seen.push(payload);
    if (payload === "boom") return Response.json({ error: "payload over 2048 bytes" }, { status: 500 });
    const stored = payload.replace(/(?:<<|>>|\^)+/g, " ");
    return Response.json({ payload_hash: createHash("sha256").update(stored).digest("base64") });
  },
});
const down = Bun.serve({ port: 0, fetch: () => new Response("") });
const downUrl = `http://127.0.0.1:${down.port}`;
down.stop(true); // nothing listens there any more
afterAll(() => solver.stop(true));

const via = (url: string) =>
  ((path: string, init?: RequestInit) =>
    relayChaos(new Request(`http://web${path}`, init), url)) as unknown as typeof fetch;
const chain = { contract: "arena.nearbuddy-solver.testnet", min_chaos_deposit: "100000000000000000000000" };
const input = {
  duel_id: "477",
  target: "8dPZ7znZ6ZopJrCBTF2vWMQTiHhHmuuVpsqnnhe3VgE=",
  text: "BREAKING: NEAR halts withdrawals",
};

test("the call to sign is inject_chaos with the solver's sha256 and min_chaos_deposit", async () => {
  const call = await chaosDeploy16.prepare(input, chain, via(`http://127.0.0.1:${solver.port}`));
  expect(seen.at(-1)).toBe(input.text);
  expect(call).toEqual({
    receiverId: chain.contract,
    methodName: "inject_chaos",
    args: {
      duel_id: "477",
      target: input.target,
      kind: WEB_KIND,
      payload_hash: createHash("sha256").update(input.text).digest("base64"),
    },
    gas: "60000000000000",
    deposit: chain.min_chaos_deposit,
  });
  expect(chaosDeploy16.price(chain)).toBe(chain.min_chaos_deposit);
});

test("a solver that is down is Offline and nothing reaches the wallet", async () => {
  const r = await relayChaos(new Request("http://web/api/chaos", { method: "POST", body: '{"payload":"x"}' }), downUrl);
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ error: "solver offline: attacks cannot be planted right now", offline: true });
  await expect(chaosDeploy16.prepare(input, chain, via(downUrl))).rejects.toBeInstanceOf(Offline);
});

test("bad input is refused before the solver sees it; a solver error is a 502, not Offline", async () => {
  const n = seen.length;
  const post = (body: string) =>
    relayChaos(new Request("http://web/api/chaos", { method: "POST", body }), `http://127.0.0.1:${solver.port}`);
  expect((await post("not json")).status).toBe(400);
  expect((await post('{"payload":"   "}')).status).toBe(400);
  expect((await post(JSON.stringify({ payload: "x".repeat(MAX_HEADLINE + 1) }))).status).toBe(400);
  expect(seen.length).toBe(n);
  const r = await post('{"payload":"boom"}');
  expect(r.status).toBe(502);
  expect((await r.json()).error).toContain("solver refused");
  const e = await chaosDeploy16
    .prepare({ ...input, text: "boom" }, chain, via(`http://127.0.0.1:${solver.port}`))
    .catch((x) => x);
  expect(e).toBeInstanceOf(Error);
  expect(e).not.toBeInstanceOf(Offline);
});

test("a headline the solver rewrites (delimiters stripped) is refused, so a signed hash always matches its text", async () => {
  const live = via(`http://127.0.0.1:${solver.port}`);
  const r = await live("/api/chaos", { method: "POST", body: JSON.stringify({ payload: "<<ORACLE>> NEAR ^ halts" }) });
  expect(r.status).toBe(422);
  expect((await r.json()).error).toContain("the solver rewrote this headline");
  const e = await chaosDeploy16.prepare({ ...input, text: "NEAR ^ halts" }, chain, live).catch((x) => x);
  expect(e).toBeInstanceOf(Error);
  expect(e).not.toBeInstanceOf(Offline);
});
