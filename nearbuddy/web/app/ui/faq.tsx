"use client";
// The home page's questions: one centred column with a lead statement, an accordion where one answer is open at a
// time, and a way to ask. The answer's height animates with CSS grid rows, so nothing is measured in script.
import { type ReactNode, useId, useState } from "react";

export type Qa = { q: string; a: ReactNode };

export function Faq({
  tag,
  title,
  lead,
  items,
  ask,
}: {
  /** The small label over the title. */
  tag: string;
  title: string;
  lead: ReactNode;
  items: Qa[];
  /** Where a visitor writes when the answer is not here. */
  ask: { href: string; label: string };
}) {
  const [open, setOpen] = useState<number | null>(null);
  const id = useId();
  return (
    <div className="faq">
      <header className="faq-head">
        <span className="faq-tag">{tag}</span>
        <h3 className="faq-title">{title}</h3>
        <div className="faq-lead">{lead}</div>
      </header>
      <ul className="faq-list">
        {items.map((it, i) => {
          const on = open === i;
          return (
            <li key={it.q} className={on ? "is-open" : undefined}>
              <button
                type="button"
                className="faq-q"
                aria-expanded={on}
                aria-controls={`${id}-${i}`}
                onClick={() => setOpen(on ? null : i)}
              >
                <span>{it.q}</span>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                </svg>
              </button>
              <div id={`${id}-${i}`} className="faq-a" inert={!on}>
                <div>{it.a}</div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="faq-more">
        <div>
          <p className="faq-more-title">Still have a question?</p>
          <p className="faq-more-line">Ask us directly.</p>
        </div>
        <a className="btn btn-primary fit" href={ask.href}>
          {ask.label} →
        </a>
      </div>
    </div>
  );
}
