// The terminal's view model: which duel pane 2 follows, the feed's order and verdicts, and the field diff that makes
// changed cells flash after a poll.
import { expect, test } from "bun:test";
import { changed, type Duel, feed, fields, pickLive, type Snap, shortModel, textsOf } from "../term/model";

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
