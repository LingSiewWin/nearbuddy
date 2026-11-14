"use client";
// The two plain charts of the design, as inline SVG: LabChart (horizontal bars on a 0 to 100% axis, for the lab
// findings) and IntervalBar (a rate with its uncertainty, for the scoreboard). Bars are ink, never red; no animation.
import { useId, useRef } from "react";
import { wilson } from "../lib/fool";
import { useWidth } from "./trace-view";

/** One bar: `rate` from 0 to 1, `text` printed at its end ("676 of 704 (96%)"). `approx`: the source figure is
 *  approximate, so the bar ends in a hatched cap 4 points wide on each side instead of a hard edge. */
export type Bar = { label: string; rate: number; text: string; approx?: boolean };

export function LabChart({
  bars,
  noise,
}: {
  bars: Bar[] /** A dashed line at this rate: the no-attack noise. */;
  noise?: number;
  /** Kept for stable call sites; the per-chart table moved to the Research method drawer. */
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const hatch = useId();
  const ROW = 52;
  const h = bars.length * ROW + 18;
  const x = (r: number) => Math.round(Math.min(1, Math.max(0, r)) * (width - 2) * 10) / 10 + 1;
  return (
    <div ref={ref} className="chart">
      <svg
        role="img"
        aria-label={bars.map((b) => `${b.label}: ${b.text}`).join(". ")}
        width={width}
        height={h}
        viewBox={`0 0 ${width} ${h}`}
      >
        <defs>
          <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line className="chart-hatch" x1="0" y1="0" x2="0" y2="4" />
          </pattern>
        </defs>
        {bars.map((b, i) => {
          const y = i * ROW;
          const cap = b.approx ? 0.04 : 0;
          return (
            <g key={b.label}>
              <text className="chart-label" x={1} y={y + 14}>
                {b.label}
              </text>
              <text className="chart-value" x={width - 1} y={y + 14} textAnchor="end">
                {b.text}
              </text>
              <line className="chart-track" x1={1} x2={width - 1} y1={y + 30} y2={y + 30} />
              <rect className="chart-bar" x={1} y={y + 24} width={Math.max(0, x(b.rate - cap) - 1)} height={12} />
              {b.approx ? (
                <rect
                  x={x(b.rate - cap)}
                  y={y + 24}
                  width={x(b.rate + cap) - x(b.rate - cap)}
                  height={12}
                  fill={`url(#${hatch})`}
                />
              ) : null}
            </g>
          );
        })}
        {noise ? <line className="chart-noise" x1={x(noise)} x2={x(noise)} y1={18} y2={bars.length * ROW - 8} /> : null}
        <text className="chart-axis" x={1} y={h - 2}>
          0%
        </text>
        <text className="chart-axis" x={width - 1} y={h - 2} textAnchor="end">
          100%
        </text>
      </svg>
    </div>
  );
}

/** A rate with its uncertainty on a 0 to 100% axis: the bar is the 95% interval, the dot the observed rate, the tick
 *  the noise line. The caller draws it only with 10 or more counted attacks. */
export function IntervalBar({ fooled, n, noise = 0.11 }: { fooled: number; n: number; noise?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [lo, hi] = wilson(fooled, n);
  const x = (r: number) => Math.round(r * (width - 12) * 10) / 10 + 6;
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  return (
    <div ref={ref} className="chart">
      <svg
        role="img"
        aria-label={`Fooled ${fooled} of ${n}: likely between ${pct(lo)} and ${pct(hi)}.`}
        width={width}
        height={20}
        viewBox={`0 0 ${width} 20`}
      >
        <line className="chart-track" x1={6} x2={width - 6} y1={10} y2={10} />
        <line className="chart-noise-tick" x1={x(noise)} x2={x(noise)} y1={2} y2={18} />
        <line className="chart-interval" x1={x(lo)} x2={x(hi)} y1={10} y2={10} />
        <line className="chart-interval" x1={x(lo)} x2={x(lo)} y1={5} y2={15} />
        <line className="chart-interval" x1={x(hi)} x2={x(hi)} y1={5} y2={15} />
        <rect className="chart-dot" x={x(n ? fooled / n : 0) - 4} y={6} width={8} height={8} />
      </svg>
    </div>
  );
}
