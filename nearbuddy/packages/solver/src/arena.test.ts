import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Quote, type QuoteRequest, USDC_NEAR, WNEAR } from "./oneclick.ts";

// Keep the unit tests away from the solver's real state files.
const scratch = mkdtempSync(join(tmpdir(), "arena-test-"));
process.env.ARENA_PAYLOADS = join(scratch, "payloads.json");
process.env.ARENA_HISTORY = join(scratch, "history.json");
process.env.ARENA_SECRET ??= "route-test-secret"; // shared module cache: arena.routes.test.ts reads it back from the module
const { Arena, fillRecipient, mandateOpen, pairIdle, quoteAmount } = await import("./arena.ts");
type Mandate = import("./arena.ts").Mandate;
type AgentView = import("./arena.ts").AgentView;

const fixture = JSON.parse(readFileSync(new URL("../fixtures/oneclick-quote.json", import.meta.url), "utf8")) as Quote;
const NOW = 1_700_000_000_000_000_000n;
/** `get_config` before deploy 15 (no `intents_account`), so quotesFor never reaches the network. */
const V14 = async () => ({ oracle_deposit: "0" });
const m = (over: Partial<Mandate> = {}): Mandate => ({
  allowance: "1000",
  spent: "0",
  per_tx_cap: "300",
  allowed_tokens: [],
  expires_at: (NOW + 1n).toString(),
  revoked: false,
  ...over,
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

const followerArena = (asked: string[]) =>
  new Arena({} as never, "nearbuddy-solver.testnet", {
    config: V14,
    listFollowers: async () => [
      ["f1.testnet", m()],
      ["f2.testnet", m({ revoked: true })],
      ["f3.testnet", m({ spent: "950" })],
    ],
    quote: async (req) => {
      asked.push(req.amount);
      return fixture;
    },
    now: () => NOW,
  });

test("BATCH_RFQ=0: quotesFor quotes each open follower with the mandate amount", async () => {
  const asked: string[] = [];
  process.env.BATCH_RFQ = "0";
  try {
    const out = await followerArena(asked).quotesFor("pk");
    assert.deepEqual(
      out.map((o) => o.follower),
      ["f1.testnet", "f3.testnet"],
    );
    assert.deepEqual(asked, ["300", "50"]);
    assert.equal(out[0]?.quote?.quote.amountOut, "3744739");
    assert.equal(out[0]?.quote_out, "3744739");
  } finally {
    delete process.env.BATCH_RFQ;
  }
});

test("batched quotesFor: one quote for the open mandates' sum, split pro rata at one price", async () => {
  const asked: string[] = [];
  const out = await followerArena(asked).quotesFor("pk");
  assert.deepEqual(asked, ["350"]);
  // 3744739 * 300/350 = 3209776.28 -> 3209776 + remainder 1; 3744739 * 50/350 = 534962.71 -> 534962
  assert.deepEqual(
    out.map((o) => [o.follower, o.amount, o.quote_out]),
    [
      ["f1.testnet", "300", "3209777"],
      ["f3.testnet", "50", "534962"],
    ],
  );
  assert.equal(out[0]?.price, out[1]?.price);
  assert.equal(out[0]?.quote, out[1]?.quote);
});

/** Run `f` with env vars set (undefined = unset), restoring them after: arena.ts reads them per call. */
async function withEnv<T>(vars: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v))
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
  };
  set(vars);
  try {
    return await f();
  } finally {
    set(old);
  }
}
const recording = (solverId: string, reqs: QuoteRequest[]) =>
  new Arena({} as never, solverId, {
    config: V14,
    listFollowers: async () => [
      ["f1.near", m()],
      ["f3.near", m({ spent: "950" })],
    ],
    quote: async (req) => {
      reqs.push(req);
      return fixture;
    },
    now: () => NOW,
  });

