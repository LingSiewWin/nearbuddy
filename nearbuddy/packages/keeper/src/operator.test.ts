// The operator runs one keyless match from a start request to its resolution. These tests drive it with a fake
// chain and a fake clock: which agents it picks, the order of its phases and calls, and that a failure frees it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentView } from "../../protocol/src/abi/arena.ts";
import type { Chain } from "./keeper.ts";
import { MATCH_S, Operator, pick } from "./operator.ts";

const DS = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const QW = "Qwen/Qwen3.8-27B";
const agent = (pk: string, model_id: string, in_duel: string | null = null) =>
  ({ pk, model_id, in_duel, owner: "house.testnet", bond: "1", tee: true, alpha_bps: 0 }) as unknown as AgentView;
const AGENTS = [agent("d1", DS, "3"), agent("d2", DS), agent("q1", QW), agent("q2", QW)];

test("pick takes the first idle agent of each model", () => {
  assert.deepEqual(pick(AGENTS, DS, QW), ["d2", "q1"]);
});

test("pick uses two different agents when one model plays itself", () => {
  assert.deepEqual(pick(AGENTS, QW, QW), ["q1", "q2"]);
});

test("pick refuses a model with no idle agent", () => {
  assert.throws(() => pick(AGENTS, DS, DS), { message: `no idle agent for ${DS}` });
  assert.throws(() => pick(AGENTS, "x/unknown", QW), { message: "no idle agent for x/unknown" });
});

/** A chain whose duel 9 opens at once, gets its tick when asked (unless `noTick`), has both calls after the keeper's
 *  second round, and resolves when asked. Time is the fake clock's. */
function world(
  over: {
    failOpen?: boolean;
    noTick?: boolean;
    openDrops?: boolean;
    flakyRead?: boolean;
    staleOracle?: number;
    throttled?: string;
    roundFails?: boolean;
    /** How many times the oracle must be asked again before the duel has its opening price. */
    noOpenPrice?: number;
  } = {},
) {
  let now = 1_000_000;
  const calls: string[] = [];
  const phases: string[] = [];
  let rounds = 0;
  let ticked = false;
  let resolved = false;
  let threw = false;
  let resolves = 0;
  let close_at = 0n;
  let throttles = 0;
  let priceAsks = 0;
  const view = (async (method: string) => {
    // a throttled RPC: the named view fails twice, then answers
    if (method === over.throttled && throttles++ < 2) throw new Error("Rate limits exceeded");
    if (method === "leaderboard") return AGENTS;
    if (method === "get_keyless") return { strategy: "s", template: 1, next_seq: "1" };
    if (method === "get_agent") return { in_duel: close_at ? "9" : null };
    if (method === "get_tick") return ticked && !over.noTick ? { price: "341000000", at: "1" } : null;
    if (method === "duel_lock") return "60000000000";
    if (method === "get_duel") {
      if (over.flakyRead && resolved && !threw) {
        threw = true;
        throw new Error("Rate limits exceeded");
      }
      return {
        id: "9",
        a: "d2",
        b: "q1",
        resolved,
        open_price: priceAsks >= (over.noOpenPrice ?? 0) ? "340000000" : null,
        close_at: String(close_at),
        last_intent_a: rounds >= 2 ? { side: "Long" } : null,
        last_intent_b: rounds >= 2 ? { side: "Short" } : null,
      };
    }
    throw new Error(`unexpected view ${method}`);
  }) as unknown as Chain["view"];
  const call = (who: string) =>
    (async (method: string, args: { close_at?: string }) => {
      calls.push(`${who}:${method}`);
      if (method === "open_duel") {
        if (over.failOpen) throw new Error("open_duel failed: in duel");
        close_at = BigInt(args.close_at as string);
        // the transaction landed, but the RPC dropped the wait for its oracle receipts
        if (over.openDrops) throw new Error("Internal server error");
        return { tx: "t-open", value: "9" };
      }
      if (method === "request_tick") ticked = true;
      if (method === "request_open_price") priceAsks++;
      // a stale oracle answers "price before close": the call succeeds, the duel stays open
      if (method === "resolve_duel") resolved = ++resolves > (over.staleOracle ?? 0);
      return { tx: `t-${method}`, value: null };
    }) as unknown as Chain["call"];
  const chain = (who: string): Chain => ({ view, call: call(who), now: async () => BigInt(now) * 1_000_000n });
  const op = new Operator({
    owner: chain("owner"),
    chain: chain("keeper"),
    keeper: {
      round: async () => {
        if (over.roundFails && rounds === 0 && !threw) {
          threw = true;
          throw new Error("Rate limits exceeded");
        }
        rounds++;
        return 2;
      },
      settle: async () => {},
    },
    sleep: async (ms) => {
      now += ms;
    },
    nowMs: () => now,
    onPhase: (p) => phases.push(p),
  });
  return { op, calls, phases, start: now, at: () => now };
}

