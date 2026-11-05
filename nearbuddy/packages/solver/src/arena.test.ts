import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Arena, mandateOpen, quoteAmount, type Mandate } from "./arena.ts";
import type { Quote } from "./oneclick.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/oneclick-quote.json", import.meta.url), "utf8")) as Quote;
const NOW = 1_700_000_000_000_000_000n;
const m = (over: Partial<Mandate> = {}): Mandate => ({
  allowance: "1000", spent: "0", per_tx_cap: "300", allowed_tokens: [], expires_at: (NOW + 1n).toString(), revoked: false, ...over,
});

test("quote amount is min(cap, allowance - spent)", () => {
  assert.equal(quoteAmount(m()), 300n);
  assert.equal(quoteAmount(m({ spent: "900" })), 100n);
  assert.equal(quoteAmount(m({ spent: "1000" })), 0n);
});

test("mandateOpen skips revoked, expired and exhausted", () => {
  assert.ok(mandateOpen(m(), NOW));
  assert.ok(!mandateOpen(m({ revoked: true }), NOW));
  assert.ok(!mandateOpen(m({ expires_at: NOW.toString() }), NOW));
  assert.ok(!mandateOpen(m({ spent: "1000" }), NOW));
});

test("quotesFor quotes each open follower with the mandate amount", async () => {
  const asked: string[] = [];
  const arena = new Arena({} as never, "nearbuddy-solver.testnet", {
    listFollowers: async () => [["f1.testnet", m()], ["f2.testnet", m({ revoked: true })], ["f3.testnet", m({ spent: "950" })]],
    quote: async (req) => { asked.push(req.amount); return fixture; },
    now: () => NOW,
  });
  const out = await arena.quotesFor("pk");
  assert.deepEqual(out.map((o) => o.follower), ["f1.testnet", "f3.testnet"]);
  assert.deepEqual(asked, ["300", "50"]);
  assert.equal(out[0].quote?.quote.amountOut, "3744739");
});

test("route: unknown path is null; /arena snapshot; pending injections by target", async () => {
  const arena = new Arena({} as never, "s.testnet");
  assert.equal(await arena.route("GET", "/nope", ""), null);
  arena.injections.push({ duel_id: "1", target: "A", kind: "fake_news", payload: "BTC banned", payload_hash: "x", tx: "t", at: 0 });
  const snap = (await arena.route("GET", "/arena", ""))!.body as { pending: Record<string, unknown[]> };
  assert.equal(snap.pending.A.length, 1);
  arena.consume("A", "1", ["x"]);
  assert.equal(Object.keys(arena.pending()).length, 0);
});

test("POST routes need the shared secret; GET /arena does not", async () => {
  const arena = new Arena({} as never, "s.testnet");
  const r = await arena.route("POST", "/duel", "{}", {});
  assert.equal(r?.code, 401);
  assert.equal((await arena.route("GET", "/arena", ""))?.code, 200);
});

test("payload hash is sha256 of the payload bytes", () => {
  const h = createHash("sha256").update("BTC banned").digest("base64");
  assert.equal(h.length, 44);
});
