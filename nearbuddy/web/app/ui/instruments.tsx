// The small instruments every panel of the control room is built from: a panel with its label and status tag, a
// readout (value and unit), a bar strip (a count out of a total), a sparkline (a recorded series) and an interval bar
// (a rate with its uncertainty). No hooks and no measuring: each chart is an SVG or a flex row that scales with its
// panel. Every chart carries its numbers as text beside it and as its accessible name; none animates.
import type { ReactNode } from "react";
import { wilson } from "../lib/fool";

export type TagKind = "idle" | "ok" | "live" | "alert" | "ink";

/** A status word: uppercase, outlined, coloured by what it means (ok: checked; live: running or waiting; alert: did
 *  not hold or was refused). */
export const Tag = ({ kind = "idle", children }: { kind?: TagKind; children: ReactNode }) => (
  <span className={`tag ${kind}`}>{children}</span>
);

/** One instrument: a label, an optional status tag, and its content. `wide` spans columns on desktop. */
export function Panel({
  label,
  tag,
  wide,
  className,
  children,
}: {
  label: string;
  tag?: ReactNode;
  wide?: 2 | 3;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel${wide ? ` w${wide}` : ""}${className ? ` ${className}` : ""}`} aria-label={label}>
      <div className="panel-head">
        <h3 className="t-label">{label}</h3>
        {tag}
      </div>
      {children}
    </section>
  );
}

/** A value in the machine's voice with its unit. `small` for a value that is a name or a sentence, not a number. */
export const Readout = ({ value, unit, small }: { value: ReactNode; unit?: ReactNode; small?: boolean }) => (
  <p className="readout">
    <span className={`v${small ? " sm" : ""}`}>{value}</span>
    {unit ? <span className="u">{unit}</span> : null}
  </p>
);

/** How many of `cells` are lit for `n` of `of`: proportional, but never empty when n > 0 and never full when n < of,
 *  so a strip cannot round a count to "none" or "all". */
export function stripCells(n: number, of: number, cells: number): number {
  if (of <= 0 || n <= 0 || cells <= 0) return 0;
  if (n >= of) return cells;
  return Math.min(cells - 1, Math.max(1, Math.round((n / of) * cells)));
}

/** Fill width % for a Research meter: proportional, never empty when n > 0 and never full when n < of. */
export function meterPct(n: number, of: number): number {
  if (of <= 0 || n <= 0) return 0;
  if (n >= of) return 100;
  return Math.min(99.5, Math.max(0.5, (n / of) * 100));
}

/** A count out of a total as a row of cells. With a total of `cells` or fewer, one cell is one item. */
export function Strip({
  n,
  of,
  cells = 24,
  kind = "live",
  label,
}: {
  n: number;
  of: number;
  cells?: number;
  kind?: "live" | "alert" | "ink" | "ok";
  /** The accessible name, with its counts: "Fooled 676 of 704". */
  label: string;
}) {
  const total = of > 0 && of <= cells ? of : cells;
  const lit = stripCells(n, of, total);
  return (
    <span className={`strip ${kind}`} role="img" aria-label={label}>
      {Array.from({ length: total }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
        <i key={i} className={i < lit ? "on" : undefined} />
      ))}
    </span>
  );
}

/** A sharp rectangular proportion bar for Research meters. `alert` = fooled/rose; `live`/`ok` = held/stable lime or blue. */
export function MeterBar({
  n,
  of,
  kind = "alert",
  label,
}: {
  n: number;
  of: number;
  kind?: "live" | "alert" | "ink" | "ok";
  label: string;
}) {
  const pct = meterPct(n, of);
  return (
    <span className={`meter-bar ${kind}`} role="img" aria-label={label}>
      <span className="meter-bar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Polyline points for `values` in a 100 x `h` box, the lowest value on the bottom edge; "" with fewer than 2. */
export function sparkPoints(values: number[], h: number): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  return values
    .map(
      (v, i) =>
        `${Math.round((i / (values.length - 1)) * 1000) / 10},${Math.round((1 - (v - lo) / span) * (h - 2) * 10) / 10 + 1}`,
    )
    .join(" ");
}

/** A recorded series as a line. `of` is how many points the full series has, so a series still being drawn (the
 *  replay) fills only its share of the width. */
export function Sparkline({ values, of, label }: { values: number[]; of?: number; label: string }) {
  const H = 28;
  const share = of && of > 1 ? Math.min(1, (values.length - 1) / (of - 1)) : 1;
  return (
    <svg className="spark" viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <line className="base" x1="0" x2="100" y1={H - 0.5} y2={H - 0.5} />
      <g transform={`scale(${share} 1)`}>
        <polyline points={sparkPoints(values, H)} />
      </g>
    </svg>
  );
}

/** A rate with its uncertainty on a 0 to 100% axis: the bar is the 95% Wilson interval, the tick the observed rate,
 *  the dashed line the no-attack noise. The caller draws it only with 10 or more counted attacks. */
export function Interval({ fooled, n, noise = 0.11 }: { fooled: number; n: number; noise?: number }) {
  const [lo, hi] = wilson(fooled, n);
  const pct = (r: number) => Math.round(r * 100);
  const at = n ? (fooled / n) * 100 : 0;
  return (
    <svg
      className="ival"
      viewBox="0 0 100 14"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Fooled ${fooled} of ${n}: likely between ${pct(lo)}% and ${pct(hi)}%.`}
    >
      <line className="track" x1="0" x2="100" y1="7" y2="7" />
      <line className="noise" x1={noise * 100} x2={noise * 100} y1="0" y2="14" />
      <line className="range" x1={lo * 100} x2={hi * 100} y1="7" y2="7" />
      <line className="at" x1={at} x2={at} y1="1" y2="13" />
    </svg>
  );
}
