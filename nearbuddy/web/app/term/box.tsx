// Exact-width boxes for the terminal: every line is `w` characters, borders drawn with box characters that screen
// readers skip (aria-hidden), and the text between them is real text, links and buttons. A cell with a key `k`
// flashes once when its value changed on the last poll (FlashCtx holds key -> time of change).
import { createContext, type ReactNode, useContext } from "react";

export type Cell =
  | string
  | {
      t: string;
      c?: string | undefined;
      href?: string | undefined;
      title?: string | undefined;
      k?: string | undefined;
      onClick?: (() => void) | undefined;
      label?: string | undefined;
    };

export const FlashCtx = createContext<ReadonlyMap<string, number>>(new Map());

/** `s` in exactly `n` columns: padded, or cut with "…". */
export const col = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

/** Words packed into lines of at most `width` characters (a longer word is cut by the line it lands on). */
export const wrap = (text: string, width: number): string[] => {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (cur && `${cur} ${word}`.length > width) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  lines.push(cur);
  return lines;
};

/** A dim note over as many box lines as it needs. */
export function Note({ w, text, c = "dim" }: { w: number; text: string; c?: string }) {
  return (
    <>
      {wrap(text, w - 4).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines of one string, in order
        <Line key={i} w={w} cells={[{ t: l, c }]} />
      ))}
    </>
  );
}

/** Cells cut to `width` characters; returns the nodes and how many characters they use. */
function useFit(list: Cell[], width: number): [ReactNode[], number] {
  const flash = useContext(FlashCtx);
  let left = width;
  const out: ReactNode[] = [];
  list.forEach((cell, i) => {
    const o = typeof cell === "string" ? { t: cell } : cell;
    // a cell cut at the box edge ends in "…" so a reader knows there is more (the full text is in its title)
    const t = o.t.length > left && left > 0 ? `${o.t.slice(0, left - 1)}…` : o.t.slice(0, Math.max(0, left));
    left -= t.length;
    if (!t) return;
    const at = o.k ? flash.get(o.k) : undefined;
    const cls = [o.c, at ? "flash" : ""].filter(Boolean).join(" ") || undefined;
    // positional fragments of one fixed-width line; a flashing cell remounts once per change so its animation replays
    const key = `${i}:${at ?? 0}`;
    if (o.href) {
      const ext = !o.href.startsWith("/");
      out.push(
        <a
          key={key}
          className={cls ?? "hi"}
          href={o.href}
          title={o.title}
          target={ext ? "_blank" : undefined}
          rel={ext ? "noreferrer" : undefined}
        >
          {t}
        </a>,
      );
    } else if (o.onClick)
      out.push(
        <button
          key={key}
          type="button"
          className={`lnk ${cls ?? "hi"}`}
          onClick={o.onClick}
          title={o.title}
          aria-label={o.label}
        >
          {t}
        </button>,
      );
    else if (cls || o.title)
      out.push(
        <span key={key} className={cls} title={o.title}>
          {t}
        </span>,
      );
    else out.push(t);
  });
  return [out, width - left];
}

/** One box line. With `onClick` the whole line is one button (its cells must not hold links or buttons). */
export function Line({
  w,
  cells,
  onClick,
  sel,
  label,
}: {
  w: number;
  cells: Cell[];
  onClick?: (() => void) | undefined;
  sel?: boolean | undefined;
  label?: string | undefined;
}) {
  const [nodes, used] = useFit(cells, w - 4);
  const body = (
    <>
      {nodes}
      {" ".repeat(Math.max(0, w - 4 - used))}
    </>
  );
  return (
    <div className={sel ? "ln sel" : "ln"}>
      <span aria-hidden="true" className="edge">
        {"│ "}
      </span>
      {onClick ? (
        <button
          type="button"
          className="row"
          onClick={onClick}
          aria-current={sel ? "true" : undefined}
          aria-label={label}
        >
          {body}
        </button>
      ) : (
        <span className="row">{body}</span>
      )}
      <span aria-hidden="true" className="edge">
        {" │"}
      </span>
    </div>
  );
}

/** `rows` box lines holding one element `w - 4` characters wide and `rows` lines tall (a textarea), borders kept. */
export function Slot({ rows = 1, children }: { rows?: number; children: ReactNode }) {
  return (
    <div className="ln slot">
      <span aria-hidden="true" className="edge">
        {Array(rows).fill("│ ").join("\n")}
      </span>
      {children}
      <span aria-hidden="true" className="edge">
        {Array(rows).fill(" │").join("\n")}
      </span>
    </div>
  );
}

/** A numbered box: `┌─1title ─── extra ─┐`, the lines, `└───┘`. The title is the section's heading. */
export function Box({
  n,
  title,
  extra = "",
  w,
  on,
  id,
  children,
}: {
  n: number | string;
  title: string;
  extra?: string;
  w: number;
  on: boolean;
  id: string;
  children: ReactNode;
}) {
  const ex = extra ? ` ${extra} `.slice(0, Math.max(0, w - 8 - title.length)) : "";
  const fill = Math.max(1, w - 6 - title.length - ex.length);
  return (
    <section id={id} className={on ? "box on" : "box"} tabIndex={-1} aria-labelledby={`${id}-h`}>
      <h2 className="ln" id={`${id}-h`}>
        <span aria-hidden="true" className="edge">
          {"┌─"}
        </span>
        <span className="num">{n}</span>
        <span className="hi">{title}</span>
        <span aria-hidden="true" className="edge">
          {` ${"─".repeat(fill)}`}
        </span>
        {ex ? <span className="dim">{ex}</span> : null}
        <span aria-hidden="true" className="edge">
          {"─┐"}
        </span>
      </h2>
      {children}
      <div aria-hidden="true" className="ln edge">{`└${"─".repeat(w - 2)}┘`}</div>
    </section>
  );
}
