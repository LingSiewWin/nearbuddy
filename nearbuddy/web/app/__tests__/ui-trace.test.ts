// The Trace's geometry and text alternative (ui/trace.ts): decisions and planted-headline records in, lines, pins,
// zones and sentences out.
import { describe, expect, test } from "bun:test";
import { hm } from "../ui/format";
import { altText, geometry, markOf, pinsOf, recordTrace, story, type TraceIn } from "../ui/trace";

const T0 = Date.UTC(2026, 10, 14, 14, 0, 0);
const min = (n: number) => T0 + n * 60_000;
const BOX = { width: 220, height: 80, padL: 10, padR: 10 }; // 20 px a minute over a 10 minute duel
const UP = 20;
const DOWN = 60;
const utc = (ms: number) => hm(ms, "UTC");
const base: TraceIn = { from: T0, to: min(10), now: min(8), running: true, decisions: [], loadedFrom: null, pins: [] };

describe("geometry", () => {
  test("held: the line stays on its rail in ink, the pin is a ring", () => {
    const t: TraceIn = {
      ...base,
      decisions: [
        { at: min(2), side: "Long" },
        { at: min(7), side: "Long" },
      ],
      pins: [{ id: "0", at: min(6), mark: "held", prev: "Long" }],
    };
    const g = geometry(t, BOX);
    expect(g.ink).toBe(`50,${UP} 150,${UP} 170,${UP}`);
    expect(g.red).toBe("");
    expect(g.pins).toEqual([{ id: "0", x: 130, y: UP, mark: "held" }]);
    expect(g.zones).toEqual([]);
    expect(g.head).toEqual({ x: 170, y: UP, pulse: true });
    expect(altText("claude-x", story(t, utc))).toBe(
      "claude-x: betting UP since 14:02. Headline planted 14:06. Next decision 14:07: still betting UP. Held.",
    );
  });

  test("fooled: the line crosses, and from the pin onward it is red", () => {
    const t: TraceIn = {
      ...base,
      decisions: [
        { at: min(1), side: "Long" },
        { at: min(5), side: "Short" },
      ],
      pins: [{ id: "3", at: min(4), mark: "fooled", prev: "Long" }],
    };
    const g = geometry(t, BOX);
    expect(g.ink).toBe(`30,${UP} 90,${UP}`);
    expect(g.red).toBe(`90,${UP} 110,${UP} 110,${DOWN} 170,${DOWN}`);
    expect(g.pins[0]).toEqual({ id: "3", x: 90, y: UP, mark: "fooled" });
    expect(g.head?.y).toBe(DOWN);
    expect(story(t, utc)).toEqual([
      "Betting UP since 14:01.",
      "Headline planted 14:04.",
      "Next decision 14:05: betting DOWN.",
      "Fooled.",
    ]);
  });

  test("waiting: a hatched zone from the pin to now; locked in adds the solid edge", () => {
    const t: TraceIn = {
      ...base,
      decisions: [{ at: min(1), side: "Short" }],
      pins: [{ id: "1", at: min(5), mark: "waiting", prev: "Short", locked: true }],
    };
    const g = geometry(t, BOX);
    expect(g.zones).toEqual([{ id: "1", x1: 110, x2: 170, y: DOWN - 8, h: 16, locked: true }]);
    expect(g.ink).toBe(`30,${DOWN} 170,${DOWN}`);
    expect(geometry({ ...t, now: min(9) }, BOX).zones[0]?.x2).toBe(190); // it grows with the clock
    expect(story(t, utc).at(-1)).toBe("Waiting for its next decision.");
  });

  test("did not count and refunded: a dashed-ring pin, the line unchanged, and their own words", () => {
    const t: TraceIn = {
      ...base,
      decisions: [{ at: min(1), side: "Long" }],
      pins: [
        { id: "0", at: min(3), mark: "nocount", prev: "Long" },
        { id: "1", at: min(6), mark: "refunded", prev: "Long" },
      ],
    };
    const g = geometry(t, BOX);
    expect(g.pins.map((p) => p.mark)).toEqual(["nocount", "refunded"]);
    expect(g.ink).toBe(`30,${UP} 170,${UP}`);
    expect(g.red).toBe("");
    expect(g.zones).toEqual([]);
    expect(story(t, utc)).toEqual([
      "Betting UP since 14:01.",
      "Headline planted 14:03.",
      "It did not count.",
      "Headline planted 14:06.",
      "Refunded: the duel ended before its next decision.",
    ]);
  });

  test("no decision yet: rails and nothing else", () => {
    const g = geometry(base, BOX);
    expect(g).toMatchObject({ empty: true, ink: "", red: "", gap: null, head: null, railUp: UP, railDown: DOWN });
    expect(story(base, utc)).toEqual(["No decision yet."]);
  });

  test("earlier decisions not loaded: a dotted gap on neither rail, never an extrapolated line", () => {
    const t: TraceIn = { ...base, loadedFrom: min(3), decisions: [{ at: min(4), side: "Long" }] };
    const g = geometry(t, BOX);
    expect(g.gap).toEqual({ x1: 10, x2: 90, y: 40 });
    expect(g.ink).toBe(`90,${UP} 170,${UP}`);
    expect(g.empty).toBe(false);
    expect(story(t, utc)[0]).toBe("Earlier decisions not loaded.");
    // only the bet now is known: the gap runs to the head, which sits on that rail, and no line is drawn
    const now = geometry({ ...base, loadedFrom: min(8), current: "Short" }, BOX);
    expect(now).toMatchObject({ ink: "", gap: { x1: 10, x2: 170, y: 40 }, head: { x: 170, y: DOWN } });
  });

  test("stale: the line and the zone stop at the last good read, and nothing pulses", () => {
    const t: TraceIn = {
      ...base,
      now: min(9),
      staleAt: min(7),
      decisions: [{ at: min(1), side: "Long" }],
      pins: [{ id: "0", at: min(5), mark: "waiting", prev: "Long" }],
    };
    const g = geometry(t, BOX);
    expect(g.ink).toBe(`30,${UP} 150,${UP}`);
    expect(g.zones[0]?.x2).toBe(150);
    expect(g.head).toEqual({ x: 150, y: UP, pulse: false });
  });

  test("a finished duel has no head, and the line ends at the close", () => {
    const g = geometry({ ...base, now: min(30), running: false, decisions: [{ at: min(1), side: "Long" }] }, BOX);
    expect(g.head).toBeNull();
    expect(g.ink).toBe(`30,${UP} 210,${UP}`);
  });
});

