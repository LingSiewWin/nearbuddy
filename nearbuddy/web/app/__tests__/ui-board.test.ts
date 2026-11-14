// The scoreboard's ranking rule and the Verify drawer's grouping (ui/board.ts).
import { describe, expect, test } from "bun:test";
import { type BoardModel, groupChecks, likely, splitBoard } from "../ui/board";

const m = (model: string, tested: number, fooled: number, at = 0, af = 0): BoardModel => ({
  model,
  attacks: tested,
  tested,
  fooled,
  against_tested: at,
  against_fooled: af,
});

describe("scoreboard ranking", () => {
  test("only models with 10 or more counted attacks are ranked; the rest are too few to rank", () => {
    const { ranked, few } = splitBoard([m("nine", 9, 0), m("ten", 10, 5), m("none", 0, 0)], "all");
    expect(ranked.map((r) => r.model)).toEqual(["ten"]);
    expect(few.map((r) => r.model)).toEqual(["nine", "none"]); // a perfect short record is still not ranked
  });
  test("ranked by the worst case the record still allows: many clean results outrank few", () => {
    const { ranked } = splitBoard([m("few-clean", 10, 0), m("many-clean", 60, 1), m("bad", 22, 20)], "all");
    expect(ranked.map((r) => r.model)).toEqual(["many-clean", "few-clean", "bad"]);
  });
  test("the against-the-move toggle uses its own counts, with the same threshold", () => {
    const { ranked, few } = splitBoard([m("a", 22, 5, 17, 0), m("b", 22, 20, 9, 7)], "against");
    expect(ranked).toEqual([{ model: "a", tested: 17, fooled: 0 }]);
    expect(few).toEqual([{ model: "b", tested: 9, fooled: 7 }]);
  });
  test("the interval is stated in whole percent", () => {
    expect(likely(3, 14)).toBe("Likely between 8% and 48%.");
  });
});

describe("verify groups", () => {
  const line = (check: string, result: "PASS" | "FAIL" | "SKIP" | "INFO") => ({ check, result, detail: "" });
  test("lines go to the first group whose prefix matches; unmatched ones are never hidden", () => {
    const g = groupChecks([
      line("opened by open_duel", "PASS"),
      line("oracle open price", "PASS"),
      line("oracle close price", "PASS"),
      line("intent A signature", "PASS"),
      line("injection 0", "PASS"),
      line("brand new check", "PASS"),
    ]);
    expect(g.map((x) => [x.name, x.lines.length])).toEqual([
      ["The duel was opened properly", 2],
      ["Every decision was signed in the enclave", 1],
      ["Headlines and money locked", 1],
      ["Result and payouts follow the rules", 1],
      ["Other checks", 1],
    ]);
  });
  test("a group passes only if every line passed; not checked is never rounded up", () => {
    const g = groupChecks([
      line("intent A signature", "PASS"),
      line("intent B answer bytes", "SKIP"),
      line("payout to winner", "PASS"),
      line("pnl A", "FAIL"),
      line("pnl note", "INFO"),
      line("injection 0", "PASS"),
      line("injection note", "INFO"),
    ]);
    const by = Object.fromEntries(g.map((x) => [x.name, x]));
    expect(by["Every decision was signed in the enclave"]?.mark).toBe("skip");
    expect(by["Result and payouts follow the rules"]?.mark).toBe("fail");
    expect(by["Result and payouts follow the rules"]?.lines.map((l) => l.result)).toEqual(["FAIL", "PASS", "INFO"]);
    expect(by["Headlines and money locked"]?.mark).toBe("pass");
  });
});
