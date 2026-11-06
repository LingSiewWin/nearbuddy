// Render helpers behind the commit-reveal markers and the execution box, checked on fixture data.
// Run: `cd web && bun test` or `bun test web/app` from nearbuddy.
import { describe, expect, test } from "bun:test";
import {
  age,
  type CommitConfig,
  commitCells,
  commitWord,
  FILL_HEAD,
  type Fill,
  fillCells,
  followerQuality,
  lastFills,
  proven,
  quoteOut,
  revealCell,
  sbps,
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
    expect(text(commitCells(c))).toBe("on   calls hidden until reveal · no reveal costs 5 % of bond");
  });
  test("explicitly off: posted in the clear", () => {
    expect(text(commitCells({ commit_reveal: false }))).toContain("in the clear");
  });
  test("reveal marker per side", () => {
    expect(revealCell(true, false, true)).toMatchObject({ t: "no-reveal slashed", c: "loss" });
    expect(revealCell(true, true, true)).toMatchObject({ t: "no-reveal slashed" }); // the slash wins
    expect(revealCell(false, true, false)).toMatchObject({ t: "revealed", c: "ok" });
    expect(revealCell(undefined, false, false)).toMatchObject({ t: "hidden until reveal" });
    expect(revealCell(undefined, false, true)).toMatchObject({ t: "no intent" });
  });
  test("proven: zero or missing proof hash is not verified (deploy 13 and committed-but-hidden intents)", () => {
    expect(proven({ proof_hash: "q83vEjRWeJA=" }, ZERO)).toBe(true);
    expect(proven({ proof_hash: ZERO }, ZERO)).toBe(false);
    expect(proven({}, ZERO)).toBe(false);
    expect(proven(null, ZERO)).toBe(false);
  });
});

describe("execution", () => {
  test("units: yocto wNEAR in, 6-dp USDC out, 1e8 oracle mid", () => {
    const t = text(fillCells(fill(), NOW));
    expect(t).toMatch(/ 0\.250 wNEAR → +0\.6401 USDC /);
    expect(t).toContain("2.5610");
    expect(t).toContain("+3.4 bps");
    expect(t).toContain("42s ago");
    expect(usdc(null)).toBe("-");
  });
  test("a row and the header fit the value column, with the columns aligned", () => {
    const t = text(fillCells(fill({ follower: "a-very-long-follower-account.testnet" }), NOW));
    expect(t.length).toBeLessThanOrEqual(VW);
    expect(FILL_HEAD.length).toBe(text(fillCells(fill(), NOW)).length);
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
