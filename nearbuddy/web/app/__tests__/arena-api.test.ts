// The v1 arena summary (app/api/arena.ts): integer yoctoNEAR -> NEAR, and summary() over a hand-built
// snapshot (fixtures/snap.ts) instead of the RPC. summary() also joins the published dataset; with no
// app/data, or with agent keys the dataset never uses (as here), every agent gets an empty attack record.
// Run: `cd web && bun test app/__tests__`.
import { describe, expect, test } from "bun:test";
import { ms, nearOf, shortModel, summary, symbolOf, usd } from "../api/arena";
import { agent, config, duel, intent, NOW, ns, outcome, snap, YOCTO, ZERO_PROOF } from "./fixtures/snap";

describe("nearOf", () => {
  test("integer yoctoNEAR to NEAR with no float drift", () => {
    expect(nearOf("2663000000000000000000000")).toBe(2.663);
    expect(nearOf("100000000000000000000000")).toBe(0.1);
    expect(nearOf(`123456789${YOCTO}`)).toBe(123456789);
  });
  test("truncates below the last digit kept, never rounds up", () => {
    expect(nearOf("2663999999999999999999999")).toBe(2.663);
    expect(nearOf("1999999999999999999999999", 2)).toBe(1.99);
    expect(nearOf("1")).toBe(0);
  });
  test("empty is 0", () => {
    expect(nearOf(null)).toBe(0);
    expect(nearOf(undefined)).toBe(0);
    expect(nearOf("")).toBe(0);
    expect(nearOf("0")).toBe(0);
  });
});

