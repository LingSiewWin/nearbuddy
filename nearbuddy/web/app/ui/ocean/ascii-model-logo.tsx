"use client";
// Reactive ASCII model-family logo for the duel dock / audit drawer.
import { useEffect, useState } from "react";
import {
  logoStateOf,
  logoTimerOf,
  modelFamilyOf,
  renderLogoGrid,
  type LogoSignal,
  type LogoState,
} from "../../assets/ocean/ascii-model-logo";
import { useReducedMotion } from "../trace-view";

export type AsciiModelLogoProps = {
  modelId: string;
  label?: string;
  signal: LogoSignal;
  className?: string;
};

const STATE_CLASS: Record<LogoState, string> = {
  idle: "is-idle",
  thinking: "is-thinking",
  held: "is-held",
  fooled: "is-fooled",
};

export function AsciiModelLogo({ modelId, label, signal, className }: AsciiModelLogoProps) {
  const calm = useReducedMotion();
  const family = modelFamilyOf(modelId);
  const state = logoStateOf(signal);
  const timer = logoTimerOf(signal, state);
  const [timeSec, setTimeSec] = useState(0);

  useEffect(() => {
    if (calm || state === "idle") return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setTimeSec((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [calm, state]);

  const lines = renderLogoGrid({
    family,
    state: calm && state === "thinking" ? "idle" : state,
    timer: calm ? 0 : timer,
    timeSec: calm ? 0 : timeSec,
    calm,
  });

  const aria = `${label ?? modelId} ${state === "idle" ? "mark" : state}`;

  return (
    <pre
      className={`ascii-model-logo ${STATE_CLASS[state]}${className ? ` ${className}` : ""}`}
      aria-label={aria}
      title={aria}
      data-state={state}
      data-family={family}
    >
      {lines.join("\n")}
    </pre>
  );
}
