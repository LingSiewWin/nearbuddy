import { expect, test } from "bun:test";
import { curveOf, dot, edge, hash, pulseCol, sample } from "./tiles";

test("the curve is the price series scaled to 0..1, and a flat series is level", () => {
  expect(curveOf([3, 5, 4])).toEqual([0, 1, 0.5]);
  expect(curveOf([2, 2])).toEqual([0.5, 0.5]);
  expect(curveOf([])).toEqual([0.5, 0.5]);
});

test("the loop runs forward then backward with no jump", () => {
  const c = curveOf([1, 2, 4]);
  expect(sample(c, 0)).toBe(0);
  expect(sample(c, 1)).toBe(1);
  expect(sample(c, 2)).toBeCloseTo(0, 9);
  expect(sample(c, 0.75)).toBeCloseTo(sample(c, 1.25), 9);
  expect(sample(c, -0.25)).toBeCloseTo(sample(c, 0.25), 9);
});

test("the edge stays inside the field, and dots fade away from it on both sides", () => {
  const c = curveOf([3.32, 3.33, 3.31, 3.35]);
  for (const t of [0, 3.7, 120, 9999]) {
    for (let col = 0; col < 288; col += 7) {
      const e = edge(c, col, 288, t);
      expect(e).toBeGreaterThanOrEqual(0.1);
      expect(e).toBeLessThanOrEqual(0.9);
      const at = (1 - e) * 179;
      for (let row = 0; row < 180; row++) {
        const d = dot(col, row, 180, e, t);
        if (!d) continue;
        expect(d.v).toBeGreaterThan(0);
        expect(d.v).toBeLessThanOrEqual(1);
        // strength never rises with distance from the edge: no hard step, on either side
        if (d.hue !== "deep" || row > at) expect(d.v).toBeLessThanOrEqual(Math.exp(-Math.abs(row - at) / 180) + 1e-9);
      }
    }
  }
});

test("the same inputs give the same dot, and the field changes over time", () => {
  expect(hash(7, 9)).toBe(hash(7, 9));
  const at = (t: number) => Array.from({ length: 180 }, (_, r) => (dot(40, r, 180, 0.5, t) ? "x" : ".")).join("");
  expect(at(2)).toBe(at(2));
  expect(at(2)).not.toBe(at(9));
});

test("a pulse crosses left to right, then rests", () => {
  expect(pulseCol(100, 0)).toBe(0);
  expect(pulseCol(100, 1.3)).toBe(50);
  expect(pulseCol(100, 5)).toBe(-1);
  expect(pulseCol(100, 14)).toBe(0);
});