describe("unit helpers", () => {
  test("usd: price x1e8 to dollars, null stays null", () => {
    expect(usd("377386666")).toBe(3.77386666);
    expect(usd(null)).toBeNull();
  });
  test("ms: nanoseconds to whole milliseconds", () => {
    expect(ms("1793978347000000000")).toBe(1_793_978_347_000);
    expect(ms("1793978069561902175")).toBe(1_793_978_069_561);
  });
  test("symbolOf and shortModel", () => {
    expect(symbolOf("wrap.near")).toBe("NEAR/USD");
    expect(symbolOf("other.near")).toBe("other.near");
    expect(shortModel("deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe("DeepSeek-V4.1-Flash");
  });
});

const A = "test-agent-a";
const B = "test-agent-b";
const STUB = "test-agent-stub";
const lb = [
  agent(A, "Qwen/Qwen3.8-27B", { alpha_bps: 1234, bond: "2663000000000000000000000", in_duel: "11" }),
  agent(B, "deepseek-ai/DeepSeek-V4.1-Flash-1017", { alpha_bps: -50, tee: false }),
  agent(STUB, "stub/always-long"),
];
const won = (id: string, a: string, b: string, winner: string | null) =>
  duel(id, a, b, { outcome: outcome({ winner, pnl_a: winner === a ? 9 : -9, pnl_b: winner === b ? 9 : -9 }) });

describe("summary: records", () => {
  test("won, lost and tied over the resolved duels in the window", async () => {
    const s = await summary(
      snap({
        leaderboard: lb,
        duels: [
          duel("11", A, B, { resolved: false, outcome: null }), // live: not in the record
          won("10", A, B, A),
          won("9", B, A, A),
          won("8", A, B, B),
          won("7", B, A, null), // level
          duel("6", A, B, { resolved: true, outcome: null }), // resolved, no outcome yet: not counted
          won("5", B, STUB, B),
        ],
      }),
      NOW,
    );
    const rec = Object.fromEntries(s.standings.map((x) => [x.agent, x.record]));
    // A's own side each time: +9 (10), +9 (9, as b), -9 (8), -9 (7, as b): reading pnl_a for both sides gives -0.18
    expect(rec[A]).toEqual({ won: 2, lost: 1, tied: 1, window: 4, return_pct: 0 });
    expect(rec[B]).toBeUndefined(); // no enclave proof: not in the standings
  });

  test("the hero is the newest open duel between enclave-verified models, not a newer test duel", async () => {
    const C = "test-agent-c";
    const s = await summary(
      snap({
        leaderboard: [...lb, agent(C, "Qwen/Qwen3.6-35B-A3B-FP8")],
        duels: [
          duel("12", STUB, B, { resolved: false, outcome: null }),
          duel("11", A, C, { resolved: false, outcome: null }),
        ],
      }),
      NOW,
    );
    expect(s.live?.duel).toBe(11);
    expect(s.live_duels).toEqual([12, 11]);
  });

  test("stub and unverified agents are hidden from the standings; the rest keep their units", async () => {
    const s = await summary(snap({ leaderboard: lb }));
    expect(s.standings.map((x) => x.agent)).toEqual([A]);
    expect(s.standings[0]).toMatchObject({
      model: "Qwen/Qwen3.8-27B",
      verified: true,
      return_pct: 12.34,
      bond_near: 2.663,
      in_duel: 11,
      record: { won: 0, lost: 0, tied: 0, window: 0 },
      attacks: { faced: 0, resisted: 0, named: 0, fell: 0, unmoved: 0 },
      calls: { scored: 0, right: 0 },
      prompt: null,
    });
    expect(s.standings.find((x) => x.agent === B)).toBeUndefined();
  });
});

describe("summary: live vs recent", () => {
  const live = duel("12", A, STUB, {
    resolved: false,
    outcome: null,
    pool: `3${YOCTO}`,
    open_price: "377950000",
    open_at: ns(NOW - 60_000),
    close_at: ns(NOW + 90_400),
    injections: [{ kind: "fake_news", payload_hash: "unknown-hash", target: A, block: "1" }],
    last_intent_a: intent(A, "12", "Short", { size_bps: 2500 }),
    last_intent_b: intent(STUB, "12", "Long", { proof_hash: ZERO_PROOF }),
  });

  test("the first unresolved duel is live, in human units", async () => {
    const s = await summary(snap({ leaderboard: lb, duels: [live, won("10", A, B, A)] }), NOW);
    expect(s.live).toEqual({
      duel: 12,
      market: "NEAR/USD",
      opened_at: NOW - 60_000,
      closes_at: NOW + 90_400,
      seconds_left: 90,
      pot_near: 3,
      open_price_usd: 3.7795,
      a: { agent: A, model: "Qwen/Qwen3.8-27B", side: "Short", size_pct: 25, verified: true },
      // a hidden stub still shows its model in a duel; a zero proof hash is not verified
      b: { agent: STUB, model: "stub/always-long", side: "Long", size_pct: 50, verified: false },
      attacks: [{ target: A, kind: "fake_news", text: null, payload_sha256: "unknown-hash" }],
    });
  });

  test("seconds_left never goes negative after the bell", async () => {
    const s = await summary(snap({ leaderboard: lb, duels: [live] }), NOW + 200_000);
    expect(s.live?.seconds_left).toBe(0);
  });

  test("an agent missing from the leaderboard is 'unregistered'; no call means no side", async () => {
    const s = await summary(snap({ duels: [duel("12", "ghost", B, { resolved: false, outcome: null })] }));
    expect(s.live?.a).toEqual({ agent: "ghost", model: "unregistered", side: null, size_pct: null, verified: false });
  });

  test("with every duel resolved nothing is live; recent is the newest ten, scored by the contract", async () => {
    const duels = Array.from({ length: 12 }, (_, i) => won(String(20 - i), A, B, i % 2 ? B : A));
    duels[0] = duel("20", A, B, {
      last_intent_a: intent(A, "20", "Long"),
      outcome: outcome({ winner: A, pnl_a: 18, pnl_b: -18, slashed: `1${YOCTO}`, injections: 2 }),
    });
    const s = await summary(snap({ leaderboard: lb, duels }));
    expect(s.live).toBeNull();
    expect(s.recent.map((r) => r.duel)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
    expect(s.recent[0]).toMatchObject({
      market: "NEAR/USD",
      open_price_usd: 3.77386666,
      close_price_usd: 3.78033333,
      a: { agent: A, side: "Long", return_pct: 0.18 },
      b: { agent: B, side: null, return_pct: -0.18 },
      winner: A,
      slashed_near: 1,
      attacks: 2,
    });
  });
});

describe("summary: rules", () => {
  test("a deploy-13 config (no commit-reveal fields) reads as off", async () => {
    const s = await summary(snap({ config: config() }));
    expect(s.rules).toEqual({
      duel_seconds_min: 300,
      decisions_locked_last_seconds: 30,
      loser_slashed_pct: 10,
      attack_cost_near: 0.1,
      sealed_calls: false,
      no_reveal_forfeit_pct: 0,
      pairing_needs_consent: false,
    });
    expect(s.duels_total).toBe(12);
  });
  test("deploy 14: sealed calls, the no-reveal forfeit and consent", async () => {
    const s = await summary(
      snap({ config: config({ commit_reveal: true, no_reveal_bps: 500, require_consent: true }) }),
    );
    expect(s.rules).toMatchObject({ sealed_calls: true, no_reveal_forfeit_pct: 5, pairing_needs_consent: true });
  });
});

describe("summary: the team's test agents stay off the standings", () => {
  test("a red-team registration with an enclave key is not ranked", async () => {
    const R = "redteam-agent";
    const s = await summary(
      snap({
        leaderboard: [agent(A, "Qwen/Qwen3.8-27B", { tee: true }), agent(R, "redteam/tee", { tee: true })],
        duels: [won("10", A, R, A)],
      }),
      NOW,
    );
    expect(s.standings.map((x) => x.agent)).toEqual([A]);
  });
});