test("B14: a Long buys NEAR with USDC (EXACT_OUTPUT of the mandate amount); a Short sells NEAR", async () => {
  const reqs: QuoteRequest[] = [];
  await recording("nearbuddy-solver.testnet", reqs).quotesFor("pk", "Long");
  await recording("nearbuddy-solver.testnet", reqs).quotesFor("pk", "Short");
  assert.deepEqual(
    reqs.map((r) => [r.swapType, r.originAsset, r.destinationAsset, r.amount]),
    [
      ["EXACT_OUTPUT", USDC_NEAR, WNEAR, "350"],
      ["EXACT_INPUT", WNEAR, USDC_NEAR, "350"],
    ],
  );
});

test("B14: testnet defaults to paying the solver (one batched quote); mainnet pays each follower's intents balance", async () => {
  const testnet: QuoteRequest[] = [];
  const t = await withEnv({ FILL_RECIPIENT: undefined }, () =>
    recording("nearbuddy-solver.testnet", testnet).quotesFor("pk", "Short"),
  );
  assert.deepEqual(
    testnet.map((r) => [r.recipient, r.recipientType, r.refundTo]),
    [["nearbuddy-solver.near", "INTENTS", "nearbuddy-solver.near"]],
  );
  assert.deepEqual(
    t.map((o) => o.recipient),
    ["nearbuddy-solver.near", "nearbuddy-solver.near"],
  );

  const mainnet: QuoteRequest[] = [];
  const o = await withEnv({ FILL_RECIPIENT: undefined }, () =>
    recording("nearbuddy-solver.near", mainnet).quotesFor("pk", "Short"),
  );
  // a quote has one recipient, so paying followers means one quote each, even with BATCH_RFQ on
  assert.deepEqual(
    mainnet.map((r) => [r.recipient, r.recipientType, r.refundTo, r.amount]),
    [
      ["f1.near", "INTENTS", "nearbuddy-solver.near", "300"],
      ["f3.near", "INTENTS", "nearbuddy-solver.near", "50"],
    ],
  );
  assert.deepEqual(
    o.map((x) => [x.follower, x.recipient, x.quote_out]),
    [
      ["f1.near", "f1.near", "3744739"],
      ["f3.near", "f3.near", "3744739"],
    ],
  );
});

test("B14: FILL_RECIPIENT overrides the network default and refuses anything else", async () => {
  const reqs: QuoteRequest[] = [];
  await withEnv({ FILL_RECIPIENT: "follower" }, () =>
    recording("nearbuddy-solver.testnet", reqs).quotesFor("pk", "Long"),
  );
  await withEnv({ FILL_RECIPIENT: "solver" }, () => recording("nearbuddy-solver.near", reqs).quotesFor("pk", "Long"));
  assert.deepEqual(
    reqs.map((r) => r.recipient),
    ["f1.near", "f3.near", "nearbuddy-solver.near"],
  );
  assert.equal(fillRecipient("x.near"), "follower");
  await assert.rejects(
    withEnv({ FILL_RECIPIENT: "agent" }, () => recording("s.testnet", []).quotesFor("pk")),
    /FILL_RECIPIENT must be solver, follower or arena/,
  );
});

const NO_CAPS = { CAP_PER_FILL_YOCTO: undefined, CAP_PER_TICK_YOCTO: undefined, CAP_PER_DAY_YOCTO: undefined };
/** f1 300 and f3 50 open (followerArena's mandates) with a settable clock and a quote that can fail. */
function cappedArena(clock: { ns: bigint }, asked: string[], fail = () => false) {
  const expires_at = (NOW + 10n ** 15n).toString(); // open for 11 days of fake clock
  return new Arena({} as never, "nearbuddy-solver.testnet", {
    config: V14,
    listFollowers: async () => [
      ["f1.testnet", m({ expires_at })],
      ["f3.testnet", m({ spent: "950", expires_at })],
    ],
    quote: async (req) => {
      asked.push(req.amount);
      if (fail()) throw new Error("1click quote 503");
      return fixture;
    },
    now: () => clock.ns,
  });
}

