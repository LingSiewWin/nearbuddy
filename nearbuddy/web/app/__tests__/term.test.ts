// The terminal's view model: which duel pane 2 follows, the feed's order and verdicts, and the field diff that makes
// changed cells flash after a poll.
import { expect, test } from "bun:test";
import type { Chaos } from "../lib/abi/arena";
import {
  attacksOf,
  changed,
  type Duel,
  feed,
  fields,
  pickLive,
  type Snap,
  shortModel,
  textsOf,
  VERDICT_OF,
} from "../term/model";

const NS = (ms: number) => String(BigInt(ms) * 1_000_000n);
const now = Date.UTC(2026, 10, 9, 12);
const duel = (id: string, closeMs: number, resolved: boolean, extra: Partial<Duel> = {}): Duel => ({
  id,
  a: "A=",
  b: "B=",
  symbol: "wrap.near",
  close_at: NS(closeMs),
  pool: "0",
  injections: [],
  resolved,
  last_intent_a: null,
  last_intent_b: null,
  ...extra,
});

test("pane 2 follows a duel taking calls, then one awaiting its oracle, then the newest", () => {
  const live = duel("12", now + 60_000, false);
  const closing = duel("11", now - 5_000, false);
  const old = duel("10", now - 600_000, true);
  expect(pickLive([closing, live, old], now)?.id).toBe("12");
  expect(pickLive([closing, null, old], now)?.id).toBe("11");
  expect(pickLive([old], now)?.id).toBe("10");
  expect(pickLive([], now)).toBeNull();
  expect(pickLive(undefined, now)).toBeNull();
});

test("one attack count per duel: chain records, else the count kept at resolve, else the open list (duel 462)", () => {
  const inj = { kind: "fake_news/web", payload_hash: "h", target: "B=", block: "1" };
  // deploy 16 attack read under deploy 17: get_chaos is empty, the outcome still counts it
  const d462 = duel("462", now - 600_000, true, {
    chaos: [],
    outcome: { pnl_a: -3, pnl_b: -3, winner: null, injections: 1 },
  });
  expect(attacksOf(d462)).toBe(1);
  expect(fields(null, null, d462)["duel:462:attacks"]).toBe("1");
  expect(attacksOf(duel("13", now + 1, false, { injections: [inj, inj] }))).toBe(2);
  expect(attacksOf(duel("14", now + 1, false, { chaos: null, injections: [inj] }))).toBe(1);
  expect(attacksOf(duel("15", now + 1, false))).toBe(0);
});

test("the feed puts this browser's attacks first, then attacks on open duels, then the dataset's", () => {
  const snap: Snap = {
    at: now,
    contract: "arena.nearbuddy-solver.testnet",
    config: { next_duel: "13", min_chaos_deposit: "100000000000000000000000" },
    leaderboard: [
      { pk: "A=", model_id: "z-ai/glm-5.3-flash", tee: true, in_duel: "12" },
      { pk: "B=", model_id: "Qwen/Qwen3.8-27B", tee: true, in_duel: "12" },
    ],
    duels: [
      duel("12", now + 60_000, false, {
        injections: [
          { kind: "fake_news/web", payload_hash: "h0", target: "B=", block: "8" }, // text no longer pending
          { kind: "fake_news/web", payload_hash: "h1", target: "B=", block: "9" },
          { kind: "fake_news/web", payload_hash: "hM", target: "A=", block: "10" }, // this browser's own
        ],
        last_intent_b: { agent_pk: "B=", side: "Short", size_bps: 5000, nonce: "1", proof_hash: "p" },
      }),
    ],
    solver: { pending: { "B=": [{ kind: "fake_news/web", payload: "ETF approved", payload_hash: "h1" }] } },
  };
  const board = {
    source: "dataset/decisions.jsonl",
    rows: 1,
    models: [],
    recent: [
      {
        duel_id: "7",
        model: "z-ai/glm-5.3-flash",
        agent_pk: "A=",
        text: "halts",
        pushed: "Short" as const,
        test: "with" as const,
        before: "Long" as const,
        after: "Long" as const,
        verdict: "held" as const,
        reply: "oracle says up",
        tx: "T",
      },
    ],
  };
  const mine = [
    { tx: "OLD", duel: "12", target: "B=", text: "mine first", hash: "hB", before: "0", at: now }, // B called since
    { tx: "MINE", duel: "12", target: "A=", text: "mine", hash: "hM", before: null, at: now },
  ];
  const items = feed(snap, board, mine, { h0: "seen on an earlier poll" });
  expect(items.map((i) => [i.key, i.model, i.lie, i.after, i.verdict, i.mine])).toEqual([
    ["mine:MINE", "glm-5.3-flash", "mine", null, "waiting", true],
    ["mine:OLD", "Qwen3.8-27B", "mine first", "Short", "answered", true], // nonce 1 is newer than the 0 it was sent at
    // others' attacks: text matched by payload_hash; no call shown, it may predate the attack
    ["chain:12:1", "Qwen3.8-27B", "ETF approved", null, "waiting", false],
    ["chain:12:0", "Qwen3.8-27B", "seen on an earlier poll", null, "waiting", false],
    ["data:7:A=:halts", "glm-5.3-flash", "halts", "Long", "held", false],
  ]);
  expect(textsOf(snap)).toEqual({ h1: "ETF approved" });
  expect(feed(null, null, [])).toEqual([]);
});