test("a match runs opening, calling, racing, resolving, done, with each chain call once", async () => {
  const w = world();
  const s = await w.op.start(DS, QW);
  assert.equal(s.busy, true);
  assert.deepEqual(
    [s.a, s.b],
    [
      { pk: "d2", model: DS },
      { pk: "q1", model: QW },
    ],
  );
  await w.op.idle();
  assert.deepEqual(w.phases, ["opening", "calling", "racing", "resolving", "done"]);
  assert.deepEqual(w.calls, ["owner:open_duel", "keeper:resolve_duel"]);
  const end = w.op.status();
  assert.deepEqual([end.busy, end.phase, end.duel, end.error], [false, "done", "9", null]);
  assert.deepEqual(end.txs, { open: "t-open", resolve: "t-resolve_duel" });
  assert.ok(w.at() - w.start >= MATCH_S * 1000); // it waited out the match
});

test("a second start while a match runs is refused", async () => {
  const w = world();
  await w.op.start(DS, QW);
  await assert.rejects(w.op.start(DS, QW), { message: "busy" });
  await w.op.idle();
});

test("a failed open ends the match as failed and frees the operator", async () => {
  const w = world({ failOpen: true });
  await w.op.start(DS, QW).catch(() => {});
  await w.op.idle();
  const end = w.op.status();
  assert.deepEqual([end.busy, end.phase, end.error], [false, "failed", "open_duel failed: in duel"]);
  assert.deepEqual(w.calls, ["owner:open_duel"]);
});

test("an open whose answer was lost is found on chain and played, never sent twice", async () => {
  const w = world({ openDrops: true });
  await w.op.start(DS, QW);
  await w.op.idle();
  const end = w.op.status();
  assert.deepEqual([end.phase, end.duel, end.error], ["done", "9", null]);
  assert.deepEqual(w.calls, ["owner:open_duel", "keeper:resolve_duel"]);
});

test("a read that fails while resolving is retried, not fatal", async () => {
  const w = world({ flakyRead: true });
  await w.op.start(DS, QW);
  await w.op.idle();
  assert.deepEqual([w.op.status().phase, w.op.status().error], ["done", null]);
});

test("a stale oracle is waited out: resolve is asked again until the duel resolves", async () => {
  const w = world({ staleOracle: 8 });
  await w.op.start(DS, QW);
  await w.op.idle();
  assert.equal(w.op.status().phase, "done");
  assert.equal(w.calls.filter((c) => c === "keeper:resolve_duel").length, 9);
});

for (const method of ["leaderboard", "duel_lock"])
  test(`a throttled ${method} read is retried and the match still plays out`, async () => {
    const w = world({ throttled: method });
    await w.op.start(DS, QW);
    await w.op.idle();
    assert.deepEqual([w.op.status().phase, w.op.status().error], ["done", null]);
    assert.deepEqual(w.calls, ["owner:open_duel", "keeper:resolve_duel"]);
  });

test("a keeper round that fails on a throttled RPC is tried again", async () => {
  const w = world({ roundFails: true });
  await w.op.start(DS, QW);
  await w.op.idle();
  assert.deepEqual([w.op.status().phase, w.op.status().error], ["done", null]);
});

test("the models are asked to call as soon as the match is open, and the match is as long as planned", async () => {
  const w = world();
  await w.op.start(DS, QW);
  await w.op.idle();
  const s = w.op.status();
  assert.equal(s.close_at, (s.open_at as number) + MATCH_S * 1000);
  assert.ok(MATCH_S >= 330 && MATCH_S <= 420); // above the arena's 310 s floor with room for the open to land
  assert.equal(w.phases[1], "calling");
});

test("a duel opened without a price has the oracle asked again, then runs as usual", async () => {
  const w = world({ noOpenPrice: 1 });
  await w.op.start(DS, QW);
  await w.op.idle();
  assert.deepEqual(w.calls, ["owner:open_duel", "keeper:request_open_price", "keeper:resolve_duel"]);
  assert.equal(w.op.status().phase, "done");
});

test("a duel that never gets its opening price fails with the reason and is not sent to resolve", async () => {
  const w = world({ noOpenPrice: Number.POSITIVE_INFINITY });
  await w.op.start(DS, QW);
  await w.op.idle();
  const end = w.op.status();
  assert.deepEqual([end.busy, end.phase], [false, "failed"]);
  assert.match(end.error ?? "", /duel 9 got no opening price/);
  assert.ok(!w.calls.includes("keeper:resolve_duel"));
  const asks = w.calls.filter((c) => c === "keeper:request_open_price").length;
  assert.ok(asks > 1 && asks <= 12, `asked ${asks} times`);
});
