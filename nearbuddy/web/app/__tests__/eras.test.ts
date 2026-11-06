// The scoring-era split: the pure tally, then GET /api/arena and GET /api/agent against a fake contract
// (../api/near mocked), so the routes' id ranges and remainder maths are checked end to end without RPC.
// Run: `cd web && bun test app`.
import { describe, expect, mock, test } from "bun:test";
import { eraSplit, isOracleEra, ORACLE_ERA_FROM, operatorIds, oracleIds, type ScoredDuel, tally } from "../eras";

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
  "257": scored(257, P, Q, 30, -30, P),
  "258": scored(258, Q, P, 20, -20, Q),
  "259": scored(259, P, Q, 0, 0, null),
  "260": { ...scored(260, Q, P, 0, 0, null), resolved: false, outcome: null },
};
const AGENTS = [
  { owner: "o.testnet", pk: P, model_id: "m/p", bond: "1", alpha_bps: 100, shield: 1, in_duel: "260", tee: true },
  { owner: "o.testnet", pk: Q, model_id: "m/q", bond: "1", alpha_bps: -40, shield: 0, in_duel: "260", tee: true },
];
const calls: string[] = [];
const fakeView = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
  calls.push(`${method}:${String(args.duel_id ?? "")}`);
  switch (method) {
    case "get_config":
      return { next_duel: "261", slash_bps: 1000, min_chaos_deposit: "1" };
    case "leaderboard":
      return AGENTS;
    case "list_followers":
      return [];
    case "get_agent":
      return AGENTS.find((a) => a.pk === args.agent_pk) ?? null;
    case "get_duel":
      return DUELS[String(args.duel_id)] ?? null;
    default:
      throw new Error(`no view ${method}`);
  }
};
mock.module("../api/near", () => ({
  RPC: "https://fake.rpc",
  ARENA: "arena.fake.testnet",
  CONTRACT: "vault.fake.testnet",
  SOLVER_URL: "http://127.0.0.1:9", // refused at once: solver offline
  viewOn: () => fakeView,
  jsonBody: (v: unknown) => JSON.stringify(v),
  json: (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } }),
}));

describe("eras", () => {
  test("one named boundary", () => {
    expect(operatorIds(3)).toEqual(["2", "1", "0"]);
    expect(operatorIds(400)).toHaveLength(257);
    expect(operatorIds(400)[0]).toBe("256");
    expect(ORACLE_ERA_FROM).toBe(257);
    expect(isOracleEra("256")).toBe(false);
    expect(isOracleEra(257)).toBe(true);
    expect(oracleIds(261)).toEqual(["260", "259", "258", "257"]);
    expect(oracleIds(100)).toEqual([]);
  });
  test("tally credits like the contract: open duels skipped, an unrevealed side keeps only its loss", () => {
    const ds = ["257", "258", "259", "260"].map((id) => DUELS[id] as ScoredDuel);
    expect(tally(P, ds)).toEqual({ alpha_bps: 10, wins: 1, ties: 1, losses: 1, duels: 3 });
    const withheld = { ...(DUELS["257"] as ScoredDuel), no_reveal: [true, false] as [boolean, boolean] };
    expect(tally(P, [withheld]).alpha_bps).toBe(0); // +30 withheld: no gain
    expect(tally(Q, [{ ...withheld, no_reveal: [false, true] }]).alpha_bps).toBe(-30); // a loss stays
    expect(eraSplit(AGENTS, ds)).toEqual({
      [P]: { oracle: { alpha_bps: 10, wins: 1, ties: 1, losses: 1, duels: 3 }, operator_alpha_bps: 90 },
      [Q]: { oracle: { alpha_bps: -10, wins: 1, ties: 1, losses: 1, duels: 3 }, operator_alpha_bps: -30 },
    });
  });
});

describe("routes", () => {
  test("GET /api/arena: per-agent split over every oracle-era duel and the excluded operator-era count", async () => {
    const { GET } = await import("../api/arena/route");
    const j = await (await GET()).json();
    expect(j.eras.from).toBe(257);
    expect(j.eras.operator_duels).toBe(257);
    expect(j.eras.oracle_duels).toBe(3);
    expect(j.eras.by_agent[P]).toEqual({
      oracle: { alpha_bps: 10, wins: 1, ties: 1, losses: 1, duels: 3 },
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
    expect(j.eras.oracle).toEqual({ alpha_bps: 10, wins: 1, ties: 1, losses: 1, duels: 3 });
    expect(j.eras.operator).toEqual({ alpha_bps: 90, duels: 257, mine: null });
    const op = await (await GET(new Request(`http://x/api/agent?pk=${encodeURIComponent(P)}&era=operator`))).json();
    expect(op.era).toBe("operator");
    expect(op.duels.map((d: { id: string; result: string }) => `${d.id} ${d.result}`)).toEqual(["256 tie", "255 win"]);
    expect(op.eras).toEqual({ ...j.eras, operator: { alpha_bps: 90, duels: 257, mine: 2 } });
    expect(calls).not.toContain("agent_duels:"); // the live index is truncated: eras come from the duel scan
  });
});
