"use client";
// The Trace as SVG (geometry in ui/trace.ts): `full` on the duel page, `mini` on the home page and the result page,
// `marks` as a row of verdict marks. Every Trace is role="img" with a generated text alternative; the same sentences
// are shown as text by <WhatHappened>, so the picture is never the only source.
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import type { Sample } from "../lib/stage";
import { hm } from "./format";
import { altText, type Box, geometry, headTime, type PinMark, story, type TraceGeo, type TraceIn } from "./trace";

/** The element's width in CSS px (328 before it is measured: a 360px phone less its gutters). */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(328);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(120, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** True when the visitor asked for reduced motion: no pulse, and the waiting zone grows in 5 s steps. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduced;
}

const FULL = { height: 72, padL: 36, padR: 10 };
const MINI = { height: 48, padL: 6, padR: 10 };
// the central object of a control room: the same Trace, drawn large
const STAGE = { height: 112, padL: 36, padR: 10 };
const BOX = { full: FULL, mini: MINI, stage: STAGE };
/** The left and right padding of a full Trace, shared by the price line and the time axis above and below it. */
export const TRACE_PAD = { left: FULL.padL, right: FULL.padR };

/** One planted headline on a Trace: filled circle (waiting), ring (held), filled diamond (fooled), dashed ring (did
 *  not count, refunded), small square (control). */
export function Pin({ x, y, mark, selected }: { x: number; y: number; mark: PinMark; selected?: boolean }) {
  const r = selected ? 6.5 : 5;
  if (mark === "fooled")
    return (
      <path className="pin fooled" d={`M${x} ${y - r - 1}L${x + r + 1} ${y}L${x} ${y + r + 1}L${x - r - 1} ${y}Z`} />
    );
  if (mark === "control") return <rect className="pin control" x={x - 3} y={y - 3} width={6} height={6} />;
  return <circle className={`pin ${mark}`} cx={x} cy={y} r={r} />;
}

/** The hatched stretch from a pin to now; `locked` (its next decision is in) adds a solid right edge. */
export function PendingZone({ z, hatch }: { z: TraceGeo["zones"][number]; hatch: string }) {
  return (
    <g>
      <rect x={z.x1} y={z.y} width={Math.max(0, z.x2 - z.x1)} height={z.h} fill={`url(#${hatch})`} />
      {z.locked ? <line className="zone-edge" x1={z.x2} x2={z.x2} y1={z.y} y2={z.y + z.h} /> : null}
    </g>
  );
}

const WORD: Record<PinMark, string> = {
  waiting: "waiting",
  held: "HELD",
  fooled: "FOOLED",
  nocount: "DID NOT COUNT",
  refunded: "REFUNDED",
  control: "control",
};

/** One agent's decisions over a duel. `input` null draws the loading state: rails without a line. */
export function Trace({
  variant,
  name,
  input,
  time = hm,
  stale,
  onPin,
  selected,
  titles,
}: {
  variant: "full" | "mini" | "stage";
  /** Who the line belongs to, for the text alternative ("A {model}"). */
  name: string;
  input: TraceIn | null;
  /** ms to "14:06"; a Trace drawn from one record passes `() => null`. */
  time?: (ms: number) => string | null;
  stale?: boolean;
  /** Full variant: a pin was pressed (the page scrolls to that headline's row). */
  onPin?: (id: string) => void;
  selected?: string | null;
  /** Pin id to its headline, shown as the pin's tooltip. */
  titles?: Record<string, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const reduced = useReducedMotion();
  const hatch = useId();
  const box: Box = { width, ...BOX[variant] };
  // reduced motion: the zone still grows, because it is information, in 5 s steps
  const stepped = input && reduced ? { ...input, now: Math.floor(input.now / 5000) * 5000 || input.now } : input;
  const g = geometry(
    stepped ?? { from: 0, to: 1, now: 0, running: false, decisions: [], loadedFrom: null, pins: [] },
    box,
  );
  const alt = input ? altText(name, story(input, time)) : `${name}: loading.`;
  return (
    <div ref={ref} className={`trace ${variant}${stale ? " is-stale" : ""}`}>
      <svg role="img" aria-label={alt} width={width} height={box.height} viewBox={`0 0 ${width} ${box.height}`}>
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line className="hatch" x1="0" y1="0" x2="0" y2="6" />
          </pattern>
        </defs>
        <line className="rail" x1={g.x0} x2={g.x1} y1={g.railUp} y2={g.railUp} />
        <line className="rail" x1={g.x0} x2={g.x1} y1={g.railDown} y2={g.railDown} />
        {variant !== "mini" ? (
          <>
            <text className="rail-label" x={0} y={g.railUp + 4}>
              UP
            </text>
            <text className="rail-label" x={0} y={g.railDown + 4}>
              DN
            </text>
          </>
        ) : null}
        {g.gap ? <line className="gap" x1={g.gap.x1} x2={g.gap.x2} y1={g.gap.y} y2={g.gap.y} /> : null}
        {g.seals.map((s) => (
          <rect key={s.x} className="seal" x={s.x - 3} y={s.y - 3} width={6} height={6}>
            <title>sealed decision</title>
          </rect>
        ))}
        {g.zones.map((z) => (
          <PendingZone key={z.id} z={z} hatch={hatch} />
        ))}
        {g.ink ? <polyline className="line" points={g.ink} /> : null}
        {g.red ? <polyline className="line red" points={g.red} /> : null}
        {g.pins.map((p) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the headline rows below are the keyboard path
          <g key={p.id} className={onPin ? "pin-hit" : undefined} onClick={onPin ? () => onPin(p.id) : undefined}>
            <title>{titles?.[p.id] ? `“${titles[p.id]}” · ${WORD[p.mark]}` : WORD[p.mark]}</title>
            {onPin ? <circle cx={p.x} cy={p.y} r={22} fill="transparent" /> : null}
            <Pin x={p.x} y={p.y} mark={p.mark} selected={selected === p.id} />
          </g>
        ))}
        {g.head ? (
          <>
            {g.head.pulse && !stale && !reduced ? (
              <circle className="head-ring" cx={g.head.x} cy={g.head.y} r={3} />
            ) : null}
            <circle className="head" cx={g.head.x} cy={g.head.y} r={3} />
          </>
        ) : null}
      </svg>
      {input && g.empty ? <p className="trace-note">no decision yet</p> : null}
      {g.gap && !input?.seals?.length ? <p className="trace-note">earlier decisions not loaded</p> : null}
    </div>
  );
}

