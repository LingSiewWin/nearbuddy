"use client";
// The decision field on a 2D canvas (layout in ui/field.ts): one square per recorded decision, grouped by model and
// duel, lit where a headline was planted and red where it fooled. It is drawn once per size or theme change and
// never animates, so there is nothing to pause; the band labels and the counts are real text over and under the
// canvas, and the table beside it is the same record for a screen reader or a browser without canvas.
import { useEffect, useRef, useState } from "react";
import { type FieldData, type FieldMark, fieldLayout, type MarkKind, markAt } from "./field";
import { shortModel } from "./format";
import { useWidth } from "./trace-view";

const WORD: Record<MarkKind, string> = {
  ".": "a decision with no headline in view",
  ":": "a decision with a headline in view",
  f: "fooled: its bet changed to the headline's side",
  h: "held: its bet did not change",
  n: "a new headline that did not count",
  "-": "no decision posted",
};

export function DecisionField({ data, describedBy }: { data: FieldData; describedBy?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = useWidth(wrap);
  const [theme, setTheme] = useState(0);
  const [hover, setHover] = useState<FieldMark | null>(null);
  // a phone has room for the band label only on two lines
  const layout = fieldLayout(data, width, width < 600 ? 5 : 6, width < 600 ? 40 : 22);
  // a theme switch changes the tokens the canvas was painted with
  useEffect(() => {
    const again = () => setTheme((n) => n + 1);
    const mo = new MutationObserver(again);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", again);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", again);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `theme` repaints with the new tokens
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !wrap.current) return;
    const t0 = performance.now();
    const css = getComputedStyle(wrap.current);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(layout.width * dpr);
    el.height = Math.round(layout.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);
    const size = layout.step - 2;
    const paint: [MarkKind, string, number][] = [
      ["-", token("--rule"), 1],
      [".", token("--dim"), 0.38],
      [":", token("--live"), 0.55],
      ["n", token("--live"), 1],
      ["h", token("--hi"), 1],
      ["f", token("--signal"), 1],
    ];
    // one pass per colour: six fill styles for the whole field
    for (const [kind, colour, alpha] of paint) {
      ctx.fillStyle = colour;
      ctx.globalAlpha = alpha;
      for (const m of layout.marks) if (m.kind === kind) ctx.fillRect(m.x, m.y, size, size);
    }
    ctx.globalAlpha = 1;
    el.dataset.drawMs = (performance.now() - t0).toFixed(2);
  }, [layout.width, layout.height, layout.step, data, theme]);
  const sum = (k: MarkKind) => layout.bands.reduce((s, b) => s + b.counts[k], 0);
  return (
    <div className="field" ref={wrap}>
      <div className="field-box" style={{ height: layout.height }}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${data.rows.toLocaleString("en-US")} recorded decisions as one mark each, grouped by model and duel: ${sum("f")} fooled, ${sum("h")} held, ${sum("n")} headlines that did not count.`}
          aria-describedby={describedBy}
          style={{ width: layout.width, height: layout.height }}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(markAt(layout, e.clientX - r.left, e.clientY - r.top));
          }}
          onMouseLeave={() => setHover(null)}
        />
        {layout.bands.map((b) => (
          <p key={b.model} className="field-band" style={{ top: b.y }}>
            <span className="mono" title={data.models[b.model]}>
              {shortModel(data.models[b.model] ?? "")}
            </span>
            <span>{`${b.total.toLocaleString("en-US")} decisions`}</span>
            {b.counts.f + b.counts.h ? <span>{`fooled ${b.counts.f} of ${b.counts.f + b.counts.h}`}</span> : null}
          </p>
        ))}
      </div>
      <p className="field-key">
        <span>
          <i className="k dim" />
          {`decision, no headline ${sum(".").toLocaleString("en-US")}`}
        </span>
        <span>
          <i className="k lit" />
          {`headline in view ${sum(":")}`}
        </span>
        <span>
          <i className="k new" />
          {`new headline, did not count ${sum("n")}`}
        </span>
        <span>
          <i className="k held" />
          {`held ${sum("h")}`}
        </span>
        <span>
          <i className="k fooled" />
          {`fooled ${sum("f")}`}
        </span>
        <span>
          <i className="k none" />
          {`no decision posted ${sum("-")}`}
        </span>
      </p>
      <p className="note field-hover" aria-hidden="true">
        {hover
          ? `duel #${hover.duel} · ${shortModel(data.models[hover.model] ?? "")} · ${WORD[hover.kind]}`
          : "Point at a mark to read it. Marks run oldest to newest, one run per agent per duel."}
      </p>
    </div>
  );
}
