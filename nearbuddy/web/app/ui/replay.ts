// The replay: one finished duel played back as a moving Trace. This file is the pure part: the recorded duel
// (app/data/replay.json, written from the chain by scripts/replay-fixture.ts) in, and for any moment of it the two
// Traces, the price so far and what had happened by then out. Nothing is invented between records: a decision
// appears at the block time it was opened, a sealed one is a tick with no side, and a planted headline waits until
// the decision that answered it.
import data from "../data/replay.json";
import type { Chaos } from "../lib/abi/arena";
import type { Sample } from "../lib/stage";
import { bet, nsMs, price8, type Side } from "./format";
import { markOf, type PinMark, type TraceIn } from "./trace";
import { sentence, VERDICT } from "./verdict";

export type ReplayEvent = {
  event: "commit" | "intent";
  agent_pk: string;
  at_ms: number;
  side: Side | null;
  tx: string;
};
export type ReplayAgent = { pk: string; model: string; tee: boolean; bond_before: string | null };
export type ReplayRecord = {
  source: string;
  built: string;
  arena: string;
  id: string;
  /** The duel's open and close, ms. */
  from: number;
  to: number;
  a: ReplayAgent;
  b: ReplayAgent;
  outcome: {
    open_price: string;
    close_price: string;
    pnl_a: number;
    pnl_b: number;
    winner: string | null;
    slashed: string;
  };
  chaos: Chaos[];
  events: ReplayEvent[];
  price: { source: string; samples: Sample[] };
  checks: { result: "PASS" | "FAIL" | "SKIP" | "INFO"; check: string }[];
};
export type Which = "a" | "b";

/** The committed recording. Its shape is checked by app/__tests__/ui-replay.test.ts. */
export const RECORDED = data as unknown as ReplayRecord;

/** One full playback takes this long, and the finished picture is held this long before it starts again. */
export const PLAY_MS = 22_000;
export const HOLD_MS = 5_000;

const of = (rec: ReplayRecord, pk: string) => rec.events.filter((e) => e.agent_pk === pk);

/** When a planted headline got its verdict: the block time of the decision that answered it. A decision sealed
 *  before the headline landed cannot answer it, so with commit-reveal the answer is the first decision opened after
 *  the first seal that followed the pin; a fooled one is also the first to leave the bet it was planted against.
 *  The duel's close when the record holds no such decision (a refund, or a decision the history does not reach). */
export function answeredAt(rec: ReplayRecord, c: Chaos): number {
  const pin = nsMs(c.at);
  const mine = of(rec, c.target);
  const sealed = mine.find((e) => e.event === "commit" && e.at_ms > pin)?.at_ms ?? pin;
  const judged = c.outcome === "Flipped" || c.outcome === "Held" || c.outcome === "NoTrial";
  const hit = judged
    ? mine.find(
        (e) => e.event === "intent" && e.at_ms > sealed && (c.outcome !== "Flipped" || !c.prev || e.side !== c.prev),
      )
    : null;
  return hit?.at_ms ?? rec.to;
}

export type Moment = {
  at: number;
  who: Which | null;
  kind: "open" | "sealed" | "opened" | "planted" | "verdict" | "close";
  text: string;
};

/** Everything the record holds, in the order it happened: the event log beside the replay. */
export function timeline(rec: ReplayRecord): Moment[] {
  const who = (pk: string): Which => (pk === rec.a.pk ? "a" : "b");
  const name = (pk: string) => who(pk).toUpperCase();
  const out: Moment[] = [
    {
      at: rec.from,
      who: null,
      kind: "open",
      text: `Duel opened. Oracle price ${price8(rec.outcome.open_price)?.toFixed(4)}.`,
    },
  ];
  for (const e of rec.events)
    out.push(
      e.event === "commit"
        ? { at: e.at_ms, who: who(e.agent_pk), kind: "sealed", text: `${name(e.agent_pk)} sealed a decision.` }
        : {
            at: e.at_ms,
            who: who(e.agent_pk),
            kind: "opened",
            text: `${name(e.agent_pk)} opened a decision: ${e.side ? `betting ${bet(e.side)}` : "no side"}.`,
          },
    );
  for (const c of rec.chaos) {
    const control = c.kind === "Placebo";
    out.push({
      at: nsMs(c.at),
      who: who(c.target),
      kind: "planted",
      text: `${control ? "Control headline" : "Headline"} planted at ${name(c.target)}.`,
    });
    if (control || c.outcome === "Pending") continue;
    const said = sentence(c, "public", name(c.target));
    out.push({
      at: answeredAt(rec, c),
      who: who(c.target),
      kind: "verdict",
      text: `${VERDICT[c.outcome].word}.${said ? ` ${said}` : ""}`,
    });
  }
  const w = rec.outcome.winner;
  out.push({
    at: rec.to,
    who: null,
    kind: "close",
    text: `Duel closed. Oracle price ${price8(rec.outcome.close_price)?.toFixed(4)}. ${w ? `${name(w)} won.` : "A tie."}`,
  });
  const order = ["open", "sealed", "opened", "planted", "verdict", "close"];
  return out.sort((x, y) => x.at - y.at || order.indexOf(x.kind) - order.indexOf(y.kind));
}

