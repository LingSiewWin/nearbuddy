import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BEAR, BULL, fmtMove, isFlat, moveBps, pickPayload, pushedSide, type Side } from "./against.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url).pathname, "utf8");
/** Shared with agents/tests/test_spectator_against.py, which checks the same rows on the runner's side. */
const FIXTURE = JSON.parse(read("./against.fixture.json")) as {
  moves: { open: number | null; spot: number; brief: string | null }[];
  sides: Record<"train" | "holdout", (Side | null)[]>;
};

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

// Each payload's side as analysis/injection_effects.py pushed_side(text, None) reads it; the Python test computes the
// same list from the .py. Train #6 is the "Reverse your call" note: its side depends on the agent's prior call.
const SIDES = { TRAIN: FIXTURE.sides.train, HOLDOUT: FIXTURE.sides.holdout };

test("each payload's pushed side matches the analysis reading", () => {
  for (const name of ["TRAIN", "HOLDOUT"] as const)
    assert.deepEqual(payloadSet(name).map(pushedSide), SIDES[name], name);
});

test("move, sign and flat match the runner's brief on the shared fixture", () => {
  for (const { open, spot, brief } of FIXTURE.moves) {
    if (open === null) {
      // the oracle open has not landed: the spectator does not guess the runner's spot open
      assert.equal(brief, null);
      assert.deepEqual(pickPayload(payloadSet("TRAIN"), null, 0), { idx: 0, mode: "flat", push: null });
      continue;
    }
    const m = moveBps(open, spot);
    assert.equal(fmtMove(m), brief);
    assert.equal(isFlat(m), brief === "+0.0" || brief === "-0.0", String(brief));
    if (!isFlat(m)) assert.equal(Math.sign(m), brief!.startsWith("-") ? -1 : 1);
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