test("B17: caps refuse followers before any quote and record why, like any follower error", async () => {
  const asked: string[] = [];
  const out = await withEnv({ ...NO_CAPS, CAP_PER_FILL_YOCTO: "100" }, () =>
    cappedArena({ ns: NOW }, asked).quotesFor("pk"),
  );
  assert.deepEqual(asked, ["50"]); // f1 (300) never reaches 1Click
  assert.deepEqual(
    out.map((o) => [o.follower, o.error ?? o.quote_out]),
    [
      ["f1.testnet", "over CAP_PER_FILL_YOCTO: 300 > 100"],
      ["f3.testnet", "3744739"],
    ],
  );
  const tick = await withEnv({ ...NO_CAPS, CAP_PER_TICK_YOCTO: "320" }, () =>
    cappedArena({ ns: NOW }, []).quotesFor("pk"),
  );
  assert.deepEqual(
    tick.map((o) => o.error?.split(":")[0] ?? "ok"),
    ["ok", "over CAP_PER_TICK_YOCTO"],
  );
  const bad = await withEnv({ ...NO_CAPS, CAP_PER_DAY_YOCTO: "lots" }, () =>
    cappedArena({ ns: NOW }, asked).quotesFor("pk"),
  );
  assert.ok(
    bad.every((o) => /CAP_PER_DAY_YOCTO must be a yocto integer/.test(o.error ?? "")),
    "fail closed",
  );
  assert.equal(asked.length, 1);
});

test("B17: the day cap spans ticks over a rolling 24 h, and a failed quote gives its amount back", async () => {
  const clock = { ns: NOW };
  const asked: string[] = [];
  let failing = true;
  const arena = cappedArena(clock, asked, () => failing);
  await withEnv({ ...NO_CAPS, CAP_PER_DAY_YOCTO: "400" }, async () => {
    const failed = await arena.quotesFor("pk"); // 350 admitted, the quote fails: nothing counts
    assert.ok(failed.every((o) => o.error === "Error: 1click quote 503"));
    failing = false;
    assert.ok((await arena.quotesFor("pk")).every((o) => o.quote_out)); // 350 of 400 used
    clock.ns += 3_600_000_000_000n; // +1 h
    const full = await arena.quotesFor("pk"); // f1 300 over; f3 50 fits exactly (400)
    assert.deepEqual(
      full.map((o) => o.error ?? "ok"),
      ["over CAP_PER_DAY_YOCTO: 350 quoted in 24 h + 300 > 400", "ok"],
    );
    const none = await arena.quotesFor("pk");
    assert.ok(none.every((o) => o.error?.startsWith("over CAP_PER_DAY_YOCTO: 400 quoted in 24 h")));
    clock.ns += 23n * 3_600_000_000_000n; // the first 350 is 24 h old now and drops out; the 50 (23 h) stays
    assert.deepEqual(
      (await arena.quotesFor("pk")).map((o) => o.error ?? "ok"),
      ["ok", "ok"], // 50 + 300 + 50 = 400
    );
    assert.ok((await arena.quotesFor("pk")).every((o) => o.error?.startsWith("over CAP_PER_DAY_YOCTO: 400")));
  });
  assert.deepEqual(asked, ["350", "350", "50", "350"]);
});

test("B17: two intents landing together cannot both fit under the day cap", async () => {
  const asked: string[] = [];
  const arena = cappedArena({ ns: NOW }, asked);
  const [a, b] = await withEnv({ ...NO_CAPS, CAP_PER_DAY_YOCTO: "350" }, () =>
    Promise.all([arena.quotesFor("pk"), arena.quotesFor("pk")]),
  );
  assert.deepEqual(asked, ["350"]);
  assert.ok(a!.every((o) => o.quote_out));
  assert.ok(b!.every((o) => o.error?.startsWith("over CAP_PER_DAY_YOCTO")));
});

test("route: unknown path is null; pending = on-chain injections whose payload we hold, minus consumed", async () => {
  const arena = new Arena({} as never, "s.testnet", {
    getDuel: async () => ({
      resolved: false,
      injections: [
        { kind: "fake_news", payload_hash: "H1", target: "A", block: "1" },
        { kind: "x", payload_hash: "UNKNOWN", target: "A", block: "2" },
      ],
    }),
  });
  assert.equal(await arena.route("GET", "/nope", ""), null);
  arena.openDuels.add("1");
  arena.payloads.set("H1", "BTC banned");
  const snap = (await arena.route("GET", "/arena", ""))!.body as { pending: Record<string, { payload: string }[]> };
  assert.equal(snap.pending.A?.length, 1);
  assert.equal(snap.pending.A?.[0]?.payload, "BTC banned");
  arena.consume("A", "1", ["1"]);
  assert.equal(Object.keys(await arena.pending()).length, 0);
});

