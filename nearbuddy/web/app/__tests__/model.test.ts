// The arena page's pure derivations (app/arena/model.ts): the contract-exact "if it ended now" score, the
// duel in focus, the reference price, and the attack-and-reply story. Run: `cd web && bun test app/__tests__`.
import { describe, expect, test } from "bun:test";
import { summary } from "../api/arena";
import type { Decision } from "../api/dataset";
import type { ArenaEvent } from "../api/tape";
import {
  duelEvents,
  type Focus,
  focusOf,
  latestStory,
  markPct,
  openOf,
  priceAt,
  replyTo,
  type Side,
  sealedIn,
  withTape,
} from "../arena/model";
import type { Tick } from "../lib/live";
import { agent, duel, intent, NOW, ns, outcome, snap, YOCTO } from "./fixtures/snap";

const side = (s: Side["side"], size_pct: number | null = 50): Side => ({
  agent: "a",
  model: "m",
  side: s,
  size_pct,
  verified: true,
  bond: null,
});

describe("markPct: the contract's pnl_bps, in percent", () => {
  // Real resolves on arena.nearbuddy-solver.testnet: each side's last call, the oracle open/close (x1e8) and
  // the pnl the contract logged. The raw value is the exact quotient before truncation.
  const chain: [duel: number, s: "Long" | "Short", open: number, close: number, pnlBps: number, raw: number][] = [
    [330, "Short", 371116666, 371186666, 0, -0.943],
    [331, "Short", 371186666, 371681666, -6, -6.668],
    [332, "Long", 371681666, 371778333, 1, 1.3],
    [335, "Short", 370916666, 370900000, 0, 0.225],
    [340, "Long", 372011666, 376670000, 62, 62.61],
    [345, "Short", 375123333, 377386666, -30, -30.168],
    [346, "Short", 377386666, 378033333, -8, -8.568],
  ];
  test.each(chain)("duel %i (%s 50%%) scores what the contract logged", (_d, s, o, c, pnl) => {
    expect(markPct(side(s), o / 1e8, c / 1e8) + 0).toBe(pnl / 100); // + 0: a losing sub-bps move is -0
  });

  test("truncates toward zero on both sides, never floors", () => {
    // all-in Long, price down 1.5 bps: -1.5 -> -1, not -2
    expect(markPct(side("Long", 100), 4, 4 * (1 - 1.5e-4))).toBe(-0.01);
    expect(markPct(side("Long", 100), 4, 4 * (1 + 1.5e-4))).toBe(0.01);
  });

  test("a Short gains when the price falls and loses when it rises", () => {
    expect(markPct(side("Short", 100), 4, 3.96)).toBe(1);
    expect(markPct(side("Short", 100), 4, 4.04)).toBe(-1);
    expect(markPct(side("Long", 100), 4, 3.96)).toBe(-1);
  });

  test("scales with the stake: half the size, half the score", () => {
    expect(markPct(side("Long", 100), 4, 4.04)).toBe(1);
    expect(markPct(side("Long", 50), 4, 4.04)).toBe(0.5);
  });

  test("a sub-bps move scores 0", () => {
    // 0.8 bps at full size; the losing side gets -0, which pct() renders as 0.00% (+ 0 folds it)
    expect(markPct(side("Long", 100), 3.75, 3.75 + 0.00003)).toBe(0);
    expect(markPct(side("Short", 100), 3.75, 3.75 + 0.00003) + 0).toBe(0);
  });

  test("no call, no size, no open or no price scores 0", () => {
    expect(markPct(side(null), 4, 4.04)).toBe(0);
    expect(markPct(side("Long", null), 4, 4.04)).toBe(0);
    expect(markPct(side("Long"), null, 4.04)).toBe(0);
    expect(markPct(side("Long"), 0, 4.04)).toBe(0);
    expect(markPct(side("Long"), 4, null)).toBe(0);
  });
});

