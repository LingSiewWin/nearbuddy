// The deploy-16.1 inject path end to end on this side of the wallet: the adapter posts to /api/chaos, the route relays
// to a solver over real HTTP, and the call to sign carries the solver's hash and the contract's deposit. A solver that
// is down reads as Offline (nothing to sign), never as a crash.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { allow, BURST, REFILL_MS, relayChaos } from "../api/chaos";
import {
  adapterFor,
  chaosDeploy16,
  chaosDeploy17,
  checkHeadline,
  claimable,
  claimCall,
  isChaosV2,
  MAX_HEADLINE,
  Offline,
  utf8Bytes,
  WEB_KIND,
} from "../lib/inject";

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

test("the relay rate-limits per address: 20 at once, then one per 15 s, so a flood cannot evict paid payloads", async () => {
  const post = () =>
    relayChaos(
      new Request("http://web/api/chaos", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
        body: JSON.stringify({ payload: "ETF approved" }),
      }),
      `http://127.0.0.1:${solver.port}`,
    );
  const n = seen.length;
  for (let i = 0; i < BURST; i++) expect((await post()).status).toBe(200);
  const r = await post();
  expect(r.status).toBe(429);
  expect((await r.json()).error).toContain("too many headlines");
  expect(seen.length - n).toBe(BURST); // the refused one never reached the solver
  // another address has its own bucket; the drained one refills one token per REFILL_MS
  expect(allow("198.51.100.1")).toBe(true);
  expect(allow("203.0.113.7", Date.now() + REFILL_MS + 50)).toBe(true);
});

// The contract's own answers: arena/src/chaos.rs check_headline run on each string (a copy of it compiled with rustc
// printed these). The page must refuse exactly what the contract refuses, in the same order and words.
const CONTRACT: [string, string][] = [
  ["", "headline empty"],
  ["   ", "headline empty"],
  [" 　", "headline empty"],
  ["\u0085", "headline empty"],
  ["\t", "headline empty"],
  ["​", "headline control character"],
  ["﻿", "headline control character"],
  ["a".repeat(280), "ok"],
  ["a".repeat(281), "headline too long"],
  ["é".repeat(140), "ok"],
  ["é".repeat(141), "headline too long"],
  ["😀".repeat(70), "ok"],
  ["😀".repeat(71), "headline too long"],
  ["BREAKING:\tNEAR", "headline control character"],
  ["NEAR\nhalts", "headline control character"],
  ["a\u007F", "headline control character"],
  ["a\u009F", "headline control character"],
  ["a‮b", "headline control character"],
  ["a⁦b", "headline control character"],
  ["a⁥b", "ok"],
  ["a‎b", "headline control character"],
  ["a­b", "ok"],
  ["  x  ", "ok"],
  [" ".repeat(300), "headline empty"],
  [`x${"\n".repeat(300)}`, "headline too long"],
  ["a b", "ok"],
  ["a᠎b", "ok"],
  ["BREAKING: Reuters says NEAR halts withdrawals", "ok"],
];

test("checkHeadline refuses exactly what the deploy-17 contract refuses, with its message", () => {
  for (const [h, want] of CONTRACT) expect([h, checkHeadline(h) ?? "ok"]).toEqual([h, want]);
  expect(checkHeadline("a\uD800b")).toBe("headline is not valid UTF-8"); // JSON would carry it; serde cannot
  expect(utf8Bytes("😀é")).toBe(6);
});

const v17 = { ...chain, chaos_fee: "125000000000000000000000" };

test("adapterFor picks deploy 17 by the chaos terms in get_config, else deploy 16.1", () => {
  const terms = { base: "1", cap: "2", fee_bps: 500, r_bps: 12_500, share_bps: 5000 };
  expect(adapterFor({ chaos: terms })).toBe(chaosDeploy17);
  expect(isChaosV2({ chaos: terms })).toBe(true);
  for (const c of [{}, { chaos: null }, null, undefined]) {
    expect(adapterFor(c)).toBe(chaosDeploy16);
    expect(isChaosV2(c)).toBe(false);
  }
  expect(chaosDeploy17.needsKind).toBe(true);
  expect(chaosDeploy16.needsKind).toBe(false);
  expect(chaosDeploy17.price(v17)).toBe(v17.chaos_fee); // the rising price, not the minimum
  expect(chaosDeploy17.price(chain)).toBeNull(); // unknown until chaos_fee is read
});

test("deploy 17 signs inject_chaos with the headline and its direction at chaos_fee, no solver involved", async () => {
  const n = seen.length;
  const call = await chaosDeploy17.prepare({ ...input, kind: "Short" }, v17);
  expect(call).toEqual({
    receiverId: chain.contract,
    methodName: "inject_chaos",
    args: { duel_id: "477", target: input.target, kind: "Short", headline: input.text },
    gas: "100000000000000",
    deposit: v17.chaos_fee,
  });
  expect(seen.length).toBe(n);
  const refused = (i: { text?: string; kind?: "Long" | "Short" | null }, c: typeof chain = v17) =>
    chaosDeploy17.prepare({ ...input, kind: "Long", ...i }, c).then(
      () => "signed",
      (e: Error) => e.message,
    );
  expect(await refused({ text: "NEAR\nhalts" })).toBe("headline control character");
  expect(await refused({ text: "x".repeat(281) })).toBe("headline too long");
  expect(await refused({ kind: null })).toBe("say which way the lie pushes: long or short");
  expect(await refused({}, chain)).toContain("chaos_fee");
});

test("claim_chaos: 1 yocto, and only this account's unclaimed payouts count", () => {
  expect(claimCall("arena.t", "9")).toEqual({
    receiverId: "arena.t",
    methodName: "claim_chaos",
    args: { duel_id: "9" },
    gas: "30000000000000",
    deposit: "1",
  });
  const recs = [
    { injector: "me.testnet", payout: "95000000000000000000000", claimed: false },
    { injector: "me.testnet", payout: "5", claimed: true },
    { injector: "you.testnet", payout: "7", claimed: false },
    { injector: "me.testnet", payout: "0", claimed: false },
  ];
  expect(claimable(recs, "me.testnet")).toBe(95000000000000000000000n);
  expect(claimable(recs, null)).toBe(0n);
  expect(claimable(null, "me.testnet")).toBe(0n);
});
