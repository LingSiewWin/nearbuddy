import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Chaos, Mandate } from "../../protocol/src/abi/arena.ts";
import { agent, config, configV14, configV16, duel } from "./arena.fixture.ts";
import { type Quote, type QuoteRequest, USDC_NEAR, WNEAR } from "./oneclick.ts";

// Keep the unit tests away from the solver's real state files.
const scratch = mkdtempSync(join(tmpdir(), "arena-test-"));
process.env.ARENA_PAYLOADS = join(scratch, "payloads.json");
process.env.ARENA_HISTORY = join(scratch, "history.json");
process.env.ARENA_SECRET ??= "route-test-secret"; // shared module cache: arena.routes.test.ts reads it back from the module
const {
  Arena,
  fillRecipient,
  mandateOpen,
  meetsFloor,
  outputToken,
  pairIdle,
  quoteAmount,
  staggerClose,
  tokenAllowed,
} = await import("./arena.ts");

const fixture = JSON.parse(readFileSync(new URL("../fixtures/oneclick-quote.json", import.meta.url), "utf8")) as Quote;
const NOW = 1_700_000_000_000_000_000n;
/** `get_config` before deploy 15 (no `intents_account`), so quotesFor never reaches the network. */
const V14 = async () => configV14();
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

test("deploy 15: the quoted amount leaves room for the fee inside the cap", () => {
  // fee 50 bps: 300 cap -> 298, and 298 + floor(298 * 50 / 10000) = 299 <= 300 (the contract's "over cap" check)
  for (const [mm, fee] of [
    [m(), 50],
    [m({ per_tx_cap: (10n ** 24n).toString(), allowance: (10n ** 25n).toString() }), 50],
    [m({ spent: "900" }), 1_000],
  ] as const) {
    const a = quoteAmount(mm, fee);
    const debit = a + (a * BigInt(fee)) / 10_000n;
    const limit = quoteAmount(mm);
    assert.ok(debit <= limit && a > 0n, `amount ${a} debit ${debit} limit ${limit}`);
    assert.ok(limit - debit <= 1n + limit / 10_000n, "and fills the cap up to rounding");
  }
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

test("deploy 16.1: unknown path is null; pending = on-chain injections whose payload we hold, minus consumed", async () => {
  const arena = new Arena({} as never, "s.testnet", {
    config: async () => configV16(),
    getChaos: async () => assert.fail("16.1 has no get_chaos"),
    getDuel: async () =>
      duel({
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

/** One `get_chaos` record (deploy 17), pending unless `over` says otherwise. */
const chaos = (over: Partial<Chaos> = {}): Chaos => ({
  arm: "Cue",
  at: "100",
  claimed: false,
  decided_by: null,
  headline: "BREAKING: Binance halts NEAR withdrawals",
  injector: "spectator.testnet",
  kind: "Short",
  next: null,
  outcome: "Pending",
  payout: "0",
  prev: null,
  stake: "1",
  target: "A",
  ...over,
});

test("deploy 17: pending = the headlines get_chaos still lists as Pending, by target, with index, arm and time", async () => {
  const arena = new Arena({} as never, "s.testnet", {
    config: async () => config(),
    getDuel: async () =>
      duel({
        injections: [
          { kind: "Short", payload_hash: "H0", target: "A", block: "1" },
          { kind: "Long", payload_hash: "H1", target: "A", block: "2" },
          { kind: "Placebo", payload_hash: "H2", target: "B", block: "3" },
        ],
      }),
    getChaos: async () => [
      chaos({ outcome: "Held", next: "Short", decided_by: "9" }),
      chaos({ kind: "Long", arm: "Clean", headline: "SEC approves NEAR ETF", at: "200" }),
      chaos({ kind: "Placebo", arm: "Placebo", headline: "NEAR turns six", target: "B", at: "300" }),
    ],
  });
  arena.openDuels.add("1");
  arena.payloads.set("H0", "a 16.1 stash is not read on 17");
  const snap = (await arena.route("GET", "/arena", ""))!.body as { pending: Record<string, unknown[]> };
  assert.deepEqual(snap.pending, {
    A: [
      {
        duel_id: "1",
        target: "A",
        kind: "Long",
        payload: "SEC approves NEAR ETF",
        payload_hash: "H1",
        block: "2",
        index: 1,
        arm: "Clean",
        at: "200",
      },
    ],
    B: [
      {
        duel_id: "1",
        target: "B",
        kind: "Placebo",
        payload: "NEAR turns six",
        payload_hash: "H2",
        block: "3",
        index: 2,
        arm: "Placebo",
        at: "300",
      },
    ],
  });
});

test("deploy 17: a resolved duel leaves pending; no config read while nothing is open", async () => {
  let reads = 0;
  const arena = new Arena({} as never, "s.testnet", {
    config: async () => {
      reads++;
      return config();
    },
    getDuel: async () => duel({ resolved: true }),
    getChaos: async () => [chaos({ outcome: "Expired" })],
  });
  assert.deepEqual(await arena.pending(), {});
  assert.equal(reads, 0);
  arena.openDuels.add("1");
  assert.deepEqual(await arena.pending(), {});
  assert.equal(arena.openDuels.size, 0);
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
  const board = [
    agent("D"),
    agent("B"),
    agent("A"),
    agent("C", { in_duel: "7" }),
    agent("E", { tee: false }),
    agent("F", { bond: "10" }),
    agent("G"),
  ];
  assert.deepEqual(pairIdle(board, 50n), [
    ["A", "B"],
    ["D", "G"],
  ]);
  assert.deepEqual(pairIdle(board), [
    ["A", "B"],
    ["D", "F"],
  ]); // min bond 0: F qualifies, G is the odd one out
  assert.deepEqual(pairIdle([agent("A")]), []);
});

test("route: GET /agent_duel returns the agent's open duel from get_agent, decoding a '+' in the pk", async () => {
  const seen: string[] = [];
  const arena = new Arena({} as never, "s.testnet", {
    getAgent: async (pk) => {
      seen.push(pk);
      return pk === "a+b=" ? agent(pk, { in_duel: "42" }) : null;
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
  assert.deepEqual((await arena.route("GET", "/pairing", ""))!.body, {
    every_s: 0,
    next_at: 0,
    stagger_s: 60,
    last: [],
  });
});

test("staggerClose keeps every close a gap from the running ones and never shortens a duel", () => {
  const S = 1000;
  // nothing running: exactly now + duel length
  assert.equal(staggerClose(0, 330, 60), 330 * S);
  // a running duel closing 20 s after the floor: pushed one gap past it
  assert.equal(staggerClose(0, 330, 60, [350 * S]), 410 * S);
  // one closing a full gap before the floor, or a full gap after it: untouched
  assert.equal(staggerClose(0, 330, 60, [270 * S, 390 * S]), 330 * S);
  // a run of closes one gap apart (order given does not matter): lands after the last
  assert.equal(staggerClose(0, 330, 60, [450 * S, 330 * S, 390 * S]), 510 * S);
  // a hole two gaps wide between running closes is used
  assert.equal(staggerClose(0, 330, 60, [300 * S, 420 * S]), 360 * S);
  // gap 0: the stagger is off
  assert.equal(staggerClose(0, 330, 0, [330 * S]), 330 * S);
  // one tick of n pairs: every close at least a gap from the others, the first at the floor
  const taken: number[] = [];
  for (let i = 0; i < 5; i++) taken.push(staggerClose(0, 330, 60, taken));
  assert.deepEqual(
    taken,
    [330, 390, 450, 510, 570].map((x) => x * S),
  );
});

test("pairIdle leaves excluded agents (the operator's own runner pair) alone", () => {
  const mk = (pk: string) => agent(pk, { bond: "1" });
  const pairs = pairIdle([mk("c"), mk("a"), mk("b"), mk("d")], 0n, new Set(["a"]));
  assert.deepEqual(pairs, [["b", "c"]]);
});

// ---- settle_follow's token and price checks, before quoting ---------------------------------------------------
const ONE = 10n ** 24n;
const U128_MAX = (1n << 128n) - 1n;

test("tokenAllowed and meetsFloor answer the contract's unit-test cases the way follow.rs does", () => {
  // the contract's `mandate()` helper: min_out_per_near 1
  const cm = (tokens: string[], floor = "1") => m({ allowed_tokens: tokens, min_out_per_near: floor });
  // fill_wrong_token_rejected: a usdc-only mandate refuses wbtc ("token not allowed")
  assert.ok(!tokenAllowed(cm(["usdc"]), "wbtc"));
  assert.ok(tokenAllowed(cm(["usdc"]), "usdc"));
  assert.ok(tokenAllowed(cm([]), "wbtc"), "an empty list allows any token");
  // price_floor_refuses_a_cheap_fill: floor 3 USDC per NEAR; 1 NEAR for 2.9 USDC refused, 3.0 settles
  assert.ok(!meetsFloor(cm([], "3000000"), ONE, 2_900_000n));
  assert.ok(meetsFloor(cm([], "3000000"), ONE, 3_000_000n));
  // price_floor_overflow_is_rejected_not_panicked: floor u128::MAX, fill(1, "usdc", 2) ("amount overflow")
  assert.ok(!meetsFloor(cm([], U128_MAX.toString()), 2n, 1_000_000n));
  // zero_output_never_settles: the floor-1 mandate refuses 0 out ("below min price")
  assert.ok(!meetsFloor(cm([]), 50n, 0n));
  // the default fill (50 in, 1_000_000 out) clears the floor-1 mandate; a migrated floor-0 mandate has no floor
  assert.ok(meetsFloor(cm([]), 50n, 1_000_000n));
  assert.ok(meetsFloor(cm([], "0"), 50n, 0n));
  assert.ok(meetsFloor(m(), 50n, 0n), "before deploy 15: no min_out_per_near");
  // the fill's token is the quote's destination
  assert.equal(outputToken("Short"), USDC_NEAR);
  assert.equal(outputToken("Long"), WNEAR);
});

/** 1Click stand-in at 3.7 USDC per NEAR, sized by the request: EXACT_INPUT pays out USDC for NEAR in, EXACT_OUTPUT
 *  charges USDC for the NEAR out. */
const priced = (asked: QuoteRequest[]) => async (req: QuoteRequest) => {
  asked.push(req);
  const usdc = ((BigInt(req.amount) * 3_700_000n) / ONE).toString();
  const exactOut = req.swapType === "EXACT_OUTPUT";
  return {
    ...fixture,
    quoteRequest: { ...fixture.quoteRequest, swapType: req.swapType },
    quote: {
      ...fixture.quote,
      amountIn: exactOut ? usdc : req.amount,
      amountOut: exactOut ? req.amount : usdc,
      amountInFormatted: exactOut ? String(Number(usdc) / 1e6) : String(Number(BigInt(req.amount) / 10n ** 18n) / 1e6),
      amountOutFormatted: exactOut ? String(Number(BigInt(req.amount) / 10n ** 18n) / 1e6) : String(Number(usdc) / 1e6),
    },
  } as Quote;
};
const nearMandate = (over: Partial<Mandate>) =>
  m({ allowance: (10n * ONE).toString(), per_tx_cap: ONE.toString(), ...over });
const floorArena = (asked: QuoteRequest[], followers: [string, Mandate][]) =>
  new Arena({} as never, "nearbuddy-solver.testnet", {
    config: V14,
    listFollowers: async () => followers,
    quote: priced(asked),
    now: () => NOW,
  });

test("quotesFor skips a follower whose mandate does not allow the side's output token", async () => {
  const usdcOnly = nearMandate({ allowed_tokens: [USDC_NEAR] });
  const followers: [string, Mandate][] = [
    ["usdc.testnet", usdcOnly],
    ["any.testnet", nearMandate({})],
  ];
  // Long lands wNEAR: the USDC-only follower is refused before the quote, the batch covers only the other one
  const asked: QuoteRequest[] = [];
  const long = await floorArena(asked, followers).quotesFor("pk", "Long");
  assert.deepEqual(
    long.map((x) => [x.follower, x.error ?? "quoted"]),
    [
      ["usdc.testnet", `token not allowed: ${WNEAR}`],
      ["any.testnet", "quoted"],
    ],
  );
  assert.deepEqual(
    asked.map((r) => r.amount),
    [ONE.toString()],
  );
  // Short lands USDC: both are quoted in one batch
  const short: QuoteRequest[] = [];
  const out = await floorArena(short, followers).quotesFor("pk", "Short");
  assert.ok(out.every((x) => x.quote));
  assert.deepEqual(
    short.map((r) => r.amount),
    [(2n * ONE).toString()],
  );
});

test("batched quotesFor drops a follower under its price floor and re-quotes the rest", async () => {
  const followers: [string, Mandate][] = [
    ["ok.testnet", nearMandate({ min_out_per_near: "3600000" })], // 3.6 USDC per NEAR: the 3.7 quote clears it
    ["high.testnet", nearMandate({ min_out_per_near: "3800000" })], // 3.8: refused by settle_follow
  ];
  const asked: QuoteRequest[] = [];
  const out = await floorArena(asked, followers).quotesFor("pk", "Short");
  assert.deepEqual(
    asked.map((r) => r.amount),
    [(2n * ONE).toString(), ONE.toString()],
    "the second quote covers only the follower the floor admits",
  );
  assert.equal(out[0]?.follower, "ok.testnet");
  assert.equal(out[0]?.quote_out, "3700000");
  assert.equal(out[1]?.quote, undefined);
  assert.match(out[1]?.error ?? "", /^below min price: 3700000 out for 1000000000000000000000000 in$/);
});

test("BATCH_RFQ=0: a follower whose own quote misses the floor gets an error, not a quote", async () => {
  const followers: [string, Mandate][] = [
    ["ok.testnet", nearMandate({ min_out_per_near: "3600000" })],
    ["high.testnet", nearMandate({ min_out_per_near: "3800000" })],
  ];
  const out = await withEnv({ BATCH_RFQ: "0" }, () => floorArena([], followers).quotesFor("pk", "Short"));
  assert.ok(out[0]?.quote);
  assert.equal(out[1]?.quote, undefined);
  assert.match(out[1]?.error ?? "", /^below min price/);
});