describe("priceAt: last trade at or before t", () => {
  const ticks: Tick[] = [
    { t: 10, p: 1, side: "buy" },
    { t: 20, p: 2, side: "sell" },
    { t: 20, p: 2.5, side: "buy" },
    { t: 30, p: 3, side: "buy" },
  ];
  test("no trades, or none yet, is null", () => {
    expect(priceAt([], 100)).toBeNull();
    expect(priceAt(ticks, 9)).toBeNull();
  });
  test("an exact time, a gap, and past the end", () => {
    expect(priceAt(ticks, 10)).toBe(1);
    expect(priceAt(ticks, 15)).toBe(1);
    expect(priceAt(ticks, 30)).toBe(3);
    expect(priceAt(ticks, 99)).toBe(3);
  });
  test("two trades at the same time: the later one", () => {
    expect(priceAt(ticks, 20)).toBe(2.5);
    expect(priceAt(ticks, 25)).toBe(2.5);
  });
  test("agrees with a linear scan on random tapes", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let n = 0; n < 200; n++) {
      const tape: Tick[] = [];
      let t = 0;
      for (let i = Math.floor(rnd() * 12); i > 0; i--) {
        t += Math.floor(rnd() * 3); // repeats allowed
        tape.push({ t, p: rnd(), side: "buy" });
      }
      const at = Math.floor(rnd() * (t + 3)) - 1;
      const linear = tape.filter((x) => x.t <= at).at(-1)?.p ?? null;
      expect(priceAt(tape, at)).toBe(linear);
    }
  });
});

describe("openOf", () => {
  const f = { open: null, opened: 100 } as Focus;
  const ticks: Tick[] = [
    { t: 90, p: 1, side: "buy" },
    { t: 100, p: 2, side: "buy" },
    { t: 110, p: 3, side: "buy" },
  ];
  test("the oracle open wins", () => {
    expect(openOf({ ...f, open: 3.7 }, ticks)).toBe(3.7);
  });
  test("else the first trade at or after the duel opened", () => {
    expect(openOf(f, ticks)).toBe(2);
    expect(openOf({ ...f, opened: 101 }, ticks)).toBe(3);
  });
  test("else null", () => {
    expect(openOf({ ...f, opened: 111 }, ticks)).toBeNull();
    expect(openOf(f, [])).toBeNull();
  });
});

describe("focusOf", () => {
  const A = "test-agent-a";
  const B = "test-agent-b";
  const lb = [
    agent(A, "Qwen/Qwen3.8-27B", { bond: `4${YOCTO}` }),
    agent(B, "deepseek-ai/DeepSeek-V4.1-Flash-1017", { bond: `6${YOCTO}` }),
  ];

  test("the live duel when there is one, with each side's bond from the standings", async () => {
    const live = duel("11", A, B, {
      resolved: false,
      outcome: null,
      pool: `2${YOCTO}`,
      open_price: "377386666",
      open_at: ns(NOW - 60_000),
      close_at: ns(NOW + 240_000),
      last_intent_a: intent(A, "11", "Long"),
    });
    const f = focusOf(await summary(snap({ leaderboard: lb, duels: [live, duel("10", A, B)] }), NOW));
    expect(f).toMatchObject({
      duel: 11,
      live: true,
      opened: NOW - 60_000,
      closes: NOW + 240_000,
      open: 3.77386666,
      close: null,
      pot: 2,
      winner: null,
      slashed: 0,
      a: { agent: A, side: "Long", size_pct: 50, bond: 4 },
      b: { agent: B, side: null, size_pct: null, bond: 6 },
    });
  });

  test("else the newest finished duel, with its close, winner and slash", async () => {
    const done = duel("10", A, B, {
      outcome: outcome({ winner: A, slashed: `1${YOCTO}`, pnl_a: 18, pnl_b: -18 }),
    });
    const f = focusOf(await summary(snap({ leaderboard: lb, duels: [done, duel("9", B, A)] })));
    expect(f).toMatchObject({
      duel: 10,
      live: false,
      open: 3.77386666,
      close: 3.78033333,
      pot: 0,
      winner: A,
      slashed: 1,
      a: { agent: A, return_pct: 0.18, bond: 4 },
      b: { agent: B, return_pct: -0.18, bond: 6 },
    });
  });

  test("carries the rules: lock, slash, sealed calls, forfeit and consent", async () => {
    const s = snap({
      leaderboard: lb,
      duels: [duel("10", A, B)],
      config: { ...snap().config, commit_reveal: true, no_reveal_bps: 500, require_consent: true },
    });
    expect(focusOf(await summary(s))).toMatchObject({
      lockS: 30,
      slashPct: 10,
      sealed: true,
      forfeitPct: 5,
      consent: true,
    });
  });

  test("a side missing from the standings has no bond", async () => {
    const f = focusOf(await summary(snap({ leaderboard: lb.slice(0, 1), duels: [duel("10", A, B)] })));
    expect(f?.b.bond).toBeNull();
  });

  test("no duels at all: nothing in focus", async () => {
    expect(focusOf(await summary(snap({ leaderboard: lb })))).toBeNull();
  });
});

