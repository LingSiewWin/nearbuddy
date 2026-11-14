"use client";
// Duel rows for the home page's "Other duels" and the duel list: the whole row is a link.
import { type DuelRow, duelPath } from "./data";
import { clock, nsMs, plural } from "./format";

/** How a duel stands, in the row's words. */
export function rowState(r: DuelRow, now: number): string {
  if (r.resolved) {
    if (r.cancelled) return "cancelled";
    if (r.winner === "Tie") return "tie";
    return `${(r.winner === "A" ? r.a : r.b).model} won`;
  }
  const left = (nsMs(r.close_at) - now) / 1000;
  return now && left <= 0 ? "closed, waiting for the final price" : now ? `ends in ${clock(left)}` : "running";
}

export const isRunning = (r: DuelRow, now: number) => !r.resolved && (!now || nsMs(r.close_at) > now);

export function DuelRows({
  rows,
  now,
  wide,
}: {
  rows: DuelRow[];
  now: number /** Desktop: one line a row, as a table. */;
  wide?: boolean;
}) {
  return (
    <ul className={`duel-rows${wide ? " wide" : ""}`}>
      {rows.map((r) => (
        <li key={`${r.arena}:${r.id}`}>
          <a href={duelPath(r.id, r.arena)}>
            <span className="mono id">{`#${r.id}`}</span>
            <span className="mono who">{`${r.a.model} vs ${r.b.model}`}</span>
            <span className="state">
              {rowState(r, now)}
              {r.headlines > 0 ? <span className="dim">{` · ${plural(r.headlines, "headline")}`}</span> : null}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
