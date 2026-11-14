// The decision field: its committed data must match the dataset and the scoreboard, and its layout must place every
// decision exactly once, inside the canvas, at any width.
import { expect, test } from "bun:test";
import { build } from "../../scripts/field";
import board from "../data/board.json";
import field from "../data/field.json";
import { type FieldData, fieldCounts, fieldLayout, markAt } from "../ui/field";

const data = field as FieldData;

test("app/data/field.json matches the dataset (run `bun scripts/field.ts` after an export)", () => {
  expect(data).toEqual(build());
});

test("one mark per recorded decision, and the same verdict counts as the scoreboard", () => {
  const counts = fieldCounts(data);
  expect(counts.reduce((s, c) => s + c.total, 0)).toBe(board.rows);
  expect(data.rows).toBe(board.rows);
  for (const m of board.models) {
    const c = counts.find((x) => data.models[x.model] === m.model);
    expect(c?.counts.f).toBe(m.fooled);
    expect((c?.counts.f ?? 0) + (c?.counts.h ?? 0)).toBe(m.tested);
    expect((c?.counts.f ?? 0) + (c?.counts.h ?? 0) + (c?.counts.n ?? 0)).toBe(m.attacks);
  }
});

const tiny: FieldData = {
  source: "test",
  rows: 9,
  models: ["m0", "m1"],
  duels: [
    {
      id: "1",
      agents: [
        { m: 0, d: "..f" },
        { m: 1, d: ":h" },
      ],
    },
    { id: "2", agents: [{ m: 0, d: "...." }] },
  ],
};

test("layout: bands by size, runs separated by one empty cell, short runs kept on one line", () => {
  const l = fieldLayout(tiny, 60, 6, 20, 10); // 10 columns
  expect(l.cols).toBe(10);
  expect(l.bands.map((b) => [b.model, b.total])).toEqual([
    [0, 7],
    [1, 2],
  ]);
  const m0 = l.marks.filter((m) => m.model === 0);
  expect(m0.map((m) => m.x / 6)).toEqual([0, 1, 2, 4, 5, 6, 7]); // column 3 is the gap between the two runs
  expect(m0.every((m) => m.y === 20)).toBe(true);
  expect(m0[2]?.kind).toBe("f");
  const narrow = fieldLayout(tiny, 36, 6, 20, 10); // 6 columns: the 4-long run moves to its own line
  expect(narrow.marks.filter((m) => m.model === 0).map((m) => [m.x / 6, (m.y - 20) / 6])).toEqual([
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
  ]);
  expect(l.bands[1]?.y).toBe(20 + 6 + 10);
  expect(l.height).toBe(20 + 6 + 10 + 20 + 6);
});

test("layout: every decision once, inside the width, no two marks on one cell, at phone and desktop widths", () => {
  for (const width of [358, 700, 1328]) {
    const l = fieldLayout(data, width);
    expect(l.marks.length).toBe(data.rows);
    expect(l.marks.every((m) => m.x >= 0 && m.x + l.step <= width && m.y + l.step <= l.height)).toBe(true);
    expect(new Set(l.marks.map((m) => `${m.x}:${m.y}`)).size).toBe(data.rows);
  }
  expect(fieldLayout(data, 5).marks).toEqual([]); // too narrow for a cell
});

test("hit test finds the mark under a point", () => {
  const l = fieldLayout(tiny, 60, 6, 20, 10);
  expect(markAt(l, 13, 22)).toMatchObject({ kind: "f", duel: "1", model: 0 });
  expect(markAt(l, 19, 22)).toBeNull(); // the gap
});
