// Render helpers behind the commit-reveal markers and the execution box, checked on fixture data.
// Run: `cd web && bun test` or `bun test web/app` from nearbuddy.
import { describe, expect, test } from "bun:test";
import {
  age,
  type ChainEvent,
  type CommitConfig,
  commitCells,
  commitWord,
  FILL_HEAD,
  type Fill,
  fillCells,
  followerQuality,
  isStubModel,
  lastFills,
  legs,
  NO_REVEAL_RULE,
  type Opened,
  pairCells,
  pairingCells,
  pairingWord,
  pairsOf,
  proven,
  quoteOut,
  revealCell,
  sbps,
  shownPairs,
  timelineCells,
  usdc,
  vsCell,
} from "../cells";
import { type Cell, W, ZERO } from "../tui";

const text = (cs: Cell[]) => cs.map((c) => (typeof c === "string" ? c : c.t)).join("");
const VW = W - 16 - 5; // value column width in tui.tsx; a row longer than this is cut
const NOW = 1_762_400_000_000;
const fill = (o: Partial<Fill> = {}): Fill => ({
  follower: "alice.testnet",
  intent_nonce: "41",
  amount_in: "250000000000000000000000", // 0.25 wNEAR
  quote_out: "640125", // 0.640125 USDC
  oracle_mid: "256100000", // 2.561 USD
  quoted_at: NOW - 42_000,
  bps_vs_oracle: 3.4,
  ...o,
});

describe("commit-reveal", () => {
  test("deploy 13 config (fields absent) reads as off, predating commit-reveal", () => {
    const deploy13: CommitConfig & { next_duel: string; slash_bps: number } = { next_duel: "300", slash_bps: 1000 };
    expect(commitWord(deploy13)).toBe("off");
    expect(commitWord(null)).toBe("off");
    expect(text(commitCells(deploy13))).toContain("predates commit-reveal");
  });
  test("on: calls hidden, no-reveal cost in percent", () => {
    const c = { commit_reveal: true, no_reveal_bps: 500, require_consent: true };
    expect(commitWord(c)).toBe("on");
    expect(text(commitCells(c))).toBe(
      "on   calls hidden until reveal · no reveal = forfeit + 5 % of bond to the opponent",
    );
    expect(text(commitCells(c)).length).toBeLessThanOrEqual(VW);
    expect(commitCells(c)[2]).toMatchObject({ title: NO_REVEAL_RULE });
    expect(NO_REVEAL_RULE).toContain("forfeits the duel");
    expect(NO_REVEAL_RULE).toContain("both unrevealed is a tie");
  });
  test("explicitly off: posted in the clear", () => {
    expect(text(commitCells({ commit_reveal: false }))).toContain("in the clear");
  });
  test("reveal marker per side: one unrevealed side forfeits, both unrevealed is a tie", () => {
    expect(revealCell([true, false], 0, false, true)).toMatchObject({ t: "no reveal: forfeit", c: "loss" });
    expect(revealCell([false, true], 0, true, true)).toMatchObject({ t: "revealed", c: "ok" });
    expect(revealCell([false, true], 1, true, true)).toMatchObject({ t: "no reveal: forfeit" }); // an older intent stays
    expect(revealCell([true, true], 1, false, true)).toMatchObject({ t: "no reveal: tie", c: "loss" });
    expect(String((revealCell([true, false], 0, false, true) as { title: string }).title)).toContain("to the opponent");
    expect(revealCell(null, 0, true, false)).toMatchObject({ t: "revealed", c: "ok" });
    expect(revealCell(undefined, 1, false, false)).toMatchObject({ t: "hidden until reveal" });
    expect(revealCell(undefined, 0, false, true)).toMatchObject({ t: "no intent" });
  });
  test("proven: zero or missing proof hash is not verified (deploy 13 and committed-but-hidden intents)", () => {
    expect(proven({ proof_hash: "q83vEjRWeJA=" }, ZERO)).toBe(true);
    expect(proven({ proof_hash: ZERO }, ZERO)).toBe(false);
    expect(proven({}, ZERO)).toBe(false);
    expect(proven(null, ZERO)).toBe(false);
  });
});

