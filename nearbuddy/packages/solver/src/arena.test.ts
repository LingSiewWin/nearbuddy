import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Quote } from "./oneclick.ts";

// Keep the unit tests away from the solver's real state files.
const scratch = mkdtempSync(join(tmpdir(), "arena-test-"));
process.env.ARENA_PAYLOADS = join(scratch, "payloads.json");
process.env.ARENA_HISTORY = join(scratch, "history.json");
const { Arena, mandateOpen, quoteAmount } = await import("./arena.ts");
type Mandate = import("./arena.ts").Mandate;

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

test("route: unknown path is null; pending = on-chain injections whose payload we hold, minus consumed", async () => {
  const arena = new Arena({} as never, "s.testnet", {
    getDuel: async () => ({ resolved: false, injections: [{ kind: "fake_news", payload_hash: "H1", target: "A", block: "1" }, { kind: "x", payload_hash: "UNKNOWN", target: "A", block: "2" }] }),
  });
  assert.equal(await arena.route("GET", "/nope", ""), null);
  arena.openDuels.add("1");
  arena.payloads.set("H1", "BTC banned");
  const snap = (await arena.route("GET", "/arena", ""))!.body as { pending: Record<string, { payload: string }[]> };
  assert.equal(snap.pending.A.length, 1);
  assert.equal(snap.pending.A[0].payload, "BTC banned");
  arena.consume("A", "1", ["1"]);
  assert.equal(Object.keys(await arena.pending()).length, 0);
});

test("/chaos caps the payload size", async () => {
  const arena = new Arena({} as never, "s.testnet");
  await assert.rejects(arena.route("POST", "/chaos", JSON.stringify({ payload: "x".repeat(2049) }), {}), /payload over 2048/);
});

test("/chaos is open and returns the sha256 of the payload", async () => {
  const arena = new Arena({} as never, "s.testnet");
  const r = (await arena.route("POST", "/chaos", JSON.stringify({ payload: "BTC banned" }), {}))!.body as { payload_hash: string };
  assert.equal(r.payload_hash, createHash("sha256").update("BTC banned").digest("base64"));
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
