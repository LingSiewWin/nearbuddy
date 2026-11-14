// The Trace: one agent's decisions as a step line on two rails (upper: betting UP, lower: betting DOWN), time left
// to right, each planted headline a pin. This file is the pure part: decisions and planted-headline records in,
// geometry and the text alternative out. Nothing is extrapolated: a stretch the page has no decisions for is a gap.
import type { Chaos } from "../lib/abi/arena";
import { bet, nsMs, type Side } from "./format";

export type Decision = { at: number; side: Side };
/** How one planted headline ended, as its pin shows it. `nocount` and `refunded` share a shape (dashed ring). */
export type PinMark = "waiting" | "held" | "fooled" | "nocount" | "refunded" | "control";
export type PinIn = {
  id: string;
  /** When it landed, ms. */
  at: number;
  mark: PinMark;
  /** The bet it was planted against, when the record holds it. */
  prev: Side | null;
  /** Waiting, and a decision made after the pin is already in: the zone gets a solid right edge. */
  locked?: boolean;
};

export type TraceIn = {
  /** The duel's open and close, ms. */
  from: number;
  to: number;
  /** The clock, ms. */
  now: number;
  /** Stale: the time of the last good read. The line and the waiting zone stop there, and nothing pulses. */
  staleAt?: number | null;
  /** False once the duel is closed or finished: no head dot. */
  running: boolean;
  /** The decisions the page has, in any order. */
  decisions: Decision[];
  /** The decisions are complete from this time on; null: from the duel's opening. */
  loadedFrom: number | null;
  /** The bet now, when it is known without the time it was made. */
  current?: Side | null;
  pins: PinIn[];
  /** Times a sealed decision went in (commit-reveal): each is a tick between the rails, since its side is hidden. */
  seals?: number[];
};
export type Box = { width: number; height: number; padL: number; padR: number };

export type TraceGeo = {
  railUp: number;
  railDown: number;
  x0: number;
  x1: number;
  /** "earlier decisions not loaded": a dotted line on neither rail. */
  gap: { x1: number; x2: number; y: number } | null;
  /** The line in ink, and from the first fooled pin onward in red; SVG polyline points, "" when there is none. */
  ink: string;
  red: string;
  pins: { id: string; x: number; y: number; mark: PinMark }[];
  /** Waiting: the hatched stretch from a pin to the head. */
  zones: { id: string; x1: number; x2: number; y: number; h: number; locked: boolean }[];
  head: { x: number; y: number; pulse: boolean } | null;
  /** Sealed decisions up to the head, as x positions on the line between the rails. */
  seals: { x: number; y: number }[];
  /** Rails only: no decision yet, and none missing. */
  empty: boolean;
};

type Pt = [number, number];
const round = (n: number) => Math.round(n * 10) / 10;
const pts = (list: Pt[]) => list.map(([x, y]) => `${round(x)},${round(y)}`).join(" ");

/** Where the line ends: now, never past the close, and at the last good read while stale. */
export const headTime = (t: Pick<TraceIn, "to" | "now" | "staleAt">) => Math.min(t.to, t.staleAt ?? t.now);

/** The decisions that count for the line: oldest first, none after the head, none before the opening. */
const usable = (t: TraceIn): Decision[] => {
  const head = headTime(t);
  return [...t.decisions]
    .filter((d) => d.at <= head)
    .sort((a, b) => a.at - b.at)
    .map((d) => ({ at: Math.max(d.at, t.from), side: d.side }));
};

