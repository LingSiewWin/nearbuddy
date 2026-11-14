"use client";
// 3D Gaussian → ASCII grid canvas. Theme-aware; board-seeded sim; no fake LIVE feed.
import { useEffect, useRef, type MouseEvent, type MutableRefObject } from "react";
import {
  ASCII_RAMP,
  CELL_SIZE,
  allocBuffers,
  rasterizeOceanField,
  type GridBuffers,
} from "../../assets/ocean/gaussian3d";
import type { ArenaTheme, ModelAgentState } from "../../assets/ocean/arena-types";
import type { ArenaSimulation } from "../../assets/ocean/simulation";
import { useReducedMotion } from "../trace-view";

/** Palette accents: lime / blue / cool white — no orange or copper. */
const ACCENT_RGB: Record<number, [number, number, number]> = {
  0: [198, 244, 50], // lime #c6f432
  1: [111, 140, 255], // blue #6f8cff
  2: [200, 214, 240], // cool white
};

export type AsciiOceanCanvasProps = {
  simulation: ArenaSimulation;
  simRef?: MutableRefObject<ArenaSimulation | null>;
  theme?: ArenaTheme;
  className?: string;
  selectedModelId?: string | null;
  onSelectModel?: (model: ModelAgentState | null) => void;
  /** Called after each frame tick so parent HUD can refresh. */
  onTickHud?: () => void;
};

export function AsciiOceanCanvas({
  simulation,
  simRef,
  theme = "dark",
  className,
  onSelectModel,
  onTickHud,
}: AsciiOceanCanvasProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const calm = useReducedMotion();
  const isDark = theme === "dark";

  useEffect(() => {
    if (simRef) simRef.current = simulation;
  }, [simulation, simRef]);

  useEffect(() => {
    const el = canvasRef.current;
    const box = wrap.current;
    if (!el || !box) return;
    const ctx = el.getContext("2d", { alpha: false });
    if (!ctx) return;

    const gridCache = document.createElement("canvas");
    const gridCtx = gridCache.getContext("2d", { alpha: false });
    if (!gridCtx) return;

    let buffers: GridBuffers = allocBuffers(1, 1);
    let raf = 0;
    let last = performance.now();
    let hudBucket = 0;

    const paintGrid = (w: number, h: number, dpr: number) => {
      gridCache.width = Math.round(w * dpr);
      gridCache.height = Math.round(h * dpr);
      gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gridCtx.fillStyle = isDark ? "#090A0F" : "#F9F9FB";
      gridCtx.fillRect(0, 0, w, h);
      gridCtx.strokeStyle = isDark ? "#141722" : "#EAEAEF";
      gridCtx.lineWidth = 1;
      gridCtx.beginPath();
      for (let x = 0; x <= w; x += CELL_SIZE) {
        gridCtx.moveTo(x + 0.5, 0);
        gridCtx.lineTo(x + 0.5, h);
      }
      for (let y = 0; y <= h; y += CELL_SIZE) {
        gridCtx.moveTo(0, y + 0.5);
        gridCtx.lineTo(w, y + 0.5);
      }
      gridCtx.stroke();
    };

    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(box.clientWidth));
      const h = Math.max(1, Math.floor(box.clientHeight));
      if (w < 80 || h < 80) return { w, h };
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintGrid(w, h, dpr);
      buffers = allocBuffers(Math.ceil(w / CELL_SIZE), Math.ceil(h / CELL_SIZE));
      simulation.resize(w, h);
      return { w, h };
    };

    size();

    const draw = (now: number) => {
      const w = Math.max(1, Math.floor(box.clientWidth));
      const h = Math.max(1, Math.floor(box.clientHeight));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (el.width !== Math.round(w * dpr)) size();

      const dt = calm ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      const timeSec = now / 1000;
      // Always step: dt===0 snaps pending think→held/fooled for reduced motion + dock logos.
      simulation.step(dt, timeSec);
      rasterizeOceanField(
        buffers,
        simulation.creatures,
        simulation.ripples,
        calm ? 0 : timeSec,
        w,
        h,
        simulation.fauna.actors,
      );

      ctx.drawImage(gridCache, 0, 0, w, h);
      ctx.font = `600 ${Math.floor(CELL_SIZE * 0.72)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const { cols, rows, density, shade, glint, palette } = buffers;
      const rampMax = ASCII_RAMP.length - 1;
      for (let row = 0; row < rows; row++) {
        const y = row * CELL_SIZE;
        for (let col = 0; col < cols; col++) {
          const idx = row * cols + col;
          const d = density[idx]!;
          if (d < 0.03) continue;
          const s = shade[idx]!;
          const effective = Math.min(1, d * (0.55 + 0.7 * s));
          const rampIdx = Math.min(rampMax, Math.max(1, Math.round(effective * rampMax)));
          const glyph = ASCII_RAMP[rampIdx] ?? "@";
          const lum = isDark ? Math.round(36 + effective * 210) : Math.round(240 - effective * 206);
          const g = glint[idx]!;
          const x = col * CELL_SIZE;
          if (g > 0.08) {
            const [ar, ag, ab] = ACCENT_RGB[palette[idx]!] ?? ACCENT_RGB[0]!;
            const blend = g * 0.5;
            ctx.fillStyle = `rgb(${Math.round(lum * (1 - blend) + ar * blend)},${Math.round(lum * (1 - blend) + ag * blend)},${Math.round(lum * (1 - blend) + ab * blend)})`;
          } else if (isDark) {
            ctx.fillStyle = `rgb(${Math.round(lum * 0.62)},${Math.round(lum * 0.7)},${Math.min(255, Math.round(lum * 0.9))})`;
          } else {
            ctx.fillStyle = `rgb(${lum},${lum},${lum + 3})`;
          }
          ctx.fillRect(x + 1, y + 1, CELL_SIZE - 1, CELL_SIZE - 1);
          ctx.fillStyle = isDark
            ? lum > 100
              ? "#090A0F"
              : "#E8EEF8"
            : lum < 138
              ? "#F9F9FB"
              : "#26262B";
          ctx.fillText(glyph, x + CELL_SIZE * 0.5, y + CELL_SIZE * 0.5 + 0.5);
        }
      }

      const bucket = Math.floor(now / 250);
      if (bucket !== hudBucket) {
        hudBucket = bucket;
        onTickHud?.();
      }

      if (!calm) raf = requestAnimationFrame(draw);
    };

    draw(performance.now());
    const ro = new ResizeObserver(() => {
      size();
      if (calm) draw(performance.now());
    });
    ro.observe(box);
    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else if (!calm) {
        last = performance.now();
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [calm, isDark, simulation, onTickHud]);

  const pick = (e: MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = simulation.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    onSelectModel?.(hit ? { ...hit } : null);
  };

  return (
    <div
      ref={wrap}
      className={`ascii-ocean ascii-ocean-${theme}${calm ? " ascii-ocean-still" : ""}${className ? ` ${className}` : ""}`}
    >
      <canvas
        ref={canvasRef}
        className="ascii-ocean-canvas"
        onClick={pick}
        role="img"
        aria-label="ASCII arena of models sized by how often they held against planted headlines"
      />
    </div>
  );
}