describe("pairing", () => {
  const opened = (method: string): Opened => ({ duel_id: "411", method, tx: "Cns1Xk9pQz7Lm", at_ms: NOW });
  test("stats strip word: consent required, open, or nothing before the field existed", () => {
    expect(pairingWord({ require_consent: true })).toBe("consent required");
    expect(pairingWord({ require_consent: false })).toBe("open");
    expect(pairingWord({ commit_reveal: false })).toBeNull();
    expect(pairingWord(null)).toBeNull();
  });
  test("the open tx's method wins over the config: consented means both agents signed", () => {
    const c = pairingCells(opened("open_duel_consented"), { require_consent: false });
    expect(text(c)).toBe("both agents signed this duel   open_duel_consented tx Cns1Xk9pQz…");
    expect(c[0]).toMatchObject({ c: "ok" });
    expect(c[2]).toMatchObject({ href: "https://testnet.nearblocks.io/txns/Cns1Xk9pQz7Lm" });
    expect(text(pairingCells(opened("open_duel"), { require_consent: true }))).toStartWith(
      "opened by the owner, no agent signatures   open_duel tx",
    );
  });
  test("without the open tx, today's require_consent is shown and labelled as such", () => {
    const on = text(pairingCells(null, { require_consent: true }));
    expect(on).toBe("consent required   from get_config now; the open tx is not in the scanned window");
    expect(on.length).toBeLessThanOrEqual(VW);
    expect(text(pairingCells(undefined, { require_consent: false }))).toStartWith("open   from get_config now");
    expect(text(pairingCells(null, { next_duel: "412" } as CommitConfig))).toBe(
      "this contract predates consented pairing",
    );
  });
});

describe("commit timeline", () => {
  const A = "PK_A";
  const T0 = Date.UTC(2026, 10, 6, 12, 1, 5);
  const e = (event: ChainEvent["event"], method: string, dt: number, pk = A): ChainEvent => ({
    event,
    duel_id: "411",
    agent_pk: pk,
    method,
    tx: `${method}-${dt}`,
    at_ms: T0 + dt * 1000,
  });
  test("committed then revealed: both times, UTC, linked to their txs", () => {
    const c = timelineCells([e("intent", "reveal_intent", 155), e("commit", "commit_intent", 0)], A, false);
    expect(text(c)).toBe("committed 12:01:05 · revealed 12:03:40");
    expect(c[0]).toMatchObject({ href: "https://testnet.nearblocks.io/txns/commit_intent-0" });
    expect(c[2]).toMatchObject({ c: "ok", href: "https://testnet.nearblocks.io/txns/reveal_intent-155" });
  });
  test("committed, not yet revealed: hidden; once resolved: never revealed", () => {
    const evs = [e("commit", "commit_intent", 0), e("commit", "commit_intent", 9, "PK_B")];
    expect(text(timelineCells(evs, A, false))).toBe("committed 12:01:05 · hidden");
    expect(timelineCells(evs, A, true)[2]).toMatchObject({ t: "never revealed", c: "loss" });
  });
  test("a reveal before the last commit belongs to the earlier commitment", () => {
    const evs = [e("commit", "commit_intent", 0), e("intent", "reveal_intent", 30), e("commit", "commit_intent", 60)];
    expect(text(timelineCells(evs, A, false))).toBe("committed 12:02:05 · hidden   2 commits, last shown");
  });
  test("no commitment: an intent posted in the clear, or nothing seen", () => {
    expect(text(timelineCells([e("intent", "post_intent", 2)], A, false))).toBe(
      "posted 12:01:07   in the clear, no commitment",
    );
    expect(text(timelineCells([], A, false))).toBe("no commit seen");
    expect(text(timelineCells(undefined, A, false))).toBe("no commit seen");
  });
});

