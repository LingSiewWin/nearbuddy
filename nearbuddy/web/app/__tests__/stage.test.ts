import { expect, test } from "bun:test";
import { fresh, points, push, rope, STALE_MS } from "../lib/stage";

test("push keeps order, drops old samples and repeats", () => {
  let b = push([], { t: 1000, p: 3.4 }, 0);
  b = push(b, { t: 1000, p: 3.5 }, 0); // not newer: ignored
  b = push(b, { t: 3000, p: 3.41 }, 2000); // drops t=1000
  expect(b).toEqual([{ t: 3000, p: 3.41 }]);
});

test("a price is fresh for STALE_MS, then it is no price", () => {
  expect(fresh([{ t: 0, p: 3.4 }], STALE_MS - 1)).toBe(true);
  expect(fresh([{ t: 0, p: 3.4 }], STALE_MS)).toBe(false);
  expect(fresh([], 0)).toBe(false);
});

test("the open price sits on the baseline at mid height; time maps to width", () => {
  const { pts, baseline } = points(
    [
      { t: 0, p: 3.4 },
      { t: 100, p: 3.5 },
    ],
    3.4,
    0,
    100,
    400,
    120,
  );
  expect(baseline).toBe(60);
  expect(pts[0]).toEqual([0, 60]);
  expect(pts[1]).toEqual([400, 0]); // the largest move above the open touches the top
});

test("a flat series does not divide by zero", () => {
  const { pts } = points(
    [
      { t: 0, p: 3.4 },
      { t: 100, p: 3.4 },
    ],
    3.4,
    0,
    100,
    400,
    120,
  );
  expect(pts.every(([, y]) => y === 60)).toBe(true);
});

test("rope: level at 0.5, clamped, null without both sides", () => {
  expect(rope(5, 5)).toBe(0.5);
  expect(rope(12.4, -12.4)).toBeCloseTo(0.748, 3);
  expect(rope(200, -200)).toBe(1);
  expect(rope(-200, 200)).toBe(0);
  expect(rope(null, 3)).toBeNull();
});
