// Smoke for the doodle footer pure helpers and board-held ASCII bars.
import { expect, test } from "bun:test";
import board from "../data/board.json";
import {
  boardHeldBars,
  clamp,
  hash,
  layoutWord,
  seatPoint,
  timeline,
} from "./doodle-crew-footer";

test("hash is stable in [0, 1)", () => {
  expect(hash(1)).toBeGreaterThanOrEqual(0);
  expect(hash(1)).toBeLessThan(1);
  expect(hash(1)).toBe(hash(1));
});

test("layoutWord lays out NEARBUDDY without throwing", () => {
  const advances = Array.from("NEARBUDDY").map(() => 152);
  const lay = layoutWord(advances, -0.02, 200);
  expect(lay.x).toHaveLength(9);
  expect(lay.width).toBeGreaterThan(1000);
});

test("seatPoint and clamp", () => {
  expect(clamp(5, 0, 3)).toBe(3);
  expect(seatPoint("front", 10, 20, 100, 0, 1)).toEqual({ x: 20, y: 0 });
  expect(seatPoint("top", 10, 20, 100, 0, 1).y).toBe(-100);
});

test("timeline covers nine-letter wordmark", () => {
  const tl = timeline(9, 6, 6, 2);
  expect(tl.letter(8)).toBeGreaterThan(tl.letter(0));
  expect(tl.total).toBeGreaterThan(tl.member(5));
});

test("boardHeldBars ranks models by held rate from board.json", () => {
  const bars = boardHeldBars(board.models);
  expect(bars.length).toBe(board.models.length);
  for (const b of bars) {
    expect(b.rate).toBeGreaterThanOrEqual(0);
    expect(b.rate).toBeLessThanOrEqual(1);
    expect(b.label.length).toBeGreaterThan(0);
  }
  for (let i = 1; i < bars.length; i++) {
    expect(bars[i - 1]!.rate).toBeGreaterThanOrEqual(bars[i]!.rate);
  }
});
