// The amount and time formatters of the Trace design (ui/format.ts).
import { describe, expect, test } from "bun:test";
import { bet, clock, guestLabel, hm, near, nearAmount, shortId, timeAgo } from "../ui/format";

const N = 10n ** 24n;

describe("nearAmount", () => {
  test("up to 4 decimals, trailing zeros dropped, unit after the number", () => {
    expect(nearAmount(N / 20n)).toBe("0.05");
    expect(nearAmount(N / 2n)).toBe("0.5");
    expect(nearAmount(2n * N)).toBe("2");
    expect(nearAmount("156250000000000000000000")).toBe("0.1563"); // 0.15625 rounds to nearest
    expect(nearAmount("96660000000000000000000")).toBe("0.0967");
    expect(nearAmount(100n * N + N / 10n)).toBe("100.1");
    expect(near(N / 20n)).toBe("0.05 NEAR");
  });
  test("a small amount never prints as 0: its first two significant digits", () => {
    expect(nearAmount("41230000000000000000")).toBe("0.000041");
    expect(nearAmount(N / 10_000n)).toBe("0.0001");
    expect(nearAmount("1")).toBe("0.000000000000000000000001");
  });
  test("zero is 0, and yoctoNEAR never shows", () => {
    expect(nearAmount("0")).toBe("0");
    expect(near("1410000000000000000000")).toBe("0.0014 NEAR");
  });
});

describe("times", () => {
  test("clock is mm:ss under an hour and h:mm:ss over", () => {
    expect(clock(724)).toBe("12:04");
    expect(clock(190)).toBe("03:10");
    expect(clock(3600)).toBe("1:00:00");
    expect(clock(3725.9)).toBe("1:02:05");
    expect(clock(-5)).toBe("00:00");
  });
  test("wall clock and time ago", () => {
    expect(hm(Date.UTC(2026, 10, 14, 14, 6, 59), "UTC")).toBe("14:06");
    const now = Date.UTC(2026, 10, 14, 15, 0, 0);
    expect(timeAgo(now - 30_000, now)).toBe("just now");
    expect(timeAgo(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(timeAgo(now - 4 * 86_400_000, now)).toBe("4 d ago");
  });
});

test("plain words: bets, guest label, shortened ids", () => {
  expect(bet("Long")).toBe("UP");
  expect(bet("Short")).toBe("DOWN");
  expect(guestLabel("nb-guest-k3f9x7a2bq.testnet")).toBe("Guest · k3f9");
  expect(shortId("nearbuddy-solver.testnet")).toBe("nearbuddy-…estnet");
  expect(shortId("alice.testnet")).toBe("alice.testnet");
});
