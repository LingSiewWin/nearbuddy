// The scoring-era split: the pure tally, then GET /api/arena and GET /api/agent against a fake contract
// (../api/near mocked), so the routes' id ranges, remainder maths, failed reads and leaderboard paging are
// checked end to end without RPC. Run: `cd web && bun test app`.
import { afterAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import {
  alphaScope,
  eraSplit,
  isOracleEra,
  isVoid,
  NO_OUTCOME,
  noOutcome,
  ORACLE_ERA_FROM,
  operatorIds,
  oracleEraFrom,
  oracleIds,
  pageEraFrom,
  type RowResult,
  recordCounts,
  type ScoredDuel,
  tally,
  unread,
} from "../eras";

const P = "UGFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=";
const Q = "UWJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=";
const scored = (id: number, a: string, b: string, pnl_a: number, pnl_b: number, winner: string | null) => ({
  id: String(id),
  a,
  b,
  resolved: true,
  outcome: { pnl_a, pnl_b, winner, open_price: "1", close_price: "1", slashed: "0", injections: 0 },
  injections: [],
  last_intent_a: null,
  last_intent_b: null,
  symbol: "wrap.near",
  open_at: "0",
  close_at: "0",
  pool: "0",
});
// lifetime alpha: P +100, Q -40. Operator era (255, 256): P +70 then a tie. Oracle era: P +30, -20, 0; 260 open.
const DUELS: Record<string, unknown> = {
  "255": scored(255, P, Q, 70, -70, P),
  "256": scored(256, Q, P, 0, 0, null),
  // shaped like testnet #0-21: resolved, but closed with no outcome (pre-migration layout)
  "254": { ...scored(254, P, Q, 0, 0, null), outcome: null, open_price: null },
  "257": scored(257, P, Q, 30, -30, P),
  "258": scored(258, Q, P, 20, -20, Q),
  "259": scored(259, P, Q, 0, 0, null),
  "260": { ...scored(260, Q, P, 0, 0, null), resolved: false, outcome: null },
};
const agentOf = (pk: string, alpha_bps: number) => ({
  owner: "o.testnet",
  pk,
  model_id: `m/${pk.slice(0, 4)}`,
  bond: "1",
  alpha_bps,
  shield: 0,
  in_duel: null,
  tee: true,
});
const AGENTS = [agentOf(P, 100), agentOf(Q, -40)];

// knobs the tests turn
const fake = {
  next: 261,
  commitReveal: false, // get_config carries no_reveal_bps (deploy 14)
  failDuel: new Set<string>(), // get_duel throws for these ids
  failNoReveal: new Set<string>(), // get_no_reveal throws for these ids
  board: "ignore-args" as "ignore-args" | "paged", // deploy 14 ignores {from, limit}; deploy 15 pages at 100
  extra: [] as ReturnType<typeof agentOf>[], // filler agents below P and Q
};
const calls: string[] = [];
const fakeView = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
  calls.push(`${method}:${String(args.duel_id ?? args.from ?? "")}`);
  const board = [...AGENTS, ...fake.extra];
  switch (method) {
    case "get_config":
      return {
        next_duel: String(fake.next),
        slash_bps: 1000,
        min_chaos_deposit: "1",
        ...(fake.commitReveal ? { commit_reveal: true, no_reveal_bps: 500 } : {}),
      };
    case "leaderboard": {
      if (fake.board === "ignore-args") return board;
      const from = Number(args.from);
      return board.slice(from, from + Math.min(100, Number(args.limit)));
    }
    case "list_followers":
      return [];
    case "get_agent":
      return board.find((a) => a.pk === args.agent_pk) ?? null;
    case "get_duel":
      if (fake.failDuel.has(String(args.duel_id))) throw new Error("rpc 429");
      return DUELS[String(args.duel_id)] ?? null;
    case "get_no_reveal":
      if (fake.failNoReveal.has(String(args.duel_id))) throw new Error("rpc 429");
      return [false, false];
    default:
      throw new Error(`no view ${method}`);
  }
};
mock.module("../api/near", () => ({
  RPC: "https://fake.rpc",
  ARENA: "arena.fake.testnet",
  SOLVER_URL: "http://127.0.0.1:9", // refused at once: solver offline
  arenaView: fakeView,
  arenaConfigAnyDeploy: () => fakeView("get_config", {}),
  jsonBody: (v: unknown) => JSON.stringify(v),
  json: (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } }),
}));

// the arena route caches its body 20 s: each build steps the clock past that
let clock = Date.UTC(2026, 10, 6, 12);
const arena = async () => {
  clock += 21_000;
  setSystemTime(new Date(clock));
  const { GET } = await import("../api/arena/route");
  return (await GET()).json();
};
afterAll(() => setSystemTime());

