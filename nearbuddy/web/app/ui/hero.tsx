"use client";
// The home page's front layer: a carousel of full-width slides on native scroll snapping. The visitor moves it
// (swipe, the arrows, the tabs, or the arrow keys while the track has focus); it never advances by itself.
import { type ReactNode, useEffect, useRef, useState } from "react";

export type Slide = { label: string; node: (go: (i: number) => void) => ReactNode };

export function Carousel({ label, slides }: { label: string; slides: Slide[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const go = (i: number) => {
    const el = track.current;
    if (!el) return;
    const to = Math.max(0, Math.min(slides.length - 1, i));
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: to * el.clientWidth, behavior: calm ? "auto" : "smooth" });
  };
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const on = () => setAt(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, []);
  return (
    <section className="hero" aria-roledescription="carousel" aria-label={label}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus so the arrow keys move it */}
      <div className="hero-track" ref={track} tabIndex={0}>
        {slides.map((s, i) => (
          // biome-ignore lint/a11y/useSemanticElements: a carousel slide is a labelled group, not a form fieldset
          <div
            key={s.label}
            className="hero-slide"
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${slides.length}: ${s.label}`}
            inert={i !== at}
          >
            {s.node(go)}
          </div>
        ))}
      </div>
      <div className="hero-nav">
        <button
          type="button"
          className="btn btn-quiet"
          aria-label="Previous"
          disabled={at === 0}
          onClick={() => go(at - 1)}
        >
          ←
        </button>
        {slides.map((s, i) => (
          <button
            key={s.label}
            type="button"
            className="hero-tab"
            aria-current={i === at ? "true" : undefined}
            onClick={() => go(i)}
          >
            <span className="mono">{String(i + 1).padStart(2, "0")}</span> {s.label}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-quiet"
          aria-label="Next"
          disabled={at === slides.length - 1}
          onClick={() => go(at + 1)}
        >
          →
        </button>
      </div>
    </section>
  );
}