describe("pairs", () => {
  test("duels group by agent pair whichever side each took, most recent pair first", () => {
    const d = (id: number, a: string, b: string) => ({ id: String(id), a, b });
    // pair 1 (P, Q) runs throughout; pair 2 (G, W) joins at #350
    const duels = [d(352, "G", "W"), d(351, "Q", "P"), d(350, "W", "G"), d(349, "P", "Q"), d(330, "P", "Q")];
    expect(pairsOf(duels)).toEqual([
      { a: "G", b: "W", first: 350, last: 352, n: 2 },
      { a: "P", b: "Q", first: 330, last: 351, n: 3 },
    ]);
    expect(pairsOf([])).toEqual([]);
  });
  test("the widest pair row the arena builds fits the value column", () => {
    const p = { a: "A", b: "B", first: 10_000, last: 10_039, n: 40 };
    const long = (pk: string) => `${pk}-${"m".repeat(60)}`; // longer than any model name: pairCells cuts it
    const cells = pairCells(p, long, 100);
    expect(text(cells).length).toBeLessThanOrEqual(VW);
    expect(text(cells)).toEndWith("  #10000-#10039 · 40 of last 100");
    expect(cells[0]).toMatchObject({ href: "/agent/A", title: "A" });
    expect(text(pairCells(p, long, undefined))).toEndWith("of last ?"); // an API without `scanned`
  });
  test("box 2 keeps the newest running pairs, then lists them oldest first", () => {
    const pair = (a: string, first: number, last: number, n = 5) => ({ a, b: `${a}2`, first, last, n });
    const four = [pair("old", 300, 330), pair("p1", 320, 365), pair("p2", 350, 364), pair("p3", 360, 366)];
    // the pair last active at #330 drops, not the newest one
    expect(shownPairs(four).map((p) => p.a)).toEqual(["p1", "p2", "p3"]);
    expect(shownPairs([...four, pair("probe", 363, 363, 1)]).map((p) => p.a)).toEqual(["p1", "p2", "p3"]);
    expect(shownPairs([pair("p1", 320, 365), pair("probe", 363, 363, 1)])).toEqual([]); // one running pair: no rows
    expect(shownPairs(undefined)).toEqual([]);
  });
  test("stub agents: one rule for standings and pairs; a pair with a stub in it gets no row", () => {
    expect(isStubModel("stub/deterministic")).toBe(true);
    expect(isStubModel("redteam/stub")).toBe(true); // the red-team probe pair
    expect(isStubModel("z-ai/glm-5.3-flash")).toBe(false);
    expect(isStubModel(undefined)).toBe(false); // unknown agent: shown
    // a whole path segment only (same cases as agents/tests/test_nearai_client.py)
    expect(isStubModel("stub")).toBe(true);
    expect(isStubModel("stub/x")).toBe(true);
    expect(isStubModel("org/stub/v2")).toBe(true);
    expect(isStubModel("stubborn-model")).toBe(false);
    expect(isStubModel("acme/stubborn-model")).toBe(false);
    expect(isStubModel("acme/model-stub")).toBe(false);
    expect(isStubModel("")).toBe(false);
    const pair = (a: string, b: string, first: number, last: number) => ({ a, b, first, last, n: 5 });
    const models: Record<string, string> = {
      q: "Qwen/Qwen3.8-27B",
      d: "deepseek-ai/DeepSeek-V4.1",
      g: "z-ai/glm-5.3-flash",
      w: "Qwen/Qwen3.6-35B",
      s: "redteam/stub",
      t: "redteam/stub",
    };
    const hide = (pk: string) => isStubModel(models[pk]);
    const live = [
      pair("q", "d", 335, 373),
      pair("g", "w", 350, 374),
      pair("s", "t", 363, 375),
      pair("s", "q", 370, 371),
    ];
    expect(shownPairs(live, hide).map((p) => `${p.a}${p.b}`)).toEqual(["qd", "gw"]); // newest stub pair dropped first
    // no rule: the three last active (st #375, gw #374, qd #373; sq #371 drops), listed by first duel
    expect(shownPairs(live).map((p) => `${p.a}${p.b}`)).toEqual(["qd", "gw", "st"]);
    expect(shownPairs([pair("q", "d", 1, 9), pair("s", "t", 2, 8)], hide)).toEqual([]); // one real pair left: no rows
  });
});