// ---------- events, newest first as tape() serves them ----------
const TARGET = "pk-target";
const OTHER = "pk-other";
const base = (tx: string, at: number, ok = true) => ({ tx, at, block: at, ok, signer: "nearbuddy-solver.testnet" });
const call = (
  tx: string,
  at: number,
  agentPk: string,
  duelId: number,
  o: { kind?: "intent" | "reveal"; ok?: boolean; side?: "Long" | "Short" } = {},
): ArenaEvent => ({
  ...base(tx, at, o.ok ?? true),
  kind: o.kind ?? "intent",
  duel: duelId,
  agent: agentPk,
  side: o.side ?? "Long",
  size: 5000,
  nonce: String(at),
  tee: 2,
});
const attack = (tx: string, at: number, duelId: number, ok = true): ArenaEvent => ({
  ...base(tx, at, ok),
  kind: "attack",
  duel: duelId,
  target: TARGET,
  attack: "fake_news",
  hash: `hash-${tx}`,
  text: `text of ${tx}`,
  paid: "100000000000000000000000",
});
const commit = (tx: string, at: number, agentPk: string, duelId: number): ArenaEvent => ({
  ...base(tx, at),
  kind: "commit",
  duel: duelId,
  agent: agentPk,
  commitment: "c",
});
const newestFirst = (...e: ArenaEvent[]) => e.sort((x, y) => y.at - x.at);
const txs = (l: { tx: string }[]) => l.map((e) => e.tx);

describe("duelEvents", () => {
  test("the duel's landed calls (reveals included) and attacks, oldest first", () => {
    const events = newestFirst(
      call("i1", 10, TARGET, 5),
      call("r1", 30, OTHER, 5, { kind: "reveal" }),
      call("i2", 20, OTHER, 5),
      call("bad", 25, TARGET, 5, { ok: false }),
      call("elsewhere", 26, TARGET, 6),
      commit("c1", 15, TARGET, 5),
      attack("a2", 22, 5),
      attack("a1", 12, 5),
      attack("a-bad", 13, 5, false),
      attack("a-other", 14, 6),
    );
    const d = duelEvents(events, 5);
    expect(txs(d.intents)).toEqual(["i1", "i2", "r1"]);
    expect(txs(d.attacks)).toEqual(["a1", "a2"]);
  });
});

