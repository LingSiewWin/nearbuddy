// The bar strip must never round a count to "none" or "all", and the sparkline must stay inside its box.
import { expect, test } from "bun:test";
import { meterPct, sparkPoints, stripCells } from "../ui/instruments";

test("a strip lights a proportional share of its cells", () => {
  expect(stripCells(12, 24, 24)).toBe(12);
  expect(stripCells(49, 705, 24)).toBe(2);
  expect(stripCells(5, 45, 24)).toBe(3);
});

test("a strip is empty only for zero and full only for all", () => {
  expect(stripCells(0, 704, 24)).toBe(0);
  expect(stripCells(1, 704, 24)).toBe(1); // 0.03 of a cell still shows
  expect(stripCells(703, 704, 24)).toBe(23); // 23.97 cells is not "all"
  expect(stripCells(676, 704, 24)).toBe(23);
  expect(stripCells(704, 704, 24)).toBe(24);
  expect(stripCells(3, 0, 24)).toBe(0);
});

test("sparkline points span the box, lowest value at the bottom", () => {
  expect(sparkPoints([1], 28)).toBe("");
  expect(sparkPoints([1, 3, 2], 28)).toBe("0,27 50,1 100,14");
  expect(sparkPoints([2, 2], 28)).toBe("0,27 100,27"); // a flat series is a flat line, not a division by zero
});

test("a meter bar is empty only for zero and full only for all", () => {
  expect(meterPct(0, 704)).toBe(0);
  expect(meterPct(704, 704)).toBe(100);
  expect(meterPct(1, 704)).toBeGreaterThan(0);
  expect(meterPct(1, 704)).toBeLessThan(1);
  expect(meterPct(703, 704)).toBeLessThan(100);
  expect(meterPct(676, 704)).toBeCloseTo((676 / 704) * 100, 5);
});
