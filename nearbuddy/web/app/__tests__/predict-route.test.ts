// GET /api/predict against fake views: the open/closed test per market (the predict contract's `still_open`), the
// label a market nobody called yet would get, input validation before any RPC, and the CDN cache header.
import { afterAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import { marketsOf } from "../api/predict";
import type { Chaos, ChaosOpen, Duel } from "../lib/abi/arena";
import type { MarketView } from "../lib/abi/predict";

const S = 1_000_000_000n; // ns per second
const T0 = Date.UTC(2026, 10, 11, 3);
const NOW = BigInt(T0) * 1_000_000n;
const duel = (extra: Partial<Duel> = {}): Duel => ({
  id: "480",
  a: "A=",
  b: "B=",
  symbol: "wrap.near",
  open_at: String(NOW - 60n * S),
  close_at: String(NOW + 240n * S), // midpoint at NOW + 90 s
  pool: "0",
  injections: [],
  resolved: false,
  last_intent_a: null,
  last_intent_b: null,
  open_price: "370000000",
  outcome: null,
  ...extra,
});
const rec = (outcome: Chaos["outcome"]): Chaos => ({
  arm: "Cue",
  at: "1",
  claimed: false,
  decided_by: null,
  headline: "BREAKING: NEAR halts withdrawals",
  injector: "spectator.testnet",
  kind: "Short",
  next: null,
  outcome,
  payout: "0",
  prev: "Long",
  stake: "1",
  target: "B=",
});
const called = (index: number | null, n: number[], extra: Partial<MarketView> = {}): MarketView => ({
  duel_id: "480",
  index,
  picks: (index === null ? (["A", "B", "Tie"] as const) : (["Flipped", "Held"] as const)).map((pick, i) => ({
    pick,
    n: n[i] ?? 0,
  })),
  total: n.reduce((a, b) => a + b, 0),
  scored: 0,
  settled: false,
  outcome: null,
  steered_by: null,
  open_until_reveal: false,
  ...extra,
});
const LOCK = String(30n * S);

describe("marketsOf", () => {
  test("the duel market closes at the midpoint and at the commit lock, like the contract", () => {
    const open = (d: Duel, lock: string | null, now = NOW) => marketsOf(d, lock, [], null, [], now)[0]?.open;
    expect(open(duel(), LOCK)).toBe(true);
    expect(open(duel(), LOCK, NOW + 90n * S)).toBe(false); // the midpoint
    expect(open(duel({ close_at: String(NOW + 20n * S), open_at: String(NOW - 200n * S) }), LOCK)).toBe(false);
    expect(open(duel(), String(240n * S))).toBe(false); // now + lock reaches close_at
    expect(open(duel({ resolved: true }), LOCK)).toBe(false);
    expect(open(duel(), null)).toBe(false); // no lock: the contract refuses ("duel missing")
  });

  test("a market nobody called is served with zero calls; a called one with the contract's split", () => {
    const [m0, m1] = marketsOf(duel(), LOCK, [rec("Pending")], null, [called(null, [5, 2, 0])], NOW);
    expect(m0).toMatchObject({ index: null, total: 7, open: true });
    expect(m1).toMatchObject({ index: 0, total: 0, settled: false, outcome: null, open: true });
    expect(m1?.picks).toEqual([
      { pick: "Flipped", n: 0 },
      { pick: "Held", n: 0 },
    ]);
  });

  test("without chaos_open a Pending headline is open until the reveal and labelled so; a decided one is closed", () => {
    const ms = marketsOf(duel(), LOCK, [rec("Pending"), rec("Held"), rec("NoTrial")], null, [], NOW);
    expect(ms.map((m) => [m.index, m.open, m.open_until_reveal])).toEqual([
      [null, true, false],
      [0, true, true],
      [1, false, false],
      [2, false, false],
    ]);
  });

  test("with chaos_open: its answer opens or closes the market and names the owner who can steer it", () => {
    const opens = new Map<number, ChaosOpen | null>([
      [0, { open: true, keyless: false, owner: "op.testnet" }],
      [1, { open: false, keyless: false, owner: "op.testnet" }],
      [2, { open: true, keyless: true, owner: "k.testnet" }],
      [3, null],
    ]);
    const chaos = [rec("Pending"), rec("Pending"), rec("Pending"), rec("Pending")];
    const ms = marketsOf(duel(), LOCK, chaos, opens, [], NOW).slice(1);
    expect(ms.map((m) => [m.open, m.steered_by, m.open_until_reveal])).toEqual([
      [true, "op.testnet", false],
      [false, "op.testnet", false],
      [true, null, false], // keyless: no owner (steerLine says any keeper can resample it)
      [false, null, false], // the arena answered none: the contract refuses
    ]);
  });

  test("a called market keeps the label the contract stored at its first call; a settled one is closed", () => {
    const ms = marketsOf(
      duel(),
      LOCK,
      [rec("Pending"), rec("Held")],
      null,
      [called(0, [1, 3], { open_until_reveal: true }), called(1, [2, 2], { settled: true, outcome: "Held" })],
      NOW,
    );
    expect(ms[1]).toMatchObject({ open: true, open_until_reveal: true, total: 4 });
    expect(ms[2]).toMatchObject({ open: false, settled: true, outcome: "Held" });
  });

  test("at most the contract's 32 chaos markets", () => {
    expect(marketsOf(duel(), LOCK, Array(40).fill(rec("Held")), null, [], NOW)).toHaveLength(33);
  });
});

// the route, against fake views; another test file may have mocked ../api/near, so the fake keeps its other exports
const views: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_duel: () => duel(),
  duel_lock: () => LOCK,
  get_chaos: () => [rec("Pending"), rec("Held")],
  chaos_open: () => {
    throw Object.assign(new Error("Contract method is not found"), { name: "ContractMethodNotFoundError" });
  },
  get_duel_markets: () => [called(null, [3, 1, 0])],
  get_predictions: ({ account }) => [
    { duel_id: "480", index: null, pick: "A", at: "1", verdict: account === "right.testnet" ? "Right" : null },
  ],
};
const asked: string[] = [];
const view = async (method: string, args: Record<string, unknown>) => {
  asked.push(method);
  const f = views[method];
  if (!f) throw new Error(`no view ${method}`);
  return f(args);
};
const near = await import("../api/near");
mock.module("../api/near", () => ({
  ...near,
  arenaView: view,
  predictView: view,
  jsonBody: (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)),
  json: (body: string, status = 200, cache = "no-store") =>
    new Response(body, { status, headers: { "content-type": "application/json", "cache-control": cache } }),
}));
const { GET } = await import("../api/predict/route");
const get = (q: string) => GET(new Request(`http://x/api/predict?${q}`));
afterAll(() => setSystemTime());

