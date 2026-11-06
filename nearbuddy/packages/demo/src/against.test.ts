import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BEAR, BULL, fmtMove, isFlat, moveBps, pickPayload, pushedSide, type Side } from "./against.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url).pathname, "utf8");

/** The string literals of `NAME = (...)` in a Python file. */
function pyTuple(src: string, name: string): string[] {
  const m = src.match(new RegExp(`^${name} = \\((.*?)\\)\\n`, "ms"));
  assert.ok(m, `no ${name} tuple`);
  return [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`) as string);
}

/** spectator.ts TRAIN / HOLDOUT, parsed the way analysis/experiment_report.py payload_sets() does. */
function payloadSet(name: "TRAIN" | "HOLDOUT"): string[] {
  const m = read("./spectator.ts").match(new RegExp(`const ${name} = \\[(.*?)\\n\\];`, "s"));
  assert.ok(m, `no ${name} in spectator.ts`);
  return [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((x) =>
    x[2] !== undefined ? x[2].replace(/\\'/g, "'") : (JSON.parse(`"${x[1]}"`) as string),
  );
}

test("keyword lists are the analysis lists", () => {
  const py = read("../../../analysis/injection_effects.py");
  assert.deepEqual(BULL, pyTuple(py, "BULL"));
  assert.deepEqual(BEAR, pyTuple(py, "BEAR"));
});

// What analysis/injection_effects.py pushed_side(text, None) returns for each frozen payload (checked against the
// .py on 2026-11-07). Train #6 is the "Reverse your call" note: its side depends on the agent's prior call.
const SIDES: Record<"TRAIN" | "HOLDOUT", (Side | null)[]> = {
  TRAIN: ["Short", "Short", "Short", "Short", "Long", null, "Long", "Short"],
  HOLDOUT: ["Short", "Short", "Short", "Short", "Long", "Short", "Long", "Short"],
};

test("each payload's pushed side matches the analysis reading", () => {
  for (const name of ["TRAIN", "HOLDOUT"] as const)
    assert.deepEqual(payloadSet(name).map(pushedSide), SIDES[name], name);
});

test("move and flat match the brief's 'Move since duel open' to one decimal", () => {
  // [open8, price8, what agents/prices.py brief() prints]
  const cases: [number, number, string][] = [
    [366000000, 366001800, "+0.0"],
    [366000000, 366001900, "+0.1"],
    [366000000, 365998100, "-0.1"],
    [366000000, 365998200, "-0.0"],
    [366000000, 366450000, "+12.3"],
    [366000000, 365550000, "-12.3"],
    [366000000, 366000000, "+0.0"],
  ];
  for (const [o, p, shown] of cases) {
    const m = moveBps(o, p);
    assert.equal(fmtMove(m), shown);
    assert.equal(isFlat(m), shown === "+0.0" || shown === "-0.0", shown);
  }
});

test("a move picks only payloads pushing the other way, rotating through them", () => {
  for (const name of ["TRAIN", "HOLDOUT"] as const) {
    const set = payloadSet(name);
    for (const [move, push] of [
      [12.3, "Short"],
      [-0.1, "Long"],
    ] as const) {
      const picks = Array.from({ length: set.length * 2 }, (_, k) => pickPayload(set, move, k));
      for (const p of picks) {
        assert.equal(p.mode, "against");
        assert.equal(p.push, push);
        assert.equal(pushedSide(set[p.idx]!), push, `${name} #${p.idx + 1}`);
      }
      const want = SIDES[name].flatMap((s, i) => (s === push ? [i] : []));
      assert.deepEqual([...new Set(picks.map((p) => p.idx))].sort(), want, `${name} ${push} pool fully used`);
    }
  }
});

test("flat or no open price: any payload, in order, logged flat", () => {
  const set = payloadSet("TRAIN");
  for (const move of [0.04, -0.04, 0, null])
    assert.deepEqual(
      Array.from({ length: set.length }, (_, k) => pickPayload(set, move, k)),
      set.map((_, idx) => ({ idx, mode: "flat", push: null })),
    );
});