describe("execution", () => {
  test("units: yocto wNEAR in, 6-dp USDC out, 1e8 oracle mid", () => {
    const t = text(fillCells(fill(), NOW));
    expect(t).toMatch(/ sell +0\.250 wNEAR → +0\.6401 USDC /); // no side: an older solver, which only sold
    expect(t).toContain("2.5610");
    expect(t).toContain("+3.4 bps");
    expect(t).toContain("42s ago");
    expect(usdc(null)).toBe("-");
  });
  test("direction follows the side: Short sells wNEAR for USDC, Long buys wNEAR with USDC", () => {
    const short = text(fillCells(fill({ side: "Short" }), NOW));
    const long = text(fillCells(fill({ side: "Long", bps_vs_oracle: 2.1 }), NOW));
    expect(short).toMatch(/ sell +0\.250 wNEAR → +0\.6401 USDC /);
    expect(long).toMatch(/ buy +0\.250 wNEAR ← +0\.6401 USDC /);
    expect(long.length).toBe(short.length);
    expect(fillCells(fill({ side: "Long" }), NOW)[3]).toMatchObject({ title: "Long: bought wNEAR, paid USDC" });
    // the solver already signs bps so + is better for the follower on both sides: same colour rule
    expect(vsCell(2.1)).toMatchObject({ c: "win" });
    expect(legs(undefined)).toEqual(legs("Short"));
    expect(legs(null).arrow).toBe("→");
  });
  test("a row and the header fit the value column, with the columns aligned", () => {
    const t = text(fillCells(fill({ follower: "a-very-long-follower-account.testnet" }), NOW));
    expect(t.length).toBeLessThanOrEqual(VW);
    expect(FILL_HEAD.length).toBe(text(fillCells(fill(), NOW)).length);
    expect(FILL_HEAD.length).toBeLessThanOrEqual(VW);
    expect(FILL_HEAD.indexOf("side")).toBe(text(fillCells(fill({ side: "Long" }), NOW)).indexOf("buy"));
  });
  test("vs mid is coloured: better a win, worse a loss, equal a tie", () => {
    expect(vsCell(2)).toMatchObject({ t: "+2.0 bps", c: "win" });
    expect(vsCell(-1.25)).toMatchObject({ t: "-1.3 bps", c: "loss" });
    expect(vsCell(0)).toMatchObject({ t: "0.0 bps", c: "tie" });
    expect(sbps(-0.04)).toBe("-0.0");
  });
  test("age buckets", () => {
    expect(age(NOW - 5_000, NOW)).toBe("5s");
    expect(age(NOW - 7 * 60_000, NOW)).toBe("7m");
    expect(age(NOW - 3 * 3_600_000, NOW)).toBe("3h");
    expect(age(NOW - 2 * 86_400_000, NOW)).toBe("2d");
    expect(age(NOW + 9_000, NOW)).toBe("0s"); // solver clock ahead of ours
  });
  test("last 10, newest first; absent list is empty", () => {
    const q = Array.from({ length: 14 }, (_, i) => fill({ intent_nonce: String(i) }));
    expect(lastFills(q).map((f) => f.intent_nonce)).toEqual(["13", "12", "11", "10", "9", "8", "7", "6", "5", "4"]);
    expect(lastFills(undefined)).toEqual([]);
  });
  test("per-follower summary keeps only this agent's followers, in follower order", () => {
    const q = [
      fill({ follower: "bob.testnet", bps_vs_oracle: -2, quoted_at: NOW - 1000 }),
      fill({ follower: "alice.testnet", bps_vs_oracle: 4 }),
      fill({ follower: "alice.testnet", bps_vs_oracle: -1, quoted_at: NOW - 5000 }),
      fill({ follower: "mallory.testnet", bps_vs_oracle: 50 }),
    ];
    expect(followerQuality(q, ["alice.testnet", "bob.testnet", "carol.testnet"])).toEqual([
      { follower: "alice.testnet", n: 2, avg: 1.5, best: 4, worst: -1, last: NOW - 5000 },
      { follower: "bob.testnet", n: 1, avg: -2, best: -2, worst: -2, last: NOW - 1000 },
    ]);
    expect(followerQuality(null, ["alice.testnet"])).toEqual([]);
  });
  test("a null bps_vs_oracle (old persisted row) renders '-' and stays out of the averages", () => {
    expect(vsCell(null)).toMatchObject({ t: "-", c: "dim" });
    expect(vsCell(undefined, 10)).toMatchObject({ t: "         -" });
    expect(vsCell(Number.NaN)).toMatchObject({ t: "-" });
    expect(sbps(null)).toBe("-");
    const row = text(fillCells(fill({ bps_vs_oracle: null }), NOW));
    expect(row).toContain("         -  ");
    expect(row.length).toBe(FILL_HEAD.length);
    const q = [
      fill({ bps_vs_oracle: null }),
      fill({ bps_vs_oracle: 2 }),
      fill({ follower: "bob.testnet", bps_vs_oracle: null }),
    ];
    expect(followerQuality(q, ["alice.testnet", "bob.testnet"])).toEqual([
      { follower: "alice.testnet", n: 2, avg: 2, best: 2, worst: 2, last: NOW - 42_000 },
      { follower: "bob.testnet", n: 1, avg: null, best: null, worst: null, last: NOW - 42_000 },
    ]);
  });
  test("solver quote: the follower's batch share wins over the batch total; old solvers fall back", () => {
    const batch = { quote: { quote: { amountOutFormatted: "1.92" } } }; // whole batch under batched RFQ
    expect(quoteOut({ follower: "a", amount: "1", quote_out: "640125", price: "2.5605", ...batch })).toBe("0.6401");
    expect(quoteOut({ follower: "a", amount: "1", ...batch })).toBe("1.92");
    expect(quoteOut({ follower: "a", amount: "1" })).toBe("?"); // quote failed
  });
});
