"use client";
// Pointer-trail grid for the home hero. Adapted from 21st.dev InteractiveGrid (SVG cells that light under the
// pointer and fade). No Tailwind, no cn(), no shadcn — styles live in ui.css. Mount as a sibling above the ocean
// canvas and below hero copy/dock; the SVG is pointer-events-none so CTAs stay clickable. Listens on the parent.
import { useEffect, useRef, useState } from "react";

type Props = {
  /** Cell edge in px. Keep larger than the ASCII ocean's ~10 px so the trail reads as a separate layer. */
  cellSize?: number;
};

type Lit = { key: string; x: number; y: number; born: number };

const FADE_MS = 520;
const MAX_LIT = 48;

/** Soft lime trail over the hero: cells under the pointer light, then fade. Skipped when reduced motion. */
export function InteractiveGrid({ cellSize = 32 }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [lit, setLit] = useState<Lit[]>([]);
  const [calm, setCalm] = useState(false);
  const litRef = useRef<Lit[]>([]);
  const raf = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setCalm(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;

    const measure = () => {
      const r = parent.getBoundingClientRect();
      setSize({ w: Math.max(0, Math.floor(r.width)), h: Math.max(0, Math.floor(r.height)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);

    if (calm) {
      return () => ro.disconnect();
    }

    const tick = (now: number) => {
      const next = litRef.current.filter((c) => now - c.born < FADE_MS);
      litRef.current = next;
      setLit(next);
      if (next.length) raf.current = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      const r = parent.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      if (px < 0 || py < 0 || px > r.width || py > r.height) return;
      const col = Math.floor(px / cellSize);
      const row = Math.floor(py / cellSize);
      const key = `${col}:${row}`;
      const now = performance.now();
      const x = col * cellSize;
      const y = row * cellSize;
      const without = litRef.current.filter((c) => c.key !== key);
      without.push({ key, x, y, born: now });
      litRef.current = without.slice(-MAX_LIT);
      setLit(litRef.current);
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(tick);
    };

    const onLeave = () => {
      litRef.current = [];
      setLit([]);
      cancelAnimationFrame(raf.current);
    };

    parent.addEventListener("pointermove", onMove);
    parent.addEventListener("pointerleave", onLeave);
    return () => {
      ro.disconnect();
      parent.removeEventListener("pointermove", onMove);
      parent.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf.current);
    };
  }, [cellSize, calm]);

  const cols = size.w > 0 ? Math.ceil(size.w / cellSize) : 0;
  const rows = size.h > 0 ? Math.ceil(size.h / cellSize) : 0;
  const now = typeof performance !== "undefined" ? performance.now() : 0;

  return (
    <div ref={layer} className="interactive-grid" aria-hidden="true">
      {size.w > 0 && size.h > 0 ? (
        <svg className="interactive-grid-svg" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
          {Array.from({ length: rows }, (_, row) =>
            Array.from({ length: cols }, (_, col) => (
              <rect
                key={`${col}:${row}`}
                className="interactive-grid-cell"
                x={col * cellSize}
                y={row * cellSize}
                width={cellSize}
                height={cellSize}
              />
            )),
          )}
          {!calm
            ? lit.map((c) => {
                const t = Math.max(0, 1 - (now - c.born) / FADE_MS);
                return (
                  <rect
                    key={`lit-${c.key}-${c.born}`}
                    className="interactive-grid-lit"
                    x={c.x}
                    y={c.y}
                    width={cellSize}
                    height={cellSize}
                    style={{ fillOpacity: 0.15 * t }}
                  />
                );
              })
            : null}
        </svg>
      ) : null}
    </div>
  );
}
