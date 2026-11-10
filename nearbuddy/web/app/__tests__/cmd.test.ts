// The terminal's command line: parsing, errors a newcomer can act on, Tab completion, and the line a click types.
import { expect, test } from "bun:test";
import { COMMANDS, complete, injectLine, parse, predictLine, words } from "../lib/cmd";

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
    kind: null,
    text: "BREAKING: NEAR halts withdrawals",
  });
  expect(parse('inject 477 b SHORT "BREAKING: NEAR halts withdrawals"')).toEqual({
    k: "inject",
    duel: "477",
    side: "B",
    kind: "Short",
    text: "BREAKING: NEAR halts withdrawals",
  });
  // a lone long/short is the headline, not a direction; a quoted headline starting with it stays whole
  expect(parse("inject 477 A long")).toMatchObject({ kind: null, text: "long" });
  expect(parse('inject 477 A "long squeeze ahead"')).toMatchObject({ kind: null, text: "long squeeze ahead" });
  expect(parse("inject 477 A constructor halts")).toMatchObject({ kind: null, text: "constructor halts" });
  expect(parse("claim 470")).toEqual({ k: "claim", duel: "470" });
  expect(parse("CLAIM #470")).toEqual({ k: "claim", duel: "470" });
  expect(parse("DUEL 470")).toEqual({ k: "duel", id: "470" });
  expect(parse("inject 477 A ETF approved today")).toEqual({
    k: "inject",
    duel: "477",
    side: "A",
    kind: null,
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
  expect(parse("claim")).toEqual({ k: "error", msg: "claim needs a duel number" });
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
  expect(complete("inject 477 B ", known)).toEqual({ line: "inject 477 B ", options: ["long", "short"] });
  expect(complete("inject 477 B s", known)).toEqual({ line: "inject 477 B short ", options: [] });
  expect(complete("claim 47", known)).toEqual({ line: "claim 47", options: ["477", "476", "470"] });
  expect(complete("zz", known)).toEqual({ line: "zz", options: [] });
});

test("a click's line parses back to the same command, quotes in the headline included", () => {
  const line = injectLine("477", "B", 'CEO says "we halt" today');
  expect(parse(line)).toEqual({ k: "inject", duel: "477", side: "B", kind: null, text: "CEO says 'we halt' today" });
  expect(parse(injectLine("477", "A", "long squeeze", "Short"))).toEqual({
    k: "inject",
    duel: "477",
    side: "A",
    kind: "Short",
    text: "long squeeze",
  });
  for (const c of COMMANDS) expect(parse(c.fill).k === "error" ? c.fill.endsWith(" ") : true).toBe(true);
});

test("predict: a free prediction on the duel's winner or on one attack, its click line parsing back", () => {
  expect(parse("predict 480 a")).toEqual({ k: "predict", duel: "480", index: null, pick: "A" });
  expect(parse("predict #480 TIE")).toEqual({ k: "predict", duel: "480", index: null, pick: "Tie" });
  expect(parse("predict 480 1 fooled")).toEqual({ k: "predict", duel: "480", index: 1, pick: "Flipped" });
  expect(parse("predict 480 #31 held")).toEqual({ k: "predict", duel: "480", index: 31, pick: "Held" });
  for (const [duel, index, pick] of [
    ["480", null, "B"],
    ["480", 0, "Held"],
    ["7", 12, "Flipped"],
  ] as const)
    expect(parse(predictLine(duel, index, pick))).toEqual({ k: "predict", duel, index, pick });
  expect(predictLine("480", 2, "Flipped")).toBe("predict 480 2 fooled");
  expect(parse("predict")).toEqual({ k: "error", msg: "predict needs a duel number" });
  expect(parse("predict 480")).toMatchObject({ k: "error", msg: expect.stringContaining("predict 12 A") });
  expect(parse("predict 480 fooled")).toMatchObject({ k: "error" }); // an attack's pick needs the attack number
  expect(parse("predict 480 0 A")).toEqual({ k: "error", msg: "predict an attack fooled or holds" });
  expect(parse("predict 480 32 fooled")).toEqual({ k: "error", msg: "predict needs an attack number from 0 to 31" });
  expect(parse("predict 480 x fooled")).toMatchObject({ k: "error" });
  expect(parse("settle 480")).toEqual({ k: "settle", duel: "480" });
  expect(parse("settle")).toEqual({ k: "error", msg: "settle needs a duel number" });
  expect(parse("claim predictions")).toEqual({ k: "claimPredictions" });
  const known = { duels: ["480"], agents: [] };
  expect(complete("predict 480 ", known)).toEqual({ line: "predict 480 ", options: ["A", "B"] });
  expect(complete("predict 480 1 f", known)).toEqual({ line: "predict 480 1 fooled ", options: [] });
  expect(complete("claim p", known)).toEqual({ line: "claim predictions ", options: [] });
});