describe("GET /api/predict", () => {
  test("bad input is refused before any RPC", async () => {
    for (const q of [
      "",
      "duel=abc",
      "duel=1e5",
      "duel=-1",
      "duel=1234567890123",
      "account=Bad!",
      "account=a",
      `account=${"a".repeat(65)}`,
      "account=a..b",
      "duel=1&account=a.testnet",
    ]) {
      const r = await get(q);
      expect(r.status, q).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  test("a duel: every market with its open flag, cached a few seconds at the CDN and in the process", async () => {
    setSystemTime(new Date(T0));
    const r = await get("duel=480");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, s-maxage=3, stale-while-revalidate=10");
    const body = (await r.json()) as { markets: (MarketView & { open: boolean })[] };
    expect(body.markets.map((m) => [m.index, m.open, m.total, m.open_until_reveal])).toEqual([
      [null, true, 4, false],
      [0, true, 0, true], // the deployed arena has no chaos_open: closes at the reveal, and says so
      [1, false, 0, false],
    ]);
    const before = asked.length;
    await get("duel=480");
    expect(asked.length).toBe(before); // served from the process cache
    setSystemTime(new Date(T0 + 3_500));
    await get("duel=480");
    expect(asked.filter((m) => m === "chaos_open")).toHaveLength(1); // a missing view is not asked again soon
  });

  test("an account: the calls it holds", async () => {
    const r = await get("account=right.testnet");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { held: unknown[] }).held).toEqual([
      { duel_id: "480", index: null, pick: "A", at: "1", verdict: "Right" },
    ]);
  });

  test("an RPC failure with no earlier body is a 502, not a guess", async () => {
    views.get_duel = () => {
      throw new Error("429");
    };
    expect((await get("duel=481")).status).toBe(502);
  });
});
