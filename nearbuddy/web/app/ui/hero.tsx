// The home page's front layer: numbered chapters down the page. Each opens with a rule, its number and title, and a
// second rule, then its content. The visitor scrolls; a chapter fades up as it enters (CSS only, ui.css), and a
// button in one chapter can move to another.
import type { ReactNode } from "react";

export type Chapter = { title: string; node: (go: (i: number) => void) => ReactNode };

const idOf = (i: number) => `chapter-${i + 1}`;

/** Scroll to chapter `i`; instant when the visitor asked for reduced motion. */
function go(i: number) {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(idOf(i))?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
}

export function Chapters({ chapters }: { chapters: Chapter[] }) {
  return (
    <>
      {chapters.map((c, i) => (
        <section key={c.title} id={idOf(i)} className="chapter" aria-labelledby={`${idOf(i)}-title`}>
          <header className="chapter-head">
            <span className="chapter-no" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h2 id={`${idOf(i)}-title`} className="chapter-title">
              {c.title}
            </h2>
          </header>
          <div className="chapter-body">{c.node(go)}</div>
        </section>
      ))}
    </>
  );
}
