// The terminal's command line: parsing, errors a newcomer can act on, Tab completion, and the line a click types.
import { expect, test } from "bun:test";
import { COMMANDS, complete, injectLine, parse, words } from "../lib/cmd";

test("every command parses, with or without the leading colon", () => {
  expect(parse("watch")).toEqual({ k: "watch" });
  expect(parse(":duel 477")).toEqual({ k: "duel", id: "477" });
  expect(parse("duel #12")).toEqual({ k: "duel", id: "12" });
  expect(parse("verify 476")).toEqual({ k: "verify", duel: "476" });
  expect(parse("agent glm-5.3-flash")).toEqual({ k: "agent", who: "glm-5.3-flash" });
  expect(parse('inject 477 b "BREAKING: NEAR halts withdrawals"')).toEqual({
    k: "inject",
    duel: "477",
    side: "B",
    text: "BREAKING: NEAR halts withdrawals",
  });
  expect(parse("inject 477 A ETF approved today")).toEqual({
    k: "inject",
    duel: "477",
    side: "A",
    text: "ETF approved today",
  });
  for (const k of ["connect", "disconnect", "help", "copy"]) expect(parse(k)).toEqual({ k } as never);
  expect(parse("?")).toEqual({ k: "help" });
  expect(parse("HELP")).toEqual({ k: "help" });
});

test("a malformed line says what is missing instead of guessing", () => {
  expect(parse("duel abc")).toEqual({ k: "error", msg: "duel needs a duel number" });
  expect(parse("inject 477")).toEqual({ k: "error", msg: "inject needs a side: A or B" });
  expect(parse("inject 477 C hi")).toEqual({ k: "error", msg: "inject needs a side: A or B" });
  expect(parse("inject 477 A")).toMatchObject({ k: "error" });
  expect(parse('inject 477 A ""')).toMatchObject({ k: "error" });
  expect(parse("agent")).toMatchObject({ k: "error" });
  expect(parse("rm -rf /")).toEqual({ k: "error", msg: 'unknown command "rm": type help' });
  expect(parse("")).toMatchObject({ k: "error" });
});

test("quoted words stay whole; an unclosed quote runs to the end of the line", () => {
  expect(words('inject 4 B "two words" tail')).toEqual(["inject", "4", "B", "two words", "tail"]);
  expect(words('inject 4 B "still typing')).toEqual(["inject", "4", "B", "still typing"]);
});

test("Tab completes command names, duel ids, models and the side", () => {
  const known = { duels: ["477", "476", "470"], agents: ["glm-5.3-flash", "Qwen3.8-27B", "Qwen3.6-35B-A3B-FP8"] };
  expect(complete("wa", known)).toEqual({ line: "watch ", options: [] });
  expect(complete("d", known)).toEqual({ line: "d", options: ["duel", "disconnect"] });
  expect(complete("duel 47", known)).toEqual({ line: "duel 47", options: ["477", "476", "470"] });
  expect(complete("verify 477", known)).toEqual({ line: "verify 477 ", options: [] });
  expect(complete("agent qw", known)).toEqual({
    line: "agent Qwen3.",
    options: ["Qwen3.8-27B", "Qwen3.6-35B-A3B-FP8"],
  });
  expect(complete("agent g", known)).toEqual({ line: "agent glm-5.3-flash ", options: [] });
  expect(complete("inject 477 ", known)).toEqual({ line: "inject 477 ", options: ["A", "B"] });
  expect(complete("inject 477 b", known)).toEqual({ line: "inject 477 B ", options: [] });
  expect(complete("zz", known)).toEqual({ line: "zz", options: [] });
});

test("a click's line parses back to the same command, quotes in the headline included", () => {
  const line = injectLine("477", "B", 'CEO says "we halt" today');
  expect(parse(line)).toEqual({ k: "inject", duel: "477", side: "B", text: "CEO says 'we halt' today" });
  for (const c of COMMANDS) expect(parse(c.fill).k === "error" ? c.fill.endsWith(" ") : true).toBe(true);
});