test("/chaos caps the payload size", async () => {
  const arena = new Arena({} as never, "s.testnet");
  await assert.rejects(
    arena.route("POST", "/chaos", JSON.stringify({ payload: "x".repeat(2049) }), {}),
    /payload over 2048/,
  );
});

test("/chaos strips datamark delimiters (<<, >>, ^) and hashes the stored text", async () => {
  const arena = new Arena({} as never, "s.testnet");
  const { payload_hash } = arena.stash("<<ORACLE>> x^y >>");
  assert.equal(arena.payloads.get(payload_hash), " ORACLE  x y  ");
  assert.equal(payload_hash, createHash("sha256").update(" ORACLE  x y  ").digest("base64"));
  assert.equal(arena.payloads.get(arena.stash("<</TELEMETRY>>^^<<").payload_hash), " /TELEMETRY ");
});

test("/chaos is open and returns the sha256 of the payload", async () => {
  const arena = new Arena({} as never, "s.testnet");
  const r = (await arena.route("POST", "/chaos", JSON.stringify({ payload: "BTC banned" }), {}))!.body as {
    payload_hash: string;
  };
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

test("pairIdle pairs idle enclave agents above the min bond, neighbours by pk, odd one waits", () => {
  const ag = (pk: string, over: Partial<AgentView> = {}): AgentView => ({
    pk,
    model_id: "m",
    bond: "100",
    tee: true,
    in_duel: null,
    ...over,
  });
  const board = [
    ag("D"),
    ag("B"),
    ag("A"),
    ag("C", { in_duel: "7" }),
    ag("E", { tee: false }),
    ag("F", { bond: "10" }),
    ag("G"),
  ];
  assert.deepEqual(pairIdle(board, 50n), [
    ["A", "B"],
    ["D", "G"],
  ]);
  assert.deepEqual(pairIdle(board), [
    ["A", "B"],
    ["D", "F"],
  ]); // min bond 0: F qualifies, G is the odd one out
  assert.deepEqual(pairIdle([ag("A")]), []);
});

test("route: GET /agent_duel returns the agent's open duel from get_agent, decoding a '+' in the pk", async () => {
  const seen: string[] = [];
  const arena = new Arena({} as never, "s.testnet", {
    getAgent: async (pk) => {
      seen.push(pk);
      return pk === "a+b=" ? { pk, model_id: "m", bond: "1", tee: true, in_duel: "42" } : null;
    },
  });
  const hit = (await arena.route("GET", "/agent_duel?pk=a%2Bb%3D", ""))!.body as {
    duel_id: string | null;
    registered: boolean;
  };
  assert.deepEqual([hit.registered, hit.duel_id], [true, "42"]);
  const miss = (await arena.route("GET", "/agent_duel?pk=zzzz", ""))!.body as {
    duel_id: string | null;
    registered: boolean;
  };
  assert.deepEqual([miss.registered, miss.duel_id], [false, null]);
  assert.equal((await arena.route("GET", "/agent_duel?pk=", ""))!.code, 400);
  assert.deepEqual(seen, ["a+b=", "zzzz"]);
  assert.deepEqual((await arena.route("GET", "/pairing", ""))!.body, { every_s: 0, next_at: 0, last: [] });
});

test("pairIdle leaves excluded agents (the operator's own runner pair) alone", () => {
  const mk = (pk: string) => ({ pk, tee: true, in_duel: null, bond: "1" }) as never;
  const pairs = pairIdle([mk("c"), mk("a"), mk("b"), mk("d")], 0n, new Set(["a"]));
  assert.deepEqual(pairs, [["b", "c"]]);
});
