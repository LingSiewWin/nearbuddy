"use client";
// Hero ASCII mosaic: light architectural field; sharks and prey carved from density tiles.
// Choreography only — no network, no model ids. Shapes/ramp/noise in app/assets/ocean.
import { useEffect, useRef } from "react";
import { useReducedMotion } from "../trace-view";
import { actorsAt, paintField, type Pointer } from "./field-paint";

const LOOP_S = 8;

/** Full-bleed mosaic inside the hero band. Hidden from assistive tech. */
export function EatScene({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const calm = useReducedMotion();
  const pointer = useRef<Pointer>({ x: 0, y: 0, active: false });

  useEffect(() => {
    const el = ref.current;
    const box = wrap.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !box) return;

    let raf = 0;
    let start = performance.now();
    let last = -1;

    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(box.clientWidth));
      const h = Math.max(1, Math.floor(box.clientHeight));
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      last = -1;
      return { w, h };
    };

    const draw = (now: number) => {
      const { w, h } = (() => {
        const ww = Math.max(1, Math.floor(box.clientWidth));
        const hh = Math.max(1, Math.floor(box.clientHeight));
        if (el.width !== Math.round(ww * Math.min(2, window.devicePixelRatio || 1))) return size();
        return { w: ww, h: hh };
      })();
      const t = calm ? 0.48 : ((now - start) / 1000 / LOOP_S) % 1;
      // ~30fps paint budget on large grids; still smooth enough for ribbons
      const bucket = Math.floor(now / (calm ? 1000 : 33));
      if (bucket === last && !calm) {
        raf = requestAnimationFrame(draw);
        return;
      }
      last = bucket;
      const { actors, flash } = actorsAt(t, w, h);
      paintField(ctx, w, h, actors, now / 1000, pointer.current, flash);
      if (!calm) raf = requestAnimationFrame(draw);
    };

    size();
    draw(performance.now());

    const ro = new ResizeObserver(() => {
      size();
      last = -1;
      if (calm) draw(performance.now());
    });
    ro.observe(box);

    const onMove = (e: PointerEvent) => {
      const r = box.getBoundingClientRect();
      pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top, active: true };
    };
    const onLeave = () => {
      pointer.current = { ...pointer.current, active: false };
    };
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerleave", onLeave);

    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else if (!calm) {
        start = performance.now();
        last = -1;
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [calm]);

  return (
    <div
      ref={wrap}
      className={`eat-scene${calm ? " eat-scene-still" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      <canvas ref={ref} className="eat-scene-canvas" />
    </div>
  );
}