/** The time axis under the full Traces: the open time, the middle, and "now" (or the close). */
export function TimeAxis({ input, time = hm }: { input: TraceIn; time?: (ms: number) => string | null }) {
  const head = headTime(input);
  return (
    <div
      className="trace-axis"
      style={{ paddingLeft: TRACE_PAD.left, paddingRight: TRACE_PAD.right }}
      aria-hidden="true"
    >
      <span>{time(input.from)}</span>
      <span>{time((input.from + input.to) / 2)}</span>
      <span>{input.running && head < input.to && time === hm ? "now" : time(input.to)}</span>
    </div>
  );
}

/** NEAR/USD over the duel on the Traces' x scale: 1px, no fill, no colour for direction. It ends at its last sample,
 *  so a stale price shows as a line that stopped. With no samples only the baseline is drawn. */
export function PriceLine({
  samples,
  from,
  to,
  stale,
}: {
  samples: Sample[];
  from: number;
  to: number;
  stale?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const H = 40;
  const [x0, x1] = [TRACE_PAD.left, width - TRACE_PAD.right];
  const inside = samples.filter((s) => s.t >= from && s.t <= to);
  const lo = Math.min(...inside.map((s) => s.p));
  const hi = Math.max(...inside.map((s) => s.p));
  const span = hi - lo || 1;
  const points = inside
    .map((s) => {
      const x = x0 + ((s.t - from) / Math.max(1, to - from)) * (x1 - x0);
      const y = hi === lo ? H / 2 : 4 + (1 - (s.p - lo) / span) * (H - 8);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(" ");
  const label = inside.length
    ? `NEAR/USD price over the duel, from ${lo.toFixed(4)} to ${hi.toFixed(4)}${stale ? ", not updating" : ""}.`
    : "NEAR/USD price: no samples loaded.";
  return (
    <div ref={ref} className={`trace price${stale ? " is-stale" : ""}`}>
      <svg role="img" aria-label={label} width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
        <text className="rail-label" x={0} y={H / 2 + 4}>
          price
        </text>
        {inside.length > 1 ? <polyline className="price-line" points={points} /> : null}
      </svg>
    </div>
  );
}

/** The Trace as a row of verdict marks, oldest first: fooled diamond, held ring. */
export function TraceMarks({ marks, label }: { marks: ("fooled" | "held")[]; label: string }) {
  const STEP = 16;
  return (
    <svg className="trace-marks" role="img" aria-label={label} width={marks.length * STEP} height={16}>
      {marks.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: marks are positional
        <Pin key={i} x={i * STEP + 8} y={8} mark={m} />
      ))}
    </svg>
  );
}

/** The Traces' sentences as visible text. */
export function WhatHappened({
  items,
}: {
  items: { name: string; input: TraceIn; time?: (ms: number) => string | null }[];
}) {
  return (
    <section className="what-happened">
      <h3 className="t-label">What happened</h3>
      <dl>
        {items.map((it) => (
          <div key={it.name}>
            <dt className="mono">{it.name}</dt>
            <dd>{story(it.input, it.time ?? hm).join(" ")}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
