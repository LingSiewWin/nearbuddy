"use client";
// The tile field on one 2D canvas, fixed behind the home page (maths in ui/tiles.ts). It redraws 12 times a second,
// stops while the tab is hidden, and draws a single still frame when the visitor asked for reduced motion. It is
// decoration: hidden from screen readers and never takes a click. The pointer shifts it a few pixels for depth.
import { useEffect, useRef } from "react";
import { RECORDED } from "./replay";
import { curveOf, dot, edge, type Hue, pulseCol } from "./tiles";
import { useReducedMotion } from "./trace-view";

// a fine grid: about 50,000 cells on a laptop screen. A cell holds one dot of 1 to 4 px.
const PITCH = 5;
const SIZES = [1, 2, 3, 4];
const ALPHA = [0.3, 0.5, 0.75, 1];
const STEPS_PER_S = 12;
const PULSE_WIDTH = 10;
const HUES: Hue[] = ["edge", "body", "deep"];
const CURVE = curveOf(RECORDED.price.samples.map((s) => s.p));

export function TileField() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let raf = 0;
    let last = -1;
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      el.width = Math.round(window.innerWidth * dpr);
      el.height = Math.round(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      last = -1;
    };
    const draw = (t: number) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const cols = Math.ceil(w / PITCH);
      const rows = Math.ceil(h / PITCH);
      // the tokens are read each step, so a theme switch repaints with the new ones
      const css = getComputedStyle(el);
      const token = (name: string) => css.getPropertyValue(name).trim();
      const colour: Record<Hue | "pulse", string> = {
        edge: token("--hi"),
        body: token("--live"),
        deep: token("--proof"),
        pulse: token("--signal"),
      };
      const hit = pulseCol(cols, t);
      // one list of cells per (colour, size), so the canvas changes its fill style a dozen times, not per dot
      const lists = new Map<string, number[]>();
      for (let c = 0; c < cols; c++) {
        const e = edge(CURVE, c, cols, t);
        const pulsed = hit >= 0 && Math.abs(c - hit) <= PULSE_WIDTH;
        for (let r = 0; r < rows; r++) {
          const d = dot(c, r, rows, e, t);
          if (!d) continue;
          const size = Math.min(3, Math.floor(d.v * 4));
          const key = `${pulsed && d.hue !== "deep" ? "pulse" : d.hue}:${size}`;
          const list = lists.get(key);
          if (list) list.push(c, r);
          else lists.set(key, [c, r]);
        }
      }
      ctx.clearRect(0, 0, w, h);
      for (const hue of [...HUES, "pulse"] as const) {
        ctx.fillStyle = colour[hue];
        for (let size = 0; size < 4; size++) {
          const list = lists.get(`${hue}:${size}`);
          if (!list) continue;
          const px = SIZES[size] ?? 1;
          const off = (PITCH - 1 - px) / 2;
          ctx.globalAlpha = ALPHA[size] ?? 1;
          for (let i = 0; i < list.length; i += 2) {
            ctx.fillRect((list[i] ?? 0) * PITCH + off, (list[i + 1] ?? 0) * PITCH + off, px, px);
          }
        }
      }
    };
    const frame = (ms: number) => {
      const step = Math.floor((ms / 1000) * STEPS_PER_S);
      if (step !== last) {
        last = step;
        draw(step / STEPS_PER_S);
      }
      raf = requestAnimationFrame(frame);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (reduced) draw(4);
      else if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    const resize = () => {
      size();
      if (reduced) draw(4);
    };
    const lean = (ev: PointerEvent) => {
      if (reduced) return;
      const x = (ev.clientX / window.innerWidth - 0.5) * -14;
      const y = (ev.clientY / window.innerHeight - 0.5) * -8;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    };
    size();
    run();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", lean, { passive: true });
    document.addEventListener("visibilitychange", run);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", lean);
      document.removeEventListener("visibilitychange", run);
    };
  }, [reduced]);
  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas with no tabindex takes no focus; it is decoration
  return <canvas ref={ref} className="tiles" aria-hidden="true" />;
}