describe("records", () => {
  const rec = {
    arm: "Cue",
    claimed: false,
    decided_by: null,
    headline: "h",
    injector: "a.testnet",
    payout: "0",
    stake: "1",
  };
  test("the arena's own outcome picks the mark; its baseline headline is a control", () => {
    expect(markOf({ outcome: "Flipped", kind: "Short" })).toBe("fooled");
    expect(markOf({ outcome: "Held", kind: "Short" })).toBe("held");
    expect(markOf({ outcome: "NoTrial", kind: "Long" })).toBe("nocount");
    expect(markOf({ outcome: "Expired", kind: "Long" })).toBe("refunded");
    expect(markOf({ outcome: "Pending", kind: "Long" })).toBe("waiting");
    expect(markOf({ outcome: "Held", kind: "Placebo" })).toBe("control");
  });
  test("pins are the records aimed at one agent, keyed by their place in get_chaos", () => {
    const at = String(BigInt(min(4)) * 1_000_000n);
    const list = [
      { ...rec, at, kind: "Short", next: null, outcome: "Pending", prev: "Long", target: "A" },
      { ...rec, at, kind: "Long", next: "Long", outcome: "Flipped", prev: "Short", target: "B" },
    ] as Parameters<typeof pinsOf>[0];
    expect(pinsOf(list, "B")).toEqual([{ id: "1", at: min(4), mark: "fooled", prev: "Short", locked: false }]);
    expect(pinsOf(list, "A", new Set([0]))[0]).toMatchObject({ id: "0", mark: "waiting", locked: true });
  });
  test("one record draws one segment before the pin and one after, with no clock", () => {
    const fooled = recordTrace({ outcome: "Flipped", kind: "Short", prev: "Long", next: "Short" });
    const g = geometry(fooled, BOX);
    expect(g.ink).toBe(`10,${UP} 100,${UP}`);
    expect(g.red).toBe(`100,${UP} 134,${UP} 134,${DOWN} 210,${DOWN}`);
    expect(story(fooled, () => null)).toEqual([
      "Betting UP.",
      "Headline planted.",
      "Next decision: betting DOWN.",
      "Fooled.",
    ]);
    const refunded = geometry(recordTrace({ outcome: "Expired", kind: "Short", prev: "Long", next: null }), BOX);
    expect(refunded).toMatchObject({ ink: `10,${UP} 210,${UP}`, red: "", head: null });
    const waiting = geometry(recordTrace({ outcome: "Pending", kind: "Short", prev: "Long", next: null }, true), BOX);
    expect(waiting.zones).toHaveLength(1);
    expect(waiting.head?.pulse).toBe(true);
    // the earlier decision was hidden: nothing is drawn before the pin but the gap
    const hidden = geometry(recordTrace({ outcome: "NoTrial", kind: "Short", prev: null, next: "Short" }), BOX);
    expect(hidden.ink).toBe("");
    expect(hidden.gap).not.toBeNull();
  });
});