describe("latestStory", () => {
  const modelOf = (pk: string) => `model-of-${pk}`;
  const none = new Map<string, Decision>();

  test("the reply is the target's first landed call in the same duel after the attack", () => {
    const events = newestFirst(
      call("before", 90, TARGET, 7),
      attack("atk", 100, 7),
      call("reply", 105, TARGET, 7),
      call("later", 120, TARGET, 7),
    );
    const d = { tx: "reply" } as Decision;
    const s = latestStory(events, new Map([["reply", d]]), [], modelOf);
    expect(s).toMatchObject({ text: "text of atk", target: TARGET, model: `model-of-${TARGET}`, duel: 7 });
    expect(s?.attack?.tx).toBe("atk");
    expect(s?.reply?.tx).toBe("reply");
    expect(s?.d).toBe(d);
  });

  test("calls in another duel, by the other agent, before the attack, or refused are not the reply", () => {
    const events = newestFirst(
      call("before", 99, TARGET, 7),
      attack("atk", 100, 7),
      call("other-duel", 101, TARGET, 8),
      call("other-agent", 102, OTHER, 7),
      call("refused", 103, TARGET, 7, { ok: false }),
    );
    const s = latestStory(events, none, [], modelOf);
    expect(s?.attack?.tx).toBe("atk");
    expect(s?.reply).toBeNull();
    expect(s?.d).toBeNull();
  });

  test("a reveal counts as the reply; the commit before it does not", () => {
    const events = newestFirst(
      attack("atk", 100, 7),
      commit("sealed", 101, TARGET, 7),
      call("revealed", 110, TARGET, 7, { kind: "reveal", side: "Short" }),
    );
    const s = latestStory(events, none, [], modelOf);
    expect(s?.reply).toMatchObject({ tx: "revealed", kind: "reveal", side: "Short" });
  });

  test("the newest landed attack is the story; a refused newer one is skipped", () => {
    const events = newestFirst(attack("old", 50, 7), attack("new", 80, 7), attack("refused", 90, 7, false));
    expect(latestStory(events, none, [], modelOf)?.attack?.tx).toBe("new");
  });

  test("with no landed attack on the tape, the newest attacked dataset row", () => {
    const rows = [
      { duel: "3", agent: "pk-1", model: "Qwen/Qwen3.8-27B", attack: "first", tx: "t1" },
      { duel: "4", agent: "pk-2", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", attack: "second", tx: "t2" },
    ] as Decision[];
    const s = latestStory(newestFirst(attack("refused", 90, 7, false)), none, rows, modelOf);
    expect(s).toEqual({
      attack: null,
      text: "second",
      target: "pk-2",
      model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      duel: 4,
      reply: null,
      d: rows[1] as Decision,
    });
  });

  test("nothing attacked anywhere: no story", () => {
    expect(latestStory(newestFirst(call("i", 1, TARGET, 1)), none, [], modelOf)).toBeNull();
  });
});

describe("withTape: a sealed call is a commit newer than the side's last reveal", () => {
  const base = { tx: "t", block: 1, ok: true, signer: "s" };
  const commit = (agent: string, at: number): ArenaEvent => ({
    ...base,
    at,
    kind: "commit",
    duel: 7,
    agent,
    commitment: "c",
  });
  const reveal = (agent: string, at: number): ArenaEvent => ({
    ...base,
    at,
    kind: "reveal",
    duel: 7,
    agent,
    side: "Short",
    size: 5000,
    nonce: "1",
    tee: 2,
  });
  const f = { live: true, duel: 7, a: { ...side(null), agent: "a" }, b: { ...side(null), agent: "b" } } as Focus;
  test("commit after the last reveal (or none): sealed; reveal after the commit: open", () => {
    // newest first, as the tape keeps it
    const g = withTape(f, [commit("a", 30), reveal("b", 25), commit("b", 20), reveal("a", 10)]);
    expect(g?.a).toMatchObject({ side: "Short", sealed: true });
    expect(g?.b).toMatchObject({ side: "Short", sealed: false });
    expect(withTape(f, [commit("a", 5)])?.a).toMatchObject({ side: null, sealed: true });
  });
});

describe("replyTo: the call fixed after the attack, not the first reveal after it", () => {
  const base = { tx: "t", block: 1, ok: true, signer: "s", duel: 7, agent: "a" };
  const atk = {
    ...base,
    at: 100,
    kind: "attack",
    target: "a",
    hash: "h",
    text: null,
    payer: "p",
    deposit: 0.1,
  } as unknown as Parameters<typeof replyTo>[0];
  const commit = (at: number, tx: string): ArenaEvent => ({ ...base, tx, at, kind: "commit", commitment: "c" });
  const reveal = (at: number, tx: string): ArenaEvent => ({
    ...base,
    tx,
    at,
    kind: "reveal",
    side: "Short",
    size: 5000,
    nonce: "1",
    tee: 2,
  });
  test("a reveal whose commit came before the attack is not the reply; the next sealed one is", () => {
    const ev = [commit(50, "c1"), reveal(105, "r1"), commit(130, "c2"), reveal(250, "r2")];
    expect(replyTo(atk, ev)?.tx).toBe("r2");
    // its commit scrolled out of the window: older than the attack, so never the reply
    expect(replyTo(atk, [reveal(105, "r1")])).toBeNull();
  });
  test("a plain intent after the attack is the reply", () => {
    const plain: ArenaEvent = {
      ...base,
      tx: "i1",
      at: 120,
      kind: "intent",
      side: "Long",
      size: 5000,
      nonce: "2",
      tee: 2,
    };
    expect(replyTo(atk, [plain])?.tx).toBe("i1");
  });
});

test("sealedIn: a commit newer than the newest call, in either event order", () => {
  const base = { tx: "t", block: 1, ok: true, signer: "s", duel: 9, agent: "a" };
  const commit = (at: number): ArenaEvent => ({ ...base, at, kind: "commit", commitment: "c" });
  const reveal = (at: number): ArenaEvent => ({
    ...base,
    at,
    kind: "reveal",
    side: "Long",
    size: 5000,
    nonce: "1",
    tee: 2,
  });
  expect(sealedIn([commit(10), reveal(20), commit(30)], 9, "a")).toBe(true);
  expect(sealedIn([commit(30), reveal(20), commit(10)], 9, "a")).toBe(true);
  expect(sealedIn([commit(10), reveal(20)], 9, "a")).toBe(false);
  expect(sealedIn([commit(10)], 8, "a")).toBe(false); // another duel
  expect(sealedIn([{ ...commit(30), ok: false }, reveal(20)], 9, "a")).toBe(false); // a refused commit seals nothing
});
