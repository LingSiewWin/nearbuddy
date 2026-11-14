// The replay timeline builder: the committed recording (app/data/replay.json, written from the chain by
// scripts/replay-fixture.ts) turned into frames. A frame may only show what the record holds at that moment.
import { expect, test } from "bun:test";
import { nsMs } from "../ui/format";
import { answeredAt, checkCounts, frameAt, RECORDED as rec, timeline, traceAt } from "../ui/replay";
import { geometry, story } from "../ui/trace";

const box = { width: 400, height: 96, padL: 36, padR: 10 };
const utc = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const [held, fooled] = rec.chaos;
if (!held || !fooled) throw new Error("the recording needs its two headlines");

test("the recording is a finished duel with two planted headlines: one held, one fooled", () => {
  expect(rec.id).toBe("575");
  expect(rec.to).toBeGreaterThan(rec.from);
  expect(rec.chaos.map((c) => [c.target === rec.a.pk ? "a" : "b", c.outcome])).toEqual([
    ["a", "Held"],
    ["b", "Flipped"],
  ]);
  expect(rec.events.every((e) => e.at_ms >= rec.from && e.at_ms <= rec.to)).toBe(true);
  expect(rec.events.every((e) => (e.event === "intent") === (e.side === "Long" || e.side === "Short"))).toBe(true);
  expect(rec.price.samples.length).toBeGreaterThan(2);
  expect(rec.price.samples.every((s) => s.p > 0)).toBe(true);
  expect(checkCounts(rec)).toEqual({ pass: 30, fail: 0, skip: 2, total: 32, signed: { pass: 14, fail: 0, skip: 2 } });
});

test("a headline is answered by the first decision sealed after it, not by one sealed before and opened after", () => {
  const pin = nsMs(fooled.at);
  const opened = rec.events.filter((e) => e.agent_pk === rec.b.pk && e.event === "intent");
  // B opened an UP decision after the pin that it had sealed before it: that one does not answer the headline
  expect(opened[0]?.at_ms).toBeGreaterThan(pin);
  expect(opened[0]?.side).toBe("Long");
  expect(answeredAt(rec, fooled)).toBe(opened[1]?.at_ms as number);
  expect(answeredAt(rec, { ...fooled, outcome: "Expired" })).toBe(rec.to); // a refund is settled at the close
});

test("the timeline lists every record in order, from the open to the close", () => {
  const tl = timeline(rec);
  expect(tl[0]?.kind).toBe("open");
  expect(tl.at(-1)?.kind).toBe("close");
  expect(tl.length).toBe(rec.events.length + 2 + 2 * rec.chaos.length); // open, close; planted and verdict each
  expect(tl.every((m, i) => i === 0 || m.at >= (tl[i - 1]?.at ?? 0))).toBe(true);
  expect(tl.filter((m) => m.kind === "verdict").map((m) => m.text)).toEqual([
    "HELD. A was betting UP. After this headline it still bet UP.",
    "FOOLED. B was betting UP. After this headline it bet DOWN.",
  ]);
  expect(tl.at(-1)?.text).toBe("Duel closed. Oracle price 3.3178. B won.");
});

test("frames: nothing before its time", () => {
  const pin = nsMs(fooled.at);
  const start = frameAt(rec, rec.from);
  expect(start.headline).toBeNull();
  expect(start.bet).toEqual({ a: null, b: null });
  expect(start.a.pins).toEqual([]);
  expect(start.b.pins).toEqual([]);
  expect(start.moments.map((m) => m.kind)).toEqual(["open"]);
  expect(geometry(start.b, box).ink + geometry(start.b, box).red).toBe(""); // no line before a decision is opened

  const waiting = frameAt(rec, pin + 1000);
  expect(waiting.headline).toMatchObject({ mark: "waiting", locked: false, target: "b" });
  expect(waiting.a.pins.map((p) => p.mark)).toEqual(["waiting"]);
  expect(geometry(waiting.b, box).zones.length).toBe(1);

  const locked = frameAt(rec, answeredAt(rec, fooled) - 1);
  expect(locked.headline).toMatchObject({ mark: "waiting", locked: true });
  expect(locked.bet).toEqual({ a: "Long", b: "Long" });
  expect(geometry(locked.b, box).red).toBe(""); // not red until the verdict

  const end = frameAt(rec, rec.to + 60_000); // clamped to the close
  expect(end.done).toBe(true);
  expect(end.headline?.mark).toBe("fooled");
  expect(end.a.pins.map((p) => p.mark)).toEqual(["held"]);
  expect(end.bet).toEqual({ a: "Long", b: "Short" });
  expect(end.samples.length).toBe(rec.price.samples.filter((s) => s.t <= rec.to).length);
  expect(end.moments.length).toBe(timeline(rec).length);
  const [ga, gb] = [geometry(end.a, box), geometry(end.b, box)];
  expect(gb.red).not.toBe("");
  expect(ga.red).toBe(""); // the held line stays in ink
  expect(gb.zones).toEqual([]);
  expect(gb.head).toBeNull();
  expect(gb.seals.length).toBe(2);
});

test("the waiting zone and the line grow with the playhead", () => {
  const pin = nsMs(fooled.at);
  const w = (t: number) => {
    const z = geometry(traceAt(rec, "b", t), box).zones[0];
    return z ? z.x2 - z.x1 : 0;
  };
  expect(w(pin + 20_000)).toBeGreaterThan(w(pin + 5_000));
  // before B opens a decision the record holds only seals: the dotted line is what grows
  const gap = (t: number) => geometry(traceAt(rec, "b", t), box).gap?.x2 ?? 0;
  expect(gap(rec.from + 10_000)).toBeGreaterThan(box.padL);
  expect(gap(rec.from + 10_000)).toBeLessThan(gap(rec.from + 100_000));
  const head = (t: number) => geometry(traceAt(rec, "b", t), box).head?.x ?? 0;
  expect(head(rec.from + 200_000)).toBeLessThan(head(rec.from + 400_000));
});

test("the finished frame reads as the story of the attack", () => {
  expect(story(frameAt(rec, rec.to).b, utc).join(" ")).toBe(
    "First decisions sealed. Headline planted 11:08. Betting UP since 11:09. Next decision 11:16: betting DOWN. Fooled.",
  );
});