describe("eras", () => {
  test("one named boundary, per network", () => {
    expect(oracleEraFrom(undefined)).toBe(257);
    expect(oracleEraFrom("testnet")).toBe(257);
    expect(oracleEraFrom("mainnet")).toBe(0); // a mainnet arena is oracle-scored from duel 0
    expect(ORACLE_ERA_FROM).toBe(oracleEraFrom(process.env.NEAR_NETWORK));
    expect(operatorIds(3)).toEqual(["2", "1", "0"]);
    expect(operatorIds(400)).toHaveLength(257);
    expect(operatorIds(400)[0]).toBe("256");
    expect(isOracleEra("256")).toBe(false);
    expect(isOracleEra(257)).toBe(true);
    expect(oracleIds(261)).toEqual(["260", "259", "258", "257"]);
    expect(oracleIds(100)).toEqual([]);
  });
  test("tally credits like the contract: open duels skipped, an unrevealed side keeps only its loss", () => {
    const ds = ["257", "258", "259", "260"].map((id) => DUELS[id] as ScoredDuel);
    expect(tally(P, ds)).toEqual({ alpha_bps: 10, wins: 1, ties: 1, losses: 1, voids: 0, duels: 3 });
    const withheld = { ...(DUELS["257"] as ScoredDuel), no_reveal: [true, false] as [boolean, boolean] };
    expect(tally(P, [withheld]).alpha_bps).toBe(0); // +30 withheld: no gain
    expect(tally(Q, [{ ...withheld, no_reveal: [false, true] }]).alpha_bps).toBe(-30); // a loss stays
    expect(eraSplit(AGENTS, ds)).toEqual({
      [P]: { oracle: { alpha_bps: 10, wins: 1, ties: 1, losses: 1, voids: 0, duels: 3 }, operator_alpha_bps: 90 },
      [Q]: { oracle: { alpha_bps: -10, wins: 1, ties: 1, losses: 1, voids: 0, duels: 3 }, operator_alpha_bps: -30 },
    });
  });
  test("a resolved duel without an outcome is labelled, and stays out of alpha and W/T/L", () => {
    const legacy = DUELS["254"] as ScoredDuel;
    expect(noOutcome(legacy)).toBe(true);
    expect(noOutcome(DUELS["260"] as ScoredDuel)).toBe(false); // open, not resolved
    expect(noOutcome(DUELS["255"] as ScoredDuel)).toBe(false);
    expect(NO_OUTCOME).toBe("resolved (no outcome recorded)");
    expect(tally(P, [legacy, DUELS["255"] as ScoredDuel])).toEqual({
      alpha_bps: 70,
      wins: 1,
      ties: 0,
      losses: 0,
      voids: 0,
      duels: 1,
    });
  });
  test("record counts: only scored duels enter the outcomes meter and the attacked / not-lost ratio", () => {
    const row = (result: RowResult, attacks = 0, resolved = true) => ({ resolved, result, attacks });
    const c = recordCounts([
      row("win", 2),
      row("tie"),
      row("loss", 1),
      row("void", 3), // never played: neither lost nor not lost
      row("no_outcome", 4), // pre-migration, never scored: not "not lost" either
      row("no_outcome"),
      row("open", 5, false), // still running
    ]);
    expect(c).toEqual({
      wins: 1,
      ties: 1,
      losses: 1,
      voids: 1,
      unscored: 2,
      scored: 3, // the meter's denominator: 6 resolved minus 1 void minus 2 without an outcome
      attacked: 2, // the win and the loss
      survived: 1, // the win
    });
  });
  test("a voided duel (both prices 0, as void_duel writes it) is counted apart, not as a tie", () => {
    const base = scored(300, P, Q, 0, 0, null);
    const voided = { ...base, outcome: { ...base.outcome, open_price: "0", close_price: "0" } } as ScoredDuel;
    expect(isVoid(voided.outcome)).toBe(true);
    expect(isVoid((DUELS["259"] as ScoredDuel).outcome)).toBe(false); // a real 0-0 tie has prices
    expect(isVoid(null)).toBe(false);
    const ds = [voided, DUELS["259"] as ScoredDuel];
    expect(tally(P, ds)).toEqual({ alpha_bps: 0, wins: 0, ties: 1, losses: 0, voids: 1, duels: 1 });
  });
  test("pages assume this build's network before the API answers", () => {
    const was = process.env.NEXT_PUBLIC_NEAR_NETWORK;
    process.env.NEXT_PUBLIC_NEAR_NETWORK = "mainnet";
    expect(pageEraFrom()).toBe(0); // no "from 257" flash on a mainnet build
    delete process.env.NEXT_PUBLIC_NEAR_NETWORK;
    expect(pageEraFrom()).toBe(257);
    if (was !== undefined) process.env.NEXT_PUBLIC_NEAR_NETWORK = was;
  });
  test("unread: a failed read, or a resolved duel without no_reveal once the contract has commit-reveal", () => {
    const d = DUELS["257"] as ScoredDuel;
    const open = DUELS["260"] as ScoredDuel;
    expect(unread([d, null, open], false)).toBe(1);
    expect(unread([d, open], true)).toBe(1); // resolved 257 lacks no_reveal; the open duel has none to read
    expect(unread([{ ...d, no_reveal: [false, false] }, open], true)).toBe(0);
  });
});