export function geometry(t: TraceIn, box: Box): TraceGeo {
  const railUp = Math.round(box.height * 0.25);
  const railDown = Math.round(box.height * 0.75);
  const mid = (railUp + railDown) / 2;
  const x0 = box.padL;
  const x1 = box.width - box.padR;
  const span = Math.max(1, t.to - t.from);
  const x = (ms: number) => x0 + Math.min(1, Math.max(0, (ms - t.from) / span)) * (x1 - x0);
  const y = (s: Side) => (s === "Long" ? railUp : railDown);
  const head = headTime(t);
  const ds = usable(t);
  const first = ds[0];
  const last = ds[ds.length - 1];
  const missing = t.loadedFrom !== null && t.loadedFrom > t.from;

  // the step line: along a rail until the next decision, then straight across to the other
  const line: Pt[] = [];
  if (first && last) {
    line.push([x(first.at), y(first.side)]);
    for (let i = 1; i < ds.length; i++) {
      const [p, d] = [ds[i - 1] as Decision, ds[i] as Decision];
      line.push([x(d.at), y(p.side)]);
      if (d.side !== p.side) line.push([x(d.at), y(d.side)]);
    }
    line.push([x(head), y(last.side)]);
  }
  const sideAt = (ms: number): Side | null => ds.filter((d) => d.at <= ms).pop()?.side ?? null;

  // red from the first fooled pin onward: the lie's ink has entered the record
  const fooledAt = Math.min(...t.pins.filter((p) => p.mark === "fooled").map((p) => p.at));
  let ink = line;
  let red: Pt[] = [];
  if (Number.isFinite(fooledAt) && line.length) {
    const cut = x(fooledAt);
    const i = line.findIndex(([px]) => px > cut);
    if (i === 0) [ink, red] = [[], line];
    else if (i > 0) {
      const at: Pt = [cut, (line[i - 1] as Pt)[1]];
      [ink, red] = [
        [...line.slice(0, i), at],
        [at, ...line.slice(i)],
      ];
    }
  }

  const pinY = (p: PinIn) => {
    const s = p.prev ?? sideAt(p.at);
    return s ? y(s) : mid;
  };
  const tip = last?.side ?? (ds.length ? null : (t.current ?? null));
  return {
    railUp,
    railDown,
    x0,
    x1,
    gap: missing ? { x1: x0, x2: first ? x(first.at) : x(head), y: mid } : null,
    ink: ink.length > 1 ? pts(ink) : "",
    red: red.length > 1 ? pts(red) : "",
    pins: t.pins.map((p) => ({ id: p.id, x: x(p.at), y: pinY(p), mark: p.mark })),
    zones: t.pins
      .filter((p) => p.mark === "waiting")
      .map((p) => ({
        id: p.id,
        x1: x(p.at),
        x2: Math.max(x(p.at), x(head)),
        y: pinY(p) - 8,
        h: 16,
        locked: !!p.locked,
      })),
    head: t.running && tip ? { x: x(head), y: y(tip), pulse: (t.staleAt ?? null) === null && head < t.to } : null,
    seals: (t.seals ?? []).filter((s) => s >= t.from && s <= head).map((s) => ({ x: x(s), y: mid })),
    empty: !first && !missing && !t.current,
  };
}

/** What happened, one sentence at a time: the Trace's text alternative, and the visible list under it. `time` turns
 *  ms into "14:06", or answers null for a Trace drawn from one record, which has no clock. */
