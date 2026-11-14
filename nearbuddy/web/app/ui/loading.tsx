"use client";
// A loading state that shows work is happening and for how long: a small pixel grid whose cells light in a pattern,
// a label with a moving sheen, and the seconds elapsed. Three patterns: `drive` (square cells, a chevron sweeping
// right), `dots` (the same sweep with round cells) and `orbit` (one comet lapping the edge). No dependency: the two
// animations are the `pixel-on` and `shimmer-text` keyframes in ui.css. Still under reduced motion.
import { type CSSProperties, useEffect, useState } from "react";

export type LoaderVariant = "drive" | "dots" | "orbit";

const N = 5;
const MID = (N - 1) / 2;
// the cells on the edge of the grid, clockwise from the top left: the comet's lap
const RING: [number, number][] = [
  ...Array.from({ length: N }, (_, c): [number, number] => [0, c]),
  ...Array.from({ length: N - 2 }, (_, r): [number, number] => [r + 1, N - 1]),
  ...Array.from({ length: N }, (_, c): [number, number] => [N - 1, N - 1 - c]),
  ...Array.from({ length: N - 2 }, (_, r): [number, number] => [N - 2 - r, 0]),
];

/** When cell (row, col) lights, in steps; null for a cell this pattern leaves dark. */
export function cellStep(variant: LoaderVariant, row: number, col: number): number | null {
  if (variant !== "orbit") return col + Math.abs(row - MID); // a chevron: the middle row leads
  const i = RING.findIndex(([r, c]) => r === row && c === col);
  return i === -1 ? null : i;
}

/** Seconds since the component mounted, updated ten times a second. */
export function useElapsed(): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    const id = setInterval(() => setS((performance.now() - t0) / 1000), 100);
    return () => clearInterval(id);
  }, []);
  return s;
}

export function LoadingState({ label, variant = "drive" }: { label: string; variant?: LoaderVariant }) {
  const elapsed = useElapsed();
  const steps = variant === "orbit" ? RING.length : N + MID;
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <div className={`pixel-grid pixel-${variant}`} aria-hidden="true">
        {Array.from({ length: N * N }, (_, i) => {
          const step = cellStep(variant, Math.floor(i / N), i % N);
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid; a cell is its position
              key={i}
              className={step === null ? "is-off" : undefined}
              style={{ "--i": step ?? 0, "--n": steps } as CSSProperties}
            />
          );
        })}
      </div>
      <p className="loading-label">{label}</p>
      <p className="loading-time mono">{`${elapsed.toFixed(1)} s`}</p>
    </div>
  );
}