/** One agent's Trace as it stood at `t`. */
export function traceAt(rec: ReplayRecord, which: Which, t: number): TraceIn {
  const pk = rec[which].pk;
  const mine = of(rec, pk);
  const decisions = mine.flatMap((e) => (e.event === "intent" && e.side ? [{ at: e.at_ms, side: e.side }] : []));
  const first = decisions[0];
  return {
    from: rec.from,
    to: rec.to,
    now: Math.min(Math.max(t, rec.from), rec.to),
    running: t < rec.to,
    decisions,
    // before its first opened decision the record holds only seals: that stretch is drawn as not loaded, never guessed
    loadedFrom: first ? (first.at > rec.from ? first.at : null) : rec.to,
    seals: mine.filter((e) => e.event === "commit").map((e) => e.at_ms),
    pins: rec.chaos.flatMap((c, i) => {
      const at = nsMs(c.at);
      if (c.target !== pk || at > t) return [];
      const final = markOf(c);
      const waiting = final !== "control" && t < answeredAt(rec, c);
      return [
        {
          id: String(i),
          at,
          mark: waiting ? ("waiting" as PinMark) : final,
          prev: c.prev,
          locked: waiting && mine.some((e) => e.event === "commit" && e.at_ms > at && e.at_ms <= t),
        },
      ];
    }),
  };
}

export type Frame = {
  t: number;
  a: TraceIn;
  b: TraceIn;
  /** The exchange price samples up to `t`, and the newest of them. */
  samples: Sample[];
  price: number | null;
  /** What had happened by `t`, oldest first. */
  moments: Moment[];
  /** Each agent's bet at `t` (null: nothing opened yet) and how many of its decisions were sealed by then. */
  bet: Record<Which, Side | null>;
  sealed: Record<Which, number>;
  /** The newest planted headline by `t`, with its pin's mark at `t`. */
  headline: { c: Chaos; index: number; target: Which; mark: PinMark; locked: boolean } | null;
  done: boolean;
};

/** From records to a frame: the whole picture at one moment of the recording. */
export function frameAt(rec: ReplayRecord, time: number): Frame {
  const t = Math.min(Math.max(time, rec.from), rec.to);
  const [a, b] = [traceAt(rec, "a", t), traceAt(rec, "b", t)];
  const samples = rec.price.samples.filter((s) => s.t <= t);
  const side = (tr: TraceIn) => tr.decisions.filter((d) => d.at <= t).at(-1)?.side ?? null;
  const index = rec.chaos.findLastIndex((c) => nsMs(c.at) <= t && c.kind !== "Placebo");
  const c = rec.chaos[index];
  const target: Which = c?.target === rec.a.pk ? "a" : "b";
  const pin = c ? (target === "a" ? a : b).pins.find((p) => p.id === String(index)) : undefined;
  return {
    t,
    a,
    b,
    samples,
    price: samples.at(-1)?.p ?? null,
    moments: timeline(rec).filter((m) => m.at <= t),
    bet: { a: side(a), b: side(b) },
    sealed: { a: (a.seals ?? []).filter((s) => s <= t).length, b: (b.seals ?? []).filter((s) => s <= t).length },
    headline: c && pin ? { c, index, target, mark: pin.mark, locked: !!pin.locked } : null,
    done: t >= rec.to,
  };
}

/** The checks of `bun run verify-duel` on the recorded duel, counted: INFO lines are notes, not checks. */
export function checkCounts(rec: ReplayRecord) {
  const n = (r: string, start = "") => rec.checks.filter((c) => c.result === r && c.check.startsWith(start)).length;
  return {
    pass: n("PASS"),
    fail: n("FAIL"),
    skip: n("SKIP"),
    total: n("PASS") + n("FAIL") + n("SKIP"),
    // the lines about a decision: its signature, its timing, its seal, and the enclave's own signature over it
    signed: { pass: n("PASS", "intent "), fail: n("FAIL", "intent "), skip: n("SKIP", "intent ") },
  };
}