test("deploy 17: the feed lists every chain record with its headline, arm and outcome, this browser's tx kept", () => {
  const rec = (target: string, headline: string, outcome: Chaos["outcome"], extra: Partial<Chaos> = {}): Chaos => ({
    arm: "Cue",
    at: "1",
    claimed: false,
    decided_by: null,
    headline,
    injector: "x.testnet",
    kind: "Short",
    next: null,
    outcome,
    payout: "0",
    prev: "Long",
    stake: "1",
    target,
    ...extra,
  });
  const snap: Snap = {
    at: now,
    contract: "arena.t",
    config: {
      next_duel: "13",
      min_chaos_deposit: "1",
      chaos: { base: "1", r_bps: 12_500, cap: "10", fee_bps: 500, share_bps: 5_000 },
    },
    leaderboard: [{ pk: "B=", model_id: "Qwen/Qwen3.8-27B", tee: true, in_duel: "12" }],
    duels: [
      duel("12", now + 60_000, false, {
        injections: [{ kind: "Short", payload_hash: "h", target: "B=", block: "1" }], // listed once, as a record
        chaos: [
          rec("B=", "ETF halted", "Flipped", { arm: "Clean", next: "Short", decided_by: "41" }),
          rec("B=", "mine", "Pending", { kind: "Long" }),
        ],
        chaos_fee: "125",
      }),
      duel("11", now - 600_000, true, { chaos: [rec("B=", "too late", "Expired")] }),
    ],
    solver: null,
  };
  const board = {
    source: "d",
    rows: 1,
    models: [],
    recent: [
      {
        duel_id: "12",
        model: "Qwen/Qwen3.8-27B",
        agent_pk: "B=",
        text: "ETF halted", // the dataset's copy of the same attack: shown once
        pushed: "Short" as const,
        test: "with" as const,
        before: "Long" as const,
        after: "Short" as const,
        verdict: "fooled" as const,
        reply: "r",
        tx: "T",
      },
    ],
  };
  const mine = [{ tx: "TX", duel: "12", target: "B=", text: "mine", hash: null, before: null, at: now }];
  expect(
    feed(snap, board, mine).map((i) => [i.key, i.lie, i.pushed, i.arm, i.verdict, i.after, i.decided_by, i.tx, i.mine]),
  ).toEqual([
    ["chain:12:1", "mine", "Long", "Cue", "waiting", null, null, "TX", true],
    ["chain:12:0", "ETF halted", "Short", "Clean", "fooled", "Short", "41", null, false],
    ["chain:11:0", "too late", "Short", "Cue", "expired", null, null, null, false], // the older duel last
  ]);
  const f = fields(snap, null, snap.duels[0] ?? null);
  expect([f.price, f["duel:12:attacks"], f["duel:12:chaos:0"]]).toEqual(["125", "2", "Flipped"]);
  expect(Object.keys(VERDICT_OF).sort()).toEqual(["Expired", "Flipped", "Held", "NoTrial", "Pending"]);
});

test("only values that changed between two polls flash; a value seen for the first time does not", () => {
  const d = duel("12", now + 60_000, false);
  const before = fields(null, null, d);
  const after = fields(null, null, {
    ...d,
    pool: "5",
    last_intent_a: { agent_pk: "A=", side: "Long", size_bps: 5000, nonce: "2", proof_hash: "p" },
  });
  expect(changed(before, after).sort()).toEqual(["duel:12:a", "duel:12:pot"]);
  expect(changed({}, after)).toEqual([]);
  expect(shortModel("deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe("DeepSeek-V4.1-Flash-1017");
});