export function story(t: TraceIn, time: (ms: number) => string | null): string[] {
  const out: string[] = [];
  const ds = usable(t);
  const when = (ms: number, lead: string) => {
    const s = time(ms);
    return s ? `${lead} ${s}` : lead;
  };
  const loaded = t.loadedFrom;
  if (loaded !== null && loaded > t.from) {
    // sealed decisions before the first opened one are known to exist: say so, instead of "not loaded"
    out.push(t.seals?.some((s) => s < loaded) ? "First decisions sealed." : "Earlier decisions not loaded.");
  }
  type Ev = { at: number; d?: Decision; p?: PinIn };
  const evs = [...ds.map((d): Ev => ({ at: d.at, d })), ...t.pins.map((p): Ev => ({ at: p.at, p }))].sort(
    (a, b) => a.at - b.at || (a.d ? -1 : 1),
  );
  let side: Side | null = null;
  let open: PinIn[] = []; // pins planted and not answered yet
  // a fooled pin is answered by the first later decision that leaves the bet it was planted against (a decision
  // sealed before the pin and opened after it does not answer it); a held one by the first later decision
  const answers = (p: PinIn, d: Decision) =>
    p.mark === "held" || (p.mark === "fooled" && (!p.prev || d.side !== p.prev));
  for (const e of evs) {
    if (e.p) {
      const p = e.p;
      if (p.mark === "control") out.push(`${when(p.at, "Control headline planted")}.`);
      else {
        out.push(`${when(p.at, "Headline planted")}.`);
        if (p.mark === "nocount") out.push("It did not count.");
        else if (p.mark === "refunded") out.push("Refunded: the duel ended before its next decision.");
        else open.push(p);
      }
      continue;
    }
    const d = e.d as Decision;
    const judged = open.filter((p) => answers(p, d));
    if (side === null) {
      const t0 = time(d.at);
      out.push(t0 ? `Betting ${bet(d.side)} since ${t0}.` : `Betting ${bet(d.side)}.`);
    } else {
      const lead = open.length ? "Next decision" : "Decision";
      const what = d.side === side ? `still betting ${bet(d.side)}` : `betting ${bet(d.side)}`;
      out.push(`${when(d.at, lead)}: ${what}.`);
    }
    for (const p of judged) out.push(p.mark === "fooled" ? "Fooled." : "Held.");
    open = open.filter((p) => !judged.includes(p));
    side = d.side;
  }
  // a verdict whose deciding decision the page does not hold still gets its word
  for (const p of open)
    out.push(p.mark === "fooled" ? "Fooled." : p.mark === "held" ? "Held." : "Waiting for its next decision.");
  if (!ds.length)
    out.push(t.current ? `Betting ${bet(t.current)} now.` : out.length ? "No decision loaded." : "No decision yet.");
  return out;
}

/** The SVG's text alternative: "claude-x: betting UP since 14:02. Headline planted 14:06. …". */
export const altText = (name: string, sentences: string[]) => {
  const s = sentences.join(" ");
  return `${name}: ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
};

const MARK: Record<Chaos["outcome"], PinMark> = {
  Pending: "waiting",
  Flipped: "fooled",
  Held: "held",
  NoTrial: "nocount",
  Expired: "refunded",
};
/** The pin's mark for one planted-headline record: the arena's own baseline headline is a control, not an attack. */
export const markOf = (c: Pick<Chaos, "outcome" | "kind">): PinMark =>
  c.kind === "Placebo" ? "control" : MARK[c.outcome];

/** A duel's records as pins on one agent's Trace. `locked`: indexes whose next decision is already in. */
export const pinsOf = (records: Chaos[], target: string, locked: ReadonlySet<number> = new Set()): PinIn[] =>
  records.flatMap((c, i) =>
    c.target === target
      ? [
          {
            id: String(i),
            at: nsMs(c.at),
            mark: markOf(c),
            prev: c.prev,
            locked: c.outcome === "Pending" && locked.has(i),
          },
        ]
      : [],
  );

/** The two-segment Trace of one headline, from its own record alone: the bet before, the pin, the bet after. It has
 *  no clock (times are positions 0 to 100), so it can be drawn for any duel however old. `now` moves the waiting zone:
 *  pass 0 to 100, or leave it for a fixed picture. */
export function recordTrace(c: Pick<Chaos, "outcome" | "kind" | "prev" | "next">, live = false): TraceIn {
  const PIN = 45;
  const DECIDED = 62;
  const mark = markOf(c);
  const decisions: Decision[] = [];
  if (c.prev) decisions.push({ at: 0, side: c.prev });
  // a refunded or uncounted headline changed nothing the record can show: the line stays where it was
  const after = mark === "fooled" || mark === "held" ? c.next : null;
  if (after) decisions.push({ at: DECIDED, side: after });
  const waiting = mark === "waiting";
  return {
    from: 0,
    to: 100,
    now: waiting ? 72 : 100,
    running: waiting && live,
    decisions,
    loadedFrom: c.prev ? null : after ? DECIDED : 100,
    pins: [{ id: "0", at: PIN, mark, prev: c.prev }],
  };
}