describe("routes", () => {
  test("GET /api/arena: per-agent split over every oracle-era duel and the excluded operator-era count", async () => {
    const j = await arena();
    expect(j.eras).toMatchObject({ from: 257, complete: true, unread: 0, operator_duels: 257, oracle_duels: 3 });
    expect(j.eras.by_agent[P]).toEqual({
      oracle: { alpha_bps: 10, wins: 1, ties: 1, losses: 1, voids: 0, duels: 3 },
      operator_alpha_bps: 90,
    });
    expect(j.eras.by_agent[Q].operator_alpha_bps).toBe(-30);
    const reads = calls.filter((c) => c.startsWith("get_duel:"));
    expect(new Set(reads).size).toBe(reads.length); // tail and oracle era overlap, each duel read once
  });
  test("GET /api/agent: oracle era by default, operator era on ?era=operator, the same split either way", async () => {
    const { GET } = await import("../api/agent/route");
    const j = await (await GET(new Request(`http://x/api/agent?pk=${encodeURIComponent(P)}`))).json();
    expect(j.era).toBe("oracle");
    expect(j.duels.map((d: { id: string }) => d.id)).toEqual(["260", "259", "258", "257"]);
    expect(j.eras).toMatchObject({ complete: true, unread: 0 });
    expect(j.eras.oracle).toEqual({ alpha_bps: 10, wins: 1, ties: 1, losses: 1, voids: 0, duels: 3 });
    expect(j.eras.operator).toEqual({ alpha_bps: 90, duels: 257, mine: null });
    const op = await (await GET(new Request(`http://x/api/agent?pk=${encodeURIComponent(P)}&era=operator`))).json();
    expect(op.era).toBe("operator");
    expect(op.duels.map((d: { id: string; result: string }) => `${d.id} ${d.result}`)).toEqual([
      "256 tie",
      "255 win",
      "254 no_outcome", // not "open": it is resolved
    ]);
    expect(op.eras).toEqual({ ...j.eras, operator: { alpha_bps: 90, duels: 257, mine: 3 } }); // 254 counts as one of its duels, never scored
    expect(calls).not.toContain("agent_duels:"); // the live index is truncated: eras come from the duel scan
  });
  test("a failed get_duel answers 200 with the split marked incomplete, then completes once the read succeeds", async () => {
    DUELS["261"] = scored(261, P, Q, 40, -40, P); // P's lifetime moves to +140 with it
    AGENTS[0]!.alpha_bps = 140;
    AGENTS[1]!.alpha_bps = -80;
    fake.next = 262;
    fake.failDuel.add("261");
    const j = await arena();
    expect(j.eras).toMatchObject({ complete: false, unread: 1 });
    expect(j.leaderboard).toHaveLength(2); // the rest of the board still renders
    fake.failDuel.clear();
    const k = await arena();
    expect(k.eras).toMatchObject({ complete: true, unread: 0 });
    expect(k.eras.by_agent[P]).toEqual({
      oracle: { alpha_bps: 50, wins: 2, ties: 1, losses: 1, voids: 0, duels: 4 },
      operator_alpha_bps: 90, // unchanged: the late read lands in the oracle era, not the remainder
    });
  });
  test("a failed get_no_reveal is never cached as 'no forfeit': the duel is re-read next build", async () => {
    fake.commitReveal = true; // the contract upgraded: every kept duel needs its no_reveal now
    fake.failNoReveal.add("258");
    const j = await arena();
    expect(j.eras).toMatchObject({ complete: false, unread: 1 });
    const before = calls.filter((c) => c === "get_no_reveal:258").length;
    fake.failNoReveal.clear();
    const k = await arena();
    expect(k.eras).toMatchObject({ complete: true, unread: 0 });
    expect(calls.filter((c) => c === "get_no_reveal:258").length).toBe(before + 1);
    await arena();
    expect(calls.filter((c) => c === "get_no_reveal:258").length).toBe(before + 1); // kept once it read
  });
  test("leaderboard: every page is read (deploy 15), and a contract that ignores the args is read once", async () => {
    fake.extra = Array.from({ length: 150 }, (_, i) => agentOf(btoa(`filler-${String(i).padStart(3, "0")}`), -100));
    fake.board = "paged";
    calls.length = 0;
    const paged = await arena();
    expect(paged.leaderboard).toHaveLength(152);
    expect(calls.filter((c) => c.startsWith("leaderboard:"))).toEqual(["leaderboard:0", "leaderboard:100"]);
    fake.board = "ignore-args"; // deploy 14 returns everyone whatever {from, limit} says
    calls.length = 0;
    const all = await arena();
    expect(all.leaderboard).toHaveLength(152);
    expect(calls.filter((c) => c.startsWith("leaderboard:"))).toEqual(["leaderboard:0", "leaderboard:100"]); // stops: no new agents
    fake.extra = [];
  });
});

test("alphaScope: the legend names the era the page ranks by, and who scored the rest", () => {
  expect(alphaScope(true, 257)).toBe("duels 257+, scored by the TEE oracle");
  // an incomplete split ranks by lifetime: the legend must say the operator key scored duels 0-256
  expect(alphaScope(false, 257)).toBe("all scored duels (0-256: operator key, 257+: TEE oracle)");
  expect(alphaScope(false, 0)).toBe("all scored duels (TEE oracle)");
});
