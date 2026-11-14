// The loader's patterns: which cell lights when.
import { expect, test } from "bun:test";
import { cellStep } from "../ui/loading";

test("drive and dots sweep as a chevron: the middle row leads and every cell lights", () => {
  for (const v of ["drive", "dots"] as const) {
    expect(cellStep(v, 2, 0)).toBe(0);
    expect(cellStep(v, 0, 0)).toBe(2);
    expect(cellStep(v, 4, 0)).toBe(2);
    expect(cellStep(v, 2, 4)).toBe(4);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) expect(cellStep(v, r, c)).not.toBeNull();
  }
});

test("orbit laps the 16 edge cells once, in order, and leaves the inner cells dark", () => {
  const steps: number[] = [];
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 5; c++) {
      const s = cellStep("orbit", r, c);
      const edge = r === 0 || r === 4 || c === 0 || c === 4;
      expect(s === null).toBe(!edge);
      if (s !== null) steps.push(s);
    }
  expect(steps.sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
  expect(cellStep("orbit", 0, 0)).toBe(0);
  expect(cellStep("orbit", 0, 4)).toBe(4);
  expect(cellStep("orbit", 4, 4)).toBe(8);
  expect(cellStep("orbit", 4, 0)).toBe(12);
});
